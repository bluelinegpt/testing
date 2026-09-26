import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Which Cash account funded a cash Trader Settlement payment.
 *
 * ---------------------------------------------------------------------------
 * THE LAST FUNDING-ACCOUNT GAP
 * ---------------------------------------------------------------------------
 *
 * `trader_settlement_payments` already records `company_bank_account_id` for
 * bank transfers, and `trader_settlement_payments_bank_check` makes it
 * mandatory there. Cash payments have no equivalent: the METHOD is recorded and
 * the funding account is not, so nothing can say which drawer the money left.
 *
 * That is the same defect Payroll and Outsourced Driver Fees had, and the last
 * one standing before a negative-balance control can be enforced across every
 * outgoing payment.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EXISTING CHECK IS EXTENDED, NOT REPLACED
 * ---------------------------------------------------------------------------
 *
 * `trader_settlement_payments_bank_check` already states the bank-side rule
 * correctly and has governed this table since the original financial schema. A
 * new CHECK is ADDED beside it rather than dropping and rewriting it.
 *
 * The two are equivalent in what they permit, but not in risk. Dropping a CHECK
 * on a financial table and recreating a longer version of it opens a window in
 * which the table is unconstrained, and turns a reviewer's question from "is
 * this one new clause right?" into "is this whole rewritten predicate still
 * identical to the old one, plus the new part?". The narrow addition is easier
 * to verify and its `down()` is exact.
 *
 * ---------------------------------------------------------------------------
 * NULLABLE, AND WHY THE CHECK DOES NOT DEMAND PRESENCE
 * ---------------------------------------------------------------------------
 *
 * Historical cash settlements never captured an account and there is no honest
 * way to recover which one it was. The column is nullable and nothing is
 * backfilled; a guess written into settlement history would be
 * indistinguishable afterwards from a fact.
 *
 * So the CHECK constrains the invalid COMBINATION -- a bank transfer may not
 * name a cash account -- and says nothing about presence. Completeness for new
 * writes is enforced by the service in S4E-2, which is where "required from now
 * on, absent before" can be expressed without lying about the past.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table trader_settlement_payments
      add column company_cash_account_id uuid,

      add constraint trader_settlement_payments_cash_account_fk
        foreign key (company_cash_account_id, company_id)
        references company_cash_accounts(id, company_id) on delete restrict,

      -- Only the new rule. The bank side stays governed by the existing
      -- trader_settlement_payments_bank_check, which is untouched:
      --   cash          => company_bank_account_id null and bank_reference null
      --   bank_transfer => both not null
      -- Presence of the cash account is deliberately NOT required here; see the
      -- header. Historical cash rows carry null and remain valid.
      add constraint trader_settlement_payments_cash_account_shape_check check (
        payment_method <> 'bank_transfer' or company_cash_account_id is null
      );

    create index if not exists trader_settlement_payments_cash_account_index
      on trader_settlement_payments (company_id, company_cash_account_id)
      where company_cash_account_id is not null;

    comment on column trader_settlement_payments.company_cash_account_id is
      'Cash account that funded a cash settlement payment. Null on rows written before this migration; required by the service for every new cash payment.';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists trader_settlement_payments_cash_account_index;

    alter table trader_settlement_payments
      drop constraint if exists trader_settlement_payments_cash_account_shape_check,
      drop constraint if exists trader_settlement_payments_cash_account_fk,
      drop column if exists company_cash_account_id;
  `.execute(database);
}
