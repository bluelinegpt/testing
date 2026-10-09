import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Why an Order was cancelled, as one of a fixed list (Aiman, 9 Oct 2026).
 *
 * - `cancel_by_customer`, `cancel_by_trader`, `cancel_normal` (the default).
 * - Internal only: never shown to Traders, and a label only -- it does not
 *   change any amount, fee, receivable or settlement.
 * - The free-text cancellation note is unchanged and still lives in
 *   `orders.delivery_reason` and `order_status_history.reason`.
 *
 * Additive and nullable. Orders cancelled before this migration keep NULL
 * (shown as "—"); nothing is backfilled or guessed. Cancelled is a terminal
 * status, so the value never needs clearing.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders
      add column cancellation_reason_code text;

    alter table orders
      add constraint orders_cancellation_reason_code_check check (
        cancellation_reason_code is null
        or cancellation_reason_code in ('cancel_by_customer', 'cancel_by_trader', 'cancel_normal')
      );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders drop constraint if exists orders_cancellation_reason_code_check;
    alter table orders drop column if exists cancellation_reason_code;
  `.execute(database);
}
