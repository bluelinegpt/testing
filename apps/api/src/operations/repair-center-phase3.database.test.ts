import { createHash, randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { CashBankManagementService } from "../accounting/cash-bank-management.service.js";
import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { markTraderDeductionV1Order } from "./order-obligation-snapshot.fixture.js";
import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import { OperationsService } from "./operations.service.js";
import { ReceivableOffsetReversalService } from "./receivable-offset-reversal.service.js";
import { type RepairExecutionRequest, RepairExecutionService } from "./repair-execution.service.js";
import { RepairPreviewService } from "./repair-preview.service.js";
import { TraderReceivableService } from "./trader-receivable.service.js";
import { TraderSettlementService } from "./trader-settlement.service.js";
import { OrderMaintenanceService } from "./order-maintenance.service.js";

/**
 * REPAIR CENTER PHASE 3 -- PROMPT 1: Trader receivable / collection /
 * settlement reconciliation certification (test matrix 1-25).
 *
 * Same construction as the Phase 2 execution suite: REAL services against the
 * disposable database (AppModule compiled), "crafted" rows only for states no
 * service produces on purpose. Every Order is checked through BOTH readers of
 * THE reconciliation decision (trader-receivable-reconciliation.ts): Company /
 * Order Health (via the Repair Center analysis) and Verify First. Executions
 * run as a Platform administrator inside the target Company.
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

describe.skipIf(!runDatabaseTests)("Repair Center Phase 3 -- Trader financial reconciliation", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let store: RequestSecurityContextStore;
  let get: <T>(type: new (...args: never[]) => T) => T;
  let previews: RepairPreviewService;
  let executions: RepairExecutionService;
  const adminId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(db)
      .compile();
    get = (type) => module.get(type, { strict: false });
    store = module.get(RequestSecurityContextStore, { strict: false });
    previews = get(RepairPreviewService);
    executions = get(RepairExecutionService);
    await sql`insert into accounts (id, company_id, account_kind, username, password_hash, status)
      values (${adminId}::uuid, null, 'platform_administrator', ${`rc.exec.${adminId}`}, 'x', 'disabled')`.execute(db);
    await sql`insert into emirates(code,name_en,name_ar,display_order)
      values ('DXB','DXB','DXB',200) on conflict (code) do nothing`.execute(db);
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  // ---------------------------------------------------------------------------
  // Fixture helpers (same construction as the Company Order Health suite)
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

  const key = (label: string) => `execution.${label}.${randomUUID()}`;

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`EXEC-${tag}`},${`exec-${tag}`},${`Exec ${mode} ${tag}`},
              'active',now())`.execute(db);
    const actorId = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${actorId}::uuid,${companyId}::uuid,'company_user',${`preview.${actorId}`},'x','disabled')`.execute(
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

  async function reverseReceivable(fixture: Fixture, receivableId: string) {
    await as(fixture, () =>
      get(ReceivableOffsetReversalService).execute(receivableId, "Fee reset", randomUUID()),
    );
  }

  async function repair(fixture: Fixture, orderId: string) {
    return as(fixture, () => get(OperationsService).repairTraderReceivable(orderId, randomUUID()));
  }

  /**
   * Crafted: a delivered Trader-pays-fee Order (trader_deduction_v1, VAT off, its
   * obligation snapshot stored) that never got its Receivable. Phase 3 Prompt 4:
   * a true legacy Order (no snapshot) is never repaired automatically.
   */
  async function legacyOrderWithoutReceivable(
    fixture: Fixture,
    options: { orderDate?: string; traderNetPayable?: number; codAmount?: number } = {},
  ): Promise<string> {
    const orderId = randomUUID();
    await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,
      created_by_account_id,customer_name,customer_mobile_number,
      customer_address,package_count,payment_condition,cod_amount,service_fee,final_service_fee_snapshot,
      customer_provenance_status,pricing_provenance_status,customer_amount_due,trader_gross_payable,
      trader_paid_service_fee,trader_net_payable,trader_paid_amount,delivery_status,
      driver_reconciliation_status,trader_settlement_status,return_status,delivered_at)
    values (${orderId}::uuid,${fixture.companyId}::uuid,${`LEG-${orderId.slice(0, 8)}`},
      ${options.orderDate ?? today}::date,
      ${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,
      'Customer','971500000001','Address',1,
      'customer_pays_cod_trader_pays_fee',${options.codAmount ?? 0},${FEE},${FEE},
      'legacy_unattributed','legacy_unattributed',
      0,0,${FEE},${options.traderNetPayable ?? 0},0,'delivered','not_applicable','not_eligible',
      'not_applicable',now())`.execute(db);
    await markTraderDeductionV1Order(db, orderId);
    return orderId;
  }

  /** Crafted (disposable DB only): bypasses triggers for one statement. */
  async function crafted(statement: ReturnType<typeof sql>) {
    await db.transaction().execute(async (transaction) => {
      await sql`set local session_replication_role = replica`.execute(transaction);
      await statement.execute(transaction);
    });
  }

  /** Content checksum of every table a repair could touch, for one Company. */
  async function footprint(companyId: string): Promise<string> {
    const tables = [
      "orders",
      "trader_receivables",
      "trader_collection_allocations",
      "trader_collections",
      "trader_settlement_receivable_offsets",
      "trader_settlements",
      "trader_credits",
      "accounting_events",
      "journal_entries",
      "driver_reconciliations",
      "driver_reconciliation_orders",
      "order_events",
      "audit_events",
      "order_maintenance_findings",
      "platform_repair_executions",
    ];
    const parts: string[] = [];
    for (const table of tables) {
      const result = await sql<{ digest: string | null; n: number }>`
        select count(*)::int as n, md5(string_agg(t::text, '|' order by t::text)) as digest
          from ${sql.table(table)} t where t.company_id = ${companyId}::uuid`.execute(db);
      parts.push(`${table}:${result.rows[0]!.n}:${result.rows[0]!.digest ?? "-"}`);
    }
    return createHash("sha256").update(parts.join("\n")).digest("hex");
  }

  // ---------------------------------------------------------------------------
  // Execution helpers
  // ---------------------------------------------------------------------------

  /** A Platform administrator acting inside the target Company (as over HTTP). */
  function asPlatform<T>(companyId: string, work: () => Promise<T>) {
    return store.run(
      {
        identity: {
          companyId: null,
          forcePasswordChange: false,
          identityId: adminId,
          kind: "platform_administrator",
          permissions: new Set([
            "platform.access",
            "platform.companies.read",
            "platform.companies.repair_center.read",
            "platform.companies.repair_center.execute",
          ]),
          sessionId: randomUUID(),
        },
        tenant: { companyId, identityId: adminId },
      } as never,
      work,
    );
  }

  const actor = () => ({
    accountId: adminId,
    authority: "platform.companies.repair_center.execute",
    correlationId: `rc-exec-${randomUUID()}`,
  });

  /** The request a reviewer would send after looking at the current preview. */
  async function requestFor(
    fixture: Fixture,
    orderId: string,
    overrides: Partial<RepairExecutionRequest> = {},
  ): Promise<RepairExecutionRequest> {
    const preview = await previews.preview(fixture.companyId, orderId);
    return {
      capabilityCode: preview.proposedRepair?.capabilityCode ?? "REPAIR_TRADER_RECEIVABLE",
      findingId: preview.finding.findingId,
      idempotencyKey: `rc-exec-${randomUUID()}`,
      previewVersion: preview.previewVersion,
      reason: "Legacy order never received its Trader receivable",
      ...overrides,
    };
  }

  function run(fixture: Fixture, orderId: string, request: RepairExecutionRequest) {
    return asPlatform(fixture.companyId, () =>
      executions.execute(fixture.companyId, orderId, request, actor()),
    );
  }

  /** Expects a refusal with `errorCode` and proves nothing at all changed. */
  async function refused(fixture: Fixture, orderId: string, request: RepairExecutionRequest, errorCode: string) {
    const before = await footprint(fixture.companyId);
    await expect(run(fixture, orderId, request)).rejects.toMatchObject({ errorCode });
    expect(await footprint(fixture.companyId), "a refused execution must not mutate anything").toBe(before);
  }

  async function audits(fixture: Fixture, orderId: string) {
    return (
      await sql<{ id: string; actor: string; reason: string; capability: string; result: string }>`
        select id, actor_account_id as actor, reason, capability_code as capability, result
          from platform_repair_executions
         where company_id = ${fixture.companyId}::uuid and order_id = ${orderId}::uuid`.execute(db)
    ).rows;
  }

  async function companyCount(table: "accounting_events" | "journal_entries", companyId: string) {
    return (
      await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}
        where company_id = ${companyId}::uuid`.execute(db)
    ).rows[0]!.n;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Phase 3 helpers
  // ---------------------------------------------------------------------------

  async function collect(fixture: Fixture, receivableId: string, amount: number) {
    await as(fixture, () =>
      get(TraderReceivableService).confirmCollection(
        {
          allocations: [{ amount, receivableId }],
          amountReceived: amount,
          paymentDate: today,
          paymentMethod: "cash",
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("collection"),
      ),
    );
  }

  async function cancelReceivable(fixture: Fixture, receivableId: string) {
    await as(fixture, () =>
      get(TraderReceivableService).cancelReceivable(receivableId, { reason: "Raised in error" } as never, randomUUID()),
    );
  }

  /** Both readers of the shared decision, for one Order. */
  async function verdict(fixture: Fixture, orderId: string) {
    const analysis = await asPlatform(fixture.companyId, () => previews.analyze(fixture.companyId, orderId));
    const verify = await as(fixture, () => get(OrderMaintenanceService).financialVerification(orderId));
    const primary = analysis.findings[0]!;
    return { analysis, primary, verify };
  }

  async function expectHealthy(fixture: Fixture, orderId: string, code: string) {
    const { analysis, primary, verify } = await verdict(fixture, orderId);
    expect({ code: primary.reasonCode, health: analysis.health, repairability: primary.repairability }).toEqual({
      code,
      health: "HEALTHY",
      repairability: "NOT_REQUIRED",
    });
    expect(verify.health).toBe("HEALTHY");
    return { analysis, verify };
  }

  async function expectFinding(
    fixture: Fixture,
    orderId: string,
    code: string,
    health: "ISSUE" | "REVIEW",
    repairability: "READY" | "BLOCKED" | "MANUAL_REVIEW",
  ) {
    const { analysis, primary, verify } = await verdict(fixture, orderId);
    expect({ code: primary.reasonCode, health: analysis.health, repairability: primary.repairability }).toEqual({
      code,
      health,
      repairability,
    });
    // Verify First reaches the SAME verdict through the SAME decision.
    expect(verify.health).toBe(health);
    if (code !== "MISSING_RECEIVABLE" && code !== "REVERSED_NEEDS_REPAIR" && code !== "MULTIPLE_ACTIVE_RECEIVABLES") {
      expect(verify.anomalyCode).toBe(code);
    }
    return { analysis, primary, verify };
  }

  async function currentReceivable(fixture: Fixture, orderId: string) {
    return (
      await sql<{ id: string; status: string; amountCollected: string; amountDue: string }>`
        select id, status, amount_collected::text as "amountCollected", original_amount_due::text as "amountDue"
          from trader_receivables
         where company_id = ${fixture.companyId}::uuid and source_type = 'service_charge'
           and source_reference = ${await orderNumber(orderId)} and status not in ('reversed', 'cancelled')`.execute(db)
    ).rows;
  }

  async function secondTrader(fixture: Fixture): Promise<string> {
    const traderId = randomUUID();
    await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,created_by_account_id)
      values (${traderId}::uuid,${fixture.companyId}::uuid,${`T2-${traderId.slice(0, 6)}`},'Other Trader',
              '971500000099',${fixture.areaId}::uuid,${fixture.actorId}::uuid)`.execute(db);
    return traderId;
  }

  /** Crafted: a confirmed Trader Collection of `traderId` allocated to `receivableId`. */
  async function craftForeignAllocation(fixture: Fixture, traderId: string, receivableId: string, amount: number) {
    const collectionId = randomUUID();
    await crafted(sql`insert into trader_collections(id,company_id,collection_number,trader_id,payment_date,
        payment_method,amount_received,status,received_by_account_id)
      values (${collectionId}::uuid,${fixture.companyId}::uuid,${`COL-X${collectionId.slice(0, 6)}`},
        ${traderId}::uuid,current_date,'cash',${amount},'confirmed',${fixture.actorId}::uuid)`);
    await crafted(sql`insert into trader_collection_allocations(company_id,collection_id,receivable_id,amount_allocated)
      values (${fixture.companyId}::uuid,${collectionId}::uuid,${receivableId}::uuid,${amount})`);
    return collectionId;
  }

  /** Crafted: an EFFECTIVE offset from a confirmed Settlement of `traderId`. */
  async function craftOffset(fixture: Fixture, traderId: string, receivableId: string, amount: number) {
    const settlementId = randomUUID();
    await crafted(sql`insert into trader_settlements(id,company_id,settlement_number,trader_id,business_date,
        gross_payable,service_fee_deductions,other_deductions,charges,adjustments,net_payable,status,
        created_by_account_id,confirmed_by_account_id,confirmed_at)
      values (${settlementId}::uuid,${fixture.companyId}::uuid,${`SET-X${settlementId.slice(0, 6)}`},
        ${traderId}::uuid,current_date,${amount},0,${amount},0,0,0,'confirmed',
        ${fixture.actorId}::uuid,${fixture.actorId}::uuid,now())`);
    await crafted(sql`insert into trader_settlement_receivable_offsets(company_id,settlement_id,receivable_id,amount_allocated)
      values (${fixture.companyId}::uuid,${settlementId}::uuid,${receivableId}::uuid,${amount})`);
    return settlementId;
  }

  async function attempts(fixture: Fixture, orderId: string) {
    return (
      await sql<{ result: string; code: string | null }>`
        select result, error_code as code from platform_repair_attempts
         where company_id = ${fixture.companyId}::uuid and entity_id = ${orderId}::uuid order by created_at`.execute(db)
    ).rows;
  }

  // ---------------------------------------------------------------------------
  // The matrix
  // ---------------------------------------------------------------------------

  describe("Accounting OFF company", () => {
    let fixture: Fixture;
    let companyB: Fixture;
    let bBefore = "";
    beforeAll(async () => {
      fixture = await createFixture("off");
      companyB = await createFixture("off");
      // Company B carries the same kinds of state; it must never change.
      const b1 = await feeOrder(companyB);
      await settleWithOffset(companyB, b1.receivableId);
      const b2 = await feeOrder(companyB);
      await crafted(sql`update trader_receivables set status = 'collected' where id = ${b2.receivableId}::uuid`);
      bBefore = await footprint(companyB.companyId);
    }, 240_000);

    afterAll(async () => {
      // MATRIX 24: Company B unchanged by every Company A diagnosis, preview and repair.
      expect(await footprint(companyB.companyId)).toBe(bBefore);
    });

    it("MATRIX 1: a valid physical collection -> HEALTHY", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, FEE);
      const { verify } = await expectHealthy(fixture, orderId, "ALREADY_PHYSICALLY_COLLECTED");
      expect(verify.physicalCollectionAmount).toBe("18.00");
    });

    it("MATRIX 2 / ORD-000108 pattern: a valid settlement offset only, no physical collection -> HEALTHY, no repair", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      const { analysis } = await expectHealthy(fixture, orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
      expect(analysis.findings.every((finding) => finding.repairability === "NOT_REQUIRED")).toBe(true);
      const preview = await asPlatform(fixture.companyId, () => previews.preview(fixture.companyId, orderId));
      expect(preview.execution.available).toBe(false);
      expect(preview.proposedRepair).toBeNull();
    });

    it("ORD-000111 pattern: the same principle with a settlement that also pays another order -> HEALTHY", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId, FEE);
      const other = await feeOrder(fixture);
      await settleWithOffset(fixture, other.receivableId, FEE);
      await expectHealthy(fixture, orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
      await expectHealthy(fixture, other.orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
    });

    it("MATRIX 3: a partial collection -> HEALTHY with the correct outstanding", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, 10);
      await expectHealthy(fixture, orderId, "HEALTHY_ACTIVE_RECEIVABLE");
      const [row] = await currentReceivable(fixture, orderId);
      expect(row).toMatchObject({ amountCollected: "10.00", status: "partially_collected" });
      const outstanding = (await sql<{ o: string }>`select outstanding_amount::text as o from trader_receivables where id = ${receivableId}::uuid`.execute(db)).rows[0]!.o;
      expect(outstanding).toBe("8.00");
    });

    it("MATRIX 4: a collection + an offset that together settle it -> HEALTHY, outstanding 0", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, 10);
      await settleWithOffset(fixture, receivableId, 8);
      const { verify } = await expectHealthy(fixture, orderId, "SETTLED_BY_COLLECTION_AND_OFFSET");
      expect({ physical: verify.physicalCollectionAmount, offset: verify.settlementOffsetAmount }).toEqual({ offset: "8.00", physical: "10.00" });
      expect((await currentReceivable(fixture, orderId))[0]).toMatchObject({ amountCollected: "18.00", status: "collected" });
    });

    it("MATRIX 5 + 17: a missing required receivable -> ISSUE, READY with Accounting OFF, repaired deterministically", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      await expectFinding(fixture, orderId, "MISSING_RECEIVABLE", "ISSUE", "READY");
      const result = await run(fixture, orderId, await requestFor(fixture, orderId));
      expect(result).toMatchObject({ afterHealth: "HEALTHY", capabilityCode: "REPAIR_TRADER_RECEIVABLE" });
      expect(await companyCount("accounting_events", fixture.companyId)).toBeGreaterThanOrEqual(0);
    });

    it("MATRIX 6 / ORD-000088 pattern: COD covers the fee -> HEALTHY / NO_TRADER_RECEIVABLE_REQUIRED", async () => {
      const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_trader_pays_fee");
      await expectHealthy(fixture, orderId, "NO_TRADER_RECEIVABLE_REQUIRED");
      expect(await currentReceivable(fixture, orderId)).toHaveLength(0);
    });

    it("MATRIX 7 / ORD-000110 pattern: an old receivable reversed (with its Credit) + an active replacement settled by a valid offset -> HEALTHY", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      await reverseReceivable(fixture, receivableId);
      await repair(fixture, orderId);
      const [replacement] = await currentReceivable(fixture, orderId);
      await settleWithOffset(fixture, replacement!.id);
      const { analysis } = await expectHealthy(fixture, orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
      expect(analysis.dependencies.historical.some((node) => node.entityType === "trader_receivable")).toBe(true);
    });

    it("ORD-000008 pattern: a cancelled receivable + a replacement fully settled by an effective offset -> HEALTHY", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await cancelReceivable(fixture, receivableId);
      // Crafted: the replacement the pre-fix repair used to create beside a cancelled one.
      const replacementId = randomUUID();
      await crafted(sql`insert into trader_receivables(id,company_id,receivable_number,trader_id,source_type,
          source_reference,business_date,original_amount_due,status,reason,created_by_account_id)
        values (${replacementId}::uuid,${fixture.companyId}::uuid,${`RCV-R${replacementId.slice(0, 6)}`},
          ${fixture.traderId}::uuid,'service_charge',${await orderNumber(orderId)},current_date,${FEE},'outstanding',
          'Order service fee owed by Trader',${fixture.actorId}::uuid)`);
      await settleWithOffset(fixture, replacementId);
      await expectHealthy(fixture, orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
    });

    it("MATRIX 8 / ORD-000100 pattern: historical reversed offsets are ignored; the current effective settlement is valid -> HEALTHY, no repair", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      const setA = await settleWithOffset(fixture, receivableId);
      await reverseSettlement(fixture, setA);
      const setB = await settleWithOffset(fixture, receivableId);
      await reverseSettlement(fixture, setB);
      await settleWithOffset(fixture, receivableId);
      const { verify } = await expectHealthy(fixture, orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
      expect(verify.settlementOffsetAmount).toBe("18.00");
      expect(verify.historicalSettlementOffsetAmount).toBe("36.00");
    });

    it("MATRIX 9: a duplicate active receivable -> REVIEW (MULTIPLE_ACTIVE_RECEIVABLES), never auto-repaired; a reversed one is not a duplicate", async () => {
      const { orderId } = await feeOrder(fixture);
      const duplicateId = randomUUID();
      await crafted(sql`insert into trader_receivables(id,company_id,receivable_number,trader_id,source_type,
          source_reference,business_date,original_amount_due,status,reason,created_by_account_id)
        values (${duplicateId}::uuid,${fixture.companyId}::uuid,${`RCV-D${duplicateId.slice(0, 6)}`},
          ${fixture.traderId}::uuid,'service_charge',${await orderNumber(orderId)},current_date,${FEE},'outstanding',
          'Duplicate',${fixture.actorId}::uuid)`);
      await expectFinding(fixture, orderId, "MULTIPLE_ACTIVE_RECEIVABLES", "REVIEW", "MANUAL_REVIEW");
    });

    it("MATRIX 10: an amount mismatch on a receivable with financial activity -> ISSUE (RECEIVABLE_AMOUNT_MISMATCH), MANUAL_REVIEW (no re-amount)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      // Phase 3 Prompt 3: money has touched it, so it is never replaced automatically.
      await collect(fixture, receivableId, 5);
      await crafted(sql`update trader_receivables set original_amount_due = 25 where id = ${receivableId}::uuid`);
      const { primary } = await expectFinding(fixture, orderId, "RECEIVABLE_AMOUNT_MISMATCH", "ISSUE", "MANUAL_REVIEW");
      expect(primary.title).toBe("Trader receivable amount does not match the order");
      expect(primary.detectedState).toContain("AED 25.00");
    });

    it("MATRIX 11 + 20 + 21: fully settled but still open -> ISSUE, READY; repaired (status only), resolved, and a repeat changes nothing", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      await crafted(sql`update trader_receivables set status = 'outstanding' where id = ${receivableId}::uuid`);
      const { primary } = await expectFinding(fixture, orderId, "FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN", "ISSUE", "READY");
      expect(primary.repairCapability).toBe("RECONCILE_TRADER_RECEIVABLE");
      const preview = await asPlatform(fixture.companyId, () => previews.preview(fixture.companyId, orderId));
      expect(preview.proposedChanges.find((change) => change.entityType === "trader_receivable")).toMatchObject({
        action: "update",
        details: { amountCollected: "18.00", from: "outstanding", to: "collected" },
      });
      expect(preview.proposedChanges.some((change) => change.action === "delete")).toBe(false);
      const eventsBefore = await companyCount("accounting_events", fixture.companyId);
      const request = await requestFor(fixture, orderId, { reason: "Settled by SET offset but left open" });
      const result = await run(fixture, orderId, request);
      expect(result).toMatchObject({ afterHealth: "HEALTHY", capabilityCode: "RECONCILE_TRADER_RECEIVABLE", replayed: false });
      expect((await currentReceivable(fixture, orderId))[0]).toMatchObject({ amountCollected: "18.00", status: "collected" });
      await expectHealthy(fixture, orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
      expect(await companyCount("accounting_events", fixture.companyId)).toBe(eventsBefore);
      const audit = (await sql<{ n: number }>`select count(*)::int as n from audit_events
         where company_id = ${fixture.companyId}::uuid and action = 'trader_receivable.status_reconciled'
           and subject_id = ${receivableId}`.execute(db)).rows[0]!.n;
      expect(audit).toBe(1);
      // MATRIX 21: the same request replays; a fresh request finds nothing to repair.
      const before = await footprint(fixture.companyId);
      expect(await run(fixture, orderId, request)).toMatchObject({ replayed: true, repairExecutionId: result.repairExecutionId });
      await expect(run(fixture, orderId, { ...request, idempotencyKey: `rc-exec-${randomUUID()}` })).rejects.toMatchObject({
        errorCode: "repair_finding_not_current",
      });
      expect(await footprint(fixture.companyId)).toBe(before);
      // The domain operation itself is idempotent.
      const again = await db.transaction().execute((transaction) =>
        get(TraderReceivableService).reconcileReceivableStatusInTransaction(transaction, fixture.companyId, receivableId, "x", {
          actorAccountId: null,
          actorRole: "test",
        }),
      );
      expect(again.changed).toBe(false);
      expect(await footprint(fixture.companyId)).toBe(before);
      expect((await audits(fixture, orderId)).filter((row) => row.capability === "RECONCILE_TRADER_RECEIVABLE")).toHaveLength(1);
    });

    it("MATRIX 12: marked collected without effective settlement -> ISSUE, READY; reconciled back to outstanding", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await crafted(sql`update trader_receivables set status = 'collected' where id = ${receivableId}::uuid`);
      await expectFinding(fixture, orderId, "RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT", "ISSUE", "READY");
      await run(fixture, orderId, await requestFor(fixture, orderId));
      expect((await currentReceivable(fixture, orderId))[0]).toMatchObject({ amountCollected: "0.00", status: "outstanding" });
      await expectHealthy(fixture, orderId, "HEALTHY_ACTIVE_RECEIVABLE");
    });

    it("MATRIX 12b: marked collected AND a recorded amount with no supporting records -> REVIEW (amount mismatch), never auto-repaired", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await crafted(sql`update trader_receivables set status = 'collected', amount_collected = 18 where id = ${receivableId}::uuid`);
      await expectFinding(fixture, orderId, "RECEIVABLE_COLLECTED_AMOUNT_MISMATCH", "REVIEW", "MANUAL_REVIEW");
    });

    it("partial-state confusion (outstanding with part paid) -> ISSUE, READY; reconciled to partially_collected", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, 10);
      await crafted(sql`update trader_receivables set status = 'outstanding' where id = ${receivableId}::uuid`);
      await expectFinding(fixture, orderId, "RECEIVABLE_PARTIAL_STATE_MISMATCH", "ISSUE", "READY");
      await run(fixture, orderId, await requestFor(fixture, orderId));
      expect((await currentReceivable(fixture, orderId))[0]).toMatchObject({ status: "partially_collected" });
    });

    it("MATRIX 13: over-collection (collection + offset beyond the amount due) -> REVIEW, MANUAL_REVIEW", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, FEE);
      await craftOffset(fixture, fixture.traderId, receivableId, FEE);
      await expectFinding(fixture, orderId, "RECEIVABLE_OVER_COLLECTED", "REVIEW", "MANUAL_REVIEW");
    });

    it("MATRIX 14: an invalid allocation (another Trader's collection) -> ISSUE, MANUAL_REVIEW; an allocation on a cancelled receivable -> ISSUE (orphan)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      const other = await secondTrader(fixture);
      await craftForeignAllocation(fixture, other, receivableId, FEE);
      await crafted(sql`update trader_receivables set amount_collected = 18, status = 'collected' where id = ${receivableId}::uuid`);
      await expectFinding(fixture, orderId, "COLLECTION_ALLOCATION_MISMATCH", "ISSUE", "MANUAL_REVIEW");

      const orphan = await feeOrder(fixture);
      await cancelReceivable(fixture, orphan.receivableId);
      await craftForeignAllocation(fixture, fixture.traderId, orphan.receivableId, 5);
      const { analysis } = await verdict(fixture, orphan.orderId);
      expect(analysis.findings.map((finding) => finding.reasonCode)).toContain("ORPHAN_COLLECTION_ALLOCATION");
      expect(analysis.health).toBe("ISSUE");
    });

    it("MATRIX 15: an invalid offset (another Trader's settlement) -> ISSUE, MANUAL_REVIEW", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      const other = await secondTrader(fixture);
      await craftOffset(fixture, other, receivableId, FEE);
      await crafted(sql`update trader_receivables set amount_collected = 18, status = 'collected' where id = ${receivableId}::uuid`);
      await expectFinding(fixture, orderId, "SETTLEMENT_OFFSET_MISMATCH", "ISSUE", "MANUAL_REVIEW");
    });

    it("MATRIX 8b: a reversed receivable's offset whose compensating Credit was cancelled -> ISSUE (SETTLEMENT_OFFSET_MISMATCH); with its Credit it is history", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      await reverseReceivable(fixture, receivableId);
      // With the live Credit: history, not an anomaly (the order needs its receivable again).
      expect((await verdict(fixture, orderId)).primary.reasonCode).toBe("REVERSED_NEEDS_REPAIR");
      await crafted(sql`update trader_credits set status = 'cancelled', cancelled_at = now(),
          cancelled_by_account_id = ${fixture.actorId}::uuid, cancelled_reason = 'crafted'
        where source_receivable_id = ${receivableId}::uuid`);
      await expectFinding(fixture, orderId, "SETTLEMENT_OFFSET_MISMATCH", "ISSUE", "MANUAL_REVIEW");
    });

    it("MATRIX 16: a cross-Company allocation is impossible (composite FK); another Company's path cannot repair the Order (404, zero mutation)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await crafted(sql`update trader_receivables set status = 'collected' where id = ${receivableId}::uuid`);
      const foreignCollection = randomUUID();
      await crafted(sql`insert into trader_collections(id,company_id,collection_number,trader_id,payment_date,
          payment_method,amount_received,status,received_by_account_id)
        values (${foreignCollection}::uuid,${companyB.companyId}::uuid,${`COL-B${foreignCollection.slice(0, 6)}`},
          ${companyB.traderId}::uuid,current_date,'cash',5,'confirmed',${companyB.actorId}::uuid)`);
      await expect(
        sql`insert into trader_collection_allocations(company_id,collection_id,receivable_id,amount_allocated)
          values (${fixture.companyId}::uuid,${foreignCollection}::uuid,${receivableId}::uuid,5)`.execute(db),
      ).rejects.toThrow(/foreign key/u);
      const request = await requestFor(fixture, orderId);
      const aBefore = await footprint(fixture.companyId);
      await expect(
        asPlatform(companyB.companyId, () => executions.execute(companyB.companyId, orderId, request, actor())),
      ).rejects.toMatchObject({ errorCode: "order_not_found" });
      expect(await footprint(fixture.companyId)).toBe(aBefore);
      await crafted(sql`delete from trader_collections where id = ${foreignCollection}::uuid`);
    });

    it("MATRIX 19 + 23: a relevant change after the preview -> 409 stale, zero mutation, REFUSED attempt recorded", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await crafted(sql`update trader_receivables set status = 'collected' where id = ${receivableId}::uuid`);
      const request = await requestFor(fixture, orderId);
      // A (reversed, so non-effective) Trader Collection allocation appears: a
      // relevant dependency changes while the finding itself stays the same.
      const collectionId = randomUUID();
      await crafted(sql`insert into trader_collections(id,company_id,collection_number,trader_id,payment_date,
          payment_method,amount_received,status,received_by_account_id,reversed_by_account_id,reversed_at,reversal_reason)
        values (${collectionId}::uuid,${fixture.companyId}::uuid,${`COL-V${collectionId.slice(0, 6)}`},
          ${fixture.traderId}::uuid,current_date,'cash',1,'reversed',${fixture.actorId}::uuid,${fixture.actorId}::uuid,
          now(),'crafted')`);
      await crafted(sql`insert into trader_collection_allocations(company_id,collection_id,receivable_id,amount_allocated)
        values (${fixture.companyId}::uuid,${collectionId}::uuid,${receivableId}::uuid,1)`);
      await refused(fixture, orderId, request, "repair_preview_stale");
      // Order financial amount changes between preview and execute.
      const second = await requestFor(fixture, orderId);
      await crafted(sql`update orders set version = version + 1 where id = ${orderId}::uuid`);
      await refused(fixture, orderId, second, "repair_preview_stale");
      const recorded = await attempts(fixture, orderId);
      expect(recorded.filter((row) => row.result === "REFUSED" && row.code === "repair_preview_stale")).toHaveLength(2);
    });

    it("MATRIX 22 + 23: a forced failure mid-repair rolls everything back and records a FAILED attempt", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await crafted(sql`update trader_receivables set status = 'collected' where id = ${receivableId}::uuid`);
      const request = await requestFor(fixture, orderId);
      const before = await footprint(fixture.companyId);
      vi.spyOn(executions as never as { writeAudit: () => Promise<never> }, "writeAudit").mockRejectedValueOnce(
        new Error("Injected audit failure"),
      );
      await expect(run(fixture, orderId, request)).rejects.toThrow(/Injected audit failure/u);
      expect(await footprint(fixture.companyId)).toBe(before);
      expect((await currentReceivable(fixture, orderId))[0]).toMatchObject({ status: "collected" });
      expect((await attempts(fixture, orderId)).map((row) => row.result)).toContain("FAILED");
      // Nothing was half-applied: the same READY repair still runs.
      await run(fixture, orderId, await requestFor(fixture, orderId));
      expect((await currentReceivable(fixture, orderId))[0]).toMatchObject({ status: "outstanding" });
    });
  });

  describe("Accounting ON company", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await createFixture("on");
    }, 240_000);

    it("MATRIX 18: a journal-requiring Platform repair (missing receivable) is BLOCKED -- PLATFORM_ACTOR_CANNOT_POST_JOURNAL", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      const { primary } = await expectFinding(fixture, orderId, "MISSING_RECEIVABLE", "ISSUE", "BLOCKED");
      expect(primary.blockers.map((blocker) => blocker.code)).toContain("PLATFORM_ACTOR_CANNOT_POST_JOURNAL");
      await refused(fixture, orderId, await requestFor(fixture, orderId), "repair_not_ready");
    });

    it("status reconciliation needs no journal: READY with Accounting ON, executes, creates no accounting event or journal", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await crafted(sql`update trader_receivables set status = 'collected' where id = ${receivableId}::uuid`);
      await expectFinding(fixture, orderId, "RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT", "ISSUE", "READY");
      const events = await companyCount("accounting_events", fixture.companyId);
      const journals = await companyCount("journal_entries", fixture.companyId);
      await run(fixture, orderId, await requestFor(fixture, orderId));
      expect(await companyCount("accounting_events", fixture.companyId)).toBe(events);
      expect(await companyCount("journal_entries", fixture.companyId)).toBe(journals);
      expect((await currentReceivable(fixture, orderId))[0]).toMatchObject({ status: "outstanding" });
    });
  });
});
