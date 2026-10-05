import { sql, type Kysely } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Adds least-privilege Company permissions for Employee and Driver master data.
 * Company administrators continue to use users_roles.manage as the fallback.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions (code, description)
    values
      ('employees.view', 'View Company Employees'),
      ('employees.create', 'Create Company Employees'),
      ('employees.edit', 'Edit Company Employees'),
      ('drivers.view', 'View Company Drivers'),
      ('drivers.create', 'Create Company Drivers'),
      ('drivers.edit', 'Edit Company Drivers')
    on conflict (code) do update set description = excluded.description
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions
    where permission_code in (
      'employees.view', 'employees.create', 'employees.edit',
      'drivers.view', 'drivers.create', 'drivers.edit'
    )
  `.execute(database);
  await sql`
    delete from permissions
    where code in (
      'employees.view', 'employees.create', 'employees.edit',
      'drivers.view', 'drivers.create', 'drivers.edit'
    )
  `.execute(database);
}
