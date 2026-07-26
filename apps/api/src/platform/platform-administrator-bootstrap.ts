import { type Kysely, sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { PasswordHasher } from "../authentication/password-hasher.js";

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

export async function bootstrapPlatformAdministratorInTransaction(
  transaction: Transaction<DatabaseSchema>,
  username: string,
  passwordHash: string,
): Promise<string> {
  await sql`select pg_advisory_xact_lock(hashtext('blueline-platform-bootstrap'))`.execute(
    transaction,
  );
  const existing = await sql<{ count: number }>`
      select count(*)::int as count
        from accounts
       where account_kind = 'platform_administrator'
  `.execute(transaction);
  if ((existing.rows[0]?.count ?? 0) > 0) {
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
  await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        after_data, correlation_id
      ) values (
        null, ${accountId}::uuid, 'platform_administrator.bootstrap', 'account', ${accountId},
        jsonb_build_object('account_kind', 'platform_administrator', 'status', 'active'),
        ${`bootstrap:${accountId}`}
      )
  `.execute(transaction);
  return accountId;
}
