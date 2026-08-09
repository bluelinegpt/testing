import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Trader Storefront Product Catalogue — foundation.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP IS CARRIED, NOT INFERRED
 * ---------------------------------------------------------------------------
 *
 * Every row here carries company_id and storefront_id, and every child table
 * references its parent through a COMPOSITE key that includes the Company. A
 * Product cannot end up under a Storefront in another Company, and media,
 * option groups and option values cannot end up under a Product in another
 * Storefront, because the row will not insert. Ownership is a schema property,
 * not something a service remembers to check.
 *
 * The alternative -- a single-column foreign key plus a WHERE clause in every
 * query -- fails the first time someone writes a query without that clause.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SLUG AND CODE ARE SCOPED, NOT GLOBAL
 * ---------------------------------------------------------------------------
 *
 * A Product's public address is /store/<storefront-slug>/products/<product-slug>.
 * The Storefront slug is already globally unique, so the Product slug only has
 * to be unique WITHIN one Storefront. Two Traders may both sell an
 * "embroidered-abaya" without colliding, and neither can reach the other's URL.
 * Product code follows the same scope for the same reason.
 *
 * Both are enforced case-insensitively by a unique index on the lowercased
 * value, so "ABAYA-0001" and "abaya-0001" are one code and not two.
 *
 * ---------------------------------------------------------------------------
 * MEDIA LIMITS THAT A CONSTRAINT CAN HOLD, AND ONES IT CANNOT
 * ---------------------------------------------------------------------------
 *
 * "At most one primary image" and "at most one active video" are expressible as
 * partial unique indexes, so they live here and no concurrent pair of requests
 * can produce two. "At most eight images" is a COUNT, which a unique index
 * cannot express; it is enforced transactionally in the service against locked
 * rows. That split is deliberate and stated so the next reader does not assume
 * the eight-image rule is structural.
 *
 * ---------------------------------------------------------------------------
 * PRODUCTS ARE DEACTIVATED, NEVER DELETED
 * ---------------------------------------------------------------------------
 *
 * No Sales Order exists yet, but one will, and it will reference a Product.
 * `archived` is the terminal state; nothing here offers a delete path, and the
 * lifecycle CHECK has no state that means "gone". A catalogue that could erase
 * a Product would eventually erase one an order depends on.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  // The composite target every Product-side foreign key needs. `id` is already
  // the primary key, so this adds no uniqueness -- it makes the (Company,
  // Storefront) pair referenceable.
  await sql`
    create unique index if not exists trader_storefronts_company_identity_key
      on trader_storefronts (company_id, id)
  `.execute(database);

  // ------------------------------------------------------------- categories

  await sql`
    create table trader_storefront_categories (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      storefront_id uuid not null,

      name_en text not null,
      name_ar text,
      slug text not null,
      description text,
      display_order integer not null default 0,
      is_active boolean not null default true,
      image_file_id uuid references file_objects(id) on delete set null,

      created_by_account_id uuid,
      updated_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,

      constraint trader_storefront_categories_storefront_fk
        foreign key (company_id, storefront_id)
        references trader_storefronts (company_id, id) on delete restrict,
      constraint trader_storefront_categories_name_check check (
        length(btrim(name_en)) > 0
      ),
      constraint trader_storefront_categories_slug_shape_check check (
        slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 2 and 63
      ),
      constraint trader_storefront_categories_order_check check (display_order >= 0)
    )
  `.execute(database);

  await sql`
    create unique index trader_storefront_categories_slug_unique
      on trader_storefront_categories (storefront_id, lower(slug))
  `.execute(database);
  await sql`
    create index trader_storefront_categories_storefront_idx
      on trader_storefront_categories (storefront_id, display_order)
  `.execute(database);
  // Referenceable by a Product's composite category foreign key.
  await sql`
    create unique index trader_storefront_categories_scope_key
      on trader_storefront_categories (company_id, storefront_id, id)
  `.execute(database);

  // --------------------------------------------------------------- products

  await sql`
    create table trader_storefront_products (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      storefront_id uuid not null,
      -- Denormalised from the Storefront so a Product carries its Trader
      -- without a join. Frozen at insert by a trigger, exactly like the
      -- Storefront's own ownership columns.
      trader_id uuid not null,
      category_id uuid,

      name text not null,
      slug text not null,
      product_code text not null,
      short_description text,
      full_description text,

      -- AED throughout the current BluelineGPT scope. Stored as numeric, never
      -- floating point: money that rounds differently in two places is money
      -- that disagrees with itself.
      currency text not null default 'AED',
      selling_price numeric(12, 2) not null,
      previous_price numeric(12, 2),

      lifecycle_status text not null default 'draft',
      availability_status text not null default 'available',

      minimum_quantity integer,
      maximum_quantity integer,
      display_order integer not null default 0,

      -- Template-specific facts, validated server-side against an allow-list
      -- keyed by the Storefront's business template. Never free-form: the
      -- service rejects unknown keys rather than storing them.
      template_attributes jsonb not null default '{}'::jsonb,

      created_by_account_id uuid,
      updated_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      archived_at timestamptz,
      version bigint not null default 1,

      constraint trader_storefront_products_storefront_fk
        foreign key (company_id, storefront_id)
        references trader_storefronts (company_id, id) on delete restrict,
      -- A Product's category must belong to the SAME Company and Storefront.
      constraint trader_storefront_products_category_fk
        foreign key (company_id, storefront_id, category_id)
        references trader_storefront_categories (company_id, storefront_id, id)
        on delete restrict,

      constraint trader_storefront_products_name_check check (
        length(btrim(name)) > 0
      ),
      constraint trader_storefront_products_slug_shape_check check (
        slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 2 and 96
      ),
      constraint trader_storefront_products_code_shape_check check (
        product_code ~ '^[A-Za-z0-9][A-Za-z0-9_/-]*$' and length(product_code) between 1 and 48
      ),
      constraint trader_storefront_products_currency_check check (currency = 'AED'),
      -- MVP rule: a zero-price Product is not sellable and inquiry-only is out
      -- of scope, so zero is refused rather than silently displayed as free.
      constraint trader_storefront_products_price_check check (selling_price > 0),
      -- A comparison price that is not higher is not a discount.
      constraint trader_storefront_products_previous_price_check check (
        previous_price is null or previous_price > selling_price
      ),
      constraint trader_storefront_products_lifecycle_check check (
        lifecycle_status in ('draft', 'active', 'inactive', 'archived')
      ),
      constraint trader_storefront_products_availability_check check (
        availability_status in ('available', 'unavailable')
      ),
      constraint trader_storefront_products_quantity_check check (
        (minimum_quantity is null or minimum_quantity >= 1)
        and (maximum_quantity is null or maximum_quantity >= 1)
        and (minimum_quantity is null or maximum_quantity is null
             or maximum_quantity >= minimum_quantity)
      ),
      constraint trader_storefront_products_order_check check (display_order >= 0),
      constraint trader_storefront_products_attributes_shape_check check (
        jsonb_typeof(template_attributes) = 'object'
      ),
      -- An archived Product records when it was archived, and only an archived
      -- one may carry that timestamp.
      constraint trader_storefront_products_archived_shape_check check (
        (lifecycle_status = 'archived') = (archived_at is not null)
      ),
      -- An active Product must have a category: public listing groups by it,
      -- and an uncategorised live Product would be unreachable by browsing.
      constraint trader_storefront_products_active_category_check check (
        lifecycle_status <> 'active' or category_id is not null
      )
    )
  `.execute(database);

  await sql`
    create unique index trader_storefront_products_slug_unique
      on trader_storefront_products (storefront_id, lower(slug))
  `.execute(database);
  await sql`
    create unique index trader_storefront_products_code_unique
      on trader_storefront_products (storefront_id, lower(product_code))
  `.execute(database);
  await sql`
    create index trader_storefront_products_listing_idx
      on trader_storefront_products (storefront_id, lifecycle_status, display_order)
  `.execute(database);
  await sql`
    create index trader_storefront_products_category_idx
      on trader_storefront_products (category_id)
  `.execute(database);
  await sql`
    create unique index trader_storefront_products_scope_key
      on trader_storefront_products (company_id, storefront_id, id)
  `.execute(database);

  // ------------------------------------------------------------------ media

  await sql`
    create table trader_storefront_product_media (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      storefront_id uuid not null,
      product_id uuid not null,

      media_type text not null,
      -- An internal reference is preferred; a validated safe URL is accepted
      -- while no upload pipeline exists. Exactly one of the two is present, so
      -- a row can never be both and never be neither.
      file_id uuid references file_objects(id) on delete restrict,
      media_url text,
      poster_file_id uuid references file_objects(id) on delete restrict,
      poster_url text,

      alt_text text,
      display_order integer not null default 0,
      is_primary boolean not null default false,
      is_active boolean not null default true,

      created_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),

      constraint trader_storefront_product_media_product_fk
        foreign key (company_id, storefront_id, product_id)
        references trader_storefront_products (company_id, storefront_id, id)
        on delete restrict,
      constraint trader_storefront_product_media_type_check check (
        media_type in ('image', 'video')
      ),
      constraint trader_storefront_product_media_source_check check (
        (file_id is null) <> (media_url is null)
      ),
      -- Only a video carries a poster, and only an image can be primary.
      constraint trader_storefront_product_media_poster_check check (
        media_type = 'video' or (poster_file_id is null and poster_url is null)
      ),
      constraint trader_storefront_product_media_primary_check check (
        media_type = 'image' or is_primary = false
      ),
      constraint trader_storefront_product_media_order_check check (display_order >= 0),
      -- Rendered in an <img>/<video> src. Only https and the storage-relative
      -- form are permitted, so no javascript:, data:, blob: or file: value can
      -- ever be stored -- the service refuses them too, and this is the floor.
      constraint trader_storefront_product_media_url_check check (
        media_url is null or media_url ~ '^(https://|/)[^[:space:]<>"]+$'
      ),
      constraint trader_storefront_product_media_poster_url_check check (
        poster_url is null or poster_url ~ '^(https://|/)[^[:space:]<>"]+$'
      )
    )
  `.execute(database);

  // At most ONE primary image per Product, decided by the database so two
  // concurrent "make this primary" requests cannot both win.
  await sql`
    create unique index trader_storefront_product_media_primary_unique
      on trader_storefront_product_media (product_id)
      where is_primary and is_active
  `.execute(database);
  // At most ONE active video per Product, for the same reason.
  await sql`
    create unique index trader_storefront_product_media_video_unique
      on trader_storefront_product_media (product_id)
      where media_type = 'video' and is_active
  `.execute(database);
  await sql`
    create index trader_storefront_product_media_product_idx
      on trader_storefront_product_media (product_id, display_order)
  `.execute(database);

  // ---------------------------------------------------------------- options

  await sql`
    create table trader_storefront_product_option_groups (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      storefront_id uuid not null,
      product_id uuid not null,

      name text not null,
      display_order integer not null default 0,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),

      constraint trader_storefront_product_option_groups_product_fk
        foreign key (company_id, storefront_id, product_id)
        references trader_storefront_products (company_id, storefront_id, id)
        on delete restrict,
      constraint trader_storefront_product_option_groups_name_check check (
        length(btrim(name)) > 0
      ),
      constraint trader_storefront_product_option_groups_order_check check (
        display_order >= 0
      )
    )
  `.execute(database);

  await sql`
    create unique index trader_storefront_product_option_groups_name_unique
      on trader_storefront_product_option_groups (product_id, lower(name))
  `.execute(database);
  await sql`
    create unique index trader_storefront_product_option_groups_scope_key
      on trader_storefront_product_option_groups (company_id, storefront_id, id)
  `.execute(database);

  await sql`
    create table trader_storefront_product_option_values (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      storefront_id uuid not null,
      option_group_id uuid not null,

      value text not null,
      display_order integer not null default 0,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),

      constraint trader_storefront_product_option_values_group_fk
        foreign key (company_id, storefront_id, option_group_id)
        references trader_storefront_product_option_groups (company_id, storefront_id, id)
        on delete restrict,
      constraint trader_storefront_product_option_values_value_check check (
        length(btrim(value)) > 0
      ),
      constraint trader_storefront_product_option_values_order_check check (
        display_order >= 0
      )
    )
  `.execute(database);

  await sql`
    create unique index trader_storefront_product_option_values_unique
      on trader_storefront_product_option_values (option_group_id, lower(value))
  `.execute(database);

  // --------------------------------------------------------------- triggers

  // Ownership is frozen at insert: a Product moving between Storefronts,
  // Traders or Companies would silently transfer a public address and every
  // media, option and future order row hanging off it.
  await sql`
    create or replace function trader_storefront_products_freeze_ownership()
    returns trigger language plpgsql as $$
    begin
      if new.company_id <> old.company_id
         or new.storefront_id <> old.storefront_id
         or new.trader_id <> old.trader_id then
        raise exception 'Product ownership cannot be changed'
          using errcode = 'restrict_violation';
      end if;
      return new;
    end;
    $$
  `.execute(database);
  await sql`
    create trigger trader_storefront_products_ownership_frozen
      before update on trader_storefront_products
      for each row execute function trader_storefront_products_freeze_ownership()
  `.execute(database);

  // An archived Product is history. Only administrative metadata may move.
  await sql`
    create or replace function trader_storefront_products_archive_guard()
    returns trigger language plpgsql as $$
    begin
      if old.lifecycle_status = 'archived' and new.lifecycle_status = 'archived' then
        if new.name is distinct from old.name
           or new.slug is distinct from old.slug
           or new.product_code is distinct from old.product_code
           or new.selling_price is distinct from old.selling_price
           or new.previous_price is distinct from old.previous_price
           or new.category_id is distinct from old.category_id
           or new.template_attributes is distinct from old.template_attributes then
          raise exception 'An archived Product cannot be edited'
            using errcode = 'restrict_violation';
        end if;
      end if;
      return new;
    end;
    $$
  `.execute(database);
  await sql`
    create trigger trader_storefront_products_archived_readonly
      before update on trader_storefront_products
      for each row execute function trader_storefront_products_archive_guard()
  `.execute(database);

  await sql`
    insert into permissions (code, description) values
      ('storefront_products.view', 'View Trader Storefront Products and categories'),
      ('storefront_products.manage', 'Create and edit Trader Storefront Products, media and options'),
      ('storefront_products.publish', 'Activate, deactivate and archive Trader Storefront Products')
    on conflict (code) do nothing
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`delete from permissions where code in (
    'storefront_products.view', 'storefront_products.manage', 'storefront_products.publish'
  )`.execute(database);
  await sql`drop trigger if exists trader_storefront_products_archived_readonly
    on trader_storefront_products`.execute(database);
  await sql`drop function if exists trader_storefront_products_archive_guard()`.execute(database);
  await sql`drop trigger if exists trader_storefront_products_ownership_frozen
    on trader_storefront_products`.execute(database);
  await sql`drop function if exists trader_storefront_products_freeze_ownership()`.execute(
    database,
  );
  await sql`drop table if exists trader_storefront_product_option_values`.execute(database);
  await sql`drop table if exists trader_storefront_product_option_groups`.execute(database);
  await sql`drop table if exists trader_storefront_product_media`.execute(database);
  await sql`drop table if exists trader_storefront_products`.execute(database);
  await sql`drop table if exists trader_storefront_categories`.execute(database);
  await sql`drop index if exists trader_storefronts_company_identity_key`.execute(database);
}
