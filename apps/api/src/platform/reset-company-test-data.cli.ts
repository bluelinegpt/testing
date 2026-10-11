import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnvironment } from "dotenv";
import pg from "pg";

import { configuration } from "../configuration/environment.js";
import {
  CliRefusal,
  describePlan,
  disposableEnvironmentRefusal,
  executeForCli,
  normalizeCliRequest,
  parseResetIntent,
  previewForCli,
} from "./company-data-reset.cli-support.js";
import { listCompanies } from "./reset-company-test-data.js";

/**
 * Entry point for the Company Data Reset from the command line.
 *
 * Company Data Reset, Prompt 2: this CLI no longer has its own reset engine.
 * It builds the SAME versioned plan the Platform portal previews and executes
 * it through the SAME planner + executor + integrity checks + audit
 * (`company-data-reset.cli-support.ts`). The legacy whole-Company
 * engine is not used.
 *
 * Default behaviour is the read-only plan (dry run). Execution requires
 * `--execute`, `--confirm-company-id <uuid>` matching `--company-id`, the
 * `--plan-version` printed by the dry run, an explicit `--preset`, and a
 * local disposable development/test database. User mode defaults to keep;
 * any user deletion also needs `--allow-user-deletion`.
 *
 *   npm run reset:test-data -- --list-companies
 *   npm run reset:test-data -- --company-id <uuid> --preset OPERATIONAL_DATA
 *   npm run reset:test-data -- --company-id <uuid> --preset FULL_COMPANY_DATA_KEEP_COMPANY --user-mode keep
 *   npm run reset:test-data -- --company-id <uuid> --preset OPERATIONAL_DATA \
 *       --execute --confirm-company-id <uuid> --plan-version crp1:<hex>
 */

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });

export interface CommandOptions {
  companyId: string;
  confirmCompanyId: string;
  execute: boolean;
  backup: boolean;
  allowNoBackup: boolean;
  listCompanies: boolean;
  help: boolean;
}

export function parseArguments(argv: string[]): CommandOptions {
  const args = argv.filter((value) => value.trim() !== "");
  const valueOf = (name: string): string => {
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index] ?? "";
      if (value === name) {
        return (args[index + 1] ?? "").trim();
      }
      if (value.startsWith(`${name}=`)) {
        return value.slice(name.length + 1).trim();
      }
    }
    return "";
  };
  return {
    companyId: valueOf("--company-id"),
    confirmCompanyId: valueOf("--confirm-company-id"),
    execute: args.includes("--execute"),
    backup: args.includes("--backup"),
    allowNoBackup: args.includes("--allow-no-backup"),
    listCompanies: args.includes("--list-companies"),
    help: args.includes("--help") || args.length === 0,
  };
}

/**
 * Refuses execution unless both identifiers are present and identical. Returns the reason
 * it refused, or null when the request may proceed. Separated out so it is directly testable
 * without a database.
 */
export function rejectionReason(options: CommandOptions, environment: string): string | null {
  if (!options.execute) {
    return null;
  }
  if (environment === "production") {
    return "Refusing to execute: the application environment is production. There is no bypass.";
  }
  if (options.companyId === "") {
    return "Refusing to execute: --company-id is required.";
  }
  if (options.confirmCompanyId === "") {
    return "Refusing to execute: --confirm-company-id <uuid> is required to execute.";
  }
  if (options.confirmCompanyId !== options.companyId) {
    return (
      "Refusing to execute: --confirm-company-id does not match --company-id.\n" +
      `  --company-id          ${options.companyId}\n` +
      `  --confirm-company-id  ${options.confirmCompanyId}`
    );
  }
  return null;
}

export function backupDecision(
  options: CommandOptions,
  pgDumpAvailable: boolean,
): { action: "backup" | "proceed"; reason: string } | { action: "stop"; reason: string } {
  if (pgDumpAvailable) {
    return { action: "backup", reason: "pg_dump is available" };
  }
  if (options.allowNoBackup) {
    return {
      action: "proceed",
      reason: "pg_dump is unavailable and --allow-no-backup was given explicitly",
    };
  }
  return {
    action: "stop",
    reason:
      "Refusing to execute: pg_dump was not found, so no backup can be taken. " +
      "Re-run with --allow-no-backup only if you accept that risk.",
  };
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function pgDumpAvailable(): boolean {
  const probe = spawnSync("pg_dump", ["--version"], { encoding: "utf8" });
  return probe.error === undefined && probe.status === 0;
}

function takeBackup(connectionString: string, companyId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = resolve(process.cwd(), "../../.backups");
  mkdirSync(directory, { recursive: true });
  const target = resolve(directory, `reset-${companyId}-${stamp}.dump`);
  const result = spawnSync("pg_dump", ["--format=custom", "--file", target, connectionString], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Backup failed: ${result.stderr || result.error?.message || "unknown error"}`);
  }
  return target;
}

function argumentReader(argv: string[]): { valueOf: (name: string) => string; has: (name: string) => boolean } {
  const args = argv.filter((value) => value.trim() !== "");
  return {
    has: (name) => args.includes(name),
    valueOf: (name) => {
      for (let index = 0; index < args.length; index += 1) {
        const value = args[index] ?? "";
        if (value === name) return (args[index + 1] ?? "").trim();
        if (value.startsWith(`${name}=`)) return value.slice(name.length + 1).trim();
      }
      return "";
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = parseArguments(argv);
  if (options.help && !options.listCompanies && options.companyId === "") {
    write("Usage:");
    write("  npm run reset:test-data -- --list-companies");
    write("  npm run reset:test-data -- --company-id <uuid> --preset <PRESET> [--domains a,b] \\");
    write("      [--user-mode keep|selected|all-eligible] [--select id,id] [--delete-admin id] \\");
    write("      [--traders-customers keep|reset] [--workforce keep|reset] [--allow-user-deletion]");
    write("  ... --execute --confirm-company-id <uuid> --plan-version crp1:<hex> [--allow-no-backup]");
    write("");
    write("Default is the read-only plan. Presets: OPERATIONAL_DATA, FINANCIAL_DATA, USERS_WORKFORCE,");
    write("FULL_COMPANY_DATA_KEEP_COMPANY, CUSTOM. User mode defaults to keep; FULL and USERS_WORKFORCE");
    write("need it explicitly. Runs only against a local development/test database.");
    return;
  }

  const settings = configuration();
  const environment = settings.app.environment;

  const refusal = rejectionReason(options, environment);
  if (refusal !== null) {
    process.stderr.write(`${refusal}\n`);
    process.exit(2);
  }
  if (options.listCompanies) {
    const pool = new pg.Pool({ connectionString: settings.database.url, max: 1 });
    const client = await pool.connect();
    try {
      await listCompanies(client);
    } finally {
      client.release();
      await pool.end();
    }
    return;
  }
  const environmentRefusal = disposableEnvironmentRefusal(environment, settings.database.url);
  if (environmentRefusal !== null) {
    process.stderr.write(`${environmentRefusal}\n`);
    process.exit(2);
  }
  if (options.companyId === "") {
    process.stderr.write("Refusing to continue: --company-id is required.\n");
    process.exit(2);
  }
  const reader = argumentReader(argv);
  let request;
  try {
    request = normalizeCliRequest(parseResetIntent(reader.valueOf, reader.has));
  } catch (error) {
    process.stderr.write(`${error instanceof CliRefusal ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const planVersion = reader.valueOf("--plan-version");
  if (options.execute && planVersion === "") {
    process.stderr.write("Refusing to execute: --plan-version is required (run without --execute to see the plan and its version).\n");
    process.exit(2);
  }

  if (options.execute) {
    const decision = backupDecision(options, pgDumpAvailable());
    if (decision.action === "stop") {
      process.stderr.write(`${decision.reason}\n`);
      process.exit(3);
    }
    if (decision.action === "backup") {
      const target = takeBackup(settings.database.url, options.companyId);
      write(`Backup written to ${target}`);
    } else {
      write(`Proceeding without a backup: ${decision.reason}`);
    }
  }

  const pool = new pg.Pool({ connectionString: settings.database.url, max: 1 });
  const client = await pool.connect();
  try {
    if (!options.execute) {
      write("BlueLineGPT — Company Data Reset PLAN (read-only, nothing changed)");
      write("=".repeat(110));
      for (const line of describePlan(await previewForCli(client, options.companyId, request))) write(line);
      return;
    }
    write("BlueLineGPT — Company Data Reset EXECUTION (plan-based)");
    write("=".repeat(110));
    try {
      const outcome = await executeForCli(client, options.companyId, request, planVersion, null);
      write("");
      for (const entry of outcome.removed) write(`  ${entry.table.padEnd(48)}${String(entry.rows).padStart(9)} row(s)`);
      write(`  ${"TOTAL".padEnd(48)}${String(outcome.totalRemoved).padStart(9)} row(s)`);
      write(`  integrity checks passed: ${outcome.integrityChecks.length}`);
      write(`  audit event: ${outcome.auditEventId}`);
      write("");
      write("RESET_COMMITTED");
    } catch (error) {
      write("");
      write(`  ${error instanceof Error ? error.message : String(error)}`);
      write("");
      write("RESET_ROLLED_BACK");
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

// Only run when invoked directly, so the exported guards stay unit-testable.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
