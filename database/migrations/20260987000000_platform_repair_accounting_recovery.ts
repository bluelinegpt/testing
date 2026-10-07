import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Platform Repair Center -- accounting event recovery (Phase 2, Prompt 4).
 *
 * Additive widening of `platform_repair_executions` (20260986000000) so the
 * same immutable audit / idempotency ledger can record an ACCOUNTING EVENT
 * recovery, whose subject is an Accounting Event rather than an Order:
 *
 *   - `order_id` becomes nullable: an Event's source is not always an Order
 *     (a settlement, a collection, a Credit). When the source resolves to an
 *     Order it is still recorded.
 *   - `entity_type` additionally allows 'accounting_event'.
 *
 * No row is changed (the table is append-only); no permission is added -- the
 * execution is governed by the existing
 * `platform.companies.repair_center.execute`.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_repair_executions alter column order_id drop not null;
    alter table platform_repair_executions
      drop constraint if exists platform_repair_executions_entity_type_check;
    alter table platform_repair_executions
      add constraint platform_repair_executions_entity_type_check
      check (entity_type in ('order', 'trader_receivable', 'accounting_event'));
  `.execute(database);
}

/** Forward-only: recorded accounting recoveries must stay readable. */
export async function down(): Promise<void> {
  // Intentionally empty: narrowing the check would reject recorded history.
}
