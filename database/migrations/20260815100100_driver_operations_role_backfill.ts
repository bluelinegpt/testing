import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Deterministic backfill: every Company User already linked to a
 * Driver-backed Employee, on every existing Company, gets the "Driver
 * Operations" role -- ADDITIVE ONLY.
 *
 * Scope is exact and narrow, matching `DriverRoleProvisioningService`'s own
 * definition of a Driver User going forward:
 *   - `employees.company_user_id` resolves an active Company User account;
 *   - that Employee is backed by a `drivers.employee_id` record.
 *
 * No existing role is touched or removed here -- this only ensures the
 * Driver role is present. A User who also legitimately holds an office role
 * keeps it; whether that combination is still appropriate is a judgment call
 * for a human, reported separately (see the accompanying task report), never
 * silently decided by a migration.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  const companies = await sql<{ id: string }>`
    select distinct e.company_id as id
      from employees e
      join drivers d on d.employee_id = e.id and d.company_id = e.company_id
     where e.company_user_id is not null
  `.execute(database);

  for (const { id: companyId } of companies.rows) {
    const role = await sql<{ id: string }>`
      insert into roles (company_id, code, name, description, is_active, is_system)
      select ${companyId}::uuid, 'driver_operations', 'Driver Operations',
             'System-managed: a Driver User''s own Orders only. Never grants office/admin Order powers.',
             true, true
      where not exists (
        select 1 from roles where company_id = ${companyId}::uuid and lower(code) = 'driver_operations'
      )
      returning id
    `.execute(database);
    const roleId =
      role.rows[0]?.id ??
      (
        await sql<{ id: string }>`
          select id from roles where company_id = ${companyId}::uuid and lower(code) = 'driver_operations'
        `.execute(database)
      ).rows[0]?.id;
    if (roleId === undefined) continue;

    await sql`
      insert into role_permissions (role_id, permission_code)
      values (${roleId}::uuid, 'orders.driver_self_service')
      on conflict do nothing
    `.execute(database);

    const assigned = await sql<{ accountId: string }>`
      insert into account_roles (account_id, role_id, company_id)
      select distinct cu.account_id, ${roleId}::uuid, ${companyId}::uuid
        from employees e
        join drivers d on d.employee_id = e.id and d.company_id = e.company_id
        join company_users cu on cu.id = e.company_user_id and cu.company_id = e.company_id
       where e.company_id = ${companyId}::uuid
      on conflict (account_id, role_id) do nothing
      returning account_id as "accountId"
    `.execute(database);

    for (const { accountId } of assigned.rows) {
      await sql`
        insert into audit_events (
          company_id, action, subject_type, subject_id, after_data, reason, correlation_id
        ) values (
          ${companyId}::uuid, 'account_role.driver_backfill_assigned', 'account', ${accountId}::uuid,
          jsonb_build_object('roleId', ${roleId}::text, 'roleCode', 'driver_operations'),
          'Deterministic backfill: Driver-linked Company User granted the Driver Operations role',
          ${`migration:20260815100100:${accountId}`}
        )
      `.execute(database);
    }
  }
}

export async function down(): Promise<void> {
  // Deliberately irreversible as a blanket rollback: removing the role would
  // strip access from every Driver User it was correctly granted to,
  // including ones assigned after this migration ran by the ordinary
  // provisioning path. Role removal, if ever needed, is a deliberate
  // per-account action, not a migration `down`.
}
