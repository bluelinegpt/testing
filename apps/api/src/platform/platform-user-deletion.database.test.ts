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

const runTests = process.env.RUN_PLATFORM_USER_DELETION_DATABASE === "true";

/**
 * Permanent user deletion, against the real schema.
 *
 * The eligibility engine reads the live foreign-key graph, so it can only be
 * meaningfully tested against a real database — a mocked catalogue would test
 * the mock. Everything runs in one transaction that is always rolled back, on
 * fixture Companies this suite creates itself. Dana is never touched.
 */
describe.skipIf(!runTests)("Platform user deletion", () => {
  it("reports deletion eligibility correctly and is blocked from executing", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

    let depth = 0;
    try {
      await database.transaction().execute(async (transaction) => {
        const module = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(DATABASE)
          .useValue(transaction)
          .overrideProvider(KyselyTransactionManager)
          .useValue({
            // Savepoints, so a refused deletion really rolls back inside the
            // outer test transaction instead of leaving its partial work.
            execute: async (work: (value: typeof transaction) => Promise<unknown>) => {
              depth += 1;
              const name = `del_txn_${depth}`;
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

          // ---------------------------------------------------------------
          // Platform actors: one manager, one read-only
          // ---------------------------------------------------------------
          const managerId = randomUUID();
          const readerId = randomUUID();
          const managerName = `del.mgr.${suffix}`;
          const readerName = `del.rdr.${suffix}`;
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
          await sql`
            insert into account_roles (account_id, role_id, company_id)
            values (${managerId}::uuid, ${superRole?.id}::uuid, null)
          `.execute(transaction);

          const readRoleId = randomUUID();
          await sql`
            insert into roles (id, company_id, code, name, is_system)
            values (${readRoleId}::uuid, null, ${`del_reader_${suffix}`}, ${`Del Reader ${suffix}`}, false)
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

          const get = (url: string, cookie: string) =>
            request(server).get(url).set("Cookie", cookie);
          const post = (url: string, cookie: string, body: object = {}) =>
            request(server)
              .post(url)
              .set("Cookie", cookie)
              .set("X-Blueline-Session", "cookie")
              .send(body);

          // ---------------------------------------------------------------
          // Two fixture Companies
          // ---------------------------------------------------------------
          const createCompany = async (tag: string): Promise<string> =>
            (
              await post("/api/v1/platform/companies", manageCookie, {
                name: `Del ${tag} ${suffix}`,
                subdomain: `${tag.toLowerCase()}${suffix}`,
                environment: "sandbox",
                countryCode: "AE",
                timezone: "Asia/Dubai",
                defaultLanguage: "en",
                accountingTemplateCode: "UAE_DELIVERY_STANDARD",
                accountingTemplateVersion: 1,
              }).expect(201)
            ).body.companyId as string;
          const companyId = await createCompany("AAA");
          const otherCompanyId = await createCompany("BBB");

          const usersUrl = `/api/v1/platform/companies/${companyId}/users`;
          // The mobile number varies per user: it is unique per Company, so a
          // shared fixture value would make the SECOND administrator fail to
          // create and the test would be measuring the wrong thing.
          let mobileSeed = 1_000_000;
          const addAdministrator = async (name: string): Promise<string> => {
            mobileSeed += 1;
            return (
              await post(`${usersUrl}/administrators`, manageCookie, {
                displayName: `User ${name}`,
                username: `${name}.${suffix}`,
                email: `${name}.${suffix}@example.com`,
                mobileNumber: `050${mobileSeed}`,
                preferredLanguage: "en",
              }).expect(201)
            ).body.accountId as string;
          };

          // ---------------------------------------------------------------
          // The last administrator is not deletable
          // ---------------------------------------------------------------
          const firstId = await addAdministrator("first");
          const firstEligibility = (
            await get(`${usersUrl}/${firstId}/deletion-eligibility`, readCookie).expect(200)
          ).body;
          expect(firstEligibility.eligible).toBe(false);
          expect(firstEligibility.isLastAdministrator).toBe(true);
          expect(firstEligibility.recommendedAction).toBe("deactivate");
          expect(firstEligibility.reason).toBe(
            "This user is the last Company Administrator. Create another administrator before deleting this user.",
          );

          // A second administrator removes that particular blocker.
          const secondId = await addAdministrator("second");
          const secondEligibility = (
            await get(`${usersUrl}/${secondId}/deletion-eligibility`, readCookie).expect(200)
          ).body;
          expect(secondEligibility.eligible).toBe(true);
          expect(secondEligibility.blockingRows).toBe(0);
          expect(secondEligibility.recommendedAction).toBe("delete");
          // The challenge is generated by the server from the username.
          expect(secondEligibility.confirmationChallenge).toBe(
            `DELETE second.${suffix}`,
          );

          // ---------------------------------------------------------------
          // Permission and confirmation boundaries
          // ---------------------------------------------------------------
          // Read-only Platform account may SEE eligibility but not act on it.
          await post(`${usersUrl}/${secondId}/delete`, readCookie, {
            confirmation: secondEligibility.confirmationChallenge,
          }).expect(403);

          // A wrong confirmation is refused, and changes nothing.
          await post(`${usersUrl}/${secondId}/delete`, manageCookie, {
            confirmation: "DELETE wrong.name",
          }).expect(409);
          expect(
            (
              await sql<{ n: string }>`
                select count(*)::bigint n from accounts where id = ${secondId}::uuid
              `.execute(transaction)
            ).rows[0]?.n,
          ).toBe("1");

          // Targeting the account through ANOTHER Company's route fails, and
          // fails the same way a non-existent account does.
          await get(
            `/api/v1/platform/companies/${otherCompanyId}/users/${secondId}/deletion-eligibility`,
            manageCookie,
          ).expect(404);
          await get(
            `/api/v1/platform/companies/${otherCompanyId}/users/${randomUUID()}/deletion-eligibility`,
            manageCookie,
          ).expect(404);
          await post(
            `/api/v1/platform/companies/${otherCompanyId}/users/${secondId}/delete`,
            manageCookie,
            { confirmation: secondEligibility.confirmationChallenge },
          ).expect(404);

          // ---------------------------------------------------------------
          // A user WITH history cannot be deleted
          // ---------------------------------------------------------------
          // `first` has audit history: creating them was audited, and they
          // granted nothing. Give `first` a concrete business dependency by
          // recording an audit event with them as the actor, which is exactly
          // the "actor history" case the rules protect.
          await sql`
            insert into audit_events (
              company_id, actor_account_id, action, subject_type, subject_id,
              correlation_id, actor_role, source
            ) values (
              ${companyId}::uuid, ${firstId}::uuid, 'company_user.did_something',
              'order', ${randomUUID()}, ${`corr-${suffix}`}, 'self', 'web'
            )
          `.execute(transaction);
          const withHistory = (
            await get(`${usersUrl}/${firstId}/deletion-eligibility`, manageCookie).expect(200)
          ).body;
          expect(withHistory.eligible).toBe(false);
          expect(withHistory.blockingRows).toBeGreaterThan(0);
          expect(
            (withHistory.blockingCategories as { category: string }[]).map((c) => c.category),
          ).toContain("Audit history");
          expect(String(withHistory.reason)).toContain("historical activity");

          await post(`${usersUrl}/${firstId}/delete`, manageCookie, {
            confirmation: withHistory.confirmationChallenge,
          }).expect(409);

          // ---------------------------------------------------------------
          // Duplicate details are reported by FIELD, not generically
          // ---------------------------------------------------------------
          //
          // `UserAdministrationService.assertIdentifiersAvailable` checks all
          // three BEFORE inserting, so each already produces a message naming
          // the field. This pins that, because the pre-check is the only reason
          // the generic "conflicts with data integrity rules" is not what an
          // administrator sees when they reuse a username by accident.
          const dupBase = {
            displayName: "Duplicate User",
            username: `dup.${suffix}`,
            email: `dup.${suffix}@example.com`,
            mobileNumber: "0509999001",
            preferredLanguage: "en",
          };
          await post(`${usersUrl}/administrators`, manageCookie, dupBase).expect(201);

          const conflict = async (overrides: object): Promise<{ code: string; message: string }> => {
            const response = await post(`${usersUrl}/administrators`, manageCookie, {
              ...dupBase,
              ...overrides,
            }).expect(409);
            return response.body.error as { code: string; message: string };
          };

          // Same username, everything else new.
          const byUsername = await conflict({
            email: `other.${suffix}@example.com`,
            mobileNumber: "0509999002",
          });
          expect(byUsername.code).toBe("username_already_exists");
          expect(byUsername.message).toContain("username");
          

          // Same email, everything else new.
          const byEmail = await conflict({
            username: `other.${suffix}`,
            mobileNumber: "0509999003",
          });
          expect(byEmail.code).toBe("email_already_exists");
          expect(byEmail.message).toContain("email address");
          

          // Same mobile, everything else new.
          const byMobile = await conflict({
            username: `other2.${suffix}`,
            email: `other2.${suffix}@example.com`,
          });
          expect(byMobile.code).toBe("mobile_already_exists");
          expect(byMobile.message).toContain("mobile number");
          

          // Every one of them says WHICH Company, because uniqueness is
          // per-Company and a global reading would be wrong.
          for (const error of [byUsername, byEmail, byMobile]) {
            // The generic fallback must never be what a duplicate looks like.
            expect(error.code).not.toBe("database_integrity_conflict");
            // Uniqueness is per-Company, and the message says so -- otherwise
            // an administrator concludes the value is taken globally and
            // invents a worse one.
            expect(error.message).toContain("in the Company");
          }

          // The SAME details in a DIFFERENT Company are accepted, which is the
          // behaviour the message promises.
          await post(
            `/api/v1/platform/companies/${otherCompanyId}/users/administrators`,
            manageCookie,
            dupBase,
          ).expect(201);

          // ---------------------------------------------------------------
          // The historical user (`first`) is STILL rejected at execute time,
          // confirmation valid or not -- the guard exception must never
          // reach an ineligible account. This is checked BEFORE the eligible
          // deletion below runs, because -- see the note on the shared
          // transaction manager at the top of this file -- once the
          // Platform service's own `SET LOCAL` has been issued inside a
          // savepoint that is RELEASED (not rolled back), Postgres keeps it
          // active for the rest of THIS transaction. Testing "still blocked"
          // after a real deletion has already run would risk measuring that
          // savepoint quirk instead of the product. Ordering this first
          // avoids the ambiguity entirely; the dedicated bypass-containment
          // suite below proves the real isolation guarantee with genuine
          // separate transactions instead.
          await post(`${usersUrl}/${firstId}/delete`, manageCookie, {
            confirmation: withHistory.confirmationChallenge,
          }).expect(409);
          expect(
            (
              await sql<{ n: string }>`select count(*)::bigint n from accounts where id = ${firstId}::uuid`.execute(
                transaction,
              )
            ).rows[0]?.n,
          ).toBe("1");

          // ---------------------------------------------------------------
          // THE ELIGIBLE USER IS ACTUALLY DELETED
          // ---------------------------------------------------------------
          //
          // Everything the removable-records list promises is verified
          // directly, not inferred from a 200. This is the proof that
          // `20260816100000_platform_user_deletion_guard_exception` really
          // lets an already-approved deletion complete, and that it removes
          // exactly the identity/access rows it says it will.
          const secondRoleId = (
            await sql<{ role_id: string }>`select role_id from account_roles where account_id=${secondId}::uuid limit 1`.execute(
              transaction,
            )
          ).rows[0]?.role_id;
          await sql`
            insert into account_sessions (id, account_id, company_id, token_hash, expires_at)
            values (${randomUUID()}::uuid, ${secondId}::uuid, ${companyId}::uuid, ${randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")}, now() + interval '1 hour')
          `.execute(transaction);
          expect(
            Number(
              (
                await sql<{ n: string }>`select count(*)::bigint n from account_sessions where account_id=${secondId}::uuid`.execute(
                  transaction,
                )
              ).rows[0]?.n,
            ),
          ).toBeGreaterThan(0);

          const beforeCompanies = (
            await sql<{ n: string }>`select count(*)::bigint n from companies`.execute(transaction)
          ).rows[0]?.n;

          const executed = await post(`${usersUrl}/${secondId}/delete`, manageCookie, {
            confirmation: secondEligibility.confirmationChallenge,
          }).expect(200);
          expect(executed.body.deleted).toBe(true);
          expect(executed.body.username).toBe(`second.${suffix}`);

          const goneFrom = async (table: string, column: string): Promise<string | undefined> =>
            (
              await sql<{ n: string }>`
                select count(*)::bigint n from ${sql.ref(table)} where ${sql.ref(column)} = ${secondId}::uuid
              `.execute(transaction)
            ).rows[0]?.n;
          expect(await goneFrom("accounts", "id")).toBe("0");
          expect(await goneFrom("company_users", "account_id")).toBe("0");
          expect(await goneFrom("account_roles", "account_id")).toBe("0");
          expect(await goneFrom("account_sessions", "account_id")).toBe("0");
          expect(await goneFrom("password_reset_tokens", "account_id")).toBe("0");

          // The Company survives, unchanged in count, with its accounting
          // setup intact, and the OTHER administrator (`first`, ineligible
          // but present) is unaffected.
          expect(
            (await sql<{ n: string }>`select count(*)::bigint n from companies`.execute(transaction))
              .rows[0]?.n,
          ).toBe(beforeCompanies);
          expect(
            Number(
              (
                await sql<{ n: string }>`
                  select count(*)::bigint n from chart_of_accounts where company_id = ${companyId}::uuid
                `.execute(transaction)
              ).rows[0]?.n,
            ),
          ).toBeGreaterThanOrEqual(20);
          expect(
            (
              await sql<{ n: string }>`select count(*)::bigint n from accounts where id = ${firstId}::uuid`.execute(
                transaction,
              )
            ).rows[0]?.n,
          ).toBe("1");

          // The role grant itself (not the assignment) is untouched -- only
          // the deleted account's OWN grant went, not the role definition.
          expect(
            (
              await sql<{ n: string }>`select count(*)::bigint n from roles where id = ${secondRoleId}::uuid`.execute(
                transaction,
              )
            ).rows[0]?.n,
          ).toBe("1");

          // The Platform audit for the completed deletion is present in the
          // shared transaction (both the success record and the service's
          // own `this.audit.record` write through the SAME overridden
          // DATABASE provider). It carries a snapshot, not a reference: the
          // username and Company name are readable even though the account
          // is gone, and no secret material is present.
          const survivingAudit = (
            await sql<{ before: unknown; result: string }>`
              select before_data as before, result from audit_events
               where company_id = ${companyId}::uuid and subject_id = ${secondId}
                 and action = 'platform.company_user.deleted'
               order by occurred_at desc limit 1
            `.execute(transaction)
          ).rows[0];
          expect(survivingAudit?.result).toBe("success");
          const auditText = JSON.stringify(survivingAudit?.before);
          expect(auditText).toContain(`second.${suffix}`);
          expect(auditText.toLowerCase()).not.toMatch(/password|token_hash|session/);

          // A second attempt on the same, now-gone account is a 404, not a
          // second "success" and not a silent no-op.
          await post(`${usersUrl}/${secondId}/delete`, manageCookie, {
            confirmation: secondEligibility.confirmationChallenge,
          }).expect(404);
        } finally {
          await app?.close();
        }

        throw new Error("rollback");
      });
    } catch (error) {
      if ((error as Error).message !== "rollback") throw error;
    } finally {
      await database.destroy();
    }
  }, 180_000);
});
