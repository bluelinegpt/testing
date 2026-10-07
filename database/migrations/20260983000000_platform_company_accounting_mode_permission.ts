import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Permission for switching a selected Company's GL Accounting ON or OFF from
 * Platform Administration (`PlatformCompanyAccountingController`).
 *
 * This migration touches ONLY the permission catalogue and the Platform super
 * administrator role. It reads and writes no Company, no
 * `accounting_configurations` row and no business data: every Company keeps
 * exactly the `accounting_enabled` value it has today. The mode only changes
 * when an administrator later executes the readiness- and
 * unresolved-work-checked operation for one Company.
 *
 * Same shape as 20260822000000_company_reset_permission.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions (code, description)
    values ('platform.companies.accounting_mode.manage',
            'Enable or disable GL Accounting for a selected Company')
    on conflict (code) do update set description = excluded.description;

    insert into role_permissions (role_id, permission_code)
    select r.id, 'platform.companies.accounting_mode.manage' from roles r
     where r.company_id is null and lower(r.code) = 'platform_super_admin'
    on conflict do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code = 'platform.companies.accounting_mode.manage';
    delete from permissions where code = 'platform.companies.accounting_mode.manage';
  `.execute(database);
}
