import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";

export interface PlatformActor {
  readonly accountId: string;
  readonly correlationId: string;
}

export interface CompanyRouteOptimization {
  readonly companyId: string;
  readonly isEnabled: boolean;
  /** Platform kill switch; when off, no Company plans with the engine. */
  readonly platformEnabled: boolean;
  readonly provider: string;
  readonly dailyCallBudget: number;
  readonly version: number;
  readonly branchSet: boolean;
  readonly areaCount: number;
  readonly verifiedAreaCount: number;
  readonly updatedAt: string | null;
  /** Runs planned per business date, last 14 days, newest first. */
  readonly runsByDay: readonly {
    readonly businessDate: string;
    readonly runs: number;
    readonly fallbackRuns: number;
  }[];
  /** Paid-engine calls per business date (empty while only the free engine is used). */
  readonly usageByDay: readonly {
    readonly businessDate: string;
    readonly callCount: number;
    readonly successCount: number;
    readonly failureCount: number;
    readonly fallbackCount: number;
  }[];
}

export interface RouteKillSwitch {
  readonly isEnabled: boolean;
  readonly note: string | null;
  readonly updatedAt: string;
}

const DEFAULT_BUDGET = 200;

/**
 * Platform Administration → Company → Route planning, and the Platform-wide
 * kill switch. A leaf service (database only) so PlatformModule can provide
 * it without importing the route planning module.
 */
@Injectable()
export class RouteOptimizationAdminService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
  ) {}

  public async overview(companyId: string): Promise<CompanyRouteOptimization> {
    const [settings, areas, runs, usage, flag] = await Promise.all([
      sql<{
        isEnabled: boolean;
        provider: string;
        budget: number;
        version: string;
        branchSet: boolean;
        updatedAt: string;
      }>`
        select is_enabled as "isEnabled", provider, daily_call_budget as budget,
               version::text as version, (branch_latitude is not null) as "branchSet",
               updated_at::text as "updatedAt"
          from company_route_optimization_settings
         where company_id = ${companyId}::uuid
      `.execute(this.database),
      sql<{ total: number; verified: number }>`
        select count(*)::int as total,
               count(*) filter (where coordinates_verified_at is not null)::int as verified
          from areas
         where company_id = ${companyId}::uuid and is_active
      `.execute(this.database),
      sql<{ businessDate: string; runs: number; fallbackRuns: number }>`
        select business_date::text as "businessDate", count(*)::int as runs,
               count(*) filter (where result_source = 'fallback')::int as "fallbackRuns"
          from driver_route_runs
         where company_id = ${companyId}::uuid and business_date >= current_date - 13
         group by business_date
         order by business_date desc
      `.execute(this.database),
      sql<{
        businessDate: string;
        callCount: number;
        successCount: number;
        failureCount: number;
        fallbackCount: number;
      }>`
        select business_date::text as "businessDate", call_count as "callCount",
               success_count as "successCount", failure_count as "failureCount",
               fallback_count as "fallbackCount"
          from company_route_optimization_usage
         where company_id = ${companyId}::uuid and business_date >= current_date - 13
         order by business_date desc
      `.execute(this.database),
      this.killSwitch(),
    ]);
    const row = settings.rows[0];
    return {
      companyId,
      isEnabled: row?.isEnabled ?? false,
      platformEnabled: flag.isEnabled,
      provider: row?.provider ?? "area_matrix",
      dailyCallBudget: row?.budget ?? DEFAULT_BUDGET,
      version: Number(row?.version ?? 0),
      branchSet: row?.branchSet ?? false,
      areaCount: areas.rows[0]?.total ?? 0,
      verifiedAreaCount: areas.rows[0]?.verified ?? 0,
      updatedAt: row?.updatedAt ?? null,
      runsByDay: runs.rows,
      usageByDay: usage.rows,
    };
  }

  /**
   * Switch a Company on or off and set its budget. `expectedVersion` is the
   * version the administrator saw (0 when no row exists yet); a stale one is
   * refused rather than silently overwriting someone else's change.
   */
  public async update(
    companyId: string,
    input: {
      readonly isEnabled: boolean;
      readonly dailyCallBudget: number;
      readonly expectedVersion: number;
    },
    actor: PlatformActor,
  ): Promise<CompanyRouteOptimization> {
    await this.transactions.execute(async (transaction) => {
      const current = await sql<{
        isEnabled: boolean;
        budget: number;
        version: string;
        provider: string;
      }>`
        select is_enabled as "isEnabled", daily_call_budget as budget, version::text as version, provider
          from company_route_optimization_settings
         where company_id = ${companyId}::uuid
         for update
      `.execute(transaction);
      const before = current.rows[0];
      if (Number(before?.version ?? 0) !== input.expectedVersion) {
        throw new ApplicationException(
          "route_optimization_settings_stale",
          "Route planning settings changed since they were loaded. Reload and try again.",
          HttpStatus.CONFLICT,
        );
      }
      await sql`
        insert into company_route_optimization_settings
          (company_id, is_enabled, provider, daily_call_budget, updated_by_account_id, updated_at)
        values (${companyId}::uuid, ${input.isEnabled}, 'area_matrix', ${input.dailyCallBudget},
                ${actor.accountId}::uuid, now())
        on conflict (company_id) do update
          set is_enabled = excluded.is_enabled,
              daily_call_budget = excluded.daily_call_budget,
              updated_by_account_id = excluded.updated_by_account_id,
              updated_at = now(),
              version = company_route_optimization_settings.version + 1
      `.execute(transaction);
      await sql`
        insert into audit_events (
          company_id, actor_account_id, action, subject_type, subject_id,
          before_data, after_data, correlation_id, actor_role, source, result, source_application
        ) values (
          ${companyId}::uuid, ${actor.accountId}::uuid, 'platform.company_route_optimization.updated',
          'company_route_optimization_settings', ${companyId},
          ${before === undefined ? null : JSON.stringify({ isEnabled: before.isEnabled, dailyCallBudget: before.budget, provider: before.provider })}::jsonb,
          ${JSON.stringify({ isEnabled: input.isEnabled, dailyCallBudget: input.dailyCallBudget, provider: "area_matrix" })}::jsonb,
          ${actor.correlationId}, 'platform_administrator', 'platform_portal', 'success', 'platform-web'
        )
      `.execute(transaction);
    });
    return this.overview(companyId);
  }

  public async killSwitch(): Promise<RouteKillSwitch> {
    const result = await sql<RouteKillSwitch>`
      select is_enabled as "isEnabled", note, updated_at::text as "updatedAt"
        from platform_feature_flags
       where code = 'route_optimization_enabled'
    `.execute(this.database);
    const row = result.rows[0];
    if (row === undefined) throw new Error("The route optimization kill switch row is missing");
    return row;
  }

  /** The Platform-wide switch: off stops engine routing for every Company. */
  public async configureKillSwitch(
    input: { readonly isEnabled: boolean; readonly note?: string },
    actor: PlatformActor,
  ): Promise<RouteKillSwitch> {
    await this.transactions.execute(async (transaction) => {
      const before = await sql<{ isEnabled: boolean }>`
        select is_enabled as "isEnabled" from platform_feature_flags
         where code = 'route_optimization_enabled' for update
      `.execute(transaction);
      await sql`
        update platform_feature_flags
           set is_enabled = ${input.isEnabled}, note = ${input.note?.trim() || null},
               updated_by_account_id = ${actor.accountId}::uuid, updated_at = now()
         where code = 'route_optimization_enabled'
      `.execute(transaction);
      await sql`
        insert into audit_events (
          company_id, actor_account_id, action, subject_type, subject_id,
          before_data, after_data, correlation_id, actor_role, source, result, source_application
        ) values (
          null, ${actor.accountId}::uuid, 'platform.route_optimization.kill_switch_changed',
          'platform_feature_flag', 'route_optimization_enabled',
          ${JSON.stringify({ isEnabled: before.rows[0]?.isEnabled ?? null })}::jsonb,
          ${JSON.stringify({ isEnabled: input.isEnabled, note: input.note?.trim() || null })}::jsonb,
          ${actor.correlationId}, 'platform_administrator', 'platform_portal', 'success', 'platform-web'
        )
      `.execute(transaction);
    });
    return this.killSwitch();
  }
}
