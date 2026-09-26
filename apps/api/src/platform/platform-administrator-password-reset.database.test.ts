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
import { PasswordHasher } from "../authentication/password-hasher.js";
import { resetPlatformAdministratorPassword } from "./platform-administrator-password-reset.js";
import { PLATFORM_SUPER_ADMIN_ROLE_CODE } from "./platform-authorization.js";
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

const runDatabaseTests = process.env.RUN_PLATFORM_ADMIN_PASSWORD_RESET_DATABASE === "true";

/**
 * `resetPlatformAdministratorPassword` opens its own top-level transaction
 * (Kysely does not support nesting `.transaction()` inside a `Transaction`),
 * so unlike most database tests in this suite these fixtures are genuinely
 * committed. Every one is a fresh, randomly-suffixed `platform_administrator`
 * account -- the one account kind `reject_administration_delete` allows a
 * real `DELETE` against unconditionally -- so cleanup in `finally` is exact
 * and complete, not best-effort.
 */
describe.skipIf(!runDatabaseTests)("platform administrator password reset", () => {
  let database: Kysely<DatabaseSchema>;
  let configService: ConfigService<AppConfiguration, true>;
  let actorId: string;
  const hasher = new PasswordHasher();

  beforeAll(async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 4 });
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
   * Permanently removes a fixture Company (and its unremovable `company_user`
   * account) through the REAL Company deletion engine, exactly as a Platform
   * Administrator would: close, preview, verified backup, execute. Replaces
   * the old `delete from companies ... catch(() => undefined)` cleanup, which
   * always failed silently — `company_user` accounts can never be raw-deleted
   * (`reject_administration_delete`), so the Company row was left behind on
   * every single run. This is what turns that permanent residue back into
   * zero residue, using the same engine `platform-dashboard.database.test.ts`
   * fixture cleanup already established.
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

  it(
    "sets a new password, clears lockout, reactivates, restores the role, ends sessions, and never targets a Company user",
    async () => {
      const suffix = randomUUID().slice(0, 8);
      const username = `pwreset.admin.${suffix}`;
      const originalHash = await hasher.hash("original-locked-out-password-1234");
      const accountId = randomUUID();
      const sessionId = randomUUID();
      try {
        await sql`
          insert into accounts (
            id, company_id, account_kind, username, normalized_username, password_hash, status,
            failed_login_attempts, locked_until, password_changed_at
          ) values (
            ${accountId}::uuid, null, 'platform_administrator', ${username}, ${username}, ${originalHash},
            'disabled', 5, now() + interval '10 minutes', now() - interval '5 days'
          )
        `.execute(database);
        await sql`
          insert into account_sessions (id, account_id, token_hash, expires_at)
          values (${sessionId}::uuid, ${accountId}::uuid, ${randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")}, now() + interval '1 hour')
        `.execute(database);

        const newPassword = "brand-new-verified-password-9876";
        const resultId = await resetPlatformAdministratorPassword(
          database,
          { password: newPassword, username },
          hasher,
        );
        expect(resultId).toBe(accountId);

        const after = await sql<{
          status: string;
          failedLoginAttempts: number;
          lockedUntil: Date | null;
          passwordHash: string;
        }>`
          select status, failed_login_attempts as "failedLoginAttempts",
                 locked_until as "lockedUntil", password_hash as "passwordHash"
            from accounts where id = ${accountId}::uuid
        `.execute(database);
        const row = after.rows[0]!;
        expect(row.status).toBe("active");
        expect(row.failedLoginAttempts).toBe(0);
        expect(row.lockedUntil).toBeNull();
        expect(await hasher.verify(newPassword, row.passwordHash)).toBe(true);
        expect(await hasher.verify("original-locked-out-password-1234", row.passwordHash)).toBe(
          false,
        );

        const session = await sql<{ revokedAt: Date | null }>`
          select revoked_at as "revokedAt" from account_sessions where id = ${sessionId}::uuid
        `.execute(database);
        expect(session.rows[0]?.revokedAt).not.toBeNull();

        const role = await sql<{ code: string }>`
          select r.code from account_roles ar join roles r on r.id = ar.role_id
           where ar.account_id = ${accountId}::uuid and r.company_id is null
        `.execute(database);
        expect(role.rows.map((r) => r.code)).toContain(PLATFORM_SUPER_ADMIN_ROLE_CODE);

        const audit = await sql<{ action: string }>`
          select action from audit_events
           where subject_id = ${accountId} and action = 'platform_administrator.password_reset'
        `.execute(database);
        expect(audit.rows).toHaveLength(1);
      } finally {
        // `audit_events.actor_account_id` has an `ON DELETE RESTRICT` FK, and
        // the reset itself just wrote one for this account -- the same
        // "permanently undeletable once audited" shape used elsewhere in
        // this suite. Leave it disabled rather than attempt (and fail) a
        // delete; there is nothing else left to remove.
        await sql`delete from account_sessions where account_id = ${accountId}::uuid`.execute(database);
        await sql`update accounts set status = 'disabled' where id = ${accountId}::uuid`.execute(database);
      }
    },
    30_000,
  );

  it(
    "refuses a username that has no existing Platform administrator, and never creates one",
    async () => {
      const missingUsername = `no.such.admin.${randomUUID().slice(0, 8)}`;
      await expect(
        resetPlatformAdministratorPassword(database, {
          password: "some-long-enough-password-value",
          username: missingUsername,
        }),
      ).rejects.toThrow(/No Platform administrator account named/);

      const created = await sql<{ n: string }>`
        select count(*)::text n from accounts where normalized_username = ${missingUsername}
      `.execute(database);
      expect(created.rows[0]?.n).toBe("0");
    },
    30_000,
  );

  it(
    "never targets or resets a Company user account with the same username",
    async () => {
      const suffix = randomUUID().slice(0, 8);
      const username = `shared.name.${suffix}`;
      const companyId = randomUUID();
      const companyCode = `PWRST${suffix}`;
      const companyUserId = randomUUID();
      const originalHash = await hasher.hash("company-user-original-password-1234");
      try {
        await sql`
          insert into companies (id, code, subdomain, name_en, status, environment)
          values (${companyId}::uuid, ${companyCode}, ${`pwrst-${suffix}`}, 'PW Reset Co', 'active', 'development')
        `.execute(database);
        await sql`
          insert into accounts (id, company_id, account_kind, username, normalized_username, password_hash, status, password_changed_at)
          values (${companyUserId}::uuid, ${companyId}::uuid, 'company_user', ${username}, ${username}, ${originalHash}, 'disabled', now())
        `.execute(database);

        await expect(
          resetPlatformAdministratorPassword(database, {
            password: "some-long-enough-password-value",
            username,
          }),
        ).rejects.toThrow(/No Platform administrator account named/);

        const untouched = await sql<{ passwordHash: string }>`
          select password_hash as "passwordHash" from accounts where id = ${companyUserId}::uuid
        `.execute(database);
        expect(
          await hasher.verify("company-user-original-password-1234", untouched.rows[0]!.passwordHash),
        ).toBe(true);
      } finally {
        // `company_user` accounts can never be raw-deleted
        // (`reject_administration_delete`) -- the real Company deletion
        // engine can, since it is one of the reviewed, transaction-scoped
        // guard exceptions (`COMPANY_DELETION_APPROVED_GUARDS`). See
        // `deleteFixtureCompany` above.
        await deleteFixtureCompany(companyId, companyCode);
      }
    },
    30_000,
  );
});
