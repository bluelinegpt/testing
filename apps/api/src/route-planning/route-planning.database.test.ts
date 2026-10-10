import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Decimal } from "decimal.js";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { BusinessDayService } from "../company-configuration/business-day.service.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { calculateOrderFinancials } from "../operations/order-financial-model.js";
import type { IdentityContextAccessor } from "../security/identity-context.js";
import { RoutePlanningService } from "./route-planning.service.js";
import type { RouteProvider } from "./route-provider.js";

/**
 * Driver route planning against a real PostgreSQL schema.
 *
 * Disposable database only: refuses to run unless the connected database is
 * named `blueline` on a local host. Behaviour tests run in a transaction that
 * is rolled back; the two concurrency tests need real parallel connections,
 * so they commit a throwaway Company and remove it afterwards.
 *
 *   RUN_ROUTE_PLANNING_DATABASE=true pnpm --filter @blueline/api exec vitest run src/route-planning/route-planning.database.test.ts
 */
const run = process.env.RUN_ROUTE_PLANNING_DATABASE === "true";
const BUSINESS_DATE = "2026-10-10";

type Db = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;
class Rollback extends Error {}

let pool: Pool;
let database: Kysely<DatabaseSchema>;

async function inRollback(work: (tx: Transaction<DatabaseSchema>) => Promise<void>): Promise<void> {
  try {
    await database.transaction().execute(async (tx) => {
      await work(tx);
      throw new Rollback("rollback");
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

interface Fixture {
  readonly companyId: string;
  readonly actorId: string;
  readonly traderId: string;
  readonly emirateId: string;
  readonly driverId: string;
  readonly driverAccountId: string;
}

async function emirate(tx: Db): Promise<string> {
  const found = await sql<{
    id: string;
  }>`select id from emirates where code = 'DXB' limit 1`.execute(tx);
  if (found.rows[0] !== undefined) return found.rows[0].id;
  const id = randomUUID();
  await sql`insert into emirates(id, code, name_en, name_ar, display_order)
    values (${id}::uuid, 'DXB', 'Dubai', 'دبي', 999)`.execute(tx);
  return id;
}

async function companyFixture(
  tx: Db,
  options: { enabled?: boolean; platform?: boolean; budget?: number } = {},
): Promise<Fixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const traderId = randomUUID();
  const tag = companyId.slice(0, 8);
  await sql`insert into companies(id, code, subdomain, name_en, status, activated_at)
    values (${companyId}::uuid, ${`RP-${tag}`}, ${`rp-${tag}`}, 'Route Planning Test', 'active', now())`.execute(
    tx,
  );
  // The office actor only signs records here; disabled, so it needs no Role.
  await sql`insert into accounts(id, company_id, account_kind, username, password_hash, preferred_language, status)
    values (${actorId}::uuid, ${companyId}::uuid, 'company_user', ${`rp.a.${actorId}`}, 'x', 'en', 'disabled')`.execute(
    tx,
  );
  await sql`insert into traders(id, company_id, code, name_en, mobile_number, created_by_account_id)
    values (${traderId}::uuid, ${companyId}::uuid, ${`TRD-${tag}`}, 'Route Trader', '971500000000', ${actorId}::uuid)`.execute(
    tx,
  );
  const driver = await driverFixture(tx, companyId, actorId, "D1");
  if (options.enabled !== false) {
    await sql`insert into company_route_optimization_settings(company_id, is_enabled, daily_call_budget)
      values (${companyId}::uuid, true, ${options.budget ?? 200})`.execute(tx);
  }
  if (options.platform !== undefined) {
    await sql`update platform_feature_flags set is_enabled = ${options.platform}
      where code = 'route_optimization_enabled'`.execute(tx);
  }
  return { companyId, actorId, traderId, emirateId: await emirate(tx), ...driver };
}

async function driverFixture(tx: Db, companyId: string, actorId: string, label: string) {
  const driverId = randomUUID();
  const driverAccountId = randomUUID();
  await sql`insert into accounts(id, company_id, account_kind, username, password_hash, preferred_language)
    values (${driverAccountId}::uuid, ${companyId}::uuid, 'driver', ${`rp.d.${driverAccountId}`}, 'x', 'en')`.execute(
    tx,
  );
  await sql`insert into drivers(id, company_id, account_id, code, name_en, mobile_number, driver_type, outsourced_fee_per_delivered_order)
    values (${driverId}::uuid, ${companyId}::uuid, ${driverAccountId}::uuid, ${`DRV-${label}-${driverId.slice(0, 6)}`},
            ${`Driver ${label}`}, '971502222222', 'outsourced', 10)`.execute(tx);
  await sql`insert into user_business_links(company_id, account_id, entity_type, entity_id, access_status, is_primary, created_by_account_id)
    values (${companyId}::uuid, ${driverAccountId}::uuid, 'driver', ${driverId}::uuid, 'active', true, ${actorId}::uuid)`.execute(
    tx,
  );
  return { driverId, driverAccountId };
}

async function areaFixture(
  tx: Db,
  f: Fixture,
  name: string,
  options: { verified?: boolean; latitude?: number; longitude?: number } = {},
): Promise<string> {
  const id = randomUUID();
  const verified = options.verified ?? true;
  await sql`insert into areas(id, company_id, emirate_id, code, name_en, latitude, longitude,
                              coordinates_verified_at, coordinates_verified_by_account_id)
    values (${id}::uuid, ${f.companyId}::uuid, ${f.emirateId}::uuid, ${`AR-${id.slice(0, 8)}`}, ${name},
            ${verified ? (options.latitude ?? 25.2) : null}, ${verified ? (options.longitude ?? 55.3) : null},
            ${verified ? sql`now()` : null}, ${verified ? f.actorId : null}::uuid)`.execute(tx);
  return id;
}

let orderSequence = 0;

async function orderFixture(
  tx: Db,
  f: Fixture,
  areaId: string,
  options: { status?: string; reconciliation?: string; driverId?: string | null } = {},
): Promise<string> {
  orderSequence += 1;
  const id = randomUUID();
  const fin = calculateOrderFinancials({
    prospective: true,
    additionalFees: new Decimal(0),
    codAmount: new Decimal(100),
    driverCost: new Decimal(0),
    paymentCondition: "customer_pays_cod_and_fee",
    serviceFee: new Decimal(18),
    vatPolicy: { enabled: false, priceMode: null, rate: new Decimal(0) },
  });
  const net = fin.traderNetPayable.toNumber();
  const serial = `RP${String(orderSequence).padStart(5, "0")}`;
  await sql`insert into orders(
      id, company_id, order_number, order_date, trader_id, area_id, created_by_account_id,
      customer_name, customer_mobile_number, customer_address, package_count,
      payment_condition, final_service_fee_snapshot, customer_provenance_status,
      pricing_provenance_status, financial_model_version, serial_number, serial_number_normalized,
      reference_number, reference_number_normalized, area_name_fallback_used,
      vat_enabled_snapshot, vat_rate_snapshot, vat_price_mode_snapshot, additional_fee_vat_amount,
      service_fee_vat_amount, cod_amount, service_fee, additional_fees, service_fee_net_amount,
      customer_amount_due, trader_gross_payable, trader_paid_service_fee, trader_deductions,
      total_deductions, trader_net_payable, company_revenue, order_profit, vat_amount,
      trader_paid_amount, amount_collected, delivery_status, delivered_at, closed_at,
      driver_reconciliation_status, trader_settlement_status, return_status, assigned_driver_id
    ) values (
      ${id}::uuid, ${f.companyId}::uuid, ${`ORD-R${String(orderSequence).padStart(6, "0")}`}, current_date,
      ${f.traderId}::uuid, ${areaId}::uuid, ${f.actorId}::uuid, 'Route Customer', '971501111111',
      'Address', 1, 'customer_pays_cod_and_fee', 18, 'legacy_unattributed', 'legacy_unattributed',
      'trader_deduction_v1', ${serial}, ${serial.toLowerCase()}, null, null, false, false, 0, null,
      0, 0, ${fin.codAmount.toNumber()}, ${fin.serviceFee.toNumber()}, ${fin.additionalFees.toNumber()},
      ${fin.serviceFeeNetAmount.toNumber()}, ${fin.customerAmountDue.toNumber()}, ${fin.codAmount.toNumber()},
      ${fin.traderPaidServiceFee.toNumber()}, ${fin.traderDeductions.toNumber()},
      ${fin.totalDeductions.toNumber()}, ${net}, ${fin.companyRevenue.toNumber()},
      ${fin.orderProfit.toNumber()}, ${fin.vatAmount.toNumber()}, 0, 0, 'new', null, null,
      'not_applicable', ${net > 0 ? "unsettled" : "not_eligible"}, 'not_applicable', null
    )`.execute(tx);
  const status = options.status ?? "assigned_to_driver";
  const driverId = options.driverId === undefined ? f.driverId : options.driverId;
  if (status !== "new" || driverId !== null) {
    // Test fixture only: move the Order straight to the wanted state with the
    // integrity triggers off for this transaction.
    const role = await sql<{
      role: string;
    }>`select current_setting('session_replication_role') as role`.execute(tx);
    await sql`set local session_replication_role = replica`.execute(tx);
    await sql`update orders
      set delivery_status = ${status}, assigned_driver_id = ${driverId}::uuid,
          driver_reconciliation_status = ${options.reconciliation ?? (status === "delivered" ? "pending" : "not_applicable")},
          delivered_at = ${status === "delivered" ? sql`now()` : null}
      where company_id = ${f.companyId}::uuid and id = ${id}::uuid`.execute(tx);
    if (driverId !== null) {
      await sql`insert into order_assignments(company_id, order_id, driver_id, assigned_by_account_id)
        values (${f.companyId}::uuid, ${id}::uuid, ${driverId}::uuid, ${f.actorId}::uuid)`.execute(
        tx,
      );
    }
    await sql`select set_config('session_replication_role', ${role.rows[0]?.role ?? "origin"}, true)`.execute(
      tx,
    );
  }
  return id;
}

function countingProvider(
  order?: (ids: string[]) => string[],
): RouteProvider & { plan: ReturnType<typeof vi.fn> } {
  return {
    name: "area_matrix",
    available: true,
    plan: vi.fn((request: { stops: readonly { areaId: string }[] }) => {
      const ids = request.stops.map((stop) => stop.areaId);
      return Promise.resolve({ orderedAreaIds: order ? order(ids) : ids, responseId: "engine-1" });
    }),
  };
}

function serviceFor(
  executor: Db,
  f: Pick<Fixture, "companyId" | "driverId" | "driverAccountId">,
  provider: RouteProvider = countingProvider(),
  inTransaction = true,
): RoutePlanningService {
  const transactions = inTransaction
    ? ({
        execute: <T>(work: (t: Transaction<DatabaseSchema>) => Promise<T>) =>
          work(executor as Transaction<DatabaseSchema>),
      } as unknown as KyselyTransactionManager)
    : ({
        execute: <T>(work: (t: Transaction<DatabaseSchema>) => Promise<T>) =>
          database.transaction().execute(work),
      } as unknown as KyselyTransactionManager);
  const identities = {
    current: () => ({
      companyId: f.companyId,
      identityId: f.driverAccountId,
      kind: "driver",
      permissions: [],
      profileId: f.driverId,
    }),
  } as unknown as IdentityContextAccessor;
  const businessDays = { businessDateOf: () => Promise.resolve(BUSINESS_DATE) } as Pick<
    BusinessDayService,
    "businessDateOf"
  >;
  return new RoutePlanningService(
    executor as Kysely<DatabaseSchema>,
    transactions,
    identities,
    businessDays as BusinessDayService,
    provider,
  );
}

async function orderRow(tx: Db, companyId: string, orderId: string): Promise<unknown> {
  const result =
    await sql`select to_jsonb(o) as row from orders o where o.company_id = ${companyId}::uuid and o.id = ${orderId}::uuid`.execute(
      tx,
    );
  return result.rows[0];
}

describe.skipIf(!run)("Driver route planning (database)", () => {
  beforeAll(async () => {
    if (process.env.BLUELINE_DISABLE_DOTENV !== "1") {
      loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });
    }
    pool = new Pool({ connectionString: configuration().database.url, max: 10 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const identity = await sql<{ name: string; local: boolean }>`
      select current_database() as name,
             coalesce(host(inet_server_addr()) in ('127.0.0.1', '::1'), true) as local
    `.execute(database);
    const row = identity.rows[0];
    if (row?.name !== "blueline" || row.local !== true) {
      throw new Error(
        "Route planning database tests run only against a local database named blueline",
      );
    }
  });

  // The pool is closed by the concurrency suite below, which runs last.

  it("is invisible and refuses writes while the Company is not enabled", async () => {
    await inRollback(async (tx) => {
      const f = await companyFixture(tx, { enabled: false });
      const service = serviceFor(tx, f);
      await expect(service.current()).resolves.toEqual({ enabled: false, stale: false, run: null });
      await expect(service.plan({}, "plan-key-0001")).rejects.toMatchObject({
        errorCode: "route_planning_disabled",
      });
      const runs =
        await sql`select 1 from driver_route_runs where company_id = ${f.companyId}::uuid`.execute(
          tx,
        );
      expect(runs.rows).toHaveLength(0);
    });
  });

  it("plans stops from the Driver's own active work only and never calls the engine behind the kill switch", async () => {
    await inRollback(async (tx) => {
      const f = await companyFixture(tx, { platform: false });
      const other = await driverFixture(tx, f.companyId, f.actorId, "D2");
      const barsha = await areaFixture(tx, f, "Al Barsha");
      const deira = await areaFixture(tx, f, "Deira");
      const qusais = await areaFixture(tx, f, "Al Qusais");
      const hold = await areaFixture(tx, f, "Hold Area");
      const otherArea = await areaFixture(tx, f, "Other Driver Area");
      const a1 = await orderFixture(tx, f, barsha);
      await orderFixture(tx, f, deira, { status: "out_for_delivery" });
      // Delivered with cash still owed: in the list, never a destination.
      await orderFixture(tx, f, qusais, { status: "delivered", reconciliation: "pending" });
      await orderFixture(tx, f, hold, { status: "hold" });
      await orderFixture(tx, f, otherArea, { driverId: other.driverId });

      const engine = countingProvider();
      const result = await serviceFor(tx, f, engine).plan({}, "plan-key-0001");
      expect(engine.plan).not.toHaveBeenCalled();
      expect(result.enabled).toBe(false);
      const view = result.run;
      expect(view).toMatchObject({
        resultSource: "fallback",
        fallbackReason: "kill_switch",
        revision: 1,
        routeSource: "fallback",
      });
      expect(view?.referenceNumber).toMatch(/^RUN-\d{6}$/);
      const stopAreas = view?.areas
        .filter((item) => item.orderCount > 0)
        .map((item) => item.areaId)
        .sort();
      expect(stopAreas).toEqual([barsha, deira].sort());
      expect(view?.areas.some((item) => item.areaId === qusais && item.orderCount > 0)).toBe(false);
      expect(view?.areas.some((item) => item.areaId === hold || item.areaId === otherArea)).toBe(
        false,
      );
      expect(view?.cashHandoverOrderCount).toBe(1);
      expect(view?.areas.flatMap((item) => item.orders.map((o) => o.id))).toContain(a1);
    });
  });

  it("calls the engine once when enabled and records the reservation outcome", async () => {
    await inRollback(async (tx) => {
      const f = await companyFixture(tx, { platform: true });
      const a = await areaFixture(tx, f, "Al Barsha");
      const b = await areaFixture(tx, f, "Deira");
      const unverified = await areaFixture(tx, f, "Western Region", { verified: false });
      await orderFixture(tx, f, a);
      await orderFixture(tx, f, b);
      await orderFixture(tx, f, unverified);
      const engine = countingProvider((ids) => [...ids].reverse());
      const result = await serviceFor(tx, f, engine).plan(
        { startLatitude: 25.1, startLongitude: 55.2 },
        "plan-key-0002",
      );
      expect(engine.plan).toHaveBeenCalledTimes(1);
      expect(result.run).toMatchObject({
        resultSource: "provider",
        routeSource: "gps",
        provider: "area_matrix",
      });
      const sequenced = result.run?.areas
        .filter((item) => item.isSequenced)
        .map((item) => item.areaId);
      expect(sequenced).toEqual([b, a]);
      expect(result.run?.areas.at(-1)).toMatchObject({ areaId: unverified, isSequenced: false });
      const usage = await sql<{ call_count: number; success_count: number }>`
        select call_count, success_count from company_route_optimization_usage
         where company_id = ${f.companyId}::uuid and business_date = ${BUSINESS_DATE}::date`.execute(
        tx,
      );
      expect(usage.rows[0]).toEqual({ call_count: 1, success_count: 1 });
    });
  });

  it("returns the same run for a repeated key and never creates a parallel run", async () => {
    await inRollback(async (tx) => {
      const f = await companyFixture(tx, { platform: true });
      await orderFixture(tx, f, await areaFixture(tx, f, "Al Barsha"));
      const engine = countingProvider();
      const service = serviceFor(tx, f, engine);
      const first = await service.plan({}, "plan-key-0003");
      const repeated = await service.plan({}, "plan-key-0003");
      const differentKey = await service.plan({}, "plan-key-0004");
      expect(repeated.run?.id).toBe(first.run?.id);
      expect(differentKey.run?.id).toBe(first.run?.id);
      expect(engine.plan).toHaveBeenCalledTimes(1);
      const runs =
        await sql`select 1 from driver_route_runs where company_id = ${f.companyId}::uuid`.execute(
          tx,
        );
      expect(runs.rows).toHaveLength(1);
      await expect(
        sql`insert into driver_route_runs(company_id, driver_id, business_date, reference_number, provider, route_source,
              result_source, fallback_reason, plan_idempotency_key, created_by_account_id)
            values (${f.companyId}::uuid, ${f.driverId}::uuid, ${BUSINESS_DATE}::date, 'RUN-999999', 'none', 'fallback',
              'fallback', 'disabled', 'manual-key-01', ${f.driverAccountId}::uuid)`.execute(tx),
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  it("reverse direction reorders the stored stops without an engine call", async () => {
    await inRollback(async (tx) => {
      const f = await companyFixture(tx, { platform: true });
      const a = await areaFixture(tx, f, "Al Barsha");
      const b = await areaFixture(tx, f, "Deira");
      await orderFixture(tx, f, a);
      await orderFixture(tx, f, b);
      const engine = countingProvider();
      const service = serviceFor(tx, f, engine);
      const planned = await service.plan({}, "plan-key-0005");
      const before = planned.run?.areas.map((item) => item.areaId);
      const reversed = await service.reverse(1, "reverse-key-01");
      expect(engine.plan).toHaveBeenCalledTimes(1);
      expect(reversed.run?.areas.map((item) => item.areaId)).toEqual([...(before ?? [])].reverse());
      expect(reversed.run).toMatchObject({ direction: "reversed", revision: 2 });
      // Repeating the same key does nothing more.
      const again = await service.reverse(1, "reverse-key-01");
      expect(again.run).toMatchObject({ direction: "reversed", revision: 2, id: planned.run?.id });
    });
  });

  it("defer moves the Order to the end of the run and changes no column on orders", async () => {
    await inRollback(async (tx) => {
      const f = await companyFixture(tx, { platform: false });
      const a = await areaFixture(tx, f, "Al Barsha");
      const deferredOrder = await orderFixture(tx, f, a);
      await orderFixture(tx, f, a);
      const service = serviceFor(tx, f);
      await service.plan({}, "plan-key-0006");
      const before = await orderRow(tx, f.companyId, deferredOrder);
      const result = await service.defer(deferredOrder, 1, "defer-key-001");
      expect(await orderRow(tx, f.companyId, deferredOrder)).toEqual(before);
      expect(result.run?.deferredOrders.map((o) => o.id)).toEqual([deferredOrder]);
      expect(result.run?.areas.flatMap((item) => item.orders.map((o) => o.id))).not.toContain(
        deferredOrder,
      );
      expect(result.run?.revision).toBe(2);
      const actions = await sql<{ action: string; order_id: string | null; revision: number }>`
        select action, order_id, revision from driver_route_actions
         where company_id = ${f.companyId}::uuid order by created_at, revision`.execute(tx);
      expect(actions.rows.map((row) => row.action)).toEqual(["plan", "defer"]);
      expect(actions.rows[1]).toMatchObject({ order_id: deferredOrder, revision: 2 });
    });
  });

  it("a stale revision returns the current run and changes nothing", async () => {
    await inRollback(async (tx) => {
      const f = await companyFixture(tx, { platform: false });
      const a = await areaFixture(tx, f, "Al Barsha");
      const orderId = await orderFixture(tx, f, a);
      const service = serviceFor(tx, f);
      await service.plan({}, "plan-key-0007");
      await service.reverse(1, "reverse-key-02");
      const stale = await service.defer(orderId, 1, "defer-key-002");
      expect(stale.stale).toBe(true);
      expect(stale.run?.revision).toBe(2);
      expect(stale.run?.deferredOrders).toEqual([]);
    });
  });

  it("refuses to defer another Driver's Order or a delivered one", async () => {
    await inRollback(async (tx) => {
      const f = await companyFixture(tx, { platform: false });
      const other = await driverFixture(tx, f.companyId, f.actorId, "D3");
      const a = await areaFixture(tx, f, "Al Barsha");
      await orderFixture(tx, f, a);
      const othersOrder = await orderFixture(tx, f, a, { driverId: other.driverId });
      const delivered = await orderFixture(tx, f, a, {
        status: "delivered",
        reconciliation: "pending",
      });
      const service = serviceFor(tx, f);
      await service.plan({}, "plan-key-0008");
      await expect(service.defer(othersOrder, 1, "defer-key-003")).rejects.toMatchObject({
        errorCode: "route_order_not_in_run",
      });
      await expect(service.defer(delivered, 1, "defer-key-004")).rejects.toMatchObject({
        errorCode: "route_order_not_in_run",
      });
    });
  });

  it("isolates Companies: another Company's Driver cannot see this run", async () => {
    await inRollback(async (tx) => {
      const f = await companyFixture(tx, { platform: false });
      await orderFixture(tx, f, await areaFixture(tx, f, "Al Barsha"));
      await serviceFor(tx, f).plan({}, "plan-key-0009");
      const g = await companyFixture(tx, { platform: false });
      const intruder = serviceFor(tx, {
        companyId: g.companyId,
        driverId: f.driverId,
        driverAccountId: f.driverAccountId,
      });
      await expect(intruder.current()).rejects.toMatchObject({
        errorCode: "profile_access_inactive",
      });
      expect((await serviceFor(tx, g).current()).run).toBeNull();
    });
  });

  it("shows an Area that gained Orders after planning as new, and a delivered Area as done", async () => {
    await inRollback(async (tx) => {
      const f = await companyFixture(tx, { platform: false });
      const a = await areaFixture(tx, f, "Al Barsha");
      const b = await areaFixture(tx, f, "Deira");
      const first = await orderFixture(tx, f, a);
      const service = serviceFor(tx, f);
      await service.plan({}, "plan-key-0010");
      await orderFixture(tx, f, b);
      await sql`set local session_replication_role = replica`.execute(tx);
      await sql`update orders set delivery_status = 'delivered', driver_reconciliation_status = 'pending', delivered_at = now()
                 where company_id = ${f.companyId}::uuid and id = ${first}::uuid`.execute(tx);
      await sql`set local session_replication_role = origin`.execute(tx);
      const view = (await service.current()).run;
      expect(view?.areas.find((item) => item.areaId === a)).toMatchObject({
        status: "done",
        orderCount: 0,
        cashHandoverCount: 1,
      });
      expect(view?.areas.find((item) => item.areaId === b)).toMatchObject({
        isNew: true,
        sequencePosition: null,
        orderCount: 1,
      });
      expect(view?.nextAreaId).toBe(b);
    });
  });
});

describe.skipIf(!run)("Driver route planning concurrency (database, committed fixtures)", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    // Committed in one transaction so the race below sees a real Company.
    fixture = await database.transaction().execute(async (tx) => {
      const created = await companyFixture(tx, { budget: 5, platform: true });
      await orderFixture(tx, created, await areaFixture(tx, created, "Al Barsha"));
      return created;
    });
  });

  afterAll(async () => {
    if (fixture === undefined) {
      await database.destroy();
      return;
    }
    const c = fixture.companyId;
    await database.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = replica`.execute(tx);
      for (const table of [
        "driver_route_actions",
        "driver_route_stops",
        "driver_route_runs",
        "company_route_optimization_usage",
        "company_route_optimization_settings",
        "company_reference_counters",
        "orders",
        "areas",
        "user_business_links",
        "drivers",
        "traders",
        "accounts",
      ]) {
        await sql`delete from ${sql.table(table)} where company_id = ${c}::uuid`.execute(tx);
      }
      await sql`delete from companies where id = ${c}::uuid`.execute(tx);
      await sql`update platform_feature_flags set is_enabled = false where code = 'route_optimization_enabled'`.execute(
        tx,
      );
    });
    await database.destroy();
  });

  it("concurrent reservations one below the budget: exactly one reaches the engine", async () => {
    await sql`insert into company_route_optimization_usage(company_id, business_date, call_count)
      values (${fixture.companyId}::uuid, ${BUSINESS_DATE}::date, 4)`.execute(database);
    const engine = countingProvider();
    const services = Array.from({ length: 6 }, () => serviceFor(database, fixture, engine, false));
    // Each Plan uses a distinct key; only one run can exist, but every request
    // computes before persisting, so all of them race for the budget.
    const results = await Promise.allSettled(
      services.map((service, index) => service.plan({}, `race-key-${index}-0000`)),
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(engine.plan).toHaveBeenCalledTimes(1);
    const runs =
      await sql`select 1 from driver_route_runs where company_id = ${fixture.companyId}::uuid and status = 'active'`.execute(
        database,
      );
    expect(runs.rows).toHaveLength(1);
    const usage = await sql<{ call_count: number; success_count: number; fallback_count: number }>`
      select call_count, success_count, fallback_count from company_route_optimization_usage
       where company_id = ${fixture.companyId}::uuid and business_date = ${BUSINESS_DATE}::date`.execute(
      database,
    );
    // A request that arrives after the winner committed returns its run
    // without reserving, so the number of losers varies -- but every
    // reservation is accounted for, and only one became an engine call.
    const counts = usage.rows[0] as {
      call_count: number;
      success_count: number;
      fallback_count: number;
    };
    expect(counts.success_count).toBe(1);
    expect(counts.call_count).toBe(4 + 1 + counts.fallback_count);
  });
});
