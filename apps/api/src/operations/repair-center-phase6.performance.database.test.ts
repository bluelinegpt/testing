import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PlatformAccountingHealthService } from "../accounting/platform-accounting-health.service.js";
import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { CompanyOrderHealthService } from "./company-order-health.service.js";
import { PlatformPayrollHealthService, RepairPayrollService } from "./payroll-repair.service.js";
import { RepairAccountingRecoveryService } from "./repair-accounting-recovery.service.js";
import { RepairCenterOverviewService } from "./repair-center-overview.service.js";
import { RepairHistoryService } from "./repair-history.service.js";
import { RepairPreviewService } from "./repair-preview.service.js";

/**
 * REPAIR CENTER PHASE 6 -- the whole Repair Center at realistic large-Company
 * scale, every read path of the Platform workflow, in ONE Company:
 * 150,000 Orders, 100,000 accounting events (60,000 with Journals), 74,000
 * Trader receivables, 600 employees x 48 Payroll periods (28,800 lines,
 * 28,200 allocations) and the Repair History fixture.
 *
 * Opt-in and disposable-only: RUN_REPAIR_CENTER_PERFORMANCE=true against a
 * database whose name contains "perf", already holding the Order Health,
 * Phase 4 accounting and Phase 5 Payroll performance fixtures (run those
 * first). Read-only: nothing is written.
 *
 * For each operation: wall time, SQL statement count, and the slowest single
 * statement (the "worst query").
 */

const url = process.env.REPAIR_CENTER_PERF_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const runPerformance =
  process.env.RUN_REPAIR_CENTER_PERFORMANCE === "true" && /\/[^/]*perf[^/]*$/u.test(url);

const COMPANY = "0d0d0d0d-0000-4000-8000-000000150000";

describe.skipIf(!runPerformance)("Repair Center Phase 6 -- whole-system performance (large Company)", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let statements = 0;
  let worst = { ms: 0, sql: "" };
  let get: <T>(type: new (...args: never[]) => T) => T;
  let store: RequestSecurityContextStore;
  const adminId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 6 });
    db = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level !== "query") return;
        statements += 1;
        if (event.queryDurationMillis > worst.ms) {
          worst = { ms: event.queryDurationMillis, sql: event.query.sql.replace(/\s+/gu, " ").slice(0, 90) };
        }
      },
    });
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DATABASE).useValue(db).compile();
    get = (type) => module.get(type, { strict: false });
    store = get(RequestSecurityContextStore);
  }, 600_000);

  afterAll(async () => {
    await db?.destroy();
  });

  const asPlatform = <T>(work: () => Promise<T>) =>
    store.run(
      {
        identity: {
          companyId: null,
          forcePasswordChange: false,
          identityId: adminId,
          kind: "platform_administrator",
          permissions: new Set(["platform.access", "platform.companies.read", "platform.companies.repair_center.read"]),
          sessionId: randomUUID(),
        },
        tenant: { companyId: COMPANY, identityId: adminId },
      } as never,
      work,
    );

  async function timed<T>(work: () => Promise<T>) {
    await work(); // warm
    statements = 0;
    worst = { ms: 0, sql: "" };
    const started = performance.now();
    const value = await work();
    return { ms: Math.round(performance.now() - started), statements, value, worst: { ms: Math.round(worst.ms), sql: worst.sql } };
  }

  it("landing, every domain summary and attention list, history, finding detail and every Preview stay bounded", async () => {
    const counts = (
      await sql<{ orders: number; events: number; receivables: number; lines: number; history: number }>`select
          (select count(*)::int from orders where company_id = ${COMPANY}::uuid) as orders,
          (select count(*)::int from accounting_events where company_id = ${COMPANY}::uuid) as events,
          (select count(*)::int from trader_receivables where company_id = ${COMPANY}::uuid) as receivables,
          (select count(*)::int from payroll_entries where company_id = ${COMPANY}::uuid) as lines,
          (select count(*)::int from platform_repair_attempts where company_id = ${COMPANY}::uuid)
            + (select count(*)::int from platform_repair_executions where company_id = ${COMPANY}::uuid) as history`.execute(db)
    ).rows[0]!;
    expect(counts.orders).toBeGreaterThanOrEqual(150_000);
    expect(counts.events).toBeGreaterThanOrEqual(100_000);
    expect(counts.lines).toBeGreaterThanOrEqual(28_800);

    const orders = get(CompanyOrderHealthService);
    const accounting = get(PlatformAccountingHealthService);
    const payroll = get(PlatformPayrollHealthService);
    const history = get(RepairHistoryService);
    const overview = get(RepairCenterOverviewService);
    const previews = get(RepairPreviewService);
    const recovery = get(RepairAccountingRecoveryService);
    const payrollRepairs = get(RepairPayrollService);

    const orderId = (
      await sql<{ id: string }>`select id from orders where company_id = ${COMPANY}::uuid order by id limit 1`.execute(db)
    ).rows[0]!.id;
    const failedEvent = (
      await sql<{ id: string }>`select id from accounting_events where company_id = ${COMPANY}::uuid and processing_status = 'failed'
        and event_type = 'trader_receivable_recognized' order by id limit 1`.execute(db)
    ).rows[0]!.id;
    const periodId = (
      await sql<{ id: string }>`select id from payroll_periods where company_id = ${COMPANY}::uuid order by period_start desc limit 1`.execute(db)
    ).rows[0]!.id;

    const runs = {
      landing: await timed(() => overview.overview(COMPANY)),
      orderSummary: await timed(() => orders.summary(COMPANY, {})),
      orderAttention: await timed(() => orders.list(COMPANY, { scope: "all" })),
      accountingSummary: await timed(() => accounting.summary(COMPANY)),
      accountingAttention: await timed(() => accounting.list(COMPANY, {})),
      payrollSummary: await timed(() => payroll.summary(COMPANY)),
      payrollAttention: await timed(() => payroll.list(COMPANY, {})),
      history: await timed(() => history.list(COMPANY, {})),
      orderFindingDetail: await timed(() => asPlatform(() => previews.analyze(COMPANY, orderId))),
      orderPreview: await timed(() => asPlatform(() => previews.preview(COMPANY, orderId))),
      accountingDetail: await timed(() => recovery.details(COMPANY, failedEvent)),
      accountingPreview: await timed(() => recovery.preview(COMPANY, failedEvent)),
      payrollPreview: await timed(() => payrollRepairs.preview(COMPANY, periodId)),
    };
    // No N+1: summaries / lists / history are fixed-statement reads.
    for (const name of ["orderSummary", "orderAttention", "accountingSummary", "accountingAttention", "payrollSummary", "payrollAttention", "history"] as const) {
      expect(runs[name].statements, name).toBeLessThanOrEqual(6);
    }
    expect(runs.landing.statements).toBe(
      runs.orderSummary.statements + runs.accountingSummary.statements + runs.payrollSummary.statements + 1,
    );
    expect(runs.landing.value.payrollHealth).not.toBeNull();
    expect(runs.landing.ms).toBeLessThan(15_000);
    for (const name of ["orderFindingDetail", "orderPreview", "accountingDetail", "accountingPreview", "payrollPreview"] as const) {
      expect(runs[name].statements, name).toBeLessThan(40);
    }
    const report = Object.fromEntries(
      Object.entries(runs).map(([name, run]) => [name, { ms: run.ms, statements: run.statements, worstQueryMs: run.worst.ms, worstQuery: run.worst.sql }]),
    );
    process.stdout.write(`PHASE6_PERFORMANCE ${JSON.stringify({ fixture: counts, report })}\n`);
  }, 900_000);
});
