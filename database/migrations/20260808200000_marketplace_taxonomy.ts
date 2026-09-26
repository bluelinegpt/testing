import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Platform Marketplace taxonomy.
 *
 * ---------------------------------------------------------------------------
 * TWO CATEGORY SYSTEMS, DELIBERATELY UNRELATED
 * ---------------------------------------------------------------------------
 *
 * `trader_storefront_categories` already exists and is NOT touched by this
 * migration. It is the Trader's own shelf labelling — "Eid Collection", "New
 * Arrivals" — meaningful only inside one shop, created and renamed freely by
 * the Trader.
 *
 * What this migration adds is a different thing that happens to share the word
 * "category": a Platform-controlled vocabulary used ACROSS shops for
 * marketplace navigation and discovery. A Trader cannot create one.
 *
 * They are separate tables with no foreign key between them, and a Product
 * carries both independently. Merging them would have been the cheaper schema
 * and the wrong one: the moment a Trader renamed "Summer Collection" the
 * marketplace's Fashion page would have moved with it.
 *
 * ---------------------------------------------------------------------------
 * THE PARENT-CONSISTENCY INVARIANT IS A FOREIGN KEY, NOT A SERVICE CHECK
 * ---------------------------------------------------------------------------
 *
 * A Product names a Category and optionally a Subcategory, and the Subcategory
 * must belong to that Category. Expressed the obvious way — two independent
 * foreign keys plus a validation in the service — that rule holds only as long
 * as every write path remembers it.
 *
 * Instead `marketplace_subcategories` carries a unique `(id,
 * marketplace_category_id)` pair, and the Product references BOTH columns
 * through one composite foreign key. "Fashion / Abayas" inserts; "Electronics /
 * Abayas" cannot, because no such pair exists. The database refuses it whether
 * the request came through the service, a script, or psql.
 *
 * MATCH SIMPLE makes the optional half work correctly: a Product with a
 * Category and no Subcategory skips the composite check entirely, which is
 * exactly the intended "classified to Fashion, no finer" state.
 *
 * ---------------------------------------------------------------------------
 * DIRECT COLUMNS RATHER THAN A PRODUCT JOIN TABLE
 * ---------------------------------------------------------------------------
 *
 * A Product gets one marketplace classification, so two nullable columns say
 * that precisely. A join table would have needed an `is_primary` flag, a
 * partial unique index to enforce exactly one, and every read to join — all to
 * express a cardinality the columns state for free. The Store side genuinely is
 * many-to-one-with-a-primary, so that one DOES get a join table.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  // ------------------------------------------------------------- categories

  await sql`
    create table marketplace_categories (
      id uuid primary key default gen_random_uuid(),

      name_en text not null,
      name_ar text,
      slug text not null,
      description_en text,
      description_ar text,

      -- Foundation only. A Category is perfectly valid without artwork, and no
      -- Platform upload surface exists yet.
      icon_file_id uuid references file_objects(id) on delete set null,

      display_order integer not null default 0,
      is_active boolean not null default true,

      created_by_account_id uuid,
      updated_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,

      constraint marketplace_categories_name_check check (length(btrim(name_en)) > 0),
      constraint marketplace_categories_name_ar_check check (
        name_ar is null or length(btrim(name_ar)) > 0
      ),
      -- The same shape the Storefront slug uses: a public route segment,
      -- lowercase alphanumerics and single interior hyphens only.
      constraint marketplace_categories_slug_shape_check check (
        slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 2 and 63
      ),
      constraint marketplace_categories_order_check check (display_order >= 0)
    )
  `.execute(database);

  // Case-insensitive and global. `Fashion` and `fashion` are one Category.
  await sql`
    create unique index marketplace_categories_slug_unique
      on marketplace_categories (lower(slug))
  `.execute(database);
  await sql`
    create index marketplace_categories_active_idx
      on marketplace_categories (display_order, lower(name_en)) where is_active
  `.execute(database);

  // ---------------------------------------------------------- subcategories

  await sql`
    create table marketplace_subcategories (
      id uuid primary key default gen_random_uuid(),
      marketplace_category_id uuid not null
        references marketplace_categories(id) on delete restrict,

      name_en text not null,
      name_ar text,
      slug text not null,
      description_en text,
      description_ar text,
      icon_file_id uuid references file_objects(id) on delete set null,

      display_order integer not null default 0,
      is_active boolean not null default true,

      created_by_account_id uuid,
      updated_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,

      constraint marketplace_subcategories_name_check check (length(btrim(name_en)) > 0),
      constraint marketplace_subcategories_name_ar_check check (
        name_ar is null or length(btrim(name_ar)) > 0
      ),
      constraint marketplace_subcategories_slug_shape_check check (
        slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 2 and 63
      ),
      constraint marketplace_subcategories_order_check check (display_order >= 0),

      -- The pair a Product's composite foreign key points at. This is what
      -- makes "this Subcategory belongs to that Category" a schema fact.
      constraint marketplace_subcategories_parent_key
        unique (id, marketplace_category_id)
    )
  `.execute(database);

  // Unique WITHIN a parent, not globally: "Fashion / Women" and
  // "Electronics / Women" are both reasonable and must be able to coexist.
  await sql`
    create unique index marketplace_subcategories_slug_unique
      on marketplace_subcategories (marketplace_category_id, lower(slug))
  `.execute(database);
  await sql`
    create index marketplace_subcategories_active_idx
      on marketplace_subcategories (marketplace_category_id, display_order, lower(name_en))
      where is_active
  `.execute(database);

  // -------------------------------------------------- Store classification

  await sql`
    create table storefront_marketplace_categories (
      id uuid primary key default gen_random_uuid(),
      storefront_id uuid not null references trader_storefronts(id) on delete restrict,
      marketplace_category_id uuid not null
        references marketplace_categories(id) on delete restrict,

      is_primary boolean not null default false,

      created_by_account_id uuid,
      created_at timestamptz not null default now(),

      constraint storefront_marketplace_categories_unique
        unique (storefront_id, marketplace_category_id)
    )
  `.execute(database);

  // At most one primary per Store. A partial unique index rather than a service
  // rule, because two concurrent "make this the primary" requests must not both
  // succeed.
  await sql`
    create unique index storefront_marketplace_categories_primary_unique
      on storefront_marketplace_categories (storefront_id) where is_primary
  `.execute(database);
  await sql`
    create index storefront_marketplace_categories_category_idx
      on storefront_marketplace_categories (marketplace_category_id)
  `.execute(database);

  // ------------------------------------------------ Product classification

  await sql`
    alter table trader_storefront_products
      add column marketplace_category_id uuid
        references marketplace_categories(id) on delete restrict,
      add column marketplace_subcategory_id uuid
  `.execute(database);

  // The composite key described in the header. A Subcategory may only be named
  // together with ITS OWN parent Category.
  await sql`
    alter table trader_storefront_products
      add constraint trader_storefront_products_marketplace_subcategory_fk
      foreign key (marketplace_subcategory_id, marketplace_category_id)
      references marketplace_subcategories (id, marketplace_category_id)
      on delete restrict
  `.execute(database);

  // A Subcategory without a Category would be a classification that cannot be
  // navigated to, and the composite FK above cannot catch it (MATCH SIMPLE
  // skips when any column is NULL).
  await sql`
    alter table trader_storefront_products
      add constraint trader_storefront_products_marketplace_shape_check check (
        marketplace_subcategory_id is null or marketplace_category_id is not null
      )
  `.execute(database);

  await sql`
    create index trader_storefront_products_marketplace_idx
      on trader_storefront_products (marketplace_category_id, marketplace_subcategory_id)
      where marketplace_category_id is not null
  `.execute(database);

  // ------------------------------------------------------------ assertions

  // Existing Products are left unclassified on purpose: nothing in the current
  // data reliably maps a Trader's own shelf label onto a Platform vocabulary,
  // and a guessed classification is indistinguishable from a curated one once
  // written.
  await sql`
    do $$
    declare
      misclassified bigint;
    begin
      select count(*) into misclassified from trader_storefront_products
        where marketplace_category_id is not null or marketplace_subcategory_id is not null;
      if misclassified <> 0 then
        raise exception 'Marketplace taxonomy: % Product(s) were classified by the migration itself', misclassified;
      end if;
    end
    $$
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop index if exists trader_storefront_products_marketplace_idx`.execute(database);
  await sql`
    alter table trader_storefront_products
      drop constraint if exists trader_storefront_products_marketplace_shape_check,
      drop constraint if exists trader_storefront_products_marketplace_subcategory_fk
  `.execute(database);
  await sql`
    alter table trader_storefront_products
      drop column if exists marketplace_subcategory_id,
      drop column if exists marketplace_category_id
  `.execute(database);
  await sql`drop table if exists storefront_marketplace_categories`.execute(database);
  await sql`drop table if exists marketplace_subcategories`.execute(database);
  await sql`drop table if exists marketplace_categories`.execute(database);
}
