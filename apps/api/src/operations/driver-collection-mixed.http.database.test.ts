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
const rollbackMarker = Symbol("rollback mixed driver collection http test");

/**
 * Driver Collections step 2 (11 Oct 2026, spec
 * `claude/driver-collection-mixed-payment-spec.md`): one collection with
 * Cash, Visa and nothing-to-collect Orders, and a Company-pays-Driver
 * collection -- end to end through HTTP, the real services, the
 * `20261011020000` schema and the confirmation trigger. Everything runs in one
 * transaction that is always rolled back.
 */
describe.skipIf(!runHttpTests)("mixed Cash/Visa Driver collection", () => {
  it("splits Cash, Visa and zero Orders, caps the fee offset at cash, and records a Company payout", async () => {
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
          const subdomain = `mixed-${suffix}`;
          const password = `Rollback-mixed-${suffix}`;
          const hash = await hasher.hash(password);

          await sql`
            insert into companies (id, code, subdomain, name_en, status, activated_at)
            values (${companyId}::uuid, ${`MIX-${suffix}`}, ${subdomain}, 'Mixed Collection Co',
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
          await sql`
            insert into role_permissions (role_id, permission_code)
            values (${roleId}::uuid, 'users_roles.manage')
          `.execute(transaction);
          await sql`
            insert into account_roles (account_id, role_id, company_id)
            values (${accountId}::uuid, ${roleId}::uuid, ${companyId}::uuid)
          `.execute(transaction);

          // Accounting OFF: a main Cash account needs no GL account, and the
          // collection writes Cash/Bank Movements without an Accounting Event.
          const cashAccountId = randomUUID();
          const bankAccountId = randomUUID();
          await sql`
            insert into company_cash_accounts (
              id, company_id, cash_account_code, cash_account_name, cash_account_type,
              effective_from, created_by_account_id
            ) values (${cashAccountId}::uuid, ${companyId}::uuid, 'CASH-0001', 'Main Cash',
                      'main_cash', current_date, ${accountId}::uuid)
          `.execute(transaction);
          await sql`
            insert into company_bank_accounts (id, company_id, bank_name, account_name, bank_account_code)
            values (${bankAccountId}::uuid, ${companyId}::uuid, 'Test Bank', 'Main', 'BANK-0001')
          `.execute(transaction);
          const expenseTypeId = randomUUID();
          await sql`
            insert into expense_types (id, company_id, code, name_en, display_name)
            values (${expenseTypeId}::uuid, ${companyId}::uuid, 'FUELX', 'Fuel', 'Fuel')
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
                    ${`mixed.driver.${suffix}`}, 'test-only')
          `.execute(transaction);
          await sql`
            insert into drivers (
              id, company_id, account_id, code, driver_type, name_en, mobile_number,
              account_status, outsourced_fee_per_delivered_order
            ) values (
              ${driverId}::uuid, ${companyId}::uuid, ${driverAccountId}::uuid,
              ${`MDRV-${suffix}`}, 'outsourced', 'Fujairah Driver', '971500000001', 'active', 15
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
                      (select id from emirates where code='DXB'), ${`MA-${orderSuffix}`},
                      ${`Area ${orderSuffix}`})
            `.execute(transaction);
            await sql`
              insert into accounts (id, company_id, account_kind, username, password_hash)
              values (${traderAccountId}::uuid, ${companyId}::uuid, 'trader',
                      ${`mixed.trader.${label}.${orderSuffix}`}, 'test-only')
            `.execute(transaction);
            await sql`
              insert into traders (
                id, company_id, account_id, code, name_en, mobile_number, account_status
              ) values (${traderId}::uuid, ${companyId}::uuid, ${traderAccountId}::uuid,
                        ${`MT-${orderSuffix}`}, ${`Trader ${label}`}, '971500000002', 'active')
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
                ${`MIX-${label}-${orderSuffix}`}, current_date, ${traderId}::uuid, ${areaId}::uuid,
                ${accountId}::uuid, ${driverId}::uuid, ${`Customer ${label}`}, '971500000003',
                'Address', 1, 'customer_pays_cod_and_fee',
                ${cod}, ${cod}, 15, ${cod}, 0, 0, 0, 0, ${cod},
                'delivered', 'pending', 'not_eligible', now(),
                'legacy_unattributed', 0, 'legacy_unattributed'
              )
            `.execute(transaction);
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

          // ---------------------------------------------- 1. Mixed collection
          const cashOrder = await makeOrder("CASH", "200.00");
          const visaOrder = await makeOrder("VISA", "267.00");
          const zeroOrder = await makeOrder("ZERO", "0.00");
          const selection = {
            defaultPaymentMethod: "cash",
            excludedOrderIds: [],
            orderIds: [cashOrder, visaOrder, zeroOrder],
            orderPaymentMethods: [{ method: "visa", orderId: visaOrder }],
            selectionMode: "ids",
          };

          // The eligible list shows the zero Order, flagged.
          const eligible = await request(server)
            .get(`/api/v1/operations/cash/eligible-orders?driverId=${driverId}`)
            .set("Authorization", `Bearer ${token}`);
          expect(eligible.status).toBe(200);
          const zeroRow = (eligible.body.items as { id: string; isZeroCollection: boolean }[]).find(
            (row) => row.id === zeroOrder,
          );
          expect(zeroRow?.isZeroCollection).toBe(true);

          // Expenses 190 leave 10 in cash, so the offset is capped at 10 even
          // though 45 in fees is outstanding and 277 would remain overall.
          const expenses = [{ amount: 190, expenseTypeId, reason: "Fuel and parking" }];
          const preview = await post("/operations/cash/reconciliations/preview", {
            ...selection,
            expenses,
            payments: [],
          });
          expect(preview.status).toBe(201);
          expect(preview.body).toMatchObject({
            cashGross: "200.00",
            cashOrderCount: 1,
            collectionPaymentMethod: "mixed",
            grossCollections: "467.00",
            safeMaximumDriverFeeOffset: "10.00",
            visaExpected: "267.00",
            visaGross: "267.00",
            visaOrderCount: 1,
            zeroOrderCount: 1,
          });
          const methodByOrder = Object.fromEntries(
            (preview.body.orders as { id: string; paymentMethod: string }[]).map((o) => [
              o.id,
              o.paymentMethod,
            ]),
          );
          expect(methodByOrder).toEqual({
            [cashOrder]: "cash",
            [visaOrder]: "visa",
            [zeroOrder]: "none",
          });

          // A method on the zero Order is refused.
          const zeroOverride = await post("/operations/cash/reconciliations/preview", {
            ...selection,
            expenses,
            orderPaymentMethods: [{ method: "visa", orderId: zeroOrder }],
            payments: [],
          });
          expect(zeroOverride.status).toBe(400);
          expect(zeroOverride.body.error?.code).toBe("reconciliation_method_on_zero_order");

          // Offset the capped 10: cash net = 200 - 190 - 10 = 0, Visa 267 to the bank.
          const withOffset = await post("/operations/cash/reconciliations/preview", {
            ...selection,
            driverFeeOffsetAmount: 10,
            expenses,
            payments: [],
          });
          expect(withOffset.status).toBe(201);
          expect(withOffset.body.cashNetExpected).toBe("0.00");
          expect(withOffset.body.netAmountExpected).toBe("267.00");

          // A Visa payment of the wrong amount is refused at confirm.
          const wrongVisa = await post("/operations/cash/reconciliations/selected", {
            ...selection,
            driverFeeOffsetAmount: 10,
            expenses,
            payments: [{ amount: 257, bankAccountId, paymentMethod: "bank_transfer" }],
          }).set("X-Idempotency-Key", `mixed-wrong-${randomUUID()}`);
          expect(wrongVisa.status).toBe(400);
          expect(wrongVisa.body.error?.code).toBe("reconciliation_payment_difference");

          const confirmed = await post("/operations/cash/reconciliations/selected", {
            ...selection,
            driverFeeOffsetAmount: 10,
            expenses,
            payments: [{ amount: 267, bankAccountId, paymentMethod: "bank_transfer" }],
          }).set("X-Idempotency-Key", `mixed-confirm-${randomUUID()}`);
          expect(confirmed.status).toBe(201);
          const mixedId = String(confirmed.body.reconciliationId);

          const header = await sql<{ method: string; net: string }>`
            select collection_payment_method as method, net_amount_received::text as net
              from driver_reconciliations
             where id = ${mixedId}::uuid and company_id = ${companyId}::uuid
          `.execute(transaction);
          expect(header.rows[0]).toEqual({ method: "mixed", net: "267.00" });
          const lines = await sql<{ order_id: string; collection_payment_method: string }>`
            select order_id, collection_payment_method from driver_reconciliation_orders
             where reconciliation_id = ${mixedId}::uuid and company_id = ${companyId}::uuid
          `.execute(transaction);
          expect(
            Object.fromEntries(lines.rows.map((row) => [row.order_id, row.collection_payment_method])),
          ).toEqual({ [cashOrder]: "cash", [visaOrder]: "visa", [zeroOrder]: "none" });
          const movements = await sql<{ movement_type: string; amount: string }>`
            select movement_type, amount::text as amount from cash_bank_movements
             where company_id = ${companyId}::uuid and reference_number = ${String(confirmed.body.reconciliationNumber)}
             order by movement_type
          `.execute(transaction);
          expect(movements.rows).toEqual([{ amount: "267.00", movement_type: "bank_deposit" }]);
          const statuses = await sql<{ n: number }>`
            select count(*)::int as n from orders
             where company_id = ${companyId}::uuid
               and id in (${cashOrder}::uuid, ${visaOrder}::uuid, ${zeroOrder}::uuid)
               and driver_reconciliation_status = 'reconciled'
          `.execute(transaction);
          expect(statuses.rows[0]?.n).toBe(3);

          // ------------------------------------- 2. Company pays the Driver
          const visaOnly = await makeOrder("VONLY", "67.00");
          const payoutSelection = {
            defaultPaymentMethod: "visa",
            excludedOrderIds: [],
            expenses: [{ amount: 80, expenseTypeId }],
            orderIds: [visaOnly],
            selectionMode: "ids",
          };
          const payoutPreview = await post("/operations/cash/reconciliations/preview", {
            ...payoutSelection,
            payments: [],
          });
          expect(payoutPreview.status).toBe(201);
          expect(payoutPreview.body).toMatchObject({
            cashNetExpected: "-80.00",
            companyPaysDriver: "80.00",
            netAmountExpected: "-13.00",
            safeMaximumDriverFeeOffset: "0.00",
            visaExpected: "67.00",
          });

          const noPayout = await post("/operations/cash/reconciliations/selected", {
            ...payoutSelection,
            payments: [{ amount: 67, bankAccountId, paymentMethod: "bank_transfer" }],
          }).set("X-Idempotency-Key", `payout-missing-${randomUUID()}`);
          expect(noPayout.status).toBe(400);
          expect(noPayout.body.error?.code).toBe("reconciliation_company_payout_required");

          const bankPayout = await post("/operations/cash/reconciliations/selected", {
            ...payoutSelection,
            payments: [
              { amount: 67, bankAccountId, paymentMethod: "bank_transfer" },
              { amount: 80, bankAccountId, direction: "out", paymentMethod: "bank_transfer" },
            ],
          }).set("X-Idempotency-Key", `payout-bank-${randomUUID()}`);
          expect(bankPayout.status).toBe(400);
          expect(bankPayout.body.error?.code).toBe("reconciliation_payout_cash_only");

          const payout = await post("/operations/cash/reconciliations/selected", {
            ...payoutSelection,
            payments: [
              { amount: 67, bankAccountId, paymentMethod: "bank_transfer" },
              { amount: 80, direction: "out", paymentMethod: "cash" },
            ],
          }).set("X-Idempotency-Key", `payout-ok-${randomUUID()}`);
          expect(payout.status).toBe(201);
          expect(payout.body.paymentTotal).toBe("-13.00");
          const payoutId = String(payout.body.reconciliationId);
          const payoutRows = await sql<{ direction: string; payment_method: string; amount: string }>`
            select direction, payment_method, amount::text as amount
              from driver_reconciliation_payments
             where reconciliation_id = ${payoutId}::uuid and company_id = ${companyId}::uuid
             order by direction
          `.execute(transaction);
          expect(payoutRows.rows).toEqual([
            { amount: "67.00", direction: "in", payment_method: "bank_transfer" },
            { amount: "80.00", direction: "out", payment_method: "cash" },
          ]);
          const payoutMovements = await sql<{
            movement_type: string;
            amount: string;
            source: string | null;
            destination: string | null;
          }>`
            select movement_type, amount::text as amount,
                   source_cash_account_id::text as source, destination_cash_account_id::text as destination
              from cash_bank_movements
             where company_id = ${companyId}::uuid and reference_number = ${String(payout.body.reconciliationNumber)}
             order by movement_type
          `.execute(transaction);
          expect(payoutMovements.rows).toEqual([
            { amount: "67.00", destination: null, movement_type: "bank_deposit", source: null },
            { amount: "80.00", destination: null, movement_type: "cash_withdrawal", source: cashAccountId },
          ]);

          // The summary counts the payout and splits Cash/Visa by Order line.
          const summary = await request(server)
            .get("/api/v1/operations/cash/reconciliations/summary")
            .set("Authorization", `Bearer ${token}`);
          expect(summary.status).toBe(200);
          expect(summary.body).toMatchObject({
            cashTotal: "200.00",
            paidToDrivers: "80.00",
            visaTotal: "334.00",
          });

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
  }, 90_000);
});
