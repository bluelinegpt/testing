import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * 0-due Orders printed on a chosen Trader Settlement (Aiman, 22 Oct 2026).
 *
 * A delivered Order that pays the Trader 0 (COD at or below the fees) is never
 * a settlement line: `trader_settlement_orders` only accepts Orders with money
 * still owed (enforce_settlement_order_trader). The Trader invoice therefore
 * prints such Orders by date, on the first Settlement created after delivery.
 *
 * This table lets the operator pick them on Create Settlement instead: one row
 * per 0-due Order the user ticked, printed at 0.00 on that Settlement's invoice
 * and on no other. A reversed Settlement's rows are ignored, so its Orders go
 * back to printing by date.
 *
 * Additive. It carries no money: no Order, Settlement, payment, Receivable or
 * accounting row is read differently or changed.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table trader_settlement_zero_due_orders (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      settlement_id uuid not null,
      order_id uuid not null,
      created_by_account_id uuid,
      created_at timestamptz not null default now(),
      constraint trader_settlement_zero_due_orders_unique unique (company_id, settlement_id, order_id),
      constraint trader_settlement_zero_due_orders_settlement_fk
        foreign key (settlement_id, company_id)
        references trader_settlements(id, company_id) on delete restrict,
      constraint trader_settlement_zero_due_orders_order_fk
        foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict
    );

    create index trader_settlement_zero_due_orders_order_idx
      on trader_settlement_zero_due_orders(company_id, order_id);

    comment on table trader_settlement_zero_due_orders is
      'Delivered 0-due Orders the user chose to print on a Trader Settlement invoice. No money.';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table if exists trader_settlement_zero_due_orders`.execute(database);
}
