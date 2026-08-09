import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Removes the redundant funding-account columns from
 * `general_expense_payments`.
 *
 * ---------------------------------------------------------------------------
 * WHY THEY SHOULD NEVER HAVE BEEN ADDED
 * ---------------------------------------------------------------------------
 *
 * `20260805200000_payment_funding_accounts` added a Cash and a Bank account
 * column to three payment tables so a later balance control could tell which
 * account funded each payment. For Payroll and Outsourced Driver Fees that was
 * the missing piece: neither has a child table, so the header is the only place
 * an account can live.
 *
 * General Expense Payments are different, and the earlier audit got them wrong.
 * They already record the account per PAYMENT ROW --
 * `general_expense_payment_rows.cash_account_id` and
 * `.company_bank_account_id` -- validated on every confirmation by
 * `assertDestination()`, which checks existence, active status, Company
 * ownership and account class before the payment is written.
 *
 * The row model is not merely equivalent, it is strictly more expressive. One
 * Expense payment can draw on several accounts -- two cash drawers, or cash
 * plus card -- and a single header pair cannot represent that. Summing rows
 * into one header account would either lose information or, worse, pick one
 * arbitrarily and present it as the answer.
 *
 * ---------------------------------------------------------------------------
 * WHY REDUNDANT IS NOT MERELY UNTIDY
 * ---------------------------------------------------------------------------
 *
 * Two places recording the same fact is a defect waiting for its first writer.
 * Nothing reconciles the header against the rows, so the day some future code
 * populates the header, the two can disagree and no rule says which is right.
 *
 * They are empty today -- verified: 2 payments, both header columns null on
 * every row, while the row-level columns are populated. Dropping them now costs
 * nothing and closes the hazard permanently.
 *
 * ---------------------------------------------------------------------------
 * SCOPE
 * ---------------------------------------------------------------------------
 *
 * `general_expense_payments` only. The Payroll and Outsourced Driver Fee
 * columns from the same earlier migration are deliberately untouched: they are
 * the authoritative record for those workflows and are already wired.
 *
 * No payment row, amount, account reference, Accounting Event or Journal is
 * read or written here.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists general_expense_payments_bank_account_index;
    drop index if exists general_expense_payments_cash_account_index;

    alter table general_expense_payments
      drop constraint if exists general_expense_payments_account_shape_check,
      drop constraint if exists general_expense_payments_bank_account_fk,
      drop constraint if exists general_expense_payments_cash_account_fk,
      drop column if exists company_bank_account_id,
      drop column if exists company_cash_account_id;
  `.execute(database);
}

/**
 * Restores exactly what `20260805200000` created, so the pair is a clean
 * round-trip. The columns come back nullable and empty, which is the state they
 * were in when this migration removed them.
 */
export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table general_expense_payments
      add column company_cash_account_id uuid,
      add column company_bank_account_id uuid,
      add constraint general_expense_payments_cash_account_fk
        foreign key (company_cash_account_id, company_id)
        references company_cash_accounts(id, company_id) on delete restrict,
      add constraint general_expense_payments_bank_account_fk
        foreign key (company_bank_account_id, company_id)
        references company_bank_accounts(id, company_id) on delete restrict,
      add constraint general_expense_payments_account_shape_check check (
        (cash_amount > 0 or company_cash_account_id is null)
        and (visa_amount > 0 or company_bank_account_id is null)
      );

    create index if not exists general_expense_payments_cash_account_index
      on general_expense_payments (company_id, company_cash_account_id)
      where company_cash_account_id is not null;
    create index if not exists general_expense_payments_bank_account_index
      on general_expense_payments (company_id, company_bank_account_id)
      where company_bank_account_id is not null;
  `.execute(database);
}
