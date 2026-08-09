import type pg from "pg";

import {
  CYCLE_BREAKS,
  PRESERVE_TABLES,
  PURGE_TABLES,
  buildCountStatement,
  buildReports,
  computeBlockers,
  introspectSchema,
  quoteIdentifier,
  resolveOwnership,
  type TableReport,
} from "./reset-company-test-data.manifest.js";

/**
 * Execution engine for the Company test-data reset.
 *
 * The caller owns the transaction. `runReset` assumes it is already inside one and never
 * commits: on success it returns a summary for the caller to commit, and on any failure it
 * throws so the caller rolls back. That is deliberate — every change this engine makes,
 * including trigger suspension, is transactional in PostgreSQL, so a rollback restores the
 * database and the triggers together with no repair step.
 *
 * Isolation: every statement carries `where company_id = $1`. The engine refuses to run if
 * any table in the removal set is not directly Company-scoped, so no statement can ever be
 * global.
 */

/**
 * Approved development-reset trigger procedure.
 *
 * These are the only triggers that may be suspended, and only inside the reset transaction.
 * Every trigger the live catalog reports on a removal-set table must appear here or the
 * engine stops: an unrecognised guard is treated as an unreviewed guard.
 */
interface TriggerApproval {
  reason: string;
  /** Tables whose rows must also be cleared in the same transaction for this to be safe. */
  requiresCleared?: string[];
  triggers: string[];
}

const APPROVED_TRIGGERS: TriggerApproval[] = [
  {
    reason:
      "Confirmed/posted financial immutability. It exists to stop edits and partial removal " +
      "of live financial history. Here the entire record and every child of it are removed " +
      "together inside one transaction, so no partial or inconsistent state can survive.",
    triggers: [
      "accounting_events_immutable",
      "cash_bank_movements_immutable",
      "driver_commission_calculations_immutable",
      "driver_commission_orders_legacy_immutable",
      "driver_reconciliation_expenses_immutable",
      "driver_reconciliation_orders_immutable",
      "driver_reconciliation_payments_immutable",
      "driver_reconciliations_immutable",
      "general_expense_lines_immutable",
      "general_expense_payment_rows_immutable",
      "general_expense_payments_immutable",
      "journal_entries_accounting_immutable",
      "journal_lines_immutable_when_posted",
      "opening_balance_batches_immutable",
      "opening_balance_lines_immutable",
      "operating_expenses_immutable",
      "order_expenses_immutable",
      "outsourced_driver_fee_accruals_immutable",
      "outsourced_driver_fee_payment_allocations_immutable",
      "outsourced_driver_fee_payments_immutable",
      "outsourced_driver_payments_legacy_immutable",
      "payroll_adjustments_immutable",
      "payroll_commission_links_immutable",
      "payroll_entries_foundation_guard",
      "payroll_line_allowances_immutable",
      "payroll_payment_allocations_immutable",
      "payroll_payments_immutable",
      "payroll_periods_foundation_guard",
      "trader_settlement_orders_immutable",
      "trader_settlement_payments_immutable",
      "trader_settlements_immutable",
    ],
  },
  {
    reason:
      "Append-only and history protection on operational trails. They stop history being " +
      "rewritten while the parent Order still exists. The parent Order is removed in the " +
      "same transaction, so there is no history left to protect.",
    triggers: [
      "order_assignments_current_driver_consistency",
      "order_assignments_history_guard",
      "order_events_append_only",
      "order_status_history_append_only",
      "orders_assignment_consistency",
    ],
  },
  {
    reason:
      "Parent-total synchronisation. These are NOT immutability guards: they recompute the " +
      "parent's totals whenever a line changes. Suspending them is only safe because the " +
      "parent rows are removed in the same transaction, so no surviving parent can be left " +
      "holding stale totals. The engine verifies the parent tables are cleared before commit.",
    requiresCleared: ["journal_entries", "opening_balance_batches"],
    triggers: ["journal_lines_totals_guard", "opening_balance_lines_totals_guard"],
  },
  {
    reason:
      "Business-master removal guards. They exist to stop masters being removed while " +
      "operational history references them. All referencing history is removed earlier in " +
      "the same transaction, and the dependency order enforces that.",
    triggers: [
      "customer_addresses_no_delete",
      "customers_no_delete",
      "trader_bank_accounts_delete_guard",
      "trader_service_prices_delete_guard",
      "trader_storefront_slugs_no_change",
    ],
  },
  {
    reason:
      "Per-entity compensation history guards. They stop an Employee's salary or allowance " +
      "history being removed while payroll still references it. The payroll runs that " +
      "reference them, and the Employee or Driver itself, are removed earlier in the same " +
      "transaction, so nothing is left that could need the history.",
    triggers: [
      "employee_allowances_payroll_guard",
      "employee_salary_versions_payroll_guard",
      "outsourced_driver_fee_versions_immutable",
    ],
  },
  {
    reason:
      "Workflow-state protection on batch and closing runs. These records are development " +
      "test runs with no accounting effect of their own; the events and journals they " +
      "reference are removed in the same transaction.",
    triggers: [
      "accounting_batch_jobs_protect_delete",
      "accounting_batch_transitions_no_change",
      "closing_workflow_transitions_no_change",
      "closing_workflows_protect_delete",
    ],
  },
  {
    reason:
      "Journal state and balance validation on update. Suspended only so the cycle-breaking " +
      "nullification of journal_entries.accounting_event_id can run; the row is removed " +
      "moments later in the same transaction.",
    triggers: ["journal_entries_accounting_state_guard", "journal_entries_balance_before_post"],
  },
];

const APPROVED_TRIGGER_NAMES = new Set(APPROVED_TRIGGERS.flatMap((approval) => approval.triggers));

/** Triggers that must be suspended for the cycle-breaking updates, beyond removal guards. */
const NULLIFICATION_SUPPORT: { table: string; triggers: string[] }[] = [
  {
    table: "journal_entries",
    triggers: ["journal_entries_accounting_state_guard", "journal_entries_balance_before_post"],
  },
];

export interface ResetSummary {
  removed: { table: string; rows: number }[];
  totalRemoved: number;
  suspendedTriggers: { table: string; trigger: string }[];
  cycleBreaks: { table: string; columns: string[]; rows: number }[];
  preservedVerified: number;
}

export interface ResetLogger {
  (message: string): void;
}

function assertIdentifiers(...names: string[]): void {
  for (const name of names) {
    quoteIdentifier(name);
  }
}

export async function runReset(
  client: pg.PoolClient,
  companyId: string,
  log: ResetLogger,
): Promise<ResetSummary> {
  const company = (
    await client.query<{ code: string }>("select code from companies where id = $1", [companyId])
  ).rows[0];
  if (company === undefined) {
    throw new Error(`No Company found for id '${companyId}'`);
  }

  const environment = (process.env.NODE_ENV ?? "development").trim().toLowerCase();
  const snapshot = await introspectSchema(client);
  const reports = await buildReports(client, companyId, snapshot);
  const { blockers, order, cycle } = computeBlockers(reports, snapshot, environment, company.code);
  if (blockers.length > 0) {
    throw new Error(
      `Refusing to reset — the manifest is not ready:\n  - ${blockers.join("\n  - ")}`,
    );
  }
  if (cycle.length > 0) {
    throw new Error(`Refusing to reset — unbroken foreign-key cycle: ${cycle.join(", ")}`);
  }

  const purgeReports = reports.filter((report) => report.classification === "PURGE");
  const preserveReports = reports.filter((report) => report.classification === "PRESERVE");
  const purgeSet = new Set(purgeReports.map((report) => report.table));
  if (order.length !== purgeSet.size) {
    throw new Error(
      `Refusing to reset — removal order covers ${order.length} of ${purgeSet.size} tables.`,
    );
  }

  // Step 7a. Work out exactly which triggers must be suspended, from the live catalog.
  const suspend: { table: string; trigger: string }[] = [];
  for (const [table, triggers] of snapshot.guards) {
    if (!purgeSet.has(table)) {
      continue;
    }
    for (const trigger of triggers) {
      suspend.push({ table, trigger });
    }
  }
  for (const support of NULLIFICATION_SUPPORT) {
    if (!purgeSet.has(support.table)) {
      continue;
    }
    for (const trigger of support.triggers) {
      if (!suspend.some((entry) => entry.table === support.table && entry.trigger === trigger)) {
        suspend.push({ table: support.table, trigger });
      }
    }
  }

  const unapproved = suspend.filter((entry) => !APPROVED_TRIGGER_NAMES.has(entry.trigger));
  if (unapproved.length > 0) {
    throw new Error(
      "Refusing to reset — these guards are not in the approved procedure:\n  - " +
        unapproved.map((entry) => `${entry.table}.${entry.trigger}`).join("\n  - "),
    );
  }

  // Step 7b. The parent-total guards may only be suspended when their parents are cleared
  // in this same transaction.
  for (const approval of APPROVED_TRIGGERS) {
    const used = approval.triggers.some((trigger) =>
      suspend.some((entry) => entry.trigger === trigger),
    );
    if (!used) {
      continue;
    }
    for (const required of approval.requiresCleared ?? []) {
      if (!purgeSet.has(required)) {
        throw new Error(
          `Refusing to reset — '${required}' must be in the removal set before a ` +
            `parent-total guard may be suspended.`,
        );
      }
    }
  }

  // Step 7c. Suspending a trigger requires ownership of the table.
  const notOwned = (
    await client.query<{ relname: string }>(
      "select target.relname from pg_class target " +
        "join pg_namespace target_namespace on target_namespace.oid = target.relnamespace " +
        "where target_namespace.nspname = 'public' and target.relname = any($1) " +
        "and pg_get_userbyid(target.relowner) <> current_user",
      [[...new Set(suspend.map((entry) => entry.table))]],
    )
  ).rows.map((row) => row.relname);
  if (notOwned.length > 0) {
    throw new Error(
      `Refusing to reset — the current role does not own: ${notOwned.join(", ")}. ` +
        "Trigger suspension would fail part-way through.",
    );
  }

  const preservedBefore = new Map(
    preserveReports.map((report) => [report.table, report.rows ?? 0]),
  );

  // Step 7d. Suspend, inside the transaction only.
  log(`Suspending ${suspend.length} approved guard(s) for this transaction`);
  for (const entry of suspend) {
    assertIdentifiers(entry.table, entry.trigger);
    await client.query(
      `alter table ${quoteIdentifier(entry.table)} disable trigger ${quoteIdentifier(entry.trigger)}`,
    );
  }

  // Step 8a. Break the foreign-key cycles by clearing the nullable side first.
  const cycleBreaks: { table: string; columns: string[]; rows: number }[] = [];
  for (const entry of CYCLE_BREAKS) {
    if (!purgeSet.has(entry.table)) {
      continue;
    }
    assertIdentifiers(entry.table, ...entry.columns);
    const assignments = entry.columns
      .map((column) => `${quoteIdentifier(column)} = null`)
      .join(", ");
    const condition = entry.columns
      .map((column) => `${quoteIdentifier(column)} is not null`)
      .join(" or ");
    const result = await client.query(
      `update ${quoteIdentifier(entry.table)} set ${assignments} ` +
        `where company_id = $1 and (${condition})`,
      [companyId],
    );
    cycleBreaks.push({ table: entry.table, columns: entry.columns, rows: result.rowCount ?? 0 });
    log(
      `Cycle break: ${entry.table}.${entry.columns.join(", ")} cleared on ${result.rowCount ?? 0} row(s)`,
    );
  }

  // Step 8b. Company-scoped removal, children first.
  const removed: { table: string; rows: number }[] = [];
  let totalRemoved = 0;
  for (const table of order) {
    const ownership = resolveOwnership(table, snapshot.companyScoped, snapshot.foreignKeys);
    if (ownership.kind !== "direct") {
      throw new Error(`Refusing to reset — '${table}' is not directly Company-scoped.`);
    }
    assertIdentifiers(table);
    const result = await client.query(
      `delete from ${quoteIdentifier(table)} where company_id = $1`,
      [companyId],
    );
    const rows = result.rowCount ?? 0;
    totalRemoved += rows;
    removed.push({ table, rows });
  }
  log(`Removed ${totalRemoved} row(s) across ${order.length} table(s)`);

  // Step 9. Restore every suspended guard.
  for (const entry of suspend) {
    await client.query(
      `alter table ${quoteIdentifier(entry.table)} enable trigger ${quoteIdentifier(entry.trigger)}`,
    );
  }

  // Step 9b. Prove they are enabled again before anything is committed.
  const stillDisabled = (
    await client.query<{ relname: string; tgname: string }>(
      "select target.relname, trigger_row.tgname from pg_trigger trigger_row " +
        "join pg_class target on target.oid = trigger_row.tgrelid " +
        "join pg_namespace target_namespace on target_namespace.oid = target.relnamespace " +
        "where target_namespace.nspname = 'public' and not trigger_row.tgisinternal " +
        "and trigger_row.tgenabled <> 'O' and trigger_row.tgname = any($1)",
      [suspend.map((entry) => entry.trigger)],
    )
  ).rows;
  if (stillDisabled.length > 0) {
    throw new Error(
      "Refusing to commit — guards were not restored: " +
        stillDisabled.map((row) => `${row.relname}.${row.tgname}`).join(", "),
    );
  }
  log(`Restored and verified ${suspend.length} guard(s)`);

  // Step 10. Every removal-set table must now be empty for this Company.
  const survivors: string[] = [];
  for (const table of order) {
    const ownership = resolveOwnership(table, snapshot.companyScoped, snapshot.foreignKeys);
    const statement = buildCountStatement(table, ownership);
    if (statement === null) {
      continue;
    }
    const rows = Number(
      (await client.query<{ n: string }>(statement, [companyId])).rows[0]?.n ?? 0,
    );
    if (rows > 0) {
      survivors.push(`${table} (${rows})`);
    }
  }
  if (survivors.length > 0) {
    throw new Error(`Refusing to commit — transactional rows survived: ${survivors.join(", ")}`);
  }

  // Step 11. Preserved configuration must be untouched.
  const changed: string[] = [];
  for (const report of preserveReports) {
    if (report.scope !== "company") {
      continue;
    }
    const statement = buildCountStatement(report.table, report.ownership);
    if (statement === null) {
      continue;
    }
    const rows = Number(
      (await client.query<{ n: string }>(statement, [companyId])).rows[0]?.n ?? 0,
    );
    const before = preservedBefore.get(report.table) ?? 0;
    if (rows !== before) {
      changed.push(`${report.table} (${before} -> ${rows})`);
    }
  }
  if (changed.length > 0) {
    throw new Error(`Refusing to commit — preserved configuration changed: ${changed.join(", ")}`);
  }
  log(`Verified ${preserveReports.length} preserved table(s) unchanged`);

  return {
    removed,
    totalRemoved,
    suspendedTriggers: suspend,
    cycleBreaks,
    preservedVerified: preserveReports.length,
  };
}

/** Exposed for tests: the manifest sets the engine operates on. */
export const engineManifest = { PURGE_TABLES, PRESERVE_TABLES, APPROVED_TRIGGER_NAMES };

export type { TableReport };
