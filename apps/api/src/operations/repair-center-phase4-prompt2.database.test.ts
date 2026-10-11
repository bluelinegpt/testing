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

/**
 * REPAIR CENTER PHASE 4 PROMPT 2 -- ACCOUNTING RECOVERY FINAL CERTIFICATION
 * (final matrix 1-60; items already certified by the Prompt 1 suite are
 * re-asserted here where Prompt 2 adds a dimension, and mapped in the docs).
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

describe.skipIf(!runDatabaseTests)("Repair Center Phase 4 Prompt 2 -- accounting recovery final certification", () => {
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

  const key = (label: string) => `rc4p2.${label}.${randomUUID()}`;

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`RC4P2-${tag}`},${`rc4p2-${tag}`},${`RC4P2 ${mode} ${tag}`},
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
  // Timeline helpers (configuration history crafted with exact timestamps)
  // ===========================================================================

  const T1 = "2026-01-01T00:00:00.000Z";
  const T2 = "2026-02-01T00:00:00.000Z";
  const T3 = "2026-03-01T00:00:00.000Z";
  const T4 = "2026-04-01T00:00:00.000Z";
  const BEFORE = "2025-12-15T00:00:00.000Z";
  const just = (at: string, deltaMs: number) => new Date(Date.parse(at) + deltaMs).toISOString();

  /** A Company whose configuration history is exactly `rows`; `current` null = no configuration row. */
  async function timeline(rows: readonly { at: string; on: boolean }[], current: boolean | null) {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`TL-${tag}`},${`tl-${tag}`},${`Timeline ${tag}`},'active',now())`.execute(db);
    let version = 0;
    for (const row of rows) {
      version += 1;
      await sql`insert into accounting_configuration_history(company_id, configuration_version, configuration_snapshot, created_at)
        values (${companyId}::uuid, ${version}, ${JSON.stringify({ accounting_enabled: row.on })}::jsonb, ${row.at}::timestamptz)`.execute(db);
    }
    if (current !== null) {
      // Crafted: the row as it stands now, without writing another snapshot.
      await crafted(sql`insert into accounting_configurations(company_id, accounting_enabled, version)
        values (${companyId}::uuid, ${current}, ${Math.max(1, version)})`);
    }
    return companyId;
  }

  /** The SQL function and the Accounting Health intervals, for one instant. */
  async function modeAt(companyId: string, at: string) {
    const result = await sql<{ fn: boolean; iv: boolean }>`
      with ${accountingOnIntervalsSql(companyId)}
      select accounting_enabled_at(${companyId}::uuid, ${at}::timestamptz) as fn,
             exists (select 1 from on_iv where ${at}::timestamptz >= from_ts
                       and (to_ts is null or ${at}::timestamptz < to_ts)) as iv`.execute(db);
    const row = result.rows[0]!;
    // Parity: ONE rule, two evaluation strategies.
    expect(row.iv, `intervals vs accounting_enabled_at at ${at}`).toBe(row.fn);
    return row.fn;
  }

  async function expectTimeline(companyId: string, expectations: readonly [string, boolean][]) {
    for (const [at, expected] of expectations) {
      expect(await modeAt(companyId, at), `required at ${at}`).toBe(expected);
    }
  }

  // ===========================================================================
  // 1-11 (timeline matrix 1-14): the authoritative Accounting mode timeline.
  // ===========================================================================
  describe("authoritative Accounting mode timeline (configuration history)", () => {
    it("T1 / final 1: never configured -> OFF at every instant", async () => {
      await expectTimeline(await timeline([], null), [[BEFORE, false], [T2, false], [new Date().toISOString(), false]]);
    });

    it("T2 / final 2: default OFF (a configuration row created OFF) -> OFF", async () => {
      await expectTimeline(await timeline([{ at: T1, on: false }], false), [[BEFORE, false], [T1, false], [T3, false]]);
    });

    it("T3 / final 3: OFF -> ON -> required from the enable instant only", async () => {
      await expectTimeline(await timeline([{ at: T1, on: false }, { at: T2, on: true }], true), [
        [BEFORE, false],
        [T1, false],
        [just(T2, -1), false],
        [T2, true],
        [T4, true],
      ]);
    });

    it("T4 / final 4: ON -> OFF -> not required from the disable instant", async () => {
      await expectTimeline(await timeline([{ at: T1, on: true }, { at: T2, on: false }], false), [
        [BEFORE, false],
        [T1, true],
        [just(T2, -1), true],
        [T2, false],
        [T4, false],
      ]);
    });

    it("T5: OFF -> ON -> OFF -> only the ON interval is required", async () => {
      await expectTimeline(await timeline([{ at: T1, on: false }, { at: T2, on: true }, { at: T3, on: false }], false), [
        [T1, false],
        [T2, true],
        [just(T3, -1), true],
        [T3, false],
        [T4, false],
      ]);
    });

    it("T6 + T10 + T13 + T14 / final 5, 10, 11: ON -> OFF -> ON -> both ON intervals, never the OFF interval", async () => {
      await expectTimeline(await timeline([{ at: T1, on: true }, { at: T2, on: false }, { at: T3, on: true }], true), [
        [BEFORE, false],
        [T1, true],
        [just(T2, 1), false], // T13: source during the OFF interval
        [just(T3, -1), false],
        [T3, true], // T14: source in the second ON interval
        [T4, true],
      ]);
    });

    it("T7 / final 6: configuration row missing, no history -> OFF", async () => {
      await expectTimeline(await timeline([], null), [[T2, false]]);
    });

    it("T8 / final 7: configuration row missing with historical ON -> stale history never makes the Company ON", async () => {
      // The ONLY snapshot reads ON but the row is gone: nothing is required.
      await expectTimeline(await timeline([{ at: T1, on: true }], null), [[T1, false], [T4, false]]);
      // A recorded, CLOSED ON interval stays legitimate history; the open
      // trailing ON interval the missing row contradicts does not.
      await expectTimeline(await timeline([{ at: T1, on: true }, { at: T2, on: false }, { at: T3, on: true }], null), [
        [T1, true],
        [just(T2, -1), true],
        [T2, false],
        [T3, false],
        [T4, false],
      ]);
    });

    it("T9: current OFF while the last snapshot reads ON (mode change written without history) -> OFF", async () => {
      await expectTimeline(await timeline([{ at: T1, on: true }], false), [[T1, false], [T4, false]]);
      // With a recorded disable, the earlier interval is real history.
      await expectTimeline(await timeline([{ at: T1, on: true }, { at: T2, on: false }], false), [[T1, true], [T2, false]]);
    });

    it("T11 + T12 / final 8, 9: boundaries are exact -- enable instant inclusive, disable instant exclusive", async () => {
      const companyId = await timeline([{ at: T1, on: false }, { at: T2, on: true }, { at: T3, on: false }], false);
      await expectTimeline(companyId, [
        [just(T2, -1), false],
        [T2, true],
        [just(T2, 1), true],
        [just(T3, -1), true],
        [T3, false],
        [just(T3, 1), false],
      ]);
    });

    it("final 6/7 via the real configuration: deleting the row turns current mode OFF, keeps closed history", async () => {
      const fixture = await postingFixture(); // history: template insert + enable + automatic posting
      const now = new Date().toISOString();
      expect(await modeAt(fixture.companyId, now)).toBe(true);
      // Crafted: no application path deletes a configuration row (only direct
      // SQL or a whole-Company deletion); this is the reported state.
      await crafted(sql`delete from accounting_configurations where company_id = ${fixture.companyId}::uuid`);
      expect(await modeAt(fixture.companyId, now)).toBe(false);
      const summary = await health.summary(fixture.companyId);
      expect(summary).toMatchObject({ accountingHealth: "NOT_APPLICABLE", accountingMode: { enabled: false }, missingRequiredEvents: { total: 0 } });
    });

    it("configuration rows are never deleted by an application path (only whole-Company deletion)", async () => {
      const { readdirSync, readFileSync, statSync } = await import("node:fs");
      const { join } = await import("node:path");
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (statSync(path).isDirectory()) walk(path);
          else if (/\.ts$/u.test(name) && !/\.test\.ts$/u.test(name)) {
            const text = readFileSync(path, "utf8");
            if (/delete\s+from\s+accounting_configuration/iu.test(text)) offenders.push(path);
          }
        }
      };
      walk(join(process.cwd(), "src"));
      expect(offenders).toEqual([]);
    });
  });

  // ===========================================================================
  // 12-18: Company Health / Accounting Health parity and capture parity.
  // ===========================================================================
  describe("one rule everywhere: capture, Company Health, Accounting Health", () => {
    async function orderMissingInCompanyHealth(fixture: Fixture, orderId: string) {
      const analysis = await asPlatform(fixture.companyId, () => previews.analyze(fixture.companyId, orderId));
      return analysis.findings.some((finding) => finding.reasonCode === "ORDER_MISSING_ACCOUNTING_EVENT");
    }

    async function missingSources(fixture: Fixture) {
      const page = await health.integrityFindings(fixture.companyId, { kind: "MISSING_REQUIRED_EVENT", pageSize: 100 });
      return new Set(page.items.map((row) => `${row.eventType}:${row.sourceId}`));
    }

    async function eventsFor(fixture: Fixture, sourceId: string) {
      return (
        await sql<{ type: string; id: string; status: string }>`select event_type as type, id, processing_status as status
          from accounting_events where company_id = ${fixture.companyId}::uuid and source_entity_id = ${sourceId}::uuid`.execute(db)
      ).rows;
    }

    it("12: Company Health and Accounting Health agree for ON / OFF / re-ON Orders, and after the row is deleted", async () => {
      const fixture = await postingFixture();
      const first = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      await setAccounting(fixture, false);
      const during = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      await setAccounting(fixture, true);
      const last = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      for (const orderId of [first, during, last]) expect(await orderMissingInCompanyHealth(fixture, orderId)).toBe(false);
      await crafted(sql`delete from accounting_events where company_id = ${fixture.companyId}::uuid
        and event_type = 'order_delivered' and source_entity_id in (${first}::uuid, ${last}::uuid)`);
      const parity = async (expected: Record<string, boolean>) => {
        const missing = await missingSources(fixture);
        for (const [orderId, required] of Object.entries(expected)) {
          expect(missing.has(`order_delivered:${orderId}`), `Accounting Health ${orderId}`).toBe(required);
          expect(await orderMissingInCompanyHealth(fixture, orderId), `Company Health ${orderId}`).toBe(required);
        }
      };
      await parity({ [first]: true, [during]: false, [last]: true });
      // The reported corruption: the configuration row disappears. The first
      // ON interval is closed, recorded history (still required); the open
      // trailing interval is no longer proven (not required) -- in BOTH.
      await crafted(sql`delete from accounting_configurations where company_id = ${fixture.companyId}::uuid`);
      await parity({ [first]: true, [during]: false, [last]: false });
    });

    it("13-18: for all six forward types, an event is captured exactly when Health requires one", async () => {
      const fixture = await postingFixture();
      // --- ON: one source per type (unposted events only, so they can be removed).
      const onOrder = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      const onFee = await feeOrder(fixture);
      const onCollection = await collect(fixture, onFee.receivableId);
      const onSettle = await settle(fixture);
      const onReconciliation = await reconciliationOf(fixture, onSettle.payable);
      const onCredit = await creditFixture(fixture);
      const on = {
        driver_collection_confirmed: onReconciliation,
        order_delivered: onOrder,
        trader_credit_issued: onCredit.creditId,
        trader_receivable_payment_received: onCollection,
        trader_receivable_recognized: onFee.receivableId,
        trader_settlement_confirmed: onSettle.settlementId,
      } as const;
      for (const [type, sourceId] of Object.entries(on)) {
        expect((await eventsFor(fixture, sourceId)).map((event) => event.type), `captured ${type}`).toContain(type);
      }
      expect((await health.summary(fixture.companyId)).missingRequiredEvents.total).toBe(0);
      // --- OFF: the same six operations capture nothing and require nothing.
      await setAccounting(fixture, false);
      const offOrder = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      const offFee = await feeOrder(fixture);
      const offCollection = await collect(fixture, offFee.receivableId);
      const offSettle = await settle(fixture);
      const offReconciliation = await reconciliationOf(fixture, offSettle.payable);
      const creditFee = await feeOrder(fixture);
      await settle(fixture, creditFee.receivableId);
      await as(fixture, () => get(ReceivableOffsetReversalService).execute(creditFee.receivableId, "Fee reset", randomUUID()));
      const offCredit = (
        await sql<{ id: string }>`select id from trader_credits where company_id = ${fixture.companyId}::uuid
          and source_receivable_id = ${creditFee.receivableId}::uuid`.execute(db)
      ).rows[0]!.id;
      const off = [offOrder, offFee.receivableId, offCollection, offSettle.settlementId, offReconciliation, offCredit];
      for (const sourceId of off) expect(await eventsFor(fixture, sourceId), `OFF source ${sourceId}`).toEqual([]);
      expect((await health.summary(fixture.companyId)).missingRequiredEvents.total).toBe(0);
      // --- Remove every ON capture (crafted): Health requires EXACTLY those six.
      for (const [type, sourceId] of Object.entries(on)) {
        await crafted(sql`delete from accounting_events where company_id = ${fixture.companyId}::uuid
          and event_type = ${type} and source_entity_id = ${sourceId}::uuid and processing_status <> 'posted'`);
      }
      const missing = await missingSources(fixture);
      expect([...missing].sort()).toEqual(Object.entries(on).map(([type, sourceId]) => `${type}:${sourceId}`).sort());
      for (const sourceId of off) expect([...missing].some((entry) => entry.endsWith(sourceId))).toBe(false);
    });
  });

  // ===========================================================================
  // 19-25: READY end to end, five types + the conditional Credit.
  // ===========================================================================
  describe("supported recovery, end to end", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await postingFixture();
    }, 300_000);

    async function prove(eventId: string) {
      const event = (
        await sql<{ actor: string; sourceType: string; sourceId: string }>`select actor_id::text as actor, source_entity_type as "sourceType",
          source_entity_id::text as "sourceId" from accounting_events where id = ${eventId}::uuid`.execute(db)
      ).rows[0]!;
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview.finding).toMatchObject({ current: true, health: "ISSUE", repairCapability: "REPROCESS_ACCOUNTING_EVENT" });
      expect(preview.repairability, JSON.stringify(preview.blockers)).toBe("READY");
      expect(preview.recovery).toMatchObject({
        fiscalPeriod: { status: "open" },
        mappings: { state: "RESOLVED" },
        originalActor: { state: "VALID" },
        source: { state: "PRESENT" },
      });
      const request = await requestFor(fixture, eventId);
      const result = await run(fixture, eventId, request);
      expect(result).toMatchObject({ afterClassification: "posted", afterHealth: "HEALTHY", replayed: false, status: "succeeded" });
      expect(await eventRow(eventId)).toMatchObject({ errorCode: null, reviewer: null, status: "posted" });
      const journals = await journalsFor(eventId);
      expect(journals).toHaveLength(1);
      expect(journals[0]!.status).toBe("posted");
      expect(journals[0]!.debit).toBe(journals[0]!.credit);
      expect(Number(journals[0]!.debit)).toBeGreaterThan(0);
      const journal = (
        await sql<{ created: string; posted: string; sourceType: string; sourceId: string; company: string }>`
          select created_by_account_id::text as created, posted_by_account_id::text as posted, source_entity_type as "sourceType",
                 source_entity_id::text as "sourceId", company_id::text as company
            from journal_entries where accounting_event_id = ${eventId}::uuid`.execute(db)
      ).rows;
      expect(journal).toEqual([
        { company: fixture.companyId, created: event.actor, posted: event.actor, sourceId: event.sourceId, sourceType: event.sourceType },
      ]);
      expect(event.actor).not.toBe(adminId);
      expect((await recovery.details(fixture.companyId, eventId)).finding).toMatchObject({ current: false, health: "HEALTHY" });
      // A second execution never duplicates: the same request replays, a new key is refused.
      expect(await run(fixture, eventId, request)).toEqual({ ...result, replayed: true });
      await refused(fixture, eventId, { ...request, idempotencyKey: `rc-acc-${randomUUID()}` }, "repair_finding_not_current");
      expect(await journalsFor(eventId)).toHaveLength(1);
      return result;
    }

    it("19: failed order_delivered", async () => {
      const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      const eventId = await eventOf(fixture, "order", orderId, "order_delivered");
      await craftFailed(eventId);
      await prove(eventId);
    });

    it("20: failed trader_receivable_recognized", async () => {
      await prove((await failedRecognition(fixture)).eventId);
    });

    it("21: failed trader_receivable_payment_received", async () => {
      const { receivableId } = await feeOrder(fixture);
      await postNow(fixture, await eventOf(fixture, "trader_receivable", receivableId, "trader_receivable_recognized"));
      const eventId = await eventOf(fixture, "trader_collection", await collect(fixture, receivableId), "trader_receivable_payment_received");
      await craftFailed(eventId);
      await prove(eventId);
    });

    it("24: failed trader_settlement_confirmed", async () => {
      const { payable, settlementId } = await settle(fixture);
      await postNow(fixture, await eventOf(fixture, "order", payable, "order_delivered"));
      const eventId = await eventOf(fixture, "trader_settlement", settlementId, "trader_settlement_confirmed");
      await craftFailed(eventId);
      await prove(eventId);
    });

    it("25: failed driver_collection_confirmed", async () => {
      const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      await postNow(fixture, await eventOf(fixture, "order", orderId, "order_delivered"));
      await reconcileCash(fixture, orderId);
      const eventId = await eventOf(fixture, "driver_reconciliation", await reconciliationOf(fixture, orderId), "driver_collection_confirmed");
      await craftFailed(eventId);
      await prove(eventId);
    });

    it("22: trader_credit_issued with a valid posted Settlement -> READY -> recovered", async () => {
      const { eventId } = await creditFixture(fixture);
      await craftFailed(eventId);
      await prove(eventId);
    });

    it("23: trader_credit_issued with a failed / missing / reversed / other-Company Settlement -> BLOCKED, never recovered", async () => {
      const blocked = async (eventId: string) => {
        const preview = await recovery.preview(fixture.companyId, eventId);
        expect(preview.repairability).toBe("BLOCKED");
        expect(preview.blockers.map((blocker) => blocker.code)).toContain("trader_credit_settlement_not_posted");
        expect(preview.execution.available).toBe(false);
        await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_not_ready");
        expect(await journalsFor(eventId)).toEqual([]);
      };
      // Failed Settlement event.
      const failed = await creditFixture(fixture);
      await craftFailed(failed.eventId);
      const failedSettlementEvent = await eventOf(fixture, "trader_settlement", failed.settlementId, "trader_settlement_confirmed");
      await crafted(sql`update accounting_events set processing_status = 'failed' where id = ${failedSettlementEvent}::uuid`);
      await blocked(failed.eventId);
      // Reversed Settlement event (its GL posting was reversed).
      const reversed = await creditFixture(fixture);
      await craftFailed(reversed.eventId);
      const reversedSettlementEvent = await eventOf(fixture, "trader_settlement", reversed.settlementId, "trader_settlement_confirmed");
      await crafted(sql`update accounting_events set processing_status = 'reversed' where id = ${reversedSettlementEvent}::uuid`);
      await blocked(reversed.eventId);
      // Missing Settlement (crafted: the Credit names a Settlement that does not exist).
      const missing = await creditFixture(fixture);
      await craftFailed(missing.eventId);
      await crafted(sql`update trader_credits set source_settlement_id = ${randomUUID()}::uuid where id = ${missing.creditId}::uuid`);
      await blocked(missing.eventId);
      // Another Company's Settlement: the schema refuses it (composite FK)...
      const other = await postingFixture();
      const foreign = await settle(other);
      const wrong = await creditFixture(fixture);
      await expect(
        sql`update trader_credits set source_settlement_id = ${foreign.settlementId}::uuid where id = ${wrong.creditId}::uuid`.execute(db),
      ).rejects.toThrow(/trader_credits_settlement_fk/u);
      // ...and even crafted past the FK, a Settlement of another Company is never used.
      await craftFailed(wrong.eventId);
      await postNow(other, await eventOf(other, "order", foreign.payable, "order_delivered"));
      await postNow(other, await eventOf(other, "trader_settlement", foreign.settlementId, "trader_settlement_confirmed"));
      await crafted(sql`update trader_credits set source_settlement_id = ${foreign.settlementId}::uuid where id = ${wrong.creditId}::uuid`);
      await blocked(wrong.eventId);
    });
  });

  async function attemptsOf(fixture: Fixture, eventId: string) {
    return (
      await sql<{ result: string; code: string | null }>`select result, error_code as code from platform_repair_attempts
        where company_id = ${fixture.companyId}::uuid and entity_id = ${eventId}::uuid order by created_at, id`.execute(db)
    ).rows.map((row) => [row.result, row.code]);
  }

  // ===========================================================================
  // 32-38: blocked matrix -- precise blocker, no Execute, zero mutation,
  // durable REFUSED attempt.
  // ===========================================================================
  describe("blocked recovery matrix (each on its own Company)", () => {
    const cases: readonly {
      readonly name: string;
      readonly code: RegExp;
      readonly mutate: (fixture: Fixture, eventId: string) => Promise<void>;
    }[] = [
      {
        code: /^accounting_event_period_closed$/u,
        mutate: async (fixture) =>
          crafted(sql`update accounting_periods set status = 'closed', closed_at = now(),
              closed_by_account_id = ${fixture.actorId}::uuid, close_reason = 'Crafted close'
            where company_id = ${fixture.companyId}::uuid and current_date between period_start and period_end`),
        name: "32 closed fiscal period",
      },
      {
        code: /period/u,
        mutate: async (fixture) =>
          crafted(sql`delete from accounting_periods
            where company_id = ${fixture.companyId}::uuid and current_date between period_start and period_end`),
        name: "33 missing fiscal period",
      },
      {
        code: /mapping/u,
        mutate: async (fixture) =>
          crafted(sql`update account_mappings set is_active = false where company_id = ${fixture.companyId}::uuid`),
        name: "34 missing mapping",
      },
      {
        code: /account|mapping/u,
        mutate: async (fixture, eventId) => {
          const code = (await recovery.preview(fixture.companyId, eventId)).recovery.mappings.lines[0]!.accountCode;
          await crafted(sql`update chart_of_accounts set is_active = false
            where company_id = ${fixture.companyId}::uuid and code = ${code}`);
        },
        name: "35 disabled mapped account",
      },
      {
        code: /^accounting_event_actor_missing$/u,
        mutate: async (_fixture, eventId) =>
          crafted(sql`update accounting_events set actor_id = null where id = ${eventId}::uuid`),
        name: "36 missing original actor",
      },
      {
        code: /^accounting_event_actor_invalid$/u,
        mutate: async (_fixture, eventId) => {
          const other = await createFixture("off");
          await crafted(sql`update accounting_events set actor_id = ${other.actorId}::uuid where id = ${eventId}::uuid`);
        },
        name: "37 actor of another Company",
      },
      {
        code: /^ACCOUNTING_EVENT_PROCESSING$/u,
        mutate: async (_fixture, eventId) =>
          crafted(sql`update accounting_events set processing_status = 'processing', processing_locked_at = now(),
              processing_locked_by = 'phase4-test-worker' where id = ${eventId}::uuid`),
        name: "38 event already processing",
      },
    ];

    for (const testCase of cases) {
      it(`${testCase.name} -> BLOCKED, no Execute, zero mutation, durable REFUSED attempt`, async () => {
        const fixture = await postingFixture();
        const { eventId } = await failedRecognition(fixture);
        await testCase.mutate(fixture, eventId);
        const preview = await recovery.preview(fixture.companyId, eventId);
        expect(preview.repairability).toBe("BLOCKED");
        expect(preview.blockers.map((blocker) => blocker.code).some((code) => testCase.code.test(code)), JSON.stringify(preview.blockers)).toBe(true);
        expect(preview.execution.available).toBe(false);
        const request = await requestFor(fixture, eventId);
        const before = await footprint(fixture.companyId);
        await expect(run(fixture, eventId, request)).rejects.toMatchObject({
          errorCode: preview.finding.current ? "repair_not_ready" : "repair_finding_not_current",
        });
        expect(await footprint(fixture.companyId)).toBe(before);
        expect(await journalsFor(eventId)).toEqual([]);
        expect((await attemptsOf(fixture, eventId)).map(([result]) => result)).toEqual(["REFUSED"]);
      });
    }

    it("automatic-posting restriction -> BLOCKED automatic_posting_disabled in list and preview, refused, zero mutation", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      await sql`update accounting_configurations set automatic_posting_enabled = false,
          automatic_posting_enabled_by_account_id = null, automatic_posting_enabled_at = null, version = version + 1
        where company_id = ${fixture.companyId}::uuid`.execute(db);
      const row = (await health.list(fixture.companyId, {})).items.find((item) => item.eventId === eventId)!;
      expect(row).toMatchObject({ triage: "BLOCKED", triageCode: "AUTOMATIC_POSTING_DISABLED" });
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview.repairability).toBe("BLOCKED");
      expect(preview.blockers.map((blocker) => blocker.code)).toContain("automatic_posting_disabled");
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_not_ready");
      expect((await attemptsOf(fixture, eventId)).map(([result]) => result)).toEqual(["REFUSED"]);
    });
  });

  // ===========================================================================
  // 39-42 + 26: manual review / out of scope / Accounting OFF / missing events.
  // ===========================================================================
  describe("manual review, out of scope, Accounting OFF", () => {
    it("26: a missing-event finding never exposes a Platform execution path", async () => {
      const fixture = await postingFixture();
      const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      await crafted(sql`delete from accounting_events where company_id = ${fixture.companyId}::uuid and source_entity_id = ${orderId}::uuid`);
      const [row] = (await health.integrityFindings(fixture.companyId, { kind: "MISSING_REQUIRED_EVENT" })).items;
      expect(row).toMatchObject({ eventId: null, repairability: "MANUAL_REVIEW", sourceId: orderId });
      expect(Object.keys(row!)).not.toContain("repairCapability");
      // No event exists, so the only execution route (by event id) cannot target it.
      await expect(recovery.preview(fixture.companyId, orderId)).rejects.toMatchObject({ errorCode: "accounting_event_not_found" });
      const before = await footprint(fixture.companyId);
      await expect(
        asPlatform(fixture.companyId, () =>
          executions.executeAccountingEvent(
            fixture.companyId,
            orderId,
            { capabilityCode: "REPROCESS_ACCOUNTING_EVENT", findingId: "fnd_000000000000000000000000", idempotencyKey: `x-${randomUUID()}`, previewVersion: "rcv1:x", reason: "try" },
            actor(),
          ),
        ),
      ).rejects.toMatchObject({ errorCode: "accounting_event_not_found" });
      expect(await footprint(fixture.companyId)).toBe(before);
    });

    it("42 + 16: Accounting OFF -> historical failure NOT_REQUIRED, OFF activity never required, Accounting never enabled", async () => {
      const fixture = await postingFixture();
      const { eventId } = await failedRecognition(fixture);
      await setAccounting(fixture, false);
      const preview = await recovery.preview(fixture.companyId, eventId);
      expect(preview).toMatchObject({ execution: { available: false }, repairability: "NOT_REQUIRED" });
      await refused(fixture, eventId, await requestFor(fixture, eventId), "repair_not_ready");
      const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      await reconcileCash(fixture, orderId);
      expect((await health.summary(fixture.companyId)).missingRequiredEvents.total).toBe(0);
      const analysis = await asPlatform(fixture.companyId, () => previews.analyze(fixture.companyId, orderId));
      expect(analysis.health).toBe("HEALTHY");
      const mode = (await sql<{ on: boolean; version: string }>`select accounting_enabled as on, version::text as version
        from accounting_configurations where company_id = ${fixture.companyId}::uuid`.execute(db)).rows[0]!;
      expect(mode.on).toBe(false);
    });
  });

  // ===========================================================================
  // 43-48 (+ mode, Credit Settlement): stale preview per dimension.
  // ===========================================================================
  describe("stale preview, one dimension at a time", () => {
    const dimensions: readonly { readonly name: string; readonly credit?: boolean; readonly mutate: (fixture: Fixture, ids: { eventId: string; sourceId: string; settlementId?: string }) => Promise<void> }[] = [
      { mutate: async (_f, ids) => crafted(sql`update accounting_events set attempt_count = attempt_count + 1 where id = ${ids.eventId}::uuid`), name: "43 event state" },
      { mutate: async (_f, ids) => crafted(sql`update trader_receivables set updated_at = updated_at + interval '1 second' where id = ${ids.sourceId}::uuid`), name: "44 source state" },
      { mutate: async (f) => crafted(sql`update accounting_periods set version = version + 1 where company_id = ${f.companyId}::uuid and current_date between period_start and period_end`), name: "45 fiscal period" },
      { mutate: async (f) => crafted(sql`update account_mappings set effective_from = effective_from - 1 where id = (select id from account_mappings where company_id = ${f.companyId}::uuid order by id limit 1)`), name: "46 mapping" },
      { mutate: async (f) => crafted(sql`update chart_of_accounts set version = version + 1 where id = (select id from chart_of_accounts where company_id = ${f.companyId}::uuid order by id limit 1)`), name: "46b mapped account" },
      { mutate: async (f) => crafted(sql`update accounts set status = 'active' where id = ${f.actorId}::uuid`), name: "47 actor state" },
      {
        mutate: async (f, ids) =>
          crafted(sql`insert into journal_entries (id, company_id, journal_number, accounting_period_id, fiscal_year_id, business_date,
                journal_type, source_type, description, status, accounting_event_id, created_by_account_id)
              select gen_random_uuid(), ${f.companyId}::uuid, 'JV-STALE-' || substr(md5(random()::text), 1, 6), p.id, p.fiscal_year_id,
                     current_date, 'operational', 'trader_receivable', 'Crafted journal', 'draft', ${ids.eventId}::uuid, ${f.actorId}::uuid
                from accounting_periods p where p.company_id = ${f.companyId}::uuid and current_date between p.period_start and p.period_end`),
        name: "48 journal state",
      },
      { mutate: async (f) => crafted(sql`update accounting_configurations set version = version + 1 where company_id = ${f.companyId}::uuid`), name: "accounting mode / configuration" },
      {
        credit: true,
        mutate: async (f, ids) =>
          // The Settlement's own event stops being Posted (its journal untouched).
          crafted(sql`update accounting_events set processing_status = 'failed'
            where company_id = ${f.companyId}::uuid and source_entity_id = ${ids.settlementId!}::uuid
              and event_type = 'trader_settlement_confirmed'`),
        name: "Trader Credit Settlement state",
      },
    ];

    for (const dimension of dimensions) {
      it(`${dimension.name} changed after a READY preview -> 409 repair_preview_stale, zero mutation`, async () => {
        const fixture = await postingFixture();
        let ids: { eventId: string; sourceId: string; settlementId?: string };
        if (dimension.credit === true) {
          const credit = await creditFixture(fixture);
          await craftFailed(credit.eventId);
          ids = { eventId: credit.eventId, settlementId: credit.settlementId, sourceId: credit.creditId };
        } else {
          const failed = await failedRecognition(fixture);
          ids = { eventId: failed.eventId, sourceId: failed.receivableId };
        }
        const preview = await recovery.preview(fixture.companyId, ids.eventId);
        expect(preview.repairability, JSON.stringify(preview.blockers)).toBe("READY");
        const request = await requestFor(fixture, ids.eventId);
        await dimension.mutate(fixture, ids);
        expect((await recovery.preview(fixture.companyId, ids.eventId)).previewVersion).not.toBe(request.previewVersion);
        // A Journal appearing for the event also re-classifies it (linkage,
        // MANUAL_REVIEW): the refusal is then "no certified recovery", still a
        // 409 with zero mutation. Every other dimension is the stale refusal.
        await refused(
          fixture,
          ids.eventId,
          request,
          dimension.name.startsWith("48") ? "repair_capability_not_applicable" : "repair_preview_stale",
        );
        expect(await journalsFor(ids.eventId)).toEqual(
          dimension.name.startsWith("48") ? [expect.objectContaining({ status: "draft" })] : [],
        );
      });
    }
  });

  // ===========================================================================
  // 54-57: durable audit identifies the Platform actor, Company, event,
  // finding, capability, result, time and reason / blocker.
  // ===========================================================================
  it("54-57: SUCCEEDED / FAILED / REFUSED / REPLAYED audit rows, Platform actor only", async () => {
    const fixture = await postingFixture();
    const { eventId } = await failedRecognition(fixture);
    // REFUSED (stale).
    await refused(fixture, eventId, await requestFor(fixture, eventId, { previewVersion: `rcv1:${"0".repeat(64)}` }), "repair_preview_stale");
    // FAILED (posting core fails, everything rolled back).
    const request = await requestFor(fixture, eventId);
    vi.spyOn(get(OperationalJournalPostingService), "process").mockRejectedValueOnce(
      new ApplicationException("accounting_journal_number_generation_failed", "forced", 409),
    );
    await expect(run(fixture, eventId, request)).rejects.toMatchObject({ errorCode: "accounting_journal_number_generation_failed" });
    // SUCCEEDED, then REPLAYED.
    const result = await run(fixture, eventId, request);
    await run(fixture, eventId, request);
    const success = (
      await sql<Record<string, unknown>>`select company_id::text as company, actor_account_id::text as actor, actor_authority as authority,
          entity_type as "entityType", entity_id::text as entity, finding_id as finding, capability_code as capability,
          result, reason, created_at is not null as "hasTime"
        from platform_repair_executions where company_id = ${fixture.companyId}::uuid and entity_id = ${eventId}::uuid`.execute(db)
    ).rows;
    expect(success).toEqual([
      {
        actor: adminId,
        authority: "platform.companies.repair_center.execute",
        capability: "REPROCESS_ACCOUNTING_EVENT",
        company: fixture.companyId,
        entity: eventId,
        entityType: "accounting_event",
        finding: request.findingId,
        hasTime: true,
        reason: request.reason,
        result: expect.stringMatching(/succeeded/iu),
      },
    ]);
    const attempts = (
      await sql<Record<string, unknown>>`select company_id::text as company, actor_account_id::text as actor, entity_id::text as entity,
          finding_id as finding, capability_code as capability, result, error_code as code, reason,
          repair_execution_id::text as execution, created_at is not null as "hasTime"
        from platform_repair_attempts where company_id = ${fixture.companyId}::uuid and entity_id = ${eventId}::uuid
        order by created_at, id`.execute(db)
    ).rows;
    expect(attempts.map((row) => [row.result, row.code])).toEqual([
      ["REFUSED", "repair_preview_stale"],
      ["FAILED", "accounting_journal_number_generation_failed"],
      ["REPLAYED", null],
    ]);
    for (const row of attempts) {
      expect(row).toMatchObject({ actor: adminId, capability: "REPROCESS_ACCOUNTING_EVENT", company: fixture.companyId, entity: eventId, hasTime: true });
    }
    expect(attempts[2]!.execution).toBe(result.repairExecutionId);
    // No Company impersonation: the auditing actor is the Platform administrator
    // (no Company), the Journal belongs to the event's original operational actor.
    const kind = (await sql<{ kind: string; company: string | null }>`select account_kind as kind, company_id as company
      from accounts where id = ${adminId}::uuid`.execute(db)).rows[0]!;
    expect(kind).toEqual({ company: null, kind: "platform_administrator" });
    const journal = (await sql<{ created: string }>`select created_by_account_id::text as created from journal_entries
      where accounting_event_id = ${eventId}::uuid`.execute(db)).rows[0]!;
    expect(journal.created).toBe(fixture.actorId);
  });
});
