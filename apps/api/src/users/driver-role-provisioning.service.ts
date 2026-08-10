import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql, type Transaction } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

type DatabaseExecutor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

/**
 * A Driver User's operational access, provisioned automatically -- never a
 * manual "which Role do I pick for a Driver" decision left to an
 * administrator.
 *
 * ===========================================================================
 * WHY A DEDICATED ROLE, NOT THE OFFICE "Orders" ROLE
 * ===========================================================================
 *
 * The `Orders` role predating this service was built for office Order
 * Operators: it carries `orders.create`, `orders.assign_driver`, and — by
 * whatever permission set an administrator happened to add to it —
 * `financial_transactions.reverse` and `journals.create_manual`. A Driver
 * User assigned that role for lack of any purpose-built alternative
 * inherited every one of those office/financial powers along with it. This
 * role is the alternative: it grants exactly one permission,
 * `orders.driver_self_service`, which unlocks the Orders List/Detail
 * endpoints and nothing else -- ownership scoping and the narrower Driver
 * transition set are enforced independently in
 * `OperationsService.changeOrderStatus`, not by this permission.
 *
 * ===========================================================================
 * ADDITIVE, IDEMPOTENT, NEVER DESTRUCTIVE
 * ===========================================================================
 *
 * Every method here only ever ADDS the Driver role or removes exactly that
 * one role -- never any other Role an account might also legitimately hold.
 * Re-running any of these for an account that already has the expected state
 * is a safe no-op (`on conflict do nothing` throughout).
 */
@Injectable()
export class DriverRoleProvisioningService {
  public static readonly ROLE_CODE = "driver_operations";
  public static readonly ROLE_NAME = "Driver Operations";
  public static readonly PERMISSIONS = ["orders.driver_self_service"] as const;

  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  /** True when the Employee is backed by a Driver record -- the sole
   *  condition that makes a linked Company User a "Driver User". */
  public async isDriverBackedEmployee(
    executor: DatabaseExecutor | undefined,
    companyId: string,
    employeeId: string,
  ): Promise<boolean> {
    const result = await sql<{ exists: boolean }>`
      select exists(
        select 1 from drivers where employee_id = ${employeeId}::uuid and company_id = ${companyId}::uuid
      ) as exists
    `.execute(executor ?? this.database);
    return result.rows[0]?.exists === true;
  }

  /** Find-or-create the Company's Driver role. Idempotent; also guards
   *  against permission drift on a role created by an earlier deployment. */
  private async ensureRole(executor: DatabaseExecutor, companyId: string): Promise<string> {
    const inserted = await sql<{ id: string }>`
      insert into roles (company_id, code, name, description, is_active, is_system)
      select ${companyId}::uuid, ${DriverRoleProvisioningService.ROLE_CODE},
             ${DriverRoleProvisioningService.ROLE_NAME},
             'System-managed: a Driver User''s own Orders only. Never grants office/admin Order powers.',
             true, true
       where not exists (
         select 1 from roles
          where company_id = ${companyId}::uuid
            and lower(code) = ${DriverRoleProvisioningService.ROLE_CODE}
       )
      returning id
    `.execute(executor);
    const roleId =
      inserted.rows[0]?.id ??
      (
        await sql<{ id: string }>`
          select id from roles
           where company_id = ${companyId}::uuid and lower(code) = ${DriverRoleProvisioningService.ROLE_CODE}
        `.execute(executor)
      ).rows[0]?.id;
    if (roleId === undefined) {
      throw new Error("Driver Operations role could not be created or resolved");
    }
    for (const permission of DriverRoleProvisioningService.PERMISSIONS) {
      await sql`
        insert into role_permissions(role_id, permission_code) values(${roleId}::uuid, ${permission})
        on conflict do nothing
      `.execute(executor);
    }
    return roleId;
  }

  /**
   * Ensures `accountId` holds the Driver role. Additive and idempotent —
   * every other Role the account holds is untouched. Returns `true` only
   * when the role was newly granted, so the caller knows whether a session
   * refresh is actually needed.
   */
  public async ensureAssigned(
    executor: DatabaseExecutor,
    companyId: string,
    accountId: string,
  ): Promise<boolean> {
    const roleId = await this.ensureRole(executor, companyId);
    const assigned = await sql<{ accountId: string }>`
      insert into account_roles (account_id, role_id, company_id)
      values (${accountId}::uuid, ${roleId}::uuid, ${companyId}::uuid)
      on conflict (account_id, role_id) do nothing
      returning account_id as "accountId"
    `.execute(executor);
    return assigned.rows.length > 0;
  }

  /**
   * The one call every "link a Company User to an Employee" code path
   * should make. A no-op — returns `false` — for an Employee that does not
   * back a Driver record, so an ordinary office Employee's User is never
   * affected.
   */
  public async provisionForEmployeeLink(
    executor: DatabaseExecutor,
    companyId: string,
    employeeId: string,
    accountId: string,
  ): Promise<boolean> {
    if (!(await this.isDriverBackedEmployee(executor, companyId, employeeId))) return false;
    const granted = await this.ensureAssigned(executor, companyId, accountId);
    if (granted) await this.revokeSessions(executor, accountId);
    return granted;
  }

  /**
   * Removes the Driver role from one account — used when the Employee that
   * backed it stops being a Driver (the Driver record is deactivated or its
   * Employee link is cleared). Never touches any other Role the account may
   * hold; a User who also does legitimate office work keeps that access.
   */
  public async revoke(
    executor: DatabaseExecutor,
    companyId: string,
    accountId: string,
  ): Promise<boolean> {
    const role = await sql<{ id: string }>`
      select id from roles
       where company_id = ${companyId}::uuid and lower(code) = ${DriverRoleProvisioningService.ROLE_CODE}
    `.execute(executor);
    const roleId = role.rows[0]?.id;
    if (roleId === undefined) return false;
    const removed = await sql<{ accountId: string }>`
      delete from account_roles
       where account_id = ${accountId}::uuid and role_id = ${roleId}::uuid and company_id = ${companyId}::uuid
      returning account_id as "accountId"
    `.execute(executor);
    const revoked = removed.rows.length > 0;
    if (revoked) await this.revokeSessions(executor, accountId);
    return revoked;
  }

  /** Same `account_sessions.revoked_at` convention every other
   *  permission-affecting change in this codebase already uses (see
   *  `UserAdministrationService`'s own `revokeAll`) — a fresh login is
   *  required to pick up the corrected permission set. */
  private async revokeSessions(executor: DatabaseExecutor, accountId: string): Promise<void> {
    await sql`
      update account_sessions set revoked_at = coalesce(revoked_at, now())
       where account_id = ${accountId}::uuid and revoked_at is null
    `.execute(executor);
  }
}
