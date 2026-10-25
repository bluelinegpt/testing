import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql, type Transaction } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import {
  AreaGeocoder,
  geocodeQuery,
  GeocoderQuotaReached,
  geocoderNotConfigured,
  type SuggestionFlag,
  suggestionFlag,
} from "./area-geocoder.js";
import type { RoutePoint } from "./route-provider.js";

export interface RouteSetupSuggestion {
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly formattedAddress: string | null;
  readonly flag: SuggestionFlag | null;
  readonly createdAt: string;
}

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
  /** Google's suggested pin, waiting for an administrator; never routed on. */
  readonly suggestion: RouteSetupSuggestion | null;
  /** Google found nothing usable earlier and the suggestion was rejected. */
  readonly suggestionRejected: boolean;
}

export interface SuggestPinsResult {
  /** Areas looked up in this batch. */
  readonly looked: number;
  readonly flagged: number;
  readonly notFound: number;
  /** Areas still without a pin or a suggestion after this batch. */
  readonly remaining: number;
  /**
   * Why the batch ended early: Google asked us to slow down ("quota"), or
   * failed part-way ("google_error"); what was saved stays saved.
   */
  readonly stopped: "quota" | "google_error" | null;
  readonly setup: RouteSetup;
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
  /** True when the server has a Google Maps key for pin suggestions. */
  readonly geocoderConfigured: boolean;
  readonly openSuggestionCount: number;
  readonly flaggedSuggestionCount: number;
  readonly areas: readonly RouteSetupArea[];
}

/** One batch of Google look-ups: small enough to finish well inside a request. */
const SUGGEST_BATCH = 25;
const SUGGEST_CONCURRENCY = 5;

/**
 * Company-side route planning setup: the Area pins and the branch location.
 *
 * Pins are stored once per Area and are what the stored-pin engine routes
 * on. Saving a pin is the administrator's confirmation, so it is stamped
 * verified by that account at that moment; an Area is never sequenced from
 * an unconfirmed (for example bulk-geocoded) position: a Google suggestion
 * waits in `area_coordinate_suggestions` until it is accepted. Whether route
 * planning is switched on stays a Platform decision and is read-only here.
 */
@Injectable()
export class RouteSetupService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(AreaGeocoder) private readonly geocoder: AreaGeocoder,
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
        suggestionLatitude: string | null;
        suggestionLongitude: string | null;
        suggestionAddress: string | null;
        suggestionFlag: SuggestionFlag | null;
        suggestionCreatedAt: string | null;
        suggestionRejected: boolean;
      }>`
        select a.id, a.code, a.name_en as "nameEn", a.name_ar as "nameAr",
               a.emirate_id as "emirateId", e.name_en as "emirateNameEn", e.name_ar as "emirateNameAr",
               a.latitude::text as latitude, a.longitude::text as longitude,
               a.coordinates_verified_at::text as "coordinatesVerifiedAt",
               v.username as "coordinatesVerifiedBy",
               s.latitude::text as "suggestionLatitude",
               s.longitude::text as "suggestionLongitude",
               s.formatted_address as "suggestionAddress",
               s.flag as "suggestionFlag",
               s.created_at::text as "suggestionCreatedAt",
               exists (
                 select 1 from area_coordinate_suggestions r
                  where r.company_id = a.company_id and r.area_id = a.id and r.resolution = 'rejected'
               ) as "suggestionRejected"
          from areas a
          join emirates e on e.id = a.emirate_id
          left join accounts v on v.id = a.coordinates_verified_by_account_id and v.company_id = a.company_id
          left join area_coordinate_suggestions s
            on s.company_id = a.company_id and s.area_id = a.id and s.resolution is null
         where a.company_id = ${companyId}::uuid and a.is_active
         order by e.display_order, lower(a.name_en), a.id
      `.execute(this.database),
    ]);
    const row = settings.rows[0];
    const companyEnabled = row?.companyEnabled === true;
    const platformEnabled = row?.platformEnabled === true;
    const list: RouteSetupArea[] = areas.rows.map((area) => ({
      id: area.id,
      code: area.code,
      nameEn: area.nameEn,
      nameAr: area.nameAr,
      emirateId: area.emirateId,
      emirateNameEn: area.emirateNameEn,
      emirateNameAr: area.emirateNameAr,
      latitude: area.latitude === null ? null : Number(area.latitude),
      longitude: area.longitude === null ? null : Number(area.longitude),
      coordinatesVerifiedAt: area.coordinatesVerifiedAt,
      coordinatesVerifiedBy: area.coordinatesVerifiedBy,
      suggestion:
        area.suggestionCreatedAt === null
          ? null
          : {
              latitude: area.suggestionLatitude === null ? null : Number(area.suggestionLatitude),
              longitude: area.suggestionLongitude === null ? null : Number(area.suggestionLongitude),
              formattedAddress: area.suggestionAddress,
              flag: area.suggestionFlag,
              createdAt: area.suggestionCreatedAt,
            },
      suggestionRejected: area.suggestionRejected,
    }));
    const open = list.filter((area) => area.suggestion !== null);
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
      geocoderConfigured: this.geocoder.configured,
      openSuggestionCount: open.length,
      flaggedSuggestionCount: open.filter((area) => area.suggestion?.flag !== null).length,
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
      // A pin entered by hand settles any Google suggestion still open.
      await this.resolveOpenSuggestion(transaction, companyId, accountId, areaId, "rejected");
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

  /**
   * Look up the next batch of Areas without a pin on Google and store each
   * result as a suggestion. Areas used by recent Orders go first. An Area
   * whose suggestion was rejected is not looked up again (pin it by hand).
   */
  public async suggestPins(correlationId: string): Promise<SuggestPinsResult> {
    const { companyId, accountId } = this.scope();
    if (!this.geocoder.configured) throw geocoderNotConfigured();
    const candidates = await sql<{
      id: string;
      nameEn: string;
      nameAr: string | null;
      emirateCode: string;
      emirateNameEn: string;
    }>`
      select a.id, a.name_en as "nameEn", a.name_ar as "nameAr",
             e.code as "emirateCode", e.name_en as "emirateNameEn"
        from areas a
        join emirates e on e.id = a.emirate_id
        left join lateral (
          select count(*) as used
            from orders o
           where o.company_id = a.company_id and o.area_id = a.id
             and o.created_at > now() - interval '60 days'
        ) recent on true
       where a.company_id = ${companyId}::uuid
         and a.is_active
         and a.coordinates_verified_at is null
         and not exists (
           select 1 from area_coordinate_suggestions s
            where s.company_id = a.company_id and s.area_id = a.id
              and (s.resolution is null or s.resolution = 'rejected')
         )
       order by recent.used desc, e.display_order, lower(a.name_en), a.id
       limit ${SUGGEST_BATCH + 1}
    `.execute(this.database);
    const batch = candidates.rows.slice(0, SUGGEST_BATCH);
    let looked = 0;
    let flagged = 0;
    let notFound = 0;
    let stopped: SuggestPinsResult["stopped"] = null;
    for (let index = 0; index < batch.length && stopped === null; index += SUGGEST_CONCURRENCY) {
      const slice = batch.slice(index, index + SUGGEST_CONCURRENCY);
      const outcomes = await Promise.allSettled(
        slice.map(async (area) => {
          const query = geocodeQuery(area);
          return { area, query, outcome: await this.geocoder.geocode(query) };
        }),
      );
      for (const settled of outcomes) {
        if (settled.status === "rejected") {
          if (settled.reason instanceof GeocoderQuotaReached) {
            stopped = "quota";
            continue;
          }
          // A denied key or an unreachable Google: with nothing saved yet the
          // administrator gets Google's reason; otherwise keep what was saved.
          if (looked === 0 && stopped === null) throw settled.reason;
          stopped ??= "google_error";
          continue;
        }
        const { area, query, outcome } = settled.value;
        const flag = suggestionFlag(area.emirateCode, outcome);
        await sql`
          insert into area_coordinate_suggestions (
            company_id, area_id, query, latitude, longitude, formatted_address,
            result_types, flag, created_by_account_id
          ) values (
            ${companyId}::uuid, ${area.id}::uuid, ${query.slice(0, 300)},
            ${outcome.point?.latitude ?? null}, ${outcome.point?.longitude ?? null},
            ${outcome.formattedAddress}, ${JSON.stringify(outcome.resultTypes)}::jsonb,
            ${flag}, ${accountId}::uuid
          )
          on conflict (company_id, area_id) where resolution is null do nothing
        `.execute(this.database);
        looked += 1;
        if (flag === "not_found") notFound += 1;
        else if (flag !== null) flagged += 1;
      }
    }
    if (looked > 0) {
      await this.audit(this.database, companyId, accountId, correlationId, {
        action: "route_planning.pins_suggested",
        subjectType: "company_route_optimization_settings",
        subjectId: companyId,
        before: null,
        after: { source: "google_geocoding", looked, flagged, notFound },
      });
    }
    const remaining = await sql<{ count: string }>`
      select count(*)::text as count
        from areas a
       where a.company_id = ${companyId}::uuid and a.is_active and a.coordinates_verified_at is null
         and not exists (
           select 1 from area_coordinate_suggestions s
            where s.company_id = a.company_id and s.area_id = a.id
              and (s.resolution is null or s.resolution = 'rejected')
         )
    `.execute(this.database);
    return {
      looked,
      flagged,
      notFound,
      remaining: Number(remaining.rows[0]?.count ?? 0),
      stopped,
      setup: await this.setup(),
    };
  }

  /** Accept one Area's Google suggestion: it becomes the confirmed pin. */
  public async acceptSuggestion(areaId: string, correlationId: string): Promise<RouteSetup> {
    const { companyId, accountId } = this.scope();
    await this.transactions.execute(async (transaction) => {
      const accepted = await this.acceptOpen(transaction, companyId, accountId, correlationId, {
        areaId,
        cleanOnly: false,
      });
      if (accepted === 0) {
        throw new ApplicationException(
          "route_suggestion_not_found",
          "There is no Google suggestion with a position for this Area",
          HttpStatus.CONFLICT,
        );
      }
    });
    return this.setup();
  }

  /** Accept every open suggestion that carries no warning. */
  public async acceptCleanSuggestions(
    correlationId: string,
  ): Promise<{ readonly accepted: number; readonly setup: RouteSetup }> {
    const { companyId, accountId } = this.scope();
    const accepted = await this.transactions.execute((transaction) =>
      this.acceptOpen(transaction, companyId, accountId, correlationId, {
        areaId: null,
        cleanOnly: true,
      }),
    );
    return { accepted, setup: await this.setup() };
  }

  /** Reject an Area's suggestion; the Area is then pinned by hand. */
  public async rejectSuggestion(areaId: string, correlationId: string): Promise<RouteSetup> {
    const { companyId, accountId } = this.scope();
    await this.transactions.execute(async (transaction) => {
      const rejected = await this.resolveOpenSuggestion(
        transaction,
        companyId,
        accountId,
        areaId,
        "rejected",
      );
      if (rejected === 0) {
        throw new ApplicationException(
          "route_suggestion_not_found",
          "There is no open Google suggestion for this Area",
          HttpStatus.CONFLICT,
        );
      }
      await this.audit(transaction, companyId, accountId, correlationId, {
        action: "area.coordinates_suggestion_rejected",
        subjectType: "area",
        subjectId: areaId,
        before: null,
        after: { resolution: "rejected" },
      });
    });
    return this.setup();
  }

  private async acceptOpen(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
    accountId: string,
    correlationId: string,
    filter: { readonly areaId: string | null; readonly cleanOnly: boolean },
  ): Promise<number> {
    const open = await sql<{
      suggestionId: string;
      areaId: string;
      latitude: string;
      longitude: string;
      flag: SuggestionFlag | null;
      beforeLatitude: string | null;
      beforeLongitude: string | null;
    }>`
      select s.id as "suggestionId", s.area_id as "areaId",
             s.latitude::text as latitude, s.longitude::text as longitude, s.flag,
             a.latitude::text as "beforeLatitude", a.longitude::text as "beforeLongitude"
        from area_coordinate_suggestions s
        join areas a on a.company_id = s.company_id and a.id = s.area_id and a.is_active
       where s.company_id = ${companyId}::uuid
         and s.resolution is null
         and s.latitude is not null
         and ${filter.areaId === null ? sql`true` : sql`s.area_id = ${filter.areaId}::uuid`}
         and ${filter.cleanOnly ? sql`s.flag is null` : sql`true`}
       order by s.area_id
       for update of s, a
    `.execute(transaction);
    for (const row of open.rows) {
      await sql`
        update areas
           set latitude = ${row.latitude}::numeric, longitude = ${row.longitude}::numeric,
               coordinates_verified_at = now(),
               coordinates_verified_by_account_id = ${accountId}::uuid,
               updated_at = now(), version = version + 1
         where company_id = ${companyId}::uuid and id = ${row.areaId}::uuid
      `.execute(transaction);
      await sql`
        update area_coordinate_suggestions
           set resolution = 'accepted', resolved_at = now(), resolved_by_account_id = ${accountId}::uuid
         where company_id = ${companyId}::uuid and id = ${row.suggestionId}::uuid
      `.execute(transaction);
      await this.audit(transaction, companyId, accountId, correlationId, {
        action: "area.coordinates_verified",
        subjectType: "area",
        subjectId: row.areaId,
        before: { latitude: row.beforeLatitude, longitude: row.beforeLongitude },
        after: {
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
          source: "google_geocoding",
          flag: row.flag,
        },
      });
    }
    return open.rows.length;
  }

  private async resolveOpenSuggestion(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
    accountId: string,
    areaId: string,
    resolution: "accepted" | "rejected",
  ): Promise<number> {
    const result = await sql`
      update area_coordinate_suggestions
         set resolution = ${resolution}, resolved_at = now(), resolved_by_account_id = ${accountId}::uuid
       where company_id = ${companyId}::uuid and area_id = ${areaId}::uuid and resolution is null
    `.execute(transaction);
    return Number(result.numAffectedRows ?? 0n);
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
    transaction: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
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
