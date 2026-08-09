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

const runPlatformTests = process.env.RUN_PLATFORM_DATABASE === "true";
const rollbackMarker = Symbol("rollback platform administration test");

/**
 * HTTP-boundary tests for the Platform Administration foundation.
 *
 * Everything asserted here lives in guards, decorators, cookies and database
 * constraints, none of which a service-level test can reach. It runs inside one
 * transaction that is always rolled back, so it creates no Company, no account
 * and no audit row that outlives the run.
 *
 * Gated behind `RUN_PLATFORM_DATABASE=true`, matching every other
 * database-backed suite in this repository. It is not skipped because it is
 * unreliable; it is skipped because it needs a migrated PostgreSQL instance.
 */
describe.skipIf(!runPlatformTests)("Platform Administration HTTP boundary", () => {
  it("enforces Platform authentication, permissions, host reservation and target-Company context", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

    try {
      await database.transaction().execute(async (transaction) => {
        const module = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(DATABASE)
          .useValue(transaction)
          .overrideProvider(KyselyTransactionManager)
          .useValue({
            execute: (work: (value: typeof transaction) => unknown) => work(transaction),
          })
          .overrideProvider(CompanyHostResolver)
          .useValue({
            // Company host resolution itself is proved exhaustively, without a
            // database, in `tenancy/reserved-subdomains.test.ts`. Here it only
            // has to yield a Company for the Company sign-in used as a control.
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

          // ---------------------------------------------------------------
          // Fixtures
          // ---------------------------------------------------------------
          const suffix = randomUUID().slice(0, 8);
          const platformPassword = "platform-password-value";
          const companyPassword = "company-password-value";
          const platformHash = await hasher.hash(platformPassword);
          const companyHash = await hasher.hash(companyPassword);

          const platformAccountId = randomUUID();
          const platformUsername = `plat.${suffix}`;
          await sql`
            insert into accounts (id, company_id, account_kind, username, password_hash, status, password_changed_at)
            values (${platformAccountId}::uuid, null, 'platform_administrator', ${platformUsername},
                    ${platformHash}, 'active', now())
          `.execute(transaction);

          const platformRole = (
            await sql<{ id: string }>`
              select id from roles
               where company_id is null and lower(code) = ${PLATFORM_SUPER_ADMIN_ROLE_CODE}
            `.execute(transaction)
          ).rows[0];
          expect(platformRole).toBeDefined();
          await sql`
            insert into account_roles (account_id, role_id, company_id)
            values (${platformAccountId}::uuid, ${platformRole?.id}::uuid, null)
          `.execute(transaction);

          const companyId = randomUUID();
          const companySubdomain = `co${suffix}`;
          await sql`
            insert into companies (id, code, subdomain, name_en, status, activated_at)
            values (${companyId}::uuid, ${`DEV-${suffix.toUpperCase()}`}, ${companySubdomain},
                    'Platform Test Company', 'active', now())
          `.execute(transaction);

          const otherCompanyId = randomUUID();
          await sql`
            insert into companies (id, code, subdomain, name_en, status, activated_at)
            values (${otherCompanyId}::uuid, ${`DEV-O${suffix.toUpperCase()}`}, ${`ot${suffix}`},
                    'Other Test Company', 'active', now())
          `.execute(transaction);

          const companyAccountId = randomUUID();
          const companyRoleId = randomUUID();
          const companyUsername = `user.${suffix}`;
          await sql`
            insert into accounts (id, company_id, account_kind, username, password_hash, status, password_changed_at)
            values (${companyAccountId}::uuid, ${companyId}::uuid, 'company_user', ${companyUsername},
                    ${companyHash}, 'active', now())
          `.execute(transaction);
          await sql`
            insert into roles (id, company_id, code, name, is_system)
            values (${companyRoleId}::uuid, ${companyId}::uuid, 'company_admin', 'Company Administrator', true)
          `.execute(transaction);
          await sql`
            insert into role_permissions (role_id, permission_code)
            values (${companyRoleId}::uuid, 'users_roles.manage')
          `.execute(transaction);
          await sql`
            insert into account_roles (account_id, role_id, company_id)
            values (${companyAccountId}::uuid, ${companyRoleId}::uuid, ${companyId}::uuid)
          `.execute(transaction);
          await sql`
            insert into company_users (company_id, account_id, display_name, name_en)
            values (${companyId}::uuid, ${companyAccountId}::uuid, 'Test User', 'Test User')
          `.execute(transaction);

          // ---------------------------------------------------------------
          // Permission seeding
          // ---------------------------------------------------------------
          const seeded = (
            await sql<{ code: string }>`
              select code from permissions where code like 'platform.%' order by code
            `.execute(transaction)
          ).rows.map((row) => row.code);
          expect(seeded).toEqual([
            "platform.access",
            "platform.audit.read",
            "platform.companies.manage",
            "platform.companies.read",
            "platform.users.manage",
            "platform.users.read",
          ]);

          const rolePermissions = (
            await sql<{ permission_code: string }>`
              select permission_code from role_permissions
               where role_id = ${platformRole?.id}::uuid order by permission_code
            `.execute(transaction)
          ).rows.map((row) => row.permission_code);
          expect(rolePermissions).toEqual(seeded);

          // Re-running the seed changes nothing.
          await sql`
            insert into permissions (code, description)
            values ('platform.access', 'Sign in to the Platform Administration Portal')
            on conflict (code) do nothing
          `.execute(transaction);
          const afterReseed = (
            await sql<{ n: string }>`
              select count(*)::bigint as n from permissions where code like 'platform.%'
            `.execute(transaction)
          ).rows[0];
          expect(Number(afterReseed?.n)).toBe(6);

          // ---------------------------------------------------------------
          // Company role management cannot see or assign a Platform permission
          // ---------------------------------------------------------------
          const companyLogin = await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `${companySubdomain}.test.local`)
            .send({ identifier: companyUsername, password: companyPassword })
            .expect(200);
          const companyCookie =
            (companyLogin.headers["set-cookie"] as unknown as string[])[0] ?? "";
          expect(companyCookie).toContain("blueline_session=");

          const visiblePermissions = await request(server)
            .get("/api/v1/roles/permissions")
            .set("Cookie", companyCookie)
            .expect(200);
          const visibleCodes = (visiblePermissions.body as { code: string }[]).map(
            (row) => row.code,
          );
          expect(visibleCodes.some((code) => code.startsWith("platform."))).toBe(false);

          // A Company Administrator asking for a Platform code by name is
          // refused: the code is not in the assignable set at all.
          await request(server)
            .post("/api/v1/roles")
            .set("Cookie", companyCookie)
            .set("X-Blueline-Session", "cookie")
            .send({
              name: `Escalation ${suffix}`,
              code: `esc_${suffix}`,
              isActive: true,
              permissions: ["platform.access"],
            })
            .expect((response) => {
              expect(response.status).toBeGreaterThanOrEqual(400);
            });

          // ---------------------------------------------------------------
          // A Company user cannot enter the Platform
          // ---------------------------------------------------------------
          await request(server)
            .get("/api/v1/platform/auth/me")
            .set("Cookie", companyCookie)
            .expect(403);
          await request(server)
            .get("/api/v1/platform/companies")
            .set("Cookie", companyCookie)
            .expect(403);
          await request(server)
            .post("/api/v1/platform/auth/login")
            .send({ identifier: companyUsername, password: companyPassword })
            .expect(401);

          // ---------------------------------------------------------------
          // Platform sign-in
          // ---------------------------------------------------------------
          await request(server)
            .post("/api/v1/platform/auth/login")
            .send({ identifier: platformUsername, password: "wrong-password-value" })
            .expect(401);

          const platformLogin = await request(server)
            .post("/api/v1/platform/auth/login")
            .send({ identifier: platformUsername, password: platformPassword })
            .expect(200);

          // No token is returned at all: the Portal has nothing it could
          // persist in browser storage.
          expect(platformLogin.body).not.toHaveProperty("accessToken");
          expect(JSON.stringify(platformLogin.body)).not.toContain("Bearer");
          expect(platformLogin.body.identity.companyId).toBeNull();
          expect(platformLogin.body.identity.kind).toBe("platform_administrator");

          const platformCookieHeader =
            (platformLogin.headers["set-cookie"] as unknown as string[])[0] ?? "";
          expect(platformCookieHeader).toContain("blueline_session=");
          expect(platformCookieHeader).toContain("HttpOnly");
          expect(platformCookieHeader).toContain("Path=/api");
          expect(platformCookieHeader).toMatch(/SameSite=Lax/i);
          // Secure follows the deployment; the test environment is not
          // production, so the cookie must not be marked Secure or the browser
          // would drop it over plain HTTP.
          expect(platformCookieHeader).not.toMatch(/;\s*Secure/i);
          const platformCookie = platformCookieHeader.split(";")[0] ?? "";

          // ---------------------------------------------------------------
          // Session bootstrap
          // ---------------------------------------------------------------
          await request(server).get("/api/v1/platform/auth/me").expect(401);

          const me = await request(server)
            .get("/api/v1/platform/auth/me")
            .set("Cookie", platformCookie)
            .expect(200);
          expect(me.body.companyId).toBeNull();
          expect(me.body.kind).toBe("platform_administrator");
          expect(me.body.username).toBe(platformUsername);
          expect(me.body.permissions).toEqual(seeded);
          expect(me.body.roles).toEqual([PLATFORM_SUPER_ADMIN_ROLE_CODE]);
          // Nothing sensitive rides along.
          const meBody = JSON.stringify(me.body);
          expect(meBody).not.toContain("password");
          expect(meBody).not.toContain("token");

          // ---------------------------------------------------------------
          // CSRF: a cookie-authenticated mutation needs the custom header
          // ---------------------------------------------------------------
          await request(server)
            .post("/api/v1/platform/auth/logout")
            .set("Cookie", platformCookie)
            .expect(403);

          // ---------------------------------------------------------------
          // Target-Company context
          // ---------------------------------------------------------------
          const companies = await request(server)
            .get("/api/v1/platform/companies")
            .set("Cookie", platformCookie)
            .expect(200);
          // Prompt 3 replaced the bare array with a paged envelope.
          const listed = (companies.body as { items: { id: string }[] }).items.map((row) => row.id);
          expect(listed).toContain(companyId);
          expect(listed).toContain(otherCompanyId);

          const targetContext = await request(server)
            .get(`/api/v1/platform/companies/${companyId}/context`)
            .set("Cookie", platformCookie)
            .expect(200);
          expect(targetContext.body.targetCompany.companyId).toBe(companyId);
          expect(targetContext.body.targetCompany.subdomain).toBe(companySubdomain);
          expect(targetContext.body.tenantCompanyId).toBe(companyId);
          // The actor's own Company stays null for the whole request.
          expect(targetContext.body.actor.companyId).toBeNull();
          expect(targetContext.body.actor.kind).toBe("platform_administrator");

          // Targeting a different Company yields that Company, not the previous
          // one: no context survives from the earlier request.
          const otherContext = await request(server)
            .get(`/api/v1/platform/companies/${otherCompanyId}/context`)
            .set("Cookie", platformCookie)
            .expect(200);
          expect(otherContext.body.targetCompany.companyId).toBe(otherCompanyId);
          expect(otherContext.body.actor.companyId).toBeNull();

          // Unknown and malformed identifiers fail identically.
          await request(server)
            .get(`/api/v1/platform/companies/${randomUUID()}/context`)
            .set("Cookie", platformCookie)
            .expect(404);
          await request(server)
            .get("/api/v1/platform/companies/not-a-uuid/context")
            .set("Cookie", platformCookie)
            .expect(404);

          // A Company user cannot reach a target-Company route even for their
          // OWN Company: the Platform kind is required first.
          await request(server)
            .get(`/api/v1/platform/companies/${companyId}/context`)
            .set("Cookie", companyCookie)
            .expect(403);

          // ---------------------------------------------------------------
          // A Platform actor is not a Company user
          // ---------------------------------------------------------------
          await request(server).get("/api/v1/users").set("Cookie", platformCookie).expect(403);

          // ---------------------------------------------------------------
          // Missing granular permission
          // ---------------------------------------------------------------
          await sql`
            delete from role_permissions
             where role_id = ${platformRole?.id}::uuid
               and permission_code = 'platform.companies.read'
          `.execute(transaction);
          await request(server)
            .get("/api/v1/platform/companies")
            .set("Cookie", platformCookie)
            .expect(403);
          // platform.access alone still admits the session bootstrap.
          await request(server)
            .get("/api/v1/platform/auth/me")
            .set("Cookie", platformCookie)
            .expect(200);

          // Removing platform.access closes the Portal entirely.
          await sql`
            delete from role_permissions
             where role_id = ${platformRole?.id}::uuid and permission_code = 'platform.access'
          `.execute(transaction);
          await request(server)
            .get("/api/v1/platform/auth/me")
            .set("Cookie", platformCookie)
            .expect(403);
          await sql`
            insert into role_permissions (role_id, permission_code)
            values (${platformRole?.id}::uuid, 'platform.access')
          `.execute(transaction);

          // ---------------------------------------------------------------
          // Revocation and sign-out
          // ---------------------------------------------------------------
          await sql`
            update account_sessions set revoked_at = now()
             where account_id = ${platformAccountId}::uuid and revoked_at is null
          `.execute(transaction);
          await request(server)
            .get("/api/v1/platform/auth/me")
            .set("Cookie", platformCookie)
            .expect(401);

          const secondLogin = await request(server)
            .post("/api/v1/platform/auth/login")
            .send({ identifier: platformUsername, password: platformPassword })
            .expect(200);
          const secondCookie =
            (secondLogin.headers["set-cookie"] as unknown as string[])[0]?.split(";")[0] ?? "";

          const signOut = await request(server)
            .post("/api/v1/platform/auth/logout")
            .set("Cookie", secondCookie)
            .set("X-Blueline-Session", "cookie")
            .expect(204);
          const cleared = (signOut.headers["set-cookie"] as unknown as string[])[0] ?? "";
          expect(cleared).toContain("blueline_session=;");

          // The page that was open a moment ago can no longer call anything.
          await request(server)
            .get("/api/v1/platform/auth/me")
            .set("Cookie", secondCookie)
            .expect(401);
          await request(server)
            .get("/api/v1/platform/companies")
            .set("Cookie", secondCookie)
            .expect(401);

          // A disabled account cannot sign in.
          await sql`
            update accounts set status = 'disabled' where id = ${platformAccountId}::uuid
          `.execute(transaction);
          await request(server)
            .post("/api/v1/platform/auth/login")
            .send({ identifier: platformUsername, password: platformPassword })
            .expect(401);
          await sql`
            update accounts set status = 'active' where id = ${platformAccountId}::uuid
          `.execute(transaction);

          // ---------------------------------------------------------------
          // Audit
          // ---------------------------------------------------------------
          const auditActions = (
            await sql<{ action: string; company_id: string | null; source: string }>`
              select action, company_id, source from audit_events
               where actor_account_id = ${platformAccountId}::uuid
               order by occurred_at
            `.execute(transaction)
          ).rows;
          const actions = auditActions.map((row) => row.action);
          expect(actions).toContain("platform.authentication.succeeded");
          expect(actions).toContain("platform.authentication.signed_out");
          for (const row of auditActions) {
            expect(row.source).toBe("platform_portal");
            expect(row.company_id).toBeNull();
          }
          const auditBodies = (
            await sql<{ after_data: unknown }>`
              select after_data from audit_events where action like 'platform.authentication.%'
            `.execute(transaction)
          ).rows;
          for (const row of auditBodies) {
            const serialised = JSON.stringify(row.after_data ?? {});
            expect(serialised).not.toContain(platformPassword);
            expect(serialised).not.toContain(platformHash);
          }

          // ---------------------------------------------------------------
          // Reserved subdomain, enforced by the database
          // ---------------------------------------------------------------
          for (const reserved of ["platform", "PLATFORM", " platform ", "www", "store"]) {
            await sql`savepoint reserved_probe`.execute(transaction);
            await expect(
              sql`
                insert into companies (id, code, subdomain, name_en, status)
                values (${randomUUID()}::uuid, ${`RSV-${randomUUID().slice(0, 6)}`},
                        ${reserved}, 'Reserved Attempt', 'disabled')
              `.execute(transaction),
            ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
            await sql`rollback to savepoint reserved_probe`.execute(transaction);
            await sql`release savepoint reserved_probe`.execute(transaction);
          }

          // An ordinary subdomain is unaffected.
          await sql`
            insert into companies (id, code, subdomain, name_en, status)
            values (${randomUUID()}::uuid, ${`OK-${suffix.toUpperCase()}`}, ${`ok${suffix}`},
                    'Ordinary Company', 'disabled')
          `.execute(transaction);

          // An existing Company cannot be renamed onto a reserved subdomain.
          await sql`savepoint reserved_update`.execute(transaction);
          await expect(
            sql`update companies set subdomain = 'platform' where id = ${companyId}::uuid`.execute(
              transaction,
            ),
          ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
          await sql`rollback to savepoint reserved_update`.execute(transaction);
          await sql`release savepoint reserved_update`.execute(transaction);

          // ---------------------------------------------------------------
          // The Platform account scope constraint still holds
          // ---------------------------------------------------------------
          await sql`savepoint platform_scope`.execute(transaction);
          await expect(
            sql`
              insert into accounts (company_id, account_kind, username, password_hash, status)
              values (${companyId}::uuid, 'platform_administrator', ${`bad.${suffix}`}, 'x', 'active')
            `.execute(transaction),
          ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
          await sql`rollback to savepoint platform_scope`.execute(transaction);
          await sql`release savepoint platform_scope`.execute(transaction);
        } finally {
          await app?.close();
        }

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      // `destroy()` ends the pool it was built on; calling `pool.end()` as well
      // throws "Called end on pool more than once".
      await database.destroy();
    }
  }, 180_000);
});
