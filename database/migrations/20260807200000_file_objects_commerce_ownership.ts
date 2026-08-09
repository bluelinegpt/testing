import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * `file_objects` gains a second kind of owner: a Trader Commerce identity.
 *
 * ---------------------------------------------------------------------------
 * WHY A SHARED TABLE GETS AN OWNER DISCRIMINATOR RATHER THAN A SECOND TABLE
 * ---------------------------------------------------------------------------
 *
 * Ten operational tables already reference `file_objects (id, company_id)`
 * through COMPOSITE foreign keys -- order attachments, driver documents,
 * reconciliation expenses, general expenses, HR documents, import batches,
 * operating expenses, cash/bank movement attachments, company branding. Every
 * one of those is genuinely Company-owned and must stay exactly as it is.
 *
 * A separate `commerce_file_objects` table would leave the Commerce tables
 * pointing somewhere else and duplicate every scan-status, size, checksum and
 * retention rule that already lives here. So the owner becomes explicit
 * instead: `owner_type` plus exactly one of `company_id` / `trader_commerce_id`.
 *
 * Only two owner types exist. A general polymorphic owner engine would be
 * cheaper to write now and much more expensive to reason about later; Customer
 * and Platform ownership can be added deliberately when they are real.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT IS ONE OWNER, ENFORCED BY THE DATABASE
 * ---------------------------------------------------------------------------
 *
 *     owner_type = 'company'         -> company_id NOT NULL, trader_commerce_id NULL
 *     owner_type = 'trader_commerce' -> trader_commerce_id NOT NULL, company_id NULL
 *
 * Both set, neither set, or a type that disagrees with the populated column are
 * all rejected by one CHECK. Ownership that can be ambiguous is ownership that
 * will eventually be resolved by whichever query happened to run first.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKING company_id NULLABLE QUIETLY BREAKS, AND THE FIX
 * ---------------------------------------------------------------------------
 *
 * `file_objects_uploader_fk` is `(uploaded_by_account_id, company_id) ->
 * accounts (id, company_id)`. Postgres composite foreign keys default to MATCH
 * SIMPLE, which SKIPS the check entirely when any column is NULL. The moment
 * `company_id` can be NULL, a Commerce file's uploader would stop being
 * validated at all -- silently, with no error anywhere.
 *
 * So a single-column `uploaded_by_account_id -> accounts (id)` foreign key is
 * added alongside it. The composite still proves "this uploader belongs to this
 * Company" for Company files; the new one proves "this uploader exists" for
 * every file including Commerce ones.
 *
 * ---------------------------------------------------------------------------
 * ROLLBACK IS NOT SYMMETRIC, AND SAYING SO IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * `down` restores `company_id NOT NULL` and drops the Commerce columns. It
 * succeeds only while every file still has a Company. Once a genuine
 * zero-Company Commerce file exists there is no Company to restore it to -- the
 * old model cannot represent that row, and `down` will fail on the NOT NULL
 * rather than invent an owner. That is correct behaviour, not a gap: the
 * verified backup taken before this migration is the real rollback boundary.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  // ------------------------------------------- Stage A: additive owner fields

  await sql`
    alter table file_objects
      add column owner_type text,
      add column trader_commerce_id uuid
  `.execute(database);

  // ------------------------------------------------- Stage B: backfill owner

  // Every file that exists today is Company-owned; that is what the NOT NULL
  // column has been asserting all along.
  await sql`
    update file_objects set owner_type = 'company' where owner_type is null
  `.execute(database);

  // ------------------------- Stage C/D: rebind Commerce-referenced files
  //
  // A file counts as Commerce-owned only if a Store or Product structure points
  // at it. The Storefront's `trader_commerce_id` is the authoritative owner
  // after 0B-1, so it is read from there rather than from the file's Company.
  //
  // `not exists (...)` against the operational tables is the shared-file
  // conflict guard: a file used by BOTH a Product image and, say, an order
  // attachment is deliberately left Company-owned rather than silently taken
  // away from the Delivery domain. Stage E then reports it rather than
  // pretending the rebind was complete.
  await sql`
    with commerce_reference as (
      select storefront.logo_file_id as file_id, storefront.trader_commerce_id
        from trader_storefronts storefront where storefront.logo_file_id is not null
      union
      select storefront.cover_file_id, storefront.trader_commerce_id
        from trader_storefronts storefront where storefront.cover_file_id is not null
      union
      select category.image_file_id, storefront.trader_commerce_id
        from trader_storefront_categories category
        join trader_storefronts storefront on storefront.id = category.storefront_id
       where category.image_file_id is not null
      union
      select media.file_id, storefront.trader_commerce_id
        from trader_storefront_product_media media
        join trader_storefronts storefront on storefront.id = media.storefront_id
       where media.file_id is not null
      union
      select media.poster_file_id, storefront.trader_commerce_id
        from trader_storefront_product_media media
        join trader_storefronts storefront on storefront.id = media.storefront_id
       where media.poster_file_id is not null
    ),
    unambiguous as (
      -- One Commerce owner only. A file reachable from two different Commerce
      -- identities is not safe to rebind either way. array_agg rather than min
      -- because Postgres has no min(uuid); the HAVING guarantees the array
      -- holds exactly one element.
      select file_id, (array_agg(distinct trader_commerce_id))[1] as trader_commerce_id
        from commerce_reference
       group by file_id
      having count(distinct trader_commerce_id) = 1
    ),
    eligible as (
      select unambiguous.file_id, unambiguous.trader_commerce_id
        from unambiguous
       where not exists (select 1 from order_attachments a where a.file_object_id = unambiguous.file_id)
         and not exists (select 1 from order_expenses a where a.attachment_file_id = unambiguous.file_id)
         and not exists (select 1 from driver_documents a where a.attachment_file_id = unambiguous.file_id)
         and not exists (select 1 from driver_reconciliation_expenses a where a.attachment_file_id = unambiguous.file_id)
         and not exists (select 1 from general_expense_attachments a where a.file_object_id = unambiguous.file_id)
         and not exists (select 1 from hr_document_attachments a where a.file_object_id = unambiguous.file_id)
         and not exists (select 1 from operating_expenses a where a.attachment_file_id = unambiguous.file_id)
         and not exists (select 1 from cash_bank_movement_attachments a where a.file_object_id = unambiguous.file_id)
         and not exists (select 1 from import_batches a where a.source_file_id = unambiguous.file_id)
         and not exists (select 1 from companies a where a.logo_file_id = unambiguous.file_id)
    )
    update file_objects
       set owner_type = 'trader_commerce',
           trader_commerce_id = eligible.trader_commerce_id,
           company_id = null
      from eligible
     where file_objects.id = eligible.file_id
  `.execute(database);

  // ------------------------------------------ Stage E: hard ownership gate

  await sql`
    do $$
    declare
      unowned bigint;
      conflicting bigint;
      bad_company bigint;
      bad_commerce bigint;
      shared bigint;
    begin
      select count(*) into unowned from file_objects
        where owner_type is null
           or (owner_type = 'company' and company_id is null)
           or (owner_type = 'trader_commerce' and trader_commerce_id is null);
      if unowned <> 0 then
        raise exception 'Media ownership blocked: % file(s) have no valid owner', unowned;
      end if;

      select count(*) into conflicting from file_objects
        where company_id is not null and trader_commerce_id is not null;
      if conflicting <> 0 then
        raise exception 'Media ownership blocked: % file(s) claim two owners', conflicting;
      end if;

      select count(*) into bad_company from file_objects file
        where file.owner_type = 'company'
          and not exists (select 1 from companies c where c.id = file.company_id);
      if bad_company <> 0 then
        raise exception 'Media ownership blocked: % Company-owned file(s) name a missing Company', bad_company;
      end if;

      select count(*) into bad_commerce from file_objects file
        where file.owner_type = 'trader_commerce'
          and not exists (
            select 1 from trader_commerce_profiles p where p.id = file.trader_commerce_id
          );
      if bad_commerce <> 0 then
        raise exception 'Media ownership blocked: % Commerce-owned file(s) name a missing Commerce identity', bad_commerce;
      end if;

      -- Reported, not fatal: a file referenced by BOTH Commerce and operational
      -- structures stays Company-owned by design. It is surfaced so the
      -- conflict is a decision someone makes, not one the migration made.
      select count(*) into shared from file_objects file
        where file.owner_type = 'company'
          and (
            exists (select 1 from trader_storefronts s
                     where s.logo_file_id = file.id or s.cover_file_id = file.id)
            or exists (select 1 from trader_storefront_categories c where c.image_file_id = file.id)
            or exists (select 1 from trader_storefront_product_media m
                        where m.file_id = file.id or m.poster_file_id = file.id)
          );
      if shared <> 0 then
        raise warning 'Media ownership: % file(s) are referenced by Commerce structures but remain Company-owned because they are also used operationally', shared;
      end if;
    end
    $$
  `.execute(database);

  // ----------------------------------- Stage F: Company requirement relaxed

  await sql`alter table file_objects alter column company_id drop not null`.execute(database);
  await sql`alter table file_objects alter column owner_type set not null`.execute(database);

  // The uploader must still be a real account when there is no Company to
  // validate it against. See the header note on MATCH SIMPLE.
  await sql`
    alter table file_objects
      add constraint file_objects_uploader_account_fk
      foreign key (uploaded_by_account_id) references accounts (id) on delete restrict
  `.execute(database);

  // ------------------------------------------- Stage G: final constraints

  await sql`
    alter table file_objects
      add constraint file_objects_owner_type_check check (
        owner_type in ('company', 'trader_commerce')
      ),
      add constraint file_objects_owner_shape_check check (
        (owner_type = 'company' and company_id is not null and trader_commerce_id is null)
        or
        (owner_type = 'trader_commerce' and trader_commerce_id is not null and company_id is null)
      )
  `.execute(database);
  await sql`
    alter table file_objects
      add constraint file_objects_trader_commerce_fk
      foreign key (trader_commerce_id) references trader_commerce_profiles (id) on delete restrict
  `.execute(database);
  await sql`
    create index file_objects_commerce_created_index
      on file_objects (trader_commerce_id, created_at desc)
      where trader_commerce_id is not null
  `.execute(database);

  // ------------------------------ Stage H: zero-Company Commerce media probe

  // Builds a Commerce identity with no Delivery Company, a Store with NULL
  // Company columns, a Product, a Commerce-owned file and a media relation
  // pointing at it -- then removes all of it. If any constraint still demands a
  // Company anywhere in that path, this migration fails and unwinds instead of
  // reporting success and leaving the discovery to a later upload attempt.
  await sql`
    do $$
    declare
      probe_commerce uuid;
      probe_storefront uuid;
      probe_category uuid;
      probe_product uuid;
      probe_logo uuid;
      probe_image uuid;
      probe_tag text := replace(gen_random_uuid()::text, '-', '');
    begin
      insert into trader_commerce_profiles (public_name, registration_source, approval_status)
        values ('Zero Company Media Probe', 'trader_self_registered', 'approved')
        returning id into probe_commerce;

      insert into file_objects (
        owner_type, trader_commerce_id, storage_provider, storage_key,
        original_filename, media_type, size_bytes, classification, scan_status
      ) values (
        'trader_commerce', probe_commerce, 'local',
        'commerce/' || probe_commerce::text || '/stores/probe/branding/logo/' || probe_tag,
        'logo.png', 'image/png', 1234, 'private', 'clean'
      ) returning id into probe_logo;

      insert into trader_storefronts (
        trader_commerce_id, display_name, slug, business_template, theme, logo_file_id
      ) values (
        probe_commerce, 'Zero Company Media Probe', 'zero-media-probe-' || probe_tag,
        'general', 'modern', probe_logo
      ) returning id into probe_storefront;

      insert into trader_storefront_categories (storefront_id, name_en, slug)
        values (probe_storefront, 'Probe', 'probe') returning id into probe_category;

      insert into trader_storefront_products (
        storefront_id, category_id, name, slug, product_code, selling_price
      ) values (
        probe_storefront, probe_category, 'Probe', 'probe-product', 'PROBE-M1', 10
      ) returning id into probe_product;

      insert into file_objects (
        owner_type, trader_commerce_id, storage_provider, storage_key,
        original_filename, media_type, size_bytes, classification, scan_status
      ) values (
        'trader_commerce', probe_commerce, 'local',
        'commerce/' || probe_commerce::text || '/stores/probe/products/probe/images/' || probe_tag,
        'image.png', 'image/png', 2345, 'private', 'clean'
      ) returning id into probe_image;

      insert into trader_storefront_product_media (
        storefront_id, product_id, media_type, file_id, is_primary, is_active, display_order
      ) values (
        probe_storefront, probe_product, 'image', probe_image, true, true, 0
      );

      raise notice 'Zero-Company Commerce media model verified';

      delete from trader_storefront_product_media where storefront_id = probe_storefront;
      delete from trader_storefront_products where storefront_id = probe_storefront;
      delete from trader_storefront_categories where storefront_id = probe_storefront;
      update trader_storefronts set logo_file_id = null where id = probe_storefront;
      delete from trader_storefronts where id = probe_storefront;
      delete from file_objects where id in (probe_logo, probe_image);
      delete from trader_commerce_profiles where id = probe_commerce;
    end
    $$
  `.execute(database);

  await sql`
    do $$
    declare
      leftovers bigint;
    begin
      select count(*) into leftovers from trader_commerce_profiles
        where public_name = 'Zero Company Media Probe';
      if leftovers <> 0 then
        raise exception 'Media ownership blocked: probe rows were not fully removed';
      end if;
    end
    $$
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  // Commerce-owned files created BEFORE this migration are returned to the
  // Company that owned them; the Storefront's legacy `company_id` is the only
  // place that answer still exists. A Commerce file whose Store has no Company
  // -- the zero-Company case this migration exists to enable -- has no answer,
  // and the `set not null` below will fail rather than fabricate one.
  await sql`
    update file_objects
       set company_id = storefront.company_id,
           trader_commerce_id = null,
           owner_type = 'company'
      from trader_storefronts storefront
     where storefront.trader_commerce_id = file_objects.trader_commerce_id
       and storefront.company_id is not null
       and file_objects.owner_type = 'trader_commerce'
  `.execute(database);

  await sql`drop index if exists file_objects_commerce_created_index`.execute(database);
  await sql`
    alter table file_objects
      drop constraint if exists file_objects_trader_commerce_fk,
      drop constraint if exists file_objects_owner_shape_check,
      drop constraint if exists file_objects_owner_type_check,
      drop constraint if exists file_objects_uploader_account_fk
  `.execute(database);
  await sql`alter table file_objects alter column company_id set not null`.execute(database);
  await sql`
    alter table file_objects
      drop column if exists trader_commerce_id,
      drop column if exists owner_type
  `.execute(database);
}
