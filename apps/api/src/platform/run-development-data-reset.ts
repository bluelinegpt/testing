import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import pg from "pg";

/**
 * DEVELOPMENT-ONLY reset of all Order-related transactional data for the active
 * development Company. It never runs in production and never touches master data
 * (Companies, Users, Roles, Permissions, Traders, Customers, Employees, Drivers,
 * Emirates, Areas, pricing, Company configuration) or the security audit log
 * (audit_events).
 *
 * Safety gates (all must pass):
 *   1. NODE_ENV must be development (unset defaults to development; anything else fails closed).
 *   2. The resolved Company code must match DEV-* .
 *   3. Nothing is deleted unless --confirm is passed. Without it, the script runs the
 *      full deletion inside a transaction and ROLLS BACK, so it can show exact before/after
 *      counts without changing anything.
 *
 * Append-only (order_events) and confirmed-financial-immutability triggers are user
 * triggers on tables this role owns, so they are disabled (USER triggers only — foreign-key
 * enforcement stays on) for the single transaction and re-enabled before commit.
 *
 * Usage:
 *   pnpm --filter @blueline/api db:reset:dev <subdomain>              # dry run (no changes)
 *   pnpm --filter @blueline/api db:reset:dev <subdomain> --confirm    # execute
 */

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });

const args = process.argv.slice(2).filter((value) => value.trim() !== "");
const confirm = args.includes("--confirm");
const subdomain =
  args.find((value) => !value.startsWith("--"))?.trim() ??
  process.env.BLUELINE_DEV_COMPANY_SUBDOMAIN?.trim() ??
  "";

// Deleted child-before-parent so foreign keys (which stay enforced) are satisfied.
// order_events references orders, driver_reconciliations and trader_settlements, so it is first.
const DELETE_ORDER = [
  "order_events",
  "trader_settlement_payments",
  "trader_settlement_orders",
  "trader_settlements",
  "driver_reconciliation_payments",
  "driver_reconciliation_expenses",
  "driver_reconciliation_orders",
  "driver_reconciliations",
  "driver_commission_orders",
  "tracking_access_events",
  "tracking_tokens",
  "international_shipments",
  "order_expenses",
  "order_items",
  "order_assignments",
  "order_attachments",
  "order_status_history",
  "saas_usage_events",
  "journal_lines",
  "journal_entries",
  "orders",
] as const;

// Order-numbering counters restarted so new Orders begin fresh. Master-data counters
// (area, customer, driver, employee, trader) are left untouched.
const RESET_COUNTERS = ["order", "reconciliation", "settlement"];

function assertDevelopmentEnvironment(): void {
  const environment = (process.env.NODE_ENV ?? "development").trim().toLowerCase();
  if (environment !== "development") {
    throw new Error(
      `Refusing to reset data: NODE_ENV is '${environment}', not 'development'. ` +
        `This destructive script only runs in the development environment.`,
    );
  }
}

async function main(): Promise<void> {
  assertDevelopmentEnvironment();
  if (subdomain === "") {
    throw new Error(
      "A development Company subdomain is required: db:reset:dev <subdomain> [--confirm]",
    );
  }
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error("DATABASE_URL is not set");
  }

  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    const company = (
      await client.query<{ code: string; id: string; subdomain: string }>(
        "select id, code, subdomain from companies where lower(subdomain) = lower($1)",
        [subdomain],
      )
    ).rows[0];
    if (company === undefined) {
      throw new Error(`No Company found for subdomain '${subdomain}'`);
    }
    if (!/^DEV-/i.test(company.code)) {
      throw new Error(
        `Refusing to reset: Company '${company.code}' (subdomain '${company.subdomain}') ` +
          `is not a DEV-* development Company.`,
      );
    }
    const companyId = company.id;

    const countAll = async (): Promise<Record<string, number>> => {
      const counts: Record<string, number> = {};
      for (const table of DELETE_ORDER) {
        counts[table] = Number(
          (
            await client.query<{ n: number }>(
              `select count(*)::int as n from ${table} where company_id = $1`,
              [companyId],
            )
          ).rows[0]?.n ?? 0,
        );
      }
      return counts;
    };

    const before = await countAll();
    let after: Record<string, number> = {};

    await client.query("begin");
    try {
      for (const table of DELETE_ORDER) {
        await client.query(`alter table ${table} disable trigger user`);
      }
      for (const table of DELETE_ORDER) {
        await client.query(`delete from ${table} where company_id = $1`, [companyId]);
      }
      await client.query(
        "update company_reference_counters set next_value = 1, updated_at = now() " +
          "where company_id = $1 and reference_type = any($2)",
        [companyId, RESET_COUNTERS],
      );
      for (const table of DELETE_ORDER) {
        await client.query(`alter table ${table} enable trigger user`);
      }
      after = await countAll();
      if (confirm) {
        await client.query("commit");
      } else {
        await client.query("rollback");
      }
    } catch (error) {
      await client.query("rollback");
      throw error;
    }

    const mode = confirm ? "EXECUTE (committed)" : "DRY RUN (rolled back — nothing changed)";
    process.stdout.write(
      `Development data reset — Company ${company.code} (subdomain '${company.subdomain}')\n` +
        `Mode: ${mode}\n\n`,
    );
    process.stdout.write(`  ${"table".padEnd(32)}${"before".padStart(8)}${"after".padStart(8)}\n`);
    process.stdout.write(`  ${"-".repeat(48)}\n`);
    let totalBefore = 0;
    let totalAfter = 0;
    for (const table of DELETE_ORDER) {
      totalBefore += before[table] ?? 0;
      totalAfter += after[table] ?? 0;
      process.stdout.write(
        `  ${table.padEnd(32)}${String(before[table] ?? 0).padStart(8)}${String(after[table] ?? 0).padStart(8)}\n`,
      );
    }
    process.stdout.write(`  ${"-".repeat(48)}\n`);
    process.stdout.write(
      `  ${"TOTAL".padEnd(32)}${String(totalBefore).padStart(8)}${String(totalAfter).padStart(8)}\n`,
    );
    process.stdout.write(`\n  Reference counters restarted: ${RESET_COUNTERS.join(", ")}\n`);
    process.stdout.write(
      confirm
        ? "\nReset complete. All Order transactional data for this development Company was deleted.\n"
        : "\nDRY RUN complete. No data was changed. Re-run with --confirm to execute.\n",
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
