import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table company_websites (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null unique references companies(id) on delete restrict,
      slug text not null,
      status text not null default 'draft' check (status in ('draft','published','disabled')),
      enabled boolean not null default true,
      published boolean not null default false,
      template_key text not null default 'corporate',
      published_template_key text,
      draft_settings jsonb not null default '{}'::jsonb,
      published_settings jsonb,
      primary_language text not null default 'en' check (primary_language in ('en','ar')),
      default_locale text not null default 'en' check (default_locale in ('en','ar')),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      published_at timestamptz, disabled_at timestamptz,
      last_published_by_account_id uuid references accounts(id) on delete restrict,
      last_updated_by_account_id uuid not null references accounts(id) on delete restrict,
      version integer not null default 1,
      constraint company_websites_slug_format check (slug = lower(btrim(slug)) and slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
      constraint company_websites_template_check check (template_key in ('corporate','modern','express','local','premium')),
      constraint company_websites_published_template_check check (published_template_key is null or published_template_key in ('corporate','modern','express','local','premium')),
      constraint company_websites_lifecycle_check check (
        (status = 'draft' and enabled and not published and published_at is null and published_template_key is null and published_settings is null and disabled_at is null)
        or (status = 'published' and enabled and published and published_at is not null and published_template_key is not null and published_settings is not null and disabled_at is null and last_published_by_account_id is not null)
        or (status = 'disabled' and not enabled and published and published_at is not null and published_template_key is not null and published_settings is not null and disabled_at is not null and last_published_by_account_id is not null)
      )
    );
    create unique index company_websites_slug_unique on company_websites (lower(slug));

    create function validate_company_website_slug() returns trigger language plpgsql as $$
    begin
      if lower(new.slug) in ('admin','api','app','assets','auth','cdn','dashboard','help','internal','mail','platform','static','status','store','support','www') then
        raise exception 'company_website_slug_reserved' using errcode = '23514';
      end if;
      if exists (select 1 from companies c where lower(c.subdomain) || 'app' = lower(new.slug)) then
        raise exception 'company_website_slug_collides_with_application' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger validate_company_website_slug_trigger before insert or update of slug on company_websites for each row execute function validate_company_website_slug();

    create function validate_company_app_slug_collision() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from company_websites w where lower(w.slug) = lower(new.subdomain) || 'app') then
        raise exception 'company_application_slug_collides_with_website' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger validate_company_app_slug_collision_trigger before insert or update of subdomain on companies for each row execute function validate_company_app_slug_collision();

    insert into permissions (code, description) values ('platform.company_websites.manage', 'Configure, preview, publish, enable and disable Delivery Company websites') on conflict (code) do nothing;
    insert into role_permissions (role_id, permission_code)
      select r.id, 'platform.company_websites.manage' from roles r
       where r.company_id is null and lower(r.code) = 'platform_super_admin'
      on conflict do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code = 'platform.company_websites.manage';
    delete from permissions where code = 'platform.company_websites.manage';
    drop trigger if exists validate_company_app_slug_collision_trigger on companies;
    drop function if exists validate_company_app_slug_collision();
    drop trigger if exists validate_company_website_slug_trigger on company_websites;
    drop function if exists validate_company_website_slug();
    drop table if exists company_websites;
  `.execute(database);
}
