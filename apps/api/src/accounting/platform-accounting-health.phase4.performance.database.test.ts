import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { RepairAccountingRecoveryService } from "../operations/repair-accounting-recovery.service.js";
import { RepairExecutionService } from "../operations/repair-execution.service.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { PlatformAccountingHealthService } from "./platform-accounting-health.service.js";

/**
 * Repair Center Phase 4 Prompt 1 -- Accounting Health at ~150,000 Orders and
 * 100,000 accounting events, WITH journal integrity and missing-event
 * detection.
 *
 * Opt-in and disposable-only: RUN_ACCOUNTING_HEALTH_PERFORMANCE=true against a
 * database whose name contains "perf". It reuses the Order Health performance
 * Company (150,000 delivered Orders, 74,000 Trader receivables, 100,000
 * events: 60,000 posted / 20,000 received / 15,000 failed / 3,000 failed
 * payroll / 1,000 blocked / 1,000 processing) and, once, with triggers
 * bypassed: turns GL Accounting ON for it with a configuration-history row
 * from 2020 (so every source is inside an ON interval and missing-event
 * detection scans all of them), gives it FY 2026, and gives every posted event
 * a real two-line Journal (600 of them deliberately unbalanced).
 */

const url = process.env.ACCOUNTING_HEALTH_PERF_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const runPerformance =
  process.env.RUN_ACCOUNTING_HEALTH_PERFORMANCE === "true" && /\/[^/]*perf[^/]*$/u.test(url);

const COMPANY = "0d0d0d0d-0000-4000-8000-000000150000";
const FISCAL = "0d0d0d0d-0000-4000-8000-0000004c1f01";
const ACTOR = "0d0d0d0d-0000-4000-8000-0000004c1a01";
const LINE_ACCOUNT = "0d0d0d0d-0000-4000-8000-0000004c1c01";

async function seed(db: Kysely<DatabaseSchema>) {
  const done = await sql<{ n: number }>`select count(*)::int as n from accounting_configuration_history
    where company_id = ${COMPANY}::uuid`.execute(db);
  if (done.rows[0]!.n > 0) return;
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = replica`.execute(tx);
    await sql`insert into accounts(id,company_id,account_kind,username,normalized_username,password_hash,status)
      values (${ACTOR}::uuid,${COMPANY}::uuid,'company_user','perf.p4.actor','perf.p4.actor','x','disabled')
      on conflict do nothing`.execute(tx);
    await sql`insert into accounting_configurations(company_id,accounting_enabled,automatic_posting_enabled,
        automatic_posting_areas,automatic_posting_enabled_by_account_id,automatic_posting_enabled_at)
      values (${COMPANY}::uuid,true,true,array['orders','trader_receivables','trader_settlements','driver_collections','employee_payroll'],
        ${ACTOR}::uuid,now()) on conflict (company_id) do nothing`.execute(tx);
    await sql`insert into accounting_configuration_history(company_id,configuration_version,configuration_snapshot,created_at)
      values (${COMPANY}::uuid,1,'{"accounting_enabled": true}'::jsonb,'2020-01-01T00:00:00Z')`.execute(tx);
    await sql`insert into fiscal_years(id,company_id,fiscal_year_code,name,start_date,end_date,status)
      values (${FISCAL}::uuid,${COMPANY}::uuid,'FY-2026','FY 2026','2026-01-01','2026-12-31','open')
      on conflict do nothing`.execute(tx);
    await sql`insert into accounting_periods(id,company_id,fiscal_year_id,period_code,name,period_number,
        period_start,period_end,status)
      select gen_random_uuid(),${COMPANY}::uuid,${FISCAL}::uuid,'P'||lpad(m::text,2,'0'),'Period '||m,m,
             make_date(2026,m,1),(make_date(2026,m,1)+interval '1 month'-interval '1 day')::date,'open'
        from generate_series(1,12) m`.execute(tx);
    // One real two-line Journal per posted event (journal_id <-> accounting_event_id).
    await sql`create temporary table p4_posted on commit drop as
      select e.id as event_id, gen_random_uuid() as journal_id, e.source_entity_type, e.source_entity_id,
             e.effective_accounting_date as d, row_number() over (order by e.id) as n
        from accounting_events e
       where e.company_id = ${COMPANY}::uuid and e.processing_status = 'posted'`.execute(tx);
    await sql`insert into journal_entries(id,company_id,journal_number,accounting_period_id,fiscal_year_id,business_date,
        journal_type,source_type,source_id,description,status,source_entity_type,source_entity_id,accounting_event_id,
        created_by_account_id,posted_by_account_id,posted_at,approved_by_account_id,approved_at,total_debit,total_credit)
      select p.journal_id,${COMPANY}::uuid,'JV-P4-'||lpad(p.n::text,7,'0'),
             (select ap.id from accounting_periods ap where ap.company_id=${COMPANY}::uuid and p.d between ap.period_start and ap.period_end),
             ${FISCAL}::uuid,p.d,'operational','trader_receivable',p.source_entity_id,'perf journal','posted',
             p.source_entity_type,p.source_entity_id,p.event_id,${ACTOR}::uuid,${ACTOR}::uuid,now(),${ACTOR}::uuid,now(),18,18
        from p4_posted p`.execute(tx);
    await sql`insert into journal_lines(company_id,journal_entry_id,line_number,account_id,debit,credit)
      select ${COMPANY}::uuid,p.journal_id,l.n,${LINE_ACCOUNT}::uuid,
             case when l.n = 1 then (case when p.n % 100 = 0 then 19 else 18 end) else 0 end,
             case when l.n = 2 then 18 else 0 end
        from p4_posted p cross join (values (1),(2)) as l(n)`.execute(tx);
    await sql`update accounting_events e set journal_id = p.journal_id
        from p4_posted p where e.id = p.event_id`.execute(tx);
  });
  await sql`analyze accounting_events`.execute(db);
  await sql`analyze journal_entries`.execute(db);
  await sql`analyze journal_lines`.execute(db);
}

describe.skipIf(!runPerformance)("Accounting Health -- Phase 4 Prompt 1 performance (150,000 Orders / 100,000 events)", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let statements = 0;
  let service: PlatformAccountingHealthService;
  let recovery: RepairAccountingRecoveryService;
  let executions: RepairExecutionService;
  let store: RequestSecurityContextStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 4 });
    db = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === "query") statements += 1;
      },
    });
    await seed(db);
    service = new PlatformAccountingHealthService(db);
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DATABASE).useValue(db).compile();
    recovery = module.get(RepairAccountingRecoveryService, { strict: false });
    executions = module.get(RepairExecutionService, { strict: false });
    store = module.get(RequestSecurityContextStore, { strict: false });
  }, 900_000);

  afterAll(async () => {
    await db?.destroy();
  });

  async function timed<T>(work: () => Promise<T>) {
    await work().catch(() => undefined);
    statements = 0;
    const started = performance.now();
    const result = await work().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    return { ms: performance.now() - started, result, statements };
  }

  it("summary, attention list, deep page, integrity findings, preview and a refused execution stay bounded", async () => {
    const summary = await timed(() => service.summary(COMPANY));
    const value = (summary.result as { value: Awaited<ReturnType<PlatformAccountingHealthService["summary"]>> }).value;
    expect(value).toMatchObject({
      accountingHealth: "ISSUE",
      failed: 18_000,
      integrity: { postedWithoutJournal: 0, total: 600, unbalancedJournals: 600 },
      totalEvents: 100_000,
    });
    // Every receivable / collection / settlement is inside the ON interval and
    // none has its event (the events' sources are synthetic): the worst case
    // for missing detection (73,500 current receivables + collections +
    // effective settlements).
    expect(value.missingRequiredEvents.total).toBeGreaterThanOrEqual(73_500);
    expect(value.headlines).toEqual([
      "ISSUE — Accounting event failed.",
      "ISSUE — Required accounting event is missing.",
      "ISSUE — Accounting journal does not match its event.",
      "REVIEW — Accounting history requires manual review.",
    ]);
    const attention = await timed(() => service.list(COMPANY, {}));
    const deep = await timed(() => service.list(COMPANY, { page: 150, pageSize: 100, status: "all" }));
    const integrityFirst = await timed(() => service.integrityFindings(COMPANY, {}));
    const integrityDeep = await timed(() => service.integrityFindings(COMPANY, { page: 700, pageSize: 100 }));
    const integrityJournal = await timed(() => service.integrityFindings(COMPANY, { kind: "JOURNAL_INTEGRITY" }));
    expect((integrityFirst.result as { value: { total: number } }).value.total).toBe(value.missingRequiredEvents.total + 600);
    expect((integrityJournal.result as { value: { total: number } }).value.total).toBe(600);
    const failedEvent = (
      await sql<{ id: string }>`select id from accounting_events where company_id = ${COMPANY}::uuid
        and processing_status = 'failed' and event_type = 'trader_receivable_recognized' order by id limit 1`.execute(db)
    ).rows[0]!.id;
    const preview = await timed(() => recovery.preview(COMPANY, failedEvent));
    const previewValue = (preview.result as { value?: { repairability: string; previewVersion: string; finding: { findingId: string } } }).value;
    expect(previewValue?.repairability).toBeDefined();
    const adminId = randomUUID();
    const execution = await timed(() =>
      store.run(
        {
          identity: {
            companyId: null,
            forcePasswordChange: false,
            identityId: adminId,
            kind: "platform_administrator",
            permissions: new Set(["platform.access"]),
            sessionId: randomUUID(),
          },
          tenant: { companyId: COMPANY, identityId: adminId },
        } as never,
        () =>
          executions.executeAccountingEvent(
            COMPANY,
            failedEvent,
            {
              capabilityCode: "REPROCESS_ACCOUNTING_EVENT",
              findingId: previewValue!.finding.findingId,
              idempotencyKey: `perf-${randomUUID()}`,
              previewVersion: previewValue!.previewVersion,
              reason: "Performance: refused (not READY in the synthetic Company)",
            },
            { accountId: adminId, authority: "platform.companies.repair_center.execute", correlationId: `perf-${randomUUID()}` },
          ),
      ),
    );
    for (const run of [summary, attention, deep, integrityFirst, integrityDeep, integrityJournal]) {
      expect(run.statements).toBe(5);
    }
    expect(summary.ms).toBeLessThan(15_000);
    expect(attention.ms).toBeLessThan(10_000);
    expect(integrityFirst.ms).toBeLessThan(15_000);
    expect(preview.statements).toBeLessThan(40);
    expect(execution.statements).toBeLessThan(40);
    process.stdout.write(
      `${JSON.stringify({
        fixture: { events: 100_000, journals: 60_000, missingRequired: value.missingRequiredEvents.total, orders: 150_000, receivables: 74_000 },
        ms: {
          executionRefused: Math.round(execution.ms),
          integrityDeepPage: Math.round(integrityDeep.ms),
          integrityFirstPage: Math.round(integrityFirst.ms),
          integrityJournalOnly: Math.round(integrityJournal.ms),
          listAttention: Math.round(attention.ms),
          listDeepPage: Math.round(deep.ms),
          preview: Math.round(preview.ms),
          summary: Math.round(summary.ms),
        },
        previewRepairability: previewValue?.repairability,
        statements: {
          executionRefused: execution.statements,
          integrity: integrityFirst.statements,
          list: attention.statements,
          preview: preview.statements,
          summary: summary.statements,
        },
      })}\n`,
    );
  }, 900_000);
});
