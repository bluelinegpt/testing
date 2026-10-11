import { createHash, randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { AccountingEventRepository } from "../accounting/accounting-event.repository.js";
import { CashBankManagementService } from "../accounting/cash-bank-management.service.js";
import { OperationalJournalPostingService } from "../accounting/operational-journal-posting.service.js";
import {
  accountingOnIntervalsSql,
  PlatformAccountingHealthService,
} from "../accounting/platform-accounting-health.service.js";
import { PlatformAccountingRepairAdapter } from "../accounting/platform-accounting-repair.adapter.js";
import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import { OperationsService } from "./operations.service.js";
import { ReceivableOffsetReversalService } from "./receivable-offset-reversal.service.js";
import { RepairAccountingRecoveryService } from "./repair-accounting-recovery.service.js";
import { type RepairExecutionRequest, RepairExecutionService } from "./repair-execution.service.js";
import { RepairPreviewService } from "./repair-preview.service.js";
import { TraderReceivableService } from "./trader-receivable.service.js";
import { TraderSettlementService } from "./trader-settlement.service.js";
import { PayrollAdjustmentService } from "../payroll/payroll-adjustment.service.js";
import { PayrollCalculationService } from "../payroll/payroll-calculation.service.js";
import { PayrollOperationalRepository } from "../payroll/payroll-operational.repository.js";
import { PayrollPaymentService } from "../payroll/payroll-payment.service.js";
import { PayrollPeriodService } from "../payroll/payroll-period.service.js";
import { PURGE_TABLES, PRESERVE_TABLES } from "../platform/reset-company-test-data.manifest.js";
import { PlatformPayrollHealthService, RepairPayrollService } from "./payroll-repair.service.js";
import { OrderMaintenanceService } from "./order-maintenance.service.js";
import { RepairCenterOverviewService } from "./repair-center-overview.service.js";
import { RepairHistoryService } from "./repair-history.service.js";

/**
 * REPAIR CENTER PHASE 6 -- FINAL SYSTEM INTEGRATION CERTIFICATION.
 *
 * The complete Repair Center as ONE system: the landing (one health
 * contract, every domain, de-duplicated root causes), cross-domain flows
 * (Order -> Trader receivable -> Settlement -> Accounting; Payroll -> payment
 * -> Accounting) with deterministic repair ORDERING, Verify / Preview /
 * Execute parity, one coherent Repair History across domains, immutable
 * audit, tenant isolation across every domain, and Reset classification.
 *
 * The REAL Payroll services (period create / calculate / approve, payment
 * confirm / reverse, adjustments) against the disposable database. Every
 * "crafted" statement runs with triggers bypassed (disposable DB only) and
 * stands for history the application cannot produce on its own (an approved
 * line edited in place, a paid status without an allocation, a deleted
 * accounting event...). Every refusal proves zero mutation with a content
 * checksum of every table a repair could touch.
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
  "payroll.view",
  "payroll.manage",
  "payroll.approve",
  "payroll.pay",
  "payroll.reverse",
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

describe.skipIf(!runDatabaseTests)("Repair Center Phase 6 -- final system integration certification", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let store: RequestSecurityContextStore;
  let get: <T>(type: new (...args: never[]) => T) => T;
  let previews: RepairPreviewService;
  let executions: RepairExecutionService;
  let recovery: RepairAccountingRecoveryService;
  let health: PlatformAccountingHealthService;
  const adminId = randomUUID();
  let statements = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    db = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === "query") statements += 1;
      },
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(db)
      .compile();
    get = (type) => module.get(type, { strict: false });
    store = module.get(RequestSecurityContextStore, { strict: false });
    previews = get(RepairPreviewService);
    executions = get(RepairExecutionService);
    recovery = get(RepairAccountingRecoveryService);
    health = get(PlatformAccountingHealthService);
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

  const key = (label: string) => `rc6.${label}.${randomUUID()}`;

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`RC6-${tag}`},${`rc6-${tag}`},${`RC6 ${mode} ${tag}`},
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
      "journal_lines",
      "accounting_event_components",
      "accounting_configurations",
      "account_mappings",
      "accounting_periods",
      "payroll_periods",
      "payroll_entries",
      "payroll_adjustments",
      "payroll_line_allowances",
      "payroll_payments",
      "payroll_payment_allocations",
      "employee_salary_versions",
      "employees",
      "outsourced_driver_fee_accruals",
      "outsourced_driver_fee_payment_allocations",
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
  // Accounting recovery helpers
  // ---------------------------------------------------------------------------

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
    correlationId: `rc-acc-${randomUUID()}`,
  });

  /** An Accounting ON Company with automatic posting enabled (template areas). */
  async function postingFixture(): Promise<Fixture> {
    const fixture = await createFixture("on");
    await sql`update accounting_configurations
                 set automatic_posting_enabled = true,
                     automatic_posting_enabled_by_account_id = ${fixture.actorId}::uuid,
                     automatic_posting_enabled_at = now(), version = version + 1
               where company_id = ${fixture.companyId}::uuid`.execute(db);
    return fixture;
  }

  /**
   * A supported, FAILED `trader_receivable_recognized` event. The receivable
   * and its event come from the real services; the failure is crafted exactly
   * as the processor records one (status, category, code, summary, attempt).
   */
  async function failedRecognition(fixture: Fixture) {
    const { orderId, receivableId } = await feeOrder(fixture);
    const eventId = (
      await sql<{ id: string }>`select id from accounting_events
        where company_id = ${fixture.companyId}::uuid and source_entity_type = 'trader_receivable'
          and source_entity_id = ${receivableId}::uuid and event_type = 'trader_receivable_recognized'`.execute(db)
    ).rows[0]!.id;
    await crafted(sql`update accounting_events
        set processing_status = 'failed', failed_at = now(), attempt_count = 1,
            failure_category = 'configuration', error_code = 'accounting_event_mapping_missing',
            safe_error_summary = 'Crafted: the mapping could not be resolved at the time'
      where id = ${eventId}::uuid`);
    return { eventId, orderId, receivableId };
  }

  async function requestFor(
    fixture: Fixture,
    eventId: string,
    overrides: Partial<RepairExecutionRequest> = {},
  ): Promise<RepairExecutionRequest> {
    const preview = await recovery.preview(fixture.companyId, eventId);
    return {
      capabilityCode: "REPROCESS_ACCOUNTING_EVENT",
      findingId: preview.finding.findingId,
      idempotencyKey: `rc-acc-${randomUUID()}`,
      previewVersion: preview.previewVersion,
      reason: "Mapping fixed; recover the failed recognition event",
      ...overrides,
    };
  }

  function run(fixture: Fixture, eventId: string, request: RepairExecutionRequest) {
    return asPlatform(fixture.companyId, () =>
      executions.executeAccountingEvent(fixture.companyId, eventId, request, actor()),
    );
  }

  async function refused(fixture: Fixture, eventId: string, request: RepairExecutionRequest, errorCode: string) {
    const before = await footprint(fixture.companyId);
    await expect(run(fixture, eventId, request)).rejects.toMatchObject({ errorCode });
    expect(await footprint(fixture.companyId), "a refused recovery must not mutate anything").toBe(before);
  }

  async function eventRow(eventId: string) {
    return (
      await sql<{ status: string; journalId: string | null; attempts: number; errorCode: string | null; reviewer: string | null }>`
        select processing_status as status, journal_id as "journalId", attempt_count as attempts,
               error_code as "errorCode", reviewed_by_account_id as reviewer
          from accounting_events where id = ${eventId}::uuid`.execute(db)
    ).rows[0]!;
  }

  async function journalsFor(eventId: string) {
    return (
      await sql<{ id: string; status: string; debit: string; credit: string }>`
        select j.id, j.status,
               (select sum(debit)::text from journal_lines l where l.journal_entry_id = j.id) as debit,
               (select sum(credit)::text from journal_lines l where l.journal_entry_id = j.id) as credit
          from journal_entries j where j.accounting_event_id = ${eventId}::uuid`.execute(db)
    ).rows;
  }

  async function auditCount(companyId: string, eventId: string) {
    return (
      await sql<{ n: number }>`select count(*)::int as n from platform_repair_executions
        where company_id = ${companyId}::uuid and entity_id = ${eventId}::uuid`.execute(db)
    ).rows[0]!.n;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Phase 4 helpers
  // ---------------------------------------------------------------------------

  async function eventOf(fixture: Fixture, sourceType: string, sourceId: string, eventType: string) {
    const rows = await sql<{ id: string }>`select id from accounting_events
      where company_id = ${fixture.companyId}::uuid and source_entity_type = ${sourceType}
        and source_entity_id = ${sourceId}::uuid and event_type = ${eventType}`.execute(db);
    expect(rows.rows, `${eventType} for ${sourceType}`).toHaveLength(1);
    return rows.rows[0]!.id;
  }

  /** The worker's own path, for exactly one event: certified claim + posting core. */
  async function postNow(fixture: Fixture, eventId: string) {
    await db.transaction().execute(async (transaction) => {
      const record = await get(AccountingEventRepository).claimInTransaction(
        transaction,
        fixture.companyId,
        eventId,
        "phase4-test-worker",
      );
      expect(record, "the event must be claimable").toBeDefined();
      await get(OperationalJournalPostingService).process(transaction, record!);
    });
    expect((await eventRow(eventId)).status).toBe("posted");
  }

  /** Crafted: the processor's own FAILED record for one event. */
  async function craftFailed(eventId: string, code = "accounting_event_mapping_missing") {
    await crafted(sql`update accounting_events
        set processing_status = 'failed', failed_at = now(), attempt_count = 1,
            failure_category = 'configuration', error_code = ${code},
            safe_error_summary = 'Crafted: the posting failed at the time'
      where id = ${eventId}::uuid`);
  }

  async function reconcileCash(fixture: Fixture, orderId: string) {
    await as(fixture, () =>
      get(DriverCashReconciliationService).confirmSingleOrder(orderId, { paymentMethod: "cash" } as never, randomUUID(), key("reconcile")),
    );
  }

  async function reconciliationOf(fixture: Fixture, orderId: string) {
    return (
      await sql<{ id: string }>`select r.id from driver_reconciliations r
        join driver_reconciliation_orders o on o.company_id = r.company_id and o.reconciliation_id = r.id
       where r.company_id = ${fixture.companyId}::uuid and o.order_id = ${orderId}::uuid
         and r.status = 'confirmed' and r.reversal_of_id is null`.execute(db)
    ).rows[0]!.id;
  }

  /** A delivered COD Order with Driver cash reconciled: Trader payable 100 - 18 = 82. */
  async function payableOrder(fixture: Fixture) {
    const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
    await reconcileCash(fixture, orderId);
    return orderId;
  }

  async function settle(fixture: Fixture, receivableId?: string, offset = FEE) {
    const payable = await payableOrder(fixture);
    const result = (await as(fixture, () =>
      get(TraderSettlementService).createPayment(
        {
          allocations: [{ amount: 82, orderId: payable }],
          amount: receivableId === undefined ? 82 : 82 - offset,
          cashAccountId: fixture.cashAccountId,
          paymentDate: today,
          paymentMethod: "cash",
          ...(receivableId === undefined ? {} : { receivableOffsets: [{ amount: offset, receivableId }] }),
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("settle"),
      ),
    )) as { settlementId?: string; id?: string };
    return { payable, settlementId: (result.settlementId ?? result.id)! };
  }

  async function collect(fixture: Fixture, receivableId: string, amount = FEE) {
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
    return (
      await sql<{ id: string }>`select c.id from trader_collections c
        join trader_collection_allocations a on a.company_id = c.company_id and a.collection_id = c.id
       where c.company_id = ${fixture.companyId}::uuid and a.receivable_id = ${receivableId}::uuid
       order by c.created_at desc limit 1`.execute(db)
    ).rows[0]!.id;
  }

  /** A Trader Credit (receivable offset reversal) whose Settlement's event is Posted. */
  async function creditFixture(fixture: Fixture) {
    const { receivableId } = await feeOrder(fixture);
    await postNow(fixture, await eventOf(fixture, "trader_receivable", receivableId, "trader_receivable_recognized"));
    const { payable, settlementId } = await settle(fixture, receivableId);
    await postNow(fixture, await eventOf(fixture, "order", payable, "order_delivered"));
    await postNow(fixture, await eventOf(fixture, "trader_settlement", settlementId, "trader_settlement_confirmed"));
    await as(fixture, () => get(ReceivableOffsetReversalService).execute(receivableId, "Fee reset", randomUUID()));
    const creditId = (
      await sql<{ id: string }>`select id from trader_credits
        where company_id = ${fixture.companyId}::uuid and source_receivable_id = ${receivableId}::uuid`.execute(db)
    ).rows[0]!.id;
    return { creditId, eventId: await eventOf(fixture, "trader_credit", creditId, "trader_credit_issued"), settlementId };
  }

  /** Recover ONE event end to end and prove exactly one balanced Journal. */
  async function recoverAndProve(fixture: Fixture, eventId: string) {
    const preview = await recovery.preview(fixture.companyId, eventId);
    expect(preview.repairability, JSON.stringify(preview.blockers)).toBe("READY");
    expect(preview.recovery).toMatchObject({
      fiscalPeriod: { status: "open" },
      mappings: { state: "RESOLVED" },
      originalActor: { state: "VALID" },
      source: { state: "PRESENT" },
    });
    expect(preview.recovery.mappings.lines.length).toBeGreaterThanOrEqual(2);
    const result = await run(fixture, eventId, await requestFor(fixture, eventId));
    expect(result).toMatchObject({ afterClassification: "posted", replayed: false, status: "succeeded" });
    const journals = await journalsFor(eventId);
    expect(journals).toHaveLength(1);
    expect(journals[0]!.status).toBe("posted");
    expect(journals[0]!.debit).toBe(journals[0]!.credit);
    expect(Number(journals[0]!.debit)).toBeGreaterThan(0);
    expect((await recovery.details(fixture.companyId, eventId)).finding).toMatchObject({
      current: false,
      health: "HEALTHY",
      repairability: "NOT_REQUIRED",
    });
    return result;
  }

  async function setAccounting(fixture: Fixture, enabled: boolean) {
    // Not crafted: the configuration history writer records the mode change,
    // which is what `accounting_enabled_at` (and missing-event detection) reads.
    await sql`update accounting_configurations
                 set accounting_enabled = ${enabled},
                     automatic_posting_enabled = ${enabled},
                     automatic_posting_enabled_by_account_id = case when ${enabled} then ${fixture.actorId}::uuid end,
                     automatic_posting_enabled_at = case when ${enabled} then now() end,
                     version = version + 1
               where company_id = ${fixture.companyId}::uuid`.execute(db);
  }

  async function integrityOf(fixture: Fixture) {
    return health.integrityFindings(fixture.companyId, { pageSize: 100 });
  }


  const MONTH = today.slice(0, 7);
  const payrollHealth = () => get(PlatformPayrollHealthService);
  const payrollRepairs = () => get(RepairPayrollService);

  /** A Company (Accounting `mode`) with two payroll-eligible employees on 1,000 / 2,000. */
  async function payrollFixture(mode: Mode | "posting" = "posting") {
    const fixture = mode === "posting" ? await postingFixture() : await createFixture(mode);
    // The fixture's delivery-driver employee has no salary: not on Payroll.
    await sql`update employees set payroll_eligible = false where company_id = ${fixture.companyId}::uuid`.execute(db);
    const employees: string[] = [];
    for (const salary of [1000, 2000]) {
      const id = randomUUID();
      await sql`insert into employees(id,company_id,employee_number,name_en,employee_type,hired_on,payroll_eligible,is_active)
        values (${id}::uuid,${fixture.companyId}::uuid,${`PE-${id.slice(0, 6)}`},${`Employee ${salary}`},'employee',
                '2026-01-01'::date,true,true)`.execute(db);
      await sql`insert into employee_salary_versions(company_id,employee_id,basic_salary,effective_from,created_by_account_id)
        values (${fixture.companyId}::uuid,${id}::uuid,${salary},'2026-01-01'::date,${fixture.actorId}::uuid)`.execute(db);
      employees.push(id);
    }
    return { ...fixture, employees };
  }
  type PayrollFixture = Awaited<ReturnType<typeof payrollFixture>>;

  async function calculatedPeriod(fixture: PayrollFixture) {
    const period = (await as(fixture, () =>
      get(PayrollPeriodService).create(MONTH, undefined, key("period"), randomUUID()),
    )) as { periodId: string };
    await as(fixture, () => get(PayrollCalculationService).calculate(period.periodId, key("calculate"), randomUUID(), true));
    return period.periodId;
  }

  async function approvedPeriod(fixture: PayrollFixture) {
    const periodId = await calculatedPeriod(fixture);
    await as(fixture, () => get(PayrollPeriodService).approve(periodId, key("approve"), randomUUID()));
    return periodId;
  }

  async function linesOf(periodId: string) {
    return (
      await sql<{ id: string; employeeId: string; net: string; gross: string; paid: string; outstanding: string; status: string }>`
        select id, employee_id as "employeeId", net_salary::text as net, gross_earnings::text as gross,
               amount_paid::text as paid, outstanding_amount::text as outstanding, status
          from payroll_entries where payroll_period_id = ${periodId}::uuid order by employee_number_snapshot`.execute(db)
    ).rows;
  }

  async function pay(fixture: PayrollFixture, periodId: string, onlyFirst = false) {
    const lines = await linesOf(periodId);
    const chosen = onlyFirst ? lines.slice(0, 1) : lines;
    const result = (await as(fixture, () =>
      get(PayrollPaymentService).confirm(
        {
          accountId: fixture.cashAccountId,
          acknowledgementType: "checkbox",
          allocations: chosen.map((line) => ({ amount: Number(line.outstanding), employeeId: line.employeeId, lineId: line.id })),
          cashVoucherReference: `V-${randomUUID().slice(0, 6)}`,
          paymentDate: today,
          periodId,
        } as never,
        key("pay"),
        randomUUID(),
      ),
    )) as { paymentId: string };
    return result.paymentId;
  }

  async function periodRow(periodId: string) {
    return (
      await sql<{ status: string; net: string; paid: string; outstanding: string }>`select status, total_net_salary::text as net,
          total_paid::text as paid, total_outstanding::text as outstanding from payroll_periods where id = ${periodId}::uuid`.execute(db)
    ).rows[0]!;
  }

  function preview(fixture: { companyId: string }, periodId: string) {
    return payrollRepairs().preview(fixture.companyId, periodId);
  }

  async function payrollRequest(fixture: { companyId: string }, periodId: string, code: string, overrides: Partial<RepairExecutionRequest> = {}) {
    const view = await preview(fixture, periodId);
    const finding = view.findings.find((item) => item.reasonCode === code);
    expect(finding, `${code} in ${JSON.stringify(view.findings.map((f) => f.reasonCode))}`).toBeDefined();
    return {
      capabilityCode: finding!.repairCapability ?? "RECONCILE_PAYROLL_PAYMENT_STATE",
      findingId: finding!.findingId,
      idempotencyKey: `rc-pay-${randomUUID()}`,
      previewVersion: view.previewVersion,
      reason: "Payroll repair from the Repair Center",
      ...overrides,
    } as RepairExecutionRequest;
  }

  function runPayroll(fixture: { companyId: string }, periodId: string, request: RepairExecutionRequest) {
    return asPlatform(fixture.companyId, () => payrollRepairs().execute(fixture.companyId, periodId, request, actor()));
  }

  async function refusedPayroll(fixture: { companyId: string }, periodId: string, request: RepairExecutionRequest, errorCode: string) {
    const before = await footprint(fixture.companyId);
    await expect(runPayroll(fixture, periodId, request)).rejects.toMatchObject({ errorCode });
    expect(await footprint(fixture.companyId), "a refused Payroll repair must not mutate anything").toBe(before);
  }

  async function payrollAttempts(companyId: string, periodId: string) {
    return (
      await sql<{ result: string; code: string | null }>`select result, error_code as code from platform_repair_attempts
        where company_id = ${companyId}::uuid and entity_id = ${periodId}::uuid order by created_at, id`.execute(db)
    ).rows.map((row) => [row.result, row.code]);
  }

  async function payrollAudits(companyId: string, periodId: string) {
    return (
      await sql<Record<string, unknown>>`select capability_code as capability, actor_account_id::text as actor, entity_type as "entityType",
          reason_code as "reasonCode", reason, result from platform_repair_executions
        where company_id = ${companyId}::uuid and entity_id = ${periodId}::uuid order by created_at`.execute(db)
    ).rows;
  }

  async function codesOf(fixture: { companyId: string }, periodId: string) {
    return (await preview(fixture, periodId)).findings.map((finding) => [finding.reasonCode, finding.repairability]);
  }

  // ===========================================================================
  // Phase 6 helpers
  // ===========================================================================

  const overviews = () => get(RepairCenterOverviewService);
  const histories = () => get(RepairHistoryService);

  async function orderRequest(fixture: { companyId: string }, orderId: string, reason = "Phase 6 certification repair") {
    const view = await asPlatform(fixture.companyId, () => previews.preview(fixture.companyId, orderId));
    expect(view.proposedRepair, JSON.stringify(view.blockers)).not.toBeNull();
    return {
      capabilityCode: view.proposedRepair!.capabilityCode,
      findingId: view.finding.findingId,
      idempotencyKey: `rc6-order-${randomUUID()}`,
      previewVersion: view.previewVersion,
      reason,
    } as RepairExecutionRequest;
  }

  function runOrder(fixture: { companyId: string }, orderId: string, request: RepairExecutionRequest) {
    return asPlatform(fixture.companyId, () => executions.execute(fixture.companyId, orderId, request, actor()));
  }

  async function orderVerdict(fixture: Fixture, orderId: string) {
    const analysis = await asPlatform(fixture.companyId, () => previews.analyze(fixture.companyId, orderId));
    const verify = await as(fixture, () => get(OrderMaintenanceService).financialVerification(orderId));
    return { analysis, primary: analysis.findings[0]!, verify };
  }

  async function lineOf(periodId: string, employeeId: string) {
    return (await linesOf(periodId)).find((line) => line.employeeId === employeeId)!;
  }

  async function forgetPayments(periodId: string) {
    await crafted(sql`update payroll_entries set amount_paid = 0, outstanding_amount = net_salary, status = 'approved'
       where payroll_period_id = ${periodId}::uuid and status not in ('held', 'reversed')`);
    await crafted(sql`update payroll_periods set total_paid = 0, total_outstanding = total_net_salary, status = 'approved'
       where id = ${periodId}::uuid`);
  }

  // ===========================================================================
  // 9, 10, 26, 28: Order -> Trader receivable -> Settlement -> Accounting.
  // ===========================================================================
  it("26 + 10 + 28: one transaction across Order, receivable, Settlement and Accounting -- the operational repair comes first, then the accounting recovery; every view agrees at every step", async () => {
    const fixture = await postingFixture();
    const { orderId, receivableId } = await feeOrder(fixture);
    const recognition = await eventOf(fixture, "trader_receivable", receivableId, "trader_receivable_recognized");
    await craftFailed(recognition);
    await settle(fixture, receivableId);
    // The receivable was settled by the offset, but its state was left open (derived cache drift).
    await crafted(sql`update trader_receivables set status = 'outstanding' where id = ${receivableId}::uuid`);

    // VERIFY: Order Health (primary = the operational finding) == Verify First.
    const first = await orderVerdict(fixture, orderId);
    expect({ code: first.primary.reasonCode, health: first.analysis.health, repairability: first.primary.repairability }).toEqual({
      code: "FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN",
      health: "ISSUE",
      repairability: "READY",
    });
    expect(first.verify.health).toBe("ISSUE");

    // ORDERING: the accounting recovery of the SAME receivable waits for the operational repair.
    const blocked = await recovery.preview(fixture.companyId, recognition);
    expect(blocked.repairability).toBe("BLOCKED");
    expect(blocked.blockers.map((b) => b.code)).toContain("operational_finance_repair_first");
    expect(blocked.execution.available).toBe(false);
    const details = await recovery.details(fixture.companyId, recognition);
    expect(details.finding).toMatchObject({ current: true, health: "ISSUE", repairability: "BLOCKED" });
    const early = { capabilityCode: "REPROCESS_ACCOUNTING_EVENT", findingId: blocked.finding.findingId, idempotencyKey: `rc6-acc-${randomUUID()}`, previewVersion: blocked.previewVersion, reason: "Too early" } as RepairExecutionRequest;
    await refused(fixture, recognition, early, "repair_not_ready");
    expect(await journalsFor(recognition)).toEqual([]);

    // The landing: ONE overall verdict; nothing pretends to be HEALTHY.
    const landing = await overviews().overview(fixture.companyId);
    expect(landing.companyHealth).toBe("ISSUE");
    expect(landing.accountingHealth.failed).toBeGreaterThanOrEqual(1);

    // REPAIR 1 (operational): reconcile the receivable status from its effective settlement.
    const order = await runOrder(fixture, orderId, await orderRequest(fixture, orderId));
    expect(order).toMatchObject({ afterHealth: "HEALTHY", capabilityCode: "RECONCILE_TRADER_RECEIVABLE", status: "succeeded" });
    const second = await orderVerdict(fixture, orderId);
    expect(second.analysis.health).toBe("HEALTHY");
    expect(second.verify.health).toBe("HEALTHY");

    // REPAIR 2 (accounting): now READY, posts one balanced journal of the CORRECT receivable.
    const ready = await recovery.preview(fixture.companyId, recognition);
    expect(ready.repairability, JSON.stringify(ready.blockers)).toBe("READY");
    expect(ready.blockers.map((b) => b.code)).not.toContain("operational_finance_repair_first");
    await recoverAndProve(fixture, recognition);

    // VERIFY AGAIN, every view.
    expect((await orderVerdict(fixture, orderId)).analysis.health).toBe("HEALTHY");
    const accounting = await health.summary(fixture.companyId);
    expect(accounting.failed).toBe(0);
    expect((await health.list(fixture.companyId, { status: "all", pageSize: 100 })).items.find((row) => row.eventId === recognition)).toMatchObject({
      status: "posted",
      triage: "NOT_REQUIRED",
    });
    const after = await overviews().overview(fixture.companyId);
    expect(after.accountingHealth.failed).toBe(0);
    expect(after.orderHealth.issue).toBe(0);
    expect(after.repairHistory.succeeded).toBe(2);
    expect(after.companyHealth).not.toBe("ISSUE");
  });

  // ===========================================================================
  // 27 + 10: Payroll -> payment -> Accounting.
  // ===========================================================================
  it("27 + 10: Payroll payment state and its failed accounting event -- Payroll repair first, then the accounting recovery; Payroll, Accounting and the landing resolve", async () => {
    const fixture = await payrollFixture();
    const periodId = await approvedPeriod(fixture);
    const paymentId = await pay(fixture, periodId);
    const paid = await eventOf(fixture, "payroll_payment", paymentId, "employee_payroll_paid");
    await craftFailed(paid);
    await forgetPayments(periodId);

    const view = await preview(fixture, periodId);
    expect(view.findings.map((f) => [f.reasonCode, f.repairability])).toEqual([
      ["PAYROLL_PAYMENT_STATE_INCONSISTENT", "READY"],
      ["PAYROLL_ACCOUNTING_EVENT_FAILED", "BLOCKED"],
    ]);
    expect(view.findings[1]!.blockers.map((b) => b.code)).toContain("payroll_repair_first");
    const accountingView = await recovery.preview(fixture.companyId, paid);
    expect(accountingView.repairability).toBe("BLOCKED");
    expect(accountingView.blockers.map((b) => b.code)).toContain("payroll_repair_first");
    await refused(fixture, paid, { capabilityCode: "REPROCESS_ACCOUNTING_EVENT", findingId: accountingView.finding.findingId, idempotencyKey: `rc6-acc-${randomUUID()}`, previewVersion: accountingView.previewVersion, reason: "Too early" } as RepairExecutionRequest, "repair_not_ready");
    expect((await overviews().overview(fixture.companyId)).companyHealth).toBe("ISSUE");

    await runPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT"));
    expect(await codesOf(fixture, periodId)).toEqual([["PAYROLL_ACCOUNTING_EVENT_FAILED", "READY"]]);
    await recoverAndProve(fixture, paid);
    expect((await preview(fixture, periodId)).findings).toEqual([]);
    expect(await payrollHealth().summary(fixture.companyId)).toMatchObject({ payrollHealth: "HEALTHY" });
    const landing = await overviews().overview(fixture.companyId);
    expect(landing.payrollHealth).toMatchObject({ payrollHealth: "HEALTHY", periodsWithFindings: 0 });
    expect(landing.accountingHealth.failed).toBe(0);
  });

  // ===========================================================================
  // 3, 4, 11: the landing -- one health contract, every domain, de-duplication.
  // ===========================================================================
  describe("the landing: one health contract (3, 4, 11)", () => {
    it("Accounting OFF, nothing wrong: HEALTHY overall; Accounting NOT_APPLICABLE never raises it; every domain present", async () => {
      const fixture = await payrollFixture("off");
      await approvedPeriod(fixture);
      await feeOrder(fixture);
      const landing = await overviews().overview(fixture.companyId);
      expect(landing).toMatchObject({
        accountingHealth: { accountingHealth: "NOT_APPLICABLE" },
        accountingMode: { enabled: false },
        companyHealth: "HEALTHY",
        companyId: fixture.companyId,
        orderHealth: { accountingRelatedIssues: 0, companyHealth: "HEALTHY" },
        payrollHealth: { payrollHealth: "HEALTHY", totalPeriods: 1 },
      });
      expect(landing.company.code).toMatch(/^RC6-/u);
      expect(landing.repairHistory).toMatchObject({ failed: 0, refused: 0, replayed: 0, succeeded: 0 });
    });

    it("an Order whose only issue is its failed accounting event is ONE root cause: Order issue labelled accounting-related, Accounting failed, overall ISSUE", async () => {
      const fixture = await postingFixture();
      const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      await craftFailed(await eventOf(fixture, "order", orderId, "order_delivered"));
      const landing = await overviews().overview(fixture.companyId);
      expect(landing.companyHealth).toBe("ISSUE");
      expect(landing.orderHealth.issue).toBeGreaterThanOrEqual(1);
      expect(landing.orderHealth.accountingRelatedIssues).toBe(landing.orderHealth.issue);
      expect(landing.accountingHealth.failed).toBeGreaterThanOrEqual(1);
      // The Order view leads with the accounting finding as its primary (and only) finding -- not a second independent problem.
      const { primary, analysis } = await orderVerdict(fixture, orderId);
      expect(primary.reasonCode).toBe("ACCOUNTING_EVENT_FAILED");
      expect(analysis.findings.filter((f) => f.repairability === "READY" || f.repairability === "BLOCKED").length).toBeLessThanOrEqual(1);
    });

    it("an operational receivable problem AND an accounting failure on one Order: the receivable is primary (repaired first); both stay visible", async () => {
      const fixture = await postingFixture();
      const { orderId, receivableId } = await feeOrder(fixture);
      // A zero-COD fee Order captures no order_delivered event; craft the processor's own FAILED record of one.
      const eventId = randomUUID();
      await crafted(sql`insert into accounting_events (id, company_id, event_type, event_version, source_entity_type,
          source_entity_id, source_reference, effective_accounting_date, currency, correlation_id, idempotency_key,
          event_hash, actor_id, actor_type, description, processing_status, operational_area, source_operation_id,
          failed_at, attempt_count, error_code, safe_error_summary, failure_category)
        values (${eventId}::uuid, ${fixture.companyId}::uuid, 'order_delivered', 1, 'order', ${orderId}::uuid,
          ${await orderNumber(orderId)}, current_date, 'AED', 'rc6', ${`order_delivered:${orderId}:v1`}, md5(${eventId}),
          ${fixture.actorId}::uuid, 'company_user', 'order_delivered', 'failed', 'orders', 'rc6', now(), 1,
          'accounting_event_mapping_missing', 'Crafted', 'configuration')`);
      await settle(fixture, receivableId);
      await crafted(sql`update trader_receivables set status = 'outstanding' where id = ${receivableId}::uuid`);
      const { analysis, primary } = await orderVerdict(fixture, orderId);
      expect(primary.reasonCode).toBe("FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN");
      expect(analysis.findings.map((f) => f.reasonCode)).toContain("ACCOUNTING_EVENT_FAILED");
      const landing = await overviews().overview(fixture.companyId);
      // The receivable problem is the primary finding, so this Order is NOT counted as accounting-only.
      expect(landing.orderHealth.accountingRelatedIssues).toBe(0);
      expect(landing.orderHealth.issue).toBe(1);
    });

    it("a Payroll REVIEW alone makes the Company REVIEW (worst-of), never ISSUE", async () => {
      const fixture = await payrollFixture("off");
      const periodId = await approvedPeriod(fixture);
      const line = await lineOf(periodId, fixture.employees[0]!);
      await crafted(sql`update payroll_entries set source_marker = 'legacy', earning_adjustments_total = 7,
          basic_salary_snapshot = basic_salary_snapshot - 7 where id = ${line.id}::uuid`);
      await crafted(sql`update payroll_periods set total_basic_salary = total_basic_salary - 7,
          total_earning_adjustments = total_earning_adjustments + 7 where id = ${periodId}::uuid`);
      const landing = await overviews().overview(fixture.companyId);
      expect(landing).toMatchObject({ companyHealth: "REVIEW", payrollHealth: { payrollHealth: "REVIEW" } });
    });
  });

  // ===========================================================================
  // 19, 47-51: ONE Repair History across every execution domain; immutable.
  // ===========================================================================
  it("19 + 47-51: one Repair History -- Order, Accounting and Payroll; SUCCEEDED / FAILED / REFUSED / REPLAYED; Platform actor; filters; details; immutable", async () => {
    const fixture = await payrollFixture();
    // Order: SUCCEEDED + REPLAYED.
    const { orderId, receivableId } = await feeOrder(fixture);
    await settle(fixture, receivableId);
    await crafted(sql`update trader_receivables set status = 'outstanding' where id = ${receivableId}::uuid`);
    const orderReq = await orderRequest(fixture, orderId);
    const orderResult = await runOrder(fixture, orderId, orderReq);
    await runOrder(fixture, orderId, orderReq);
    // Accounting: SUCCEEDED.
    const periodId = await approvedPeriod(fixture);
    const approval = await eventOf(fixture, "payroll_period", periodId, "employee_payroll_approved");
    await craftFailed(approval);
    const accountingResult = await recoverAndProve(fixture, approval);
    // Payroll: REFUSED (stale) + FAILED (injected) + SUCCEEDED.
    await pay(fixture, periodId);
    await forgetPayments(periodId);
    const payReq = await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT");
    await expect(runPayroll(fixture, periodId, { ...payReq, idempotencyKey: `rc6-p-${randomUUID()}`, previewVersion: `prv1:${"0".repeat(64)}` })).rejects.toMatchObject({ errorCode: "repair_preview_stale" });
    vi.spyOn(get(PayrollOperationalRepository), "reconcilePaymentState").mockRejectedValueOnce(new Error("injected"));
    await expect(runPayroll(fixture, periodId, { ...payReq, idempotencyKey: `rc6-p-${randomUUID()}` })).rejects.toThrow(/injected/u);
    const payrollResult = await runPayroll(fixture, periodId, payReq);

    const page = await histories().list(fixture.companyId, { pageSize: 100 });
    const summary = page.items.map((row) => `${row.entityType}:${row.result}`).sort();
    // A receivable repair executed from the Order route records its execution on the repaired entity
    // (trader_receivable) and the route's attempts on the Order; the REPLAYED attempt links the execution.
    expect(summary).toEqual([
      "accounting_event:SUCCEEDED",
      "order:REPLAYED",
      "payroll_period:FAILED",
      "payroll_period:REFUSED",
      "payroll_period:SUCCEEDED",
      "trader_receivable:SUCCEEDED",
    ]);
    expect(page.items.find((row) => row.result === "REPLAYED")).toMatchObject({ entityId: orderId, repairExecutionId: orderResult.repairExecutionId });
    for (const row of page.items) {
      expect(row.actor, row.id).toBe(`rc.exec.${adminId}`);
      expect(row.occurredAt).toBeTruthy();
      expect(row.repairApplied).toBe(row.result === "SUCCEEDED");
    }
    // Ordered newest first; filters by domain and by result.
    const times = page.items.map((row) => row.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect((await histories().list(fixture.companyId, { entityType: "payroll_period" })).total).toBe(3);
    expect((await histories().list(fixture.companyId, { result: "SUCCEEDED" })).total).toBe(3);
    // Details identify actor authority, capability, finding, reason, preview version.
    for (const id of [orderResult.repairExecutionId, accountingResult.repairExecutionId, payrollResult.repairExecutionId]) {
      const record = await histories().detail(fixture.companyId, "execution", id);
      expect(record).toMatchObject({ actorAuthority: "platform.companies.repair_center.execute", repairApplied: true, result: "SUCCEEDED" });
      expect(record.capabilityCode).toBeTruthy();
      expect(record.findingId).toBeTruthy();
      expect(record.reason).toBeTruthy();
      expect(record.previewVersion).toBeTruthy();
    }
    expect(await overviews().overview(fixture.companyId)).toMatchObject({ repairHistory: { failed: 1, refused: 1, replayed: 1, succeeded: 3 } });
    // 51: immutable -- UPDATE and DELETE are refused on both audit tables.
    for (const table of ["platform_repair_executions", "platform_repair_attempts"]) {
      await expect(sql`update ${sql.table(table)} set reason = 'tampered' where company_id = ${fixture.companyId}::uuid`.execute(db)).rejects.toThrow();
      await expect(sql`delete from ${sql.table(table)} where company_id = ${fixture.companyId}::uuid`.execute(db)).rejects.toThrow();
    }
    expect((await histories().list(fixture.companyId, { pageSize: 100 })).total).toBe(6);
  });

  // ===========================================================================
  // 17, 41-43: tenant isolation across every domain and the history.
  // ===========================================================================
  it("17 + 41-43: Company A's Repair Center never reads, discloses or mutates Company B's Order, accounting event, Payroll period or history record", async () => {
    const a = await payrollFixture();
    const b = await payrollFixture();
    const { orderId, receivableId } = await feeOrder(b);
    await settle(b, receivableId);
    await crafted(sql`update trader_receivables set status = 'outstanding' where id = ${receivableId}::uuid`);
    const periodId = await approvedPeriod(b);
    const eventId = await eventOf(b, "payroll_period", periodId, "employee_payroll_approved");
    await craftFailed(eventId);
    const bOrderReq = await orderRequest(b, orderId);
    const done = await runOrder(b, orderId, bOrderReq);
    const beforeA = await footprint(a.companyId);
    const beforeB = await footprint(b.companyId);
    const notFound = async (work: () => Promise<unknown>) => {
      const error = await work().then(() => undefined, (failure: unknown) => failure as ApplicationException);
      expect(error, "must be refused").toBeDefined();
      expect(error!.getStatus?.() ?? 404).toBe(404);
    };
    // Orders
    await notFound(() => asPlatform(a.companyId, () => previews.preview(a.companyId, orderId)));
    await notFound(() => runOrder(a, orderId, bOrderReq));
    // Accounting events
    await notFound(() => recovery.details(a.companyId, eventId));
    await notFound(() => recovery.preview(a.companyId, eventId));
    await notFound(() => run(a, eventId, { capabilityCode: "REPROCESS_ACCOUNTING_EVENT", findingId: "fnd_x", idempotencyKey: `rc6-${randomUUID()}`, previewVersion: `rcv1:${"0".repeat(64)}`, reason: "Cross" } as RepairExecutionRequest));
    // Payroll
    await notFound(() => preview(a, periodId));
    await notFound(() => runPayroll(a, periodId, { capabilityCode: "RECONCILE_PAYROLL_PAYMENT_STATE", findingId: "fnd_x", idempotencyKey: `rc6-${randomUUID()}`, previewVersion: `prv1:${"0".repeat(64)}`, reason: "Cross" } as RepairExecutionRequest));
    // History
    await notFound(() => histories().detail(a.companyId, "execution", done.repairExecutionId));
    // Anti-amplification (Phase 2 Prompt 5): an identified refusal is recorded against the REQUESTING Company,
    // with only the identifier it submitted -- never Company B's business reference or data.
    const aHistory = (await histories().list(a.companyId, { pageSize: 100 })).items;
    for (const row of aHistory.filter((item) => [orderId, eventId, periodId].includes(item.entityId))) {
      expect(row).toMatchObject({ entityNumber: null, repairApplied: false, result: "REFUSED" });
    }
    expect(aHistory.some((row) => row.result === "SUCCEEDED")).toBe(false);
    // B's own history never contains A's refusals.
    expect((await histories().list(b.companyId, { pageSize: 100 })).items.every((row) => row.result !== "REFUSED")).toBe(true);
    // Health views never disclose B.
    expect((await health.list(a.companyId, { status: "all", pageSize: 100 })).items.some((row) => row.eventId === eventId)).toBe(false);
    expect((await payrollHealth().list(a.companyId, { status: "all" })).items.some((row) => row.entityId === periodId)).toBe(false);
    expect(await footprint(a.companyId)).toBe(beforeA);
    expect(await footprint(b.companyId)).toBe(beforeB);
  });

  // ===========================================================================
  // 26 (execution performance): statement count and duration per capability.
  // ===========================================================================
  it("65: every executable capability -- statement count and duration (one business transaction each)", async () => {
    const measured: Record<string, { ms: number; statements: number }> = {};
    async function measure<T>(name: string, work: () => Promise<T>) {
      statements = 0;
      const started = performance.now();
      const value = await work();
      measured[name] = { ms: Math.round(performance.now() - started), statements };
      return value;
    }
    // Trader receivable repair (missing receivable; Accounting OFF -- ON is BLOCKED by design).
    const off = await payrollFixture("off");
    const missing = await feeOrder(off);
    await crafted(sql`delete from trader_receivables where id = ${missing.receivableId}::uuid`);
    const missingReq = await orderRequest(off, missing.orderId);
    expect(missingReq.capabilityCode).toBe("REPAIR_TRADER_RECEIVABLE");
    await measure("REPAIR_TRADER_RECEIVABLE", () => runOrder(off, missing.orderId, missingReq));
    // Status reconciliation.
    const fixture = await payrollFixture();
    const settled = await feeOrder(fixture);
    await settle(fixture, settled.receivableId);
    await crafted(sql`update trader_receivables set status = 'outstanding' where id = ${settled.receivableId}::uuid`);
    const reconcileReq = await orderRequest(fixture, settled.orderId);
    await measure("RECONCILE_TRADER_RECEIVABLE", () => runOrder(fixture, settled.orderId, reconcileReq));
    // Accounting recovery.
    const recognition = await eventOf(fixture, "trader_receivable", settled.receivableId, "trader_receivable_recognized");
    await craftFailed(recognition);
    const accountingReq = await requestFor(fixture, recognition);
    await measure("REPROCESS_ACCOUNTING_EVENT", () => run(fixture, recognition, accountingReq));
    expect(await journalsFor(recognition)).toHaveLength(1);
    // Payroll line repair + totals rebuild (calculated period), payment reconciliation (paid period).
    const draft = await calculatedPeriod(fixture);
    const line = await lineOf(draft, fixture.employees[0]!);
    await sql`update payroll_entries set earning_adjustments_total = earning_adjustments_total + 50, gross_earnings = gross_earnings + 50,
        net_salary = net_salary + 50, outstanding_amount = outstanding_amount + 50 where id = ${line.id}::uuid`.execute(db);
    const lineReq = await payrollRequest(fixture, draft, "PAYROLL_LINE_AMOUNTS_INCONSISTENT");
    await measure("REPAIR_PAYROLL_LINE_AMOUNTS", () => runPayroll(fixture, draft, lineReq));
    await sql`update payroll_periods set total_net_salary = 1, total_outstanding = 1 where id = ${draft}::uuid`.execute(db);
    const totalsReq = await payrollRequest(fixture, draft, "PAYROLL_PERIOD_TOTALS_MISMATCH");
    await measure("REBUILD_PAYROLL_PERIOD_TOTALS", () => runPayroll(fixture, draft, totalsReq));
    await as(fixture, () => get(PayrollPeriodService).approve(draft, key("approve"), randomUUID()));
    await pay(fixture, draft);
    await forgetPayments(draft);
    const reconcilePayReq = await payrollRequest(fixture, draft, "PAYROLL_PAYMENT_STATE_INCONSISTENT");
    await measure("RECONCILE_PAYROLL_PAYMENT_STATE", () => runPayroll(fixture, draft, reconcilePayReq));
    for (const [name, value] of Object.entries(measured)) {
      expect(value.statements, name).toBeLessThan(80);
    }
    process.stdout.write(`PHASE6_EXECUTION ${JSON.stringify(measured)}\n`);
  });

  // ===========================================================================
  // 20, 52-54: Data Reset compatibility (classification; Reset is not run or changed).
  // ===========================================================================
  it("20 + 52-54: repair audit, reference counters and Accounting mode history are PRESERVE; every repairable domain is reset data", () => {
    for (const table of ["platform_repair_executions", "platform_repair_attempts", "company_reference_counters", "accounting_configuration_history", "companies", "accounts"]) {
      expect(PRESERVE_TABLES.has(table), table).toBe(true);
    }
    for (const table of ["orders", "trader_receivables", "trader_collections", "trader_settlements", "accounting_events", "journal_entries", "payroll_periods", "payroll_entries", "payroll_payments"]) {
      expect(PURGE_TABLES.has(table) || PRESERVE_TABLES.has(table), `${table} is classified`).toBe(true);
    }
    for (const table of ["platform_repair_executions", "platform_repair_attempts"]) expect(PURGE_TABLES.has(table)).toBe(false);
  });
});
