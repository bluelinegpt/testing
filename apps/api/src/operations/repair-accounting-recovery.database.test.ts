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
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { OperationsService } from "./operations.service.js";
import { PlatformAccountingHealthService } from "../accounting/platform-accounting-health.service.js";
import { OperationalJournalPostingService } from "../accounting/operational-journal-posting.service.js";
import { AccountingEventRepository } from "../accounting/accounting-event.repository.js";
import { AccountingEventProcessor } from "../accounting/accounting-event.processor.js";
import { AccountingReprocessPrecheckService } from "../accounting/accounting-reprocess-precheck.service.js";
import { type RepairExecutionRequest, RepairExecutionService } from "./repair-execution.service.js";
import { RepairAccountingRecoveryService } from "./repair-accounting-recovery.service.js";
import { RepairCenterOverviewService } from "./repair-center-overview.service.js";
import { RepairHistoryService } from "./repair-history.service.js";
import { RepairPreviewService } from "./repair-preview.service.js";

/**
 * Phase 2 Prompt 4 -- Platform Repair Center ACCOUNTING HEALTH + SAFE
 * ACCOUNTING RECOVERY (test matrix A-L, O, P; M / N are HTTP-level in
 * platform-repair-center.http.database.test.ts).
 *
 * Fixtures: the REAL services against the disposable database (the Accounting
 * ON Company uses the certified UAE_DELIVERY_STANDARD template: chart, mappings,
 * fiscal year). The background posting processor is NOT running (the module is
 * compiled, not initialised), so events stay where the tests put them; an
 * event's FAILED state is crafted (as the processor would record it) and
 * marked "crafted". Every refusal proves zero mutation with a content checksum
 * of every table a recovery could touch, journals and journal lines included.
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

describe.skipIf(!runDatabaseTests)("Repair Center -- accounting health and safe accounting recovery", () => {
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

  const key = (label: string) => `accrec.${label}.${randomUUID()}`;

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`ACCREC-${tag}`},${`accrec-${tag}`},${`AccRec ${mode} ${tag}`},
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

  it("Part C: every declared event type is classified SUPPORTED / UNSUPPORTED / MANUAL_REVIEW", async () => {
    const { ACCOUNTING_EVENT_SUPPORT } = await import("../accounting/platform-accounting-repair.adapter.js");
    const supported = Object.entries(ACCOUNTING_EVENT_SUPPORT)
      .filter(([, value]) => value.support === "SUPPORTED")
      .map(([type]) => type)
      .sort();
    expect(supported).toEqual([
      "driver_collection_confirmed",
      // Phase 5 Prompt 1: Payroll approval and payment.
      "employee_payroll_approved",
      "employee_payroll_paid",
      "order_delivered",
      "trader_credit_issued",
      "trader_receivable_payment_received",
      "trader_receivable_recognized",
      "trader_settlement_confirmed",
    ]);
    expect(ACCOUNTING_EVENT_SUPPORT.employee_salary_advance_paid.support).toBe("MANUAL_REVIEW");
    expect(ACCOUNTING_EVENT_SUPPORT.trader_settlement_reversed.support).toBe("MANUAL_REVIEW");
    expect(ACCOUNTING_EVENT_SUPPORT.driver_expense_confirmed.support).toBe("UNSUPPORTED");
    expect(ACCOUNTING_EVENT_SUPPORT.bank_transfer_confirmed.support).toBe("UNSUPPORTED");
  });

  describe("Accounting ON, automatic posting enabled", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await postingFixture();
    }, 300_000);

    it("A + E + J + Part Q: READY -> atomic recovery -> one balanced journal, finding resolved, replay identical, re-run refused", async () => {
      const { eventId, orderId } = await failedRecognition(fixture);
      const details = await recovery.details(fixture.companyId, eventId);
      expect(details).toMatchObject({
        event: { eventType: "trader_receivable_recognized", failureCode: "accounting_event_mapping_missing", status: "failed" },
        finding: { current: true, repairCapability: "REPROCESS_ACCOUNTING_EVENT", repairability: "READY" },
        sourceOrderId: orderId,
        support: { support: "SUPPORTED" },
      });
      expect(JSON.stringify(details)).not.toMatch(/supplementary_metadata|event_hash|Customer|971500000001/u);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview).toMatchObject({
        execution: { available: true },
        proposedRepair: { capabilityCode: "REPROCESS_ACCOUNTING_EVENT", candidateOnly: false },
        repairability: "READY",
        requiredInputs: [{ name: "reason", required: true }],
        requiredPermission: "platform.companies.repair_center.execute",
      });
      expect(preview.proposedChanges.map((change) => change.entityType)).toEqual([
        "accounting_event",
        "journal_entry",
        "trader_receivable",
      ]);
      const request = await requestFor(fixture, eventId);
      const result = await run(fixture, eventId, request);
      expect(result).toMatchObject({
        afterClassification: "posted",
        afterHealth: "HEALTHY",
        beforeClassification: "failed",
        beforeHealth: "ISSUE",
        capabilityCode: "REPROCESS_ACCOUNTING_EVENT",
        eventId,
        eventType: "trader_receivable_recognized",
        orderHealthAfter: "HEALTHY",
        orderId,
        replayed: false,
        status: "succeeded",
      });
      // A: posted, owning exactly one balanced journal; no Company reviewer.
      const event = await eventRow(eventId);
      expect(event).toMatchObject({ errorCode: null, reviewer: null, status: "posted" });
      const journals = await journalsFor(eventId);
      expect(journals).toHaveLength(1);
      expect(journals[0]).toMatchObject({ id: event.journalId, status: "posted" });
      expect(journals[0]!.debit).toBe(journals[0]!.credit);
      expect(Number(journals[0]!.debit)).toBeGreaterThan(0);
      // The Platform admin -- not a Company employee -- is the recorded actor.
      const requeueAudit = (
        await sql<{ actor: string }>`select actor_account_id as actor from audit_events
          where company_id = ${fixture.companyId}::uuid and subject_type = 'accounting_event'
            and subject_id = ${eventId} and action = 'accounting.event.reprocessing_requested'`.execute(db)
      ).rows;
      expect(requeueAudit).toEqual([{ actor: adminId }]);
      expect(await auditCount(fixture.companyId, eventId)).toBe(1);
      // The finding is resolved.
      expect((await recovery.details(fixture.companyId, eventId)).finding).toMatchObject({
        current: false,
        repairability: "NOT_REQUIRED",
      });
      // J: same key + same request -> the same result, still one journal.
      const before = await footprint(fixture.companyId);
      expect(await run(fixture, eventId, request)).toEqual({ ...result, replayed: true });
      expect(await footprint(fixture.companyId)).toBe(before);
      expect(await journalsFor(eventId)).toHaveLength(1);
      // E: a different request after success -> finding not current.
      await refused(fixture, eventId, { ...request, idempotencyKey: `rc-acc-${randomUUID()}` }, "repair_finding_not_current");
      expect((await recovery.preview(fixture.companyId, eventId)).repairability).toBe("NOT_REQUIRED");
      expect(await journalsFor(eventId)).toHaveLength(1);
    });

    it("D: unsupported / out-of-scope event -> MANUAL_REVIEW, no execute", async () => {
      const { eventId } = await failedRecognition(fixture);
      // Crafted: the same failed event as a reversal type (posted by inverting
      // the original journal -- not enabled for Platform recovery).
      await crafted(sql`update accounting_events set event_type = 'trader_receivable_reversed' where id = ${eventId}::uuid`);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview).toMatchObject({ execution: { available: false }, proposedRepair: null, repairability: "MANUAL_REVIEW" });
      expect(preview.warnings.map((warning) => warning.code)).toContain("NO_CERTIFIED_PLATFORM_RECOVERY");
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_capability_not_applicable");
    });

    it("I: preview READY, then another process posts the event -> finding not current, still one journal", async () => {
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      // "Another process": the Company's own certified reprocess, then the
      // processor's claim + posting for exactly this event. (The background
      // drain the reprocess kicks off is stubbed so it cannot touch other
      // Companies' queued events in the shared test database.)
      vi.spyOn(get(AccountingEventProcessor), "drain").mockResolvedValue(0);
      await as(fixture, () => get(AccountingReprocessPrecheckService).execute(eventId, { reason: "Company fix" }, key("company-reprocess")));
      await db.transaction().execute(async (transaction) => {
        const record = await get(AccountingEventRepository).claimInTransaction(transaction, fixture.companyId, eventId, "test-worker");
        await get(OperationalJournalPostingService).process(transaction, record!);
      });
      expect((await eventRow(eventId)).status).toBe("posted");
      await refused(fixture, eventId, request, "repair_finding_not_current");
      expect(await journalsFor(eventId)).toHaveLength(1);
    });

    it("K: concurrent recoveries of one READY event -> exactly one posting, one journal", async () => {
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      const results = await Promise.allSettled([
        run(fixture, eventId, request),
        run(fixture, eventId, { ...request, idempotencyKey: `rc-acc-${randomUUID()}` }),
        run(fixture, eventId, { ...request, idempotencyKey: `rc-acc-${randomUUID()}` }),
        run(fixture, eventId, request),
      ]);
      const fulfilled = results.filter((item) => item.status === "fulfilled") as PromiseFulfilledResult<{ replayed: boolean; repairExecutionId: string }>[];
      expect(fulfilled.filter((item) => !item.value.replayed)).toHaveLength(1);
      expect(new Set(fulfilled.map((item) => item.value.repairExecutionId)).size).toBe(1);
      for (const item of results.filter((entry) => entry.status === "rejected")) {
        expect(["repair_finding_not_current", "repair_preview_stale"]).toContain(
          ((item as PromiseRejectedResult).reason as ApplicationException).errorCode,
        );
      }
      expect(await journalsFor(eventId)).toHaveLength(1);
      expect(await auditCount(fixture.companyId, eventId)).toBe(1);
    });

    it("O: a posting failure inside recovery rolls back EVERYTHING (event keeps its failure, no journal, no audit)", async () => {
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      const before = await footprint(fixture.companyId);
      const posting = get(OperationalJournalPostingService);
      vi.spyOn(posting, "process").mockRejectedValueOnce(
        new ApplicationException("accounting_journal_number_generation_failed", "A unique Journal Number could not be reserved", 409),
      );
      await expect(run(fixture, eventId, request)).rejects.toMatchObject({
        errorCode: "accounting_journal_number_generation_failed",
      });
      expect(await footprint(fixture.companyId)).toBe(before);
      expect(await eventRow(eventId)).toMatchObject({
        attempts: 1,
        errorCode: "accounting_event_mapping_missing",
        journalId: null,
        status: "failed",
      });
      // Nothing was spent: the same preview is still READY and recovers.
      expect((await recovery.preview(fixture.companyId, eventId)).repairability).toBe("READY");
      await expect(run(fixture, eventId, request)).resolves.toMatchObject({ status: "succeeded" });
    });

    it("P: post-reprocess verification failure -> no false success, full rollback", async () => {
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      vi.spyOn(
        executions as never as { verifyAccountingRecovery: () => Promise<void> },
        "verifyAccountingRecovery",
      ).mockRejectedValueOnce(new ApplicationException("repair_verification_failed", "forced", 409));
      await refused(fixture, eventId, request, "repair_verification_failed");
      expect(await eventRow(eventId)).toMatchObject({ journalId: null, status: "failed" });
      expect(await journalsFor(eventId)).toEqual([]);
      expect(await auditCount(fixture.companyId, eventId)).toBe(0);
    });

    it("L: another Company's path cannot recover the event -> 404, zero mutation in both", async () => {
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      const other = await createFixture("off");
      const beforeA = await footprint(fixture.companyId);
      const beforeB = await footprint(other.companyId);
      await expect(
        asPlatform(other.companyId, () => executions.executeAccountingEvent(other.companyId, eventId, request, actor())),
      ).rejects.toMatchObject({ errorCode: "accounting_event_not_found" });
      await expect(recovery.preview(other.companyId, eventId)).rejects.toMatchObject({ errorCode: "accounting_event_not_found" });
      expect(await footprint(fixture.companyId)).toBe(beforeA);
      expect(await footprint(other.companyId)).toBe(beforeB);
    });

    it("request rules: wrong capability and undeclared inputs are refused before anything runs", async () => {
      const { eventId } = await failedRecognition(fixture);
      await refused(fixture, eventId, await requestFor(fixture, eventId, { capabilityCode: "REPAIR_TRADER_RECEIVABLE" }), "repair_capability_not_applicable");
      await refused(fixture, eventId, await requestFor(fixture, eventId, { inputs: { journalNumber: "JV-1" } }), "repair_inputs_invalid");
    });
  });

  // ===========================================================================
  // Phase 2 Prompt 5 -- accounting recovery E2E through History and Overview.
  // ===========================================================================
  describe("Prompt 5 -- accounting attempts, History and Overview", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await postingFixture();
    }, 300_000);

    async function attemptsFor(eventId: string) {
      return (
        await sql<{ result: string; code: string | null; execution: string | null; entityType: string; number: string | null }>`
          select result, error_code as code, repair_execution_id as execution, entity_type as "entityType",
                 entity_number as number
            from platform_repair_attempts
           where company_id = ${fixture.companyId}::uuid and entity_id = ${eventId}::uuid
           order by created_at, id`.execute(db)
      ).rows;
    }

    it("L: accounting E2E -- READY CANDIDATE -> preview READY -> recover -> SUCCEEDED in History, replay REPLAYED, Overview counts", async () => {
      const health = get(PlatformAccountingHealthService);
      const history = get(RepairHistoryService);
      const overview = get(RepairCenterOverviewService);
      const { eventId, receivableId } = await failedRecognition(fixture);
      const reference = (
        await sql<{ ref: string }>`select receivable_number as ref from trader_receivables where id = ${receivableId}::uuid`.execute(db)
      ).rows[0]!.ref;
      const summaryBefore = await health.summary(fixture.companyId);
      expect(summaryBefore.readyCandidates).toBeGreaterThanOrEqual(1);
      expect(summaryBefore.readyCandidateNote).toMatch(/READY is decided only by Preview/u);
      const listed = await health.list(fixture.companyId, { status: "failed" });
      const row = listed.items.find((item) => item.eventId === eventId)!;
      expect(row).toMatchObject({ previewRequired: true, triage: "READY_CANDIDATE" });
      expect(row.finding).toMatch(/preview required/iu);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview).toMatchObject({ execution: { available: true }, repairability: "READY" });
      const request = await requestFor(fixture, eventId);
      const result = await run(fixture, eventId, request);
      expect(result).toMatchObject({ replayed: false, status: "succeeded" });
      expect(await journalsFor(eventId)).toHaveLength(1);
      const replay = await run(fixture, eventId, request);
      expect(replay).toMatchObject({ repairExecutionId: result.repairExecutionId, replayed: true });
      expect(await journalsFor(eventId)).toHaveLength(1);
      expect(await auditCount(fixture.companyId, eventId)).toBe(1);
      expect(await attemptsFor(eventId)).toEqual([
        { code: null, entityType: "accounting_event", execution: result.repairExecutionId, number: reference, result: "REPLAYED" },
      ]);
      const page = await history.list(fixture.companyId, { entityType: "accounting_event" });
      const mine = page.items.filter((item) => item.entityId === eventId);
      expect(mine.map((item) => item.result)).toEqual(["REPLAYED", "SUCCEEDED"]);
      expect(mine[1]).toMatchObject({ capabilityCode: "REPROCESS_ACCOUNTING_EVENT", entityNumber: reference, repairApplied: true });
      const detail = await history.detail(fixture.companyId, "execution", result.repairExecutionId);
      expect(detail.execution).toMatchObject({ replays: 1 });
      expect(detail.execution?.beforeFingerprint).toBe(request.previewVersion);
      const landing = await overview.overview(fixture.companyId);
      expect(landing.accountingMode.enabled).toBe(true);
      expect(landing.repairHistory.succeeded).toBeGreaterThanOrEqual(1);
      expect(landing.repairHistory.replayed).toBeGreaterThanOrEqual(1);
      expect(landing.accountingHealth.readyCandidates).toBe(summaryBefore.readyCandidates - 1);
      // HEALTHY now: NOT_REQUIRED, no execute.
      expect(await recovery.preview(fixture.companyId, eventId)).toMatchObject({
        execution: { available: false },
        repairability: "NOT_REQUIRED",
      });
    });

    it("O: a posting failure inside recovery is a durable FAILED attempt; event, journals and audit unchanged", async () => {
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      const before = await footprint(fixture.companyId);
      vi.spyOn(get(OperationalJournalPostingService), "process").mockRejectedValueOnce(
        new ApplicationException("accounting_journal_number_generation_failed", "A unique Journal Number could not be reserved", 409),
      );
      await expect(run(fixture, eventId, request)).rejects.toMatchObject({
        errorCode: "accounting_journal_number_generation_failed",
      });
      expect(await footprint(fixture.companyId)).toBe(before);
      expect(await eventRow(eventId)).toMatchObject({ journalId: null, status: "failed" });
      expect(await auditCount(fixture.companyId, eventId)).toBe(0);
      expect((await attemptsFor(eventId)).map((row) => [row.result, row.code, row.execution])).toEqual([
        ["FAILED", "accounting_journal_number_generation_failed", null],
      ]);
    });

    it("P: refusals before reprocessing (stale, not current, wrong capability, input) are durable REFUSED", async () => {
      const { eventId } = await failedRecognition(fixture);
      await refused(fixture, eventId, await requestFor(fixture, eventId, { previewVersion: `acv1:${"0".repeat(64)}` }), "repair_preview_stale");
      await refused(fixture, eventId, await requestFor(fixture, eventId, { findingId: "fnd_000000000000000000000000" }), "repair_finding_not_current");
      await refused(fixture, eventId, await requestFor(fixture, eventId, { capabilityCode: "REPAIR_TRADER_RECEIVABLE" }), "repair_capability_not_applicable");
      await refused(fixture, eventId, await requestFor(fixture, eventId, { inputs: { journalNumber: "JV-1" } }), "repair_inputs_invalid");
      expect((await attemptsFor(eventId)).map((row) => [row.result, row.code])).toEqual([
        ["REFUSED", "repair_preview_stale"],
        ["REFUSED", "repair_finding_not_current"],
        ["REFUSED", "repair_capability_not_applicable"],
        ["REFUSED", "repair_inputs_invalid"],
      ]);
      expect(await auditCount(fixture.companyId, eventId)).toBe(0);
    });
  });

  describe("prerequisite changes (own Companies; configuration is mutated)", () => {
    it("B: missing mapping -> BLOCKED with the pipeline's own code, zero mutation", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      await crafted(sql`update account_mappings set is_active = false where company_id = ${fixture.companyId}::uuid`);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview.repairability).toBe("BLOCKED");
      expect(preview.blockers.map((blocker) => blocker.code).join(" ")).toMatch(/mapping/u);
      expect(preview.execution.available).toBe(false);
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_not_ready");
    });

    it("C: closed fiscal period -> BLOCKED, zero mutation", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      await crafted(sql`update accounting_periods
          set status = 'closed', closed_at = now(), closed_by_account_id = ${fixture.actorId}::uuid,
              close_reason = 'Crafted close'
        where company_id = ${fixture.companyId}::uuid and current_date between period_start and period_end`);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview.repairability).toBe("BLOCKED");
      expect(preview.blockers.map((blocker) => blocker.code)).toContain("accounting_event_period_closed");
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_not_ready");
    });

    it("G: READY preview, then the accounting configuration changes -> repair_preview_stale, zero mutation", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      expect((await recovery.preview(fixture.companyId, eventId)).repairability).toBe("READY");
      // An unrelated mapping row changes (the mapping digest is fingerprinted).
      await crafted(sql`update account_mappings set effective_from = effective_from - 1
                         where id = (select id from account_mappings where company_id = ${fixture.companyId}::uuid
                                      order by id desc limit 1)`);
      await refused(fixture, eventId, request, "repair_preview_stale");
      // Configuration version too.
      const fresh = await requestFor(fixture, eventId);
      await crafted(sql`update accounting_configurations set version = version + 1 where company_id = ${fixture.companyId}::uuid`);
      await refused(fixture, eventId, fresh, "repair_preview_stale");
    });

    it("H: READY preview, then the fiscal period closes -> stale (and now BLOCKED), zero mutation", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      const request = await requestFor(fixture, eventId);
      await crafted(sql`update accounting_periods
          set status = 'closed', closed_at = now(), closed_by_account_id = ${fixture.actorId}::uuid,
              close_reason = 'Crafted close', version = version + 1
        where company_id = ${fixture.companyId}::uuid and current_date between period_start and period_end`);
      await refused(fixture, eventId, request, "repair_preview_stale");
      expect((await recovery.preview(fixture.companyId, eventId)).repairability).toBe("BLOCKED");
    });

    it("F: Accounting OFF + historical failed event -> NOT_REQUIRED, no GL recovery, operational finance valid", async () => {
      const fixture = await postingFixture();
      const { eventId, orderId } = await failedRecognition(fixture);
      // Crafted: GL Accounting switched OFF (automatic posting goes with it).
      await crafted(sql`update accounting_configurations
                           set accounting_enabled = false, automatic_posting_enabled = false
                         where company_id = ${fixture.companyId}::uuid`);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview).toMatchObject({ execution: { available: false }, repairability: "NOT_REQUIRED" });
      expect(preview.warnings.map((warning) => warning.code)).toContain("ACCOUNTING_OFF_HISTORICAL");
      // The event is still unresolved, but no GL recovery runs while OFF.
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_not_ready");
      const summary = await health.summary(fixture.companyId);
      expect(summary).toMatchObject({ accountingHealth: "NOT_APPLICABLE", accountingMode: { enabled: false } });
      expect(summary.historicalWhileOff).toBeGreaterThanOrEqual(1);
      expect(summary.note).toMatch(/not required for new operational activity/u);
      // Operational finance is untouched and healthy without GL.
      expect((await previews.analyze(fixture.companyId, orderId)).health).toBe("HEALTHY");
      expect(await sql<{ n: number }>`select count(*)::int as n from accounting_configurations
        where company_id = ${fixture.companyId}::uuid and accounting_enabled`.execute(db).then((r) => r.rows[0]!.n)).toBe(0);
    });
  });

  describe("Accounting Health (summary + list), set-based", () => {
    it("Part M / N / O / T: mode-aware counts, triage, filters and pagination in one statement each", async () => {
      const fixture = await postingFixture();
      // Four failed events, each classified from current state (Part T):
      const ready = await failedRecognition(fixture); // READY_CANDIDATE
      const noActor = await failedRecognition(fixture);
      await crafted(sql`update accounting_events set actor_id = null where id = ${noActor.eventId}::uuid`); // BLOCKED
      const outOfScope = await failedRecognition(fixture);
      await crafted(sql`update accounting_events set event_type = 'trader_receivable_reversed' where id = ${outOfScope.eventId}::uuid`); // MANUAL_REVIEW
      const posted = await failedRecognition(fixture);
      await run(fixture, posted.eventId, await requestFor(fixture, posted.eventId)); // NOT_REQUIRED afterwards

      let statements = 0;
      const counting = new Kysely<DatabaseSchema>({
        dialect: new PostgresDialect({ pool }),
        log: (event) => {
          if (event.level === "query") statements += 1;
        },
      });
      const counted = new PlatformAccountingHealthService(counting);
      statements = 0;
      const summary = await counted.summary(fixture.companyId);
      const summaryStatements = statements;
      expect(summary).toMatchObject({
        accountingHealth: "ISSUE",
        accountingMode: { automaticPostingEnabled: true, enabled: true },
        blocked: 1,
        failed: 3,
        manualReview: 1,
        readyCandidates: 1,
      });
      statements = 0;
      const page = await counted.list(fixture.companyId, {});
      const listStatements = statements;
      expect(page.total).toBe(3);
      const byEvent = new Map(page.items.map((row) => [row.eventId, row]));
      expect(byEvent.get(ready.eventId)).toMatchObject({ triage: "READY_CANDIDATE", triageCode: "PRECHECK_REQUIRED" });
      expect(byEvent.get(noActor.eventId)).toMatchObject({ triage: "BLOCKED", triageCode: "ACCOUNTING_ACTOR_MISSING" });
      expect(byEvent.get(outOfScope.eventId)).toMatchObject({ triage: "MANUAL_REVIEW" });
      expect(byEvent.has(posted.eventId)).toBe(false);
      expect(JSON.stringify(page)).not.toMatch(/Customer|971500000001|metadata/u);
      // The per-event preview is what proves READY (full certified precheck).
      expect((await recovery.preview(fixture.companyId, ready.eventId)).repairability).toBe("READY");
      expect((await recovery.preview(fixture.companyId, noActor.eventId)).blockers.map((b) => b.code)).toContain(
        "accounting_event_actor_missing",
      );
      // Filters, all in SQL.
      expect((await health.list(fixture.companyId, { repairability: "BLOCKED" })).items.map((row) => row.eventId)).toEqual([
        noActor.eventId,
      ]);
      expect((await health.list(fixture.companyId, { status: "posted" })).items.map((row) => row.eventId)).toContain(
        posted.eventId,
      );
      expect((await health.list(fixture.companyId, { eventType: "trader_receivable_reversed" })).total).toBe(1);
      const reference = byEvent.get(ready.eventId)!.businessReference!;
      expect((await health.list(fixture.companyId, { reference })).items[0]!.eventId).toBe(ready.eventId);
      expect((await health.list(fixture.companyId, { dateFrom: "2000-01-01", dateTo: "2000-01-31" })).total).toBe(0);
      const paged = await health.list(fixture.companyId, { page: 2, pageSize: 2 });
      expect(paged).toMatchObject({ page: 2, pageSize: 2, total: 3 });
      expect(paged.items).toHaveLength(1);
      // Bounded: transaction settings + ONE triage statement (+ begin/commit).
      expect(summaryStatements).toBe(5);
      expect(listStatements).toBe(5);
      process.stdout.write(`accounting health SQL statements: summary=${summaryStatements} list=${listStatements}\n`);
    });
  });

  it("Part U: preview and execution run a fixed number of SQL statements", async () => {
    const fixture = await postingFixture();
    const { eventId } = await failedRecognition(fixture);
    let statements = 0;
    const counting = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === "query") statements += 1;
      },
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(counting)
      .compile();
    const countedRecovery = module.get(RepairAccountingRecoveryService, { strict: false });
    const countedExecutions = module.get(RepairExecutionService, { strict: false });
    statements = 0;
    const preview = await countedRecovery.preview(fixture.companyId, eventId);
    const previewStatements = statements;
    statements = 0;
    const countedStore = module.get(RequestSecurityContextStore, { strict: false });
    await countedStore.run(
      {
        identity: {
          companyId: null,
          forcePasswordChange: false,
          identityId: adminId,
          kind: "platform_administrator",
          permissions: new Set(["platform.access"]),
          sessionId: randomUUID(),
        },
        tenant: { companyId: fixture.companyId, identityId: adminId },
      } as never,
      () =>
      countedExecutions.executeAccountingEvent(
        fixture.companyId,
        eventId,
        {
          capabilityCode: "REPROCESS_ACCOUNTING_EVENT",
          findingId: preview.finding.findingId,
          idempotencyKey: `rc-acc-${randomUUID()}`,
          previewVersion: preview.previewVersion,
          reason: "Statement count",
        },
        actor(),
      ),
    );
    const executionStatements = statements;
    process.stdout.write(`accounting recovery SQL statements: preview=${previewStatements} execution=${executionStatements}\n`);
    expect(previewStatements).toBeLessThan(40);
    expect(executionStatements).toBeLessThan(120);
  }, 120_000);
});
