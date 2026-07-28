import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Trader Receivable / Collect Money from Trader — the reverse money-flow
 * direction from Trader Settlement (Trader -> Company, not Company ->
 * Trader). Fully additive and independent of every existing Trader
 * Settlement object: no existing table, trigger, or constraint is touched,
 * and the existing non-negative `orders.trader_net_payable` /
 * `trader_outstanding_balance` constraints are left exactly as they are —
 * a Trader owing the Company is represented in these new tables only, never
 * by relaxing or negating the payable-to-Trader side.
 *
 * Three new tables, mirroring (not reusing) the trader_settlements /
 * trader_settlement_orders / trader_settlement_payments shape:
 *   - trader_receivables            one amount a Trader owes the Company
 *   - trader_collections            one payment received from a Trader
 *   - trader_collection_allocations links a collection to the receivable(s)
 *                                   it pays down, mirroring how
 *                                   trader_settlement_orders links a
 *                                   settlement to the Orders it pays
 *
 * Unlike Trader Settlement / Driver Cash Reconciliation (which reverse via a
 * new zero-value compensating record, because their own amount columns are
 * allowed to be zero), `trader_collections.amount_received` is a strict `> 0`
 * business amount with no zero-value case in this feature's design, so a
 * zero-value marker row does not fit. `status` is instead a real, closed
 * two-value domain (`confirmed`, `reversed`) exactly as approved, flipped in
 * place on the one and only row for that collection; the reversal actor,
 * timestamp and reason are recorded directly on that same row (queried once,
 * no `audit_events` join needed for the detail/report views) as well as on
 * the append-only `audit_events` trail. The original amount, allocations and
 * payment details are never modified or deleted — only `status` and the three
 * `reversed_*` columns change.
 *
 * Two new `company_reference_counters.reference_type` values for the two
 * new human-readable number series (Receivable Number, Collection/Receipt
 * Number) — the existing "reconciliation" type already owns the "REC"
 * prefix, so these use "RCV" and "COL" to stay visually unambiguous.
 *
 * Two new permissions, `trader_receivables.create` / `.reverse`, seeded into
 * the `permissions` catalog only — exactly like `settlements.create` /
 * `.reverse` before them, no `role_permissions` row is inserted here. The
 * default "Company Administrator" bootstrap role only ever receives
 * `users_roles.manage` (confirmed in `development-company-bootstrap.ts`),
 * which already grants access via the same administrator-fallback check
 * every other permission uses; specific roles are then granted these
 * permissions later through the existing Roles UI, not at migration time.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table company_reference_counters drop constraint company_reference_counters_type_check;
    alter table company_reference_counters add constraint company_reference_counters_type_check check (
      reference_type in (
        'order', 'payment', 'reconciliation', 'settlement', 'journal', 'payroll', 'import',
        'trader_receivable', 'trader_collection'
      )
    );

    create table trader_receivables (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      receivable_number text not null,
      trader_id uuid not null,
      source_type text not null,
      source_reference text,
      business_date date not null,
      original_amount_due numeric(18,2) not null,
      amount_collected numeric(18,2) not null default 0,
      outstanding_amount numeric(18,2) generated always as (original_amount_due - amount_collected) stored,
      status text not null default 'outstanding',
      reason text not null,
      notes text,
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, receivable_number),
      constraint trader_receivables_trader_fk foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      constraint trader_receivables_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint trader_receivables_source_type_check check (
        source_type in (
          'manual_adjustment', 'trader_penalty', 'overpayment_recovery', 'refund_due',
          'service_charge', 'damaged_or_lost_shipment_recovery', 'other'
        )
      ),
      constraint trader_receivables_status_check check (
        status in ('outstanding', 'partially_collected', 'collected', 'cancelled', 'reversed')
      ),
      constraint trader_receivables_reason_nonempty check (btrim(reason) <> ''),
      constraint trader_receivables_amounts_check check (
        original_amount_due > 0 and amount_collected >= 0 and amount_collected <= original_amount_due
      )
    );
    create index trader_receivables_trader_index on trader_receivables (company_id, trader_id);
    create index trader_receivables_status_index on trader_receivables (company_id, status);

    create table trader_collections (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      collection_number text not null,
      trader_id uuid not null,
      payment_date date not null,
      payment_method text not null,
      amount_received numeric(18,2) not null,
      company_bank_account_id uuid,
      payment_reference text,
      notes text,
      status text not null default 'confirmed',
      received_by_account_id uuid not null,
      reversed_by_account_id uuid,
      reversed_at timestamptz,
      reversal_reason text,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, collection_number),
      constraint trader_collections_trader_fk foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      constraint trader_collections_bank_fk foreign key (company_bank_account_id, company_id)
        references company_bank_accounts(id, company_id) on delete restrict,
      constraint trader_collections_receiver_fk foreign key (received_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint trader_collections_reverser_fk foreign key (reversed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint trader_collections_method_check check (payment_method in ('cash', 'bank_transfer')),
      constraint trader_collections_status_check check (status in ('confirmed', 'reversed')),
      constraint trader_collections_amount_positive check (amount_received > 0),
      constraint trader_collections_bank_check check (
        (payment_method = 'cash' and company_bank_account_id is null and payment_reference is null)
        or (payment_method = 'bank_transfer' and company_bank_account_id is not null and payment_reference is not null)
      ),
      constraint trader_collections_reversal_shape_check check (
        (status = 'confirmed' and reversed_by_account_id is null and reversed_at is null and reversal_reason is null)
        or (status = 'reversed' and reversed_by_account_id is not null and reversed_at is not null
            and btrim(reversal_reason) <> '')
      )
    );
    create index trader_collections_trader_index on trader_collections (company_id, trader_id);

    create table trader_collection_allocations (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      collection_id uuid not null,
      receivable_id uuid not null,
      amount_allocated numeric(18,2) not null,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, collection_id, receivable_id),
      constraint trader_collection_allocations_collection_fk foreign key (collection_id, company_id)
        references trader_collections(id, company_id) on delete restrict,
      constraint trader_collection_allocations_receivable_fk foreign key (receivable_id, company_id)
        references trader_receivables(id, company_id) on delete restrict,
      constraint trader_collection_allocations_amount_positive check (amount_allocated > 0)
    );
    create index trader_collection_allocations_receivable_index
      on trader_collection_allocations (company_id, receivable_id);

    insert into permissions (code, description) values
      ('trader_receivables.create', 'Create a Trader receivable and confirm a Trader collection'),
      ('trader_receivables.reverse', 'Reverse a confirmed Trader collection')
    on conflict (code) do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code in ('trader_receivables.create', 'trader_receivables.reverse');
    delete from permissions where code in ('trader_receivables.create', 'trader_receivables.reverse');

    drop table if exists trader_collection_allocations;
    drop table if exists trader_collections;
    drop table if exists trader_receivables;

    alter table company_reference_counters drop constraint company_reference_counters_type_check;
    alter table company_reference_counters add constraint company_reference_counters_type_check check (
      reference_type in ('order', 'payment', 'reconciliation', 'settlement', 'journal', 'payroll', 'import')
    );
  `.execute(database);
}
