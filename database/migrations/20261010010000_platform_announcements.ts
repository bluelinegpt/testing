import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Platform announcements: a banner the Platform shows to Companies, for
 * example "Planned maintenance on 14 October, 05:00-06:00".
 *
 * `platform_announcements` is Platform-owned (no `company_id`): one message,
 * in English and/or Arabic, shown between `show_from` and `show_until` on the
 * chosen surfaces (`office_web`, `trader_portal`, `mobile_app`).
 *
 * `platform_announcement_companies` lists the target Companies when the
 * audience is `selected_companies`; it is empty for `all_companies`. It is the
 * only table here with a `company_id`, so it is the one the reset and
 * deletion manifests classify.
 *
 * Nothing is ever hard-deleted: an announcement is ended (`show_until` moved
 * to now) or cancelled. `version` grows on every edit so a banner a user
 * closed shows again once its wording changes.
 *
 * Editors are PLATFORM accounts (company_id is null), so the actor columns
 * use a plain FK to accounts(id), like other Platform-administered records.
 *
 * Additive only: two new tables and two permission codes on the Platform
 * super administrator role. No existing row is read or changed.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table platform_announcements (
      id uuid primary key default gen_random_uuid(),
      type text not null,
      title_en text,
      title_ar text,
      body_en text,
      body_ar text,
      show_from timestamptz not null,
      show_until timestamptz not null,
      surfaces text[] not null,
      audience text not null,
      status text not null default 'active',
      version integer not null default 1,
      created_by_account_id uuid not null references accounts(id) on delete restrict,
      updated_by_account_id uuid not null references accounts(id) on delete restrict,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint platform_announcements_type_check
        check (type in ('info', 'warning', 'critical')),
      constraint platform_announcements_status_check
        check (status in ('active', 'cancelled')),
      constraint platform_announcements_audience_check
        check (audience in ('all_companies', 'selected_companies')),
      constraint platform_announcements_window_check check (show_until > show_from),
      constraint platform_announcements_surfaces_check check (
        cardinality(surfaces) > 0
        and surfaces <@ array['office_web', 'trader_portal', 'mobile_app']::text[]
      ),
      -- Each language is optional, but a language that is used must have both
      -- a title and a body, and at least one language must be used.
      constraint platform_announcements_language_check check (
        ((title_en is null) = (body_en is null))
        and ((title_ar is null) = (body_ar is null))
        and (title_en is not null or title_ar is not null)
      ),
      constraint platform_announcements_length_check check (
        coalesce(length(title_en), 0) <= 120 and coalesce(length(title_ar), 0) <= 120
        and coalesce(length(body_en), 0) <= 600 and coalesce(length(body_ar), 0) <= 600
      ),
      constraint platform_announcements_version_positive check (version > 0)
    )
  `.execute(database);

  await sql`
    create index platform_announcements_live_idx
      on platform_announcements (show_until, show_from)
      where status = 'active'
  `.execute(database);

  await sql`
    create table platform_announcement_companies (
      announcement_id uuid not null references platform_announcements(id) on delete cascade,
      company_id uuid not null references companies(id) on delete restrict,
      created_at timestamptz not null default now(),
      primary key (announcement_id, company_id)
    )
  `.execute(database);

  await sql`
    create index platform_announcement_companies_company_idx
      on platform_announcement_companies (company_id)
  `.execute(database);

  await sql`
    insert into permissions (code, description)
    values
      ('platform.announcements.read', 'View Platform announcements to Companies'),
      ('platform.announcements.manage',
       'Create, edit, end and cancel Platform announcements to Companies')
    on conflict (code) do update set description = excluded.description;

    insert into role_permissions (role_id, permission_code)
    select r.id, p.code
      from roles r
     cross join (values ('platform.announcements.read'), ('platform.announcements.manage')) p(code)
     where r.company_id is null and lower(r.code) = 'platform_super_admin'
    on conflict do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions
     where permission_code in ('platform.announcements.read', 'platform.announcements.manage');
    delete from permissions
     where code in ('platform.announcements.read', 'platform.announcements.manage');
  `.execute(database);
  await sql`drop table if exists platform_announcement_companies`.execute(database);
  await sql`drop table if exists platform_announcements`.execute(database);
}
