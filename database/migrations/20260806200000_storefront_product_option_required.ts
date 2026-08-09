import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Required Product option groups.
 *
 * ---------------------------------------------------------------------------
 * WHY A COLUMN AND NOT A CONSTRAINT
 * ---------------------------------------------------------------------------
 *
 * "A required group must have at least one active value before the Product is
 * activated" spans three rows in two tables and depends on the Product's
 * lifecycle, so no CHECK can express it. It is enforced transactionally at
 * activation, where the Product row is already locked, and the column here is
 * only the declaration of intent.
 *
 * The default is FALSE deliberately: every option group that already exists was
 * created when the concept did not, and silently making them required would
 * block activation for Products that are live today.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * Required means "the customer must choose one of these", nothing more. It does
 * not introduce variants: there is still no per-combination stock, price or
 * SKU, and this migration adds no column that could hold one.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table trader_storefront_product_option_groups
      add column is_required boolean not null default false
  `.execute(database);

  // Activation reads "the required groups for this Product" on every attempt;
  // a partial index keeps that lookup proportional to the required ones rather
  // than to every option group in the catalogue.
  await sql`
    create index trader_storefront_product_option_groups_required_idx
      on trader_storefront_product_option_groups (product_id)
      where is_required and is_active
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop index if exists trader_storefront_product_option_groups_required_idx`.execute(
    database,
  );
  await sql`
    alter table trader_storefront_product_option_groups drop column if exists is_required
  `.execute(database);
}
