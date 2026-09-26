import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Permission for the Company test-data reset screen (Platform Administration).
 *
 * The reset engine itself has existed since Prompt 2A as a CLI-only tool; this
 * permission was deliberately NOT seeded back then, per the foundation
 * migration's own rule that a permission nothing enforces is a control that
 * appears to exist and does not. The Platform screen now exists, so the code
 * is seeded.
 *
 * The permission only grants access to the routes. The decisive gate lives in
 * the service: a Company whose `environment` is 'production' is refused
 * outright, with no bypass — holding this permission changes nothing for a
 * production Company.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions (code, description)
    values ('platform.companies.reset', 'Reset a development or demo Company''s transactional data')
    on conflict (code) do update set description = excluded.description;

    insert into role_permissions (role_id, permission_code)
    select r.id, 'platform.companies.reset' from roles r
     where r.company_id is null and lower(r.code) = 'platform_super_admin'
    on conflict do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code = 'platform.companies.reset';
    delete from permissions where code = 'platform.companies.reset';
  `.execute(database);
}
