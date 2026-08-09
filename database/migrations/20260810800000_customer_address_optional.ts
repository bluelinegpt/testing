import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * A saved Customer address may be blank.
 *
 * Customer address is optional on the Order. Creating an Order for a NEW
 * Customer also creates that Customer's default address record, and
 * `customer_addresses_address_nonempty` forbade an empty one -- so the form had
 * to keep asking for a value it did not need.
 *
 * The first attempt at this avoided the constraint instead: skip the address
 * record entirely when nothing was typed. That failed on a DIFFERENT rule.
 * `orders_customer_provenance_check` requires `customer_address_id IS NOT NULL`
 * for a 'resolved' Order, and rightly so -- a resolved Order is one that carries
 * a complete Customer snapshot, and a null address identifier is not that.
 * Creating the Order then raised the generic integrity error.
 *
 * So the address record is always created, and this relaxes the one rule that
 * actually stood in the way. The Area is always known (the Order has one), so
 * the record is meaningful even with no street line.
 *
 * `NOT NULL` stays. The column still always has a value; that value may now be
 * the empty string, exactly as `orders.customer_address` already worked. The two
 * were inconsistent and this makes them agree.
 *
 * No backfill: nothing violates the relaxed rule and no existing address is
 * touched.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table customer_addresses
      drop constraint if exists customer_addresses_address_nonempty;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  /*
   * Reversible only while no blank address exists. Once one does, this ALTER
   * fails rather than silently leaving an invalid Customer record behind --
   * which is the correct outcome: the fix is to fill the addresses in, not to
   * hide them.
   */
  await sql`
    alter table customer_addresses
      add constraint customer_addresses_address_nonempty check (btrim(address) <> '');
  `.execute(database);
}
