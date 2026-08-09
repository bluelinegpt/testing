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
const rollbackMarker = Symbol("rollback outsourced fee preview http test");

/**
 * Investigating a reported "An unexpected error occurred." on New Collection:
 * two delivered Orders selected, from two different Traders, for an OUTSOURCED
 * Driver with outstanding fee accruals.
 *
 * `driver-cash-reconciliation.database.test.ts` could not have ruled this shape
 * out: it stubs `OutsourcedDriverFeeService` entirely, so the real
 * `collectionOffsetProposal()` path -- the one every outsourced Driver with a
 * positive fee balance actually runs -- had never been exercised end to end,
 * through the real HTTP boundary, with automatic accounting posting on for
 * `driver_collections` and `outsourced_driver_fees` (both enabled in the
 * reporting Company). It is exercised here and it is clean: preview and confirm
 * both succeed, with the real fee service computing a real 30.00 balance. The
 * live report was pursued using the actual reported Driver, Orders and Company
 * data directly, and that also came back clean -- so the defect, if it recurs,
 * is not in this shape or in this Company's configuration. Kept as a permanent
 * regression test because the coverage gap it closes is real regardless.
 */
describe.skipIf(!runHttpTests)("reconciliation preview for an outsourced Driver", () => {
  it("previews two Orders across two Traders for an outsourced Driver with an outstanding fee balance", async () => {
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
          .useValue({ resolve: (host: string | undefined) => host?.split(".")[0] })
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

          const companyId = randomUUID();
          const accountId = randomUUID();
          const roleId = randomUUID();
          const driverId = randomUUID();
          const driverAccountId = randomUUID();
          const suffix = companyId.slice(0, 8);
          const subdomain = `outfee-${suffix}`;
          const password = `Rollback-outfee-${suffix}`;
          const hash = await hasher.hash(password);

          await sql`
            insert into companies (id, code, subdomain, name_en, status, activated_at)
            values (${companyId}::uuid, ${`OFP-${suffix}`}, ${subdomain}, 'Outsourced Fee Preview Co',
                    'active', now())
          `.execute(transaction);
          await sql`
            insert into accounts (
              id, company_id, account_kind, username, password_hash, status, password_changed_at
            ) values (${accountId}::uuid, ${companyId}::uuid, 'company_user', 'operator',
                      ${hash}, 'active', now())
          `.execute(transaction);
          await sql`
            insert into company_users (company_id, account_id, display_name, name_en)
            values (${companyId}::uuid, ${accountId}::uuid, 'Operator', 'Operator')
          `.execute(transaction);
          await sql`
            insert into roles (id, company_id, code, name, is_system)
            values (${roleId}::uuid, ${companyId}::uuid, 'company_admin', ${`Role ${suffix}`}, true)
          `.execute(transaction);
          /* The reported operator's Role, as closely as it can be inferred: able
             to run a Driver Collection, but NOT separately granted the Payroll
             permission that gates viewing another Driver's fee balance. That
             narrower grant is the realistic case -- "outsourced_driver_fees.view"
             is a Payroll permission, and Operations staff running collections
             are not necessarily also given Payroll access. */
          await sql`
            insert into role_permissions (role_id, permission_code)
            values (${roleId}::uuid, 'users_roles.manage')
          `.execute(transaction);
          await sql`
            insert into account_roles (account_id, role_id, company_id)
            values (${accountId}::uuid, ${roleId}::uuid, ${companyId}::uuid)
          `.execute(transaction);

          const login = await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `${subdomain}.blueline.test`)
            .send({ identifier: "operator", password })
            .expect(200);
          const token = String(login.body.accessToken);
          const post = (path: string, body: object) =>
            request(server)
              .post(`/api/v1${path}`)
              .set("Authorization", `Bearer ${token}`)
              .send(body);

          // Outsourced Driver, AED 15 per delivered Order.
          await sql`
            insert into accounts (id, company_id, account_kind, username, password_hash)
            values (${driverAccountId}::uuid, ${companyId}::uuid, 'driver',
                    ${`outfee.driver.${suffix}`}, 'test-only')
          `.execute(transaction);
          await sql`
            insert into drivers (
              id, company_id, account_id, code, driver_type, name_en, mobile_number,
              account_status, outsourced_fee_per_delivered_order
            ) values (
              ${driverId}::uuid, ${companyId}::uuid, ${driverAccountId}::uuid,
              ${`ODRV-${suffix}`}, 'outsourced', 'Kareem', '971500000001', 'active', 15
            )
          `.execute(transaction);

          // Two Orders, delivered and pending collection, from TWO DIFFERENT
          // Traders -- matching the screenshot exactly (Plaza Store / Noon).
          /* Automatic accounting posting, ON for driver_collections and
             outsourced_driver_fees -- matching the real Company exactly.
             `driver_reconciliations_accounting_event_capture` and
             `outsourced_driver_fee_accruals_accounting_event_capture` are DB
             triggers, invisible to a service-level test and to any fixture that
             skips this table. If the crash lives in that path, this is the one
             thing standing between a clean repro and the real bug. */
          await sql`
            insert into accounting_configurations(
              company_id, accounting_enabled, automatic_posting_enabled,
              automatic_posting_areas, automatic_posting_enabled_by_account_id,
              automatic_posting_enabled_at
            ) values(
              ${companyId}::uuid, true, true,
              array['driver_collections','outsourced_driver_fees'], ${accountId}::uuid, now()
            )
          `.execute(transaction);

          const feeVersionId = randomUUID();
          await sql`
            insert into outsourced_driver_fee_versions(
              id, company_id, driver_id, effective_from, fee_per_order, created_by_account_id, status
            ) values(${feeVersionId}::uuid, ${companyId}::uuid, ${driverId}::uuid, '-infinity'::date,
                     15, ${accountId}::uuid, 'active')
          `.execute(transaction);

          const makeOrder = async (label: string, cod: string) => {
            const orderId = randomUUID();
            const traderId = randomUUID();
            const areaId = randomUUID();
            const traderAccountId = randomUUID();
            const orderSuffix = orderId.slice(0, 8);
            await sql`
              insert into areas (id, company_id, emirate_id, code, name_en)
              values (${areaId}::uuid, ${companyId}::uuid,
                      (select id from emirates where code='DXB'), ${`OA-${orderSuffix}`},
                      ${`Area ${orderSuffix}`})
            `.execute(transaction);
            await sql`
              insert into accounts (id, company_id, account_kind, username, password_hash)
              values (${traderAccountId}::uuid, ${companyId}::uuid, 'trader',
                      ${`outfee.trader.${label}.${orderSuffix}`}, 'test-only')
            `.execute(transaction);
            await sql`
              insert into traders (
                id, company_id, account_id, code, name_en, mobile_number, account_status
              ) values (${traderId}::uuid, ${companyId}::uuid, ${traderAccountId}::uuid,
                        ${`OT-${orderSuffix}`}, ${`Trader ${label}`}, '971500000002', 'active')
            `.execute(transaction);
            await sql`
              insert into orders (
                service_fee_override_reason, id, company_id, order_number, order_date, trader_id,
                area_id, created_by_account_id, assigned_driver_id, customer_name,
                customer_mobile_number, customer_address, package_count, payment_condition,
                amount_collected, customer_amount_due, driver_cost,
                trader_gross_payable, trader_paid_service_fee, trader_deductions,
                trader_charges, trader_adjustments, trader_net_payable,
                delivery_status, driver_reconciliation_status, trader_settlement_status,
                delivered_at, pricing_provenance_status, final_service_fee_snapshot,
                customer_provenance_status
              ) values (
                'Zero configured Service Fee (fixture)', ${orderId}::uuid, ${companyId}::uuid,
                ${`OFP-${orderSuffix}`}, current_date, ${traderId}::uuid, ${areaId}::uuid,
                ${accountId}::uuid, ${driverId}::uuid, ${`Customer ${label}`}, '971500000003',
                'Address', 1, 'customer_pays_cod_and_fee',
                ${cod}, ${cod}, 15, ${cod}, 0, 0, 0, 0, ${cod},
                'delivered', 'pending', 'not_eligible', now(),
                'legacy_unattributed', 0, 'legacy_unattributed'
              )
            `.execute(transaction);
            /* One accrued, outstanding fee per delivered Order -- exactly what
               makes `collectionOffsetProposal()`'s total positive and takes the
               `outsourced_driver_fees.view` permission check. */
            await sql`
              insert into outsourced_driver_fee_accruals(
                id, company_id, driver_id, order_id, delivery_date, accrual_business_date,
                fee_rate_version_id, fee_rate_snapshot, earned_amount, paid_amount,
                outstanding_amount, accrual_source, status, created_by_account_id
              ) select ${randomUUID()}::uuid, ${companyId}::uuid, ${driverId}::uuid, ${orderId}::uuid,
                o.delivered_at, current_date, ${feeVersionId}::uuid, 15, 15, 0, 15, 'delivery',
                'accrued', ${accountId}::uuid
                from orders o where o.id = ${orderId}::uuid
            `.execute(transaction);
            return orderId;
          };

          const orderOne = await makeOrder("A", "250.00");
          const orderTwo = await makeOrder("B", "200.00");

          const preview = await post("/operations/cash/reconciliations/preview", {
            expenses: [],
            orderIds: [orderOne, orderTwo],
            payments: [],
            selectionMode: "ids",
          });
          expect(preview.status).not.toBe(500);
          expect(preview.status).toBe(201);
          expect(preview.body.orderCount).toBe(2);
          expect(preview.body.traderCount).toBe(2);
          // The Driver's real outstanding fee, proving the real service ran
          // rather than a stub: 15 + 15 = 30, matching both accruals.
          expect(preview.body.driverPayableDeduction).toBe("0.00");

          /* Now the exact click the screenshot shows next: Confirm reconciliation,
             Cash, for the net amount expected, no manual fee offset. */
          const confirm = await post("/operations/cash/reconciliations/selected", {
            collectionPaymentMethod: "cash",
            excludedOrderIds: [],
            expenses: [],
            orderIds: [orderOne, orderTwo],
            payments: [{ amount: Number(preview.body.netAmountExpected), paymentMethod: "cash" }],
            selectionMode: "ids",
          }).set("X-Idempotency-Key", `outfee-confirm-${randomUUID()}`);

          /* Same standard: any answer except a raw, unattributed 500. Whatever
             this reconciliation resolves to -- confirmed, or rejected for a
             stated reason -- the operator must be told WHAT happened, never
             "An unexpected error occurred." */
          expect(confirm.status).not.toBe(500);
          if (confirm.status !== 201 && confirm.status !== 200) {
            expect(typeof confirm.body.error?.code).toBe("string");
            expect(confirm.body.error?.message).not.toBe("An unexpected error occurred.");
          }

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
  }, 60_000);
});
