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

const runTests = process.env.RUN_PLATFORM_CERTIFICATION_DATABASE === "true";

/**
 * Phase 1 closure certification for the Platform Administration Portal.
 *
 * This suite exists to answer one question with evidence rather than with an
 * assertion of confidence: can a Company be taken from "does not exist" to
 * "its Administrator is signed in and working", using only the Platform
 * Portal, without any manual database step — and can nothing else happen along
 * the way that should not.
 *
 * It is deliberately ONE test. The end-to-end journey and the isolation attack
 * matrix share a fixture because the attacks only mean something against a real
 * onboarded Company; splitting them would either duplicate the fixture or test
 * the attacks against a Company that was never actually brought to life.
 *
 * Everything runs inside one transaction that is always rolled back. The
 * development Company is never read from, written to or relied upon.
 */
describe.skipIf(!runTests)("Platform Phase 1 certification", () => {
  it("certifies onboarding, isolation, lifecycle and audit end to end", async () => {
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
            // Savepoints preserve real rollback semantics inside the outer test
            // transaction. Without this a failed multi-step operation would
            // leave its partial rows behind and the atomicity assertions below
            // would certify a guarantee production does not have.
            execute: async (work: (value: typeof transaction) => Promise<unknown>) => {
              savepointDepth += 1;
              const name = `cert_txn_${savepointDepth}`;
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
          const password = "platform-password-value";
          const hash = await hasher.hash(password);

          // =================================================================
          // Fixture: one Platform manager, one read-only Platform account
          // =================================================================
          const managerId = randomUUID();
          const readerId = randomUUID();
          const managerName = `cert.mgr.${suffix}`;
          const readerName = `cert.rdr.${suffix}`;
          await sql`
            insert into accounts (id, company_id, account_kind, username, password_hash, status, password_changed_at)
            values (${managerId}::uuid, null, 'platform_administrator', ${managerName}, ${hash}, 'active', now()),
                   (${readerId}::uuid, null, 'platform_administrator', ${readerName}, ${hash}, 'active', now())
          `.execute(transaction);
          const superRole = (
            await sql<{ id: string }>`
              select id from roles
               where company_id is null and lower(code) = ${PLATFORM_SUPER_ADMIN_ROLE_CODE}
            `.execute(transaction)
          ).rows[0];
          expect(superRole).toBeDefined();
          await sql`
            insert into account_roles (account_id, role_id, company_id)
            values (${managerId}::uuid, ${superRole?.id}::uuid, null)
          `.execute(transaction);

          const readRoleId = randomUUID();
          await sql`
            insert into roles (id, company_id, code, name, is_system)
            values (${readRoleId}::uuid, null, ${`cert_reader_${suffix}`}, ${`Cert Reader ${suffix}`}, false)
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

          const signIn = async (username: string, host?: string): Promise<string> => {
            const call = request(server)
              .post("/api/v1/platform/auth/login")
              .send({ identifier: username, password });
            if (host !== undefined) call.set("Host", host);
            const response = await call.expect(200);
            // STEP: sign-in returns NO token. The credential lives only in the
            // HttpOnly cookie, so nothing is handed to the SPA to store.
            expect(response.body.accessToken).toBeUndefined();
            expect(response.body.token).toBeUndefined();
            expect(response.body.identity.companyId).toBeNull();
            return (response.headers["set-cookie"] as unknown as string[])[0]?.split(";")[0] ?? "";
          };
          const manageCookie = await signIn(managerName);
          const readCookie = await signIn(readerName);

          const get = (url: string, cookie: string) =>
            request(server).get(url).set("Cookie", cookie);
          const post = (url: string, cookie: string, body: object = {}) =>
            request(server)
              .post(url)
              .set("Cookie", cookie)
              .set("X-Blueline-Session", "cookie")
              .send(body);

          // =================================================================
          // 1. Unauthenticated access is refused everywhere
          // =================================================================
          for (const url of [
            "/api/v1/platform/companies",
            "/api/v1/platform/audit",
            "/api/v1/platform/auth/me",
          ]) {
            await request(server).get(url).expect(401);
          }

          // A Company user must not reach the Platform surface at all, even
          // holding a perfectly valid Company session.
          // (Established after the Company exists, below.)

          // =================================================================
          // 2. Company creation, atomically, with its Accounting setup
          // =================================================================
          const createPayload = (tag: string) => ({
            name: `Cert ${tag} ${suffix}`,
            subdomain: `${tag.toLowerCase()}${suffix}`,
            environment: "sandbox",
            countryCode: "AE",
            timezone: "Asia/Dubai",
            defaultLanguage: "en",
            contactName: "Cert Contact",
            accountingTemplateCode: "UAE_DELIVERY_STANDARD",
            accountingTemplateVersion: 1,
          });

          // A read-only Platform account can see the list and create nothing.
          await get("/api/v1/platform/companies", readCookie).expect(200);
          await post("/api/v1/platform/companies", readCookie, createPayload("RRR")).expect(403);

          // A reserved subdomain is refused: `platform` is the Portal's own
          // host, and a Company owning it would shadow the Portal.
          await post("/api/v1/platform/companies", manageCookie, {
            ...createPayload("RES"),
            subdomain: "platform",
          }).expect(400);

          const companyId = (
            await post("/api/v1/platform/companies", manageCookie, createPayload("AAA")).expect(201)
          ).body.companyId as string;
          const otherCompanyId = (
            await post("/api/v1/platform/companies", manageCookie, createPayload("BBB")).expect(201)
          ).body.companyId as string;

          // A duplicate subdomain is refused and leaves NOTHING behind: the
          // whole creation is one transaction, so a Company that fails to be
          // created must not leave a Chart of Accounts orphaned in the schema.
          const before = (
            await sql<{ n: string }>`select count(*) as n from companies`.execute(transaction)
          ).rows[0]?.n;
          await post("/api/v1/platform/companies", manageCookie, createPayload("AAA")).expect(409);
          const after = (
            await sql<{ n: string }>`select count(*) as n from companies`.execute(transaction)
          ).rows[0]?.n;
          expect(after).toBe(before);

          // The Accounting setup really landed, and belongs to this Company.
          const accounts = (
            await sql<{ n: string }>`
              select count(*) as n from chart_of_accounts where company_id = ${companyId}::uuid
            `.execute(transaction)
          ).rows[0]?.n;
          expect(Number(accounts)).toBeGreaterThanOrEqual(20);
          const stray = (
            await sql<{ n: string }>`
              select count(*) as n from chart_of_accounts
               where company_id = ${otherCompanyId}::uuid
                 and id in (select id from chart_of_accounts where company_id = ${companyId}::uuid)
            `.execute(transaction)
          ).rows[0]?.n;
          expect(Number(stray)).toBe(0);

          // Delivery Areas, created with NO template version named -- the
          // server's own default, exactly the request the Platform Portal
          // sends. `companyId`/`otherCompanyId` above were pinned to v1
          // deliberately, to prove v1 keeps working; this Company proves the
          // default a caller actually gets.
          const defaultedCompanyId = (
            await post("/api/v1/platform/companies", manageCookie, {
              ...createPayload("DEF"),
              accountingTemplateVersion: undefined,
            }).expect(201)
          ).body.companyId as string;
          const defaultedAreas = (
            await sql<{ n: string; distinctEmirates: string }>`
              select count(*) as n, count(distinct emirate_id) as "distinctEmirates"
                from areas where company_id = ${defaultedCompanyId}::uuid
            `.execute(transaction)
          ).rows[0];
          expect(Number(defaultedAreas?.n)).toBeGreaterThan(400);
          expect(Number(defaultedAreas?.distinctEmirates)).toBe(7);
          expect(
            Number(
              (
                await sql<{ version: number }>`
                  select accounting_template_version as version from companies
                   where id = ${defaultedCompanyId}::uuid
                `.execute(transaction)
              ).rows[0]?.version,
            ),
          ).toBe(2);

          // Areas are Company-scoped like everything else: the v1-pinned
          // Company created above has none, and nothing here leaked across.
          expect(
            Number(
              (
                await sql<{ n: string }>`
                  select count(*) as n from areas where company_id = ${companyId}::uuid
                `.execute(transaction)
              ).rows[0]?.n,
            ),
          ).toBe(0);

          // A Company is created in `draft`, never active. An accidental
          // creation must not be immediately usable by anyone.
          const status = (
            await sql<{ status: string }>`
              select status from companies where id = ${companyId}::uuid
            `.execute(transaction)
          ).rows[0]?.status;
          expect(status).toBe("draft");

          // =================================================================
          // 3. Target-Company isolation attack matrix
          // =================================================================
          const usersUrl = `/api/v1/platform/companies/${companyId}/users`;

          // Unknown and malformed Company identifiers are indistinguishable.
          await get(`/api/v1/platform/companies/${randomUUID()}`, manageCookie).expect(404);
          await get("/api/v1/platform/companies/not-a-uuid", manageCookie).expect(404);

          // The server-resolved target is the ROUTE's Company, and the actor
          // never acquires a Company identity.
          const context = (
            await get(`/api/v1/platform/companies/${companyId}/context`, manageCookie).expect(200)
          ).body;
          expect(context.actor.companyId).toBeNull();
          expect(context.actor.kind).toBe("platform_administrator");
          expect(context.targetCompany.companyId).toBe(companyId);
          expect(context.tenantCompanyId).toBe(companyId);

          // Nothing the client sends about a Company is honoured: a body, a
          // query parameter or a header naming another Company changes nothing.
          // Each attack is issued one at a time. Building them up front would
          // construct several supertest clients against a server that is not
          // listening yet, and they would race to bind it.
          const attacks: (() => request.Test)[] = [
            () =>
              get(
                `/api/v1/platform/companies/${companyId}/context?companyId=${otherCompanyId}`,
                manageCookie,
              ),
            () =>
              get(`/api/v1/platform/companies/${companyId}/context`, manageCookie).set(
                "X-Company-Id",
                otherCompanyId,
              ),
            () =>
              get(`/api/v1/platform/companies/${companyId}/context`, manageCookie).set(
                "Host",
                `bbb${suffix}.test.local`,
              ),
          ];
          for (const attack of attacks) {
            const response = await attack();
            // A rejected unknown query parameter (400) is an equally correct
            // outcome; what must never happen is a 200 naming the other one.
            if (response.status === 200) {
              expect(response.body.targetCompany.companyId).toBe(companyId);
              expect(response.body.tenantCompanyId).toBe(companyId);
            } else {
              expect([400, 404]).toContain(response.status);
            }
          }

          // =================================================================
          // 4. Company Administrator onboarding
          // =================================================================
          // Activation is refused while nobody can sign in to the Company.
          await post(`/api/v1/platform/companies/${companyId}/activate`, manageCookie).expect(409);

          const created = (
            await post(`${usersUrl}/administrators`, manageCookie, {
              displayName: "Cert Administrator",
              username: `cert.admin.${suffix}`,
              email: `cert.admin.${suffix}@example.com`,
              mobileNumber: "0501234567",
              preferredLanguage: "en",
            }).expect(201)
          ).body;
          const adminAccountId = created.accountId as string;
          const setupUrl = created.setupUrl as string;
          // The destination is built by the server. Locally there is no tenant
          // host suffix configured, so it resolves to the development web
          // origin; what matters for certification is that nothing the caller
          // sent influenced it and that it carries the setup path and token.
          expect(setupUrl).toContain("/account-setup?token=");
          expect(setupUrl.startsWith("http")).toBe(true);
          // No password is ever returned to the Platform administrator.
          expect(JSON.stringify(created)).not.toMatch(/password/i);

          // The account belongs to the TARGET Company, not to the Platform.
          const adminRow = (
            await sql<{ companyId: string; kind: string }>`
              select company_id as "companyId", account_kind as kind
                from accounts where id = ${adminAccountId}::uuid
            `.execute(transaction)
          ).rows[0];
          expect(adminRow?.companyId).toBe(companyId);
          expect(adminRow?.kind).toBe("company_user");

          // It holds no Platform permission whatsoever.
          const platformCodes = (
            await sql<{ code: string }>`
              select rp.permission_code as code
                from account_roles ar
                join role_permissions rp on rp.role_id = ar.role_id
               where ar.account_id = ${adminAccountId}::uuid
                 and rp.permission_code like 'platform.%'
            `.execute(transaction)
          ).rows;
          expect(platformCodes).toEqual([]);

          // =================================================================
          // 5. Activation completes through the public setup route
          // =================================================================
          const token = new URL(setupUrl).searchParams.get("token");
          expect(token).toBeTruthy();

          // The link is describable without a session, and reveals only what
          // its holder needs to complete setup.
          const described = (
            await request(server)
              .post("/api/v1/auth/account-setup/describe")
              .send({ token })
              .expect(200)
          ).body;
          expect(described.username).toBe(`cert.admin.${suffix}`);
          expect(described.purpose).toBe("activation");
          expect(JSON.stringify(described)).not.toMatch(/hash|password/i);

          // An unknown token is refused with the same answer as an expired one.
          await request(server)
            .post("/api/v1/auth/account-setup/describe")
            .send({ token: randomUUID().replace(/-/g, "") })
            .expect(400);

          const newPassword = "cert-admin-password";
          await request(server)
            .post("/api/v1/auth/account-setup/complete")
            .send({ token, password: newPassword })
            .expect(204);

          // Single use: the same link cannot be replayed.
          await request(server)
            .post("/api/v1/auth/account-setup/complete")
            .send({ token, password: "another-password" })
            .expect(400);

          // =================================================================
          // 6. Readiness becomes satisfied, and activation is now permitted
          // =================================================================
          const readiness = (
            await get(`/api/v1/platform/companies/${companyId}/readiness`, manageCookie).expect(200)
          ).body;
          expect(readiness.canActivate).toBe(true);
          expect(readiness.blockedBy).toEqual([]);

          await post(`/api/v1/platform/companies/${companyId}/activate`, readCookie).expect(403);
          await post(`/api/v1/platform/companies/${companyId}/activate`, manageCookie).expect(204);

          // =================================================================
          // 7. The Company Administrator signs in to their own Company
          // =================================================================
          const companyLogin = await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `cert.admin.${suffix}`, password: newPassword })
            .expect(200);
          const companyCookie =
            (companyLogin.headers["set-cookie"] as unknown as string[])[0]?.split(";")[0] ?? "";
          expect(companyLogin.body.identity.companyId).toBe(companyId);

          // THE CENTRAL ISOLATION CLAIM: a fully-privileged Company
          // Administrator cannot reach any Platform route.
          for (const url of [
            "/api/v1/platform/companies",
            "/api/v1/platform/audit",
            `/api/v1/platform/companies/${otherCompanyId}`,
            `/api/v1/platform/companies/${companyId}/users`,
          ]) {
            const response = await get(url, companyCookie);
            expect([401, 403]).toContain(response.status);
          }

          // And cannot be granted one: the Platform namespace is invisible to
          // Company role management.
          const assignable = (
            await get("/api/v1/permissions", companyCookie).set(
              "Host",
              `aaa${suffix}.test.local`,
            )
          ).body;
          expect(JSON.stringify(assignable ?? {})).not.toContain("platform.");

          // =================================================================
          // 8. CSRF: a cookie without the intent header changes nothing
          // =================================================================
          await request(server)
            .post(`/api/v1/platform/companies/${companyId}/suspend`)
            .set("Cookie", manageCookie)
            .send({ reason: "csrf attempt" })
            .expect(403);
          expect(
            (
              await sql<{ status: string }>`
                select status from companies where id = ${companyId}::uuid
              `.execute(transaction)
            ).rows[0]?.status,
          ).toBe("active");

          // =================================================================
          // 9. Lifecycle: legal transitions, illegal ones, and their effects
          // =================================================================
          // A reason is required to suspend; suspension is not a casual act.
          await post(`/api/v1/platform/companies/${companyId}/suspend`, manageCookie, {}).expect(400);
          await post(`/api/v1/platform/companies/${companyId}/suspend`, manageCookie, {
            reason: "Certification suspension",
          }).expect(204);

          // Suspension takes effect immediately for the Company's users.
          await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `cert.admin.${suffix}`, password: newPassword })
            .expect(401);

          // Illegal transitions are refused, not silently ignored. A `draft`
          // Company cannot be suspended: there is nothing yet to suspend, and
          // allowing it would create a fourth state nobody designed a route out
          // of. The second Company is still in draft, so it proves the rule.
          await post(`/api/v1/platform/companies/${otherCompanyId}/suspend`, manageCookie, {
            reason: "draft cannot be suspended",
          }).expect(409);

          // NOTE, recorded rather than asserted away: `activate` and
          // `reactivate` both request the same `-> active` transition, so
          // POSTing `activate` to a suspended Company succeeds and IS a
          // reactivation. That is the transition table behaving correctly —
          // `suspended -> active` is legal — but the two route names are
          // aliases rather than distinct operations. Certified as safe;
          // recorded as a naming imprecision in the Phase 1 findings.

          await post(`/api/v1/platform/companies/${companyId}/reactivate`, manageCookie, {
            reason: "Certification reactivation",
          }).expect(204);
          await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `aaa${suffix}.test.local`)
            .send({ identifier: `cert.admin.${suffix}`, password: newPassword })
            .expect(200);

          // Closed is terminal: nothing brings a closed Company back.
          const closingCode = (
            await sql<{ code: string }>`select code from companies where id = ${companyId}::uuid`.execute(transaction)
          ).rows[0]?.code;
          await post(`/api/v1/platform/companies/${companyId}/close`, manageCookie, {
            reason: "Certification closure",
            confirmation: `CLOSE ${closingCode ?? ""}`,
          }).expect(204);
          for (const action of ["activate", "reactivate", "suspend"]) {
            await post(`/api/v1/platform/companies/${companyId}/${action}`, manageCookie, {
              reason: "should be refused",
            }).expect(409);
          }

          // Closing a Company destroys nothing. Its history survives.
          expect(
            Number(
              (
                await sql<{ n: string }>`
                  select count(*) as n from chart_of_accounts where company_id = ${companyId}::uuid
                `.execute(transaction)
              ).rows[0]?.n,
            ),
          ).toBeGreaterThanOrEqual(20);
          expect(
            (
              await sql<{ n: string }>`
                select count(*) as n from accounts where id = ${adminAccountId}::uuid
              `.execute(transaction)
            ).rows[0]?.n,
          ).toBe("1");

          // =================================================================
          // 10. The audit trail recorded every one of those decisions
          // =================================================================
          const trail = (
            await get(`/api/v1/platform/audit?companyId=${companyId}&pageSize=100`, manageCookie)
              .expect(200)
          ).body;
          const actions = (trail.items as { action: string }[]).map((item) => item.action);
          for (const expected of [
            "platform.company.created",
            "platform.company.activated",
            "platform.company.suspended",
            "platform.company.closed",
          ]) {
            expect(actions).toContain(expected);
          }
          expect(trail.total).toBeGreaterThanOrEqual(actions.length);

          // The trail carries no credential material of any kind.
          expect(JSON.stringify(trail)).not.toMatch(/password|token_hash|setupUrl/i);

          // Every entry now carries a structured outcome and names the
          // application it came from, so "what failed" is answerable without
          // parsing prose.
          for (const item of trail.items as { result: string; sourceApplication: string }[]) {
            expect(["success", "failure", "denied"]).toContain(item.result);
            expect(item.sourceApplication).toBe("platform-web");
          }

          // A failed sign-in is recorded as a failure, with a reason that does
          // NOT say which check failed — naming it would rebuild the
          // enumeration oracle the generic 401 exists to prevent.
          await request(server)
            .post("/api/v1/platform/auth/login")
            .send({ identifier: managerName, password: "wrong-password-value" })
            .expect(401);
          const failures = (
            await sql<{ result: string; failureReason: string }>`
              select result, failure_reason as "failureReason"
                from audit_events
               where action = 'platform.authentication.failed'
                 and correlation_id is not null
               order by occurred_at desc limit 1
            `.execute(transaction)
          ).rows[0];
          expect(failures?.result).toBe("failure");
          expect(failures?.failureReason).toBe("invalid_credentials");

          // It is gated by its own permission: a read-only account holding
          // companies.read and users.read still cannot read it.
          await get("/api/v1/platform/audit", readCookie).expect(403);

          // The filter cannot be widened to a Company's operational history.
          const widened = await get(
            "/api/v1/platform/audit?action=order&pageSize=100",
            manageCookie,
          ).expect(200);
          for (const item of (widened.body.items ?? []) as { action: string }[]) {
            expect(String(item.action)).toMatch(/^platform\./);
          }

          // And it is append-only: the trigger refuses even a direct update.
          //
          // Wrapped in a savepoint because a failed statement poisons the whole
          // PostgreSQL transaction — without it, every later statement in this
          // test (including the framework's own shutdown queries) would fail
          // with "current transaction is aborted" and the failure would look
          // like something else entirely.
          await sql.raw("savepoint tamper_attempt").execute(transaction);
          await expect(
            sql`update audit_events set reason = 'tampered' where company_id = ${companyId}::uuid`.execute(
              transaction,
            ),
          ).rejects.toThrow();
          await sql.raw("rollback to savepoint tamper_attempt").execute(transaction);
        } finally {
          await app?.close();
        }

        // Always roll back. Nothing this suite created outlives the run.
        throw new Error("rollback");
      });
    } catch (error) {
      if ((error as Error).message !== "rollback") throw error;
    } finally {
      // `destroy()` ends the pool; calling `pool.end()` as well throws and
      // would mask whatever the test actually found.
      await database.destroy();
    }
  }, 180_000);
});
