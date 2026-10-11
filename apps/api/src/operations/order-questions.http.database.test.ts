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
import { OrderQuestionModel } from "./order-question-ask.js";

/** Stands in for the AI: the test controls exactly what it "understood". */
const fakeModel = {
  configured: () => true,
  interpret: ({ question }: { question: string }) =>
    Promise.resolve(
      question.includes("weather")
        ? { aboutOrders: false }
        : { aboutOrders: true, cashStatus: "pending", driverName: "fujairah" },
    ),
};

const runHttpTests = process.env.RUN_RECONCILIATION_HTTP === "true";
const rollbackMarker = Symbol("rollback order questions http test");

/**
 * Orders ready questions (11 Oct 2026, `order-questions.ts`): the counts and
 * the list they open agree, through HTTP and the real service, against the
 * real schema. Everything runs in one transaction that is always rolled back.
 */
describe.skipIf(!runHttpTests)("Orders ready questions", () => {
  it("counts each question and opens exactly those Orders", async () => {
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
          .overrideProvider(OrderQuestionModel)
          .useValue(fakeModel)
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
          const subdomain = `questions-${suffix}`;
          const password = `Rollback-questions-${suffix}`;
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

          type OrderState = {
            readonly cash: string;
            readonly cod: string;
            readonly delivery: string;
            readonly driver: boolean;
            readonly net: string;
            readonly settlement: string;
          };
          const makeOrder = async (label: string, state: OrderState) => {
            const orderId = randomUUID();
            const traderId = randomUUID();
            const areaId = randomUUID();
            const traderAccountId = randomUUID();
            const orderSuffix = orderId.slice(0, 8);
            await sql`
              insert into areas (id, company_id, emirate_id, code, name_en)
              values (${areaId}::uuid, ${companyId}::uuid,
                      (select id from emirates where code='DXB'), ${`QA-${orderSuffix}`},
                      ${`Area ${orderSuffix}`})
            `.execute(transaction);
            await sql`
              insert into accounts (id, company_id, account_kind, username, password_hash)
              values (${traderAccountId}::uuid, ${companyId}::uuid, 'trader',
                      ${`questions.trader.${label}.${orderSuffix}`}, 'test-only')
            `.execute(transaction);
            await sql`
              insert into traders (
                id, company_id, account_id, code, name_en, mobile_number, account_status
              ) values (${traderId}::uuid, ${companyId}::uuid, ${traderAccountId}::uuid,
                        ${`QT-${orderSuffix}`}, ${`Trader ${label}`}, '971500000002', 'active')
            `.execute(transaction);
            const delivered = state.delivery === "delivered";
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
                ${`QST-${label}-${orderSuffix}`}, current_date, ${traderId}::uuid, ${areaId}::uuid,
                ${accountId}::uuid, ${state.driver ? driverId : null}::uuid, ${`Customer ${label}`},
                '971500000003', 'Address', 1, 'customer_pays_cod_and_fee',
                ${delivered ? state.cod : "0"}, ${state.cod}, 15, ${state.net}, 0, 0, 0, 0,
                ${state.net}, ${state.delivery}, ${state.cash}, ${state.settlement},
                ${delivered ? sql`now()` : sql`null`},
                'legacy_unattributed', 0, 'legacy_unattributed'
              )
            `.execute(transaction);
            return orderId;
          };

          // One Order per question, each in exactly one answer.
          const toCollect = await makeOrder("COLLECT", {
            cash: "pending", cod: "100.00", delivery: "delivered", driver: true,
            net: "90.00", settlement: "unsettled",
          });
          const toPay = await makeOrder("PAY", {
            cash: "not_applicable", cod: "0.00", delivery: "delivered", driver: true,
            net: "90.00", settlement: "unsettled",
          });
          const toClose = await makeOrder("CLOSE", {
            cash: "not_applicable", cod: "0.00", delivery: "delivered", driver: true,
            net: "0.00", settlement: "not_eligible",
          });
          const noDriver = await makeOrder("NODRIVER", {
            cash: "not_applicable", cod: "50.00", delivery: "in_branch", driver: false,
            net: "40.00", settlement: "unsettled",
          });
          const outForDelivery = await makeOrder("OUT", {
            cash: "not_applicable", cod: "50.00", delivery: "out_for_delivery", driver: true,
            net: "40.00", settlement: "unsettled",
          });

          const counts = await request(server)
            .get("/api/v1/operations/orders/questions")
            .set("Authorization", `Bearer ${token}`);
          expect(counts.status).toBe(200);
          const byKey = Object.fromEntries(
            (counts.body.items as { amount: string | null; count: number; key: string }[]).map(
              (item) => [item.key, item],
            ),
          );
          expect(byKey.collect_from_driver).toEqual({ amount: "100.00", count: 1, key: "collect_from_driver" });
          expect(byKey.pay_trader).toEqual({ amount: "90.00", count: 1, key: "pay_trader" });
          expect(byKey.ready_to_close).toMatchObject({ amount: null, count: 1 });
          expect(byKey.no_driver).toMatchObject({ count: 1 });
          expect(byKey.out_not_delivered).toMatchObject({ count: 1 });
          expect(byKey.on_hold).toMatchObject({ count: 0 });

          const listFor = async (question: string) => {
            const response = await request(server)
              .get(`/api/v1/operations/orders?question=${question}&pageSize=100`)
              .set("Authorization", `Bearer ${token}`);
            expect(response.status).toBe(200);
            return (response.body.items as { id: string }[]).map((order) => order.id);
          };
          expect(await listFor("collect_from_driver")).toEqual([toCollect]);
          expect(await listFor("pay_trader")).toEqual([toPay]);
          expect(await listFor("ready_to_close")).toEqual([toClose]);
          expect(await listFor("no_driver")).toEqual([noDriver]);
          expect(await listFor("out_not_delivered")).toEqual([outForDelivery]);

          // "Close all ready" (step 4): the existing bulk Close, scoped by the
          // question, closes exactly the ready Order and nothing else.
          const closeAll = await request(server)
            .post("/api/v1/operations/orders/bulk-status")
            .set("Authorization", `Bearer ${token}`)
            .send({
              allowPartial: true,
              excludedOrderIds: [],
              question: "ready_to_close",
              selectionMode: "filter",
              targetStatus: "closed",
            });
          expect(closeAll.status).toBe(201);
          expect(closeAll.body).toMatchObject({ ineligible: [], processedCount: 1 });
          const statuses = await sql<{ id: string; status: string }>`
            select id, delivery_status as status from orders
             where company_id = ${companyId}::uuid
               and id in (${toClose}::uuid, ${toPay}::uuid, ${toCollect}::uuid)
          `.execute(transaction);
          expect(Object.fromEntries(statuses.rows.map((row) => [row.id, row.status]))).toEqual({
            [toClose]: "closed",
            [toCollect]: "delivered",
            [toPay]: "delivered",
          });
          expect(await listFor("ready_to_close")).toEqual([]);

          // Question box (step 5): a ready question in words needs no AI; any
          // other question becomes filters, with names resolved in this Company.
          const ask = (question: string) =>
            request(server)
              .post("/api/v1/operations/orders/ask")
              .set("Authorization", `Bearer ${token}`)
              .send({ language: "en", question });
          const library = await ask("Which orders are ready to collect from the driver?");
          expect(library.status).toBe(201);
          expect(library.body).toMatchObject({
            filters: { question: "collect_from_driver" },
            source: "library",
            unsupported: false,
          });
          const asked = await ask("Fujairah driver orders not collected yet");
          expect(asked.status).toBe(201);
          expect(asked.body).toMatchObject({
            filters: { cashStatus: "pending", driverId, quickView: "all" },
            source: "ai",
          });
          const answer = await request(server)
            .get(`/api/v1/operations/orders?quickView=all&cashStatus=pending&driverId=${driverId}`)
            .set("Authorization", `Bearer ${token}`);
          expect((answer.body.items as { id: string }[]).map((order) => order.id)).toEqual([toCollect]);
          const outside = await ask("what is the weather tomorrow");
          expect(outside.body).toMatchObject({ filters: {}, unsupported: true });
          const logged = await sql<{ n: number }>`
            select count(*)::int as n from audit_events
             where company_id = ${companyId}::uuid and action = 'orders.question_asked'
          `.execute(transaction);
          expect(logged.rows[0]?.n).toBe(3);

          const invalid = await request(server)
            .get("/api/v1/operations/orders?question=drop_table")
            .set("Authorization", `Bearer ${token}`);
          expect(invalid.status).toBe(400);
          expect(invalid.body.error?.code).toBe("order_question_invalid");

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
