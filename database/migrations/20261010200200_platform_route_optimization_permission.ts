import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Platform permission to switch route optimization on or off for a Company,
 * choose its provider, set its daily engine-call budget and flip the
 * Platform-wide kill switch. Granted to the Platform super administrator role
 * only; reading follows the existing `platform.companies.read`.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions (code, description)
    values ('platform.company_route_optimization.manage',
            'Enable and configure Driver route optimization for a Company')
    on conflict (code) do nothing
  `.execute(database);
  await sql`
    insert into role_permissions (role_id, permission_code)
    select r.id, 'platform.company_route_optimization.manage'
      from roles r
     where r.company_id is null
       and lower(r.code) = 'platform_super_admin'
    on conflict (role_id, permission_code) do nothing
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code = 'platform.company_route_optimization.manage'
  `.execute(database);
  await sql`
    delete from permissions where code = 'platform.company_route_optimization.manage'
  `.execute(database);
}
