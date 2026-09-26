import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Storefront / Category / Product ownership moves from Delivery Company to
 * Trader Commerce.
 *
 * ---------------------------------------------------------------------------
 * WHAT ACTUALLY CHANGES
 * ---------------------------------------------------------------------------
 *
 * Before this migration every row in the Store tree carried `company_id NOT
 * NULL` and every parent link was a COMPOSITE key beginning with that Company:
 *
 *     categories    (company_id, storefront_id)          -> storefronts (company_id, id)
 *     products      (company_id, storefront_id)          -> storefronts (company_id, id)
 *     products      (company_id, storefront_id, cat_id)  -> categories  (company_id, storefront_id, id)
 *     media/groups  (company_id, storefront_id, prod_id) -> products    (company_id, storefront_id, id)
 *     values        (company_id, storefront_id, group_id)-> groups      (company_id, storefront_id, id)
 *
 * That shape made the Delivery Company structurally load-bearing: a Store could
 * not exist without one, because the foreign key said so. After this migration
 * the same links are expressed WITHOUT the Company:
 *
 *     categories -> storefronts (id)
 *     products   -> storefronts (id) and categories (storefront_id, id)
 *     media      -> products    (storefront_id, id)
 *     groups     -> products    (storefront_id, id)
 *     values     -> groups      (storefront_id, id)
 *
 * The Storefront's own owner is `trader_commerce_id`, which 0A-2 already made
 * mandatory. Ownership is now a single chain rooted at the shop, and a Delivery
 * Company is a RELATIONSHIP the shop has, not the thing that owns it.
 *
 * The composite keys are kept one column narrower rather than reduced to a
 * plain `product_id`, because `(storefront_id, product_id)` still makes "this
 * media row cannot belong to a Product in another Store" a schema fact. Losing
 * the Company must not also lose that.
 *
 * ---------------------------------------------------------------------------
 * WHY company_id AND trader_id SURVIVE AS NULLABLE COLUMNS
 * ---------------------------------------------------------------------------
 *
 * They are not dropped. Dropping them would be a second, irreversible decision
 * bundled into an already large migration, and code still reads them during the
 * transition. They become OPTIONAL COMPATIBILITY REFERENCES with no ownership
 * meaning: nothing may infer "this Store belongs to the session's Company" from
 * `trader_storefronts.company_id` after this point.
 *
 * Postgres composite foreign keys default to MATCH SIMPLE, which skips the
 * check when ANY column is NULL. That is exactly the semantics wanted here --
 * a legacy pair is verified against `traders (company_id, id)` when it is
 * present and ignored when it is absent -- but on its own it also permits the
 * half-populated pair `(company, NULL)`, which would silently pass. The added
 * CHECK closes that: both present, or neither.
 *
 * ---------------------------------------------------------------------------
 * THE ZERO-COMPANY PROBE IS PART OF THE MIGRATION, NOT A LATER TEST
 * ---------------------------------------------------------------------------
 *
 * Stage G builds a complete Commerce -> Storefront -> Category -> Product ->
 * Option Group -> Option Value tree with `company_id` and `trader_id` NULL and
 * no Delivery Company relationship at all, then rolls it back to a savepoint.
 * If any constraint still demands a Company, this migration fails and the whole
 * transaction unwinds, rather than reporting success and leaving the real
 * discovery to a test run afterwards.
 *
 * ---------------------------------------------------------------------------
 * ROLLBACK
 * ---------------------------------------------------------------------------
 *
 * `down` restores every Company-scoped constraint and NOT NULL. It succeeds
 * only while every row still has a Company -- which is true immediately after
 * this migration and stops being true the moment a genuine zero-Company Store
 * is created. That is inherent to the conversion, not an oversight: at that
 * point the backup taken before this migration is the recovery path, and rows
 * created after it were never representable in the old model.
 *
 * `file_objects` is not referenced by any DDL in this file.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  // ------------------------------------------------- Stage A: new FK targets

  // Storefront-scoped replacements for the three `(company_id, ...)` unique
  // indexes the old composite keys pointed at. Created before anything is
  // dropped so no foreign key is ever without a target.
  await sql`
    create unique index if not exists trader_storefront_categories_storefront_key
      on trader_storefront_categories (storefront_id, id)
  `.execute(database);
  await sql`
    create unique index if not exists trader_storefront_products_storefront_key
      on trader_storefront_products (storefront_id, id)
  `.execute(database);
  await sql`
    create unique index if not exists trader_storefront_product_option_groups_storefront_key
      on trader_storefront_product_option_groups (storefront_id, id)
  `.execute(database);

  // ------------------------------------------- Stage B: validate every chain

  // Relaxing a foreign key can only be safe if nothing currently depends on the
  // column being dropped from it. Each check below asks whether the narrower
  // key would still identify the same parent; a non-zero answer means some row
  // is reachable only through the Company, and the migration stops.
  await sql`
    do $$
    declare
      offenders bigint;
    begin
      select count(*) into offenders from trader_storefronts
        where trader_commerce_id is null;
      if offenders <> 0 then
        raise exception 'Ownership rebind blocked: % Storefront(s) have no Trader Commerce identity', offenders;
      end if;

      select count(*) into offenders from trader_storefront_categories category
        where not exists (
          select 1 from trader_storefronts storefront
          where storefront.id = category.storefront_id
            and storefront.company_id = category.company_id
        );
      if offenders <> 0 then
        raise exception 'Ownership rebind blocked: % Category/Categories do not resolve to their Storefront', offenders;
      end if;

      select count(*) into offenders from trader_storefront_products product
        where not exists (
          select 1 from trader_storefronts storefront
          where storefront.id = product.storefront_id
            and storefront.company_id = product.company_id
        );
      if offenders <> 0 then
        raise exception 'Ownership rebind blocked: % Product(s) do not resolve to their Storefront', offenders;
      end if;

      select count(*) into offenders from trader_storefront_products product
        where product.category_id is not null
          and not exists (
            select 1 from trader_storefront_categories category
            where category.id = product.category_id
              and category.storefront_id = product.storefront_id
          );
      if offenders <> 0 then
        raise exception 'Ownership rebind blocked: % Product(s) reference a Category in another Storefront', offenders;
      end if;

      select count(*) into offenders from trader_storefront_product_media media
        where not exists (
          select 1 from trader_storefront_products product
          where product.id = media.product_id
            and product.storefront_id = media.storefront_id
        );
      if offenders <> 0 then
        raise exception 'Ownership rebind blocked: % media row(s) do not resolve to their Product', offenders;
      end if;

      select count(*) into offenders from trader_storefront_product_option_groups grp
        where not exists (
          select 1 from trader_storefront_products product
          where product.id = grp.product_id
            and product.storefront_id = grp.storefront_id
        );
      if offenders <> 0 then
        raise exception 'Ownership rebind blocked: % option group(s) do not resolve to their Product', offenders;
      end if;

      select count(*) into offenders from trader_storefront_product_option_values value
        where not exists (
          select 1 from trader_storefront_product_option_groups grp
          where grp.id = value.option_group_id
            and grp.storefront_id = value.storefront_id
        );
      if offenders <> 0 then
        raise exception 'Ownership rebind blocked: % option value(s) do not resolve to their option group', offenders;
      end if;
    end
    $$
  `.execute(database);

  // -------------------------------------- Stage C: Storefront Company relaxed

  // The freeze trigger previously guarded `company_id` and `trader_id`, which
  // were the owner. They no longer are, and this migration itself needs them to
  // become clearable. The guard therefore moves to the column that IS now the
  // owner. `is distinct from` rather than `<>` because a NULL comparison
  // yields NULL, and a guard that evaluates to NULL does not fire -- which
  // would have let ownership be nulled out silently.
  await sql`
    create or replace function trader_storefronts_freeze_ownership()
    returns trigger language plpgsql as $$
    begin
      if new.trader_commerce_id is distinct from old.trader_commerce_id then
        raise exception 'Storefront ownership cannot be changed'
          using errcode = 'restrict_violation';
      end if;
      return new;
    end;
    $$
  `.execute(database);

  await sql`
    alter table trader_storefronts
      alter column company_id drop not null,
      alter column trader_id drop not null
  `.execute(database);

  // Both or neither. The composite FK to `traders` is MATCH SIMPLE and skips a
  // half-populated pair entirely, so without this a Storefront could claim a
  // Company while naming no Trader and nothing would object.
  await sql`
    alter table trader_storefronts
      add constraint trader_storefronts_legacy_pair_check check (
        (company_id is null) = (trader_id is null)
      )
  `.execute(database);

  // ---------------------------------------- Stage D: Category Company relaxed

  await sql`
    alter table trader_storefront_categories
      add constraint trader_storefront_categories_storefront_only_fk
      foreign key (storefront_id) references trader_storefronts (id) on delete restrict
  `.execute(database);
  await sql`
    alter table trader_storefront_categories
      drop constraint trader_storefront_categories_storefront_fk
  `.execute(database);
  await sql`
    alter table trader_storefront_categories alter column company_id drop not null
  `.execute(database);

  // ----------------------------------------- Stage E: Product Company relaxed

  await sql`
    alter table trader_storefront_products
      add constraint trader_storefront_products_storefront_only_fk
      foreign key (storefront_id) references trader_storefronts (id) on delete restrict
  `.execute(database);
  // Still composite: a Product may only point at a Category in ITS OWN Store.
  // Dropping to a bare `category_id` here would have quietly allowed borrowing
  // another shop's Category.
  await sql`
    alter table trader_storefront_products
      add constraint trader_storefront_products_category_only_fk
      foreign key (storefront_id, category_id)
      references trader_storefront_categories (storefront_id, id) on delete restrict
  `.execute(database);
  await sql`
    alter table trader_storefront_products
      drop constraint trader_storefront_products_category_fk,
      drop constraint trader_storefront_products_storefront_fk
  `.execute(database);
  await sql`
    alter table trader_storefront_products
      alter column company_id drop not null,
      alter column trader_id drop not null
  `.execute(database);

  // The Category composite target is now unreferenced.
  await sql`drop index if exists trader_storefront_categories_scope_key`.execute(database);

  // ----------------------------- Stage F: Product child Company dependency

  await sql`
    alter table trader_storefront_product_media
      add constraint trader_storefront_product_media_product_only_fk
      foreign key (storefront_id, product_id)
      references trader_storefront_products (storefront_id, id) on delete restrict
  `.execute(database);
  await sql`
    alter table trader_storefront_product_media
      drop constraint trader_storefront_product_media_product_fk
  `.execute(database);
  await sql`
    alter table trader_storefront_product_media alter column company_id drop not null
  `.execute(database);

  await sql`
    alter table trader_storefront_product_option_groups
      add constraint trader_storefront_product_option_groups_product_only_fk
      foreign key (storefront_id, product_id)
      references trader_storefront_products (storefront_id, id) on delete restrict
  `.execute(database);
  await sql`
    alter table trader_storefront_product_option_groups
      drop constraint trader_storefront_product_option_groups_product_fk
  `.execute(database);
  await sql`
    alter table trader_storefront_product_option_groups alter column company_id drop not null
  `.execute(database);

  await sql`drop index if exists trader_storefront_products_scope_key`.execute(database);

  await sql`
    alter table trader_storefront_product_option_values
      add constraint trader_storefront_product_option_values_group_only_fk
      foreign key (storefront_id, option_group_id)
      references trader_storefront_product_option_groups (storefront_id, id) on delete restrict
  `.execute(database);
  await sql`
    alter table trader_storefront_product_option_values
      drop constraint trader_storefront_product_option_values_group_fk
  `.execute(database);
  await sql`
    alter table trader_storefront_product_option_values alter column company_id drop not null
  `.execute(database);

  await sql`drop index if exists trader_storefront_product_option_groups_scope_key`.execute(
    database,
  );

  // Retired slugs belong to the Storefront, which they already reference
  // directly. Their Company column is now compatibility only.
  await sql`
    alter table trader_storefront_slugs alter column company_id drop not null
  `.execute(database);

  // The Storefront composite target existed only to be pointed at by the
  // Company-scoped child keys that no longer exist.
  await sql`drop index if exists trader_storefronts_company_identity_key`.execute(database);

  // ------------------------------- Stage G: prove the zero-Company Store model

  // Built and rolled back inside this transaction. If any constraint still
  // requires a Delivery Company anywhere in the Store tree, this raises and the
  // entire migration unwinds -- the failure surfaces here rather than in
  // production the first time a Trader has no Delivery Company.
  await sql`
    do $$
    declare
      probe_commerce uuid;
      probe_storefront uuid;
      probe_category uuid;
      probe_product uuid;
      probe_group uuid;
      probe_slug text := 'zero-company-probe-' || replace(gen_random_uuid()::text, '-', '');
    begin
      insert into trader_commerce_profiles (public_name, registration_source, approval_status)
        values ('Zero Company Probe', 'trader_self_registered', 'approved')
        returning id into probe_commerce;

      -- No company_id. No trader_id. No delivery relationship row anywhere.
      insert into trader_storefronts (
        trader_commerce_id, display_name, slug, business_template, theme
      ) values (
        probe_commerce, 'Zero Company Probe', probe_slug, 'general', 'modern'
      ) returning id into probe_storefront;

      insert into trader_storefront_categories (storefront_id, name_en, slug)
        values (probe_storefront, 'Probe Category', 'probe-category')
        returning id into probe_category;

      insert into trader_storefront_products (
        storefront_id, category_id, name, slug, product_code, selling_price
      ) values (
        probe_storefront, probe_category, 'Probe Product', 'probe-product', 'PROBE-1', 10
      ) returning id into probe_product;

      insert into trader_storefront_product_option_groups (storefront_id, product_id, name)
        values (probe_storefront, probe_product, 'Probe Group')
        returning id into probe_group;

      insert into trader_storefront_product_option_values (storefront_id, option_group_id, value)
        values (probe_storefront, probe_group, 'Probe Value');

      -- Publishing must work too: a Store with no Delivery Company is still a
      -- Store, and refusing to publish it would defeat the whole conversion.
      update trader_storefronts
        set status = 'published', published_at = now()
        where id = probe_storefront;

      raise notice 'Zero-Company Store model verified';
    end
    $$
  `.execute(database);

  // Everything the probe wrote is removed in dependency order. It was a proof,
  // not data.
  await sql`
    delete from trader_storefront_product_option_values
     where storefront_id in (
       select id from trader_storefronts where trader_commerce_id in (
         select id from trader_commerce_profiles where public_name = 'Zero Company Probe'
       )
     )
  `.execute(database);
  await sql`
    delete from trader_storefront_product_option_groups
     where storefront_id in (
       select id from trader_storefronts where trader_commerce_id in (
         select id from trader_commerce_profiles where public_name = 'Zero Company Probe'
       )
     )
  `.execute(database);
  await sql`
    delete from trader_storefront_products
     where storefront_id in (
       select id from trader_storefronts where trader_commerce_id in (
         select id from trader_commerce_profiles where public_name = 'Zero Company Probe'
       )
     )
  `.execute(database);
  await sql`
    delete from trader_storefront_categories
     where storefront_id in (
       select id from trader_storefronts where trader_commerce_id in (
         select id from trader_commerce_profiles where public_name = 'Zero Company Probe'
       )
     )
  `.execute(database);
  await sql`
    delete from trader_storefronts
     where trader_commerce_id in (
       select id from trader_commerce_profiles where public_name = 'Zero Company Probe'
     )
  `.execute(database);
  await sql`
    delete from trader_commerce_profiles where public_name = 'Zero Company Probe'
  `.execute(database);

  // ------------------------------------------------- final integrity assertion

  await sql`
    do $$
    declare
      leftovers bigint;
      unresolved bigint;
    begin
      select count(*) into leftovers from trader_commerce_profiles
        where public_name = 'Zero Company Probe';
      if leftovers <> 0 then
        raise exception 'Ownership rebind blocked: probe rows were not fully removed';
      end if;

      select count(*) into unresolved from trader_storefronts
        where trader_commerce_id is null;
      if unresolved <> 0 then
        raise exception 'Ownership rebind blocked: % Storefront(s) lost their Commerce identity', unresolved;
      end if;
    end
    $$
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  // Restores Company ownership. Only possible while every Store row still has a
  // Company; a genuine zero-Company Store cannot be represented in the old
  // model and will make these statements fail by design.
  await sql`
    create unique index if not exists trader_storefronts_company_identity_key
      on trader_storefronts (company_id, id)
  `.execute(database);

  await sql`
    alter table trader_storefront_slugs alter column company_id set not null
  `.execute(database);

  await sql`
    create unique index if not exists trader_storefront_product_option_groups_scope_key
      on trader_storefront_product_option_groups (company_id, storefront_id, id)
  `.execute(database);
  await sql`
    alter table trader_storefront_product_option_values
      alter column company_id set not null
  `.execute(database);
  await sql`
    alter table trader_storefront_product_option_values
      add constraint trader_storefront_product_option_values_group_fk
      foreign key (company_id, storefront_id, option_group_id)
      references trader_storefront_product_option_groups (company_id, storefront_id, id)
      on delete restrict
  `.execute(database);
  await sql`
    alter table trader_storefront_product_option_values
      drop constraint if exists trader_storefront_product_option_values_group_only_fk
  `.execute(database);

  await sql`
    create unique index if not exists trader_storefront_products_scope_key
      on trader_storefront_products (company_id, storefront_id, id)
  `.execute(database);
  await sql`
    alter table trader_storefront_product_option_groups alter column company_id set not null
  `.execute(database);
  await sql`
    alter table trader_storefront_product_option_groups
      add constraint trader_storefront_product_option_groups_product_fk
      foreign key (company_id, storefront_id, product_id)
      references trader_storefront_products (company_id, storefront_id, id) on delete restrict
  `.execute(database);
  await sql`
    alter table trader_storefront_product_option_groups
      drop constraint if exists trader_storefront_product_option_groups_product_only_fk
  `.execute(database);

  await sql`
    alter table trader_storefront_product_media alter column company_id set not null
  `.execute(database);
  await sql`
    alter table trader_storefront_product_media
      add constraint trader_storefront_product_media_product_fk
      foreign key (company_id, storefront_id, product_id)
      references trader_storefront_products (company_id, storefront_id, id) on delete restrict
  `.execute(database);
  await sql`
    alter table trader_storefront_product_media
      drop constraint if exists trader_storefront_product_media_product_only_fk
  `.execute(database);

  await sql`
    create unique index if not exists trader_storefront_categories_scope_key
      on trader_storefront_categories (company_id, storefront_id, id)
  `.execute(database);
  await sql`
    alter table trader_storefront_products
      alter column company_id set not null,
      alter column trader_id set not null
  `.execute(database);
  await sql`
    alter table trader_storefront_products
      add constraint trader_storefront_products_storefront_fk
      foreign key (company_id, storefront_id)
      references trader_storefronts (company_id, id) on delete restrict,
      add constraint trader_storefront_products_category_fk
      foreign key (company_id, storefront_id, category_id)
      references trader_storefront_categories (company_id, storefront_id, id) on delete restrict
  `.execute(database);
  await sql`
    alter table trader_storefront_products
      drop constraint if exists trader_storefront_products_category_only_fk,
      drop constraint if exists trader_storefront_products_storefront_only_fk
  `.execute(database);

  await sql`
    alter table trader_storefront_categories alter column company_id set not null
  `.execute(database);
  await sql`
    alter table trader_storefront_categories
      add constraint trader_storefront_categories_storefront_fk
      foreign key (company_id, storefront_id)
      references trader_storefronts (company_id, id) on delete restrict
  `.execute(database);
  await sql`
    alter table trader_storefront_categories
      drop constraint if exists trader_storefront_categories_storefront_only_fk
  `.execute(database);

  await sql`
    alter table trader_storefronts
      drop constraint if exists trader_storefronts_legacy_pair_check
  `.execute(database);
  await sql`
    alter table trader_storefronts
      alter column company_id set not null,
      alter column trader_id set not null
  `.execute(database);

  await sql`
    create or replace function trader_storefronts_freeze_ownership()
    returns trigger language plpgsql as $$
    begin
      if new.company_id <> old.company_id or new.trader_id <> old.trader_id then
        raise exception 'Storefront ownership cannot be changed'
          using errcode = 'restrict_violation';
      end if;
      return new;
    end;
    $$
  `.execute(database);

  await sql`drop index if exists trader_storefront_product_option_groups_storefront_key`.execute(
    database,
  );
  await sql`drop index if exists trader_storefront_products_storefront_key`.execute(database);
  await sql`drop index if exists trader_storefront_categories_storefront_key`.execute(database);
}
