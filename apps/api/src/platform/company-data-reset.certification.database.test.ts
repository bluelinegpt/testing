import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { domainCoverageProblems, normalizeResetRequest, type ResetPlanRequest } from "./company-data-reset.domains.js";
import { ResetPlanNotExecutableError, ResetPlanStaleError } from "./company-data-reset.executor.js";
import { assertDisposableDatabase } from "./company-data-reset.fixture.js";
import { buildCompanyDataResetPlan, type CompanyDataResetPlan } from "./company-data-reset.planner.js";
import { type ScenarioFixture, seedScenarioCompany } from "./company-data-reset.scenario-fixture.js";
import {
  type AuditedCompanyDataResetOutcome,
  executeAndAuditCompanyDataReset,
} from "./company-data-reset.service.js";
import { buildReports, computeBlockers, introspectSchema } from "./reset-company-test-data.manifest.js";

/**
 * COMPANY DATA RESET -- Prompt 3 FINAL CERTIFICATION (disposable database,
 * COMMITTED; hard name guard). Enable with RUN_RESET_DATABASE=true.
 *
 * PREVIEW ACCURACY is measured, not assumed: every Company-scoped table of the
 * database is counted before and after each execution, and EVERY delta must
 * equal what the preview said -- the table-level plan, the per-user plan
 * (memberships, role assignments, links, identities, Employees, Drivers and
 * their owned rows) and every summary DELETE / PRESERVE pair. Anything the
 * preview did not announce must be unchanged (the only addition is the one
 * reset audit row). A second Company with IDENTICAL business numbers is
 * fingerprinted across every Company-scoped table around every execution.
 */

const runDatabase = process.env.RUN_RESET_DATABASE === "true";

type Counts = Record<string, number>;

describe.skipIf(!runDatabase)("Company Data Reset -- Prompt 3 final certification (disposable, committed)", () => {
  let pool: pg.Pool;
  let companyTables: string[] = [];

  const withClient = async <T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  };

  async function seed(label: string): Promise<ScenarioFixture> {
    return withClient(async (client) => {
      await client.query("begin");
      try {
        const fixture = await seedScenarioCompany(client, label);
        await client.query("commit");
        return fixture;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  async function counts(client: pg.PoolClient, companyId: string): Promise<Counts> {
    const selects = companyTables.map((table) => `(select count(*) from "${table}" where company_id = $1)::int as "${table}"`);
    const row = (await client.query<Counts>(`select ${selects.join(", ")}`, [companyId])).rows[0]!;
    return row;
  }

  /** Content fingerprint of EVERY Company-scoped table (cross-Company isolation). */
  async function fingerprintAll(client: pg.PoolClient, companyId: string): Promise<string> {
    const parts: string[] = [];
    for (const table of companyTables) {
      const row = (
        await client.query<{ digest: string | null }>(
          `select md5(string_agg(t::text, '|' order by t::text)) as digest from "${table}" t where t.company_id = $1`,
          [companyId],
        )
      ).rows[0]!;
      parts.push(`${table}:${row.digest ?? "-"}`);
    }
    return parts.join("\n");
  }

  async function preview(client: pg.PoolClient, companyId: string, request: ResetPlanRequest): Promise<CompanyDataResetPlan> {
    await client.query("begin transaction read only");
    try {
      return await buildCompanyDataResetPlan(client, companyId, normalizeResetRequest(request));
    } finally {
      await client.query("rollback");
    }
  }

  async function execute(
    client: pg.PoolClient,
    companyId: string,
    request: ResetPlanRequest,
    planVersion: string,
  ): Promise<AuditedCompanyDataResetOutcome> {
    await client.query("begin");
    try {
      const outcome = await executeAndAuditCompanyDataReset(client, companyId, normalizeResetRequest(request), planVersion, {
        accountId: null,
        backupFile: null,
        correlationId: `cdr-p3-${randomUUID()}`,
        source: "cli",
      });
      await client.query("commit");
      return outcome;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }

  /** Expected per-table deltas (before - after) derived ONLY from the preview. */
  function expectedDeltas(plan: CompanyDataResetPlan): Counts {
    const expected: Counts = {};
    const add = (table: string, rows: number) => {
      expected[table] = (expected[table] ?? 0) + rows;
    };
    const planned = new Set(plan.tables.map((entry) => entry.table));
    for (const entry of plan.tables) add(entry.table, entry.rows);
    const removed = plan.users.filter((user) => user.remove);
    for (const user of removed) {
      add("company_users", user.membershipRemoved);
      add("account_roles", user.roleAssignmentsRemoved);
      add("account_sessions", user.accessRowsRemoved.sessions);
      add("password_reset_tokens", user.accessRowsRemoved.resetTokens);
      add("user_business_links", user.accessRowsRemoved.businessLinks);
      if (!planned.has("device_registrations")) add("device_registrations", user.accessRowsRemoved.deviceRegistrations);
      if (user.identity.action === "DELETE") add("accounts", 1);
      for (const record of [user.employee, user.driver]) {
        if (record?.action !== "DELETE") continue;
        if (!planned.has(record.kind === "employee" ? "employees" : "drivers")) add(record.kind === "employee" ? "employees" : "drivers", 1);
        for (const owned of record.ownedRows) if (!planned.has(owned.table)) add(owned.table, owned.rows);
      }
    }
    add("user_business_links", plan.entityLinksRemoved);
    add("audit_events", -1); // the one reset audit row
    return expected;
  }

  /**
   * PREVIEW ACCURACY: execute the previewed plan and compare EVERY Company
   * table delta and every summary pair with the preview.
   */
  async function certify(fixture: ScenarioFixture, other: ScenarioFixture, request: ResetPlanRequest) {
    return withClient(async (client) => {
      const plan = await preview(client, fixture.company, request);
      expect(plan.blockers, "plan must be executable").toEqual([]);
      expect(plan.executable).toBe(true);
      const before = await counts(client, fixture.company);
      const otherBefore = await fingerprintAll(client, other.company);
      const accountsBefore = (await client.query<{ id: string; status: string }>("select id, status from accounts where company_id = $1", [fixture.company])).rows;
      const outcome = await execute(client, fixture.company, request, plan.planVersion);
      const after = await counts(client, fixture.company);

      const expected = expectedDeltas(plan);
      const mismatches: string[] = [];
      for (const table of companyTables) {
        const actual = before[table]! - after[table]!;
        const wanted = expected[table] ?? 0;
        if (actual !== wanted) mismatches.push(`${table}: preview ${wanted}, actual ${actual}`);
      }
      expect(mismatches, "every table delta equals the preview").toEqual([]);

      // Summary pairs: DELETE = actual removal, PRESERVE = what is left.
      const pairs: [keyof CompanyDataResetPlan["summary"], string][] = [
        ["orders", "orders"],
        ["collections", "trader_collections"],
        ["settlements", "trader_settlements"],
        ["accountingTransactions", "journal_entries"],
        ["payrollTransactions", "payroll_entries"],
        ["traders", "traders"],
        ["customers", "customers"],
        ["employees", "employees"],
        ["drivers", "drivers"],
      ];
      for (const [key, table] of pairs) {
        const pair = plan.summary[key] as { delete: number; preserve: number };
        expect({ key, removed: before[table]! - after[table]!, kept: after[table]! }).toEqual({ key, kept: pair.preserve, removed: pair.delete });
      }
      const removedUsers = plan.users.filter((user) => user.remove);
      expect(plan.summary.companyUsers.delete).toBe(removedUsers.length);
      expect(plan.summary.membershipsDeleted).toBe(before.company_users! - after.company_users!);
      expect(plan.summary.roleAssignmentsDeleted).toBe(before.account_roles! - after.account_roles!);
      expect(plan.summary.globalIdentities.delete).toBe(before.accounts! - after.accounts!);
      expect(outcome.periodsOpened).toBe(plan.fiscalCalendar.periodsToOpen);

      // Users: kept ones untouched (same row), removed ones exactly as planned.
      const accountsAfter = new Map(
        (await client.query<{ id: string; status: string }>("select id, status from accounts where company_id = $1", [fixture.company])).rows.map((row) => [row.id, row.status]),
      );
      for (const user of plan.users.filter((entry) => entry.accountKind !== "platform_administrator" && entry.accountKind !== "unknown")) {
        const was = accountsBefore.find((row) => row.id === user.accountId)!;
        if (!user.remove) expect({ id: user.username, status: accountsAfter.get(user.accountId) }).toEqual({ id: user.username, status: was.status });
        else if (user.identity.action === "DELETE") expect(accountsAfter.has(user.accountId)).toBe(false);
        else expect(accountsAfter.has(user.accountId)).toBe(true);
      }
      // Cross-Company isolation: the other Company (identical business numbers) is byte-identical.
      expect(await fingerprintAll(client, other.company)).toBe(otherBefore);
      // The one reset audit row is this execution's, with the plan it executed.
      const audit = (
        await client.query<{ before_data: { planVersion: string; preset: string; userMode: string; selectedDomains: string[] }; after_data: { usersRemoved: string[] } }>(
          "select before_data, after_data from audit_events where id = $1 and company_id = $2 and action = 'platform.company.data_reset.planned' and result = 'success'",
          [outcome.auditEventId, fixture.company],
        )
      ).rows[0]!;
      expect(audit.before_data).toMatchObject({ planVersion: plan.planVersion, preset: plan.request.preset, userMode: plan.request.userMode });
      expect([...audit.after_data.usersRemoved].sort()).toEqual(removedUsers.map((user) => user.accountId).sort());
      return { after, before, outcome, plan };
    });
  }

  let other: ScenarioFixture;

  beforeAll(async () => {
    assertDisposableDatabase(process.env.DATABASE_URL);
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    companyTables = (
      await pool.query<{ table_name: string }>(
        `select c.table_name from information_schema.columns c
           join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
          where c.table_schema = 'public' and c.column_name = 'company_id' order by c.table_name`,
      )
    ).rows.map((row) => row.table_name);
    other = await seed("P3B");
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("SCENARIO 1 OPERATIONAL: preview == execution on every table; users, workforce, masters, financial, configuration, counters, audit kept", async () => {
    const a = await seed("P3S1");
    const { before, after, plan } = await certify(a, other, { preset: "OPERATIONAL_DATA" });
    expect(plan.effectiveDomains).toEqual(["OPERATIONAL"]);
    expect(after.orders).toBe(0);
    expect(after.driver_reconciliations).toBe(0);
    for (const kept of ["accounts", "employees", "drivers", "traders", "customers", "trader_collections", "trader_settlements", "trader_receivables", "payroll_entries", "journal_entries", "company_reference_counters", "platform_repair_executions", "platform_repair_attempts", "company_whatsapp_connections"]) {
      expect({ kept, rows: after[kept] }).toEqual({ kept, rows: before[kept] });
    }
  }, 300_000);

  it("SCENARIO 2 FINANCIAL: collections, settlements, receivables, payroll, journals removed exactly as previewed; fiscal calendar reopened; everything else kept", async () => {
    const a = await seed("P3S2");
    await pool.query("update accounting_periods set status = 'closed' where company_id = $1", [a.company]);
    const { before, after, plan, outcome } = await certify(a, other, { preset: "FINANCIAL_DATA" });
    expect(plan.effectiveDomains).toContain("FINANCIAL");
    expect(outcome.periodsOpened).toBe(1);
    for (const gone of ["trader_collections", "trader_settlements", "trader_receivables", "payroll_entries", "payroll_periods", "journal_entries", "accounting_events"]) {
      expect({ gone, rows: after[gone] }).toEqual({ gone, rows: 0 });
    }
    for (const kept of ["accounts", "employees", "drivers", "traders", "customers", "company_reference_counters", "chart_of_accounts", "fiscal_years", "accounting_periods"]) {
      expect({ kept, rows: after[kept] }).toEqual({ kept, rows: before[kept] });
    }
  }, 300_000);

  it("SCENARIO 3 SELECTED USERS: exactly the selected users (and only them) are removed; Employee planned and handled; admin and others kept", async () => {
    const a = await seed("P3S3");
    const { plan } = await certify(a, other, { preset: "USERS_WORKFORCE", selectedAccountIds: [a.employeeUser, a.ordinaryUser], userMode: "DELETE_SELECTED_USERS" });
    expect(plan.users.filter((user) => user.remove).map((user) => user.accountId).sort()).toEqual([a.employeeUser, a.ordinaryUser].sort());
    expect(await pool.query("select 1 from accounts where id = $1 and status = 'active'", [a.admin]).then((r) => r.rowCount)).toBe(1);
    expect(await pool.query("select 1 from accounts where id = $1", [a.driverUser]).then((r) => r.rowCount)).toBe(1);
  }, 300_000);

  it("SCENARIO 4 FULL + KEEP ALL USERS: every user, Employee and Driver kept; operational + financial removed as previewed", async () => {
    const a = await seed("P3S4");
    const { before, after, plan } = await certify(a, other, { preset: "FULL_COMPANY_DATA_KEEP_COMPANY", userMode: "KEEP_ALL_USERS" });
    expect(plan.users.every((user) => !user.remove)).toBe(true);
    for (const kept of ["accounts", "company_users", "account_roles", "employees", "drivers", "traders", "customers"]) {
      expect({ kept, rows: after[kept] }).toEqual({ kept, rows: before[kept] });
    }
  }, 300_000);

  it("SCENARIO 4b FULL + SELECTED USERS: only the selected user goes; the preview's Employee handling is what happens", async () => {
    const a = await seed("P3S4B");
    const { plan } = await certify(a, other, { preset: "FULL_COMPANY_DATA_KEEP_COMPANY", selectedAccountIds: [a.employeeUser], userMode: "DELETE_SELECTED_USERS" });
    expect(plan.users.filter((user) => user.remove).map((user) => user.accountId)).toEqual([a.employeeUser]);
  }, 300_000);

  it("SCENARIO 5 FULL + DELETE ALL ELIGIBLE (+ traders/customers and workforce): protected admin kept active with its role; Platform audit, counters, configuration and Company PRESERVED (strongest reset)", async () => {
    const a = await seed("P3S5");
    const repairBefore = await pool.query("select * from platform_repair_executions where company_id = $1 order by id", [a.company]);
    const attemptsBefore = await pool.query("select * from platform_repair_attempts where company_id = $1 order by id", [a.company]);
    const auditBefore = await pool.query("select * from audit_events where company_id = $1 order by id", [a.company]);
    const countersBefore = await pool.query("select * from company_reference_counters where company_id = $1 order by reference_type", [a.company]);
    const { plan } = await certify(a, other, {
      preset: "FULL_COMPANY_DATA_KEEP_COMPANY",
      tradersCustomers: "RESET",
      userMode: "DELETE_ALL_ELIGIBLE_USERS",
      workforce: "RESET",
    });
    expect(plan.users.find((user) => user.accountId === a.admin)).toMatchObject({ classification: "PROTECTED", remove: false });
    expect((await pool.query("select status from accounts where id = $1", [a.admin])).rows[0]).toEqual({ status: "active" });
    expect((await pool.query("select count(*)::int as n from account_roles where account_id = $1 and company_id = $2", [a.admin, a.company])).rows[0]).toEqual({ n: 1 });
    expect((await pool.query("select * from platform_repair_executions where company_id = $1 order by id", [a.company])).rows).toEqual(repairBefore.rows);
    expect((await pool.query("select * from platform_repair_attempts where company_id = $1 order by id", [a.company])).rows).toEqual(attemptsBefore.rows);
    const auditAfter = (await pool.query("select * from audit_events where company_id = $1 order by id", [a.company])).rows;
    for (const row of auditBefore.rows) expect(auditAfter).toContainEqual(row);
    expect(auditAfter).toHaveLength(auditBefore.rows.length + 1);
    expect((await pool.query("select * from company_reference_counters where company_id = $1 order by reference_type", [a.company])).rows).toEqual(countersBefore.rows);
    expect((await pool.query("select status, environment from companies where id = $1", [a.company])).rows[0]).toEqual({ environment: "development", status: "active" });
  }, 300_000);

  it("SCENARIO 6 CUSTOM (Traders & customers + Integrations, one selected user): required dependencies shown and executed exactly", async () => {
    const a = await seed("P3S6");
    const request: ResetPlanRequest = { domains: ["TRADERS_CUSTOMERS", "INTEGRATIONS"], preset: "CUSTOM", selectedAccountIds: [a.ordinaryUser], userMode: "DELETE_SELECTED_USERS" };
    const { after, plan } = await certify(a, other, request);
    expect(plan.requiredDependencies.map((dependency) => dependency.domain).sort()).toEqual(["FINANCIAL", "OPERATIONAL"]);
    expect(plan.effectiveDomains).toEqual(["OPERATIONAL", "FINANCIAL", "TRADERS_CUSTOMERS", "INTEGRATIONS"]);
    expect(after.company_whatsapp_connections).toBe(0);
    expect(after.commerce_integration_area_mappings).toBe(0);
    expect(after.traders).toBe(0);
    expect(after.employees).toBe(1);
  }, 300_000);

  it("SCENARIO 7 BLOCKED: preview BLOCKED with an explanation; direct execution refused; zero mutation", async () => {
    const a = await seed("P3S7");
    await withClient(async (client) => {
      const request: ResetPlanRequest = { domains: ["WORKFORCE"], preset: "CUSTOM", userMode: "KEEP_ALL_USERS" };
      const plan = await preview(client, a.company, request);
      expect(plan.executable).toBe(false);
      expect(plan.blockers.join(" ")).toMatch(/Driver/u);
      const before = await fingerprintAll(client, a.company);
      await expect(execute(client, a.company, request, plan.planVersion)).rejects.toBeInstanceOf(ResetPlanNotExecutableError);
      expect(await fingerprintAll(client, a.company)).toBe(before);
    });
  }, 300_000);

  it("SCENARIO 8 STALE PLAN: a Company changed after preview refuses the old plan; zero mutation", async () => {
    const a = await seed("P3S8");
    await withClient(async (client) => {
      const plan = await preview(client, a.company, { preset: "OPERATIONAL_DATA" });
      await client.query(
        `insert into orders (company_id, order_number, order_date, trader_id, area_id, created_by_account_id, customer_name, customer_mobile_number,
           customer_address, package_count, payment_condition, final_service_fee_snapshot, customer_provenance_status, pricing_provenance_status, service_fee)
         values ($1, 'ORD-DUP-0002', '2026-01-20', $2, $3, $4, 'Late', '971500000010', 'Address', 1, 'customer_pays_cod_and_fee', 25,
           'legacy_unattributed', 'legacy_unattributed', 25)`,
        [a.company, a.trader, a.area, a.admin],
      );
      const before = await fingerprintAll(client, a.company);
      await expect(execute(client, a.company, { preset: "OPERATIONAL_DATA" }, plan.planVersion)).rejects.toBeInstanceOf(ResetPlanStaleError);
      expect(await fingerprintAll(client, a.company)).toBe(before);
    });
  }, 300_000);

  it("SCENARIO 10 DOUBLE SUBMIT (in process): the same approved plan executes ONCE -- a re-submission is stale, even concurrently", async () => {
    const a = await seed("P3S10");
    const request: ResetPlanRequest = { preset: "OPERATIONAL_DATA" };
    const plan = await withClient((client) => preview(client, a.company, request));
    const results = await Promise.allSettled([
      withClient((client) => execute(client, a.company, request, plan.planVersion)),
      withClient((client) => execute(client, a.company, request, plan.planVersion)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ResetPlanStaleError);
    // Sequential re-submit of the same plan: still stale (the executed reset is part of the plan version).
    await expect(withClient((client) => execute(client, a.company, request, plan.planVersion))).rejects.toBeInstanceOf(ResetPlanStaleError);
    expect(
      (await pool.query("select count(*)::int as n from audit_events where company_id = $1 and action = 'platform.company.data_reset.planned'", [a.company])).rows[0],
    ).toEqual({ n: 1 });
    // A NEW preview after the reset carries the last reset reference.
    const next = await withClient((client) => preview(client, a.company, { preset: "FINANCIAL_DATA" }));
    expect(next.lastReset).not.toBeNull();
  }, 300_000);

  it("DRY RUN: preview performs zero mutation, writes no audit row and is deterministic for unchanged state", async () => {
    const a = await seed("P3DRY");
    await withClient(async (client) => {
      const before = await fingerprintAll(client, a.company);
      const requests: ResetPlanRequest[] = [
        { preset: "OPERATIONAL_DATA" },
        { preset: "FULL_COMPANY_DATA_KEEP_COMPANY", tradersCustomers: "RESET", userMode: "DELETE_ALL_ELIGIBLE_USERS", workforce: "RESET" },
        { domains: ["WORKFORCE"], preset: "CUSTOM", userMode: "KEEP_ALL_USERS" },
      ];
      for (const request of requests) {
        const first = await preview(client, a.company, request);
        const second = await preview(client, a.company, request);
        expect(second.planVersion).toBe(first.planVersion);
        expect(second).toEqual(first);
      }
      expect(await fingerprintAll(client, a.company)).toBe(before);
      expect(
        (await client.query("select count(*)::int as n from audit_events where company_id = $1 and action like 'platform.company.data_reset%'", [a.company])).rows[0],
      ).toEqual({ n: 0 });
    });
  }, 300_000);

  it("AUDIT CONTENT: actor, Company, preset/domains, user mode, removed account ids, plan version, timestamp, result -- and no customer / user PII", async () => {
    const a = await seed("P3AUD");
    const { outcome, plan } = await certify(a, other, { preset: "FULL_COMPANY_DATA_KEEP_COMPANY", selectedAccountIds: [a.ordinaryUser], userMode: "DELETE_SELECTED_USERS" });
    const row = (
      await pool.query<Record<string, unknown>>(
        "select company_id, action, subject_type, subject_id, before_data, after_data, correlation_id, actor_role, source, result, occurred_at from audit_events where id = $1",
        [outcome.auditEventId],
      )
    ).rows[0]!;
    expect(row).toMatchObject({
      action: "platform.company.data_reset.planned",
      actor_role: "operator_cli",
      company_id: a.company,
      result: "success",
      source: "reset_cli",
      subject_id: a.company,
      subject_type: "company",
    });
    expect(row.occurred_at).toBeInstanceOf(Date);
    expect(row.before_data).toMatchObject({ planVersion: plan.planVersion, preset: "FULL_COMPANY_DATA_KEEP_COMPANY", selectedDomains: ["OPERATIONAL", "FINANCIAL"], userMode: "DELETE_SELECTED_USERS" });
    expect(row.after_data).toMatchObject({ effectiveDomains: ["OPERATIONAL", "FINANCIAL"], usersRemoved: [a.ordinaryUser] });
    const text = JSON.stringify(row);
    for (const pii of ["Customer One", "971500000002", "Someone", "971500000009", "Address", "cdr-ordinary-", "Ordinary", "Scenario street"]) {
      expect(text, pii).not.toContain(pii);
    }
  }, 300_000);

  it("MANIFEST: every table in the database is classified; 0 unclassified, 0 unsafe, 0 reset blockers; every PURGE table in exactly one domain", async () => {
    await withClient(async (client) => {
      const snapshot = await introspectSchema(client);
      const reports = await buildReports(client, other.company, snapshot);
      expect(reports.length).toBeGreaterThan(150);
      expect(reports.filter((report) => report.classification === "UNSAFE" || report.classification === "CONDITIONAL").map((report) => `${report.table}: ${report.reason}`)).toEqual([]);
      const readiness = computeBlockers(reports, snapshot, "test", { code: "DEV-CDR", environment: "development" });
      expect(readiness.blockers).toEqual([]);
      expect(readiness.cycle).toEqual([]);
      expect(domainCoverageProblems()).toEqual([]);
    });
  }, 300_000);
});
