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
 * REPAIR CENTER PHASE 5 PROMPT 2 -- PAYROLL & INCENTIVES FINAL CERTIFICATION
 * (final matrix 1-75).
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

describe.skipIf(!runDatabaseTests)("Repair Center Phase 5 Prompt 2 -- Payroll & incentives final certification", () => {
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

  const key = (label: string) => `rc5p2.${label}.${randomUUID()}`;

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`RC5P2-${tag}`},${`rc5p2-${tag}`},${`RC5P2 ${mode} ${tag}`},
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
  // Phase 5 Prompt 2 helpers
  // ===========================================================================

  async function lineOf(periodId: string, employeeId: string) {
    return (await linesOf(periodId)).find((line) => line.employeeId === employeeId)!;
  }

  /** Crafted: a calculated period (and its lines) back in `draft` -- the earliest unfinalized state. */
  async function asDraft(periodId: string) {
    await crafted(sql`update payroll_entries set status = 'draft' where payroll_period_id = ${periodId}::uuid`);
    await crafted(sql`update payroll_periods set status = 'draft' where id = ${periodId}::uuid`);
  }

  /** Unfinalized line: its earning-adjustment total drifts from its (absent) adjustments; CHECK kept. */
  async function driftLine(lineId: string, delta = 500) {
    await sql`update payroll_entries set earning_adjustments_total = earning_adjustments_total + ${delta},
        gross_earnings = gross_earnings + ${delta}, net_salary = net_salary + ${delta},
        outstanding_amount = outstanding_amount + ${delta}
      where id = ${lineId}::uuid`.execute(db);
  }

  /** Approved+: the lines and header forgot their payments (derived cache only; allocations intact). */
  async function forgetPayments(periodId: string) {
    await crafted(sql`update payroll_entries set amount_paid = 0, outstanding_amount = net_salary, status = 'approved'
       where payroll_period_id = ${periodId}::uuid and status not in ('held', 'reversed')`);
    await crafted(sql`update payroll_periods set total_paid = 0, total_outstanding = total_net_salary, status = 'approved'
       where id = ${periodId}::uuid`);
  }

  async function craftAdjustment(
    fixture: PayrollFixture,
    periodId: string,
    lineId: string,
    employeeId: string,
    direction: "earning" | "deduction",
    amount: number,
  ) {
    const id = randomUUID();
    await crafted(sql`insert into payroll_adjustments(id, company_id, payroll_period_id, payroll_line_id, employee_id,
        adjustment_type, direction, amount, reason, created_by_account_id)
      values (${id}::uuid, ${fixture.companyId}::uuid, ${periodId}::uuid, ${lineId}::uuid, ${employeeId}::uuid,
              ${direction === "earning" ? "bonus" : "penalty"}, ${direction}, ${amount}, 'Crafted', ${fixture.actorId}::uuid)`);
    return id;
  }

  async function refusedAny(fixture: { companyId: string }, periodId: string, request: RepairExecutionRequest, codes: readonly string[]) {
    const before = await footprint(fixture.companyId);
    const error = await runPayroll(fixture, periodId, request).then(
      () => undefined,
      (failure: unknown) => failure as ApplicationException,
    );
    expect(error, "the repair must be refused").toBeDefined();
    expect(codes).toContain(error!.errorCode);
    expect(await footprint(fixture.companyId), "a refused Payroll repair must not mutate anything").toBe(before);
    return error!.errorCode;
  }

  /** A period whose lines forgot a real, fully allocated payment: READY RECONCILE with allocations behind it. */
  async function forgotPaid(mode: Mode | "posting" = "posting") {
    const fixture = await payrollFixture(mode);
    const periodId = await approvedPeriod(fixture);
    const paymentId = await pay(fixture, periodId);
    await forgetPayments(periodId);
    return { fixture, paymentId, periodId };
  }

  /** The Platform's expected values must equal what the Company's stored values are (one truth). */
  async function expectParity(fixture: { companyId: string }, periodId: string, label: string) {
    const view = await preview(fixture, periodId);
    expect(view.findings, label).toEqual([]);
    for (const line of view.lines) {
      expect(line.current, `${label}: line ${line.payrollNumber}`).toEqual({
        gross: line.expected.gross,
        net: line.expected.net,
        outstanding: line.expected.outstanding,
        paid: line.expected.paid,
      });
      if (["approved", "partially_paid", "paid"].includes(line.status)) {
        expect(line.status, `${label}: line status ${line.payrollNumber}`).toBe(line.expected.status);
      }
    }
    expect(view.period.totals, `${label}: header totals`).toEqual(view.period.expectedTotals);
    return view;
  }

  // ===========================================================================
  // 1-7: every healthy lifecycle state is HEALTHY; reversed history stays reversed.
  // ===========================================================================
  describe("healthy lifecycle (1-7)", () => {
    it("1 draft (no lines) / 2 calculated / 3 approved / 4 partially paid / 5 paid / 6 closed -> HEALTHY at every step", async () => {
      const fixture = await payrollFixture();
      const period = (await as(fixture, () =>
        get(PayrollPeriodService).create(MONTH, undefined, key("period"), randomUUID()),
      )) as { periodId: string };
      expect((await preview(fixture, period.periodId))).toMatchObject({ findings: [], health: "HEALTHY", period: { status: "draft" } });
      await as(fixture, () => get(PayrollCalculationService).calculate(period.periodId, key("calculate"), randomUUID(), true));
      expect(await expectParity(fixture, period.periodId, "2 calculated")).toMatchObject({ period: { status: "calculated" } });
      await as(fixture, () => get(PayrollPeriodService).approve(period.periodId, key("approve"), randomUUID()));
      expect(await expectParity(fixture, period.periodId, "3 approved")).toMatchObject({ period: { status: "approved" } });
      await pay(fixture, period.periodId, true);
      expect(await expectParity(fixture, period.periodId, "4 partially paid")).toMatchObject({ period: { status: "partially_paid" } });
      const remaining = (await linesOf(period.periodId)).filter((line) => Number(line.outstanding) > 0);
      expect(remaining).toHaveLength(1);
      await as(fixture, () =>
        get(PayrollPaymentService).confirm(
          {
            accountId: fixture.cashAccountId,
            acknowledgementType: "checkbox",
            allocations: remaining.map((line) => ({ amount: Number(line.outstanding), employeeId: line.employeeId, lineId: line.id })),
            cashVoucherReference: "V-REST",
            paymentDate: today,
            periodId: period.periodId,
          } as never,
          key("pay-rest"),
          randomUUID(),
        ),
      );
      expect(await expectParity(fixture, period.periodId, "5 paid")).toMatchObject({ period: { status: "paid" } });
      await as(fixture, () => get(PayrollPeriodService).close(period.periodId, key("close"), randomUUID()));
      expect(await expectParity(fixture, period.periodId, "6 closed")).toMatchObject({ health: "HEALTHY", period: { status: "closed" } });
      expect(await payrollHealth().summary(fixture.companyId)).toMatchObject({ headlines: [], payrollHealth: "HEALTHY" });
    });

    it("7 historical reversed Payroll stays reversed and HEALTHY after payments, workforce and accounting changes", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await as(fixture, () => get(PayrollPeriodService).reverse(periodId, "Wrong month", key("rev"), randomUUID()));
      const reversedLines = await linesOf(periodId);
      expect(reversedLines.every((line) => line.status === "reversed")).toBe(true);
      // Later life of the Company: an employee leaves, Accounting is toggled, a new Payroll for the month.
      await crafted(sql`update employees set is_active = false, deactivated_at = now() where id = ${fixture.employees[0]!}::uuid`);
      await setAccounting(fixture, false);
      await setAccounting(fixture, true);
      const replacement = await as(fixture, () =>
        get(PayrollPeriodService).create(MONTH, undefined, key("period-2"), randomUUID()),
      ).then(
        (value) => (value as { periodId: string }).periodId,
        () => undefined,
      );
      if (replacement !== undefined) {
        await as(fixture, () => get(PayrollCalculationService).calculate(replacement, key("calc-2"), randomUUID(), true));
      }
      const view = await preview(fixture, periodId);
      expect(view).toMatchObject({ findings: [], health: "HEALTHY", period: { status: "reversed" } });
      expect(await linesOf(periodId)).toEqual(reversedLines);
      // No capability applies to a reversed period at all.
      for (const capability of ["REPAIR_PAYROLL_LINE_AMOUNTS", "REBUILD_PAYROLL_PERIOD_TOTALS", "RECONCILE_PAYROLL_PAYMENT_STATE"]) {
        await refusedAny(fixture, periodId, {
          capabilityCode: capability,
          findingId: "fnd_none",
          idempotencyKey: `rc-pay-${randomUUID()}`,
          previewVersion: view.previewVersion,
          reason: "Try to resurrect",
        } as RepairExecutionRequest, ["repair_finding_not_current"]);
      }
      expect((await periodRow(periodId)).status).toBe("reversed");
    });
  });

  // ===========================================================================
  // Section 3: ONE financial truth -- Platform expected == Company stored, contract.
  // ===========================================================================
  describe("one Payroll financial truth (contract)", () => {
    it("after every Company operation the Platform's expected gross / net / paid / outstanding / status / totals equal the stored ones", async () => {
      const fixture = await payrollFixture();
      const periodId = await calculatedPeriod(fixture);
      await expectParity(fixture, periodId, "calculate");
      const [first] = await linesOf(periodId);
      const adjustments = get(PayrollAdjustmentService);
      await as(fixture, () => adjustments.create(first!.id, { adjustmentType: "bonus", amount: 100, direction: "earning", reason: "Bonus" } as never, key("bonus"), randomUUID()));
      await expectParity(fixture, periodId, "bonus");
      const penalty = (await as(fixture, () => adjustments.create(first!.id, { adjustmentType: "penalty", amount: 40, direction: "deduction", reason: "Late" } as never, key("pen"), randomUUID()))) as { adjustmentId?: string; id?: string };
      await expectParity(fixture, periodId, "penalty");
      const penaltyId = penalty.adjustmentId ?? penalty.id ?? (await sql<{ id: string }>`select id from payroll_adjustments where payroll_line_id = ${first!.id}::uuid and direction = 'deduction'`.execute(db)).rows[0]!.id;
      await as(fixture, () => adjustments.reverse(penaltyId, "Waived", key("pen-rev"), randomUUID()));
      await expectParity(fixture, periodId, "penalty reversed");
      await as(fixture, () => get(PayrollCalculationService).recalculate(periodId, key("recalc"), randomUUID(), true));
      await expectParity(fixture, periodId, "recalculate");
      await as(fixture, () => get(PayrollPeriodService).approve(periodId, key("approve"), randomUUID()));
      await expectParity(fixture, periodId, "approve");
      const partial = await pay(fixture, periodId, true);
      await expectParity(fixture, periodId, "partial payment");
      await as(fixture, () => get(PayrollPaymentService).reverse(partial, "Wrong amount", key("pay-rev"), randomUUID()));
      await expectParity(fixture, periodId, "payment reversed");
      await pay(fixture, periodId);
      const view = await expectParity(fixture, periodId, "paid in full");
      expect(view.period.status).toBe("paid");
      await as(fixture, () => get(PayrollPeriodService).close(periodId, key("close"), randomUUID()));
      await expectParity(fixture, periodId, "closed");
    });

    it("the Platform's expected line amounts are exactly what PayrollOperationalRepository.recalculateLine stores (randomised, held line included)", async () => {
      const fixture = await payrollFixture();
      const periodId = await calculatedPeriod(fixture);
      const lines = await linesOf(periodId);
      const repository = get(PayrollOperationalRepository);
      const cases = [
        { advances: 0, earn: [120], ded: [30], reversed: [15] },
        { advances: 25, earn: [], ded: [10, 5], reversed: [] },
        { advances: 0, earn: [7.5, 2.25], ded: [], reversed: [100] },
        { advances: 50, earn: [300], ded: [299.99], reversed: [1] },
      ];
      for (const [index, item] of cases.entries()) {
        const line = lines[index % lines.length]!;
        const employeeId = line.employeeId;
        for (const amount of item.earn) await craftAdjustment(fixture, periodId, line.id, employeeId, "earning", amount);
        for (const amount of item.ded) await craftAdjustment(fixture, periodId, line.id, employeeId, "deduction", amount);
        for (const amount of item.reversed) {
          const id = await craftAdjustment(fixture, periodId, line.id, employeeId, "deduction", amount);
          await crafted(sql`update payroll_adjustments set status = 'reversed', reversed_at = now(),
              reversed_by_account_id = ${fixture.actorId}::uuid, reversal_reason = 'Crafted' where id = ${id}::uuid`);
        }
        if (item.advances > 0) {
          await crafted(sql`update payroll_entries set advances = advances + ${item.advances}, net_salary = net_salary - ${item.advances},
              outstanding_amount = outstanding_amount - ${item.advances} where id = ${line.id}::uuid`);
        }
        const expected = (await preview(fixture, periodId)).lines.find((row) => row.lineId === line.id)!.expected;
        await db.transaction().execute((transaction) => repository.recalculateLine(transaction, fixture.companyId, line.id));
        const stored = await lineOf(periodId, employeeId);
        expect({ gross: stored.gross, net: stored.net, outstanding: stored.outstanding }, `case ${index}`).toEqual({
          gross: expected.gross,
          net: expected.net,
          outstanding: (Number(expected.net) - Number(expected.paid)).toFixed(2),
        });
      }
      // A held line pays nothing -- its components are zero (the CHECK ties gross to them) and its
      // active adjustments are ignored: both implementations agree.
      const held = lines[0]!;
      await crafted(sql`update payroll_entries set salary_hold_snapshot = true, salary_hold_reason_snapshot = 'Crafted hold',
          salary_hold_from_snapshot = current_date, basic_salary_snapshot = 0, allowance_total = 0, employee_driver_commission = 0,
          delivered_order_earnings = 0, collection_earnings = 0, earning_adjustments_total = 0, deduction_adjustments_total = 0,
          advances = 0, variable_earnings_already_paid = 0, salary_advance_recovery = 0, gross_earnings = 0, net_salary = 0,
          outstanding_amount = 0 where id = ${held.id}::uuid`);
      const heldExpected = (await preview(fixture, periodId)).lines.find((row) => row.lineId === held.id)!.expected;
      await db.transaction().execute((transaction) => repository.recalculateLine(transaction, fixture.companyId, held.id));
      expect((await lineOf(periodId, held.employeeId))).toMatchObject({ gross: heldExpected.gross, net: heldExpected.net });
      expect(heldExpected.gross).toBe("0.00");
      await db.transaction().execute((transaction) => repository.recalculatePeriodTotals(transaction, fixture.companyId, periodId));
      const view = await preview(fixture, periodId);
      expect(view.period.totals).toEqual(view.period.expectedTotals);
    });
  });

  // ===========================================================================
  // 8-11: REPAIR_PAYROLL_LINE_AMOUNTS and the component boundary.
  // ===========================================================================
  describe("REPAIR_PAYROLL_LINE_AMOUNTS (8-11)", () => {
    for (const status of ["draft", "calculated"] as const) {
      it(`${status === "draft" ? 8 : 9}: ${status} line drift -> READY -> recomputed from its own snapshots + active adjustments, totals rebuilt, HEALTHY`, async () => {
        const fixture = await payrollFixture();
        const periodId = await calculatedPeriod(fixture);
        if (status === "draft") await asDraft(periodId);
        const line = await lineOf(periodId, fixture.employees[0]!);
        await as(fixture, () => get(PayrollAdjustmentService).create(line.id, { adjustmentType: "bonus", amount: 75, direction: "earning", reason: "Bonus" } as never, key("bonus"), randomUUID()));
        const reversedId = await craftAdjustment(fixture, periodId, line.id, fixture.employees[0]!, "deduction", 60);
        await crafted(sql`update payroll_adjustments set status = 'reversed', reversed_at = now(), reversed_by_account_id = ${fixture.actorId}::uuid,
            reversal_reason = 'Crafted' where id = ${reversedId}::uuid`);
        const truth = await lineOf(periodId, fixture.employees[0]!);
        await driftLine(line.id, 500);
        // Today's mutable configuration changes too: it must never be read.
        await crafted(sql`update employee_salary_versions set basic_salary = 7777 where employee_id = ${fixture.employees[0]!}::uuid`);
        const view = await preview(fixture, periodId);
        expect(view.findings.map((f) => [f.reasonCode, f.repairability])).toEqual([
          ["PAYROLL_LINE_AMOUNTS_INCONSISTENT", "READY"],
          ["PAYROLL_PERIOD_TOTALS_MISMATCH", "BLOCKED"],
        ]);
        const frozen = async () =>
          (
            await sql<{ d: string }>`select md5(string_agg((to_jsonb(l) - array['earning_adjustments_total','deduction_adjustments_total',
                'gross_earnings','net_salary','outstanding_amount','version','updated_at']::text[])::text, '|' order by l.id)) as d
              from payroll_entries l where l.payroll_period_id = ${periodId}::uuid`.execute(db)
          ).rows[0]!.d;
        const before = await frozen();
        const result = await runPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_LINE_AMOUNTS_INCONSISTENT"));
        expect(result).toMatchObject({ afterHealth: "HEALTHY", capabilityCode: "REPAIR_PAYROLL_LINE_AMOUNTS", status: "succeeded" });
        expect(await lineOf(periodId, fixture.employees[0]!)).toMatchObject({ gross: truth.gross, net: truth.net, status });
        // Only the derived amount columns changed; snapshots and the status did not.
        expect(await frozen()).toBe(before);
        expect((await periodRow(periodId)).status).toBe(status);
        await expectParity(fixture, periodId, "after line repair");
      });
    }

    it("10: a line whose own components make net negative -> BLOCKED, refused repair_not_ready, zero mutation", async () => {
      const fixture = await payrollFixture();
      const periodId = await calculatedPeriod(fixture);
      const line = await lineOf(periodId, fixture.employees[0]!);
      await craftAdjustment(fixture, periodId, line.id, fixture.employees[0]!, "deduction", 5000);
      const finding = (await preview(fixture, periodId)).findings.find((f) => f.reasonCode === "PAYROLL_LINE_AMOUNTS_INCONSISTENT")!;
      expect(finding).toMatchObject({ execution: { available: false }, repairability: "BLOCKED" });
      expect(finding.blockers.map((b) => b.code)).toEqual(["payroll_line_negative_net_salary"]);
      await refusedPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_LINE_AMOUNTS_INCONSISTENT"), "repair_not_ready");
    });

    it("11: component mismatches (allowance, commission, bonus source, deduction source) -> MANUAL_REVIEW, no Execute, zero mutation", async () => {
      const variants: [string, (fixture: PayrollFixture, periodId: string, lineId: string) => Promise<void>][] = [
        ["allowance total vs allowance rows", async (_f, _p, lineId) =>
          sql`update payroll_entries set allowance_total = 250, gross_earnings = gross_earnings + 250, net_salary = net_salary + 250,
              outstanding_amount = outstanding_amount + 250 where id = ${lineId}::uuid`.execute(db).then(() => undefined)],
        ["commission vs commission links", async (_f, _p, lineId) =>
          sql`update payroll_entries set employee_driver_commission = 40, gross_earnings = gross_earnings + 40, net_salary = net_salary + 40,
              outstanding_amount = outstanding_amount + 40 where id = ${lineId}::uuid`.execute(db).then(() => undefined)],
        ["bonus recorded for another employee", async (fixture, periodId, lineId) => {
          await craftAdjustment(fixture, periodId, lineId, fixture.employees[1]!, "earning", 90);
        }],
        ["deduction recorded for another period", async (fixture, _periodId, lineId) => {
          const other = (await as(fixture, () => get(PayrollPeriodService).create(
            `${String(Number(MONTH.slice(0, 4)) - 1)}${MONTH.slice(4)}`, undefined, key("other"), randomUUID()))) as { periodId: string };
          await craftAdjustment(fixture, other.periodId, lineId, fixture.employees[0]!, "deduction", 30);
        }],
      ];
      for (const [name, mutate] of variants) {
        const fixture = await payrollFixture();
        const periodId = await calculatedPeriod(fixture);
        const line = await lineOf(periodId, fixture.employees[0]!);
        await mutate(fixture, periodId, line.id);
        const view = await preview(fixture, periodId);
        const component = view.findings.find((f) => f.reasonCode === "PAYROLL_LINE_COMPONENTS_INCONSISTENT");
        expect(component, name).toMatchObject({ execution: { available: false }, repairability: "MANUAL_REVIEW" });
        expect(component!.whyNotAutomatic, name).toMatch(/Recalculate/u);
        expect(view.findings.some((f) => f.repairability === "READY"), name).toBe(false);
        for (const capability of ["REPAIR_PAYROLL_LINE_AMOUNTS", "REBUILD_PAYROLL_PERIOD_TOTALS"]) {
          await refusedAny(fixture, periodId, { ...(await payrollRequest(fixture, periodId, "PAYROLL_LINE_COMPONENTS_INCONSISTENT")), capabilityCode: capability }, ["repair_capability_not_applicable"]);
        }
      }
    });

    it("11b: an earning snapshot (delivered / collection earnings) changed in place is never re-derived from today's sources", async () => {
      const fixture = await payrollFixture();
      const periodId = await calculatedPeriod(fixture);
      const line = await lineOf(periodId, fixture.employees[0]!);
      await sql`update payroll_entries set delivered_order_earnings = 33, gross_earnings = gross_earnings + 33, net_salary = net_salary + 33,
          outstanding_amount = outstanding_amount + 33 where id = ${line.id}::uuid`.execute(db);
      // The line is self-consistent; only the header disagrees. No line amount is rewritten.
      const view = await preview(fixture, periodId);
      expect(view.findings.map((f) => f.reasonCode)).toEqual(["PAYROLL_PERIOD_TOTALS_MISMATCH"]);
      expect(view.lines.find((row) => row.lineId === line.id)!.expected.net).toBe((Number(line.net) + 33).toFixed(2));
    });

    it("draft line repair never touches a legacy line (inputs not provable) and is refused when the period carries payment history", async () => {
      const fixture = await payrollFixture();
      const periodId = await calculatedPeriod(fixture);
      const modern = await lineOf(periodId, fixture.employees[0]!);
      const legacy = await lineOf(periodId, fixture.employees[1]!);
      await driftLine(modern.id, 500);
      await crafted(sql`update payroll_entries set source_marker = 'legacy', earning_adjustments_total = earning_adjustments_total + 9,
          gross_earnings = gross_earnings + 9, net_salary = net_salary + 9, outstanding_amount = outstanding_amount + 9 where id = ${legacy.id}::uuid`);
      const legacyBefore = await lineOf(periodId, fixture.employees[1]!);
      expect(await codesOf(fixture, periodId)).toEqual([
        ["PAYROLL_LINE_AMOUNTS_INCONSISTENT", "READY"],
        ["PAYROLL_PERIOD_TOTALS_MISMATCH", "BLOCKED"],
        ["PAYROLL_LEGACY_HISTORY_REVIEW", "MANUAL_REVIEW"],
      ]);
      await runPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_LINE_AMOUNTS_INCONSISTENT"));
      expect(await lineOf(periodId, fixture.employees[1]!)).toEqual(legacyBefore);
      expect(await codesOf(fixture, periodId)).toEqual([["PAYROLL_LEGACY_HISTORY_REVIEW", "MANUAL_REVIEW"]]);

      // Payment history on an unfinalized period: never rewritten automatically.
      const other = await payrollFixture();
      const draft = await calculatedPeriod(other);
      const target = await lineOf(draft, other.employees[0]!);
      await driftLine(target.id, 100);
      const paymentId = randomUUID();
      await crafted(sql`insert into payroll_payments(id, company_id, payment_number, payment_date, payment_method, total_amount,
          acknowledgement_type, status, paid_by_account_id, idempotency_key, request_hash, payroll_period_id)
        values (${paymentId}::uuid, ${other.companyId}::uuid, ${`PP-X-${paymentId.slice(0, 6)}`}, current_date, 'cash', 10,
                'checkbox', 'confirmed', ${other.actorId}::uuid, ${`x-${paymentId}`}, 'x', ${draft}::uuid)`);
      const finding = (await preview(other, draft)).findings.find((f) => f.reasonCode === "PAYROLL_LINE_AMOUNTS_INCONSISTENT")!;
      expect(finding).toMatchObject({ repairability: "MANUAL_REVIEW", whyNotAutomatic: expect.stringMatching(/payment history/u) });
      await refusedPayroll(other, draft, await payrollRequest(other, draft, "PAYROLL_LINE_AMOUNTS_INCONSISTENT"), "repair_not_ready");
    });
  });

  // ===========================================================================
  // 12-15: REBUILD_PAYROLL_PERIOD_TOTALS.
  // ===========================================================================
  describe("REBUILD_PAYROLL_PERIOD_TOTALS (12-15)", () => {
    it("12: draft header totals drift from healthy lines -> READY -> exactly the sum of the lines", async () => {
      const fixture = await payrollFixture();
      const periodId = await calculatedPeriod(fixture);
      const truth = (await preview(fixture, periodId)).period.totals;
      await sql`update payroll_periods set total_net_salary = 1, total_outstanding = 1, total_basic_salary = 5, total_employees = 9
        where id = ${periodId}::uuid`.execute(db);
      expect(await codesOf(fixture, periodId)).toEqual([["PAYROLL_PERIOD_TOTALS_MISMATCH", "READY"]]);
      const lineDigest = async () => (await sql<{ d: string }>`select md5(string_agg(to_jsonb(l)::text, '|' order by l.id)) as d from payroll_entries l where l.payroll_period_id = ${periodId}::uuid`.execute(db)).rows[0]!.d;
      const lines = await lineDigest();
      await runPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_PERIOD_TOTALS_MISMATCH"));
      expect((await preview(fixture, periodId)).period.totals).toEqual(truth);
      expect(await lineDigest()).toBe(lines);
    });

    it("13: totals BLOCKED while any line is unhealthy (repair the lines first), refused repair_not_ready", async () => {
      const fixture = await payrollFixture();
      const periodId = await calculatedPeriod(fixture);
      await driftLine((await lineOf(periodId, fixture.employees[0]!)).id, 200);
      const finding = (await preview(fixture, periodId)).findings.find((f) => f.reasonCode === "PAYROLL_PERIOD_TOTALS_MISMATCH")!;
      expect(finding).toMatchObject({ repairability: "BLOCKED", blockers: [{ code: "payroll_line_amounts_first" }] });
      await refusedPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_PERIOD_TOTALS_MISMATCH"), "repair_not_ready");
    });

    for (const [n, state] of [[14, "approved"], [15, "paid"]] as const) {
      it(`${n}: ${state} header totals mismatch -> MANUAL_REVIEW (finalized header history), refused, zero mutation`, async () => {
        const fixture = await payrollFixture();
        const periodId = await approvedPeriod(fixture);
        if (state === "paid") await pay(fixture, periodId);
        await crafted(sql`update payroll_periods set total_basic_salary = total_basic_salary + 1 where id = ${periodId}::uuid`);
        const finding = (await preview(fixture, periodId)).findings.find((f) => f.reasonCode === "PAYROLL_PERIOD_TOTALS_MISMATCH")!;
        expect(finding).toMatchObject({ repairCapability: null, repairability: "MANUAL_REVIEW", whyNotAutomatic: expect.stringMatching(/immutable/u) });
        await refusedAny(fixture, periodId, { ...(await payrollRequest(fixture, periodId, "PAYROLL_PERIOD_TOTALS_MISMATCH")), capabilityCode: "REBUILD_PAYROLL_PERIOD_TOTALS" }, ["repair_capability_not_applicable"]);
        expect((await periodRow(periodId)).status).toBe(state);
      });
    }
  });

  // ===========================================================================
  // 16-21: RECONCILE_PAYROLL_PAYMENT_STATE and the payment boundary.
  // ===========================================================================
  describe("RECONCILE_PAYROLL_PAYMENT_STATE and payments (16-21)", () => {
    const history = async (companyId: string, periodId: string) =>
      (
        await sql<{ d: string }>`select md5(
            coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from payroll_payments x where x.company_id = ${companyId}::uuid), '')
         || coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from payroll_payment_allocations x where x.company_id = ${companyId}::uuid), '')
         || coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from cash_bank_movements x where x.company_id = ${companyId}::uuid), '')
         || coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from journal_entries x where x.company_id = ${companyId}::uuid), '')
         || coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from accounting_events x where x.company_id = ${companyId}::uuid), '')
         || coalesce((select string_agg((to_jsonb(l) - array['amount_paid','outstanding_amount','status','version','updated_at']::text[])::text, '|' order by l.id)
                        from payroll_entries l where l.payroll_period_id = ${periodId}::uuid), '')) as d`.execute(db)
      ).rows[0]!.d;

    for (const [n, name, partial] of [[16, "approved period forgot its payment", false], [17, "partial payment forgotten", true], [18, "full payment forgotten", false]] as const) {
      it(`${n}: ${name} -> READY -> rebuilt from the active allocations only (payment, allocation, cash, journal, obligation untouched)`, async () => {
        const fixture = await payrollFixture();
        const periodId = await approvedPeriod(fixture);
        await pay(fixture, periodId, partial);
        const truth = await preview(fixture, periodId);
        await forgetPayments(periodId);
        expect(await codesOf(fixture, periodId)).toEqual([["PAYROLL_PAYMENT_STATE_INCONSISTENT", "READY"]]);
        const before = await history(fixture.companyId, periodId);
        await runPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT"));
        expect(await history(fixture.companyId, periodId)).toBe(before);
        const after = await expectParity(fixture, periodId, name);
        expect(after.period.status).toBe(partial ? "partially_paid" : "paid");
        expect(after.lines.map((line) => line.current)).toEqual(truth.lines.map((line) => line.current));
        expect(after.period.totals).toEqual(truth.period.totals);
      });
    }

    it("19: allocation inconsistencies (reversed payment still allocated / overpaid line / wrong employee) -> MANUAL_REVIEW, never reconciled", async () => {
      const variants: [string, (fixture: PayrollFixture, periodId: string, paymentId: string) => Promise<void>][] = [
        ["active allocation on a reversed payment", async (fixture, _p, paymentId) =>
          crafted(sql`update payroll_payments set status = 'reversed', reversed_at = now(), reversed_by_account_id = ${fixture.actorId}::uuid,
              reversal_reason = 'Crafted' where id = ${paymentId}::uuid`)],
        ["allocation larger than the line", async (_f, _p, paymentId) =>
          crafted(sql`update payroll_payment_allocations set allocated_amount = allocated_amount + 5000
              where id = (select id from payroll_payment_allocations where payroll_payment_id = ${paymentId}::uuid order by id limit 1)`)],
        ["allocation for another employee", async (fixture, _p, paymentId) =>
          crafted(sql`update payroll_payment_allocations set employee_id = ${fixture.employees[1]!}::uuid
              where id = (select a.id from payroll_payment_allocations a join payroll_entries l on l.id = a.payroll_line_id
                           where a.payroll_payment_id = ${paymentId}::uuid and l.employee_id = ${fixture.employees[0]!}::uuid)`)],
      ];
      for (const [name, mutate] of variants) {
        const fixture = await payrollFixture();
        const periodId = await approvedPeriod(fixture);
        const paymentId = await pay(fixture, periodId);
        await mutate(fixture, periodId, paymentId);
        const view = await preview(fixture, periodId);
        expect(view.findings.map((f) => f.reasonCode), name).toContain("PAYROLL_PAYMENT_ALLOCATION_INCONSISTENT");
        expect(view.findings.every((f) => f.repairability !== "READY"), name).toBe(true);
        const finding = view.findings.find((f) => f.reasonCode === "PAYROLL_PAYMENT_STATE_INCONSISTENT") ?? view.findings[0]!;
        await refusedAny(fixture, periodId, {
          capabilityCode: "RECONCILE_PAYROLL_PAYMENT_STATE",
          findingId: finding.findingId,
          idempotencyKey: `rc-pay-${randomUUID()}`,
          previewVersion: view.previewVersion,
          reason: name,
        } as RepairExecutionRequest, ["repair_not_ready", "repair_capability_not_applicable"]);
      }
    });

    it("20: the Company's payment reversal reverses allocations and recomputes paid / outstanding / status; the Platform has no reversal capability", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      const paymentId = await pay(fixture, periodId);
      await expectParity(fixture, periodId, "paid");
      await as(fixture, () => get(PayrollPaymentService).reverse(paymentId, "Paid twice by mistake", key("rev"), randomUUID()));
      const allocations = (await sql<{ reversed: boolean }>`select reversed_at is not null as reversed from payroll_payment_allocations where payroll_payment_id = ${paymentId}::uuid`.execute(db)).rows;
      expect(allocations.length).toBeGreaterThan(0);
      expect(allocations.every((row) => row.reversed)).toBe(true);
      const view = await expectParity(fixture, periodId, "after reversal");
      expect(view.period.status).toBe("approved");
      expect(view.lines.every((line) => line.current.paid === "0.00" && line.status === "approved")).toBe(true);
      expect(view.payments.every((payment) => payment.status === "reversed" && Number(payment.activeAllocated) === 0)).toBe(true);
      // The existing architecture captures the reversal event (Accounting ON); Phase 4 never recovers reversals.
      const reversal = await eventOf(fixture, "payroll_payment", paymentId, "employee_payroll_payment_reversed");
      await craftFailed(reversal);
      expect((await recovery.preview(fixture.companyId, reversal)).repairability).toBe("MANUAL_REVIEW");
      // No Platform payment reversal capability exists.
      await refusedAny(fixture, periodId, {
        capabilityCode: "REVERSE_PAYROLL_PAYMENT",
        findingId: "fnd_x",
        idempotencyKey: `rc-pay-${randomUUID()}`,
        previewVersion: view.previewVersion,
        reason: "Reverse it from the Platform",
      } as RepairExecutionRequest, ["repair_capability_not_applicable"]);
    });

    it("21: a duplicate payment is impossible (same key replays; the line cannot be overpaid)", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      const lines = await linesOf(periodId);
      const input = {
        accountId: fixture.cashAccountId,
        acknowledgementType: "checkbox",
        allocations: lines.map((line) => ({ amount: Number(line.outstanding), employeeId: line.employeeId, lineId: line.id })),
        cashVoucherReference: "V-DUP",
        paymentDate: today,
        periodId,
      } as never;
      const idempotency = key("dup");
      const first = (await as(fixture, () => get(PayrollPaymentService).confirm(input, idempotency, randomUUID()))) as { paymentId: string };
      expect(((await as(fixture, () => get(PayrollPaymentService).confirm(input, idempotency, randomUUID()))) as { paymentId: string }).paymentId).toBe(first.paymentId);
      await expect(as(fixture, () => get(PayrollPaymentService).confirm(input, key("dup-2"), randomUUID()))).rejects.toBeDefined();
      expect((await sql<{ n: number }>`select count(*)::int as n from payroll_payments where payroll_period_id = ${periodId}::uuid`.execute(db)).rows[0]!.n).toBe(1);
      await expectParity(fixture, periodId, "after duplicate attempts");
    });
  });

  // ===========================================================================
  // Closed Payroll: immutable, every capability refused.
  // ===========================================================================
  it("closed Payroll: amounts, totals and settlement inconsistencies are MANUAL_REVIEW; every capability refused; never reopened", async () => {
    const mutations: [string, (periodId: string) => Promise<void>][] = [
      ["line amounts", async (periodId) => crafted(sql`update payroll_entries set earning_adjustments_total = earning_adjustments_total + 1, gross_earnings = gross_earnings + 1,
          net_salary = net_salary + 1, amount_paid = amount_paid + 1 where id = (select id from payroll_entries where payroll_period_id = ${periodId}::uuid order by id limit 1)`)],
      ["header totals", async (periodId) => crafted(sql`update payroll_periods set total_basic_salary = total_basic_salary + 1 where id = ${periodId}::uuid`)],
      ["settlement state", async (periodId) => crafted(sql`update payroll_entries set amount_paid = 0, outstanding_amount = net_salary, status = 'approved' where payroll_period_id = ${periodId}::uuid`)],
    ];
    for (const [name, mutate] of mutations) {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await pay(fixture, periodId);
      await as(fixture, () => get(PayrollPeriodService).close(periodId, key("close"), randomUUID()));
      await mutate(periodId);
      const view = await preview(fixture, periodId);
      expect(view.findings.length, name).toBeGreaterThan(0);
      expect(view.findings.every((f) => f.repairability === "MANUAL_REVIEW" && !f.execution.available), name).toBe(true);
      for (const capability of ["REPAIR_PAYROLL_LINE_AMOUNTS", "REBUILD_PAYROLL_PERIOD_TOTALS", "RECONCILE_PAYROLL_PAYMENT_STATE"]) {
        await refusedAny(fixture, periodId, {
          capabilityCode: capability,
          findingId: view.findings[0]!.findingId,
          idempotencyKey: `rc-pay-${randomUUID()}`,
          previewVersion: view.previewVersion,
          reason: name,
        } as RepairExecutionRequest, ["repair_capability_not_applicable", "repair_not_ready"]);
      }
      expect((await periodRow(periodId)).status, name).toBe("closed");
    }
  });

  // ===========================================================================
  // 22-28: historical truth -- configuration changes never reinterpret history.
  // ===========================================================================
  describe("historical truth (22-28)", () => {
    it("22-27: salary, salary version, incentive rule, deduction source, employee, role and driver changes after approval leave Payroll HEALTHY and unchanged", async () => {
      const fixture = await payrollFixture();
      // A delivered-order incentive snapshotted into the line at calculation.
      const ruleId = randomUUID();
      await sql`insert into employee_delivery_earning_rules(id, company_id, employee_id, amount_per_order, effective_from, created_by_account_id)
        values (${ruleId}::uuid, ${fixture.companyId}::uuid, ${fixture.employees[0]!}::uuid, 12, '2026-01-01'::date, ${fixture.actorId}::uuid)`.execute(db);
      const orderId = await deliveredOrder(fixture, 0, "customer_pays_cod_trader_pays_fee");
      await sql`insert into employee_order_earnings(company_id, employee_id, order_id, rule_id, order_number, delivered_at, applied_amount, earning_month)
        values (${fixture.companyId}::uuid, ${fixture.employees[0]!}::uuid, ${orderId}::uuid, ${ruleId}::uuid, ${await orderNumber(orderId)}, now(), 12,
                date_trunc('month', current_date)::date)`.execute(db);
      const periodId = await calculatedPeriod(fixture);
      const line = await lineOf(periodId, fixture.employees[0]!);
      const adjustments = get(PayrollAdjustmentService);
      await as(fixture, () => adjustments.create(line.id, { adjustmentType: "bonus", amount: 100, direction: "earning", reason: "Bonus" } as never, key("bonus"), randomUUID()));
      await as(fixture, () => adjustments.create(line.id, { adjustmentType: "unpaid_leave", amount: 50, direction: "deduction", reason: "Leave" } as never, key("leave"), randomUUID()));
      await as(fixture, () => get(PayrollPeriodService).approve(periodId, key("approve"), randomUUID()));
      await pay(fixture, periodId, true);
      const before = await expectParity(fixture, periodId, "approved with incentives");
      const incentive = before.lines.find((row) => row.lineId === line.id)!;
      expect(incentive.components).toMatchObject({ activeDeductionAdjustments: "50.00", activeEarningAdjustments: "100.00", deliveredOrderEarnings: "12.00" });
      // 22 salary changed + a new salary version.
      await crafted(sql`update employee_salary_versions set basic_salary = 9999 where employee_id = ${fixture.employees[0]!}::uuid`);
      await crafted(sql`update employee_salary_versions set effective_to = current_date where employee_id = ${fixture.employees[1]!}::uuid`);
      await sql`insert into employee_salary_versions(company_id, employee_id, basic_salary, effective_from, created_by_account_id)
        values (${fixture.companyId}::uuid, ${fixture.employees[1]!}::uuid, 4321, current_date + 1, ${fixture.actorId}::uuid)`.execute(db).catch(() => undefined);
      // 23 incentive rule changed (rate, deactivation, a new rule).
      await crafted(sql`update employee_delivery_earning_rules set amount_per_order = 99, is_active = false where id = ${ruleId}::uuid`);
      // 24 deduction source changed: the approved adjustment cannot be edited; the Company is refused.
      await expect(as(fixture, () => adjustments.create(line.id, { adjustmentType: "penalty", amount: 5, direction: "deduction", reason: "Late" } as never, key("late"), randomUUID()))).rejects.toBeDefined();
      // 25 employee deactivated, 26 role changed, 27 driver relationship changed.
      const roleId = randomUUID();
      await sql`insert into employee_roles(id, company_id, code, name_en) values (${roleId}::uuid, ${fixture.companyId}::uuid, ${`SUP_${roleId.slice(0, 6).toUpperCase()}`}, 'Supervisor')`.execute(db);
      await crafted(sql`update employees set is_active = false, deactivated_at = now(), employee_role_id = ${roleId}::uuid where id = ${fixture.employees[0]!}::uuid`);
      await crafted(sql`update drivers set deactivated_at = now() where company_id = ${fixture.companyId}::uuid`);
      const after = await expectParity(fixture, periodId, "after configuration changes");
      expect(after.lines.map((row) => ({ components: row.components, current: row.current }))).toEqual(
        before.lines.map((row) => ({ components: row.components, current: row.current })),
      );
      expect(after.period.totals).toEqual(before.period.totals);
      expect(after.lines.find((row) => row.lineId === line.id)!.employeeActive).toBe(false);
      // A READY reconcile still verifies: workforce state is not a financial dependency of the amounts.
      await forgetPayments(periodId);
      await runPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT"));
      const final = await expectParity(fixture, periodId, "after reconcile");
      expect(final.lines.map((row) => row.current)).toEqual(before.lines.map((row) => row.current));
    });

    it("28: a legacy line with insufficient snapshots -> REVIEW / MANUAL_REVIEW, never recomputed", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      const line = await lineOf(periodId, fixture.employees[0]!);
      await crafted(sql`update payroll_entries set source_marker = 'legacy', earning_adjustments_total = 7,
          basic_salary_snapshot = basic_salary_snapshot - 7 where id = ${line.id}::uuid`);
      await crafted(sql`update payroll_periods set total_basic_salary = total_basic_salary - 7,
          total_earning_adjustments = total_earning_adjustments + 7 where id = ${periodId}::uuid`);
      const view = await preview(fixture, periodId);
      expect(view.findings.map((f) => [f.reasonCode, f.health, f.repairability])).toEqual([["PAYROLL_LEGACY_HISTORY_REVIEW", "REVIEW", "MANUAL_REVIEW"]]);
      expect(view.findings[0]!.whyNotAutomatic).toMatch(/Legacy/u);
      await refusedAny(fixture, periodId, { ...(await payrollRequest(fixture, periodId, "PAYROLL_LEGACY_HISTORY_REVIEW")), capabilityCode: "REPAIR_PAYROLL_LINE_AMOUNTS" }, ["repair_capability_not_applicable"]);
    });
  });

  // ===========================================================================
  // 29-30: driver fees -- MANUAL_REVIEW only, no capability.
  // ===========================================================================
  it("29 + 30: a consistent driver fee is HEALTHY; inconsistent ones are MANUAL_REVIEW with no Payroll execution path", async () => {
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
    await accrual("2026-07-15", 0, "accrued");
    expect(await payrollHealth().summary(fixture.companyId)).toMatchObject({ driverFeeFindings: 0, payrollHealth: "HEALTHY" });
    const broken = await accrual("2026-01-15", 2, "partially_paid");
    const summary = await payrollHealth().summary(fixture.companyId);
    expect(summary).toMatchObject({ byCode: { DRIVER_FEE_PAYMENT_STATE_INCONSISTENT: 1, DRIVER_FEE_RATE_OUTSIDE_VERSION: 1 }, payrollHealth: "ISSUE" });
    const before = await footprint(fixture.companyId);
    // No capability addresses a driver fee: the Payroll route only knows Payroll periods.
    await expect(preview(fixture, broken)).rejects.toMatchObject({ errorCode: "payroll_period_not_found" });
    await expect(runPayroll(fixture, broken, {
      capabilityCode: "RECONCILE_PAYROLL_PAYMENT_STATE",
      findingId: "fnd_fee",
      idempotencyKey: `rc-pay-${randomUUID()}`,
      previewVersion: `prv1:${"0".repeat(64)}`,
      reason: "Fix the fee",
    } as RepairExecutionRequest)).rejects.toMatchObject({ errorCode: "payroll_period_not_found" });
    expect(await footprint(fixture.companyId)).toBe(before);
  });

  // ===========================================================================
  // 31-43: Payroll accounting -- OFF, ON E2E, missing, mode transitions, fiscal period.
  // ===========================================================================
  describe("Payroll accounting (31-43)", () => {
    it("31 + 32: Accounting OFF -- approval and payment need no event; repair works; Accounting is never enabled", async () => {
      const fixture = await payrollFixture("off");
      const periodId = await approvedPeriod(fixture);
      expect(await expectParity(fixture, periodId, "OFF approval")).toMatchObject({ accounting: { enabled: false, events: [] } });
      await pay(fixture, periodId);
      await expectParity(fixture, periodId, "OFF payment");
      await forgetPayments(periodId);
      await runPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT"));
      await expectParity(fixture, periodId, "OFF repaired");
      const mode = (await sql<{ on: boolean; n: number }>`select c.accounting_enabled as on,
          (select count(*)::int from accounting_events e where e.company_id = c.company_id) as n
        from accounting_configurations c where c.company_id = ${fixture.companyId}::uuid`.execute(db)).rows[0];
      expect(mode === undefined || mode.on === false).toBe(true);
      expect((await health.summary(fixture.companyId)).missingRequiredEvents.total).toBe(0);
    });

    for (const kind of ["approval", "payment"] as const) {
      it(`${kind === "approval" ? 33 : 34}: Accounting ON ${kind} event failed -> Preview (fiscal, mapping, original actor, source) -> one balanced journal on the right source -> both healths resolve -> idempotent`, async () => {
        const fixture = await payrollFixture();
        const periodId = await approvedPeriod(fixture);
        const paymentId = await pay(fixture, periodId);
        const [sourceType, sourceId, eventType] =
          kind === "approval"
            ? (["payroll_period", periodId, "employee_payroll_approved"] as const)
            : (["payroll_payment", paymentId, "employee_payroll_paid"] as const);
        const eventId = await eventOf(fixture, sourceType, sourceId, eventType);
        await craftFailed(eventId);
        expect(await codesOf(fixture, periodId)).toEqual([["PAYROLL_ACCOUNTING_EVENT_FAILED", "READY"]]);
        const accounting = await recovery.preview(fixture.companyId, eventId);
        expect(accounting.repairability).toBe("READY");
        expect(accounting.recovery).toMatchObject({
          fiscalPeriod: { status: "open" },
          mappings: { state: "RESOLVED" },
          originalActor: { state: "VALID" },
          source: { state: "PRESENT" },
        });
        const request = await requestFor(fixture, eventId);
        const result = await run(fixture, eventId, request);
        expect(result).toMatchObject({ afterClassification: "posted", replayed: false, status: "succeeded" });
        const journals = (await sql<{ id: string; sourceType: string; sourceId: string; creator: string; debit: string; credit: string; status: string }>`
          select j.id, j.source_entity_type as "sourceType", j.source_entity_id::text as "sourceId", j.created_by_account_id::text as creator, j.status,
                 (select sum(debit)::text from journal_lines l where l.journal_entry_id = j.id) as debit,
                 (select sum(credit)::text from journal_lines l where l.journal_entry_id = j.id) as credit
            from journal_entries j where j.accounting_event_id = ${eventId}::uuid`.execute(db)).rows;
        expect(journals).toHaveLength(1);
        expect(journals[0]).toMatchObject({ sourceId, sourceType, status: "posted" });
        expect(journals[0]!.debit).toBe(journals[0]!.credit);
        expect(Number(journals[0]!.debit)).toBeGreaterThan(0);
        // Never a Platform / System actor on the Company's books.
        expect(journals[0]!.creator).not.toBe(adminId);
        expect((await sql<{ kind: string }>`select account_kind as kind from accounts where id = ${journals[0]!.creator}::uuid`.execute(db)).rows[0]!.kind).toBe("company_user");
        // Idempotent: replay, then a fresh key after recovery -> no second journal.
        expect(await run(fixture, eventId, request)).toEqual({ ...result, replayed: true });
        await expect(run(fixture, eventId, { ...request, idempotencyKey: `rc-acc-${randomUUID()}` })).rejects.toBeDefined();
        expect(await journalsFor(eventId)).toHaveLength(1);
        expect((await preview(fixture, periodId)).findings).toEqual([]);
        expect(await payrollHealth().summary(fixture.companyId)).toMatchObject({ payrollHealth: "HEALTHY" });
        expect(await health.summary(fixture.companyId)).toMatchObject({ failed: 0, integrity: { total: 0 }, missingRequiredEvents: { total: 0 } });
      });
    }

    for (const kind of ["approval", "payment"] as const) {
      it(`${kind === "approval" ? 35 : 36}: missing ${kind} event while ON -> MANUAL_REVIEW in both healths, no Execute anywhere, zero mutation`, async () => {
        const fixture = await payrollFixture();
        const periodId = await approvedPeriod(fixture);
        const paymentId = await pay(fixture, periodId);
        const sourceId = kind === "approval" ? periodId : paymentId;
        await crafted(sql`delete from accounting_events where company_id = ${fixture.companyId}::uuid and source_entity_id = ${sourceId}::uuid`);
        const view = await preview(fixture, periodId);
        expect(view.findings.map((f) => [f.reasonCode, f.repairability, f.repairCapability, f.execution.available])).toEqual([
          ["PAYROLL_ACCOUNTING_EVENT_MISSING", "MANUAL_REVIEW", null, false],
        ]);
        const missing = (await health.integrityFindings(fixture.companyId, { kind: "MISSING_REQUIRED_EVENT" })).items;
        expect(missing.map((row) => [row.eventType, row.sourceId])).toEqual([[kind === "approval" ? "employee_payroll_approved" : "employee_payroll_paid", sourceId]]);
        expect(missing[0]).toMatchObject({ certifiedCapture: null, repairability: "MANUAL_REVIEW" });
        for (const capability of ["REPAIR_PAYROLL_LINE_AMOUNTS", "RECONCILE_PAYROLL_PAYMENT_STATE", "REPROCESS_ACCOUNTING_EVENT"]) {
          await refusedAny(fixture, periodId, {
            capabilityCode: capability,
            findingId: view.findings[0]!.findingId,
            idempotencyKey: `rc-pay-${randomUUID()}`,
            previewVersion: view.previewVersion,
            reason: "Capture it",
          } as RepairExecutionRequest, ["repair_capability_not_applicable"]);
        }
        expect((await sql<{ n: number }>`select count(*)::int as n from accounting_events where company_id = ${fixture.companyId}::uuid and source_entity_id = ${sourceId}::uuid`.execute(db)).rows[0]!.n).toBe(0);
      });
    }

    describe("37-40: Accounting mode timeline (the Phase 4 authoritative rule)", () => {
      /** Replace the Company's mode history with snapshots at offsets from `base` (crafted). */
      async function timeline(fixture: PayrollFixture, base: string, snapshots: readonly (readonly [string, boolean])[], current: boolean) {
        await crafted(sql`delete from accounting_configuration_history where company_id = ${fixture.companyId}::uuid`);
        let version = 0;
        for (const [offset, enabled] of snapshots) {
          version += 1;
          await crafted(sql`insert into accounting_configuration_history(company_id, configuration_version, configuration_snapshot, created_at)
            values (${fixture.companyId}::uuid, ${version}, ${JSON.stringify({ accounting_enabled: enabled })}::jsonb,
                    ${base}::timestamptz + ${offset}::interval)`);
        }
        await crafted(sql`update accounting_configurations
            set accounting_enabled = ${current}, automatic_posting_enabled = ${current},
                automatic_posting_enabled_by_account_id = case when ${current} then ${fixture.actorId}::uuid end,
                automatic_posting_enabled_at = case when ${current} then now() end
          where company_id = ${fixture.companyId}::uuid`);
      }
      const cases: readonly { name: string; snapshots: readonly (readonly [string, boolean])[]; current: boolean; required: boolean }[] = [
        { current: true, name: "before enable", required: false, snapshots: [["1 second", true]] },
        { current: true, name: "37 at the enable boundary (inclusive)", required: true, snapshots: [["0 seconds", true]] },
        { current: true, name: "during ON", required: true, snapshots: [["-1 day", true]] },
        { current: false, name: "38 at the disable boundary (exclusive)", required: false, snapshots: [["-1 day", true], ["0 seconds", false]] },
        { current: false, name: "ON interval closed later", required: true, snapshots: [["-1 day", true], ["1 second", false]] },
        { current: true, name: "39 inside an OFF interval", required: false, snapshots: [["-2 days", true], ["-1 day", false], ["1 second", true]] },
        { current: true, name: "40 after re-enable", required: true, snapshots: [["-2 days", true], ["-1 day", false], ["-1 second", true]] },
      ];
      for (const kind of ["approval", "payment"] as const) {
        it(`${kind}: only operations inside an ON interval require the event (Payroll Health == Accounting Health)`, async () => {
          const fixture = await payrollFixture();
          const periodId = await approvedPeriod(fixture);
          const paymentId = await pay(fixture, periodId);
          const sourceId = kind === "approval" ? periodId : paymentId;
          const base = (
            await sql<{ at: string }>`select to_char(${kind === "approval"
              ? sql`(select approved_at from payroll_periods where id = ${periodId}::uuid)`
              : sql`(select created_at from payroll_payments where id = ${paymentId}::uuid)`} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`.execute(db)
          ).rows[0]!.at;
          await crafted(sql`delete from accounting_events where company_id = ${fixture.companyId}::uuid and source_entity_id = ${sourceId}::uuid`);
          for (const item of cases) {
            await timeline(fixture, base, item.snapshots, item.current);
            const codes = (await codesOf(fixture, periodId)).map(([code]) => code);
            expect(codes.includes("PAYROLL_ACCOUNTING_EVENT_MISSING"), `${kind}: ${item.name}`).toBe(item.required);
            const missing = (await health.integrityFindings(fixture.companyId, { kind: "MISSING_REQUIRED_EVENT" })).items;
            expect(missing.some((row) => row.sourceId === sourceId), `${kind} (Accounting Health): ${item.name}`).toBe(item.required);
          }
          // Repair Center never enables Accounting.
          expect((await sql<{ on: boolean }>`select accounting_enabled as on from accounting_configurations where company_id = ${fixture.companyId}::uuid`.execute(db)).rows[0]!.on).toBe(true);
        });
      }
    });

    it("41-43: fiscal period open -> READY; closed -> BLOCKED; missing -> BLOCKED (never reopened); Payroll period untouched", async () => {
      const outcomes: [string, ((fixture: PayrollFixture) => Promise<void>) | undefined, string][] = [
        ["41 open", undefined, "READY"],
        ["42 closed", async (fixture) => crafted(sql`update accounting_periods set status = 'closed', closed_at = now(),
            closed_by_account_id = ${fixture.actorId}::uuid, close_reason = 'Crafted close'
          where company_id = ${fixture.companyId}::uuid and current_date between period_start and period_end`), "BLOCKED"],
        ["43 missing", async (fixture) => crafted(sql`delete from accounting_periods
          where company_id = ${fixture.companyId}::uuid and current_date between period_start and period_end`), "BLOCKED"],
      ];
      for (const [name, mutate, expected] of outcomes) {
        for (const kind of ["approval", "payment"] as const) {
          const fixture = await payrollFixture();
          const periodId = await approvedPeriod(fixture);
          const paymentId = await pay(fixture, periodId);
          const eventId = kind === "approval"
            ? await eventOf(fixture, "payroll_period", periodId, "employee_payroll_approved")
            : await eventOf(fixture, "payroll_payment", paymentId, "employee_payroll_paid");
          await craftFailed(eventId);
          if (mutate !== undefined) await mutate(fixture);
          const accounting = await recovery.preview(fixture.companyId, eventId);
          expect(accounting.repairability, `${name} ${kind}`).toBe(expected);
          expect((await codesOf(fixture, periodId)), `${name} ${kind}`).toEqual([["PAYROLL_ACCOUNTING_EVENT_FAILED", expected]]);
          if (expected === "BLOCKED") {
            expect(accounting.blockers.map((b) => b.code).join(" "), `${name} ${kind}`).toMatch(/period/u);
            await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_not_ready");
            const fiscal = (await sql<{ status: string }>`select status from accounting_periods
              where company_id = ${fixture.companyId}::uuid and current_date between period_start and period_end`.execute(db)).rows;
            expect(fiscal.every((row) => row.status === "closed"), `${name} ${kind}: never reopened`).toBe(true);
          } else {
            await recoverAndProve(fixture, eventId);
          }
          expect((await periodRow(periodId)).status, `${name} ${kind}: the Payroll period is a separate concept`).toBe("paid");
        }
      }
    });
  });

  // ===========================================================================
  // 44-51: stale preview, one dimension at a time.
  // ===========================================================================
  describe("stale preview (44-51)", () => {
    const payrollDimensions: readonly [string, (fixture: PayrollFixture, periodId: string, paymentId: string) => Promise<void>][] = [
      ["44 Payroll line", async (_f, periodId) => crafted(sql`update payroll_entries set notes = 'changed' where id = (select id from payroll_entries where payroll_period_id = ${periodId}::uuid order by id limit 1)`)],
      ["45 Payroll period", async (_f, periodId) => crafted(sql`update payroll_periods set notes = 'changed' where id = ${periodId}::uuid`)],
      ["46 component", async (fixture, periodId) => crafted(sql`insert into payroll_line_allowances(company_id, payroll_line_id, allowance_code_snapshot, allowance_name_snapshot, amount)
          select ${fixture.companyId}::uuid, id, 'HOUSING', 'Housing', 10 from payroll_entries where payroll_period_id = ${periodId}::uuid order by id limit 1`)],
      ["47 adjustment", async (fixture, periodId) => {
        const line = await lineOf(periodId, fixture.employees[0]!);
        await craftAdjustment(fixture, periodId, line.id, fixture.employees[0]!, "earning", 10);
      }],
      ["48 payment allocation", async (_f, _p, paymentId) => crafted(sql`update payroll_payment_allocations set reversed_at = now()
          where id = (select id from payroll_payment_allocations where payroll_payment_id = ${paymentId}::uuid order by id limit 1)`)],
      ["49 payment", async (_f, _p, paymentId) => crafted(sql`update payroll_payments set version = version + 1 where id = ${paymentId}::uuid`)],
      ["employee historical dependency", async (fixture) => crafted(sql`update employees set is_active = false where id = ${fixture.employees[0]!}::uuid`)],
      ["50 accounting event", async (_f, periodId) => crafted(sql`update accounting_events set attempt_count = attempt_count + 1 where source_entity_id = ${periodId}::uuid`)],
      ["accounting mode", async (fixture) => crafted(sql`update accounting_configurations set version = version + 1 where company_id = ${fixture.companyId}::uuid`)],
    ];
    for (const [name, mutate] of payrollDimensions) {
      it(`${name} changed after a READY Payroll preview -> 409 repair_preview_stale, zero mutation, durable REFUSED`, async () => {
        const { fixture, paymentId, periodId } = await forgotPaid();
        const request = await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT");
        await mutate(fixture, periodId, paymentId);
        await refusedPayroll(fixture, periodId, request, "repair_preview_stale");
        expect(await payrollAttempts(fixture.companyId, periodId)).toEqual([["REFUSED", "repair_preview_stale"]]);
      });
    }

    const accountingDimensions: readonly [string, (fixture: PayrollFixture, eventId: string) => Promise<void>, readonly string[]][] = [
      ["51 journal", async (fixture, eventId) => crafted(sql`insert into journal_entries (id, company_id, journal_number, accounting_period_id, fiscal_year_id, business_date,
            journal_type, source_type, description, status, accounting_event_id, created_by_account_id)
          select gen_random_uuid(), ${fixture.companyId}::uuid, 'JV-STALE-' || substr(md5(random()::text), 1, 6), p.id, p.fiscal_year_id,
                 current_date, 'operational', 'payroll', 'Crafted journal', 'draft', ${eventId}::uuid, ${fixture.actorId}::uuid
            from accounting_periods p where p.company_id = ${fixture.companyId}::uuid and current_date between p.period_start and p.period_end`),
        ["repair_preview_stale", "repair_capability_not_applicable", "repair_finding_not_current"]],
      ["51 mapping", async (fixture) => crafted(sql`update account_mappings set effective_from = effective_from - 1
          where id = (select id from account_mappings where company_id = ${fixture.companyId}::uuid order by id limit 1)`), ["repair_preview_stale"]],
      ["fiscal period", async (fixture) => crafted(sql`update accounting_periods set version = version + 1
          where company_id = ${fixture.companyId}::uuid and current_date between period_start and period_end`), ["repair_preview_stale"]],
      ["accounting mode", async (fixture) => crafted(sql`update accounting_configurations set version = version + 1 where company_id = ${fixture.companyId}::uuid`), ["repair_preview_stale"]],
    ];
    for (const [name, mutate, codes] of accountingDimensions) {
      it(`${name} changed after a READY Payroll accounting preview -> refused, zero mutation`, async () => {
        const fixture = await payrollFixture();
        const periodId = await approvedPeriod(fixture);
        const eventId = await eventOf(fixture, "payroll_period", periodId, "employee_payroll_approved");
        await craftFailed(eventId);
        const request = await requestFor(fixture, eventId);
        await mutate(fixture, eventId);
        const before = await footprint(fixture.companyId);
        const error = await run(fixture, eventId, request).then(() => undefined, (failure: unknown) => failure as ApplicationException);
        expect(codes).toContain(error?.errorCode);
        expect(await footprint(fixture.companyId)).toBe(before);
      });
    }
  });

  // ===========================================================================
  // 52-58: atomicity and idempotency, per capability.
  // ===========================================================================
  const capabilitySetups: readonly {
    readonly code: string;
    readonly capability: string;
    readonly setup: () => Promise<{ fixture: PayrollFixture; periodId: string }>;
  }[] = [
    {
      capability: "REPAIR_PAYROLL_LINE_AMOUNTS",
      code: "PAYROLL_LINE_AMOUNTS_INCONSISTENT",
      setup: async () => {
        const fixture = await payrollFixture();
        const periodId = await calculatedPeriod(fixture);
        for (const employeeId of fixture.employees) await driftLine((await lineOf(periodId, employeeId)).id, 300);
        return { fixture, periodId };
      },
    },
    {
      capability: "REBUILD_PAYROLL_PERIOD_TOTALS",
      code: "PAYROLL_PERIOD_TOTALS_MISMATCH",
      setup: async () => {
        const fixture = await payrollFixture();
        const periodId = await calculatedPeriod(fixture);
        await sql`update payroll_periods set total_net_salary = 1, total_outstanding = 1 where id = ${periodId}::uuid`.execute(db);
        return { fixture, periodId };
      },
    },
    {
      capability: "RECONCILE_PAYROLL_PAYMENT_STATE",
      code: "PAYROLL_PAYMENT_STATE_INCONSISTENT",
      setup: async () => {
        const { fixture, periodId } = await forgotPaid();
        return { fixture, periodId };
      },
    },
  ];

  describe("atomicity (52-54)", () => {
    for (const [index, item] of capabilitySetups.entries()) {
      it(`${52 + index}: ${item.capability} -- a failure AFTER the mutation, before commit, rolls everything back; durable FAILED; the retry succeeds once`, async () => {
        const { fixture, periodId } = await item.setup();
        const request = await payrollRequest(fixture, periodId, item.code);
        const before = await footprint(fixture.companyId);
        const payrollDigest = async (database: Kysely<DatabaseSchema>) =>
          (
            await sql<{ d: string }>`select md5(coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from payroll_entries x where x.payroll_period_id = ${periodId}::uuid), '')
                || (select to_jsonb(p)::text from payroll_periods p where p.id = ${periodId}::uuid)) as d`.execute(database)
          ).rows[0]!.d;
        const outside = await payrollDigest(db);
        const service = payrollRepairs() as unknown as { apply: (...args: unknown[]) => Promise<void> };
        const original = service.apply.bind(service);
        let inside: string | undefined;
        vi.spyOn(service, "apply").mockImplementationOnce(async (...args: unknown[]) => {
          await original(...args);
          inside = await payrollDigest(args[0] as Kysely<DatabaseSchema>);
          throw new Error("injected failure after the Payroll mutation");
        });
        await expect(runPayroll(fixture, periodId, request)).rejects.toThrow(/injected failure/u);
        expect(inside, "the mutation really happened inside the transaction").toBeDefined();
        expect(inside).not.toBe(outside);
        expect(await payrollDigest(db), "no partial Payroll change survives").toBe(outside);
        expect(await footprint(fixture.companyId)).toBe(before);
        expect(await payrollAttempts(fixture.companyId, periodId)).toEqual([["FAILED", "repair_execution_failed"]]);
        expect(await payrollAudits(fixture.companyId, periodId)).toEqual([]);
        expect(await runPayroll(fixture, periodId, request)).toMatchObject({ replayed: false, status: "succeeded" });
        expect(await payrollAudits(fixture.companyId, periodId)).toHaveLength(1);
      });
    }
  });

  describe("idempotency (55-58)", () => {
    for (const [index, item] of capabilitySetups.entries()) {
      it(`${55 + index}: ${item.capability} -- same request replays; same key + different request refused (58); a new key after resolution mutates nothing`, async () => {
        const { fixture, periodId } = await item.setup();
        const request = await payrollRequest(fixture, periodId, item.code);
        const first = await runPayroll(fixture, periodId, request);
        const resolved = await footprint(fixture.companyId);
        expect(await runPayroll(fixture, periodId, request)).toEqual({ ...first, replayed: true });
        await refusedPayroll(fixture, periodId, { ...request, reason: "A different reason" }, "repair_idempotency_conflict");
        await refusedPayroll(fixture, periodId, { ...request, idempotencyKey: `rc-pay-${randomUUID()}` }, "repair_finding_not_current");
        expect(await payrollAudits(fixture.companyId, periodId)).toHaveLength(1);
        expect((await payrollAttempts(fixture.companyId, periodId)).map(([result, code]) => `${result}:${code ?? "-"}`)).toEqual([
          "REPLAYED:-",
          "REFUSED:repair_idempotency_conflict",
          "REFUSED:repair_finding_not_current",
        ]);
        // Only the attempt log grew since the success.
        void resolved;
      });
    }
  });

  // ===========================================================================
  // 59-64: concurrency -- exactly one correct final state.
  // ===========================================================================
  describe("concurrency (59-64)", () => {
    it("59: two Platform line repairs of one period -> exactly one succeeds", async () => {
      const { fixture, periodId } = await capabilitySetups[0]!.setup();
      const request = await payrollRequest(fixture, periodId, "PAYROLL_LINE_AMOUNTS_INCONSISTENT");
      const results = await Promise.allSettled([
        runPayroll(fixture, periodId, request),
        runPayroll(fixture, periodId, { ...request, idempotencyKey: `rc-pay-${randomUUID()}` }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((x) => x.status === "rejected")) {
        expect(["repair_finding_not_current", "repair_preview_stale"]).toContain(((r as PromiseRejectedResult).reason as ApplicationException).errorCode);
      }
      expect(await payrollAudits(fixture.companyId, periodId)).toHaveLength(1);
      await expectParity(fixture, periodId, "59");
    });

    it("60: line repair vs the Company's Recalculate -> one consistent result", async () => {
      const { fixture, periodId } = await capabilitySetups[0]!.setup();
      const request = await payrollRequest(fixture, periodId, "PAYROLL_LINE_AMOUNTS_INCONSISTENT");
      await Promise.allSettled([
        runPayroll(fixture, periodId, request),
        as(fixture, () => get(PayrollCalculationService).recalculate(periodId, key("recalc"), randomUUID(), true)),
      ]);
      await expectParity(fixture, periodId, "60");
      expect(await linesOf(periodId)).toHaveLength(2);
      expect((await periodRow(periodId)).net).toBe("3000.00");
    });

    it("61: totals rebuild vs the Company's Recalculate -> one consistent result", async () => {
      const { fixture, periodId } = await capabilitySetups[1]!.setup();
      const request = await payrollRequest(fixture, periodId, "PAYROLL_PERIOD_TOTALS_MISMATCH");
      await Promise.allSettled([
        runPayroll(fixture, periodId, request),
        as(fixture, () => get(PayrollCalculationService).recalculate(periodId, key("recalc"), randomUUID(), true)),
      ]);
      await expectParity(fixture, periodId, "61");
      expect((await periodRow(periodId)).net).toBe("3000.00");
    });

    async function settleRace(fixture: PayrollFixture, periodId: string) {
      // Whatever ran first, a fresh Verify First either is HEALTHY or offers the ONE certified reconcile.
      const codes = await codesOf(fixture, periodId);
      if (codes.length > 0) {
        expect(codes).toEqual([["PAYROLL_PAYMENT_STATE_INCONSISTENT", "READY"]]);
        await runPayroll(fixture, periodId, await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT"));
      }
      return expectParity(fixture, periodId, "after the race");
    }

    it("62: reconcile vs a Company payment confirmation -> never an overpaid line, one correct final state", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      await pay(fixture, periodId, true);
      await forgetPayments(periodId);
      const request = await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT");
      const unpaid = (await sql<{ id: string; employeeId: string; net: string }>`select l.id, l.employee_id as "employeeId", l.net_salary::text as net
          from payroll_entries l where l.payroll_period_id = ${periodId}::uuid
           and not exists (select 1 from payroll_payment_allocations a where a.payroll_line_id = l.id and a.reversed_at is null)`.execute(db)).rows;
      await Promise.allSettled([
        runPayroll(fixture, periodId, request),
        as(fixture, () => get(PayrollPaymentService).confirm({
          accountId: fixture.cashAccountId,
          acknowledgementType: "checkbox",
          allocations: unpaid.map((line) => ({ amount: Number(line.net), employeeId: line.employeeId, lineId: line.id })),
          cashVoucherReference: "V-RACE",
          paymentDate: today,
          periodId,
        } as never, key("race-pay"), randomUUID())),
      ]);
      const view = await settleRace(fixture, periodId);
      for (const line of view.lines) expect(Number(line.current.paid)).toBeLessThanOrEqual(Number(line.current.net));
      const allocated = (await sql<{ s: string }>`select coalesce(sum(a.allocated_amount), 0)::text as s from payroll_payment_allocations a
          join payroll_entries l on l.id = a.payroll_line_id where l.payroll_period_id = ${periodId}::uuid and a.reversed_at is null`.execute(db)).rows[0]!.s;
      expect(Number(view.period.totals.paid)).toBe(Number(allocated));
    });

    it("63: reconcile vs a Company payment reversal -> one correct final state (allocations are the truth)", async () => {
      const { fixture, paymentId, periodId } = await forgotPaid();
      const request = await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT");
      await Promise.allSettled([
        runPayroll(fixture, periodId, request),
        as(fixture, () => get(PayrollPaymentService).reverse(paymentId, "Race reversal", key("race-rev"), randomUUID())),
      ]);
      const view = await settleRace(fixture, periodId);
      expect(view.period.status).toBe("approved");
      expect(view.lines.every((line) => line.current.paid === "0.00")).toBe(true);
    });

    it("64: Payroll payment accounting recovery vs the worker / a Company reprocess -> exactly one journal", async () => {
      const fixture = await payrollFixture();
      const periodId = await approvedPeriod(fixture);
      const paymentId = await pay(fixture, periodId);
      const eventId = await eventOf(fixture, "payroll_payment", paymentId, "employee_payroll_paid");
      await craftFailed(eventId);
      const request = await requestFor(fixture, eventId);
      const adapter = get(PlatformAccountingRepairAdapter);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let lockedSignal!: () => void;
      const locked = new Promise<void>((resolve) => (lockedSignal = resolve));
      const worker = as(fixture, () =>
        db.transaction().execute(async (transaction) => {
          await adapter.lockEvent(transaction, fixture.companyId, eventId);
          lockedSignal();
          await gate;
          await adapter.reprocessInTransaction(transaction, { companyId: fixture.companyId, correlationId: `w-${randomUUID()}`, eventId, reason: "Company" });
        }),
      );
      await locked;
      const platform = run(fixture, eventId, request);
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      const [w, p] = await Promise.allSettled([worker, platform]);
      expect(w.status).toBe("fulfilled");
      expect(p.status).toBe("rejected");
      expect(await journalsFor(eventId)).toHaveLength(1);
      expect((await preview(fixture, periodId)).findings).toEqual([]);
    });
  });

  // ===========================================================================
  // 65: cross-company -- never read, lock, modify or disclose.
  // ===========================================================================
  it("65: Company A's repair never reads, locks, modifies or discloses Company B's Payroll", async () => {
    const a = await payrollFixture();
    const b = await forgotPaid();
    const bRequest = await payrollRequest(b.fixture, b.periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT");
    const beforeA = await footprint(a.companyId);
    const beforeB = await footprint(b.fixture.companyId);
    // B's period is held FOR UPDATE by an open transaction: A's request must not wait on it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let lockedSignal!: () => void;
    const locked = new Promise<void>((resolve) => (lockedSignal = resolve));
    const holder = db.transaction().execute(async (transaction) => {
      await sql`select id from payroll_periods where id = ${b.periodId}::uuid for update`.execute(transaction);
      lockedSignal();
      await gate;
    });
    await locked;
    const started = Date.now();
    const outcome = await Promise.race([
      runPayroll(a, b.periodId, bRequest).then(() => "succeeded", (error: unknown) => (error as ApplicationException).errorCode),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
    ]);
    release();
    await holder;
    expect(outcome).toBe("payroll_period_not_found");
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(preview(a, b.periodId)).rejects.toMatchObject({ errorCode: "payroll_period_not_found" });
    expect((await payrollHealth().list(a.companyId, { status: "all" })).items.some((row) => row.entityId === b.periodId)).toBe(false);
    expect(await payrollHealth().summary(a.companyId)).toMatchObject({ totalPeriods: 0 });
    // The identified refusal is recorded against Company A only, with no B data in it.
    const attempts = (await sql<{ company: string; number: string | null }>`select company_id::text as company, entity_number as number
        from platform_repair_attempts where entity_id = ${b.periodId}::uuid`.execute(db)).rows;
    expect(attempts).toEqual([{ company: a.companyId, number: null }]);
    expect(await footprint(a.companyId)).toBe(beforeA);
    expect(await footprint(b.fixture.companyId)).toBe(beforeB);
    // B's own repair is unaffected.
    expect(await runPayroll(b.fixture, b.periodId, bRequest)).toMatchObject({ status: "succeeded" });
  });

  // ===========================================================================
  // 66-69: audit -- SUCCEEDED / FAILED / REFUSED / REPLAYED, no impersonation.
  // ===========================================================================
  it("66-69: SUCCEEDED / FAILED / REFUSED / REPLAYED are durable, complete and carry the Platform actor only", async () => {
    const { fixture, periodId } = await forgotPaid();
    const request = await payrollRequest(fixture, periodId, "PAYROLL_PAYMENT_STATE_INCONSISTENT");
    // 68 REFUSED (stale)
    await refusedPayroll(fixture, periodId, { ...request, idempotencyKey: `rc-pay-${randomUUID()}`, previewVersion: `prv1:${"0".repeat(64)}` }, "repair_preview_stale");
    // 67 FAILED (injected)
    vi.spyOn(get(PayrollOperationalRepository), "reconcilePaymentState").mockRejectedValueOnce(new Error("injected"));
    await expect(runPayroll(fixture, periodId, { ...request, idempotencyKey: `rc-pay-${randomUUID()}` })).rejects.toThrow(/injected/u);
    // 66 SUCCEEDED, 69 REPLAYED
    const result = await runPayroll(fixture, periodId, request);
    await runPayroll(fixture, periodId, request);
    const reference = (await sql<{ r: string }>`select period_reference as r from payroll_periods where id = ${periodId}::uuid`.execute(db)).rows[0]!.r;
    const success = (await sql<Record<string, unknown>>`select company_id::text as company, actor_account_id::text as actor, actor_authority as authority,
        entity_type as "entityType", entity_id::text as entity, entity_number as reference, finding_id as finding, reason_code as "reasonCode",
        capability_code as capability, reason, result, preview_version as "previewVersion", before_state_fingerprint as "beforeFingerprint",
        after_state_fingerprint is not null as "hasAfter", created_at is not null as "hasTime", idempotency_key as "key"
      from platform_repair_executions where id = ${result.repairExecutionId}::uuid`.execute(db)).rows[0];
    expect(success).toEqual({
      actor: adminId,
      authority: "platform.companies.repair_center.execute",
      beforeFingerprint: request.previewVersion,
      capability: "RECONCILE_PAYROLL_PAYMENT_STATE",
      company: fixture.companyId,
      entity: periodId,
      entityType: "payroll_period",
      finding: request.findingId,
      hasAfter: true,
      hasTime: true,
      key: request.idempotencyKey,
      previewVersion: request.previewVersion,
      reason: request.reason,
      reasonCode: "PAYROLL_PAYMENT_STATE_INCONSISTENT",
      reference,
      result: "succeeded",
    });
    const attempts = (await sql<Record<string, unknown>>`select result, error_code as code, company_id::text as company, actor_account_id::text as actor,
        actor_authority as authority, entity_type as "entityType", entity_number as reference, capability_code as capability,
        reason is not null as "hasReason", created_at is not null as "hasTime", idempotency_key_sha256 is not null as "hashedKey",
        repair_execution_id::text as execution
      from platform_repair_attempts where entity_id = ${periodId}::uuid order by created_at, id`.execute(db)).rows;
    const common = { actor: adminId, authority: "platform.companies.repair_center.execute", capability: "RECONCILE_PAYROLL_PAYMENT_STATE",
      company: fixture.companyId, entityType: "payroll_period", hasReason: true, hasTime: true, hashedKey: true, reference };
    expect(attempts).toEqual([
      { ...common, code: "repair_preview_stale", execution: null, result: "REFUSED" },
      { ...common, code: "repair_execution_failed", execution: null, result: "FAILED" },
      { ...common, code: null, execution: result.repairExecutionId, result: "REPLAYED" },
    ]);
    // The raw idempotency key is never stored in the attempt log.
    expect(JSON.stringify(await sql`select to_jsonb(a) as row from platform_repair_attempts a where entity_id = ${periodId}::uuid`.execute(db))).not.toContain(request.idempotencyKey);
    // No impersonation: the actor is a Platform administrator; no Company-user audit was written by the repair.
    expect((await sql<{ kind: string }>`select account_kind as kind from accounts where id = ${adminId}::uuid`.execute(db)).rows[0]!.kind).toBe("platform_administrator");
  });

  // ===========================================================================
  // 70: every manual-review case is zero-mutation for every capability.
  // ===========================================================================
  it("70: manual-review cases (finalized amounts, components, allocations, closed, reversed-active, legacy, missing event) -> zero mutation for every capability", async () => {
    const cases: [string, () => Promise<{ fixture: PayrollFixture; periodId: string }>][] = [
      ["finalized amounts", async () => {
        const fixture = await payrollFixture();
        const periodId = await approvedPeriod(fixture);
        await crafted(sql`update payroll_entries set earning_adjustments_total = 1, gross_earnings = gross_earnings + 1, net_salary = net_salary + 1,
            outstanding_amount = outstanding_amount + 1 where id = (select id from payroll_entries where payroll_period_id = ${periodId}::uuid order by id limit 1)`);
        return { fixture, periodId };
      }],
      ["component ambiguity", async () => {
        const fixture = await payrollFixture();
        const periodId = await calculatedPeriod(fixture);
        await craftAdjustment(fixture, periodId, (await lineOf(periodId, fixture.employees[0]!)).id, fixture.employees[1]!, "earning", 10);
        return { fixture, periodId };
      }],
      ["allocation inconsistency", async () => {
        const fixture = await payrollFixture();
        const periodId = await approvedPeriod(fixture);
        const paymentId = await pay(fixture, periodId);
        await crafted(sql`update payroll_payments set status = 'reversed', reversed_at = now(), reversed_by_account_id = ${fixture.actorId}::uuid,
            reversal_reason = 'Crafted' where id = ${paymentId}::uuid`);
        return { fixture, periodId };
      }],
      ["closed period", async () => {
        const fixture = await payrollFixture();
        const periodId = await approvedPeriod(fixture);
        await pay(fixture, periodId);
        await as(fixture, () => get(PayrollPeriodService).close(periodId, key("close"), randomUUID()));
        await crafted(sql`update payroll_entries set amount_paid = 0, outstanding_amount = net_salary, status = 'approved' where payroll_period_id = ${periodId}::uuid`);
        return { fixture, periodId };
      }],
      ["reversed-active", async () => {
        const fixture = await payrollFixture();
        const periodId = await approvedPeriod(fixture);
        await as(fixture, () => get(PayrollPeriodService).reverse(periodId, "Wrong month", key("rev"), randomUUID()));
        await crafted(sql`update payroll_entries set status = 'approved', reversed_at = null, reversed_by_account_id = null, reversal_reason = null
            where id = (select id from payroll_entries where payroll_period_id = ${periodId}::uuid order by id limit 1)`);
        return { fixture, periodId };
      }],
      ["legacy history", async () => {
        const fixture = await payrollFixture();
        const periodId = await approvedPeriod(fixture);
        await crafted(sql`update payroll_entries set source_marker = 'legacy', earning_adjustments_total = 7, basic_salary_snapshot = basic_salary_snapshot - 7
            where id = (select id from payroll_entries where payroll_period_id = ${periodId}::uuid order by id limit 1)`);
        return { fixture, periodId };
      }],
      ["missing accounting event", async () => {
        const fixture = await payrollFixture();
        const periodId = await approvedPeriod(fixture);
        await crafted(sql`delete from accounting_events where company_id = ${fixture.companyId}::uuid and source_entity_id = ${periodId}::uuid`);
        return { fixture, periodId };
      }],
    ];
    for (const [name, setup] of cases) {
      const { fixture, periodId } = await setup();
      const view = await preview(fixture, periodId);
      expect(view.findings.length, name).toBeGreaterThan(0);
      expect(view.findings.every((f) => f.repairability !== "READY" && !f.execution.available), name).toBe(true);
      expect(view.findings.every((f) => (f.repairability === "MANUAL_REVIEW" ? typeof f.whyNotAutomatic === "string" && f.whyNotAutomatic.length > 0 : true)), name).toBe(true);
      for (const finding of view.findings) {
        for (const capability of ["REPAIR_PAYROLL_LINE_AMOUNTS", "REBUILD_PAYROLL_PERIOD_TOTALS", "RECONCILE_PAYROLL_PAYMENT_STATE"]) {
          await refusedAny(fixture, periodId, {
            capabilityCode: capability,
            findingId: finding.findingId,
            idempotencyKey: `rc-pay-${randomUUID()}`,
            previewVersion: view.previewVersion,
            reason: name,
          } as RepairExecutionRequest, ["repair_capability_not_applicable", "repair_not_ready"]);
        }
      }
      expect(await payrollAudits(fixture.companyId, periodId), name).toEqual([]);
    }
  });

  // ===========================================================================
  // 71: Data Reset compatibility (classification only; Reset is not modified).
  // ===========================================================================
  it("71: Payroll / driver-fee data is reset data; repair audit, counters and mode history are preserved", () => {
    for (const table of [
      "payroll_periods", "payroll_entries", "payroll_payments", "payroll_payment_allocations", "payroll_adjustments",
      "payroll_line_allowances", "payroll_commission_links", "payroll_calculation_exceptions",
      "outsourced_driver_fee_accruals", "outsourced_driver_fee_payments", "outsourced_driver_fee_payment_allocations",
      "employee_order_earnings", "employee_salary_versions",
    ]) {
      expect(PURGE_TABLES.has(table), table).toBe(true);
      expect(PRESERVE_TABLES.has(table), table).toBe(false);
    }
    for (const table of ["platform_repair_executions", "platform_repair_attempts", "accounting_configuration_history", "company_reference_counters", "accounts", "companies"]) {
      expect(PRESERVE_TABLES.has(table), table).toBe(true);
      expect(PURGE_TABLES.has(table), table).toBe(false);
    }
  });
});
