import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql, type Transaction } from "kysely";

import { PasswordHasher } from "../authentication/password-hasher.js";
import { TemporaryPasswordService } from "../authentication/temporary-password.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

export interface UserListInput {
  readonly accountKind?: string;
  readonly direction?: "asc" | "desc";
  readonly employee?: string;
  readonly page: number;
  readonly pageSize: number;
  readonly roleId?: string;
  readonly search?: string;
  readonly sort?: string;
  readonly status?: string;
}

export interface CompanyUserSummary {
  readonly accountKind: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly employeeCode: string | null;
  readonly employeeName: string | null;
  readonly failedLoginAttempts: number;
  readonly forcePasswordChange: boolean;
  readonly lastLoginAt: Date | null;
  readonly lockedUntil: Date | null;
  readonly mobileNumber: string | null;
  readonly roleIds: readonly string[];
  readonly roleNames: readonly string[];
  readonly status: string;
  readonly username: string;
}

export interface UserPage {
  readonly items: readonly CompanyUserSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

interface UserActionContext {
  readonly accountId: string;
  readonly accountKind: string;
  readonly companyId: string;
  readonly companyUserId: string | null;
  readonly forcePasswordChange: boolean;
  readonly status: string;
}

type UserDatabaseExecutor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

@Injectable()
export class UserAdministrationService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
    @Inject(TemporaryPasswordService) private readonly temporaryPasswords: TemporaryPasswordService,
  ) {}

  public async list(input: UserListInput): Promise<UserPage> {
    const { companyId } = this.tenants.current();
    const search = input.search?.trim();
    const offset = (input.page - 1) * input.pageSize;
    const sortColumns: Record<string, string> = {
      createdAt: "a.created_at",
      email: "a.email",
      lastLoginAt: "a.last_login_at",
      name: "coalesce(cu.display_name,a.username)",
      status: "a.status",
      username: "a.username",
    };
    const orderBy = sortColumns[input.sort ?? "name"] ?? "coalesce(cu.display_name,a.username)";
    const direction = input.direction === "desc" ? "desc" : "asc";
    const filters = sql`
      ${
        search === undefined
          ? sql``
          : sql`and (
        a.username ilike ${`%${search}%`} or cu.display_name ilike ${`%${search}%`}
        or linked_trader.name_en ilike ${`%${search}%`}
        or linked_driver.name_en ilike ${`%${search}%`}
        or linked_trader.email ilike ${`%${search}%`}
        or linked_trader.mobile_number ilike ${`%${search}%`}
        or a.email ilike ${`%${search}%`} or a.mobile_number ilike ${`%${search}%`}
      )`
      }
      ${input.status === undefined || input.status === "all" ? sql`` : input.status === "locked" ? sql`and (a.status = 'locked' or a.locked_until > now())` : sql`and a.status = ${input.status} and (a.locked_until is null or a.locked_until <= now())`}
      ${input.roleId === undefined ? sql`` : sql`and exists (select 1 from account_roles f_ar where f_ar.account_id = a.id and f_ar.role_id = ${input.roleId}::uuid)`}
      ${input.employee === undefined || input.employee === "all" ? sql`` : input.employee === "linked" ? sql`and e.id is not null` : sql`and e.id is null`}
      ${input.accountKind === undefined || input.accountKind === "all" ? sql`` : sql`and a.account_kind=${input.accountKind}`}
    `;
    const totalResult = await sql<{ total: number }>`
      select count(distinct a.id)::int as total
        from accounts a left join company_users cu on cu.account_id = a.id and cu.company_id = a.company_id
        left join employees e on e.company_user_id = cu.id and e.company_id = cu.company_id
        left join user_business_links profile_link on profile_link.account_id=a.id
          and profile_link.company_id=a.company_id
          and profile_link.access_status in ('invited','active','suspended')
        left join traders linked_trader on profile_link.entity_type='trader'
          and linked_trader.id=profile_link.entity_id and linked_trader.company_id=profile_link.company_id
        left join drivers linked_driver on profile_link.entity_type='driver'
          and linked_driver.id=profile_link.entity_id and linked_driver.company_id=profile_link.company_id
       where a.company_id = ${companyId}::uuid and a.account_kind<>'platform_user' ${filters}
    `.execute(this.database);
    const result = await sql<CompanyUserSummary>`
      select a.id as "accountId", a.account_kind as "accountKind",a.username,
             case when a.status = 'active' and a.locked_until > now() then 'locked' else a.status end as status,
             a.failed_login_attempts as "failedLoginAttempts", a.locked_until as "lockedUntil",
             a.last_login_at as "lastLoginAt", a.force_password_change as "forcePasswordChange",
             coalesce(cu.display_name,linked_trader.name_en,linked_driver.name_en,a.username) as "displayName",
             coalesce(a.email,linked_trader.email) as email,
             coalesce(a.mobile_number,linked_trader.mobile_number) as "mobileNumber",
             e.employee_number as "employeeCode", e.name_en as "employeeName",
             coalesce(array_agg(distinct r.id order by r.id) filter (where r.id is not null), array[]::uuid[])::text[] as "roleIds",
             coalesce(array_agg(distinct r.name order by r.name) filter (where r.id is not null), array[]::text[]) as "roleNames"
        from accounts a left join company_users cu on cu.account_id = a.id and cu.company_id = a.company_id
        left join employees e on e.company_user_id = cu.id and e.company_id = cu.company_id
        left join user_business_links profile_link on profile_link.account_id=a.id
          and profile_link.company_id=a.company_id
          and profile_link.access_status in ('invited','active','suspended')
        left join traders linked_trader on profile_link.entity_type='trader'
          and linked_trader.id=profile_link.entity_id and linked_trader.company_id=profile_link.company_id
        left join drivers linked_driver on profile_link.entity_type='driver'
          and linked_driver.id=profile_link.entity_id and linked_driver.company_id=profile_link.company_id
        left join account_roles ar on ar.account_id = a.id and ar.company_id = a.company_id
        left join roles r on r.id = ar.role_id
       where a.company_id = ${companyId}::uuid and a.account_kind<>'platform_user' ${filters}
       group by a.id, cu.id, e.id, linked_trader.id, linked_driver.id
       order by ${sql.raw(orderBy)} ${sql.raw(direction)}, a.id
       limit ${input.pageSize} offset ${offset}
    `.execute(this.database);
    return {
      items: result.rows,
      page: input.page,
      pageSize: input.pageSize,
      total: totalResult.rows[0]?.total ?? 0,
    };
  }

  public async details(accountId: string): Promise<object> {
    const { companyId } = this.tenants.current();
    const userResult = await sql<Record<string, unknown>>`
      select a.id as "accountId",a.account_kind as "accountKind",a.username,a.status,
             a.preferred_language as "preferredLanguage",
             a.failed_login_attempts as "failedLoginAttempts", a.locked_until as "lockedUntil",
             a.last_failed_login_at as "lastFailedLoginAt", a.last_login_at as "lastLoginAt",
             a.password_changed_at as "passwordChangedAt", a.force_password_change as "forcePasswordChange",
             a.temporary_password_expires_at as "temporaryPasswordExpiresAt",
             a.administrative_lock_reason as "lockReason", a.created_at as "createdAt", a.updated_at as "updatedAt",
             cu.id as "companyUserId",
             coalesce(cu.display_name,linked_trader.name_en,linked_driver.name_en,a.username) as "displayName",
             coalesce(a.email,linked_trader.email) as email,
             coalesce(a.mobile_number,linked_trader.mobile_number) as "mobileNumber",
             cu.name_en as "legacyNameEn", cu.name_ar as "legacyNameAr",
             e.id as "employeeId", e.employee_number as "employeeCode", e.name_en as "employeeName",
             e.job_title as "employeeJobTitle", case when e.is_active then 'active' else 'disabled' end as "employeeStatus"
        from accounts a left join company_users cu on cu.account_id = a.id and cu.company_id = a.company_id
        left join employees e on e.company_user_id = cu.id and e.company_id = cu.company_id
        left join user_business_links profile_link on profile_link.account_id=a.id
          and profile_link.company_id=a.company_id
          and profile_link.access_status in ('invited','active','suspended')
        left join traders linked_trader on profile_link.entity_type='trader'
          and linked_trader.id=profile_link.entity_id and linked_trader.company_id=profile_link.company_id
        left join drivers linked_driver on profile_link.entity_type='driver'
          and linked_driver.id=profile_link.entity_id and linked_driver.company_id=profile_link.company_id
       where a.id=${accountId}::uuid and a.company_id=${companyId}::uuid
         and a.account_kind<>'platform_user'
    `.execute(this.database);
    const user = userResult.rows[0];
    if (user === undefined) throw this.notFound();
    const [roles, permissions, sessions, audits, profiles] = await Promise.all([
      sql<
        Record<string, unknown>
      >`select r.id, r.code, r.name, r.is_active as "isActive" from account_roles ar join roles r on r.id=ar.role_id where ar.account_id=${accountId}::uuid and ar.company_id=${companyId}::uuid order by lower(r.name)`.execute(
        this.database,
      ),
      sql<
        Record<string, unknown>
      >`select rp.permission_code as code, p.description, array_agg(distinct r.name order by r.name) as "sourceRoles" from account_roles ar join roles r on r.id=ar.role_id and r.is_active join role_permissions rp on rp.role_id=r.id join permissions p on p.code=rp.permission_code where ar.account_id=${accountId}::uuid and ar.company_id=${companyId}::uuid group by rp.permission_code,p.description order by rp.permission_code`.execute(
        this.database,
      ),
      this.sessions(accountId),
      this.auditHistory(accountId, 1, 50),
      sql<Record<string,unknown>>`
        select l.id,l.entity_type as "profileType",l.entity_id as "profileId",
          l.access_status as "accessStatus",l.created_at as "createdAt",l.updated_at as "updatedAt",
          coalesce(e.employee_number,d.code,t.code) as code,
          coalesce(e.name_en,d.name_en,t.name_en) as name,
          coalesce(case when e.is_active then 'active' when e.id is not null then 'disabled' end,
                   d.account_status,t.account_status) as "businessStatus"
        from user_business_links l
        left join employees e on l.entity_type='employee' and e.id=l.entity_id and e.company_id=l.company_id
        left join drivers d on l.entity_type='driver' and d.id=l.entity_id and d.company_id=l.company_id
        left join traders t on l.entity_type='trader' and t.id=l.entity_id and t.company_id=l.company_id
        where l.company_id=${companyId}::uuid and l.account_id=${accountId}::uuid
        order by l.created_at
      `.execute(this.database),
    ]);
    return {
      ...user,
      roles: roles.rows,
      effectivePermissions: permissions.rows,
      sessions,
      audit: audits.items,
      linkedProfiles: profiles.rows,
    };
  }

  public async availableEmployees(search?: string): Promise<readonly Record<string, unknown>[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<Record<string, unknown>>`
      select e.id, e.employee_number as code, e.name_en as name, e.job_title as "jobTitle"
        from employees e where e.company_id=${companyId}::uuid and e.is_active
          and e.company_user_id is null
          ${search?.trim() ? sql`and (e.name_en ilike ${`%${search.trim()}%`} or e.employee_number ilike ${`%${search.trim()}%`})` : sql``}
       order by lower(e.name_en) limit 50
    `.execute(this.database);
    return result.rows;
  }

  public async identifierAvailability(input: {
    email?: string;
    excludeAccountId?: string;
    mobileNumber?: string;
    username?: string;
  }): Promise<{
    emailAvailable: boolean;
    mobileNumberAvailable: boolean;
    usernameAvailable: boolean;
  }> {
    const { companyId } = this.tenants.current();
    const conflicts = await this.identifierConflicts(this.database, companyId, input);
    return {
      emailAvailable: input.email === undefined || !conflicts.email,
      mobileNumberAvailable: input.mobileNumber === undefined || !conflicts.mobileNumber,
      usernameAvailable: input.username === undefined || !conflicts.username,
    };
  }

  public async create(input: {
    displayName: string;
    email: string;
    employeeId?: string;
    forcePasswordChange: boolean;
    mobileNumber: string;
    preferredLanguage: string;
    roleIds: readonly string[];
    status: "active" | "disabled";
    username: string;
    correlationId: string;
  }): Promise<object> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    const temporaryPassword = this.temporaryPasswords.create();
    const passwordHash = await this.passwordHasher.hash(temporaryPassword);
    const accountId = await this.transactions.execute(async (transaction) => {
      await this.lockCompany(transaction, companyId);
      await this.assertRoles(transaction, companyId, input.roleIds, input.status === "active");
      await this.assertIdentifiersAvailable(transaction, companyId, input);
      const account = await sql<{ id: string }>`insert into accounts (
        company_id, account_kind, username, email, mobile_number, password_hash, status, preferred_language,
        force_password_change, temporary_password_expires_at
      ) values (${companyId}::uuid, 'company_user', ${input.username.trim()}, ${input.email.trim().toLowerCase()},
        ${input.mobileNumber}, ${passwordHash}, ${input.status},
        ${input.preferredLanguage}, true, now() + interval '24 hours') returning id`.execute(
        transaction,
      );
      const id = account.rows[0]?.id;
      if (id === undefined) throw new Error("User creation did not return an identifier");
      const companyUser = await sql<{ id: string }>`insert into company_users (
        company_id, account_id, name_en, display_name, email, mobile_number, is_active
      ) values (${companyId}::uuid, ${id}::uuid, ${input.displayName.trim()}, ${input.displayName.trim()},
        ${input.email.trim().toLowerCase()}, ${input.mobileNumber}, ${input.status === "active"}) returning id`.execute(
        transaction,
      );
      const companyUserId = companyUser.rows[0]?.id;
      if (companyUserId === undefined) throw new Error("User profile creation failed");
      for (const roleId of [...new Set(input.roleIds)])
        await sql`insert into account_roles (account_id, role_id, company_id, assigned_by_account_id) values (${id}::uuid, ${roleId}::uuid, ${companyId}::uuid, ${actorId}::uuid)`.execute(
          transaction,
        );
      if (input.employeeId !== undefined)
        await this.linkEmployee(transaction, companyId, companyUserId, input.employeeId);
      await this.audit(transaction, {
        action: "company_user.create",
        actorId,
        after: {
          displayName: input.displayName,
          email: input.email,
          employeeId: input.employeeId ?? null,
          forcePasswordChange: true,
          roleIds: input.roleIds,
          status: input.status,
          username: input.username,
        },
        before: {},
        companyId,
        correlationId: input.correlationId,
        subjectId: id,
      });
      await this.audit(transaction, {
        action: "company_user.temporary_password_generated",
        actorId,
        before: {},
        after: { expiresInHours: 24, forcePasswordChange: true },
        companyId,
        correlationId: input.correlationId,
        subjectId: id,
      });
      for (const roleId of input.roleIds) {
        await this.audit(transaction, {
          action: "company_user.role_assigned",
          actorId,
          before: {},
          after: { roleId },
          companyId,
          correlationId: input.correlationId,
          subjectId: id,
        });
      }
      if (input.employeeId) {
        await this.audit(transaction, {
          action: "company_user.employee_linked",
          actorId,
          before: {},
          after: { employeeId: input.employeeId },
          companyId,
          correlationId: input.correlationId,
          subjectId: id,
        });
      }
      return id;
    });
    return {
      accountId,
      temporaryPassword,
      temporaryPasswordExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }

  public async edit(
    accountId: string,
    input: {
      displayName?: string;
      email?: string;
      mobileNumber?: string | null;
      preferredLanguage?: string;
    },
    correlationId: string,
  ): Promise<void> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    await this.transactions.execute(async (transaction) => {
      const user = await this.lockCompanyUser(transaction, companyId, accountId);
      const before = await sql<Record<string, unknown>>`
        select coalesce(cu.display_name,a.username) as "displayName",a.email,
               a.mobile_number as "mobileNumber",a.preferred_language as "preferredLanguage",
               e.id as "employeeId"
          from accounts a
          left join company_users cu on cu.account_id=a.id and cu.company_id=a.company_id
          left join employees e on e.company_user_id=cu.id and e.company_id=cu.company_id
         where a.id=${accountId}::uuid and a.company_id=${companyId}::uuid
      `.execute(transaction);
      await this.assertIdentifiersAvailable(transaction, companyId, {
        excludeAccountId: accountId,
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.mobileNumber == null ? {} : { mobileNumber: input.mobileNumber }),
      });
      if (user.companyUserId !== null) await sql`
        update company_users
           set display_name=coalesce(${input.displayName ?? null},display_name),
               updated_at=now(),version=version+1
         where id=${user.companyUserId}::uuid
      `.execute(transaction);
      await sql`
        update accounts
           set email = case when ${input.email !== undefined}
                 then ${input.email?.trim().toLowerCase() ?? null}
                 else email end,
               mobile_number = case when ${Object.hasOwn(input, "mobileNumber")}
                 then ${input.mobileNumber ?? null}
                 else mobile_number end,
               preferred_language = coalesce(${input.preferredLanguage ?? null}, preferred_language),
               updated_at = now(),
               version = version + 1
         where id = ${accountId}::uuid
      `.execute(transaction);
      await this.audit(transaction, {
        action: `${user.accountKind}.update`,
        actorId,
        before: before.rows[0] ?? {},
        after: input,
        companyId,
        correlationId,
        subjectId: accountId,
      });
    });
  }

  public async assignRoles(
    accountId: string,
    roleIds: readonly string[],
    correlationId: string,
  ): Promise<void> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const requested = [...new Set(roleIds)].sort();
    await this.transactions.execute(async (transaction) => {
      await this.lockCompany(transaction, companyId);
      const account = await this.lockCompanyUser(transaction, companyId, accountId);
      if (account.accountKind !== "company_user") throw new ApplicationException(
        "account_kind_roles_not_supported",
        "Roles can only be assigned to Company User accounts",
        HttpStatus.CONFLICT,
      );
      await this.assertRoles(transaction, companyId, requested, account.status === "active");
      const current = await sql<{
        roleId: string;
      }>`select role_id as "roleId" from account_roles where account_id=${accountId}::uuid and company_id=${companyId}::uuid order by role_id`.execute(
        transaction,
      );
      const before = current.rows.map((x) => x.roleId);
      const currentlyManages = await this.rolesGrantManagement(transaction, companyId, before);
      const willManage = await this.rolesGrantManagement(transaction, companyId, requested);
      if (accountId === identity.identityId && !willManage)
        throw new ApplicationException(
          "self_lockout_denied",
          "You cannot remove your own Company user-management access",
          HttpStatus.CONFLICT,
        );
      if (currentlyManages && !willManage)
        await this.assertAnotherAdministrator(transaction, companyId, accountId);
      await sql`delete from account_roles where account_id=${accountId}::uuid and company_id=${companyId}::uuid`.execute(
        transaction,
      );
      for (const roleId of requested)
        await sql`insert into account_roles(account_id,role_id,company_id,assigned_by_account_id) values(${accountId}::uuid,${roleId}::uuid,${companyId}::uuid,${identity.identityId}::uuid)`.execute(
          transaction,
        );
      await this.audit(transaction, {
        action: "company_user.roles_assign",
        actorId: identity.identityId,
        before: { roleIds: before },
        after: { roleIds: requested },
        companyId,
        correlationId,
        subjectId: accountId,
      });
      for (const roleId of requested.filter((id) => !before.includes(id))) {
        await this.audit(transaction, {
          action: "company_user.role_assigned",
          actorId: identity.identityId,
          before: {},
          after: { roleId },
          companyId,
          correlationId,
          subjectId: accountId,
        });
      }
      for (const roleId of before.filter((id) => !requested.includes(id))) {
        await this.audit(transaction, {
          action: "company_user.role_removed",
          actorId: identity.identityId,
          before: { roleId },
          after: {},
          companyId,
          correlationId,
          subjectId: accountId,
        });
      }
    });
  }

  public deactivate(accountId: string, reason: string, correlationId: string): Promise<void> {
    return this.changeStatus(accountId, "disabled", reason, correlationId);
  }
  public reactivate(accountId: string, correlationId: string): Promise<void> {
    return this.changeStatus(accountId, "active", undefined, correlationId);
  }

  public async lock(accountId: string, reason: string, correlationId: string): Promise<void> {
    const { companyId } = this.tenants.current();
    const actor = this.identities.current();
    await this.transactions.execute(async (tx) => {
      await this.lockCompany(tx, companyId);
      const account = await this.lockCompanyUser(tx, companyId, accountId);
      if (accountId === actor.identityId)
        throw new ApplicationException(
          "self_lock_denied",
          "You cannot lock your own account",
          HttpStatus.CONFLICT,
        );
      if (await this.accountHasManagement(tx, companyId, accountId))
        await this.assertAnotherAdministrator(tx, companyId, accountId);
      await sql`update accounts set status='locked',administrative_lock_reason=${reason.trim()},administrative_locked_at=now(),administrative_locked_by_account_id=${actor.identityId}::uuid,updated_at=now(),version=version+1 where id=${accountId}::uuid`.execute(
        tx,
      );
      await this.revokeAll(tx, accountId);
      await this.audit(tx, {
        action: `${account.accountKind}.lock`,
        actorId: actor.identityId,
        before: { status: account.status },
        after: { status: "locked" },
        companyId,
        correlationId,
        reason: reason.trim(),
        subjectId: accountId,
      });
    });
  }

  public async unlock(accountId: string, correlationId: string): Promise<void> {
    const { companyId } = this.tenants.current();
    const actor = this.identities.current();
    await this.transactions.execute(async (tx) => {
      const account = await this.lockCompanyUser(tx, companyId, accountId);
      if (account.status === "disabled")
        throw new ApplicationException(
          "disabled_account",
          "A disabled account cannot be unlocked",
          HttpStatus.CONFLICT,
        );
      await sql`update accounts set status='active',failed_login_attempts=0,locked_until=null,administrative_lock_reason=null,administrative_locked_at=null,administrative_locked_by_account_id=null,updated_at=now(),version=version+1 where id=${accountId}::uuid`.execute(
        tx,
      );
      await this.audit(tx, {
        action: `${account.accountKind}.unlock`,
        actorId: actor.identityId,
        before: { status: account.status, failedLoginAttempts: account.failedLoginAttempts },
        after: { status: "active", failedLoginAttempts: 0 },
        companyId,
        correlationId,
        subjectId: accountId,
      });
    });
  }

  public async resetPassword(
    accountId: string,
    reason: string,
    correlationId: string,
  ): Promise<object> {
    const { companyId } = this.tenants.current();
    const actor = this.identities.current();
    const temporaryPassword = this.temporaryPasswords.create();
    const hash = await this.passwordHasher.hash(temporaryPassword);
    await this.transactions.execute(async (tx) => {
      const account = await this.lockCompanyUser(tx, companyId, accountId);
      await this.audit(tx, {
        action: `${account.accountKind}.password_reset_requested`,
        actorId: actor.identityId,
        before: {},
        after: {},
        companyId,
        correlationId,
        reason: reason.trim(),
        subjectId: accountId,
      });
      await sql`update accounts set password_hash=${hash},force_password_change=true,temporary_password_expires_at=now()+interval '24 hours',password_changed_at=null,failed_login_attempts=0,locked_until=null,updated_at=now(),version=version+1 where id=${accountId}::uuid`.execute(
        tx,
      );
      await this.revokeAll(tx, accountId);
      await this.audit(tx, {
        action: `${account.accountKind}.temporary_password_generated`,
        actorId: actor.identityId,
        before: {},
        after: { forcePasswordChange: true, expiresInHours: 24 },
        companyId,
        correlationId,
        reason: reason.trim(),
        subjectId: accountId,
      });
    });
    return {
      temporaryPassword,
      temporaryPasswordExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }

  public async setForcePasswordChange(
    accountId: string,
    required: boolean,
    reason: string | undefined,
    correlationId: string,
  ): Promise<void> {
    const { companyId } = this.tenants.current();
    const actor = this.identities.current();
    await this.transactions.execute(async (tx) => {
      const user = await this.lockCompanyUser(tx, companyId, accountId);
      await sql`update accounts set force_password_change=${required},updated_at=now(),version=version+1 where id=${accountId}::uuid`.execute(
        tx,
      );
      await this.audit(tx, {
        action: `${user.accountKind}.force_password_change`,
        actorId: actor.identityId,
        before: { required: user.forcePasswordChange },
        after: { required },
        companyId,
        correlationId,
        reason,
        subjectId: accountId,
      });
    });
  }

  public async sessions(accountId: string): Promise<readonly Record<string, unknown>[]> {
    const { companyId } = this.tenants.current();
    await this.ensureUser(accountId, companyId);
    const current = this.identities.current().sessionId;
    const result = await sql<
      Record<string, unknown>
    >`select id,created_at as "createdAt",last_seen_at as "lastActivity",created_ip::text as "ipAddress",user_agent as "userAgent",expires_at as "expiresAt",revoked_at as "revokedAt",(id=${current}::uuid) as "isCurrent" from account_sessions where account_id=${accountId}::uuid and company_id=${companyId}::uuid order by created_at desc limit 100`.execute(
      this.database,
    );
    return result.rows;
  }
  public async revokeSession(
    accountId: string,
    sessionId: string,
    reason: string | undefined,
    correlationId: string,
  ): Promise<void> {
    const { companyId } = this.tenants.current();
    const actor = this.identities.current();
    await this.transactions.execute(async (tx) => {
      const account = await this.lockCompanyUser(tx, companyId, accountId);
      const changed = await sql<{
        id: string;
      }>`update account_sessions set revoked_at=coalesce(revoked_at,now()) where id=${sessionId}::uuid and account_id=${accountId}::uuid and company_id=${companyId}::uuid returning id`.execute(
        tx,
      );
      if (changed.rows.length === 0)
        throw new ApplicationException(
          "session_not_found",
          "Session not found",
          HttpStatus.NOT_FOUND,
        );
      await this.audit(tx, {
        action: `${account.accountKind}.session_revoked`,
        actorId: actor.identityId,
        before: {},
        after: { sessionId },
        companyId,
        correlationId,
        reason,
        subjectId: accountId,
      });
    });
  }
  public async revokeSessions(
    accountId: string,
    preserveCurrent: boolean,
    reason: string | undefined,
    correlationId: string,
  ): Promise<void> {
    const { companyId } = this.tenants.current();
    const actor = this.identities.current();
    await this.transactions.execute(async (tx) => {
      const account = await this.lockCompanyUser(tx, companyId, accountId);
      await sql`update account_sessions set revoked_at=coalesce(revoked_at,now()) where account_id=${accountId}::uuid and company_id=${companyId}::uuid ${preserveCurrent && accountId === actor.identityId ? sql`and id<>${actor.sessionId}::uuid` : sql``}`.execute(
        tx,
      );
      await this.audit(tx, {
        action: `${account.accountKind}.sessions_revoked`,
        actorId: actor.identityId,
        before: {},
        after: { preserveCurrent },
        companyId,
        correlationId,
        reason,
        subjectId: accountId,
      });
    });
  }

  public async auditHistory(
    accountId: string,
    page: number,
    pageSize: number,
  ): Promise<{
    items: readonly Record<string, unknown>[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const { companyId } = this.tenants.current();
    await this.ensureUser(accountId, companyId);
    const count = await sql<{
      total: number;
    }>`select count(*)::int total from audit_events where company_id=${companyId}::uuid and subject_type='account' and subject_id=${accountId}`.execute(
      this.database,
    );
    const rows = await sql<
      Record<string, unknown>
    >`select ae.id,ae.action as "eventType",ae.before_data as "previousValue",ae.after_data as "newValue",ae.reason,ae.occurred_at as "occurredAt",ae.correlation_id as "correlationId",ae.source,ae.actor_role as "actorRole",a.username as actor from audit_events ae left join accounts a on a.id=ae.actor_account_id where ae.company_id=${companyId}::uuid and ae.subject_type='account' and ae.subject_id=${accountId} order by ae.occurred_at desc limit ${pageSize} offset ${(page - 1) * pageSize}`.execute(
      this.database,
    );
    return { items: rows.rows, page, pageSize, total: count.rows[0]?.total ?? 0 };
  }

  private async changeStatus(
    accountId: string,
    status: "active" | "disabled",
    reason: string | undefined,
    correlationId: string,
  ): Promise<void> {
    const { companyId } = this.tenants.current();
    const actor = this.identities.current();
    if (status === "disabled" && accountId === actor.identityId)
      throw new ApplicationException(
        "self_deactivation_denied",
        "You cannot disable your own account",
        HttpStatus.CONFLICT,
      );
    await this.transactions.execute(async (tx) => {
      await this.lockCompany(tx, companyId);
      const account = await this.lockCompanyUser(tx, companyId, accountId);
      if (status === "active" && account.accountKind === "company_user")
        await this.assertUserHasActiveRole(tx, companyId, accountId);
      else if (await this.accountHasManagement(tx, companyId, accountId))
        await this.assertAnotherAdministrator(tx, companyId, accountId);
      await sql`update accounts set status=${status},deactivated_at=${status === "disabled" ? sql`now()` : null},updated_at=now(),version=version+1 where id=${accountId}::uuid`.execute(
        tx,
      );
      await sql`update company_users set is_active=${status === "active"},deactivated_at=${status === "disabled" ? sql`now()` : null},updated_at=now(),version=version+1 where account_id=${accountId}::uuid and company_id=${companyId}::uuid`.execute(
        tx,
      );
      if (status === "disabled") await this.revokeAll(tx, accountId);
      await this.audit(tx, {
        action: `${account.accountKind}.${status === "active" ? "reactivate" : "deactivate"}`,
        actorId: actor.identityId,
        before: { status: account.status },
        after: { status },
        companyId,
        correlationId,
        reason,
        subjectId: accountId,
      });
    });
  }
  private async lockCompany(tx: Transaction<DatabaseSchema>, companyId: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${companyId},0))`.execute(tx);
  }
  private async lockCompanyUser(
    tx: Transaction<DatabaseSchema>,
    companyId: string,
    accountId: string,
  ): Promise<UserActionContext & { failedLoginAttempts: number }> {
    const result = await sql<
      UserActionContext & { failedLoginAttempts: number }
    >`select a.id as "accountId",a.account_kind as "accountKind",a.company_id as "companyId",
             cu.id as "companyUserId",a.status,a.force_password_change as "forcePasswordChange",
             a.failed_login_attempts as "failedLoginAttempts"
        from accounts a
        left join company_users cu on cu.account_id=a.id and cu.company_id=a.company_id
       where a.id=${accountId}::uuid and a.company_id=${companyId}::uuid
         and a.account_kind<>'platform_user' for update of a`.execute(
      tx,
    );
    const row = result.rows[0];
    if (!row) throw this.notFound();
    return row;
  }
  private async ensureUser(accountId: string, companyId: string): Promise<void> {
    const r = await sql<{
      exists: boolean;
    }>`select exists(select 1 from accounts where id=${accountId}::uuid
          and company_id=${companyId}::uuid and account_kind<>'platform_user') as exists`.execute(
      this.database,
    );
    if (!r.rows[0]?.exists) throw this.notFound();
  }
  private notFound() {
    return new ApplicationException(
      "user_not_found",
      "Company user not found",
      HttpStatus.NOT_FOUND,
    );
  }
  private async identifierConflicts(
    executor: UserDatabaseExecutor,
    companyId: string,
    input: {
      email?: string;
      excludeAccountId?: string;
      mobileNumber?: string;
      username?: string;
    },
  ): Promise<{ email: boolean; mobileNumber: boolean; username: boolean }> {
    const result = await sql<{
      email: boolean;
      mobileNumber: boolean;
      username: boolean;
    }>`
      select
        ${
          input.username === undefined
            ? sql`false`
            : sql`exists(
                select 1 from accounts
                 where company_id = ${companyId}::uuid
                   and normalized_username = lower(btrim(${input.username}))
                   and (${input.excludeAccountId ?? null}::uuid is null or id <> ${input.excludeAccountId ?? null}::uuid)
              )`
        } as username,
        ${
          input.email === undefined
            ? sql`false`
            : sql`exists(
                select 1 from accounts
                 where company_id = ${companyId}::uuid
                   and normalized_email = lower(btrim(${input.email}))
                   and (${input.excludeAccountId ?? null}::uuid is null or id <> ${input.excludeAccountId ?? null}::uuid)
              )`
        } as email,
        ${
          input.mobileNumber === undefined
            ? sql`false`
            : sql`exists(
                select 1 from accounts
                 where company_id = ${companyId}::uuid
                   and normalized_mobile_number = ${input.mobileNumber}
                   and (${input.excludeAccountId ?? null}::uuid is null or id <> ${input.excludeAccountId ?? null}::uuid)
              )`
        } as "mobileNumber"
    `.execute(executor);
    return result.rows[0] ?? { email: false, mobileNumber: false, username: false };
  }
  private async assertIdentifiersAvailable(
    executor: UserDatabaseExecutor,
    companyId: string,
    input: {
      email?: string;
      excludeAccountId?: string;
      mobileNumber?: string;
      username?: string;
    },
  ): Promise<void> {
    const conflicts = await this.identifierConflicts(executor, companyId, input);
    if (conflicts.username) {
      throw new ApplicationException(
        "username_already_exists",
        "This username is already in use in the Company",
        HttpStatus.CONFLICT,
      );
    }
    if (conflicts.email) {
      throw new ApplicationException(
        "email_already_exists",
        "This email address is already in use in the Company",
        HttpStatus.CONFLICT,
      );
    }
    if (conflicts.mobileNumber) {
      throw new ApplicationException(
        "mobile_already_exists",
        "This mobile number is already in use in the Company",
        HttpStatus.CONFLICT,
      );
    }
  }
  private async assertRoles(
    tx: Transaction<DatabaseSchema>,
    companyId: string,
    roleIds: readonly string[],
    required: boolean,
  ): Promise<void> {
    const unique = [...new Set(roleIds)];
    if (required && unique.length === 0)
      throw new ApplicationException(
        "active_user_requires_role",
        "An Active User must have at least one active Role",
        HttpStatus.BAD_REQUEST,
      );
    if (unique.length === 0) return;
    const r = await sql<{
      id: string;
    }>`select id from roles where company_id=${companyId}::uuid and id=any(${unique}::uuid[]) and is_active`.execute(
      tx,
    );
    if (r.rows.length !== unique.length)
      throw new ApplicationException(
        "invalid_role_assignment",
        "Every assigned Role must be active and belong to the authenticated Company",
        HttpStatus.BAD_REQUEST,
      );
  }
  private async assertUserHasActiveRole(
    tx: Transaction<DatabaseSchema>,
    companyId: string,
    accountId: string,
  ): Promise<void> {
    const r = await sql<{
      ok: boolean;
    }>`select exists(select 1 from account_roles ar join roles r on r.id=ar.role_id and r.is_active where ar.account_id=${accountId}::uuid and ar.company_id=${companyId}::uuid) ok`.execute(
      tx,
    );
    if (!r.rows[0]?.ok)
      throw new ApplicationException(
        "active_user_requires_role",
        "Assign at least one active Role before reactivating this User",
        HttpStatus.CONFLICT,
      );
  }
  private async linkEmployee(
    tx: Transaction<DatabaseSchema>,
    companyId: string,
    companyUserId: string,
    employeeId: string,
  ): Promise<void> {
    const r = await sql<{
      id: string;
    }>`update employees set company_user_id=${companyUserId}::uuid,updated_at=now(),version=version+1 where id=${employeeId}::uuid and company_id=${companyId}::uuid and is_active and company_user_id is null returning id`.execute(
      tx,
    );
    if (r.rows.length !== 1)
      throw new ApplicationException(
        "employee_link_unavailable",
        "Employee is disabled, already linked, or belongs to another Company",
        HttpStatus.CONFLICT,
      );
  }
  private async rolesGrantManagement(
    tx: Transaction<DatabaseSchema>,
    companyId: string,
    roleIds: readonly string[],
  ): Promise<boolean> {
    if (roleIds.length === 0) return false;
    const r = await sql<{
      allowed: boolean;
    }>`select exists(select 1 from roles r join role_permissions rp on rp.role_id=r.id where r.company_id=${companyId}::uuid and r.id=any(${roleIds}::uuid[]) and r.is_active and rp.permission_code='users_roles.manage') allowed`.execute(
      tx,
    );
    return r.rows[0]?.allowed ?? false;
  }
  private async accountHasManagement(
    tx: Transaction<DatabaseSchema>,
    companyId: string,
    accountId: string,
  ): Promise<boolean> {
    const r = await sql<{
      allowed: boolean;
    }>`select exists(select 1 from account_roles ar join roles r on r.id=ar.role_id and r.is_active join role_permissions rp on rp.role_id=r.id where ar.account_id=${accountId}::uuid and ar.company_id=${companyId}::uuid and rp.permission_code='users_roles.manage') allowed`.execute(
      tx,
    );
    return r.rows[0]?.allowed ?? false;
  }
  private async assertAnotherAdministrator(
    tx: Transaction<DatabaseSchema>,
    companyId: string,
    excluded: string,
  ): Promise<void> {
    const r = await sql<{
      count: number;
    }>`select count(distinct a.id)::int count from accounts a join account_roles ar on ar.account_id=a.id and ar.company_id=a.company_id join roles r on r.id=ar.role_id and r.is_active join role_permissions rp on rp.role_id=r.id where a.company_id=${companyId}::uuid and a.status='active' and a.id<>${excluded}::uuid and rp.permission_code='users_roles.manage'`.execute(
      tx,
    );
    if ((r.rows[0]?.count ?? 0) === 0)
      throw new ApplicationException(
        "last_company_administrator",
        "The last active Company administrator cannot lose access",
        HttpStatus.CONFLICT,
      );
  }
  private async revokeAll(tx: Transaction<DatabaseSchema>, accountId: string): Promise<void> {
    await sql`update account_sessions set revoked_at=coalesce(revoked_at,now()) where account_id=${accountId}::uuid and revoked_at is null`.execute(
      tx,
    );
  }
  private async audit(
    tx: Transaction<DatabaseSchema>,
    input: {
      action: string;
      actorId: string;
      after: object;
      before: object;
      companyId: string;
      correlationId: string;
      reason?: string | undefined;
      subjectId: string;
    },
  ): Promise<void> {
    await sql`insert into audit_events(company_id,actor_account_id,action,subject_type,subject_id,reason,before_data,after_data,correlation_id,actor_role,source) values(${input.companyId}::uuid,${input.actorId}::uuid,${input.action},'account',${input.subjectId},${input.reason ?? null},${JSON.stringify(input.before)}::jsonb,${JSON.stringify(input.after)}::jsonb,${input.correlationId},'users_roles.manage','web')`.execute(
      tx,
    );
  }
}
