import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Removes an office Role from a Driver-linked Company User's account when
 * that Role grants a permission a Driver must never hold.
 *
 * Deterministic scope only -- an account qualifies when ALL of:
 *   - it is linked (via `employees.company_user_id`) to an Employee backed
 *     by a `drivers.employee_id` record (a genuine Driver User);
 *   - it holds a Role granting at least one of the permissions a Driver must
 *     never have: assigning/reassigning a Driver, creating/editing Orders
 *     before processing, manual journals, or reversing a confirmed
 *     financial transaction.
 *
 * The prior migration already granted every such account the
 * `driver_operations` role additively, so removing the office Role here
 * never leaves the account without Order access.
 *
 * This is narrower than "every Role a Driver holds" on purpose: a Role that
 * grants none of those specific permissions is left alone, so a legitimate
 * dual-purpose assignment a human made deliberately is never silently
 * undone by a migration.
 */
const forbiddenForDrivers = [
  "orders.assign_driver",
  "orders.create",
  "orders.edit_before_processing",
  "financial_transactions.reverse",
  "journals.create_manual",
] as const;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  const removed = await sql<{
    accountId: string;
    companyId: string;
    roleId: string;
    roleName: string;
  }>`
    with driver_linked_accounts as (
      select distinct cu.account_id, e.company_id
        from employees e
        join drivers d on d.employee_id = e.id and d.company_id = e.company_id
        join company_users cu on cu.id = e.company_user_id and cu.company_id = e.company_id
    ),
    disqualified_roles as (
      select distinct ar.account_id, ar.role_id, dla.company_id
        from account_roles ar
        join driver_linked_accounts dla on dla.account_id = ar.account_id
        join role_permissions rp on rp.role_id = ar.role_id
       where rp.permission_code in (${sql.join(forbiddenForDrivers.map((code) => sql`${code}`))})
         -- Never remove the Driver role itself, however it is matched.
         and ar.role_id not in (select id from roles where lower(code) = 'driver_operations')
    ),
    deleted as (
      delete from account_roles ar
        using disqualified_roles dq
       where ar.account_id = dq.account_id and ar.role_id = dq.role_id
      returning ar.account_id, dq.company_id, dq.role_id
    )
    select deleted.account_id as "accountId", deleted.company_id as "companyId",
           deleted.role_id as "roleId", r.name as "roleName"
      from deleted join roles r on r.id = deleted.role_id
  `.execute(database);

  for (const row of removed.rows) {
    await sql`
      insert into audit_events (
        company_id, action, subject_type, subject_id, before_data, reason, correlation_id
      ) values (
        ${row.companyId}::uuid, 'account_role.driver_office_role_removed', 'account',
        ${row.accountId}::uuid,
        jsonb_build_object('roleId', ${row.roleId}::text, 'roleName', ${row.roleName}::text),
        'Deterministic repair: office Role granting Driver-inappropriate permissions removed from a Driver-linked Company User; the driver_operations role was already granted additively beforehand',
        ${`migration:20260815100200:${row.accountId}:${row.roleId}`}
      )
    `.execute(database);
  }
}

export async function down(): Promise<void> {
  // Deliberately irreversible: re-granting a removed office Role
  // automatically would recreate the exact privilege-escalation this
  // migration exists to close, for whichever account happened to match at
  // the time it ran. Restoring a Role, if ever genuinely needed, is a
  // deliberate per-account decision made by an administrator.
}
