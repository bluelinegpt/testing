import { type Kysely, sql, type Transaction } from "kysely";

import { PasswordHasher } from "../authentication/password-hasher.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import {
  PLATFORM_ACCESS,
  PLATFORM_BLOG_CATEGORIES_MANAGE,
  PLATFORM_BLOG_CREATE,
  PLATFORM_BLOG_EDIT,
  PLATFORM_BLOG_READ,
  PLATFORM_WEBSITE_MEDIA_MANAGE,
  PLATFORM_WEBSITE_READ,
  PLATFORM_WEBSITE_SEO_MANAGE,
} from "./platform-authorization.js";

export const PLATFORM_SEO_CONSULTANT_ROLE_CODE = "platform_seo_consultant";
export const PLATFORM_SEO_CONSULTANT_ROLE_NAME = "Platform SEO Consultant";
export const PLATFORM_SEO_CONSULTANT_PERMISSIONS = [
  PLATFORM_ACCESS,
  PLATFORM_BLOG_READ,
  PLATFORM_BLOG_CREATE,
  PLATFORM_BLOG_EDIT,
  PLATFORM_BLOG_CATEGORIES_MANAGE,
  PLATFORM_WEBSITE_READ,
  PLATFORM_WEBSITE_MEDIA_MANAGE,
  PLATFORM_WEBSITE_SEO_MANAGE,
] as const;

export interface PlatformSeoConsultantProvisioningInput {
  readonly email: string;
  readonly temporaryPassword: string;
  readonly username: string;
}

export async function provisionPlatformSeoConsultant(
  database: Kysely<DatabaseSchema>,
  input: PlatformSeoConsultantProvisioningInput,
  passwordHasher = new PasswordHasher(),
): Promise<string> {
  const username = input.username.trim();
  const email = input.email.trim().toLowerCase();
  if (!/^[A-Za-z0-9._@-]{3,128}$/.test(username)) {
    throw new Error("Username must be 3-128 characters using letters, numbers, . _ @ or -");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("A valid email address is required");
  }
  if (input.temporaryPassword.length < 16 || input.temporaryPassword.length > 256) {
    throw new Error("Temporary password must be between 16 and 256 characters");
  }
  const passwordHash = await passwordHasher.hash(input.temporaryPassword);
  return database.transaction().execute((transaction) =>
    provisionInTransaction(transaction, { email, passwordHash, username }),
  );
}

async function provisionInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: { readonly email: string; readonly passwordHash: string; readonly username: string },
): Promise<string> {
  await sql`select pg_advisory_xact_lock(hashtext('blueline-platform-user-provisioning'))`.execute(
    transaction,
  );
  for (const code of PLATFORM_SEO_CONSULTANT_PERMISSIONS) {
    await sql`
      insert into permissions (code, description)
      select code, description from (
        values (${code}, ${`Platform SEO Consultant permission: ${code}`})
      ) as requested(code, description)
      on conflict (code) do nothing
    `.execute(transaction);
  }
  const role = await sql<{ id: string }>`
    insert into roles (company_id, code, name, is_system, is_active, description)
    values (
      null, ${PLATFORM_SEO_CONSULTANT_ROLE_CODE}, ${PLATFORM_SEO_CONSULTANT_ROLE_NAME},
      true, true, 'Restricted Platform access for blog drafts, media and SEO'
    )
    on conflict (lower(code)) where company_id is null
    do update set name=excluded.name, is_active=true, description=excluded.description
    returning id
  `.execute(transaction);
  const roleId = role.rows[0]?.id;
  if (roleId === undefined) throw new Error("SEO Consultant role was not created");
  await sql`delete from role_permissions where role_id=${roleId}::uuid`.execute(transaction);
  for (const code of PLATFORM_SEO_CONSULTANT_PERMISSIONS) {
    await sql`
      insert into role_permissions (role_id, permission_code)
      values (${roleId}::uuid, ${code})
    `.execute(transaction);
  }

  const existing = await sql<{ id: string; hasSeoRole: boolean }>`
    select a.id,
           exists(
             select 1 from account_roles ar
             join roles r on r.id=ar.role_id
             where ar.account_id=a.id and r.company_id is null
               and lower(r.code)=${PLATFORM_SEO_CONSULTANT_ROLE_CODE}
           ) as "hasSeoRole"
      from accounts a
     where a.company_id is null and a.account_kind='platform_administrator'
       and (a.normalized_username=lower(btrim(${input.username}))
            or a.normalized_email=lower(btrim(${input.email})))
     limit 1
  `.execute(transaction);
  const current = existing.rows[0];
  if (current !== undefined && !current.hasSeoRole) {
    throw new Error("The username or email already belongs to another Platform account");
  }

  let accountId = current?.id;
  if (accountId === undefined) {
    const inserted = await sql<{ id: string }>`
      insert into accounts (
        company_id, account_kind, username, email, password_hash, status,
        preferred_language, force_password_change, temporary_password_expires_at
      ) values (
        null, 'platform_administrator', ${input.username}, ${input.email}, ${input.passwordHash},
        'active', 'en', true, now()+interval '24 hours'
      )
      returning id
    `.execute(transaction);
    accountId = inserted.rows[0]?.id;
    if (accountId === undefined) throw new Error("Platform account was not created");
  } else {
    await sql`
      update accounts
         set username=${input.username}, email=${input.email}, password_hash=${input.passwordHash},
             status='active', force_password_change=true,
             temporary_password_expires_at=now()+interval '24 hours', password_changed_at=null,
             failed_login_attempts=0, locked_until=null, last_failed_login_at=null,
             updated_at=now(), version=version+1
       where id=${accountId}::uuid
    `.execute(transaction);
    await sql`
      update account_sessions set revoked_at=now()
       where account_id=${accountId}::uuid and revoked_at is null
    `.execute(transaction);
  }
  await sql`
    insert into account_roles (account_id, role_id, company_id)
    values (${accountId}::uuid, ${roleId}::uuid, null)
    on conflict (account_id, role_id) do nothing
  `.execute(transaction);
  await sql`
    insert into audit_events (
      company_id, actor_account_id, action, subject_type, subject_id,
      after_data, correlation_id, actor_role, source
    ) values (
      null, null, 'platform_user.provision', 'account', ${accountId},
      ${JSON.stringify({
        accountKind: "platform_administrator",
        role: PLATFORM_SEO_CONSULTANT_ROLE_CODE,
        permissions: PLATFORM_SEO_CONSULTANT_PERMISSIONS,
      })}::jsonb,
      ${`platform-provision:${accountId}`}, 'platform_operator', 'platform_provisioning'
    )
  `.execute(transaction);
  return accountId;
}
