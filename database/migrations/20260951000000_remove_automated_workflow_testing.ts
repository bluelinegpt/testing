import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Retire the removed Platform Workflow Testing feature.
 *
 * Its historical run records are deliberately retained. They are inert once
 * the controller and worker are removed, and preserving them avoids silently
 * destroying operational history during deployment.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions
     where permission_code in (
       'platform.workflow_tests.read',
       'platform.workflow_tests.manage'
     );

    delete from permissions
     where code in (
       'platform.workflow_tests.read',
       'platform.workflow_tests.manage'
     );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions(code, description) values
      ('platform.workflow_tests.read', 'View automated workflow tests and evidence'),
      ('platform.workflow_tests.manage', 'Configure and control automated workflow tests')
    on conflict(code) do update set description = excluded.description;

    insert into role_permissions(role_id, permission_code)
      select r.id, p.code
        from roles r
        cross join permissions p
       where r.company_id is null
         and lower(r.code) = 'platform_super_admin'
         and p.code in (
           'platform.workflow_tests.read',
           'platform.workflow_tests.manage'
         )
    on conflict do nothing;
  `.execute(database);
}
