import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

// Company Profile / branding, Phase A.
//
// Additive and reversible. The `companies` table already carries `name_en`
// (not null), `name_ar`, `telephone`, `email` and a `logo_file_id` foreign key
// into `file_objects`, so this migration only adds the missing bilingual
// subtitle columns. Logo metadata (original filename, media type, size, sha256,
// uploader) continues to live on `file_objects` referenced by
// `companies.logo_file_id` — no duplicate `logo_*` columns are introduced.
//
// The per-user "Text Language" preference reuses the existing
// `accounts.preferred_language` column (text not null default 'en', checked
// en/ar), so no account schema change is required.
//
// A narrow `company_profile.manage` permission is seeded and granted to every
// role that already holds `users_roles.manage`, so existing Company
// Administrators keep uninterrupted access to Company configuration.
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies add column subtitle_en text;
    alter table companies add column subtitle_ar text;

    insert into permissions (code, description)
    values ('company_profile.manage', 'Manage the Company profile, branding and logo')
    on conflict (code) do nothing;

    insert into role_permissions (role_id, permission_code)
    select rp.role_id, 'company_profile.manage'
    from role_permissions rp
    where rp.permission_code = 'users_roles.manage'
    on conflict (role_id, permission_code) do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code = 'company_profile.manage';
    delete from permissions where code = 'company_profile.manage';

    alter table companies drop column subtitle_ar;
    alter table companies drop column subtitle_en;
  `.execute(database);
}
