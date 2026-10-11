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

/**
 * REPAIR CENTER PHASE 5 PROMPT 1 -- PAYROLL HEALTH + SAFE PAYROLL RECOVERY
 * (matrix 1-60).
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

describe.skipIf(!runDatabaseTests)("Repair Center Phase 5 Prompt 1 -- Payroll health and safe Payroll recovery", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let store: RequestSecurityContextStore;
  let get: <T>(type: new (...args: never[]) => T) => T;
  let previews: RepairPreviewService;
  let executions: RepairExecutionService;
  let recovery: RepairAccountingRecoveryService;
  let health: PlatformAccountingHealthService;
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

  const key = (label: string) => `rc5p1.${label}.${randomUUID()}`;

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`RC5P1-${tag}`},${`rc5p1-${tag}`},${`RC5P1 ${mode} ${tag}`},
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
  // 1-2, 5, 18, 24-25, 27, 31, 55: healthy Payroll stays HEALTHY.
  // ===========================================================================
  describe("healthy Payroll", () => {
    it("1 + 2 + 18 + 31: approved and paid Payroll (Accounting ON, events captured) is HEALTHY, nothing to repair", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await pay(fixture, periodId);
      const view = await preview(fixture, periodId);
      expect(view).toMatchObject({ findings: [], health: "HEALTHY", period: { status: "paid" } });
      expect(view.lines.map((line) => line.current)).toEqual(view.lines.map((line) => ({ gross: line.expected.gross, net: line.expected.net, outstanding: line.expected.outstanding, paid: line.expected.paid })));
      expect(view.accounting.events.map((event) => event.eventType).sort()).toEqual(["employee_payroll_approved", "employee_payroll_paid"]);
      expect(await payrollHealth().summary(fixture.companyId)).toMatchObject({ headlines: [], payrollHealth: "HEALTHY", totalPeriods: 1 });
      expect((await payrollHealth().list(fixture.companyId, {})).total).toBe(0);
    });

    it("5 + 24 + 25 + 55: later salary change, employee / driver deactivation and detachment never break historical Payroll", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await pay(fixture, periodId, true);
      const before = (await preview(fixture, periodId)).lines.map((line) => line.current);
      // A new salary version, the employee deactivated, the delivery driver detached.
      // Crafted: today's salary rate differs from the rate the period snapshotted.
      await crafted(sql`update employee_salary_versions set basic_salary = 9999 where employee_id = ${fixture.employees[0]!}::uuid`);
      await crafted(sql`update employees set is_active = false, deactivated_at = now() where id = ${fixture.employees[0]!}::uuid`);
      await crafted(sql`update drivers set deactivated_at = now() where company_id = ${fixture.companyId}::uuid`);
      const after = await preview(fixture, periodId);
      expect(after.findings).toEqual([]);
      expect(after.lines.map((line) => line.current)).toEqual(before);
      expect(after.lines.some((line) => line.employeeActive === false)).toBe(true);
    });

    it("27 + 30: a draft period under Accounting OFF is HEALTHY; Payroll Health never requires accounting while OFF", async () => {
      const fixture = await payrollFixture("off");
      const periodId = await calculatedPeriod(fixture);
      expect(await codesOf(fixture, periodId)).toEqual([]);
      await as(fixture, () => get(PayrollPeriodService).approve(periodId, key("approve"), randomUUID()));
      await pay(fixture, periodId);
      const view = await preview(fixture, periodId);
      expect(view).toMatchObject({ accounting: { enabled: false, events: [] }, findings: [] });
    });

    it("8 + 9 + 22: duplicate Payroll lines and duplicate payments are impossible (database + idempotency)", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await expect(
        crafted(sql`insert into payroll_entries
            select (jsonb_populate_record(null::payroll_entries,
                      to_jsonb(x) || jsonb_build_object('id', gen_random_uuid(), 'payroll_number', x.payroll_number || '-DUP'))).*
              from payroll_entries x where x.payroll_period_id = ${periodId}::uuid limit 1`),
      ).rejects.toThrow(/duplicate key/u);
      const lines = await linesOf(periodId);
      const input = {
        accountId: fixture.cashAccountId,
        acknowledgementType: "checkbox",
        allocations: lines.map((line) => ({ amount: Number(line.outstanding), employeeId: line.employeeId, lineId: line.id })),
        cashVoucherReference: "V-DUP",
        paymentDate: today,
        periodId,
      } as never;
      const idempotency = key("pay-dup");
      const first = (await as(fixture, () => get(PayrollPaymentService).confirm(input, idempotency, randomUUID()))) as { paymentId: string };
      const second = (await as(fixture, () => get(PayrollPaymentService).confirm(input, idempotency, randomUUID()))) as { paymentId: string };
      expect(second.paymentId).toBe(first.paymentId);
      expect((await sql<{ n: number }>`select count(*)::int as n from payroll_payments where payroll_period_id = ${periodId}::uuid`.execute(db)).rows[0]!.n).toBe(1);
      expect((await preview(fixture, periodId)).findings).toEqual([]);
    });
  });

  // ===========================================================================
  // 3, 10, 12, 16, 17: DRAFT Payroll -- deterministic, actor-free repairs.
  // ===========================================================================
  describe("draft / calculated Payroll", () => {
    it("3 + 16 + 58: a draft line's wrong net -> READY REPAIR_PAYROLL_LINE_AMOUNTS -> line and totals rebuilt, HEALTHY, audited", async () => {
      const fixture = await payrollFixture();
      const periodId = await calculatedPeriod(fixture);
      const [line] = await linesOf(periodId);
      // The line's arithmetic is a database CHECK; what can drift is a total
      // that no longer matches its source rows (here: an earning adjustment
      // total with no active adjustment behind it).
      await sql`update payroll_entries set earning_adjustments_total = 500, gross_earnings = gross_earnings + 500,
          net_salary = net_salary + 500, outstanding_amount = outstanding_amount + 500
        where id = ${line!.id}::uuid`.execute(db);
      expect(await codesOf(fixture, periodId)).toEqual([
        ["PAYROLL_LINE_AMOUNTS_INCONSISTENT", "READY"],
        ["PAYROLL_PERIOD_TOTALS_MISMATCH", "BLOCKED"],
      ]);
      const view = await preview(fixture, periodId);
      const affected = view.lines.find((item) => item.lineId === line!.id)!;
      expect(affected).toMatchObject({ current: { net: (Number(line!.net) + 500).toFixed(2) }, expected: { net: line!.net }, flags: { amounts: true } });
      expect(view.findings[0]).toMatchObject({ execution: { available: true }, plannedOperation: expect.stringMatching(/recalculateLine/u) });
      expect(view.findings[1]!.blockers.map((b) => b.code)).toEqual(["payroll_line_amounts_first"]);
      const request = await payrollRequest(fixture, periodId, "PAYROLL_LINE_AMOUNTS_INCONSISTENT");
      const result = await runPayroll(fixture, periodId, request);
      expect(result).toMatchObject({ afterHealth: "HEALTHY", beforeHealth: "ISSUE", capabilityCode: "REPAIR_PAYROLL_LINE_AMOUNTS", replayed: false, status: "succeeded" });
      expect((await linesOf(periodId)).find((item) => item.id === line!.id)!.net).toBe(line!.net);
      expect((await periodRow(periodId)).net).toBe("3000.00");
      expect((await preview(fixture, periodId)).findings).toEqual([]);
      expect(await payrollAudits(fixture.companyId, periodId)).toEqual([
        { actor: adminId, capability: "REPAIR_PAYROLL_LINE_AMOUNTS", entityType: "payroll_period", reason: request.reason, reasonCode: "PAYROLL_LINE_AMOUNTS_INCONSISTENT", result: "succeeded" },
      ]);
      // The repaired draft still approves through the Company's own operation.
      await as(fixture, () => get(PayrollPeriodService).approve(periodId, key("approve"), randomUUID()));
      expect((await preview(fixture, periodId)).findings).toEqual([]);
    });

    it("10 + 12: wrong incentive (bonus) / deduction totals on a draft line -> READY from the active adjustments", async () => {
      const fixture = await payrollFixture();
      const periodId = await calculatedPeriod(fixture);
      const [line] = await linesOf(periodId);
      const adjustments = get(PayrollAdjustmentService);
      await as(fixture, () => adjustments.create(line!.id, { adjustmentType: "bonus", amount: 100, direction: "earning", reason: "Bonus" } as never, key("bonus"), randomUUID()));
      await as(fixture, () => adjustments.create(line!.id, { adjustmentType: "penalty", amount: 40, direction: "deduction", reason: "Late" } as never, key("ded"), randomUUID()));
      const expected = (await linesOf(periodId)).find((item) => item.id === line!.id)!;
      await sql`update payroll_entries set earning_adjustments_total = 0, deduction_adjustments_total = 99,
          gross_earnings = gross_earnings - 100, net_salary = net_salary - 100 - 59, outstanding_amount = outstanding_amount - 159
        where id = ${line!.id}::uuid`.execute(db);
      expect((await codesOf(fixture, periodId))[0]).toEqual(["PAYROLL_LINE_AMOUNTS_INCONSISTENT", "READY"]);
      await runPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_LINE_AMOUNTS_INCONSISTENT"));
      expect((await linesOf(periodId)).find((item) => item.id === line!.id)).toMatchObject({ gross: expected.gross, net: expected.net });
      expect((await preview(fixture, periodId)).findings).toEqual([]);
    });

    it("17: draft period totals that differ from its lines -> READY REBUILD_PAYROLL_PERIOD_TOTALS", async () => {
      const fixture = await payrollFixture();
      const periodId = await calculatedPeriod(fixture);
      await sql`update payroll_periods set total_net_salary = 1, total_outstanding = 1, total_paid = 0 where id = ${periodId}::uuid`.execute(db);
      expect(await codesOf(fixture, periodId)).toEqual([["PAYROLL_PERIOD_TOTALS_MISMATCH", "READY"]]);
      await runPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_PERIOD_TOTALS_MISMATCH"));
      expect((await periodRow(periodId)).net).toBe("3000.00");
      expect((await preview(fixture, periodId)).findings).toEqual([]);
    });

    it("11 + 13: wrong allowance / commission snapshot on a draft line -> MANUAL_REVIEW (only the Company's Recalculate re-derives it)", async () => {
      const fixture = await payrollFixture();
      const periodId = await calculatedPeriod(fixture);
      const [line] = await linesOf(periodId);
      await sql`update payroll_entries set allowance_total = 250, gross_earnings = gross_earnings + 250,
          net_salary = net_salary + 250, outstanding_amount = outstanding_amount + 250 where id = ${line!.id}::uuid`.execute(db);
      const view = await preview(fixture, periodId);
      const finding = view.findings.find((item) => item.reasonCode === "PAYROLL_LINE_COMPONENTS_INCONSISTENT")!;
      expect(finding).toMatchObject({ execution: { available: false }, repairability: "MANUAL_REVIEW" });
      expect(finding.whyNotAutomatic).toMatch(/Recalculate/u);
      expect(view.findings.find((item) => item.reasonCode === "PAYROLL_LINE_AMOUNTS_INCONSISTENT")).toBeUndefined();
      await refusedPayroll(fixture, periodId, { ...(await payrollRequest(fixture, periodId, "PAYROLL_LINE_COMPONENTS_INCONSISTENT")), capabilityCode: "REPAIR_PAYROLL_LINE_AMOUNTS" }, "repair_capability_not_applicable");
      // The Company's own Recalculate is the certified correction.
      await as(fixture, () => get(PayrollCalculationService).recalculate(periodId, key("recalc"), randomUUID(), true));
      expect((await preview(fixture, periodId)).findings).toEqual([]);
    });
  });

  // ===========================================================================
  // 4, 6, 7, 19-21, 23, 28: approved / paid / closed / reversed Payroll.
  // ===========================================================================
  describe("finalized Payroll", () => {
    it("4 + 16: an approved line's net edited in place -> MANUAL_REVIEW, refused, zero mutation", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      const [line] = await linesOf(periodId);
      await crafted(sql`update payroll_entries set earning_adjustments_total = 1, gross_earnings = gross_earnings + 1,
          net_salary = net_salary + 1, outstanding_amount = outstanding_amount + 1 where id = ${line!.id}::uuid`);
      const view = await preview(fixture, periodId);
      expect(view.findings.find((item) => item.reasonCode === "PAYROLL_LINE_AMOUNTS_INCONSISTENT")).toMatchObject({
        repairCapability: null,
        repairability: "MANUAL_REVIEW",
        whyNotAutomatic: expect.stringMatching(/immutable/u),
      });
      for (const capability of ["REPAIR_PAYROLL_LINE_AMOUNTS", "RECONCILE_PAYROLL_PAYMENT_STATE"]) {
        await refusedPayroll(fixture, periodId, { ...(await payrollRequest(fixture, periodId, "PAYROLL_LINE_AMOUNTS_INCONSISTENT")), capabilityCode: capability }, "repair_capability_not_applicable");
      }
      // The database itself refuses an in-place edit of approved Payroll.
      await expect(sql`update payroll_entries set net_salary = 1 where id = ${line!.id}::uuid`.execute(db)).rejects.toThrow(/immutable/u);
    });

    it("6: a legacy line whose amounts do not follow the calculation -> REVIEW (inputs not provable)", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      const [line] = await linesOf(periodId);
      // A legacy line whose 7.00 "earning adjustment" has no adjustment record
      // (the legacy import folded it out of the basic salary); totals agree.
      await crafted(sql`update payroll_entries set source_marker = 'legacy', earning_adjustments_total = 7,
          basic_salary_snapshot = basic_salary_snapshot - 7 where id = ${line!.id}::uuid`);
      await crafted(sql`update payroll_periods set total_basic_salary = total_basic_salary - 7,
          total_earning_adjustments = total_earning_adjustments + 7 where id = ${periodId}::uuid`);
      const view = await preview(fixture, periodId);
      expect(view.findings.map((item) => [item.reasonCode, item.health, item.repairability])).toEqual([
        ["PAYROLL_LEGACY_HISTORY_REVIEW", "REVIEW", "MANUAL_REVIEW"],
      ]);
      expect(view.health).toBe("REVIEW");
      expect(await payrollHealth().summary(fixture.companyId)).toMatchObject({ headlines: ["REVIEW — Payroll history requires manual review."], payrollHealth: "REVIEW" });
    });

    it("7 + 17: an approved line removed from history -> totals mismatch, MANUAL_REVIEW (approved header is immutable)", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      const [line] = await linesOf(periodId);
      await crafted(sql`delete from payroll_entries where id = ${line!.id}::uuid`);
      expect(await codesOf(fixture, periodId)).toEqual([
        ["PAYROLL_PERIOD_TOTALS_MISMATCH", "MANUAL_REVIEW"],
        ["PAYROLL_PAYMENT_STATE_INCONSISTENT", "MANUAL_REVIEW"],
      ]);
    });

    it("19 + 58: paid amount that disagrees with the allocations -> READY RECONCILE -> restored from allocations", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await pay(fixture, periodId);
      const [line] = await linesOf(periodId);
      await crafted(sql`update payroll_entries set amount_paid = 10, outstanding_amount = net_salary - 10, status = 'partially_paid' where id = ${line!.id}::uuid`);
      await crafted(sql`update payroll_periods set total_paid = total_paid - (${line!.net}::numeric - 10), total_outstanding = total_outstanding + (${line!.net}::numeric - 10), status = 'partially_paid' where id = ${periodId}::uuid`);
      const allocationsBefore = (await sql<{ d: string }>`select md5(string_agg(to_jsonb(a)::text, '|' order by a.id)) as d from payroll_payment_allocations a where a.company_id = ${fixture.companyId}::uuid`.execute(db)).rows[0]!.d;
      expect(await codesOf(fixture, periodId)).toEqual([["PAYROLL_PAYMENT_STATE_INCONSISTENT", "READY"]]);
      const result = await runPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT"));
      expect(result).toMatchObject({ afterHealth: "HEALTHY", capabilityCode: "RECONCILE_PAYROLL_PAYMENT_STATE" });
      expect((await linesOf(periodId)).every((item) => item.paid === item.net && item.status === "paid")).toBe(true);
      expect(await periodRow(periodId)).toMatchObject({ outstanding: "0.00", paid: "3000.00", status: "paid" });
      // 56: payment history untouched.
      expect((await sql<{ d: string }>`select md5(string_agg(to_jsonb(a)::text, '|' order by a.id)) as d from payroll_payment_allocations a where a.company_id = ${fixture.companyId}::uuid`.execute(db)).rows[0]!.d).toBe(allocationsBefore);
    });

    it("20: marked paid without a payment -> READY RECONCILE -> back to approved / outstanding", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await crafted(sql`update payroll_entries set amount_paid = net_salary, outstanding_amount = 0, status = 'paid' where payroll_period_id = ${periodId}::uuid`);
      await crafted(sql`update payroll_periods set total_paid = total_net_salary, total_outstanding = 0, status = 'paid' where id = ${periodId}::uuid`);
      expect(await codesOf(fixture, periodId)).toEqual([["PAYROLL_PAYMENT_STATE_INCONSISTENT", "READY"]]);
      await runPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT"));
      expect(await periodRow(periodId)).toMatchObject({ outstanding: "3000.00", paid: "0.00", status: "approved" });
      expect((await linesOf(periodId)).map((item) => item.status)).toEqual(["approved", "approved"]);
    });

    it("21: a payment exists but the line / period stayed open -> READY RECONCILE -> paid", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await pay(fixture, periodId);
      await crafted(sql`update payroll_entries set amount_paid = 0, outstanding_amount = net_salary, status = 'approved' where payroll_period_id = ${periodId}::uuid`);
      await crafted(sql`update payroll_periods set total_paid = 0, total_outstanding = total_net_salary, status = 'approved' where id = ${periodId}::uuid`);
      await runPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT"));
      expect(await periodRow(periodId)).toMatchObject({ paid: "3000.00", status: "paid" });
    });

    it("22: an active allocation on a reversed payment / an overpaid line -> MANUAL_REVIEW, never reconciled", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      const paymentId = await pay(fixture, periodId);
      await crafted(sql`update payroll_payments set status = 'reversed', reversed_at = now(), reversed_by_account_id = ${fixture.actorId}::uuid, reversal_reason = 'Crafted' where id = ${paymentId}::uuid`);
      const codes = await codesOf(fixture, periodId);
      expect(codes).toContainEqual(["PAYROLL_PAYMENT_ALLOCATION_INCONSISTENT", "MANUAL_REVIEW"]);
      const view = await preview(fixture, periodId);
      expect(view.findings.every((item) => item.repairability !== "READY")).toBe(true);
    });

    it("23: a reversed period with a live line -> MANUAL_REVIEW; a properly reversed period is HEALTHY", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await as(fixture, () => get(PayrollPeriodService).reverse(periodId, "Wrong month", key("rev"), randomUUID()));
      expect((await preview(fixture, periodId)).findings).toEqual([]);
      const [line] = await linesOf(periodId);
      await crafted(sql`update payroll_entries set status = 'approved', reversed_at = null, reversed_by_account_id = null, reversal_reason = null where id = ${line!.id}::uuid`);
      expect(await codesOf(fixture, periodId)).toContainEqual(["PAYROLL_REVERSED_STILL_ACTIVE", "MANUAL_REVIEW"]);
    });

    it("28: payment state inconsistent on a CLOSED period -> MANUAL_REVIEW (a closed period is never reopened)", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await pay(fixture, periodId);
      await as(fixture, () => get(PayrollPeriodService).close(periodId, key("close"), randomUUID()));
      await crafted(sql`update payroll_entries set amount_paid = 0, outstanding_amount = net_salary, status = 'approved' where payroll_period_id = ${periodId}::uuid`);
      expect(await codesOf(fixture, periodId)).toContainEqual(["PAYROLL_PAYMENT_STATE_INCONSISTENT", "MANUAL_REVIEW"]);
      await refusedPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT", { capabilityCode: "RECONCILE_PAYROLL_PAYMENT_STATE" }), "repair_capability_not_applicable");
      expect((await periodRow(periodId)).status).toBe("closed");
    });

    it("29 + 53: unknown period / another Company's period -> 404, zero mutation in both", async () => {
      const fixture = await payrollFixture();
      const other = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await crafted(sql`update payroll_entries set amount_paid = net_salary, outstanding_amount = 0, status = 'paid' where payroll_period_id = ${periodId}::uuid`);
      const request = await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT");
      const beforeA = await footprint(fixture.companyId);
      const beforeB = await footprint(other.companyId);
      await expect(preview(fixture, randomUUID())).rejects.toMatchObject({ errorCode: "payroll_period_not_found" });
      await expect(preview(other, periodId)).rejects.toMatchObject({ errorCode: "payroll_period_not_found" });
      await expect(runPayroll(other, periodId, request)).rejects.toMatchObject({ errorCode: "payroll_period_not_found" });
      expect((await payrollHealth().list(other.companyId, { status: "all" })).items.some((row) => row.entityId === periodId)).toBe(false);
      expect(await footprint(fixture.companyId)).toBe(beforeA);
      expect(await footprint(other.companyId)).toBe(beforeB);
    });
  });

  // ===========================================================================
  // 30-37, 59: Payroll accounting -- the Phase 4 recovery, reused.
  // ===========================================================================
  describe("Payroll accounting (Phase 4 recovery reused)", () => {
    async function approvalEvent(fixture: PayrollFixture, periodId: string) {
      return eventOf(fixture, "payroll_period", periodId, "employee_payroll_approved");
    }

    it("32 + 59: failed approval and payment events -> ISSUE; recovered from Accounting Health; both healths resolve", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      const paymentId = await pay(fixture, periodId);
      const approval = await approvalEvent(fixture, periodId);
      const payment = await eventOf(fixture, "payroll_payment", paymentId, "employee_payroll_paid");
      await craftFailed(approval);
      await craftFailed(payment);
      const view = await preview(fixture, periodId);
      expect(view.findings.map((item) => [item.reasonCode, item.repairability, item.executionRoute])).toEqual([
        ["PAYROLL_ACCOUNTING_EVENT_FAILED", "READY", "accounting_event"],
      ]);
      expect(view.findings[0]).toMatchObject({ execution: { available: false }, repairCapability: "REPROCESS_ACCOUNTING_EVENT" });
      expect(view.accounting.events.map((event) => event.recovery)).toEqual(["READY", "READY"]);
      expect((await payrollHealth().summary(fixture.companyId)).headlines).toEqual(["ISSUE — Payroll accounting failed."]);
      // Never executed from the Payroll route...
      await refusedPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_ACCOUNTING_EVENT_FAILED", { capabilityCode: "REPROCESS_ACCOUNTING_EVENT" }), "repair_capability_not_applicable");
      // ...but through the ONE accounting recovery (same posting core, one balanced journal each).
      for (const eventId of [approval, payment]) {
        await recoverAndProve(fixture, eventId);
      }
      expect((await preview(fixture, periodId)).findings).toEqual([]);
      expect(await payrollHealth().summary(fixture.companyId)).toMatchObject({ payrollHealth: "HEALTHY" });
      const accounting = await health.summary(fixture.companyId);
      expect(accounting).toMatchObject({ failed: 0, integrity: { total: 0 }, missingRequiredEvents: { total: 0 } });
    });

    it("33: approval / payment accounting events missing while ON -> ISSUE in Payroll AND Accounting Health, MANUAL_REVIEW", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      const paymentId = await pay(fixture, periodId);
      await crafted(sql`delete from accounting_events where company_id = ${fixture.companyId}::uuid
        and source_entity_id in (${periodId}::uuid, ${paymentId}::uuid)`);
      expect(await codesOf(fixture, periodId)).toEqual([["PAYROLL_ACCOUNTING_EVENT_MISSING", "MANUAL_REVIEW"]]);
      const missing = (await health.integrityFindings(fixture.companyId, { kind: "MISSING_REQUIRED_EVENT" })).items;
      expect(missing.map((row) => [row.eventType, row.sourceId]).sort()).toEqual(
        [["employee_payroll_approved", periodId], ["employee_payroll_paid", paymentId]].sort(),
      );
      expect(missing.every((row) => row.repairability === "MANUAL_REVIEW" && row.certifiedCapture === null)).toBe(true);
    });

    it("30: Accounting OFF -> a historical failed Payroll event is not a Payroll finding", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await craftFailed(await approvalEvent(fixture, periodId));
      await setAccounting(fixture, false);
      expect((await preview(fixture, periodId)).findings).toEqual([]);
      expect((await payrollHealth().summary(fixture.companyId)).payrollHealth).toBe("HEALTHY");
    });

    it("34: a posted Payroll journal made unbalanced -> Accounting Health journal-integrity ISSUE, never balanced automatically", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      const approval = await approvalEvent(fixture, periodId);
      await postNow(fixture, approval);
      const [journal] = await journalsFor(approval);
      await crafted(sql`update journal_lines set debit = debit + 1
        where id = (select id from journal_lines where journal_entry_id = ${journal!.id}::uuid and debit > 0 limit 1)`);
      const rows = (await health.integrityFindings(fixture.companyId, { kind: "JOURNAL_INTEGRITY" })).items;
      expect(rows.find((row) => row.eventId === approval)).toMatchObject({ code: "ACCOUNTING_JOURNAL_UNBALANCED", repairability: "MANUAL_REVIEW", sourceType: "payroll_period" });
    });

    it("35 + 36 + 37: fiscal period closed / mapping missing / invalid actor -> the Payroll accounting finding is BLOCKED", async () => {
      const cases: [string, (fixture: PayrollFixture, eventId: string) => Promise<void>, RegExp][] = [
        [
          "closed fiscal period",
          async (fixture) =>
            crafted(sql`update accounting_periods set status = 'closed', closed_at = now(), closed_by_account_id = ${fixture.actorId}::uuid,
                close_reason = 'Crafted' where company_id = ${fixture.companyId}::uuid
                and (select period_end from payroll_periods where company_id = ${fixture.companyId}::uuid limit 1) between period_start and period_end`),
          /period/u,
        ],
        ["missing mapping", async (fixture) => crafted(sql`update account_mappings set is_active = false where company_id = ${fixture.companyId}::uuid`), /mapping/u],
        ["invalid actor", async (_fixture, eventId) => crafted(sql`update accounting_events set actor_id = ${adminId}::uuid where id = ${eventId}::uuid`), /actor/u],
      ];
      for (const [name, mutate, code] of cases) {
        const fixture = await payrollFixture();
        const periodId = await approvedPeriod(fixture);
        const approval = await approvalEvent(fixture, periodId);
        await craftFailed(approval);
        await mutate(fixture, approval);
        const view = await preview(fixture, periodId);
        expect(view.findings.map((item) => [item.reasonCode, item.repairability]), name).toEqual([["PAYROLL_ACCOUNTING_EVENT_FAILED", "BLOCKED"]]);
        const accounting = await recovery.preview(fixture.companyId, approval);
        expect(accounting.repairability, name).toBe("BLOCKED");
        expect(accounting.blockers.map((b) => b.code).join(" "), name).toMatch(code);
        await refused(fixture, approval, await requestFor(fixture, approval), "repair_not_ready");
      }
    });

    it("48: a Company reprocess holding the event while the Platform recovers it -> one journal", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      const approval = await approvalEvent(fixture, periodId);
      await craftFailed(approval);
      const request = await requestFor(fixture, approval);
      const adapter = get(PlatformAccountingRepairAdapter);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let lockedSignal!: () => void;
      const locked = new Promise<void>((resolve) => (lockedSignal = resolve));
      const worker = as(fixture, () =>
        db.transaction().execute(async (transaction) => {
          await adapter.lockEvent(transaction, fixture.companyId, approval);
          lockedSignal();
          await gate;
          await adapter.reprocessInTransaction(transaction, { companyId: fixture.companyId, correlationId: `w-${randomUUID()}`, eventId: approval, reason: "Company" });
        }),
      );
      await locked;
      const platform = run(fixture, approval, request);
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      const [w, p] = await Promise.allSettled([worker, platform]);
      expect(w.status).toBe("fulfilled");
      expect(p).toMatchObject({ status: "rejected" });
      expect(await journalsFor(approval)).toHaveLength(1);
    });
  });

  // ===========================================================================
  // 14-15: driver fees.
  // ===========================================================================
  it("14 + 15: driver fee accrued outside its rate version / paid amount without allocations -> ISSUE, MANUAL_REVIEW", async () => {
    const fixture = await payrollFixture();
    const driverId = randomUUID();
    const versionId = randomUUID();
    await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,outsourced_fee_per_delivered_order)
      values (${driverId}::uuid,${fixture.companyId}::uuid,${`OD-${driverId.slice(0, 6)}`},'Outsourced','971500000004','outsourced',5)`.execute(db);
    await sql`insert into outsourced_driver_fee_versions(id,company_id,driver_id,effective_from,fee_per_order,status,created_by_account_id)
      values (${versionId}::uuid,${fixture.companyId}::uuid,${driverId}::uuid,'2026-06-01'::date,5,'active',${fixture.actorId}::uuid)`.execute(db);
    const accrual = async (businessDate: string, paid: number, status: string) => {
      const id = randomUUID();
      const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      await crafted(sql`insert into outsourced_driver_fee_accruals(id,company_id,driver_id,order_id,delivery_date,accrual_business_date,
          fee_rate_version_id,fee_rate_snapshot,earned_amount,paid_amount,outstanding_amount,status,accrual_source,source_reference,
          created_by_account_id,earning_type,unit_count)
        values (${id}::uuid,${fixture.companyId}::uuid,${driverId}::uuid,${orderId}::uuid,${businessDate}::date,${businessDate}::date,
                ${versionId}::uuid,5,5,${paid},${5 - paid},${status},'delivery',${`ACR-${id.slice(0, 6)}`},${fixture.actorId}::uuid,'delivery',1)`);
      return id;
    };
    const outside = await accrual("2026-01-15", 0, "accrued");
    const unpaid = await accrual("2026-07-15", 2, "partially_paid");
    const summary = await payrollHealth().summary(fixture.companyId);
    expect(summary).toMatchObject({ byCode: { DRIVER_FEE_PAYMENT_STATE_INCONSISTENT: 1, DRIVER_FEE_RATE_OUTSIDE_VERSION: 1 }, driverFeeFindings: 2, payrollHealth: "ISSUE" });
    expect(summary.headlines).toEqual(["ISSUE — Driver fee state is inconsistent."]);
    const rows = (await payrollHealth().list(fixture.companyId, {})).items;
    expect(rows.filter((row) => row.entityType === "outsourced_driver_fee_accrual").map((row) => [row.entityId, row.codes]).sort()).toEqual(
      [[outside, ["DRIVER_FEE_RATE_OUTSIDE_VERSION"]], [unpaid, ["DRIVER_FEE_PAYMENT_STATE_INCONSISTENT"]]].sort(),
    );
  });

  // ===========================================================================
  // 38-52: stale protection, idempotency, concurrency, atomicity, audit.
  // ===========================================================================
  describe("execution safety", () => {
    /** An approved period whose lines were crafted 'paid' with no payment (READY RECONCILE). */
    async function reconcilable() {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await crafted(sql`update payroll_entries set amount_paid = net_salary, outstanding_amount = 0, status = 'paid' where payroll_period_id = ${periodId}::uuid`);
      await crafted(sql`update payroll_periods set total_paid = total_net_salary, total_outstanding = 0, status = 'paid' where id = ${periodId}::uuid`);
      return { fixture, periodId };
    }

    it("38-41: Payroll / component / payment / accounting change after Preview -> 409 stale, zero mutation", async () => {
      const mutations: [string, (fixture: PayrollFixture, periodId: string) => Promise<void>][] = [
        ["38 Payroll period", async (_f, periodId) => crafted(sql`update payroll_periods set notes = 'changed' where id = ${periodId}::uuid`)],
        ["39 component (line)", async (_f, periodId) => crafted(sql`update payroll_entries set notes = 'changed' where payroll_period_id = ${periodId}::uuid`)],
        ["40 payment", async (fixture) => {
          await crafted(sql`update payroll_payments set version = version + 1 where company_id = ${fixture.companyId}::uuid`);
          await crafted(sql`update employees set is_active = false where id = ${fixture.employees[0]!}::uuid`);
        }],
        ["41 accounting state", async (_f, periodId) => crafted(sql`update accounting_events set attempt_count = attempt_count + 1 where source_entity_id = ${periodId}::uuid`)],
      ];
      for (const [name, mutate] of mutations) {
        const { fixture, periodId } = await reconcilable();
        const request = await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT");
        await mutate(fixture, periodId);
        await refusedPayroll(fixture, periodId, request, "repair_preview_stale");
        expect(await payrollAttempts(fixture.companyId, periodId), name).toEqual([["REFUSED", "repair_preview_stale"]]);
      }
    });

    it("42: double submit replays; the same key with a different request is refused", async () => {
      const { fixture, periodId } = await reconcilable();
      const request = await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT");
      const first = await runPayroll(fixture, periodId, request);
      expect(await runPayroll(fixture, periodId, request)).toEqual({ ...first, replayed: true });
      await refusedPayroll(fixture, periodId, { ...request, reason: "Another" }, "repair_idempotency_conflict");
      expect(await payrollAudits(fixture.companyId, periodId)).toHaveLength(1);
      expect((await payrollAttempts(fixture.companyId, periodId)).map(([result]) => result)).toEqual(["REPLAYED", "REFUSED"]);
    });

    it("43 + 49 + 50: a timeout / forced failure rolls everything back (durable FAILED); the retry succeeds once", async () => {
      const { fixture, periodId } = await reconcilable();
      const request = await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT");
      const before = await footprint(fixture.companyId);
      vi.spyOn(get(PayrollOperationalRepository), "reconcilePaymentState").mockRejectedValueOnce(
        Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
      );
      await expect(runPayroll(fixture, periodId, request)).rejects.toThrow(/statement timeout/u);
      expect(await footprint(fixture.companyId)).toBe(before);
      expect(await payrollAttempts(fixture.companyId, periodId)).toEqual([["FAILED", "repair_execution_failed"]]);
      expect(await runPayroll(fixture, periodId, request)).toMatchObject({ replayed: false, status: "succeeded" });
      expect(await payrollAudits(fixture.companyId, periodId)).toHaveLength(1);
    });

    it("44: concurrent Platform repairs of one period -> exactly one succeeds", async () => {
      const { fixture, periodId } = await reconcilable();
      const request = await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT");
      const results = await Promise.allSettled([
        runPayroll(fixture, periodId, request),
        runPayroll(fixture, periodId, { ...request, idempotencyKey: `rc-pay-${randomUUID()}` }),
        runPayroll(fixture, periodId, { ...request, idempotencyKey: `rc-pay-${randomUUID()}` }),
      ]);
      expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      for (const item of results.filter((entry) => entry.status === "rejected")) {
        expect(["repair_finding_not_current", "repair_preview_stale"]).toContain(((item as PromiseRejectedResult).reason as ApplicationException).errorCode);
      }
      expect(await payrollAudits(fixture.companyId, periodId)).toHaveLength(1);
      expect((await preview(fixture, periodId)).findings).toEqual([]);
    });

    it("45: Platform draft repair vs the Company's Recalculate -> one consistent result", async () => {
      const fixture = await payrollFixture();
      const periodId = await calculatedPeriod(fixture);
      const [line] = await linesOf(periodId);
      await sql`update payroll_entries set earning_adjustments_total = 500, gross_earnings = gross_earnings + 500,
          net_salary = net_salary + 500, outstanding_amount = outstanding_amount + 500 where id = ${line!.id}::uuid`.execute(db);
      const request = await payrollRequest(fixture, periodId, "PAYROLL_LINE_AMOUNTS_INCONSISTENT");
      await Promise.allSettled([
        runPayroll(fixture, periodId, request),
        as(fixture, () => get(PayrollCalculationService).recalculate(periodId, key("recalc"), randomUUID(), true)),
      ]);
      expect((await preview(fixture, periodId)).findings).toEqual([]);
      expect(await linesOf(periodId)).toHaveLength(2);
      expect((await periodRow(periodId)).net).toBe("3000.00");
    });

    it("46: Platform draft totals repair vs the Company's approval -> one consistent result", async () => {
      const fixture = await payrollFixture();
      const periodId = await calculatedPeriod(fixture);
      await sql`update payroll_periods set total_net_salary = 1, total_outstanding = 1 where id = ${periodId}::uuid`.execute(db);
      const request = await payrollRequest(fixture, periodId, "PAYROLL_PERIOD_TOTALS_MISMATCH");
      const [platform] = await Promise.allSettled([
        runPayroll(fixture, periodId, request),
        as(fixture, () => get(PayrollPeriodService).approve(periodId, key("approve"), randomUUID())),
      ]);
      expect((await periodRow(periodId))).toMatchObject({ net: "3000.00", status: "approved" });
      expect((await preview(fixture, periodId)).findings).toEqual([]);
      if (platform.status === "rejected") {
        expect(["repair_finding_not_current", "repair_preview_stale", "repair_capability_not_applicable"]).toContain(
          (platform.reason as ApplicationException).errorCode,
        );
      }
    });

    it("47: Platform reconcile vs a Company payment -> one effective payment, never an overpaid line", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      const paymentId = await pay(fixture, periodId);
      // Crafted: the lines forgot the payment (outstanding again).
      await crafted(sql`update payroll_entries set amount_paid = 0, outstanding_amount = net_salary, status = 'approved' where payroll_period_id = ${periodId}::uuid`);
      await crafted(sql`update payroll_periods set total_paid = 0, total_outstanding = total_net_salary, status = 'approved' where id = ${periodId}::uuid`);
      const request = await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT");
      await Promise.allSettled([runPayroll(fixture, periodId, request), pay(fixture, periodId)]);
      const payments = (await sql<{ id: string }>`select id from payroll_payments where payroll_period_id = ${periodId}::uuid and status = 'confirmed'`.execute(db)).rows;
      expect(payments.map((row) => row.id)).toContain(paymentId);
      const lines = await linesOf(periodId);
      for (const line of lines) expect(Number(line.paid)).toBeLessThanOrEqual(Number(line.net));
      // Whatever ran first, the period ends consistent with its allocations or explicitly flagged.
      const view = await preview(fixture, periodId);
      expect(view.findings.every((item) => item.repairability !== "READY" || item.reasonCode === "PAYROLL_PAYMENT_STATE_INCONSISTENT")).toBe(true);
    });

    it("51 + 52 + 56: refused / successful audit rows; the reconcile changes only settlement columns", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await pay(fixture, periodId);
      await crafted(sql`update payroll_entries set amount_paid = 0, outstanding_amount = net_salary, status = 'approved' where payroll_period_id = ${periodId}::uuid`);
      await refusedPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT", { previewVersion: `prv1:${"0".repeat(64)}` }), "repair_preview_stale");
      const frozen = async () =>
        (
          await sql<{ d: string }>`select md5(string_agg((to_jsonb(l) - array['amount_paid','outstanding_amount','status','version','updated_at']::text[])::text, '|' order by l.id)) as d
            from payroll_entries l where l.payroll_period_id = ${periodId}::uuid`.execute(db)
        ).rows[0]!.d;
      const history = async () =>
        (
          await sql<{ d: string }>`select md5(coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from payroll_payments x where x.payroll_period_id = ${periodId}::uuid), '')
              || coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from payroll_payment_allocations x where x.company_id = ${fixture.companyId}::uuid), '')
              || coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from payroll_adjustments x where x.company_id = ${fixture.companyId}::uuid), '')
              || coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from journal_entries x where x.company_id = ${fixture.companyId}::uuid), '')) as d`.execute(db)
        ).rows[0]!.d;
      const before = { history: await history(), lines: await frozen() };
      const request = await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT");
      const result = await runPayroll(fixture, periodId, request);
      expect({ history: await history(), lines: await frozen() }).toEqual(before);
      const audit = (await sql<Record<string, unknown>>`select company_id::text as company, actor_account_id::text as actor, actor_authority as authority,
          entity_type as "entityType", entity_id::text as entity, entity_number as reference, finding_id as finding,
          capability_code as capability, reason, result, before_health as "beforeHealth", after_health as "afterHealth"
        from platform_repair_executions where id = ${result.repairExecutionId}::uuid`.execute(db)).rows[0];
      expect(audit).toEqual({
        actor: adminId,
        afterHealth: "HEALTHY",
        authority: "platform.companies.repair_center.execute",
        beforeHealth: "ISSUE",
        capability: "RECONCILE_PAYROLL_PAYMENT_STATE",
        company: fixture.companyId,
        entity: periodId,
        entityType: "payroll_period",
        finding: request.findingId,
        reason: request.reason,
        reference: expect.any(String),
        result: "succeeded",
      });
      expect(await payrollAttempts(fixture.companyId, periodId)).toEqual([["REFUSED", "repair_preview_stale"]]);
    });
  });

  // ===========================================================================
  // 54 + statement counts.
  // ===========================================================================
  it("54: reset compatibility -- Payroll is reset data, every repair audit is preserved, no new table", () => {
    for (const table of ["payroll_periods", "payroll_entries", "payroll_payments", "payroll_payment_allocations", "payroll_adjustments"]) {
      expect(PURGE_TABLES.has(table), table).toBe(true);
    }
    for (const table of ["platform_repair_executions", "platform_repair_attempts", "accounting_configuration_history"]) {
      expect(PRESERVE_TABLES.has(table), table).toBe(true);
    }
  });

  it("Payroll Health summary and list are one statement each", async () => {
    const fixture = await payrollFixture();
    await approvedPeriod(fixture);
    let statements = 0;
    const counting = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === "query") statements += 1;
      },
    });
    const counted = new PlatformPayrollHealthService(counting);
    statements = 0;
    await counted.summary(fixture.companyId);
    const summaryStatements = statements;
    statements = 0;
    await counted.list(fixture.companyId, { status: "all" });
    expect([summaryStatements, statements]).toEqual([5, 5]);
  });
});
