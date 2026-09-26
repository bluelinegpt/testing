import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * SEO metadata for Stores, Products and Marketplace taxonomy.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIELD IS OPTIONAL, AND THAT IS THE DESIGN
 * ---------------------------------------------------------------------------
 *
 * Not one column here is NOT NULL. A Trader who never opens the SEO section
 * must still get correct, complete metadata, so the metadata layer derives
 * everything from data that already exists — the Store's display name, the
 * Product's description — and treats these columns purely as OVERRIDES.
 *
 * The alternative, requiring a Trader to write a title before their shop can be
 * shared, would mean either an empty `<title>` in production or a made-up one.
 * Both are worse than "use the name the Trader already gave it".
 *
 * ---------------------------------------------------------------------------
 * WHY indexable IS A COLUMN AND NOT A DERIVED VALUE
 * ---------------------------------------------------------------------------
 *
 * Whether a page is `noindex` is already decided for most cases by data the
 * system owns: an unpublished Store and a draft Product are never indexable,
 * and no flag can override that. `seo_indexable` exists for the remaining case
 * — a live, public resource the owner nonetheless does not want indexed — which
 * nothing else in the schema can express. It defaults to true because the
 * common intent for a published shop is to be found.
 *
 * ---------------------------------------------------------------------------
 * NO SOCIAL IMAGE BINARY IS DUPLICATED
 * ---------------------------------------------------------------------------
 *
 * `seo_social_file_id` is a REFERENCE to an existing `file_objects` row, on the
 * same terms as the Store logo. When it is absent the metadata layer falls back
 * to media the Store or Product already has. Nothing here copies an image so
 * that a share card can have its own.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table trader_storefronts
      add column seo_title_en text,
      add column seo_title_ar text,
      add column seo_description_en text,
      add column seo_description_ar text,
      add column seo_social_file_id uuid references file_objects(id) on delete set null,
      add column seo_indexable boolean not null default true
  `.execute(database);

  await sql`
    alter table trader_storefront_products
      add column seo_title_en text,
      add column seo_title_ar text,
      add column seo_description_en text,
      add column seo_description_ar text,
      add column seo_social_file_id uuid references file_objects(id) on delete set null,
      add column seo_indexable boolean not null default true
  `.execute(database);

  // Taxonomy SEO is Platform-owned and has no `seo_social_file_id`: a Category
  // page's social image would be a Platform asset, and no Platform media
  // surface exists yet. Adding the column now would be an unusable placeholder.
  await sql`
    alter table marketplace_categories
      add column seo_title_en text,
      add column seo_title_ar text,
      add column seo_description_en text,
      add column seo_description_ar text,
      add column seo_indexable boolean not null default true
  `.execute(database);

  await sql`
    alter table marketplace_subcategories
      add column seo_title_en text,
      add column seo_title_ar text,
      add column seo_description_en text,
      add column seo_description_ar text,
      add column seo_indexable boolean not null default true
  `.execute(database);

  // Blank is not a value. An empty string would satisfy "is not null" and then
  // render as an empty <title>, which is worse than the fallback it displaced —
  // so a supplied override must actually contain something.
  for (const table of [
    "trader_storefronts",
    "trader_storefront_products",
    "marketplace_categories",
    "marketplace_subcategories",
  ]) {
    await sql`
      alter table ${sql.raw(table)}
        add constraint ${sql.raw(`${table}_seo_text_check`)} check (
          (seo_title_en is null or length(btrim(seo_title_en)) > 0)
          and (seo_title_ar is null or length(btrim(seo_title_ar)) > 0)
          and (seo_description_en is null or length(btrim(seo_description_en)) > 0)
          and (seo_description_ar is null or length(btrim(seo_description_ar)) > 0)
        )
    `.execute(database);
  }
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  for (const table of [
    "trader_storefronts",
    "trader_storefront_products",
    "marketplace_categories",
    "marketplace_subcategories",
  ]) {
    await sql`
      alter table ${sql.raw(table)}
        drop constraint if exists ${sql.raw(`${table}_seo_text_check`)}
    `.execute(database);
  }
  await sql`
    alter table marketplace_subcategories
      drop column if exists seo_indexable,
      drop column if exists seo_description_ar,
      drop column if exists seo_description_en,
      drop column if exists seo_title_ar,
      drop column if exists seo_title_en
  `.execute(database);
  await sql`
    alter table marketplace_categories
      drop column if exists seo_indexable,
      drop column if exists seo_description_ar,
      drop column if exists seo_description_en,
      drop column if exists seo_title_ar,
      drop column if exists seo_title_en
  `.execute(database);
  await sql`
    alter table trader_storefront_products
      drop column if exists seo_indexable,
      drop column if exists seo_social_file_id,
      drop column if exists seo_description_ar,
      drop column if exists seo_description_en,
      drop column if exists seo_title_ar,
      drop column if exists seo_title_en
  `.execute(database);
  await sql`
    alter table trader_storefronts
      drop column if exists seo_indexable,
      drop column if exists seo_social_file_id,
      drop column if exists seo_description_ar,
      drop column if exists seo_description_en,
      drop column if exists seo_title_ar,
      drop column if exists seo_title_en
  `.execute(database);
}
