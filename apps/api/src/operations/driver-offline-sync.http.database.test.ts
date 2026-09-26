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

const runHttpTests = process.env.RUN_DRIVER_OFFLINE_HTTP === "true";
const rollbackMarker = Symbol("rollback driver offline sync http test");

/**
 * HTTP-boundary tests for Prompt 16's backend additions to `PATCH
 * portal/driver/orders/:orderId/status`: idempotent replay via
 * `X-Idempotency-Key` (`idempotency_records`, operation
 * `driver.order_status_change`) and `expectedStatus` conflict detection.
 * Also re-confirms, in this same offline-sync-focused suite, the
 * pre-existing guarantees the offline queue depends on (ownership,
 * transition validity, reason enforcement) so this file stands alone as
 * Prompt 16's acceptance suite. Same one-real-app/one-rolled-back-transaction
 * pattern as `driver-mobile-workflow.http.database.test.ts`.
 */
describe.skipIf(!runHttpTests)("Driver offline sync HTTP boundary", () => {
  it("idempotent replay, expected-status conflict, ownership, and sequencing all hold for the Driver status endpoint", async () => {
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

          const makeCompany = async (label: string, status = "active") => {
            const companyId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            const subdomain = `dos-${label}-${suffix}`;
            await sql`
              insert into companies (id, code, subdomain, name_en, status, activated_at)
              values (${companyId}::uuid, ${`DOS-${suffix}`}, ${subdomain}, 'Driver Offline Sync Co',
                      ${status}, now())
            `.execute(transaction);
            return { companyId, subdomain, suffix };
          };

          const makeOperator = async (companyId: string, subdomain: string, label: string) => {
            const accountId = randomUUID();
            const roleId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            const password = `Rollback-dos-${label}-password`;
            const hash = await hasher.hash(password);
            await sql`
              insert into accounts (
                id, company_id, account_kind, username, password_hash, status, password_changed_at
              ) values (${accountId}::uuid, ${companyId}::uuid, 'company_user',
                        ${`dos.op.${label}.${suffix}`}, ${hash}, 'active', now())
            `.execute(transaction);
            await sql`
              insert into roles (id, company_id, code, name, is_system)
              values (${roleId}::uuid, ${companyId}::uuid, ${`dos_op_${suffix}`}, ${`Role ${suffix}`}, true)
            `.execute(transaction);
            await sql`
              insert into role_permissions (role_id, permission_code)
              values (${roleId}::uuid, 'orders.update_delivery_status'),
                     (${roleId}::uuid, 'orders.assign_driver')
            `.execute(transaction);
            await sql`
              insert into account_roles (account_id, role_id, company_id)
              values (${accountId}::uuid, ${roleId}::uuid, ${companyId}::uuid)
            `.execute(transaction);
            const login = await request(server)
              .post("/api/v1/auth/login")
              .set("Host", `${subdomain}.blueline.test`)
              .send({ identifier: `dos.op.${label}.${suffix}`, password })
              .expect(200);
            return { accountId, token: String(login.body.accessToken) };
          };

          const makeDriver = async (
            companyId: string,
            subdomain: string,
            label: string,
          ): Promise<{ accountId: string; driverId: string; token: string } | { blocked: true }> => {
            const accountId = randomUUID();
            const driverId = randomUUID();
            const linkId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            const username = `dos.driver.${label}.${suffix}`;
            const password = `Rollback-dos-driver-${label}-password`;
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
                ${driverId}::uuid, ${companyId}::uuid, ${accountId}::uuid, ${`DOSDR-${label}-${suffix}`},
                'outsourced', ${`Driver ${label}`}, '971500000031', 'active', 7.5
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
              .send({ identifier: username, password });
            if (login.status !== 200) return { blocked: true };
            return { accountId, driverId, token: String(login.body.accessToken) };
          };

          const createOrder = async (
            companyId: string,
            createdByAccountId: string,
            traderId: string,
            driverId: string,
            deliveryStatus: string,
          ) => {
            const orderId = randomUUID();
            const areaId = randomUUID();
            const suffix = orderId.slice(0, 8);
            await sql`
              insert into areas (id, company_id, emirate_id, code, name_en)
              values (${areaId}::uuid, ${companyId}::uuid,
                      (select id from emirates where code='DXB'), ${`DOSA-${suffix}`}, ${`DOS Area ${suffix}`})
            `.execute(transaction);
            await sql`
              insert into orders (
                service_fee_override_reason, id, company_id, order_number, order_date, trader_id, area_id,
                created_by_account_id, assigned_driver_id, customer_name, customer_mobile_number,
                customer_address, package_count, payment_condition, amount_collected, customer_amount_due,
                driver_cost, trader_gross_payable, trader_paid_service_fee, trader_deductions,
                trader_charges, trader_adjustments, trader_net_payable, delivery_status,
                driver_reconciliation_status, trader_settlement_status, pricing_provenance_status,
                final_service_fee_snapshot, customer_provenance_status
              ) values (
                'Zero configured Service Fee (fixture)', ${orderId}::uuid, ${companyId}::uuid,
                ${`DOS-ORD-${suffix}`}, current_date, ${traderId}::uuid, ${areaId}::uuid,
                ${createdByAccountId}::uuid, ${driverId}::uuid, 'DOS Customer', '971500000032',
                'DOS Address', 1, 'customer_pays_cod_and_fee', 0, 55, 7.5, 55, 0, 0, 0, 0, 55,
                'assigned_to_driver', 'not_applicable', 'not_eligible', 'legacy_unattributed', 0,
                'legacy_unattributed'
              )
            `.execute(transaction);
            // `order_assignments_current_driver_consistency` only allows a
            // fresh active assignment row against an Order that is, at that
            // exact moment, newly assigned/held — mirrors
            // `driver-mobile-workflow.http.database.test.ts`'s identical
            // two-step fixture pattern for the same reason. Any OTHER
            // requested starting status is applied as a plain follow-up
            // update, which does not touch `order_assignments` at all.
            await sql`
              insert into order_assignments (company_id, order_id, driver_id, assigned_by_account_id)
              values (${companyId}::uuid, ${orderId}::uuid, ${driverId}::uuid, ${createdByAccountId}::uuid)
            `.execute(transaction);
            if (deliveryStatus !== "assigned_to_driver") {
              await sql`
                update orders set delivery_status = ${deliveryStatus} where id = ${orderId}::uuid
              `.execute(transaction);
            }
            return orderId;
          };

          const makeTrader = async (companyId: string, createdByAccountId: string) => {
            const traderId = randomUUID();
            const traderAccountId = randomUUID();
            const suffix = traderId.slice(0, 8);
            await sql`
              insert into accounts (id, company_id, account_kind, username, password_hash)
              values (${traderAccountId}::uuid, ${companyId}::uuid, 'trader',
                      ${`dos.trader.${suffix}`}, 'test-only')
            `.execute(transaction);
            await sql`
              insert into traders (id, company_id, account_id, code, name_en, mobile_number, account_status)
              values (${traderId}::uuid, ${companyId}::uuid, ${traderAccountId}::uuid,
                      ${`DOST-${suffix}`}, ${`DOS Trader ${suffix}`}, '971500000033', 'active')
            `.execute(transaction);
            void createdByAccountId;
            return traderId;
          };

          const patch = (token: string, path: string, body: object, idempotencyKey?: string) => {
            const call = request(server)
              .patch(`/api/v1${path}`)
              .set("Authorization", `Bearer ${token}`);
            if (idempotencyKey !== undefined) call.set("X-Idempotency-Key", idempotencyKey);
            return call.send(body);
          };

          // --- Fixtures --------------------------------------------------
          const companyA = await makeCompany("a");
          const companyB = await makeCompany("b");
          const operatorA = await makeOperator(companyA.companyId, companyA.subdomain, "a");
          const operatorB = await makeOperator(companyB.companyId, companyB.subdomain, "b");
          const traderA = await makeTrader(companyA.companyId, operatorA.accountId);
          const driverA1 = await makeDriver(companyA.companyId, companyA.subdomain, "a1");
          const driverA2 = await makeDriver(companyA.companyId, companyA.subdomain, "a2");
          if ("blocked" in driverA1 || "blocked" in driverA2) {
            throw new Error("fixture driver login unexpectedly blocked");
          }

          const historyCount = async (orderId: string) =>
            Number(
              (
                await sql<{ count: string }>`
                  select count(*)::text as count from order_status_history
                   where order_id = ${orderId}::uuid
                `.execute(transaction)
              ).rows[0]?.count ?? "0",
            );

          // --- 1/2: idempotent replay — same key, same payload, retried  --
          const orderIdempotent = await createOrder(
            companyA.companyId,
            operatorA.accountId,
            traderA,
            driverA1.driverId,
            "assigned_to_driver",
          );
          const replayKey = `replay-key-${randomUUID()}`;
          const first = await patch(
            driverA1.token,
            `/portal/driver/orders/${orderIdempotent}/status`,
            { status: "out_for_delivery" },
            replayKey,
          ).expect(200);
          const second = await patch(
            driverA1.token,
            `/portal/driver/orders/${orderIdempotent}/status`,
            { status: "out_for_delivery" },
            replayKey,
          ).expect(200);
          expect(first.body.deliveryStatus).toBe("out_for_delivery");
          expect(second.body.deliveryStatus).toBe("out_for_delivery");
          expect(await historyCount(orderIdempotent)).toBe(1);

          // A different payload under the SAME key is rejected, not silently
          // applied — the key is bound to the exact original request.
          await patch(
            driverA1.token,
            `/portal/driver/orders/${orderIdempotent}/status`,
            { status: "returned_to_branch", reason: "different action" },
            replayKey,
          ).expect(409);

          // --- 3/5: expectedStatus conflict — cancelled server-side, then a
          // queued (stale) offline transition is rejected, not applied ------
          const orderConflict = await createOrder(
            companyA.companyId,
            operatorA.accountId,
            traderA,
            driverA1.driverId,
            "out_for_delivery",
          );
          await patch(operatorA.token, `/operations/orders/${orderConflict}/status`, {
            status: "cancelled",
            reason: "Customer cancelled",
          }).expect(200);
          const conflictAttempt = await patch(
            driverA1.token,
            `/portal/driver/orders/${orderConflict}/status`,
            { status: "delivered", expectedStatus: "out_for_delivery" },
            `conflict-key-${randomUUID()}`,
          );
          expect(conflictAttempt.status).toBe(409);
          expect(conflictAttempt.body.error?.code).toBe("order_status_conflict");
          const stillCancelled = await sql<{ status: string }>`
            select delivery_status as status from orders where id = ${orderConflict}::uuid
          `.execute(transaction);
          expect(stillCancelled.rows[0]?.status).toBe("cancelled");

          // --- 6: already-applied same transition resolves safely, no new
          // history row ------------------------------------------------------
          const orderAlready = await createOrder(
            companyA.companyId,
            operatorA.accountId,
            traderA,
            driverA1.driverId,
            "out_for_delivery",
          );
          const alreadyApplied = await patch(
            driverA1.token,
            `/portal/driver/orders/${orderAlready}/status`,
            { status: "out_for_delivery", expectedStatus: "assigned_to_driver" },
          ).expect(200);
          expect(alreadyApplied.body.deliveryStatus).toBe("out_for_delivery");
          expect(await historyCount(orderAlready)).toBe(0);

          // --- 4/8: reassignment rejects the old Driver (ownership re-check,
          // not merely a UI hint) ---------------------------------------------
          const orderReassign = await createOrder(
            companyA.companyId,
            operatorA.accountId,
            traderA,
            driverA1.driverId,
            "assigned_to_driver",
          );
          // NOTE: bulk-assign is a POST route — using the PATCH `patch()`
          // helper here would silently be swallowed by the unrelated
          // `PATCH orders/:orderId` route (matching "bulk-assign" as an
          // orderId) and fail with a misleading `permission_denied`.
          await request(server)
            .post("/api/v1/operations/orders/bulk-assign")
            .set("Authorization", `Bearer ${operatorA.token}`)
            .send({
              driverIdToAssign: driverA2.driverId,
              orderIds: [orderReassign],
              selectionMode: "ids",
            })
            .expect(201);
          const rejectedOldDriver = await patch(
            driverA1.token,
            `/portal/driver/orders/${orderReassign}/status`,
            { status: "out_for_delivery" },
          );
          expect(rejectedOldDriver.status).toBe(404);
          expect(rejectedOldDriver.body.error?.code).toBe("driver_order_access_denied");

          // --- 9: a suspended Company's Driver cannot even authenticate,
          // so no mutation can ever be attempted — sync fails closed at the
          // session layer, before this endpoint is ever reached -------------
          const companySuspended = await makeCompany("suspended", "suspended");
          const suspendedDriver = await makeDriver(
            companySuspended.companyId,
            companySuspended.subdomain,
            "susp",
          );
          expect("blocked" in suspendedDriver).toBe(true);

          // --- 10: ordered sequential transitions succeed in the correct
          // order -----------------------------------------------------------
          const orderSequence = await createOrder(
            companyA.companyId,
            operatorA.accountId,
            traderA,
            driverA1.driverId,
            "assigned_to_driver",
          );
          await patch(
            driverA1.token,
            `/portal/driver/orders/${orderSequence}/status`,
            { status: "out_for_delivery" },
            `seq-key-1-${randomUUID()}`,
          ).expect(200);
          await patch(
            driverA1.token,
            `/portal/driver/orders/${orderSequence}/status`,
            { status: "delivered" },
            `seq-key-2-${randomUUID()}`,
          ).expect(200);
          expect(await historyCount(orderSequence)).toBe(2);

          // --- 11: an out-of-order (invalid) transition is rejected, exactly
          // as it must be for the queue's own ordering guarantee to matter --
          const orderInvalid = await createOrder(
            companyA.companyId,
            operatorA.accountId,
            traderA,
            driverA1.driverId,
            "assigned_to_driver",
          );
          const invalidJump = await patch(
            driverA1.token,
            `/portal/driver/orders/${orderInvalid}/status`,
            { status: "delivered" },
          );
          expect(invalidJump.status).toBe(409);
          expect(invalidJump.body.error?.code).toBe("order_status_transition_invalid");

          // --- 12: required reason is still enforced for offline-originated
          // requests exactly as for online ones ------------------------------
          const orderReason = await createOrder(
            companyA.companyId,
            operatorA.accountId,
            traderA,
            driverA1.driverId,
            "out_for_delivery",
          );
          const missingReason = await patch(
            driverA1.token,
            `/portal/driver/orders/${orderReason}/status`,
            { status: "returned_to_branch" },
          );
          expect(missingReason.status).toBe(400);
          expect(missingReason.body.error?.code).toBe("order_status_reason_required");
          await patch(
            driverA1.token,
            `/portal/driver/orders/${orderReason}/status`,
            { status: "returned_to_branch", reason: "Customer unavailable" },
          ).expect(200);

          // --- 7: cross-company — Company B's Operator can never reach
          // Company A's Order at all (tenant-scoped WHERE clause), and the
          // Driver route is a completely different identity-kind door in the
          // first place. -------------------------------------------------
          const crossCompanyAttempt = await patch(
            operatorB.token,
            `/operations/orders/${orderReason}/status`,
            { status: "closed" },
          );
          expect(crossCompanyAttempt.status).toBe(404);

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
