-- Unified Order search indexes, built without blocking writes.
--
-- WHEN TO USE THIS
-- ----------------------------------------------------------------------------
-- Run this INSTEAD of letting migration
-- `20260810300000_order_search_index_foundation` build the indexes, on any
-- database where `orders` is large enough that an ACCESS EXCLUSIVE lock for the
-- duration of an index build is unacceptable -- i.e. production.
--
-- Order of operations for such a database:
--
--   1. Run this script (writes keep flowing throughout).
--   2. Run the migration as usual. Every statement in it is `IF NOT EXISTS`,
--      so it finds the work already done, records itself, and changes nothing.
--
-- On a small database the migration alone is fine and this script is unnecessary.
--
-- WHY THIS IS A SCRIPT AND NOT PART OF THE MIGRATION
-- ----------------------------------------------------------------------------
-- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, and
-- Kysely's migrator wraps the entire migration run in one transaction. Enabling
-- its `disableTransactions` option would strip atomicity from every migration in
-- the repository -- an unacceptable trade for four indexes. Keeping the
-- concurrent build here is the honest split: the migration owns the schema
-- contract, this script owns how it is applied safely at scale.
--
-- HOW TO RUN
-- ----------------------------------------------------------------------------
--   psql "$DATABASE_URL" -f database/scripts/order-search-indexes-concurrently.sql
--
-- Do NOT wrap this in BEGIN/COMMIT and do not run it through a tool that opens
-- a transaction for you. psql without -1 / --single-transaction is correct.
--
-- IF IT FAILS PART-WAY
-- ----------------------------------------------------------------------------
-- A failed CONCURRENTLY build leaves an INVALID index behind. It is not used by
-- the planner and it does not corrupt anything, but it does consume space and it
-- will not be replaced by a re-run, because `IF NOT EXISTS` sees the name as
-- taken. Find and drop any invalid index before retrying:
--
--   SELECT c.relname
--     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE NOT i.indisvalid;
--
--   DROP INDEX CONCURRENTLY <name>;
--
-- Each statement is independently re-runnable, so a retry only rebuilds what is
-- genuinely missing.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Order Number prefix, Company-scoped. `text_pattern_ops` because this database
-- uses a non-C collation, under which a default B-tree cannot serve LIKE 'x%'.
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_company_order_number_pattern_index
  ON orders (company_id, order_number text_pattern_ops);

-- Customer Mobile prefix, Company-scoped. Same collation reasoning.
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_company_mobile_pattern_index
  ON orders (company_id, customer_mobile_number text_pattern_ops);

-- Reference Number infix search. Partial: only rows that have a reference can
-- ever match one.
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_reference_normalized_trgm_index
  ON orders USING gin (reference_number_normalized gin_trgm_ops)
  WHERE reference_number_normalized IS NOT NULL;

-- Customer Name infix search, case-insensitive and Unicode-safe.
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_customer_name_trgm_index
  ON orders USING gin (lower(customer_name) gin_trgm_ops);

-- Serial Number exact and prefix, Company-scoped. Partial because serials are
-- optional and only an Order that has one can match one. The existing
-- orders_daily_serial_number_unique cannot serve this: it leads with
-- (company_id, order_date), so a search that does not know the date cannot use
-- the serial as an index condition.
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_company_serial_pattern_index
  ON orders (company_id, serial_number_normalized text_pattern_ops)
  WHERE serial_number_normalized IS NOT NULL;

-- Fresh statistics for the new expression index, so the planner costs it
-- correctly from the first query rather than after the next autovacuum.
ANALYZE orders;
