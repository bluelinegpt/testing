import { createHash, randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { AccountingEventRepository } from "../accounting/accounting-event.repository.js";
import { accountingEventTypes } from "../accounting/accounting.constants.js";
import { CashBankManagementService } from "../accounting/cash-bank-management.service.js";
import { OperationalJournalPostingService } from "../accounting/operational-journal-posting.service.js";
import { PlatformAccountingHealthService } from "../accounting/platform-accounting-health.service.js";
import {
  ACCOUNTING_RECOVERY_DECISIONS,
  MISSING_EVENT_DETECTED_TYPES,
  PlatformAccountingRepairAdapter,
} from "../accounting/platform-accounting-repair.adapter.js";
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

/**
 * REPAIR CENTER PHASE 4 PROMPT 1 -- ACCOUNTING HEALTH & RECOVERY COVERAGE
 * (test matrix 1-40).
 *
 * The REAL services against the disposable database (Accounting ON Companies
 * use the certified UAE_DELIVERY_STANDARD template). The background posting
 * processor is NOT running, so captured events stay `received` until a test
 * posts them through the certified claim + posting core (`postNow`, exactly
 * what the worker does) or crafts a failure exactly as the processor records
 * one. Every "crafted" statement runs with triggers bypassed, disposable DB
 * only, and stands for history the application cannot produce on its own
 * (posted-without-journal, unbalanced, mislinked, duplicated). Every refusal
 * proves zero mutation with a content checksum of every table a recovery
 * could touch.
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

describe.skipIf(!runDatabaseTests)("Repair Center Phase 4 Prompt 1 -- accounting health and recovery coverage", () => {
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

  const key = (label: string) => `rc4p1.${label}.${randomUUID()}`;

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`RC4P1-${tag}`},${`rc4p1-${tag}`},${`RC4P1 ${mode} ${tag}`},
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

  // ===========================================================================
  // Decision table (Part 18) -- pinned for EVERY declared type.
  // ===========================================================================
  it("decision table: every declared event type has exactly one audited decision", () => {
    expect(Object.keys(ACCOUNTING_RECOVERY_DECISIONS).sort()).toEqual([...accountingEventTypes].sort());
    const byDecision = (decision: string) =>
      Object.entries(ACCOUNTING_RECOVERY_DECISIONS)
        .filter(([, row]) => row.decision === decision)
        .map(([type]) => type)
        .sort();
    expect(byDecision("SUPPORTED_READY")).toEqual([
      "driver_collection_confirmed",
      // Phase 5 Prompt 1: Payroll approval and payment are certified.
      "employee_payroll_approved",
      "employee_payroll_paid",
      "order_delivered",
      "trader_receivable_payment_received",
      "trader_receivable_recognized",
      "trader_settlement_confirmed",
    ]);
    expect(byDecision("SUPPORTED_CONDITIONAL")).toEqual(["trader_credit_issued"]);
    expect(byDecision("MANUAL_REVIEW")).toEqual([
      "bank_transfer_confirmed",
      "bank_transfer_reversed",
      "driver_collection_reversed",
      "driver_expense_confirmed",
      "order_recognition_reversed",
      "trader_receivable_payment_reversed",
      "trader_receivable_reversed",
      "trader_settlement_reversed",
    ]);
    // Early payments / driver fee (Payroll approval and payment are certified
    // in Phase 5 Prompt 1); expense / cash-bank -> outside the domains.
    for (const type of byDecision("OUT_OF_SCOPE_PHASE_4")) {
      expect(type).toMatch(/^(employee_|outsourced_driver_fee_|general_expense_|cash_|bank_)/u);
    }
    expect(byDecision("OUT_OF_SCOPE_PHASE_4")).toHaveLength(39 - 7 - 1 - 8);
    expect(ACCOUNTING_RECOVERY_DECISIONS.employee_salary_advance_paid.reason).toMatch(/Phase 5/u);
    for (const row of Object.values(ACCOUNTING_RECOVERY_DECISIONS)) {
      expect(row.whenAccountingOff).toBe("NOT_REQUIRED_WHEN_ACCOUNTING_OFF");
      expect(row.reason.length).toBeGreaterThan(20);
    }
    // 36 / 37: legacy types have no producer and no forward loader.
    for (const type of ["driver_expense_confirmed", "bank_transfer_confirmed"] as const) {
      expect(ACCOUNTING_RECOVERY_DECISIONS[type]).toMatchObject({ decision: "MANUAL_REVIEW", producer: null });
      expect(ACCOUNTING_RECOVERY_DECISIONS[type].posting).toMatch(/no forward loader/u);
    }
    expect(ACCOUNTING_RECOVERY_DECISIONS.trader_credit_issued.condition).toMatch(/Settlement/u);
    expect([...MISSING_EVENT_DETECTED_TYPES].sort()).toEqual([
      "driver_collection_confirmed",
      "employee_payroll_approved",
      "employee_payroll_paid",
      "order_delivered",
      "trader_credit_issued",
      "trader_receivable_payment_received",
      "trader_receivable_recognized",
      "trader_settlement_confirmed",
    ]);
  });

  // ===========================================================================
  // 1-7, 16, 19, 27: posted / failed supported events, one per type.
  // ===========================================================================
  describe("supported events (Accounting ON, automatic posting)", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await postingFixture();
    }, 300_000);

    it("1: a healthy posted event is NOT_REQUIRED, HEALTHY, absent from integrity findings", async () => {
      const { receivableId } = await feeOrder(fixture);
      const eventId = await eventOf(fixture, "trader_receivable", receivableId, "trader_receivable_recognized");
      await postNow(fixture, eventId);
      const details = await recovery.details(fixture.companyId, eventId);
      expect(details.finding).toMatchObject({ current: false, health: "HEALTHY", repairability: "NOT_REQUIRED" });
      expect(details.recovery.existingJournals).toMatchObject({ linkedToEvent: 1, eventJournal: { balanced: true, status: "posted" } });
      expect((await integrityOf(fixture)).items.some((row) => row.eventId === eventId)).toBe(false);
    });

    it("2 + 16 + 19 + 27: failed order_delivered -> READY (open period, mappings resolved, original actor) -> one balanced journal", async () => {
      const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      const eventId = await eventOf(fixture, "order", orderId, "order_delivered");
      await craftFailed(eventId);
      await recoverAndProve(fixture, eventId);
      // 27: the Journal is attributed to the ORIGINAL operational actor, never the Platform admin.
      const creator = (
        await sql<{ created: string; posted: string }>`select created_by_account_id as created, posted_by_account_id as posted
          from journal_entries where accounting_event_id = ${eventId}::uuid`.execute(db)
      ).rows[0]!;
      expect(creator).toEqual({ created: fixture.actorId, posted: fixture.actorId });
    });

    it("3: failed trader_receivable_recognized -> READY -> one balanced journal", async () => {
      const { eventId } = await failedRecognition(fixture);
      await recoverAndProve(fixture, eventId);
    });

    it("4: failed trader_receivable_payment_received -> READY -> one balanced journal", async () => {
      const { receivableId } = await feeOrder(fixture);
      await postNow(fixture, await eventOf(fixture, "trader_receivable", receivableId, "trader_receivable_recognized"));
      const collectionId = await collect(fixture, receivableId);
      const eventId = await eventOf(fixture, "trader_collection", collectionId, "trader_receivable_payment_received");
      await craftFailed(eventId);
      await recoverAndProve(fixture, eventId);
    });

    it("5: failed trader_credit_issued -> SUPPORTED_CONDITIONAL: READY only while the Settlement's event is posted", async () => {
      const { eventId } = await creditFixture(fixture);
      await craftFailed(eventId);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview.recovery.decision).toMatchObject({ decision: "SUPPORTED_CONDITIONAL" });
      await recoverAndProve(fixture, eventId);
    });

    it("6: failed trader_settlement_confirmed -> READY -> one balanced journal", async () => {
      const { payable, settlementId } = await settle(fixture);
      await postNow(fixture, await eventOf(fixture, "order", payable, "order_delivered"));
      const eventId = await eventOf(fixture, "trader_settlement", settlementId, "trader_settlement_confirmed");
      await craftFailed(eventId);
      await recoverAndProve(fixture, eventId);
    });

    it("7: failed driver_collection_confirmed -> READY -> one balanced journal", async () => {
      const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      await postNow(fixture, await eventOf(fixture, "order", orderId, "order_delivered"));
      await reconcileCash(fixture, orderId);
      const eventId = await eventOf(fixture, "driver_reconciliation", await reconciliationOf(fixture, orderId), "driver_collection_confirmed");
      await craftFailed(eventId);
      await recoverAndProve(fixture, eventId);
    });
  });

  // ===========================================================================
  // 8-14: missing events and Journal integrity (never recovered automatically).
  // ===========================================================================
  describe("missing events and journal integrity (each on its own Company)", () => {
    it("8: missing order_delivered (Accounting ON at delivery) -> ISSUE, reconstructable, Company Historical Recovery, never Platform-executed", async () => {
      const fixture = await postingFixture();
      const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      const eventId = await eventOf(fixture, "order", orderId, "order_delivered");
      // Crafted: the capture never happened (a received event, never posted).
      await crafted(sql`delete from accounting_events where id = ${eventId}::uuid`);
      const summary = await health.summary(fixture.companyId);
      expect(summary.accountingHealth).toBe("ISSUE");
      expect(summary.missingRequiredEvents).toEqual({ byEventType: [{ eventType: "order_delivered", missing: 1 }], total: 1 });
      expect(summary.headlines).toContain("ISSUE — Required accounting event is missing.");
      const page = await integrityOf(fixture);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        actor: { state: "VALID" },
        certifiedCapture: "COMPANY_HISTORICAL_RECOVERY",
        code: "ACCOUNTING_REQUIRED_EVENT_MISSING",
        eventId: null,
        eventType: "order_delivered",
        health: "ISSUE",
        kind: "MISSING_REQUIRED_EVENT",
        reconstructable: true,
        repairability: "MANUAL_REVIEW",
        sourceId: orderId,
      });
      // The same rule as Company Health's ORDER_MISSING_ACCOUNTING_EVENT.
      const analysis = await asPlatform(fixture.companyId, () => previews.analyze(fixture.companyId, orderId));
      expect(analysis.findings.map((finding) => finding.reasonCode)).toContain("ORDER_MISSING_ACCOUNTING_EVENT");
      // Nothing captured it: still missing, still no event.
      expect((await health.summary(fixture.companyId)).missingRequiredEvents.total).toBe(1);
    });

    it("9: missing trader_receivable_recognized whose actor is not a Company user -> not reconstructable, MANUAL_REVIEW", async () => {
      const fixture = await postingFixture();
      const { receivableId } = await feeOrder(fixture);
      const eventId = await eventOf(fixture, "trader_receivable", receivableId, "trader_receivable_recognized");
      await crafted(sql`delete from accounting_events where id = ${eventId}::uuid`);
      await crafted(sql`update trader_receivables set created_by_account_id = ${adminId}::uuid where id = ${receivableId}::uuid`);
      const row = (await integrityOf(fixture)).items.find((item) => item.sourceId === receivableId)!;
      expect(row).toMatchObject({
        actor: { state: "INVALID" },
        certifiedCapture: null,
        eventType: "trader_receivable_recognized",
        reconstructable: false,
        repairability: "MANUAL_REVIEW",
      });
      expect(row.whyNotAutomatic).toMatch(/does not capture accounting events/u);
    });

    it("10: posted event whose journal reference is missing -> ISSUE MANUAL_REVIEW, no journal created, execution refused", async () => {
      const fixture = await postingFixture();
      const { receivableId } = await feeOrder(fixture);
      const eventId = await eventOf(fixture, "trader_receivable", receivableId, "trader_receivable_recognized");
      await postNow(fixture, eventId);
      // Crafted: the application cannot produce this (posting writes both in
      // one statement and the immutability trigger freezes journal_id).
      await crafted(sql`update accounting_events set journal_id = null where id = ${eventId}::uuid`);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview).toMatchObject({
        execution: { available: false },
        finding: { current: true, health: "ISSUE", repairCapability: null },
        proposedRepair: null,
        repairability: "MANUAL_REVIEW",
      });
      expect(preview.finding.classificationCode).toBe("ACCOUNTING_POSTED_WITHOUT_JOURNAL");
      expect(preview.recovery.recommendedInvestigation.join(" ")).toMatch(/Do not create a Journal/u);
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_capability_not_applicable");
      const summary = await health.summary(fixture.companyId);
      expect(summary.integrity).toMatchObject({ postedWithoutJournal: 1, total: 1 });
      expect(summary.accountingHealth).toBe("ISSUE");
      expect(summary.headlines).toContain("ISSUE — Accounting journal does not match its event.");
      expect((await integrityOf(fixture)).items.filter((row) => row.eventId === eventId).map((row) => row.code)).toEqual([
        "ACCOUNTING_POSTED_WITHOUT_JOURNAL",
      ]);
      expect(await journalsFor(eventId)).toHaveLength(1); // the original only; nothing new
    });

    it("11: one event can never own two journals (database uniqueness); a posted event is never reprocessed", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      await run(fixture, eventId, request);
      const [journal] = await journalsFor(eventId);
      // A second journal claiming the same event is refused by the database itself.
      await expect(
        crafted(sql`insert into journal_entries (id, company_id, journal_number, accounting_period_id, fiscal_year_id,
              business_date, journal_type, source_type, source_id, description, status, source_entity_type,
              source_entity_id, accounting_event_id, created_by_account_id)
            select gen_random_uuid(), company_id, journal_number || '-DUP', accounting_period_id, fiscal_year_id,
                   business_date, journal_type, source_type, source_id, description, 'draft', source_entity_type,
                   source_entity_id, accounting_event_id, created_by_account_id
              from journal_entries where id = ${journal!.id}::uuid`),
      ).rejects.toThrow(/journal_entries_accounting_event_unique/u);
      // Reprocessing the posted event: not current, nothing written.
      await refused(fixture, eventId, { ...request, idempotencyKey: `rc-acc-${randomUUID()}` }, "repair_finding_not_current");
      expect(await journalsFor(eventId)).toHaveLength(1);
    });

    it("12: duplicate events for one source -> MANUAL_REVIEW, never a second effective journal; two posted -> ISSUE", async () => {
      const fixture = await postingFixture();
      const { receivableId } = await feeOrder(fixture);
      const first = await eventOf(fixture, "trader_receivable", receivableId, "trader_receivable_recognized");
      await postNow(fixture, first);
      // Crafted: a second event (version 2) for the same source, failed.
      const second = randomUUID();
      await crafted(sql`insert into accounting_events (id, company_id, event_type, event_version, source_entity_type,
            source_entity_id, source_reference, effective_accounting_date, currency, correlation_id, idempotency_key,
            event_hash, actor_id, actor_type, description, supplementary_metadata, processing_status, operational_area,
            attempt_count, failed_at, error_code, failure_category, safe_error_summary)
          select ${second}::uuid, company_id, event_type, 2, source_entity_type, source_entity_id, source_reference,
                 effective_accounting_date, currency, correlation_id || ':v2', idempotency_key || ':v2', event_hash || 'v2',
                 actor_id, actor_type, description, '{}'::jsonb, 'failed', operational_area, 1, now(),
                 'accounting_event_mapping_missing', 'configuration', 'Crafted duplicate'
            from accounting_events where id = ${first}::uuid`);
      const preview = await recovery.preview(fixture.companyId, second);
      expect(preview.repairability).toBe("MANUAL_REVIEW");
      expect(preview.finding.classificationCode).toBe("ACCOUNTING_HISTORY_AMBIGUOUS");
      expect(preview.execution.available).toBe(false);
      await refused(fixture, second, await requestFor(fixture, second), "repair_not_ready");
      expect(
        (await sql<{ n: number }>`select count(*)::int as n from journal_entries
          where company_id = ${fixture.companyId}::uuid and source_entity_id = ${receivableId}::uuid and status = 'posted'`.execute(db)).rows[0]!.n,
      ).toBe(1);
      // Crafted: the duplicate ALSO posted (its own journal, copied) -> the source is posted twice.
      const copy = randomUUID();
      await crafted(sql`insert into journal_entries (id, company_id, journal_number, accounting_period_id, fiscal_year_id,
            business_date, journal_type, source_type, source_id, description, status, source_entity_type, source_entity_id,
            accounting_event_id, created_by_account_id, posted_by_account_id, posted_at, approved_by_account_id, approved_at,
            total_debit, total_credit)
          select ${copy}::uuid, company_id, journal_number || '-V2', accounting_period_id, fiscal_year_id, business_date,
                 journal_type, source_type, source_id, description, 'posted', source_entity_type, source_entity_id,
                 ${second}::uuid, created_by_account_id, posted_by_account_id, posted_at, approved_by_account_id, approved_at,
                 total_debit, total_credit
            from journal_entries where accounting_event_id = ${first}::uuid`);
      await crafted(sql`insert into journal_lines (company_id, journal_entry_id, line_number, account_id, debit, credit,
            description, subledger_type, subledger_id, trader_id, created_by_account_id)
          select l.company_id, ${copy}::uuid, l.line_number, l.account_id, l.debit, l.credit, l.description,
                 l.subledger_type, l.subledger_id, l.trader_id, l.created_by_account_id
            from journal_lines l join journal_entries j on j.id = l.journal_entry_id
           where j.accounting_event_id = ${first}::uuid`);
      await crafted(sql`update accounting_events set processing_status = 'posted', journal_id = ${copy}::uuid,
            error_code = null, failed_at = null where id = ${second}::uuid`);
      for (const eventId of [first, second]) {
        const details = await recovery.details(fixture.companyId, eventId);
        expect(details.finding).toMatchObject({ classificationCode: "ACCOUNTING_DUPLICATE_EFFECTIVE_POSTING", health: "ISSUE", repairCapability: null });
      }
      const summary = await health.summary(fixture.companyId);
      expect(summary.integrity).toMatchObject({ duplicateEffectivePostings: 2 });
      // History is never deleted.
      expect(await journalsFor(first)).toHaveLength(1);
      expect(await journalsFor(second)).toHaveLength(1);
    });

    it("13: unbalanced journal -> ISSUE MANUAL_REVIEW; no balancing line is ever inserted", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      await run(fixture, eventId, await requestFor(fixture, eventId));
      const [journal] = await journalsFor(eventId);
      const lines = async () =>
        (await sql<{ n: number }>`select count(*)::int as n from journal_lines where journal_entry_id = ${journal!.id}::uuid`.execute(db)).rows[0]!.n;
      const before = await lines();
      await crafted(sql`update journal_lines set debit = debit + 1
          where id = (select id from journal_lines where journal_entry_id = ${journal!.id}::uuid and debit > 0 limit 1)`);
      const details = await recovery.details(fixture.companyId, eventId);
      expect(details.finding).toMatchObject({ classificationCode: "ACCOUNTING_JOURNAL_UNBALANCED", health: "ISSUE", repairability: "MANUAL_REVIEW" });
      expect(details.recovery.existingJournals.eventJournal).toMatchObject({ balanced: false });
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_capability_not_applicable");
      expect((await health.summary(fixture.companyId)).integrity).toMatchObject({ unbalancedJournals: 1 });
      const row = (await integrityOf(fixture)).items.find((item) => item.eventId === eventId)!;
      expect(row).toMatchObject({ code: "ACCOUNTING_JOURNAL_UNBALANCED", journal: { status: "posted" } });
      expect(row.journal!.debit).not.toBe(row.journal!.credit);
      expect(await lines()).toBe(before);
    });

    it("14: wrong journal linkage (journal source differs from the event's) -> ISSUE MANUAL_REVIEW", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      await run(fixture, eventId, await requestFor(fixture, eventId));
      await crafted(sql`update journal_entries set source_entity_id = ${randomUUID()}::uuid where accounting_event_id = ${eventId}::uuid`);
      expect((await recovery.details(fixture.companyId, eventId)).finding).toMatchObject({
        classificationCode: "ACCOUNTING_JOURNAL_LINKAGE_MISMATCH",
        health: "ISSUE",
      });
      expect((await health.summary(fixture.companyId)).integrity).toMatchObject({ linkageMismatches: 1 });
      // A FAILED event that a Journal already points at is never reprocessed.
      const other = await failedRecognition(fixture);
      const orphanJournal = (await journalsFor(eventId))[0]!.id;
      await crafted(sql`update accounting_events set journal_id = ${orphanJournal}::uuid where id = ${other.eventId}::uuid`);
      const preview = await recovery.preview(fixture.companyId, other.eventId);
      expect(preview).toMatchObject({ execution: { available: false }, repairability: "MANUAL_REVIEW" });
      expect(preview.finding.classificationCode).toBe("ACCOUNTING_JOURNAL_LINKAGE_MISMATCH");
      const listed = await health.list(fixture.companyId, {});
      expect(listed.items.find((row) => row.eventId === other.eventId)).toMatchObject({
        triage: "MANUAL_REVIEW",
        triageCode: "ACCOUNTING_JOURNAL_LINKAGE_MISMATCH",
      });
    });
  });

  // ===========================================================================
  // 15, 17-23, 28: cross-company, fiscal periods, mappings, staleness, actor.
  // ===========================================================================
  describe("preconditions (each on its own Company; configuration is mutated)", () => {
    it("15 + 39: another Company's path cannot see or recover the event; both Companies unchanged", async () => {
      const fixture = await postingFixture();
      const other = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      const beforeA = await footprint(fixture.companyId);
      const beforeB = await footprint(other.companyId);
      await expect(
        asPlatform(other.companyId, () => executions.executeAccountingEvent(other.companyId, eventId, request, actor())),
      ).rejects.toMatchObject({ errorCode: "accounting_event_not_found" });
      await expect(recovery.preview(other.companyId, eventId)).rejects.toMatchObject({ errorCode: "accounting_event_not_found" });
      await expect(recovery.details(other.companyId, eventId)).rejects.toMatchObject({ errorCode: "accounting_event_not_found" });
      expect((await integrityOf(other)).items.some((row) => row.eventId === eventId)).toBe(false);
      expect((await health.list(other.companyId, { status: "all" })).items.some((row) => row.eventId === eventId)).toBe(false);
      expect(await footprint(fixture.companyId)).toBe(beforeA);
      const footB = await footprint(other.companyId);
      // 39: a successful recovery in A leaves B byte-identical.
      await run(fixture, eventId, request);
      expect(await footprint(other.companyId)).toBe(footB);
      expect(footB).toBe(beforeB);
    });

    it("17: closed fiscal period -> BLOCKED with the precise reason; never reopened, source date unchanged", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      const dateBefore = (await sql<{ d: string }>`select effective_accounting_date::text as d from accounting_events where id = ${eventId}::uuid`.execute(db)).rows[0]!.d;
      await crafted(sql`update accounting_periods
          set status = 'closed', closed_at = now(), closed_by_account_id = ${fixture.actorId}::uuid, close_reason = 'Crafted close'
        where company_id = ${fixture.companyId}::uuid and current_date between period_start and period_end`);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview.repairability).toBe("BLOCKED");
      expect(preview.blockers.map((blocker) => blocker.code)).toContain("accounting_event_period_closed");
      expect(preview.recovery).toMatchObject({ blocker: expect.stringMatching(/period/u), fiscalPeriod: { status: "closed" } });
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_not_ready");
      expect((await sql<{ s: string }>`select status as s from accounting_periods
        where company_id = ${fixture.companyId}::uuid and current_date between period_start and period_end`.execute(db)).rows[0]!.s).toBe("closed");
      expect((await sql<{ d: string }>`select effective_accounting_date::text as d from accounting_events where id = ${eventId}::uuid`.execute(db)).rows[0]!.d).toBe(dateBefore);
    });

    it("18: missing fiscal period -> BLOCKED, zero mutation", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      // Crafted: no period covers the accounting date (the fixture posted no journal yet).
      await crafted(sql`delete from accounting_periods
        where company_id = ${fixture.companyId}::uuid and current_date between period_start and period_end`);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview.repairability).toBe("BLOCKED");
      expect(preview.recovery.fiscalPeriod).toMatchObject({ matches: 0, status: null });
      expect(preview.blockers.map((blocker) => blocker.code).join(" ")).toMatch(/period/u);
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_not_ready");
    });

    it("20: missing mapping -> BLOCKED, mapping state UNRESOLVED; no fallback / suspense account used", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      await crafted(sql`update account_mappings set is_active = false where company_id = ${fixture.companyId}::uuid`);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview.repairability).toBe("BLOCKED");
      expect(preview.recovery.mappings.state).toBe("UNRESOLVED");
      expect(preview.recovery.mappings.blockerCodes.length).toBeGreaterThan(0);
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_not_ready");
      expect(await journalsFor(eventId)).toEqual([]);
    });

    it("21: disabled mapped account -> BLOCKED, zero mutation", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      const ready = await recovery.preview(fixture.companyId, eventId);
      const code = ready.recovery.mappings.lines[0]!.accountCode;
      await crafted(sql`update chart_of_accounts set is_active = false
        where company_id = ${fixture.companyId}::uuid and code = ${code}`);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview.repairability).toBe("BLOCKED");
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_not_ready");
    });

    it("22: mapping changed after preview -> repair_preview_stale, zero mutation", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      await crafted(sql`update account_mappings set effective_from = effective_from - 1
          where id = (select id from account_mappings where company_id = ${fixture.companyId}::uuid order by id limit 1)`);
      await refused(fixture, eventId, request, "repair_preview_stale");
    });

    it("23: source record or event changed after preview -> repair_preview_stale, zero mutation", async () => {
      const fixture = await postingFixture();
      const { eventId, receivableId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      await crafted(sql`update trader_receivables set updated_at = updated_at + interval '1 second' where id = ${receivableId}::uuid`);
      await refused(fixture, eventId, request, "repair_preview_stale");
      const fresh = await requestFor(fixture, eventId);
      await crafted(sql`update accounting_events set attempt_count = attempt_count + 1 where id = ${eventId}::uuid`);
      await refused(fixture, eventId, fresh, "repair_preview_stale");
    });

    it("28: actor missing / Platform administrator / another Company's user -> BLOCKED; no actor is substituted", async () => {
      const fixture = await postingFixture();
      const other = await createFixture("off");
      const missing = await failedRecognition(fixture);
      await crafted(sql`update accounting_events set actor_id = null where id = ${missing.eventId}::uuid`);
      const platform = await failedRecognition(fixture);
      await crafted(sql`update accounting_events set actor_id = ${adminId}::uuid where id = ${platform.eventId}::uuid`);
      const foreign = await failedRecognition(fixture);
      await crafted(sql`update accounting_events set actor_id = ${other.actorId}::uuid where id = ${foreign.eventId}::uuid`);
      const expectations: [string, string, string][] = [
        [missing.eventId, "accounting_event_actor_missing", "MISSING"],
        [platform.eventId, "accounting_event_actor_invalid", "INVALID"],
        [foreign.eventId, "accounting_event_actor_invalid", "INVALID"],
      ];
      for (const [eventId, code, state] of expectations) {
        const preview = await recovery.preview(fixture.companyId, eventId);
        expect(preview.repairability).toBe("BLOCKED");
        expect(preview.blockers.map((blocker) => blocker.code)).toContain(code);
        expect(preview.recovery.originalActor.state).toBe(state);
        await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_not_ready");
        expect(await journalsFor(eventId)).toEqual([]);
      }
      const listed = new Map((await health.list(fixture.companyId, {})).items.map((row) => [row.eventId, row.triageCode]));
      expect(listed.get(missing.eventId)).toBe("ACCOUNTING_ACTOR_MISSING");
      expect(listed.get(platform.eventId)).toBe("ACCOUNTING_ACTOR_INVALID");
      expect(listed.get(foreign.eventId)).toBe("ACCOUNTING_ACTOR_INVALID");
    });

    it("5 (conditional): a trader_credit_issued whose Settlement event is not posted -> BLOCKED", async () => {
      const fixture = await postingFixture();
      const { eventId, settlementId } = await creditFixture(fixture);
      await craftFailed(eventId);
      // Crafted: the Settlement's event is no longer posted (its journal is untouched).
      const settlementEvent = await eventOf(fixture, "trader_settlement", settlementId, "trader_settlement_confirmed");
      await crafted(sql`update accounting_events set processing_status = 'failed' where id = ${settlementEvent}::uuid`);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview.repairability).toBe("BLOCKED");
      expect(preview.blockers.map((blocker) => blocker.code)).toContain("trader_credit_settlement_not_posted");
      expect((await health.list(fixture.companyId, {})).items.find((row) => row.eventId === eventId)).toMatchObject({
        triage: "BLOCKED",
        triageCode: "TRADER_CREDIT_SETTLEMENT_NOT_POSTED",
      });
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_not_ready");
    });
  });

  // ===========================================================================
  // 24-26: Accounting mode boundaries.
  // ===========================================================================
  describe("Accounting mode boundaries", () => {
    it("24: Accounting OFF -> historical failure NOT_REQUIRED, operations keep working, nothing required", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      await setAccounting(fixture, false);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview).toMatchObject({ execution: { available: false }, repairability: "NOT_REQUIRED" });
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_not_ready");
      // Operations are independent: a new delivered Order while OFF captures nothing and is not required.
      const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      expect((await sql<{ n: number }>`select count(*)::int as n from accounting_events where source_entity_id = ${orderId}::uuid`.execute(db)).rows[0]!.n).toBe(0);
      const summary = await health.summary(fixture.companyId);
      expect(summary).toMatchObject({ accountingHealth: "NOT_APPLICABLE", headlines: [], missingRequiredEvents: { total: 0 } });
      expect(summary.historicalWhileOff).toBeGreaterThanOrEqual(1);
      expect((await sql<{ on: boolean }>`select accounting_enabled as on from accounting_configurations
        where company_id = ${fixture.companyId}::uuid`.execute(db)).rows[0]!.on).toBe(false);
    });

    it("25: OFF -> ON: only activity after enabling is required (no backfill contract)", async () => {
      const fixture = await postingFixture();
      await setAccounting(fixture, false);
      const before = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      await setAccounting(fixture, true);
      const after = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      const afterEvent = await eventOf(fixture, "order", after, "order_delivered");
      expect((await health.summary(fixture.companyId)).missingRequiredEvents.total).toBe(0);
      // Crafted: the post-enable capture is lost -> ONLY that Order is required.
      await crafted(sql`delete from accounting_events where id = ${afterEvent}::uuid`);
      const missing = (await integrityOf(fixture)).items.filter((row) => row.kind === "MISSING_REQUIRED_EVENT");
      expect(missing.map((row) => row.sourceId)).toEqual([after]);
      expect(missing.some((row) => row.sourceId === before)).toBe(false);
    });

    it("26: ON -> OFF -> ON: OFF-period activity is never back-posted or required", async () => {
      const fixture = await postingFixture();
      const first = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      await setAccounting(fixture, false);
      const during = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      await setAccounting(fixture, true);
      const last = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      const events = await sql<{ source: string }>`select source_entity_id::text as source from accounting_events
        where company_id = ${fixture.companyId}::uuid and event_type = 'order_delivered'`.execute(db);
      expect(events.rows.map((row) => row.source).sort()).toEqual([first, last].sort());
      expect((await health.summary(fixture.companyId)).missingRequiredEvents.total).toBe(0);
      await crafted(sql`delete from accounting_events where company_id = ${fixture.companyId}::uuid
        and event_type = 'order_delivered' and source_entity_id in (${first}::uuid, ${last}::uuid)`);
      const missing = (await integrityOf(fixture)).items.filter((row) => row.kind === "MISSING_REQUIRED_EVENT").map((row) => row.sourceId);
      expect(missing.sort()).toEqual([first, last].sort());
      expect(missing).not.toContain(during);
    });
  });

  // ===========================================================================
  // 29-34: idempotency, concurrency, atomicity, durable attempts.
  // ===========================================================================
  describe("execution safety", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await postingFixture();
    }, 300_000);

    async function attemptsFor(eventId: string) {
      return (
        await sql<{ result: string; code: string | null }>`select result, error_code as code from platform_repair_attempts
          where company_id = ${fixture.companyId}::uuid and entity_id = ${eventId}::uuid order by created_at, id`.execute(db)
      ).rows.map((row) => [row.result, row.code]);
    }

    it("29: concurrent recoveries of one READY event -> exactly one posting, one journal, one audit", async () => {
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      const results = await Promise.allSettled([
        run(fixture, eventId, request),
        run(fixture, eventId, { ...request, idempotencyKey: `rc-acc-${randomUUID()}` }),
        run(fixture, eventId, { ...request, idempotencyKey: `rc-acc-${randomUUID()}` }),
      ]);
      const fulfilled = results.filter((item) => item.status === "fulfilled");
      expect(fulfilled).toHaveLength(1);
      for (const item of results.filter((entry) => entry.status === "rejected")) {
        expect(["repair_finding_not_current", "repair_preview_stale"]).toContain(
          ((item as PromiseRejectedResult).reason as ApplicationException).errorCode,
        );
      }
      expect(await journalsFor(eventId)).toHaveLength(1);
      expect(await auditCount(fixture.companyId, eventId)).toBe(1);
    });

    it("30: double submit (same key, same request) -> the same result replayed, still one journal", async () => {
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      const first = await run(fixture, eventId, request);
      const second = await run(fixture, eventId, request);
      expect(second).toEqual({ ...first, replayed: true });
      expect(await journalsFor(eventId)).toHaveLength(1);
      expect(await auditCount(fixture.companyId, eventId)).toBe(1);
      // Same key, different request -> conflict, nothing written.
      await refused(fixture, eventId, { ...request, reason: "Another reason" }, "repair_idempotency_conflict");
    });

    it("31: retry after a timeout -> the timed-out attempt rolled back (FAILED); the retry posts exactly once", async () => {
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      const before = await footprint(fixture.companyId);
      vi.spyOn(get(OperationalJournalPostingService), "process").mockRejectedValueOnce(
        Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
      );
      await expect(run(fixture, eventId, request)).rejects.toThrow(/statement timeout/u);
      expect(await footprint(fixture.companyId)).toBe(before);
      expect(await eventRow(eventId)).toMatchObject({ journalId: null, status: "failed" });
      const retried = await run(fixture, eventId, request);
      expect(retried).toMatchObject({ replayed: false, status: "succeeded" });
      expect(await journalsFor(eventId)).toHaveLength(1);
      expect((await attemptsFor(eventId)).map(([result]) => result)).toEqual(["FAILED"]);
    });

    it("31b: a processor posting the same event while the repair waits -> the repair is refused, one journal", async () => {
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      const adapter = get(PlatformAccountingRepairAdapter);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let lockedSignal!: () => void;
      const locked = new Promise<void>((resolve) => (lockedSignal = resolve));
      // The Company's own certified reprocess (re-queue + claim + posting),
      // holding the event row lock while the Platform repair is submitted.
      const worker = as(fixture, () =>
        db.transaction().execute(async (transaction) => {
          expect(await adapter.lockEvent(transaction, fixture.companyId, eventId)).toBe(true);
          lockedSignal();
          await gate;
          await adapter.reprocessInTransaction(transaction, {
            companyId: fixture.companyId,
            correlationId: `worker-${randomUUID()}`,
            eventId,
            reason: "Company reprocess",
          });
        }),
      );
      await locked;
      const repair = run(fixture, eventId, request);
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      const [workerResult, repairResult] = await Promise.allSettled([worker, repair]);
      expect(workerResult.status).toBe("fulfilled");
      expect(repairResult).toMatchObject({ reason: { errorCode: "repair_finding_not_current" }, status: "rejected" });
      expect(await journalsFor(eventId)).toHaveLength(1);
      expect(await auditCount(fixture.companyId, eventId)).toBe(0);
    });

    it("32 + 33: a forced posting failure rolls back everything and leaves a durable FAILED attempt", async () => {
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      const before = await footprint(fixture.companyId);
      vi.spyOn(get(OperationalJournalPostingService), "process").mockRejectedValueOnce(
        new ApplicationException("accounting_journal_number_generation_failed", "A unique Journal Number could not be reserved", 409),
      );
      await expect(run(fixture, eventId, request)).rejects.toMatchObject({ errorCode: "accounting_journal_number_generation_failed" });
      expect(await footprint(fixture.companyId)).toBe(before);
      expect(await eventRow(eventId)).toMatchObject({ attempts: 1, journalId: null, status: "failed" });
      expect(await auditCount(fixture.companyId, eventId)).toBe(0);
      expect(await attemptsFor(eventId)).toEqual([["FAILED", "accounting_journal_number_generation_failed"]]);
    });

    it("34: refusals are durable REFUSED attempts (stale, not current, capability, not ready)", async () => {
      const { eventId } = await failedRecognition(fixture);
      await refused(fixture, eventId, await requestFor(fixture, eventId, { previewVersion: `rcv1:${"0".repeat(64)}` }), "repair_preview_stale");
      await refused(fixture, eventId, await requestFor(fixture, eventId, { findingId: "fnd_000000000000000000000000" }), "repair_finding_not_current");
      await refused(fixture, eventId, await requestFor(fixture, eventId, { capabilityCode: "REPAIR_TRADER_RECEIVABLE" }), "repair_capability_not_applicable");
      expect(await attemptsFor(eventId)).toEqual([
        ["REFUSED", "repair_preview_stale"],
        ["REFUSED", "repair_finding_not_current"],
        ["REFUSED", "repair_capability_not_applicable"],
      ]);
      expect(await journalsFor(eventId)).toEqual([]);
    });
  });

  // ===========================================================================
  // 35-38: reversal, legacy and payroll types -> never Platform-recovered.
  // ===========================================================================
  describe("unsupported, legacy and out-of-scope types", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await postingFixture();
    }, 300_000);

    /** Crafted: a FAILED event of a type no current flow produces, on a real receivable. */
    async function craftedEvent(eventType: string, sourceType: string, area: string) {
      const id = randomUUID();
      await crafted(sql`insert into accounting_events (id, company_id, event_type, event_version, source_entity_type,
            source_entity_id, source_reference, effective_accounting_date, currency, correlation_id, idempotency_key,
            event_hash, actor_id, actor_type, description, supplementary_metadata, processing_status, operational_area,
            attempt_count, failed_at, error_code, failure_category, safe_error_summary)
          values (${id}::uuid, ${fixture.companyId}::uuid, ${eventType}, 1, ${sourceType}, ${randomUUID()}::uuid,
                  ${`LEG-${id.slice(0, 6)}`}, current_date, 'AED', ${`crafted:${id}`}, ${`crafted:${id}`}, md5(${id}),
                  ${fixture.actorId}::uuid, 'company_user', 'Crafted legacy event', '{}'::jsonb, 'failed', ${area},
                  1, now(), 'accounting_event_source_conflict', 'source', 'Crafted: no source loader')`);
      return id;
    }

    async function neverRecovered(eventId: string, classification: string, decision: string) {
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview).toMatchObject({ execution: { available: false }, proposedRepair: null, repairability: "MANUAL_REVIEW" });
      expect(preview.finding.classificationCode).toBe(classification);
      expect(preview.recovery.decision?.decision).toBe(decision);
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_capability_not_applicable");
      expect(await journalsFor(eventId)).toEqual([]);
    }

    it("35: a failed reversal event (trader_receivable_reversed, real cancel) -> MANUAL_REVIEW", async () => {
      const { receivableId } = await feeOrder(fixture);
      await postNow(fixture, await eventOf(fixture, "trader_receivable", receivableId, "trader_receivable_recognized"));
      await as(fixture, () =>
        get(TraderReceivableService).cancelReceivable(receivableId, { reason: "Raised in error" } as never, randomUUID()),
      );
      const eventId = await eventOf(fixture, "trader_receivable", receivableId, "trader_receivable_reversed");
      await craftFailed(eventId, "accounting_event_original_not_posted");
      await neverRecovered(eventId, "ACCOUNTING_EVENT_OUT_OF_SCOPE", "MANUAL_REVIEW");
    });

    it("36: driver_expense_confirmed (no producer, no loader) -> MANUAL_REVIEW, no weak loader", async () => {
      await neverRecovered(await craftedEvent("driver_expense_confirmed", "driver_expense", "driver_expenses"), "ACCOUNTING_EVENT_UNSUPPORTED", "MANUAL_REVIEW");
    });

    it("37: bank_transfer_confirmed (no producer, no loader) -> MANUAL_REVIEW", async () => {
      await neverRecovered(await craftedEvent("bank_transfer_confirmed", "bank_transfer", "cash_bank_management"), "ACCOUNTING_EVENT_UNSUPPORTED", "MANUAL_REVIEW");
    });

    it("38: early-payment accounting event (employee_salary_advance_paid) -> OUT_OF_SCOPE_PHASE_4, MANUAL_REVIEW; a Payroll event with a non-certified source -> MANUAL_REVIEW", async () => {
      // Phase 5 Prompt 1 certifies employee_payroll_approved / _paid only;
      // early payments stay out of scope.
      await neverRecovered(await craftedEvent("employee_salary_advance_paid", "employee_salary_advance", "employee_payroll"), "ACCOUNTING_EVENT_OUT_OF_SCOPE", "OUT_OF_SCOPE_PHASE_4");
      // A promoted Payroll type whose source is not the certified one was not
      // produced by the capture trigger: never a recovery candidate.
      const odd = await craftedEvent("employee_payroll_paid", "employee_payroll", "employee_payroll");
      await neverRecovered(odd, "ACCOUNTING_EVENT_OUT_OF_SCOPE", "SUPPORTED_READY");
      const listed = await health.list(fixture.companyId, { status: "all", pageSize: 100 });
      expect(listed.items.find((item) => item.eventId === odd)).toMatchObject({ triage: "MANUAL_REVIEW", triageCode: "ACCOUNTING_EVENT_OUT_OF_SCOPE" });
      const summary = await health.summary(fixture.companyId);
      expect(summary.manualReview).toBeGreaterThanOrEqual(3);
      expect(summary.headlines).toContain("REVIEW — Accounting history requires manual review.");
    });
  });

  // ===========================================================================
  // 40 + statement counts: recovery resolves the health finding.
  // ===========================================================================
  it("40: one failed event -> ISSUE; recovery -> HEALTHY; summary / list / integrity are one statement each", async () => {
    const fixture = await postingFixture();
    const { eventId } = await failedRecognition(fixture);
    let statements = 0;
    const counting = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === "query") statements += 1;
      },
    });
    const counted = new PlatformAccountingHealthService(counting);
    statements = 0;
    const before = await counted.summary(fixture.companyId);
    const summaryStatements = statements;
    statements = 0;
    await counted.list(fixture.companyId, {});
    const listStatements = statements;
    statements = 0;
    await counted.integrityFindings(fixture.companyId, {});
    const integrityStatements = statements;
    expect(before).toMatchObject({
      accountingHealth: "ISSUE",
      headlines: ["ISSUE — Accounting event failed."],
      integrity: { total: 0 },
      missingRequiredEvents: { total: 0 },
      readyCandidates: 1,
    });
    await run(fixture, eventId, await requestFor(fixture, eventId));
    expect(await health.summary(fixture.companyId)).toMatchObject({
      accountingHealth: "HEALTHY",
      headlines: [],
      integrity: { total: 0 },
      readyCandidates: 0,
    });
    expect((await health.list(fixture.companyId, {})).total).toBe(0);
    expect([summaryStatements, listStatements, integrityStatements]).toEqual([5, 5, 5]);
  });
});
