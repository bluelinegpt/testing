import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ConfigService } from "@nestjs/config";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import type { AppConfiguration } from "../configuration/environment.js";
import { configuration } from "../configuration/environment.js";
import { FileStoragePort } from "../files/file-storage.port.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { PlatformCompanyDeletionBackupService, runBackupProcess } from "./platform-company-deletion-backup.service.js";
import { PlatformCompanyDeletionExecutionService } from "./platform-company-deletion-execution.service.js";
import { PlatformCompanyDeletionService } from "./platform-company-deletion.service.js";

/** No file objects are ever created by this fixture; a real port is unused. */
class NoopStorage extends FileStoragePort {
  public async storePrivate(): Promise<{ storageKey: string }> {
    throw new Error("unused");
  }
  public async readPrivate(): Promise<Uint8Array> {
    throw new Error("unused");
  }
  public async deletePrivate(): Promise<void> {}
  public async storeCommerce(): Promise<{ storageKey: string }> {
    throw new Error("unused");
  }
  public async readCommerce(): Promise<Uint8Array> {
    throw new Error("unused");
  }
  public async deleteCommerce(): Promise<void> {}
}

const runTests = process.env.RUN_PLATFORM_USER_DELETION_DATABASE === "true";

/**
 * Direct proof of the `company_user_accounts_no_delete` guard exception's
 * transaction semantics -- deliberately at the SQL level, against genuinely
 * independent connections, not through the HTTP/savepoint harness used by
 * `platform-user-deletion.database.test.ts`. Savepoint RELEASE (as opposed to
 * ROLLBACK) does not undo a `SET LOCAL` for the rest of an outer transaction,
 * so containment and concurrency can only be measured honestly with real,
 * separate transactions and real commits.
 *
 * Fixtures here are committed, not rolled back, because cross-connection
 * visibility requires it -- and are cleaned up at the end of every test, the
 * account rows via the exact mechanism under test.
 */
describe.skipIf(!runTests)("Platform user deletion guard exception", () => {
  let pool: Pool;
  let database: Kysely<DatabaseSchema>;
  let configService: ConfigService<AppConfiguration, true>;
  let actorId: string;

  beforeAll(async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });
    const settings = configuration();
    pool = new Pool({ connectionString: settings.database.url, max: 8 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    configService = new ConfigService<AppConfiguration, true>(settings);
    actorId = (
      await sql<{ id: string }>`
        select id from accounts where account_kind = 'platform_administrator' order by created_at limit 1
      `.execute(database)
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await database.destroy();
  });

  /**
   * Permanently removes a fixture Company through the REAL Company deletion
   * engine. Needed for the "D-shared" Company below: it holds a `roles` row,
   * and `roles_no_delete` has no raw-SQL exception at all -- but the
   * deletion engine's own reviewed guard allowlist
   * (`COMPANY_DELETION_APPROVED_GUARDS`) DOES include `roles_no_delete`,
   * since a Company's own Roles are exactly the kind of Company-owned data a
   * full deletion is meant to remove. What this suite proves (raw SQL can
   * never bypass the guard) and what this cleanup uses (the one reviewed,
   * audited, transaction-scoped mechanism that legitimately can) are
   * different code paths -- using the second to tidy up after testing the
   * first does not weaken what the first proves.
   */
  async function deleteFixtureCompany(companyId: string, code: string): Promise<void> {
    await sql`update companies set status = 'closed', closed_at = now() where id = ${companyId}::uuid`.execute(
      database,
    );
    const key = randomUUID();
    const preview = (await new PlatformCompanyDeletionService(database).preview(
      companyId,
      { accountId: actorId, correlationId: randomUUID() },
      key,
    )) as { operationId: string; previewId: string };
    await new PlatformCompanyDeletionBackupService(database, configService, runBackupProcess).createVerifiedBackup(
      companyId,
      preview.operationId,
      actorId,
    );
    await new PlatformCompanyDeletionExecutionService(
      database,
      configService,
      new NoopStorage(),
      () => undefined,
    ).execute(companyId, {
      operationId: preview.operationId,
      previewId: preview.previewId,
      confirmation: `DELETE ${code}`,
      idempotencyKey: key,
    });
  }

  /** A committed fixture Company, with no children beyond what each test adds.
   * `companies.environment` defaults to `production` at the schema level —
   * override it explicitly, or a fixture that outlives a failed test run
   * inherits Production's 48-hour deletion wait for no reason connected to
   * what it actually is. */
  const makeCompany = async (tag: string): Promise<string> => {
    const suffix = randomUUID().slice(0, 8);
    const id = randomUUID();
    await sql`
      insert into companies (id, code, subdomain, name_en, status, environment)
      values (${id}::uuid, ${`GX${tag}${suffix}`}, ${`gx${tag.toLowerCase()}${suffix}`}, ${`Guard Exception ${tag} ${suffix}`}, 'active', 'development')
    `.execute(database);
    return id;
  };

  /**
   * A committed fixture `company_user` account, deliberately WITHOUT
   * history. Created `disabled`, not `active`, on purpose:
   * `accounts_active_role_guard` only requires an active Role for accounts
   * with `status = 'active'`, and a Role, once created, can never be
   * deleted (`roles_no_delete` has no exception -- deliberately, that guard
   * is unrelated to and untouched by this feature). Using non-active
   * fixtures lets every row this suite creates be cleaned up completely,
   * with nothing left behind. What these tests exercise -- the delete
   * trigger and transaction semantics -- does not depend on the account
   * being active.
   */
  const makeAccount = async (companyId: string, tag: string): Promise<string> => {
    const suffix = randomUUID().slice(0, 8);
    const id = randomUUID();
    const username = `gx.${tag}.${suffix}`;
    await database.transaction().execute(async (transaction) => {
      await sql`
        insert into accounts (id, company_id, account_kind, username, normalized_username, password_hash, status, password_changed_at)
        values (${id}::uuid, ${companyId}::uuid, 'company_user', ${username}, ${username.toLowerCase()}, 'x', 'disabled', now())
      `.execute(transaction);
      await sql`
        insert into company_users (id, company_id, account_id, name_en, name_ar, display_name)
        values (${randomUUID()}::uuid, ${companyId}::uuid, ${id}::uuid, ${`Guard ${tag}`}, ${`Guard ${tag}`}, ${`Guard ${tag}`})
      `.execute(transaction);
    });
    return id;
  };

  /** Removes every fixture row left under a Company, including any account
   * still present (through the exact production mechanism), before the
   * Company row itself. */
  const dropCompany = async (companyId: string): Promise<void> => {
    const remaining = (
      await sql<{ id: string }>`select id from accounts where company_id = ${companyId}::uuid`.execute(database)
    ).rows;
    for (const account of remaining) {
      await database.transaction().execute(async (transaction) => {
        await sql`set local blueline.platform_user_delete = 'on'`.execute(transaction);
        await sql`delete from account_sessions where account_id = ${account.id}::uuid`.execute(transaction);
        await sql`delete from password_reset_tokens where account_id = ${account.id}::uuid`.execute(transaction);
        await sql`delete from account_roles where account_id = ${account.id}::uuid`.execute(transaction);
        await sql`delete from company_users where account_id = ${account.id}::uuid`.execute(transaction);
        await sql`delete from accounts where id = ${account.id}::uuid`.execute(transaction);
      });
    }
    await sql`delete from company_users where company_id = ${companyId}::uuid`.execute(database);
    await sql`delete from companies where id = ${companyId}::uuid`.execute(database);
  };

  /** Deletes through the exact production mechanism, in its own transaction. */
  const deleteWithFlag = async (accountId: string): Promise<void> => {
    await database.transaction().execute(async (transaction) => {
      await sql`set local blueline.platform_user_delete = 'on'`.execute(transaction);
      await sql`delete from account_sessions where account_id = ${accountId}::uuid`.execute(transaction);
      await sql`delete from password_reset_tokens where account_id = ${accountId}::uuid`.execute(transaction);
      await sql`delete from account_roles where account_id = ${accountId}::uuid`.execute(transaction);
      await sql`delete from company_users where account_id = ${accountId}::uuid`.execute(transaction);
      await sql`delete from accounts where id = ${accountId}::uuid`.execute(transaction);
    });
  };

  it(
    "blocks a raw delete with no flag, in a genuine standalone transaction",
    async () => {
      const companyId = await makeCompany("A");
      const accountId = await makeAccount(companyId, "noflag");
      try {
        await expect(
          database.transaction().execute(async (transaction) => {
            await sql`delete from accounts where id = ${accountId}::uuid`.execute(transaction);
          }),
        ).rejects.toThrow(/cannot be deleted/i);

        expect(
          (
            await sql<{ n: string }>`select count(*)::bigint n from accounts where id = ${accountId}::uuid`.execute(
              database,
            )
          ).rows[0]?.n,
        ).toBe("1");
      } finally {
        await deleteWithFlag(accountId).catch(() => undefined);
        await dropCompany(companyId);
      }
    },
    60_000,
  );

  it(
    "still blocks roles deletion even with the accounts flag set in the same transaction",
    async () => {
      const roleId = randomUUID();
      const suffix = randomUUID().slice(0, 8);
      await database.transaction().execute(async (transaction) => {
        await sql`
          insert into roles (id, company_id, code, name, is_system)
          values (${roleId}::uuid, null, ${`gx_role_${suffix}`}, ${`GX Role ${suffix}`}, false)
        `.execute(transaction);
        await sql`
          insert into role_permissions (role_id, permission_code) values (${roleId}::uuid, 'platform.access')
        `.execute(transaction);
      });
      try {
        await expect(
          database.transaction().execute(async (transaction) => {
            await sql`set local blueline.platform_user_delete = 'on'`.execute(transaction);
            await sql`delete from roles where id = ${roleId}::uuid`.execute(transaction);
          }),
        ).rejects.toThrow(/cannot be deleted/i);

        expect(
          (
            await sql<{ n: string }>`select count(*)::bigint n from roles where id = ${roleId}::uuid`.execute(
              database,
            )
          ).rows[0]?.n,
        ).toBe("1");
      } finally {
        // Deliberately no cleanup delete of the role itself: this test's own
        // assertion is that no path -- including this one, flag and all --
        // can ever remove it. A fixture that could not be removed is the
        // expected, permanent shape of a Role row; there is nothing to undo.
      }
    },
    60_000,
  );

  it(
    "the flag never crosses transactions: it lifts the guard only inside the transaction that set it",
    async () => {
      const companyId = await makeCompany("B");
      const flagged = await makeAccount(companyId, "flagged");
      const unflagged = await makeAccount(companyId, "unflagged");
      try {
        // Set inside one transaction, and used inside it -- succeeds.
        await database.transaction().execute(async (transaction) => {
          await sql`set local blueline.platform_user_delete = 'on'`.execute(transaction);
          await sql`delete from company_users where account_id = ${flagged}::uuid`.execute(transaction);
          const removed = await sql`delete from accounts where id = ${flagged}::uuid`.execute(transaction);
          expect(removed.numAffectedRows).toBe(1n);
        });

        // A brand-new transaction, on the same pool, never saw that setting.
        await expect(
          database.transaction().execute(async (transaction) => {
            await sql`delete from accounts where id = ${unflagged}::uuid`.execute(transaction);
          }),
        ).rejects.toThrow(/cannot be deleted/i);

        expect(
          (
            await sql<{ n: string }>`select count(*)::bigint n from accounts where id = ${unflagged}::uuid`.execute(
              database,
            )
          ).rows[0]?.n,
        ).toBe("1");
      } finally {
        await deleteWithFlag(unflagged).catch(() => undefined);
        await dropCompany(companyId);
      }
    },
    60_000,
  );

  it(
    "a rolled-back deletion leaves the flag with no lasting effect, and every row intact",
    async () => {
      const companyId = await makeCompany("C");
      const accountId = await makeAccount(companyId, "rollback");
      try {
        await sql`
          insert into account_sessions (id, account_id, company_id, token_hash, expires_at)
          values (${randomUUID()}::uuid, ${accountId}::uuid, ${companyId}::uuid, ${randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")}, now() + interval '1 hour')
        `.execute(database);

        await expect(
          database.transaction().execute(async (transaction) => {
            await sql`set local blueline.platform_user_delete = 'on'`.execute(transaction);
            await sql`delete from account_sessions where account_id = ${accountId}::uuid`.execute(transaction);
            await sql`delete from company_users where account_id = ${accountId}::uuid`.execute(transaction);
            await sql`delete from accounts where id = ${accountId}::uuid`.execute(transaction);
            throw new Error("simulated failure after the delete, before commit");
          }),
        ).rejects.toThrow("simulated failure after the delete, before commit");

        // Every row this transaction touched is back, whole.
        expect(
          (
            await sql<{ n: string }>`select count(*)::bigint n from accounts where id = ${accountId}::uuid`.execute(
              database,
            )
          ).rows[0]?.n,
        ).toBe("1");
        expect(
          (
            await sql<{ n: string }>`select count(*)::bigint n from company_users where account_id = ${accountId}::uuid`.execute(
              database,
            )
          ).rows[0]?.n,
        ).toBe("1");
        expect(
          (
            await sql<{ n: string }>`select count(*)::bigint n from account_sessions where account_id = ${accountId}::uuid`.execute(
              database,
            )
          ).rows[0]?.n,
        ).toBe("1");

        // And the flag itself carries no residue: a fresh transaction on the
        // same pool still hits the guard unconditionally.
        await expect(
          database.transaction().execute(async (transaction) => {
            await sql`delete from accounts where id = ${accountId}::uuid`.execute(transaction);
          }),
        ).rejects.toThrow(/cannot be deleted/i);
      } finally {
        await sql`delete from account_sessions where account_id = ${accountId}::uuid`.execute(database);
        await deleteWithFlag(accountId).catch(() => undefined);
        await dropCompany(companyId);
      }
    },
    60_000,
  );

  it(
    "a failure injected at each step of the delete sequence undoes the whole transaction, not just the failed step",
    async () => {
      // One Company and one Role, shared across every injection point in
      // this test: a Role can never be raw-deleted (`roles_no_delete` has
      // no exception -- see the note on `makeAccount`), so a fresh Role per
      // iteration would leave five orphaned Companies instead of one. Only
      // the account fixtures, which genuinely are removable by raw SQL, are
      // cleaned up per iteration; the shared Company+Role are removed once
      // at the very end, through the real Company deletion engine (see
      // `deleteFixtureCompany`) -- the one mechanism that is actually
      // allowed to lift `roles_no_delete`, reviewed and audited, unlike
      // anything this test itself exercises.
      const sharedCompanyId = await makeCompany("D-shared");
      const sharedRoleId = randomUUID();
      const suffix = randomUUID().slice(0, 8);
      await database.transaction().execute(async (transaction) => {
        await sql`
          insert into roles (id, company_id, code, name, is_system)
          values (${sharedRoleId}::uuid, ${sharedCompanyId}::uuid, ${`gx_role_${suffix}`}, ${`GX Role ${suffix}`}, false)
        `.execute(transaction);
        await sql`
          insert into role_permissions (role_id, permission_code) values (${sharedRoleId}::uuid, 'company_profile.manage')
        `.execute(transaction);
      });

      try {
      const steps = ["sessions", "tokens", "roles", "membership", "accounts"] as const;
      for (const failAfter of steps) {
        const accountId = await makeAccount(sharedCompanyId, failAfter);
        await sql`insert into account_roles (account_id, role_id, company_id) values (${accountId}::uuid, ${sharedRoleId}::uuid, ${sharedCompanyId}::uuid)`.execute(
          database,
        );
        await sql`
          insert into account_sessions (id, account_id, company_id, token_hash, expires_at)
          values (${randomUUID()}::uuid, ${accountId}::uuid, ${sharedCompanyId}::uuid, ${randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")}, now() + interval '1 hour')
        `.execute(database);
        await sql`
          insert into password_reset_tokens (id, account_id, company_id, token_hash, expires_at)
          values (${randomUUID()}::uuid, ${accountId}::uuid, ${sharedCompanyId}::uuid, ${randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")}, now() + interval '1 hour')
        `.execute(database);

        try {
          await expect(
            database.transaction().execute(async (transaction) => {
              await sql`set local blueline.platform_user_delete = 'on'`.execute(transaction);
              await sql`delete from account_sessions where account_id = ${accountId}::uuid`.execute(transaction);
              if (failAfter === "sessions") throw new Error("injected failure");
              await sql`delete from password_reset_tokens where account_id = ${accountId}::uuid`.execute(
                transaction,
              );
              if (failAfter === "tokens") throw new Error("injected failure");
              await sql`delete from account_roles where account_id = ${accountId}::uuid`.execute(transaction);
              if (failAfter === "roles") throw new Error("injected failure");
              await sql`delete from company_users where account_id = ${accountId}::uuid`.execute(transaction);
              if (failAfter === "membership") throw new Error("injected failure");
              await sql`delete from accounts where id = ${accountId}::uuid`.execute(transaction);
              if (failAfter === "accounts") throw new Error("injected failure");
            }),
          ).rejects.toThrow("injected failure");

          // Nothing this transaction touched actually moved -- proven per
          // table, for every injection point, not just the last one.
          const countOf = async (table: string, column: string): Promise<string | undefined> =>
            (
              await sql<{ n: string }>`
                select count(*)::bigint n from ${sql.ref(table)} where ${sql.ref(column)} = ${accountId}::uuid
              `.execute(database)
            ).rows[0]?.n;
          expect(await countOf("accounts", "id")).toBe("1");
          expect(await countOf("company_users", "account_id")).toBe("1");
          expect(await countOf("account_roles", "account_id")).toBe("1");
          expect(await countOf("account_sessions", "account_id")).toBe("1");
          expect(await countOf("password_reset_tokens", "account_id")).toBe("1");
        } finally {
          await sql`delete from account_sessions where account_id = ${accountId}::uuid`.execute(database);
          await sql`delete from password_reset_tokens where account_id = ${accountId}::uuid`.execute(database);
          await deleteWithFlag(accountId).catch(() => undefined);
        }
      }
      } finally {
        const shared = (
          await sql<{ code: string }>`select code from companies where id = ${sharedCompanyId}::uuid`.execute(
            database,
          )
        ).rows[0];
        if (shared !== undefined) await deleteFixtureCompany(sharedCompanyId, shared.code);
      }
    },
    120_000,
  );

  it(
    "two simultaneous deletions of the same account: exactly one succeeds, the other finds nothing left, no duplication",
    async () => {
      const companyId = await makeCompany("E");
      const accountId = await makeAccount(companyId, "race");
      try {
        const attempt = () =>
          database
            .transaction()
            .execute(async (transaction) => {
              // Mirrors the service's own first step: lock the row before
              // acting on it, so a concurrent attempt genuinely waits rather
              // than racing on the delete itself.
              const locked = await sql<{ id: string }>`
                select id from accounts where id = ${accountId}::uuid for update
              `.execute(transaction);
              if (locked.rows.length === 0) {
                return { deleted: false as const };
              }
              await sql`set local blueline.platform_user_delete = 'on'`.execute(transaction);
              await sql`delete from company_users where account_id = ${accountId}::uuid`.execute(transaction);
              const removed = await sql`delete from accounts where id = ${accountId}::uuid`.execute(transaction);
              return { deleted: (removed.numAffectedRows ?? 0n) === 1n };
            })
            .catch(() => ({ deleted: false as const }));

        const [first, second] = await Promise.all([attempt(), attempt()]);
        const successes = [first, second].filter((result) => result.deleted).length;
        expect(successes).toBe(1);

        expect(
          (
            await sql<{ n: string }>`select count(*)::bigint n from accounts where id = ${accountId}::uuid`.execute(
              database,
            )
          ).rows[0]?.n,
        ).toBe("0");
      } finally {
        await sql`delete from company_users where account_id = ${accountId}::uuid`.execute(database);
        await dropCompany(companyId);
      }
    },
    60_000,
  );
});
