import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { IdentityContext } from "../security/identity-context.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import type {
  ListClientErrorReportsQueryDto,
  ReportClientErrorDto,
  UpdateClientErrorReportDto,
} from "./client-error-report.dto.js";

export interface ClientErrorReportRow {
  readonly id: string;
  readonly companyId: string | null;
  readonly companyName: string | null;
  readonly sourceApp: string;
  readonly severity: "high" | "medium" | "low";
  readonly status: "open" | "resolved";
  readonly message: string;
  readonly stack: string | null;
  readonly correlationId: string | null;
  readonly path: string | null;
  readonly accountId: string | null;
  readonly accountKind: string | null;
  readonly appCommit: string | null;
  readonly explanation: string | null;
  readonly resolutionNotes: string | null;
  readonly resolvedByAccountId: string | null;
  readonly resolvedByUsername: string | null;
  readonly resolvedAt: string | null;
  readonly occurredAt: string;
}

/**
 * Captures and triages crashes from any app (`web`, `api`, `platform-web`,
 * `store`) into one place a Platform Administrator can actually work from --
 * see `20260820000000_client_error_reports.ts` for why the schema looks the
 * way it does.
 *
 * `report()` is called two ways: directly by `ClientErrorReportController`
 * when a frontend error boundary posts a crash, and internally by
 * `ApiExceptionFilter` for every unhandled 500 the API itself produces. Both
 * paths funnel through the same insert, so the Platform never has to look in
 * two places for "what crashed."
 */
@Injectable()
export class ClientErrorReportService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(IdentityContextAccessor) private readonly identity: IdentityContextAccessor,
    @Inject(RequestSecurityContextStore)
    private readonly securityContext: RequestSecurityContextStore,
  ) {}

  /**
   * Used by `ClientErrorReportController` -- deliberately a `@Public()`
   * route, not gated on any identity kind. The Store serves anonymous
   * shoppers who have never signed in, and a crash can happen before that
   * ever changes; requiring auth here would silently drop exactly the
   * reports a public storefront needs most. Identity is read only if a
   * session happens to exist (`RequestSecurityContextStore.current()`
   * throws when it doesn't, so this never assumes one).
   */
  public async reportFromRequest(input: ReportClientErrorDto): Promise<{ id: string }> {
    let identity: IdentityContext | undefined;
    try {
      identity = this.securityContext.current().identity;
    } catch {
      identity = undefined;
    }
    return this.insert({
      accountId: identity?.identityId ?? null,
      accountKind: identity?.kind ?? null,
      appCommit: input.appCommit ?? null,
      companyId: identity?.companyId ?? null,
      correlationId: input.correlationId ?? null,
      message: input.message,
      path: input.path ?? null,
      severity: "high",
      sourceApp: input.sourceApp,
      stack: input.stack ?? null,
    });
  }

  /**
   * Used by `ApiExceptionFilter` for a backend 500. Identity may or may not
   * be available (a request can crash before authentication resolves), so
   * every identity field is optional here -- never throws on a missing one,
   * since a failure to capture must never turn into a second, worse failure.
   */
  public async reportServerError(input: {
    readonly message: string;
    readonly stack: string | null;
    readonly correlationId: string | null;
    readonly path: string | null;
    readonly identity: IdentityContext | undefined;
  }): Promise<void> {
    try {
      await this.insert({
        accountId: input.identity?.identityId ?? null,
        accountKind: input.identity?.kind ?? null,
        appCommit: null,
        companyId: input.identity?.companyId ?? null,
        correlationId: input.correlationId,
        message: input.message,
        path: input.path,
        severity: "high",
        sourceApp: "api",
        stack: input.stack,
      });
    } catch {
      // Deliberately swallowed: this runs inside the exception filter that is
      // already handling a failure. A broken capture must never mask, or
      // replace, the actual error response the caller is waiting on.
    }
  }

  private async insert(input: {
    readonly accountId: string | null;
    readonly accountKind: string | null;
    readonly appCommit: string | null;
    readonly companyId: string | null;
    readonly correlationId: string | null;
    readonly message: string;
    readonly path: string | null;
    readonly severity: "high" | "medium" | "low";
    readonly sourceApp: string;
    readonly stack: string | null;
  }): Promise<{ id: string }> {
    const result = await sql<{ id: string }>`
      insert into client_error_reports
        (source_app, severity, message, stack, correlation_id, path,
         account_id, account_kind, company_id, app_commit)
      values
        (${input.sourceApp}, ${input.severity}, ${input.message}, ${input.stack},
         ${input.correlationId}, ${input.path}, ${input.accountId}::uuid,
         ${input.accountKind}, ${input.companyId}::uuid, ${input.appCommit})
      returning id
    `.execute(this.database);
    return { id: result.rows[0]!.id };
  }

  public async list(
    query: ListClientErrorReportsQueryDto,
  ): Promise<{ items: readonly ClientErrorReportRow[]; page: number; pageSize: number; total: number }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const offset = (page - 1) * pageSize;
    const search = query.search?.trim() ?? "";
    const result = await sql<ClientErrorReportRow & { total: number }>`
      select r.id, r.company_id as "companyId", c.name_en as "companyName",
             r.source_app as "sourceApp", r.severity, r.status, r.message,
             r.stack, r.correlation_id as "correlationId", r.path,
             r.account_id as "accountId", r.account_kind as "accountKind",
             r.app_commit as "appCommit", r.explanation,
             r.resolution_notes as "resolutionNotes",
             r.resolved_by_account_id as "resolvedByAccountId",
             resolver.username as "resolvedByUsername",
             r.resolved_at::text as "resolvedAt", r.occurred_at::text as "occurredAt",
             count(*) over ()::int as total
        from client_error_reports r
        left join companies c on c.id = r.company_id
        left join accounts resolver on resolver.id = r.resolved_by_account_id
       where (${query.companyId ?? null}::uuid is null or r.company_id = ${query.companyId ?? null}::uuid)
         and (${query.sourceApp ?? null}::text is null or r.source_app = ${query.sourceApp ?? null})
         and (${query.severity ?? null}::text is null or r.severity = ${query.severity ?? null})
         and (${query.status ?? null}::text is null or r.status = ${query.status ?? null})
         and (${search} = '' or r.message ilike ${`%${search}%`}
              or coalesce(r.correlation_id, '') ilike ${`%${search}%`}
              or coalesce(r.path, '') ilike ${`%${search}%`})
       order by (r.status = 'open') desc, r.occurred_at desc
       limit ${pageSize} offset ${offset}
    `.execute(this.database);
    return {
      items: result.rows,
      page,
      pageSize,
      total: result.rows[0]?.total ?? 0,
    };
  }

  public async detail(id: string): Promise<ClientErrorReportRow> {
    const result = await sql<ClientErrorReportRow>`
      select r.id, r.company_id as "companyId", c.name_en as "companyName",
             r.source_app as "sourceApp", r.severity, r.status, r.message,
             r.stack, r.correlation_id as "correlationId", r.path,
             r.account_id as "accountId", r.account_kind as "accountKind",
             r.app_commit as "appCommit", r.explanation,
             r.resolution_notes as "resolutionNotes",
             r.resolved_by_account_id as "resolvedByAccountId",
             resolver.username as "resolvedByUsername",
             r.resolved_at::text as "resolvedAt", r.occurred_at::text as "occurredAt"
        from client_error_reports r
        left join companies c on c.id = r.company_id
        left join accounts resolver on resolver.id = r.resolved_by_account_id
       where r.id = ${id}::uuid
    `.execute(this.database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "error_report_not_found",
        "Error report not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  /**
   * Reopening (status -> 'open') clears the resolver fields rather than
   * leaving a stale "resolved by X" on a report that is, right now, not
   * resolved -- `client_error_reports_resolution_check` enforces this pairing
   * at the database level too, so this can't silently drift even if a future
   * caller forgets.
   */
  public async update(id: string, input: UpdateClientErrorReportDto): Promise<ClientErrorReportRow> {
    const identity = this.identity.current();
    const resolving = input.status === "resolved";
    const reopening = input.status === "open";
    await sql`
      update client_error_reports
         set severity = coalesce(${input.severity ?? null}, severity),
             status = coalesce(${input.status ?? null}, status),
             explanation = case when ${input.explanation !== undefined}
               then ${input.explanation ?? null} else explanation end,
             resolution_notes = case when ${input.resolutionNotes !== undefined}
               then ${input.resolutionNotes ?? null} else resolution_notes end,
             resolved_by_account_id = case
               when ${resolving} then ${identity.identityId}::uuid
               when ${reopening} then null
               else resolved_by_account_id end,
             resolved_at = case
               when ${resolving} then now()
               when ${reopening} then null
               else resolved_at end
       where id = ${id}::uuid
    `.execute(this.database);
    return this.detail(id);
  }
}
