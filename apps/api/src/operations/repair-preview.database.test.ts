import { createHash, randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { CashBankManagementService } from "../accounting/cash-bank-management.service.js";
import { PlatformAccountingRepairAdapter } from "../accounting/platform-accounting-repair.adapter.js";
import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { markTraderDeductionV1Order } from "./order-obligation-snapshot.fixture.js";
import { CompanyOrderHealthService } from "./company-order-health.service.js";
import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import { OperationsService } from "./operations.service.js";
import { OrderMaintenanceService } from "./order-maintenance.service.js";
import { ReceivableOffsetReversalService } from "./receivable-offset-reversal.service.js";
import { REPAIR_CAPABILITIES } from "./repair-capability.registry.js";
import { findingIdOf } from "./repair-center.model.js";
import { RepairPreviewService } from "./repair-preview.service.js";
import { TraderReceivableService } from "./trader-receivable.service.js";
import { TraderSettlementService } from "./trader-settlement.service.js";

/**
 * Phase 2 Prompt 2 -- Repair Center finding details + repair plan PREVIEW.
 *
 * Fixtures come from the REAL services (AppModule compiled, not initialised)
 * against the disposable database; the few states no service produces on
 * purpose are written directly and marked "crafted". The preview itself is
 * only ever called read-only, and every scenario proves it wrote nothing.
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

describe.skipIf(!runDatabaseTests)("Repair Center -- finding details and repair plan preview", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let store: RequestSecurityContextStore;
  let get: <T>(type: new (...args: never[]) => T) => T;
  let previews: RepairPreviewService;

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

  const key = (label: string) => `preview.${label}.${randomUUID()}`;

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`PREVIEW-${tag}`},${`preview-${tag}`},${`Preview ${mode} ${tag}`},
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

  /** Runs analyze + preview and proves byte-for-byte that nothing changed. */
  async function readOnlyPreview(fixture: Fixture, orderId: string, reasonCode?: string) {
    const before = await footprint(fixture.companyId);
    const analysis = await previews.analyze(fixture.companyId, orderId);
    const preview = await previews.preview(fixture.companyId, orderId, { reasonCode });
    expect(await footprint(fixture.companyId), "preview must not mutate anything").toBe(before);
    expect(preview.previewVersion).toBe(analysis.previewVersion);
    // Prompt 3: executable only for a READY finding of the one executable
    // certified capability; never for BLOCKED / MANUAL_REVIEW / NOT_REQUIRED.
    expect(preview.execution.available).toBe(
      preview.repairability === "READY" && preview.proposedRepair?.capabilityCode === "REPAIR_TRADER_RECEIVABLE",
    );
    return { analysis, preview };
  }

  async function craftCodCoversFee(orderId: string) {
    // Crafted: the order's COD now covers the fee, so the active receivable is
    // no longer required (RECEIVABLE_NOT_REQUIRED_BUT_ACTIVE).
    // Every derived column moves with it, as the financial-model check requires.
    await crafted(sql`update orders set cod_amount = 100, customer_amount_due = 100,
        trader_gross_payable = 100, trader_net_payable = greatest(100 - total_deductions, 0)
      where id = ${orderId}::uuid`);
  }

  describe("Accounting OFF company", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await createFixture("off");
    }, 300_000);

    it("S1 / Part R: valid effective offset, no physical collection -> HEALTHY, NOT_REQUIRED, no capability", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      const { analysis, preview } = await readOnlyPreview(fixture, orderId);
      expect(preview.finding).toMatchObject({
        health: "HEALTHY",
        reasonCode: "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
        repairCapability: null,
        repairability: "NOT_REQUIRED",
        severity: "none",
      });
      expect(preview).toMatchObject({
        blockers: [],
        proposedChanges: [],
        proposedRepair: null,
        repairability: "NOT_REQUIRED",
        requiredInputs: [],
        requiredPermission: null,
      });
      expect(analysis.findings).toHaveLength(1);
    });

    it("S2: SET-A -> reversal -> SET-B -> HEALTHY, NOT_REQUIRED; SET-A offset historical, SET-B current", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      const setA = await settleWithOffset(fixture, receivableId);
      await reverseSettlement(fixture, setA);
      await settleWithOffset(fixture, receivableId);
      const { analysis, preview } = await readOnlyPreview(fixture, orderId);
      expect(preview.repairability).toBe("NOT_REQUIRED");
      const offsets = (nodes: typeof analysis.dependencies.current) =>
        nodes.filter((node) => node.entityType === "trader_settlement_offset");
      expect(offsets(analysis.dependencies.current)).toHaveLength(1);
      expect(offsets(analysis.dependencies.historical)).toHaveLength(1);
      expect(offsets(analysis.dependencies.historical)[0]!.relation).toMatch(/reversed by/u);
      expect(offsets(analysis.dependencies.current)[0]!.status).toBe("effective");
    });

    it("S3: reversed historical receivable + valid replacement -> HEALTHY, NOT_REQUIRED; history classified historical", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      await reverseReceivable(fixture, receivableId);
      await repair(fixture, orderId);
      const { analysis, preview } = await readOnlyPreview(fixture, orderId);
      expect(preview.finding).toMatchObject({
        health: "HEALTHY",
        reasonCode: "HEALTHY_ACTIVE_RECEIVABLE",
        repairability: "NOT_REQUIRED",
      });
      const receivables = (nodes: typeof analysis.dependencies.current) =>
        nodes.filter((node) => node.entityType === "trader_receivable").map((node) => node.status);
      expect(receivables(analysis.dependencies.current)).toEqual(["outstanding"]);
      expect(receivables(analysis.dependencies.historical)).toEqual(["reversed"]);
      // The reversal's Credit stays visible, linked to the historical receivable.
      expect(
        [...analysis.dependencies.current, ...analysis.dependencies.historical].some(
          (node) => node.entityType === "trader_credit",
        ),
      ).toBe(true);
    });

    it("S4: cancelled + reversed history + valid replacement -> HEALTHY, NOT_REQUIRED", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await cancelReceivable(fixture, receivableId);
      await repair(fixture, orderId);
      const second = await activeReceivable(fixture, orderId);
      await settleWithOffset(fixture, second);
      await reverseReceivable(fixture, second);
      await repair(fixture, orderId);
      const { analysis, preview } = await readOnlyPreview(fixture, orderId);
      expect(preview.repairability).toBe("NOT_REQUIRED");
      expect(
        analysis.dependencies.historical
          .filter((node) => node.entityType === "trader_receivable")
          .map((node) => node.status)
          .sort(),
      ).toEqual(["cancelled", "reversed"]);
    });

    it("S5 / S7: missing receivable -> ISSUE, READY, exactly ONE receivable created, no GL (Accounting OFF)", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      const { preview } = await readOnlyPreview(fixture, orderId);
      expect(preview.finding).toMatchObject({
        domain: "TRADER_RECEIVABLE",
        findingId: findingIdOf(fixture.companyId, orderId, "MISSING_RECEIVABLE"),
        health: "ISSUE",
        reasonCode: "MISSING_RECEIVABLE",
        repairCapability: "REPAIR_TRADER_RECEIVABLE",
        repairability: "READY",
        severity: "high",
      });
      expect(preview.proposedRepair).toMatchObject({
        candidateOnly: false,
        capabilityCode: "REPAIR_TRADER_RECEIVABLE",
        executionHandler: "OperationsService.repairTraderReceivableInTransaction",
      });
      expect(preview.blockers).toEqual([]);
      const creates = preview.proposedChanges.filter((change) => change.action === "create");
      expect(creates.filter((change) => change.entityType === "trader_receivable")).toHaveLength(1);
      expect(creates.find((change) => change.entityType === "trader_receivable")!.details).toMatchObject({
        amountDue: "18.00",
        status: "outstanding",
      });
      expect(preview.proposedChanges.filter((change) => change.action === "delete")).toEqual([]);
      expect(creates.some((change) => change.entityType === "accounting_event")).toBe(false);
      expect(preview.warnings.map((warning) => warning.code)).toEqual(
        expect.arrayContaining(["ACCOUNTING_OFF_NO_GL_EVENT", "ORDER_STATUS_UNCHANGED"]),
      );
      expect(preview).toMatchObject({
        accountingMode: { enabled: false },
        requiredInputs: [],
        requiredPermission: "users_roles.manage",
      });
      expect(preview.idempotencyKeyBasis).toBe(
        `repair:REPAIR_TRADER_RECEIVABLE:${fixture.companyId}:${orderId}:${preview.previewVersion}`,
      );
      // The preview never changes repairability by being called twice.
      expect((await previews.preview(fixture.companyId, orderId)).repairability).toBe("READY");
    });

    it("S5b: only a reversed receivable -> READY repair; reversed receivable, settlement and Credit preserved", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      await reverseReceivable(fixture, receivableId);
      const { preview } = await readOnlyPreview(fixture, orderId);
      expect(preview.finding).toMatchObject({ reasonCode: "REVERSED_NEEDS_REPAIR", repairability: "READY" });
      const preserved = preview.preservedHistory.map((row) => row.entityType);
      expect(preserved).toEqual(
        expect.arrayContaining(["trader_receivable", "trader_settlement", "trader_credit", "audit_trail"]),
      );
      expect(preview.warnings.map((warning) => warning.code)).toEqual(
        expect.arrayContaining(["HISTORICAL_RECEIVABLE_PRESERVED"]),
      );
      expect(preview.proposedChanges.some((change) => change.action === "delete")).toBe(false);
    });

    it("Part M: missing receivable whose COD partly covers the fee -> BLOCKED (repair would bill the wrong amount)", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture, { codAmount: 5 });
      const { preview } = await readOnlyPreview(fixture, orderId);
      expect(preview.finding.reasonCode).toBe("MISSING_RECEIVABLE");
      expect(preview.repairability).toBe("BLOCKED");
      expect(preview.blockers.map((blocker) => blocker.code)).toEqual([
        "REPAIR_AMOUNT_DIFFERS_FROM_FINANCIAL_MODEL",
      ]);
      expect(preview.finding.blockers).toEqual(preview.blockers);
    });

    it("S6: processed (offset-settled) receivable no longer required -> certified reversal previewed, history preserved, Credit as the service requires", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      await craftCodCoversFee(orderId);
      const { preview } = await readOnlyPreview(fixture, orderId);
      expect(preview.finding).toMatchObject({
        health: "REVIEW",
        reasonCode: "RECEIVABLE_NOT_REQUIRED_BUT_ACTIVE",
        repairCapability: "RESET_TRADER_RECEIVABLE",
        // Part Q: a REVIEW finding stays manual; the plan is a candidate only.
        repairability: "MANUAL_REVIEW",
      });
      expect(preview.proposedRepair).toMatchObject({ candidateOnly: true, capabilityCode: "RESET_TRADER_RECEIVABLE" });
      expect(preview.blockers).toEqual([]);
      expect(preview.requiredPermission).toBe("trader_receivables.reverse");
      expect(preview.requiredInputs).toEqual([
        expect.objectContaining({ name: "reason", required: true }),
      ]);
      const byType = (type: string) => preview.proposedChanges.filter((change) => change.entityType === type);
      expect(byType("trader_receivable")).toEqual([
        expect.objectContaining({ action: "update", details: expect.objectContaining({ to: "reversed" }) }),
      ]);
      expect(byType("trader_credit")).toEqual([
        expect.objectContaining({ action: "create", details: expect.objectContaining({ amount: "18.00" }) }),
      ]);
      expect(byType("trader_settlement")).toEqual([expect.objectContaining({ action: "none" })]);
      expect(preview.proposedChanges.some((change) => change.action === "delete")).toBe(false);
      // Accounting OFF: the certified reversal captures nothing.
      expect(byType("accounting_event")).toEqual([]);
      expect(preview.preservedHistory.map((row) => row.entityType)).toEqual(
        expect.arrayContaining(["trader_settlement"]),
      );
    });

    it("S6b: UNUSED receivable no longer required -> the certified physical delete is previewed (manual review)", async () => {
      const { orderId } = await feeOrder(fixture);
      await craftCodCoversFee(orderId);
      const { preview } = await readOnlyPreview(fixture, orderId);
      expect(preview.repairability).toBe("MANUAL_REVIEW");
      expect(preview.requiredPermission).toBe("users_roles.manage");
      expect(preview.proposedChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: "delete", entityType: "trader_receivable" }),
          expect.objectContaining({ action: "create", entityType: "audit_event" }),
        ]),
      );
    });

    it("S9 / Part Q: ambiguous duplicate effective settlement -> REVIEW, MANUAL_REVIEW, no executable capability", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      await craftSecondEffectiveOffset(fixture, receivableId);
      const { preview } = await readOnlyPreview(fixture, orderId);
      expect(preview.finding).toMatchObject({
        domain: "TRADER_SETTLEMENT",
        health: "REVIEW",
        reasonCode: "MULTIPLE_EFFECTIVE_SETTLEMENTS",
        repairCapability: null,
        repairability: "MANUAL_REVIEW",
      });
      expect(preview.proposedRepair).toBeNull();
      expect(preview.proposedChanges).toEqual([]);
      expect(preview.requiredPermission).toBeNull();
      expect(preview.warnings.map((warning) => warning.code)).toEqual(["NO_CERTIFIED_REPAIR"]);
    });

    it("Driver Cash finding -> MANUAL_REVIEW (on hold, no certified repair)", async () => {
      const orderId = await deliveredOrder(fixture, 50, "customer_pays_cod_and_fee");
      await crafted(sql`update orders set driver_reconciliation_status = 'reconciled' where id = ${orderId}::uuid`);
      const { preview } = await readOnlyPreview(fixture, orderId);
      expect(preview.finding).toMatchObject({
        domain: "DRIVER_CASH",
        reasonCode: "DRIVER_CASH_RECONCILED_WITHOUT_RECONCILIATION",
        repairability: "MANUAL_REVIEW",
      });
      expect(preview.proposedRepair).toBeNull();
    });

    it("an unknown or not-current finding is refused; the browser cannot choose health", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      await expect(
        previews.preview(fixture.companyId, orderId, { reasonCode: "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION" }),
      ).rejects.toMatchObject({ errorCode: "repair_finding_not_current" });
    });

    it("Part K / U: previewVersion is stable for the same state and changes with each relevant change", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      const version = async () => (await previews.analyze(fixture.companyId, orderId)).previewVersion;
      const a = await version();
      expect(await version()).toBe(a);
      expect(a).toMatch(/^rcv1:[0-9a-f]{64}$/u);

      // Receivable state: a physical collection.
      await collectPhysically(fixture, receivableId);
      const b = await version();
      expect(b).not.toBe(a);
      expect(await version()).toBe(b);

      // Order status/version.
      await crafted(sql`update orders set version = version + 1 where id = ${orderId}::uuid`);
      const c = await version();
      expect(c).not.toBe(b);

      // Accounting mode (the OFF fixture has no configuration row; add an
      // enabled one, then remove it again to return to the original state).
      await crafted(sql`insert into accounting_configurations(company_id, accounting_enabled)
                         values (${fixture.companyId}::uuid, true)`);
      const d = await version();
      await crafted(sql`delete from accounting_configurations
                         where company_id = ${fixture.companyId}::uuid`);
      expect(d).not.toBe(c);
      expect(await version()).toBe(c);
    });

    it("Part K / U: effective-settlement state changes the fingerprint (settle, then reverse)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      const version = async () => (await previews.analyze(fixture.companyId, orderId)).previewVersion;
      const a = await version();
      const setA = await settleWithOffset(fixture, receivableId);
      const b = await version();
      await reverseSettlement(fixture, setA);
      const c = await version();
      expect(new Set([a, b, c]).size).toBe(3);
    });

    it("Part V: a complex preview runs a fixed, bounded number of SQL statements", async () => {
      let statements = 0;
      const counting = new Kysely<DatabaseSchema>({
        dialect: new PostgresDialect({ pool }),
        log: (event) => {
          if (event.level === "query") statements += 1;
        },
      });
      const service = new RepairPreviewService(
        counting,
        new CompanyOrderHealthService(counting),
        get(OrderMaintenanceService),
        get(ReceivableOffsetReversalService),
        get(PlatformAccountingRepairAdapter),
      );
      // Complex: settled, settlement reversed, re-settled, then no longer required
      // (reset plan + reversal inspection both run).
      const { orderId, receivableId } = await feeOrder(fixture);
      const setA = await settleWithOffset(fixture, receivableId);
      await reverseSettlement(fixture, setA);
      await settleWithOffset(fixture, receivableId);
      await craftCodCoversFee(orderId);
      statements = 0;
      const preview = await service.preview(fixture.companyId, orderId);
      expect(preview.proposedRepair?.capabilityCode).toBe("RESET_TRADER_RECEIVABLE");
      // begin, read only, settings, context, evaluation, graph, reset plan,
      // reversal inspection, commit.
      expect(statements).toBe(9);
      process.stdout.write(`complex preview SQL statements: ${statements}\n`);
    });
  });

  describe("Accounting ON company", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await createFixture("on");
    }, 300_000);

    it("S8 (revised Prompt 4): missing receivable under Accounting ON -> BLOCKED (Platform actor cannot post); recognition event still previewed", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      const { preview } = await readOnlyPreview(fixture, orderId);
      // Prompt 4 finding: a Platform-created receivable's recognition event has
      // no operational actor and the certified posting pipeline refuses it.
      expect(preview).toMatchObject({ accountingMode: { enabled: true }, repairability: "BLOCKED" });
      expect(preview.blockers.map((blocker) => blocker.code)).toContain("PLATFORM_ACTOR_CANNOT_POST_JOURNAL");
      expect(preview.proposedChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "create",
            details: expect.objectContaining({ eventType: "trader_receivable_recognized" }),
            entityType: "accounting_event",
          }),
        ]),
      );
      expect(preview.warnings.map((warning) => warning.code)).not.toContain("ACCOUNTING_OFF_NO_GL_EVENT");
    });

    it("failed order accounting event -> repairability from the certified precheck (Prompt 4); executes from Accounting Health only", async () => {
      const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      await crafted(sql`update accounting_events set processing_status = 'failed', failed_at = now()
        where company_id = ${fixture.companyId}::uuid and source_entity_type = 'order'
          and source_entity_id = ${orderId}::uuid`);
      const { preview } = await readOnlyPreview(fixture, orderId);
      expect(preview.finding).toMatchObject({
        domain: "ACCOUNTING",
        reasonCode: "ACCOUNTING_EVENT_FAILED",
        repairCapability: "REPROCESS_ACCOUNTING_EVENT",
      });
      const event = (
        await sql<{ id: string }>`select id from accounting_events where company_id = ${fixture.companyId}::uuid
          and source_entity_type = 'order' and source_entity_id = ${orderId}::uuid`.execute(db)
      ).rows[0]!;
      const inspection = (await get(PlatformAccountingRepairAdapter).inspect(null, fixture.companyId, event.id))!;
      // The order-level plan carries exactly the certified precheck's verdict.
      expect(preview.repairability).toBe(inspection.repairability === "READY" ? "READY" : "BLOCKED");
      expect(preview.blockers.map((blocker) => blocker.code)).not.toContain("ACCOUNTING_PRECHECK_REQUIRED");
      expect(preview.warnings.map((warning) => warning.code)).toContain("RECOVER_FROM_ACCOUNTING_HEALTH");
      expect(preview.execution.available).toBe(false);
      expect(preview.requiredPermission).toBe("accounting.post");
      expect(preview.requiredInputs.map((input) => input.name)).toEqual(["reason"]);
    });

    it("an accounting event in 'processing' blocks the repair (ACCOUNTING_EVENT_PROCESSING)", async () => {
      const orderId = await deliveredOrder(fixture, 0, "customer_pays_cod_trader_pays_fee");
      const receivableId = await activeReceivable(fixture, orderId);
      // Crafted: the receivable is reversed with no replacement while the
      // order's own event is mid-processing.
      await reverseReceivableDirect(receivableId);
      // This order type carries no order event; its receivable's recognition
      // event is the one mid-processing.
      await crafted(sql`update accounting_events set processing_status = 'processing'
        where company_id = ${fixture.companyId}::uuid and source_entity_type = 'trader_receivable'
          and source_entity_id = ${receivableId}::uuid`);
      const { preview } = await readOnlyPreview(fixture, orderId);
      expect(preview.finding.reasonCode).toBe("REVERSED_NEEDS_REPAIR");
      expect(preview.repairability).toBe("BLOCKED");
      expect(preview.blockers.map((blocker) => blocker.code)).toContain("ACCOUNTING_EVENT_PROCESSING");
    });

    async function reverseReceivableDirect(receivableId: string) {
      await crafted(sql`update trader_receivables set status = 'reversed' where id = ${receivableId}::uuid`);
    }
  });

  it("S10 / Part W: same human-readable order number in two Companies -> strict isolation", async () => {
    const a = await createFixture("off");
    const b = await createFixture("off");
    const aOrder = await feeOrder(a);
    const bOrder = await feeOrder(b);
    expect(await orderNumber(aOrder.orderId)).toBe(await orderNumber(bOrder.orderId));
    await settleWithOffset(b, bOrder.receivableId);
    await craftSecondEffectiveOffset(b, bOrder.receivableId);

    const { analysis, preview } = await readOnlyPreview(a, aOrder.orderId);
    expect(preview.finding).toMatchObject({ health: "HEALTHY", repairability: "NOT_REQUIRED" });
    const ids = [...analysis.dependencies.current, ...analysis.dependencies.historical].map((node) => node.entityId);
    expect(ids).toEqual([aOrder.receivableId]);
    // Company A's path can never reach Company B's Order.
    for (const work of [
      () => previews.analyze(a.companyId, bOrder.orderId),
      () => previews.preview(a.companyId, bOrder.orderId),
    ]) {
      let refused: unknown;
      try {
        await work();
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(ApplicationException);
      expect((refused as ApplicationException).getStatus()).toBe(404);
    }
    // B, previewed in its own Company, shows its own ambiguity.
    expect((await previews.preview(b.companyId, bOrder.orderId)).repairability).toBe("MANUAL_REVIEW");
  });

  it("Part D: the registry only names existing handlers; only REPAIR_TRADER_RECEIVABLE and (Phase 3) RECONCILE / CANCEL_DUPLICATE / REPLACE_UNUSED are executable", () => {
    expect(REPAIR_CAPABILITIES.map((capability) => capability.capabilityCode).sort()).toEqual([
      "CANCEL_DUPLICATE_TRADER_RECEIVABLE",
      "RECONCILE_TRADER_RECEIVABLE",
      "REPAIR_TRADER_RECEIVABLE",
      "REPLACE_UNUSED_TRADER_RECEIVABLE",
      "REPROCESS_ACCOUNTING_EVENT",
      "RESET_TRADER_RECEIVABLE",
    ]);
    const handlers: Record<string, object> = {
      AccountingReprocessPrecheckService: { execute: true },
      PlatformAccountingRepairAdapter: PlatformAccountingRepairAdapter.prototype,
      OperationsService: OperationsService.prototype,
      OrderMaintenanceService: OrderMaintenanceService.prototype,
      TraderReceivableService: TraderReceivableService.prototype,
    };
    for (const capability of REPAIR_CAPABILITIES) {
      // A composite capability (Phase 3 Prompt 3) names each certified handler: "A.b + C.d".
      for (const handler of capability.executionHandler.split(" + ")) {
        const [service, method] = handler.split(".");
        expect(handlers[service!], handler).toBeDefined();
        expect(method! in handlers[service!]!, handler).toBe(true);
      }
      expect(Object.keys(capability)).not.toContain("execute");
      expect(capability.execution.available, capability.capabilityCode).toBe(
        [
          "REPAIR_TRADER_RECEIVABLE",
          "RECONCILE_TRADER_RECEIVABLE",
          "CANCEL_DUPLICATE_TRADER_RECEIVABLE",
          "REPLACE_UNUSED_TRADER_RECEIVABLE",
        ].includes(capability.capabilityCode),
      );
    }
  });
});
