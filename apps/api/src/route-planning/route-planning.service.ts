import { createHash } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql, type Transaction } from "kysely";

import { BusinessDayService } from "../company-configuration/business-day.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { driverWorkPredicate } from "../operations/driver-work-visibility.js";
import { OperationsService } from "../operations/operations.service.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import {
  applyManualAreaOrder,
  collapseDuplicateAreas,
  deferOrder,
  type PlannedStop,
  planRoute,
  reverseStops,
  type RouteArea,
  type RouteFallbackReason,
  type RoutePlanResult,
  sortByManualSequence,
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
  readonly customerMobile: string | null;
  readonly customerAddress: string | null;
  /** What the Driver collects from the customer at this stop. */
  readonly amountDue: string | null;
  /** Times the Driver recorded "no answer" today. The Order itself is unchanged. */
  readonly noAnswerCount: number;
  readonly lastNoAnswerAt: string | null;
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
  /** Cash the Driver holds for delivered Orders, to hand over at the branch. */
  readonly cashHandoverAmount: string;
  /** When the Driver tapped Start trip; null before he sets out. */
  readonly startedAt: string | null;
  /** True after the Driver put the route in his own order. */
  readonly manualOrder: boolean;
  /** His own Order order across all Areas (empty until he arranges it). */
  readonly orderSequence: readonly string[];
  readonly branchLatitude: number | null;
  readonly branchLongitude: number | null;
}

export interface RouteResponse {
  /** Effective switch: Platform kill switch AND the Company's own flag. */
  readonly enabled: boolean;
  /** True when the request carried an older revision; nothing was changed. */
  readonly stale: boolean;
  readonly run: RouteRunView | null;
  /** Only before a run exists: the Areas a Driver may start from. */
  readonly startAreas?: readonly {
    readonly areaId: string;
    readonly areaNameEn: string;
    readonly areaNameAr: string | null;
    readonly emirateNameEn: string;
    readonly emirateNameAr: string;
  }[];
  /** Start trip only: Orders moved to Out for Delivery, and any that could not be. */
  readonly trip?: { readonly changedCount: number; readonly failedOrderIds: readonly string[] };
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
  readonly startedAt: string | null;
  readonly manualOrder: boolean;
  readonly orderSequence: readonly string[];
}

interface LiveOrderRow extends RouteOrderView {
  readonly isStop: boolean;
  readonly cashHeld: string | null;
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
  r.deferred_order_ids as "deferredOrderIds",
  r.started_at::text as "startedAt",
  r.manual_order as "manualOrder",
  r.order_sequence as "orderSequence"
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
    @Inject(OperationsService)
    private readonly operations: Pick<OperationsService, "changeOrderStatus">,
  ) {}

  /** The Driver's run for today, rebuilt over live Order data. */
  public async current(): Promise<RouteResponse> {
    const scope = await this.scope();
    const settings = await this.settings(this.database, scope.companyId);
    const enabled = settings.companyEnabled && settings.platformEnabled;
    if (!settings.companyEnabled) return { enabled, stale: false, run: null };
    const run = await this.activeRun(this.database, scope);
    if (run !== null) {
      return { enabled, stale: false, run: await this.view(this.database, scope, run) };
    }
    // Before a run exists, the Areas of the Driver's own stops, so "Start
    // from an Area" can offer them whatever kind of account he uses.
    const areas = await this.stopAreas(scope);
    return {
      enabled,
      stale: false,
      run: null,
      startAreas: areas.map((area) => ({
        areaId: area.id,
        areaNameEn: area.nameEn,
        areaNameAr: area.nameAr,
        emirateNameEn: area.emirateNameEn,
        emirateNameAr: area.emirateNameAr,
      })),
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
               manual_order = false,
               order_sequence = '[]'::jsonb,
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

  /**
   * The Driver's own order: Areas he dragged into place, and optionally the
   * Orders inside them. Saved as a new revision; no engine call. A later
   * Replan replaces it (the app asks him first).
   */
  public async reorder(
    input: {
      readonly expectedRevision: number;
      readonly areaIds: readonly string[];
      readonly orderIds?: readonly string[];
    },
    idempotencyKey: string,
  ): Promise<RouteResponse> {
    const scope = await this.scope();
    const settings = await this.requireEnabled(scope.companyId);
    return this.mutate(
      scope,
      settings.platformEnabled,
      input.expectedRevision,
      idempotencyKey,
      async (transaction, run) => {
        const current = await this.view(transaction, scope, run);
        const stops = await sql<{ areaId: string; isSequenced: boolean; status: string }>`
        select area_id as "areaId", is_sequenced as "isSequenced", status
          from driver_route_stops
         where company_id = ${scope.companyId}::uuid and run_id = ${run.id}::uuid
         order by sequence_position
      `.execute(transaction);
        const allowed = new Set(current.areas.map((area) => area.areaId));
        const ordered = applyManualAreaOrder(stops.rows, input.areaIds, allowed);
        if (ordered === undefined) {
          throw new ApplicationException(
            "route_area_not_in_run",
            "Every Area must be one of your route's Areas, once",
            HttpStatus.BAD_REQUEST,
          );
        }
        // Deferred Orders are stops too: placing one puts it back in the
        // Driver's order, so an explicit Order list clears the deferrals.
        const stopOrderIds = new Set([
          ...current.areas.flatMap((area) => area.orders.map((order) => order.id)),
          ...current.deferredOrders.map((order) => order.id),
        ]);
        const orderIds = input.orderIds ?? run.orderSequence;
        if (
          new Set(orderIds).size !== orderIds.length ||
          (input.orderIds !== undefined && orderIds.some((id) => !stopOrderIds.has(id)))
        ) {
          throw new ApplicationException(
            "route_order_not_in_run",
            "Every Order must be one of your route's stops, once",
            HttpStatus.BAD_REQUEST,
          );
        }
        const statusOf = new Map(stops.rows.map((stop) => [stop.areaId, stop.status]));
        await sql`delete from driver_route_stops where company_id = ${scope.companyId}::uuid and run_id = ${run.id}::uuid`.execute(
          transaction,
        );
        await this.writeStops(transaction, scope.companyId, run.id, ordered, statusOf);
        await sql`
        update driver_route_runs
           set revision = revision + 1,
               manual_order = true,
               order_sequence = ${JSON.stringify(orderIds)}::jsonb,
               deferred_order_ids = case
                 when ${input.orderIds !== undefined} then '[]'::jsonb
                 else deferred_order_ids
               end,
               updated_at = now()
         where company_id = ${scope.companyId}::uuid and id = ${run.id}::uuid
      `.execute(transaction);
        return {
          action: "manual_reorder",
          details: { areaCount: input.areaIds.length, orderCount: orderIds.length },
        };
      },
    );
  }

  /**
   * Start trip. Every Order still Assigned to the Driver moves to Out for
   * Delivery through the normal Order status change -- the same rules,
   * history, audit and events as tapping Start Delivery on each one. An Order
   * that cannot move (changed by the office meanwhile) is reported back and
   * left as it is. A repeated request changes nothing twice: only Orders that
   * are still Assigned are picked up, and the trip start is recorded once.
   */
  public async start(idempotencyKey: string, correlationId: string): Promise<RouteResponse> {
    const scope = await this.scope();
    const settings = await this.requireEnabled(scope.companyId);
    const run = await this.requireActiveRun(scope);
    if (await this.actionKeyUsed(this.database, scope.companyId, run.id, idempotencyKey)) {
      return this.respond(scope, settings.platformEnabled, run, false);
    }
    const assigned = await sql<{ id: string }>`
      select o.id
        from orders o
       where o.company_id = ${scope.companyId}::uuid
         and o.assigned_driver_id = ${scope.driverId}::uuid
         and o.order_type <> 'gcc_international'
         and o.delivery_status = 'assigned_to_driver'
       order by o.serial_number nulls last, o.order_number, o.id
    `.execute(this.database);
    const failedOrderIds: string[] = [];
    let changedCount = 0;
    for (const order of assigned.rows) {
      try {
        await this.operations.changeOrderStatus(
          order.id,
          { status: "out_for_delivery", expectedStatus: "assigned_to_driver" },
          correlationId,
          tripStatusKey(idempotencyKey, order.id),
        );
        changedCount += 1;
      } catch {
        failedOrderIds.push(order.id);
      }
    }
    try {
      const updated = await this.transactions.execute(async (transaction) => {
        const locked = await sql<RunRow>`
          select ${RUN_COLUMNS}
            from driver_route_runs r
           where r.company_id = ${scope.companyId}::uuid and r.id = ${run.id}::uuid
           for update
        `.execute(transaction);
        const current = locked.rows[0] ?? run;
        await sql`
          update driver_route_runs
             set started_at = coalesce(started_at, now()), updated_at = now()
           where company_id = ${scope.companyId}::uuid and id = ${run.id}::uuid
        `.execute(transaction);
        await this.recordAction(transaction, scope, run.id, "trip_started", current.revision, {
          details: { changedCount, failedOrderIds },
          idempotencyKey,
        });
        return (await this.runById(transaction, scope, run.id)) as RunRow;
      });
      const response = await this.respond(scope, settings.platformEnabled, updated, false);
      return { ...response, trip: { changedCount, failedOrderIds } };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const latest = await this.requireActiveRun(scope);
      return this.respond(scope, settings.platformEnabled, latest, false);
    }
  }

  /**
   * Change one stop's status from the trip screen: Delivered, Hold or
   * Return to Branch. It goes through the normal Order status change (the
   * same rules, reasons, history, audit and cash status as the Order screen)
   * and only for an Order that is one of this Driver's own stops right now.
   */
  public async changeStopStatus(
    input: {
      readonly orderId: string;
      readonly status: "delivered" | "hold" | "returned_to_branch";
      readonly reason?: string;
    },
    idempotencyKey: string,
    correlationId: string,
  ): Promise<RouteResponse> {
    const scope = await this.scope();
    const settings = await this.requireEnabled(scope.companyId);
    const order = await sql<{ id: string; deliveryStatus: string }>`
      select o.id, o.delivery_status as "deliveryStatus"
        from orders o
       where o.company_id = ${scope.companyId}::uuid
         and o.id = ${input.orderId}::uuid
         and o.assigned_driver_id = ${scope.driverId}::uuid
         and o.order_type <> 'gcc_international'
         and o.delivery_status in ('assigned_to_driver', 'out_for_delivery')
    `.execute(this.database);
    const found = order.rows[0];
    if (found === undefined) {
      throw new ApplicationException(
        "route_order_not_in_run",
        "This Order is not a stop in your route",
        HttpStatus.NOT_FOUND,
      );
    }
    // Delivered, Hold and Return to Branch are reached from Out for Delivery;
    // an Order still Assigned is started first, as the Order screen does.
    if (found.deliveryStatus === "assigned_to_driver") {
      await this.operations.changeOrderStatus(
        found.id,
        { status: "out_for_delivery", expectedStatus: "assigned_to_driver" },
        correlationId,
        tripStatusKey(`${idempotencyKey}:start`, found.id),
      );
    }
    // "Return to Branch" is the Order status `in_branch` (the parcel is back
    // at the branch); `returned_to_branch` is not a target the status
    // change accepts.
    const target = input.status === "returned_to_branch" ? "in_branch" : input.status;
    await this.operations.changeOrderStatus(
      found.id,
      {
        status: target,
        expectedStatus: "out_for_delivery",
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
      correlationId,
      tripStatusKey(idempotencyKey, found.id),
    );
    const run = await this.activeRun(this.database, scope);
    return {
      enabled: settings.platformEnabled,
      stale: false,
      run: run === null ? null : await this.view(this.database, scope, run),
    };
  }

  /**
   * No answer: records the attempt and nothing else. The Order keeps its
   * status and its place in the route; the Driver can open it and deliver
   * it whenever he comes back.
   */
  public async noAnswer(orderId: string, idempotencyKey: string): Promise<RouteResponse> {
    const scope = await this.scope();
    const settings = await this.requireEnabled(scope.companyId);
    const run = await this.requireActiveRun(scope);
    if (await this.actionKeyUsed(this.database, scope.companyId, run.id, idempotencyKey)) {
      return this.respond(scope, settings.platformEnabled, run, false);
    }
    const order = await sql<{ id: string; areaId: string | null }>`
      select o.id, o.area_id as "areaId"
        from orders o
       where o.company_id = ${scope.companyId}::uuid
         and o.id = ${orderId}::uuid
         and o.assigned_driver_id = ${scope.driverId}::uuid
         and o.order_type <> 'gcc_international'
         and ${driverWorkPredicate("o")}
         and o.delivery_status <> 'delivered'
    `.execute(this.database);
    const found = order.rows[0];
    if (found === undefined) {
      throw new ApplicationException(
        "route_order_not_in_run",
        "This Order is not a stop in your route",
        HttpStatus.NOT_FOUND,
      );
    }
    try {
      await this.transactions.execute(async (transaction) => {
        await this.recordAction(transaction, scope, run.id, "no_answer", run.revision, {
          details: {},
          idempotencyKey,
          orderId: found.id,
          areaId: found.areaId,
        });
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    return this.respond(scope, settings.platformEnabled, run, false);
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
      readonly action: "replan" | "reverse" | "defer" | "manual_reorder";
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
    const isDriverUser = identity.kind === "company_user" && identity.profileType === "employee";
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
    action:
      "plan" | "replan" | "reverse" | "defer" | "manual_reorder" | "trip_started" | "no_answer",
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
    const [stopsResult, ordersResult, settings] = await Promise.all([
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
               o.customer_mobile_number as "customerMobile",
               o.customer_address as "customerAddress",
               o.customer_amount_due::text as "amountDue",
               coalesce(o.amount_collected, o.customer_amount_due)::text as "cashHeld",
               (o.delivery_status <> 'delivered') as "isStop",
               coalesce(attempts.count, 0)::int as "noAnswerCount",
               attempts.last_at::text as "lastNoAnswerAt"
          from orders o
          left join lateral (
            select count(*) as count, max(ra.created_at) as last_at
              from driver_route_actions ra
             where ra.company_id = o.company_id
               and ra.run_id = ${run.id}::uuid
               and ra.order_id = o.id
               and ra.action = 'no_answer'
          ) attempts on true
         where o.company_id = ${scope.companyId}::uuid
           and o.assigned_driver_id = ${scope.driverId}::uuid
           and o.order_type <> 'gcc_international'
           and ${driverWorkPredicate("o")}
         order by o.serial_number nulls last, o.order_number, o.id
      `.execute(executor),
      this.settings(executor, scope.companyId),
    ]);
    const stops = stopsResult.rows;
    const orders = sortByManualSequence(ordersResult.rows, run.orderSequence);
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
      cashHandoverAmount: sumMoney(
        orders.filter((order) => !order.isStop).map((order) => order.cashHeld),
      ),
      startedAt: run.startedAt,
      manualOrder: run.manualOrder,
      orderSequence: run.orderSequence,
      branchLatitude: settings.branch?.latitude ?? null,
      branchLongitude: settings.branch?.longitude ?? null,
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
    customerMobile: order.customerMobile,
    customerAddress: order.customerAddress,
    amountDue: order.amountDue,
    noAnswerCount: order.noAnswerCount,
    lastNoAnswerAt: order.lastNoAnswerAt,
  };
}

/** Exact sum of money strings (fils), never floating point. */
export function sumMoney(values: readonly (string | null)[]): string {
  let fils = 0n;
  for (const value of values) {
    if (value === null || value.trim() === "") continue;
    const [whole = "0", fraction = ""] = value.trim().replace(/^-/, "").split(".");
    const sign = value.trim().startsWith("-") ? -1n : 1n;
    fils += sign * (BigInt(whole || "0") * 100n + BigInt((fraction + "00").slice(0, 2)));
  }
  const negative = fils < 0n;
  const absolute = negative ? -fils : fils;
  const text = `${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/**
 * The status-change key for one Order inside a Start trip, derived from the
 * trip's own key so a retried Start replays instead of changing twice.
 */
export function tripStatusKey(tripKey: string, orderId: string): string {
  return `route-trip.${createHash("sha256").update(`${tripKey}:${orderId}`).digest("hex").slice(0, 40)}`;
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
