import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

import { defaultExpenseTypes } from "./company-defaults.js";
import { bootstrapDevelopmentCompany } from "./development-company-bootstrap.js";

const runDatabaseTests = process.env.RUN_PROVISIONING_DATABASE === "true";
const rollbackMarker = Symbol("rollback bootstrap database test");

describe.skipIf(!runDatabaseTests)("development company bootstrap", () => {
  it("creates a Company, administrator, Role, permissions and defaults", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

    try {
      await database.transaction().execute(async (transaction) => {
        const subdomain = `boot-${randomUUID().slice(0, 8)}`;
        const username = `boot.admin.${randomUUID().slice(0, 8)}`;
        // A hash placeholder: the bootstrap never receives a plaintext password.
        const passwordHash = "argon2-placeholder-hash";

        const identifiers = await bootstrapDevelopmentCompany(transaction, {
          companyName: "Bootstrap Test Company",
          passwordHash,
          subdomain,
          username,
        });

        const company = await sql<{ code: string; status: string; subdomain: string }>`
          select code, subdomain, status from companies where id = ${identifiers.companyId}::uuid
        `.execute(transaction);
        expect(company.rows).toHaveLength(1);
        expect(company.rows[0]?.status).toBe("active");
        expect(company.rows[0]?.code).toMatch(/^DEV-[0-9A-F]{8}$/);
        expect(company.rows[0]?.subdomain).toBe(subdomain);

        const account = await sql<{ kind: string; status: string; username: string }>`
          select username, status, account_kind as kind from accounts
           where id = ${identifiers.accountId}::uuid
        `.execute(transaction);
        expect(account.rows[0]?.username).toBe(username);
        expect(account.rows[0]?.status).toBe("active");
        expect(account.rows[0]?.kind).toBe("company_user");

        // The regression this test exists for: display_name must be populated.
        const profile = await sql<{ displayName: string; nameEn: string }>`
          select display_name as "displayName", name_en as "nameEn" from company_users
           where account_id = ${identifiers.accountId}::uuid
        `.execute(transaction);
        expect(profile.rows).toHaveLength(1);
        expect(profile.rows[0]?.displayName).toBe("Development Administrator");
        expect(profile.rows[0]?.displayName).not.toBeNull();
        // The legacy column is preserved and kept in step with the display Name.
        expect(profile.rows[0]?.nameEn).toBe("Development Administrator");

        const permissions = await sql<{ code: string }>`
          select rp.permission_code as code
            from account_roles ar
            join roles r on r.id = ar.role_id
            join role_permissions rp on rp.role_id = r.id
           where ar.account_id = ${identifiers.accountId}::uuid
        `.execute(transaction);
        expect(permissions.rows.map((row) => row.code)).toContain("users_roles.manage");

        const role = await sql<{ active: boolean; code: string }>`
          select code, is_active as active from roles where id = ${identifiers.roleId}::uuid
        `.execute(transaction);
        expect(role.rows[0]?.code).toBe("company_admin");
        expect(role.rows[0]?.active).toBe(true);

        // Mandatory Company defaults are seeded.
        const expenseTypes = await sql<{ code: string }>`
          select code from expense_types where company_id = ${identifiers.companyId}::uuid
           order by code
        `.execute(transaction);
        expect(expenseTypes.rows.map((row) => row.code)).toEqual(
          [...defaultExpenseTypes].map((type) => type.code).sort(),
        );

        const audit = await sql<{ action: string }>`
          select action from audit_events where company_id = ${identifiers.companyId}::uuid
        `.execute(transaction);
        expect(audit.rows.map((row) => row.action)).toContain("development_company.bootstrap");

        // Re-running for the same subdomain fails safely instead of mutating.
        await sql.raw("savepoint rerun").execute(transaction);
        await expect(
          bootstrapDevelopmentCompany(transaction, {
            companyName: "Bootstrap Test Company",
            passwordHash,
            subdomain,
            username: `${username}.second`,
          }),
        ).rejects.toThrow(/already exists/);
        await sql.raw("rollback to savepoint rerun").execute(transaction);
        await sql.raw("release savepoint rerun").execute(transaction);

        // Exactly one Company for that subdomain survives.
        const total = await sql<{ value: number }>`
          select count(*)::int as value from companies where lower(subdomain) = lower(${subdomain})
        `.execute(transaction);
        expect(total.rows[0]?.value).toBe(1);

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      await database.destroy();
    }
  }, 60_000);
});
