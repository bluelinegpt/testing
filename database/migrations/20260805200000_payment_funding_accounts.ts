import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Which Cash or Bank account funded each outgoing payment.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 *
 * Three payment tables recorded that money left, and how much, but never which
 * account it left. That is why the negative-balance policy from Prompt 6 is
 * configurable and inert: you cannot enforce "this Cash account must not go
 * negative" against a payment that does not say which Cash account it drew on.
 *
 * `cash_bank_movements` already carries source/destination account ids and
 * `trader_settlement_payments` carries `company_bank_account_id`; both were
 * inspected and are left alone. This migration brings the other three up to the
 * same standard, reusing the SAME account tables and the SAME composite
 * foreign-key pattern. No new account master is introduced.
 *
 * ---------------------------------------------------------------------------
 * NULLABLE, AND WHY THAT IS NOT A COMPROMISE
 * ---------------------------------------------------------------------------
 *
 * Every column is nullable and nothing is backfilled. Historical payments do
 * not record which account funded them, and there is no honest way to recover
 * it -- a Company with three Cash accounts would get a guess written into
 * financial history, indistinguishable afterwards from a fact.
 *
 * So the database permits null for what already exists, and the SERVICE layer
 * requires an account for every new confirmed payment. Old rows stay truthful
 * about what is unknown; new rows are complete.
 *
 * The CHECK constraints below therefore constrain the COMBINATION, never the
 * presence: "if a bank account is set, the method must be one that uses a bank
 * account". They hold for every historical row, where nothing is set at all.
 *
 * ---------------------------------------------------------------------------
 * CASH AND VISA STAY APART
 * ---------------------------------------------------------------------------
 *
 * Cash payments reference `company_cash_accounts`; Visa/bank payments reference
 * `company_bank_accounts`. Two columns rather than one polymorphic id, so the
 * foreign key does the work and a Bank account can never be recorded as the
 * source of a cash payment.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    -- PAYROLL: cash only, enforced by the existing payroll_payments_method_check
    -- (payment_method = 'cash'). One column, because there is no other kind of
    -- payroll payment and adding a bank column would invite one. Employee bank
    -- details remain deliberately absent from this system.
    alter table payroll_payments
      add column company_cash_account_id uuid,
      add constraint payroll_payments_cash_account_fk
        foreign key (company_cash_account_id, company_id)
        references company_cash_accounts(id, company_id) on delete restrict;

    create index if not exists payroll_payments_cash_account_index
      on payroll_payments (company_id, company_cash_account_id)
      where company_cash_account_id is not null;

    comment on column payroll_payments.company_cash_account_id is
      'Cash account that funded this payment. Null on rows written before this migration; required by the service for every new confirmed payment.';

    -- OUTSOURCED DRIVER FEES: cash or collection_offset. A collection_offset
    -- nets the fee against cash the Driver already owes, so no money leaves an
    -- account and no funding account exists -- the CHECK forbids one.
    alter table outsourced_driver_fee_payments
      add column company_cash_account_id uuid,
      add column company_bank_account_id uuid,
      add constraint outsourced_driver_fee_payments_cash_account_fk
        foreign key (company_cash_account_id, company_id)
        references company_cash_accounts(id, company_id) on delete restrict,
      add constraint outsourced_driver_fee_payments_bank_account_fk
        foreign key (company_bank_account_id, company_id)
        references company_bank_accounts(id, company_id) on delete restrict,
      add constraint outsourced_driver_fee_payments_account_shape_check check (
        -- Never both, whatever the method.
        (company_cash_account_id is null or company_bank_account_id is null)
        -- An offset moves no money, so it may name no account.
        and (payment_method <> 'collection_offset'
             or (company_cash_account_id is null and company_bank_account_id is null))
        -- A cash payment may name a Cash account, never a Bank one.
        and (payment_method <> 'cash' or company_bank_account_id is null)
      );

    create index if not exists outsourced_driver_fee_payments_cash_account_index
      on outsourced_driver_fee_payments (company_id, company_cash_account_id)
      where company_cash_account_id is not null;
    create index if not exists outsourced_driver_fee_payments_bank_account_index
      on outsourced_driver_fee_payments (company_id, company_bank_account_id)
      where company_bank_account_id is not null;

    -- GENERAL EXPENSE PAYMENTS: this table splits ONE payment across
    -- cash_amount and visa_amount on the same row, so a single payment can draw
    -- on both a Cash and a Bank account. Both columns may therefore be set at
    -- once -- the only one of the three tables where that is legitimate.
    --
    -- The CHECK ties each account to its own amount: an account named for a
    -- zero half is a claim about money that did not move.
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

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists general_expense_payments_bank_account_index;
    drop index if exists general_expense_payments_cash_account_index;
    alter table general_expense_payments
      drop constraint if exists general_expense_payments_account_shape_check,
      drop constraint if exists general_expense_payments_bank_account_fk,
      drop constraint if exists general_expense_payments_cash_account_fk,
      drop column if exists company_bank_account_id,
      drop column if exists company_cash_account_id;

    drop index if exists outsourced_driver_fee_payments_bank_account_index;
    drop index if exists outsourced_driver_fee_payments_cash_account_index;
    alter table outsourced_driver_fee_payments
      drop constraint if exists outsourced_driver_fee_payments_account_shape_check,
      drop constraint if exists outsourced_driver_fee_payments_bank_account_fk,
      drop constraint if exists outsourced_driver_fee_payments_cash_account_fk,
      drop column if exists company_bank_account_id,
      drop column if exists company_cash_account_id;

    drop index if exists payroll_payments_cash_account_index;
    alter table payroll_payments
      drop constraint if exists payroll_payments_cash_account_fk,
      drop column if exists company_cash_account_id;
  `.execute(database);
}
