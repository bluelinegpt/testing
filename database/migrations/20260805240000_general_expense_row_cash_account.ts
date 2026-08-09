import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * The exact Cash account behind a General Expense cash payment row.
 *
 * ---------------------------------------------------------------------------
 * WHY A GL ACCOUNT IS NOT AN ANSWER
 * ---------------------------------------------------------------------------
 *
 * `general_expense_payment_rows.cash_account_id` references
 * `chart_of_accounts`. That is correct for ACCOUNTING -- it is the GL account
 * the expense credits -- but it does not identify the physical drawer the money
 * left, and those are different questions.
 *
 * A Company may deactivate a Cash account and open a replacement on the same GL
 * code. From that moment a GL id resolves to two Cash accounts, and any join
 * has to guess. Every available tiebreak is a guess dressed up as a rule:
 * "prefer active" silently reassigns a historical payment to an account that
 * did not exist when it happened; "prefer newest" and "prefer oldest" are
 * arbitrary. A balance built on a guess is worse than one that admits a gap,
 * because nothing marks the rows it invented.
 *
 * So this migration records the answer instead of deriving it.
 *
 * ---------------------------------------------------------------------------
 * TWO COLUMNS, TWO PURPOSES
 * ---------------------------------------------------------------------------
 *
 *   company_cash_account_id -- WHICH DRAWER. Operational identity, used by
 *                              balance and funding-account logic.
 *   cash_account_id         -- WHICH GL ACCOUNT. Accounting identity, used by
 *                              posting. Unchanged, still validated by
 *                              assertDestination(), still mandatory for cash.
 *
 * They are related (the Cash account's `linked_gl_account_id` should equal the
 * GL id) but not interchangeable, and the service verifies that relationship on
 * write rather than trusting either value alone.
 *
 * ---------------------------------------------------------------------------
 * NULLABLE, AND NOT BACKFILLED
 * ---------------------------------------------------------------------------
 *
 * Historical rows recorded only the GL account. Which Cash account funded them
 * is not recoverable, and writing a guess into expense history would be
 * indistinguishable afterwards from a fact.
 *
 * The column is therefore nullable and empty. Completeness for new rows is
 * enforced by the service; historical rows stay honest about what is unknown
 * and are excluded from account-level balances with a reported count, never
 * silently attributed.
 *
 * Bank/Visa rows are untouched -- `company_bank_account_id` already references
 * `company_bank_accounts` directly and never had this ambiguity.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table general_expense_payment_rows
      add column company_cash_account_id uuid,

      add constraint general_expense_payment_rows_company_cash_account_fk
        foreign key (company_cash_account_id, company_id)
        references company_cash_accounts(id, company_id) on delete restrict,

      -- Only a cash row may name a Cash account. Presence is NOT required here:
      -- historical rows have none, and "required from now on" is a rule the
      -- service can express without lying about the past.
      add constraint general_expense_payment_rows_company_cash_shape_check check (
        payment_method = 'cash' or company_cash_account_id is null
      );

    create index if not exists general_expense_payment_rows_company_cash_account_index
      on general_expense_payment_rows (company_id, company_cash_account_id)
      where company_cash_account_id is not null;

    comment on column general_expense_payment_rows.company_cash_account_id is
      'The physical Cash account this row was funded from. Distinct from cash_account_id, which is the linked GL account used for posting. Null on rows written before this migration; required by the service for every new cash row.';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists general_expense_payment_rows_company_cash_account_index;

    alter table general_expense_payment_rows
      drop constraint if exists general_expense_payment_rows_company_cash_shape_check,
      drop constraint if exists general_expense_payment_rows_company_cash_account_fk,
      drop column if exists company_cash_account_id;
  `.execute(database);
}
