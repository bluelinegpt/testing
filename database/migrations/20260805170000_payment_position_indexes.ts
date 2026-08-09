import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Indexes for the Unified Payment Position report.
 *
 * The report's defining question is "what is still outstanding", which every
 * source answers with `outstanding_amount > 0` plus a status filter. That
 * predicate matches a shrinking fraction of each table over time -- most rows
 * are eventually settled -- so a partial index stays small while the table it
 * covers grows without bound.
 *
 * Without them each of the six UNION branches is a sequential scan, and the
 * report re-runs them three times per request (rows, count, totals). That is
 * the one thing this report cannot afford, because it reads live rather than
 * from a stored ledger.
 *
 * Shape is `(company_id, <party>) where <still owed>`: company_id leads because
 * every query is tenant-scoped first, and the party column follows because the
 * common drill-down is one party at a time.
 *
 * Orders is deliberately absent. `driver_reconciliation_status` and
 * `trader_settlement_status` are already indexed by the operational modules
 * that filter on them daily, and adding a fourth index to the busiest write
 * table in the system to serve a report is a bad trade.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create index if not exists trader_receivables_outstanding_index
      on trader_receivables (company_id, trader_id)
      where status in ('outstanding', 'partially_collected');

    create index if not exists payroll_entries_outstanding_index
      on payroll_entries (company_id, employee_id)
      where outstanding_amount > 0 and status not in ('held', 'reversed');

    create index if not exists outsourced_driver_fee_accruals_outstanding_index
      on outsourced_driver_fee_accruals (company_id, driver_id)
      where outstanding_amount > 0;

    create index if not exists general_expenses_outstanding_index
      on general_expenses (company_id, payee_id)
      where outstanding_amount > 0 and status = 'approved';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists general_expenses_outstanding_index;
    drop index if exists outsourced_driver_fee_accruals_outstanding_index;
    drop index if exists payroll_entries_outstanding_index;
    drop index if exists trader_receivables_outstanding_index;
  `.execute(database);
}
