import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { config as loadEnvironment } from "dotenv";
import { Decimal } from "decimal.js";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Logger } from "nestjs-pino";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { configuration } from "../configuration/environment.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApiExceptionFilter } from "../presentation/errors/api-exception.filter.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import { calculateOrderFinancials } from "./order-financial-model.js";
import { OrderValidationLookup } from "./order-validation.lookup.js";
import {
  OrderValidationService,
  type OrderValidationCheck,
  type OrderValidationCheckCode,
  type OrderValidationResult,
} from "./order-validation.service.js";

/**
 * Repair Center Order Validation (phase 1) against a real PostgreSQL schema.
 *
 * Disposable database only: the suite refuses to run unless the connected
 * database is named `blueline` on a local host, and every test runs inside one
 * transaction that is always rolled back. Fixtures follow the shapes found on
 * 8 Oct 2026 (spec §1): ORD-000160 before and after its fix, the
 * re-recognition gap, ORD-000195 (V2), Trader-pays-fee with its fee collected.
 *
 *   RUN_ORDER_VALIDATION_DATABASE=true pnpm --filter @blueline/api exec vitest run src/operations/order-validation.database.test.ts
 */
const run = process.env.RUN_ORDER_VALIDATION_DATABASE === "true";

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

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

interface CompanyFixture {
  readonly companyId: string;
  readonly actorId: string;
  readonly traderId: string;
  readonly areaId: string;
  readonly tag: string;
  journalPeriod?: { fiscalYearId: string; periodId: string };
}

async function company(tx: Db, options: { accounting?: boolean } = {}): Promise<CompanyFixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const traderId = randomUUID();
  const areaId = randomUUID();
  const tag = companyId.slice(0, 8);
  await sql`insert into companies(id, code, subdomain, name_en, status, activated_at)
    values (${companyId}::uuid, ${`OV-${tag}`}, ${`ov-${tag}`}, 'Order Validation Test', 'active', now())`.execute(
    tx,
  );
  await sql`insert into accounts(id, company_id, account_kind, username, password_hash, preferred_language)
    values (${actorId}::uuid, ${companyId}::uuid, 'company_user', ${`ov.a.${actorId}`}, 'x', 'en')`.execute(
    tx,
  );
  await sql`insert into traders(id, company_id, code, name_en, mobile_number, created_by_account_id)
    values (${traderId}::uuid, ${companyId}::uuid, ${`TRD-${tag}`}, 'Validation Trader', '971500000000', ${actorId}::uuid)`.execute(
    tx,
  );
  const emirate = await sql<{
    id: string;
  }>`select id from emirates where code = 'DXB' limit 1`.execute(tx);
  let emirateId = emirate.rows[0]?.id;
  if (emirateId === undefined) {
    emirateId = randomUUID();
    await sql`insert into emirates(id, code, name_en, name_ar, display_order)
      values (${emirateId}::uuid, 'DXB', 'Dubai', 'دبي', 999)`.execute(tx);
  }
  await sql`insert into areas(id, company_id, emirate_id, code, name_en)
    values (${areaId}::uuid, ${companyId}::uuid, ${emirateId}::uuid, ${`AREA-${tag}`}, 'Validation Area')`.execute(
    tx,
  );
  if (options.accounting === true) {
    await sql`insert into accounting_configurations(company_id, accounting_enabled)
      values (${companyId}::uuid, true)`.execute(tx);
  }
  return { companyId, actorId, traderId, areaId, tag };
}

interface OrderOptions {
  readonly number: number;
  readonly reference?: string | null;
  readonly cod: number;
  readonly fee?: number;
  readonly additional?: number;
  readonly condition?: "customer_pays_cod_and_fee" | "customer_pays_cod_trader_pays_fee";
  readonly status?: string;
  readonly settlementStatus?: string;
  readonly reconciliationStatus?: string;
  readonly deliveredAt?: string | null;
  readonly amountCollected?: number;
  readonly traderPaidAmount?: number;
  readonly assignedDriverId?: string | null;
  /** Raw column overrides applied after the model values. */
  readonly override?: Readonly<Record<string, number | string | null>>;
  /** Write a delivery status-history row to the final status (default true). */
  readonly history?: boolean;
}

interface OrderFixture {
  readonly id: string;
  readonly orderNumber: string;
  readonly version: number;
}

async function order(tx: Db, c: CompanyFixture, o: OrderOptions): Promise<OrderFixture> {
  const id = randomUUID();
  const orderNumber = `ORD-${String(o.number).padStart(6, "0")}`;
  const fee = o.fee ?? 18;
  const additional = o.additional ?? 0;
  const condition = o.condition ?? "customer_pays_cod_and_fee";
  const status = o.status ?? "delivered";
  const f = calculateOrderFinancials({
    prospective: true,
    additionalFees: new Decimal(additional),
    codAmount: new Decimal(o.cod),
    driverCost: new Decimal(0),
    paymentCondition: condition,
    serviceFee: new Decimal(fee),
    vatPolicy: { enabled: false, priceMode: null, rate: new Decimal(0) },
  });
  const net = f.traderNetPayable.toNumber();
  const values: Record<string, number | string | null> = {
    cod_amount: f.codAmount.toNumber(),
    service_fee: f.serviceFee.toNumber(),
    additional_fees: f.additionalFees.toNumber(),
    service_fee_net_amount: f.serviceFeeNetAmount.toNumber(),
    customer_amount_due: f.customerAmountDue.toNumber(),
    trader_gross_payable: f.codAmount.toNumber(),
    trader_paid_service_fee: f.traderPaidServiceFee.toNumber(),
    trader_deductions: f.traderDeductions.toNumber(),
    total_deductions: f.totalDeductions.toNumber(),
    trader_net_payable: net,
    company_revenue: f.companyRevenue.toNumber(),
    order_profit: f.orderProfit.toNumber(),
    vat_amount: f.vatAmount.toNumber(),
    trader_paid_amount: o.traderPaidAmount ?? 0,
    amount_collected: o.amountCollected ?? 0,
    ...o.override,
  };
  const deliveredAt =
    o.deliveredAt === undefined
      ? ["delivered", "closed"].includes(status)
        ? "2026-10-01T10:00:00+04:00"
        : null
      : o.deliveredAt;
  const reference = o.reference === undefined ? String(o.number) : o.reference;
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
      ${id}::uuid, ${c.companyId}::uuid, ${orderNumber}, date '2026-10-01', ${c.traderId}::uuid,
      ${c.areaId}::uuid, ${c.actorId}::uuid, 'Validation Customer', '971501111111', 'Address', 1,
      ${condition}, ${fee}, 'legacy_unattributed', 'legacy_unattributed', 'trader_deduction_v1',
      ${`S-${o.number}`}, ${`s-${o.number}`}, ${reference},
      ${reference === null ? null : reference.toLowerCase()}, false, false, 0, null, 0, 0,
      ${values.cod_amount}, ${values.service_fee}, ${values.additional_fees}, ${values.service_fee_net_amount},
      ${values.customer_amount_due}, ${values.trader_gross_payable}, ${values.trader_paid_service_fee},
      ${values.trader_deductions}, ${values.total_deductions}, ${values.trader_net_payable},
      ${values.company_revenue}, ${values.order_profit}, ${values.vat_amount}, ${values.trader_paid_amount},
      ${values.amount_collected}, ${status}, ${deliveredAt}::timestamptz,
      ${status === "closed" ? "2026-10-02T10:00:00+04:00" : null}::timestamptz,
      ${o.reconciliationStatus ?? "not_applicable"},
      ${o.settlementStatus ?? (net > 0 ? "unsettled" : "not_eligible")}, 'not_applicable',
      ${o.assignedDriverId ?? null}::uuid
    )`.execute(tx);
  if (o.history !== false && status !== "new") {
    await sql`insert into order_status_history(company_id, order_id, status_dimension, from_status, to_status, changed_by_account_id, occurred_at)
      values (${c.companyId}::uuid, ${id}::uuid, 'delivery', 'new', ${status}, ${c.actorId}::uuid, '2026-10-01T09:00:00+04:00')`.execute(
      tx,
    );
  }
  return { id, orderNumber, version: await version(tx, c.companyId, id) };
}

async function version(tx: Db, companyId: string, orderId: string): Promise<number> {
  const result = await sql<{
    version: number;
  }>`select version::int as version from orders where company_id = ${companyId}::uuid and id = ${orderId}::uuid`.execute(
    tx,
  );
  return result.rows[0]!.version;
}

async function journal(
  tx: Db,
  c: CompanyFixture,
  number: string,
  totalDebit: number,
): Promise<string> {
  if (c.journalPeriod === undefined) {
    const fiscalYearId = randomUUID();
    const periodId = randomUUID();
    await sql`insert into fiscal_years(id, company_id, start_date, end_date, fiscal_year_code, name)
      values (${fiscalYearId}::uuid, ${c.companyId}::uuid, date '2026-01-01', date '2026-12-31', 'FY2026', 'FY 2026')`.execute(
      tx,
    );
    await sql`insert into accounting_periods(id, company_id, fiscal_year_id, period_start, period_end, period_number, period_code, name)
      values (${periodId}::uuid, ${c.companyId}::uuid, ${fiscalYearId}::uuid, date '2026-10-01', date '2026-10-31', 10, '2026-10', 'October 2026')`.execute(
      tx,
    );
    c.journalPeriod = { fiscalYearId, periodId };
  }
  const id = randomUUID();
  await sql`insert into journal_entries(id, company_id, journal_number, business_date, fiscal_year_id, accounting_period_id,
      source_type, description, created_by_account_id, total_debit, total_credit)
    values (${id}::uuid, ${c.companyId}::uuid, ${number}, date '2026-10-01', ${c.journalPeriod.fiscalYearId}::uuid,
      ${c.journalPeriod.periodId}::uuid, 'order', 'fixture', ${c.actorId}::uuid, ${totalDebit}, ${totalDebit})`.execute(
    tx,
  );
  return id;
}

interface Component {
  readonly type: string;
  readonly intent: "debit" | "credit";
  readonly amount: number;
}

async function accountingEvent(
  tx: Db,
  c: CompanyFixture,
  o: OrderFixture,
  e: {
    type: "order_delivered" | "order_recognition_reversed";
    version: number;
    status: string;
    journalId?: string | null;
    reversalOf?: string | null;
    components?: readonly Component[];
  },
): Promise<string> {
  const id = randomUUID();
  const key = `${e.type}:${o.id}:v${e.version}`;
  await sql`insert into accounting_events(id, company_id, event_type, event_version, source_entity_type, source_entity_id,
      source_reference, effective_accounting_date, currency, correlation_id, idempotency_key, event_hash, actor_type,
      description, reversal_of_event_id, processing_status, operational_area, journal_id)
    values (${id}::uuid, ${c.companyId}::uuid, ${e.type}, ${e.version}, 'order', ${o.id}::uuid, ${o.orderNumber},
      date '2026-10-01', 'AED', ${key}, ${key}, ${`hash-${key}`}, 'system', ${`${e.type} for ${o.orderNumber}`},
      ${e.reversalOf ?? null}::uuid, ${e.status}, 'orders', ${e.journalId ?? null}::uuid)`.execute(
    tx,
  );
  let number = 1;
  for (const component of e.components ?? []) {
    await sql`insert into accounting_event_components(company_id, accounting_event_id, component_number, component_type, amount, entry_intent, mapping_key)
      values (${c.companyId}::uuid, ${id}::uuid, ${number}, ${component.type}, ${component.amount}, ${component.intent}, ${component.type})`.execute(
      tx,
    );
    number += 1;
  }
  return id;
}

/** JRN-<tag>-310 for ORD-000160 itself; other Order numbers get their own journal numbers. */
function jrn(c: CompanyFixture, number: number, journal: number): string {
  return number === 160 ? `JRN-${c.tag}-${journal}` : `JRN-${c.tag}-${number}-${journal}`;
}

const FIXED_160: readonly Component[] = [
  { type: "cod_receivable", intent: "debit", amount: 193 },
  { type: "trader_payable", intent: "credit", amount: 175 },
  { type: "service_fee_revenue", intent: "credit", amount: 18 },
];
const ORIGINAL_160: readonly Component[] = [
  { type: "cod_receivable", intent: "debit", amount: 193 },
  { type: "service_fee_revenue", intent: "credit", amount: 193 },
];

/** ORD-000160 as entered (§1.1): COD 0, fee 18, additional 175, customer pays, closed, posted v1. */
async function ord160Before(
  tx: Db,
  c: CompanyFixture,
  number = 160,
  reference = "1744",
): Promise<OrderFixture> {
  const o = await order(tx, c, {
    number,
    reference,
    cod: 0,
    fee: 18,
    additional: 175,
    status: "closed",
  });
  const journalId = await journal(tx, c, jrn(c, number, 310), 193);
  await accountingEvent(tx, c, o, {
    type: "order_delivered",
    version: 1,
    status: "posted",
    journalId,
    components: ORIGINAL_160,
  });
  return o;
}

/** ORD-000160 after the 8 Oct fix: COD 193, delivered, unsettled; v1 reversed, v2 posted. */
async function ord160After(
  tx: Db,
  c: CompanyFixture,
  number = 160,
  reference = "1744",
): Promise<OrderFixture> {
  const o = await order(tx, c, {
    number,
    reference,
    cod: 193,
    fee: 18,
    additional: 0,
    status: "delivered",
  });
  const j310 = await journal(tx, c, jrn(c, number, 310), 193);
  const j555 = await journal(tx, c, jrn(c, number, 555), 193);
  const j556 = await journal(tx, c, jrn(c, number, 556), 193);
  const v1 = await accountingEvent(tx, c, o, {
    type: "order_delivered",
    version: 1,
    status: "reversed",
    journalId: j310,
    components: ORIGINAL_160,
  });
  await accountingEvent(tx, c, o, {
    type: "order_recognition_reversed",
    version: 1,
    status: "posted",
    journalId: j555,
    reversalOf: v1,
  });
  await accountingEvent(tx, c, o, {
    type: "order_delivered",
    version: 2,
    status: "posted",
    journalId: j556,
    components: FIXED_160,
  });
  return o;
}

/** §1.3: delivered again after a reversal, and the v1 re-enqueue was ignored -- no effective recognition. */
async function recognitionGap(tx: Db, c: CompanyFixture, number: number): Promise<OrderFixture> {
  const o = await order(tx, c, { number, cod: 193, fee: 18 });
  const j1 = await journal(tx, c, `JRN-${c.tag}-${number}-1`, 193);
  const j2 = await journal(tx, c, `JRN-${c.tag}-${number}-2`, 193);
  const v1 = await accountingEvent(tx, c, o, {
    type: "order_delivered",
    version: 1,
    status: "reversed",
    journalId: j1,
    components: FIXED_160,
  });
  await accountingEvent(tx, c, o, {
    type: "order_recognition_reversed",
    version: 1,
    status: "posted",
    journalId: j2,
    reversalOf: v1,
  });
  return o;
}

async function codRemoved(tx: Db, c: CompanyFixture, o: OrderFixture, from: string): Promise<void> {
  await sql`insert into order_events(company_id, order_id, event_type, event_category, field_name, previous_value, new_value,
      actor_account_id, actor_role, source, correlation_id, occurred_at)
    values (${c.companyId}::uuid, ${o.id}::uuid, 'order.updated', 'financial_change', 'cod_amount',
      to_jsonb(${from}::text), to_jsonb('0.00'::text), ${c.actorId}::uuid, 'Operator', 'web_portal',
      ${randomUUID()}, '2026-10-01T09:59:00+04:00')`.execute(tx);
}

function byCode(
  result: OrderValidationResult,
): Record<OrderValidationCheckCode, OrderValidationCheck> {
  return Object.fromEntries(result.checks.map((check) => [check.code, check])) as Record<
    OrderValidationCheckCode,
    OrderValidationCheck
  >;
}

async function validate(tx: Db, c: CompanyFixture, o: OrderFixture) {
  const service = new OrderValidationService(tx as unknown as Kysely<DatabaseSchema>);
  return byCode(await service.validate(c.companyId, o.id, await version(tx, c.companyId, o.id)));
}

async function rowCounts(tx: Db): Promise<Record<string, number>> {
  const result = await sql<Record<string, number>>`
    select (select count(*) from orders)::int as orders,
           (select count(*) from order_events)::int as order_events,
           (select count(*) from order_status_history)::int as order_status_history,
           (select count(*) from accounting_events)::int as accounting_events,
           (select count(*) from journal_entries)::int as journal_entries,
           (select count(*) from audit_events)::int as audit_events
  `.execute(tx);
  return result.rows[0]!;
}

async function lookupError(
  tx: Db,
  companyId: string,
  value: string,
): Promise<ApplicationException> {
  const lookup = new OrderValidationLookup(tx as unknown as Kysely<DatabaseSchema>);
  const error = await lookup.resolve(companyId, value).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApplicationException);
  return error as ApplicationException;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe.skipIf(!run)("Repair Center Order Validation (database)", () => {
  beforeAll(async () => {
    if (process.env.BLUELINE_DISABLE_DOTENV !== "1") {
      loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });
    }
    pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const identity = await sql<{ name: string; local: boolean }>`
      select current_database() as name,
             coalesce(host(inet_server_addr()) in ('127.0.0.1', '::1'), true) as local
    `.execute(database);
    const row = identity.rows[0];
    if (row?.name !== "blueline" || !row.local) {
      throw new Error(`Refusing Order Validation tests against database ${String(row?.name)}`);
    }
  });

  afterAll(async () => {
    await database?.destroy();
  });

  describe("lookup", () => {
    it("resolves an exact Order Number, a bare number and an exact reference", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        const target = await order(tx, c, { number: 160, reference: "1744", cod: 193 });
        await order(tx, c, { number: 161, reference: "2416", cod: 50 });
        const lookup = new OrderValidationLookup(tx as unknown as Kysely<DatabaseSchema>);
        for (const value of ["ORD-000160", "ord-000160", "160", "1744"]) {
          expect(await lookup.resolve(c.companyId, value), value).toEqual({
            orderId: target.id,
            orderNumber: "ORD-000160",
            referenceNumber: "1744",
            version: target.version,
          });
        }
      });
    });

    it("reports not found cleanly (refs 2465 / 2480)", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        await order(tx, c, { number: 160, reference: "1744", cod: 193 });
        for (const value of ["2465", "2480"]) {
          const error = await lookupError(tx, c.companyId, value);
          expect(error.errorCode).toBe("order_not_found");
          expect(error.getStatus()).toBe(404);
        }
      });
    });

    it("refuses an ambiguous value with the candidate Order Numbers", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        // "301" is both ORD-000301's number and another Order's reference.
        await order(tx, c, { number: 301, reference: "A-301", cod: 10 });
        await order(tx, c, { number: 302, reference: "301", cod: 10 });
        const error = await lookupError(tx, c.companyId, "301");
        expect(error.errorCode).toBe("order_lookup_ambiguous");
        expect(error.getStatus()).toBe(409);
        expect(error.validationDetails).toEqual(["ORD-000301", "ORD-000302"]);
      });
    });

    it("refuses a list", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        const error = await lookupError(tx, c.companyId, "1744,2416");
        expect(error.errorCode).toBe("order_lookup_invalid");
      });
    });

    it("returns only the route Company's Order when two Companies share a reference", async () => {
      await inRollback(async (tx) => {
        const a = await company(tx);
        const b = await company(tx);
        const mine = await order(tx, a, { number: 160, reference: "1744", cod: 193 });
        await order(tx, b, { number: 160, reference: "1744", cod: 193 });
        await order(tx, b, { number: 999, reference: "ONLY-B", cod: 1 });
        const lookup = new OrderValidationLookup(tx as unknown as Kysely<DatabaseSchema>);
        expect((await lookup.resolve(a.companyId, "1744")).orderId).toBe(mine.id);
        expect((await lookup.resolve(a.companyId, "ORD-000160")).orderId).toBe(mine.id);
        expect((await lookupError(tx, a.companyId, "ONLY-B")).errorCode).toBe("order_not_found");
      });
    });

    it("refuses a stale version at validation", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        const o = await order(tx, c, { number: 160, cod: 193 });
        const service = new OrderValidationService(tx as unknown as Kysely<DatabaseSchema>);
        const error = await service
          .validate(c.companyId, o.id, o.version + 1)
          .catch((caught: unknown) => caught);
        expect((error as ApplicationException).errorCode).toBe("order_changed_since_lookup");
        expect((error as ApplicationException).getStatus()).toBe(409);
      });
    });
  });

  describe("§1 shapes", () => {
    it("ORD-000160 before the fix: V1 strong, F2 consistent at not_eligible, A1 one recognition", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx, { accounting: true });
        const checks = await validate(tx, c, await ord160Before(tx, c));
        expect(checks.V1.severity).toBe("warning");
        expect(checks.V1.titleKey).toBe("platform.orderValidation.V1.strong.title");
        expect(checks.F2.severity).toBe("pass");
        expect(checks.F2.stored).toMatchObject({ status: "not_eligible" });
        expect(checks.F1.severity).toBe("pass");
        expect(checks.F3.severity).toBe("pass");
        expect(checks.A1.severity).toBe("pass");
        expect(checks.A2.severity).toBe("pass");
        expect(checks.A4.severity).toBe("pass");
      });
    });

    it("ORD-000160 after the fix: A1 exactly one effective recognition, at v2, and its journal matches", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx, { accounting: true });
        const checks = await validate(tx, c, await ord160After(tx, c));
        expect(checks.A1.severity).toBe("pass");
        expect(checks.A1.stored).toEqual({
          effectiveRecognitions: [{ version: 2, journal: `JRN-${c.tag}-556` }],
        });
        expect(checks.A1.refs).toContain(`JRN-${c.tag}-556`);
        expect(checks.A2.severity).toBe("pass");
        expect(checks.A4.severity).toBe("pass");
        expect(checks.V1.severity).toBe("pass");
        expect(checks.F1.severity).toBe("pass");
        expect(checks.F2.severity).toBe("pass");
      });
    });

    it("re-recognition gap (§1.3): A4 fails, and A1 fails", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx, { accounting: true });
        const checks = await validate(tx, c, await recognitionGap(tx, c, 400));
        expect(checks.A4.severity).toBe("fail");
        expect(checks.A1.severity).toBe("fail");
      });
    });

    it("ORD-000195 shape: COD removed before delivery raises V2", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        const o = await order(tx, c, {
          number: 195,
          reference: "2487",
          cod: 0,
          fee: 18,
          condition: "customer_pays_cod_trader_pays_fee",
        });
        await codRemoved(tx, c, o, "859.00");
        const checks = await validate(tx, c, o);
        expect(checks.V2.severity).toBe("warning");
        expect(checks.V2.stored).toMatchObject({ codRemovals: [{ from: "859.00", to: "0.00" }] });
      });
    });
  });

  describe("every check passes and fails", () => {
    it("L1: history and status events agree / disagree", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        const good = await order(tx, c, { number: 1, cod: 50 });
        const bad = await order(tx, c, { number: 2, cod: 50, history: false });
        await sql`insert into order_status_history(company_id, order_id, status_dimension, from_status, to_status, changed_by_account_id, occurred_at)
          values (${c.companyId}::uuid, ${bad.id}::uuid, 'delivery', 'new', 'out_for_delivery', ${c.actorId}::uuid, now())`.execute(
          tx,
        );
        expect((await validate(tx, c, good)).L1.severity).toBe("pass");
        expect((await validate(tx, c, bad)).L1.severity).toBe("fail");
      });
    });

    it("L2: a delivered Order needs a delivery date", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        expect(
          (await validate(tx, c, await order(tx, c, { number: 1, cod: 50 }))).L2.severity,
        ).toBe("pass");
        expect(
          (await validate(tx, c, await order(tx, c, { number: 2, cod: 50, deliveredAt: null }))).L2
            .severity,
        ).toBe("fail");
      });
    });

    it("L3: the assigned driver must match the open assignment", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        const driverId = randomUUID();
        await sql`insert into drivers(id, company_id, code, name_en, mobile_number, driver_type, outsourced_fee_per_delivered_order)
          values (${driverId}::uuid, ${c.companyId}::uuid, ${`DRV-${c.tag}`}, 'Driver', '971502222222', 'outsourced', 5)`.execute(
          tx,
        );
        const good = await order(tx, c, {
          number: 1,
          cod: 50,
          status: "out_for_delivery",
          assignedDriverId: driverId,
        });
        await sql`insert into order_assignments(company_id, order_id, driver_id, assigned_by_account_id)
          values (${c.companyId}::uuid, ${good.id}::uuid, ${driverId}::uuid, ${c.actorId}::uuid)`.execute(
          tx,
        );
        // No assignment row at all: the deferred consistency trigger never fires because the test rolls back.
        const bad = await order(tx, c, {
          number: 2,
          cod: 50,
          status: "out_for_delivery",
          assignedDriverId: driverId,
        });
        expect((await validate(tx, c, good)).L3.severity).toBe("pass");
        expect((await validate(tx, c, bad)).L3.severity).toBe("fail");
      });
    });

    it("F1: a stored amount that differs from the model fails", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        expect(
          (await validate(tx, c, await order(tx, c, { number: 1, cod: 193, fee: 18 }))).F1.severity,
        ).toBe("pass");
        const bad = await validate(
          tx,
          c,
          await order(tx, c, { number: 2, cod: 193, fee: 18, override: { company_revenue: 193 } }),
        );
        expect(bad.F1.severity).toBe("fail");
        expect(bad.F1.expected).toMatchObject({ companyRevenue: "18.00" });
      });
    });

    it("F2: status and paid amount must agree with the payable and effective settlements", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        const unsettledZero = await order(tx, c, {
          number: 1,
          cod: 0,
          settlementStatus: "unsettled",
        });
        expect((await validate(tx, c, unsettledZero)).F2.severity).toBe("fail");
        const paidWithoutSettlement = await order(tx, c, {
          number: 2,
          cod: 193,
          settlementStatus: "settled",
          traderPaidAmount: 175,
        });
        expect((await validate(tx, c, paidWithoutSettlement)).F2.severity).toBe("fail");

        const settled = await order(tx, c, { number: 3, cod: 193 });
        const settlementId = randomUUID();
        await sql`insert into trader_settlements(id, company_id, settlement_number, trader_id, business_date, gross_payable, net_payable, created_by_account_id)
          values (${settlementId}::uuid, ${c.companyId}::uuid, ${`SET-${c.tag}-1`}, ${c.traderId}::uuid, date '2026-10-02', 175, 175, ${c.actorId}::uuid)`.execute(
          tx,
        );
        await sql`insert into trader_settlement_orders(company_id, settlement_id, order_id, gross_payable, deductions_and_charges, adjustments, net_payable, allocated_amount)
          values (${c.companyId}::uuid, ${settlementId}::uuid, ${settled.id}::uuid, 193, 18, 0, 175, 175)`.execute(
          tx,
        );
        await sql`insert into trader_settlement_payments(company_id, settlement_id, payment_method, amount, created_by_account_id, payment_at)
          values (${c.companyId}::uuid, ${settlementId}::uuid, 'cash', 175, ${c.actorId}::uuid, now())`.execute(
          tx,
        );
        await sql`update trader_settlements set status = 'confirmed', confirmed_by_account_id = ${c.actorId}::uuid, confirmed_at = now()
          where id = ${settlementId}::uuid and company_id = ${c.companyId}::uuid`.execute(tx);
        await sql`update orders set trader_paid_amount = 175, trader_settlement_status = 'money_sent_to_trader'
          where id = ${settled.id}::uuid and company_id = ${c.companyId}::uuid`.execute(tx);
        const checks = await validate(tx, c, settled);
        expect(checks.F2.severity).toBe("pass");
        expect(checks.F2.refs).toContain(`SET-${c.tag}-1`);
      });
    });

    it("F3: a closed Order must have completed settlement", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        expect(
          (await validate(tx, c, await order(tx, c, { number: 1, cod: 0, status: "closed" }))).F3
            .severity,
        ).toBe("pass");
        expect(
          (await validate(tx, c, await order(tx, c, { number: 2, cod: 193, status: "closed" }))).F3
            .severity,
        ).toBe("fail");
      });
    });

    it("F4: Trader-pays-fee with its receivable collected passes; a wrong status fails; a missing receivable fails", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        const receivable = async (
          o: OrderFixture,
          number: string,
          collected: number,
          status: string,
        ) => {
          await sql`insert into trader_receivables(company_id, receivable_number, trader_id, source_type, source_reference,
              business_date, original_amount_due, amount_collected, status, reason, created_by_account_id)
            values (${c.companyId}::uuid, ${number}, ${c.traderId}::uuid, 'service_charge', ${o.orderNumber},
              date '2026-10-01', 18, ${collected}, ${status}, 'Service fee', ${c.actorId}::uuid)`.execute(
            tx,
          );
        };
        const collected = await order(tx, c, {
          number: 1,
          cod: 0,
          condition: "customer_pays_cod_trader_pays_fee",
        });
        await receivable(collected, `RCV-${c.tag}-72`, 18, "collected");
        const good = await validate(tx, c, collected);
        expect(good.F4.severity).toBe("pass");
        expect(good.F4.refs).toContain(`RCV-${c.tag}-72`);

        const wrongStatus = await order(tx, c, {
          number: 2,
          cod: 0,
          condition: "customer_pays_cod_trader_pays_fee",
        });
        await receivable(wrongStatus, `RCV-${c.tag}-73`, 18, "outstanding");
        expect((await validate(tx, c, wrongStatus)).F4.severity).toBe("fail");

        const missing = await order(tx, c, {
          number: 3,
          cod: 0,
          condition: "customer_pays_cod_trader_pays_fee",
        });
        expect((await validate(tx, c, missing)).F4.severity).toBe("fail");
      });
    });

    it("D1: the reconciliation line must equal the customer amount due", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        const driverId = randomUUID();
        await sql`insert into drivers(id, company_id, code, name_en, mobile_number, driver_type, outsourced_fee_per_delivered_order)
          values (${driverId}::uuid, ${c.companyId}::uuid, ${`DRV-${c.tag}`}, 'Driver', '971502222222', 'outsourced', 5)`.execute(
          tx,
        );
        const reconciled = async (number: number) => {
          const o = await order(tx, c, {
            number,
            cod: 193,
            status: "out_for_delivery",
            assignedDriverId: driverId,
          });
          await sql`insert into order_assignments(company_id, order_id, driver_id, assigned_by_account_id)
            values (${c.companyId}::uuid, ${o.id}::uuid, ${driverId}::uuid, ${c.actorId}::uuid)`.execute(
            tx,
          );
          await sql`update orders set delivery_status = 'delivered', delivered_at = '2026-10-01T10:00:00+04:00', driver_reconciliation_status = 'pending'
            where id = ${o.id}::uuid and company_id = ${c.companyId}::uuid`.execute(tx);
          await sql`insert into order_status_history(company_id, order_id, status_dimension, from_status, to_status, changed_by_account_id)
            values (${c.companyId}::uuid, ${o.id}::uuid, 'delivery', 'out_for_delivery', 'delivered', ${c.actorId}::uuid)`.execute(
            tx,
          );
          const reconciliationId = randomUUID();
          await sql`insert into driver_reconciliations(id, company_id, reconciliation_number, driver_id, business_date, gross_collections, net_amount_received, created_by_account_id)
            values (${reconciliationId}::uuid, ${c.companyId}::uuid, ${`REC-${c.tag}-${number}`}, ${driverId}::uuid, date '2026-10-01', 193, 193, ${c.actorId}::uuid)`.execute(
            tx,
          );
          await sql`insert into driver_reconciliation_orders(company_id, reconciliation_id, order_id, customer_collection_amount)
            values (${c.companyId}::uuid, ${reconciliationId}::uuid, ${o.id}::uuid, 193)`.execute(
            tx,
          );
          await sql`insert into driver_reconciliation_payments(company_id, reconciliation_id, payment_method, amount, created_by_account_id, payment_at)
            values (${c.companyId}::uuid, ${reconciliationId}::uuid, 'cash', 193, ${c.actorId}::uuid, now())`.execute(
            tx,
          );
          await sql`update driver_reconciliations set status = 'confirmed', confirmed_by_account_id = ${c.actorId}::uuid, confirmed_at = now()
            where id = ${reconciliationId}::uuid and company_id = ${c.companyId}::uuid`.execute(tx);
          await sql`update orders set driver_reconciliation_status = 'reconciled'
            where id = ${o.id}::uuid and company_id = ${c.companyId}::uuid`.execute(tx);
          return o;
        };
        const good = await reconciled(1);
        const goodChecks = await validate(tx, c, good);
        expect(goodChecks.D1.severity).toBe("pass");
        expect(goodChecks.D1.refs).toContain(`REC-${c.tag}-1`);

        const changed = await reconciled(2);
        // The Order's amount changed after the driver's cash was reconciled.
        await sql`update orders set cod_amount = 100, customer_amount_due = 100, trader_gross_payable = 100,
            trader_net_payable = 82, total_deductions = 18
          where id = ${changed.id}::uuid and company_id = ${c.companyId}::uuid`.execute(tx);
        expect((await validate(tx, c, changed)).D1.severity).toBe("fail");
      });
    });

    it("A1-A5 are info only when accounting capture is off", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx, { accounting: false });
        const checks = await validate(tx, c, await order(tx, c, { number: 1, cod: 193 }));
        for (const code of ["A1", "A2", "A3", "A4", "A5"] as const) {
          expect(checks[code].severity, code).toBe("info");
          expect(checks[code].stored).toBe("Accounting not enabled");
        }
      });
    });

    it("A2: a journal posted before the Order changed fails", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx, { accounting: true });
        // The Order now has the fixed values, but its only effective recognition still carries the original lines.
        const o = await order(tx, c, { number: 160, cod: 193, fee: 18 });
        const journalId = await journal(tx, c, `JRN-${c.tag}-310`, 193);
        await accountingEvent(tx, c, o, {
          type: "order_delivered",
          version: 1,
          status: "posted",
          journalId,
          components: ORIGINAL_160,
        });
        const checks = await validate(tx, c, o);
        expect(checks.A1.severity).toBe("pass");
        expect(checks.A2.severity).toBe("fail");
        expect(checks.A2.refs).toContain(`JRN-${c.tag}-310`);
      });
    });

    it("A3: a failed accounting event fails; none passes", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx, { accounting: true });
        const good = await ord160After(tx, c, 1, "R-1");
        const bad = await order(tx, c, { number: 2, cod: 193 });
        await accountingEvent(tx, c, bad, {
          type: "order_delivered",
          version: 1,
          status: "failed",
        });
        expect((await validate(tx, c, good)).A3.severity).toBe("pass");
        const checks = await validate(tx, c, bad);
        expect(checks.A3.severity).toBe("fail");
        expect(checks.A1.severity).toBe("fail");
      });
    });

    it("A5: the unmaintained accounting_status is info, never a failure", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx, { accounting: true });
        const checks = await validate(tx, c, await ord160After(tx, c, 1, "R-1"));
        expect(checks.A5.stored).toBe("unposted");
        expect(checks.A5.expected).toBe("posted");
        expect(checks.A5.severity).toBe("info");
        await sql`update orders set accounting_status = 'posted' where company_id = ${c.companyId}::uuid`.execute(
          tx,
        );
        const after = await sql<{
          id: string;
        }>`select id from orders where company_id = ${c.companyId}::uuid`.execute(tx);
        const o = { id: after.rows[0]!.id, orderNumber: "ORD-000001", version: 0 };
        expect((await validate(tx, c, o)).A5.severity).toBe("pass");
      });
    });

    it("V1: review level, strong level and pass", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        const review = await validate(
          tx,
          c,
          await order(tx, c, { number: 257, reference: "2372", cod: 0, fee: 18, additional: 10 }),
        );
        expect(review.V1.severity).toBe("warning");
        expect(review.V1.titleKey).toBe("platform.orderValidation.V1.title");
        const strong = await validate(
          tx,
          c,
          await order(tx, c, { number: 258, cod: 0, fee: 18, additional: 175 }),
        );
        expect(strong.V1.titleKey).toBe("platform.orderValidation.V1.strong.title");
        expect(
          (await validate(tx, c, await order(tx, c, { number: 259, cod: 193, fee: 18 }))).V1
            .severity,
        ).toBe("pass");
      });
    });

    it("V2: no warning without a COD removal, or when cash was collected", async () => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        expect(
          (
            await validate(
              tx,
              c,
              await order(tx, c, {
                number: 1,
                cod: 0,
                condition: "customer_pays_cod_trader_pays_fee",
              }),
            )
          ).V2.severity,
        ).toBe("pass");
        const collected = await order(tx, c, {
          number: 2,
          cod: 0,
          condition: "customer_pays_cod_trader_pays_fee",
          amountCollected: 18,
        });
        await codRemoved(tx, c, collected, "859.00");
        expect((await validate(tx, c, collected)).V2.severity).toBe("pass");
      });
    });
  });

  it("Company isolation: the same violations in Company B never reach Company A's results", async () => {
    await inRollback(async (tx) => {
      const a = await company(tx, { accounting: true });
      const b = await company(tx, { accounting: true });
      const seed = async (c: CompanyFixture) => {
        const before = await ord160Before(tx, c, 160, "1744");
        await codRemoved(tx, c, before, "859.00");
        await accountingEvent(tx, c, before, {
          type: "order_recognition_reversed",
          version: 1,
          status: "failed",
        });
        const settlementId = randomUUID();
        await sql`insert into trader_settlements(id, company_id, settlement_number, trader_id, business_date, gross_payable, net_payable, created_by_account_id)
          values (${settlementId}::uuid, ${c.companyId}::uuid, ${`SET-${c.tag}`}, ${c.traderId}::uuid, date '2026-10-02', 0, 0, ${c.actorId}::uuid)`.execute(
          tx,
        );
        await sql`insert into trader_receivables(company_id, receivable_number, trader_id, source_type, source_reference,
            business_date, original_amount_due, amount_collected, status, reason, created_by_account_id)
          values (${c.companyId}::uuid, ${`RCV-${c.tag}`}, ${c.traderId}::uuid, 'service_charge', 'ORD-000160',
            date '2026-10-01', 18, 0, 'outstanding', 'Service fee', ${c.actorId}::uuid)`.execute(
          tx,
        );
        await recognitionGap(tx, c, 400);
        return before;
      };
      const orderA = await seed(a);
      const orderB = await seed(b);
      // B's Order shares A's id space only by number and reference; give B more history on the same number too.
      await sql`insert into order_status_history(company_id, order_id, status_dimension, from_status, to_status, changed_by_account_id)
        values (${b.companyId}::uuid, ${orderB.id}::uuid, 'delivery', 'closed', 'delivered', ${b.actorId}::uuid)`.execute(
        tx,
      );

      const resultA = await validate(tx, a, orderA);
      const all = JSON.stringify(Object.values(resultA));
      expect(all).not.toContain(b.tag);
      expect(all).not.toContain(orderB.id);
      for (const check of Object.values(resultA)) {
        for (const ref of check.refs)
          expect(ref.includes(b.tag), `${check.code} ${ref}`).toBe(false);
      }
      // A's own violations are still found (so the absence of B is not an empty result).
      expect(resultA.V1.severity).toBe("warning");
      expect(resultA.V2.severity).toBe("warning");
      expect(resultA.A3.severity).toBe("fail");
      expect(resultA.A1.refs).toContain(`JRN-${a.tag}-310`);
      // Validating A's Order under B's route Company is refused, not answered.
      const service = new OrderValidationService(tx as unknown as Kysely<DatabaseSchema>);
      const crossed = await service
        .validate(b.companyId, orderA.id, orderA.version)
        .catch((caught: unknown) => caught);
      expect((crossed as ApplicationException).errorCode).toBe("order_not_found");
    });
  });

  it("is read-only: row counts are unchanged after lookup and every validation", async () => {
    await inRollback(async (tx) => {
      const c = await company(tx, { accounting: true });
      const orders = [
        await ord160Before(tx, c, 160, "1744"),
        await ord160After(tx, c, 161, "1745"),
        await recognitionGap(tx, c, 162),
        await order(tx, c, { number: 163, cod: 0, condition: "customer_pays_cod_trader_pays_fee" }),
      ];
      const before = await rowCounts(tx);
      const versions = await Promise.all(orders.map((o) => version(tx, c.companyId, o.id)));
      const lookup = new OrderValidationLookup(tx as unknown as Kysely<DatabaseSchema>);
      await lookup.resolve(c.companyId, "1744");
      for (const o of orders) await validate(tx, c, o);
      expect(await rowCounts(tx)).toEqual(before);
      expect(await Promise.all(orders.map((o) => version(tx, c.companyId, o.id)))).toEqual(
        versions,
      );
    });
  });

  it("HTTP: Platform routes return the result; missing permission is 403; a company_user is rejected", async () => {
    let app: INestApplication | undefined;
    await inRollback(async (tx) => {
      const c = await company(tx, { accounting: true });
      const target = await ord160Before(tx, c, 160, "1744");
      const hash = await new PasswordHasher().hash("order-validation-password");
      const suffix = randomUUID().slice(0, 8);
      const reader = randomUUID();
      const noPermission = randomUUID();
      await sql`insert into accounts(id, company_id, account_kind, username, password_hash, status, password_changed_at)
        values (${reader}::uuid, null, 'platform_administrator', ${`ov.rdr.${suffix}`}, ${hash}, 'active', now()),
               (${noPermission}::uuid, null, 'platform_administrator', ${`ov.np.${suffix}`}, ${hash}, 'active', now())`.execute(
        tx,
      );
      const readRole = randomUUID();
      const accessRole = randomUUID();
      await sql`insert into roles(id, company_id, code, name, is_system)
        values (${readRole}::uuid, null, ${`ov_reader_${suffix}`}, ${`OV Reader ${suffix}`}, false),
               (${accessRole}::uuid, null, ${`ov_access_${suffix}`}, ${`OV Access ${suffix}`}, false)`.execute(
        tx,
      );
      await sql`insert into role_permissions(role_id, permission_code) values
          (${readRole}::uuid, 'platform.access'), (${readRole}::uuid, 'platform.integrity.read'),
          (${accessRole}::uuid, 'platform.access'), (${accessRole}::uuid, 'platform.companies.read')`.execute(
        tx,
      );
      await sql`insert into account_roles(account_id, role_id, company_id)
        values (${reader}::uuid, ${readRole}::uuid, null), (${noPermission}::uuid, ${accessRole}::uuid, null)`.execute(
        tx,
      );
      // A Company user holding every Company permission still cannot reach a Platform route.
      const companyUser = randomUUID();
      const subdomain = `ov-${suffix}`;
      await sql`update companies set subdomain = ${subdomain} where id = ${c.companyId}::uuid`.execute(
        tx,
      );
      await sql`insert into accounts(id, company_id, account_kind, username, password_hash, status, password_changed_at)
        values (${companyUser}::uuid, ${c.companyId}::uuid, 'company_user', ${`ov.cu.${suffix}`}, ${hash}, 'active', now())`.execute(
        tx,
      );
      await sql`insert into company_users(company_id, account_id, display_name, name_en)
        values (${c.companyId}::uuid, ${companyUser}::uuid, 'Company User', 'Company User')`.execute(
        tx,
      );
      const companyRole = randomUUID();
      await sql`insert into roles(id, company_id, code, name, is_system)
        values (${companyRole}::uuid, ${c.companyId}::uuid, 'ov_admin', 'OV Admin', true)`.execute(
        tx,
      );
      await sql`insert into role_permissions(role_id, permission_code) select ${companyRole}::uuid, code from permissions where code not like 'platform.%'`.execute(
        tx,
      );
      await sql`insert into account_roles(account_id, role_id, company_id) values (${companyUser}::uuid, ${companyRole}::uuid, ${c.companyId}::uuid)`.execute(
        tx,
      );

      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DATABASE)
        .useValue(tx)
        .overrideProvider(CompanyHostResolver)
        .useValue({
          resolve: (host: string | undefined) => host?.split(".")[0],
          isReservedHost: () => false,
        })
        .compile();
      app = module.createNestApplication();
      app.setGlobalPrefix("api/v1");
      app.useGlobalPipes(
        new ValidationPipe({ forbidNonWhitelisted: true, transform: true, whitelist: true }),
      );
      app.useGlobalFilters(new ApiExceptionFilter(app.get(Logger)));
      await app.init();
      const server = app.getHttpServer();
      const platformCookie = async (username: string) => {
        const response = await request(server)
          .post("/api/v1/platform/auth/login")
          .send({ identifier: username, password: "order-validation-password" })
          .expect(200);
        return (response.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
      };
      const base = `/api/v1/platform/companies/${c.companyId}/repair-center/orders`;
      const readerCookie = await platformCookie(`ov.rdr.${suffix}`);

      const found = await request(server)
        .get(`${base}/lookup`)
        .query({ q: "1744" })
        .set("Cookie", readerCookie)
        .expect(200);
      expect(found.body).toMatchObject({
        orderId: target.id,
        orderNumber: "ORD-000160",
        version: target.version,
      });
      const validated = await request(server)
        .get(`${base}/${target.id}/validation`)
        .query({ version: target.version })
        .set("Cookie", readerCookie)
        .expect(200);
      expect(validated.body.checks).toHaveLength(15);
      expect(
        validated.body.checks.find((check: { code: string }) => check.code === "V1").severity,
      ).toBe("warning");

      const ambiguous = await request(server)
        .get(`${base}/lookup`)
        .query({ q: "1744,2416" })
        .set("Cookie", readerCookie)
        .expect(400);
      expect(ambiguous.body.error.code).toBe("order_lookup_invalid");
      const missing = await request(server)
        .get(`${base}/lookup`)
        .query({ q: "2465" })
        .set("Cookie", readerCookie)
        .expect(404);
      expect(missing.body.error.code).toBe("order_not_found");
      const extra = await request(server)
        .get(`${base}/lookup`)
        .query({ q: "1744", companyId: randomUUID() })
        .set("Cookie", readerCookie);
      expect(extra.status).toBe(400);

      const noPermissionCookie = await platformCookie(`ov.np.${suffix}`);
      await request(server)
        .get(`${base}/lookup`)
        .query({ q: "1744" })
        .set("Cookie", noPermissionCookie)
        .expect(403);
      await request(server)
        .get(`${base}/${target.id}/validation`)
        .query({ version: target.version })
        .set("Cookie", noPermissionCookie)
        .expect(403);

      const companyLogin = await request(server)
        .post("/api/v1/auth/login")
        .set("Host", `${subdomain}.blueline.test`)
        .send({ identifier: `ov.cu.${suffix}`, password: "order-validation-password" })
        .expect(200);
      const token = String(companyLogin.body.accessToken);
      const asCompany = await request(server)
        .get(`${base}/lookup`)
        .query({ q: "1744" })
        .set("Host", `${subdomain}.blueline.test`)
        .set("Authorization", `Bearer ${token}`);
      expect([401, 403]).toContain(asCompany.status);

      await request(server).get(`${base}/lookup`).query({ q: "1744" }).expect(401);
      await app.close();
      app = undefined;
    }).finally(async () => {
      await app?.close();
    });
  });
});
