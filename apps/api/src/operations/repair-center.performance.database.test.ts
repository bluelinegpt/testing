import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PlatformAccountingHealthService } from "../accounting/platform-accounting-health.service.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { CompanyOrderHealthService } from "./company-order-health.service.js";
import { RepairCenterOverviewService } from "./repair-center-overview.service.js";
import { RepairHistoryService } from "./repair-history.service.js";

/**
 * Phase 2 Prompt 5, Part T -- Repair Center landing, Order Health, Accounting
 * Health and Repair History at scale.
 *
 * Opt-in and disposable-only: RUN_REPAIR_CENTER_PERFORMANCE=true against a
 * database whose name contains "perf", already holding the Prompt 1 fixture
 * (150,000 Orders, company ...150000; run the Order Health performance test
 * first) and migrated through 20260988000000. This test adds, once, with
 * triggers bypassed:
 *   - 100,000 accounting events for the SAME Company (so one Company carries
 *     150k Orders AND 100k events);
 *   - 2,000 successful executions and 4,000 attempts (2,000 REFUSED,
 *     1,000 FAILED, 1,000 REPLAYED linked to executions).
 */

const url = process.env.REPAIR_CENTER_PERF_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const runPerformance =
  process.env.RUN_REPAIR_CENTER_PERFORMANCE === "true" && /\/[^/]*perf[^/]*$/u.test(url);

const COMPANY = "0d0d0d0d-0000-4000-8000-000000150000";
const ADMIN = "0d0d0d0d-0000-4000-8000-0000000bad01";

async function seed(db: Kysely<DatabaseSchema>) {
  const orders = await sql<{ n: number }>`select count(*)::int as n from orders where company_id = ${COMPANY}::uuid`.execute(db);
  if (orders.rows[0]!.n !== 150_000) throw new Error("Run the Order Health performance fixture first (150,000 Orders).");
  const actor = (
    await sql<{ id: string }>`select id from accounts where company_id = ${COMPANY}::uuid order by id limit 1`.execute(db)
  ).rows[0]!.id;
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = replica`.execute(tx);
    await sql`insert into accounts(id,company_id,account_kind,username,normalized_username,password_hash,status)
      values (${ADMIN}::uuid,null,'platform_administrator','perf.rc.admin','perf.rc.admin','x','disabled')
      on conflict do nothing`.execute(tx);
    const events = await sql<{ n: number }>`select count(*)::int as n from accounting_events
      where company_id = ${COMPANY}::uuid`.execute(tx);
    if (events.rows[0]!.n < 100_000) {
      await sql`insert into accounting_events(company_id,event_type,event_version,source_entity_type,
          source_entity_id,source_reference,effective_accounting_date,currency,correlation_id,idempotency_key,
          event_hash,actor_id,actor_type,description,supplementary_metadata,processing_status,operational_area,
          attempt_count,failed_at,error_code,safe_error_summary,processing_locked_at)
        select ${COMPANY}::uuid,
               case when g > 95000 and g <= 98000 then 'employee_payroll_paid' else 'trader_receivable_recognized' end,
               1,
               case when g > 95000 and g <= 98000 then 'employee_payroll' else 'trader_receivable' end,
               gen_random_uuid(),'RC-REF-'||lpad(g::text,7,'0'),
               make_date(2026,1 + (g % 9),1 + (g % 27)),'AED','rc-perf-'||g,'rc-perf:'||g,md5('rc'||g::text),
               ${actor}::uuid,'company_user','perf event '||g,'{}'::jsonb,
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
    }
    const executions = await sql<{ n: number }>`select count(*)::int as n from platform_repair_executions
      where company_id = ${COMPANY}::uuid`.execute(tx);
    if (executions.rows[0]!.n < 2_000) {
      await sql`insert into platform_repair_executions(id,company_id,order_id,entity_type,entity_id,entity_number,
          finding_id,reason_code,capability_code,preview_version,actor_account_id,actor_authority,reason,
          before_state_fingerprint,after_state_fingerprint,before_health,after_health,before_classification,
          after_classification,result,idempotency_key,request_hash,correlation_id,created_at)
        select gen_random_uuid(), ${COMPANY}::uuid, o.id, 'order', o.id, o.order_number,
               'fnd_' || substr(md5(o.id::text), 1, 24), 'MISSING_RECEIVABLE', 'REPAIR_TRADER_RECEIVABLE',
               'rcv1:' || md5(o.id::text) || md5(o.order_number), ${ADMIN}::uuid,
               'platform.companies.repair_center.execute', 'Perf fixture repair',
               'rcv1:' || md5(o.id::text) || md5(o.order_number), 'rcv1:' || md5(o.order_number) || md5(o.id::text),
               'ISSUE', 'HEALTHY', 'MISSING_RECEIVABLE', 'HEALTHY_ACTIVE_RECEIVABLE', 'succeeded',
               'rc-perf-' || replace(o.id::text, '-', ''), md5(o.id::text), 'rc-perf-' || o.order_number,
               now() - (row_number() over (order by o.id)) * interval '3 minutes'
          from (select id, order_number from orders where company_id = ${COMPANY}::uuid order by id limit 2000) o`.execute(tx);
      await sql`insert into platform_repair_attempts(company_id,entity_type,entity_id,entity_number,finding_id,
          reason_code,capability_code,actor_account_id,actor_authority,reason,preview_version,idempotency_key_sha256,
          result,error_code,safe_error_summary,repair_execution_id,correlation_id,created_at)
        select ${COMPANY}::uuid, 'order', o.id, o.order_number, 'fnd_' || substr(md5(o.id::text), 1, 24),
               'MISSING_RECEIVABLE', 'REPAIR_TRADER_RECEIVABLE', ${ADMIN}::uuid,
               'platform.companies.repair_center.execute', 'Perf fixture attempt', 'rcv1:' || md5(o.id::text),
               encode(sha256(convert_to(o.id::text || g::text, 'UTF8')), 'hex'),
               case when g = 1 then 'REFUSED' when g = 2 then 'FAILED' else 'REPLAYED' end,
               case when g = 1 then 'repair_preview_stale' when g = 2 then 'repair_execution_failed' end,
               case when g = 1 then 'The order changed after the repair preview.'
                    when g = 2 then 'The repair failed unexpectedly; no repair was applied.' end,
               case when g = 3 then x.id end,
               'rc-perf-attempt-' || g || '-' || o.order_number,
               now() - (row_number() over (order by o.id, g)) * interval '1 minute'
          from (select id, order_number, row_number() over (order by id desc) as rn
                  from orders where company_id = ${COMPANY}::uuid order by id desc limit 2000) o
          cross join generate_series(1, 3) g
          left join lateral (select id from platform_repair_executions
                              where company_id = ${COMPANY}::uuid order by id offset (abs(hashtext(o.id::text)) % 2000) limit 1) x
            on g = 3
         where g = 1 or (g = 2 and o.rn % 2 = 0) or (g = 3 and o.rn % 2 = 1)`.execute(tx);
    }
  });
  await sql`analyze accounting_events`.execute(db);
  await sql`analyze platform_repair_executions`.execute(db);
  await sql`analyze platform_repair_attempts`.execute(db);
}

describe.skipIf(!runPerformance)("Repair Center -- landing, health and history at scale (Prompt 5, Part T)", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let statements = 0;
  let orders: CompanyOrderHealthService;
  let accounting: PlatformAccountingHealthService;
  let history: RepairHistoryService;
  let overview: RepairCenterOverviewService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 4 });
    db = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === "query") statements += 1;
      },
    });
    await seed(db);
    orders = new CompanyOrderHealthService(db);
    accounting = new PlatformAccountingHealthService(db);
    history = new RepairHistoryService(db);
    overview = new RepairCenterOverviewService(orders, accounting, history);
  }, 900_000);

  afterAll(async () => {
    await db?.destroy();
  });

  async function timed<T>(work: () => Promise<T>) {
    await work();
    statements = 0;
    const started = performance.now();
    const result = await work();
    return { ms: Math.round(performance.now() - started), result, statements };
  }

  it("one Company with 150k Orders, 100k events and 6k audit rows: fixed statements, bounded time", async () => {
    const counts = (
      await sql<{ orders: number; events: number; executions: number; attempts: number }>`
        select (select count(*)::int from orders where company_id = ${COMPANY}::uuid) as orders,
               (select count(*)::int from accounting_events where company_id = ${COMPANY}::uuid) as events,
               (select count(*)::int from platform_repair_executions where company_id = ${COMPANY}::uuid) as executions,
               (select count(*)::int from platform_repair_attempts where company_id = ${COMPANY}::uuid) as attempts`.execute(db)
    ).rows[0]!;
    expect(counts.orders).toBe(150_000);
    expect(counts.events).toBe(100_000);
    expect(counts.executions).toBe(2_000);
    expect(counts.attempts).toBe(4_000);

    const landing = await timed(() => overview.overview(COMPANY));
    const orderHealth = await timed(() => orders.summary(COMPANY, {}));
    const orderList = await timed(() => orders.list(COMPANY, { scope: "all" }));
    const accountingSummary = await timed(() => accounting.summary(COMPANY));
    const accountingList = await timed(() => accounting.list(COMPANY, { status: "all" }));
    const historyFirst = await timed(() => history.list(COMPANY, {}));
    const historyDeep = await timed(() => history.list(COMPANY, { page: 60, pageSize: 100 }));
    const historyFiltered = await timed(() => history.list(COMPANY, { result: "FAILED", pageSize: 100 }));
    const historyCounts = await timed(() => history.counts(COMPANY));
    // The Accounting-ON 100k-event Company of the Prompt 4 fixture, when present.
    const accountingOnCompany = "0d0d0d0d-0000-4000-8000-0000000ac100";
    const hasAccountingOn =
      (await sql<{ n: number }>`select count(*)::int as n from companies where id = ${accountingOnCompany}::uuid`.execute(db))
        .rows[0]!.n === 1;
    const landingAccountingOn = hasAccountingOn ? await timed(() => overview.overview(accountingOnCompany)) : undefined;
    if (landingAccountingOn !== undefined) {
      expect(landingAccountingOn.result.accountingMode.enabled).toBe(true);
      expect(landingAccountingOn.statements).toBeLessThanOrEqual(12);
    }
    const detailId = historyFirst.result.items[0]!;
    const historyDetail = await timed(() => history.detail(COMPANY, detailId.kind, detailId.id));

    expect(landing.result.repairHistory).toMatchObject({ failed: 1_000, refused: 2_000, replayed: 1_000, succeeded: 2_000 });
    expect(historyFirst.result.total).toBe(6_000);
    expect(historyDeep.result.items).toHaveLength(100);
    expect(historyFiltered.result.total).toBe(1_000);
    // newest first
    const times = historyFirst.result.items.map((row) => row.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);

    // No N+1: statement counts are constant, independent of fixture size.
    // History list / detail: BEGIN, SET TRANSACTION, set_config, query, COMMIT.
    for (const run of [historyFirst, historyDeep, historyFiltered, historyDetail]) expect(run.statements).toBe(5);
    expect(historyCounts.statements).toBe(1);
    expect(landing.statements).toBe(orderHealth.statements + accountingSummary.statements + historyCounts.statements);
    expect(landing.statements).toBeLessThanOrEqual(12);
    for (const run of [historyFirst, historyDeep, historyFiltered, historyCounts, historyDetail]) {
      expect(run.ms).toBeLessThan(5_000);
    }
    expect(landing.ms).toBeLessThan(15_000);

    process.stdout.write(
      `${JSON.stringify({
        fixture: counts,
        repairCenterPerformance: {
          accountingHealthList: { ms: accountingList.ms, statements: accountingList.statements },
          accountingHealthSummary: { ms: accountingSummary.ms, statements: accountingSummary.statements },
          historyCounts: { ms: historyCounts.ms, statements: historyCounts.statements },
          historyDeepPage60: { ms: historyDeep.ms, statements: historyDeep.statements },
          historyDetail: { ms: historyDetail.ms, statements: historyDetail.statements },
          historyFailedFilter: { ms: historyFiltered.ms, statements: historyFiltered.statements },
          historyFirstPage: { ms: historyFirst.ms, statements: historyFirst.statements },
          landingOverview: { ms: landing.ms, statements: landing.statements },
          landingOverviewAccountingOn100kEvents:
            landingAccountingOn === undefined
              ? null
              : { ms: landingAccountingOn.ms, statements: landingAccountingOn.statements },
          orderHealthList: { ms: orderList.ms, statements: orderList.statements },
          orderHealthSummaryLast30: { ms: orderHealth.ms, statements: orderHealth.statements },
        },
      })}\n`,
    );
  }, 900_000);
});
