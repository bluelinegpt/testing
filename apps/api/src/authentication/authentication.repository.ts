import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { IdentityKind } from "../security/identity-context.js";

export interface AccountLoginRecord {
  readonly accountStatus: string;
  readonly companyId: string | null;
  readonly companyStatus: string | null;
  readonly failedLoginAttempts: number;
  readonly id: string;
  readonly kind: IdentityKind;
  readonly lockedUntil: Date | null;
  readonly passwordHash: string;
  readonly username: string;
  readonly forcePasswordChange: boolean;
  readonly temporaryPasswordExpiresAt: Date | null;
}

export interface AuthenticatedSessionRecord {
  readonly accountId: string;
  readonly companyId: string | null;
  readonly kind: IdentityKind;
  readonly sessionId: string;
  readonly forcePasswordChange: boolean;
}

@Injectable()
export class AuthenticationRepository {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async findCompanyAccount(
    companySubdomain: string,
    identifier: string,
    normalizedMobile: string | undefined,
  ): Promise<AccountLoginRecord | undefined> {
    const result = await sql<AccountLoginRecord>`
      select a.id,
             a.company_id as "companyId",
             a.account_kind as kind,
             a.username,
             a.password_hash as "passwordHash",
             a.status as "accountStatus",
             a.failed_login_attempts as "failedLoginAttempts",
             a.locked_until as "lockedUntil",
             a.force_password_change as "forcePasswordChange",
             a.temporary_password_expires_at as "temporaryPasswordExpiresAt",
             c.status as "companyStatus"
        from accounts a
        join companies c on c.id = a.company_id
       where lower(c.subdomain) = lower(${companySubdomain})
         and (
           a.normalized_username = lower(btrim(${identifier}))
           or a.normalized_email = lower(btrim(${identifier}))
           or (
             ${normalizedMobile ?? null}::text is not null
             and a.normalized_mobile_number = ${normalizedMobile ?? null}
           )
         )
         and a.account_kind <> 'platform_administrator'
       limit 2
    `.execute(this.database);
    return result.rows.length === 1 ? result.rows[0] : undefined;
  }

  public async findPlatformAccount(identifier: string): Promise<AccountLoginRecord | undefined> {
    const result = await sql<AccountLoginRecord>`
      select a.id,
             a.company_id as "companyId",
             a.account_kind as kind,
             a.username,
             a.password_hash as "passwordHash",
             a.status as "accountStatus",
             a.failed_login_attempts as "failedLoginAttempts",
             a.locked_until as "lockedUntil",
             a.force_password_change as "forcePasswordChange",
             a.temporary_password_expires_at as "temporaryPasswordExpiresAt",
             null::text as "companyStatus"
        from accounts a
       where a.company_id is null
         and a.account_kind = 'platform_administrator'
         and a.normalized_username = lower(btrim(${identifier}))
       limit 1
    `.execute(this.database);
    return result.rows[0];
  }

  public async recordFailedLogin(accountId: string, lockoutMinutes: number): Promise<void> {
    await sql`
      update accounts
         set failed_login_attempts = least(failed_login_attempts + 1, 5),
             last_failed_login_at = now(),
             locked_until = case
               when failed_login_attempts + 1 >= 5
                 then now() + (${lockoutMinutes} * interval '1 minute')
               else locked_until
             end,
             updated_at = now(),
             version = version + 1
       where id = ${accountId}::uuid
    `.execute(this.database);
  }

  public async resetLoginSecurity(accountId: string): Promise<void> {
    await sql`
      update accounts
         set failed_login_attempts = 0,
             locked_until = null,
             last_login_at = now(),
             updated_at = now(),
             version = version + 1
       where id = ${accountId}::uuid
    `.execute(this.database);
  }

  public async createSession(input: {
    accountId: string;
    companyId: string | null;
    createdIp?: string | undefined;
    expiresAt: Date;
    tokenHash: string;
    userAgent?: string | undefined;
  }): Promise<string> {
    const result = await sql<{ id: string }>`
      insert into account_sessions (
        account_id, company_id, token_hash, expires_at, created_ip, user_agent
      ) values (
        ${input.accountId}::uuid,
        ${input.companyId}::uuid,
        ${input.tokenHash},
        ${input.expiresAt},
        ${input.createdIp ?? null}::inet,
        ${input.userAgent?.slice(0, 1_000) ?? null}
      )
      returning id
    `.execute(this.database);
    const session = result.rows[0];
    if (session === undefined) {
      throw new Error("Session creation did not return an identifier");
    }
    return session.id;
  }

  public async findActiveSession(
    tokenHash: string,
  ): Promise<AuthenticatedSessionRecord | undefined> {
    await sql`
      update account_sessions set last_seen_at=now()
       where token_hash=${tokenHash} and revoked_at is null and expires_at>now()
    `.execute(this.database);
    const result = await sql<AuthenticatedSessionRecord>`
      select s.id as "sessionId",
             a.id as "accountId",
             a.company_id as "companyId",
             a.account_kind as kind
             ,a.force_password_change as "forcePasswordChange"
        from account_sessions s
        join accounts a on a.id = s.account_id
        left join companies c on c.id = a.company_id
       where s.token_hash = ${tokenHash}
         and s.revoked_at is null
         and s.expires_at > now()
         and a.status = 'active'
         and (a.company_id is null or c.status = 'active')
       limit 1
    `.execute(this.database);
    return result.rows[0];
  }

  public async passwordHash(accountId: string): Promise<string | undefined> {
    const result = await sql<{ passwordHash: string }>`
      select password_hash as "passwordHash" from accounts where id = ${accountId}::uuid
    `.execute(this.database);
    return result.rows[0]?.passwordHash;
  }

  public async changePassword(input: {
    accountId: string;
    companyId: string | null;
    correlationId: string;
    passwordHash: string;
    sessionId: string;
  }): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await sql`
        update accounts set password_hash=${input.passwordHash}, force_password_change=false,
          temporary_password_expires_at=null, password_changed_at=now(), failed_login_attempts=0,
          locked_until=null, updated_at=now(), version=version+1
        where id=${input.accountId}::uuid
      `.execute(transaction);
      await sql`
        update account_sessions set revoked_at=coalesce(revoked_at,now())
         where account_id=${input.accountId}::uuid and id<>${input.sessionId}::uuid and revoked_at is null
      `.execute(transaction);
      await sql`
        insert into audit_events(company_id,actor_account_id,action,subject_type,subject_id,
          before_data,after_data,correlation_id,actor_role,source)
        values(${input.companyId}::uuid,${input.accountId}::uuid,'company_user.force_password_change_completed',
          'account',${input.accountId},'{"forcePasswordChange":true}'::jsonb,
          '{"forcePasswordChange":false}'::jsonb,${input.correlationId},'self','web')
      `.execute(transaction);
    });
  }

  public async findPermissions(accountId: string): Promise<ReadonlySet<string>> {
    const result = await sql<{ code: string }>`
      select distinct rp.permission_code as code
        from account_roles ar
        join roles r on r.id = ar.role_id
        join role_permissions rp on rp.role_id = r.id
       where ar.account_id = ${accountId}::uuid
         and r.is_active = true
    `.execute(this.database);
    return new Set(result.rows.map((row) => row.code));
  }

  public async revokeSession(sessionId: string, accountId: string): Promise<void> {
    await sql`
      update account_sessions
         set revoked_at = coalesce(revoked_at, now())
       where id = ${sessionId}::uuid
         and account_id = ${accountId}::uuid
    `.execute(this.database);
  }
}
