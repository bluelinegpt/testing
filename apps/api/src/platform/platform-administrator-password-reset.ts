import { type Kysely, sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { ensurePlatformRoleAssigned } from "./platform-administrator-bootstrap.js";
import { PLATFORM_SUPER_ADMIN_ROLE_CODE } from "./platform-authorization.js";

export interface PlatformAdministratorPasswordResetInput {
  readonly username: string;
  readonly password: string;
}

/**
 * Sets a NEW password on an EXISTING Platform administrator account.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, SEPARATE FROM BOOTSTRAP
 * ---------------------------------------------------------------------------
 *
 * `bootstrapPlatformAdministrator` is deliberately, permanently a one-time
 * CREATE: re-running it against a username that already exists leaves the
 * stored password untouched (see the comment in
 * `platform-administrator-bootstrap.ts`) — "a bootstrap command must never be
 * a password reset, or anyone able to run it could silently take over the
 * account." That is correct and this file does not change it.
 *
 * What was missing is the *other* half of that story: once a Platform
 * administrator genuinely forgets or needs to rotate their password, there
 * was no path back at all — no API route (Platform administrators, unlike
 * Company users, have no `/password-reset` endpoint, by design: nothing
 * un-authenticated should ever be able to touch a Platform-level account),
 * and bootstrap refuses on principle. This script is that path: an explicit,
 * narrow, operator-run repair for exactly one already-existing account,
 * identified by username, requiring direct database/host access to invoke —
 * never reachable from a browser, never reachable over HTTP, and using the
 * same `PasswordHasher` and role-repair helper the rest of the authentication
 * system already trusts.
 *
 * ---------------------------------------------------------------------------
 * SAFETY PROPERTIES
 * ---------------------------------------------------------------------------
 *
 * - Only ever targets an account that already matches
 *   `account_kind = 'platform_administrator' and company_id is null` for the
 *   given username — refuses (throws) if no such account exists. It never
 *   creates a new account; that remains bootstrap's job alone.
 * - Never assigns a Company role, never touches `company_id`.
 * - Re-confirms `platform_super_admin` is granted (via the same
 *   `ensurePlatformRoleAssigned` helper bootstrap itself uses) so a repair
 *   that is "reset the password" also silently repairs "the role got lost"
 *   if both happened — it does not touch any other role.
 * - Clears failed-login lockout state (`failed_login_attempts`,
 *   `locked_until`) and reactivates the account if it was `disabled` —
 *   exactly the two states a forgotten-password operator repair is meant to
 *   clear, and nothing else: it does not touch `force_password_change`
 *   (an operator setting a fresh password already satisfies that intent) and
 *   does not resurrect a genuinely different lifecycle state.
 * - Ends every existing session for the account, the same way a real
 *   password change does elsewhere in this codebase — an old session must
 *   not outlive a password an operator just decided to replace.
 * - Writes a Platform audit event recording that a reset happened, by whom
 *   the script was run as (unattributable beyond "the operator"), with no
 *   password, hash, or token ever written to it or to any log.
 */
export async function resetPlatformAdministratorPassword(
  database: Kysely<DatabaseSchema>,
  input: PlatformAdministratorPasswordResetInput,
  passwordHasher = new PasswordHasher(),
): Promise<string> {
  const username = input.username.trim();
  if (!/^[A-Za-z0-9._@-]{3,128}$/.test(username)) {
    throw new Error("Username must be 3-128 characters using letters, numbers, . _ @ or -");
  }
  if (input.password.length < 16 || input.password.length > 256) {
    throw new Error("Password must be between 16 and 256 characters");
  }

  const passwordHash = await passwordHasher.hash(input.password);
  return database.transaction().execute((transaction) =>
    resetInTransaction(transaction, username, passwordHash),
  );
}

async function resetInTransaction(
  transaction: Transaction<DatabaseSchema>,
  username: string,
  passwordHash: string,
): Promise<string> {
  await sql`select pg_advisory_xact_lock(hashtext('blueline-platform-bootstrap'))`.execute(
    transaction,
  );

  const existing = await sql<{ id: string; status: string }>`
      select id, status from accounts
       where account_kind = 'platform_administrator'
         and company_id is null
         and normalized_username = lower(btrim(${username}))
       limit 1
  `.execute(transaction);
  const account = existing.rows[0];
  if (account === undefined) {
    throw new Error(
      `No Platform administrator account named "${username}" exists. This repairs an existing account only -- use the bootstrap command to create one.`,
    );
  }

  await sql`
      update accounts
         set password_hash = ${passwordHash},
             password_changed_at = now(),
             status = case when status = 'disabled' then 'active' else status end,
             failed_login_attempts = 0,
             locked_until = null,
             last_failed_login_at = null,
             updated_at = now(),
             version = version + 1
       where id = ${account.id}::uuid
  `.execute(transaction);
  await sql`
      update account_sessions set revoked_at = now()
       where account_id = ${account.id}::uuid and revoked_at is null
  `.execute(transaction);
  await ensurePlatformRoleAssigned(transaction, account.id);
  await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        before_data, after_data, correlation_id, actor_role, source
      ) values (
        null, ${account.id}::uuid, 'platform_administrator.password_reset', 'account', ${account.id},
        ${JSON.stringify({ status: account.status })}::jsonb,
        ${JSON.stringify({ status: "active", role: PLATFORM_SUPER_ADMIN_ROLE_CODE })}::jsonb,
        ${`operator-reset:${account.id}`}, 'platform_administrator', 'platform_bootstrap'
      )
  `.execute(transaction);

  return account.id;
}
