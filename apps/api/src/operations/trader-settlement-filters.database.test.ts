import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CashBankManagementService } from "../accounting/cash-bank-management.service.js";
import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import { OperationsService } from "./operations.service.js";
import { SEARCH_LIST_LIMIT } from "./search-list.js";
import { TraderSettlementService } from "./trader-settlement.service.js";

/**
 * Trader Settlements filters (2026-10-06): Driver, Order Number, Order
 * Reference Number (one value = partial, a comma list = exact), Emirate and
 * Area, all matched against a settlement's LINKED Orders with one EXISTS --
 * plus the comma list on the Orders search, and the summary's cross-Company
 * "reversed payments" leak.
 *
 * Real writers throughout: Orders are created, delivered and their Driver cash
 * collected by the services, and settlements are created and reversed by
 * TraderSettlementService. Disposable database only.
 */

const url = process.env.DATABASE_URL ?? "";
const disposable = process.env.BLUELINE_DISPOSABLE_DB_NAME ?? "";
const run = process.env.RUN_INTEGRITY_DATABASE === "true" && disposable !== "" && url.endsWith(`/${disposable}`);
const today = new Date().toISOString().slice(0, 10);
const COD = 100;
const FEE = 25;
const PAYABLE = COD - FEE;
const PERMISSIONS = [
  "orders.create",
  "orders.view",
  "orders.update",
  "orders.update_delivery_status",
  "settlements.create",
  "settlements.view",
  "settlements.reverse",
  "reconciliations.create",
  "accounting.view",
  "accounting.manage",
  "users_roles.manage",
];

interface Fixture {
  readonly companyId: string;
  readonly actorId: string;
  readonly traderId: string;
  readonly cashAccountId: string;
  readonly dubai: { readonly emirateId: string; readonly areaId: string };
  readonly sharjah: { readonly emirateId: string; readonly areaId: string };
  readonly driverA: string;
  readonly driverB: string;
}

describe.skipIf(!run)("Trader Settlements filters and Orders comma-list search", () => {
  let db: Kysely<DatabaseSchema>;
  let store: RequestSecurityContextStore;
  let get: <T>(type: new (...args: never[]) => T) => T;
  let a: Fixture;
  let b: Fixture;
  /** Settlement ids in Company A, by name. */
  const s: Record<string, string> = {};
  /** Order numbers in Company A, by name. */
  const o: Record<string, string> = {};
  const tag = randomUUID().slice(0, 6);

  const as = <T,>(fixture: Pick<Fixture, "actorId" | "companyId">, work: () => Promise<T>) =>
    store.run(
      {
        identity: {
          companyId: fixture.companyId,
          forcePasswordChange: false,
          identityId: fixture.actorId,
          kind: "company_user",
          permissions: new Set(PERMISSIONS),
          sessionId: randomUUID(),
        },
        tenant: { companyId: fixture.companyId, identityId: fixture.actorId },
      } as never,
      work,
    );
  const key = (label: string) => `filters.${label}.${randomUUID()}`;

  async function emirate(code: string): Promise<string> {
    await sql`insert into emirates(code,name_en,name_ar,display_order) values (${code},${code},${code},300)
      on conflict (code) do nothing`.execute(db);
    return (await sql<{ id: string }>`select id from emirates where code = ${code}`.execute(db)).rows[0]!.id;
  }

  async function createFixture(label: string): Promise<Fixture> {
    const companyId = randomUUID();
    const short = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`FLT-${short}`},${`flt-${short}`},${`Filters ${label}`},'active',now())`.execute(db);
    const actorId = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${actorId}::uuid,${companyId}::uuid,'company_user',${`flt.${actorId}`},'x','disabled')`.execute(db);
    const areas: Record<string, { emirateId: string; areaId: string }> = {};
    for (const code of ["DXB", "SHJ"]) {
      const emirateId = await emirate(code);
      const areaId = randomUUID();
      await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
        values (${areaId}::uuid,${companyId}::uuid,${`${code}-${short}`},${code},'منطقة',${emirateId}::uuid)`.execute(db);
      areas[code] = { areaId, emirateId };
    }
    const traderId = randomUUID();
    await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,created_by_account_id)
      values (${traderId}::uuid,${companyId}::uuid,${`T-${short}`},'Trader','971500000003',${areas.DXB!.areaId}::uuid,${actorId}::uuid)`.execute(db);
    for (const area of Object.values(areas))
      await sql`insert into trader_service_prices(company_id,trader_id,emirate_id,area_id,service_fee,created_by_account_id)
        values (${companyId}::uuid,${traderId}::uuid,${area.emirateId}::uuid,${area.areaId}::uuid,${FEE},${actorId}::uuid)`.execute(db);
    const drivers: string[] = [];
    for (const name of ["A", "B"]) {
      const employeeId = randomUUID();
      const driverId = randomUUID();
      await sql`insert into employees(id,company_id,employee_number,name_en,employee_type,hired_on,payroll_eligible,is_active)
        values (${employeeId}::uuid,${companyId}::uuid,${`E-${name}-${short}`},${`Driver ${name}`},'employee','2026-01-01'::date,true,true)`.execute(db);
      await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,employee_id)
        values (${driverId}::uuid,${companyId}::uuid,${`D-${name}-${short}`},${`Driver ${name}`},${`97150000001${name === "A" ? 1 : 2}`},'employee',${employeeId}::uuid)`.execute(db);
      drivers.push(driverId);
    }
    // A posting Cash GL account: required by the committed Cash account rule,
    // harmless where that link has since become optional.
    const cashGlId = randomUUID();
    await sql`insert into chart_of_accounts(id,company_id,code,name_en,account_type,account_class,normal_balance,is_posting_account,is_active)
      values (${cashGlId}::uuid,${companyId}::uuid,'1010','Cash on hand','asset','cash','debit',true,true)`.execute(db);
    const partial = { actorId, companyId };
    const cash = get(CashBankManagementService);
    const cashAccountId = (
      (await as(partial, () =>
        cash.createCashAccount(
          { code: "CASH", effectiveFrom: today, linkedGlAccountId: cashGlId, name: "Main Cash", type: "main_cash" } as never,
          key("cash"),
        ),
      )) as { id: string }
    ).id;
    // Let cash settlements post without first funding the account: an
    // opening-balance movement needs a fiscal-period setup the committed
    // Cash/Bank rules require, and balances are not what this suite tests.
    await sql`insert into company_balance_policies(company_id,cash_policy,bank_policy,bank_overdraft_limit,effective_from,change_reason,created_by_account_id)
      values (${companyId}::uuid,'allow','allow_within_overdraft',0,'-infinity'::date,'Filter test fixture',${actorId}::uuid)`.execute(db);
    return {
      actorId,
      cashAccountId,
      companyId,
      driverA: drivers[0]!,
      driverB: drivers[1]!,
      dubai: areas.DXB!,
      sharjah: areas.SHJ!,
      traderId,
    };
  }

  let serial = 0;
  /** A delivered Order whose Driver cash is collected, ready to settle. Returns [id, orderNumber]. */
  async function payableOrder(
    fixture: Fixture,
    options: { reference: string; driverId: string; areaId: string },
  ): Promise<[string, string]> {
    serial += 1;
    const operations = get(OperationsService);
    const created = (await as(fixture, () =>
      operations.createOrder(
        {
          areaId: options.areaId,
          codAmount: COD,
          customerAddress: "Address",
          customerMobileNumber: "0501234567",
          customerName: "Customer",
          driverId: options.driverId,
          packageCount: 1,
          paymentCondition: "customer_pays_cod_and_fee",
          referenceNumber: options.reference,
          serialNumber: `FLT-${tag}-${serial}`,
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("order"),
      ),
    )) as { id: string };
    for (const status of ["out_for_delivery", "delivered"])
      await as(fixture, () => operations.changeOrderStatus(created.id, { status } as never, randomUUID()));
    await as(fixture, () =>
      get(DriverCashReconciliationService).confirmSingleOrder(created.id, { paymentMethod: "cash" } as never, randomUUID(), key("reconcile")),
    );
    const number = (await sql<{ n: string }>`select order_number as n from orders where id = ${created.id}::uuid`.execute(db)).rows[0]!.n;
    return [created.id, number];
  }

  async function settle(fixture: Fixture, orderIds: readonly string[]): Promise<string> {
    const result = (await as(fixture, () =>
      get(TraderSettlementService).createPayment(
        {
          allocations: orderIds.map((orderId) => ({ amount: PAYABLE, orderId })),
          amount: PAYABLE * orderIds.length,
          cashAccountId: fixture.cashAccountId,
          paymentDate: today,
          paymentMethod: "cash",
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("settle"),
      ),
    )) as { settlementId?: string; id?: string };
    return (result.settlementId ?? result.id)!;
  }

  const list = (fixture: Fixture, query: Record<string, unknown>) =>
    as(fixture, () => get(TraderSettlementService).list({ pageSize: 200, ...query } as never)) as Promise<{
      items: ReadonlyArray<{ settlementId: string }>;
      total: number;
    }>;
  const ids = async (fixture: Fixture, query: Record<string, unknown>) =>
    (await list(fixture, query)).items.map((row) => row.settlementId).sort();
  const named = (...names: string[]) => names.map((name) => s[name]!).sort();

  beforeAll(async () => {
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 6 }) }) });
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DATABASE).useValue(db).compile();
    get = (type) => module.get(type, { strict: false });
    store = module.get(RequestSecurityContextStore, { strict: false });
    a = await createFixture("A");
    b = await createFixture("B");

    // Company A.
    //  S1: one Order -- ref 2383, Driver A, Dubai
    //  S2: three Orders -- 1523 (Driver A, Dubai), 1524 (Driver B, Sharjah), 12383 (Driver B, Dubai)
    //  S3: one Order -- 2447, Driver B, Sharjah
    const [o1, n1] = await payableOrder(a, { areaId: a.dubai.areaId, driverId: a.driverA, reference: `2383` });
    o.o1 = n1;
    s.S1 = await settle(a, [o1]);
    const [o2, n2] = await payableOrder(a, { areaId: a.dubai.areaId, driverId: a.driverA, reference: `1523` });
    const [o3, n3] = await payableOrder(a, { areaId: a.sharjah.areaId, driverId: a.driverB, reference: `1524` });
    const [o4, n4] = await payableOrder(a, { areaId: a.dubai.areaId, driverId: a.driverB, reference: `12383` });
    o.o2 = n2;
    o.o3 = n3;
    o.o4 = n4;
    s.S2 = await settle(a, [o2, o3, o4]);
    const [o5, n5] = await payableOrder(a, { areaId: a.sharjah.areaId, driverId: a.driverB, reference: `2447` });
    o.o5 = n5;
    s.S3 = await settle(a, [o5]);

    // Company B: the SAME reference numbers and order numbers (numbering is per
    // Company), and a reversed settlement -- none of it may reach Company A.
    const [b1] = await payableOrder(b, { areaId: b.dubai.areaId, driverId: b.driverA, reference: `2383` });
    const [b2] = await payableOrder(b, { areaId: b.dubai.areaId, driverId: b.driverA, reference: `1523` });
    s.B1 = await settle(b, [b1]);
    s.B2 = await settle(b, [b2]);
    await as(b, () => get(TraderSettlementService).reverse(s.B2!, "Paid to the wrong account", randomUUID()));
  }, 600_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it("no filter lists every settlement of the Company once", async () => {
    expect(await ids(a, {})).toEqual(named("S1", "S2", "S3"));
  });

  it("Order Reference Number: one value is partial, a comma list is exact", async () => {
    // Partial (unchanged behaviour): 2383 is inside 12383 too.
    expect(await ids(a, { referenceNumber: "2383" })).toEqual(named("S1", "S2"));
    // List: exact only -- 2383 no longer reaches 12383.
    expect(await ids(a, { referenceNumber: "2383,2447" })).toEqual(named("S1", "S3"));
    // Spaces, an Arabic comma, new lines, a duplicate and an empty item.
    expect(await ids(a, { referenceNumber: " 2383 ،\n2447,, 2383 ," })).toEqual(named("S1", "S3"));
    // A single exact value written as a list.
    expect(await ids(a, { referenceNumber: "12383," })).toEqual(named("S2"));
  });

  it("Order Number: one value is partial, a list is exact, and bare numbers work", async () => {
    expect(await ids(a, { orderNumber: o.o5! })).toEqual(named("S3"));
    const bare = (number: string) => String(Number(number.replace(/^\D+/u, "")));
    expect(await ids(a, { orderNumber: `${bare(o.o1!)}, ${o.o5!.toLowerCase()}` })).toEqual(named("S1", "S3"));
    expect(await ids(a, { orderNumber: `${o.o3!}\n${o.o4!}` })).toEqual(named("S2"));
  });

  it("Driver, Emirate and Area match the linked Orders", async () => {
    expect(await ids(a, { driverId: a.driverA })).toEqual(named("S1", "S2"));
    expect(await ids(a, { driverId: a.driverB })).toEqual(named("S2", "S3"));
    expect(await ids(a, { emirateId: a.sharjah.emirateId })).toEqual(named("S2", "S3"));
    expect(await ids(a, { areaId: a.dubai.areaId })).toEqual(named("S1", "S2"));
  });

  it("filters combine on the SAME Order and a multi-Order match still lists the settlement once", async () => {
    // Driver B + Dubai: only Order 12383 (in S2).
    expect(await ids(a, { driverId: a.driverB, emirateId: a.dubai.emirateId })).toEqual(named("S2"));
    // Driver A + Sharjah: no single Order is both, so nothing (S2 has one of each on different Orders).
    expect(await ids(a, { driverId: a.driverA, emirateId: a.sharjah.emirateId })).toEqual([]);
    // Two of S2's Orders match the list: still one row and total 1.
    const result = await list(a, { referenceNumber: "1523,1524" });
    expect(result.items.map((row) => row.settlementId)).toEqual([s.S2]);
    expect(result.total).toBe(1);
    // Combined with an existing (settlement-level) filter.
    expect(await ids(a, { paymentMethod: "cash", referenceNumber: "2383,1523", traderId: a.traderId })).toEqual(named("S1", "S2"));
  });

  it("pagination counts settlements, not matching Orders", async () => {
    const page = (await as(a, () =>
      get(TraderSettlementService).list({ page: 1, pageSize: 25, referenceNumber: "2383,1523,1524,12383,2447" } as never),
    )) as { items: readonly unknown[]; total: number };
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(3);
  });

  it("tenant isolation: Company B's identical references, Drivers and reversals never reach Company A", async () => {
    expect(await ids(a, { referenceNumber: "2383,1523" })).toEqual(named("S1", "S2"));
    expect(await ids(a, { driverId: b.driverA })).toEqual([]);
    expect(await ids(a, { areaId: b.dubai.areaId })).toEqual([]);
    const summary = (await as(a, () => get(TraderSettlementService).summary({} as never))) as unknown as Record<string, unknown>;
    const flat = JSON.stringify(summary);
    // Company B reversed a settlement; Company A has none.
    expect(flat).toMatch(/"reversedPayments":0/u);
    const summaryB = JSON.stringify(await as(b, () => get(TraderSettlementService).summary({} as never)));
    expect(summaryB).toMatch(/"reversedPayments":1/u);
  });

  it(`a list longer than ${SEARCH_LIST_LIMIT} values is refused with a clear error`, async () => {
    const tooMany = Array.from({ length: SEARCH_LIST_LIMIT + 1 }, (_, index) => `R${index}`).join(",");
    await expect(list(a, { referenceNumber: tooMany })).rejects.toMatchObject({ errorCode: "search_list_too_long" });
    await expect(list(a, { orderNumber: tooMany })).rejects.toMatchObject({ errorCode: "search_list_too_long" });
  });

  it("Orders search: a comma list is an exact Order Number / Reference Number match; one value is unchanged", async () => {
    const orders = (search: string) =>
      as(a, async () =>
        ((await get(OperationsService).orders({ search, pageSize: 200 } as never)) as { items: ReadonlyArray<{ orderNumber: string }> }).items
          .map((row) => row.orderNumber)
          .sort(),
      );
    expect(await orders("2383,2447")).toEqual([o.o1!, o.o5!].sort());
    expect(await orders(`${o.o3!}, 12383`)).toEqual([o.o3!, o.o4!].sort());
    // One value keeps the partial reference search: 2383 also finds 12383.
    expect(await orders("2383")).toEqual([o.o1!, o.o4!].sort());
    // Company B's identical references stay in Company B.
    expect((await orders("2383,1523")).every((number) => [o.o1, o.o2].includes(number))).toBe(true);
  });

  it("Orders Report: signed Trader Amount, Paid, Collected and Balance per order and in whole-report totals", async () => {
    type Money = { cod: string; fee: string; traderAmount: string; paidToTrader: string; collectedFromTrader: string; balance: string };
    const report = (fixture: Fixture, page: number, pageSize = 2) =>
      as(fixture, () => get(OperationsService).ordersReport({ page, pageSize })) as Promise<{
        items: ReadonlyArray<Money & { orderNumber: string }>;
        totalCount: number;
        totals: Money;
      }>;
    const first = await report(a, 1);
    // Company A: 5 Orders, COD 100, fee 25, owed to the Trader 75 each -- all paid in settlements.
    expect(first.totalCount).toBe(5);
    expect(first.items).toHaveLength(2);
    expect(first.items.every((row) => Number(row.traderAmount) === PAYABLE && Number(row.paidToTrader) === PAYABLE && Number(row.balance) === 0)).toBe(true);
    // Totals cover all 5 Orders even though the page holds 2, and are identical on every page.
    expect(first.totals).toEqual({ balance: "0.00", cod: "500.00", collectedFromTrader: "0.00", fee: "125.00", paidToTrader: "375.00", traderAmount: "375.00" });
    expect((await report(a, 3)).totals).toEqual(first.totals);

    // Company B gets an Order whose fee is more than its COD: the Trader owes the fee.
    const created = (await as(b, () =>
      get(OperationsService).createOrder(
        {
          areaId: b.dubai.areaId, codAmount: 0, customerAddress: "Address", customerMobileNumber: "0501234567",
          customerName: "Customer", driverId: b.driverA, packageCount: 1,
          paymentCondition: "customer_pays_cod_trader_pays_fee", referenceNumber: "NEG-1",
          serialNumber: `FLT-${tag}-neg`, traderId: b.traderId,
        } as never,
        randomUUID(),
        key("order-negative"),
      ),
    )) as { id: string };
    const negativeNumber = (await sql<{ n: string }>`select order_number as n from orders where id = ${created.id}::uuid`.execute(db)).rows[0]!.n;
    const bReport = await report(b, 1, 200);
    const negative = bReport.items.find((row) => row.orderNumber === negativeNumber)!;
    expect(negative).toMatchObject({ balance: "-25.00", collectedFromTrader: "0.00", cod: "0.00", paidToTrader: "0.00", traderAmount: "-25.00" });
    // Company B totals: its own 3 Orders only; Balance = Trader Amount - Paid + Collected.
    expect(bReport.totalCount).toBe(3);
    const t = bReport.totals;
    expect(t.cod).toBe("200.00");
    expect(Number(t.traderAmount)).toBe(2 * PAYABLE - FEE);
    expect(Number(t.balance)).toBeCloseTo(Number(t.traderAmount) - Number(t.paidToTrader) + Number(t.collectedFromTrader), 2);
    // Company A is unchanged by Company B's Order.
    expect((await report(a, 1)).totals).toEqual(first.totals);
  });
});
