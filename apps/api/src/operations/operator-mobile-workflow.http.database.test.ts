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

const runHttpTests = process.env.RUN_OPERATOR_MOBILE_HTTP === "true";
const rollbackMarker = Symbol("rollback operator mobile workflow http test");

/**
 * HTTP-boundary tests for the Prompt 12B Operator mobile surface:
 * `GET orders/dashboard-summary`, `GET orders/:orderId` permission fix,
 * `PATCH orders/:orderId/status` permission fix, and driver
 * assignment/reassignment through `POST orders/bulk-assign`.
 *
 * Mirrors `reconciliation-http.database.test.ts`'s pattern: one real booted
 * app bound to a single rolled-back transaction, one `it()` walking every
 * guard/business-rule case so the whole surface commits or rolls back
 * together.
 */
describe.skipIf(!runHttpTests)("Operator mobile workflow HTTP boundary", () => {
  it("enforces narrow Operator permissions, Company isolation, and the reassignment rule", async () => {
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
          app.useGlobalFilters(new ApiExceptionFilter(app.get(Logger)));
          await app.init();
          const server = app.getHttpServer();
          const hasher = new PasswordHasher();

          const makeCompany = async (label: string, permissions: readonly string[] | null) => {
            const companyId = randomUUID();
            const accountId = randomUUID();
            const roleId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            const subdomain = `opm-${label}-${suffix}`;
            const password = `Rollback-opm-${label}-password`;
            const hash = await hasher.hash(password);
            await sql`
                insert into companies (id, code, subdomain, name_en, status, activated_at)
                values (${companyId}::uuid, ${`OPM-${suffix}`}, ${subdomain}, 'Operator Mobile Co',
                        'active', now())
              `.execute(transaction);
            await sql`
                insert into accounts (
                  id, company_id, account_kind, username, password_hash, status, password_changed_at
                ) values (${accountId}::uuid, ${companyId}::uuid, 'company_user', 'operator',
                          ${hash}, 'active', now())
              `.execute(transaction);
            await sql`
                insert into roles (id, company_id, code, name, is_system)
                values (${roleId}::uuid, ${companyId}::uuid, 'operator_role', ${`Role ${suffix}`}, true)
              `.execute(transaction);
            if (permissions !== null && permissions.length > 0) {
              await sql`
                  insert into role_permissions (role_id, permission_code)
                  values ${sql.join(permissions.map((permission) => sql`(${roleId}::uuid, ${permission})`))}
                `.execute(transaction);
            }
            await sql`
                insert into account_roles (account_id, role_id, company_id)
                values (${accountId}::uuid, ${roleId}::uuid, ${companyId}::uuid)
              `.execute(transaction);
            const login = await request(server)
              .post("/api/v1/auth/login")
              .set("Host", `${subdomain}.blueline.test`)
              .send({ identifier: "operator", password })
              .expect(200);
            return { accountId, companyId, subdomain, token: String(login.body.accessToken) };
          };

          const createDriver = async (companyId: string, label: string) => {
            const driverId = randomUUID();
            const driverAccountId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            await sql`
                insert into accounts (id, company_id, account_kind, username, password_hash)
                values (${driverAccountId}::uuid, ${companyId}::uuid, 'driver',
                        ${`opm.driver.${label}.${suffix}`}, 'test-only')
              `.execute(transaction);
            await sql`
                insert into drivers (
                  id, company_id, account_id, code, driver_type, name_en, mobile_number,
                  account_status, outsourced_fee_per_delivered_order
                ) values (
                  ${driverId}::uuid, ${companyId}::uuid, ${driverAccountId}::uuid,
                  ${`ODRV-${label}-${suffix}`}, 'outsourced', ${`Operator Driver ${label}`},
                  '971500000008', 'active', 7.5
                )
              `.execute(transaction);
            return driverId;
          };

          // A "Driver User": a `company_user` account whose linked Employee
          // backs a `drivers.employee_id` record — no `driver`-kind account
          // anywhere, exactly the real-world D123 shape found during the
          // Driver Physical Correction. Returns the resolved Driver id so
          // Orders can be assigned to it and counts asserted against it.
          const makeDriverUser = async (
            companyId: string,
            subdomain: string,
            permissions: readonly string[],
            label: string,
          ) => {
            const accountId = randomUUID();
            const roleId = randomUUID();
            const companyUserId = randomUUID();
            const employeeId = randomUUID();
            const driverId = randomUUID();
            const linkId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            const password = `Rollback-opm-du-${label}-password`;
            const hash = await hasher.hash(password);
            await sql`
                insert into accounts (
                  id, company_id, account_kind, username, password_hash, status, password_changed_at
                ) values (${accountId}::uuid, ${companyId}::uuid, 'company_user',
                          ${`opm.du.${label}.${suffix}`}, ${hash}, 'active', now())
              `.execute(transaction);
            await sql`
                insert into roles (id, company_id, code, name, is_system)
                values (${roleId}::uuid, ${companyId}::uuid, ${`opm_du_${suffix}`}, ${`Role ${suffix}`}, true)
              `.execute(transaction);
            if (permissions.length > 0) {
              await sql`
                  insert into role_permissions (role_id, permission_code)
                  values ${sql.join(permissions.map((permission) => sql`(${roleId}::uuid, ${permission})`))}
                `.execute(transaction);
            }
            await sql`
                insert into account_roles (account_id, role_id, company_id)
                values (${accountId}::uuid, ${roleId}::uuid, ${companyId}::uuid)
              `.execute(transaction);
            await sql`
                insert into company_users (id, company_id, account_id, name_en, display_name)
                values (${companyUserId}::uuid, ${companyId}::uuid, ${accountId}::uuid,
                        ${`Driver User ${label}`}, ${`Driver User ${label}`})
              `.execute(transaction);
            await sql`
                insert into employees (id, company_id, company_user_id, name_en, mobile_number)
                values (${employeeId}::uuid, ${companyId}::uuid, ${companyUserId}::uuid,
                        ${`Driver User ${label}`}, '971500000011')
              `.execute(transaction);
            await sql`
                insert into drivers (
                  id, company_id, account_id, employee_id, code, driver_type, name_en, mobile_number,
                  account_status
                ) values (
                  ${driverId}::uuid, ${companyId}::uuid, null, ${employeeId}::uuid,
                  ${`DUDR-${label}-${suffix}`}, 'employee', ${`Driver User ${label}`},
                  '971500000011', 'active'
                )
              `.execute(transaction);
            await sql`
                insert into user_business_links (
                  id, company_id, account_id, entity_type, entity_id, access_status, is_primary,
                  created_by_account_id
                ) values (${linkId}::uuid, ${companyId}::uuid, ${accountId}::uuid, 'employee',
                          ${employeeId}::uuid, 'active', true, ${accountId}::uuid)
              `.execute(transaction);
            const login = await request(server)
              .post("/api/v1/auth/login")
              .set("Host", `${subdomain}.blueline.test`)
              .send({ identifier: `opm.du.${label}.${suffix}`, password })
              .expect(200);
            return { accountId, driverId, token: String(login.body.accessToken) };
          };

          const createOrder = async (options: {
            readonly companyId: string;
            readonly createdByAccountId: string;
            readonly deliveryStatus: string;
            readonly driverId?: string | null;
            readonly deliveredAt?: "today" | null;
          }) => {
            const orderId = randomUUID();
            const traderId = randomUUID();
            const areaId = randomUUID();
            const traderAccountId = randomUUID();
            const suffix = orderId.slice(0, 8);
            await sql`
                insert into areas (id, company_id, emirate_id, code, name_en)
                values (${areaId}::uuid, ${options.companyId}::uuid,
                        (select id from emirates where code='DXB'), ${`OA-${suffix}`}, ${`Operator Area ${suffix}`})
              `.execute(transaction);
            await sql`
                insert into accounts (id, company_id, account_kind, username, password_hash)
                values (${traderAccountId}::uuid, ${options.companyId}::uuid, 'trader',
                        ${`opm.trader.${suffix}`}, 'test-only')
              `.execute(transaction);
            await sql`
                insert into traders (id, company_id, account_id, code, name_en, mobile_number, account_status)
                values (${traderId}::uuid, ${options.companyId}::uuid, ${traderAccountId}::uuid,
                        ${`OT-${suffix}`}, ${`Operator Trader ${suffix}`}, '971500000009', 'active')
              `.execute(transaction);
            // `enforce_initial_order_assignment` only permits a new active
            // `order_assignments` row while the Order is Assigned-to-Driver
            // or Hold — so a Driver-bearing fixture is always first created
            // at `assigned_to_driver`, given its assignment row, and only
            // then moved on to whatever final status the scenario needs.
            const initialStatus =
              options.driverId != null ? "assigned_to_driver" : options.deliveryStatus;
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
                  'Zero configured Service Fee (fixture)', ${orderId}::uuid, ${options.companyId}::uuid,
                  ${`OPM-ORD-${suffix}`}, current_date, ${traderId}::uuid, ${areaId}::uuid,
                  ${options.createdByAccountId}::uuid, ${options.driverId ?? null},
                  'Operator Customer', '971500000010', 'Operator Address', 1, 'customer_pays_cod_and_fee',
                  0, 55, 7.5, 55, 0, 0, 0, 0, 55,
                  ${initialStatus}, 'not_applicable', 'not_eligible',
                  ${options.deliveredAt === "today" ? sql`now()` : null},
                  'legacy_unattributed', 0, 'legacy_unattributed'
                )
              `.execute(transaction);
            if (options.driverId != null) {
              await sql`
                  insert into order_assignments (company_id, order_id, driver_id, assigned_by_account_id)
                  values (${options.companyId}::uuid, ${orderId}::uuid, ${options.driverId}::uuid,
                          ${options.createdByAccountId}::uuid)
                `.execute(transaction);
              if (options.deliveryStatus !== initialStatus) {
                // `orders_return_delivery_sync_check` ties return_status to
                // delivery_status for the return states specifically.
                const returnStatus = ["returned_to_branch", "returned_to_trader"].includes(
                  options.deliveryStatus,
                )
                  ? options.deliveryStatus
                  : "not_applicable";
                await sql`
                    update orders
                       set delivery_status = ${options.deliveryStatus}, return_status = ${returnStatus}
                     where id = ${orderId}::uuid
                  `.execute(transaction);
              }
            }
            return orderId;
          };

          // --- Fixtures -------------------------------------------------------
          const narrowOperator = await makeCompany("narrow", [
            "orders.assign_driver",
            "orders.update_delivery_status",
          ]);
          const noPermission = await makeCompany("none", null);
          const admin = await makeCompany("admin", ["users_roles.manage"]);
          const companyB = await makeCompany("companyb", [
            "orders.assign_driver",
            "orders.update_delivery_status",
          ]);

          const driverA1 = await createDriver(narrowOperator.companyId, "a1");
          const driverA2 = await createDriver(narrowOperator.companyId, "a2");
          const driverB1 = await createDriver(companyB.companyId, "b1");

          // A "Driver User" in the SAME Company as `narrowOperator`, holding
          // the SAME broad Orders permissions any Operator there might have
          // — proving the dashboard narrowing comes from the identity being a
          // Driver User, never from a reduced permission set.
          const driverUser = await makeDriverUser(
            narrowOperator.companyId,
            narrowOperator.subdomain,
            ["orders.assign_driver", "orders.update_delivery_status"],
            "a",
          );

          const orderNew = await createOrder({
            companyId: narrowOperator.companyId,
            createdByAccountId: narrowOperator.accountId,
            deliveryStatus: "new",
          });
          const orderAssigned = await createOrder({
            companyId: narrowOperator.companyId,
            createdByAccountId: narrowOperator.accountId,
            deliveryStatus: "assigned_to_driver",
            driverId: driverA1,
          });
          const orderOutForDelivery = await createOrder({
            companyId: narrowOperator.companyId,
            createdByAccountId: narrowOperator.accountId,
            deliveryStatus: "out_for_delivery",
            driverId: driverA1,
          });
          const orderDeliveredToday = await createOrder({
            companyId: narrowOperator.companyId,
            createdByAccountId: narrowOperator.accountId,
            deliveryStatus: "delivered",
            driverId: driverA1,
            deliveredAt: "today",
          });
          const orderReturnedToBranch = await createOrder({
            companyId: narrowOperator.companyId,
            createdByAccountId: narrowOperator.accountId,
            deliveryStatus: "returned_to_branch",
            driverId: driverA1,
          });
          const orderCancelled = await createOrder({
            companyId: narrowOperator.companyId,
            createdByAccountId: narrowOperator.accountId,
            deliveryStatus: "cancelled",
          });
          const orderCompanyB = await createOrder({
            companyId: companyB.companyId,
            createdByAccountId: companyB.accountId,
            deliveryStatus: "new",
          });

          // Two Orders assigned to the Driver User's own Driver — mirrors the
          // real D123 physical-test shape (exactly 2 Orders, both Out for
          // Delivery). Plus one Order assigned to an UNRELATED Driver
          // (`driverA1`) in the SAME Company, to prove the Driver User's
          // dashboard excludes another Driver's Orders, not just other
          // Companies'.
          const driverUserOrder1 = await createOrder({
            companyId: narrowOperator.companyId,
            createdByAccountId: narrowOperator.accountId,
            deliveryStatus: "out_for_delivery",
            driverId: driverUser.driverId,
          });
          const driverUserOrder2 = await createOrder({
            companyId: narrowOperator.companyId,
            createdByAccountId: narrowOperator.accountId,
            deliveryStatus: "out_for_delivery",
            driverId: driverUser.driverId,
          });

          const authed = (token: string) => (path: string) =>
            request(server).get(`/api/v1${path}`).set("Authorization", `Bearer ${token}`);
          const post = (token: string, path: string, body: object) =>
            request(server)
              .post(`/api/v1${path}`)
              .set("Authorization", `Bearer ${token}`)
              .send(body);
          const patch = (token: string, path: string, body: object) =>
            request(server)
              .patch(`/api/v1${path}`)
              .set("Authorization", `Bearer ${token}`)
              .send(body);

          // --- Guard wiring ----------------------------------------------------
          await request(server).get("/api/v1/operations/orders/dashboard-summary").expect(401);
          await authed(noPermission.token)("/operations/orders/dashboard-summary").expect(403);
          await authed(noPermission.token)(`/operations/orders/${orderNew}`).expect(403);
          await patch(noPermission.token, `/operations/orders/${orderNew}/status`, {
            status: "in_branch",
          }).expect(403);

          // --- Dashboard summary: correct counts, no financial fields, scoped --
          const dashboard = await authed(narrowOperator.token)(
            "/operations/orders/dashboard-summary",
          ).expect(200);
          expect(dashboard.body.byStatus.new).toBe(1);
          expect(dashboard.body.byStatus.assigned_to_driver).toBe(1);
          // 1 (orderOutForDelivery, driverA1) + 2 (the Driver User's own
          // Orders) — the plain Operator has no linked Driver, so
          // `operatorDashboardSummary` narrows nothing for them and they see
          // every Order in the Company, including the Driver User's.
          expect(dashboard.body.byStatus.out_for_delivery).toBe(3);
          expect(dashboard.body.byStatus.delivered).toBe(1);
          expect(dashboard.body.byStatus.returned_to_branch).toBe(1);
          expect(dashboard.body.byStatus.cancelled).toBe(1);
          expect(dashboard.body.deliveredToday).toBe(1);
          expect(dashboard.body.returnPending).toBe(1);
          // Active = not in (hold, closed, cancelled): 8 Orders minus the 1 Cancelled.
          expect(dashboard.body.activeTotal).toBe(7);
          const dashboardKeys = JSON.stringify(dashboard.body);
          for (const financialField of [
            "codAmount",
            "companyRevenue",
            "orderProfit",
            "vatAmount",
            "traderNetPayable",
            "customerAmountDue",
          ]) {
            expect(dashboardKeys).not.toContain(financialField);
          }

          // Company B's Operator sees only Company B's single New Order.
          const dashboardB = await authed(companyB.token)(
            "/operations/orders/dashboard-summary",
          ).expect(200);
          expect(dashboardB.body.byStatus.new).toBe(1);
          expect(dashboardB.body.byStatus.assigned_to_driver).toBe(0);
          expect(dashboardB.body.activeTotal).toBe(1);

          // --- Driver User: dashboard narrows to the Driver User's own Driver
          // only (the exact bug the physical D123 test found — the identity
          // holds the SAME broad Orders permissions the plain Operator above
          // has, so this proves the narrowing is identity-based, not a
          // reduced permission set) ------------------------------------------
          const driverUserDashboard = await authed(driverUser.token)(
            "/operations/orders/dashboard-summary",
          ).expect(200);
          // Both of the Driver User's own Orders, and nothing else — not the
          // 1 New, not driverA1's Out for Delivery Order, not any of the
          // other statuses that exist in this same Company.
          expect(driverUserDashboard.body.byStatus.out_for_delivery).toBe(2);
          expect(driverUserDashboard.body.byStatus.new).toBe(0);
          expect(driverUserDashboard.body.byStatus.assigned_to_driver).toBe(0);
          expect(driverUserDashboard.body.byStatus.delivered).toBe(0);
          expect(driverUserDashboard.body.byStatus.returned_to_branch).toBe(0);
          expect(driverUserDashboard.body.byStatus.cancelled).toBe(0);
          expect(driverUserDashboard.body.deliveredToday).toBe(0);
          expect(driverUserDashboard.body.returnPending).toBe(0);
          expect(driverUserDashboard.body.activeTotal).toBe(2);

          // --- Driver User: /auth/me authoritatively signals the linked
          // Driver — this is the ONLY thing a client may use to decide "show
          // this account a Driver-style experience"; it must never guess from
          // a display name or hardcode an account. An ordinary Operator with
          // no linked Driver gets no such field at all. ----------------------
          const driverUserIdentity = await request(server)
            .get("/api/v1/auth/me")
            .set("Authorization", `Bearer ${driverUser.token}`)
            .expect(200);
          expect(driverUserIdentity.body.kind).toBe("company_user");
          expect(driverUserIdentity.body.linkedDriverId).toBe(driverUser.driverId);
          // Company name is always present alongside identity — every
          // Company-scoped account (Driver User or plain Operator alike)
          // gets it, sourced from `companies.name_en`/`name_ar`, never a
          // client-side guess.
          expect(driverUserIdentity.body.companyName).toBe("Operator Mobile Co");

          const plainOperatorIdentity = await request(server)
            .get("/api/v1/auth/me")
            .set("Authorization", `Bearer ${narrowOperator.token}`)
            .expect(200);
          expect(plainOperatorIdentity.body.kind).toBe("company_user");
          expect(plainOperatorIdentity.body.linkedDriverId).toBeUndefined();
          expect(plainOperatorIdentity.body.companyName).toBe("Operator Mobile Co");

          // --- Order detail: narrow Operator permission now works --------------
          const detail = await authed(narrowOperator.token)(
            `/operations/orders/${orderNew}`,
          ).expect(200);
          expect(detail.body.id).toBe(orderNew);
          // Order detail (only, not the list/export queries) also carries the
          // Order's Emirate — required by the Communication Center's Order
          // context panel (Prompt 13).
          expect(typeof detail.body.emirateNameEn).toBe("string");
          expect(detail.body.emirateNameEn.length).toBeGreaterThan(0);
          // Company isolation: Company B's Operator cannot see Company A's Order.
          await authed(companyB.token)(`/operations/orders/${orderNew}`).expect(404);

          // --- Status change: narrow permission works; invalid transition 409 --
          await patch(narrowOperator.token, `/operations/orders/${orderNew}/status`, {
            status: "in_branch",
          }).expect(200);
          const invalidTransition = await patch(
            narrowOperator.token,
            `/operations/orders/${orderNew}/status`,
            { status: "delivered" },
          );
          expect(invalidTransition.status).toBe(409);
          expect(invalidTransition.body.error?.code).toBe("order_status_transition_invalid");

          // --- Assignment: fresh assign, then reassign, then cross-company/terminal rejections --
          const freshAssign = await post(narrowOperator.token, "/operations/orders/bulk-assign", {
            driverIdToAssign: driverA1,
            orderIds: [orderNew],
            selectionMode: "ids",
          }).expect(201);
          expect(freshAssign.body.processedCount).toBe(1);
          const afterAssign = await authed(narrowOperator.token)(
            `/operations/orders/${orderNew}`,
          ).expect(200);
          expect(afterAssign.body.assignedDriverId).toBe(driverA1);
          expect(afterAssign.body.deliveryStatus).toBe("assigned_to_driver");

          // Reassignment to a different Driver succeeds and keeps the status.
          const reassign = await post(narrowOperator.token, "/operations/orders/bulk-assign", {
            driverIdToAssign: driverA2,
            orderIds: [orderNew],
            selectionMode: "ids",
          }).expect(201);
          expect(reassign.body.processedCount).toBe(1);
          const afterReassign = await authed(narrowOperator.token)(
            `/operations/orders/${orderNew}`,
          ).expect(200);
          expect(afterReassign.body.assignedDriverId).toBe(driverA2);
          expect(afterReassign.body.deliveryStatus).toBe("assigned_to_driver");

          // A Driver from another Company is refused, never silently cross-assigned.
          const crossCompanyAssign = await post(
            narrowOperator.token,
            "/operations/orders/bulk-assign",
            { driverIdToAssign: driverB1, orderIds: [orderNew], selectionMode: "ids" },
          );
          expect(crossCompanyAssign.status).toBe(400);
          expect(crossCompanyAssign.body.error?.code).toBe("driver_not_found");

          // Reassigning an Order already Out for Delivery is refused (Driver is
          // locked in past the assignment stage) — the preview reports it
          // ineligible rather than silently skipping it without explanation.
          const outForDeliveryPreview = await post(
            narrowOperator.token,
            "/operations/orders/bulk-assign/preview",
            { driverIdToAssign: driverA2, orderIds: [orderOutForDelivery], selectionMode: "ids" },
          ).expect(201);
          expect(outForDeliveryPreview.body.eligibleCount).toBe(0);
          expect(outForDeliveryPreview.body.ineligible[0]?.reason).toContain("reassignment");

          // Cross-company Order id in the selection resolves to nothing for
          // Company B's Operator — no cross-tenant assignment is possible.
          const crossCompanyOrder = await post(companyB.token, "/operations/orders/bulk-assign", {
            driverIdToAssign: driverB1,
            orderIds: [orderNew],
            selectionMode: "ids",
          }).expect(201);
          expect(crossCompanyOrder.body.processedCount).toBe(0);

          // --- Driver User status-change authorization (Driver Order Detail
          // action-button fix): the real-world D123 shape — a Driver User
          // whose Role holds NO `orders.update_delivery_status`/
          // `users_roles.manage` at all (only, say, `orders.assign_driver`)
          // — must still be able to change status on their OWN Order,
          // purely via Driver ownership (`currentEmployeeDriverId`), exactly
          // like a genuine `driver`-kind identity needs no permission
          // either. This is the actual root cause the physical test found:
          // mobile was correctly hiding the buttons that would have 403'd. --
          const narrowDriverUser = await makeDriverUser(
            narrowOperator.companyId,
            narrowOperator.subdomain,
            ["orders.assign_driver"],
            "narrow",
          );
          const narrowDriverUserOrder = await createOrder({
            companyId: narrowOperator.companyId,
            createdByAccountId: narrowOperator.accountId,
            deliveryStatus: "out_for_delivery",
            driverId: narrowDriverUser.driverId,
          });
          // Hold requires a reason — same rule as every other identity.
          const narrowHoldWithoutReason = await patch(
            narrowDriverUser.token,
            `/operations/orders/${narrowDriverUserOrder}/status`,
            { status: "hold" },
          );
          expect(narrowHoldWithoutReason.status).toBe(400);
          expect(narrowHoldWithoutReason.body.error?.code).toBe("order_status_reason_required");
          const narrowHeld = await patch(
            narrowDriverUser.token,
            `/operations/orders/${narrowDriverUserOrder}/status`,
            { status: "hold", reason: "Customer requested a later delivery" },
          ).expect(200);
          expect(narrowHeld.body.deliveryStatus).toBe("hold");
          // Still gets exactly the narrow Driver transition set, never the
          // Operator's broader lifecycle — no resume-from-hold for them.
          const narrowResumeDenied = await patch(
            narrowDriverUser.token,
            `/operations/orders/${narrowDriverUserOrder}/status`,
            { status: "out_for_delivery" },
          );
          expect(narrowResumeDenied.status).toBe(409);
          expect(narrowResumeDenied.body.error?.code).toBe("order_status_transition_invalid");
          // A SECOND Order, this time taken straight to Delivered.
          const narrowDeliverOrder = await createOrder({
            companyId: narrowOperator.companyId,
            createdByAccountId: narrowOperator.accountId,
            deliveryStatus: "out_for_delivery",
            driverId: narrowDriverUser.driverId,
          });
          const narrowDelivered = await patch(
            narrowDriverUser.token,
            `/operations/orders/${narrowDeliverOrder}/status`,
            { status: "delivered" },
          ).expect(200);
          expect(narrowDelivered.body.deliveryStatus).toBe("delivered");
          // Cannot touch a DIFFERENT Driver's Order — ownership is
          // re-verified per request, never inferred from a prior success.
          // Same fate as a nonexistent Order (`order_not_found`), never a
          // distinct code that would confirm the Order exists.
          const narrowCrossDriverDenied = await patch(
            narrowDriverUser.token,
            `/operations/orders/${orderOutForDelivery}/status`,
            { status: "delivered" },
          );
          expect(narrowCrossDriverDenied.status).toBe(404);
          expect(narrowCrossDriverDenied.body.error?.code).toBe("order_not_found");

          // A bare company_user — no Orders permission at all AND no linked
          // Driver at all (`noPermission`, unlike `makeDriverUser`, never
          // creates an Employee/Driver link) — still gets the exact same
          // rejection the guard used to give before this fix, just
          // relocated into the service.
          const bareDenied = await patch(
            noPermission.token,
            `/operations/orders/${orderOutForDelivery}/status`,
            { status: "delivered" },
          );
          expect(bareDenied.status).toBe(403);
          expect(bareDenied.body.error?.code).toBe("permission_denied");

          // A plain Operator's own existing behavior is completely
          // unaffected by any of the above — still requires the permission,
          // still 403s exactly as before.
          await patch(noPermission.token, `/operations/orders/${orderNew}/status`, {
            status: "in_branch",
          }).expect(403);

          // --- `orders.driver_self_service`: the actual Driver role's ONLY
          // permission (Driver Order Status Permission fix). Holding NOTHING
          // else must still unlock the Driver's own List/Detail/status-change
          // surface, and must grant NONE of the office/financial surface a
          // Driver must never reach. ------------------------------------------
          const cleanDriverUser = await makeDriverUser(
            narrowOperator.companyId,
            narrowOperator.subdomain,
            ["orders.driver_self_service"],
            "clean",
          );
          const cleanOrder1 = await createOrder({
            companyId: narrowOperator.companyId,
            createdByAccountId: narrowOperator.accountId,
            deliveryStatus: "assigned_to_driver",
            driverId: cleanDriverUser.driverId,
          });

          // Sees the List (scoped to their own Order) and Detail.
          const cleanList = await authed(cleanDriverUser.token)("/operations/orders").expect(200);
          const cleanListIds = (cleanList.body.items as readonly { id: string }[]).map(
            (item) => item.id,
          );
          expect(cleanListIds).toEqual([cleanOrder1]);
          await authed(cleanDriverUser.token)(`/operations/orders/${cleanOrder1}`).expect(200);
          // Never sees another Driver's Order, or the wider Company list.
          expect(cleanListIds).not.toContain(orderOutForDelivery);
          expect(cleanListIds).not.toContain(orderNew);

          // Assigned to Driver -> Out for Delivery -> Delivered, exactly the
          // narrow Driver transition set, with NO office permission granted.
          await patch(cleanDriverUser.token, `/operations/orders/${cleanOrder1}/status`, {
            status: "out_for_delivery",
          }).expect(200);
          const cleanDelivered = await patch(
            cleanDriverUser.token,
            `/operations/orders/${cleanOrder1}/status`,
            { status: "delivered" },
          ).expect(200);
          expect(cleanDelivered.body.deliveryStatus).toBe("delivered");

          // Never Order-create, Driver-assignment, or any financial/admin
          // surface -- `orders.driver_self_service` grants visibility only;
          // every write endpoint below still requires its own real permission.
          await post(cleanDriverUser.token, "/operations/orders", {}).expect(403);
          await post(cleanDriverUser.token, "/operations/orders/bulk-assign", {
            driverId: cleanDriverUser.driverId,
            orderIds: [cleanOrder1],
          }).expect(403);
          await authed(cleanDriverUser.token)("/operations/cash/reconciliations/preview").expect(
            403,
          );
          await authed(cleanDriverUser.token)("/operations/cash/expense-types").expect(403);
          await authed(cleanDriverUser.token)("/operations/cash/drivers").expect(403);

          // Silence unused-variable lint for fixtures only asserted via dashboard counts.
          expect([
            orderAssigned,
            orderOutForDelivery,
            orderDeliveredToday,
            orderReturnedToBranch,
            orderCancelled,
            orderCompanyB,
            admin.token,
            driverUserOrder1,
            driverUserOrder2,
            driverUser.accountId,
          ]).toHaveLength(10);

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
