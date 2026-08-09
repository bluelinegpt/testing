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
            return { accountId, companyId, token: String(login.body.accessToken) };
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

          const defaulted = await authed(admin.token)("/operations/cash/reconciliations").expect(
            200,
          );
          expect(defaulted.body.page).toBe(1);
          expect(defaulted.body.pageSize).toBe(25);

          // --- Validation-pipe rejections ------------------------------------
          // Unapproved page size.
          await authed(admin.token)("/operations/cash/reconciliations?pageSize=200").expect(400);
          await authed(admin.token)("/operations/cash/reconciliations?pageSize=7").expect(400);
          await authed(admin.token)("/operations/cash/reconciliations?pageSize=abc").expect(400);
          // Invalid sort field and direction.
          await authed(admin.token)("/operations/cash/reconciliations?sortBy=driver_id").expect(
            400,
          );
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
          for (const leak of [
            "select ",
            "insert ",
            "pg_",
            "kysely",
            "at object.",
            ".ts:",
            "stack",
          ]) {
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

          // --- Driver Shipment Manifest and Driver Collection report endpoints ---
          const createDriver = async (label: string) => {
            const driverId = randomUUID();
            const driverAccountId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            await sql`
              insert into accounts (id, company_id, account_kind, username, password_hash)
              values (${driverAccountId}::uuid, ${admin.companyId}::uuid, 'driver',
                      ${`http.driver.${label}.${suffix}`}, 'test-only')
            `.execute(transaction);
            await sql`
              insert into drivers (
                id, company_id, account_id, code, driver_type, name_en, mobile_number,
                account_status, outsourced_fee_per_delivered_order
              ) values (
                ${driverId}::uuid, ${admin.companyId}::uuid, ${driverAccountId}::uuid,
                ${`HDRV-${label}-${suffix}`}, 'outsourced', ${`HTTP Driver ${label}`},
                '971500000005', 'active', 7.5
              )
            `.execute(transaction);
            return driverId;
          };

          const createManifestOrder = async (options: {
            readonly driverId: string;
            readonly deliveryStatus?: string;
          }) => {
            const orderId = randomUUID();
            const traderId = randomUUID();
            const areaId = randomUUID();
            const traderAccountId = randomUUID();
            const suffix = orderId.slice(0, 8);
            await sql`
              insert into areas (id, company_id, emirate_id, code, name_en)
              values (${areaId}::uuid, ${admin.companyId}::uuid,
                      (select id from emirates where code='DXB'), ${`HA-${suffix}`}, ${`HTTP Area ${suffix}`})
            `.execute(transaction);
            await sql`
              insert into accounts (id, company_id, account_kind, username, password_hash)
              values (${traderAccountId}::uuid, ${admin.companyId}::uuid, 'trader',
                      ${`http.trader.${suffix}`}, 'test-only')
            `.execute(transaction);
            await sql`
              insert into traders (
                id, company_id, account_id, code, name_en, mobile_number, account_status
              ) values (${traderId}::uuid, ${admin.companyId}::uuid, ${traderAccountId}::uuid,
                        ${`HT-${suffix}`}, ${`HTTP Trader ${suffix}`}, '971500000006', 'active')
            `.execute(transaction);
            await sql`
              insert into orders (
                service_fee_override_reason, id, company_id, order_number, order_date, trader_id, area_id,
                created_by_account_id, assigned_driver_id, customer_name,
                customer_mobile_number, customer_address, package_count, payment_condition,
                amount_collected, customer_amount_due, driver_cost,
                trader_gross_payable, trader_paid_service_fee, trader_deductions,
                trader_charges, trader_adjustments, trader_net_payable,
                delivery_status, driver_reconciliation_status, trader_settlement_status,
                delivered_at, pricing_provenance_status, final_service_fee_snapshot,
                customer_provenance_status
              ) values (
                'Zero configured Service Fee (fixture)', ${orderId}::uuid, ${admin.companyId}::uuid, ${`HTTP-${suffix}`}, current_date,
                ${traderId}::uuid, ${areaId}::uuid, ${admin.accountId}::uuid, ${options.driverId}::uuid,
                'HTTP Customer', '971500000007', 'HTTP Address', 2, 'customer_pays_cod_and_fee',
                0, 55, 7.5, 55, 0, 0, 0, 0, 55,
                'assigned_to_driver', 'not_applicable', 'not_eligible', null,
                'legacy_unattributed', 0, 'legacy_unattributed'
              )
            `.execute(transaction);
            await sql`
              insert into order_assignments (company_id, order_id, driver_id, assigned_by_account_id)
              values (${admin.companyId}::uuid, ${orderId}::uuid, ${options.driverId}::uuid,
                      ${admin.accountId}::uuid)
            `.execute(transaction);
            // Assignment can only be inserted while the Order is newly-assigned or
            // held, so status transitions like Cancelled are applied afterward.
            if (
              options.deliveryStatus !== undefined &&
              options.deliveryStatus !== "assigned_to_driver"
            ) {
              await sql`
                update orders set delivery_status = ${options.deliveryStatus} where id = ${orderId}::uuid
              `.execute(transaction);
            }
            return orderId;
          };

          const manifestDriverOne = await createDriver("one");
          const manifestDriverTwo = await createDriver("two");
          const manifestOrderOne = await createManifestOrder({ driverId: manifestDriverOne });
          const manifestOrderTwo = await createManifestOrder({ driverId: manifestDriverOne });
          const manifestOrderOtherDriver = await createManifestOrder({
            driverId: manifestDriverTwo,
          });
          const manifestOrderCancelled = await createManifestOrder({
            deliveryStatus: "cancelled",
            driverId: manifestDriverOne,
          });

          // Guard wiring and permission gating on the new Manifest endpoints.
          await request(server)
            .post("/api/v1/operations/cash/driver-shipment-manifest/data")
            .send({ orderIds: [manifestOrderOne], selectionMode: "ids" })
            .expect(401);
          // "scoped" only holds reconciliations.create, which the Manifest guard
          // does not accept (it needs reports.export/orders.assign_driver/
          // orders.update_delivery_status/users_roles.manage).
          await post(scoped.token, "/operations/cash/driver-shipment-manifest/data", {
            orderIds: [manifestOrderOne],
            selectionMode: "ids",
          }).expect(403);

          // DTO validation on the shared OrderSelectionDto shape.
          await post(admin.token, "/operations/cash/driver-shipment-manifest/data", {
            orderIds: [manifestOrderOne],
            selectionMode: "sideways",
          }).expect(400);

          // Empty selection is a clear business rejection, not a 500.
          const empty = await post(admin.token, "/operations/cash/driver-shipment-manifest/data", {
            orderIds: [],
            selectionMode: "ids",
          });
          expect(empty.status).toBe(400);
          expect(empty.body.error?.code).toBe("manifest_empty");

          // Mixed-Driver selection is rejected with the exact business message.
          const mixedDrivers = await post(
            admin.token,
            "/operations/cash/driver-shipment-manifest/data",
            { orderIds: [manifestOrderOne, manifestOrderOtherDriver], selectionMode: "ids" },
          );
          expect(mixedDrivers.status).toBe(409);
          expect(mixedDrivers.body.error?.code).toBe("manifest_driver_mismatch");

          // A Cancelled Order is rejected and named in the details.
          const withCancelled = await post(
            admin.token,
            "/operations/cash/driver-shipment-manifest/data",
            { orderIds: [manifestOrderOne, manifestOrderCancelled], selectionMode: "ids" },
          );
          expect(withCancelled.status).toBe(409);
          expect(withCancelled.body.error?.code).toBe("manifest_order_cancelled");
          expect(withCancelled.body.error?.details).toEqual(
            expect.arrayContaining([expect.stringContaining("HTTP-")]),
          );

          // A valid same-Driver selection returns real, server-computed totals.
          const manifestData = await post(
            admin.token,
            "/operations/cash/driver-shipment-manifest/data",
            { orderIds: [manifestOrderOne, manifestOrderTwo], selectionMode: "ids" },
          ).expect(201);
          expect(manifestData.body.header.orderCount).toBe(2);
          expect(manifestData.body.summary.totalOrders).toBe(2);
          expect(manifestData.body.summary.totalCod).toBe("110.00");
          expect(manifestData.body.orders).toHaveLength(2);
          // No internal Order/Driver ids are ever exposed in report data.
          expect(JSON.stringify(manifestData.body)).not.toContain(manifestDriverOne);

          // "Select all matching" filter-mode selection: resolves the same way
          // the Orders list filters (by Driver here), and stays scoped to
          // Orders actually assigned to that Driver — driverTwo's Order and the
          // Cancelled Order (same Driver) are excluded by the filter query
          // itself, without needing an explicit exclusion or error.
          const filterAllForDriverOne = await post(
            admin.token,
            "/operations/cash/driver-shipment-manifest/data",
            { driverId: manifestDriverOne, selectionMode: "filter" },
          ).expect(201);
          expect(filterAllForDriverOne.body.header.orderCount).toBe(2);
          expect(filterAllForDriverOne.body.orders).toHaveLength(2);
          expect(
            filterAllForDriverOne.body.orders.every(
              (row: { deliveryStatusLabel: string }) => row.deliveryStatusLabel !== "Cancelled",
            ),
          ).toBe(true);

          // Explicitly excluding one Order from the filtered set narrows it
          // further, exactly as the Orders list "select all matching" does.
          const filterExcludingOne = await post(
            admin.token,
            "/operations/cash/driver-shipment-manifest/data",
            {
              driverId: manifestDriverOne,
              excludedOrderIds: [manifestOrderTwo],
              selectionMode: "filter",
            },
          ).expect(201);
          expect(filterExcludingOne.body.header.orderCount).toBe(1);

          // The true PDF bytes are real, not just the JSON preview (never trust
          // report-data alone as proof that printing works).
          const manifestPdf = await request(server)
            .post("/api/v1/operations/cash/driver-shipment-manifest/pdf?language=en")
            .set("Authorization", `Bearer ${admin.token}`)
            .responseType("blob")
            .send({ orderIds: [manifestOrderOne, manifestOrderTwo], selectionMode: "ids" })
            .expect(201);
          expect(manifestPdf.headers["content-type"]).toContain("application/pdf");
          expect(manifestPdf.headers["content-disposition"]).toContain("Driver-Manifest-");
          expect(manifestPdf.headers["content-disposition"]).toContain(".pdf");
          const manifestBytes: Buffer = Buffer.isBuffer(manifestPdf.body)
            ? manifestPdf.body
            : Buffer.from(manifestPdf.body);
          expect(manifestBytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
          expect(manifestBytes.length).toBeGreaterThan(1000);

          // --- Order -> Driver Collection lookup, and the collection PDF itself ---
          await request(server)
            .get(`/api/v1/operations/orders/${manifestOrderOne}/driver-collection`)
            .expect(401);
          await request(server)
            .get(`/api/v1/operations/orders/${manifestOrderOne}/driver-collection`)
            .set("Authorization", `Bearer ${unprivileged.token}`)
            .expect(403);

          // No reconciliation exists yet: the lookup is a real 204, not a 200
          // with an ambiguous empty body (which the API client cannot tell
          // apart from a non-JSON error response).
          await authed(admin.token)(
            `/operations/orders/${manifestOrderOne}/driver-collection`,
          ).expect(204);

          // Confirm a real Driver Collection through the HTTP boundary, then the
          // lookup and the report PDF must both reflect it.
          await sql`
            update orders
               set delivery_status = 'delivered', driver_reconciliation_status = 'pending',
                   amount_collected = 55, trader_settlement_status = 'unsettled', delivered_at = now()
             where id in (${manifestOrderOne}::uuid, ${manifestOrderTwo}::uuid)
          `.execute(transaction);
          const confirmResponse = await post(
            admin.token,
            "/operations/cash/reconciliations/selected",
            {
              collectionPaymentMethod: "cash",
              excludedOrderIds: [],
              expenses: [],
              orderIds: [manifestOrderOne],
              payments: [{ amount: 55, paymentMethod: "cash" }],
              selectionMode: "ids",
            },
          )
            .set("X-Idempotency-Key", `http-manifest-${randomUUID()}`)
            .expect(201);
          const reconciliationId = String(confirmResponse.body.reconciliationId);
          const reconciliationNumber = String(confirmResponse.body.reconciliationNumber);

          const linkedCollection = await authed(admin.token)(
            `/operations/orders/${manifestOrderOne}/driver-collection`,
          ).expect(200);
          expect(linkedCollection.body).toEqual({
            reconciliationId,
            reconciliationNumber,
          });

          const collectionPdf = await request(server)
            .get(`/api/v1/operations/cash/reconciliations/${reconciliationId}/pdf?language=en`)
            .set("Authorization", `Bearer ${admin.token}`)
            .responseType("blob")
            .expect(200);
          expect(collectionPdf.headers["content-type"]).toContain("application/pdf");
          expect(collectionPdf.headers["content-disposition"]).toContain(reconciliationNumber);
          const collectionBytes: Buffer = Buffer.isBuffer(collectionPdf.body)
            ? collectionPdf.body
            : Buffer.from(collectionPdf.body);
          expect(collectionBytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
          expect(collectionBytes.length).toBeGreaterThan(1000);

          // A direct duplicate-collection attempt on the already-reconciled Order
          // is rejected with the specific, reconciliation-naming error (§1).
          const duplicateAttempt = await post(
            admin.token,
            "/operations/cash/reconciliations/selected",
            {
              collectionPaymentMethod: "cash",
              excludedOrderIds: [],
              expenses: [],
              orderIds: [manifestOrderOne],
              payments: [{ amount: 55, paymentMethod: "cash" }],
              selectionMode: "ids",
            },
          ).set("X-Idempotency-Key", `http-manifest-dup-${randomUUID()}`);
          expect(duplicateAttempt.status).toBe(409);
          expect(duplicateAttempt.body.error?.code).toBe("order_already_reconciled");
          expect(duplicateAttempt.body.error?.details?.[0]).toContain(reconciliationNumber);

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
