import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * One active Company Cash account per GL cash account.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NEEDED BEFORE BALANCES CAN BE WIDENED
 * ---------------------------------------------------------------------------
 *
 * `general_expense_payment_rows.cash_account_id` references
 * `chart_of_accounts`, not `company_cash_accounts`. To count those payments
 * against a Cash account's balance, the only available join is
 * `company_cash_accounts.linked_gl_account_id = <the GL account>`.
 *
 * That join is only meaningful if it resolves to ONE account. If a Company ever
 * has two active Cash accounts pointing at the same GL account, every General
 * Expense cash payment would either be counted against both -- doubling the
 * outflow -- or attributed to whichever row the planner happened to return.
 * Both are wrong, and neither would announce itself.
 *
 * Nothing prevented that until now: `company_cash_accounts` was unique on
 * `(company_id, cash_account_code)` and on `(id, company_id)`, and said nothing
 * about the GL link. The mapping was one-to-one in current data by coincidence,
 * not by rule.
 *
 * ---------------------------------------------------------------------------
 * WHY PARTIAL ON is_active
 * ---------------------------------------------------------------------------
 *
 * A deactivated Cash account must keep its historical GL link -- that link is
 * how its past payments are still explicable. Making the index total would
 * force a Company to sever that history before it could open a replacement
 * account on the same GL code, which is a reasonable thing to want to do.
 *
 * Restricting it to active rows enforces exactly the property the join needs
 * (one live destination per GL account) while leaving the past intact.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 * ---------------------------------------------------------------------------
 *
 * Verified before writing this: zero Companies have more than one ACTIVE Cash
 * account sharing a `linked_gl_account_id`, so the index applies cleanly. It
 * creates no data, modifies no row, and touches no balance, payment or Journal.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create unique index company_cash_accounts_active_gl_unique
      on company_cash_accounts (company_id, linked_gl_account_id)
      where is_active = true;

    comment on index company_cash_accounts_active_gl_unique is
      'Guarantees a GL cash account resolves to at most one ACTIVE Company Cash account, so General Expense cash rows (which reference chart_of_accounts) map unambiguously. Partial so deactivated accounts keep their historical GL link.';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists company_cash_accounts_active_gl_unique;
  `.execute(database);
}
