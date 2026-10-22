import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Decimal } from "decimal.js";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { CashBankManagementService } from "../accounting/cash-bank-management.service.js";
import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import {
  CompanyOrderHealthService,
  type OrderHealthRow,
  traderReceivableDueSql,
} from "./company-order-health.service.js";
import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import {
  effectiveOffsetTotal,
  effectiveSettlementCount,
} from "./effective-settlement-offsets.js";
import { calculateOrderFinancials } from "./order-financial-model.js";
import { OperationsService } from "./operations.service.js";
import { OrderMaintenanceService } from "./order-maintenance.service.js";
import { ReceivableOffsetReversalService } from "./receivable-offset-reversal.service.js";
import { TraderReceivableService } from "./trader-receivable.service.js";
import { TraderSettlementService } from "./trader-settlement.service.js";

/**
 * Phase 2 Prompt 1 -- Company Order Health certification.
 *
 * Every Order below is produced through the REAL services (AppModule
 * compiled, not initialised) against the disposable database. Only states no
 * service produces on purpose are written directly, each marked "crafted":
 * a legacy Order with no Receivable, a second effective offset, an Order
 * whose accounting capture never ran, a failed Accounting Event, and a
 * Driver-cash flag with no reconciliation. That is the corruption the health
 * check exists to find.
 *
 * The health check itself is only ever called read-only.
 */

const disposableName = process.env.BLUELINE_DISPOSABLE_DB_NAME ?? "";
const databaseUrl = process.env.DATABASE_URL ?? "";
const runDatabaseTests =
  process.env.RUN_INTEGRITY_DATABASE === "true" &&
  disposableName.length > 0 &&
  databaseUrl.endsWith(`/${disposableName}`);

const today = new Date().toISOString().slice(0, 10);
const FEE = 18;

const PERMISSIONS = [
  "accounting.view",
  "accounting.manage",
  "accounting.configuration.manage",
  "orders.create",
  "orders.view",
  "orders.update",
  "orders.update_delivery_status",
  "trader_receivables.create",
  "trader_receivables.view",
  "trader_receivables.reverse",
  "settlements.create",
  "settlements.view",
  "settlements.reverse",
  "reconciliations.create",
  "users_roles.manage",
];

type Mode = "off" | "on";

interface Fixture {
  readonly mode: Mode;
  readonly companyId: string;
  readonly actorId: string;
  readonly areaId: string;
  readonly traderId: string;
  readonly driverId: string;
  readonly cashAccountId: string;
}

describe.skipIf(!runDatabaseTests)("Company Order Health (Repair Center, read-only)", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let store: RequestSecurityContextStore;
  let get: <T>(type: new (...args: never[]) => T) => T;
  let health: CompanyOrderHealthService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(db)
      .compile();
    get = (type) => module.get(type, { strict: false });
    store = module.get(RequestSecurityContextStore, { strict: false });
    health = get(CompanyOrderHealthService);
    await sql`insert into emirates(code,name_en,name_ar,display_order)
      values ('DXB','DXB','DXB',200) on conflict (code) do nothing`.execute(db);
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  // ---------------------------------------------------------------------------
  // Fixture helpers (same construction as the Phase 1 Verify First suite)
  // ---------------------------------------------------------------------------

  function as<T>(fixture: Pick<Fixture, "actorId" | "companyId">, work: () => Promise<T>) {
    return store.run(
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
      },
      work,
    );
  }

  const key = (label: string) => `health.${label}.${randomUUID()}`;

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`HEALTH-${tag}`},${`health-${tag}`},${`Health ${mode} ${tag}`},
              'active',now())`.execute(db);
    const actorId = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${actorId}::uuid,${companyId}::uuid,'company_user',${`health.${actorId}`},'x','disabled')`.execute(
      db,
    );
    if (mode === "on") {
      await db.transaction().execute((transaction) =>
        new AccountingTemplateImporter().apply(transaction, {
          actorAccountId: null,
          baseCurrency: "AED",
          companyId,
          effectiveFrom: today,
          templateCode: "UAE_DELIVERY_STANDARD",
          templateVersion: 3,
        }),
      );
      await sql`update accounting_configurations set accounting_enabled = true, version = version + 1
                 where company_id = ${companyId}::uuid`.execute(db);
    }
    const areaId = randomUUID();
    const traderId = randomUUID();
    const driverId = randomUUID();
    const emirate = await sql<{ id: string }>`select id from emirates where code='DXB'`.execute(db);
    await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
      values (${areaId}::uuid,${companyId}::uuid,${`A-${tag}`},${`Area ${tag}`},'منطقة',
              ${emirate.rows[0]!.id}::uuid)`.execute(db);
    await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,created_by_account_id)
      values (${traderId}::uuid,${companyId}::uuid,${`T-${tag}`},'Trader','971500000003',
              ${areaId}::uuid,${actorId}::uuid)`.execute(db);
    await sql`insert into trader_service_prices(company_id,trader_id,emirate_id,area_id,service_fee,
        created_by_account_id)
      values (${companyId}::uuid,${traderId}::uuid,${emirate.rows[0]!.id}::uuid,${areaId}::uuid,${FEE},
              ${actorId}::uuid)`.execute(db);
    const employeeId = randomUUID();
    await sql`insert into employees(id,company_id,employee_number,name_en,employee_type,hired_on,
        payroll_eligible,is_active)
      values (${employeeId}::uuid,${companyId}::uuid,${`E-${tag}`},'Driver','employee',
              '2026-01-01'::date,true,true)`.execute(db);
    await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,employee_id)
      values (${driverId}::uuid,${companyId}::uuid,${`D-${tag}`},'Driver','971500000005','employee',
              ${employeeId}::uuid)`.execute(db);
    const partial = { actorId, areaId, cashAccountId: "", companyId, driverId, mode, traderId };
    const cash = get(CashBankManagementService);
    const cashAccountId =
      mode === "off"
        ? (
            (await as(partial, () =>
              cash.createCashAccount(
                { code: "CASH", effectiveFrom: today, name: "Main Cash", type: "main_cash" } as never,
                key("cash"),
              ),
            )) as { id: string }
          ).id
        : (
            await sql<{ id: string }>`select id from company_cash_accounts
              where company_id=${companyId}::uuid and cash_account_type='main_cash'`.execute(db)
          ).rows[0]!.id;
    const fixture = { ...partial, cashAccountId };
    const movement = (await as(fixture, () =>
      cash.createMovement(
        mode === "off"
          ? ({
              accountingDate: today,
              amount: "100000",
              destinationCashAccountId: cashAccountId,
              movementDate: today,
              movementType: "opening_balance",
            } as never)
          : ({
              accountingDate: today,
              amount: "100000",
              classificationMappingKey: "cash_bank_deposit_owner_contribution",
              destinationCashAccountId: cashAccountId,
              movementDate: today,
              movementType: "cash_deposit",
            } as never),
        key("fund"),
      ),
    )) as { id: string };
    await as(fixture, () => cash.confirmMovement(movement.id, undefined, key("fund-confirm")));
    return fixture;
  }

  let serial = 0;
  async function deliveredOrder(
    fixture: Fixture,
    codAmount: number,
    paymentCondition: "customer_pays_cod_and_fee" | "customer_pays_cod_trader_pays_fee",
  ): Promise<string> {
    serial += 1;
    const operations = get(OperationsService);
    const created = (await as(fixture, () =>
      operations.createOrder(
        {
          areaId: fixture.areaId,
          codAmount,
          customerAddress: "Address",
          customerMobileNumber: "0501234567",
          customerName: "Customer",
          driverId: fixture.driverId,
          packageCount: 1,
          paymentCondition,
          serialNumber: `OH-${Date.now()}-${serial}`,
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("order"),
      ),
    )) as { id: string };
    for (const status of ["out_for_delivery", "delivered"]) {
      await as(fixture, () =>
        operations.changeOrderStatus(created.id, { status } as never, randomUUID()),
      );
    }
    return created.id;
  }

  async function reconcileCash(fixture: Fixture, orderId: string) {
    await as(fixture, () =>
      get(DriverCashReconciliationService).confirmSingleOrder(
        orderId,
        { paymentMethod: "cash" } as never,
        randomUUID(),
        key("reconcile"),
      ),
    );
  }

  /** A delivered COD Order with Driver cash reconciled: Trader payable 100 - 18 = 82. */
  async function payableOrder(fixture: Fixture): Promise<string> {
    const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
    await reconcileCash(fixture, orderId);
    return orderId;
  }

  async function orderNumber(orderId: string) {
    return (
      await sql<{ n: string }>`select order_number as n from orders where id=${orderId}::uuid`.execute(db)
    ).rows[0]!.n;
  }

  async function activeReceivable(fixture: Fixture, orderId: string): Promise<string> {
    const rows = await sql<{ id: string }>`select id from trader_receivables
      where company_id=${fixture.companyId}::uuid and source_type='service_charge'
        and source_reference=${await orderNumber(orderId)}
        and status not in ('reversed','cancelled')`.execute(db);
    expect(rows.rows).toHaveLength(1);
    return rows.rows[0]!.id;
  }

  /** A zero-COD Trader-pays-fee Order: the Trader owes the AED 18 fee. */
  async function feeOrder(fixture: Fixture) {
    const orderId = await deliveredOrder(fixture, 0, "customer_pays_cod_trader_pays_fee");
    return { orderId, receivableId: await activeReceivable(fixture, orderId) };
  }

  async function settleWithOffset(fixture: Fixture, receivableId: string, offset = FEE) {
    const payable = await payableOrder(fixture);
    const result = (await as(fixture, () =>
      get(TraderSettlementService).createPayment(
        {
          allocations: [{ amount: 82, orderId: payable }],
          amount: 82 - offset,
          cashAccountId: fixture.cashAccountId,
          paymentDate: today,
          paymentMethod: "cash",
          receivableOffsets: [{ amount: offset, receivableId }],
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("settle"),
      ),
    )) as { settlementId?: string; id?: string };
    return (result.settlementId ?? result.id)!;
  }

  async function reverseSettlement(fixture: Fixture, settlementId: string) {
    await as(fixture, () =>
      get(TraderSettlementService).reverse(settlementId, "Paid to the wrong account", randomUUID()),
    );
  }

  async function collectPhysically(fixture: Fixture, receivableId: string) {
    await as(fixture, () =>
      get(TraderReceivableService).confirmCollection(
        {
          allocations: [{ amount: FEE, receivableId }],
          amountReceived: FEE,
          paymentDate: today,
          paymentMethod: "cash",
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("collection"),
      ),
    );
  }

  async function reverseReceivable(fixture: Fixture, receivableId: string) {
    await as(fixture, () =>
      get(ReceivableOffsetReversalService).execute(receivableId, "Fee reset", randomUUID()),
    );
  }

  async function repair(fixture: Fixture, orderId: string) {
    return as(fixture, () => get(OperationsService).repairTraderReceivable(orderId, randomUUID()));
  }

  async function cancelReceivable(fixture: Fixture, receivableId: string) {
    await as(fixture, () =>
      get(TraderReceivableService).cancelReceivable(
        receivableId,
        { reason: "Raised in error" } as never,
        randomUUID(),
      ),
    );
  }

  async function receivableStatuses(fixture: Fixture, orderId: string) {
    return (
      await sql<{ status: string }>`select status from trader_receivables
        where company_id=${fixture.companyId}::uuid and source_type='service_charge'
          and source_reference=${await orderNumber(orderId)} order by status`.execute(db)
    ).rows.map((row) => row.status);
  }

  /** Crafted: a legacy delivered Trader-pays-fee Order that never got its Receivable. */
  async function legacyOrderWithoutReceivable(
    fixture: Fixture,
    options: { orderDate?: string; traderNetPayable?: number } = {},
  ): Promise<string> {
    const orderId = randomUUID();
    await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,
      created_by_account_id,customer_name,customer_mobile_number,
      customer_address,package_count,payment_condition,service_fee,final_service_fee_snapshot,
      customer_provenance_status,pricing_provenance_status,customer_amount_due,trader_gross_payable,
      trader_paid_service_fee,trader_net_payable,trader_paid_amount,delivery_status,
      driver_reconciliation_status,trader_settlement_status,return_status,delivered_at)
    values (${orderId}::uuid,${fixture.companyId}::uuid,${`LEG-${orderId.slice(0, 8)}`},
      ${options.orderDate ?? today}::date,
      ${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,
      'Customer','971500000001','Address',1,
      'customer_pays_cod_trader_pays_fee',${FEE},${FEE},'legacy_unattributed','legacy_unattributed',
      0,0,${FEE},${options.traderNetPayable ?? 0},0,'delivered','not_applicable','not_eligible',
      'not_applicable',now())`.execute(db);
    return orderId;
  }

  /** Crafted: a second EFFECTIVE offset of the same Receivable (disposable DB only). */
  async function craftSecondEffectiveOffset(fixture: Fixture, receivableId: string) {
    const settlementId = randomUUID();
    await db.transaction().execute(async (transaction) => {
      await sql`set local session_replication_role = replica`.execute(transaction);
      await sql`insert into trader_settlements(id,company_id,settlement_number,trader_id,business_date,
          gross_payable,service_fee_deductions,other_deductions,charges,adjustments,net_payable,status,
          created_by_account_id,confirmed_by_account_id,confirmed_at)
        values (${settlementId}::uuid,${fixture.companyId}::uuid,${`SET-X${settlementId.slice(0, 6)}`},
          ${fixture.traderId}::uuid,current_date,${FEE},0,${FEE},0,0,0,'confirmed',
          ${fixture.actorId}::uuid,${fixture.actorId}::uuid,now())`.execute(transaction);
      await sql`insert into trader_settlement_receivable_offsets(company_id,settlement_id,receivable_id,
          amount_allocated)
        values (${fixture.companyId}::uuid,${settlementId}::uuid,${receivableId}::uuid,${FEE})`.execute(
        transaction,
      );
    });
  }

  /** Crafted (disposable DB only): bypasses triggers for one statement. */
  async function crafted(statement: ReturnType<typeof sql>) {
    await db.transaction().execute(async (transaction) => {
      await sql`set local session_replication_role = replica`.execute(transaction);
      await statement.execute(transaction);
    });
  }

  async function allRows(companyId: string, scope: "all" | "last30" = "all") {
    const rows: OrderHealthRow[] = [];
    for (let page = 1; ; page += 1) {
      const result = await health.list(companyId, { health: "all", page, pageSize: 100, scope });
      rows.push(...result.items);
      if (rows.length >= result.total || result.items.length === 0) break;
    }
    return rows;
  }

  async function rowFor(companyId: string, orderId: string) {
    const row = (await allRows(companyId)).find((item) => item.orderId === orderId);
    expect(row, `order ${orderId} must be evaluated`).toBeDefined();
    return row!;
  }

  /** Writes of every kind the Repair Center must never produce, for one Company. */
  async function writeFootprint(companyId: string) {
    const result = await sql<Record<string, string>>`
      select
        (select count(*) from orders where company_id=${companyId}::uuid)::text as orders,
        (select coalesce(max(updated_at)::text,'') from orders where company_id=${companyId}::uuid) as "ordersUpdated",
        (select count(*) from trader_receivables where company_id=${companyId}::uuid)::text as receivables,
        (select coalesce(max(updated_at)::text,'') from trader_receivables where company_id=${companyId}::uuid) as "receivablesUpdated",
        (select count(*) from trader_settlements where company_id=${companyId}::uuid)::text as settlements,
        (select count(*) from trader_settlement_receivable_offsets where company_id=${companyId}::uuid)::text as offsets,
        (select count(*) from trader_collections where company_id=${companyId}::uuid)::text as collections,
        (select count(*) from accounting_events where company_id=${companyId}::uuid)::text as events,
        (select count(*) from journal_entries where company_id=${companyId}::uuid)::text as journals,
        (select count(*) from audit_events where company_id=${companyId}::uuid or subject_id=${companyId})::text as audit,
        (select count(*) from order_maintenance_findings where company_id=${companyId}::uuid)::text as findings
    `.execute(db);
    return result.rows[0]!;
  }

  // ---------------------------------------------------------------------------
  // Scenarios A-L
  // ---------------------------------------------------------------------------

  describe("scenarios (Accounting OFF company)", () => {
    let fixture: Fixture;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      fixture = await createFixture("off");
      // A: customer pays COD + fee -> no Receivable required.
      ids.a = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      await reconcileCash(fixture, ids.a);
      // B: Trader pays fee but COD covers it (service_fee > 0, still no Receivable).
      ids.b = await deliveredOrder(fixture, 100, "customer_pays_cod_trader_pays_fee");
      // C: active, unpaid AED 18 Receivable.
      ids.c = (await feeOrder(fixture)).orderId;
      // D: physically collected.
      const d = await feeOrder(fixture);
      ids.d = d.orderId;
      await collectPhysically(fixture, d.receivableId);
      // E: settled by one effective offset, no physical collection.
      const e = await feeOrder(fixture);
      ids.e = e.orderId;
      await settleWithOffset(fixture, e.receivableId);
      // F: SET-A -> SET-A reversed -> SET-B (one effective AED 18).
      const f = await feeOrder(fixture);
      ids.f = f.orderId;
      const setA = await settleWithOffset(fixture, f.receivableId);
      await reverseSettlement(fixture, setA);
      await settleWithOffset(fixture, f.receivableId);
      // G: required Receivable missing (crafted legacy Order).
      ids.g = await legacyOrderWithoutReceivable(fixture);
      // H: only a reversed Receivable remains.
      const h = await feeOrder(fixture);
      ids.h = h.orderId;
      await settleWithOffset(fixture, h.receivableId);
      await reverseReceivable(fixture, h.receivableId);
      // I: two genuinely effective offsets (crafted).
      const i = await feeOrder(fixture);
      ids.i = i.orderId;
      await settleWithOffset(fixture, i.receivableId);
      await craftSecondEffectiveOffset(fixture, i.receivableId);
      // K: Driver cash flagged reconciled with no reconciliation (crafted).
      ids.k = await deliveredOrder(fixture, 50, "customer_pays_cod_and_fee");
      await crafted(sql`update orders set driver_reconciliation_status='reconciled'
                         where id=${ids.k}::uuid`);
    }, 600_000);

    it("A: customer pays COD and fee -> HEALTHY, no receivable required", async () => {
      expect(await rowFor(fixture.companyId, ids.a!)).toMatchObject({
        classification: "NO_TRADER_RECEIVABLE_REQUIRED",
        health: "HEALTHY",
        reasonCode: "NO_TRADER_RECEIVABLE_REQUIRED",
        recommendedAction: "none",
      });
    });

    it("B (Part G): Trader pays fee but COD covers it -> HEALTHY (no receivable from service_fee > 0)", async () => {
      const fee = await sql<{ fee: string }>`select service_fee::text as fee from orders
        where id=${ids.b!}::uuid`.execute(db);
      expect(Number(fee.rows[0]!.fee)).toBeGreaterThan(0);
      expect(await rowFor(fixture.companyId, ids.b!)).toMatchObject({
        classification: "NO_TRADER_RECEIVABLE_REQUIRED",
        health: "HEALTHY",
      });
    });

    it("C: active receivable awaiting collection -> HEALTHY", async () => {
      expect(await rowFor(fixture.companyId, ids.c!)).toMatchObject({
        classification: "HEALTHY_ACTIVE_RECEIVABLE",
        health: "HEALTHY",
      });
    });

    it("D (Part I): physically collected -> HEALTHY ALREADY_PHYSICALLY_COLLECTED", async () => {
      expect(await rowFor(fixture.companyId, ids.d!)).toMatchObject({
        classification: "ALREADY_PHYSICALLY_COLLECTED",
        health: "HEALTHY",
      });
    });

    it("E (Part E): offset-settled without physical collection -> HEALTHY, never ISSUE", async () => {
      expect(await rowFor(fixture.companyId, ids.e!)).toMatchObject({
        classification: "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
        health: "HEALTHY",
        recommendedAction: "none",
      });
    });

    it("F (Part H): SET-A -> reversal -> SET-B is ONE effective AED 18 settlement -> HEALTHY", async () => {
      const row = await rowFor(fixture.companyId, ids.f!);
      expect(row).toMatchObject({
        classification: "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
        health: "HEALTHY",
        additionalReasonCodes: [],
      });
      const verification = await as(fixture, () =>
        get(OrderMaintenanceService).financialVerification(ids.f!),
      );
      expect(verification.settlementOffsetAmount).toBe("18.00");
      expect(verification.historicalSettlementOffsetAmount).toBe("18.00");
    });

    it("G: required receivable missing -> ISSUE MISSING_RECEIVABLE", async () => {
      expect(await rowFor(fixture.companyId, ids.g!)).toMatchObject({
        classification: "MISSING_RECEIVABLE",
        health: "ISSUE",
        reasonCode: "MISSING_RECEIVABLE",
        recommendedAction: "repair_trader_receivable",
      });
    });

    it("H: only a reversed receivable remains -> ISSUE REVERSED_NEEDS_REPAIR", async () => {
      expect(await rowFor(fixture.companyId, ids.h!)).toMatchObject({
        classification: "REVERSED_NEEDS_REPAIR",
        health: "ISSUE",
      });
    });

    it("I: two effective full offsets -> REVIEW (ambiguous), never HEALTHY", async () => {
      expect(await rowFor(fixture.companyId, ids.i!)).toMatchObject({
        classification: "NEEDS_REVIEW",
        health: "REVIEW",
        reasonCode: "MULTIPLE_EFFECTIVE_SETTLEMENTS",
      });
    });

    it("J (OFF): no Accounting finding when GL Accounting is OFF", async () => {
      const rows = await allRows(fixture.companyId);
      expect(
        rows.flatMap((row) => [row.reasonCode, ...row.additionalReasonCodes]).filter((code) =>
          code.startsWith("ACCOUNTING") || code === "ORDER_MISSING_ACCOUNTING_EVENT",
        ),
      ).toEqual([]);
      // A crafted payable Order with no Event at all, delivered while OFF: healthy state.
      const offPayable = await legacyOrderWithoutReceivable(fixture, { traderNetPayable: 40 });
      const row = await rowFor(fixture.companyId, offPayable);
      expect(row.reasonCode).toBe("MISSING_RECEIVABLE");
      expect(row.additionalReasonCodes).not.toContain("ORDER_MISSING_ACCOUNTING_EVENT");
    });

    it("K (Driver Cash): reconciled flag with no effective reconciliation -> REVIEW only", async () => {
      expect(await rowFor(fixture.companyId, ids.k!)).toMatchObject({
        classification: "DRIVER_CASH_INCONSISTENT",
        health: "REVIEW",
        reasonCode: "DRIVER_CASH_RECONCILED_WITHOUT_RECONCILIATION",
        recommendedAction: "review_driver_cash",
      });
      // A genuinely reconciled Order (A) is not flagged.
      expect((await rowFor(fixture.companyId, ids.a!)).additionalReasonCodes).toEqual([]);
    });

    it("parity: every receivable classification equals Verify First for the same Order", async () => {
      const rows = await allRows(fixture.companyId);
      expect(rows.length).toBeGreaterThan(10);
      for (const row of rows) {
        const verification = await as(fixture, () =>
          get(OrderMaintenanceService).financialVerification(row.orderId),
        );
        const receivableCode =
          row.classification === "DRIVER_CASH_INCONSISTENT" ||
          row.classification === "ACCOUNTING_FAILURE"
            ? undefined
            : row.classification;
        if (receivableCode !== undefined) {
          expect(receivableCode, row.orderNumber).toBe(verification.classification);
        }
        if (row.additionalReasonCodes.length === 0 && receivableCode !== undefined) {
          expect(row.health, row.orderNumber).toBe(verification.health);
        }
      }
    }, 120_000);

    it("Part L / T: summary counts equal the list, total = healthy + issue + review", async () => {
      const summary = await health.summary(fixture.companyId, { scope: "all" });
      const rows = await allRows(fixture.companyId);
      expect(summary.totalOrders).toBe(rows.length);
      expect(summary.totalOrders).toBe(
        summary.healthyOrders + summary.issueOrders + summary.reviewOrders,
      );
      expect(summary.issueOrders).toBe(rows.filter((row) => row.health === "ISSUE").length);
      expect(summary.reviewOrders).toBe(rows.filter((row) => row.health === "REVIEW").length);
      expect(summary.healthyOrders).toBe(rows.filter((row) => row.health === "HEALTHY").length);
      expect(summary.byReason.reduce((sum, item) => sum + item.orders, 0)).toBe(summary.totalOrders);
      expect(summary.companyHealth).toBe("ISSUE");
      expect(summary.accountingMode.enabled).toBe(false);
      expect(summary.company.id).toBe(fixture.companyId);
      for (const reason of summary.byReason) {
        expect(reason.orders).toBe(rows.filter((row) => row.reasonCode === reason.reasonCode).length);
      }
    });

    it("Part M: default list is ISSUE + REVIEW only, sorted ISSUE first; filters narrow correctly", async () => {
      const page = await health.list(fixture.companyId, { scope: "all" });
      expect(page.filter.health).toBe("attention");
      expect(page.items.every((row) => row.health !== "HEALTHY")).toBe(true);
      const severities = page.items.map((row) => (row.health === "ISSUE" ? 0 : 1));
      expect([...severities].sort()).toEqual(severities);
      const summary = await health.summary(fixture.companyId, { scope: "all" });
      expect(page.total).toBe(summary.issueOrders + summary.reviewOrders);

      const issues = await health.list(fixture.companyId, { health: "issue", scope: "all" });
      expect(issues.total).toBe(summary.issueOrders);
      expect(issues.items.every((row) => row.health === "ISSUE")).toBe(true);
      const healthy = await health.list(fixture.companyId, { health: "healthy", scope: "all" });
      expect(healthy.total).toBe(summary.healthyOrders);

      const byNumber = await health.list(fixture.companyId, {
        health: "all",
        scope: "all",
        search: (await orderNumber(ids.g!)).slice(2),
      });
      expect(byNumber.items.map((row) => row.orderId)).toEqual([ids.g]);

      const byReason = await health.list(fixture.companyId, {
        health: "all",
        reasonCode: "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
        scope: "all",
      });
      expect(byReason.items.map((row) => row.orderId).sort()).toEqual([ids.e, ids.f].sort());

      const delivered = await health.list(fixture.companyId, {
        deliveryStatus: "cancelled",
        health: "all",
        scope: "all",
      });
      expect(delivered.total).toBe(0);
    });

    it("Part M: pagination is applied in SQL and pages do not overlap", async () => {
      const all = await health.list(fixture.companyId, { health: "all", pageSize: 100, scope: "all" });
      const first = await health.list(fixture.companyId, { health: "all", page: 1, pageSize: 4, scope: "all" });
      const second = await health.list(fixture.companyId, { health: "all", page: 2, pageSize: 4, scope: "all" });
      expect(first.items).toHaveLength(4);
      expect(first.total).toBe(all.total);
      expect(second.total).toBe(all.total);
      const overlap = first.items.filter((row) =>
        second.items.some((other) => other.orderId === row.orderId),
      );
      expect(overlap).toEqual([]);
      expect([...first.items, ...second.items].map((row) => row.orderId)).toEqual(
        all.items.slice(0, 8).map((row) => row.orderId),
      );
      const beyond = await health.list(fixture.companyId, { health: "all", page: 999, pageSize: 4, scope: "all" });
      expect(beyond.items).toEqual([]);
      expect(beyond.total).toBe(all.total);
    });

    it("Part O / X: list rows carry no SET/RCV/JRN numbers, no UUID text and no customer PII", async () => {
      const page = await health.list(fixture.companyId, { health: "all", pageSize: 100, scope: "all" });
      for (const row of page.items) {
        expect(Object.keys(row).sort()).toEqual([
          "additionalReasonCodes",
          "classification",
          "deliveryStatus",
          "health",
          "orderDate",
          "orderId",
          "orderNumber",
          "reason",
          "reasonCode",
          "recommendedAction",
        ]);
        const visible = `${row.orderNumber} ${row.reason} ${row.reasonCode}`;
        expect(visible).not.toMatch(/SET-|RCV-|JRN-|JE-/u);
        expect(visible).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
        expect(JSON.stringify(row)).not.toMatch(/Customer|0501234567|971500000001|Address/u);
      }
    });

    it("Part Q / X: read-only -- no row written, no audit row, nothing persisted", async () => {
      const before = await writeFootprint(fixture.companyId);
      await health.summary(fixture.companyId, { scope: "all" });
      await health.list(fixture.companyId, { scope: "all" });
      await health.list(fixture.companyId, { health: "all", scope: "last30" });
      await as(fixture, () => get(OrderMaintenanceService).financialVerification(ids.e!));
      expect(await writeFootprint(fixture.companyId)).toEqual(before);
    });
  });

  describe("Accounting ON company (Part J)", () => {
    let fixture: Fixture;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      fixture = await createFixture("on");
      ids.healthy = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      // Crafted: delivered while ON with a Trader payable, capture never ran.
      ids.missing = randomUUID();
      await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,
        created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,
        payment_condition,cod_amount,service_fee,final_service_fee_snapshot,customer_provenance_status,
        pricing_provenance_status,customer_amount_due,trader_gross_payable,trader_paid_service_fee,
        trader_net_payable,trader_paid_amount,delivery_status,driver_reconciliation_status,
        trader_settlement_status,return_status,delivered_at)
      values (${ids.missing}::uuid,${fixture.companyId}::uuid,${`LEGON-${ids.missing.slice(0, 8)}`},
        current_date,${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,
        'Customer','971500000001','Address',1,'customer_pays_cod_and_fee',100,${FEE},${FEE},
        'legacy_unattributed','legacy_unattributed',100,100,${FEE},82,0,'delivered','not_applicable',
        'unsettled','not_applicable',now())`.execute(db);
      // Crafted: the Order's Accounting Event failed.
      ids.failed = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      await crafted(sql`update accounting_events set processing_status='failed', failed_at=now()
        where company_id=${fixture.companyId}::uuid and source_entity_type='order'
          and source_entity_id=${ids.failed}::uuid`);
    }, 600_000);

    it("a captured, unfailed Order is HEALTHY under Accounting ON", async () => {
      const row = await rowFor(fixture.companyId, ids.healthy!);
      expect(row.health).toBe("HEALTHY");
    });

    it("delivered while ON with no Accounting Event -> ISSUE ORDER_MISSING_ACCOUNTING_EVENT", async () => {
      expect(await rowFor(fixture.companyId, ids.missing!)).toMatchObject({
        classification: "ACCOUNTING_FAILURE",
        health: "ISSUE",
        reasonCode: "ORDER_MISSING_ACCOUNTING_EVENT",
        recommendedAction: "review_accounting",
      });
    });

    it("a failed Accounting Event while ON -> ISSUE ACCOUNTING_EVENT_FAILED", async () => {
      const events = await sql<{ n: number }>`select count(*)::int as n from accounting_events
        where company_id=${fixture.companyId}::uuid and source_entity_id=${ids.failed!}::uuid
          and processing_status='failed'`.execute(db);
      expect(events.rows[0]!.n).toBeGreaterThan(0);
      expect(await rowFor(fixture.companyId, ids.failed!)).toMatchObject({
        health: "ISSUE",
        reasonCode: "ACCOUNTING_EVENT_FAILED",
      });
    });

    it("summary reports Accounting ON", async () => {
      const summary = await health.summary(fixture.companyId, { scope: "all" });
      expect(summary.accountingMode.enabled).toBe(true);
      expect(summary.issueOrders).toBeGreaterThanOrEqual(2);
    });
  });


  // ---------------------------------------------------------------------------
  // EXACT A-L certification (production-derived scenarios, Phase 2 Prompt 1)
  // ---------------------------------------------------------------------------

  describe("EXACT A-L certification", () => {
    let off: Fixture;
    let on: Fixture;
    const ids: Record<string, string> = {};
    const receivables: Record<string, string> = {};

    beforeAll(async () => {
      off = await createFixture("off");
      on = await createFixture("on");
      // A: normal delivered order with a required, active receivable.
      ({ orderId: ids.a!, receivableId: receivables.a! } = await feeOrder(off));
      // B: valid physical Trader Collection.
      ({ orderId: ids.b!, receivableId: receivables.b! } = await feeOrder(off));
      await collectPhysically(off, receivables.b!);
      // C: valid effective settlement offset, no physical collection.
      ({ orderId: ids.c!, receivableId: receivables.c! } = await feeOrder(off));
      await settleWithOffset(off, receivables.c!);
      // D: SET-A offset -> SET-A reversal -> SET-B re-settlement.
      ({ orderId: ids.d!, receivableId: receivables.d! } = await feeOrder(off));
      const setA = await settleWithOffset(off, receivables.d!);
      await reverseSettlement(off, setA);
      await settleWithOffset(off, receivables.d!);
      // E: historical REVERSED receivable + valid current replacement.
      ({ orderId: ids.e!, receivableId: receivables.e! } = await feeOrder(off));
      await settleWithOffset(off, receivables.e!);
      await reverseReceivable(off, receivables.e!);
      expect(await repair(off, ids.e!)).toMatchObject({ created: true });
      // F: historical CANCELLED + historical REVERSED + valid current replacement.
      ({ orderId: ids.f!, receivableId: receivables.f! } = await feeOrder(off));
      await cancelReceivable(off, receivables.f!);
      expect(await repair(off, ids.f!)).toMatchObject({ created: true });
      const second = await activeReceivable(off, ids.f!);
      await settleWithOffset(off, second);
      await reverseReceivable(off, second);
      expect(await repair(off, ids.f!)).toMatchObject({ created: true });
      // G: COD legitimately covers the service fee (Trader pays fee).
      ids.g = await deliveredOrder(off, 100, "customer_pays_cod_trader_pays_fee");
      // H: Trader separately owes the fee, current receivable missing (crafted legacy).
      ids.h = await legacyOrderWithoutReceivable(off);
      // I: two genuinely CURRENT EFFECTIVE offsets (crafted duplicate).
      ({ orderId: ids.i!, receivableId: receivables.i! } = await feeOrder(off));
      await settleWithOffset(off, receivables.i!);
      await craftSecondEffectiveOffset(off, receivables.i!);
      // J: Accounting OFF, operationally valid, no accounting event or journal.
      ids.j = await deliveredOrder(off, 100, "customer_pays_cod_and_fee");
      await reconcileCash(off, ids.j);
      // K: Accounting ON, genuine unresolved accounting problem (crafted failed Event).
      ids.k = await deliveredOrder(on, 100, "customer_pays_cod_and_fee");
      await crafted(sql`update accounting_events set processing_status='failed', failed_at=now()
        where company_id=${on.companyId}::uuid and source_entity_type='order'
          and source_entity_id=${ids.k}::uuid`);
    }, 600_000);

    const verifyOff = (orderId: string) =>
      as(off, () => get(OrderMaintenanceService).financialVerification(orderId));

    it("A: delivered order with required active receivable -> HEALTHY", async () => {
      expect(await rowFor(off.companyId, ids.a!)).toMatchObject({
        classification: "HEALTHY_ACTIVE_RECEIVABLE",
        health: "HEALTHY",
        additionalReasonCodes: [],
      });
      expect((await verifyOff(ids.a!)).traderOwes).toBe("18.00");
    });

    it("B: valid physical Trader Collection -> HEALTHY", async () => {
      expect(await rowFor(off.companyId, ids.b!)).toMatchObject({
        classification: "ALREADY_PHYSICALLY_COLLECTED",
        health: "HEALTHY",
      });
      const verification = await verifyOff(ids.b!);
      expect(verification.physicalCollectionAmount).toBe("18.00");
      expect(verification.settlementOffsetAmount).toBe("0.00");
    });

    it("C: valid effective settlement offset, no physical collection -> HEALTHY (shared effective semantics)", async () => {
      expect(await rowFor(off.companyId, ids.c!)).toMatchObject({
        classification: "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
        health: "HEALTHY",
        recommendedAction: "none",
      });
      const verification = await verifyOff(ids.c!);
      expect(verification.physicalCollectionAmount).toBe("0.00");
      expect(verification.settlementOffsetAmount).toBe("18.00");
      expect(verification.settlementOffsets.map((offset) => offset.effective)).toEqual([true]);
      // Same rule as effective-settlement-offsets.ts, read directly.
      const effective = await sql<{ total: string }>`
        select ${effectiveOffsetTotal("r")}::text as total from trader_receivables r
         where r.id = ${receivables.c!}::uuid`.execute(db);
      expect(Number(effective.rows[0]!.total)).toBe(18);
    });

    it("D: SET-A -> reversal -> SET-B -> HEALTHY with exactly ONE effective settlement amount", async () => {
      expect(await rowFor(off.companyId, ids.d!)).toMatchObject({
        classification: "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
        health: "HEALTHY",
        additionalReasonCodes: [],
      });
      const verification = await verifyOff(ids.d!);
      expect(verification.settlementOffsetAmount).toBe("18.00");
      expect(verification.historicalSettlementOffsetAmount).toBe("18.00");
      expect(verification.settlementNumbers).toHaveLength(1);
      expect(verification.historicalSettlementNumbers).toHaveLength(1);
      const effective = await sql<{ total: string; settlements: number }>`
        select ${effectiveOffsetTotal("r")}::text as total,
               ${effectiveSettlementCount("r")} as settlements
          from trader_receivables r where r.id = ${receivables.d!}::uuid`.execute(db);
      expect(Number(effective.rows[0]!.total)).toBe(18);
      expect(effective.rows[0]!.settlements).toBe(1);
    });

    it("E: historical REVERSED receivable + valid current replacement -> HEALTHY, no false issue", async () => {
      expect(await receivableStatuses(off, ids.e!)).toEqual(["outstanding", "reversed"]);
      expect(await rowFor(off.companyId, ids.e!)).toMatchObject({
        classification: "HEALTHY_ACTIVE_RECEIVABLE",
        health: "HEALTHY",
        additionalReasonCodes: [],
      });
    });

    it("F: historical CANCELLED + historical REVERSED + valid current replacement -> HEALTHY, no false issue", async () => {
      expect(await receivableStatuses(off, ids.f!)).toEqual(["cancelled", "outstanding", "reversed"]);
      expect(await rowFor(off.companyId, ids.f!)).toMatchObject({
        classification: "HEALTHY_ACTIVE_RECEIVABLE",
        health: "HEALTHY",
        additionalReasonCodes: [],
      });
    });

    it("G: COD legitimately covers the service fee -> HEALTHY, no receivable required (order financial model)", async () => {
      const order = (
        await sql<{ cod: string; fee: string; condition: string }>`
          select cod_amount::text as cod, service_fee::text as fee, payment_condition as condition
            from orders where id=${ids.g!}::uuid`.execute(db)
      ).rows[0]!;
      const due = calculateOrderFinancials({
        codAmount: new Decimal(order.cod),
        driverCost: new Decimal(0),
        paymentCondition: order.condition as "customer_pays_cod_trader_pays_fee",
        prospective: true,
        serviceFee: new Decimal(order.fee),
        vatPolicy: { enabled: false, priceMode: null, rate: new Decimal(0) },
      }).traderReceivableDue;
      expect(order.condition).toBe("customer_pays_cod_trader_pays_fee");
      expect(Number(order.fee)).toBeGreaterThan(0);
      expect(due.toFixed(2)).toBe("0.00");
      expect(await receivableStatuses(off, ids.g!)).toEqual([]);
      expect(await rowFor(off.companyId, ids.g!)).toMatchObject({
        classification: "NO_TRADER_RECEIVABLE_REQUIRED",
        health: "HEALTHY",
      });
    });

    it("H: Trader owes the fee but the current receivable is missing -> ISSUE", async () => {
      expect(await rowFor(off.companyId, ids.h!)).toMatchObject({
        classification: "MISSING_RECEIVABLE",
        health: "ISSUE",
        reasonCode: "MISSING_RECEIVABLE",
      });
    });

    it("I: two CURRENT EFFECTIVE offsets -> REVIEW per the certified Phase 1 rule, never HEALTHY", async () => {
      const verification = await verifyOff(ids.i!);
      expect(verification).toMatchObject({ classification: "NEEDS_REVIEW", health: "REVIEW" });
      expect(verification.settlementOffsets.every((offset) => offset.effective)).toBe(true);
      const row = await rowFor(off.companyId, ids.i!);
      expect(row).toMatchObject({ health: verification.health, reasonCode: "MULTIPLE_EFFECTIVE_SETTLEMENTS" });
      expect(row.health).not.toBe("HEALTHY");
    });

    it("J: Accounting OFF, operationally valid, no accounting event or journal -> HEALTHY", async () => {
      const artifacts = await sql<{ events: number; journals: number }>`
        select (select count(*)::int from accounting_events
                 where company_id=${off.companyId}::uuid and source_entity_id=${ids.j!}::uuid) as events,
               (select count(*)::int from journal_entries j join accounting_events e on e.id=j.accounting_event_id
                 where j.company_id=${off.companyId}::uuid and e.source_entity_id=${ids.j!}::uuid) as journals
      `.execute(db);
      expect(artifacts.rows[0]).toEqual({ events: 0, journals: 0 });
      expect((await health.summary(off.companyId, {})).accountingMode.enabled).toBe(false);
      expect(await rowFor(off.companyId, ids.j!)).toMatchObject({
        health: "HEALTHY",
        additionalReasonCodes: [],
      });
    });

    it("K: Accounting ON with a genuine unresolved accounting problem -> ISSUE (deterministic rule)", async () => {
      expect((await health.summary(on.companyId, {})).accountingMode.enabled).toBe(true);
      expect(await rowFor(on.companyId, ids.k!)).toMatchObject({
        classification: "ACCOUNTING_FAILURE",
        health: "ISSUE",
        reasonCode: "ACCOUNTING_EVENT_FAILED",
      });
    });

    it("L: two Companies with the SAME order number -> scanning/verifying A never returns B data", async () => {
      const a = await createFixture("off");
      const b = await createFixture("off");
      const aOrder = await feeOrder(a);
      const bOrder = await feeOrder(b);
      const number = await orderNumber(aOrder.orderId);
      expect(await orderNumber(bOrder.orderId)).toBe(number);
      // Company B's copy is corrupt: duplicate effective offset + reversed history.
      await settleWithOffset(b, bOrder.receivableId);
      await craftSecondEffectiveOffset(b, bOrder.receivableId);

      const aRows = await allRows(a.companyId);
      expect(aRows.map((row) => row.orderId)).toEqual([aOrder.orderId]);
      expect(aRows[0]).toMatchObject({
        classification: "HEALTHY_ACTIVE_RECEIVABLE",
        health: "HEALTHY",
        orderNumber: number,
      });
      const bySearch = await health.list(a.companyId, { health: "all", scope: "all", search: number });
      expect(bySearch.items.map((row) => row.orderId)).toEqual([aOrder.orderId]);
      expect(await health.summary(a.companyId, { scope: "all" })).toMatchObject({
        issueOrders: 0,
        reviewOrders: 0,
        totalOrders: 1,
      });

      const verifyA = await as(a, () => get(OrderMaintenanceService).financialVerification(aOrder.orderId));
      expect(verifyA.receivables.map((row) => row.id)).toEqual([aOrder.receivableId]);
      expect(verifyA.settlementOffsets).toEqual([]);
      expect(verifyA.settlementOffsetAmount).toBe("0.00");
      let refused: unknown;
      try {
        await as(a, () => get(OrderMaintenanceService).financialVerification(bOrder.orderId));
      } catch (error) {
        refused = error;
      }
      expect((refused as ApplicationException).getStatus()).toBe(404);
      // Company B, scanned on its own, does show its own problem.
      expect((await rowFor(b.companyId, bOrder.orderId)).health).toBe("REVIEW");
    });
  });

  it("Part N: date scopes use the Order date; summary and list share the same scope", async () => {
    const fixture = await createFixture("off");
    const ages = { today: 0, five: 5, twenty: 20, hundred: 100 } as const;
    const dateOf = async (days: number) =>
      (
        await sql<{ d: string }>`select ((now() at time zone 'Asia/Dubai')::date - ${days}::int)::text as d`.execute(
          db,
        )
      ).rows[0]!.d;
    for (const days of Object.values(ages)) {
      await legacyOrderWithoutReceivable(fixture, { orderDate: await dateOf(days) });
    }
    const counts = async (input: Parameters<CompanyOrderHealthService["summary"]>[1]) => {
      const summary = await health.summary(fixture.companyId, input);
      const list = await health.list(fixture.companyId, { ...input, health: "all" });
      expect(list.total).toBe(summary.totalOrders);
      expect(list.scope).toEqual(summary.scope);
      return summary.totalOrders;
    };
    expect(await counts({ scope: "today" })).toBe(1);
    expect(await counts({ scope: "last7" })).toBe(2);
    expect(await counts({})).toBe(3); // Last 30 days is the default.
    expect(await counts({ scope: "all" })).toBe(4);
    expect(
      await counts({ dateFrom: await dateOf(100), dateTo: await dateOf(20), scope: "custom" }),
    ).toBe(2);
    const summary = await health.summary(fixture.companyId, {});
    expect(summary.scope).toMatchObject({ dateBasis: "order_date", scope: "last30" });
  });

  it("Part V: tenant isolation -- another Company's corrupt twin never leaks in", async () => {
    const a = await createFixture("off");
    const b = await createFixture("off");
    const aOrder = await feeOrder(a);
    const bOrder = await feeOrder(b);
    // Same sequence in two fresh Companies -> identical Order numbers.
    expect(await orderNumber(aOrder.orderId)).toBe(await orderNumber(bOrder.orderId));
    await settleWithOffset(b, bOrder.receivableId);
    await craftSecondEffectiveOffset(b, bOrder.receivableId);
    await legacyOrderWithoutReceivable(b);

    const aRows = await allRows(a.companyId);
    expect(aRows.map((row) => row.orderId).sort()).toEqual([aOrder.orderId]);
    expect(aRows[0]).toMatchObject({ classification: "HEALTHY_ACTIVE_RECEIVABLE", health: "HEALTHY" });
    const aSummary = await health.summary(a.companyId, { scope: "all" });
    expect(aSummary).toMatchObject({ issueOrders: 0, reviewOrders: 0, totalOrders: 1 });

    const bSummary = await health.summary(b.companyId, { scope: "all" });
    expect(bSummary.issueOrders + bSummary.reviewOrders).toBeGreaterThanOrEqual(2);
    expect((await allRows(b.companyId)).some((row) => row.orderId === aOrder.orderId)).toBe(false);

    // View Details inside Company A cannot reach Company B's Order.
    let refused: unknown;
    try {
      await as(a, () => get(OrderMaintenanceService).financialVerification(bOrder.orderId));
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ApplicationException);
    expect((refused as ApplicationException).getStatus()).toBe(404);

    // An unknown Company is a 404, never an empty "healthy" answer.
    await expect(health.summary(randomUUID(), {})).rejects.toBeInstanceOf(ApplicationException);
  });

  it("Part G: the SQL Trader receivable due equals the order financial model", async () => {
    const policies = [
      { enabled: false, priceMode: null, rate: "0" },
      { enabled: true, priceMode: "exclusive", rate: "5" },
      { enabled: true, priceMode: "inclusive", rate: "5" },
      { enabled: true, priceMode: "exclusive", rate: "0" },
      { enabled: true, priceMode: "inclusive", rate: "7.5" },
    ] as const;
    const conditions = ["customer_pays_cod_and_fee", "customer_pays_cod_trader_pays_fee"] as const;
    const fees = ["0", "10", "18", "18.5", "33.33"];
    const cods = ["0", "5", "18", "18.9", "100"];
    const additional = [null, "0", "2.5", "7"];
    const cases: { condition: string; fee: string; cod: string; add: string | null; p: number }[] = [];
    policies.forEach((_, p) => {
      for (const condition of conditions)
        for (const fee of fees)
          for (const cod of cods) for (const add of additional) cases.push({ add, cod, condition, fee, p });
    });
    const values = sql.join(
      cases.map(
        (c, index) =>
          sql`(${index}::int, null::uuid, ${c.condition}::text, ${c.cod}::numeric, ${c.fee}::numeric, ${c.add}::numeric,
               ${policies[c.p]!.enabled}::boolean, ${policies[c.p]!.priceMode}::text, ${policies[c.p]!.rate}::numeric)`,
      ),
    );
    // company_id is null: no Company, so the COD-shortfall switch is off.
    const result = await sql<{ index: number; due: string }>`
      select o.index, (${traderReceivableDueSql()})::text as due
        from (values ${values}) as o(index, company_id, payment_condition, cod_amount, service_fee, additional_fees,
                                     enabled, price_mode, rate)
        cross join lateral (select o.enabled, o.price_mode, o.rate) vat
    `.execute(db);
    expect(result.rows).toHaveLength(cases.length);
    for (const row of result.rows) {
      const c = cases[row.index]!;
      const policy = policies[c.p]!;
      const vatPolicy = {
        enabled: policy.enabled,
        priceMode: policy.priceMode,
        rate: new Decimal(policy.rate),
      };
      for (const prospective of [true, false]) {
        const expected = calculateOrderFinancials({
          additionalFees: new Decimal(c.add ?? 0),
          codAmount: new Decimal(c.cod),
          driverCost: new Decimal(0),
          paymentCondition: c.condition as "customer_pays_cod_trader_pays_fee",
          prospective,
          serviceFee: new Decimal(c.fee),
          vatPolicy,
        }).traderReceivableDue;
        expect(new Decimal(row.due).toFixed(2), JSON.stringify({ ...c, prospective })).toBe(
          expected.toFixed(2),
        );
      }
    }
  });

  it("Part C / U: a fixed number of statements per request, whatever the Company size", async () => {
    let statements = 0;
    const counting = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === "query") statements += 1;
      },
    });
    const service = new CompanyOrderHealthService(counting);
    const small = await createFixture("off");
    await legacyOrderWithoutReceivable(small);
    const large = await createFixture("off");
    for (let index = 0; index < 12; index += 1) await feeOrder(large);
    await legacyOrderWithoutReceivable(large);

    const measure = async (work: () => Promise<unknown>) => {
      statements = 0;
      await work();
      return statements;
    };
    const smallSummary = await measure(() => service.summary(small.companyId, { scope: "all" }));
    const largeSummary = await measure(() => service.summary(large.companyId, { scope: "all" }));
    const smallList = await measure(() => service.list(small.companyId, { health: "all", scope: "all" }));
    const largeList = await measure(() => service.list(large.companyId, { health: "all", scope: "all" }));
    // begin + set read only + statement_timeout + context + ONE evaluation
    // statement + commit -- independent of the number of Orders (no N+1).
    expect(smallSummary).toBe(6);
    expect(largeSummary).toBe(6);
    expect(smallList).toBe(6);
    expect(largeList).toBe(6);
  });
});
