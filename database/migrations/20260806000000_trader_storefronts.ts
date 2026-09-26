import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Trader Storefront profile and configuration — foundation.
 *
 * ---------------------------------------------------------------------------
 * THE SLUG IS A GLOBAL NAMESPACE; EVERYTHING ELSE IS TENANT-SCOPED
 * ---------------------------------------------------------------------------
 *
 * `/store/al-noor-fashion` has no Company in it. That single fact makes the
 * slug the one column in this schema that cannot be scoped by `company_id`:
 * two Companies claiming the same slug would resolve to the same public URL.
 * So the slug carries a GLOBAL unique index on its lowercase form, while every
 * other access path is scoped to the owning Company.
 *
 * Case-insensitivity is enforced by the index, not by trusting callers to
 * lowercase first. `AL-Noor` and `al-noor` are the same public address and the
 * database is where that has to be true, because an availability check is a
 * read: two requests can both be told "available" microseconds apart and only
 * the index decides which one actually gets it.
 *
 * ---------------------------------------------------------------------------
 * WHY SLUG HISTORY IS INSERT-ONLY AND OUTLIVES THE STOREFRONT
 * ---------------------------------------------------------------------------
 *
 * A published Storefront's URL has been shared — in a WhatsApp message, on a
 * printed card, in someone's browser history. When a Trader changes it, the
 * old address must not become claimable by a DIFFERENT Trader, or those links
 * would silently start pointing at a stranger's shop. `trader_storefront_slugs`
 * therefore keeps every slug a Storefront has ever published under, carries the
 * same global unique index, and is never cleaned up when a Storefront is
 * unpublished or suspended.
 *
 * The redirect behaviour that consumes this history is deliberately NOT
 * implemented here — only the data it will need. Retaining the reservation is
 * the part that cannot be added retroactively; the redirect can.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP IS ENFORCED BY THE SCHEMA, NOT BY THE SERVICE
 * ---------------------------------------------------------------------------
 *
 * A Storefront belongs to one Trader and one Company, and that Trader must
 * belong to that same Company. A composite foreign key to
 * `traders (company_id, id)` makes the three-way agreement structural: no
 * service bug can attach a Storefront to a Trader in another Company, because
 * the row will not insert.
 *
 * `trader_id` is UNIQUE on its own, which is what "one Storefront per Trader
 * for the MVP" means. Relaxing it later is an additive change; discovering
 * duplicates later is not.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  // The composite target the Storefront's ownership FK needs. `id` is already
  // the primary key, so this adds no new uniqueness -- it only makes the pair
  // referenceable, which is what lets the schema state "same Company".
  await sql`
    create unique index if not exists traders_company_identity_key
      on traders (company_id, id)
  `.execute(database);

  await sql`
    create table trader_storefronts (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      trader_id uuid not null,

      -- The display name is what customers read; the slug is the address they
      -- arrive at. They are separate because two Traders may legitimately both
      -- trade as "Al Noor Fashion", but only one can own /store/al-noor-fashion.
      display_name text not null,
      slug text not null,

      business_template text not null,
      theme text not null,

      logo_file_id uuid references file_objects(id) on delete set null,
      cover_file_id uuid references file_objects(id) on delete set null,
      brand_primary_color text,
      brand_accent_color text,

      store_description text,
      public_mobile text,
      public_whatsapp text,
      public_email text,

      -- Structured operational copy. Business hours are a validated array of
      -- {days,time} entries rather than free text so a template can render
      -- them; the policy fields are plain text and are rendered as text, never
      -- as markup.
      business_hours jsonb not null default '[]'::jsonb,
      delivery_information text,
      return_policy text,
      terms text,
      customer_support text,

      status text not null default 'draft',
      published_at timestamptz,

      -- Suspension is an ADMINISTRATIVE act. It is recorded separately from
      -- status so that lifting it is auditable and so a Trader-initiated
      -- status change can never clear it: the service refuses, and these
      -- columns preserve who imposed it and why regardless.
      suspended_at timestamptz,
      suspended_by_account_id uuid,
      suspension_reason text,

      created_by_account_id uuid,
      updated_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,

      constraint trader_storefronts_trader_unique unique (trader_id),
      constraint trader_storefronts_company_trader_fk
        foreign key (company_id, trader_id)
        references traders (company_id, id) on delete restrict,

      constraint trader_storefronts_status_check check (
        status in ('draft', 'published', 'temporarily_closed', 'unpublished', 'suspended')
      ),
      constraint trader_storefronts_template_check check (
        business_template in ('fashion', 'electronics', 'jewelry', 'general')
      ),
      constraint trader_storefronts_theme_check check (
        theme in ('luxury_minimal', 'modern', 'clean_light')
      ),

      -- Shape, enforced here rather than only in the DTO. The slug is a public
      -- route segment: lowercase alphanumerics and single interior hyphens,
      -- nothing that could alter how a URL parses.
      constraint trader_storefronts_slug_shape_check check (
        slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 63
      ),
      constraint trader_storefronts_display_name_check check (
        length(btrim(display_name)) > 0
      ),
      -- Colours are injected into a stylesheet. Constraining them to six-digit
      -- hex means no value from this column can ever close a declaration and
      -- start another.
      constraint trader_storefronts_primary_color_check check (
        brand_primary_color is null or brand_primary_color ~ '^#[0-9a-f]{6}$'
      ),
      constraint trader_storefronts_accent_color_check check (
        brand_accent_color is null or brand_accent_color ~ '^#[0-9a-f]{6}$'
      ),
      constraint trader_storefronts_hours_shape_check check (
        jsonb_typeof(business_hours) = 'array' and jsonb_array_length(business_hours) <= 14
      ),
      -- A publicly resolvable Storefront must carry the moment it went public.
      -- Stated one-directionally on purpose: unpublished and suspended KEEP
      -- their published_at (they were public once, and that is history), and
      -- a Storefront suspended before it ever published legitimately has none.
      constraint trader_storefronts_published_shape_check check (
        status not in ('published', 'temporarily_closed') or published_at is not null
      ),
      constraint trader_storefronts_suspension_shape_check check (
        (status = 'suspended') = (suspended_at is not null)
      )
    )
  `.execute(database);

  // THE authoritative slug uniqueness. Global and case-insensitive: the public
  // namespace has no tenant dimension.
  await sql`
    create unique index trader_storefronts_slug_unique
      on trader_storefronts (lower(slug))
  `.execute(database);

  await sql`
    create index trader_storefronts_company_idx on trader_storefronts (company_id)
  `.execute(database);
  await sql`
    create index trader_storefronts_status_idx on trader_storefronts (status)
  `.execute(database);

  await sql`
    create table trader_storefront_slugs (
      id uuid primary key default gen_random_uuid(),
      storefront_id uuid not null references trader_storefronts(id) on delete restrict,
      company_id uuid not null references companies(id) on delete restrict,
      slug text not null,
      released_at timestamptz not null default now(),
      released_by_account_id uuid,
      constraint trader_storefront_slugs_shape_check check (
        slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      )
    )
  `.execute(database);

  // Retired slugs share the live namespace: a slug someone still has a link to
  // cannot be handed to a different Trader.
  await sql`
    create unique index trader_storefront_slugs_unique
      on trader_storefront_slugs (lower(slug))
  `.execute(database);
  await sql`
    create index trader_storefront_slugs_storefront_idx
      on trader_storefront_slugs (storefront_id)
  `.execute(database);

  // History is evidence, so it is insert-only. `on delete restrict` above plus
  // this trigger mean a Storefront that ever published cannot be erased along
  // with the record of the addresses it occupied.
  await sql`
    create or replace function trader_storefront_slugs_insert_only()
    returns trigger language plpgsql as $$
    begin
      raise exception 'trader_storefront_slugs is insert-only'
        using errcode = 'restrict_violation';
    end;
    $$
  `.execute(database);
  await sql`
    create trigger trader_storefront_slugs_no_change
      before update or delete on trader_storefront_slugs
      for each row execute function trader_storefront_slugs_insert_only()
  `.execute(database);

  // Ownership is frozen at insert. A Storefront moving between Traders or
  // Companies would silently transfer a public address and everything that
  // will later hang off it.
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
  await sql`
    create trigger trader_storefronts_ownership_frozen
      before update on trader_storefronts
      for each row execute function trader_storefronts_freeze_ownership()
  `.execute(database);

  await sql`
    insert into permissions (code, description) values
      ('storefront.view', 'View Trader Storefront configuration'),
      ('storefront.manage', 'Create and edit Trader Storefront configuration'),
      ('storefront.publish', 'Publish, close, reopen and unpublish a Trader Storefront'),
      ('storefront.suspend', 'Suspend a Trader Storefront and remove a suspension')
    on conflict (code) do nothing
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`delete from permissions where code in (
    'storefront.view', 'storefront.manage', 'storefront.publish', 'storefront.suspend'
  )`.execute(database);
  await sql`drop trigger if exists trader_storefront_slugs_no_change on trader_storefront_slugs`.execute(
    database,
  );
  await sql`drop function if exists trader_storefront_slugs_insert_only()`.execute(database);
  await sql`drop trigger if exists trader_storefronts_ownership_frozen on trader_storefronts`.execute(
    database,
  );
  await sql`drop function if exists trader_storefronts_freeze_ownership()`.execute(database);
  await sql`drop table if exists trader_storefront_slugs`.execute(database);
  await sql`drop table if exists trader_storefronts`.execute(database);
  await sql`drop index if exists traders_company_identity_key`.execute(database);
}
