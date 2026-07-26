import { randomBytes } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql, type Transaction } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

export interface PermissionView {
  readonly code: string;
  readonly description: string;
}
export interface RoleView {
  readonly assignedUserCount: number;
  readonly code: string;
  readonly description: string | null;
  readonly id: string;
  readonly isActive: boolean;
  readonly isSystem: boolean;
  readonly name: string;
  readonly permissionCount: number;
  readonly permissions: readonly string[];
  readonly scope: "company";
}

@Injectable()
export class RoleService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public async list(input: {
    page: number;
    pageSize: number;
    search?: string;
    status?: string;
  }): Promise<{ items: readonly RoleView[]; page: number; pageSize: number; total: number }> {
    const { companyId } = this.tenants.current();
    const search = input.search?.trim();
    const filter = sql`${search ? sql`and (r.name ilike ${`%${search}%`} or r.description ilike ${`%${search}%`})` : sql``}${!input.status || input.status === "all" ? sql`` : sql`and r.is_active=${input.status === "active"}`}`;
    const count = await sql<{
      total: number;
    }>`select count(*)::int total from roles r where r.company_id=${companyId}::uuid ${filter}`.execute(
      this.database,
    );
    const rows =
      await sql<RoleView>`select r.id,r.code,r.name,r.description,r.is_system as "isSystem",r.is_active as "isActive",'company'::text as scope,count(distinct rp.permission_code)::int as "permissionCount",count(distinct ar.account_id)::int as "assignedUserCount",coalesce(array_agg(distinct rp.permission_code order by rp.permission_code)filter(where rp.permission_code is not null),array[]::text[]) permissions from roles r left join role_permissions rp on rp.role_id=r.id left join account_roles ar on ar.role_id=r.id where r.company_id=${companyId}::uuid ${filter} group by r.id order by lower(r.name),r.id limit ${input.pageSize} offset ${(input.page - 1) * input.pageSize}`.execute(
        this.database,
      );
    return {
      items: rows.rows,
      page: input.page,
      pageSize: input.pageSize,
      total: count.rows[0]?.total ?? 0,
    };
  }

  public async details(roleId: string): Promise<object> {
    const { companyId } = this.tenants.current();
    const result =
      await sql<RoleView>`select r.id,r.code,r.name,r.description,r.is_system as "isSystem",r.is_active as "isActive",'company'::text scope,count(distinct rp.permission_code)::int as "permissionCount",count(distinct ar.account_id)::int as "assignedUserCount",coalesce(array_agg(distinct rp.permission_code order by rp.permission_code)filter(where rp.permission_code is not null),array[]::text[]) permissions from roles r left join role_permissions rp on rp.role_id=r.id left join account_roles ar on ar.role_id=r.id where r.id=${roleId}::uuid and r.company_id=${companyId}::uuid group by r.id`.execute(
        this.database,
      );
    const role = result.rows[0];
    if (!role) throw this.notFound();
    const [users, audit] = await Promise.all([
      sql<
        Record<string, unknown>
      >`select a.id as "accountId",a.username,cu.display_name as "displayName",a.status from account_roles ar join accounts a on a.id=ar.account_id and a.company_id=ar.company_id join company_users cu on cu.account_id=a.id where ar.role_id=${roleId}::uuid and ar.company_id=${companyId}::uuid order by lower(cu.display_name)`.execute(
        this.database,
      ),
      sql<
        Record<string, unknown>
      >`select ae.id,ae.action as "eventType",ae.before_data as "previousValue",ae.after_data as "newValue",ae.reason,ae.occurred_at as "occurredAt",a.username as actor from audit_events ae left join accounts a on a.id=ae.actor_account_id where ae.company_id=${companyId}::uuid and ae.subject_type='role' and ae.subject_id=${roleId} order by ae.occurred_at desc limit 100`.execute(
        this.database,
      ),
    ]);
    return { ...role, assignedUsers: users.rows, audit: audit.rows };
  }

  public async listPermissions(): Promise<readonly PermissionView[]> {
    const result =
      await sql<PermissionView>`select code,description from permissions where code not like 'platform.%' order by code`.execute(
        this.database,
      );
    return result.rows;
  }

  public async create(input: {
    correlationId: string;
    description?: string | undefined;
    isActive: boolean;
    name: string;
    permissions: readonly string[];
  }): Promise<RoleView> {
    const { companyId } = this.tenants.current();
    const actor = this.identities.current().identityId;
    const permissions = [...new Set(input.permissions)].sort();
    if (input.isActive && permissions.length === 0)
      throw new ApplicationException(
        "active_role_requires_permission",
        "An Active Role must have at least one Permission",
        HttpStatus.BAD_REQUEST,
      );
    return this.transactions.execute(async (tx) => {
      await this.lockCompany(tx, companyId);
      await this.assertKnownPermissions(tx, permissions);
      const code = this.generateCode(input.name);
      const created = await sql<{
        id: string;
      }>`insert into roles(company_id,code,name,description,is_active,is_system) values(${companyId}::uuid,${code},${input.name.trim()},${input.description?.trim() ?? null},${input.isActive},false) returning id`.execute(
        tx,
      );
      const id = created.rows[0]?.id;
      if (!id) throw new Error("Role creation failed");
      for (const permission of permissions)
        await sql`insert into role_permissions(role_id,permission_code)values(${id}::uuid,${permission})`.execute(
          tx,
        );
      await this.audit(tx, companyId, actor, "role.create", id, {}, input, input.correlationId);
      return {
        assignedUserCount: 0,
        code,
        description: input.description?.trim() ?? null,
        id,
        isActive: input.isActive,
        isSystem: false,
        name: input.name.trim(),
        permissionCount: permissions.length,
        permissions,
        scope: "company",
      };
    });
  }

  public async update(
    roleId: string,
    input: {
      correlationId: string;
      description?: string | null;
      isActive?: boolean;
      name?: string;
      permissions?: readonly string[];
    },
  ): Promise<RoleView> {
    const { companyId } = this.tenants.current();
    const actor = this.identities.current().identityId;
    const protectedRole = await sql<{ isSystem: boolean }>`
      select is_system as "isSystem" from roles
       where id=${roleId}::uuid and company_id=${companyId}::uuid
    `.execute(this.database);
    if (protectedRole.rows[0]?.isSystem) {
      await this.audit(
        this.database,
        companyId,
        actor,
        "role.protected_change_attempt",
        roleId,
        {},
        {},
        input.correlationId,
      );
      throw new ApplicationException(
        "system_role_protected",
        "System Roles cannot be modified",
        HttpStatus.CONFLICT,
      );
    }
    return this.transactions.execute(async (tx) => {
      await this.lockCompany(tx, companyId);
      await sql`select id from roles where id=${roleId}::uuid and company_id=${companyId}::uuid for update`.execute(
        tx,
      );
      const stored = await this.load(tx, companyId, roleId);
      const permissions =
        input.permissions === undefined
          ? [...stored.permissions]
          : [...new Set(input.permissions)].sort();
      const active = input.isActive ?? stored.isActive;
      if (active && permissions.length === 0)
        throw new ApplicationException(
          "active_role_requires_permission",
          "An Active Role must have at least one Permission",
          HttpStatus.BAD_REQUEST,
        );
      await this.assertKnownPermissions(tx, permissions);
      const removesManagement =
        stored.permissions.includes("users_roles.manage") &&
        (!active || !permissions.includes("users_roles.manage"));
      if (removesManagement && stored.assignedUserCount > 0)
        await this.assertManagementAlternative(tx, companyId, roleId);
      if (!active) await this.assertAssignedUsersHaveAlternativeRole(tx, companyId, roleId);
      const name = input.name?.trim() ?? stored.name;
      const description = Object.hasOwn(input, "description")
        ? (input.description?.trim() ?? null)
        : stored.description;
      await sql`update roles set name=${name},description=${description},is_active=${active},updated_at=now(),version=version+1 where id=${roleId}::uuid`.execute(
        tx,
      );
      if (input.permissions !== undefined) {
        await sql`delete from role_permissions where role_id=${roleId}::uuid`.execute(tx);
        for (const permission of permissions)
          await sql`insert into role_permissions(role_id,permission_code)values(${roleId}::uuid,${permission})`.execute(
            tx,
          );
      }
      await this.audit(
        tx,
        companyId,
        actor,
        "role.update",
        roleId,
        {
          name: stored.name,
          description: stored.description,
          isActive: stored.isActive,
          permissions: stored.permissions,
        },
        { name, description, isActive: active, permissions },
        input.correlationId,
      );
      for (const permission of permissions.filter((code) => !stored.permissions.includes(code))) {
        await this.audit(
          tx,
          companyId,
          actor,
          "role.permission_added",
          roleId,
          {},
          { permission },
          input.correlationId,
        );
      }
      for (const permission of stored.permissions.filter((code) => !permissions.includes(code))) {
        await this.audit(
          tx,
          companyId,
          actor,
          "role.permission_removed",
          roleId,
          { permission },
          {},
          input.correlationId,
        );
      }
      if (active !== stored.isActive) {
        await this.audit(
          tx,
          companyId,
          actor,
          active ? "role.reactivate" : "role.disable",
          roleId,
          { isActive: stored.isActive },
          { isActive: active },
          input.correlationId,
        );
      }
      return {
        ...stored,
        name,
        description,
        isActive: active,
        permissions,
        permissionCount: permissions.length,
      };
    });
  }

  public async duplicate(roleId: string, name: string, correlationId: string): Promise<RoleView> {
    const { companyId } = this.tenants.current();
    const source = await this.load(this.database, companyId, roleId);
    return this.create({
      correlationId,
      ...(source.description === null ? {} : { description: source.description }),
      isActive: false,
      name,
      permissions: source.permissions,
    });
  }

  private generateCode(name: string): string {
    let base = name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48);
    if (!/^[a-z]/.test(base)) base = `role_${base}`;
    return `${base || "role"}_${randomBytes(4).toString("hex")}`;
  }
  private async load(
    db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    companyId: string,
    roleId: string,
  ): Promise<RoleView> {
    const result =
      await sql<RoleView>`select r.id,r.code,r.name,r.description,r.is_system as "isSystem",r.is_active as "isActive",'company'::text scope,count(distinct rp.permission_code)::int as "permissionCount",count(distinct ar.account_id)::int as "assignedUserCount",coalesce(array_agg(distinct rp.permission_code order by rp.permission_code)filter(where rp.permission_code is not null),array[]::text[]) permissions from roles r left join role_permissions rp on rp.role_id=r.id left join account_roles ar on ar.role_id=r.id where r.id=${roleId}::uuid and r.company_id=${companyId}::uuid group by r.id`.execute(
        db,
      );
    const role = result.rows[0];
    if (!role) throw this.notFound();
    return role;
  }
  private notFound() {
    return new ApplicationException("role_not_found", "Role not found", HttpStatus.NOT_FOUND);
  }
  private async lockCompany(tx: Transaction<DatabaseSchema>, companyId: string) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${companyId},0))`.execute(tx);
  }
  private async assertKnownPermissions(
    db: Transaction<DatabaseSchema>,
    permissions: readonly string[],
  ) {
    if (permissions.length === 0) return;
    const rows = await sql<{
      code: string;
    }>`select code from permissions where code=any(${permissions}::text[]) and code not like 'platform.%'`.execute(
      db,
    );
    if (rows.rows.length !== permissions.length)
      throw new ApplicationException(
        "unknown_permission",
        "One or more Permissions are unavailable for Company Roles",
        HttpStatus.BAD_REQUEST,
      );
  }
  private async assertManagementAlternative(
    tx: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    companyId: string,
    excludedRole: string,
  ) {
    const r = await sql<{
      count: number;
    }>`select count(distinct a.id)::int count from accounts a join account_roles ar on ar.account_id=a.id and ar.company_id=a.company_id join roles r on r.id=ar.role_id and r.is_active join role_permissions rp on rp.role_id=r.id where a.company_id=${companyId}::uuid and a.status='active' and r.id<>${excludedRole}::uuid and rp.permission_code='users_roles.manage'`.execute(
      tx,
    );
    if ((r.rows[0]?.count ?? 0) === 0)
      throw new ApplicationException(
        "last_administrator_role",
        "The final administrative Role cannot lose management access",
        HttpStatus.CONFLICT,
      );
  }
  private async assertAssignedUsersHaveAlternativeRole(
    tx: Transaction<DatabaseSchema>,
    companyId: string,
    roleId: string,
  ) {
    const r = await sql<{
      count: number;
    }>`select count(*)::int count from accounts a join account_roles ar on ar.account_id=a.id where ar.role_id=${roleId}::uuid and a.company_id=${companyId}::uuid and a.status='active' and not exists(select 1 from account_roles ar2 join roles r2 on r2.id=ar2.role_id and r2.is_active where ar2.account_id=a.id and r2.id<>${roleId}::uuid)`.execute(
      tx,
    );
    if ((r.rows[0]?.count ?? 0) > 0)
      throw new ApplicationException(
        "role_in_use_without_alternative",
        "Assign another active Role to affected Users before disabling this Role",
        HttpStatus.CONFLICT,
      );
  }
  private async audit(
    tx: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    companyId: string,
    actor: string,
    action: string,
    subject: string,
    before: object,
    after: object,
    correlationId: string,
  ) {
    await sql`insert into audit_events(company_id,actor_account_id,action,subject_type,subject_id,before_data,after_data,correlation_id,actor_role,source)values(${companyId}::uuid,${actor}::uuid,${action},'role',${subject},${JSON.stringify(before)}::jsonb,${JSON.stringify(after)}::jsonb,${correlationId},'users_roles.manage','web')`.execute(
      tx,
    );
  }
}
