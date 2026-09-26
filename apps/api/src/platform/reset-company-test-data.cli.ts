import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnvironment } from "dotenv";
import pg from "pg";

import { configuration } from "../configuration/environment.js";
import { runReset } from "./reset-company-test-data.engine.js";
import { listCompanies, runDryRun } from "./reset-company-test-data.js";

/**
 * Entry point for the Company test-data reset.
 *
 * Default behaviour is the read-only dry run. Execution requires BOTH `--execute` and
 * `--confirm-company-id <uuid>` matching `--company-id` exactly, is refused outright in
 * production, and takes a backup first unless the operator explicitly waives it.
 *
 *   npm run reset:test-data -- --company-id <uuid>
 *   npm run reset:test-data -- --list-companies
 *   npm run reset:test-data -- --company-id <uuid> --execute --confirm-company-id <uuid>
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

async function execute(client: pg.PoolClient, options: CommandOptions): Promise<void> {
  write("BlueLineGPT — Company test-data reset EXECUTION");
  write("=".repeat(110));
  await client.query("begin");
  try {
    const summary = await runReset(client, options.companyId, (message) => write(`  ${message}`));
    await client.query("commit");
    write("");
    write("Removed rows by table");
    write("-".repeat(110));
    for (const entry of summary.removed.filter((row) => row.rows > 0)) {
      write(`  ${entry.table.padEnd(48)}${String(entry.rows).padStart(9)} row(s)`);
    }
    write(`  ${"-".repeat(106)}`);
    write(`  ${"TOTAL".padEnd(48)}${String(summary.totalRemoved).padStart(9)} row(s)`);
    write("");
    write(`Guards suspended and restored: ${summary.suspendedTriggers.length}`);
    write(`Preserved tables verified unchanged: ${summary.preservedVerified}`);
    write("");
    write("RESET_COMMITTED");
  } catch (error) {
    await client.query("rollback");
    write("");
    write(`  ${error instanceof Error ? error.message : String(error)}`);
    write("");
    write("RESET_ROLLED_BACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help && !options.listCompanies && options.companyId === "") {
    write("Usage:");
    write("  npm run reset:test-data -- --company-id <uuid>");
    write("  npm run reset:test-data -- --list-companies");
    write("  npm run reset:test-data -- --company-id <uuid> \\");
    write("      --execute --confirm-company-id <uuid> [--backup] [--allow-no-backup]");
    write("");
    write("Default is a read-only dry run. Execution needs both identifiers and they must match.");
    return;
  }

  const settings = configuration();
  const environment = settings.app.environment;

  const refusal = rejectionReason(options, environment);
  if (refusal !== null) {
    process.stderr.write(`${refusal}\n`);
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
    if (options.listCompanies) {
      await listCompanies(client);
    } else if (options.execute) {
      await execute(client, options);
    } else {
      await runDryRun(client, options.companyId);
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
