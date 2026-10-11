import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import pg from "pg";

import {
  describePlan,
  DEVELOPMENT_RESET_REQUEST,
  disposableEnvironmentRefusal,
  executeForCli,
  previewForCli,
} from "./company-data-reset.cli-support.js";

/**
 * DEVELOPMENT-ONLY reset of a development Company's operational and financial
 * transactional data -- Company Data Reset, Prompt 2.
 *
 * This script no longer has its own table list or DELETE statements. It is a
 * thin front end for the ONE plan-based Company Data Reset: it always plans
 * FULL_COMPANY_DATA_KEEP_COMPANY + KEEP_ALL_USERS (Operational + Financial;
 * users, Employees, Drivers, Traders, Customers, configuration and Platform
 * audit are kept -- the same scope this script always documented) and runs it
 * through the same planner, executor, integrity checks and audit as the
 * Platform portal.
 *
 * Safety gates (all must pass):
 *   1. NODE_ENV must be development, and the database must be local and not
 *      production-like (positive allow-list, no override).
 *   2. The Company code must match DEV-* and its environment must not be production.
 *   3. Nothing changes without --confirm AND the --plan-version printed by the dry run;
 *      a Company that changed after the dry run is refused (reset_plan_stale).
 *
 * Behaviour change: Company reference counters (order / reconciliation /
 * settlement numbering) are no longer restarted -- numbering is preserved
 * Company configuration, so an issued number is never reused.
 *
 * Usage:
 *   pnpm --filter @blueline/api db:reset:dev <subdomain>                                  # plan (no changes)
 *   pnpm --filter @blueline/api db:reset:dev <subdomain> --confirm --plan-version crp1:<hex>
 */

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });

const args = process.argv.slice(2).filter((value) => value.trim() !== "");
const confirm = args.includes("--confirm");
const versionIndex = args.indexOf("--plan-version");
const planVersion =
  args.find((value) => value.startsWith("--plan-version="))?.slice("--plan-version=".length) ??
  (versionIndex >= 0 ? (args[versionIndex + 1] ?? "") : "");
const subdomain =
  args.find((value, index) => !value.startsWith("--") && args[index - 1] !== "--plan-version")?.trim() ??
  process.env.BLUELINE_DEV_COMPANY_SUBDOMAIN?.trim() ??
  "";

async function main(): Promise<void> {
  const environment = (process.env.NODE_ENV ?? "development").trim().toLowerCase();
  if (environment !== "development") {
    throw new Error(
      `Refusing to reset data: NODE_ENV is '${environment}', not 'development'. ` +
        "This destructive script only runs in the development environment.",
    );
  }
  const refusal = disposableEnvironmentRefusal(environment, process.env.DATABASE_URL);
  if (refusal !== null) throw new Error(refusal);
  if (subdomain === "") {
    throw new Error("A development Company subdomain is required: db:reset:dev <subdomain> [--confirm --plan-version <v>]");
  }
  if (confirm && planVersion === "") {
    throw new Error("Refusing to execute: --plan-version is required (run without --confirm to see the plan and its version).");
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    const company = (
      await client.query<{ code: string; id: string; subdomain: string }>(
        "select id, code, subdomain from companies where lower(subdomain) = lower($1)",
        [subdomain],
      )
    ).rows[0];
    if (company === undefined) throw new Error(`No Company found for subdomain '${subdomain}'`);
    if (!/^DEV-/iu.test(company.code)) {
      throw new Error(`Refusing to reset: Company '${company.code}' (subdomain '${company.subdomain}') is not a DEV-* development Company.`);
    }
    if (!confirm) {
      const plan = await previewForCli(client, company.id, DEVELOPMENT_RESET_REQUEST);
      process.stdout.write(`Development data reset — PLAN ONLY (nothing changed)\n${describePlan(plan).join("\n")}\n`);
      process.stdout.write("\nRe-run with --confirm --plan-version <planVersion above> to execute this exact plan.\n");
      return;
    }
    const outcome = await executeForCli(client, company.id, DEVELOPMENT_RESET_REQUEST, planVersion, null);
    process.stdout.write(
      `Development data reset — Company ${company.code}: ${outcome.totalRemoved} row(s) removed, ` +
        `${outcome.integrityChecks.length} integrity checks passed. Users, workforce, masters and configuration kept. ` +
        `Reference numbering continues (counters preserved). Audit event ${outcome.auditEventId}.\n`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
