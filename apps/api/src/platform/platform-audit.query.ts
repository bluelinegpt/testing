import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * Reads the Platform administrative trail across every Company.
 *
 * ---------------------------------------------------------------------------
 * WHY FILTERING AND PAGING HAPPEN IN THE DATABASE
 * ---------------------------------------------------------------------------
 *
 * `audit_events` grows without bound and is never pruned — that is the point of
 * an append-only trail. Fetching a page's worth of rows and filtering them in
 * the API would either return a wrong page or read the whole table to build a
 * right one. Every filter below is therefore part of the SQL, and the total is
 * a `count(*) over ()` window on the same scan rather than a second query that
 * could disagree with the first.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ACTION FILTER IS NOT NEGOTIABLE
 * ---------------------------------------------------------------------------
 *
 * `action like 'platform.%'` is applied unconditionally, not as a default the
 * caller can widen. `audit_events` also holds Company operational history —
 * order edits, settlement changes, configuration writes. This screen exists to
 * answer "what did Platform administration do", and letting a query parameter
 * turn it into a cross-Company reader of every Company's operational records
 * would quietly create a far broader disclosure than the permission grants.
 */
export interface PlatformAuditQuery {
  readonly companyId?: string | undefined;
  readonly action?: string | undefined;
  readonly actorAccountId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
}

interface AuditRow extends Record<string, unknown> {
  total: string | number;
}

@Injectable()
export class PlatformAuditQueryService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async search(query: PlatformAuditQuery): Promise<{
    items: readonly Record<string, unknown>[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const pageSize = Math.min(Math.max(Math.trunc(query.pageSize), 1), 100);
    const page = Math.max(Math.trunc(query.page), 1);

    // Every value is a bound parameter. `action` is matched as a PREFIX with
    // its wildcards escaped, so a caller cannot smuggle `%` in and widen their
    // own filter to everything.
    const actionPrefix =
      query.action === undefined ? null : `${query.action.replace(/[\\%_]/g, "\\$&")}%`;

    const rows = (
      await sql<AuditRow>`
        select e.id,
               e.action,
               e.subject_type as "subjectType",
               e.subject_id as "subjectId",
               e.reason,
               e.before_data as "before",
               e.after_data as "after",
               e.occurred_at as "occurredAt",
               e.correlation_id as "correlationId",
               e.source,
               e.result,
               e.failure_reason as "failureReason",
               e.source_application as "sourceApplication",
               e.company_id as "companyId",
               c.name_en as "companyName",
               a.username as "actorUsername",
               e.actor_account_id as "actorAccountId",
               count(*) over () as total
          from audit_events e
          left join companies c on c.id = e.company_id
          left join accounts a on a.id = e.actor_account_id
         where e.action like 'platform.%'
           and (${query.companyId ?? null}::uuid is null or e.company_id = ${query.companyId ?? null}::uuid)
           and (${actionPrefix}::text is null or e.action like ${actionPrefix} escape '\\')
           and (${query.actorAccountId ?? null}::uuid is null
                or e.actor_account_id = ${query.actorAccountId ?? null}::uuid)
           and (${query.from ?? null}::timestamptz is null
                or e.occurred_at >= ${query.from ?? null}::timestamptz)
           and (${query.to ?? null}::timestamptz is null
                or e.occurred_at < ${query.to ?? null}::timestamptz)
         order by e.occurred_at desc, e.id desc
         limit ${pageSize} offset ${(page - 1) * pageSize}
      `.execute(this.database)
    ).rows;

    // `count(*) over ()` disappears with the rows on an empty page, so an empty
    // result reports zero rather than reading a total that is not there.
    const total = rows.length === 0 ? 0 : Number(rows[0]?.total ?? 0);
    return {
      // `total` is a window function carried on every row; it is transport,
      // not part of an audit entry, so it is dropped rather than returned.
      items: rows.map((row) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => key !== "total")),
      ),
      total,
      page,
      pageSize,
    };
  }

  /** The distinct Platform actions present, for populating the filter. */
  public async actions(): Promise<readonly string[]> {
    return (
      await sql<{ action: string }>`
        select distinct action from audit_events
         where action like 'platform.%' order by action
      `.execute(this.database)
    ).rows.map((row) => row.action);
  }
}
