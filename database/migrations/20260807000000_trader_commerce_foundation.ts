import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Trader Commerce identity foundation — ADDITIVE ONLY.
 *
 * ---------------------------------------------------------------------------
 * WHY A TRADER NEEDS AN IDENTITY THAT IS NOT A DELIVERY COMPANY'S ROW
 * ---------------------------------------------------------------------------
 *
 * Today a Trader exists only INSIDE a Delivery Company: `traders.company_id` is
 * NOT NULL, the Trader code is Company-scoped, and a Storefront reaches its
 * Trader through the composite key `(company_id, trader_id)`. That models the
 * delivery relationship correctly and models the business incorrectly. The shop
 * is the same shop whether it ships with one Delivery Company, three, or none;
 * only the delivery arrangement changes.
 *
 * `trader_commerce_profiles` is that shop. It has no `company_id`. Everything
 * about which Delivery Companies serve it lives in
 * `trader_delivery_company_relationships`, which is a many-row relationship and
 * is allowed to be empty.
 *
 * ---------------------------------------------------------------------------
 * THIS MIGRATION DELIBERATELY LEAVES THE OLD OWNERSHIP IN PLACE
 * ---------------------------------------------------------------------------
 *
 * At the end of this migration a Storefront carries BOTH:
 *
 *     trader_commerce_id NOT NULL   -- the new, intended owner
 *     company_id         NOT NULL   -- the old, still-enforced owner
 *     trader_id          NOT NULL
 *
 * and the composite FK to `traders (company_id, id)` still exists. That dual
 * state is the point, not an oversight. Making the new column mandatory proves
 * the backfill is total and the new ownership chain is real; keeping the old
 * constraint means nothing that reads Storefronts today can break. Removing the
 * Company dependency is a separate, reversible-in-isolation step (0B-1), and
 * doing it in the same migration as the backfill would mean a failure there
 * takes the identity work down with it.
 *
 * ---------------------------------------------------------------------------
 * NO TRADER IS MERGED WITH ANY OTHER TRADER
 * ---------------------------------------------------------------------------
 *
 * The backfill rule is exactly one Commerce identity per existing
 * Storefront-owning Company Trader. It is tempting to treat two Traders with
 * the same mobile number in two Companies as one shop -- that is very likely
 * what they are -- but nothing available here can PROVE it: Trader code is
 * Company-scoped, mobile and email are not unique, and trade licence is mostly
 * absent. A wrong merge silently joins two businesses' catalogues and, later,
 * their money. Splitting them again afterwards is not a migration, it is an
 * investigation. So this migration never merges; an explicit, approved,
 * human-reviewed linking operation will.
 *
 * ---------------------------------------------------------------------------
 * THE BACKFILL VALIDATES ITSELF BEFORE IT TIGHTENS ANYTHING
 * ---------------------------------------------------------------------------
 *
 * The `NOT NULL` and the foreign key at the end of this file run only after an
 * assertion block has confirmed every Storefront resolved, every Trader has
 * exactly one link, and no duplicate identity was created. The whole migration
 * is one transaction, so a failed assertion leaves the database exactly as it
 * was rather than half-converted.
 *
 * Re-running is safe: identity creation is guarded by `not exists` against the
 * link table, whose `unique (trader_id)` makes "this Trader already has an
 * identity" a structural fact rather than a hope.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  // ------------------------------------------------------- commerce identity

  // The Trader's business identity. No company_id, by design: this row must
  // survive a Trader leaving every Delivery Company it currently works with.
  //
  // Almost every column is nullable. The registration form that will populate
  // legal name, trade licence, expected order volume and COD range does not
  // exist yet, and the existing Traders being backfilled genuinely do not have
  // those values. Requiring them now would mean inventing them, and invented
  // business data is indistinguishable from real business data once written.
  await sql`
    create table trader_commerce_profiles (
      id uuid primary key default gen_random_uuid(),

      public_name text not null,
      legal_name text,
      contact_name text,

      mobile_number text,
      telephone text,
      whatsapp_number text,
      email text,

      trade_license_number text,
      business_description text,
      emirate text,
      address text,

      estimated_product_count integer,
      expected_orders_per_day integer,
      expected_orders_per_month integer,
      typical_cod_min numeric(12, 2),
      typical_cod_max numeric(12, 2),
      current_delivery_rate numeric(12, 2),

      instagram_url text,
      tiktok_url text,
      facebook_url text,
      website_url text,

      registration_source text not null,
      approval_status text not null default 'pending',
      is_active boolean not null default true,

      created_by_account_id uuid,
      updated_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,

      constraint trader_commerce_profiles_public_name_check check (
        length(btrim(public_name)) > 0
      ),
      constraint trader_commerce_profiles_source_check check (
        registration_source in (
          'delivery_company_registered',
          'trader_self_registered',
          'platform_registered'
        )
      ),
      constraint trader_commerce_profiles_approval_check check (
        approval_status in ('pending', 'approved', 'rejected', 'suspended')
      ),
      -- Volume and money figures are self-reported estimates, but a negative
      -- one is not a low estimate, it is a broken write.
      constraint trader_commerce_profiles_counts_check check (
        (estimated_product_count is null or estimated_product_count >= 0)
        and (expected_orders_per_day is null or expected_orders_per_day >= 0)
        and (expected_orders_per_month is null or expected_orders_per_month >= 0)
      ),
      constraint trader_commerce_profiles_cod_check check (
        (typical_cod_min is null or typical_cod_min >= 0)
        and (typical_cod_max is null or typical_cod_max >= 0)
        and (
          typical_cod_min is null
          or typical_cod_max is null
          or typical_cod_max >= typical_cod_min
        )
      ),
      constraint trader_commerce_profiles_rate_check check (
        current_delivery_rate is null or current_delivery_rate >= 0
      )
    )
  `.execute(database);

  await sql`
    create index trader_commerce_profiles_approval_idx
      on trader_commerce_profiles (approval_status)
  `.execute(database);

  // --------------------------------------------- commerce <-> Company Trader

  // The bridge between the new identity and the existing Company-scoped Trader
  // row. It exists so that nothing has to GUESS the correspondence later: every
  // Trader that gained an identity in this migration says so explicitly, with
  // the source of the claim recorded.
  //
  // `unique (trader_id)` is the whole safety story for re-runs. The preflight
  // established that `trader_id` is globally unique across Storefronts, so one
  // existing Trader mapping to two identities is meaningless -- and, with this
  // constraint, impossible rather than merely unintended.
  await sql`
    create table trader_commerce_company_links (
      id uuid primary key default gen_random_uuid(),
      trader_commerce_id uuid not null references trader_commerce_profiles(id) on delete restrict,
      company_id uuid not null references companies(id) on delete restrict,
      trader_id uuid not null,

      link_source text not null,
      status text not null default 'active',
      linked_at timestamptz not null default now(),

      created_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),

      -- The referenced Trader must belong to the referenced Company. Stated
      -- structurally for the same reason the Storefront states it structurally:
      -- a service that forgets the check writes a row that outlives the bug.
      constraint trader_commerce_company_links_company_trader_fk
        foreign key (company_id, trader_id)
        references traders (company_id, id) on delete restrict,

      -- One existing Company Trader belongs to exactly one Commerce identity.
      constraint trader_commerce_company_links_trader_unique unique (trader_id),
      -- Redundant given the line above, but it is the invariant the reader
      -- actually cares about, and it survives any future relaxation of the
      -- global uniqueness above.
      constraint trader_commerce_company_links_scope_unique
        unique (company_id, trader_id),

      constraint trader_commerce_company_links_source_check check (
        link_source in ('migration_backfill', 'delivery_company_registered', 'manual_link')
      ),
      constraint trader_commerce_company_links_status_check check (
        status in ('active', 'inactive')
      )
    )
  `.execute(database);

  await sql`
    create index trader_commerce_company_links_commerce_idx
      on trader_commerce_company_links (trader_commerce_id)
  `.execute(database);
  await sql`
    create index trader_commerce_company_links_company_idx
      on trader_commerce_company_links (company_id)
  `.execute(database);

  // ------------------------------------- commerce <-> Delivery Company

  // Which Delivery Companies serve this shop. A Trader Commerce identity with
  // ZERO rows here is valid and intentional: a shop between delivery contracts
  // still exists, still has a catalogue, and still has a public address.
  //
  // (The Storefront's own `company_id` still prevents a genuinely zero-Company
  // Storefront today. That constraint is removed in 0B-1; this table is shaped
  // now so that removal is the only change needed then.)
  await sql`
    create table trader_delivery_company_relationships (
      id uuid primary key default gen_random_uuid(),
      trader_commerce_id uuid not null references trader_commerce_profiles(id) on delete restrict,
      company_id uuid not null references companies(id) on delete restrict,
      -- Present when the relationship corresponds to an existing Company Trader
      -- row. Nullable because a future relationship may be agreed before the
      -- Delivery Company has created its own Trader record.
      trader_id uuid,

      relationship_source text not null,
      status text not null default 'active',
      enabled_for_store_orders boolean not null default true,
      is_default_for_store_orders boolean not null default false,

      effective_from timestamptz not null default now(),
      effective_to timestamptz,

      created_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,

      constraint trader_delivery_company_relationships_company_trader_fk
        foreign key (company_id, trader_id)
        references traders (company_id, id) on delete restrict,

      -- One relationship row per (shop, Delivery Company). History of past
      -- arrangements is carried by status and the effective window, not by
      -- accumulating duplicate live rows that a reader would have to rank.
      constraint trader_delivery_company_relationships_unique
        unique (trader_commerce_id, company_id),

      constraint trader_delivery_company_relationships_source_check check (
        relationship_source in (
          'delivery_company_registered',
          'trader_requested',
          'platform_assigned'
        )
      ),
      constraint trader_delivery_company_relationships_status_check check (
        status in ('active', 'inactive', 'suspended', 'terminated')
      ),
      constraint trader_delivery_company_relationships_window_check check (
        effective_to is null or effective_to >= effective_from
      ),
      -- A default the Store cannot actually route to is a trap: it reads as
      -- configured and behaves as unconfigured.
      constraint trader_delivery_company_relationships_default_check check (
        is_default_for_store_orders = false or enabled_for_store_orders = true
      )
    )
  `.execute(database);

  // At most one enabled default per shop. A partial unique index rather than a
  // service rule, because "set this one as default" and "set that one as
  // default" arriving together must not both succeed.
  await sql`
    create unique index trader_delivery_company_relationships_default_unique
      on trader_delivery_company_relationships (trader_commerce_id)
      where is_default_for_store_orders and enabled_for_store_orders
  `.execute(database);
  await sql`
    create index trader_delivery_company_relationships_company_idx
      on trader_delivery_company_relationships (company_id, status)
  `.execute(database);
  await sql`
    create index trader_delivery_company_relationships_commerce_idx
      on trader_delivery_company_relationships (trader_commerce_id)
  `.execute(database);

  // ---------------------------------------------- Storefront commerce owner

  // Nullable first. The column has to exist before it can be filled, and it
  // cannot be mandatory before the fill is proven total.
  await sql`
    alter table trader_storefronts add column trader_commerce_id uuid
  `.execute(database);
  await sql`
    create index trader_storefronts_commerce_idx
      on trader_storefronts (trader_commerce_id)
  `.execute(database);

  // ------------------------------------------------------------- backfill

  // One identity, one link and one delivery relationship per existing
  // Storefront-owning Company Trader, created in a single statement so the
  // three rows cannot diverge. The UUID is generated in the source CTE
  // precisely so all three inserts can reference the same value.
  //
  // `not exists (link)` is the idempotency guard: on a re-run the source set is
  // empty and this statement writes nothing.
  await sql`
    with source as (
      select
        gen_random_uuid() as commerce_id,
        trader.id as trader_id,
        trader.company_id as company_id,
        trader.name_en as public_name,
        nullif(btrim(coalesce(trader.contact_person, '')), '') as contact_name,
        nullif(btrim(coalesce(trader.mobile_number, '')), '') as mobile_number,
        nullif(btrim(coalesce(trader.telephone, '')), '') as telephone,
        nullif(btrim(coalesce(trader.email, '')), '') as email,
        nullif(btrim(coalesce(trader.address_en, '')), '') as address
      from trader_storefronts storefront
      join traders trader on trader.id = storefront.trader_id
      where not exists (
        select 1 from trader_commerce_company_links link
        where link.trader_id = trader.id
      )
    ),
    created_profile as (
      insert into trader_commerce_profiles (
        id, public_name, contact_name, mobile_number, telephone, email, address,
        registration_source, approval_status, is_active
      )
      select
        source.commerce_id, source.public_name, source.contact_name,
        source.mobile_number, source.telephone, source.email, source.address,
        'delivery_company_registered', 'approved', true
      from source
      returning id
    ),
    created_link as (
      insert into trader_commerce_company_links (
        trader_commerce_id, company_id, trader_id, link_source, status
      )
      select source.commerce_id, source.company_id, source.trader_id,
             'migration_backfill', 'active'
      from source
      returning id
    )
    insert into trader_delivery_company_relationships (
      trader_commerce_id, company_id, trader_id, relationship_source, status,
      enabled_for_store_orders, is_default_for_store_orders
    )
    select source.commerce_id, source.company_id, source.trader_id,
           'delivery_company_registered', 'active', true, true
    from source
  `.execute(database);

  // Resolve each Storefront through the link table rather than through the
  // statement above, so a partially-applied earlier run (identities created,
  // Storefront not yet stamped) is repaired rather than duplicated.
  //
  // This UPDATE touches only `trader_commerce_id`; the ownership-freeze trigger
  // on this table fires on any UPDATE but raises only when company_id or
  // trader_id change, which they do not here.
  await sql`
    update trader_storefronts storefront
    set trader_commerce_id = link.trader_commerce_id
    from trader_commerce_company_links link
    where link.trader_id = storefront.trader_id
      and storefront.trader_commerce_id is null
  `.execute(database);

  // -------------------------------------------------------- hard gate

  // Everything below this point tightens the schema. None of it runs unless the
  // backfill is provably complete and internally consistent. The migration is
  // one transaction, so a raise here restores the pre-migration state exactly.
  await sql`
    do $$
    declare
      unresolved bigint;
      dangling bigint;
      unlinked bigint;
      duplicate_identities bigint;
      orphan_identities bigint;
      missing_relationships bigint;
    begin
      select count(*) into unresolved
        from trader_storefronts where trader_commerce_id is null;
      if unresolved <> 0 then
        raise exception 'Trader Commerce backfill incomplete: % Storefront(s) have no trader_commerce_id', unresolved;
      end if;

      select count(*) into dangling
        from trader_storefronts storefront
        where not exists (
          select 1 from trader_commerce_profiles profile
          where profile.id = storefront.trader_commerce_id
        );
      if dangling <> 0 then
        raise exception 'Trader Commerce backfill invalid: % Storefront(s) reference a missing Commerce profile', dangling;
      end if;

      select count(*) into unlinked
        from trader_storefronts storefront
        where not exists (
          select 1 from trader_commerce_company_links link
          where link.trader_id = storefront.trader_id
            and link.company_id = storefront.company_id
            and link.trader_commerce_id = storefront.trader_commerce_id
        );
      if unlinked <> 0 then
        raise exception 'Trader Commerce backfill invalid: % Storefront-owning Trader(s) lack a matching Company link', unlinked;
      end if;

      select count(*) into duplicate_identities
        from (
          select trader_id from trader_commerce_company_links
          group by trader_id having count(distinct trader_commerce_id) > 1
        ) as offenders;
      if duplicate_identities <> 0 then
        raise exception 'Trader Commerce backfill invalid: % Trader(s) map to more than one Commerce identity', duplicate_identities;
      end if;

      -- Every identity created here must be reachable from a Trader. An
      -- identity with no link is the signature of a duplicate insert.
      select count(*) into orphan_identities
        from trader_commerce_profiles profile
        where not exists (
          select 1 from trader_commerce_company_links link
          where link.trader_commerce_id = profile.id
        );
      if orphan_identities <> 0 then
        raise exception 'Trader Commerce backfill invalid: % unexpected Commerce identity/identities have no Company link', orphan_identities;
      end if;

      select count(*) into missing_relationships
        from trader_storefronts storefront
        where not exists (
          select 1 from trader_delivery_company_relationships relationship
          where relationship.trader_commerce_id = storefront.trader_commerce_id
            and relationship.company_id = storefront.company_id
            and relationship.status = 'active'
            and relationship.enabled_for_store_orders
        );
      if missing_relationships <> 0 then
        raise exception 'Trader Commerce backfill invalid: % Storefront(s) lack an active Delivery Company relationship', missing_relationships;
      end if;
    end
    $$
  `.execute(database);

  // ------------------------------------------------- make ownership real

  await sql`
    alter table trader_storefronts
      add constraint trader_storefronts_commerce_fk
      foreign key (trader_commerce_id)
      references trader_commerce_profiles (id) on delete restrict
  `.execute(database);
  await sql`
    alter table trader_storefronts alter column trader_commerce_id set not null
  `.execute(database);

  // Referenceable as a composite target, so 0B-1 can rebind Categories and
  // Products onto (trader_commerce_id, id) the same way they are bound to
  // (company_id, id) today.
  await sql`
    create unique index trader_storefronts_commerce_identity_key
      on trader_storefronts (trader_commerce_id, id)
  `.execute(database);

  // ------------------------------------------- Product SKU / barcode / brand

  // Additive and optional. `product_code` remains what it is -- the Trader's
  // own catalogue reference, required and Storefront-unique. SKU and barcode
  // are inventory identifiers that a Trader may or may not operate.
  await sql`
    alter table trader_storefront_products
      add column sku text,
      add column barcode text,
      add column brand text
  `.execute(database);

  // Both identifiers are STRINGS and stay strings. A barcode such as
  // '0012345678905' is not the number 12345678905; the leading zero is part of
  // the code. No constraint here coerces, pads or reformats -- length and
  // non-emptiness only. EAN/UPC checksum validation is deliberately absent:
  // real catalogues contain internal codes that are not valid EANs.
  await sql`
    alter table trader_storefront_products
      add constraint trader_storefront_products_sku_check check (
        sku is null or (length(btrim(sku)) > 0 and length(sku) <= 64)
      ),
      add constraint trader_storefront_products_barcode_check check (
        barcode is null or (length(btrim(barcode)) > 0 and length(barcode) <= 64)
      ),
      add constraint trader_storefront_products_brand_check check (
        brand is null or (length(btrim(brand)) > 0 and length(brand) <= 120)
      )
  `.execute(database);

  // SKU identifies one Product within one Storefront when it is used at all.
  // Case-insensitive, because 'ABA-01' and 'aba-01' are one SKU in every
  // stockroom that has ever existed. Partial, because "no SKU" is not a
  // collision -- many Products may legitimately have none.
  //
  // Barcode is intentionally NOT unique: the same manufacturer barcode across
  // two Storefronts is normal, and even within one Storefront a Trader may
  // legitimately list variants sharing a code.
  await sql`
    create unique index trader_storefront_products_sku_unique
      on trader_storefront_products (storefront_id, lower(sku))
      where sku is not null
  `.execute(database);
  await sql`
    create index trader_storefront_products_barcode_idx
      on trader_storefront_products (storefront_id, barcode)
      where barcode is not null
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop index if exists trader_storefront_products_barcode_idx`.execute(database);
  await sql`drop index if exists trader_storefront_products_sku_unique`.execute(database);
  await sql`
    alter table trader_storefront_products
      drop constraint if exists trader_storefront_products_brand_check,
      drop constraint if exists trader_storefront_products_barcode_check,
      drop constraint if exists trader_storefront_products_sku_check
  `.execute(database);
  await sql`
    alter table trader_storefront_products
      drop column if exists brand,
      drop column if exists barcode,
      drop column if exists sku
  `.execute(database);

  await sql`drop index if exists trader_storefronts_commerce_identity_key`.execute(database);
  await sql`
    alter table trader_storefronts
      drop constraint if exists trader_storefronts_commerce_fk
  `.execute(database);
  await sql`drop index if exists trader_storefronts_commerce_idx`.execute(database);
  await sql`
    alter table trader_storefronts drop column if exists trader_commerce_id
  `.execute(database);

  await sql`drop table if exists trader_delivery_company_relationships`.execute(database);
  await sql`drop table if exists trader_commerce_company_links`.execute(database);
  await sql`drop table if exists trader_commerce_profiles`.execute(database);
}
