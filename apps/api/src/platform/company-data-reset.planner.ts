import { createHash } from "node:crypto";

import type pg from "pg";

import {
  AUTO_DEPENDENCY_DOMAINS,
  DOMAIN_TABLES,
  domainCoverageProblems,
  domainOf,
  type NormalizedResetRequest,
  PROTECTED_DOMAINS,
  type ResetDomain,
} from "./company-data-reset.domains.js";
import {
  collectInboundReferences,
  dependencyOrder,
  type ForeignKey,
  introspectSchema,
  quoteIdentifier,
  type SchemaSnapshot,
} from "./reset-company-test-data.manifest.js";
import { engineManifest } from "./reset-company-test-data.engine.js";

/**
 * COMPANY DATA RESET PLANNER (Company Data Reset, Prompt 1).
 *
 * Builds ONE deterministic reset plan from the live database, read-only:
 *   - the table-level part: the selected domains, plus OPERATIONAL /
 *     FINANCIAL when rows in them reference what is removed (a shown
 *     REQUIRED DEPENDENCY); a needed protected domain (Traders & Customers,
 *     Workforce, Integrations) or a preserved table is a BLOCKED dependency;
 *   - the user part: every Company account classified, with its exact
 *     membership / roles / access / Employee / Driver / identity handling;
 *   - a `planVersion` (sha256 of the canonical plan, including row counts and
 *     row versions). Execution rebuilds the plan under lock and refuses a
 *     different version (reset_plan_stale): nothing is discovered during
 *     execution that the preview did not show.
 */

export type UserClassification =
  | "KEEP"
  | "ELIGIBLE"
  | "PROTECTED"
  | "PROTECTED_PLATFORM_ADMIN"
  | "BLOCKED"
  | "SHARED_IDENTITY_PRESERVE"
  | "DEPENDENCY_REVIEW";

export type WorkforceAction = "DELETE" | "DETACH" | "KEEP" | "DELETE_WITH_DOMAIN";
export type IdentityAction = "KEEP" | "DELETE" | "PRESERVE_HISTORY" | "PRESERVE_SHARED";

export interface ReferenceCount {
  readonly table: string;
  readonly column: string;
  readonly rows: number;
}

export interface WorkforcePlan {
  readonly kind: "employee" | "driver";
  readonly id: string;
  readonly reference: string;
  readonly name: string;
  readonly version: string;
  readonly action: WorkforceAction;
  readonly reason: string;
  /** Rows that keep this record (DETACH) -- history the reset preserves. */
  readonly historyReferences: readonly ReferenceCount[];
  /** Owned configuration rows removed together with the record (DELETE). */
  readonly ownedRows: readonly ReferenceCount[];
}

export interface UserPlan {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly accountKind: string;
  readonly status: string;
  readonly version: string;
  readonly isCompanyAdmin: boolean;
  readonly isActiveAdmin: boolean;
  /** This Company's role names for the account (sorted). */
  readonly roles: readonly string[];
  /**
   * Selection state, independent of the current request: what deleting this
   * account WOULD mean. PROTECTED = Company Admin (deleted only with an
   * explicit admin confirmation); SHARED = another Company uses the identity
   * (only this Company's access would be removed); ELIGIBLE otherwise.
   */
  readonly eligibility: { readonly state: "ELIGIBLE" | "PROTECTED" | "SHARED" | "BLOCKED"; readonly reason: string | null };
  readonly classification: UserClassification;
  readonly reason: string | null;
  /** True only when this account's Company access is removed. */
  readonly remove: boolean;
  readonly membershipRemoved: number;
  readonly roleAssignmentsRemoved: number;
  readonly accessRowsRemoved: {
    readonly sessions: number;
    readonly resetTokens: number;
    readonly businessLinks: number;
    readonly deviceRegistrations: number;
  };
  readonly employee: WorkforcePlan | null;
  readonly driver: WorkforcePlan | null;
  readonly identity: { readonly action: IdentityAction; readonly references: readonly ReferenceCount[] };
}

export interface RequiredDependency {
  readonly domain: ResetDomain;
  readonly reason: string;
}

export interface CompanyDataResetPlan {
  readonly company: { readonly id: string; readonly code: string; readonly name: string; readonly environment: string };
  readonly request: NormalizedResetRequest;
  readonly effectiveDomains: readonly ResetDomain[];
  readonly requiredDependencies: readonly RequiredDependency[];
  /** Table-level removals, children first (execution order). */
  readonly tables: readonly { readonly table: string; readonly domain: ResetDomain; readonly rows: number }[];
  /** user_business_links removed because their Employee / Driver / Trader is removed (R4). */
  readonly entityLinksRemoved: number;
  /**
   * Fiscal calendar (configuration, never deleted). When the FINANCIAL domain
   * is reset, every fiscal year / accounting period of the Company is reopened
   * in the same transaction so the Company can post again -- the same rule the
   * legacy reset applied. IDs, dates, numbering and links are unchanged.
   */
  readonly fiscalCalendar: {
    readonly fiscalYearsPreserved: number;
    readonly periodsPreserved: number;
    readonly fiscalYearsToOpen: number;
    readonly periodsToOpen: number;
  };
  readonly users: readonly UserPlan[];
  readonly summary: CompanyDataResetSummary;
  /**
   * The Company's last executed Company Data Reset (audit reference), or null.
   * Part of planVersion: once a reset executes, every plan previewed before it
   * is stale -- the same approved plan can never execute twice.
   */
  readonly lastReset: { readonly auditEventId: string; readonly at: string } | null;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly executable: boolean;
  readonly confirmation: string;
  readonly planVersion: string;
}

export interface CountPair {
  readonly delete: number;
  readonly preserve: number;
}

export interface CompanyDataResetSummary {
  readonly orders: CountPair;
  readonly collections: CountPair;
  readonly settlements: CountPair;
  readonly accountingTransactions: CountPair;
  readonly payrollTransactions: CountPair;
  readonly traders: CountPair;
  readonly customers: CountPair;
  readonly employees: CountPair;
  readonly drivers: CountPair;
  readonly companyUsers: CountPair;
  readonly roleAssignmentsDeleted: number;
  readonly membershipsDeleted: number;
  readonly globalIdentities: CountPair;
  readonly protectedAdmins: number;
  readonly sharedIdentitiesPreserved: number;
  readonly platformRepairExecutions: "PRESERVE";
  readonly platformRepairAttempts: "PRESERVE";
  readonly generalAudit: "PRESERVE";
  /**
   * Business reference numbering (company_reference_counters: order,
   * settlement, collection, receivable, journal, ...): never reset. Numbering
   * continues after a reset so a removed record's number is never reused.
   */
  readonly referenceCounters: "PRESERVE";
}

/** Owned configuration of an Employee / Driver: removed with the record. */
const EMPLOYEE_OWNED: readonly { table: string; column: string }[] = [
  { column: "employee_id", table: "employee_allowances" },
  { column: "employee_id", table: "employee_salary_versions" },
  { column: "employee_id", table: "employee_collection_earning_rules" },
  { column: "employee_id", table: "employee_delivery_earning_rules" },
  { column: "employee_id", table: "hr_documents" },
];
const DRIVER_OWNED: readonly { table: string; column: string }[] = [
  { column: "driver_id", table: "driver_documents" },
  { column: "driver_id", table: "driver_commission_rules" },
  { column: "driver_id", table: "outsourced_driver_collection_earning_rules" },
  { column: "driver_id", table: "outsourced_driver_fee_versions" },
  { column: "driver_id", table: "hr_documents" },
];
/** hr_document_attachments belong to hr_documents (removed with them). */
const OWNED_GRANDCHILD = { column: "document_id", parent: "hr_documents", table: "hr_document_attachments" };

/** Per-account access rows removed by the user step (never history). */
export const ACCESS_REFERENCES = new Set([
  "account_sessions.account_id",
  "password_reset_tokens.account_id",
  "account_roles.account_id",
  "company_users.account_id",
  "user_business_links.account_id",
  "device_registrations.account_id",
]);

const ADMIN_SQL = (alias: string) => `exists (
  select 1 from account_roles ar
    join roles r on r.id = ar.role_id and r.company_id = ar.company_id
    left join role_permissions rp on rp.role_id = r.id
   where ar.account_id = ${alias}.id and ar.company_id = $1
     and (lower(r.code) = 'company_admin' or rp.permission_code = 'users_roles.manage'))`;
/** The existing last-administrator rule (user administration): active account + active role with users_roles.manage. */
const ACTIVE_ADMIN_SQL = (alias: string) => `(${alias}.status = 'active' and exists (
  select 1 from account_roles ar
    join roles r on r.id = ar.role_id and r.is_active
    join role_permissions rp on rp.role_id = r.id
   where ar.account_id = ${alias}.id and ar.company_id = $1 and rp.permission_code = 'users_roles.manage'))`;
const SHARED_SQL = (alias: string) => `(
  exists (select 1 from company_users o where o.account_id = ${alias}.id and o.company_id <> $1)
  or exists (select 1 from account_roles o where o.account_id = ${alias}.id and o.company_id is distinct from $1)
  or exists (select 1 from user_business_links o where o.account_id = ${alias}.id and o.company_id <> $1)
  or exists (select 1 from account_sessions o where o.account_id = ${alias}.id and o.company_id <> $1)
  or exists (select 1 from password_reset_tokens o where o.account_id = ${alias}.id and o.company_id <> $1))`;

const q = quoteIdentifier;
/** The engine's approved guard procedure (single source of truth). */
export const APPROVED_TRIGGERS: ReadonlySet<string> = engineManifest.APPROVED_TRIGGER_NAMES;
const count = async (client: pg.PoolClient, text: string, values: unknown[]): Promise<number> =>
  Number((await client.query<{ n: string }>(text, values)).rows[0]?.n ?? 0);

function nonCompanyColumns(key: ForeignKey): string[] {
  return key.childColumns.filter((column) => column !== "company_id");
}

export class CompanyNotFoundForReset extends Error {}

export interface PlanOptions {
  /** Execution: take row locks on the Company, accounts and workforce rows. */
  readonly lock?: boolean;
  readonly snapshot?: SchemaSnapshot;
}

export async function buildCompanyDataResetPlan(
  client: pg.PoolClient,
  companyId: string,
  request: NormalizedResetRequest,
  options: PlanOptions = {},
): Promise<CompanyDataResetPlan> {
  const lock = options.lock === true ? " for update" : "";
  const company = (
    await client.query<{ id: string; code: string; name_en: string; environment: string; version: string }>(
      `select id, code, name_en, environment, version::text from companies where id = $1${lock}`,
      [companyId],
    )
  ).rows[0];
  if (company === undefined) throw new CompanyNotFoundForReset(companyId);

  const blockers: string[] = [];
  const warnings: string[] = [];
  if ((process.env.NODE_ENV ?? "development").trim().toLowerCase() === "production") {
    blockers.push("NODE_ENV is production: Company Data Reset is a non-production capability.");
  }
  if (company.environment === "production") {
    blockers.push(`Company '${company.code}' is in production. Production data can never be reset.`);
  }
  for (const problem of domainCoverageProblems()) blockers.push(`Reset domain map: ${problem}`);

  const snapshot = options.snapshot ?? (await introspectSchema(client));

  // ------------------------------------------------------------------ users
  const accounts = (
    await client.query<{
      id: string;
      username: string;
      displayName: string;
      kind: string;
      status: string;
      version: string;
      companyUserId: string | null;
      isAdmin: boolean;
      isActiveAdmin: boolean;
      shared: boolean;
      roles: string[];
    }>(
      `select a.id, a.username, coalesce(nullif(btrim(cu.display_name), ''), nullif(btrim(cu.name_en), ''), a.username) as "displayName",
              a.account_kind as kind, a.status, a.version::text as version, cu.id as "companyUserId",
              ${ADMIN_SQL("a")} as "isAdmin", ${ACTIVE_ADMIN_SQL("a")} as "isActiveAdmin", ${SHARED_SQL("a")} as shared,
              array(select r.name from account_roles ar join roles r on r.id = ar.role_id
                     where ar.account_id = a.id and ar.company_id = $1 order by r.name, r.id) as roles
         from accounts a
         left join company_users cu on cu.account_id = a.id and cu.company_id = $1
        where a.company_id = $1 and a.account_kind <> 'platform_administrator'
        order by lower(a.username), a.id${options.lock === true ? " for update of a" : ""}`,
      [companyId],
    )
  ).rows;
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  // Requested ids that are not this Company's accounts: Platform admins or unknown.
  const requested = [...new Set([...request.selectedAccountIds, ...request.deleteAdminAccountIds])];
  const foreign = requested.filter((id) => !accountById.has(id));
  const platformAdmins = new Set(
    foreign.length === 0
      ? []
      : (
          await client.query<{ id: string }>(
            "select id from accounts where id = any($1::uuid[]) and account_kind = 'platform_administrator'",
            [foreign],
          )
        ).rows.map((row) => row.id),
  );

  // Who is asked to be removed?
  const wantsRemoval = new Set<string>();
  if (request.userMode === "DELETE_SELECTED_USERS") request.selectedAccountIds.forEach((id) => wantsRemoval.add(id));
  if (request.userMode === "DELETE_ALL_ELIGIBLE_USERS") {
    // Every Company account, admins included: an admin not explicitly confirmed is classified PROTECTED (kept).
    for (const account of accounts) wantsRemoval.add(account.id);
    request.deleteAdminAccountIds.forEach((id) => wantsRemoval.add(id));
  }
  const adminDeleteConfirmed = new Set(request.deleteAdminAccountIds);

  // Admin protection: explicit confirmation, then LAST_REQUIRED_COMPANY_ADMIN.
  const removable = new Set<string>();
  const classification = new Map<string, { value: UserClassification; reason: string | null }>();
  for (const id of [...wantsRemoval].sort()) {
    const account = accountById.get(id);
    if (account === undefined) continue;
    if (account.isAdmin && !adminDeleteConfirmed.has(id)) {
      classification.set(id, {
        reason: "Company Admin: kept unless its deletion is explicitly confirmed (deleteAdminAccountIds).",
        value: "PROTECTED",
      });
      continue;
    }
    removable.add(id);
  }
  const activeAdmins = accounts.filter((account) => account.isActiveAdmin);
  const remainingActiveAdmins = activeAdmins.filter((account) => !removable.has(account.id));
  if (activeAdmins.length > 0 && remainingActiveAdmins.length === 0) {
    // Keep the first active admin (deterministic: username, id) so the Company stays accessible.
    const keep = activeAdmins.filter((account) => removable.has(account.id))[0]!;
    removable.delete(keep.id);
    classification.set(keep.id, {
      reason: "LAST_REQUIRED_COMPANY_ADMIN: removing it would leave the Company without an active administrator.",
      value: "PROTECTED",
    });
  }
  for (const id of removable) {
    const account = accountById.get(id)!;
    classification.set(id, account.shared
      ? { reason: "Another Company still uses this identity: only this Company's access is removed.", value: "SHARED_IDENTITY_PRESERVE" }
      : { reason: null, value: "ELIGIBLE" });
  }

  // --------------------------------------------------- table-level domains
  const selected = new Set(request.selectedDomains);
  const effective = new Set(selected);
  const requiredDependencies: RequiredDependency[] = [];
  const blockedSeen = new Set<string>();
  const tableRows = new Map<string, number>();
  const rowsOf = async (table: string) => {
    if (!tableRows.has(table)) {
      tableRows.set(table, await count(client, `select count(*)::bigint as n from ${q(table)} where company_id = $1`, [companyId]));
    }
    return tableRows.get(table)!;
  };
  for (let changed = true; changed; ) {
    changed = false;
    const purge = new Set(RESET_DOMAINS_IN(effective).flatMap((domain) => DOMAIN_TABLES[domain]));
    for (const [parent, children] of collectInboundReferences(snapshot.foreignKeys, purge)) {
      for (const child of [...children].sort()) {
        const keys = snapshot.foreignKeys.filter((key) => key.child === child && key.parent === parent);
        let referencing = 0;
        for (const key of keys) {
          const columns = nonCompanyColumns(key);
          if (columns.length === 0) continue;
          referencing += snapshot.companyScoped.has(child)
            ? await count(
                client,
                `select count(*)::bigint as n from ${q(child)} where company_id = $1 and ${columns.map((c) => `${q(c)} is not null`).join(" and ")}`,
                [companyId],
              )
            : 1; // not directly scoped: cannot prove absence, so treat as referencing
        }
        if (referencing === 0) continue;
        const domain = domainOf(child);
        const parentDomain = domainOf(parent);
        const why = `${child} -> ${parent}: ${referencing} row(s) (${parentDomain ?? "?"} needs ${domain ?? "a preserved table"})`;
        if (domain !== null && AUTO_DEPENDENCY_DOMAINS.has(domain) && !effective.has(domain)) {
          effective.add(domain);
          requiredDependencies.push({ domain, reason: why });
          changed = true;
        } else if (domain === null || PROTECTED_DOMAINS.has(domain)) {
          if (domain !== null && effective.has(domain)) continue;
          const message = `Blocked dependency: ${why}. Select ${domain ?? "nothing (preserved)"} explicitly or keep ${parentDomain}.`;
          if (!blockedSeen.has(message)) {
            blockedSeen.add(message);
            blockers.push(message);
          }
        }
      }
    }
  }
  const effectiveDomains = RESET_DOMAINS_IN(effective);
  const purgeTables = effectiveDomains.flatMap((domain) => DOMAIN_TABLES[domain]);
  const purgeSet = new Set(purgeTables);
  const { order, cycle, blocked } = dependencyOrder(purgeTables, snapshot.foreignKeys);
  if (cycle.length > 0 || blocked.length > 0) {
    blockers.push(`Unbroken foreign-key cycle in the removal set: ${[...cycle, ...blocked].join(", ")}`);
  }
  for (const table of purgeTables) {
    if (!snapshot.companyScoped.has(table)) blockers.push(`Removal-set table '${table}' is not directly Company-scoped.`);
  }
  // Every guard on a removed table must be in the approved procedure.
  for (const table of purgeTables) {
    for (const trigger of snapshot.guards.get(table) ?? []) {
      if (!APPROVED_TRIGGERS.has(trigger)) {
        blockers.push(`Guard ${table}.${trigger} is not in the approved reset procedure.`);
      }
    }
  }
  const tables = [];
  for (const table of order) tables.push({ domain: domainOf(table)!, rows: await rowsOf(table), table });

  // ------------------------------------------------ workforce per account
  const workforceDomain = effective.has("WORKFORCE");
  const tradersDomain = effective.has("TRADERS_CUSTOMERS");
  const removedIds = [...removable].sort();
  const drivers = (
    await client.query<{ id: string; accountId: string | null; employeeId: string | null; code: string; name: string; version: string }>(
      `select id, account_id as "accountId", employee_id as "employeeId", code, name_en as name, version::text
         from drivers where company_id = $1 order by id${lock}`,
      [companyId],
    )
  ).rows;
  const employees = (
    await client.query<{ id: string; companyUserId: string | null; number: string | null; name: string; version: string }>(
      `select id, company_user_id as "companyUserId", employee_number as number, name_en as name, version::text
         from employees where company_id = $1 order by id${lock}`,
      [companyId],
    )
  ).rows;

  const ownedRemovalBlocked = (owned: readonly { table: string }[]): string | null => {
    for (const { table } of [...owned, OWNED_GRANDCHILD]) {
      for (const trigger of snapshot.guards.get(table) ?? []) {
        if (!APPROVED_TRIGGERS.has(trigger)) return `${table}.${trigger}`;
      }
    }
    for (const table of ["employees", "drivers"]) {
      for (const trigger of snapshot.guards.get(table) ?? []) {
        if (!APPROVED_TRIGGERS.has(trigger)) return `${table}.${trigger}`;
      }
    }
    return null;
  };

  /** History that keeps a workforce record: FK rows outside the removal set and outside its owned rows. */
  const historyOf = async (
    parent: "employees" | "drivers",
    id: string,
    owned: readonly { table: string; column: string }[],
    alsoRemoved: ReadonlySet<string>,
  ): Promise<ReferenceCount[]> => {
    const ownedTables = new Set([...owned.map((entry) => entry.table), OWNED_GRANDCHILD.table]);
    const references: ReferenceCount[] = [];
    for (const key of snapshot.foreignKeys.filter((entry) => entry.parent === parent)) {
      if (purgeSet.has(key.child) || ownedTables.has(key.child)) continue;
      const columns = nonCompanyColumns(key);
      if (columns.length !== 1) continue;
      const column = columns[0]!;
      const exclusion = key.child === "drivers" && alsoRemoved.size > 0 ? " and not (id = any($3::uuid[]))" : "";
      const rows = await count(
        client,
        `select count(*)::bigint as n from ${q(key.child)} where company_id = $1 and ${q(column)} = $2${exclusion}`,
        exclusion === "" ? [companyId, id] : [companyId, id, [...alsoRemoved]],
      );
      if (rows > 0) references.push({ column, rows, table: key.child });
    }
    // Second level: history that references the owned configuration rows.
    for (const ownedEntry of owned) {
      for (const key of snapshot.foreignKeys.filter((entry) => entry.parent === ownedEntry.table)) {
        if (purgeSet.has(key.child) || ownedTables.has(key.child)) continue;
        const columns = nonCompanyColumns(key);
        if (columns.length !== 1) continue;
        const rows = await count(
          client,
          `select count(*)::bigint as n from ${q(key.child)} c join ${q(ownedEntry.table)} o
              on o.id = c.${q(columns[0]!)} and o.company_id = c.company_id
            where c.company_id = $1 and o.${q(ownedEntry.column)} = $2`,
          [companyId, id],
        );
        if (rows > 0) references.push({ column: `${columns[0]!} (via ${ownedEntry.table})`, rows, table: key.child });
      }
    }
    return references.sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
  };
  const ownedCounts = async (owned: readonly { table: string; column: string }[], id: string) => {
    const rows: ReferenceCount[] = [];
    for (const entry of owned) {
      const n = await count(client, `select count(*)::bigint as n from ${q(entry.table)} where company_id = $1 and ${q(entry.column)} = $2`, [companyId, id]);
      if (n > 0) rows.push({ column: entry.column, rows: n, table: entry.table });
      if (entry.table === "hr_documents" && n > 0) {
        const attachments = await count(
          client,
          `select count(*)::bigint as n from hr_document_attachments a join hr_documents d on d.id = a.document_id
            where a.company_id = $1 and d.${q(entry.column)} = $2`,
          [companyId, id],
        );
        if (attachments > 0) rows.push({ column: `document_id (via hr_documents.${entry.column})`, rows: attachments, table: "hr_document_attachments" });
      }
    }
    return rows;
  };

  // Drivers first (an Employee-type Driver references its Employee).
  const driverPlans = new Map<string, WorkforcePlan>();
  const removedDriverIds = new Set<string>();
  const blockedOwned = ownedRemovalBlocked([...EMPLOYEE_OWNED, ...DRIVER_OWNED]);
  for (const driver of drivers) {
    if (driver.accountId === null || !removable.has(driver.accountId)) continue;
    let plan: WorkforcePlan;
    const base = { id: driver.id, kind: "driver" as const, name: driver.name, reference: driver.code, version: driver.version };
    if (workforceDomain) {
      plan = { ...base, action: "DELETE_WITH_DOMAIN", historyReferences: [], ownedRows: [], reason: "Workforce domain is reset." };
    } else {
      const history = await historyOf("drivers", driver.id, DRIVER_OWNED, new Set());
      if (history.length === 0 && blockedOwned === null) {
        plan = { ...base, action: "DELETE", historyReferences: [], ownedRows: await ownedCounts(DRIVER_OWNED, driver.id), reason: "No history references this Driver." };
      } else {
        plan = {
          ...base,
          action: "DETACH",
          historyReferences: history,
          ownedRows: [],
          reason: blockedOwned !== null && history.length === 0
            ? `Driver kept and unlinked from the login: guard ${blockedOwned} is not in the approved procedure.`
            : "Driver kept (history references it) and unlinked from the removed login.",
        };
      }
    }
    if (plan.action !== "DETACH") removedDriverIds.add(driver.id);
    driverPlans.set(driver.accountId, plan);
  }
  const employeePlans = new Map<string, WorkforcePlan>();
  const removedEmployeeIds = new Set<string>();
  for (const account of accounts) {
    if (!removable.has(account.id) || account.companyUserId === null) continue;
    const employee = employees.find((entry) => entry.companyUserId === account.companyUserId);
    if (employee === undefined) continue;
    const base = { id: employee.id, kind: "employee" as const, name: employee.name, reference: employee.number ?? employee.id, version: employee.version };
    let plan: WorkforcePlan;
    if (workforceDomain) {
      plan = { ...base, action: "DELETE_WITH_DOMAIN", historyReferences: [], ownedRows: [], reason: "Workforce domain is reset." };
    } else {
      const history = await historyOf("employees", employee.id, EMPLOYEE_OWNED, removedDriverIds);
      plan = history.length === 0 && blockedOwned === null
        ? { ...base, action: "DELETE", historyReferences: [], ownedRows: await ownedCounts(EMPLOYEE_OWNED, employee.id), reason: "No history references this Employee." }
        : { ...base, action: "DETACH", historyReferences: history, ownedRows: [], reason: "Employee kept (history references it) and unlinked from the removed user." };
    }
    if (plan.action !== "DETACH") removedEmployeeIds.add(employee.id);
    employeePlans.set(account.id, plan);
  }

  // Kept logins whose business record the domain reset removes.
  if (workforceDomain) {
    for (const driver of drivers) {
      if (driver.accountId !== null && !removable.has(driver.accountId)) {
        const account = accountById.get(driver.accountId);
        blockers.push(
          `Driver login '${account?.username ?? driver.accountId}' would remain without Driver ${driver.code}: ` +
            "choose a user mode that removes it, or keep the Workforce domain.",
        );
      }
    }
    const keptEmployeeUsers = accounts.filter(
      (account) => !removable.has(account.id) && account.companyUserId !== null && employees.some((e) => e.companyUserId === account.companyUserId),
    );
    if (keptEmployeeUsers.length > 0) {
      warnings.push(`${keptEmployeeUsers.length} kept user(s) lose their Employee record (Workforce domain reset); their logins are kept.`);
    }
  }
  if (tradersDomain) {
    const traderLogins = (
      await client.query<{ accountId: string; username: string }>(
        `select distinct l.account_id as "accountId", a.username from user_business_links l join accounts a on a.id = l.account_id
          where l.company_id = $1 and l.entity_type = 'trader' and a.account_kind = 'trader'`,
        [companyId],
      )
    ).rows;
    for (const login of traderLogins) {
      if (!removable.has(login.accountId)) {
        blockers.push(`Trader Portal login '${login.username}' would remain without its Trader: choose a user mode that removes it, or keep Traders & Customers.`);
      }
    }
  }

  // R4: links of ANY account to removed Employees / Drivers / Traders.
  const removedEntityTypes = [
    ...(workforceDomain ? ["employee", "driver"] : []),
    ...(tradersDomain ? ["trader"] : []),
  ];
  const entityLinksRemoved = await count(
    client,
    `select count(*)::bigint as n from user_business_links where company_id = $1 and (
       entity_type = any($2::text[])
       or (entity_type = 'employee' and entity_id = any($3::uuid[]))
       or (entity_type = 'driver' and entity_id = any($4::uuid[])))`,
    [companyId, removedEntityTypes, [...removedEmployeeIds], [...removedDriverIds]],
  );

  // --------------------------------------------- identity per removed user
  // Per-user access rows EXCLUDE the entity links counted above (and their
  // sessions): those are removed first by the entity-link step, so counting
  // them here too would announce more rows than execution removes (Prompt 3
  // preview accuracy).
  const entityLinkFilter = `(entity_type = any($3::text[])
       or (entity_type = 'employee' and entity_id = any($4::uuid[]))
       or (entity_type = 'driver' and entity_id = any($5::uuid[])))`;
  const entityLinkValues = [removedEntityTypes, [...removedEmployeeIds], [...removedDriverIds]];
  const accessCounts = async (accountId: string) => ({
    businessLinks: await count(
      client,
      `select count(*)::bigint as n from user_business_links where company_id = $1 and account_id = $2 and not ${entityLinkFilter}`,
      [companyId, accountId, ...entityLinkValues],
    ),
    deviceRegistrations: await count(client, "select count(*)::bigint as n from device_registrations where company_id = $1 and account_id = $2", [companyId, accountId]),
    resetTokens: await count(client, "select count(*)::bigint as n from password_reset_tokens where company_id = $1 and account_id = $2", [companyId, accountId]),
    sessions: await count(
      client,
      `select count(*)::bigint as n from account_sessions s where s.company_id = $1 and s.account_id = $2
          and not exists (select 1 from user_business_links l where l.id = s.profile_link_id and l.company_id = $1 and ${entityLinkFilter.replaceAll("entity_", "l.entity_")})`,
      [companyId, accountId, ...entityLinkValues],
    ),
  });
  const accountForeignKeys = (
    await client.query<{ child: string; column: string; action: string; nullable: boolean }>(
      `select c.relname as child, att.attname as column, con.confdeltype as action, not att.attnotnull as nullable
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public'
         join unnest(con.conkey, con.confkey) as k(child_attnum, parent_attnum) on true
         join pg_attribute att on att.attrelid = c.oid and att.attnum = k.child_attnum
         join pg_attribute patt on patt.attrelid = con.confrelid and patt.attnum = k.parent_attnum and patt.attname = 'id'
        where con.contype = 'f' and con.confrelid = 'public.accounts'::regclass
        group by c.relname, att.attname, con.confdeltype, att.attnotnull
        order by c.relname, att.attname`,
    )
  ).rows;
  const identityReferences = async (accountId: string): Promise<ReferenceCount[]> => {
    const references: ReferenceCount[] = [];
    for (const key of accountForeignKeys) {
      const name = `${key.child}.${key.column}`;
      if (ACCESS_REFERENCES.has(name) || purgeSet.has(key.child)) continue;
      if (key.action === "n" && key.nullable) continue; // SET NULL keeps the history row
      let text = `select count(*)::bigint as n from ${q(key.child)} where ${q(key.column)} = $1`;
      const values: unknown[] = [accountId];
      if (key.child === "accounts") text += " and id <> $1";
      if (key.child === "account_roles") {
        text += " and not (account_id = any($2::uuid[]))";
        values.push(removedIds);
      }
      if (key.child === "user_business_links") {
        text += ` and not (account_id = any($2::uuid[])) and not (company_id = $3 and (entity_type = any($4::text[])
                  or (entity_type = 'employee' and entity_id = any($5::uuid[])) or (entity_type = 'driver' and entity_id = any($6::uuid[]))))`;
        values.push(removedIds, companyId, removedEntityTypes, [...removedEmployeeIds], [...removedDriverIds]);
      }
      if (key.child === "drivers" && key.column === "account_id") {
        // Removed or detached Drivers no longer point at the login.
        const handled = [...driverPlans.values()].map((plan) => plan.id);
        text += " and not (id = any($2::uuid[]))";
        values.push(workforceDomain ? drivers.map((driver) => driver.id) : handled);
      }
      if (key.child === "employees") continue; // employees reference company_users, not accounts
      const rows = await count(client, text, values);
      if (rows > 0) references.push({ column: key.column, rows, table: key.child });
    }
    return references;
  };

  const users: UserPlan[] = [];
  for (const account of accounts) {
    const decided = classification.get(account.id);
    const remove = removable.has(account.id);
    const access = remove ? await accessCounts(account.id) : { businessLinks: 0, deviceRegistrations: 0, resetTokens: 0, sessions: 0 };
    let identity: UserPlan["identity"] = { action: "KEEP", references: [] };
    if (remove) {
      if (account.shared) identity = { action: "PRESERVE_SHARED", references: [] };
      else {
        const references = await identityReferences(account.id);
        identity = references.length === 0 ? { action: "DELETE", references } : { action: "PRESERVE_HISTORY", references };
      }
    }
    users.push({
      accessRowsRemoved: access,
      accountId: account.id,
      accountKind: account.kind,
      classification: decided?.value ?? "KEEP",
      displayName: account.displayName,
      driver: driverPlans.get(account.id) ?? null,
      employee: employeePlans.get(account.id) ?? null,
      identity,
      eligibility: account.isAdmin
        ? { reason: "Company Admin: deleted only with an explicit admin confirmation.", state: "PROTECTED" }
        : account.shared
          ? { reason: "Another Company uses this identity: only this Company's access would be removed.", state: "SHARED" }
          : { reason: null, state: "ELIGIBLE" },
      isActiveAdmin: account.isActiveAdmin,
      isCompanyAdmin: account.isAdmin,
      membershipRemoved: remove && account.companyUserId !== null ? 1 : 0,
      reason: decided?.reason ?? null,
      remove,
      roles: account.roles,
      roleAssignmentsRemoved: remove
        ? await count(client, "select count(*)::bigint as n from account_roles where company_id = $1 and account_id = $2", [companyId, account.id])
        : 0,
      status: account.status,
      username: account.username,
      version: account.version,
    });
  }
  for (const id of requested.filter((entry) => !accountById.has(entry)).sort()) {
    const platform = platformAdmins.has(id);
    users.push({
      accessRowsRemoved: { businessLinks: 0, deviceRegistrations: 0, resetTokens: 0, sessions: 0 },
      accountId: id,
      accountKind: platform ? "platform_administrator" : "unknown",
      classification: platform ? "PROTECTED_PLATFORM_ADMIN" : "BLOCKED",
      displayName: platform ? "Platform administrator" : "Unknown account",
      driver: null,
      eligibility: {
        reason: platform ? "Platform / Super Admin identities are never removed by a Company Data Reset." : "Not an account of this Company.",
        state: "BLOCKED",
      },
      employee: null,
      identity: { action: "KEEP", references: [] },
      isActiveAdmin: false,
      isCompanyAdmin: false,
      membershipRemoved: 0,
      reason: platform
        ? "Platform / Super Admin identities are never removed by a Company Data Reset."
        : "Not an account of this Company.",
      remove: false,
      roles: [],
      roleAssignmentsRemoved: 0,
      status: "n/a",
      username: platform ? "(platform)" : "(unknown)",
      version: "0",
    });
  }
  // Deterministic handling for every SELECTED user before execution.
  if (request.userMode === "DELETE_SELECTED_USERS") {
    for (const user of users) {
      if (!request.selectedAccountIds.includes(user.accountId)) continue;
      if (["PROTECTED", "PROTECTED_PLATFORM_ADMIN", "BLOCKED", "DEPENDENCY_REVIEW"].includes(user.classification)) {
        blockers.push(`Selected account '${user.username}' is ${user.classification}: ${user.reason ?? ""} Deselect it to continue.`);
      }
    }
  } else {
    for (const user of users.filter((entry) => entry.classification === "PROTECTED_PLATFORM_ADMIN" || entry.classification === "BLOCKED")) {
      blockers.push(`Account '${user.accountId}' is ${user.classification}: ${user.reason ?? ""}`);
    }
  }

  // ---------------------------------------------------------------- summary
  const pair = async (table: string, domain: ResetDomain, rowLevelDeletes = 0): Promise<CountPair> => {
    const total = await rowsOf(table);
    const removedAll = effective.has(domain);
    const deleted = removedAll ? total : rowLevelDeletes;
    return { delete: deleted, preserve: total - deleted };
  };
  const removedUsers = users.filter((user) => user.remove);
  const summary: CompanyDataResetSummary = {
    accountingTransactions: await pair("journal_entries", "FINANCIAL"),
    collections: await pair("trader_collections", "FINANCIAL"),
    companyUsers: { delete: removedUsers.length, preserve: accounts.length - removedUsers.length },
    customers: await pair("customers", "TRADERS_CUSTOMERS"),
    drivers: await pair("drivers", "WORKFORCE", removedDriverIds.size),
    employees: await pair("employees", "WORKFORCE", removedEmployeeIds.size),
    generalAudit: "PRESERVE",
    referenceCounters: "PRESERVE",
    globalIdentities: {
      delete: removedUsers.filter((user) => user.identity.action === "DELETE").length,
      preserve: removedUsers.filter((user) => user.identity.action !== "DELETE").length,
    },
    membershipsDeleted: removedUsers.reduce((total, user) => total + user.membershipRemoved, 0),
    orders: await pair("orders", "OPERATIONAL"),
    payrollTransactions: await pair("payroll_entries", "FINANCIAL"),
    platformRepairAttempts: "PRESERVE",
    platformRepairExecutions: "PRESERVE",
    protectedAdmins: users.filter((user) => user.isCompanyAdmin && !user.remove).length,
    roleAssignmentsDeleted: removedUsers.reduce((total, user) => total + user.roleAssignmentsRemoved, 0),
    settlements: await pair("trader_settlements", "FINANCIAL"),
    sharedIdentitiesPreserved: removedUsers.filter((user) => user.identity.action === "PRESERVE_SHARED").length,
    traders: await pair("traders", "TRADERS_CUSTOMERS"),
  };
  for (const dependency of requiredDependencies) {
    warnings.push(`Required dependency: ${dependency.domain} is also reset (${dependency.reason}).`);
  }
  for (const user of removedUsers) {
    if (user.identity.action === "PRESERVE_HISTORY") {
      warnings.push(`Login '${user.username}' is disabled and preserved: history still references it (${user.identity.references.map((r) => `${r.table}.${r.column}`).join(", ")}).`);
    }
  }
  const financialReset = effective.has("FINANCIAL");
  const calendar = (
    await client.query<{ years: string; periods: string; yearsClosed: string; periodsClosed: string }>(
      `select (select count(*) from fiscal_years where company_id = $1)::text as years,
              (select count(*) from accounting_periods where company_id = $1)::text as periods,
              (select count(*) from fiscal_years where company_id = $1 and status is distinct from 'open')::text as "yearsClosed",
              (select count(*) from accounting_periods where company_id = $1 and status is distinct from 'open')::text as "periodsClosed"`,
      [companyId],
    )
  ).rows[0]!;
  const fiscalCalendar = {
    fiscalYearsPreserved: Number(calendar.years),
    fiscalYearsToOpen: financialReset ? Number(calendar.yearsClosed) : 0,
    periodsPreserved: Number(calendar.periods),
    periodsToOpen: financialReset ? Number(calendar.periodsClosed) : 0,
  };
  if (fiscalCalendar.fiscalYearsToOpen + fiscalCalendar.periodsToOpen > 0) {
    warnings.push(
      `Fiscal calendar: ${fiscalCalendar.fiscalYearsToOpen} fiscal year(s) and ${fiscalCalendar.periodsToOpen} period(s) will be reopened (Financial reset).`,
    );
  }
  const nothing = purgeTables.length === 0 && removedUsers.length === 0;
  if (nothing) warnings.push("Nothing would be reset with this selection.");

  const lastResetRow = (
    await client.query<{ id: string; at: string }>(
      `select id::text, occurred_at::text as at from audit_events
        where company_id = $1 and action = 'platform.company.data_reset.planned'
        order by occurred_at desc, id desc limit 1`,
      [companyId],
    )
  ).rows[0];
  const lastReset = lastResetRow === undefined ? null : { at: lastResetRow.at, auditEventId: lastResetRow.id };

  // Canonical version: request + domains + every count and row version used.
  const versionInput = {
    accounts: accounts.map((account) => [account.id, account.version, account.status, account.isAdmin, account.shared, account.companyUserId]),
    company: [company.id, company.version, company.environment],
    drivers: drivers.map((driver) => [driver.id, driver.version, driver.accountId, driver.employeeId]),
    effectiveDomains,
    employees: employees.map((employee) => [employee.id, employee.version, employee.companyUserId]),
    entityLinksRemoved,
    fiscalCalendar,
    lastReset,
    request,
    tables: [...tableRows.entries()].sort(([a], [b]) => a.localeCompare(b)),
    users: users.map((user) => [user.accountId, user.classification, user.remove, user.identity, user.employee, user.driver, user.accessRowsRemoved, user.roleAssignmentsRemoved, user.roles]),
  };
  const planVersion = `crp1:${createHash("sha256").update(JSON.stringify(versionInput)).digest("hex")}`;

  return {
    blockers,
    company: { code: company.code, environment: company.environment, id: company.id, name: company.name_en },
    confirmation: `RESET ${company.code}`,
    effectiveDomains,
    entityLinksRemoved,
    executable: blockers.length === 0 && !nothing,
    fiscalCalendar,
    lastReset,
    planVersion,
    request,
    requiredDependencies,
    summary,
    tables,
    users,
    warnings,
  };
}

function RESET_DOMAINS_IN(domains: ReadonlySet<ResetDomain>): ResetDomain[] {
  return (["OPERATIONAL", "FINANCIAL", "TRADERS_CUSTOMERS", "WORKFORCE", "INTEGRATIONS"] as const).filter((domain) =>
    domains.has(domain),
  );
}

export const WORKFORCE_OWNED = { DRIVER_OWNED, EMPLOYEE_OWNED, OWNED_GRANDCHILD };
