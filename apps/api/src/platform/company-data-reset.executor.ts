import type pg from "pg";

import type { NormalizedResetRequest } from "./company-data-reset.domains.js";
import {
  APPROVED_TRIGGERS,
  buildCompanyDataResetPlan,
  type CompanyDataResetPlan,
  WORKFORCE_OWNED,
} from "./company-data-reset.planner.js";
import { CYCLE_BREAKS, introspectSchema, quoteIdentifier } from "./reset-company-test-data.manifest.js";
import { deleteResetCompanyUserAccount } from "./platform-user-deletion.service.js";

/**
 * COMPANY DATA RESET EXECUTOR (Company Data Reset, Prompt 1).
 *
 * The caller owns ONE transaction and commits only on success. This function:
 *   1. rebuilds the plan under row locks and refuses a different planVersion
 *      (ResetPlanStaleError) or a non-executable plan;
 *   2. applies exactly that plan -- table-level domains (children first, the
 *      engine's approved guards suspended in this transaction only), then the
 *      per-user / per-Employee / per-Driver steps the preview listed;
 *   3. verifies the outcome (every identity disposition as planned, removal
 *      set empty, kept domains unchanged except planned rows, no dangling
 *      Employee / Driver / link reference, Platform identities and Repair
 *      Center / general audit untouched, guards restored) -- any mismatch
 *      throws, and the caller rolls everything back.
 * No dependency is discovered here that the preview did not show.
 */

export class ResetPlanStaleError extends Error {
  public constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super("The Company changed after the reset preview. Preview again before resetting.");
  }
}

export class ResetPlanNotExecutableError extends Error {
  public constructor(public readonly blockers: readonly string[]) {
    super(blockers.length > 0 ? `The reset plan is blocked: ${blockers.join(" | ")}` : "The reset plan changes nothing.");
  }
}

export class ResetIntegrityError extends Error {}

/** Same as the engine: these journal guards must be off for the cycle-breaking update. */
const NULLIFICATION_SUPPORT: readonly { table: string; triggers: readonly string[] }[] = [
  { table: "journal_entries", triggers: ["journal_entries_accounting_state_guard", "journal_entries_balance_before_post"] },
];

export interface CompanyDataResetOutcome {
  readonly plan: CompanyDataResetPlan;
  readonly removed: readonly { readonly table: string; readonly rows: number }[];
  readonly totalRemoved: number;
  readonly identitiesDeleted: number;
  readonly identitiesPreserved: number;
  readonly employeesDeleted: number;
  readonly employeesDetached: number;
  readonly driversDeleted: number;
  readonly driversDetached: number;
  readonly entityLinksRemoved: number;
  readonly fiscalYearsOpened: number;
  readonly periodsOpened: number;
  readonly integrityChecks: readonly string[];
}

const q = quoteIdentifier;
const one = async (client: pg.PoolClient, text: string, values: unknown[]): Promise<number> =>
  Number((await client.query<{ n: string }>(text, values)).rows[0]?.n ?? 0);

export async function executeCompanyDataReset(
  client: pg.PoolClient,
  companyId: string,
  request: NormalizedResetRequest,
  expectedPlanVersion: string,
): Promise<CompanyDataResetOutcome> {
  await client.query("select pg_advisory_xact_lock(hashtextextended('platform-company-reset', 0))");
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [companyId]);
  const snapshot = await introspectSchema(client);
  const plan = await buildCompanyDataResetPlan(client, companyId, request, { lock: true, snapshot });
  if (plan.planVersion !== expectedPlanVersion) throw new ResetPlanStaleError(expectedPlanVersion, plan.planVersion);
  if (!plan.executable) throw new ResetPlanNotExecutableError(plan.blockers);

  const purgeSet = new Set(plan.tables.map((entry) => entry.table));
  const removedUsers = plan.users.filter((user) => user.remove);
  const rowLevelWorkforce = removedUsers.some(
    (user) => user.employee?.action === "DELETE" || user.driver?.action === "DELETE",
  );

  // ---- before-state for verification
  const platformIdentitiesBefore = await one(client, "select count(*)::bigint as n from accounts where account_kind = 'platform_administrator'", []);
  const auditBefore = await auditCounts(client, companyId);
  const keptTables = [...snapshot.companyScoped].filter((table) => !purgeSet.has(table)).sort();
  const keptBefore = new Map<string, number>();
  for (const table of keptTables) {
    keptBefore.set(table, await one(client, `select count(*)::bigint as n from ${q(table)} where company_id = $1`, [companyId]));
  }

  // ---- 1. suspend the approved guards this plan needs (transaction-local)
  const guardedTables = new Set(purgeSet);
  if (rowLevelWorkforce) {
    for (const entry of [...WORKFORCE_OWNED.EMPLOYEE_OWNED, ...WORKFORCE_OWNED.DRIVER_OWNED]) guardedTables.add(entry.table);
    guardedTables.add(WORKFORCE_OWNED.OWNED_GRANDCHILD.table);
    guardedTables.add("employees");
    guardedTables.add("drivers");
  }
  const suspend: { table: string; trigger: string }[] = [];
  for (const table of [...guardedTables].sort()) {
    for (const trigger of snapshot.guards.get(table) ?? []) suspend.push({ table, trigger });
  }
  for (const support of NULLIFICATION_SUPPORT) {
    if (!purgeSet.has(support.table)) continue;
    for (const trigger of support.triggers) {
      if (!suspend.some((entry) => entry.table === support.table && entry.trigger === trigger)) suspend.push({ table: support.table, trigger });
    }
  }
  const unapproved = suspend.filter((entry) => !APPROVED_TRIGGERS.has(entry.trigger));
  if (unapproved.length > 0) {
    throw new ResetIntegrityError(`Guards not in the approved procedure: ${unapproved.map((e) => `${e.table}.${e.trigger}`).join(", ")}`);
  }
  for (const entry of suspend) await client.query(`alter table ${q(entry.table)} disable trigger ${q(entry.trigger)}`);

  const removed: { table: string; rows: number }[] = [];
  const record = (table: string, rows: number | null) => {
    if ((rows ?? 0) > 0) removed.push({ rows: rows ?? 0, table });
  };

  // ---- 2. R4 first: links (and their sessions) to every Employee / Driver / Trader this plan removes
  const workforceDomain = plan.effectiveDomains.includes("WORKFORCE");
  const tradersDomain = plan.effectiveDomains.includes("TRADERS_CUSTOMERS");
  const removedEntityTypes = [...(workforceDomain ? ["employee", "driver"] : []), ...(tradersDomain ? ["trader"] : [])];
  const rowEmployees = removedUsers.flatMap((user) => (user.employee?.action === "DELETE" ? [user.employee.id] : []));
  const rowDrivers = removedUsers.flatMap((user) => (user.driver?.action === "DELETE" ? [user.driver.id] : []));
  const linkFilter = `company_id = $1 and (entity_type = any($2::text[])
      or (entity_type = 'employee' and entity_id = any($3::uuid[])) or (entity_type = 'driver' and entity_id = any($4::uuid[])))`;
  const linkValues = [companyId, removedEntityTypes, rowEmployees, rowDrivers];
  record(
    "account_sessions (entity links)",
    (await client.query(`delete from account_sessions where company_id = $1 and profile_link_id in (select id from user_business_links where ${linkFilter})`, linkValues)).rowCount,
  );
  const entityLinks = (await client.query(`delete from user_business_links where ${linkFilter}`, linkValues)).rowCount ?? 0;
  if (entityLinks !== plan.entityLinksRemoved) {
    throw new ResetIntegrityError(`Entity links removed ${entityLinks}, planned ${plan.entityLinksRemoved}.`);
  }
  record("user_business_links (entity links)", entityLinks);

  // ---- 3. table-level domains, children first
  for (const entry of CYCLE_BREAKS) {
    if (!purgeSet.has(entry.table)) continue;
    await client.query(
      `update ${q(entry.table)} set ${entry.columns.map((c) => `${q(c)} = null`).join(", ")} where company_id = $1 and (${entry.columns
        .map((c) => `${q(c)} is not null`)
        .join(" or ")})`,
      [companyId],
    );
  }
  for (const entry of plan.tables) {
    const rows = (await client.query(`delete from ${q(entry.table)} where company_id = $1`, [companyId])).rowCount ?? 0;
    if (rows !== entry.rows) throw new ResetIntegrityError(`${entry.table}: removed ${rows}, planned ${entry.rows}.`);
    record(entry.table, rows);
  }

  // ---- 3b. fiscal calendar: reopened (never deleted) after a Financial reset, as planned
  let fiscalYearsOpened = 0;
  let periodsOpened = 0;
  if (plan.effectiveDomains.includes("FINANCIAL")) {
    fiscalYearsOpened =
      (await client.query("update fiscal_years set status = 'open' where company_id = $1 and status is distinct from 'open'", [companyId])).rowCount ?? 0;
    periodsOpened =
      (await client.query("update accounting_periods set status = 'open' where company_id = $1 and status is distinct from 'open'", [companyId])).rowCount ?? 0;
    if (fiscalYearsOpened !== plan.fiscalCalendar.fiscalYearsToOpen || periodsOpened !== plan.fiscalCalendar.periodsToOpen) {
      throw new ResetIntegrityError(
        `Fiscal calendar: opened ${fiscalYearsOpened}/${periodsOpened}, planned ${plan.fiscalCalendar.fiscalYearsToOpen}/${plan.fiscalCalendar.periodsToOpen}.`,
      );
    }
  }

  // ---- 4. per removed user: access, Driver, Employee, roles, membership
  let employeesDeleted = 0;
  let employeesDetached = 0;
  let driversDeleted = 0;
  let driversDetached = 0;
  for (const user of removedUsers) {
    const shared = user.identity.action === "PRESERVE_SHARED";
    // Each access step removes exactly what the preview announced for this user (Prompt 3).
    const planned = user.accessRowsRemoved;
    const exact = (what: string, rows: number | null, expected: number) => {
      if ((rows ?? 0) !== expected) throw new ResetIntegrityError(`${what} for '${user.username}': removed ${rows ?? 0}, planned ${expected}.`);
      record(what, rows);
    };
    exact("account_sessions", (await client.query("delete from account_sessions where company_id = $1 and account_id = $2", [companyId, user.accountId])).rowCount, planned.sessions);
    exact("password_reset_tokens", (await client.query("delete from password_reset_tokens where company_id = $1 and account_id = $2", [companyId, user.accountId])).rowCount, planned.resetTokens);
    exact("device_registrations", (await client.query("delete from device_registrations where company_id = $1 and account_id = $2", [companyId, user.accountId])).rowCount, planned.deviceRegistrations);
    await client.query(
      "delete from account_sessions where company_id = $1 and profile_link_id in (select id from user_business_links where company_id = $1 and account_id = $2)",
      [companyId, user.accountId],
    );
    exact("user_business_links", (await client.query("delete from user_business_links where company_id = $1 and account_id = $2", [companyId, user.accountId])).rowCount, planned.businessLinks);

    if (user.driver !== null && user.driver.action !== "DELETE_WITH_DOMAIN") {
      if (user.driver.action === "DELETE") {
        await removeOwned(client, companyId, WORKFORCE_OWNED.DRIVER_OWNED, user.driver.id, record);
        const rows = (await client.query("delete from drivers where company_id = $1 and id = $2", [companyId, user.driver.id])).rowCount ?? 0;
        if (rows !== 1) throw new ResetIntegrityError(`Driver ${user.driver.reference} was not removed as planned.`);
        driversDeleted += 1;
        record("drivers", rows);
      } else {
        const rows = (await client.query("update drivers set account_id = null, updated_at = now(), version = version + 1 where company_id = $1 and id = $2 and account_id = $3", [companyId, user.driver.id, user.accountId])).rowCount ?? 0;
        if (rows !== 1) throw new ResetIntegrityError(`Driver ${user.driver.reference} was not detached as planned.`);
        driversDetached += 1;
      }
    }
    if (!shared && user.status !== "disabled") {
      // The active-user-needs-a-role invariant: disable before removing roles.
      await client.query(
        "update accounts set status = 'disabled', deactivated_at = coalesce(deactivated_at, now()), updated_at = now(), version = version + 1 " +
          "where id = $1 and company_id = $2 and account_kind <> 'platform_administrator'",
        [user.accountId, companyId],
      );
    }
  }
  // Employees after every Driver (an Employee-type Driver references its Employee).
  for (const user of removedUsers) {
    if (user.employee !== null && user.employee.action !== "DELETE_WITH_DOMAIN") {
      if (user.employee.action === "DELETE") {
        await removeOwned(client, companyId, WORKFORCE_OWNED.EMPLOYEE_OWNED, user.employee.id, record);
        const rows = (await client.query("delete from employees where company_id = $1 and id = $2", [companyId, user.employee.id])).rowCount ?? 0;
        if (rows !== 1) throw new ResetIntegrityError(`Employee ${user.employee.reference} was not removed as planned.`);
        employeesDeleted += 1;
        record("employees", rows);
      } else {
        const rows = (await client.query("update employees set company_user_id = null, updated_at = now(), version = version + 1 where company_id = $1 and id = $2", [companyId, user.employee.id])).rowCount ?? 0;
        if (rows !== 1) throw new ResetIntegrityError(`Employee ${user.employee.reference} was not detached as planned.`);
        employeesDetached += 1;
      }
    }
  }
  for (const user of removedUsers) {
    const roles = (await client.query("delete from account_roles where company_id = $1 and account_id = $2", [companyId, user.accountId])).rowCount ?? 0;
    if (roles !== user.roleAssignmentsRemoved) throw new ResetIntegrityError(`Roles of '${user.username}': removed ${roles}, planned ${user.roleAssignmentsRemoved}.`);
    record("account_roles", roles);
    const membership = (await client.query("delete from company_users where company_id = $1 and account_id = $2", [companyId, user.accountId])).rowCount ?? 0;
    if (membership !== user.membershipRemoved) throw new ResetIntegrityError(`Membership of '${user.username}' not removed as planned.`);
    record("company_users", membership);
  }

  // ---- 5. identities, after every reference this plan removes is gone
  let identitiesDeleted = 0;
  let identitiesPreserved = 0;
  for (const user of removedUsers) {
    if (user.identity.action === "PRESERVE_SHARED") {
      identitiesPreserved += 1;
      continue;
    }
    const outcome = await deleteResetCompanyUserAccount(client, companyId, user.accountId);
    const planned = user.identity.action === "DELETE";
    if (outcome.deleted !== planned) {
      throw new ResetIntegrityError(
        `Identity '${user.username}': planned ${user.identity.action}, observed ${outcome.deleted ? "deleted" : "kept"} ` +
          `(${outcome.blockingReferences.map((r) => `${r.table}.${r.column}`).join(", ")}).`,
      );
    }
    if (outcome.deleted) {
      identitiesDeleted += 1;
      record("accounts", 1);
    } else identitiesPreserved += 1;
  }

  // ---- 6. restore and prove every guard is back
  for (const entry of suspend) await client.query(`alter table ${q(entry.table)} enable trigger ${q(entry.trigger)}`);
  const stillDisabled = (
    await client.query<{ name: string }>(
      "select c.relname || '.' || t.tgname as name from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and t.tgenabled <> 'O' and t.tgname = any($1)",
      [suspend.map((entry) => entry.trigger)],
    )
  ).rows;
  if (stillDisabled.length > 0) throw new ResetIntegrityError(`Guards not restored: ${stillDisabled.map((r) => r.name).join(", ")}`);

  // ---- 7. post-reset integrity
  const checks = await verifyCompanyAfterReset(client, companyId, {
    auditBefore,
    keptBefore,
    plan,
    platformIdentitiesBefore,
    removedRows: removed,
  });

  return {
    driversDeleted,
    driversDetached,
    employeesDeleted,
    employeesDetached,
    entityLinksRemoved: entityLinks,
    fiscalYearsOpened,
    periodsOpened,
    identitiesDeleted,
    identitiesPreserved,
    integrityChecks: checks,
    plan,
    removed,
    totalRemoved: removed.reduce((total, entry) => total + entry.rows, 0),
  };
}

async function removeOwned(
  client: pg.PoolClient,
  companyId: string,
  owned: readonly { table: string; column: string }[],
  id: string,
  record: (table: string, rows: number | null) => void,
): Promise<void> {
  for (const entry of owned) {
    if (entry.table === "hr_documents") {
      const documents = `select id from hr_documents where company_id = $1 and ${q(entry.column)} = $2`;
      await client.query(`update hr_document_attachments set replaced_by_attachment_id = null where company_id = $1 and document_id in (${documents})`, [companyId, id]);
      record("hr_document_attachments", (await client.query(`delete from hr_document_attachments where company_id = $1 and document_id in (${documents})`, [companyId, id])).rowCount);
      await client.query(`update hr_documents set replaced_by_document_id = null where company_id = $1 and ${q(entry.column)} = $2`, [companyId, id]);
    }
    record(entry.table, (await client.query(`delete from ${q(entry.table)} where company_id = $1 and ${q(entry.column)} = $2`, [companyId, id])).rowCount);
  }
}

async function auditCounts(client: pg.PoolClient, companyId: string) {
  const row = (
    await client.query<{ executions: string; attempts: string; audit: string }>(
      `select (select count(*) from platform_repair_executions where company_id = $1)::text as executions,
              (select count(*) from platform_repair_attempts where company_id = $1)::text as attempts,
              (select count(*) from audit_events where company_id = $1)::text as audit`,
      [companyId],
    )
  ).rows[0]!;
  return { attempts: Number(row.attempts), audit: Number(row.audit), executions: Number(row.executions) };
}

/** Post-reset integrity: any failure throws so the caller rolls back. */
export async function verifyCompanyAfterReset(
  client: pg.PoolClient,
  companyId: string,
  before: {
    readonly plan: CompanyDataResetPlan;
    readonly platformIdentitiesBefore: number;
    readonly auditBefore: { executions: number; attempts: number; audit: number };
    readonly keptBefore: ReadonlyMap<string, number>;
    readonly removedRows: readonly { table: string; rows: number }[];
  },
): Promise<string[]> {
  const failures: string[] = [];
  const passed: string[] = [];
  const check = (name: string, ok: boolean, detail = "") => (ok ? passed.push(name) : failures.push(`${name}${detail === "" ? "" : `: ${detail}`}`));

  check("company preserved", (await one(client, "select count(*)::bigint as n from companies where id = $1", [companyId])) === 1);
  check(
    "platform identities untouched",
    (await one(client, "select count(*)::bigint as n from accounts where account_kind = 'platform_administrator'", [])) === before.platformIdentitiesBefore,
  );
  const audit = await auditCounts(client, companyId);
  check("repair executions preserved", audit.executions === before.auditBefore.executions);
  check("repair attempts preserved", audit.attempts === before.auditBefore.attempts);
  check("general audit preserved", audit.audit >= before.auditBefore.audit);
  for (const entry of before.plan.tables) {
    const left = await one(client, `select count(*)::bigint as n from ${q(entry.table)} where company_id = $1`, [companyId]);
    if (left > 0) failures.push(`removal set not empty: ${entry.table} (${left})`);
  }
  passed.push("removal set empty");
  // Kept tables change only by rows this plan removed row by row.
  const plannedRowLevel = new Map<string, number>();
  for (const entry of before.removedRows) {
    const table = entry.table.split(" ")[0]!;
    if (!before.plan.tables.some((t) => t.table === table)) plannedRowLevel.set(table, (plannedRowLevel.get(table) ?? 0) + entry.rows);
  }
  for (const [table, rows] of before.keptBefore) {
    const after = await one(client, `select count(*)::bigint as n from ${q(table)} where company_id = $1`, [companyId]);
    const expected = rows - (plannedRowLevel.get(table) ?? 0);
    if (table === "audit_events") continue; // the reset audit row is written after this check
    if (after !== expected) failures.push(`kept table changed: ${table} (${rows} -> ${after}, expected ${expected})`);
  }
  passed.push("kept domains and configuration unchanged except planned rows");
  if (before.plan.effectiveDomains.includes("FINANCIAL")) {
    check(
      "fiscal calendar reopened after Financial reset",
      (await one(
        client,
        `select (select count(*) from fiscal_years where company_id = $1 and status is distinct from 'open')
              + (select count(*) from accounting_periods where company_id = $1 and status is distinct from 'open') as n`,
        [companyId],
      )) === 0,
    );
  }
  const dangling = await one(
    client,
    `select count(*)::bigint as n from user_business_links l where l.company_id = $1 and (
       (l.entity_type = 'employee' and not exists (select 1 from employees e where e.id = l.entity_id and e.company_id = l.company_id))
    or (l.entity_type = 'driver' and not exists (select 1 from drivers d where d.id = l.entity_id and d.company_id = l.company_id))
    or (l.entity_type = 'trader' and not exists (select 1 from traders t where t.id = l.entity_id and t.company_id = l.company_id)))`,
    [companyId],
  );
  check("no business link to a removed Employee / Driver / Trader", dangling === 0, `${dangling}`);
  const removedIds = before.plan.users.filter((user) => user.remove).map((user) => user.accountId);
  check(
    "no surviving access for removed users",
    (await one(
      client,
      `select (select count(*) from company_users where company_id = $1 and account_id = any($2::uuid[]))
            + (select count(*) from account_roles where company_id = $1 and account_id = any($2::uuid[]))
            + (select count(*) from account_sessions where company_id = $1 and account_id = any($2::uuid[]))
            + (select count(*) from user_business_links where company_id = $1 and account_id = any($2::uuid[])) as n`,
      [companyId, removedIds],
    )) === 0,
  );
  check(
    "removed users' Employees / Drivers removed or unlinked",
    (await one(
      client,
      `select (select count(*) from drivers where company_id = $1 and account_id = any($2::uuid[]))
            + (select count(*) from employees e join company_users cu on cu.id = e.company_user_id
                 where e.company_id = $1 and cu.account_id = any($2::uuid[])) as n`,
      [companyId, removedIds],
    )) === 0,
  );
  check(
    "preserved removed identities are disabled",
    (await one(
      client,
      "select count(*)::bigint as n from accounts where company_id = $1 and id = any($2::uuid[]) and status <> 'disabled'",
      [companyId, before.plan.users.filter((user) => user.remove && user.identity.action === "PRESERVE_HISTORY").map((user) => user.accountId)],
    )) === 0,
  );
  check(
    "active Company administrator still present when one existed",
    !before.plan.users.some((user) => user.isActiveAdmin) ||
      (await one(
        client,
        `select count(*)::bigint as n from accounts a where a.company_id = $1 and a.status = 'active' and exists (
           select 1 from account_roles ar join roles r on r.id = ar.role_id and r.is_active join role_permissions rp on rp.role_id = r.id
            where ar.account_id = a.id and ar.company_id = $1 and rp.permission_code = 'users_roles.manage')`,
        [companyId],
      )) > 0,
  );
  if (failures.length > 0) throw new ResetIntegrityError(`Post-reset integrity failed: ${failures.join("; ")}`);
  return passed;
}
