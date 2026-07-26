import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import request from "supertest";

import { Logger } from "nestjs-pino";

import { AppModule } from "../app.module.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { configuration } from "../configuration/environment.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApiExceptionFilter } from "../presentation/errors/api-exception.filter.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";

const runHttpTests = process.env.RUN_RECONCILIATION_HTTP === "true";
const rollbackMarker = Symbol("rollback reconciliation http test");

/**
 * HTTP-boundary tests for the reconciliation endpoints.
 *
 * Service-level tests cannot prove that guards are wired, that query strings are
 * coerced, or that the validation pipe rejects malformed input — those live in
 * decorators and global pipes, so they need a booted application.
 */
describe.skipIf(!runHttpTests)("reconciliation HTTP boundary", () => {
  it("enforces guards, coercion, validation and tenant isolation", async () => {
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
            resolve: (host: string | undefined) => host?.split(".")[0],
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
          // The real bootstrap registers this filter; without it the test would
          // assert against a different error shape than production returns.
          app.useGlobalFilters(new ApiExceptionFilter(app.get(Logger)));
          await app.init();
          const server = app.getHttpServer();
          const hasher = new PasswordHasher();

          // Two Companies, each with an administrator, plus a Company user whose
          // Role grants neither reconciliation permission.
          const makeCompany = async (label: string, permission: string | null) => {
            const companyId = randomUUID();
            const accountId = randomUUID();
            const roleId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            const subdomain = `http-${label}-${suffix}`;
            const password = `Rollback-http-${label}-password`;
            const hash = await hasher.hash(password);
            await sql`
              insert into companies (id, code, subdomain, name_en, status, activated_at)
              values (${companyId}::uuid, ${`HTP-${suffix}`}, ${subdomain}, 'HTTP Co',
                      'active', now())
            `.execute(transaction);
            await sql`
              insert into accounts (
                id, company_id, account_kind, username, password_hash, status, password_changed_at
              ) values (${accountId}::uuid, ${companyId}::uuid, 'company_user', 'administrator',
                        ${hash}, 'active', now())
            `.execute(transaction);
            await sql`
              insert into company_users (company_id, account_id, display_name, name_en)
              values (${companyId}::uuid, ${accountId}::uuid, 'HTTP Admin', 'HTTP Admin')
            `.execute(transaction);
            await sql`
              insert into roles (id, company_id, code, name, is_system)
              values (${roleId}::uuid, ${companyId}::uuid, 'company_admin', ${`Role ${suffix}`}, true)
            `.execute(transaction);
            await sql`
              insert into role_permissions (role_id, permission_code)
              values (${roleId}::uuid, ${permission ?? "orders.assign_driver"})
            `.execute(transaction);
            await sql`
              insert into account_roles (account_id, role_id, company_id)
              values (${accountId}::uuid, ${roleId}::uuid, ${companyId}::uuid)
            `.execute(transaction);
            const login = await request(server)
              .post("/api/v1/auth/login")
              .set("Host", `${subdomain}.blueline.test`)
              .send({ identifier: "administrator", password })
              .expect(200);
            return { companyId, token: String(login.body.accessToken) };
          };

          const admin = await makeCompany("a", "users_roles.manage");
          const scoped = await makeCompany("b", "reconciliations.create");
          const unprivileged = await makeCompany("c", null);

          const authed = (token: string) => (path: string) =>
            request(server).get(`/api/v1${path}`).set("Authorization", `Bearer ${token}`);

          // --- Guard wiring --------------------------------------------------
          await request(server).get("/api/v1/operations/cash/reconciliations").expect(401);
          await request(server).get("/api/v1/operations/cash/drivers").expect(401);
          await request(server)
            .post("/api/v1/operations/cash/reconciliations/selected")
            .send({ expenses: [], orderIds: [], payments: [], selectionMode: "ids" })
            .expect(401);

          // A Role without either permission is refused.
          await authed(unprivileged.token)("/operations/cash/reconciliations").expect(403);
          await authed(unprivileged.token)("/operations/cash/expense-types").expect(403);

          // Both approved permissions grant access.
          await authed(admin.token)("/operations/cash/reconciliations").expect(200);
          await authed(scoped.token)("/operations/cash/reconciliations").expect(200);
          await authed(scoped.token)("/operations/cash/expense-types").expect(200);

          // --- Query coercion -------------------------------------------------
          const coerced = await authed(admin.token)(
            "/operations/cash/reconciliations?page=2&pageSize=50",
          ).expect(200);
          // Strings from the query string arrive as numbers in the response.
          expect(coerced.body.page).toBe(2);
          expect(coerced.body.pageSize).toBe(50);
          expect(Array.isArray(coerced.body.items)).toBe(true);
          expect(typeof coerced.body.total).toBe("number");

          const defaulted = await authed(admin.token)(
            "/operations/cash/reconciliations",
          ).expect(200);
          expect(defaulted.body.page).toBe(1);
          expect(defaulted.body.pageSize).toBe(25);

          // --- Validation-pipe rejections ------------------------------------
          // Unapproved page size.
          await authed(admin.token)("/operations/cash/reconciliations?pageSize=200").expect(400);
          await authed(admin.token)("/operations/cash/reconciliations?pageSize=7").expect(400);
          await authed(admin.token)("/operations/cash/reconciliations?pageSize=abc").expect(400);
          // Invalid sort field and direction.
          await authed(admin.token)("/operations/cash/reconciliations?sortBy=driver_id").expect(400);
          await authed(admin.token)(
            "/operations/cash/reconciliations?sortDirection=sideways",
          ).expect(400);
          // Malformed dates.
          await authed(admin.token)("/operations/cash/reconciliations?dateFrom=18-07-2026").expect(
            400,
          );
          await authed(admin.token)("/operations/cash/reconciliations?dateTo=not-a-date").expect(
            400,
          );
          // Unknown query parameter is rejected by forbidNonWhitelisted.
          await authed(admin.token)("/operations/cash/reconciliations?unexpected=1").expect(400);
          // Non-UUID identifier.
          await authed(admin.token)("/operations/cash/reconciliations?driverId=not-a-uuid").expect(
            400,
          );
          // Missing required parameter on eligible Orders.
          await authed(admin.token)("/operations/cash/eligible-orders").expect(400);
          await authed(admin.token)("/operations/cash/eligible-orders?driverId=nope").expect(400);
          // Malformed path parameter.
          await authed(admin.token)("/operations/cash/reconciliations/not-a-uuid").expect(400);

          // --- Body DTO validation -------------------------------------------
          const post = (token: string, path: string, body: object) =>
            request(server)
              .post(`/api/v1${path}`)
              .set("Authorization", `Bearer ${token}`)
              .send(body);

          await post(admin.token, "/operations/cash/reconciliations/preview", {
            expenses: [],
            orderIds: [],
            payments: [],
            selectionMode: "sideways",
          }).expect(400);
          await post(admin.token, "/operations/cash/reconciliations/preview", {
            expenses: [{ amount: -5, expenseTypeId: randomUUID() }],
            orderIds: [],
            payments: [],
            selectionMode: "ids",
          }).expect(400);
          await post(admin.token, "/operations/cash/reconciliations/preview", {
            expenses: [],
            orderIds: [],
            payments: [{ amount: 10, paymentMethod: "cheque" }],
            selectionMode: "ids",
          }).expect(400);

          // A confirmation without an idempotency key is refused by the service.
          const missingKey = await post(admin.token, "/operations/cash/reconciliations/selected", {
            expenses: [],
            orderIds: [randomUUID()],
            payments: [],
            selectionMode: "ids",
          });
          expect(missingKey.status).toBe(400);
          expect(missingKey.body.error?.code).toBe("idempotency_key_invalid");

          // --- Safe error mapping ---------------------------------------------
          const notFound = await authed(admin.token)(
            `/operations/cash/reconciliations/${randomUUID()}`,
          ).expect(404);
          expect(notFound.body.error?.code).toBe("reconciliation_not_found");
          expect(typeof notFound.body.error?.correlationId).toBe("string");
          const serialised = JSON.stringify(notFound.body).toLowerCase();
          for (const leak of ["select ", "insert ", "pg_", "kysely", "at object.", ".ts:", "stack"]) {
            expect(serialised).not.toContain(leak);
          }

          // --- Tenant isolation at the HTTP boundary --------------------------
          const crossDrivers = await authed(scoped.token)(
            "/operations/cash/drivers?pageSize=25",
          ).expect(200);
          expect(crossDrivers.body.items).toHaveLength(0);
          // Company A's token cannot read a Company B reconciliation id.
          await authed(admin.token)(`/operations/cash/reconciliations/${randomUUID()}`).expect(404);

          // --- Deprecated legacy endpoint --------------------------------------
          const legacy = await post(
            admin.token,
            `/operations/orders/${randomUUID()}/reconcile-cash`,
            { paymentMethod: "cash" },
          );
          // Reaches the authoritative service and fails on Company scope, not 404 routing.
          expect(legacy.status).toBe(404);
          expect(legacy.body.error?.code).toBe("order_not_found");
          // It is permission-gated like the rest of the module.
          await request(server)
            .post(`/api/v1/operations/orders/${randomUUID()}/reconcile-cash`)
            .set("Authorization", `Bearer ${unprivileged.token}`)
            .send({ paymentMethod: "cash" })
            .expect(403);

          throw rollbackMarker;
        } finally {
          await app?.close();
        }
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      await database.destroy();
    }
  }, 180_000);
});
