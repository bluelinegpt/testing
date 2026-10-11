import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { PlatformPayrollHealthService, RepairPayrollService } from "./payroll-repair.service.js";

/**
 * Repair Center Phase 5 Prompt 1 -- Payroll Health at realistic scale.
 *
 * Opt-in and disposable-only: RUN_REPAIR_CENTER_PERFORMANCE=true against a
 * database whose name contains "perf". It reuses the Order Health performance
 * Company (150,000 Orders, 100,000 accounting events, GL Accounting ON since
 * 2020 -- seeded by the Phase 4 performance suite) and adds, once, with
 * triggers bypassed (test seeding only; the repairs themselves never bypass
 * anything): 600 employees, 48 monthly Payroll periods (2022-01 .. 2025-12),
 * 28,800 lines, 2,880 active bonus adjustments, 47 confirmed payments with
 * 28,200 allocations and a posted `employee_payroll_approved` /
 * `employee_payroll_paid` event for each. Deliberate findings:
 *   - 2025-12 approved, paid in the allocations but not on the lines  -> READY payment reconciliation;
 *   - 2025-11 draft with header totals off by 10                     -> READY totals rebuild;
 *   - 2025-10 paid without its approval event                        -> MANUAL_REVIEW (event missing).
 */

const url = process.env.REPAIR_CENTER_PERF_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const runPerformance =
  process.env.RUN_REPAIR_CENTER_PERFORMANCE === "true" && /\/[^/]*perf[^/]*$/u.test(url);

const COMPANY = "0d0d0d0d-0000-4000-8000-000000150000";
const ACTOR = "0d0d0d0d-0000-4000-8000-0000004c1a01";
const EMPLOYEES = 600;
const PERIODS = 48;

async function seed(db: Kysely<DatabaseSchema>) {
  const done = await sql<{ n: number }>`select count(*)::int as n from payroll_periods
    where company_id = ${COMPANY}::uuid`.execute(db);
  if (done.rows[0]!.n > 0) return;
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = replica`.execute(tx);
    await sql`insert into employees(id,company_id,employee_number,name_en,basic_salary,is_active,payroll_eligible)
      select gen_random_uuid(),${COMPANY}::uuid,'P5E-'||lpad(e::text,4,'0'),'Perf Employee '||e,1000+(e%50)*10,true,true
        from generate_series(1,${EMPLOYEES}::int) e`.execute(tx);
    // k = 0 .. 47 -> 2022-01 .. 2025-12. 47 = approved (payment drift), 46 = draft, 45 = paid (event missing).
    await sql`create temporary table p5_per on commit drop as
      select k, gen_random_uuid() as id, (date '2022-01-01' + make_interval(months => k))::date as m,
             case when k = 47 then 'approved' when k = 46 then 'draft' when k < 36 then 'closed' else 'paid' end as status
        from generate_series(0,${PERIODS - 1}::int) k`.execute(tx);
    await sql`create temporary table p5_emp on commit drop as
      select id, row_number() over (order by employee_number)::int as e, employee_number, name_en, basic_salary
        from employees where company_id = ${COMPANY}::uuid and employee_number like 'P5E-%'`.execute(tx);
    await sql`create temporary table p5_line on commit drop as
      select gen_random_uuid() as id, p.id as pid, p.k, p.status as pstatus, x.id as employee_id, x.e,
             x.employee_number, x.name_en, x.basic_salary as basic,
             case when x.e % 10 = 0 then 50 else 0 end as adj,
             x.basic_salary + case when x.e % 10 = 0 then 50 else 0 end as net
        from p5_per p cross join p5_emp x`.execute(tx);
    await sql`insert into payroll_periods(id,company_id,period_start,period_end,payroll_month,status,period_reference,
        total_employees,total_basic_salary,total_earning_adjustments,total_net_salary,total_paid,total_outstanding,
        created_by_account_id,calculated_by_account_id,calculated_at,approved_by_account_id,approved_at,
        closed_by_account_id,closed_at)
      select p.id,${COMPANY}::uuid,p.m,(p.m + interval '1 month' - interval '1 day')::date,p.m,p.status,
             'PAY-P5-'||to_char(p.m,'YYYY-MM'),
             count(l.id),sum(l.basic),sum(l.adj),sum(l.net) + case when p.k = 46 then 10 else 0 end,
             case when p.status in ('paid','closed') then sum(l.net) else 0 end,
             case when p.status in ('paid','closed') then 0 else sum(l.net) + case when p.k = 46 then 10 else 0 end end,
             ${ACTOR}::uuid,${ACTOR}::uuid,p.m + interval '27 days',
             case when p.k <> 46 then ${ACTOR}::uuid end, case when p.k <> 46 then p.m + interval '28 days' end,
             case when p.status = 'closed' then ${ACTOR}::uuid end, case when p.status = 'closed' then p.m + interval '40 days' end
        from p5_per p join p5_line l on l.pid = p.id
       group by p.id, p.k, p.m, p.status`.execute(tx);
    await sql`insert into payroll_entries(id,company_id,payroll_number,payroll_period_id,employee_id,basic_salary_snapshot,
        earning_adjustments_total,gross_earnings,net_salary,amount_paid,outstanding_amount,status,source_marker,
        created_by_account_id,employee_number_snapshot,employee_name_snapshot,approved_by_account_id,approved_at)
      select l.id,${COMPANY}::uuid,'PR-P5-'||l.k||'-'||l.e,l.pid,l.employee_id,l.basic,l.adj,l.net,l.net,
             case when l.pstatus in ('paid','closed') then l.net else 0 end,
             case when l.pstatus in ('paid','closed') then 0 else l.net end,
             case when l.pstatus in ('paid','closed') then 'paid' when l.pstatus = 'draft' then 'draft' else 'approved' end,
             'new_payroll',${ACTOR}::uuid,l.employee_number,l.name_en,
             case when l.pstatus <> 'draft' then ${ACTOR}::uuid end,
             case when l.pstatus <> 'draft' then now() end
        from p5_line l`.execute(tx);
    await sql`insert into payroll_adjustments(company_id,payroll_period_id,payroll_line_id,employee_id,adjustment_type,
        direction,amount,reason,created_by_account_id)
      select ${COMPANY}::uuid,l.pid,l.id,l.employee_id,'bonus','earning',50,'Perf bonus',${ACTOR}::uuid
        from p5_line l where l.adj > 0`.execute(tx);
    await sql`create temporary table p5_pay on commit drop as
      select p.id as pid, p.k, p.m, gen_random_uuid() as id from p5_per p where p.status <> 'draft'`.execute(tx);
    await sql`insert into payroll_payments(id,company_id,payment_number,payment_date,payment_method,total_amount,
        acknowledgement_type,status,paid_by_account_id,idempotency_key,request_hash,payroll_period_id,created_at,confirmed_at)
      select y.id,${COMPANY}::uuid,'PP-P5-'||y.k,(y.m + interval '1 month')::date,'cash',
             (select sum(l.net) from p5_line l where l.pid = y.pid),'checkbox','confirmed',${ACTOR}::uuid,
             'perf-p5-pay-'||y.k,md5(y.id::text),y.pid,y.m + interval '32 days',y.m + interval '32 days'
        from p5_pay y`.execute(tx);
    await sql`insert into payroll_payment_allocations(company_id,payroll_payment_id,payroll_line_id,employee_id,
        allocated_amount,allocation_order)
      select ${COMPANY}::uuid,y.id,l.id,l.employee_id,l.net,l.e
        from p5_pay y join p5_line l on l.pid = y.pid`.execute(tx);
    // Posted accounting events (approval + payment), except 2025-10's approval.
    await sql`insert into accounting_events(company_id,event_type,event_version,source_entity_type,source_entity_id,
        source_reference,effective_accounting_date,currency,correlation_id,idempotency_key,event_hash,actor_id,actor_type,
        description,processing_status,operational_area,source_operation_id,processed_at)
      select ${COMPANY}::uuid,'employee_payroll_approved',1,'payroll_period',p.id,'PAY-P5-'||to_char(p.m,'YYYY-MM'),
             (p.m + interval '1 month' - interval '1 day')::date,'AED','perf-p5','employee_payroll_approved:'||p.id||':v1',
             md5('a'||p.id::text),${ACTOR}::uuid,'company_user','perf payroll approved','posted','employee_payroll','perf-p5',now()
        from p5_per p where p.status <> 'draft' and p.k <> 45
      union all
      select ${COMPANY}::uuid,'employee_payroll_paid',1,'payroll_payment',y.id,'PP-P5-'||y.k,
             (y.m + interval '1 month')::date,'AED','perf-p5','employee_payroll_paid:'||y.id||':v1',
             md5('p'||y.id::text),${ACTOR}::uuid,'company_user','perf payroll paid','posted','employee_payroll','perf-p5',now()
        from p5_pay y`.execute(tx);
  });
  for (const table of ["employees", "payroll_periods", "payroll_entries", "payroll_adjustments", "payroll_payments",
    "payroll_payment_allocations", "accounting_events"]) {
    await sql`analyze ${sql.table(table)}`.execute(db);
  }
}

/** Re-arms the two READY findings, so the suite can run again on the same disposable database. */
async function arm(db: Kysely<DatabaseSchema>) {
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = replica`.execute(tx);
    await sql`update payroll_entries l set amount_paid = 0, outstanding_amount = l.net_salary, status = 'approved'
        from payroll_periods p
       where p.id = l.payroll_period_id and p.company_id = ${COMPANY}::uuid and p.period_reference = 'PAY-P5-2025-12'`.execute(tx);
    await sql`update payroll_periods set status = 'approved', total_paid = 0, total_outstanding = total_net_salary
       where company_id = ${COMPANY}::uuid and period_reference = 'PAY-P5-2025-12'`.execute(tx);
    await sql`update payroll_periods p set total_net_salary = s.net + 10, total_outstanding = s.net + 10, total_paid = 0
        from (select payroll_period_id as id, sum(net_salary) as net from payroll_entries
               where company_id = ${COMPANY}::uuid group by payroll_period_id) s
       where s.id = p.id and p.company_id = ${COMPANY}::uuid and p.period_reference = 'PAY-P5-2025-11'`.execute(tx);
  });
}

describe.skipIf(!runPerformance)("Payroll Health -- Phase 5 Prompt 1 performance (48 periods / 28,800 lines)", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let statements = 0;
  let health: PlatformPayrollHealthService;
  let repairs: RepairPayrollService;
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
    await arm(db);
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DATABASE).useValue(db).compile();
    health = module.get(PlatformPayrollHealthService, { strict: false });
    repairs = module.get(RepairPayrollService, { strict: false });
    store = module.get(RequestSecurityContextStore, { strict: false });
  }, 900_000);

  afterAll(async () => {
    await db?.destroy();
  });

  async function timed<T>(work: () => Promise<T>, warm = true) {
    if (warm) await work().catch(() => undefined);
    statements = 0;
    const started = performance.now();
    const value = await work();
    return { ms: performance.now() - started, statements, value };
  }

  const asAdmin = <T>(adminId: string, work: () => Promise<T>) =>
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
      work,
    );

  const periodOf = async (month: string) =>
    (
      await sql<{ id: string }>`select id from payroll_periods where company_id = ${COMPANY}::uuid
        and period_reference = ${`PAY-P5-${month}`}`.execute(db)
    ).rows[0]!.id;

  it("summary, lists, preview and READY executions stay bounded at scale", async () => {
    const summary = await timed(() => health.summary(COMPANY));
    expect(summary.value).toMatchObject({ payrollHealth: "ISSUE", periodsWithFindings: 3 });
    expect(summary.value.totalPeriods).toBeGreaterThanOrEqual(PERIODS);
    expect(summary.value.headlines).toEqual(
      expect.arrayContaining([
        "ISSUE — Payroll calculation is inconsistent.",
        "ISSUE — Payroll payment state is inconsistent.",
      ]),
    );
    const attention = await timed(() => health.list(COMPANY, {}));
    const all = await timed(() => health.list(COMPANY, { page: 1, pageSize: 100, status: "all" }));
    expect(attention.value.total).toBe(3);

    const paymentPeriod = await periodOf("2025-12");
    const draftPeriod = await periodOf("2025-11");
    const missingPeriod = await periodOf("2025-10");
    const healthyPeriod = await periodOf("2024-06");

    const preview = await timed(() => repairs.preview(COMPANY, paymentPeriod));
    const paymentFinding = preview.value.findings.find((f) => f.reasonCode === "PAYROLL_PAYMENT_STATE_INCONSISTENT")!;
    expect(paymentFinding).toMatchObject({ repairCapability: "RECONCILE_PAYROLL_PAYMENT_STATE", repairability: "READY" });
    expect(preview.value.lines).toHaveLength(EMPLOYEES);
    const healthyPreview = await timed(() => repairs.preview(COMPANY, healthyPeriod));
    expect(healthyPreview.value.findings).toEqual([]);
    const missingPreview = await timed(() => repairs.preview(COMPANY, missingPeriod));
    expect(missingPreview.value.findings.map((f) => [f.reasonCode, f.repairability])).toEqual([
      ["PAYROLL_ACCOUNTING_EVENT_MISSING", "MANUAL_REVIEW"],
    ]);

    const adminId = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,normalized_username,password_hash,status)
      values (${adminId}::uuid,null,'platform_administrator',${`perf.p5.${adminId}`},${`perf.p5.${adminId}`},'x','disabled')`.execute(db);
    const actor = { accountId: adminId, authority: "platform.companies.repair_center.execute", correlationId: `perf-${randomUUID()}` };
    const reconcile = await timed(
      () =>
        asAdmin(adminId, () =>
          repairs.execute(
            COMPANY,
            paymentPeriod,
            {
              capabilityCode: "RECONCILE_PAYROLL_PAYMENT_STATE",
              findingId: paymentFinding.findingId,
              idempotencyKey: `perf-${randomUUID()}`,
              previewVersion: preview.value.previewVersion,
              reason: "Performance: reconcile 600 lines from allocations",
            },
            actor,
          ),
        ),
      false,
    );
    expect(reconcile.value).toMatchObject({ afterHealth: "HEALTHY", status: "succeeded" });
    const status = await sql<{ status: string }>`select status from payroll_periods where id = ${paymentPeriod}::uuid`.execute(db);
    expect(status.rows[0]!.status).toBe("paid");

    const draftPreview = await repairs.preview(COMPANY, draftPeriod);
    const totalsFinding = draftPreview.findings.find((f) => f.reasonCode === "PAYROLL_PERIOD_TOTALS_MISMATCH")!;
    const rebuild = await timed(
      () =>
        asAdmin(adminId, () =>
          repairs.execute(
            COMPANY,
            draftPeriod,
            {
              capabilityCode: "REBUILD_PAYROLL_PERIOD_TOTALS",
              findingId: totalsFinding.findingId,
              idempotencyKey: `perf-${randomUUID()}`,
              previewVersion: draftPreview.previewVersion,
              reason: "Performance: rebuild draft header totals",
            },
            actor,
          ),
        ),
      false,
    );
    expect(rebuild.value).toMatchObject({ afterHealth: "HEALTHY", status: "succeeded" });
    const after = await timed(() => health.summary(COMPANY));
    // Only the MANUAL_REVIEW finding remains (an approval event never captured).
    expect(after.value).toMatchObject({ payrollHealth: "ISSUE", periodsWithFindings: 1 });
    expect(after.value.headlines).toEqual(["ISSUE — Payroll accounting failed."]);

    for (const run of [summary, attention, all, after]) expect(run.statements).toBe(5);
    expect(summary.ms).toBeLessThan(10_000);
    expect(attention.ms).toBeLessThan(10_000);
    expect(preview.statements).toBeLessThan(15);
    expect(preview.ms).toBeLessThan(5_000);
    expect(reconcile.statements).toBeLessThan(40);
    expect(rebuild.statements).toBeLessThan(40);
    process.stdout.write(
      `${JSON.stringify({
        fixture: { adjustments: 2_880, allocations: 28_200, employees: EMPLOYEES, lines: EMPLOYEES * PERIODS, periods: PERIODS, payments: 47 },
        ms: {
          executeReconcile600Lines: Math.round(reconcile.ms),
          executeRebuildTotals: Math.round(rebuild.ms),
          listAll: Math.round(all.ms),
          listAttention: Math.round(attention.ms),
          preview600Lines: Math.round(preview.ms),
          previewHealthy: Math.round(healthyPreview.ms),
          previewManualReview: Math.round(missingPreview.ms),
          summary: Math.round(summary.ms),
          summaryAfter: Math.round(after.ms),
        },
        statements: {
          executeReconcile: reconcile.statements,
          executeRebuild: rebuild.statements,
          list: attention.statements,
          preview: preview.statements,
          summary: summary.statements,
        },
      })}\n`,
    );
  }, 900_000);
});
