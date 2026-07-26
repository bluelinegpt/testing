import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

// Phase 3: when a Driver collection is confirmed, one payable grouping is created per Trader in
// that collection (§13). It records the Trader's total payable and Order count for the collection
// and links back to the driver_reconciliation; the relevant Orders are the collection's Orders for
// that Trader (driver_reconciliation_orders joined to orders.trader_id). Trader *payments* and
// allocations are Phase 4 and are not created here.
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table driver_collection_trader_payables (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      reconciliation_id uuid not null,
      trader_id uuid not null,
      order_count integer not null,
      total_payable numeric(18, 2) not null,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, reconciliation_id, trader_id),
      constraint driver_collection_trader_payables_reconciliation_fk
        foreign key (reconciliation_id, company_id)
        references driver_reconciliations(id, company_id) on delete restrict,
      constraint driver_collection_trader_payables_trader_fk
        foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      constraint driver_collection_trader_payables_order_count_positive check (order_count > 0),
      constraint driver_collection_trader_payables_total_nonneg check (total_payable >= 0)
    );
    create index driver_collection_trader_payables_reconciliation_index
      on driver_collection_trader_payables (company_id, reconciliation_id);
    create index driver_collection_trader_payables_trader_index
      on driver_collection_trader_payables (company_id, trader_id);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table if exists driver_collection_trader_payables;`.execute(database);
}
