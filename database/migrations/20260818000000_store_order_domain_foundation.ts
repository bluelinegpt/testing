import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Shared Commerce Foundation Prompt 3B: the Store Order domain foundation.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A NEW TABLE, NOT AN EXTENSION OF THE DELIVERY orders TABLE
 * ---------------------------------------------------------------------------
 *
 * A Store Order is not automatically a Delivery Order. It may have zero
 * Delivery Companies (awaiting Trader confirmation or fulfilled externally),
 * one, or -- later -- convert into exactly one. `orders` is Company-scoped
 * throughout (`company_id NOT NULL`, `unique(company_id, order_number)`,
 * FKs to `traders`/`areas`/`drivers` all composite on `company_id`) and its
 * every downstream system -- Driver Cash Reconciliation, Trader
 * Settlements, Accounting -- assumes that scoping. Reusing it as the Store
 * Order record would mean either inventing a fake Company for a shop with
 * none, or rewriting that entire scoping model. Neither is acceptable, so
 * `store_orders`/`store_order_items` are new, additive tables owned by the
 * Trader Commerce identity (`trader_commerce_id`), not a Company --
 * mirroring the same Company-less ownership shape `trader_storefronts` and
 * `trader_storefront_products` already established (0B-1/0B-2).
 *
 * `store_orders.delivery_order_id` is the ONLY point of contact with the
 * Delivery domain, and it is a bridge reference only -- 3B does not create
 * or populate it (§39). Nothing here writes to `orders`, `reconciliations`,
 * `trader_receivables`, settlements, Accounting Events, or Journals.
 *
 * ---------------------------------------------------------------------------
 * WHY A NEW, GLOBAL Store Order NUMBER COUNTER
 * ---------------------------------------------------------------------------
 *
 * `company_reference_counters` (used by `nextOrderNumber`/
 * `nextReferenceNumber` for Delivery Orders) is keyed
 * `(company_id, reference_type)` with `company_id NOT NULL` and a
 * `reference_type` CHECK that does not include a Store Order value. A Store
 * Order is not Company-scoped, so it cannot borrow that counter without
 * either faking a Company or widening a constraint that exists specifically
 * to keep Delivery reference numbers scoped correctly. `store_order_number_counters`
 * mirrors the exact same INSERT ... ON CONFLICT DO UPDATE idiom, just
 * without the Company key, seeded with one row: `('store_order', 1, 'SO')`.
 *
 * ---------------------------------------------------------------------------
 * SNAPSHOTS: NORMALIZED SCALAR COLUMNS, NOT ONE JSONB BLOB
 * ---------------------------------------------------------------------------
 *
 * This mirrors the codebase's own established idiom for "frozen historical
 * copy of a priced/parented thing" -- `orders.customer_name`/
 * `customer_mobile_number`/... denormalize Customer data directly onto the
 * Order row, and `trader_configuration`'s `pricing_type_snapshot`/
 * `configured_service_fee_snapshot` freeze pricing facts as scalar columns,
 * not as JSONB. `store_order_items` follows the same pattern for Product
 * facts (name/price/code/sku/brand). JSONB is used for exactly one field --
 * `selected_options_snapshot` -- because a Product's option selections are
 * inherently a variable-length list with no existing "selection" table to
 * normalize into (`trader_storefront_product_option_groups`/`_option_values`
 * are live, editable definitions, not history).
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    -- ---------------------------------------------------------------------
    -- Global Store Order number counter (mirrors company_reference_counters'
    -- upsert idiom, without a Company key).
    -- ---------------------------------------------------------------------
    create table store_order_number_counters (
      reference_type text primary key,
      next_value bigint not null default 1 check (next_value > 0),
      prefix text not null check (prefix ~ '^[A-Z0-9-]{1,12}$'),
      updated_at timestamptz not null default now()
    );
    insert into store_order_number_counters (reference_type, next_value, prefix)
      values ('store_order', 1, 'SO');

    -- Composite unique target so a Store Order's selected Delivery Company
    -- relationship can be FK-validated as belonging to the SAME Trader
    -- Commerce identity AND the SAME Company in one constraint, without a
    -- trigger. Purely additive -- no existing query relies on absence of
    -- this index, and it does not touch the Driver Cash Reconciliation hold
    -- (this table is Commerce/Trader-relationship domain, not DCR).
    create unique index trader_delivery_company_relationships_id_commerce_company_key
      on trader_delivery_company_relationships (id, trader_commerce_id, company_id);

    create table store_orders (
      id uuid primary key default gen_random_uuid(),
      store_order_number text not null unique,

      -- Shop identity: Trader Commerce, not Company (§2/§4 of the prompt).
      trader_commerce_id uuid not null
        references trader_commerce_profiles (id) on delete restrict,
      storefront_id uuid not null,

      -- Store identity snapshot (§24): enough for historical display without
      -- duplicating every Store setting.
      store_display_name_snapshot text not null check (btrim(store_display_name_snapshot) <> ''),
      store_slug_snapshot text not null check (btrim(store_slug_snapshot) <> ''),

      -- Customer or guest (§8/§23): nullable account, mandatory snapshot either way.
      customer_id uuid references commerce_customers (id) on delete restrict,

      order_source text not null default 'store_web'
        check (order_source in ('store_web', 'store_app', 'trader_manual_future')),
      status text not null default 'draft'
        check (status in (
          'draft', 'submitted', 'awaiting_trader_confirmation', 'confirmed',
          'cancelled', 'converted_to_delivery', 'completed_external'
        )),
      currency text not null default 'AED' check (currency = 'AED'),

      -- Customer snapshot (§21) -- frozen at creation, never rewritten by a
      -- later profile/address edit.
      customer_name text not null check (btrim(customer_name) <> ''),
      customer_mobile text not null check (customer_mobile ~ '^9715[0-9]{8}$'),
      customer_email text,
      delivery_emirate text not null check (btrim(delivery_emirate) <> ''),
      delivery_area text not null check (btrim(delivery_area) <> ''),
      delivery_address text not null check (btrim(delivery_address) <> ''),
      delivery_location_link text,
      delivery_instructions text,

      -- Money foundation (§25): separate components, never collapsed into one total.
      product_subtotal numeric(12,2) not null check (product_subtotal >= 0),
      customer_delivery_fee numeric(12,2) not null default 0 check (customer_delivery_fee >= 0),
      delivery_company_service_fee numeric(12,2) not null default 0 check (delivery_company_service_fee >= 0),
      platform_fee numeric(12,2) not null default 0 check (platform_fee >= 0),
      cod_total numeric(12,2) not null check (cod_total >= 0),
      -- §29's documented current rule: COD total is product subtotal plus the
      -- customer-facing delivery amount. No Checkout pricing logic is invented
      -- here; this is an arithmetic identity the internal creation service
      -- must already satisfy, enforced again at the database for defence in
      -- depth. Named distinctly from the plain "cod_total >= 0" column CHECK
      -- above -- an unnamed column CHECK auto-names itself
      -- "store_orders_cod_total_check" (table_column_check), which this
      -- would otherwise collide with.
      constraint store_orders_cod_total_identity_check
        check (cod_total = product_subtotal + customer_delivery_fee),

      -- Delivery Company bridge (§32/§33/§37): nullable, both-or-neither.
      delivery_company_id uuid references companies (id) on delete restrict,
      delivery_company_relationship_id uuid references trader_delivery_company_relationships (id) on delete restrict,
      constraint store_orders_company_pair_check
        check ((delivery_company_id is null) = (delivery_company_relationship_id is null)),

      -- §38: a Delivery Order may be linked from at most one Store Order
      -- (UNIQUE), and since this is a single nullable column, a Store Order
      -- can never reference more than one Delivery Order by construction --
      -- idempotency without a separate conversion table. Conversion itself
      -- is NOT implemented in 3B (§39).
      delivery_order_id uuid references orders (id) on delete restrict,

      submitted_at timestamptz,
      confirmed_at timestamptz,
      cancelled_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1 check (version > 0),

      -- §7: Storefront/Trader Commerce ownership as a database composite FK,
      -- not only a service check -- mirrors the successful pattern already
      -- used for Product ownership.
      constraint store_orders_storefront_commerce_fk
        foreign key (trader_commerce_id, storefront_id)
        references trader_storefronts (trader_commerce_id, id) on delete restrict,

      -- Selected Company relationship must belong to the SAME Trader
      -- Commerce identity AND report the SAME Company as delivery_company_id
      -- -- one constraint enforces both (§33).
      constraint store_orders_relationship_fk
        foreign key (delivery_company_relationship_id, trader_commerce_id, delivery_company_id)
        references trader_delivery_company_relationships (id, trader_commerce_id, company_id)
        on delete restrict,

      constraint store_orders_delivery_order_unique unique (delivery_order_id)
    );

    create index store_orders_trader_commerce_idx on store_orders (trader_commerce_id, status);
    create index store_orders_storefront_idx on store_orders (storefront_id);
    create index store_orders_customer_idx on store_orders (customer_id) where customer_id is not null;

    -- §34: once a Delivery Company/relationship/Delivery Order is attached,
    -- it is historical truth -- a later change to the underlying
    -- relationship (default swapped, disabled) must never rewrite what THIS
    -- Store Order already recorded.
    create function enforce_store_order_delivery_freeze()
      returns trigger language plpgsql as $$
      begin
        if old.delivery_company_id is not null
           and new.delivery_company_id is distinct from old.delivery_company_id then
          raise exception 'store_orders.delivery_company_id is frozen once set';
        end if;
        if old.delivery_company_relationship_id is not null
           and new.delivery_company_relationship_id is distinct from old.delivery_company_relationship_id then
          raise exception 'store_orders.delivery_company_relationship_id is frozen once set';
        end if;
        if old.delivery_order_id is not null
           and new.delivery_order_id is distinct from old.delivery_order_id then
          raise exception 'store_orders.delivery_order_id is frozen once set';
        end if;
        return new;
      end;
      $$;
    create trigger store_orders_delivery_freeze_guard
      before update of delivery_company_id, delivery_company_relationship_id, delivery_order_id
      on store_orders
      for each row execute function enforce_store_order_delivery_freeze();

    create table store_order_items (
      id uuid primary key default gen_random_uuid(),
      store_order_id uuid not null references store_orders (id) on delete cascade,

      -- Denormalized alongside product_id so Product ownership (§49) is a
      -- database composite FK, not only a service check.
      storefront_id uuid not null,
      product_id uuid not null,

      -- Product snapshot (§17/§18): frozen at creation, immune to later
      -- Product edits.
      product_name_snapshot text not null check (btrim(product_name_snapshot) <> ''),
      product_code_snapshot text not null check (btrim(product_code_snapshot) <> ''),
      sku_snapshot text,
      brand_snapshot text,
      -- A plain reference, deliberately NOT foreign-keyed to file_objects:
      -- the display image used at order time must remain resolvable even if
      -- the Product's media is later replaced or removed, and a hard FK
      -- would force this row to track file lifecycle it has no business
      -- depending on.
      product_image_snapshot uuid,

      unit_price_snapshot numeric(12,2) not null check (unit_price_snapshot >= 0),
      quantity integer not null check (quantity > 0),
      line_total numeric(12,2) not null check (line_total >= 0),
      -- Named distinctly from the plain "line_total >= 0" column CHECK above
      -- for the same auto-naming-collision reason as
      -- store_orders_cod_total_identity_check.
      constraint store_order_items_line_total_identity_check
        check (line_total = unit_price_snapshot * quantity),

      -- Selected options (§19): immutable snapshot array, no existing
      -- "selection" table to normalize into (option groups/values are live
      -- definitions, not history).
      selected_options_snapshot jsonb not null default '[]'::jsonb
        check (jsonb_typeof(selected_options_snapshot) = 'array'),

      created_at timestamptz not null default now(),

      constraint store_order_items_product_fk
        foreign key (storefront_id, product_id)
        references trader_storefront_products (storefront_id, id) on delete restrict
    );

    create index store_order_items_store_order_idx on store_order_items (store_order_id);
    create index store_order_items_product_idx on store_order_items (storefront_id, product_id);

    -- The Item's storefront must match its own Store Order's storefront --
    -- checked once at INSERT (there is no legitimate path that later moves
    -- an Item to a different Store Order or Storefront; see the immutability
    -- guard below for why no UPDATE case exists to re-check).
    create function enforce_store_order_item_storefront_match()
      returns trigger language plpgsql as $$
      declare order_storefront uuid;
      begin
        select storefront_id into order_storefront from store_orders where id = new.store_order_id;
        if order_storefront is distinct from new.storefront_id then
          raise exception 'store_order_items.storefront_id must match its Store Order''s storefront_id';
        end if;
        return new;
      end;
      $$;
    create trigger store_order_items_storefront_match_guard
      before insert on store_order_items
      for each row execute function enforce_store_order_item_storefront_match();

    -- No legitimate update path exists for a Store Order Item today (§14-19
    -- describe creation-time snapshot only) -- enforced at the database so a
    -- future bug cannot silently rewrite Order history.
    create function enforce_store_order_item_immutable()
      returns trigger language plpgsql as $$
      begin
        raise exception 'store_order_items rows are immutable once created';
      end;
      $$;
    create trigger store_order_items_immutable_guard
      before update of
        store_order_id, storefront_id, product_id, product_name_snapshot, product_code_snapshot,
        sku_snapshot, brand_snapshot, product_image_snapshot, unit_price_snapshot, quantity,
        line_total, selected_options_snapshot
      on store_order_items
      for each row execute function enforce_store_order_item_immutable();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists store_order_items_immutable_guard on store_order_items;
    drop function if exists enforce_store_order_item_immutable();
    drop trigger if exists store_order_items_storefront_match_guard on store_order_items;
    drop function if exists enforce_store_order_item_storefront_match();
    drop table if exists store_order_items;

    drop trigger if exists store_orders_delivery_freeze_guard on store_orders;
    drop function if exists enforce_store_order_delivery_freeze();
    drop table if exists store_orders;

    drop index if exists trader_delivery_company_relationships_id_commerce_company_key;

    drop table if exists store_order_number_counters;
  `.execute(database);
}
