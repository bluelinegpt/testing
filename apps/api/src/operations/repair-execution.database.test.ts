import { createHash, randomUUID } from "node:crypto";

import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { CashBankManagementService } from "../accounting/cash-bank-management.service.js";
import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { markTraderDeductionV1Order } from "./order-obligation-snapshot.fixture.js";
import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import { RepairCenterOverviewService } from "./repair-center-overview.service.js";
import { RepairHistoryService } from "./repair-history.service.js";
import { OperationsService } from "./operations.service.js";
import { ReceivableOffsetReversalService } from "./receivable-offset-reversal.service.js";
import { type RepairExecutionRequest, RepairExecutionService } from "./repair-execution.service.js";
import { RepairPreviewService } from "./repair-preview.service.js";
import { TraderReceivableService } from "./trader-receivable.service.js";
import { TraderSettlementService } from "./trader-settlement.service.js";

/**
 * Phase 2 Prompt 3 -- Repair Center SAFE REPAIR EXECUTION (Part W cases 1-13,
 * 16, 17, Part X concurrency). Cases 14 / 15 (Platform reader, Company user)
 * are HTTP-level: platform-repair-center.http.database.test.ts.
 *
 * Same fixture construction as the Prompt 2 preview suite: REAL services
 * against the disposable database, "crafted" rows only where no service
 * produces the state on purpose. Executions run as a Platform administrator
 * identity with the target Company as tenant -- exactly what
 * PlatformTargetCompanyGuard sets up over HTTP. Every refusal proves zero
 * mutation with a content checksum of every table a repair could touch.
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

describe.skipIf(!runDatabaseTests)("Repair Center -- safe repair execution", () => {
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

  async function craftCodCoversFee(orderId: string) {
    // Crafted: the order's COD now covers the fee, so the active receivable is
    // no longer required (RECEIVABLE_NOT_REQUIRED_BUT_ACTIVE).
    // Every derived column moves with it, as the financial-model check requires.
    await crafted(sql`update orders set cod_amount = 100, customer_amount_due = 100,
        trader_gross_payable = 100, trader_net_payable = greatest(100 - total_deductions, 0)
      where id = ${orderId}::uuid`);
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

  async function receivables(fixture: Fixture, orderId: string) {
    return (
      await sql<{ id: string; status: string; amount: string; createdBy: string | null }>`
        select id, status, original_amount_due::text as amount, created_by_account_id as "createdBy"
          from trader_receivables
         where company_id = ${fixture.companyId}::uuid and source_type = 'service_charge'
           and source_reference = ${await orderNumber(orderId)}
         order by created_at`.execute(db)
    ).rows;
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

  describe("Accounting OFF company", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await createFixture("off");
    }, 300_000);

    it("CASE 1 + 11 + 2 + 3: READY missing receivable -> one receivable, Delivered, HEALTHY, no GL; replay and re-run are safe", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      const preview = await previews.preview(fixture.companyId, orderId);
      expect(preview).toMatchObject({
        execution: { available: true },
        finding: { reasonCode: "MISSING_RECEIVABLE" },
        repairability: "READY",
      });
      const events = await companyCount("accounting_events", fixture.companyId);
      const journals = await companyCount("journal_entries", fixture.companyId);
      const request = await requestFor(fixture, orderId);

      // CASE 1
      const result = await run(fixture, orderId, request);
      expect(result).toMatchObject({
        afterClassification: "HEALTHY_ACTIVE_RECEIVABLE",
        afterHealth: "HEALTHY",
        beforeClassification: "MISSING_RECEIVABLE",
        beforeHealth: "ISSUE",
        capabilityCode: "REPAIR_TRADER_RECEIVABLE",
        companyId: fixture.companyId,
        orderId,
        replayed: false,
        status: "succeeded",
      });
      expect(result.auditId).toBe(result.repairExecutionId);
      expect(result.beforePreviewVersion).toBe(request.previewVersion);
      expect(result.afterPreviewVersion).not.toBe(request.previewVersion);
      const created = await receivables(fixture, orderId);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ amount: "18.00", createdBy: null, status: "outstanding" });
      const order = (
        await sql<{ status: string }>`select delivery_status as status from orders where id=${orderId}::uuid`.execute(db)
      ).rows[0]!;
      expect(order.status).toBe("delivered");
      expect((await previews.analyze(fixture.companyId, orderId)).health).toBe("HEALTHY");
      const event = (
        await sql<{ actor: string | null; role: string }>`select actor_account_id as actor, actor_role as role
          from order_events where order_id=${orderId}::uuid
           and event_type='trader_receivable.created_from_order'`.execute(db)
      ).rows;
      expect(event).toEqual([{ actor: null, role: "Platform Repair Center" }]);
      const audit = await audits(fixture, orderId);
      expect(audit).toEqual([
        {
          actor: adminId,
          capability: "REPAIR_TRADER_RECEIVABLE",
          id: result.repairExecutionId,
          reason: request.reason,
          result: "succeeded",
        },
      ]);

      // Phase 2 Prompt 4, Part Q: positive audit evidence -> "Platform Repair".
      const detail = (await as(fixture, () =>
        get(TraderReceivableService).receivableDetail(created[0]!.id),
      )) as { createdBy: string };
      expect(detail.createdBy).toBe("Platform Repair");
      const graphNode = (await previews.analyze(fixture.companyId, orderId)).dependencies.current.find(
        (node) => node.entityType === "trader_receivable",
      );
      expect(graphNode?.relation).toMatch(/created by Platform Repair/u);
      // ... and a NULL creator WITHOUT that evidence stays Legacy/Unknown.
      const legacyOrder = await legacyOrderWithoutReceivable(fixture);
      const legacyReceivable = randomUUID();
      await crafted(sql`insert into trader_receivables(id,company_id,receivable_number,trader_id,source_type,
          source_reference,business_date,original_amount_due,amount_collected,status,reason)
        values (${legacyReceivable}::uuid, ${fixture.companyId}::uuid, ${`RCV-L${legacyReceivable.slice(0, 6)}`},
          ${fixture.traderId}::uuid, 'service_charge', ${await orderNumber(legacyOrder)}, current_date, 18, 0,
          'outstanding', 'Crafted legacy row')`);
      const legacyDetail = (await as(fixture, () =>
        get(TraderReceivableService).receivableDetail(legacyReceivable),
      )) as { createdBy: string };
      expect(legacyDetail.createdBy).toBe("Legacy/Unknown");

      // CASE 11: Accounting OFF -> no accounting event, no journal.
      expect(await companyCount("accounting_events", fixture.companyId)).toBe(events);
      expect(await companyCount("journal_entries", fixture.companyId)).toBe(journals);

      // CASE 2: the exact same request (double click / network retry).
      const before = await footprint(fixture.companyId);
      const replay = await run(fixture, orderId, request);
      expect(replay).toEqual({ ...result, replayed: true });
      expect(await footprint(fixture.companyId)).toBe(before);
      // Same key, different request -> conflict, nothing written.
      await refused(fixture, orderId, { ...request, reason: "A different reason" }, "repair_idempotency_conflict");

      // CASE 3: a NEW key with the old preview -> the finding is gone.
      await refused(fixture, orderId, { ...request, idempotencyKey: `rc-exec-${randomUUID()}` }, "repair_finding_not_current");
      const fresh = await previews.preview(fixture.companyId, orderId);
      expect(fresh).toMatchObject({ execution: { available: false }, repairability: "NOT_REQUIRED" });
      await refused(
        fixture,
        orderId,
        await requestFor(fixture, orderId, { capabilityCode: "REPAIR_TRADER_RECEIVABLE" }),
        "repair_capability_not_applicable",
      );
      expect(await receivables(fixture, orderId)).toHaveLength(1);
      expect(await audits(fixture, orderId)).toHaveLength(1);
    });

    it("REVERSED_NEEDS_REPAIR (READY) -> replacement created, reversed receivable kept as history", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      await reverseReceivable(fixture, receivableId);
      const preview = await previews.preview(fixture.companyId, orderId);
      expect(preview).toMatchObject({ finding: { reasonCode: "REVERSED_NEEDS_REPAIR" }, repairability: "READY" });
      const result = await run(fixture, orderId, await requestFor(fixture, orderId));
      expect(result).toMatchObject({ afterHealth: "HEALTHY", beforeClassification: "REVERSED_NEEDS_REPAIR" });
      expect((await receivables(fixture, orderId)).map((row) => row.status)).toEqual(["reversed", "outstanding"]);
    });

    it("CASE 4: preview READY, then another process creates the receivable -> finding not current, zero mutation", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      const request = await requestFor(fixture, orderId);
      await repair(fixture, orderId); // the Company's own certified repair, elsewhere
      await refused(fixture, orderId, request, "repair_finding_not_current");
      expect(await receivables(fixture, orderId)).toHaveLength(1);
      expect(await audits(fixture, orderId)).toEqual([]);
    });

    it("CASE 5 / Part D: any relevant change between preview and execute -> repair_preview_stale, zero mutation", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      // Order version / status.
      let request = await requestFor(fixture, orderId);
      await crafted(sql`update orders set version = version + 1 where id = ${orderId}::uuid`);
      await refused(fixture, orderId, request, "repair_preview_stale");
      // Accounting mode.
      request = await requestFor(fixture, orderId);
      await crafted(sql`insert into accounting_configurations(company_id, accounting_enabled)
                         values (${fixture.companyId}::uuid, true)`);
      try {
        await refused(fixture, orderId, request, "repair_preview_stale");
      } finally {
        await crafted(sql`delete from accounting_configurations where company_id = ${fixture.companyId}::uuid`);
      }
      // A historical (reversed) receivable appearing changes the dependency state.
      request = await requestFor(fixture, orderId);
      await crafted(sql`insert into trader_receivables(company_id,receivable_number,trader_id,source_type,
          source_reference,business_date,original_amount_due,amount_collected,status,reason,created_by_account_id)
        values (${fixture.companyId}::uuid, ${`RCV-X${randomUUID().slice(0, 6)}`}, ${fixture.traderId}::uuid,
          'service_charge', ${await orderNumber(orderId)}, current_date, 18, 0, 'reversed', 'Crafted history',
          ${fixture.actorId}::uuid)`);
      // That changes the finding itself (MISSING -> REVERSED_NEEDS_REPAIR).
      await refused(fixture, orderId, request, "repair_finding_not_current");
      // The fresh preview is still READY (REVERSED_NEEDS_REPAIR) and executes.
      const fresh = await requestFor(fixture, orderId);
      await expect(run(fixture, orderId, fresh)).resolves.toMatchObject({ afterHealth: "HEALTHY" });
    });

    it("CASE 5b: a dependency changing (the reversal's Trader Credit is applied) makes the preview stale", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      await reverseReceivable(fixture, receivableId);
      const request = await requestFor(fixture, orderId);
      expect((await previews.preview(fixture.companyId, orderId)).repairability).toBe("READY");
      // Crafted: part of the compensating Credit is consumed elsewhere.
      await crafted(sql`update trader_credits set amount_applied = amount_applied + 1, status = 'partially_applied'
                         where source_receivable_id = ${receivableId}::uuid`);
      await refused(fixture, orderId, request, "repair_preview_stale");
    });

    it("CASE 6 / Part H: service fee differs from the financial model -> BLOCKED, cannot execute", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture, { codAmount: 5 });
      const preview = await previews.preview(fixture.companyId, orderId);
      expect(preview.repairability).toBe("BLOCKED");
      expect(preview.execution.available).toBe(false);
      expect(preview.blockers.map((blocker) => blocker.code)).toContain("REPAIR_AMOUNT_DIFFERS_FROM_FINANCIAL_MODEL");
      await refused(fixture, orderId, await requestFor(fixture, orderId), "repair_not_ready");
      expect(await receivables(fixture, orderId)).toEqual([]);
    });

    it("CASE 7 / 8 / 9: healthy states (offset-settled, SET-A reversed + SET-B, history + replacement) never execute", async () => {
      const a = await feeOrder(fixture);
      await settleWithOffset(fixture, a.receivableId);
      const b = await feeOrder(fixture);
      const setA = await settleWithOffset(fixture, b.receivableId);
      await reverseSettlement(fixture, setA);
      await settleWithOffset(fixture, b.receivableId);
      const c = await feeOrder(fixture);
      await settleWithOffset(fixture, c.receivableId);
      await reverseReceivable(fixture, c.receivableId);
      await repair(fixture, c.orderId);
      for (const { orderId } of [a, b, c]) {
        const preview = await previews.preview(fixture.companyId, orderId);
        expect(preview).toMatchObject({
          execution: { available: false },
          finding: { health: "HEALTHY" },
          repairability: "NOT_REQUIRED",
        });
        await refused(fixture, orderId, await requestFor(fixture, orderId), "repair_capability_not_applicable");
      }
    });

    it("CASE 10: duplicate effective settlements -> MANUAL_REVIEW, no execution; RESET stays non-executable", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      await craftSecondEffectiveOffset(fixture, receivableId);
      expect((await previews.preview(fixture.companyId, orderId)).repairability).toBe("MANUAL_REVIEW");
      await refused(fixture, orderId, await requestFor(fixture, orderId), "repair_capability_not_applicable");

      // RESET candidate (manual review) is refused even when named explicitly.
      const reset = await feeOrder(fixture);
      await craftCodCoversFee(reset.orderId);
      const preview = await previews.preview(fixture.companyId, reset.orderId);
      expect(preview).toMatchObject({
        execution: { available: false },
        proposedRepair: { capabilityCode: "RESET_TRADER_RECEIVABLE", candidateOnly: true },
        repairability: "MANUAL_REVIEW",
      });
      await refused(
        fixture,
        reset.orderId,
        await requestFor(fixture, reset.orderId, { capabilityCode: "RESET_TRADER_RECEIVABLE" }),
        "repair_not_ready",
      );
    });

    it("inputs: undeclared inputs are rejected before anything runs", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      await refused(
        fixture,
        orderId,
        await requestFor(fixture, orderId, { inputs: { amount: "1.00" } }),
        "repair_inputs_invalid",
      );
      expect(await receivables(fixture, orderId)).toEqual([]);
    });

    it("CASE 16: audit-write failure rolls back the whole repair", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      vi.spyOn(executions as never as { writeAudit: () => Promise<never> }, "writeAudit").mockRejectedValueOnce(
        new Error("audit store unavailable"),
      );
      const before = await footprint(fixture.companyId);
      await expect(run(fixture, orderId, await requestFor(fixture, orderId))).rejects.toThrow(
        "audit store unavailable",
      );
      expect(await footprint(fixture.companyId)).toBe(before);
      expect(await receivables(fixture, orderId)).toEqual([]);
      expect((await previews.preview(fixture.companyId, orderId)).repairability).toBe("READY");
    });

    it("CASE 17: post-repair verification failure rolls back the whole repair", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      vi.spyOn(executions as never as { verifyRepaired: () => void }, "verifyRepaired").mockImplementationOnce(() => {
        throw new ApplicationException("repair_verification_failed", "forced", 409);
      });
      await refused(fixture, orderId, await requestFor(fixture, orderId), "repair_verification_failed");
      expect(await receivables(fixture, orderId)).toEqual([]);
      expect(await audits(fixture, orderId)).toEqual([]);
    });

    it("Part X: concurrent executions of one READY finding -> exactly one repair", async () => {
      // Different keys: one succeeds, the other sees the committed repair.
      const orderId = await legacyOrderWithoutReceivable(fixture);
      const request = await requestFor(fixture, orderId);
      const results = await Promise.allSettled([
        run(fixture, orderId, request),
        run(fixture, orderId, { ...request, idempotencyKey: `rc-exec-${randomUUID()}` }),
        run(fixture, orderId, { ...request, idempotencyKey: `rc-exec-${randomUUID()}` }),
      ]);
      expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      for (const item of results.filter((entry) => entry.status === "rejected")) {
        expect(["repair_finding_not_current", "repair_preview_stale"]).toContain(
          ((item as PromiseRejectedResult).reason as ApplicationException).errorCode,
        );
      }
      expect(await receivables(fixture, orderId)).toHaveLength(1);
      expect(await audits(fixture, orderId)).toHaveLength(1);

      // Same key: one executes, the others replay the same result.
      const second = await legacyOrderWithoutReceivable(fixture);
      const same = await requestFor(fixture, second);
      const replays = await Promise.all([run(fixture, second, same), run(fixture, second, same), run(fixture, second, same)]);
      expect(replays.filter((item) => !item.replayed)).toHaveLength(1);
      expect(new Set(replays.map((item) => item.repairExecutionId)).size).toBe(1);
      expect(await receivables(fixture, second)).toHaveLength(1);
    });
  });

  describe("Accounting ON company", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await createFixture("on");
    }, 300_000);

    it("CASE 12 (revised Prompt 4): Accounting ON missing-receivable repair is BLOCKED -- its event could never post; zero mutation", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      const preview = await previews.preview(fixture.companyId, orderId, { reasonCode: "MISSING_RECEIVABLE" });
      expect(preview).toMatchObject({ accountingMode: { enabled: true }, execution: { available: false }, repairability: "BLOCKED" });
      expect(preview.blockers.map((blocker) => blocker.code)).toContain("PLATFORM_ACTOR_CANNOT_POST_JOURNAL");
      const journals = await companyCount("journal_entries", fixture.companyId);
      await refused(
        fixture,
        orderId,
        await requestFor(fixture, orderId, { findingId: preview.finding.findingId, previewVersion: preview.previewVersion }),
        "repair_not_ready",
      );
      expect(await receivables(fixture, orderId)).toEqual([]);
      expect(await companyCount("journal_entries", fixture.companyId)).toBe(journals);
      // Prompt 5 Part Q: still BLOCKED; no receivable event; the refusal is durable.
      expect(
        (
          await sql<{ n: number }>`select count(*)::int as n from accounting_events
            where company_id = ${fixture.companyId}::uuid and source_reference = ${await orderNumber(orderId)}`.execute(db)
        ).rows[0]!.n,
      ).toBe(0);
      const attempt = (
        await sql<{ result: string; code: string; execution: string | null }>`
          select result, error_code as code, repair_execution_id as execution from platform_repair_attempts
           where company_id = ${fixture.companyId}::uuid and entity_id = ${orderId}::uuid`.execute(db)
      ).rows;
      expect(attempt).toEqual([{ code: "repair_not_ready", execution: null, result: "REFUSED" }]);
    });

    it("CASE 5c: an accounting-event state change between preview and execute -> repair_preview_stale", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      // Crafted: the receivable reversed with no replacement (REVERSED_NEEDS_REPAIR).
      await crafted(sql`update trader_receivables set status = 'reversed' where id = ${receivableId}::uuid`);
      const request = await requestFor(fixture, orderId);
      // BLOCKED under Accounting ON (Prompt 4), but a changed state is still
      // reported as STALE first: the fingerprint check precedes READY.
      expect((await previews.preview(fixture.companyId, orderId)).repairability).toBe("BLOCKED");
      await crafted(sql`update accounting_events set processing_status = 'failed', failed_at = now()
        where company_id = ${fixture.companyId}::uuid and source_entity_type = 'trader_receivable'
          and source_entity_id = ${receivableId}::uuid`);
      await refused(fixture, orderId, request, "repair_preview_stale");
    });
  });

  it("CASE 13: another Company's path cannot execute the Order -> 404, zero mutation in both Companies", async () => {
    const a = await createFixture("off");
    const b = await createFixture("off");
    const orderId = await legacyOrderWithoutReceivable(a);
    const request = await requestFor(a, orderId);
    const beforeA = await footprint(a.companyId);
    const beforeB = await footprint(b.companyId);
    await expect(
      asPlatform(b.companyId, () => executions.execute(b.companyId, orderId, request, actor())),
    ).rejects.toMatchObject({ errorCode: "order_not_found" });
    expect(await footprint(a.companyId)).toBe(beforeA);
    expect(await footprint(b.companyId)).toBe(beforeB);
  });

  it("the audit is immutable: UPDATE and DELETE are rejected", async () => {
    const fixture = await createFixture("off");
    const orderId = await legacyOrderWithoutReceivable(fixture);
    const result = await run(fixture, orderId, await requestFor(fixture, orderId));
    await expect(
      sql`update platform_repair_executions set reason = 'changed' where id = ${result.repairExecutionId}::uuid`.execute(db),
    ).rejects.toThrow(/append-only/u);
    await expect(
      sql`delete from platform_repair_executions where id = ${result.repairExecutionId}::uuid`.execute(db),
    ).rejects.toThrow(/append-only/u);
  });

  // ===========================================================================
  // Phase 2 Prompt 5 -- durable attempt audit (Parts A-D, N, O, P), Repair
  // History (F-I), consolidated overview (J) and the order E2E (L).
  // ===========================================================================
  describe("Prompt 5 -- repair attempt audit and Repair History", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await createFixture("off");
    }, 300_000);

    interface AttemptRow {
      id: string;
      result: string;
      errorCode: string | null;
      summary: string | null;
      actor: string;
      authority: string;
      keyHash: string | null;
      previewVersion: string | null;
      entityType: string;
      entityId: string;
      entityNumber: string | null;
      reasonCode: string | null;
      capability: string | null;
      executionId: string | null;
      correlationId: string | null;
      row: string;
    }

    async function attempts(companyId: string, entityId?: string): Promise<AttemptRow[]> {
      return (
        await sql<AttemptRow>`
          select id, result, error_code as "errorCode", safe_error_summary as summary,
                 actor_account_id as actor, actor_authority as authority, idempotency_key_sha256 as "keyHash",
                 preview_version as "previewVersion", entity_type as "entityType", entity_id as "entityId",
                 entity_number as "entityNumber", reason_code as "reasonCode", capability_code as capability,
                 repair_execution_id as "executionId", correlation_id as "correlationId", t::text as row
            from platform_repair_attempts t
           where company_id = ${companyId}::uuid
             and (${entityId ?? null}::uuid is null or entity_id = ${entityId ?? null}::uuid)
           order by created_at, id`.execute(db)
      ).rows;
    }

    const sha = (value: string) => createHash("sha256").update(value).digest("hex");

    /** A refusal: durable REFUSED attempt, zero business mutation, no execution row. */
    async function refusedDurably(
      orderId: string,
      request: RepairExecutionRequest,
      errorCode: string,
    ): Promise<AttemptRow> {
      const before = await attempts(fixture.companyId, orderId);
      await refused(fixture, orderId, request, errorCode);
      const after = await attempts(fixture.companyId, orderId);
      expect(after).toHaveLength(before.length + 1);
      const row = after.at(-1)!;
      expect(row).toMatchObject({
        actor: adminId,
        authority: "platform.companies.repair_center.execute",
        entityId: orderId,
        entityType: "order",
        errorCode,
        executionId: null,
        keyHash: sha(request.idempotencyKey),
        result: "REFUSED",
      });
      // Never the raw idempotency key, never a stack trace.
      expect(row.row).not.toContain(request.idempotencyKey);
      expect(row.row).not.toMatch(/\bat [A-Za-z].*\.(ts|js):\d+/u);
      expect(row.correlationId).toMatch(/^rc-exec-/u);
      return row;
    }

    it("P: stale preview, finding not current, not READY, unsupported / inapplicable capability, wrong input, idempotency conflict -> durable REFUSED", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      const number = await orderNumber(orderId);
      // stale preview
      const stale = await refusedDurably(
        orderId,
        await requestFor(fixture, orderId, { previewVersion: `rcv1:${"0".repeat(64)}` }),
        "repair_preview_stale",
      );
      expect(stale).toMatchObject({ entityNumber: number, reasonCode: "MISSING_RECEIVABLE" });
      // finding not current
      await refusedDurably(
        orderId,
        await requestFor(fixture, orderId, { findingId: "fnd_000000000000000000000000" }),
        "repair_finding_not_current",
      );
      // unsupported capability (unknown code) -- refused before any order is read
      await refusedDurably(orderId, await requestFor(fixture, orderId, { capabilityCode: "FORCE_ORDER_STATUS" }), "repair_capability_unknown");
      // capability that is not the finding's certified capability
      const wrongCapability = await requestFor(fixture, orderId, { capabilityCode: "RESET_TRADER_RECEIVABLE" });
      const wrongCapabilityError = await run(fixture, orderId, wrongCapability).catch((error: ApplicationException) => error.errorCode);
      expect(["repair_capability_not_applicable", "repair_capability_not_executable"]).toContain(wrongCapabilityError);
      expect((await attempts(fixture.companyId, orderId)).at(-1)).toMatchObject({ errorCode: wrongCapabilityError, result: "REFUSED" });
      // wrong input
      await refusedDurably(orderId, await requestFor(fixture, orderId, { inputs: { amount: "1" } }), "repair_inputs_invalid");
      // repairability not READY (BLOCKED: amount differs from the financial model)
      const blocked = await legacyOrderWithoutReceivable(fixture, { codAmount: 5 });
      expect((await previews.preview(fixture.companyId, blocked)).repairability).toBe("BLOCKED");
      const blockedRow = await refusedDurably(blocked, await requestFor(fixture, blocked), "repair_not_ready");
      expect(blockedRow.reasonCode).toBe("MISSING_RECEIVABLE");
      // a HEALTHY order (NOT_REQUIRED): no capability applies
      const healthy = await feeOrder(fixture);
      const healthyRow = await refusedDurably(healthy.orderId, await requestFor(fixture, healthy.orderId), "repair_capability_not_applicable");
      expect(healthyRow.reasonCode).toBe("HEALTHY_ACTIVE_RECEIVABLE");
      // idempotency conflict: the same key, a different request, after a success
      const request = await requestFor(fixture, orderId);
      const success = await run(fixture, orderId, request);
      await refusedDurably(orderId, { ...request, reason: "A different reason" }, "repair_idempotency_conflict");
      // None of the refusals created a success record.
      expect(await audits(fixture, orderId)).toHaveLength(1);
      expect((await audits(fixture, orderId))[0]!.id).toBe(success.repairExecutionId);
    });

    it("O: a FAILED execution rolls back, records FAILED, writes no execution row and says no repair was applied", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      const request = await requestFor(fixture, orderId);
      const before = await footprint(fixture.companyId);
      const spy = vi
        .spyOn(executions as never as { writeAudit: () => Promise<never> }, "writeAudit")
        .mockRejectedValueOnce(new Error('insert into "platform_repair_executions" failed: secret detail at x.ts:12'));
      await expect(run(fixture, orderId, request)).rejects.toThrow(/secret detail/u);
      expect(spy).toHaveBeenCalledTimes(1);
      // Rolled back: the receivable the domain operation created is gone.
      expect(await footprint(fixture.companyId)).toBe(before);
      expect(await receivables(fixture, orderId)).toEqual([]);
      expect(await audits(fixture, orderId)).toEqual([]);
      const [failed] = await attempts(fixture.companyId, orderId);
      expect(failed).toMatchObject({
        errorCode: "repair_execution_failed",
        executionId: null,
        result: "FAILED",
        summary: "The repair failed unexpectedly; no repair was applied.",
      });
      expect(failed!.row).not.toContain("secret detail");
      const history = get(RepairHistoryService);
      const detail = await history.detail(fixture.companyId, "attempt", failed!.id);
      expect(detail).toMatchObject({ execution: null, repairApplied: false, result: "FAILED" });
      expect(detail.repairAppliedStatement).toMatch(/^No repair was applied/u);
      // Business state unchanged: the order is still repairable afterwards.
      expect((await previews.preview(fixture.companyId, orderId)).repairability).toBe("READY");
    });

    it("O: a verification failure (ApplicationException) is FAILED with its own safe code", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      vi.spyOn(executions as never as { verifyRepaired: () => void }, "verifyRepaired").mockImplementationOnce(() => {
        throw new ApplicationException("repair_verification_failed", "The repair did not verify; everything was rolled back", 409);
      });
      await expect(run(fixture, orderId, await requestFor(fixture, orderId))).rejects.toMatchObject({
        errorCode: "repair_verification_failed",
      });
      expect(await receivables(fixture, orderId)).toEqual([]);
      expect((await attempts(fixture.companyId, orderId)).map((row) => [row.result, row.errorCode])).toEqual([
        ["FAILED", "repair_verification_failed"],
      ]);
    });

    it("N: an idempotent replay records REPLAYED linked to the one execution -- never a second success", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      const request = await requestFor(fixture, orderId);
      const first = await run(fixture, orderId, request);
      const replay = await run(fixture, orderId, request);
      expect(replay).toMatchObject({ repairExecutionId: first.repairExecutionId, replayed: true });
      expect(await audits(fixture, orderId)).toHaveLength(1);
      expect(await receivables(fixture, orderId)).toHaveLength(1);
      expect((await attempts(fixture.companyId, orderId)).map((row) => [row.result, row.executionId])).toEqual([
        ["REPLAYED", first.repairExecutionId],
      ]);
      const history = get(RepairHistoryService);
      const page = await history.list(fixture.companyId, { pageSize: 100 });
      const mine = page.items.filter((row) => row.entityId === orderId);
      expect(mine.filter((row) => row.result === "SUCCEEDED")).toHaveLength(1);
      expect(mine.filter((row) => row.result === "REPLAYED")).toHaveLength(1);
      expect(mine.find((row) => row.result === "REPLAYED")).toMatchObject({ repairApplied: false, repairExecutionId: first.repairExecutionId });
      const detail = await history.detail(fixture.companyId, "execution", first.repairExecutionId);
      expect(detail.execution?.replays).toBe(1);
    });

    it("C: a failure to write the attempt log never changes the outcome (refusal stays a refusal, replay stays a replay)", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      const request = await requestFor(fixture, orderId);
      // An actor account that does not exist makes the attempt INSERT fail (FK).
      const ghost = { ...actor(), accountId: randomUUID() };
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      await expect(
        asPlatform(fixture.companyId, () =>
          executions.execute(fixture.companyId, orderId, { ...request, previewVersion: `rcv1:${"1".repeat(64)}` }, ghost),
        ),
      ).rejects.toMatchObject({ errorCode: "repair_preview_stale" });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/repair attempt audit write failed/u));
      expect(await receivables(fixture, orderId)).toEqual([]);
      const first = await run(fixture, orderId, request);
      const replay = await asPlatform(fixture.companyId, () => executions.execute(fixture.companyId, orderId, request, ghost));
      expect(replay).toMatchObject({ repairExecutionId: first.repairExecutionId, replayed: true });
      expect(await attempts(fixture.companyId, orderId)).toEqual([]);
    });

    it("B: platform_repair_attempts is append-only (UPDATE and DELETE rejected)", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      await run(fixture, orderId, await requestFor(fixture, orderId, { findingId: "fnd_000000000000000000000000" })).catch(() => undefined);
      const [row] = await attempts(fixture.companyId, orderId);
      await expect(
        sql`update platform_repair_attempts set reason = 'changed' where id = ${row!.id}::uuid`.execute(db),
      ).rejects.toThrow(/append-only/u);
      await expect(sql`delete from platform_repair_attempts where id = ${row!.id}::uuid`.execute(db)).rejects.toThrow(
        /append-only/u,
      );
      await expect(
        sql`insert into platform_repair_attempts (company_id, entity_type, entity_id, actor_account_id, actor_authority, result)
            values (${fixture.companyId}::uuid, 'order', ${orderId}::uuid, ${adminId}::uuid, 'x', 'SUCCEEDED')`.execute(db),
      ).rejects.toThrow(/check/u);
      await expect(
        sql`insert into platform_repair_attempts (company_id, entity_type, entity_id, actor_account_id, actor_authority, result)
            values (${fixture.companyId}::uuid, 'order', ${orderId}::uuid, ${adminId}::uuid, 'x', 'REPLAYED')`.execute(db),
      ).rejects.toThrow(/replay_links_execution/u);
    });

    it("L + F-J: order E2E -- history newest first, details, overview counts; HEALTHY order offers no execution", async () => {
      const company = await createFixture("off");
      const history = get(RepairHistoryService);
      const overview = get(RepairCenterOverviewService);
      expect(await history.counts(company.companyId)).toMatchObject({ failed: 0, refused: 0, replayed: 0, succeeded: 0 });
      const orderId = await legacyOrderWithoutReceivable(company);
      expect((await previews.analyze(company.companyId, orderId)).health).toBe("ISSUE");
      // refused first, then success
      await run(company, orderId, await requestFor(company, orderId, { findingId: "fnd_000000000000000000000000" })).catch(() => undefined);
      const success = await run(company, orderId, await requestFor(company, orderId));
      const page = await history.list(company.companyId, {});
      expect(page.total).toBe(2);
      expect(page.items.map((row) => row.result)).toEqual(["SUCCEEDED", "REFUSED"]);
      expect(page.items[0]).toMatchObject({
        actor: `rc.exec.${adminId}`,
        capabilityCode: "REPAIR_TRADER_RECEIVABLE",
        entityNumber: await orderNumber(orderId),
        entityType: "order",
        reasonCode: "MISSING_RECEIVABLE",
        repairApplied: true,
      });
      const detail = await history.detail(company.companyId, "execution", success.repairExecutionId);
      expect(detail).toMatchObject({
        companyId: company.companyId,
        execution: {
          afterClassification: "HEALTHY_ACTIVE_RECEIVABLE",
          afterHealth: "HEALTHY",
          beforeClassification: "MISSING_RECEIVABLE",
          beforeHealth: "ISSUE",
          replays: 0,
        },
        result: "SUCCEEDED",
      });
      expect(detail.execution?.beforeFingerprint).toBe(success.beforePreviewVersion);
      expect(detail.execution?.afterFingerprint).toBe(success.afterPreviewVersion);
      expect(JSON.stringify(detail)).not.toMatch(/Customer|971500000001|Address/u);
      // filters + pagination in the database
      expect((await history.list(company.companyId, { result: "REFUSED" })).items).toHaveLength(1);
      const paged = await history.list(company.companyId, { page: 2, pageSize: 1 });
      expect(paged).toMatchObject({ page: 2, pageSize: 1, total: 2 });
      expect(paged.items.map((row) => row.result)).toEqual(["REFUSED"]);
      expect((await history.list(company.companyId, { pageSize: 10_000 })).pageSize).toBe(100);
      // overview
      const landing = await overview.overview(company.companyId);
      expect(landing.repairHistory).toMatchObject({ failed: 0, refused: 1, replayed: 0, succeeded: 1 });
      expect(landing.accountingMode.enabled).toBe(false);
      expect(landing.accountingHealth.readyCandidateNote).toMatch(/READY is decided only by Preview/u);
      expect(Object.keys(landing.accountingHealth)).not.toContain("ready");
      // HEALTHY now: NOT_REQUIRED, no executable repair
      const healthyPreview = await previews.preview(company.companyId, orderId);
      expect(healthyPreview).toMatchObject({ execution: { available: false }, repairability: "NOT_REQUIRED" });
    });

    it("U: history is tenant-scoped -- duplicate order numbers across Companies never leak", async () => {
      const a = await createFixture("off");
      const b = await createFixture("off");
      const orderA = await legacyOrderWithoutReceivable(a);
      const orderB = await legacyOrderWithoutReceivable(b);
      // Crafted: Company B's order carries Company A's order number.
      await crafted(sql`update orders set order_number = ${await orderNumber(orderA)} where id = ${orderB}::uuid`);
      const successA = await run(a, orderA, await requestFor(a, orderA));
      await run(b, orderB, await requestFor(b, orderB, { findingId: "fnd_000000000000000000000000" })).catch(() => undefined);
      const history = get(RepairHistoryService);
      const listA = await history.list(a.companyId, {});
      const listB = await history.list(b.companyId, {});
      expect(listA.items.map((row) => row.entityId)).toEqual([orderA]);
      expect(listB.items.map((row) => row.entityId)).toEqual([orderB]);
      expect(listB.items.map((row) => row.result)).toEqual(["REFUSED"]);
      // A's record cannot be opened through B.
      await expect(history.detail(b.companyId, "execution", successA.repairExecutionId)).rejects.toMatchObject({
        errorCode: "repair_history_not_found",
      });
      const attemptB = listB.items[0]!.id;
      await expect(history.detail(a.companyId, "attempt", attemptB)).rejects.toMatchObject({
        errorCode: "repair_history_not_found",
      });
      expect((await history.counts(a.companyId)).refused).toBe(0);
      expect((await history.counts(b.companyId)).succeeded).toBe(0);
    });
  });
});
