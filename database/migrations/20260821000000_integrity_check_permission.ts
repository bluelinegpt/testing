import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Permission for the Integration Integrity Checker's read-only detector
 * screen (Platform Administration) -- agreed 2026-08-04 as the last piece
 * of the Accounting enhancement programme, shipped read-only first per that
 * decision. No table needed: every check is a live query re-derived from
 * current data, never a stored/cached result, so there is nothing here to
 * persist yet. See `IntegrityCheckService`'s own comment for the checks
 * themselves and why remediation is deliberately not part of this pass.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions (code, description)
    values ('platform.integrity.read', 'View cross-module data integrity findings on the Platform')
    on conflict (code) do update set description = excluded.description;

    insert into role_permissions (role_id, permission_code)
    select r.id, 'platform.integrity.read' from roles r
     where r.company_id is null and lower(r.code) = 'platform_super_admin'
    on conflict do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code = 'platform.integrity.read';
    delete from permissions where code = 'platform.integrity.read';
  `.execute(database);
}
