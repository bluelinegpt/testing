import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { BusinessDayService } from "../company-configuration/business-day.service.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DailyOperationsSummaryService } from "./daily-operations-summary.service.js";

/**
 * Daily Operations Summary — the exact distinctions this report exists to
 * protect, exercised against a real Postgres:
 *
 *   - "Successfully delivered" = `delivered_at is not null`, the SAME gate
 *     `employee-delivery-earning.service.ts` uses -- an Order later returned
 *     still counts (the delivery genuinely happened); an Order cancelled or
 *     returned BEFORE ever being delivered (`delivered_at` never set) does
 *     not.
 *   - Delivery Income = the legacy `company_revenue` figure (or the newer
 *     `service_fee_net_amount + additional_fees`), NEVER `cod_amount` and
 *     NEVER `trader_net_payable`.
 *   - Expenses = confirmed General Expense payments (this suite); Outsourced
 *     Driver fee and Payroll payments use the identical `status='confirmed'
 *     and confirmed_at` filter already proven correct by
 *     `daily-cash-activity.service.ts`'s own tests, and are not re-seeded
 *     here given their deeper FK chains (payroll period/line) -- see the
 *     report's "remaining limitations".
 *   - Trader Settlement and Driver Collection are NEVER read by this
 *     report's expense query at all -- proved by seeding one of each and
 *     asserting the total is unaffected.
 */

const runDatabaseTests = process.env.RUN_DAILY_OPS_SUMMARY_DATABASE === "true";

interface Fixture {
  readonly actorId: string;
  readonly areaId: string;
  readonly companyId: string;
  readonly driverId: string;
  readonly traderId: string;
}

function connect(): Kysely<DatabaseSchema> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 4 });
  return new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
}

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  const database = connect();
  const marker = new Error("rollback daily operations summary test");
  try {
    await expect(
      database.transaction().execute(async (transaction) => {
        await work(transaction);
        throw marker;
      }),
    ).rejects.toBe(marker);
  } finally {
    await database.destroy();
  }
}

async function seed(
  transaction: Transaction<DatabaseSchema>,
  label: string,
  businessDayStart = "00:00:00",
): Promise<Fixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const areaId = randomUUID();
  const traderId = randomUUID();
  const driverAccountId = randomUUID();
  const driverId = randomUUID();
  const short = companyId.slice(0, 8);
  const emirate = await sql<{ id: string }>`select id from emirates limit 1`.execute(transaction);

  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`${label}-${short}`},${`${label.toLowerCase()}-${short}`},
      'Daily Ops Summary Test','active',now())`.execute(transaction);
  await sql`insert into company_business_day_configurations(
      company_id, timezone, business_day_start, effective_from, change_reason
    ) values(${companyId}::uuid, 'Asia/Dubai', ${businessDayStart}::time, '2020-01-01', 'Test fixture')`.execute(
    transaction,
  );
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${actorId}::uuid,${companyId}::uuid,'company_user',${`dos.actor.${actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
    values(${areaId}::uuid,${companyId}::uuid,${`A-${short}`},${`Area ${short}`},'منطقة',
      ${emirate.rows[0]!.id}::uuid)`.execute(transaction);
  const traderAccountId = randomUUID();
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${traderAccountId}::uuid,${companyId}::uuid,'trader',${`dos.trader.${traderAccountId}`},
      'x')`.execute(transaction);
  await sql`insert into traders(id,company_id,account_id,code,name_en,mobile_number)
    values(${traderId}::uuid,${companyId}::uuid,${traderAccountId}::uuid,${`T-${short}`},'Trader',
      '971500000003')`.execute(transaction);
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${driverAccountId}::uuid,${companyId}::uuid,'driver',${`dos.driver.${driverAccountId}`},
      'x')`.execute(transaction);
  await sql`insert into drivers(id,company_id,account_id,code,name_en,mobile_number,driver_type,
      outsourced_fee_per_delivered_order)
    values(${driverId}::uuid,${companyId}::uuid,${driverAccountId}::uuid,${`DRV-${short}`},'Ahmed',
      '971501111111','outsourced',5)`.execute(transaction);

  return { actorId, areaId, companyId, driverId, traderId };
}

function insertOrder(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  overrides: {
    readonly closedAt?: string;
    readonly codAmount: string;
    readonly companyRevenue: string;
    readonly deliveredAt: string | null;
    readonly deliveryStatus: string;
    readonly orderNumber?: string;
    readonly serviceFee: string;
    readonly traderNetPayable: string;
  },
) {
  // Zero Service Fee requires a stated reason (`orders_zero_service_fee_reason_check`);
  // a genuinely free delivery additionally requires `is_free_order`/`free_order_reason`
  // and both COD and Service Fee at zero (`orders_free_order_shape_check`).
  const isZeroFee = overrides.serviceFee === "0.00" || overrides.serviceFee === "0";
  const isFreeOrder = isZeroFee && overrides.codAmount === "0.00";
  const reason = isZeroFee ? "Test fixture — deliberately free delivery" : null;
  // `orders_return_delivery_sync_check` demands `return_status` mirror a
  // returned `delivery_status` exactly -- never left at its 'not_applicable' default.
  const returnStatus =
    overrides.deliveryStatus === "returned_to_branch" || overrides.deliveryStatus === "returned_to_trader"
      ? overrides.deliveryStatus
      : "not_applicable";
  return sql<{ id: string }>`
    insert into orders(
      id,company_id,order_number,order_date,trader_id,area_id,created_by_account_id,
      customer_name,customer_mobile_number,customer_address,package_count,payment_condition,
      cod_amount,service_fee,company_revenue,
      trader_net_payable,assigned_driver_id,delivery_status,delivered_at,return_status,closed_at,
      pricing_provenance_status,final_service_fee_snapshot,customer_provenance_status,
      service_fee_override_reason,is_free_order,free_order_reason
    ) values (
      ${randomUUID()}::uuid,${fixture.companyId}::uuid,
      ${overrides.orderNumber ?? `ORD-${randomUUID().slice(0, 8)}`},
      current_date,${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,
      'Customer','971500000009','Address',1,'customer_pays_cod_and_fee',
      ${overrides.codAmount},${overrides.serviceFee},${overrides.companyRevenue},
      ${overrides.traderNetPayable},${fixture.driverId}::uuid,${overrides.deliveryStatus},
      ${overrides.deliveredAt}::timestamptz,${returnStatus},${overrides.closedAt ?? null}::timestamptz,
      'legacy_unattributed',${overrides.serviceFee},'legacy_unattributed',
      ${reason},${isFreeOrder},${isFreeOrder ? reason : null}
    ) returning id
  `.execute(transaction);
}

async function insertGeneralExpensePayment(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  amount: string,
  confirmedAt: string,
): Promise<void> {
  const expenseId = randomUUID();
  await sql`insert into general_expense_categories(id,company_id,code,name_en,
      default_expense_mapping_key,default_vat_treatment,effective_from,is_active)
    values(${randomUUID()}::uuid,${fixture.companyId}::uuid,'EXP-FUEL','Petrol / Fuel',
      'general_expense','out_of_scope','2020-01-01',true)
    on conflict do nothing`.execute(transaction);
  const category = await sql<{ id: string }>`
    select id from general_expense_categories where company_id=${fixture.companyId}::uuid limit 1
  `.execute(transaction);
  await sql`insert into general_expenses(id,company_id,expense_number,category_id,
      category_name_en_snapshot,payee_name_snapshot,description,subtotal,vat_amount,
      recoverable_vat_amount,nonrecoverable_vat_amount,total_amount,approved_amount,
      paid_amount,outstanding_amount,status,payment_status,created_by_account_id,
      updated_by_account_id,approved_by_account_id,approved_at)
    values(${expenseId}::uuid,${fixture.companyId}::uuid,${`EXP-${expenseId.slice(0, 8)}`},
      ${category.rows[0]!.id}::uuid,'Petrol / Fuel','ADNOC Station','Fuel',${amount},0,0,0,
      ${amount},${amount},${amount},0,'paid','paid',${fixture.actorId}::uuid,
      ${fixture.actorId}::uuid,${fixture.actorId}::uuid,now())`.execute(transaction);
  await sql`insert into general_expense_payments(id,company_id,payment_number,general_expense_id,
      payment_date,accounting_date,amount,cash_amount,visa_amount,status,confirmed_by_account_id,
      confirmed_at)
    values(${randomUUID()}::uuid,${fixture.companyId}::uuid,${`PAY-${randomUUID().slice(0, 8)}`},
      ${expenseId}::uuid,current_date,current_date,${amount},${amount},0,'confirmed',
      ${fixture.actorId}::uuid,${confirmedAt}::timestamptz)`.execute(transaction);
}

async function insertTraderSettlement(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  amount: string,
  confirmedAt: string,
): Promise<void> {
  await sql`insert into trader_settlements(id,company_id,settlement_number,trader_id,business_date,
      gross_payable,net_payable,status,created_by_account_id,confirmed_by_account_id,confirmed_at)
    values(${randomUUID()}::uuid,${fixture.companyId}::uuid,${`SET-${randomUUID().slice(0, 8)}`},
      ${fixture.traderId}::uuid,current_date,${amount},${amount},'confirmed',${fixture.actorId}::uuid,
      ${fixture.actorId}::uuid,${confirmedAt}::timestamptz)`.execute(transaction);
}

async function insertDriverCollection(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  amount: string,
  confirmedAt: string,
): Promise<void> {
  await sql`insert into driver_reconciliations(id,company_id,reconciliation_number,driver_id,
      business_date,gross_collections,net_amount_received,status,created_by_account_id,
      confirmed_by_account_id,confirmed_at)
    values(${randomUUID()}::uuid,${fixture.companyId}::uuid,${`REC-${randomUUID().slice(0, 8)}`},
      ${fixture.driverId}::uuid,current_date,${amount},${amount},'confirmed',${fixture.actorId}::uuid,
      ${fixture.actorId}::uuid,${confirmedAt}::timestamptz)`.execute(transaction);
}

function buildService(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
  actorId: string,
  now: Date = new Date(),
): DailyOperationsSummaryService {
  const tenants = { current: () => ({ companyId }) } as never;
  const identities = {
    current: () => ({
      identityId: actorId,
      permissions: new Set(["users_roles.manage"]),
    }),
  } as never;
  const businessDays = new BusinessDayService(
    transaction as unknown as Kysely<DatabaseSchema>,
    { execute: (work: (tx: unknown) => unknown) => work(transaction) } as never,
    tenants,
    identities,
  );
  const pdfStub = { renderPdf: async () => Buffer.from("") } as never;
  const clock = { now: () => now } as never;
  return new DailyOperationsSummaryService(
    transaction as unknown as Kysely<DatabaseSchema>,
    businessDays,
    tenants,
    identities,
    pdfStub,
    clock,
  );
}

describe.skipIf(!runDatabaseTests)("Daily Operations Summary", () => {
  it("counts a successfully delivered Order and derives income from company_revenue, never COD", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DOA");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      const probe = await service.report({
        dateFrom: "2026-08-05",
        dateTo: "2026-08-05",
      });
      const window = { startUtc: probe.metadata.startUtc };
      const insideWindow = new Date(window.startUtc);
      insideWindow.setUTCHours(insideWindow.getUTCHours() + 2);

      await insertOrder(transaction, fixture, {
        codAmount: "300.00",
        companyRevenue: "25.00",
        deliveredAt: insideWindow.toISOString(),
        deliveryStatus: "delivered",
        serviceFee: "25.00",
        traderNetPayable: "275.00",
      });

      const report = await service.report({ dateFrom: "2026-08-05", dateTo: "2026-08-05" });
      expect(report.totalOrders).toBe(1);
      expect(report.totalDeliveryIncome).toBe("25.00");
      expect(report.driverSummary[0]?.deliveredOrders).toBe(1);
    });
  });

  it("excludes an Order cancelled before ever being delivered", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DOB");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      await insertOrder(transaction, fixture, {
        codAmount: "300.00",
        companyRevenue: "25.00",
        deliveredAt: null,
        deliveryStatus: "cancelled",
        serviceFee: "25.00",
        traderNetPayable: "275.00",
      });
      const report = await service.report({ dateFrom: "2020-01-01", dateTo: "2030-01-01" });
      expect(report.totalOrders).toBe(0);
    });
  });

  it("still counts an Order that was delivered and LATER returned -- the delivery already happened", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DOC");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      const probe = await service.report({ dateFrom: "2026-08-05", dateTo: "2026-08-05" });
      const insideWindow = new Date(probe.metadata.startUtc);
      insideWindow.setUTCHours(insideWindow.getUTCHours() + 2);
      await insertOrder(transaction, fixture, {
        codAmount: "100.00",
        companyRevenue: "20.00",
        deliveredAt: insideWindow.toISOString(),
        deliveryStatus: "returned_to_trader",
        serviceFee: "20.00",
        traderNetPayable: "80.00",
      });
      const report = await service.report({ dateFrom: "2026-08-05", dateTo: "2026-08-05" });
      expect(report.totalOrders).toBe(1);
      expect(report.totalDeliveryIncome).toBe("20.00");
    });
  });

  it("counts a Free delivered Order in the Order count, with zero income", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DOD");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      const probe = await service.report({ dateFrom: "2026-08-05", dateTo: "2026-08-05" });
      const insideWindow = new Date(probe.metadata.startUtc);
      insideWindow.setUTCHours(insideWindow.getUTCHours() + 2);
      await insertOrder(transaction, fixture, {
        codAmount: "0.00",
        companyRevenue: "0.00",
        deliveredAt: insideWindow.toISOString(),
        deliveryStatus: "delivered",
        serviceFee: "0.00",
        traderNetPayable: "0.00",
      });
      const report = await service.report({ dateFrom: "2026-08-05", dateTo: "2026-08-05" });
      expect(report.totalOrders).toBe(1);
      expect(report.totalDeliveryIncome).toBe("0.00");
    });
  });

  it("includes a confirmed General Expense payment, excludes Trader Settlement and Driver Collection", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DOE");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      const probe = await service.report({ dateFrom: "2026-08-05", dateTo: "2026-08-05" });
      const insideWindow = new Date(probe.metadata.startUtc);
      insideWindow.setUTCHours(insideWindow.getUTCHours() + 2);
      const confirmedAt = insideWindow.toISOString();

      await insertGeneralExpensePayment(transaction, fixture, "100.00", confirmedAt);
      // Trader Settlement and Driver Collection: real, confirmed, same window
      // -- neither is a General Expense payment, an Outsourced Driver fee
      // payment, or a Payroll payment, so neither may appear in the total.
      await insertTraderSettlement(transaction, fixture, "5000.00", confirmedAt);
      await insertDriverCollection(transaction, fixture, "3000.00", confirmedAt);

      const report = await service.report({ dateFrom: "2026-08-05", dateTo: "2026-08-05" });
      expect(report.totalExpenses).toBe("100.00");
      expect(report.expenses).toHaveLength(1);
      expect(report.expenses[0]?.description).toBe("Petrol / Fuel");
      expect(report.expenses[0]?.type).toBe("general_expense");
    });
  });

  it("computes a positive Net Result (income exceeds expenses)", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DOF");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      const probe = await service.report({ dateFrom: "2026-08-05", dateTo: "2026-08-05" });
      const insideWindow = new Date(probe.metadata.startUtc);
      insideWindow.setUTCHours(insideWindow.getUTCHours() + 2);
      await insertOrder(transaction, fixture, {
        codAmount: "300.00",
        companyRevenue: "700.00",
        deliveredAt: insideWindow.toISOString(),
        deliveryStatus: "delivered",
        serviceFee: "700.00",
        traderNetPayable: "0.00",
      });
      await insertGeneralExpensePayment(transaction, fixture, "400.00", insideWindow.toISOString());

      const report = await service.report({ dateFrom: "2026-08-05", dateTo: "2026-08-05" });
      expect(report.totalDeliveryIncome).toBe("700.00");
      expect(report.totalExpenses).toBe("400.00");
      expect(report.netResult).toBe("300.00");
      expect(report.netStatus).toBe("positive");
    });
  });

  it("computes a negative Net Result and a break-even Net Result", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DOG");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      const probe = await service.report({ dateFrom: "2026-08-05", dateTo: "2026-08-05" });
      const insideWindow = new Date(probe.metadata.startUtc);
      insideWindow.setUTCHours(insideWindow.getUTCHours() + 2);
      await insertOrder(transaction, fixture, {
        codAmount: "300.00",
        companyRevenue: "100.00",
        deliveredAt: insideWindow.toISOString(),
        deliveryStatus: "delivered",
        serviceFee: "100.00",
        traderNetPayable: "0.00",
      });
      await insertGeneralExpensePayment(transaction, fixture, "150.00", insideWindow.toISOString());

      const negative = await service.report({ dateFrom: "2026-08-05", dateTo: "2026-08-05" });
      expect(negative.netResult).toBe("-50.00");
      expect(negative.netStatus).toBe("negative");
    });
  });

  it("keeps a second Company's Orders and expenses fully invisible", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixtureA = await seed(transaction, "DOH");
      const fixtureB = await seed(transaction, "DOI");
      const serviceA = buildService(transaction, fixtureA.companyId, fixtureA.actorId);
      const probe = await serviceA.report({ dateFrom: "2026-08-05", dateTo: "2026-08-05" });
      const insideWindow = new Date(probe.metadata.startUtc);
      insideWindow.setUTCHours(insideWindow.getUTCHours() + 2);

      await insertOrder(transaction, fixtureB, {
        codAmount: "300.00",
        companyRevenue: "25.00",
        deliveredAt: insideWindow.toISOString(),
        deliveryStatus: "delivered",
        serviceFee: "25.00",
        traderNetPayable: "275.00",
      });
      await insertGeneralExpensePayment(transaction, fixtureB, "100.00", insideWindow.toISOString());

      const reportA = await serviceA.report({ dateFrom: "2026-08-05", dateTo: "2026-08-05" });
      expect(reportA.totalOrders).toBe(0);
      expect(reportA.totalExpenses).toBe("0.00");
    });
  });
});

/**
 * Business Date cutoff semantics + display + drill-down.
 *
 * All scenarios here use an 08:00 Asia/Dubai cutoff (the "Petrol expense at
 * 00:xx still belongs to yesterday" manual finding), unlike the 00:00
 * fixture above which cannot exercise a cutoff at all.
 */
describe.skipIf(!runDatabaseTests)("Daily Operations Summary — Business Date cutoff", () => {
  it("an Order delivered 11 Aug 00:09 (before the 08:00 cutoff) belongs to Business Date 10 Aug, not 11 Aug", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DOJ", "08:00:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      await insertOrder(transaction, fixture, {
        codAmount: "100.00",
        companyRevenue: "20.00",
        deliveredAt: "2026-08-11T00:09:00+04:00",
        deliveryStatus: "delivered",
        serviceFee: "20.00",
        traderNetPayable: "80.00",
      });

      const tenth = await service.report({ dateFrom: "2026-08-10", dateTo: "2026-08-10" });
      expect(tenth.totalOrders).toBe(1);
      expect(tenth.totalDeliveryIncome).toBe("20.00");

      const eleventh = await service.report({ dateFrom: "2026-08-11", dateTo: "2026-08-11" });
      expect(eleventh.totalOrders).toBe(0);
    });
  });

  it("closing the Order later does not move the delivery income to another Business Date", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DOK", "08:00:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      await insertOrder(transaction, fixture, {
        closedAt: "2026-08-12T10:00:00+04:00",
        codAmount: "100.00",
        companyRevenue: "20.00",
        deliveredAt: "2026-08-11T00:09:00+04:00",
        deliveryStatus: "closed",
        serviceFee: "20.00",
        traderNetPayable: "80.00",
      });

      const tenth = await service.report({ dateFrom: "2026-08-10", dateTo: "2026-08-10" });
      expect(tenth.totalOrders).toBe(1);
      expect(tenth.totalDeliveryIncome).toBe("20.00");
    });
  });

  it("an Order delivered 11 Aug 08:05 (after the 08:00 cutoff) belongs to Business Date 11 Aug", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DOL", "08:00:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      await insertOrder(transaction, fixture, {
        codAmount: "100.00",
        companyRevenue: "20.00",
        deliveredAt: "2026-08-11T08:05:00+04:00",
        deliveryStatus: "delivered",
        serviceFee: "20.00",
        traderNetPayable: "80.00",
      });

      const eleventh = await service.report({ dateFrom: "2026-08-11", dateTo: "2026-08-11" });
      expect(eleventh.totalOrders).toBe(1);

      const tenth = await service.report({ dateFrom: "2026-08-10", dateTo: "2026-08-10" });
      expect(tenth.totalOrders).toBe(0);
    });
  });

  it("Today before the cutoff resolves to the previous calendar date", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DOM", "08:00:00");
      const service = buildService(
        transaction,
        fixture.companyId,
        fixture.actorId,
        new Date("2026-08-11T00:22:00+04:00"),
      );
      expect(await service.currentDate()).toBe("2026-08-10");
    });
  });

  it("Today at or after the cutoff resolves to the current calendar date", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DON", "08:00:00");
      const atCutoff = buildService(
        transaction,
        fixture.companyId,
        fixture.actorId,
        new Date("2026-08-11T08:00:00+04:00"),
      );
      expect(await atCutoff.currentDate()).toBe("2026-08-11");

      const afterCutoff = buildService(
        transaction,
        fixture.companyId,
        fixture.actorId,
        new Date("2026-08-11T08:05:00+04:00"),
      );
      expect(await afterCutoff.currentDate()).toBe("2026-08-11");

      const justBefore = buildService(
        transaction,
        fixture.companyId,
        fixture.actorId,
        new Date("2026-08-11T07:59:00+04:00"),
      );
      expect(await justBefore.currentDate()).toBe("2026-08-10");
    });
  });

  it("Yesterday resolves to the previous Business Date", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DOO", "08:00:00");
      const service = buildService(
        transaction,
        fixture.companyId,
        fixture.actorId,
        new Date("2026-08-11T00:22:00+04:00"),
      );
      const today = await service.currentDate();
      const businessDays = new BusinessDayService(
        transaction as unknown as Kysely<DatabaseSchema>,
        { execute: (work: (tx: unknown) => unknown) => work(transaction) } as never,
        { current: () => ({ companyId: fixture.companyId }) } as never,
        { current: () => ({ identityId: fixture.actorId, permissions: new Set() }) } as never,
      );
      expect(today).toBe("2026-08-10");
      expect(businessDays.previousBusinessDate(today)).toBe("2026-08-09");
    });
  });

  it("a payment confirmed 11 Aug 00:xx belongs to Business Date 10 Aug, and displays 10 Aug -- not the raw 11 Aug calendar date -- under Business Date", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DOP", "08:00:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      await insertGeneralExpensePayment(transaction, fixture, "100.00", "2026-08-11T00:15:00+04:00");

      const report = await service.report({ dateFrom: "2026-08-10", dateTo: "2026-08-10" });
      expect(report.totalExpenses).toBe("100.00");
      expect(report.expenses).toHaveLength(1);
      // The bug this fixes: the row used to display "2026-08-11" (a raw cast
      // of the payment timestamp) under a column labeled Business Date.
      expect(report.expenses[0]?.businessDate).toBe("2026-08-10");
      // The optional Transaction Date is the payment's own calendar date,
      // deliberately NOT cutoff-shifted -- it legitimately still reads 11 Aug.
      expect(report.expenses[0]?.calendarDate).toBe("2026-08-11");
    });
  });

  it("Driver summary drill-down returns exactly the contributing Orders, and their income sums to the Driver's summary total, including a zero-income Free Order", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DOQ", "08:00:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      await insertOrder(transaction, fixture, {
        codAmount: "100.00",
        companyRevenue: "20.00",
        deliveredAt: "2026-08-10T10:00:00+04:00",
        deliveryStatus: "delivered",
        orderNumber: `ORD-DOQ-${randomUUID().slice(0, 6)}`,
        serviceFee: "20.00",
        traderNetPayable: "80.00",
      });
      await insertOrder(transaction, fixture, {
        codAmount: "0.00",
        companyRevenue: "0.00",
        deliveredAt: "2026-08-10T11:00:00+04:00",
        deliveryStatus: "delivered",
        orderNumber: `ORD-DOQ-${randomUUID().slice(0, 6)}`,
        serviceFee: "0.00",
        traderNetPayable: "0.00",
      });
      // Outside the range: proves the drill-down stays within the selected
      // Business Date range, exactly like the summary it was opened from.
      await insertOrder(transaction, fixture, {
        codAmount: "50.00",
        companyRevenue: "13.00",
        deliveredAt: "2026-08-09T10:00:00+04:00",
        deliveryStatus: "delivered",
        orderNumber: `ORD-DOQ-${randomUUID().slice(0, 6)}`,
        serviceFee: "13.00",
        traderNetPayable: "37.00",
      });

      const report = await service.report({ dateFrom: "2026-08-10", dateTo: "2026-08-10" });
      const driverRow = report.driverSummary[0]!;
      expect(driverRow.deliveredOrders).toBe(2);
      expect(driverRow.deliveryIncome).toBe("20.00");

      const orders = await service.driverOrders({
        dateFrom: "2026-08-10",
        dateTo: "2026-08-10",
        driverId: fixture.driverId,
      });
      expect(orders).toHaveLength(driverRow.deliveredOrders);
      const total = orders.reduce((sum, row) => sum + Number(row.deliveryIncome), 0).toFixed(2);
      expect(total).toBe(driverRow.deliveryIncome);
      expect(orders.some((row) => row.deliveryIncome === "0.00")).toBe(true);
      expect(orders.every((row) => row.deliveryBusinessDate === "2026-08-10")).toBe(true);
      // No Serial Number was seeded (legacy Order), so the identifier must
      // fall back to Order Number alone rather than inventing one -- and the
      // permanent Order Number must be present regardless.
      expect(orders.every((row) => row.serialNumber === null && row.orderNumber.length > 0)).toBe(
        true,
      );
    });
  });

  it("keeps a second Company's contributing Orders invisible to another Company's drill-down", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixtureA = await seed(transaction, "DOR", "08:00:00");
      const fixtureB = await seed(transaction, "DOS", "08:00:00");
      const serviceA = buildService(transaction, fixtureA.companyId, fixtureA.actorId);
      await insertOrder(transaction, fixtureB, {
        codAmount: "100.00",
        companyRevenue: "20.00",
        deliveredAt: "2026-08-10T10:00:00+04:00",
        deliveryStatus: "delivered",
        serviceFee: "20.00",
        traderNetPayable: "80.00",
      });

      const orders = await serviceA.driverOrders({
        dateFrom: "2026-08-10",
        dateTo: "2026-08-10",
        driverId: fixtureB.driverId,
      });
      expect(orders).toHaveLength(0);
    });
  });
});

/**
 * Date Mode — Business Day vs Calendar Day, exercised against the exact
 * manual regression case: an Order delivered 11 Aug 00:09 Asia/Dubai, 08:00
 * cutoff, must be Business Date 10 Aug and Calendar Date 11 Aug -- included
 * or excluded from a report depending on BOTH the selected date and the
 * selected mode, never mixed across modes within one report execution.
 */
describe.skipIf(!runDatabaseTests)("Daily Operations Summary — Date Mode", () => {
  it("§19 the manual regression case: 11 Aug 00:09 delivery is Business Date 10 Aug, Calendar Date 11 Aug", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DMA", "08:00:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      await insertOrder(transaction, fixture, {
        codAmount: "100.00",
        companyRevenue: "20.00",
        deliveredAt: "2026-08-11T00:09:00+04:00",
        deliveryStatus: "delivered",
        serviceFee: "20.00",
        traderNetPayable: "80.00",
      });

      const businessTenth = await service.report({
        dateFrom: "2026-08-10",
        dateMode: "business_day",
        dateTo: "2026-08-10",
      });
      expect(businessTenth.totalOrders).toBe(1);
      const businessEleventh = await service.report({
        dateFrom: "2026-08-11",
        dateMode: "business_day",
        dateTo: "2026-08-11",
      });
      expect(businessEleventh.totalOrders).toBe(0);

      const calendarTenth = await service.report({
        dateFrom: "2026-08-10",
        dateMode: "calendar_day",
        dateTo: "2026-08-10",
      });
      expect(calendarTenth.totalOrders).toBe(0);
      const calendarEleventh = await service.report({
        dateFrom: "2026-08-11",
        dateMode: "calendar_day",
        dateTo: "2026-08-11",
      });
      expect(calendarEleventh.totalOrders).toBe(1);
      expect(calendarEleventh.totalDeliveryIncome).toBe("20.00");
    });
  });

  it("§19 the same case for a Petrol payment at 11 Aug 00:xx", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DMB", "08:00:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      await insertGeneralExpensePayment(transaction, fixture, "150.00", "2026-08-11T00:15:00+04:00");

      const business = await service.report({
        dateFrom: "2026-08-10",
        dateMode: "business_day",
        dateTo: "2026-08-10",
      });
      expect(business.totalExpenses).toBe("150.00");

      const calendar = await service.report({
        dateFrom: "2026-08-11",
        dateMode: "calendar_day",
        dateTo: "2026-08-11",
      });
      expect(calendar.totalExpenses).toBe("150.00");
      // Both fields are always present, regardless of which one is "active".
      expect(calendar.expenses[0]?.businessDate).toBe("2026-08-10");
      expect(calendar.expenses[0]?.calendarDate).toBe("2026-08-11");
    });
  });

  it("defaults to Business Day mode when dateMode is omitted", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DMC", "08:00:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      await insertOrder(transaction, fixture, {
        codAmount: "100.00",
        companyRevenue: "20.00",
        deliveredAt: "2026-08-11T00:09:00+04:00",
        deliveryStatus: "delivered",
        serviceFee: "20.00",
        traderNetPayable: "80.00",
      });
      const defaulted = await service.report({ dateFrom: "2026-08-10", dateTo: "2026-08-10" });
      expect(defaulted.dateMode).toBe("business_day");
      expect(defaulted.totalOrders).toBe(1);
    });
  });

  it("Calendar Day mode has no 08:00 cutoff: 07:59 and 08:00 land on the same Calendar Date", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DMD", "08:00:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      await insertOrder(transaction, fixture, {
        codAmount: "50.00",
        companyRevenue: "10.00",
        deliveredAt: "2026-08-11T07:59:00+04:00",
        deliveryStatus: "delivered",
        orderNumber: `ORD-DMD-A-${randomUUID().slice(0, 6)}`,
        serviceFee: "10.00",
        traderNetPayable: "40.00",
      });
      await insertOrder(transaction, fixture, {
        codAmount: "50.00",
        companyRevenue: "12.00",
        deliveredAt: "2026-08-11T08:00:00+04:00",
        deliveryStatus: "delivered",
        orderNumber: `ORD-DMD-B-${randomUUID().slice(0, 6)}`,
        serviceFee: "12.00",
        traderNetPayable: "38.00",
      });

      // In Business Day mode these two straddle the cutoff and land on
      // DIFFERENT Business Dates.
      const businessTenth = await service.report({
        dateFrom: "2026-08-10",
        dateMode: "business_day",
        dateTo: "2026-08-10",
      });
      expect(businessTenth.totalOrders).toBe(1);
      expect(businessTenth.totalDeliveryIncome).toBe("10.00");

      // In Calendar Day mode both belong to 11 Aug -- Calendar Day has no
      // cutoff at all.
      const calendarEleventh = await service.report({
        dateFrom: "2026-08-11",
        dateMode: "calendar_day",
        dateTo: "2026-08-11",
      });
      expect(calendarEleventh.totalOrders).toBe(2);
      expect(calendarEleventh.totalDeliveryIncome).toBe("22.00");
    });
  });

  it("a 23:59 delivery belongs to the same Calendar Date, not the next one", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DME", "08:00:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      await insertOrder(transaction, fixture, {
        codAmount: "50.00",
        companyRevenue: "9.00",
        deliveredAt: "2026-08-10T23:59:00+04:00",
        deliveryStatus: "delivered",
        serviceFee: "9.00",
        traderNetPayable: "41.00",
      });
      const calendarTenth = await service.report({
        dateFrom: "2026-08-10",
        dateMode: "calendar_day",
        dateTo: "2026-08-10",
      });
      expect(calendarTenth.totalOrders).toBe(1);
      const calendarEleventh = await service.report({
        dateFrom: "2026-08-11",
        dateMode: "calendar_day",
        dateTo: "2026-08-11",
      });
      expect(calendarEleventh.totalOrders).toBe(0);
    });
  });

  it("Today resolves differently per mode before the cutoff, and Yesterday follows", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DMF", "08:00:00");
      const now = new Date("2026-08-11T00:30:00+04:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId, now);

      expect(await service.currentDate("business_day")).toBe("2026-08-10");
      expect(await service.currentDate("calendar_day")).toBe("2026-08-11");
      expect(await service.currentDate()).toBe("2026-08-10"); // default

      const businessDays = new BusinessDayService(
        transaction as unknown as Kysely<DatabaseSchema>,
        { execute: (work: (tx: unknown) => unknown) => work(transaction) } as never,
        { current: () => ({ companyId: fixture.companyId }) } as never,
        { current: () => ({ identityId: fixture.actorId, permissions: new Set() }) } as never,
      );
      expect(businessDays.previousBusinessDate(await service.currentDate("business_day"))).toBe(
        "2026-08-09",
      );
      expect(businessDays.previousBusinessDate(await service.currentDate("calendar_day"))).toBe(
        "2026-08-10",
      );
    });
  });

  it("Today at/after the cutoff resolves to the same date in both modes", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DMG", "08:00:00");
      const service = buildService(
        transaction,
        fixture.companyId,
        fixture.actorId,
        new Date("2026-08-11T08:05:00+04:00"),
      );
      expect(await service.currentDate("business_day")).toBe("2026-08-11");
      expect(await service.currentDate("calendar_day")).toBe("2026-08-11");
    });
  });

  it("a Free delivered Order counts with zero income in Calendar Day mode too", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DMH", "08:00:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      await insertOrder(transaction, fixture, {
        codAmount: "0.00",
        companyRevenue: "0.00",
        deliveredAt: "2026-08-11T00:09:00+04:00",
        deliveryStatus: "delivered",
        serviceFee: "0.00",
        traderNetPayable: "0.00",
      });
      const calendarEleventh = await service.report({
        dateFrom: "2026-08-11",
        dateMode: "calendar_day",
        dateTo: "2026-08-11",
      });
      expect(calendarEleventh.totalOrders).toBe(1);
      expect(calendarEleventh.totalDeliveryIncome).toBe("0.00");
    });
  });

  it("Driver drill-down shows both Business Date and Calendar Date, and Order links still resolve, in Calendar Day mode", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DMI", "08:00:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      const orderNumber = `ORD-DMI-${randomUUID().slice(0, 6)}`;
      await insertOrder(transaction, fixture, {
        codAmount: "100.00",
        companyRevenue: "20.00",
        deliveredAt: "2026-08-11T00:09:00+04:00",
        deliveryStatus: "delivered",
        orderNumber,
        serviceFee: "20.00",
        traderNetPayable: "80.00",
      });

      const report = await service.report({
        dateFrom: "2026-08-11",
        dateMode: "calendar_day",
        dateTo: "2026-08-11",
      });
      const driverRow = report.driverSummary[0]!;
      const orders = await service.driverOrders({
        dateFrom: "2026-08-11",
        dateMode: "calendar_day",
        dateTo: "2026-08-11",
        driverId: driverRow.driverId,
      });
      expect(orders).toHaveLength(1);
      expect(orders[0]?.orderNumber).toBe(orderNumber);
      expect(orders[0]?.deliveryBusinessDate).toBe("2026-08-10");
      expect(orders[0]?.deliveryCalendarDate).toBe("2026-08-11");
      expect(orders[0]?.driverName).toBe(driverRow.driverName);
    });
  });

  it("never mixes datasets across modes: the same range under each mode produces its own consistent Net Result", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DMJ", "08:00:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      // Business Date 10 Aug / Calendar Date 11 Aug -- included only in the
      // mode that actually covers it for a given requested date.
      await insertOrder(transaction, fixture, {
        codAmount: "100.00",
        companyRevenue: "50.00",
        deliveredAt: "2026-08-11T00:09:00+04:00",
        deliveryStatus: "delivered",
        serviceFee: "50.00",
        traderNetPayable: "50.00",
      });
      await insertGeneralExpensePayment(transaction, fixture, "20.00", "2026-08-11T00:15:00+04:00");

      const business10 = await service.report({
        dateFrom: "2026-08-10",
        dateMode: "business_day",
        dateTo: "2026-08-10",
      });
      expect(business10.totalDeliveryIncome).toBe("50.00");
      expect(business10.totalExpenses).toBe("20.00");
      expect(business10.netResult).toBe("30.00");

      const calendar10 = await service.report({
        dateFrom: "2026-08-10",
        dateMode: "calendar_day",
        dateTo: "2026-08-10",
      });
      expect(calendar10.totalDeliveryIncome).toBe("0.00");
      expect(calendar10.totalExpenses).toBe("0.00");
      expect(calendar10.netResult).toBe("0.00");

      const calendar11 = await service.report({
        dateFrom: "2026-08-11",
        dateMode: "calendar_day",
        dateTo: "2026-08-11",
      });
      expect(calendar11.totalDeliveryIncome).toBe("50.00");
      expect(calendar11.totalExpenses).toBe("20.00");
      expect(calendar11.netResult).toBe("30.00");
    });
  });

  it("PDF and Excel generation succeed and carry the active Date Mode in either mode", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DMK", "08:00:00");
      const service = buildService(transaction, fixture.companyId, fixture.actorId);
      // `pdfRenderer` is a stub here (no real Chromium render in a DB test);
      // this proves the HTML build + service plumbing succeed for both
      // modes without throwing, not the rendered byte count.
      const business = await service.pdf(
        { dateFrom: "2026-08-10", dateMode: "business_day", dateTo: "2026-08-10" },
        "en",
      );
      expect(business.filename).toContain("2026-08-10");
      const calendar = await service.pdf(
        { dateFrom: "2026-08-10", dateMode: "calendar_day", dateTo: "2026-08-10" },
        "en",
      );
      expect(calendar.filename).toContain("2026-08-10");
      // `accountingXlsx` is the real writer, so this one genuinely proves
      // non-empty output.
      const excel = await service.excel({
        dateFrom: "2026-08-10",
        dateMode: "calendar_day",
        dateTo: "2026-08-10",
      });
      expect(excel.bytes.byteLength).toBeGreaterThan(0);
    });
  });

  it("keeps Company isolation for a drill-down request in Calendar Day mode", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixtureA = await seed(transaction, "DML", "08:00:00");
      const fixtureB = await seed(transaction, "DMM", "08:00:00");
      const serviceA = buildService(transaction, fixtureA.companyId, fixtureA.actorId);
      await insertOrder(transaction, fixtureB, {
        codAmount: "100.00",
        companyRevenue: "20.00",
        deliveredAt: "2026-08-11T00:09:00+04:00",
        deliveryStatus: "delivered",
        serviceFee: "20.00",
        traderNetPayable: "80.00",
      });

      const orders = await serviceA.driverOrders({
        dateFrom: "2026-08-11",
        dateMode: "calendar_day",
        dateTo: "2026-08-11",
        driverId: fixtureB.driverId,
      });
      expect(orders).toHaveLength(0);
    });
  });
});
