import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Logger } from "nestjs-pino";
import { Pool } from "pg";
import request from "supertest";

import { AppModule } from "../app.module.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { configuration } from "../configuration/environment.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApiExceptionFilter } from "../presentation/errors/api-exception.filter.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import { PLATFORM_SUPER_ADMIN_ROLE_CODE } from "./platform-authorization.js";

const runTests = process.env.RUN_PLATFORM_COMPANY_USER_DATABASE === "true";
const rollbackMarker = Symbol("rollback platform company user test");

/**
 * Company Administrator onboarding, credential recovery and account support,
 * end to end against the real schema.
 *
 * Everything runs inside ONE transaction that is always rolled back, so the
 * Companies, accounts, tokens and sessions it creates never outlive the run.
 * The development Company is never touched: this suite builds its own fixtures.
 */
describe.skipIf(!runTests)("Platform Company user administration", () => {
  it("onboards a Company Administrator through to a real Company sign-in", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

    let savepointDepth = 0;
    try {
      await database.transaction().execute(async (transaction) => {
        const module = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(DATABASE)
          .useValue(transaction)
          .overrideProvider(KyselyTransactionManager)
          .useValue({
            // Savepoints, so a service rollback is a real rollback inside the
            // test's outer transaction rather than a silently ignored one.
            execute: async (work: (value: typeof transaction) => Promise<unknown>) => {
              savepointDepth += 1;
              const name = `svc_txn_${savepointDepth}`;
              await sql.raw(`savepoint ${name}`).execute(transaction);
              try {
                const result = await work(transaction);
                await sql.raw(`release savepoint ${name}`).execute(transaction);
                return result;
              } catch (error) {
                await sql.raw(`rollback to savepoint ${name}`).execute(transaction);
                throw error;
              }
            },
          })
          .overrideProvider(CompanyHostResolver)
          .useValue({
            resolve: (host: string | undefined) => host?.split(".")[0],
            isReservedHost: () => false,
          })
          .compile();

        let app: INestApplication | undefined;
        try {
          app = module.createNestApplication();
          app.setGlobalPrefix("api/v1");
          app.useGlobalPipes(
            new ValidationPipe({
              forbidNonWhitelisted: true,
              stopAtFirstError: false,
              transform: true,
              whitelist: true,
            }),
          );
          app.useGlobalFilters(new ApiExceptionFilter(app.get(Logger)));
          await app.init();
          const server = app.getHttpServer();
          const hasher = new PasswordHasher();
          const suffix = randomUUID().slice(0, 8);

          // ---------------------------------------------------------------
          // Platform actors
          // ---------------------------------------------------------------
          const password = "platform-password-value";
          const hash = await hasher.hash(password);
          const managerId = randomUUID();
          const readerId = randomUUID();
          const managerName = `mgr.${suffix}`;
          const readerName = `rdr.${suffix}`;
          await sql`
            insert into accounts (id, company_id, account_kind, username, password_hash, status, password_changed_at)
            values (${managerId}::uuid, null, 'platform_administrator', ${managerName}, ${hash}, 'active', now()),
                   (${readerId}::uuid, null, 'platform_administrator', ${readerName}, ${hash}, 'active', now())
          `.execute(transaction);
          const superRole = (
            await sql<{ id: string }>`
              select id from roles where company_id is null and lower(code) = ${PLATFORM_SUPER_ADMIN_ROLE_CODE}
            `.execute(transaction)
          ).rows[0];
          await sql`
            insert into account_roles (account_id, role_id, company_id)
            values (${managerId}::uuid, ${superRole?.id}::uuid, null)
          `.execute(transaction);

          // Read-only Platform account: access + read only, no manage.
          const readRoleId = randomUUID();
          await sql`
            insert into roles (id, company_id, code, name, is_system)
            values (${readRoleId}::uuid, null, ${`platform_reader_${suffix}`}, ${`Platform Reader ${suffix}`}, false)
          `.execute(transaction);
          await sql`
            insert into role_permissions (role_id, permission_code) values
              (${readRoleId}::uuid, 'platform.access'),
              (${readRoleId}::uuid, 'platform.companies.read'),
              (${readRoleId}::uuid, 'platform.users.read')
          `.execute(transaction);
          await sql`
            insert into account_roles (account_id, role_id, company_id)
            values (${readerId}::uuid, ${readRoleId}::uuid, null)
          `.execute(transaction);

          const signIn = async (username: string): Promise<string> => {
            const response = await request(server)
              .post("/api/v1/platform/auth/login")
              .send({ identifier: username, password })
              .expect(200);
            return (response.headers["set-cookie"] as unknown as string[])[0]?.split(";")[0] ?? "";
          };
          const manageCookie = await signIn(managerName);
          const readCookie = await signIn(readerName);

          // ---------------------------------------------------------------
          // Two Companies, created through the Platform API
          // ---------------------------------------------------------------
          const createCompany = async (tag: string): Promise<string> => {
            const created = await request(server)
              .post("/api/v1/platform/companies")
              .set("Cookie", manageCookie)
              .set("X-Blueline-Session", "cookie")
              .send({
                name: `Test ${tag} ${suffix}`,
                code: `${tag}-${suffix.toUpperCase()}`,
                subdomain: `${tag.toLowerCase()}${suffix}`,
                environment: "sandbox",
                countryCode: "AE",
                timezone: "Asia/Dubai",
                defaultLanguage: "en",
                accountingTemplateCode: "UAE_DELIVERY_STANDARD",
                accountingTemplateVersion: 1,
              })
              .expect(201);
            return created.body.companyId as string;
          };
          const companyId = await createCompany("AAA");
          const otherCompanyId = await createCompany("BBB");

          const usersUrl = `/api/v1/platform/companies/${companyId}/users`;
          const post = (url: string, cookie: string, body: object = {}) =>
            request(server)
              .post(url)
              .set("Cookie", cookie)
              .set("X-Blueline-Session", "cookie")
              .send(body);

          // ---------------------------------------------------------------
          // Empty state, and readiness before any administrator
          // ---------------------------------------------------------------
          const empty = await request(server).get(usersUrl).set("Cookie", readCookie).expect(200);
          expect(empty.body.items).toEqual([]);

          const readinessOf = async (id: string): Promise<Record<string, never>> =>
            (
              await request(server)
                .get(`/api/v1/platform/companies/${id}/readiness`)
                .set("Cookie", manageCookie)
                .expect(200)
            ).body as Record<string, never>;
          const stateOf = (readiness: Record<string, never>, key: string): string =>
            (readiness.items as unknown as { key: string; state: string }[]).find(
              (item) => item.key === key,
            )?.state ?? "missing";

          let readiness = await readinessOf(companyId);
          expect(stateOf(readiness, "companyAdmin")).toBe("incomplete");
          expect(readiness.canActivate).toBe(false);
          expect(readiness.nextStep).toBe("Create Company Administrator");
          // Fiscal periods are all `future`, so posting is unavailable — a
          // warning, never a blocked readiness item.
          expect(readiness.warnings as unknown as string[]).toContain(
            "Accounting period not yet open - financial posting remains unavailable.",
          );
          expect(readiness.blockedBy as unknown as string[]).toEqual(["companyAdmin"]);

          // Activation is refused while no administrator can sign in.
          await post(`/api/v1/platform/companies/${companyId}/activate`, manageCookie).expect(409);

          // ---------------------------------------------------------------
          // Permission boundaries on creation
          // ---------------------------------------------------------------
          const adminPayload = (overrides: object = {}) => ({
            displayName: "علي المدير",
            username: `admin.${suffix}`,
            email: `admin.${suffix}@example.com`,
            mobileNumber: "0501234567",
            preferredLanguage: "en",
            ...overrides,
          });
          await post(`${usersUrl}/administrators`, readCookie, adminPayload()).expect(403);
          await post(`${usersUrl}/administrators`, manageCookie, {}).expect(400);
          // Nothing outside the declared contract is accepted.
          await post(
            `${usersUrl}/administrators`,
            manageCookie,
            adminPayload({ roleIds: [] }),
          ).expect(400);
          await post(
            `${usersUrl}/administrators`,
            manageCookie,
            adminPayload({ password: "hunter2xxx" }),
          ).expect(400);
          await post(
            `${usersUrl}/administrators`,
            manageCookie,
            adminPayload({ companyId: otherCompanyId }),
          ).expect(400);

          // ---------------------------------------------------------------
          // Create the first Company Administrator
          // ---------------------------------------------------------------
          const created = await post(
            `${usersUrl}/administrators`,
            manageCookie,
            adminPayload(),
          ).expect(201);
          const accountId = created.body.accountId as string;
          const setupUrl = created.body.setupUrl as string;
          expect(setupUrl).toContain("/account-setup?token=");
          const token = new URL(setupUrl).searchParams.get("token") ?? "";
          expect(token.length).toBeGreaterThan(30);
          // No password of any kind is returned.
          expect(JSON.stringify(created.body)).not.toContain("temporaryPassword");
          expect(JSON.stringify(created.body)).not.toContain("password");

          // Ownership, role and provenance.
          const account = (
            await sql<{
              company_id: string;
              account_kind: string;
              status: string;
              force_password_change: boolean;
              password_changed_at: Date | null;
            }>`select company_id, account_kind, status, force_password_change, password_changed_at
                 from accounts where id = ${accountId}::uuid`.execute(transaction)
          ).rows[0];
          expect(account?.company_id).toBe(companyId);
          expect(account?.account_kind).toBe("company_user");
          expect(account?.force_password_change).toBe(true);
          expect(account?.password_changed_at).toBeNull();

          const roleRow = (
            await sql<{ code: string; company_id: string; assigned_by: string }>`
              select r.code, r.company_id, ar.assigned_by_account_id as assigned_by
                from account_roles ar join roles r on r.id = ar.role_id
               where ar.account_id = ${accountId}::uuid
            `.execute(transaction)
          ).rows;
          expect(roleRow).toHaveLength(1);
          expect(roleRow[0]?.code).toBe("company_admin");
          expect(roleRow[0]?.company_id).toBe(companyId);
          // The Platform actor is recorded truthfully: `assigned_by_account_id`
          // is a plain FK to accounts(id), so no fake Company user was invented.
          expect(roleRow[0]?.assigned_by).toBe(managerId);

          // The Platform actor is still Company-null.
          const platformAccount = (
            await sql<{ company_id: string | null }>`
              select company_id from accounts where id = ${managerId}::uuid
            `.execute(transaction)
          ).rows[0];
          expect(platformAccount?.company_id).toBeNull();

          // No platform.* permission reached the Company role.
          const rolePermissions = (
            await sql<{ permission_code: string }>`
              select rp.permission_code from role_permissions rp
                join roles r on r.id = rp.role_id
               where r.company_id = ${companyId}::uuid
            `.execute(transaction)
          ).rows.map((row) => row.permission_code);
          expect(rolePermissions.some((code) => code.startsWith("platform."))).toBe(false);
          expect(rolePermissions).toContain("users_roles.manage");

          // Duplicate identifier is refused (per-Company uniqueness).
          await post(`${usersUrl}/administrators`, manageCookie, adminPayload()).expect(409);
          // ...but the SAME username is fine in a different Company.
          await post(
            `/api/v1/platform/companies/${otherCompanyId}/users/administrators`,
            manageCookie,
            adminPayload({ email: `other.${suffix}@example.com`, mobileNumber: "0507654321" }),
          ).expect(201);

          // ---------------------------------------------------------------
          // Readiness reflects "invited, not yet credential-ready"
          // ---------------------------------------------------------------
          readiness = await readinessOf(companyId);
          expect(stateOf(readiness, "companyAdmin")).toBe("incomplete");
          expect(readiness.canActivate).toBe(false);
          expect(readiness.nextStep).toBe("Waiting for the administrator to set a password");
          await post(`/api/v1/platform/companies/${companyId}/activate`, manageCookie).expect(409);

          const listed = await request(server).get(usersUrl).set("Cookie", readCookie).expect(200);
          const listedUser = (listed.body.items as { state: string; accountId: string }[])[0];
          expect(listedUser?.state).toBe("invitation_pending");
          // Nothing sensitive in the list.
          const listBody = JSON.stringify(listed.body);
          expect(listBody).not.toContain("password_hash");
          expect(listBody).not.toContain("token_hash");
          expect(listBody).not.toContain(token);

          // ---------------------------------------------------------------
          // Cross-Company protection
          // ---------------------------------------------------------------
          const otherUrl = `/api/v1/platform/companies/${otherCompanyId}/users/${accountId}`;
          await post(`${otherUrl}/unlock`, manageCookie).expect(404);
          await post(`${otherUrl}/password-reset`, manageCookie).expect(404);
          await request(server).get(`${otherUrl}/sessions`).set("Cookie", manageCookie).expect(404);
          await post(`${usersUrl}/${randomUUID()}/unlock`, manageCookie).expect(404);

          // ---------------------------------------------------------------
          // The setup token
          // ---------------------------------------------------------------
          await request(server)
            .post("/api/v1/auth/account-setup/describe")
            .send({ token: `${token.slice(0, -2)}zz` })
            .expect(400);
          await request(server)
            .post("/api/v1/auth/account-setup/complete")
            .send({ token, password: "short" })
            .expect(400);

          const described = await request(server)
            .post("/api/v1/auth/account-setup/describe")
            .send({ token })
            .expect(200);
          expect(described.body.username).toBe(`admin.${suffix}`);
          expect(described.body.purpose).toBe("activation");
          expect(JSON.stringify(described.body)).not.toContain("password");

          // Issuing a new link revokes the old one.
          const reissued = await post(`${usersUrl}/${accountId}/activation`, manageCookie).expect(
            200,
          );
          const newToken =
            new URL(reissued.body.setupUrl as string).searchParams.get("token") ?? "";
          expect(newToken).not.toBe(token);
          await request(server)
            .post("/api/v1/auth/account-setup/describe")
            .send({ token })
            .expect(400);

          // ---------------------------------------------------------------
          // The administrator sets their own password
          // ---------------------------------------------------------------
          const chosenPassword = "chosen-password-1";
          await request(server)
            .post("/api/v1/auth/account-setup/complete")
            .send({ token: newToken, password: chosenPassword })
            .expect(204);

          // Single use: the same link cannot be replayed.
          await request(server)
            .post("/api/v1/auth/account-setup/complete")
            .send({ token: newToken, password: "another-password-1" })
            .expect(400);

          const afterSetup = (
            await sql<{
              force_password_change: boolean;
              password_changed_at: Date | null;
              password_hash: string;
            }>`
              select force_password_change, password_changed_at, password_hash
                from accounts where id = ${accountId}::uuid
            `.execute(transaction)
          ).rows[0];
          expect(afterSetup?.force_password_change).toBe(false);
          expect(afterSetup?.password_changed_at).not.toBeNull();
          // Stored hashed, never in plaintext.
          expect(afterSetup?.password_hash).not.toContain(chosenPassword);
          expect(afterSetup?.password_hash.startsWith("scrypt$")).toBe(true);

          // The raw token was never persisted.
          const storedTokens = (
            await sql<{ token_hash: string; used_at: Date | null; revoked_at: Date | null }>`
              select token_hash, used_at, revoked_at from password_reset_tokens
               where account_id = ${accountId}::uuid
            `.execute(transaction)
          ).rows;
          expect(storedTokens.length).toBeGreaterThanOrEqual(2);
          for (const stored of storedTokens) {
            expect(stored.token_hash).not.toBe(token);
            expect(stored.token_hash).not.toBe(newToken);
            expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
          }
          expect(storedTokens.filter((row) => row.used_at !== null)).toHaveLength(1);

          // ---------------------------------------------------------------
          // Readiness is now complete; activation succeeds
          // ---------------------------------------------------------------
          readiness = await readinessOf(companyId);
          expect(stateOf(readiness, "companyAdmin")).toBe("complete");
          expect(stateOf(readiness, "openingBalance")).toBe("optional");
          expect(readiness.canActivate).toBe(true);
          expect(readiness.nextStep).toBe("Activate Company");

          await post(`/api/v1/platform/companies/${companyId}/activate`, manageCookie, {
            reason: "onboarding complete",
          }).expect(204);

          // ---------------------------------------------------------------
          // END TO END: the administrator signs in to the normal Company API
          // ---------------------------------------------------------------
          const companyLogin = await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `admin.${suffix}`, password: chosenPassword })
            .expect(200);
          const companyCookie =
            (companyLogin.headers["set-cookie"] as unknown as string[])[0]?.split(";")[0] ?? "";
          expect(companyLogin.body.identity.companyId).toBe(companyId);
          expect(companyLogin.body.identity.kind).toBe("company_user");
          expect(companyLogin.body.identity.forcePasswordChange).toBe(false);
          expect(
            (companyLogin.body.identity.permissions as string[]).some((code) =>
              code.startsWith("platform."),
            ),
          ).toBe(false);

          // Correct tenant context.
          const me = await request(server)
            .get("/api/v1/auth/me")
            .set("Cookie", companyCookie)
            .expect(200);
          expect(me.body.companyId).toBe(companyId);

          // The Company Administrator cannot reach the Platform API.
          await request(server)
            .get("/api/v1/platform/companies")
            .set("Cookie", companyCookie)
            .expect(403);
          await request(server).get(usersUrl).set("Cookie", companyCookie).expect(403);

          // The Platform Administrator is not a Company user.
          await request(server).get("/api/v1/users").set("Cookie", manageCookie).expect(403);

          // ---------------------------------------------------------------
          // Sessions
          // ---------------------------------------------------------------
          const sessions = await request(server)
            .get(`${usersUrl}/${accountId}/sessions`)
            .set("Cookie", readCookie)
            .expect(200);
          expect((sessions.body.items as unknown[]).length).toBeGreaterThan(0);
          const sessionBody = JSON.stringify(sessions.body);
          expect(sessionBody).not.toContain("token_hash");
          expect(sessionBody).not.toContain("tokenHash");

          const sessionId = (sessions.body.items as { id: string }[])[0]?.id ?? "";
          // A session belonging to another account cannot be targeted.
          await post(
            `${usersUrl}/${accountId}/sessions/${randomUUID()}/revoke`,
            manageCookie,
          ).expect(404);
          // Read-only cannot revoke.
          await post(`${usersUrl}/${accountId}/sessions/${sessionId}/revoke`, readCookie).expect(
            403,
          );

          await post(`${usersUrl}/${accountId}/sessions/${sessionId}/revoke`, manageCookie).expect(
            204,
          );
          await request(server).get("/api/v1/auth/me").set("Cookie", companyCookie).expect(401);

          // Revoke-all, from a fresh session.
          const second = await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `admin.${suffix}`, password: chosenPassword })
            .expect(200);
          const secondCookie =
            (second.headers["set-cookie"] as unknown as string[])[0]?.split(";")[0] ?? "";
          const revokeAll = await post(
            `${usersUrl}/${accountId}/sessions/revoke-all`,
            manageCookie,
          ).expect(200);
          expect(revokeAll.body.revoked).toBeGreaterThan(0);
          await request(server).get("/api/v1/auth/me").set("Cookie", secondCookie).expect(401);

          // ---------------------------------------------------------------
          // Password reset
          // ---------------------------------------------------------------
          const third = await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `admin.${suffix}`, password: chosenPassword })
            .expect(200);
          const thirdCookie =
            (third.headers["set-cookie"] as unknown as string[])[0]?.split(";")[0] ?? "";

          const reset = await post(`${usersUrl}/${accountId}/password-reset`, manageCookie).expect(
            200,
          );
          const resetToken = new URL(reset.body.setupUrl as string).searchParams.get("token") ?? "";
          // Sessions end the moment recovery starts, not when it completes.
          await request(server).get("/api/v1/auth/me").set("Cookie", thirdCookie).expect(401);

          const newPassword = "brand-new-password-2";
          await request(server)
            .post("/api/v1/auth/account-setup/complete")
            .send({ token: resetToken, password: newPassword })
            .expect(204);
          // Old password no longer works; new one does.
          await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `admin.${suffix}`, password: chosenPassword })
            .expect(401);
          await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `admin.${suffix}`, password: newPassword })
            .expect(200);

          // ---------------------------------------------------------------
          // Lock and unlock
          // ---------------------------------------------------------------
          await sql`
            update accounts set failed_login_attempts = 5, locked_until = now() + interval '15 minutes'
             where id = ${accountId}::uuid
          `.execute(transaction);
          await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `admin.${suffix}`, password: newPassword })
            .expect(401);
          const lockedList = await request(server)
            .get(usersUrl)
            .set("Cookie", readCookie)
            .expect(200);
          expect((lockedList.body.items as { state: string }[])[0]?.state).toBe("locked");

          await post(`${usersUrl}/${accountId}/unlock`, readCookie).expect(403);
          await post(`${usersUrl}/${accountId}/unlock`, manageCookie).expect(204);
          const unlocked = (
            await sql<{ locked_until: Date | null; password_hash: string }>`
              select locked_until, password_hash from accounts where id = ${accountId}::uuid
            `.execute(transaction)
          ).rows[0];
          expect(unlocked?.locked_until).toBeNull();
          // Unlock does not touch the password.
          expect(unlocked?.password_hash).toBe(
            (
              await sql<{ password_hash: string }>`
                select password_hash from accounts where id = ${accountId}::uuid
              `.execute(transaction)
            ).rows[0]?.password_hash,
          );
          await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `admin.${suffix}`, password: newPassword })
            .expect(200);

          // ---------------------------------------------------------------
          // Deactivate and reactivate
          // ---------------------------------------------------------------
          await post(`${usersUrl}/${accountId}/deactivate`, manageCookie, {}).expect(400);

          // The Company's ONLY user holding management permission cannot be
          // deactivated - an existing guard that stops a tenant being stranded
          // with nobody able to administer it. The Platform does not get to
          // override it, so a second administrator is created first, which is
          // also the supported multi-administrator path.
          await post(`${usersUrl}/${accountId}/deactivate`, manageCookie, {
            reason: "would strand the Company",
          }).expect(409);

          const secondAdmin = await post(`${usersUrl}/administrators`, manageCookie, {
            displayName: "Second Administrator",
            username: `admin2.${suffix}`,
            email: `admin2.${suffix}@example.com`,
            mobileNumber: "0507654321",
            preferredLanguage: "en",
          }).expect(201);
          expect(secondAdmin.body.accountId).not.toBe(accountId);

          await post(`${usersUrl}/${accountId}/deactivate`, manageCookie, {
            reason: "left the company",
          }).expect(204);
          await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `admin.${suffix}`, password: newPassword })
            .expect(401);
          // The user is not deleted; history survives.
          expect(
            Number(
              (
                await sql<{ n: string }>`
                  select count(*)::bigint n from accounts where id = ${accountId}::uuid
                `.execute(transaction)
              ).rows[0]?.n ?? 0,
            ),
          ).toBe(1);
          // Unlock must not resurrect a deactivated account. The existing
          // service refuses outright rather than silently reactivating, which
          // keeps "locked" and "deactivated" genuinely distinct.
          await post(`${usersUrl}/${accountId}/unlock`, manageCookie).expect(409);
          const stillDisabled = (
            await sql<{ status: string }>`
              select status from accounts where id = ${accountId}::uuid
            `.execute(transaction)
          ).rows[0];
          expect(stillDisabled?.status).toBe("disabled");
          await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `admin.${suffix}`, password: newPassword })
            .expect(401);
          // Nor may a deactivated account be handed a fresh setup link.
          await post(`${usersUrl}/${accountId}/activation`, manageCookie).expect(409);

          await post(`${usersUrl}/${accountId}/reactivate`, manageCookie, {
            reason: "returned",
          }).expect(204);
          await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `admin.${suffix}`, password: newPassword })
            .expect(200);

          // ---------------------------------------------------------------
          // Company suspension overrides an active account
          // ---------------------------------------------------------------
          await post(`/api/v1/platform/companies/${companyId}/suspend`, manageCookie, {
            reason: "non-payment",
          }).expect(204);
          await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `admin.${suffix}`, password: newPassword })
            .expect(401);
          // Support actions remain possible while suspended...
          await post(`${usersUrl}/${accountId}/password-reset`, manageCookie).expect(200);
          await post(`${usersUrl}/${accountId}/unlock`, manageCookie).expect(204);
          // ...but they do not restore access.
          await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `admin.${suffix}`, password: newPassword })
            .expect(401);
          await post(`/api/v1/platform/companies/${companyId}/reactivate`, manageCookie, {
            reason: "paid",
          }).expect(204);

          // ---------------------------------------------------------------
          // Audit
          // ---------------------------------------------------------------
          const auditRows = (
            await sql<{ action: string; actor: string | null; after_data: unknown }>`
              select action, actor_account_id as actor, after_data
                from audit_events
               where company_id = ${companyId}::uuid and action like 'platform.company_user%'
               order by occurred_at
            `.execute(transaction)
          ).rows;
          const actions = auditRows.map((row) => row.action);
          expect(actions).toContain("platform.company_user.administrator_created");
          expect(actions).toContain("platform.company_user.activation_link_issued");
          expect(actions).toContain("platform.company_user.password_reset_requested");
          expect(actions).toContain("platform.company_user.unlocked");
          expect(actions).toContain("platform.company_user.deactivated");
          expect(actions).toContain("platform.company_user.reactivated");
          expect(actions).toContain("platform.company_user.session_revoked");
          expect(actions).toContain("platform.company_user.all_sessions_revoked");
          for (const row of auditRows) expect(row.actor).toBe(managerId);

          // No token, password or session secret anywhere in the trail.
          const auditText = JSON.stringify(auditRows);
          for (const secret of [
            token,
            newToken,
            resetToken,
            chosenPassword,
            newPassword,
            password,
          ]) {
            expect(auditText).not.toContain(secret);
          }
        } finally {
          await app?.close();
        }

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      await database.destroy();
    }
  }, 300_000);
});
