import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Index foundation for unified Order search.
 *
 * Infrastructure only: no query, endpoint or screen changes with it. The
 * indexes exist so the search rewrite that follows has an indexed path to land
 * on, rather than shipping the rewrite and discovering the plans afterwards.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EXISTING INDEXES ARE NOT ENOUGH
 * ---------------------------------------------------------------------------
 *
 * `orders_company_id_order_number_key`, `orders_customer_mobile_index` and
 * `orders_reference_number_normalized_unique` already serve EQUALITY. They
 * cannot serve `LIKE 'prefix%'`, because this database is created with
 * `English_United States.1252`, not `C`. Under any non-C collation a default
 * B-tree orders text differently from the byte order `LIKE` needs, so the
 * planner refuses the index and falls back to a sequential scan. `text_pattern_ops`
 * builds the same B-tree under byte ordering, which is what makes prefix search
 * indexable. If this database is ever recreated with `C` collation the two
 * pattern indexes below become redundant -- that is the only condition under
 * which they should be dropped.
 *
 * Arbitrary infix search (`'%0050000%'`, `'%Ahmed%'`) is not a B-tree problem at
 * all: no ordering helps when the anchor is unknown. That is what the two
 * trigram indexes are for, and why `pg_trgm` is enabled here.
 *
 * ---------------------------------------------------------------------------
 * MEASURED AT 100,000 ROWS (85,715 in the searched Company)
 * ---------------------------------------------------------------------------
 *
 *   search                        before              after
 *   order number prefix           11.0ms  Seq Scan     0.1ms  Index Scan
 *   reference infix               20.5ms  Seq Scan     0.4ms  Bitmap/GIN
 *   mobile prefix (857 rows)      20.2ms  Seq Scan     0.1ms  Bitmap
 *   customer name, selective      86.8ms  Seq Scan     2.1ms  Bitmap/GIN
 *   customer name '%Ahmed%'       76.2ms  Seq Scan    21.1ms  Bitmap/GIN
 *   closed-tab + reference infix  28.2ms  Seq Scan     0.3ms  Bitmap/GIN
 *
 * The broad-name case is reported as measured rather than as a win: 'Ahmed'
 * matches 8,572 rows (10%), and a bitmap over 10% of a table is legitimately
 * expensive. The claim being made is not "every search is fast", it is "every
 * SELECTIVE search has an index-backed path", which is the property that holds
 * as the table grows.
 *
 * ---------------------------------------------------------------------------
 * COMPANY SCOPING
 * ---------------------------------------------------------------------------
 *
 * Both B-tree indexes lead with `company_id`, so tenant scoping is the first
 * thing the index does rather than a filter applied afterwards.
 *
 * The GIN indexes deliberately do NOT include `company_id`. Adding a uuid to a
 * GIN index needs `btree_gin`, which is not installed, and the alternative --
 * a composite GiST using the already-present `btree_gist` -- searches more
 * slowly than GIN for this workload. Instead the planner combines the trigram
 * bitmap with the Company predicate, which the measurements above confirm it
 * does. Company scoping is never left to post-filtering in the application: the
 * query itself always carries `company_id`, and these indexes only decide how
 * cheaply it is satisfied.
 *
 * ---------------------------------------------------------------------------
 * DEPLOYMENT ON A LARGE TABLE -- READ BEFORE PROMOTING
 * ---------------------------------------------------------------------------
 *
 * These are plain `CREATE INDEX` statements, which take ACCESS EXCLUSIVE and
 * block writes to `orders` for the duration of the build.
 *
 * That is acceptable where this migration runs today: `orders` is small in
 * development and in every environment provisioned so far. It is NOT acceptable
 * on a large production table.
 *
 * `CREATE INDEX CONCURRENTLY` cannot be used here. Kysely's migrator wraps the
 * whole run in one transaction (`supportsTransactionalDdl && !disableTransactions`
 * in `migrator.js`), and CONCURRENTLY cannot run inside a transaction block.
 * Turning `disableTransactions` on globally would remove atomicity from every
 * migration in the repository, which is far too broad a change to make for one
 * index.
 *
 * So for a large database, deploy the indexes FIRST with
 * `database/scripts/order-search-indexes-concurrently.sql`, which creates
 * exactly these five objects with CONCURRENTLY and outside any transaction.
 * Every statement below is `IF NOT EXISTS`, so this migration then finds the
 * work already done and becomes a no-op.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    -- Trigram matching for infix search. IF NOT EXISTS so an environment that
    -- already has it (or has it installed by an operator) is unaffected.
    create extension if not exists pg_trgm;

    -- Order Number prefix, Company-scoped. Equality is already served by
    -- orders_company_id_order_number_key; this exists solely because that index
    -- cannot answer LIKE 'ORD-0005%' under a non-C collation.
    create index if not exists orders_company_order_number_pattern_index
      on orders (company_id, order_number text_pattern_ops);

    -- Customer Mobile prefix, Company-scoped. Same reasoning against
    -- orders_customer_mobile_index, which stays for equality.
    create index if not exists orders_company_mobile_pattern_index
      on orders (company_id, customer_mobile_number text_pattern_ops);

    -- Reference Number infix search. Partial so the index carries only rows
    -- that have a reference at all -- roughly the population that can ever
    -- match -- which keeps it materially smaller than the table.
    create index if not exists orders_reference_normalized_trgm_index
      on orders using gin (reference_number_normalized gin_trgm_ops)
      where reference_number_normalized is not null;

    -- Customer Name infix search, case-insensitive and Unicode-safe. Indexed on
    -- lower(customer_name) so the future query can match with a plain
    -- lower(...) like lower(...) and stay indexable; ILIKE would not use it.
    -- Trigrams work on Arabic as they do on Latin, so 'أحمد' is searchable
    -- without a second mechanism. The stored display value is untouched.
    create index if not exists orders_customer_name_trgm_index
      on orders using gin (lower(customer_name) gin_trgm_ops);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  /*
   * The extension is deliberately NOT dropped. Another feature may have come to
   * depend on pg_trgm by the time this is reversed, and dropping a shared
   * extension to undo four indexes is a far larger act than this migration
   * performed.
   */
  await sql`
    drop index if exists orders_customer_name_trgm_index;
    drop index if exists orders_reference_normalized_trgm_index;
    drop index if exists orders_company_mobile_pattern_index;
    drop index if exists orders_company_order_number_pattern_index;
  `.execute(database);
}
