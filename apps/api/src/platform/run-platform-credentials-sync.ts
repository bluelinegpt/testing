import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import {
  PLATFORM_ACCESS,
  PLATFORM_AUDIT_READ,
  PLATFORM_COMPANIES_READ,
  PLATFORM_ERRORS_READ,
  PLATFORM_INTEGRITY_READ,
  PLATFORM_PERMISSIONS,
  PLATFORM_SUPER_ADMIN_ROLE_CODE,
  PLATFORM_USERS_READ,
} from "./platform-authorization.js";

/**
 * Makes the database match the Platform credentials in `.env`.
 *
 * Exists because a database restore rolls `accounts` back to whatever the
 * backup held: passwords silently revert, lockouts reappear, and the account
 * in `.env` may not exist at all. The bootstrap command cannot repair this —
 * it refuses, by design, to ever touch an existing password. This command is
 * the explicit local-development counterpart: `.env` is the source of truth,
 * and running this makes the database agree with it.
 *
 * Idempotent — safe to run after every restore or `.env` edit:
 * - `BLUELINE_BOOTSTRAP_USERNAME/PASSWORD` → super administrator account
 *   (created if missing) with password reset, lockout cleared, and the
 *   `platform_super_admin` role granted.
 * - `BLUELINE_PLATFORM_VIEWER_USERNAME/PASSWORD` (optional) → read-only
 *   account on the `platform_viewer` role, which is created here with only
 *   the `.read` permission codes — it can see every screen but manage none.
 */
const PLATFORM_VIEWER_ROLE_CODE = "platform_viewer";
const PLATFORM_VIEWER_ROLE_NAME = "Platform Viewer";
const PLATFORM_VIEWER_PERMISSION_CODES: readonly string[] = [
  PLATFORM_ACCESS,
  PLATFORM_COMPANIES_READ,
  PLATFORM_USERS_READ,
  PLATFORM_AUDIT_READ,
  PLATFORM_ERRORS_READ,
  PLATFORM_INTEGRITY_READ,
];

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });

interface AccountSpec {
  readonly label: string;
  readonly password: string;
  readonly roleCode: string;
  readonly username: string;
}

function readSpec(
  label: string,
  usernameKey: string,
  passwordKey: string,
  roleCode: string,
): AccountSpec | undefined {
  const username = process.env[usernameKey]?.trim();
  const password = process.env[passwordKey];
  if (username === undefined || username.length === 0 || password === undefined) {
    return undefined;
  }
  if (password.length < 16 || password.length > 256) {
    throw new Error(`${passwordKey} must be between 16 and 256 characters`);
  }
  return { label, password, roleCode, username };
}

const specs: AccountSpec[] = [];
const admin = readSpec(
  "super administrator",
  "BLUELINE_BOOTSTRAP_USERNAME",
  "BLUELINE_BOOTSTRAP_PASSWORD",
  PLATFORM_SUPER_ADMIN_ROLE_CODE,
);
if (admin === undefined) {
  throw new Error(
    "BLUELINE_BOOTSTRAP_USERNAME and BLUELINE_BOOTSTRAP_PASSWORD are required in .env",
  );
}
specs.push(admin);
const viewer = readSpec(
  "read-only viewer",
  "BLUELINE_PLATFORM_VIEWER_USERNAME",
  "BLUELINE_PLATFORM_VIEWER_PASSWORD",
  PLATFORM_VIEWER_ROLE_CODE,
);
if (viewer !== undefined) {
  specs.push(viewer);
}

async function ensureViewerRole(transaction: Transaction<DatabaseSchema>): Promise<void> {
  for (const permission of PLATFORM_PERMISSIONS) {
    await sql`
        insert into permissions (code, description)
        values (${permission.code}, ${permission.description})
        on conflict (code) do nothing
    `.execute(transaction);
  }
  const existing = await sql<{ id: string }>`
      select id from roles
       where company_id is null and lower(code) = ${PLATFORM_VIEWER_ROLE_CODE}
       limit 1
  `.execute(transaction);
  let roleId = existing.rows[0]?.id;
  if (roleId === undefined) {
    const inserted = await sql<{ id: string }>`
        insert into roles (company_id, code, name, is_system, is_active, description)
        values (null, ${PLATFORM_VIEWER_ROLE_CODE}, ${PLATFORM_VIEWER_ROLE_NAME}, true, true,
                'Read-only access to every Platform Administration screen')
        returning id
    `.execute(transaction);
    roleId = inserted.rows[0]?.id;
    if (roleId === undefined) {
      throw new Error("Creating the platform_viewer role did not return an identifier");
    }
  }
  for (const code of PLATFORM_VIEWER_PERMISSION_CODES) {
    await sql`
        insert into role_permissions (role_id, permission_code)
        values (${roleId}::uuid, ${code})
        on conflict (role_id, permission_code) do nothing
    `.execute(transaction);
  }
}

async function syncAccount(
  transaction: Transaction<DatabaseSchema>,
  spec: AccountSpec,
  passwordHash: string,
): Promise<string> {
  const existing = await sql<{ id: string }>`
      select id from accounts
       where account_kind = 'platform_administrator'
         and company_id is null
         and normalized_username = lower(btrim(${spec.username}))
       limit 1
  `.execute(transaction);
  let accountId = existing.rows[0]?.id;
  if (accountId === undefined) {
    const inserted = await sql<{ id: string }>`
        insert into accounts (
          company_id, account_kind, username, password_hash, status, password_changed_at
        ) values (
          null, 'platform_administrator', ${spec.username}, ${passwordHash}, 'active', now()
        )
        returning id
    `.execute(transaction);
    accountId = inserted.rows[0]?.id;
    if (accountId === undefined) {
      throw new Error(`Creating the ${spec.label} account did not return an identifier`);
    }
  } else {
    await sql`
        update accounts
           set password_hash = ${passwordHash},
               password_changed_at = now(),
               status = 'active',
               failed_login_attempts = 0,
               locked_until = null,
               last_failed_login_at = null
         where id = ${accountId}::uuid
    `.execute(transaction);
  }
  await sql`
      insert into account_roles (account_id, role_id, company_id)
      select ${accountId}::uuid, r.id, null
        from roles r
       where r.company_id is null and lower(r.code) = ${spec.roleCode}
      on conflict (account_id, role_id) do nothing
  `.execute(transaction);
  return accountId;
}

const settings = configuration();
const pool = new Pool({
  application_name: "blueline-platform-credentials-sync",
  connectionTimeoutMillis: settings.database.connectionTimeoutMs,
  connectionString: settings.database.url,
  max: 1,
  query_timeout: settings.database.queryTimeoutMs,
});
const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
const hasher = new PasswordHasher();

try {
  await database.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtext('blueline-platform-credentials-sync'))`.execute(
      transaction,
    );
    await ensureViewerRole(transaction);
    for (const spec of specs) {
      const hash = await hasher.hash(spec.password);
      const accountId = await syncAccount(transaction, spec, hash);
      process.stdout.write(`Synced ${spec.label} "${spec.username}" (${accountId})\n`);
    }
  });
  process.stdout.write("Platform credentials now match .env\n");
} finally {
  await database.destroy();
}
