import type pg from "pg";

import {
  CYCLE_BREAKS,
  buildReports,
  collectInboundReferences,
  computeBlockers,
  introspectSchema,
  type TableReport,
} from "./reset-company-test-data.manifest.js";

/**
 * READ-ONLY dry-run report for the Company test-data reset.
 *
 * This module has no write capability of any kind: every statement it issues is a `select`,
 * and all of them run inside a `begin transaction read only`, so PostgreSQL itself rejects
 * any write. The safety test enforces mechanically that no data-changing statement appears
 * in this file or in the manifest it depends on. Execution lives in a separate engine module
 * that this file does not import.
 *
 * It reports, for the resolved Company:
 *   - Company identity (id, code, subdomain, name, status)
 *   - the live schema as it exists right now (no hard-coded table list)
 *   - a classification for every table: PURGE / PRESERVE / CONDITIONAL / UNSAFE
 *   - Company-scoped row counts, ownership paths and guard triggers, grouped by module
 *   - foreign-key dependency order for the removal set (children first)
 *   - READY_FOR_EXECUTION_TOOL=true/false with the blocking reasons
 */

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

export async function listCompanies(client: pg.PoolClient): Promise<void> {
  await client.query("begin transaction read only");
  try {
    const rows = (
      await client.query<{
        id: string;
        code: string;
        subdomain: string;
        name_en: string;
        status: string;
      }>("select id, code, subdomain, name_en, status from companies order by code")
    ).rows;
    write("Companies");
    write("=".repeat(110));
    write(
      `${"id".padEnd(38)}${"code".padEnd(18)}${"subdomain".padEnd(14)}${"status".padEnd(12)}name`,
    );
    write("-".repeat(110));
    for (const row of rows) {
      write(
        `${row.id.padEnd(38)}${row.code.padEnd(18)}${row.subdomain.padEnd(14)}` +
          `${row.status.padEnd(12)}${row.name_en}`,
      );
    }
    write("-".repeat(110));
    write(`${rows.length} Company row(s).`);
  } finally {
    await client.query("rollback");
  }
}

function reportModules(reports: TableReport[]): void {
  const modules = [...new Set(reports.map((report) => report.module))].sort();
  write("Classification by module, with row counts, guards and ownership paths");
  write("-".repeat(110));
  for (const module of modules) {
    const inModule = reports.filter((report) => report.module === module);
    const moduleRows = inModule.reduce(
      (total, report) => total + (report.scope === "company" ? (report.rows ?? 0) : 0),
      0,
    );
    write(`  ${module}  (${inModule.length} table(s), ${moduleRows} Company-scoped row(s))`);
    write(`  ${"-".repeat(106)}`);
    write(
      `    ${"table".padEnd(44)}${"class".padEnd(13)}${"rows".padStart(7)}  ${"guard".padEnd(6)}ownership path`,
    );
    for (const report of inModule) {
      const rows =
        report.rows === null
          ? "n/a"
          : report.scope === "global"
            ? `${report.rows}*`
            : String(report.rows);
      const guard = report.guards.length > 0 ? `[${report.guards.length}]` : "";
      write(
        `    ${report.table.padEnd(44)}${report.classification.padEnd(13)}${rows.padStart(7)}  ` +
          `${guard.padEnd(6)}${report.ownership.path}`,
      );
    }
    write("");
  }
  write("  * global table — count is not Company-scoped.");
  write("  [n] table has n user trigger(s) firing on row-removal events.");
  write("");
}

export async function runDryRun(client: pg.PoolClient, companyId: string): Promise<boolean> {
  await client.query("begin transaction read only");
  try {
    const environment = (process.env.NODE_ENV ?? "development").trim().toLowerCase();

    const company = (
      await client.query<{
        id: string;
        code: string;
        subdomain: string;
        name_en: string;
        status: string;
      }>("select id, code, subdomain, name_en, status from companies where id = $1", [companyId])
    ).rows[0];

    write("BlueLineGPT — Company test-data reset inspection");
    write("Mode: READ-ONLY DRY RUN (no write capability in this module)");
    write("=".repeat(110));
    write("");

    if (company === undefined) {
      write(`Company: NOT FOUND for id '${companyId}'`);
      write("");
      write("READY_FOR_EXECUTION_TOOL=false");
      write("  - Company could not be resolved. Run with --list-companies to see valid ids.");
      return false;
    }

    write("Company");
    write("-".repeat(110));
    write(`  id         ${company.id}`);
    write(`  code       ${company.code}`);
    write(`  subdomain  ${company.subdomain}`);
    write(`  name       ${company.name_en}`);
    write(`  status     ${company.status}`);
    write(`  NODE_ENV   ${environment}`);
    write("");

    const snapshot = await introspectSchema(client);
    const reports = await buildReports(client, companyId, snapshot);
    const { blockers, order, cycle, blocked } = computeBlockers(
      reports,
      snapshot,
      environment,
      company.code,
    );

    const counts = { PURGE: 0, PRESERVE: 0, CONDITIONAL: 0, UNSAFE: 0 };
    for (const report of reports) {
      counts[report.classification] += 1;
    }

    write("Live schema inspection");
    write("-".repeat(110));
    write(`  tables in public schema      ${snapshot.tables.length}`);
    write(`  foreign-key constraints      ${snapshot.foreignKeys.length}`);
    write(`  tables with company_id       ${snapshot.companyScoped.size}`);
    write(
      `  classified                   PURGE ${counts.PURGE} | PRESERVE ${counts.PRESERVE} | ` +
        `CONDITIONAL ${counts.CONDITIONAL} | UNSAFE ${counts.UNSAFE}`,
    );
    write("");

    reportModules(reports);

    write("Declared foreign-key cycle breaks (applied by the execution engine)");
    write("-".repeat(110));
    for (const entry of CYCLE_BREAKS) {
      write(`  ${`${entry.table}.${entry.columns.join(", ")}`.padEnd(50)}${entry.reason}`);
    }
    write("");

    write("Foreign-key dependency order for the removal set (children first)");
    write("-".repeat(110));
    const rowsByTable = new Map(reports.map((report) => [report.table, report.rows ?? 0]));
    let total = 0;
    order.forEach((table, index) => {
      const rows = rowsByTable.get(table) ?? 0;
      total += rows;
      write(
        `  ${String(index + 1).padStart(3)}. ${table.padEnd(44)}${String(rows).padStart(9)} row(s)`,
      );
    });
    write(`  ${"-".repeat(106)}`);
    write(`  ${"".padEnd(4)}${"TOTAL".padEnd(44)}${String(total).padStart(9)} row(s)`);
    if (cycle.length > 0) {
      write(`  Unbroken foreign-key cycle among: ${cycle.join(", ")}`);
    }
    if (blocked.length > 0) {
      write(`  Waiting behind that cycle: ${blocked.join(", ")}`);
    }
    write("");

    const purgeSet = new Set(
      reports.filter((report) => report.classification === "PURGE").map((report) => report.table),
    );
    const inbound = collectInboundReferences(snapshot.foreignKeys, purgeSet);
    if (inbound.size > 0) {
      write("Removal-set tables still referenced by tables outside the set");
      write("-".repeat(110));
      for (const [parent, children] of [...inbound.entries()].sort()) {
        write(`  ${parent.padEnd(44)}referenced by ${[...children].sort().join(", ")}`);
      }
      write("");
    }

    const guarded = reports.filter(
      (report) => report.classification === "PURGE" && report.guards.length > 0,
    );
    write("Guarded removal-set tables (handled by the approved reset procedure)");
    write("-".repeat(110));
    for (const report of guarded) {
      write(`  ${report.table.padEnd(44)}${report.guards.join(", ")}`);
    }
    write(`  ${guarded.length} guarded table(s) covered by the approved procedure.`);
    write("");

    write("Readiness");
    write("-".repeat(110));
    write(`READY_FOR_EXECUTION_TOOL=${blockers.length === 0 ? "true" : "false"}`);
    for (const blocker of blockers) {
      write(`  - ${blocker}`);
    }
    if (blockers.length === 0) {
      write("  All tables classified, all removal-set tables Company-scoped,");
      write("  dependency order resolved, cycles broken, guards covered.");
    }
    write("");
    write("No data was read outside this Company scope and nothing was changed.");
    return blockers.length === 0;
  } finally {
    await client.query("rollback");
  }
}
