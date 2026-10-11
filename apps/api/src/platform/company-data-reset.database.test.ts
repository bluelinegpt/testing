import pg from "pg";
import { describe, expect, it } from "vitest";

import { normalizeResetRequest, type ResetPlanRequest } from "./company-data-reset.domains.js";
import { executeCompanyDataReset, ResetPlanNotExecutableError, ResetPlanStaleError } from "./company-data-reset.executor.js";
import {
  assertDisposableDatabase,
  AUDIT_TABLES,
  CONFIGURATION_TABLES,
  fingerprint,
  MASTER_TABLES,
  type ResetFixture,
  seedResetCompany,
  USER_TABLES,
  WORKFORCE_TABLES,
} from "./company-data-reset.fixture.js";
import { buildCompanyDataResetPlan, type CompanyDataResetPlan } from "./company-data-reset.planner.js";

/**
 * Company Data Reset, Prompt 1 -- planner + executor against a DISPOSABLE
 * database. Every test runs in one transaction that is rolled back, so the
 * database is unchanged afterwards. Enable with RUN_RESET_DATABASE=true.
 */

const runDatabase = process.env.RUN_RESET_DATABASE === "true";

async function inRolledBack<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  assertDisposableDatabase(process.env.DATABASE_URL);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    return await work(client);
  } finally {
    await client.query("rollback");
    client.release();
    await pool.end();
  }
}

const plan = (client: pg.PoolClient, fixture: ResetFixture, request: ResetPlanRequest) =>
  buildCompanyDataResetPlan(client, fixture.company, normalizeResetRequest(request));

async function previewAndExecute(client: pg.PoolClient, fixture: ResetFixture, request: ResetPlanRequest) {
  const preview = await plan(client, fixture, request);
  expect(preview.blockers, preview.blockers.join("\n")).toEqual([]);
  const outcome = await executeCompanyDataReset(client, fixture.company, normalizeResetRequest(request), preview.planVersion);
  return { outcome, preview };
}

const user = (preview: CompanyDataResetPlan, accountId: string) => preview.users.find((entry) => entry.accountId === accountId)!;
const rows = async (client: pg.PoolClient, sql: string, values: unknown[]) =>
  Number(Object.values((await client.query<Record<string, string>>(sql, values)).rows[0] ?? {})[0] ?? 0);

describe.skipIf(!runDatabase)("Company Data Reset -- planner and executor (disposable, rolled back)", () => {
  it("NON-NEGOTIABLE 1 / R7: OPERATIONAL_DATA resets operational data and keeps every user, workforce, master, configuration and audit row", async () => {
    await inRolledBack(async (client) => {
      const a = await seedResetCompany(client, "A");
      const kept = [...USER_TABLES, ...WORKFORCE_TABLES, ...MASTER_TABLES, ...CONFIGURATION_TABLES, ...AUDIT_TABLES];
      const before = await fingerprint(client, a.company, kept);
      const { preview, outcome } = await previewAndExecute(client, a, { preset: "OPERATIONAL_DATA" });
      expect(preview.effectiveDomains).toEqual(["OPERATIONAL"]);
      expect(preview.users.every((entry) => !entry.remove)).toBe(true);
      expect(preview.summary).toMatchObject({
        accountingTransactions: { delete: 0, preserve: 1 },
        companyUsers: { delete: 0, preserve: 5 },
        customers: { delete: 0, preserve: 1 },
        drivers: { delete: 0, preserve: 2 },
        employees: { delete: 0, preserve: 1 },
        orders: { delete: 1, preserve: 0 },
        platformRepairAttempts: "PRESERVE",
        platformRepairExecutions: "PRESERVE",
        traders: { delete: 0, preserve: 1 },
      });
      expect(outcome.integrityChecks).toContain("removal set empty");
      expect(await rows(client, "select count(*) from orders where company_id = $1", [a.company])).toBe(0);
      expect(await rows(client, "select count(*) from journal_entries where company_id = $1", [a.company])).toBe(1);
      expect(await fingerprint(client, a.company, kept)).toEqual(before);
    });
  });

  it("FINANCIAL_DATA resets financial data only: orders, users, workforce, masters and configuration stay", async () => {
    await inRolledBack(async (client) => {
      const a = await seedResetCompany(client, "A");
      const kept = ["orders", ...USER_TABLES, ...WORKFORCE_TABLES, ...MASTER_TABLES, ...CONFIGURATION_TABLES, ...AUDIT_TABLES];
      const before = await fingerprint(client, a.company, kept);
      const { preview } = await previewAndExecute(client, a, { preset: "FINANCIAL_DATA" });
      expect(preview.effectiveDomains).toEqual(["FINANCIAL"]);
      expect(preview.summary.accountingTransactions).toEqual({ delete: 1, preserve: 0 });
      expect(await rows(client, "select count(*) from accounting_events where company_id = $1", [a.company])).toBe(0);
      expect(await fingerprint(client, a.company, kept)).toEqual(before);
    });
  });

  it("NON-NEGOTIABLE 2 / R3 / R4: selecting ONLY the Employee user removes that user and its Employee exactly as previewed", async () => {
    await inRolledBack(async (client) => {
      const a = await seedResetCompany(client, "A");
      const request: ResetPlanRequest = { preset: "USERS_WORKFORCE", selectedAccountIds: [a.employeeUser], userMode: "DELETE_SELECTED_USERS" };
      const keptBefore = await fingerprint(client, a.company, [...MASTER_TABLES, ...CONFIGURATION_TABLES, "orders", "journal_entries"]);
      const preview = await plan(client, a, request);
      expect(preview.effectiveDomains).toEqual([]);
      expect(user(preview, a.employeeUser)).toMatchObject({
        classification: "ELIGIBLE",
        employee: { action: "DELETE", id: a.employee, reference: "EMP-0001" },
        identity: { action: "DELETE" },
        membershipRemoved: 1,
        remove: true,
        roleAssignmentsRemoved: 1,
      });
      expect(preview.entityLinksRemoved).toBe(1); // the Admin's link to EMP-0001 (R4)
      expect(preview.summary).toMatchObject({ companyUsers: { delete: 1, preserve: 4 }, employees: { delete: 1, preserve: 0 }, orders: { delete: 0, preserve: 1 } });
      const outcome = await executeCompanyDataReset(client, a.company, normalizeResetRequest(request), preview.planVersion);
      expect(outcome).toMatchObject({ employeesDeleted: 1, entityLinksRemoved: 1, identitiesDeleted: 1 });
      expect(await rows(client, "select count(*) from accounts where id = $1", [a.employeeUser])).toBe(0);
      expect(await rows(client, "select count(*) from employees where id = $1", [a.employee])).toBe(0);
      // Everyone and everything else remains.
      expect(await rows(client, "select count(*) from accounts where id = any($1::uuid[]) and status = 'active'", [[a.admin, a.ordinaryUser, a.driverUser, a.driverUserNoHistory]])).toBe(4);
      expect(await rows(client, "select count(*) from drivers where company_id = $1 and account_id is not null", [a.company])).toBe(2);
      expect(await rows(client, "select count(*) from account_roles where account_id = $1", [a.admin])).toBe(1);
      expect(await rows(client, "select count(*) from user_business_links where company_id = $1 and entity_type = 'employee'", [a.company])).toBe(0);
      expect(await fingerprint(client, a.company, [...MASTER_TABLES, ...CONFIGURATION_TABLES, "orders", "journal_entries"])).toEqual(keptBefore);
    });
  });

  it("NON-NEGOTIABLE 3 / R5: selecting ONLY a Driver user -- Driver with history is unlinked and kept, Driver without history is removed, no login survives", async () => {
    await inRolledBack(async (client) => {
      const a = await seedResetCompany(client, "A");
      const request: ResetPlanRequest = {
        preset: "USERS_WORKFORCE",
        selectedAccountIds: [a.driverUser, a.driverUserNoHistory],
        userMode: "DELETE_SELECTED_USERS",
      };
      const preview = await plan(client, a, request);
      expect(user(preview, a.driverUser).driver).toMatchObject({
        action: "DETACH",
        historyReferences: [
          { column: "driver_id", rows: 1, table: "order_assignments" },
          { column: "assigned_driver_id", rows: 1, table: "orders" },
        ],
        reference: "DRV-0001",
      });
      expect(user(preview, a.driverUserNoHistory).driver).toMatchObject({ action: "DELETE", reference: "DRV-0002" });
      expect(user(preview, a.driverUser).identity.action).toBe("DELETE");
      const outcome = await executeCompanyDataReset(client, a.company, normalizeResetRequest(request), preview.planVersion);
      expect(outcome).toMatchObject({ driversDeleted: 1, driversDetached: 1, identitiesDeleted: 2 });
      expect(await rows(client, "select count(*) from drivers where id = $1 and account_id is null", [a.driver])).toBe(1);
      expect(await rows(client, "select count(*) from drivers where id = $1", [a.driverNoHistory])).toBe(0);
      expect(await rows(client, "select count(*) from accounts where id = any($1::uuid[])", [[a.driverUser, a.driverUserNoHistory]])).toBe(0);
      expect(await rows(client, "select count(*) from accounts where id = any($1::uuid[]) and status = 'active'", [[a.admin, a.employeeUser, a.ordinaryUser]])).toBe(3);
      expect(await rows(client, "select count(*) from employees where id = $1 and company_user_id is not null", [a.employee])).toBe(1);
    });
  });

  it("NON-NEGOTIABLE 4: DELETE_ALL_ELIGIBLE_USERS removes every eligible user; the Company Admin and Platform admin are protected; nothing dangles", async () => {
    await inRolledBack(async (client) => {
      const a = await seedResetCompany(client, "A");
      const request: ResetPlanRequest = { preset: "USERS_WORKFORCE", userMode: "DELETE_ALL_ELIGIBLE_USERS" };
      const preview = await plan(client, a, request);
      expect(user(preview, a.admin)).toMatchObject({ classification: "PROTECTED", isCompanyAdmin: true, remove: false });
      expect(user(preview, a.ordinaryUser).identity).toMatchObject({
        action: "PRESERVE_HISTORY",
        references: [{ column: "created_by_account_id", rows: 1, table: "customers" }],
      });
      expect(preview.users.some((entry) => entry.accountId === a.platformAdmin)).toBe(false);
      expect(preview.summary).toMatchObject({
        companyUsers: { delete: 4, preserve: 1 },
        globalIdentities: { delete: 3, preserve: 1 },
        protectedAdmins: 1,
      });
      const outcome = await executeCompanyDataReset(client, a.company, normalizeResetRequest(request), preview.planVersion);
      expect(outcome).toMatchObject({ employeesDeleted: 1, identitiesDeleted: 3, identitiesPreserved: 1 });
      expect(await rows(client, "select count(*) from accounts where id = $1 and status = 'active'", [a.admin])).toBe(1);
      expect(await rows(client, "select count(*) from accounts where id = $1 and status = 'disabled'", [a.ordinaryUser])).toBe(1);
      expect(await rows(client, "select count(*) from company_users where company_id = $1", [a.company])).toBe(1);
      expect(await rows(client, "select count(*) from account_roles where company_id = $1", [a.company])).toBe(1);
      expect(await rows(client, "select count(*) from accounts where id = $1", [a.platformAdmin])).toBe(1);
      // No orphan workforce: removed or unlinked, never pointing at a removed login.
      expect(await rows(client, "select count(*) from employees where company_id = $1", [a.company])).toBe(0);
      expect(await rows(client, "select count(*) from drivers where company_id = $1 and account_id is not null", [a.company])).toBe(0);
      expect(await rows(client, "select count(*) from user_business_links where company_id = $1", [a.company])).toBe(0);
    });
  });

  it("R2: Company Admin KEEP / DELETE -- explicit confirmation, LAST_REQUIRED_COMPANY_ADMIN, and deletion when another admin remains", async () => {
    await inRolledBack(async (client) => {
      const a = await seedResetCompany(client, "A");
      // Selected without confirmation -> PROTECTED, plan blocked.
      const unconfirmed = await plan(client, a, { preset: "USERS_WORKFORCE", selectedAccountIds: [a.admin], userMode: "DELETE_SELECTED_USERS" });
      expect(user(unconfirmed, a.admin).classification).toBe("PROTECTED");
      expect(unconfirmed.executable).toBe(false);
      // Confirmed, but the only active admin -> LAST_REQUIRED_COMPANY_ADMIN.
      const last = await plan(client, a, {
        deleteAdminAccountIds: [a.admin],
        preset: "USERS_WORKFORCE",
        selectedAccountIds: [a.admin],
        userMode: "DELETE_SELECTED_USERS",
      });
      expect(user(last, a.admin)).toMatchObject({ classification: "PROTECTED", remove: false });
      expect(user(last, a.admin).reason).toMatch(/LAST_REQUIRED_COMPANY_ADMIN/u);
      await expect(
        executeCompanyDataReset(client, a.company, normalizeResetRequest({ deleteAdminAccountIds: [a.admin], preset: "USERS_WORKFORCE", selectedAccountIds: [a.admin], userMode: "DELETE_SELECTED_USERS" }), last.planVersion),
      ).rejects.toBeInstanceOf(ResetPlanNotExecutableError);
      // Promote the ordinary user to admin: the first admin may now be deleted.
      await client.query("insert into account_roles (account_id, role_id, company_id) values ($1, $2, $3)", [a.ordinaryUser, a.adminRole, a.company]);
      const request: ResetPlanRequest = { deleteAdminAccountIds: [a.admin], preset: "USERS_WORKFORCE", selectedAccountIds: [a.admin], userMode: "DELETE_SELECTED_USERS" };
      const allowed = await plan(client, a, request);
      expect(user(allowed, a.admin)).toMatchObject({ classification: "ELIGIBLE", remove: true });
      await executeCompanyDataReset(client, a.company, normalizeResetRequest(request), allowed.planVersion);
      expect(await rows(client, "select count(*) from company_users where account_id = $1", [a.admin])).toBe(0);
      expect(await rows(client, "select count(*) from accounts where id = $1 and status = 'active'", [a.ordinaryUser])).toBe(1);
    });
  });

  it("Platform admin protection and unknown ids: PROTECTED_PLATFORM_ADMIN / BLOCKED, never executable", async () => {
    await inRolledBack(async (client) => {
      const a = await seedResetCompany(client, "A");
      const preview = await plan(client, a, {
        preset: "USERS_WORKFORCE",
        selectedAccountIds: [a.platformAdmin, "00000000-0000-4000-8000-000000000000"],
        userMode: "DELETE_SELECTED_USERS",
      });
      expect(user(preview, a.platformAdmin).classification).toBe("PROTECTED_PLATFORM_ADMIN");
      expect(user(preview, "00000000-0000-4000-8000-000000000000").classification).toBe("BLOCKED");
      expect(preview.executable).toBe(false);
    });
  });

  it("NON-NEGOTIABLE 5 / R1: FULL_COMPANY_DATA_KEEP_COMPANY + KEEP_ALL_USERS resets business data and keeps every user and valid workforce link", async () => {
    await inRolledBack(async (client) => {
      const a = await seedResetCompany(client, "A");
      const kept = [...USER_TABLES, ...WORKFORCE_TABLES, ...MASTER_TABLES, ...CONFIGURATION_TABLES, ...AUDIT_TABLES];
      const before = await fingerprint(client, a.company, kept);
      const { preview } = await previewAndExecute(client, a, { preset: "FULL_COMPANY_DATA_KEEP_COMPANY", userMode: "KEEP_ALL_USERS" });
      expect(preview.effectiveDomains).toEqual(["OPERATIONAL", "FINANCIAL"]);
      expect(preview.summary.companyUsers).toEqual({ delete: 0, preserve: 5 });
      expect(await rows(client, "select count(*) from orders where company_id = $1", [a.company])).toBe(0);
      expect(await rows(client, "select count(*) from journal_entries where company_id = $1", [a.company])).toBe(0);
      expect(await fingerprint(client, a.company, kept)).toEqual(before);
    });
  });

  it("CASE 4: FULL + DELETE_SELECTED_USERS -- business data reset, ONLY the selected Employee user and its Employee removed", async () => {
    await inRolledBack(async (client) => {
      const a = await seedResetCompany(client, "A");
      const others = [a.admin, a.ordinaryUser, a.driverUser, a.driverUserNoHistory];
      const keptBefore = await fingerprint(client, a.company, [...MASTER_TABLES, ...CONFIGURATION_TABLES, ...AUDIT_TABLES, "drivers"]);
      const { preview, outcome } = await previewAndExecute(client, a, {
        preset: "FULL_COMPANY_DATA_KEEP_COMPANY",
        selectedAccountIds: [a.employeeUser],
        userMode: "DELETE_SELECTED_USERS",
      });
      expect(preview.effectiveDomains).toEqual(["OPERATIONAL", "FINANCIAL"]);
      expect(preview.users.filter((entry) => entry.remove).map((entry) => entry.accountId)).toEqual([a.employeeUser]);
      expect(outcome).toMatchObject({ employeesDeleted: 1, identitiesDeleted: 1 });
      expect(await rows(client, "select count(*) from orders where company_id = $1", [a.company])).toBe(0);
      expect(await rows(client, "select count(*) from accounts where id = any($1::uuid[]) and status = 'active'", [others])).toBe(4);
      expect(await rows(client, "select count(*) from accounts where id = $1", [a.employeeUser])).toBe(0);
      expect(await fingerprint(client, a.company, [...MASTER_TABLES, ...CONFIGURATION_TABLES, ...AUDIT_TABLES, "drivers"])).toEqual(keptBefore);
    });
  });

  it("Fiscal calendar: a Financial reset reopens closed fiscal years / periods exactly as previewed (IDs and dates unchanged)", async () => {
    await inRolledBack(async (client) => {
      const a = await seedResetCompany(client, "A");
      await client.query("update accounting_periods set status = 'closed' where company_id = $1", [a.company]);
      const before = (await client.query("select id, period_start, period_end, fiscal_year_id from accounting_periods where company_id = $1 order by id", [a.company])).rows;
      const operational = await plan(client, a, { preset: "OPERATIONAL_DATA" });
      expect(operational.fiscalCalendar).toMatchObject({ fiscalYearsToOpen: 0, periodsToOpen: 0 });
      const { preview, outcome } = await previewAndExecute(client, a, { preset: "FINANCIAL_DATA" });
      expect(preview.fiscalCalendar).toMatchObject({ periodsPreserved: 1, periodsToOpen: 1 });
      expect(outcome).toMatchObject({ periodsOpened: 1 });
      expect(outcome.integrityChecks).toContain("fiscal calendar reopened after Financial reset");
      expect((await client.query("select id, period_start, period_end, fiscal_year_id from accounting_periods where company_id = $1 order by id", [a.company])).rows).toEqual(before);
      expect(await rows(client, "select count(*) from accounting_periods where company_id = $1 and status = 'open'", [a.company])).toBe(1);
    });
  });

  it("FULL + Workforce RESET + KEEP_ALL_USERS is BLOCKED (Driver logins would survive their Drivers); with DELETE_ALL_ELIGIBLE it runs consistently", async () => {
    await inRolledBack(async (client) => {
      const a = await seedResetCompany(client, "A");
      const blocked = await plan(client, a, { preset: "FULL_COMPANY_DATA_KEEP_COMPANY", userMode: "KEEP_ALL_USERS", workforce: "RESET" });
      expect(blocked.executable).toBe(false);
      expect(blocked.blockers.join("\n")).toMatch(/Driver login .* would remain without Driver DRV-0001/u);
      const { outcome, preview } = await previewAndExecute(client, a, {
        preset: "FULL_COMPANY_DATA_KEEP_COMPANY",
        userMode: "DELETE_ALL_ELIGIBLE_USERS",
        workforce: "RESET",
      });
      expect(preview.effectiveDomains).toEqual(["OPERATIONAL", "FINANCIAL", "WORKFORCE"]);
      expect(outcome.entityLinksRemoved).toBe(3);
      expect(await rows(client, "select count(*) from employees where company_id = $1", [a.company])).toBe(0);
      expect(await rows(client, "select count(*) from drivers where company_id = $1", [a.company])).toBe(0);
      expect(await rows(client, "select count(*) from accounts where id = $1 and status = 'active'", [a.admin])).toBe(1);
      expect(await rows(client, "select count(*) from traders where company_id = $1", [a.company])).toBe(1);
    });
  });

  it("Traders & Customers are reset only when selected, with Operational shown as a required dependency", async () => {
    await inRolledBack(async (client) => {
      const a = await seedResetCompany(client, "A");
      const { preview } = await previewAndExecute(client, a, { domains: ["TRADERS_CUSTOMERS"], preset: "CUSTOM" });
      expect(preview.effectiveDomains).toEqual(["OPERATIONAL", "TRADERS_CUSTOMERS"]);
      expect(preview.requiredDependencies.map((dependency) => dependency.domain)).toEqual(["OPERATIONAL"]);
      expect(preview.warnings.join("\n")).toMatch(/Required dependency: OPERATIONAL/u);
      expect(await rows(client, "select count(*) from traders where company_id = $1", [a.company])).toBe(0);
      expect(await rows(client, "select count(*) from customers where company_id = $1", [a.company])).toBe(0);
      expect(await rows(client, "select count(*) from accounts where company_id = $1", [a.company])).toBe(5);
    });
  });

  it("RESET PLAN VERSION: a change after preview makes execution refuse with ResetPlanStaleError; nothing changes", async () => {
    await inRolledBack(async (client) => {
      const a = await seedResetCompany(client, "A");
      const request: ResetPlanRequest = { preset: "OPERATIONAL_DATA" };
      const preview = await plan(client, a, request);
      expect(preview.planVersion).toBe((await plan(client, a, request)).planVersion); // deterministic
      await client.query("update traders set name_en = 'Renamed' where id = $1", [a.trader]); // not in the plan: same version
      expect((await plan(client, a, request)).planVersion).toBe(preview.planVersion);
      await client.query(
        `insert into orders (company_id, order_number, order_date, trader_id, area_id, created_by_account_id, customer_name, customer_mobile_number,
           customer_address, package_count, payment_condition, final_service_fee_snapshot, customer_provenance_status, pricing_provenance_status, service_fee)
         values ($1, 'ORD-NEW-0002', '2026-01-16', $2, $4, $3, 'X', '971500000010', 'A', 1, 'customer_pays_cod_and_fee', 25, 'legacy_unattributed', 'legacy_unattributed', 25)`,
        [a.company, a.trader, a.admin, a.area],
      );
      await client.query("savepoint stale");
      await expect(executeCompanyDataReset(client, a.company, normalizeResetRequest(request), preview.planVersion)).rejects.toBeInstanceOf(ResetPlanStaleError);
      await client.query("rollback to savepoint stale");
      expect(await rows(client, "select count(*) from orders where company_id = $1", [a.company])).toBe(2);
    });
  });

  it("CROSS-COMPANY: resets of Company A never change Company B (same order / employee / driver / trader numbers)", async () => {
    await inRolledBack(async (client) => {
      const a = await seedResetCompany(client, "A");
      const b = await seedResetCompany(client, "B");
      const tables = [...USER_TABLES, ...WORKFORCE_TABLES, ...MASTER_TABLES, ...CONFIGURATION_TABLES, ...AUDIT_TABLES, "orders", "journal_entries", "accounting_events"];
      const before = await fingerprint(client, b.company, tables);
      await previewAndExecute(client, a, { preset: "FULL_COMPANY_DATA_KEEP_COMPANY", tradersCustomers: "RESET", userMode: "DELETE_ALL_ELIGIBLE_USERS", workforce: "RESET" });
      expect(await fingerprint(client, b.company, tables)).toEqual(before);
      expect(await rows(client, "select count(*) from orders where order_number = 'ORD-DUP-0001' and company_id = $1", [b.company])).toBe(1);
      expect(await rows(client, "select count(*) from employees where employee_number = 'EMP-0001' and company_id = $1", [b.company])).toBe(1);
      expect(await rows(client, "select count(*) from drivers where code = 'DRV-0001' and company_id = $1", [b.company])).toBe(1);
    });
  });

  it("request rules: presets never imply user deletion; explicit modes are required where they matter", () => {
    expect(() => normalizeResetRequest({ preset: "OPERATIONAL_DATA", userMode: "DELETE_ALL_ELIGIBLE_USERS" })).toThrow(/keeps every user/u);
    expect(() => normalizeResetRequest({ preset: "FULL_COMPANY_DATA_KEEP_COMPANY" })).toThrow(/explicit user mode/u);
    expect(() => normalizeResetRequest({ preset: "USERS_WORKFORCE" })).toThrow(/explicit user mode/u);
    expect(normalizeResetRequest({ preset: "FULL_COMPANY_DATA_KEEP_COMPANY", userMode: "KEEP_ALL_USERS" }).selectedDomains).toEqual(["OPERATIONAL", "FINANCIAL"]);
  });
});
