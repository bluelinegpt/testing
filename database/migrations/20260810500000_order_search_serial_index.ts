import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Serial Number joins the unified Order search.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EXISTING SERIAL INDEX CANNOT SERVE THIS
 * ---------------------------------------------------------------------------
 *
 * `orders_daily_serial_number_unique` is
 * `(company_id, order_date, serial_number_normalized)`. It exists to enforce
 * one serial per Company per DAY, and its column order says so: the serial is
 * third. A search that knows the Company and the serial but NOT the order date
 * can only use the first column as an index condition, leaving the serial to be
 * rechecked against every Order the Company has ever had. That index is doing
 * its job correctly; it simply is not the shape a search needs.
 *
 * Hence one more index, leading with the two columns a search actually has.
 *
 * ---------------------------------------------------------------------------
 * WHY B-TREE AND NOT TRIGRAM
 * ---------------------------------------------------------------------------
 *
 * The requirement is exact and prefix, not arbitrary infix. `text_pattern_ops`
 * covers both -- it supports equality as well as byte-ordered range scans, so a
 * second index for exact lookup would be redundant. A GIN trigram index would
 * be larger, slower to write, and would buy an infix capability nobody asked
 * for; Reference Number is the field where operators paste fragments, and it
 * already has trigram coverage.
 *
 * `text_pattern_ops` rather than a default B-tree because this database uses
 * `English_United States.1252`. Under a non-C collation a default B-tree orders
 * text differently from the byte order `LIKE` needs, so the planner refuses it
 * for `LIKE 'x%'` -- the same reason the Order Number and Mobile pattern
 * indexes exist.
 *
 * Partial on `is not null`: only an Order that HAS a serial can ever match one,
 * and serials are optional, so the index carries just the rows worth carrying.
 *
 * ---------------------------------------------------------------------------
 * DEPLOYMENT ON A LARGE TABLE
 * ---------------------------------------------------------------------------
 *
 * Same split as the index foundation, deliberately reusing that convention
 * rather than inventing a second one. This is a plain `CREATE INDEX`, which
 * takes ACCESS EXCLUSIVE and blocks writes for the duration of the build --
 * fine where `orders` is small, not fine on a large production table.
 *
 * `CREATE INDEX CONCURRENTLY` cannot be used from a migration because Kysely
 * wraps the run in a transaction. For a large database, run
 * `database/scripts/order-search-indexes-concurrently.sql` first -- it now
 * includes this index -- and this migration then finds the work done and
 * becomes a no-op, because the statement is `IF NOT EXISTS`.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create index if not exists orders_company_serial_pattern_index
      on orders (company_id, serial_number_normalized text_pattern_ops)
      where serial_number_normalized is not null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop index if exists orders_company_serial_pattern_index`.execute(database);
}
