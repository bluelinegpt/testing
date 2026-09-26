import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Customer Commerce C3 corrective (Tracking Token Security): removes
 * plaintext raw-tracking-token storage.
 *
 * `store_order_idempotency_keys.raw_tracking_token` (added by
 * `20260924000000_store_order_idempotency_keys.ts`) stored the Store
 * Order's raw guest tracking credential in plaintext so an idempotent retry
 * could hand it back to the Customer a second time. On review this is not
 * an acceptable trade-off: `store_orders.tracking_token_hash` is the ONE
 * place a tracking credential is ever meant to be persisted, and it is
 * intentionally one-way (SHA-256, no plaintext, no decrypt path) -- a
 * second, plaintext copy of the same secret undermines that design
 * regardless of which table it lives in.
 *
 * The corrected model needs no replacement column: an idempotent replay
 * returns the Store Order in full (number, status, items, totals -- see
 * `StoreOrderSubmissionService.placeOrder`) but `trackingToken: null`,
 * because the guarantee idempotency actually owes a caller is "same request
 * -> same Store Order", not "same request -> the same secret handed out a
 * second time". A guest whose first response was lost still has their Store
 * Order; a logged-in Customer finds it in My Orders, which never depended
 * on the token.
 *
 * Local/dev-only data: this table has existed for less than a day and holds
 * only the four Store Orders created during C3's own testing (see the C3
 * corrective completion report for the exact list). `drop column` discards
 * whatever plaintext values exist without ever selecting or logging them.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table store_order_idempotency_keys
      drop column raw_tracking_token;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table store_order_idempotency_keys
      add column raw_tracking_token text;
  `.execute(database);
}
