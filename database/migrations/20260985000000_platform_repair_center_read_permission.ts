import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Read-only permission for the Platform Repair Center of a selected Company
 * (`PlatformRepairCenterController`: Company Order Health summary and list,
 * and the Verify First drill-down).
 *
 * This migration touches ONLY the permission catalogue and the Platform super
 * administrator role. It reads and writes no Company and no business data.
 * No repair / reset / reverse / reprocess permission is seeded: those
 * behaviours do not exist yet.
 *
 * Same shape as 20260983000000_platform_company_accounting_mode_permission.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions (code, description)
    values ('platform.companies.repair_center.read',
            'View a selected Company''s Repair Center health checks (read-only)')
    on conflict (code) do update set description = excluded.description;

    insert into role_permissions (role_id, permission_code)
    select r.id, 'platform.companies.repair_center.read' from roles r
     where r.company_id is null and lower(r.code) = 'platform_super_admin'
    on conflict do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code = 'platform.companies.repair_center.read';
    delete from permissions where code = 'platform.companies.repair_center.read';
  `.execute(database);
}
