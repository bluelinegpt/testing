import { randomUUID } from "node:crypto";

import type pg from "pg";

import {
  normalizeResetRequest,
  RESET_DOMAINS,
  RESET_PRESETS,
  type NormalizedResetRequest,
  type ResetDomain,
  type ResetPlanRequest,
  type ResetPreset,
  type UserMode,
} from "./company-data-reset.domains.js";
import { ResetPlanNotExecutableError, ResetPlanStaleError } from "./company-data-reset.executor.js";
import { buildCompanyDataResetPlan, type CompanyDataResetPlan } from "./company-data-reset.planner.js";
import {
  type AuditedCompanyDataResetOutcome,
  auditCompanyDataResetFailure,
  type CompanyDataResetActor,
  executeAndAuditCompanyDataReset,
} from "./company-data-reset.service.js";

/**
 * COMPANY DATA RESET from the command line (Company Data Reset, Prompt 2).
 *
 * The CLIs (`reset:test-data`, `db:reset:dev`) contain NO deletion logic.
 * They parse an explicit reset intent, enforce a positive allow-list of
 * disposable environments, show the SAME plan the Platform portal previews,
 * and execute it through the SAME `executeAndAuditCompanyDataReset` (planner
 * + executor + integrity checks + audit) inside one transaction.
 *
 *   - no default preset: the operator must say what is reset;
 *   - user mode defaults to KEEP_ALL_USERS; any user deletion additionally
 *     needs --allow-user-deletion;
 *   - execution needs the planVersion printed by the dry run (a changed
 *     Company refuses: reset_plan_stale).
 */

export const CLI_USER_MODES: Readonly<Record<string, UserMode>> = {
  "all-eligible": "DELETE_ALL_ELIGIBLE_USERS",
  keep: "KEEP_ALL_USERS",
  selected: "DELETE_SELECTED_USERS",
};

export interface CliResetIntent {
  readonly request: ResetPlanRequest;
  readonly allowUserDeletion: boolean;
}

export class CliRefusal extends Error {}

const list = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

/** Explicit reset intent from CLI flags. Never infers a preset or a user deletion. */
export function parseResetIntent(valueOf: (name: string) => string, has: (name: string) => boolean): CliResetIntent {
  const preset = valueOf("--preset").toUpperCase().replace(/-/gu, "_");
  if (preset === "") {
    throw new CliRefusal(`--preset is required: one of ${RESET_PRESETS.join(", ")}.`);
  }
  if (!(RESET_PRESETS as readonly string[]).includes(preset)) {
    throw new CliRefusal(`Unknown --preset '${preset}'. Use one of ${RESET_PRESETS.join(", ")}.`);
  }
  const modeFlag = valueOf("--user-mode").toLowerCase();
  const userMode = modeFlag === "" ? undefined : CLI_USER_MODES[modeFlag];
  if (modeFlag !== "" && userMode === undefined) {
    throw new CliRefusal(`Unknown --user-mode '${modeFlag}'. Use keep, selected or all-eligible.`);
  }
  const domains = list(valueOf("--domains").toUpperCase().replace(/-/gu, "_"));
  for (const domain of domains) {
    if (!(RESET_DOMAINS as readonly string[]).includes(domain)) throw new CliRefusal(`Unknown domain '${domain}'.`);
  }
  const keepOrReset = (name: string): "KEEP" | "RESET" | undefined => {
    const value = valueOf(name).toUpperCase();
    if (value === "") return undefined;
    if (value !== "KEEP" && value !== "RESET") throw new CliRefusal(`${name} must be keep or reset.`);
    return value;
  };
  const selected = list(valueOf("--select"));
  const deleteAdmins = list(valueOf("--delete-admin"));
  const tradersCustomers = keepOrReset("--traders-customers");
  const workforce = keepOrReset("--workforce");
  const request: ResetPlanRequest = {
    preset: preset as ResetPreset,
    ...(domains.length > 0 ? { domains: domains as ResetDomain[] } : {}),
    // Presets that require an explicit mode get the CLI default KEEP_ALL_USERS
    // only when the operator passed --user-mode keep (or nothing for the
    // OPERATIONAL / FINANCIAL presets, which always keep users).
    ...(userMode !== undefined ? { userMode } : {}),
    ...(selected.length > 0 ? { selectedAccountIds: selected } : {}),
    ...(deleteAdmins.length > 0 ? { deleteAdminAccountIds: deleteAdmins } : {}),
    ...(tradersCustomers !== undefined ? { tradersCustomers } : {}),
    ...(workforce !== undefined ? { workforce } : {}),
  };
  const deletesUsers = userMode !== undefined && userMode !== "KEEP_ALL_USERS";
  if (deletesUsers && !has("--allow-user-deletion")) {
    throw new CliRefusal("This user mode deletes Company users: add --allow-user-deletion to confirm that intent explicitly.");
  }
  return { allowUserDeletion: has("--allow-user-deletion"), request };
}

/** Same normalisation as the portal; a request error becomes a CLI refusal. */
export function normalizeCliRequest(intent: CliResetIntent): NormalizedResetRequest {
  try {
    return normalizeResetRequest(intent.request);
  } catch (error) {
    throw new CliRefusal(error instanceof Error ? error.message : String(error));
  }
}

/**
 * `db:reset:dev`'s fixed intent: Operational + Financial data, KEEP_ALL_USERS
 * (the scope that script always documented). It never deletes users.
 */
export const DEVELOPMENT_RESET_REQUEST: NormalizedResetRequest = normalizeCliRequest({
  allowUserDeletion: false,
  request: { preset: "FULL_COMPANY_DATA_KEEP_COMPANY", userMode: "KEEP_ALL_USERS" },
});

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const DISPOSABLE_ENVIRONMENTS = new Set(["development", "test"]);

/**
 * POSITIVE allow-list: the application environment must be development or
 * test, and the database must be on this machine (local host or socket) with
 * a name that does not look like production. Unknown / unset / anything else
 * is refused. There is no override flag.
 */
export function disposableEnvironmentRefusal(environment: string | undefined, databaseUrl: string | undefined): string | null {
  const env = (environment ?? "").trim().toLowerCase();
  if (env === "production") return "Refusing to execute: the application environment is production. There is no bypass.";
  if (!DISPOSABLE_ENVIRONMENTS.has(env)) {
    return `Refusing to reset: environment '${env || "unset"}' is not an allowed disposable environment (development, test).`;
  }
  if (databaseUrl === undefined || databaseUrl.trim() === "") return "Refusing to reset: DATABASE_URL is not set.";
  let url: URL;
  try {
    // A socket URL ("postgresql://user@/db?host=/var/run/postgresql") has an empty host.
    url = new URL(databaseUrl.replace(/@\//u, "@socket.invalid/"));
  } catch {
    return "Refusing to reset: DATABASE_URL is not a valid connection URL.";
  }
  const socketHost = url.searchParams.get("host") ?? "";
  const host = url.hostname === "socket.invalid" || url.hostname === "" ? socketHost : url.hostname;
  const local = LOCAL_HOSTS.has(host.toLowerCase()) || host.startsWith("/");
  if (!local) return `Refusing to reset: database host '${host}' is not local. Company Data Reset CLIs run only against a local disposable database.`;
  const name = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (name === "" || /prod|live|shared/iu.test(name)) {
    return `Refusing to reset: database '${name || "unset"}' looks like a production or shared database.`;
  }
  return null;
}

/** Read-only plan, exactly what the portal preview shows (rolled back). */
export async function previewForCli(client: pg.PoolClient, companyId: string, request: NormalizedResetRequest): Promise<CompanyDataResetPlan> {
  await client.query("begin transaction read only");
  try {
    return await buildCompanyDataResetPlan(client, companyId, request);
  } finally {
    await client.query("rollback");
  }
}

/** Executes the previewed plan through the single executor, in one transaction. */
export async function executeForCli(
  client: pg.PoolClient,
  companyId: string,
  request: NormalizedResetRequest,
  planVersion: string,
  backupFile: string | null,
): Promise<AuditedCompanyDataResetOutcome> {
  const actor: CompanyDataResetActor = { accountId: null, backupFile, correlationId: `reset-cli-${randomUUID()}`, source: "cli" };
  await client.query("begin");
  try {
    const outcome = await executeAndAuditCompanyDataReset(client, companyId, request, planVersion, actor);
    await client.query("commit");
    return outcome;
  } catch (error) {
    await client.query("rollback");
    const code =
      error instanceof ResetPlanStaleError ? "reset_plan_stale" : error instanceof ResetPlanNotExecutableError ? "reset_plan_blocked" : "reset_failed_rolled_back";
    await auditCompanyDataResetFailure(client, companyId, request, planVersion, actor, code).catch(() => undefined);
    throw error;
  }
}

/** Human-readable plan for the terminal. */
export function describePlan(plan: CompanyDataResetPlan): string[] {
  const lines = [
    `Company ${plan.company.code} (${plan.company.name}) · environment ${plan.company.environment}`,
    `Domains reset: ${plan.effectiveDomains.join(", ") || "none"}`,
    ...plan.requiredDependencies.map((dependency) => `  required dependency: ${dependency.domain} -- ${dependency.reason}`),
    "",
    "Records                       delete   keep",
  ];
  for (const [key, value] of Object.entries(plan.summary)) {
    if (typeof value === "object") lines.push(`  ${key.padEnd(28)}${String(value.delete).padStart(6)} ${String(value.preserve).padStart(6)}`);
  }
  lines.push(`  role assignments deleted: ${plan.summary.roleAssignmentsDeleted} · memberships deleted: ${plan.summary.membershipsDeleted}`);
  lines.push("  platform repair executions / attempts / general audit: PRESERVE");
  lines.push("  reference numbering (order, settlement, collection, receivable, journal ... counters): PRESERVE");
  lines.push(`  fiscal years / periods reopened: ${plan.fiscalCalendar.fiscalYearsToOpen} / ${plan.fiscalCalendar.periodsToOpen}`);
  lines.push("");
  lines.push("Users:");
  for (const user of plan.users) {
    lines.push(
      `  ${user.username.padEnd(30)} ${user.classification.padEnd(26)} ${user.remove ? `login ${user.identity.action}` : "kept"}` +
        (user.employee === null ? "" : ` · employee ${user.employee.reference} ${user.employee.action}`) +
        (user.driver === null ? "" : ` · driver ${user.driver.reference} ${user.driver.action}`),
    );
  }
  for (const blocker of plan.blockers) lines.push(`BLOCKED: ${blocker}`);
  for (const warning of plan.warnings) lines.push(`warning: ${warning}`);
  lines.push("");
  lines.push(`planVersion: ${plan.planVersion}`);
  lines.push(`executable: ${plan.executable ? "yes" : "NO"}`);
  return lines;
}
