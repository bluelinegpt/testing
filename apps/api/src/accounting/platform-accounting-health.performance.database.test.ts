import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { PlatformAccountingHealthService } from "./platform-accounting-health.service.js";

/**
 * Phase 2 Prompt 4, Part U -- Accounting Health at 100,000 accounting events.
 *
 * Opt-in and disposable-only: runs with RUN_ACCOUNTING_HEALTH_PERFORMANCE=true
 * against a database whose name contains "perf". The fixture (one Company,
 * Accounting ON with automatic posting, FY 2026 open, 100,000 events) is
 * inserted once with triggers bypassed and reused:
 *   60,000 posted / 20,000 received / 15,000 failed supported /
 *    3,000 failed payroll (out of scope) / 1,000 blocked_configuration /
 *    1,000 processing (500 with a stale lock).
 */

const url = process.env.ACCOUNTING_HEALTH_PERF_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const runPerformance =
  process.env.RUN_ACCOUNTING_HEALTH_PERFORMANCE === "true" && /\/[^/]*perf[^/]*$/u.test(url);

const COMPANY = "0d0d0d0d-0000-4000-8000-0000000ac100";
const ACTOR = "0d0d0d0d-0000-4000-8000-0000000ac1a1";
const FISCAL = "0d0d0d0d-0000-4000-8000-0000000ac1f1";

async function seed(db: Kysely<DatabaseSchema>) {
  const exists = await sql<{ n: number }>`select count(*)::int as n from accounting_events
    where company_id = ${COMPANY}::uuid`.execute(db);
  if (exists.rows[0]!.n === 100_000) {
    // The fixture is reused across runs: re-anchor the processing locks to
    // "now" so 500 stay fresh and 500 stay stale (the stuck threshold is
    // time-relative). Disposable perf database only; triggers bypassed.
    await db.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = replica`.execute(tx);
      await sql`update accounting_events
          set processing_locked_at = now() - case when source_reference > 'REF-0099500' then interval '1 hour'
                                                  else interval '1 minute' end
        where company_id = ${COMPANY}::uuid and processing_status = 'processing'`.execute(tx);
    });
    return;
  }
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = replica`.execute(tx);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${COMPANY}::uuid,'PERF-ACC','perf-acc','Perf Accounting','active',now())
      on conflict do nothing`.execute(tx);
    await sql`insert into accounts(id,company_id,account_kind,username,normalized_username,password_hash,status)
      values (${ACTOR}::uuid,${COMPANY}::uuid,'company_user','perf.acc.actor','perf.acc.actor','x','disabled')
      on conflict do nothing`.execute(tx);
    await sql`insert into accounting_configurations(company_id,accounting_enabled,automatic_posting_enabled,
        automatic_posting_areas,automatic_posting_enabled_by_account_id,automatic_posting_enabled_at)
      values (${COMPANY}::uuid,true,true,array['orders','trader_receivables','trader_settlements','driver_collections','employee_payroll'],
        ${ACTOR}::uuid,now()) on conflict (company_id) do nothing`.execute(tx);
    await sql`insert into fiscal_years(id,company_id,fiscal_year_code,name,start_date,end_date,status)
      values (${FISCAL}::uuid,${COMPANY}::uuid,'FY-2026','FY 2026','2026-01-01','2026-12-31','open')
      on conflict do nothing`.execute(tx);
    await sql`insert into accounting_periods(id,company_id,fiscal_year_id,period_code,name,period_number,
        period_start,period_end,status)
      select gen_random_uuid(),${COMPANY}::uuid,${FISCAL}::uuid,'P'||lpad(m::text,2,'0'),'Period '||m,m,
             make_date(2026,m,1),(make_date(2026,m,1)+interval '1 month'-interval '1 day')::date,'open'
        from generate_series(1,12) m`.execute(tx);
    await sql`insert into accounting_events(company_id,event_type,event_version,source_entity_type,
        source_entity_id,source_reference,effective_accounting_date,currency,correlation_id,idempotency_key,
        event_hash,actor_id,actor_type,description,supplementary_metadata,processing_status,operational_area,
        attempt_count,failed_at,error_code,safe_error_summary,processing_locked_at)
      select ${COMPANY}::uuid,
             case when g > 95000 and g <= 98000 then 'employee_payroll_paid' else 'trader_receivable_recognized' end,
             1,
             case when g > 95000 and g <= 98000 then 'employee_payroll' else 'trader_receivable' end,
             gen_random_uuid(),'REF-'||lpad(g::text,7,'0'),
             make_date(2026,1 + (g % 9),1 + (g % 27)),'AED','perf-'||g,'perf:'||g,md5(g::text),
             ${ACTOR}::uuid,'company_user','perf event '||g,'{}'::jsonb,
             case when g <= 60000 then 'posted'
                  when g <= 80000 then 'received'
                  when g <= 98000 then 'failed'
                  when g <= 99000 then 'blocked_configuration'
                  else 'processing' end,
             case when g > 95000 and g <= 98000 then 'employee_payroll' else 'trader_receivables' end,
             case when g > 80000 then 1 else 0 end,
             case when g > 80000 and g <= 99000 then now() - (g % 30) * interval '1 day' end,
             case when g > 80000 and g <= 99000 then 'accounting_event_mapping_missing' end,
             case when g > 80000 and g <= 99000 then 'A mapping was missing' end,
             case when g > 99000 then now() - case when g > 99500 then interval '1 hour' else interval '1 minute' end end
        from generate_series(1,100000) g`.execute(tx);
  });
  await sql`analyze accounting_events`.execute(db);
}

describe.skipIf(!runPerformance)("Accounting Health -- 100,000-event performance (Prompt 4, Part U)", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let statements = 0;
  let service: PlatformAccountingHealthService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 });
    db = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === "query") statements += 1;
      },
    });
    await seed(db);
    service = new PlatformAccountingHealthService(db);
  }, 600_000);

  afterAll(async () => {
    await db?.destroy();
  });

  async function timed<T>(work: () => Promise<T>) {
    await work();
    statements = 0;
    const started = performance.now();
    const result = await work();
    return { ms: performance.now() - started, result, statements };
  }

  it("summarises and lists 100,000 events in a fixed number of statements", async () => {
    const summary = await timed(() => service.summary(COMPANY));
    expect(summary.result).toMatchObject({
      accountingHealth: "ISSUE",
      blockedConfiguration: 1_000,
      failed: 18_000,
      manualReview: 3_000,
      pending: 20_000,
      processing: 1_000,
      stuck: 500,
      totalEvents: 100_000,
    });
    // 15,000 failed + 1,000 blocked_configuration supported events pass every
    // stored-state check; 500 non-stale processing + 500 stale are BLOCKED.
    expect(summary.result.readyCandidates).toBe(16_000);
    expect(summary.result.blocked).toBe(1_000);
    const page = await timed(() => service.list(COMPANY, {}));
    const deep = await timed(() => service.list(COMPANY, { page: 150, pageSize: 100, status: "all" }));
    const filtered = await timed(() =>
      service.list(COMPANY, { eventType: "employee_payroll_paid", repairability: "MANUAL_REVIEW" }),
    );
    expect(page.result.total).toBe(19_500);
    expect(deep.result.items).toHaveLength(100);
    expect(filtered.result.total).toBe(3_000);
    for (const run of [summary, page, deep, filtered]) expect(run.statements).toBe(5);
    expect(summary.ms).toBeLessThan(10_000);
    expect(page.ms).toBeLessThan(10_000);
    process.stdout.write(
      `${JSON.stringify({
        fixtureEvents: summary.result.totalEvents,
        ms: {
          listAttention: Math.round(page.ms),
          listDeepPage: Math.round(deep.ms),
          listFiltered: Math.round(filtered.ms),
          summary: Math.round(summary.ms),
        },
        statementsPerRequest: summary.statements,
      })}\n`,
    );
  }, 600_000);
});
