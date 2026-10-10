import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql, type Transaction } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import type { RoutePoint } from "./route-provider.js";

export interface RouteSetupArea {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly emirateId: string;
  readonly emirateNameEn: string;
  readonly emirateNameAr: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly coordinatesVerifiedAt: string | null;
  readonly coordinatesVerifiedBy: string | null;
}

export interface RouteSetup {
  /** Effective: the Platform kill switch AND the Company's own switch. */
  readonly enabled: boolean;
  readonly companyEnabled: boolean;
  readonly platformEnabled: boolean;
  readonly provider: string;
  readonly branch: RoutePoint | null;
  readonly verifiedAreaCount: number;
  readonly areaCount: number;
  readonly areas: readonly RouteSetupArea[];
}

/**
 * Company-side route planning setup: the Area pins and the branch location.
 *
 * Pins are stored once per Area and are what the stored-pin engine routes
 * on. Saving a pin is the administrator's confirmation, so it is stamped
 * verified by that account at that moment; an Area is never sequenced from
 * an unconfirmed (for example bulk-geocoded) position. Whether route
 * planning is switched on stays a Platform decision and is read-only here.
 */
@Injectable()
export class RouteSetupService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public async setup(): Promise<RouteSetup> {
    const { companyId } = this.scope();
    const [settings, areas] = await Promise.all([
      sql<{
        companyEnabled: boolean | null;
        platformEnabled: boolean | null;
        provider: string | null;
        branchLatitude: string | null;
        branchLongitude: string | null;
      }>`
        select s.is_enabled as "companyEnabled",
               (select f.is_enabled from platform_feature_flags f
                 where f.code = 'route_optimization_enabled') as "platformEnabled",
               s.provider,
               s.branch_latitude::text as "branchLatitude",
               s.branch_longitude::text as "branchLongitude"
          from (select 1) one
          left join company_route_optimization_settings s on s.company_id = ${companyId}::uuid
      `.execute(this.database),
      sql<{
        id: string;
        code: string;
        nameEn: string;
        nameAr: string | null;
        emirateId: string;
        emirateNameEn: string;
        emirateNameAr: string;
        latitude: string | null;
        longitude: string | null;
        coordinatesVerifiedAt: string | null;
        coordinatesVerifiedBy: string | null;
      }>`
        select a.id, a.code, a.name_en as "nameEn", a.name_ar as "nameAr",
               a.emirate_id as "emirateId", e.name_en as "emirateNameEn", e.name_ar as "emirateNameAr",
               a.latitude::text as latitude, a.longitude::text as longitude,
               a.coordinates_verified_at::text as "coordinatesVerifiedAt",
               v.username as "coordinatesVerifiedBy"
          from areas a
          join emirates e on e.id = a.emirate_id
          left join accounts v on v.id = a.coordinates_verified_by_account_id and v.company_id = a.company_id
         where a.company_id = ${companyId}::uuid and a.is_active
         order by e.display_order, lower(a.name_en), a.id
      `.execute(this.database),
    ]);
    const row = settings.rows[0];
    const companyEnabled = row?.companyEnabled === true;
    const platformEnabled = row?.platformEnabled === true;
    const list = areas.rows.map((area) => ({
      ...area,
      latitude: area.latitude === null ? null : Number(area.latitude),
      longitude: area.longitude === null ? null : Number(area.longitude),
    }));
    return {
      enabled: companyEnabled && platformEnabled,
      companyEnabled,
      platformEnabled,
      provider: row?.provider ?? "area_matrix",
      branch:
        row?.branchLatitude == null || row.branchLongitude == null
          ? null
          : { latitude: Number(row.branchLatitude), longitude: Number(row.branchLongitude) },
      verifiedAreaCount: list.filter((area) => area.coordinatesVerifiedAt !== null).length,
      areaCount: list.length,
      areas: list,
    };
  }

  /** Save and confirm one Area's pin. */
  public async setAreaPin(
    areaId: string,
    point: RoutePoint,
    correlationId: string,
  ): Promise<RouteSetup> {
    const { companyId, accountId } = this.scope();
    await this.transactions.execute(async (transaction) => {
      const before = await this.lockArea(transaction, companyId, areaId);
      await sql`
        update areas
           set latitude = ${point.latitude}, longitude = ${point.longitude},
               coordinates_verified_at = now(),
               coordinates_verified_by_account_id = ${accountId}::uuid,
               updated_at = now(), version = version + 1
         where company_id = ${companyId}::uuid and id = ${areaId}::uuid
      `.execute(transaction);
      await this.audit(transaction, companyId, accountId, correlationId, {
        action: "area.coordinates_verified",
        subjectType: "area",
        subjectId: areaId,
        before,
        after: { latitude: point.latitude, longitude: point.longitude },
      });
    });
    return this.setup();
  }

  /** Remove an Area's pin; the Area is then listed unsequenced. */
  public async clearAreaPin(areaId: string, correlationId: string): Promise<RouteSetup> {
    const { companyId, accountId } = this.scope();
    await this.transactions.execute(async (transaction) => {
      const before = await this.lockArea(transaction, companyId, areaId);
      await sql`
        update areas
           set latitude = null, longitude = null,
               coordinates_verified_at = null, coordinates_verified_by_account_id = null,
               updated_at = now(), version = version + 1
         where company_id = ${companyId}::uuid and id = ${areaId}::uuid
      `.execute(transaction);
      await this.audit(transaction, companyId, accountId, correlationId, {
        action: "area.coordinates_cleared",
        subjectType: "area",
        subjectId: areaId,
        before,
        after: { latitude: null, longitude: null },
      });
    });
    return this.setup();
  }

  /**
   * The branch: where a run ends (cash handover) and, with no GPS, starts.
   * Creates the Company's settings row if needed, always switched off --
   * saving a branch never enables route planning.
   */
  public async setBranch(point: RoutePoint, correlationId: string): Promise<RouteSetup> {
    const { companyId, accountId } = this.scope();
    await this.transactions.execute(async (transaction) => {
      const before = await sql<{ latitude: string | null; longitude: string | null }>`
        select branch_latitude::text as latitude, branch_longitude::text as longitude
          from company_route_optimization_settings
         where company_id = ${companyId}::uuid
         for update
      `.execute(transaction);
      await sql`
        insert into company_route_optimization_settings (company_id, branch_latitude, branch_longitude, updated_at)
        values (${companyId}::uuid, ${point.latitude}, ${point.longitude}, now())
        on conflict (company_id) do update
          set branch_latitude = excluded.branch_latitude,
              branch_longitude = excluded.branch_longitude,
              updated_at = now(),
              version = company_route_optimization_settings.version + 1
      `.execute(transaction);
      await this.audit(transaction, companyId, accountId, correlationId, {
        action: "route_planning.branch_updated",
        subjectType: "company_route_optimization_settings",
        subjectId: companyId,
        before: before.rows[0] ?? null,
        after: { latitude: point.latitude, longitude: point.longitude },
      });
    });
    return this.setup();
  }

  private scope(): { companyId: string; accountId: string } {
    const identity = this.identities.current();
    if (identity.kind !== "company_user" || identity.companyId === null) {
      throw new ApplicationException(
        "route_setup_company_user_required",
        "A Company user is required",
        HttpStatus.FORBIDDEN,
      );
    }
    return { companyId: identity.companyId, accountId: identity.identityId };
  }

  private async lockArea(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
    areaId: string,
  ): Promise<{ latitude: string | null; longitude: string | null }> {
    const area = await sql<{ latitude: string | null; longitude: string | null }>`
      select latitude::text as latitude, longitude::text as longitude
        from areas
       where company_id = ${companyId}::uuid and id = ${areaId}::uuid and is_active
       for update
    `.execute(transaction);
    const row = area.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "area_not_found",
        "The Area was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private async audit(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
    accountId: string,
    correlationId: string,
    event: {
      readonly action: string;
      readonly subjectType: string;
      readonly subjectId: string;
      readonly before: object | null;
      readonly after: object;
    },
  ): Promise<void> {
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        before_data, after_data, correlation_id
      ) values (
        ${companyId}::uuid, ${accountId}::uuid, ${event.action}, ${event.subjectType},
        ${event.subjectId}, ${event.before === null ? null : JSON.stringify(event.before)}::jsonb,
        ${JSON.stringify(event.after)}::jsonb, ${correlationId}
      )
    `.execute(transaction);
  }
}
