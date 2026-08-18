import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

import type {
  AreaListQueryDto,
  AreaSearchQueryDto,
  CreateAreaDto,
  UpdateAreaDto,
} from "./area-configuration.dto.js";
import { areaPageSizes } from "./area-configuration.dto.js";

export interface Emirate {
  readonly code: string;
  readonly id: string;
  readonly nameAr: string;
  readonly nameEn: string;
}

export interface ConfiguredArea {
  readonly code: string;
  readonly emirateCode: string;
  readonly emirateId: string;
  readonly emirateNameAr: string;
  readonly emirateNameEn: string;
  readonly id: string;
  readonly isActive: boolean;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly notes: string | null;
  readonly updatedAt: string;
}

export interface AreaPage {
  readonly items: readonly ConfiguredArea[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface AreaSearchPage {
  readonly hasMore: boolean;
  readonly items: readonly ConfiguredArea[];
  readonly total: number;
}

/**
 * Areas and the read-only Emirate master.
 *
 * Every statement is filtered by the Company from the authenticated tenant
 * context; no caller-supplied Company identifier is ever accepted. Areas are
 * never hard-deleted because Traders, Customers, pricing and Orders reference
 * them and historical records must keep resolving.
 */
@Injectable()
export class AreaConfigurationService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public async emirates(): Promise<readonly Emirate[]> {
    const result = await sql<Emirate>`
      select id, code, name_en as "nameEn", name_ar as "nameAr"
        from emirates
       where is_active
       order by display_order
    `.execute(this.database);
    return result.rows;
  }

  public async list(query: AreaListQueryDto): Promise<AreaPage> {
    const { companyId } = this.tenants.current();
    const pageSize = areaPageSizes.includes(query.pageSize as (typeof areaPageSizes)[number])
      ? Number(query.pageSize)
      : 25;
    const page = Math.max(Number(query.page) || 1, 1);
    const search = query.search?.trim() ?? "";
    const status = query.status ?? "all";
    const emirateId = query.emirateId ?? null;

    const result = await sql<ConfiguredArea & { total: string }>`
      select a.id,
             a.code,
             a.name_en as "nameEn",
             a.name_ar as "nameAr",
             a.notes,
             a.is_active as "isActive",
             a.updated_at as "updatedAt",
             e.id as "emirateId",
             e.code as "emirateCode",
             e.name_en as "emirateNameEn",
             e.name_ar as "emirateNameAr",
             count(*) over () as total
        from areas a
        join emirates e on e.id = a.emirate_id
       where a.company_id = ${companyId}::uuid
         and (${emirateId}::uuid is null or a.emirate_id = ${emirateId}::uuid)
         and (${status} = 'all'
              or (${status} = 'active' and a.is_active)
              or (${status} = 'disabled' and not a.is_active))
         and (${search} = ''
              or a.name_en ilike '%' || ${search} || '%'
              or coalesce(a.name_ar, '') ilike '%' || ${search} || '%'
              or a.code ilike '%' || ${search} || '%')
       -- Stable ordering: code is unique per Company so paging cannot repeat
       -- or drop a row between requests.
       order by e.display_order, lower(btrim(a.name_en)), a.code
       limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(this.database);

    return {
      items: result.rows.map((row) => this.toArea(row)),
      page,
      pageSize,
      total: Number(result.rows[0]?.total ?? 0),
    };
  }

  /** Typeahead source for the shared Area selector. */
  public async search(query: AreaSearchQueryDto): Promise<AreaSearchPage> {
    const { companyId } = this.tenants.current();
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const search = query.search?.trim() ?? "";
    const emirateId = query.emirateId ?? null;
    // Operational pickers default to active Areas only.
    const activeOnly = query.activeOnly ?? true;

    const result = await sql<ConfiguredArea & { total: string }>`
      select a.id,
             a.code,
             a.name_en as "nameEn",
             a.name_ar as "nameAr",
             a.notes,
             a.is_active as "isActive",
             a.updated_at as "updatedAt",
             e.id as "emirateId",
             e.code as "emirateCode",
             e.name_en as "emirateNameEn",
             e.name_ar as "emirateNameAr",
             count(*) over () as total
        from areas a
        join emirates e on e.id = a.emirate_id
       where a.company_id = ${companyId}::uuid
         and (${emirateId}::uuid is null or a.emirate_id = ${emirateId}::uuid)
         and (not ${activeOnly}::boolean or a.is_active)
         and (${search} = ''
              or a.name_en ilike '%' || ${search} || '%'
              or coalesce(a.name_ar, '') ilike '%' || ${search} || '%'
              or a.code ilike '%' || ${search} || '%')
       order by e.display_order, lower(btrim(a.name_en)), a.code
       limit ${limit + 1} offset ${offset}
    `.execute(this.database);

    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    return {
      hasMore,
      items: rows.map((row) => this.toArea(row)),
      total: Number(result.rows[0]?.total ?? 0),
    };
  }

  public async get(areaId: string): Promise<ConfiguredArea> {
    const area = await this.findArea(this.database, areaId);
    if (area === undefined) throw this.notFound();
    return area;
  }

  public async create(input: CreateAreaDto, correlationId: string): Promise<ConfiguredArea> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const nameEn = input.nameEn.trim();
    const nameAr = input.nameAr?.trim() || null;
    const notes = input.notes?.trim() || null;
    if (nameEn.length === 0) throw this.emptyName();

    return this.transactions.execute(async (transaction) => {
      await this.assertEmirateExists(transaction, input.emirateId);
      // Concurrency-safe: the counter row is updated in this transaction, so a
      // parallel create blocks here rather than reusing a code.
      const counterResult = await sql<{ nextValue: string; prefix: string }>`
        insert into company_reference_counters (company_id, reference_type, next_value, prefix)
        values (${companyId}::uuid, 'area', 2, 'AREA')
        on conflict (company_id, reference_type)
        do update set next_value = company_reference_counters.next_value + 1,
                      updated_at = now()
        returning prefix, (next_value - 1)::text as "nextValue"
      `.execute(transaction);
      const counter = counterResult.rows[0];
      if (counter === undefined) throw new Error("Area counter did not return a value");
      const code = `${counter.prefix}-${counter.nextValue.padStart(6, "0")}`;

      let inserted;
      try {
        inserted = await sql<{ id: string }>`
          insert into areas (company_id, emirate_id, code, name_en, name_ar, notes, is_active)
          values (${companyId}::uuid, ${input.emirateId}::uuid, ${code}, ${nameEn}, ${nameAr},
                  ${notes}, true)
          returning id
        `.execute(transaction);
      } catch (error) {
        throw this.duplicateOrRethrow(error);
      }
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error("Area creation did not return an identifier");

      await this.audit(transaction, {
        action: "area.create",
        actorId: identity.identityId,
        after: { code, emirateId: input.emirateId, nameAr, nameEn, notes },
        before: null,
        companyId,
        correlationId,
        subjectId: id,
      });

      const created = await this.findArea(transaction, id);
      if (created === undefined) throw new Error("Area was not readable after creation");
      return created;
    });
  }

  public async update(
    areaId: string,
    input: UpdateAreaDto,
    correlationId: string,
  ): Promise<ConfiguredArea> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();

    return this.transactions.execute(async (transaction) => {
      const before = await this.findArea(transaction, areaId);
      if (before === undefined) throw this.notFound();

      const nameEn = input.nameEn === undefined ? before.nameEn : input.nameEn.trim();
      if (nameEn.length === 0) throw this.emptyName();
      const nameAr = input.nameAr === undefined ? before.nameAr : input.nameAr.trim() || null;
      const notes = input.notes === undefined ? before.notes : input.notes.trim() || null;
      const emirateId = input.emirateId ?? before.emirateId;

      if (emirateId !== before.emirateId) {
        await this.assertEmirateExists(transaction, emirateId);
      }

      try {
        await sql`
          update areas
             set emirate_id = ${emirateId}::uuid,
                 name_en = ${nameEn},
                 name_ar = ${nameAr},
                 notes = ${notes},
                 updated_at = now(),
                 version = version + 1
           where id = ${areaId}::uuid and company_id = ${companyId}::uuid
        `.execute(transaction);
      } catch (error) {
        throw this.duplicateOrRethrow(error);
      }

      await this.audit(transaction, {
        action: "area.update",
        actorId: identity.identityId,
        after: { emirateId, nameAr, nameEn, notes },
        before: {
          emirateId: before.emirateId,
          nameAr: before.nameAr,
          nameEn: before.nameEn,
          notes: before.notes,
        },
        companyId,
        correlationId,
        subjectId: areaId,
      });

      const updated = await this.findArea(transaction, areaId);
      if (updated === undefined) throw new Error("Area was not readable after update");
      return updated;
    });
  }

  public async setStatus(
    areaId: string,
    isActive: boolean,
    correlationId: string,
  ): Promise<ConfiguredArea> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();

    return this.transactions.execute(async (transaction) => {
      const before = await this.findArea(transaction, areaId);
      if (before === undefined) throw this.notFound();

      await sql`
        update areas
           set is_active = ${isActive},
               deactivated_at = case when ${isActive} then null else now() end,
               updated_at = now(),
               version = version + 1
         where id = ${areaId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);

      await this.audit(transaction, {
        action: isActive ? "area.enable" : "area.disable",
        actorId: identity.identityId,
        after: { isActive },
        before: { isActive: before.isActive },
        companyId,
        correlationId,
        subjectId: areaId,
      });

      const updated = await this.findArea(transaction, areaId);
      if (updated === undefined) throw new Error("Area was not readable after status change");
      return updated;
    });
  }

  /** Drops the window-function total from a projected row. */
  private toArea(row: ConfiguredArea & { total: string }): ConfiguredArea {
    return {
      code: row.code,
      emirateCode: row.emirateCode,
      emirateId: row.emirateId,
      emirateNameAr: row.emirateNameAr,
      emirateNameEn: row.emirateNameEn,
      id: row.id,
      isActive: row.isActive,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      notes: row.notes,
      updatedAt: row.updatedAt,
    };
  }

  private async findArea(
    database:
      Kysely<DatabaseSchema> | Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    areaId: string,
  ): Promise<ConfiguredArea | undefined> {
    const { companyId } = this.tenants.current();
    const result = await sql<ConfiguredArea>`
      select a.id,
             a.code,
             a.name_en as "nameEn",
             a.name_ar as "nameAr",
             a.notes,
             a.is_active as "isActive",
             a.updated_at as "updatedAt",
             e.id as "emirateId",
             e.code as "emirateCode",
             e.name_en as "emirateNameEn",
             e.name_ar as "emirateNameAr"
        from areas a
        join emirates e on e.id = a.emirate_id
       where a.id = ${areaId}::uuid and a.company_id = ${companyId}::uuid
    `.execute(database);
    return result.rows[0];
  }

  private async assertEmirateExists(
    transaction: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    emirateId: string,
  ): Promise<void> {
    const result = await sql<{ id: string }>`
      select id from emirates where id = ${emirateId}::uuid and is_active
    `.execute(transaction);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "emirate_not_found",
        "The selected Emirate does not exist",
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async audit(
    transaction: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    input: {
      action: string;
      actorId: string;
      after: object;
      before: object | null;
      companyId: string;
      correlationId: string;
      subjectId: string;
    },
  ): Promise<void> {
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        before_data, after_data, correlation_id
      ) values (
        ${input.companyId}::uuid, ${input.actorId}::uuid, ${input.action}, 'area',
        ${input.subjectId}::uuid,
        ${input.before === null ? null : JSON.stringify(input.before)}::jsonb,
        ${JSON.stringify(input.after)}::jsonb, ${input.correlationId}::uuid
      )
    `.execute(transaction);
  }

  private notFound(): ApplicationException {
    return new ApplicationException(
      "area_not_found",
      "The Area was not found",
      HttpStatus.NOT_FOUND,
    );
  }

  private emptyName(): ApplicationException {
    return new ApplicationException(
      "area_name_required",
      "Area Name is required",
      HttpStatus.BAD_REQUEST,
    );
  }

  /** Surfaces the uniqueness rule without leaking index or schema names. */
  private duplicateOrRethrow(error: unknown): unknown {
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      return new ApplicationException(
        "area_exists",
        "An Area with this name already exists in the selected Emirate",
        HttpStatus.CONFLICT,
      );
    }
    return error;
  }
}
