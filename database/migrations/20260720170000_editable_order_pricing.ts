import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

// Editing an order before delivery may change its Trader, Customer or Area, which
// re-prices the order. The original design froze an order's pricing identity after
// creation via the orders_pricing_provenance_immutable trigger. We drop that trigger so
// the pre-delivery Edit flow can re-price. Internal consistency is still guaranteed by the
// orders_pricing_provenance_check CHECK constraint, and every change is recorded in the
// append-only order_events audit trail.
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists orders_pricing_provenance_immutable on orders;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create trigger orders_pricing_provenance_immutable
      before update of pricing_provenance_status, trader_service_price_id, configured_service_fee_snapshot
      on orders
      for each row execute function protect_order_pricing_provenance();
  `.execute(database);
}
