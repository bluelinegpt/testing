import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Customer Commerce Prompt C3, Part C: duplicate-submission protection for
 * Store Order creation.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE TABLE, NOT A COLUMN ON `store_orders`
 * ---------------------------------------------------------------------------
 *
 * A reservation must exist BEFORE the Store Order does -- the whole point is
 * to let a concurrent duplicate request lose a race at `INSERT ... ON
 * CONFLICT DO NOTHING` before any Store Order work begins. A column on
 * `store_orders` cannot do that: there would be nothing to conflict against
 * until a row already existed, by which point the duplicate has already done
 * all its revalidation work. `status` distinguishes a reservation an
 * in-flight request is still working on (`pending`) from one whose Store
 * Order actually exists (`completed`); a `pending` row older than 30 seconds
 * is treated as abandoned (crashed request) and reclaimed by a fresh
 * attempt with the same key, rather than blocking that key forever.
 *
 * `raw_tracking_token` is the ONE narrow, deliberate exception to "only the
 * hash is ever stored" (`store_orders.tracking_token_hash`): it exists ONLY
 * so a legitimate retry of the SAME idempotency key -- e.g. the commit
 * succeeded but the HTTP response was lost, and the client retries -- can be
 * handed the same raw token again, exactly as it would have received it the
 * first time. It is never returned to a caller who does not already hold
 * this exact `(scope_key, idempotency_key)` pair, and this table is not
 * queried by anything outside `StoreOrderSubmissionService`.
 *
 * Purely additive: no existing table's shape changes. Store Order domain
 * only -- no Delivery Order, Accounting, or reconciliation object touched.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table store_order_idempotency_keys (
      id uuid primary key default gen_random_uuid(),
      scope_key text not null check (btrim(scope_key) <> ''),
      idempotency_key text not null check (btrim(idempotency_key) <> ''),
      payload_hash text not null,
      status text not null check (status in ('pending', 'completed')),
      store_order_id uuid references store_orders(id) on delete restrict,
      raw_tracking_token text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint store_order_idempotency_keys_scope_key_unique unique (scope_key, idempotency_key),
      constraint store_order_idempotency_keys_completed_has_order
        check (status <> 'completed' or store_order_id is not null)
    );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table store_order_idempotency_keys;`.execute(database);
}
