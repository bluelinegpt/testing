import { type Kysely, sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { PLATFORM_SUPER_ADMIN_ROLE_CODE } from "./platform-authorization.js";

export interface PlatformBootstrapInput {
  readonly password: string;
  readonly username: string;
}

export async function bootstrapPlatformAdministrator(
  database: Kysely<DatabaseSchema>,
  input: PlatformBootstrapInput,
  passwordHasher = new PasswordHasher(),
): Promise<string> {
  const username = input.username.trim();
  if (!/^[A-Za-z0-9._@-]{3,128}$/.test(username)) {
    throw new Error(
      "Bootstrap username must be 3-128 characters using letters, numbers, . _ @ or -",
    );
  }
  if (input.password.length < 16 || input.password.length > 256) {
    throw new Error("Bootstrap password must be between 16 and 256 characters");
  }

  const passwordHash = await passwordHasher.hash(input.password);
  return database
    .transaction()
    .execute((transaction) =>
      bootstrapPlatformAdministratorInTransaction(transaction, username, passwordHash),
    );
}

/**
 * Grants the system Platform role to an account, if it does not hold it.
 *
 * Separate and idempotent because the grant is needed on two paths: a brand new
 * bootstrap, and a re-run against an administrator that already exists. An
 * account that authenticates but holds no `platform.*` permission can reach
 * nothing, so this is not an optional finishing touch — it is the difference
 * between a usable administrator and a decorative one.
 *
 * Returns true when a grant was actually made.
 */
export async function ensurePlatformRoleAssigned(
  transaction: Transaction<DatabaseSchema>,
  accountId: string,
): Promise<boolean> {
  const granted = await sql<{ account_id: string }>`
      insert into account_roles (account_id, role_id, company_id)
      select ${accountId}::uuid, r.id, null
        from roles r
       where r.company_id is null and lower(r.code) = ${PLATFORM_SUPER_ADMIN_ROLE_CODE}
      on conflict (account_id, role_id) do nothing
      returning account_id
  `.execute(transaction);
  return granted.rows.length > 0;
}

export async function bootstrapPlatformAdministratorInTransaction(
  transaction: Transaction<DatabaseSchema>,
  username: string,
  passwordHash: string,
): Promise<string> {
  await sql`select pg_advisory_xact_lock(hashtext('blueline-platform-bootstrap'))`.execute(
    transaction,
  );

  // Re-running the bootstrap with the SAME username is a repair, not a second
  // administrator: it is how an environment that was bootstrapped before the
  // Platform role existed gets its permissions. The stored password is left
  // exactly as it is — a bootstrap command must never be a password reset, or
  // anyone able to run it could silently take over the account.
  const existingSame = await sql<{ id: string }>`
      select id from accounts
       where account_kind = 'platform_administrator'
         and company_id is null
         and normalized_username = lower(btrim(${username}))
       limit 1
  `.execute(transaction);
  const reused = existingSame.rows[0]?.id;
  if (reused !== undefined) {
    const granted = await ensurePlatformRoleAssigned(transaction, reused);
    if (granted) {
      await recordBootstrapAudit(transaction, reused, "platform_administrator.role_granted", {
        role: PLATFORM_SUPER_ADMIN_ROLE_CODE,
      });
    }
    return reused;
  }

  // A DIFFERENT Platform administrator already exists. Refusing is deliberate:
  // silently creating a second privileged account because a username was
  // mistyped is exactly the outcome a one-time bootstrap must prevent.
  const existingOther = await sql<{ count: number }>`
      select count(*)::int as count
        from accounts
       where account_kind = 'platform_administrator'
  `.execute(transaction);
  if ((existingOther.rows[0]?.count ?? 0) > 0) {
    throw new Error("Platform administrator bootstrap has already been completed");
  }

  const inserted = await sql<{ id: string }>`
      insert into accounts (
        company_id, account_kind, username, password_hash, status, password_changed_at
      ) values (
        null, 'platform_administrator', ${username}, ${passwordHash}, 'active', now()
      )
      returning id
  `.execute(transaction);
  const accountId = inserted.rows[0]?.id;
  if (accountId === undefined) {
    throw new Error("Platform administrator bootstrap did not return an account identifier");
  }
  await ensurePlatformRoleAssigned(transaction, accountId);
  await recordBootstrapAudit(transaction, accountId, "platform_administrator.bootstrap", {
    account_kind: "platform_administrator",
    status: "active",
    role: PLATFORM_SUPER_ADMIN_ROLE_CODE,
  });
  return accountId;
}

/** No password, hash, token or secret is ever written here. */
async function recordBootstrapAudit(
  transaction: Transaction<DatabaseSchema>,
  accountId: string,
  action: string,
  after: Record<string, string>,
): Promise<void> {
  await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        after_data, correlation_id, actor_role, source
      ) values (
        null, ${accountId}::uuid, ${action}, 'account', ${accountId},
        ${JSON.stringify(after)}::jsonb,
        ${`bootstrap:${accountId}`}, 'platform_administrator', 'platform_bootstrap'
      )
  `.execute(transaction);
}
