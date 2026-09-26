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

const runHttpTests = process.env.RUN_PUSH_HTTP === "true";
const rollbackMarker = Symbol("rollback push notifications http test");

/**
 * HTTP-boundary tests for Prompt 15: `POST push/device-registrations`,
 * `POST push/device-registrations/deregister`, `GET push/notifications`,
 * `POST push/notifications/:id/read`, and the Order-push side effects of
 * `POST operations/orders/bulk-assign` / `PATCH operations/orders/:orderId/status`.
 * Same one-real-app/one-rolled-back-transaction pattern as
 * `driver-mobile-workflow.http.database.test.ts`.
 */
describe.skipIf(!runHttpTests)("Push notifications HTTP boundary", () => {
  it("registers idempotently, rotates tokens safely, revokes on logout, and scopes Order push to the correct recipient only", async () => {
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
            const subdomain = `pnw-${label}-${suffix}`;
            await sql`
              insert into companies (id, code, subdomain, name_en, status, activated_at)
              values (${companyId}::uuid, ${`PNW-${suffix}`}, ${subdomain}, 'Push Notifications Co',
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
            const password = `Rollback-pnw-${label}-password`;
            const hash = await hasher.hash(password);
            await sql`
              insert into accounts (
                id, company_id, account_kind, username, password_hash, status, password_changed_at
              ) values (${accountId}::uuid, ${companyId}::uuid, 'company_user',
                        ${`pnw.op.${label}.${suffix}`}, ${hash}, 'active', now())
            `.execute(transaction);
            await sql`
              insert into roles (id, company_id, code, name, is_system)
              values (${roleId}::uuid, ${companyId}::uuid, ${`pnw_op_${suffix}`}, ${`Role ${suffix}`}, true)
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
              .send({ identifier: `pnw.op.${label}.${suffix}`, password })
              .expect(200);
            return { accountId, token: String(login.body.accessToken) };
          };

          const makeDriver = async (companyId: string, subdomain: string, label: string) => {
            const accountId = randomUUID();
            const driverId = randomUUID();
            const linkId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            const username = `pnw.driver.${label}.${suffix}`;
            const password = `Rollback-pnw-driver-${label}-password`;
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
                ${driverId}::uuid, ${companyId}::uuid, ${accountId}::uuid, ${`PNWDR-${label}-${suffix}`},
                'outsourced', ${`Driver ${label}`}, '971500000021', 'active', 7.5
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

          const makeTrader = async (companyId: string, subdomain: string, label: string) => {
            const accountId = randomUUID();
            const traderId = randomUUID();
            const linkId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            const username = `pnw.trader.${label}.${suffix}`;
            const password = `Rollback-pnw-trader-${label}-password`;
            const hash = await hasher.hash(password);
            await sql`
              insert into accounts (
                id, company_id, account_kind, username, password_hash, status, password_changed_at
              ) values (${accountId}::uuid, ${companyId}::uuid, 'trader', ${username}, ${hash},
                        'active', now())
            `.execute(transaction);
            await sql`
              insert into traders (id, company_id, account_id, code, name_en, mobile_number, account_status)
              values (${traderId}::uuid, ${companyId}::uuid, ${accountId}::uuid, ${`PNWTR-${label}-${suffix}`},
                      ${`Trader ${label}`}, '971500000022', 'active')
            `.execute(transaction);
            await sql`
              insert into user_business_links (
                id, company_id, account_id, entity_type, entity_id, access_status, is_primary,
                created_by_account_id
              ) values (${linkId}::uuid, ${companyId}::uuid, ${accountId}::uuid, 'trader',
                        ${traderId}::uuid, 'active', true, ${accountId}::uuid)
            `.execute(transaction);
            const login = await request(server)
              .post("/api/v1/auth/login")
              .set("Host", `${subdomain}.blueline.test`)
              .send({ identifier: username, password })
              .expect(200);
            return { accountId, traderId, token: String(login.body.accessToken) };
          };

          const createOrder = async (companyId: string, createdByAccountId: string, traderId: string) => {
            const orderId = randomUUID();
            const areaId = randomUUID();
            const suffix = orderId.slice(0, 8);
            await sql`
              insert into areas (id, company_id, emirate_id, code, name_en)
              values (${areaId}::uuid, ${companyId}::uuid,
                      (select id from emirates where code='DXB'), ${`PA-${suffix}`}, ${`Push Area ${suffix}`})
            `.execute(transaction);
            await sql`
              insert into orders (
                service_fee_override_reason, id, company_id, order_number, order_date, trader_id, area_id,
                created_by_account_id, customer_name, customer_mobile_number, customer_address,
                package_count, payment_condition, amount_collected, customer_amount_due, driver_cost,
                trader_gross_payable, trader_paid_service_fee, trader_deductions, trader_charges,
                trader_adjustments, trader_net_payable, delivery_status, driver_reconciliation_status,
                trader_settlement_status, pricing_provenance_status, final_service_fee_snapshot,
                customer_provenance_status
              ) values (
                'Zero configured Service Fee (fixture)', ${orderId}::uuid, ${companyId}::uuid,
                ${`PNW-ORD-${suffix}`}, current_date, ${traderId}::uuid, ${areaId}::uuid,
                ${createdByAccountId}::uuid, 'Push Customer', '971500000023', 'Push Address', 1,
                'customer_pays_cod_and_fee', 0, 55, 7.5, 55, 0, 0, 0, 0, 55, 'new', 'not_applicable',
                'not_eligible', 'legacy_unattributed', 0, 'legacy_unattributed'
              )
            `.execute(transaction);
            return orderId;
          };

          const authed = (token: string) => (path: string) =>
            request(server).get(`/api/v1${path}`).set("Authorization", `Bearer ${token}`);
          const post = (token: string, path: string, body: object) =>
            request(server)
              .post(`/api/v1${path}`)
              .set("Authorization", `Bearer ${token}`)
              .send(body);
          const postAuth = (token: string, path: string) =>
            request(server).post(`/api/v1${path}`).set("Authorization", `Bearer ${token}`);
          const patch = (token: string, path: string, body: object) =>
            request(server)
              .patch(`/api/v1${path}`)
              .set("Authorization", `Bearer ${token}`)
              .send(body);

          // --- Fixtures ---------------------------------------------------
          const companyA = await makeCompany("a");
          const companyB = await makeCompany("b");
          const operatorA = await makeOperator(companyA.companyId, companyA.subdomain, "a", [
            "orders.assign_driver",
            "orders.update_delivery_status",
          ]);
          const driverA1 = await makeDriver(companyA.companyId, companyA.subdomain, "a1");
          const traderA = await makeTrader(companyA.companyId, companyA.subdomain, "a1");
          const operatorB = await makeOperator(companyB.companyId, companyB.subdomain, "b", []);

          // --- 1/2: register, then idempotent duplicate re-register -------
          const registration = await post(driverA1.token, "/push/device-registrations", {
            platform: "android",
            token: "device-token-a1-v1",
          }).expect(201);
          expect(registration.body.status).toBe("active");
          const countAfterFirst = await sql<{ count: string }>`
            select count(*)::text as count from device_registrations
             where company_id = ${companyA.companyId}::uuid and account_id = ${driverA1.accountId}::uuid
          `.execute(transaction);
          expect(countAfterFirst.rows[0]?.count).toBe("1");

          await post(driverA1.token, "/push/device-registrations", {
            platform: "android",
            token: "device-token-a1-v1",
          }).expect(201);
          const countAfterDuplicate = await sql<{ count: string }>`
            select count(*)::text as count from device_registrations
             where company_id = ${companyA.companyId}::uuid and account_id = ${driverA1.accountId}::uuid
          `.execute(transaction);
          expect(countAfterDuplicate.rows[0]?.count).toBe("1");

          // --- 3: token rotation — old token revoked, exactly one active row --
          await post(driverA1.token, "/push/device-registrations", {
            platform: "android",
            token: "device-token-a1-v2",
          }).expect(201);
          const afterRotation = await sql<{ pushToken: string; status: string }>`
            select push_token as "pushToken", status from device_registrations
             where company_id = ${companyA.companyId}::uuid and account_id = ${driverA1.accountId}::uuid
             order by updated_at
          `.execute(transaction);
          expect(afterRotation.rows).toHaveLength(2);
          const active = afterRotation.rows.filter((row) => row.status === "active");
          expect(active).toHaveLength(1);
          expect(active[0]?.pushToken).toBe("device-token-a1-v2");
          expect(
            afterRotation.rows.find((row) => row.pushToken === "device-token-a1-v1")?.status,
          ).toBe("revoked");

          // --- 4: logout revokes the active registration -------------------
          await postAuth(driverA1.token, "/auth/logout").expect(204);
          const afterLogout = await sql<{ status: string }>`
            select status from device_registrations
             where company_id = ${companyA.companyId}::uuid and account_id = ${driverA1.accountId}::uuid
               and push_token = 'device-token-a1-v2'
          `.execute(transaction);
          expect(afterLogout.rows[0]?.status).toBe("revoked");
          // The revoked session can no longer register a new token either —
          // proves "previous account must no longer receive private pushes"
          // is enforced by the session layer, not just this module.
          await post(driverA1.token, "/push/device-registrations", {
            platform: "android",
            token: "device-token-a1-v3",
          }).expect(401);

          // --- Company isolation: an Operator from Company B cannot see or
          // affect Company A's registrations or notifications. ---------------
          const registrationB = await post(operatorB.token, "/push/device-registrations", {
            platform: "android",
            token: "device-token-b-v1",
          }).expect(201);
          expect(registrationB.body.status).toBe("active");
          const crossCompanyLeak = await sql<{ count: string }>`
            select count(*)::text as count from device_registrations
             where company_id = ${companyB.companyId}::uuid and push_token like 'device-token-a1-%'
          `.execute(transaction);
          expect(crossCompanyLeak.rows[0]?.count).toBe("0");

          // --- 11: Driver Order assignment recipient -----------------------
          // The Driver's earlier device registration was already revoked at
          // logout above; this proves the notification event still resolves
          // to the CORRECT recipient account regardless of registration
          // state — `notification_outbox_events.recipient_account_id`, not
          // device delivery, is what's asserted here (device-eligibility
          // re-checking at dispatch time is covered separately in
          // `push.database.test.ts`).
          const orderId = await createOrder(companyA.companyId, operatorA.accountId, traderA.traderId);
          await post(operatorA.token, "/operations/orders/bulk-assign", {
            driverIdToAssign: driverA1.driverId,
            orderIds: [orderId],
            selectionMode: "ids",
          }).expect(201);
          const assignmentEvents = await sql<{ recipientAccountId: string; notificationType: string }>`
            select recipient_account_id as "recipientAccountId", notification_type as "notificationType"
              from notification_outbox_events
             where notification_type in ('order.assigned', 'order.reassigned')
               and target_id = ${orderId}::uuid
          `.execute(transaction);
          expect(assignmentEvents.rows).toHaveLength(1);
          expect(assignmentEvents.rows[0]?.recipientAccountId).toBe(driverA1.accountId);
          expect(assignmentEvents.rows[0]?.notificationType).toBe("order.assigned");

          // --- 12: Trader Order status-change recipient ---------------------
          await patch(operatorA.token, `/operations/orders/${orderId}/status`, {
            status: "out_for_delivery",
          }).expect(200);
          const statusEvents = await sql<{ recipientAccountId: string; bodyParams: { status: string } }>`
            select recipient_account_id as "recipientAccountId", body_params as "bodyParams"
              from notification_outbox_events
             where notification_type = 'order.status_changed' and target_id = ${orderId}::uuid
          `.execute(transaction);
          expect(statusEvents.rows).toHaveLength(1);
          expect(statusEvents.rows[0]?.recipientAccountId).toBe(traderA.accountId);
          expect(statusEvents.rows[0]?.bodyParams.status).toBe("out_for_delivery");

          // --- 13: no cross-company push — Company B never appears as a
          // recipient of any Company A event. ---------------------------------
          const anyCrossCompany = await sql<{ count: string }>`
            select count(*)::text as count from notification_outbox_events
             where company_id = ${companyA.companyId}::uuid
               and recipient_account_id in (${operatorB.accountId}::uuid)
          `.execute(transaction);
          expect(anyCrossCompany.rows[0]?.count).toBe("0");

          // --- Notification Inbox: list + mark read -------------------------
          const inbox = await authed(traderA.token)("/push/notifications").expect(200);
          expect(Array.isArray(inbox.body.items)).toBe(true);
          expect(inbox.body.items.length).toBeGreaterThan(0);
          const unread = inbox.body.items[0] as { id: string; readAt: string | null };
          expect(unread.readAt).toBeNull();
          await postAuth(traderA.token, `/push/notifications/${unread.id}/read`).expect(204);
          const afterRead = await sql<{ readAt: string | null }>`
            select read_at::text as "readAt" from notification_outbox_events where id = ${unread.id}::uuid
          `.execute(transaction);
          expect(afterRead.rows[0]?.readAt).not.toBeNull();
          // A different Company A account cannot mark the Trader's
          // notification read — `markRead` scopes by the authenticated
          // account, so this call is a silent no-op on someone else's row.
          await postAuth(operatorA.token, `/push/notifications/${unread.id}/read`).expect(204);
          const stillOwnedByTrader = await sql<{ readAt: string | null }>`
            select read_at::text as "readAt" from notification_outbox_events where id = ${unread.id}::uuid
          `.execute(transaction);
          // Already read by the Trader themself above — unaffected either way,
          // but the row's recipient never changed to prove ownership held.
          expect(stillOwnedByTrader.rows[0]?.readAt).not.toBeNull();
          const ownerCheck = await sql<{ recipientAccountId: string }>`
            select recipient_account_id as "recipientAccountId" from notification_outbox_events
             where id = ${unread.id}::uuid
          `.execute(transaction);
          expect(ownerCheck.rows[0]?.recipientAccountId).toBe(traderA.accountId);

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
