import { sql } from "kysely";
import type { Kysely } from "kysely";

type MigrationDatabase = Record<string, unknown>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table if not exists platform_fee_receivables (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      quote_request_id uuid references platform_customer_quote_requests(id) on delete set null,
      order_id uuid not null references orders(id) on delete restrict,
      source text not null default 'customer_quote_order',
      currency char(3) not null default 'AED',
      amount numeric(12,2) not null,
      paid_amount numeric(12,2) not null default 0,
      status text not null default 'unpaid',
      created_by_account_id uuid references accounts(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint platform_fee_receivables_amount_positive check (amount > 0),
      constraint platform_fee_receivables_paid_nonnegative check (paid_amount >= 0),
      constraint platform_fee_receivables_paid_not_over_amount check (paid_amount <= amount),
      constraint platform_fee_receivables_status_check check (status in ('unpaid','partially_paid','paid','cancelled'))
    );

    create unique index if not exists platform_fee_receivables_order_unique
      on platform_fee_receivables(order_id);
    create index if not exists platform_fee_receivables_company_status_idx
      on platform_fee_receivables(company_id,status,created_at desc);

    create table if not exists platform_fee_payments (
      id uuid primary key default gen_random_uuid(),
      receivable_id uuid not null references platform_fee_receivables(id) on delete restrict,
      company_id uuid not null references companies(id) on delete restrict,
      amount numeric(12,2) not null,
      payment_date date not null default current_date,
      payment_method text,
      reference_number text,
      notes text,
      recorded_by_account_id uuid references accounts(id) on delete set null,
      created_at timestamptz not null default now(),
      constraint platform_fee_payments_amount_positive check (amount > 0)
    );

    create index if not exists platform_fee_payments_receivable_idx
      on platform_fee_payments(receivable_id,created_at desc);
    create index if not exists platform_fee_payments_company_date_idx
      on platform_fee_payments(company_id,payment_date desc);

    insert into platform_fee_receivables (
      company_id, quote_request_id, order_id, source, currency, amount, paid_amount, status,
      created_by_account_id, created_at, updated_at
    )
    select
      q.assigned_company_id,
      q.id,
      q.converted_order_id,
      'customer_quote_order',
      coalesce(q.quote_currency, 'AED'),
      q.platform_fee_amount,
      0,
      'unpaid',
      q.converted_by_account_id,
      coalesce(q.converted_at, q.created_at, now()),
      now()
    from platform_customer_quote_requests q
    where q.assigned_company_id is not null
      and q.converted_order_id is not null
      and q.platform_fee_amount is not null
      and q.platform_fee_amount > 0
    on conflict (order_id) do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop table if exists platform_fee_payments;
    drop table if exists platform_fee_receivables;
  `.execute(database);
}
