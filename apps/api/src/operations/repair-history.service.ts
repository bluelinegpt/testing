import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";

/**
 * REPAIR CENTER HISTORY (Phase 2, Prompt 5). Read-only, one Company.
 *
 * One chronology merged in SQL from:
 *   - `platform_repair_executions` -> SUCCEEDED (the one authoritative record
 *     per repair actually applied);
 *   - `platform_repair_attempts`   -> REFUSED / FAILED / REPLAYED (no repair
 *     applied by the attempt itself; a REPLAYED row links the execution).
 * Paginated in the database (one statement with a window count). Only
 * identifiers, business references, codes and the administrator's username
 * are returned: no customer data, payloads, raw idempotency keys or traces.
 */

export const REPAIR_HISTORY_RESULTS = ["SUCCEEDED", "REFUSED", "FAILED", "REPLAYED"] as const;
export type RepairHistoryResult = (typeof REPAIR_HISTORY_RESULTS)[number];
export const REPAIR_HISTORY_MAX_PAGE_SIZE = 100;

export interface RepairHistoryRow {
  readonly kind: "execution" | "attempt";
  readonly id: string;
  readonly occurredAt: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly entityNumber: string | null;
  readonly findingId: string | null;
  readonly reasonCode: string | null;
  readonly capabilityCode: string | null;
  readonly actor: string | null;
  readonly result: RepairHistoryResult;
  readonly reason: string | null;
  readonly outcome: string | null;
  readonly errorCode: string | null;
  readonly correlationId: string | null;
  readonly repairExecutionId: string | null;
  /** True only for SUCCEEDED: an attempt never applied a repair. */
  readonly repairApplied: boolean;
}

export interface RepairHistoryPage {
  readonly items: readonly RepairHistoryRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly generatedAt: string;
}

export interface RepairHistoryQuery {
  readonly result?: RepairHistoryResult | undefined;
  readonly capabilityCode?: string | undefined;
  readonly entityType?: string | undefined;
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
}

export interface RepairHistoryDetail extends RepairHistoryRow {
  readonly companyId: string;
  readonly actorAuthority: string;
  readonly previewVersion: string | null;
  readonly repairAppliedStatement: string;
  /** SUCCEEDED only. */
  readonly execution: {
    readonly beforeFingerprint: string;
    readonly afterFingerprint: string;
    readonly beforeHealth: string;
    readonly afterHealth: string;
    readonly beforeClassification: string;
    readonly afterClassification: string;
    readonly outcome: Readonly<Record<string, string | number | boolean | null>>;
    /** Idempotent replays of this execution (none of them repaired anything). */
    readonly replays: number;
  } | null;
}

export interface RepairHistoryCounts {
  readonly succeeded: number;
  readonly failed: number;
  readonly refused: number;
  readonly replayed: number;
  readonly lastRepairAt: string | null;
}

@Injectable()
export class RepairHistoryService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  private async readOnly<T>(work: (db: Kysely<DatabaseSchema>) => Promise<T>): Promise<T> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`set transaction read only`.execute(transaction);
      await sql`select set_config('statement_timeout', '30s', true), set_config('jit', 'off', true)`.execute(
        transaction,
      );
      return work(transaction);
    });
  }

  /** The merged chronology, as one CTE. */
  private merged(companyId: string) {
    return sql`
      merged as (
        select 'execution'::text as kind, x.id, x.created_at, x.entity_type, x.entity_id, x.entity_number,
               x.finding_id, x.reason_code, x.capability_code, x.actor_account_id, 'SUCCEEDED'::text as result,
               x.reason, x.before_classification || ' -> ' || x.after_classification as outcome,
               null::text as error_code, x.correlation_id, x.id as repair_execution_id
          from platform_repair_executions x
         where x.company_id = ${companyId}::uuid
        union all
        select 'attempt'::text, a.id, a.created_at, a.entity_type, a.entity_id, a.entity_number,
               a.finding_id, a.reason_code, a.capability_code, a.actor_account_id, a.result,
               a.reason, a.safe_error_summary, a.error_code, a.correlation_id, a.repair_execution_id
          from platform_repair_attempts a
         where a.company_id = ${companyId}::uuid
      )
    `;
  }

  public list(companyId: string, query: RepairHistoryQuery): Promise<RepairHistoryPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(REPAIR_HISTORY_MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? 25));
    return this.readOnly(async (db) => {
      const result = await sql<RepairHistoryRow & { total: number }>`
        with ${this.merged(companyId)}
        select m.kind, m.id, m.created_at::text as "occurredAt", m.entity_type as "entityType",
               m.entity_id as "entityId", m.entity_number as "entityNumber", m.finding_id as "findingId",
               m.reason_code as "reasonCode", m.capability_code as "capabilityCode", acc.username as actor,
               m.result, m.reason, m.outcome, m.error_code as "errorCode", m.correlation_id as "correlationId",
               m.repair_execution_id as "repairExecutionId", m.result = 'SUCCEEDED' as "repairApplied",
               count(*) over ()::int as total
          from merged m
          left join accounts acc on acc.id = m.actor_account_id
         where (${query.result ?? null}::text is null or m.result = ${query.result ?? null})
           and (${query.capabilityCode ?? null}::text is null or m.capability_code = ${query.capabilityCode ?? null})
           and (${query.entityType ?? null}::text is null or m.entity_type = ${query.entityType ?? null})
         order by m.created_at desc, m.id desc
         limit ${pageSize} offset ${(page - 1) * pageSize}
      `.execute(db);
      return {
        generatedAt: new Date().toISOString(),
        items: result.rows.map(({ total, ...row }) => {
          void total;
          return row;
        }),
        page,
        pageSize,
        total: result.rows[0]?.total ?? 0,
      };
    });
  }

  public counts(companyId: string, db: Kysely<DatabaseSchema> = this.database): Promise<RepairHistoryCounts> {
    return sql<RepairHistoryCounts>`
      select (select count(*)::int from platform_repair_executions where company_id = ${companyId}::uuid) as succeeded,
             count(*) filter (where result = 'FAILED')::int as failed,
             count(*) filter (where result = 'REFUSED')::int as refused,
             count(*) filter (where result = 'REPLAYED')::int as replayed,
             (select max(created_at)::text from platform_repair_executions where company_id = ${companyId}::uuid)
               as "lastRepairAt"
        from platform_repair_attempts where company_id = ${companyId}::uuid
    `
      .execute(db)
      .then((result) => result.rows[0]!);
  }

  public detail(companyId: string, kind: "execution" | "attempt", id: string): Promise<RepairHistoryDetail> {
    return this.readOnly(async (db) => {
      const notFound = () =>
        new ApplicationException("repair_history_not_found", "The repair history record was not found", HttpStatus.NOT_FOUND);
      if (kind === "execution") {
        const row = (
          await sql<RepairHistoryDetail["execution"] & RepairHistoryRow & { actorAuthority: string; previewVersion: string; replays: number; summary: { domainOutcome?: Record<string, unknown> } }>`
            select 'execution' as kind, x.id, x.created_at::text as "occurredAt", x.entity_type as "entityType",
                   x.entity_id as "entityId", x.entity_number as "entityNumber", x.finding_id as "findingId",
                   x.reason_code as "reasonCode", x.capability_code as "capabilityCode", acc.username as actor,
                   'SUCCEEDED' as result, x.reason, x.before_classification || ' -> ' || x.after_classification as outcome,
                   null as "errorCode", x.correlation_id as "correlationId", x.id as "repairExecutionId",
                   true as "repairApplied", x.actor_authority as "actorAuthority", x.preview_version as "previewVersion",
                   x.before_state_fingerprint as "beforeFingerprint", x.after_state_fingerprint as "afterFingerprint",
                   x.before_health as "beforeHealth", x.after_health as "afterHealth",
                   x.before_classification as "beforeClassification", x.after_classification as "afterClassification",
                   x.result_summary as summary,
                   (select count(*)::int from platform_repair_attempts a
                     where a.company_id = x.company_id and a.repair_execution_id = x.id) as replays
              from platform_repair_executions x
              left join accounts acc on acc.id = x.actor_account_id
             where x.id = ${id}::uuid and x.company_id = ${companyId}::uuid
          `.execute(db)
        ).rows[0];
        if (row === undefined) throw notFound();
        // Only scalar, non-personal outcome facts (amounts, numbers, ids).
        const outcome = Object.fromEntries(
          Object.entries(row.summary?.domainOutcome ?? {}).filter(
            ([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value),
          ),
        ) as Record<string, string | number | boolean | null>;
        const { summary, beforeFingerprint, afterFingerprint, beforeHealth, afterHealth, beforeClassification, afterClassification, replays, ...base } = row;
        void summary;
        return {
          ...base,
          companyId,
          execution: { afterClassification, afterFingerprint, afterHealth, beforeClassification, beforeFingerprint, beforeHealth, outcome, replays },
          repairAppliedStatement: "This repair was applied, atomically, with this audit record.",
        };
      }
      const row = (
        await sql<RepairHistoryRow & { actorAuthority: string; previewVersion: string | null }>`
          select 'attempt' as kind, a.id, a.created_at::text as "occurredAt", a.entity_type as "entityType",
                 a.entity_id as "entityId", a.entity_number as "entityNumber", a.finding_id as "findingId",
                 a.reason_code as "reasonCode", a.capability_code as "capabilityCode", acc.username as actor,
                 a.result, a.reason, a.safe_error_summary as outcome, a.error_code as "errorCode",
                 a.correlation_id as "correlationId", a.repair_execution_id as "repairExecutionId",
                 false as "repairApplied", a.actor_authority as "actorAuthority", a.preview_version as "previewVersion"
            from platform_repair_attempts a
            left join accounts acc on acc.id = a.actor_account_id
           where a.id = ${id}::uuid and a.company_id = ${companyId}::uuid
        `.execute(db)
      ).rows[0];
      if (row === undefined) throw notFound();
      return {
        ...row,
        companyId,
        execution: null,
        repairAppliedStatement:
          row.result === "REPLAYED"
            ? "No repair was applied by this request: it replayed an earlier successful repair (linked)."
            : "No repair was applied. Business and financial data were not changed by this attempt.",
      };
    });
  }
}
