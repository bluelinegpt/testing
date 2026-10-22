import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * 0.00 Trader invoices (Aiman, 22 Oct 2026).
 *
 * A Trader whose only open Orders pay him nothing ("Nothing to pay": the
 * customer paid, the Company kept its fee) still needs an invoice as proof. A
 * Trader Settlement always moves money (net > 0), so such an invoice cannot
 * be one. It is its own small record, numbered INV-000001, with no money: the
 * "Nothing to pay" Orders printed on it are remembered in the existing
 * `trader_settlement_zero_due_orders`, which now points at a Settlement OR a
 * 0.00 invoice (exactly one), so they are not offered again. Un-post marks the
 * invoice reversed and its Orders become available again.
 *
 * Additive:
 *   - new table `trader_zero_invoices`;
 *   - `trader_settlement_zero_due_orders.settlement_id` becomes nullable with a
 *     new `zero_invoice_id`, and a check that each row has exactly one of the
 *     two (every existing row has a Settlement, so it already passes);
 *   - `trader_settlement_drafts.confirmed_zero_invoice_id`, and the draft
 *     status rule widened to include it (no existing row changes);
 *   - the reference counter accepts `trader_zero_invoice`.
 * No money, Order, Settlement or accounting row is changed.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table if not exists trader_zero_invoices (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      trader_id uuid not null,
      invoice_number text not null,
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      reversed_at timestamptz,
      reversed_by_account_id uuid,
      reversal_reason text,
      constraint trader_zero_invoices_number_unique unique (company_id, invoice_number),
      constraint trader_zero_invoices_id_company_unique unique (id, company_id),
      constraint trader_zero_invoices_trader_fk
        foreign key (trader_id, company_id) references traders(id, company_id) on delete restrict,
      constraint trader_zero_invoices_creator_fk
        foreign key (created_by_account_id, company_id) references accounts(id, company_id) on delete restrict,
      constraint trader_zero_invoices_reversal_shape check (
        (reversed_at is null and reversed_by_account_id is null and reversal_reason is null)
        or (reversed_at is not null and reversed_by_account_id is not null and btrim(coalesce(reversal_reason, '')) <> '')
      )
    )
  `.execute(database);
  await sql`
    create index if not exists trader_zero_invoices_trader_idx
      on trader_zero_invoices(company_id, trader_id)
  `.execute(database);
  await sql`
    comment on table trader_zero_invoices is
      '0.00 Trader invoices: proof of Nothing-to-pay Orders. No money.'
  `.execute(database);

  await sql`
    alter table trader_settlement_zero_due_orders
      alter column settlement_id drop not null,
      add column if not exists zero_invoice_id uuid
  `.execute(database);
  await sql`
    alter table trader_settlement_zero_due_orders
      drop constraint if exists trader_settlement_zero_due_orders_zero_invoice_fk,
      add constraint trader_settlement_zero_due_orders_zero_invoice_fk
        foreign key (zero_invoice_id, company_id)
        references trader_zero_invoices(id, company_id) on delete restrict,
      drop constraint if exists trader_settlement_zero_due_orders_one_parent,
      add constraint trader_settlement_zero_due_orders_one_parent
        check (num_nonnulls(settlement_id, zero_invoice_id) = 1)
  `.execute(database);
  await sql`
    create unique index if not exists trader_settlement_zero_due_orders_invoice_unique
      on trader_settlement_zero_due_orders(company_id, zero_invoice_id, order_id)
      where zero_invoice_id is not null
  `.execute(database);

  await sql`
    alter table trader_settlement_drafts
      add column if not exists confirmed_zero_invoice_id uuid
  `.execute(database);
  await sql`
    alter table trader_settlement_drafts
      drop constraint if exists trader_settlement_drafts_confirmed_zero_invoice_fk,
      add constraint trader_settlement_drafts_confirmed_zero_invoice_fk
        foreign key (confirmed_zero_invoice_id, company_id)
        references trader_zero_invoices(id, company_id) on delete restrict,
      drop constraint if exists trader_settlement_drafts_status_consistent,
      add constraint trader_settlement_drafts_status_consistent
        check ((status = 'confirmed') = (confirmed_settlement_id is not null
                                         or confirmed_collection_id is not null
                                         or confirmed_zero_invoice_id is not null))
  `.execute(database);

  await sql`
    alter table company_reference_counters
      drop constraint if exists company_reference_counters_type_check,
      add constraint company_reference_counters_type_check check (reference_type = any (array[
        'accounting_opening_balance', 'area', 'cash_bank_movement', 'customer', 'driver', 'employee',
        'employee_salary_advance', 'employee_variable_earning_payment', 'general_expense',
        'general_expense_payment', 'import', 'journal', 'order', 'outsourced_driver_fee_payment',
        'payment', 'payroll', 'payroll_payment', 'reconciliation', 'settlement', 'trader',
        'trader_collection', 'trader_receivable', 'trader_credit', 'route_run', 'trader_zero_invoice'
      ]::text[]))
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table company_reference_counters
      drop constraint if exists company_reference_counters_type_check,
      add constraint company_reference_counters_type_check check (reference_type = any (array[
        'accounting_opening_balance', 'area', 'cash_bank_movement', 'customer', 'driver', 'employee',
        'employee_salary_advance', 'employee_variable_earning_payment', 'general_expense',
        'general_expense_payment', 'import', 'journal', 'order', 'outsourced_driver_fee_payment',
        'payment', 'payroll', 'payroll_payment', 'reconciliation', 'settlement', 'trader',
        'trader_collection', 'trader_receivable', 'trader_credit', 'route_run'
      ]::text[]))
  `.execute(database);
  await sql`
    alter table trader_settlement_drafts
      drop constraint if exists trader_settlement_drafts_status_consistent,
      add constraint trader_settlement_drafts_status_consistent
        check ((status = 'confirmed') = (confirmed_settlement_id is not null or confirmed_collection_id is not null)),
      drop constraint if exists trader_settlement_drafts_confirmed_zero_invoice_fk,
      drop column if exists confirmed_zero_invoice_id
  `.execute(database);
  await sql`drop index if exists trader_settlement_zero_due_orders_invoice_unique`.execute(database);
  await sql`delete from trader_settlement_zero_due_orders where zero_invoice_id is not null`.execute(database);
  await sql`
    alter table trader_settlement_zero_due_orders
      drop constraint if exists trader_settlement_zero_due_orders_one_parent,
      drop constraint if exists trader_settlement_zero_due_orders_zero_invoice_fk,
      drop column if exists zero_invoice_id,
      alter column settlement_id set not null
  `.execute(database);
  await sql`drop table if exists trader_zero_invoices`.execute(database);
}
