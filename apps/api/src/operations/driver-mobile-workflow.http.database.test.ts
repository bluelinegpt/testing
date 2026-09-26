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

const runHttpTests = process.env.RUN_DRIVER_MOBILE_HTTP === "true";
const rollbackMarker = Symbol("rollback driver mobile workflow http test");

/**
 * HTTP-boundary tests for the Driver Mobile Correction: `GET
 * portal/driver/dashboard-summary`, `GET portal/driver/orders`, `GET
 * portal/driver/orders/:orderId/history`, and `PATCH
 * portal/driver/orders/:orderId/status`. Proves the three security
 * properties the correction requires: a Driver never sees another Driver's
 * counts/Orders, never sees Company-wide totals, and can never reach an
 * Operator-only action (dashboard/assign/reassign) regardless of what the
 * mobile client hides.
 *
 * Same one-real-app/one-rolled-back-transaction pattern as
 * `operator-mobile-workflow.http.database.test.ts`.
 */
describe.skipIf(!runHttpTests)("Driver mobile workflow HTTP boundary", () => {
  it("scopes the Driver dashboard/Orders/history to the authenticated Driver only, and rejects Operator-only actions", async () => {
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

          const makeCompany = async (label: string) => {
            const companyId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            const subdomain = `dmw-${label}-${suffix}`;
            await sql`
              insert into companies (id, code, subdomain, name_en, status, activated_at)
              values (${companyId}::uuid, ${`DMW-${suffix}`}, ${subdomain}, 'Driver Mobile Co',
                      'active', now())
            `.execute(transaction);
            return { companyId, subdomain, suffix };
          };

          const makeOperator = async (
            companyId: string,
            subdomain: string,
            label: string,
            permissions: readonly string[],
          ) => {
            const accountId = randomUUID();
            const roleId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            const password = `Rollback-dmw-${label}-password`;
            const hash = await hasher.hash(password);
            await sql`
              insert into accounts (
                id, company_id, account_kind, username, password_hash, status, password_changed_at
              ) values (${accountId}::uuid, ${companyId}::uuid, 'company_user',
                        ${`dmw.op.${label}.${suffix}`}, ${hash}, 'active', now())
            `.execute(transaction);
            await sql`
              insert into roles (id, company_id, code, name, is_system)
              values (${roleId}::uuid, ${companyId}::uuid, ${`dmw_op_${suffix}`}, ${`Role ${suffix}`}, true)
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
            const login = await request(server)
              .post("/api/v1/auth/login")
              .set("Host", `${subdomain}.blueline.test`)
              .send({ identifier: `dmw.op.${label}.${suffix}`, password })
              .expect(200);
            return { accountId, token: String(login.body.accessToken) };
          };

          /** A Driver who can actually log in and act as themself — needs a
           *  real password hash and an active `user_business_links` row,
           *  which `driverForAccount` requires to resolve `identity.profileId`. */
          const makeDriver = async (companyId: string, subdomain: string, label: string) => {
            const accountId = randomUUID();
            const driverId = randomUUID();
            const linkId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            const username = `dmw.driver.${label}.${suffix}`;
            const password = `Rollback-dmw-driver-${label}-password`;
            const hash = await hasher.hash(password);
            await sql`
              insert into accounts (
                id, company_id, account_kind, username, password_hash, status, password_changed_at
              ) values (${accountId}::uuid, ${companyId}::uuid, 'driver', ${username}, ${hash},
                        'active', now())
            `.execute(transaction);
            await sql`
              insert into drivers (
                id, company_id, account_id, code, driver_type, name_en, mobile_number,
                account_status, outsourced_fee_per_delivered_order
              ) values (
                ${driverId}::uuid, ${companyId}::uuid, ${accountId}::uuid, ${`DMWDR-${label}-${suffix}`},
                'outsourced', ${`Driver ${label}`}, '971500000011', 'active', 7.5
              )
            `.execute(transaction);
            await sql`
              insert into user_business_links (
                id, company_id, account_id, entity_type, entity_id, access_status, is_primary,
                created_by_account_id
              ) values (${linkId}::uuid, ${companyId}::uuid, ${accountId}::uuid, 'driver',
                        ${driverId}::uuid, 'active', true, ${accountId}::uuid)
            `.execute(transaction);
            const login = await request(server)
              .post("/api/v1/auth/login")
              .set("Host", `${subdomain}.blueline.test`)
              .send({ identifier: username, password })
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
                      (select id from emirates where code='DXB'), ${`DA-${suffix}`}, ${`Driver Area ${suffix}`})
            `.execute(transaction);
            await sql`
              insert into accounts (id, company_id, account_kind, username, password_hash)
              values (${traderAccountId}::uuid, ${options.companyId}::uuid, 'trader',
                      ${`dmw.trader.${suffix}`}, 'test-only')
            `.execute(transaction);
            await sql`
              insert into traders (id, company_id, account_id, code, name_en, mobile_number, account_status)
              values (${traderId}::uuid, ${options.companyId}::uuid, ${traderAccountId}::uuid,
                      ${`DT-${suffix}`}, ${`Driver Trader ${suffix}`}, '971500000012', 'active')
            `.execute(transaction);
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
                ${`DMW-ORD-${suffix}`}, current_date, ${traderId}::uuid, ${areaId}::uuid,
                ${options.createdByAccountId}::uuid, ${options.driverId ?? null},
                'Driver Customer', '971500000013', 'Driver Address', 1, 'customer_pays_cod_and_fee',
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
          const companyA = await makeCompany("a");
          const companyB = await makeCompany("b");
          const operatorA = await makeOperator(companyA.companyId, companyA.subdomain, "a", [
            "orders.assign_driver",
            "orders.update_delivery_status",
          ]);
          const operatorB = await makeOperator(companyB.companyId, companyB.subdomain, "b", []);
          const driverA1 = await makeDriver(companyA.companyId, companyA.subdomain, "a1");
          const driverA2 = await makeDriver(companyA.companyId, companyA.subdomain, "a2");
          const driverB1 = await makeDriver(companyB.companyId, companyB.subdomain, "b1");

          // Driver A1's own Orders across the statuses the dashboard counts.
          const a1Assigned = await createOrder({
            companyId: companyA.companyId,
            createdByAccountId: operatorA.accountId,
            deliveryStatus: "assigned_to_driver",
            driverId: driverA1.driverId,
          });
          const a1OutForDelivery = await createOrder({
            companyId: companyA.companyId,
            createdByAccountId: operatorA.accountId,
            deliveryStatus: "out_for_delivery",
            driverId: driverA1.driverId,
          });
          const a1DeliveredToday = await createOrder({
            companyId: companyA.companyId,
            createdByAccountId: operatorA.accountId,
            deliveryStatus: "delivered",
            driverId: driverA1.driverId,
            deliveredAt: "today",
          });
          const a1ReturnPending = await createOrder({
            companyId: companyA.companyId,
            createdByAccountId: operatorA.accountId,
            deliveryStatus: "returned_to_branch",
            driverId: driverA1.driverId,
          });
          // Driver A2's Order — must never affect Driver A1's counts/list,
          // despite being the same Company.
          const a2Assigned = await createOrder({
            companyId: companyA.companyId,
            createdByAccountId: operatorA.accountId,
            deliveryStatus: "assigned_to_driver",
            driverId: driverA2.driverId,
          });
          // An unassigned "new" Order — must never appear for either Driver.
          const unassignedNew = await createOrder({
            companyId: companyA.companyId,
            createdByAccountId: operatorA.accountId,
            deliveryStatus: "new",
          });
          // Company B's Driver Order — must never leak into Company A's view.
          const b1Assigned = await createOrder({
            companyId: companyB.companyId,
            createdByAccountId: operatorB.accountId,
            deliveryStatus: "assigned_to_driver",
            driverId: driverB1.driverId,
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

          // --- Guard wiring: identity kind, not just permission ----------------
          await request(server).get("/api/v1/portal/driver/dashboard-summary").expect(401);
          // An Operator (company_user) identity is refused the Driver portal
          // outright — `@RequireIdentityKinds("driver")` rejects it before any
          // permission check runs.
          await authed(operatorA.token)("/portal/driver/dashboard-summary").expect(403);
          await authed(operatorA.token)("/portal/driver/orders").expect(403);
          await patch(operatorA.token, `/portal/driver/orders/${a1Assigned}/status`, {
            status: "out_for_delivery",
          }).expect(403);
          // A Driver identity is refused the Operator-only assignment surface
          // outright — the reverse of the above, same mechanism.
          await post(driverA1.token, "/operations/orders/bulk-assign", {
            driverIdToAssign: driverA2.driverId,
            orderIds: [a1Assigned],
            selectionMode: "ids",
          }).expect(403);
          await authed(driverA1.token)("/operations/orders/dashboard-summary").expect(403);

          // --- Dashboard: Driver-scoped, never another Driver's, never Company-wide --
          const dashboardA1 = await authed(driverA1.token)(
            "/portal/driver/dashboard-summary",
          ).expect(200);
          expect(dashboardA1.body.assignedToMe).toBe(1);
          expect(dashboardA1.body.outForDelivery).toBe(1);
          expect(dashboardA1.body.deliveredToday).toBe(1);
          expect(dashboardA1.body.returnPending).toBe(1);
          expect(dashboardA1.body.activeTotal).toBe(2);
          // No Company-wide/"new" field is ever exposed on this response.
          expect(JSON.stringify(dashboardA1.body)).not.toContain('"new"');

          const dashboardA2 = await authed(driverA2.token)(
            "/portal/driver/dashboard-summary",
          ).expect(200);
          expect(dashboardA2.body.assignedToMe).toBe(1);
          expect(dashboardA2.body.outForDelivery).toBe(0);
          expect(dashboardA2.body.deliveredToday).toBe(0);
          expect(dashboardA2.body.returnPending).toBe(0);
          expect(dashboardA2.body.activeTotal).toBe(1);

          const dashboardB1 = await authed(driverB1.token)(
            "/portal/driver/dashboard-summary",
          ).expect(200);
          expect(dashboardB1.body.assignedToMe).toBe(1);
          expect(dashboardB1.body.activeTotal).toBe(1);

          // --- Orders list: only this Driver's own Orders, with the new fields --
          const ordersA1 = await authed(driverA1.token)("/portal/driver/orders").expect(200);
          const idsA1 = (ordersA1.body as { id: string }[]).map((row) => row.id).sort();
          expect(idsA1).toEqual(
            [a1Assigned, a1OutForDelivery, a1DeliveredToday, a1ReturnPending].sort(),
          );
          expect(idsA1).not.toContain(a2Assigned);
          expect(idsA1).not.toContain(unassignedNew);
          expect(idsA1).not.toContain(b1Assigned);
          const a1AssignedRow = (ordersA1.body as { id: string }[]).find(
            (row) => row.id === a1Assigned,
          ) as Record<string, unknown>;
          // The fixture inserts Orders directly (bypassing the sequence-backed
          // creation flow that assigns a real Serial Number), so only the
          // field's presence on the contract is asserted here — the field's
          // real-world population is exercised elsewhere. Emirate, by
          // contrast, is a plain join against a real seeded row and must
          // resolve to an actual value.
          expect("serialNumber" in a1AssignedRow).toBe(true);
          expect(typeof a1AssignedRow.emirateNameEn).toBe("string");
          expect((a1AssignedRow.emirateNameEn as string).length).toBeGreaterThan(0);

          // --- History: on-demand, ownership-scoped independently of the list --
          const historyBefore = await authed(driverA1.token)(
            `/portal/driver/orders/${a1Assigned}/history`,
          ).expect(200);
          expect(Array.isArray(historyBefore.body)).toBe(true);
          // Driver A2 cannot read Driver A1's Order history, even by guessed id.
          await authed(driverA2.token)(`/portal/driver/orders/${a1Assigned}/history`).expect(404);

          // A separate Out for Delivery Order, created here (not with the
          // earlier fixtures) so it plays no part in the dashboard-count or
          // Orders-list assertions above — used only for the Hold transition
          // below (Driver Physical Correction, Section F/I).
          const a1HoldCandidate = await createOrder({
            companyId: companyA.companyId,
            createdByAccountId: operatorA.accountId,
            deliveryStatus: "out_for_delivery",
            driverId: driverA1.driverId,
          });

          // --- Status transitions: exactly the Driver-safe path, nothing else --
          const invalidJump = await patch(
            driverA1.token,
            `/portal/driver/orders/${a1Assigned}/status`,
            {
              status: "delivered",
            },
          );
          expect(invalidJump.status).toBe(409);
          expect(invalidJump.body.error?.code).toBe("order_status_transition_invalid");

          const started = await patch(
            driverA1.token,
            `/portal/driver/orders/${a1Assigned}/status`,
            { status: "out_for_delivery" },
          ).expect(200);
          expect(started.body.deliveryStatus).toBe("out_for_delivery");

          // A return without a reason is rejected — the same rule Operations enforces.
          const returnWithoutReason = await patch(
            driverA1.token,
            `/portal/driver/orders/${a1OutForDelivery}/status`,
            { status: "returned_to_branch" },
          );
          expect(returnWithoutReason.status).toBe(400);
          expect(returnWithoutReason.body.error?.code).toBe("order_status_reason_required");

          const returned = await patch(
            driverA1.token,
            `/portal/driver/orders/${a1OutForDelivery}/status`,
            { status: "returned_to_branch", reason: "Customer unavailable" },
          ).expect(200);
          expect(returned.body.deliveryStatus).toBe("returned_to_branch");

          // --- Hold (Driver Physical Correction, Section A/F): the SAME
          // pre-existing "hold" status Operations already uses, now also
          // reachable by a Driver from Out for Delivery only — the same
          // reason requirement applies, and resuming OUT of Hold stays
          // Operations-only (a Driver has no valid transition from `hold`).
          const holdWithoutReason = await patch(
            driverA1.token,
            `/portal/driver/orders/${a1HoldCandidate}/status`,
            { status: "hold" },
          );
          expect(holdWithoutReason.status).toBe(400);
          expect(holdWithoutReason.body.error?.code).toBe("order_status_reason_required");

          const held = await patch(
            driverA1.token,
            `/portal/driver/orders/${a1HoldCandidate}/status`,
            { status: "hold", reason: "Customer requested a later delivery" },
          ).expect(200);
          expect(held.body.deliveryStatus).toBe("hold");

          // A Driver cannot resume an Order out of Hold — only Operations can.
          const driverResumeFromHold = await patch(
            driverA1.token,
            `/portal/driver/orders/${a1HoldCandidate}/status`,
            { status: "out_for_delivery" },
          );
          expect(driverResumeFromHold.status).toBe(409);
          expect(driverResumeFromHold.body.error?.code).toBe("order_status_transition_invalid");
          const operatorResumeFromHold = await patch(
            operatorA.token,
            `/operations/orders/${a1HoldCandidate}/status`,
            { status: "out_for_delivery" },
          ).expect(200);
          expect(operatorResumeFromHold.body.deliveryStatus).toBe("out_for_delivery");

          // A Driver still cannot reach the Operations-only transitions Hold
          // does NOT unlock for them — assignment, cancellation, or Returned
          // to Trader remain completely out of reach.
          const driverCancelDenied = await patch(
            driverA1.token,
            `/portal/driver/orders/${a1Assigned}/status`,
            { status: "cancelled", reason: "not permitted" },
          );
          expect(driverCancelDenied.status).toBe(409);
          expect(driverCancelDenied.body.error?.code).toBe("order_status_transition_invalid");

          // History now reflects the transition just made, and is still refused
          // to a Driver who does not own the Order.
          const historyAfter = await authed(driverA1.token)(
            `/portal/driver/orders/${a1Assigned}/history`,
          ).expect(200);
          expect((historyAfter.body as unknown[]).length).toBeGreaterThan(
            historyBefore.body.length,
          );

          // A Driver can never reach an Order that isn't theirs, even to fail a
          // transition on it — it reads as not-found, not a business-rule error.
          const otherDriversOrder = await patch(
            driverA1.token,
            `/portal/driver/orders/${a2Assigned}/status`,
            { status: "out_for_delivery" },
          );
          expect(otherDriversOrder.status).toBe(404);
          expect(otherDriversOrder.body.error?.code).toBe("driver_order_access_denied");

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
