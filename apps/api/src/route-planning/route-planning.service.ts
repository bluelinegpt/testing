import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql, type Transaction } from "kysely";

import { BusinessDayService } from "../company-configuration/business-day.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { driverWorkPredicate } from "../operations/driver-work-visibility.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import {
  collapseDuplicateAreas,
  deferOrder,
  type PlannedStop,
  planRoute,
  reverseStops,
  type RouteArea,
  type RouteFallbackReason,
  type RoutePlanResult,
} from "./route-planner.js";
import { ROUTE_PROVIDERS, type RoutePoint, type RouteProviderRegistry } from "./route-provider.js";

type Executor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export interface RouteStartInput {
  readonly startAreaId?: string;
  readonly startLatitude?: number;
  readonly startLongitude?: number;
}

export interface RouteOrderView {
  readonly id: string;
  readonly orderNumber: string;
  readonly serialNumber: string | null;
  readonly referenceNumber: string | null;
  readonly customerName: string | null;
  readonly deliveryStatus: string;
  readonly areaId: string | null;
}

export interface RouteAreaView {
  readonly areaId: string;
  readonly areaNameEn: string;
  readonly areaNameAr: string | null;
  readonly emirateId: string;
  readonly emirateNameEn: string;
  readonly emirateNameAr: string;
  /** Position in the run; null for an Area that appeared after planning. */
  readonly sequencePosition: number | null;
  readonly isSequenced: boolean;
  /** An Area that gained Orders after the run was planned; Replan to place it. */
  readonly isNew: boolean;
  readonly status: "pending" | "in_progress" | "done" | "skipped";
  readonly orderCount: number;
  /** Delivered Orders here whose cash the Driver still owes. Never a destination. */
  readonly cashHandoverCount: number;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly orders: readonly RouteOrderView[];
}

export interface RouteRunView {
  readonly id: string;
  readonly referenceNumber: string;
  readonly businessDate: string;
  readonly revision: number;
  readonly direction: "recommended" | "reversed";
  readonly provider: string;
  readonly routeSource: RouteSource;
  readonly resultSource: "provider" | "fallback";
  readonly fallbackReason: RouteFallbackReason | null;
  readonly partialOptimization: boolean;
  readonly distanceMeters: number | null;
  readonly durationSeconds: number | null;
  readonly computedAt: string;
  readonly areas: readonly RouteAreaView[];
  readonly deferredOrders: readonly RouteOrderView[];
  readonly nextAreaId: string | null;
  readonly cashHandoverOrderCount: number;
}

export interface RouteResponse {
  /** Effective switch: Platform kill switch AND the Company's own flag. */
  readonly enabled: boolean;
  /** True when the request carried an older revision; nothing was changed. */
  readonly stale: boolean;
  readonly run: RouteRunView | null;
}

export type RouteSource = "gps" | "selected_area" | "branch" | "fallback";

interface DriverScope {
  readonly companyId: string;
  readonly driverId: string;
  readonly accountId: string;
  readonly businessDate: string;
}

interface RunRow {
  readonly id: string;
  readonly referenceNumber: string;
  readonly businessDate: string;
  readonly revision: number;
  readonly direction: "recommended" | "reversed";
  readonly provider: string;
  readonly routeSource: RouteSource;
  readonly resultSource: "provider" | "fallback";
  readonly fallbackReason: RouteFallbackReason | null;
  readonly partialOptimization: boolean;
  readonly distanceMeters: number | null;
  readonly durationSeconds: number | null;
  readonly computedAt: string;
  readonly deferredOrderIds: readonly string[];
}

interface LiveOrderRow extends RouteOrderView {
  readonly isStop: boolean;
}

interface AreaRow {
  readonly id: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly emirateId: string;
  readonly emirateNameEn: string;
  readonly emirateNameAr: string;
  readonly emirateOrder: number;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly coordinatesVerified: boolean;
}

interface Settings {
  readonly companyEnabled: boolean;
  readonly platformEnabled: boolean;
  readonly dailyCallBudget: number;
  readonly provider: string;
  readonly branch: RoutePoint | null;
}

interface ResolvedStart {
  readonly areaId: string | null;
  readonly coordinates: RoutePoint | null;
  readonly source: Exclude<RouteSource, "fallback"> | null;
}

const RUN_COLUMNS = sql`
  r.id,
  r.reference_number as "referenceNumber",
  r.business_date::text as "businessDate",
  r.revision,
  r.direction,
  r.provider,
  r.route_source as "routeSource",
  r.result_source as "resultSource",
  r.fallback_reason as "fallbackReason",
  r.partial_optimization as "partialOptimization",
  r.distance_meters as "distanceMeters",
  r.duration_seconds as "durationSeconds",
  r.computed_at::text as "computedAt",
  r.deferred_order_ids as "deferredOrderIds"
`;

/**
 * Driver route planning: persisted runs over the Driver's own active work.
 *
 * Scope is always the caller's own Company and own Driver profile; every
 * statement carries `company_id`. Nothing here writes to `orders`, Trader
 * payables, settlements or reconciliation.
 */
@Injectable()
export class RoutePlanningService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(BusinessDayService)
    private readonly businessDays: Pick<BusinessDayService, "businessDateOf">,
    @Inject(ROUTE_PROVIDERS) private readonly providers: RouteProviderRegistry,
  ) {}

  /** The Driver's run for today, rebuilt over live Order data. */
  public async current(): Promise<RouteResponse> {
    const scope = await this.scope();
    const settings = await this.settings(this.database, scope.companyId);
    const enabled = settings.companyEnabled && settings.platformEnabled;
    if (!settings.companyEnabled) return { enabled, stale: false, run: null };
    const run = await this.activeRun(this.database, scope);
    return {
      enabled,
      stale: false,
      run: run === null ? null : await this.view(this.database, scope, run),
    };
  }

  /**
   * Plan my route. Returns the existing active run when there is one (Plan
   * never creates a parallel run) and the same run for a repeated key.
   */
  public async plan(input: RouteStartInput, idempotencyKey: string): Promise<RouteResponse> {
    const scope = await this.scope();
    const settings = await this.requireEnabled(scope.companyId);
    const enabled = settings.platformEnabled;
    await this.closeEarlierRuns(scope);

    const repeated = await this.runByPlanKey(this.database, scope, idempotencyKey);
    if (repeated !== null) return this.respond(scope, enabled, repeated, false);
    const existing = await this.activeRun(this.database, scope);
    if (existing !== null) return this.respond(scope, enabled, existing, false);

    const start = await this.resolveStart(scope.companyId, input, settings.branch);
    const computed = await this.compute(scope, settings, start.coordinates);

    try {
      const run = await this.transactions.execute(async (transaction) => {
        const reference = await this.nextReference(transaction, scope.companyId);
        const inserted = await sql<{ id: string }>`
          insert into driver_route_runs (
            company_id, driver_id, business_date, reference_number, provider, route_source,
            result_source, fallback_reason, partial_optimization, start_area_id,
            start_latitude, start_longitude, engine_response_id, distance_meters,
            duration_seconds, plan_idempotency_key, created_by_account_id
          ) values (
            ${scope.companyId}::uuid, ${scope.driverId}::uuid, ${scope.businessDate}::date,
            ${reference}, ${computed.providerName}, ${this.routeSource(computed.result, start)},
            ${computed.result.resultSource}, ${computed.result.fallbackReason},
            ${computed.result.partialOptimization}, ${start.areaId}::uuid,
            ${start.coordinates?.latitude ?? null}, ${start.coordinates?.longitude ?? null},
            ${computed.result.providerResult?.responseId ?? null},
            ${computed.result.providerResult?.distanceMeters ?? null},
            ${computed.result.providerResult?.durationSeconds ?? null},
            ${idempotencyKey}, ${scope.accountId}::uuid
          )
          returning id
        `.execute(transaction);
        const runId = (inserted.rows[0] as { id: string }).id;
        await this.writeStops(transaction, scope.companyId, runId, computed.result.stops);
        await this.recordAction(transaction, scope, runId, "plan", 1, {
          details: this.planDetails(computed.result),
          idempotencyKey,
        });
        return (await this.runById(transaction, scope, runId)) as RunRow;
      });
      return this.respond(scope, enabled, run, false);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent Plan for the same Driver and day won the race. Return its
      // run instead of creating a second one.
      const winner =
        (await this.runByPlanKey(this.database, scope, idempotencyKey)) ??
        (await this.activeRun(this.database, scope));
      if (winner === null) throw error;
      return this.respond(scope, enabled, winner, false);
    }
  }

  /** Replan: recompute today's run (one engine call at most). */
  public async replan(
    input: RouteStartInput & { readonly expectedRevision: number },
    idempotencyKey: string,
  ): Promise<RouteResponse> {
    const scope = await this.scope();
    const settings = await this.requireEnabled(scope.companyId);
    const current = await this.requireActiveRun(scope);
    if (await this.actionKeyUsed(this.database, scope.companyId, current.id, idempotencyKey)) {
      return this.respond(scope, settings.platformEnabled, current, false);
    }
    if (current.revision !== input.expectedRevision) {
      return this.respond(scope, settings.platformEnabled, current, true);
    }
    const start = await this.resolveStart(scope.companyId, input, settings.branch);
    const computed = await this.compute(scope, settings, start.coordinates);
    return this.mutate(
      scope,
      settings.platformEnabled,
      input.expectedRevision,
      idempotencyKey,
      async (transaction, run) => {
        await sql`delete from driver_route_stops where company_id = ${scope.companyId}::uuid and run_id = ${run.id}::uuid`.execute(
          transaction,
        );
        await this.writeStops(transaction, scope.companyId, run.id, computed.result.stops);
        await sql`
        update driver_route_runs
           set revision = revision + 1,
               provider = ${computed.providerName},
               route_source = ${this.routeSource(computed.result, start)},
               result_source = ${computed.result.resultSource},
               fallback_reason = ${computed.result.fallbackReason},
               partial_optimization = ${computed.result.partialOptimization},
               direction = 'recommended',
               start_area_id = ${start.areaId}::uuid,
               start_latitude = ${start.coordinates?.latitude ?? null},
               start_longitude = ${start.coordinates?.longitude ?? null},
               engine_response_id = ${computed.result.providerResult?.responseId ?? null},
               distance_meters = ${computed.result.providerResult?.distanceMeters ?? null},
               duration_seconds = ${computed.result.providerResult?.durationSeconds ?? null},
               computed_at = now(),
               updated_at = now()
         where company_id = ${scope.companyId}::uuid and id = ${run.id}::uuid
      `.execute(transaction);
        return { action: "replan", details: this.planDetails(computed.result) };
      },
    );
  }

  /** Reverse direction: reorders the stored stops. Never calls the engine. */
  public async reverse(expectedRevision: number, idempotencyKey: string): Promise<RouteResponse> {
    const scope = await this.scope();
    const settings = await this.requireEnabled(scope.companyId);
    return this.mutate(
      scope,
      settings.platformEnabled,
      expectedRevision,
      idempotencyKey,
      async (transaction, run) => {
        const stops = await sql<{ areaId: string; isSequenced: boolean; status: string }>`
        select area_id as "areaId", is_sequenced as "isSequenced", status
          from driver_route_stops
         where company_id = ${scope.companyId}::uuid and run_id = ${run.id}::uuid
         order by sequence_position
      `.execute(transaction);
        const reversed = reverseStops(stops.rows);
        const statusOf = new Map(stops.rows.map((stop) => [stop.areaId, stop.status]));
        await sql`delete from driver_route_stops where company_id = ${scope.companyId}::uuid and run_id = ${run.id}::uuid`.execute(
          transaction,
        );
        await this.writeStops(transaction, scope.companyId, run.id, reversed, statusOf);
        await sql`
        update driver_route_runs
           set revision = revision + 1,
               direction = case when direction = 'recommended' then 'reversed' else 'recommended' end,
               updated_at = now()
         where company_id = ${scope.companyId}::uuid and id = ${run.id}::uuid
      `.execute(transaction);
        return {
          action: "reverse",
          details: { direction: run.direction === "recommended" ? "reversed" : "recommended" },
        };
      },
    );
  }

  /**
   * Defer: the Order moves to the end of the run. One tap, no reason. Only
   * the run and its action log change -- never the Order.
   */
  public async defer(
    orderId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<RouteResponse> {
    const scope = await this.scope();
    const settings = await this.requireEnabled(scope.companyId);
    return this.mutate(
      scope,
      settings.platformEnabled,
      expectedRevision,
      idempotencyKey,
      async (transaction, run) => {
        const order = await sql<{ id: string; areaId: string | null }>`
        select o.id, o.area_id as "areaId"
          from orders o
         where o.company_id = ${scope.companyId}::uuid
           and o.id = ${orderId}::uuid
           and o.assigned_driver_id = ${scope.driverId}::uuid
           and o.order_type <> 'gcc_international'
           and ${driverWorkPredicate("o")}
           and o.delivery_status <> 'delivered'
      `.execute(transaction);
        const found = order.rows[0];
        if (found === undefined) {
          throw new ApplicationException(
            "route_order_not_in_run",
            "This Order is not a stop in your route",
            HttpStatus.NOT_FOUND,
          );
        }
        const deferred = deferOrder(run.deferredOrderIds, found.id);
        await sql`
        update driver_route_runs
           set revision = revision + 1,
               deferred_order_ids = ${JSON.stringify(deferred)}::jsonb,
               updated_at = now()
         where company_id = ${scope.companyId}::uuid and id = ${run.id}::uuid
      `.execute(transaction);
        return { action: "defer", orderId: found.id, areaId: found.areaId, details: {} };
      },
    );
  }

  // ---------------------------------------------------------------------------

  private async mutate(
    scope: DriverScope,
    enabled: boolean,
    expectedRevision: number,
    idempotencyKey: string,
    work: (
      transaction: Transaction<DatabaseSchema>,
      run: RunRow,
    ) => Promise<{
      readonly action: "replan" | "reverse" | "defer";
      readonly details: Record<string, unknown>;
      readonly orderId?: string;
      readonly areaId?: string | null;
    }>,
  ): Promise<RouteResponse> {
    try {
      const outcome = await this.transactions.execute(async (transaction) => {
        const locked = await sql<RunRow>`
          select ${RUN_COLUMNS}
            from driver_route_runs r
           where r.company_id = ${scope.companyId}::uuid
             and r.driver_id = ${scope.driverId}::uuid
             and r.business_date = ${scope.businessDate}::date
             and r.status = 'active'
           for update
        `.execute(transaction);
        const run = locked.rows[0];
        if (run === undefined) throw noActiveRun();
        if (await this.actionKeyUsed(transaction, scope.companyId, run.id, idempotencyKey)) {
          return { run, stale: false };
        }
        if (run.revision !== expectedRevision) return { run, stale: true };
        const result = await work(transaction, run);
        await this.recordAction(transaction, scope, run.id, result.action, run.revision + 1, {
          details: result.details,
          idempotencyKey,
          orderId: result.orderId ?? null,
          areaId: result.areaId ?? null,
        });
        return { run: (await this.runById(transaction, scope, run.id)) as RunRow, stale: false };
      });
      return this.respond(scope, enabled, outcome.run, outcome.stale);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The same key raced itself; the first request's result stands.
      const run = await this.requireActiveRun(scope);
      return this.respond(scope, enabled, run, false);
    }
  }

  private async respond(
    scope: DriverScope,
    enabled: boolean,
    run: RunRow,
    stale: boolean,
  ): Promise<RouteResponse> {
    return { enabled, stale, run: await this.view(this.database, scope, run) };
  }

  private async compute(
    scope: DriverScope,
    settings: Settings,
    start: RoutePoint | null,
  ): Promise<{ result: RoutePlanResult; providerName: string }> {
    const areas = await this.stopAreas(scope);
    const provider = this.providers.forCompany(settings.provider);
    const result = await planRoute({
      areas: areas.map(toRouteArea),
      gate: { companyEnabled: settings.companyEnabled, platformEnabled: settings.platformEnabled },
      provider,
      start,
      // A Driver usually ends the run at the branch to hand over the cash.
      end: settings.branch,
      reserveCall: () => this.reserveCall(scope, settings.dailyCallBudget),
    });
    if (result.reserved) await this.recordOutcome(scope, result);
    return { result, providerName: result.resultSource === "provider" ? provider.name : "none" };
  }

  /**
   * Reserve one engine call before calling, atomically. Over-counting a
   * refused call is far better than under-counting a paid one.
   */
  private async reserveCall(scope: DriverScope, budget: number): Promise<boolean> {
    const reserved = await sql<{ callCount: number }>`
      insert into company_route_optimization_usage (company_id, business_date, call_count)
      values (${scope.companyId}::uuid, ${scope.businessDate}::date, 1)
      on conflict (company_id, business_date)
        do update set call_count = company_route_optimization_usage.call_count + 1,
                      updated_at = now()
      returning call_count as "callCount"
    `.execute(this.database);
    return (reserved.rows[0]?.callCount ?? Number.POSITIVE_INFINITY) <= budget;
  }

  private async recordOutcome(scope: DriverScope, result: RoutePlanResult): Promise<void> {
    const column =
      result.resultSource === "provider"
        ? sql.raw("success_count")
        : result.fallbackReason === "provider_error"
          ? sql.raw("failure_count")
          : sql.raw("fallback_count");
    await sql`
      update company_route_optimization_usage
         set ${column} = ${column} + 1, updated_at = now()
       where company_id = ${scope.companyId}::uuid and business_date = ${scope.businessDate}::date
    `.execute(this.database);
  }

  private async scope(): Promise<DriverScope> {
    const identity = this.identities.current();
    const isDriverAccount = identity.kind === "driver";
    // A Driver User: a Company user whose linked Employee backs a Driver --
    // the same explicit `drivers.employee_id` chain `OperationsService`
    // uses for that account's Orders list. Never inferred from a name or
    // mobile number.
    const isDriverUser =
      identity.kind === "company_user" && identity.profileType === "employee";
    if ((!isDriverAccount && !isDriverUser) || identity.companyId === null) {
      throw new ApplicationException(
        "route_driver_required",
        "A Driver account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const driver = isDriverAccount
      ? await sql<{ id: string }>`
          select d.id
            from drivers d
            join user_business_links l
              on l.company_id = d.company_id and l.entity_type = 'driver' and l.entity_id = d.id
             and l.account_id = ${identity.identityId}::uuid and l.access_status = 'active'
           where d.company_id = ${identity.companyId}::uuid
             and d.id = ${identity.profileId ?? null}::uuid
             and d.account_status = 'active'
           limit 1
        `.execute(this.database)
      : await sql<{ id: string }>`
          select d.id
            from drivers d
           where d.company_id = ${identity.companyId}::uuid
             and d.employee_id = ${identity.profileId ?? null}::uuid
             and d.account_status = 'active'
           limit 1
        `.execute(this.database);
    const row = driver.rows[0];
    if (row === undefined && isDriverUser) {
      throw new ApplicationException(
        "route_driver_required",
        "A Driver account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    if (row === undefined) {
      throw new ApplicationException(
        "profile_access_inactive",
        "The profile is not active",
        HttpStatus.FORBIDDEN,
      );
    }
    const businessDate = await this.businessDays.businessDateOf(new Date().toISOString());
    return {
      companyId: identity.companyId,
      driverId: row.id,
      accountId: identity.identityId,
      businessDate,
    };
  }

  private async settings(executor: Executor, companyId: string): Promise<Settings> {
    const result = await sql<{
      companyEnabled: boolean | null;
      platformEnabled: boolean | null;
      budget: number | null;
      provider: string | null;
      branchLatitude: string | null;
      branchLongitude: string | null;
    }>`
      select s.is_enabled as "companyEnabled",
             (select f.is_enabled from platform_feature_flags f where f.code = 'route_optimization_enabled') as "platformEnabled",
             s.daily_call_budget as budget,
             s.provider,
             s.branch_latitude::text as "branchLatitude",
             s.branch_longitude::text as "branchLongitude"
        from (select 1) one
        left join company_route_optimization_settings s on s.company_id = ${companyId}::uuid
    `.execute(executor);
    const row = result.rows[0];
    const branch =
      row?.branchLatitude == null || row.branchLongitude == null
        ? null
        : { latitude: Number(row.branchLatitude), longitude: Number(row.branchLongitude) };
    return {
      companyEnabled: row?.companyEnabled === true,
      platformEnabled: row?.platformEnabled === true,
      dailyCallBudget: row?.budget ?? 0,
      provider: row?.provider ?? "area_matrix",
      branch,
    };
  }

  private async requireEnabled(companyId: string): Promise<Settings> {
    const settings = await this.settings(this.database, companyId);
    if (!settings.companyEnabled) {
      throw new ApplicationException(
        "route_planning_disabled",
        "Route planning is not enabled for this Company",
        HttpStatus.FORBIDDEN,
      );
    }
    return settings;
  }

  private async closeEarlierRuns(scope: DriverScope): Promise<void> {
    await sql`
      update driver_route_runs
         set status = 'closed', closed_at = now(), updated_at = now()
       where company_id = ${scope.companyId}::uuid
         and driver_id = ${scope.driverId}::uuid
         and status = 'active'
         and business_date < ${scope.businessDate}::date
    `.execute(this.database);
  }

  private async activeRun(executor: Executor, scope: DriverScope): Promise<RunRow | null> {
    const result = await sql<RunRow>`
      select ${RUN_COLUMNS}
        from driver_route_runs r
       where r.company_id = ${scope.companyId}::uuid
         and r.driver_id = ${scope.driverId}::uuid
         and r.business_date = ${scope.businessDate}::date
         and r.status = 'active'
    `.execute(executor);
    return result.rows[0] ?? null;
  }

  private async requireActiveRun(scope: DriverScope): Promise<RunRow> {
    const run = await this.activeRun(this.database, scope);
    if (run === null) throw noActiveRun();
    return run;
  }

  private async runByPlanKey(
    executor: Executor,
    scope: DriverScope,
    key: string,
  ): Promise<RunRow | null> {
    const result = await sql<RunRow>`
      select ${RUN_COLUMNS}
        from driver_route_runs r
       where r.company_id = ${scope.companyId}::uuid
         and r.driver_id = ${scope.driverId}::uuid
         and r.business_date = ${scope.businessDate}::date
         and r.plan_idempotency_key = ${key}
    `.execute(executor);
    return result.rows[0] ?? null;
  }

  private async runById(
    executor: Executor,
    scope: DriverScope,
    runId: string,
  ): Promise<RunRow | null> {
    const result = await sql<RunRow>`
      select ${RUN_COLUMNS}
        from driver_route_runs r
       where r.company_id = ${scope.companyId}::uuid
         and r.driver_id = ${scope.driverId}::uuid
         and r.id = ${runId}::uuid
    `.execute(executor);
    return result.rows[0] ?? null;
  }

  private async actionKeyUsed(
    executor: Executor,
    companyId: string,
    runId: string,
    key: string,
  ): Promise<boolean> {
    const result = await sql<{ found: number }>`
      select 1 as found
        from driver_route_actions
       where company_id = ${companyId}::uuid and run_id = ${runId}::uuid and idempotency_key = ${key}
       limit 1
    `.execute(executor);
    return result.rows.length > 0;
  }

  /**
   * The run's start: GPS when the Driver shared it, else a chosen Area, else
   * the branch (a Driver usually sets out from the branch).
   */
  private async resolveStart(
    companyId: string,
    input: RouteStartInput,
    branch: RoutePoint | null,
  ): Promise<ResolvedStart> {
    if (input.startLatitude !== undefined && input.startLongitude !== undefined) {
      return {
        areaId: null,
        coordinates: { latitude: input.startLatitude, longitude: input.startLongitude },
        source: "gps",
      };
    }
    if (input.startAreaId === undefined) {
      return { areaId: null, coordinates: branch, source: branch === null ? null : "branch" };
    }
    const area = await sql<{
      id: string;
      latitude: string | null;
      longitude: string | null;
      verified: boolean;
    }>`
      select a.id, a.latitude::text as latitude, a.longitude::text as longitude,
             (a.coordinates_verified_at is not null) as verified
        from areas a
       where a.company_id = ${companyId}::uuid and a.id = ${input.startAreaId}::uuid and a.is_active
    `.execute(this.database);
    const row = area.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "route_start_area_not_found",
        "The start Area was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const coordinates =
      row.verified && row.latitude !== null && row.longitude !== null
        ? { latitude: Number(row.latitude), longitude: Number(row.longitude) }
        : null;
    return { areaId: row.id, coordinates, source: coordinates === null ? null : "selected_area" };
  }

  private routeSource(result: RoutePlanResult, start: ResolvedStart): RouteSource {
    if (result.resultSource === "fallback") return "fallback";
    return start.source ?? "fallback";
  }

  private planDetails(result: RoutePlanResult): Record<string, unknown> {
    return {
      resultSource: result.resultSource,
      fallbackReason: result.fallbackReason,
      partialOptimization: result.partialOptimization,
      areaCount: result.stops.length,
    };
  }

  /** Areas holding the Driver's route stops (not delivered-with-cash Orders). */
  private async stopAreas(scope: DriverScope): Promise<readonly AreaRow[]> {
    const result = await sql<AreaRow>`
      select distinct ${AREA_COLUMNS}
        from orders o
        join areas a on a.id = o.area_id and a.company_id = o.company_id
        join emirates e on e.id = a.emirate_id
       where o.company_id = ${scope.companyId}::uuid
         and o.assigned_driver_id = ${scope.driverId}::uuid
         and o.order_type <> 'gcc_international'
         and ${driverWorkPredicate("o")}
         and o.delivery_status <> 'delivered'
    `.execute(this.database);
    return result.rows;
  }

  private async writeStops(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
    runId: string,
    stops: readonly PlannedStop[],
    statusOf?: ReadonlyMap<string, string>,
  ): Promise<void> {
    let position = 0;
    for (const stop of stops) {
      position += 1;
      await sql`
        insert into driver_route_stops (company_id, run_id, area_id, sequence_position, is_sequenced, status)
        values (${companyId}::uuid, ${runId}::uuid, ${stop.areaId}::uuid, ${position},
                ${stop.isSequenced}, ${statusOf?.get(stop.areaId) ?? "pending"})
      `.execute(transaction);
    }
  }

  private async recordAction(
    transaction: Transaction<DatabaseSchema>,
    scope: DriverScope,
    runId: string,
    action: "plan" | "replan" | "reverse" | "defer",
    revision: number,
    options: {
      readonly details: Record<string, unknown>;
      readonly idempotencyKey: string;
      readonly orderId?: string | null;
      readonly areaId?: string | null;
    },
  ): Promise<void> {
    await sql`
      insert into driver_route_actions (
        company_id, run_id, driver_id, action, revision, area_id, order_id,
        idempotency_key, details, created_by_account_id
      ) values (
        ${scope.companyId}::uuid, ${runId}::uuid, ${scope.driverId}::uuid, ${action}, ${revision},
        ${options.areaId ?? null}::uuid, ${options.orderId ?? null}::uuid, ${options.idempotencyKey},
        ${JSON.stringify(options.details)}::jsonb, ${scope.accountId}::uuid
      )
    `.execute(transaction);
  }

  private async nextReference(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
  ): Promise<string> {
    const counter = await sql<{ nextValue: string; prefix: string }>`
      insert into company_reference_counters (company_id, reference_type, next_value, prefix)
      values (${companyId}::uuid, 'route_run', 2, 'RUN')
      on conflict (company_id, reference_type)
      do update set next_value = company_reference_counters.next_value + 1, updated_at = now()
      returning prefix, (next_value - 1)::text as "nextValue"
    `.execute(transaction);
    const row = counter.rows[0];
    if (row === undefined) throw new Error("Route run counter did not return a value");
    return `${row.prefix}-${row.nextValue.padStart(6, "0")}`;
  }

  /**
   * The run as the Driver sees it: stored sequence, live Orders. Delivered
   * Orders leave their Area; an Area with nothing left is done; Orders in an
   * Area that was not in the plan show as a new Area until Replan.
   */
  private async view(executor: Executor, scope: DriverScope, run: RunRow): Promise<RouteRunView> {
    const [stopsResult, ordersResult] = await Promise.all([
      sql<{
        areaId: string;
        position: number;
        isSequenced: boolean;
        status: RouteAreaView["status"];
      }>`
        select area_id as "areaId", sequence_position as position, is_sequenced as "isSequenced", status
          from driver_route_stops
         where company_id = ${scope.companyId}::uuid and run_id = ${run.id}::uuid
         order by sequence_position
      `.execute(executor),
      sql<LiveOrderRow>`
        select o.id,
               o.order_number as "orderNumber",
               o.serial_number as "serialNumber",
               o.reference_number as "referenceNumber",
               o.customer_name as "customerName",
               o.delivery_status as "deliveryStatus",
               o.area_id as "areaId",
               (o.delivery_status <> 'delivered') as "isStop"
          from orders o
         where o.company_id = ${scope.companyId}::uuid
           and o.assigned_driver_id = ${scope.driverId}::uuid
           and o.order_type <> 'gcc_international'
           and ${driverWorkPredicate("o")}
         order by o.serial_number nulls last, o.order_number, o.id
      `.execute(executor),
    ]);
    const stops = stopsResult.rows;
    const orders = ordersResult.rows;
    const areaIds = [
      ...new Set([
        ...stops.map((stop) => stop.areaId),
        ...orders.flatMap((order) => (order.areaId === null ? [] : [order.areaId])),
      ]),
    ];
    const areaRows =
      areaIds.length === 0
        ? []
        : (
            await sql<AreaRow>`
      select ${AREA_COLUMNS}
        from areas a
        join emirates e on e.id = a.emirate_id
       where a.company_id = ${scope.companyId}::uuid
         and a.id in (${sql.join(areaIds.map((id) => sql`${id}::uuid`))})
    `.execute(executor)
          ).rows;
    const areaById = new Map(areaRows.map((area) => [area.id, area]));
    const { representativeOf } = collapseDuplicateAreas(areaRows.map(toRouteArea));
    const placeOf = (areaId: string | null): string | null =>
      areaId === null ? null : (representativeOf.get(areaId) ?? areaId);

    const deferredIds = run.deferredOrderIds.filter((id) =>
      orders.some((order) => order.id === id && order.isStop),
    );
    const deferredSet = new Set(deferredIds);
    const stopOrdersByPlace = new Map<string, RouteOrderView[]>();
    const cashByPlace = new Map<string, number>();
    for (const order of orders) {
      const place = placeOf(order.areaId);
      if (place === null) continue;
      if (!order.isStop) {
        cashByPlace.set(place, (cashByPlace.get(place) ?? 0) + 1);
      } else if (!deferredSet.has(order.id)) {
        const list = stopOrdersByPlace.get(place) ?? [];
        list.push(orderView(order));
        stopOrdersByPlace.set(place, list);
      }
    }

    const areaView = (
      areaId: string,
      position: number | null,
      isSequenced: boolean,
      isNew: boolean,
      storedStatus: RouteAreaView["status"],
    ): RouteAreaView | null => {
      const area = areaById.get(areaId);
      if (area === undefined) return null;
      const stopOrders = stopOrdersByPlace.get(areaId) ?? [];
      return {
        areaId,
        areaNameEn: area.nameEn,
        areaNameAr: area.nameAr,
        emirateId: area.emirateId,
        emirateNameEn: area.emirateNameEn,
        emirateNameAr: area.emirateNameAr,
        sequencePosition: position,
        isSequenced,
        isNew,
        status: stopOrders.length === 0 && storedStatus !== "skipped" ? "done" : storedStatus,
        orderCount: stopOrders.length,
        cashHandoverCount: cashByPlace.get(areaId) ?? 0,
        latitude: area.latitude === null ? null : Number(area.latitude),
        longitude: area.longitude === null ? null : Number(area.longitude),
        orders: stopOrders,
      };
    };

    const placed = new Set<string>();
    const views: RouteAreaView[] = [];
    for (const stop of stops) {
      const place = placeOf(stop.areaId) ?? stop.areaId;
      if (placed.has(place)) continue;
      placed.add(place);
      const view = areaView(place, stop.position, stop.isSequenced, false, stop.status);
      if (view !== null) views.push(view);
    }
    for (const place of stopOrdersByPlace.keys()) {
      if (placed.has(place)) continue;
      placed.add(place);
      const view = areaView(place, null, false, true, "pending");
      if (view !== null) views.push(view);
    }

    const orderById = new Map(orders.map((order) => [order.id, order]));
    const deferredOrders = deferredIds.flatMap((id) => {
      const order = orderById.get(id);
      return order === undefined ? [] : [orderView(order)];
    });
    const next = views.find((view) => view.orderCount > 0 && view.status !== "skipped");
    return {
      id: run.id,
      referenceNumber: run.referenceNumber,
      businessDate: run.businessDate,
      revision: run.revision,
      direction: run.direction,
      provider: run.provider,
      routeSource: run.routeSource,
      resultSource: run.resultSource,
      fallbackReason: run.fallbackReason,
      partialOptimization: run.partialOptimization,
      distanceMeters: run.distanceMeters,
      durationSeconds: run.durationSeconds,
      computedAt: run.computedAt,
      areas: views,
      deferredOrders,
      nextAreaId: next?.areaId ?? null,
      cashHandoverOrderCount: orders.filter((order) => !order.isStop).length,
    };
  }
}

const AREA_COLUMNS = sql`
  a.id,
  a.name_en as "nameEn",
  a.name_ar as "nameAr",
  a.emirate_id as "emirateId",
  e.name_en as "emirateNameEn",
  e.name_ar as "emirateNameAr",
  e.display_order as "emirateOrder",
  a.latitude::text as latitude,
  a.longitude::text as longitude,
  (a.coordinates_verified_at is not null) as "coordinatesVerified"
`;

function toRouteArea(area: AreaRow): RouteArea {
  return {
    id: area.id,
    emirateId: area.emirateId,
    emirateOrder: area.emirateOrder,
    nameEn: area.nameEn,
    latitude: area.latitude === null ? null : Number(area.latitude),
    longitude: area.longitude === null ? null : Number(area.longitude),
    coordinatesVerified: area.coordinatesVerified,
  };
}

function orderView(order: LiveOrderRow): RouteOrderView {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    serialNumber: order.serialNumber,
    referenceNumber: order.referenceNumber,
    customerName: order.customerName,
    deliveryStatus: order.deliveryStatus,
    areaId: order.areaId,
  };
}

function noActiveRun(): ApplicationException {
  return new ApplicationException(
    "route_run_not_found",
    "There is no route for today yet",
    HttpStatus.NOT_FOUND,
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
}
