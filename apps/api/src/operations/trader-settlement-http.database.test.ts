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

const runHttpTests = process.env.RUN_SETTLEMENT_HTTP === "true";
const rollbackMarker = Symbol("rollback trader settlement http test");

/**
 * HTTP-boundary tests for every `operations/settlements/payments/*` route
 * (Phase 4 Checkpoint 4B). Service-level tests cannot prove that guards are
 * wired, that DTOs are validated at the HTTP boundary, or that Company
 * isolation holds through the real routing/auth stack — those need a booted
 * application and real HTTP responses, not direct service calls.
 */
describe.skipIf(!runHttpTests)("trader settlement HTTP boundary", () => {
  it("enforces guards, validation, permissions and Company isolation on every route", async () => {
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

          const makeCompany = async (label: string, permission: string | null) => {
            const companyId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            await sql`
              insert into companies (id, code, subdomain, name_en, status, activated_at)
              values (${companyId}::uuid, ${`SHTP-${suffix}`}, ${`settlehttp-${label}-${suffix}`},
                      'Settlement HTTP Co', 'active', now())
            `.execute(transaction);
            const owner = await makeUser(companyId, label, permission);
            return { companyId, ...owner };
          };

          // Adds an additional User (its own Account + single-permission Role) to an
          // EXISTING Company — distinct from makeCompany, which also creates the Company
          // itself. Every "permission variant" must share ONE Company's data, or requests
          // made with that token are correctly (but unintentionally) Company-isolated away
          // from the fixtures below.
          const makeUser = async (
            companyId: string,
            label: string,
            permission: string | null,
            /**
             * Extra permissions this Role also grants.
             *
             * Creating a settlement now reads the funding account's
             * authoritative balance for balance enforcement, and that read
             * asserts `accounting.view`. A settlement User therefore genuinely
             * needs it; the single-permission Role predates balance controls.
             * Kept as an explicit opt-in so the unprivileged User stays
             * unprivileged and the permission assertions below are unchanged.
             */
            extraPermissions: readonly string[] = [],
          ) => {
            const accountId = randomUUID();
            const roleId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            const username = `http-${label}-${suffix}`;
            const password = `Rollback-settlehttp-${label}-password`;
            const hash = await hasher.hash(password);
            await sql`
              insert into accounts (
                id, company_id, account_kind, username, password_hash, status, password_changed_at
              ) values (${accountId}::uuid, ${companyId}::uuid, 'company_user', ${username},
                        ${hash}, 'active', now())
            `.execute(transaction);
            await sql`
              insert into company_users (company_id, account_id, display_name, name_en)
              values (${companyId}::uuid, ${accountId}::uuid, 'HTTP User', 'HTTP User')
            `.execute(transaction);
            await sql`
              insert into roles (id, company_id, code, name, is_system)
              values (${roleId}::uuid, ${companyId}::uuid, ${`role_${suffix}`}, ${`Role ${suffix}`}, true)
            `.execute(transaction);
            const permissionCodes = [
              permission ?? "orders.assign_driver",
              ...extraPermissions,
            ];
            for (const permissionCode of permissionCodes) {
              await sql`
                insert into role_permissions (role_id, permission_code)
                values (${roleId}::uuid, ${permissionCode})
              `.execute(transaction);
            }
            await sql`
              insert into account_roles (account_id, role_id, company_id)
              values (${accountId}::uuid, ${roleId}::uuid, ${companyId}::uuid)
            `.execute(transaction);
            const company = await sql<{ subdomain: string }>`
              select subdomain from companies where id = ${companyId}::uuid
            `.execute(transaction);
            const subdomain = company.rows[0]!.subdomain;
            const login = await request(server)
              .post("/api/v1/auth/login")
              .set("Host", `${subdomain}.blueline.test`)
              .send({ identifier: username, password })
              .expect(200);
            return { accountId, token: String(login.body.accessToken) };
          };

          // Company A: one Company, four Users with different, deliberately narrow Roles,
          // all sharing the same Company's data.
          const admin = await makeCompany("admin", "users_roles.manage");
          const settlementUser = await makeUser(admin.companyId, "settle", "settlements.create", [
            "accounting.view",
          ]);
          const reportUser = await makeUser(admin.companyId, "report", "reports.export");
          // Neither settlements.create, settlements.reverse, reports.export nor
          // users_roles.manage — must be refused everywhere.
          const unprivileged = await makeUser(admin.companyId, "unpriv", "orders.assign_driver");
          // Company B: fully independent, for cross-Company isolation.
          const adminB = await makeCompany("b", "users_roles.manage");

          const authed = (token: string) => (path: string) =>
            request(server).get(`/api/v1${path}`).set("Authorization", `Bearer ${token}`);
          const post = (token: string, path: string, body: object) =>
            request(server)
              .post(`/api/v1${path}`)
              .set("Authorization", `Bearer ${token}`)
              .send(body);

          // --- Fixture data: Trader, bank accounts, Orders --------------------
          const createTrader = async (
            companyId: string,
            creatorAccountId: string,
            label: string,
          ) => {
            const traderId = randomUUID();
            const traderAccountId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            await sql`
              insert into accounts (id, company_id, account_kind, username, password_hash)
              values (${traderAccountId}::uuid, ${companyId}::uuid, 'trader',
                      ${`shttp.trader.${label}.${suffix}`}, 'test-only')
            `.execute(transaction);
            await sql`
              insert into traders (id, company_id, account_id, code, name_en, mobile_number, created_by_account_id)
              values (${traderId}::uuid, ${companyId}::uuid, ${traderAccountId}::uuid,
                      ${`TRD-${suffix}`}, ${`HTTP Trader ${label}`}, '971501234567', ${creatorAccountId}::uuid)
            `.execute(transaction);
            return traderId;
          };
          const traderA = await createTrader(admin.companyId, admin.accountId, "a");
          const traderB = await createTrader(adminB.companyId, adminB.accountId, "b");

          const cashGlAccountId = randomUUID();
          const companyCashAccountId = randomUUID();
          await sql`
            insert into chart_of_accounts (
              id, company_id, code, name_en, account_type, account_class,
              normal_balance, is_posting_account, is_active
            ) values (
              ${cashGlAccountId}::uuid, ${admin.companyId}::uuid,
              ${`1010-${admin.companyId.slice(0, 8)}`}, 'Cash on hand', 'asset', 'cash',
              'debit', true, true
            )
          `.execute(transaction);
          await sql`
            insert into company_cash_accounts (
              id, company_id, cash_account_code, cash_account_name, cash_account_type,
              linked_gl_account_id, effective_from, created_by_account_id
            ) values (
              ${companyCashAccountId}::uuid, ${admin.companyId}::uuid,
              ${`HTTP-CASH-${admin.companyId.slice(0, 8)}`}, 'HTTP Cash', 'main_cash',
              ${cashGlAccountId}::uuid, '2020-01-01'::date, ${admin.accountId}::uuid
            )
          `.execute(transaction);
          await sql`
            insert into company_balance_policies (
              company_id, cash_policy, bank_policy, bank_overdraft_limit, effective_from,
              change_reason, created_by_account_id
            ) values (
              ${admin.companyId}::uuid, 'allow', 'allow', 0, '2020-01-01'::date,
              'HTTP boundary fixture: this suite asserts routing, not balance policy',
              ${admin.accountId}::uuid
            )
          `.execute(transaction);

          const companyBankAccountId = randomUUID();
          const companyBankAccountInactiveId = randomUUID();
          await sql`
            insert into company_bank_accounts (id, company_id, bank_account_code, bank_name, account_name, iban, is_active)
            values
              (${companyBankAccountId}::uuid, ${admin.companyId}::uuid, ${`HTTP-BANK-${admin.companyId.slice(0, 8)}-1`}, 'HTTP Bank', 'HTTP Account',
               ${`AE${admin.companyId.slice(0, 8)}COMPANY01`}, true),
              (${companyBankAccountInactiveId}::uuid, ${admin.companyId}::uuid, ${`HTTP-BANK-${admin.companyId.slice(0, 8)}-2`}, 'HTTP Bank', 'Inactive Account',
               ${`AE${admin.companyId.slice(0, 8)}COMPANY02`}, false)
          `.execute(transaction);
          const traderBankAccountId = randomUUID();
          await sql`
            insert into trader_bank_accounts (
              id, company_id, trader_id, bank_name, account_name, account_number, iban,
              is_default, created_by_account_id
            ) values (${traderBankAccountId}::uuid, ${admin.companyId}::uuid, ${traderA}::uuid,
                      'Trader Bank', 'Trader Account', '5551234567',
                      ${`AE${admin.companyId.slice(0, 8)}TRADER01`}, true, ${admin.accountId}::uuid)
          `.execute(transaction);
          const traderBBankAccountId = randomUUID();
          await sql`
            insert into trader_bank_accounts (
              id, company_id, trader_id, bank_name, account_name, account_number, iban,
              is_default, created_by_account_id
            ) values (${traderBBankAccountId}::uuid, ${adminB.companyId}::uuid, ${traderB}::uuid,
                      'Trader B Bank', 'Trader B Account', '5559876543',
                      ${`AE${adminB.companyId.slice(0, 8)}TRADERB1`}, true, ${adminB.accountId}::uuid)
          `.execute(transaction);

          let orderSequence = 0;
          const createOrder = async (
            companyId: string,
            creatorAccountId: string,
            traderId: string,
            netPayable: number,
          ): Promise<{ id: string; orderNumber: string }> => {
            const orderId = randomUUID();
            const areaId = randomUUID();
            orderSequence += 1;
            const number = `SHTTP-${companyId.slice(0, 4)}-${String(orderSequence).padStart(4, "0")}`;
            await sql`
              insert into areas (id, company_id, emirate_id, code, name_en)
              values (${areaId}::uuid, ${companyId}::uuid, (select id from emirates where code='DXB'),
                      ${`A${orderSequence}`}, ${`Area ${orderSequence}`})
            `.execute(transaction);
            await sql`
              insert into orders (
                service_fee_override_reason, id, company_id, order_number, order_date, trader_id, area_id, created_by_account_id,
                customer_name, customer_mobile_number, customer_address, package_count, payment_condition,
                final_service_fee_snapshot, customer_provenance_status, pricing_provenance_status,
                trader_gross_payable, trader_net_payable,
                delivery_status, driver_reconciliation_status, trader_settlement_status, return_status,
                delivered_at
              ) values (
                'Zero configured Service Fee (fixture)', ${orderId}::uuid, ${companyId}::uuid, ${number}, current_date, ${traderId}::uuid,
                ${areaId}::uuid, ${creatorAccountId}::uuid, 'HTTP Customer', '971509999999',
                'HTTP address', 1, 'customer_pays_cod_and_fee', 0, 'legacy_unattributed',
                'legacy_unattributed', ${netPayable}, ${netPayable},
                'delivered', 'reconciled', 'unsettled', 'not_applicable', now()
              )
            `.execute(transaction);
            return { id: orderId, orderNumber: number };
          };

          const orderFull = await createOrder(admin.companyId, admin.accountId, traderA, 100);
          const orderPartial = await createOrder(admin.companyId, admin.accountId, traderA, 80);
          const orderIdemA = await createOrder(admin.companyId, admin.accountId, traderA, 40);
          const orderOverpay = await createOrder(admin.companyId, admin.accountId, traderA, 25);
          const orderBankInactive = await createOrder(
            admin.companyId,
            admin.accountId,
            traderA,
            60,
          );
          const orderBankCrossTrader = await createOrder(
            admin.companyId,
            admin.accountId,
            traderA,
            60,
          );
          const orderMismatch = await createOrder(admin.companyId, admin.accountId, traderA, 30);
          const orderReceipt = await createOrder(admin.companyId, admin.accountId, traderA, 45);
          const orderReverse = await createOrder(admin.companyId, admin.accountId, traderA, 35);
          const orderReverseBlocked = await createOrder(
            admin.companyId,
            admin.accountId,
            traderA,
            55,
          );
          const orderCompanyB = await createOrder(adminB.companyId, adminB.accountId, traderB, 50);

          // =====================================================================
          // 1. GET eligible-orders
          // =====================================================================
          await authed(settlementUser.token)(
            `/operations/settlements/payments/eligible-orders?traderId=${traderA}&page=1&pageSize=25`,
          ).expect(200);
          const eligibleOk = await authed(settlementUser.token)(
            `/operations/settlements/payments/eligible-orders?traderId=${traderA}&page=1&pageSize=25`,
          ).expect(200);
          expect(eligibleOk.body.items.some((row: { id: string }) => row.id === orderFull.id)).toBe(
            true,
          );
          // Missing Trader validation.
          await authed(settlementUser.token)(
            "/operations/settlements/payments/eligible-orders?page=1&pageSize=25",
          ).expect(400);
          // Permission denied.
          await authed(unprivileged.token)(
            `/operations/settlements/payments/eligible-orders?traderId=${traderA}`,
          ).expect(403);
          // Cross-Company isolation: Company B's token, Company A's Trader ID —
          // scoped to nothing, never leaks Company A's Orders.
          const crossEligible = await authed(adminB.token)(
            `/operations/settlements/payments/eligible-orders?traderId=${traderA}&page=1&pageSize=25`,
          ).expect(200);
          expect(crossEligible.body.items).toHaveLength(0);

          // =====================================================================
          // 2. POST propose-allocation
          // =====================================================================
          const proposal = await post(
            settlementUser.token,
            "/operations/settlements/payments/propose-allocation",
            {
              amount: 120,
              traderId: traderA,
            },
          ).expect(201);
          expect(proposal.body.allocations.length).toBeGreaterThan(0);
          expect(Number(proposal.body.totalAllocated)).toBeGreaterThan(0);
          // Invalid amount.
          await post(settlementUser.token, "/operations/settlements/payments/propose-allocation", {
            amount: 0,
            traderId: traderA,
          }).expect(400);
          // Wrong (cross-Company) Trader: scoped to nothing, not an error.
          const wrongTraderProposal = await post(
            settlementUser.token,
            "/operations/settlements/payments/propose-allocation",
            { amount: 10, traderId: traderB },
          ).expect(201);
          expect(wrongTraderProposal.body.allocations).toHaveLength(0);
          expect(wrongTraderProposal.body.unallocatedAmount).toBe("10.00");
          // Permission denied.
          await post(unprivileged.token, "/operations/settlements/payments/propose-allocation", {
            amount: 10,
            traderId: traderA,
          }).expect(403);

          // =====================================================================
          // 3. POST create payment
          // =====================================================================
          // Full payment.
          const fullPaymentResponse = await post(
            settlementUser.token,
            "/operations/settlements/payments",
            {
              allocations: [{ amount: 100, orderId: orderFull.id }],
              amount: 100,
              cashAccountId: companyCashAccountId,
              paymentMethod: "cash",
              traderId: traderA,
            },
          )
            .set("X-Idempotency-Key", `full-${randomUUID()}`)
            .expect(201);
          const fullSettlementId = String(fullPaymentResponse.body.settlementId);
          expect(fullPaymentResponse.body.amount).toBe("100.00");

          // Partial payment.
          const partialPaymentResponse = await post(
            settlementUser.token,
            "/operations/settlements/payments",
            {
              allocations: [{ amount: 30, orderId: orderPartial.id }],
              amount: 30,
              cashAccountId: companyCashAccountId,
              paymentMethod: "cash",
              traderId: traderA,
            },
          )
            .set("X-Idempotency-Key", `partial-${randomUUID()}`)
            .expect(201);
          expect(partialPaymentResponse.body.amount).toBe("30.00");

          // Idempotency-key replay: identical body, identical key, twice.
          const idemKey = `idem-${randomUUID()}`;
          const idemBody = {
            allocations: [{ amount: 40, orderId: orderIdemA.id }],
            amount: 40,
            cashAccountId: companyCashAccountId,
            paymentMethod: "cash",
            traderId: traderA,
          };
          const idemFirst = await post(
            settlementUser.token,
            "/operations/settlements/payments",
            idemBody,
          )
            .set("X-Idempotency-Key", idemKey)
            .expect(201);
          const idemReplay = await post(
            settlementUser.token,
            "/operations/settlements/payments",
            idemBody,
          )
            .set("X-Idempotency-Key", idemKey)
            .expect(201);
          expect(idemReplay.body.settlementId).toBe(idemFirst.body.settlementId);

          // Missing idempotency key where required.
          const missingKey = await post(settlementUser.token, "/operations/settlements/payments", {
            allocations: [{ amount: 5, orderId: orderOverpay.id }],
            amount: 5,
            traderId: traderA,
          });
          expect(missingKey.status).toBe(400);
          expect(missingKey.body.error?.code).toBe("idempotency_key_invalid");

          // Invalid allocation total (sum of allocations != declared amount).
          const mismatchResponse = await post(
            settlementUser.token,
            "/operations/settlements/payments",
            {
              allocations: [{ amount: 10, orderId: orderMismatch.id }],
              amount: 20,
              traderId: traderA,
            },
          ).set("X-Idempotency-Key", `mismatch-${randomUUID()}`);
          expect(mismatchResponse.status).toBe(400);
          expect(mismatchResponse.body.error?.code).toBe("settlement_allocation_mismatch");

          // Overpayment: allocate more than the Order's outstanding balance.
          const overpayResponse = await post(
            settlementUser.token,
            "/operations/settlements/payments",
            {
              allocations: [{ amount: 26, orderId: orderOverpay.id }],
              amount: 26,
              traderId: traderA,
            },
          ).set("X-Idempotency-Key", `overpay-${randomUUID()}`);
          expect(overpayResponse.status).toBe(409);
          expect(overpayResponse.body.error?.code).toBe(
            "settlement_allocation_exceeds_outstanding",
          );

          // Inactive bank account.
          const inactiveBankResponse = await post(
            settlementUser.token,
            "/operations/settlements/payments",
            {
              allocations: [{ amount: 60, orderId: orderBankInactive.id }],
              amount: 60,
              bankAccountId: companyBankAccountInactiveId,
              bankReference: "REF-INACTIVE",
              paymentMethod: "bank_transfer",
              traderBankAccountId,
              traderId: traderA,
            },
          ).set("X-Idempotency-Key", `bankinactive-${randomUUID()}`);
          expect(inactiveBankResponse.status).toBe(400);
          expect(inactiveBankResponse.body.error?.code).toBe("bank_account_not_found");

          // Cross-Trader beneficiary bank account (Company B's Trader account
          // used for a Company A Trader payment).
          const crossTraderBankResponse = await post(
            settlementUser.token,
            "/operations/settlements/payments",
            {
              allocations: [{ amount: 60, orderId: orderBankCrossTrader.id }],
              amount: 60,
              bankAccountId: companyBankAccountId,
              bankReference: "REF-CROSSTRADER",
              paymentMethod: "bank_transfer",
              traderBankAccountId: traderBBankAccountId,
              traderId: traderA,
            },
          ).set("X-Idempotency-Key", `crosstrader-${randomUUID()}`);
          expect(crossTraderBankResponse.status).toBe(400);
          expect(crossTraderBankResponse.body.error?.code).toBe("trader_beneficiary_required");

          // Permission denied.
          const deniedCreate = await post(unprivileged.token, "/operations/settlements/payments", {
            allocations: [{ amount: 5, orderId: orderOverpay.id }],
            amount: 5,
            traderId: traderA,
          }).set("X-Idempotency-Key", `denied-${randomUUID()}`);
          expect(deniedCreate.status).toBe(403);

          // Cross-Company Order rejected: Company A's token paying against
          // Company B's Order — resolves to nothing under Company A's lock
          // query, so it is rejected as an empty allocation, not silently
          // reaching across tenants.
          const crossCompanyOrder = await post(
            settlementUser.token,
            "/operations/settlements/payments",
            {
              allocations: [{ amount: 50, orderId: orderCompanyB.id }],
              amount: 50,
              traderId: traderA,
            },
          ).set("X-Idempotency-Key", `crosscompany-${randomUUID()}`);
          expect(crossCompanyOrder.status).toBe(400);
          expect(crossCompanyOrder.body.error?.code).toBe("settlement_allocation_empty");

          // =====================================================================
          // 4. GET list
          // =====================================================================
          const list = await authed(settlementUser.token)(
            `/operations/settlements/payments/list?page=1&pageSize=25&traderId=${traderA}`,
          ).expect(200);
          expect(
            list.body.items.some(
              (row: { settlementId: string }) => row.settlementId === fullSettlementId,
            ),
          ).toBe(true);
          expect(list.body.page).toBe(1);
          expect(list.body.pageSize).toBe(25);
          await authed(unprivileged.token)("/operations/settlements/payments/list").expect(403);

          // =====================================================================
          // 5. GET summary
          // =====================================================================
          const summary = await authed(settlementUser.token)(
            `/operations/settlements/payments/summary?traderId=${traderA}`,
          ).expect(200);
          expect(Number(summary.body.moneySentAmount)).toBeGreaterThan(0);
          await authed(unprivileged.token)("/operations/settlements/payments/summary").expect(403);

          // =====================================================================
          // 6. GET settlement detail
          // =====================================================================
          const detail = await authed(settlementUser.token)(
            `/operations/settlements/payments/${fullSettlementId}`,
          ).expect(200);
          expect(detail.body.settlementId).toBe(fullSettlementId);
          expect(detail.body.orders).toHaveLength(1);
          expect(detail.body.createdBy).toBeDefined();
          expect(detail.body.createdBy).not.toBe("");
          // Not found.
          const notFound = await authed(settlementUser.token)(
            `/operations/settlements/payments/${randomUUID()}`,
          ).expect(404);
          expect(notFound.body.error?.code).toBe("settlement_not_found");
          // Cross-Company access denied (as "not found", never leaking existence).
          const crossDetail = await authed(adminB.token)(
            `/operations/settlements/payments/${fullSettlementId}`,
          ).expect(404);
          expect(crossDetail.body.error?.code).toBe("settlement_not_found");

          // =====================================================================
          // 7. GET report-data
          // =====================================================================
          const report = await authed(settlementUser.token)(
            `/operations/settlements/payments/${fullSettlementId}/report-data`,
          ).expect(200);
          expect(report.body.header.settlementNumber).toBeDefined();
          // reports.export alone is sufficient, without settlements.create.
          await authed(reportUser.token)(
            `/operations/settlements/payments/${fullSettlementId}/report-data`,
          ).expect(200);
          // Permission denied.
          await authed(unprivileged.token)(
            `/operations/settlements/payments/${fullSettlementId}/report-data`,
          ).expect(403);
          // Masked bank values: the bank-transfer settlement created above names
          // a real beneficiary, so its report-data must mask it.
          const bankReport = await authed(settlementUser.token)(
            `/operations/settlements/payments/${
              (
                await post(settlementUser.token, "/operations/settlements/payments", {
                  allocations: [{ amount: 60, orderId: orderBankCrossTrader.id }],
                  amount: 60,
                  bankAccountId: companyBankAccountId,
                  bankReference: "REF-MASKTEST",
                  paymentMethod: "bank_transfer",
                  traderBankAccountId,
                  traderId: traderA,
                })
                  .set("X-Idempotency-Key", `masktest-${randomUUID()}`)
                  .expect(201)
              ).body.settlementId
            }/report-data`,
          ).expect(200);
          expect(bankReport.body.header.beneficiaryBank.accountNumberMasked).not.toContain(
            "5551234567",
          );
          expect(bankReport.body.header.beneficiaryBank.accountNumberMasked).toContain("4567");
          // No internal database IDs anywhere in the report payload.
          expect(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(
              JSON.stringify(report.body),
            ),
          ).toBe(false);

          // =====================================================================
          // 7b. GET pdf — Trader Settlement Statement
          // =====================================================================
          const pdfResponse = await request(server)
            .get(`/api/v1/operations/settlements/payments/${fullSettlementId}/pdf?language=en`)
            .set("Authorization", `Bearer ${settlementUser.token}`)
            .buffer(true)
            .parse((response, callback) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.on("end", () => callback(null, Buffer.concat(chunks)));
            })
            .expect(200);
          expect(pdfResponse.headers["content-type"]).toContain("application/pdf");
          expect(pdfResponse.headers["content-disposition"]).toContain("Trader-Settlement-");
          expect(pdfResponse.headers["content-disposition"]).toContain(".pdf");
          expect((pdfResponse.body as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
          // reports.export alone is sufficient, without settlements.create.
          await request(server)
            .get(`/api/v1/operations/settlements/payments/${fullSettlementId}/pdf?language=ar`)
            .set("Authorization", `Bearer ${reportUser.token}`)
            .expect(200);
          // Permission denied.
          await authed(unprivileged.token)(
            `/operations/settlements/payments/${fullSettlementId}/pdf`,
          ).expect(403);
          // Cross-Company access denied.
          const crossPdf = await authed(adminB.token)(
            `/operations/settlements/payments/${fullSettlementId}/pdf`,
          ).expect(404);
          expect(crossPdf.body.error?.code).toBe("settlement_not_found");

          // =====================================================================
          // 7c. Bank-account picker access — settlements.create must be able to
          // list Company source banks and a Trader's beneficiary banks (the
          // Checkpoint 5A gap fixed in this checkpoint), without gaining any
          // write access on those routes.
          // =====================================================================
          const companyBanks = await authed(settlementUser.token)(
            "/configuration/bank-accounts",
          ).expect(200);
          expect(Array.isArray(companyBanks.body)).toBe(true);
          expect(
            companyBanks.body.some((row: { id: string }) => row.id === companyBankAccountId),
          ).toBe(true);
          const traderBanks = await authed(settlementUser.token)(
            `/configuration/traders/${traderA}/bank-accounts`,
          ).expect(200);
          expect(Array.isArray(traderBanks.body)).toBe(true);
          expect(
            traderBanks.body.some((row: { id: string }) => row.id === traderBankAccountId),
          ).toBe(true);
          // Permission denied for a User with neither settlements.create nor
          // users_roles.manage.
          await authed(unprivileged.token)("/configuration/bank-accounts").expect(403);
          await authed(unprivileged.token)(
            `/configuration/traders/${traderA}/bank-accounts`,
          ).expect(403);
          // The write routes on the same controllers remain users_roles.manage-only
          // — settlements.create must not have gained write access.
          await post(settlementUser.token, "/configuration/bank-accounts", {
            accountName: "Should Not Be Created",
            bankName: "Should Not Be Created",
            currency: "AED",
          }).expect(403);

          // =====================================================================
          // 8. POST confirm-receipt
          // =====================================================================
          const receiptSettlement = await post(
            settlementUser.token,
            "/operations/settlements/payments",
            {
              allocations: [{ amount: 45, orderId: orderReceipt.id }],
              amount: 45,
              // No paymentMethod: the API defaults to cash, which still needs
              // its funding Cash account named.
              cashAccountId: companyCashAccountId,
              traderId: traderA,
            },
          )
            .set("X-Idempotency-Key", `receipt-base-${randomUUID()}`)
            .expect(201);
          const receiptSettlementId = String(receiptSettlement.body.settlementId);
          const receiptConfirmKey = `receipt-confirm-${randomUUID()}`;
          const receiptConfirmBody = {
            notes: "Confirmed via HTTP test",
            receivedDate: "2026-01-15",
            reference: "ACK-HTTP-1",
          };
          const receiptConfirm = await post(
            settlementUser.token,
            `/operations/settlements/payments/${receiptSettlementId}/confirm-receipt`,
            receiptConfirmBody,
          )
            .set("X-Idempotency-Key", receiptConfirmKey)
            .expect(201);
          expect(receiptConfirm.body.orderCount).toBe(1);
          // Duplicate confirmation.
          const duplicateReceipt = await post(
            settlementUser.token,
            `/operations/settlements/payments/${receiptSettlementId}/confirm-receipt`,
            {},
          ).set("X-Idempotency-Key", `receipt-dup-${randomUUID()}`);
          expect(duplicateReceipt.status).toBe(409);
          expect(duplicateReceipt.body.error?.code).toBe(
            "trader_settlement_receipt_already_confirmed",
          );
          // Invalid state: a settlement that does not exist.
          const invalidStateReceipt = await post(
            settlementUser.token,
            `/operations/settlements/payments/${randomUUID()}/confirm-receipt`,
            {},
          ).set("X-Idempotency-Key", `receipt-invalid-${randomUUID()}`);
          expect(invalidStateReceipt.status).toBe(404);
          expect(invalidStateReceipt.body.error?.code).toBe("settlement_not_found");
          // Idempotency replay of the exact same confirmation.
          const receiptReplay = await post(
            settlementUser.token,
            `/operations/settlements/payments/${receiptSettlementId}/confirm-receipt`,
            receiptConfirmBody,
          )
            .set("X-Idempotency-Key", receiptConfirmKey)
            .expect(201);
          expect(receiptReplay.body.settlementId).toBe(receiptSettlementId);
          // Permission denied.
          await post(
            unprivileged.token,
            `/operations/settlements/payments/${receiptSettlementId}/confirm-receipt`,
            {},
          )
            .set("X-Idempotency-Key", `receipt-denied-${randomUUID()}`)
            .expect(403);

          // =====================================================================
          // 9. POST reverse
          // =====================================================================
          const reverseSettlement = await post(
            settlementUser.token,
            "/operations/settlements/payments",
            {
              allocations: [{ amount: 35, orderId: orderReverse.id }],
              amount: 35,
              cashAccountId: companyCashAccountId,
              traderId: traderA,
            },
          )
            .set("X-Idempotency-Key", `reverse-base-${randomUUID()}`)
            .expect(201);
          const reverseSettlementId = String(reverseSettlement.body.settlementId);
          // Missing reason.
          await post(
            admin.token,
            `/operations/settlements/payments/${reverseSettlementId}/reverse`,
            {},
          ).expect(400);
          // Valid reversal.
          const validReverse = await post(
            admin.token,
            `/operations/settlements/payments/${reverseSettlementId}/reverse`,
            { reason: "HTTP test reversal" },
          ).expect(201);
          expect(validReverse.body.settlementId).toBe(reverseSettlementId);
          // Duplicate reversal rejected.
          const duplicateReverse = await post(
            admin.token,
            `/operations/settlements/payments/${reverseSettlementId}/reverse`,
            { reason: "second attempt" },
          );
          expect(duplicateReverse.status).toBe(409);
          expect(duplicateReverse.body.error?.code).toBe("settlement_already_reversed");
          // Permission denied: settlements.create alone does not grant reverse.
          const anotherReversible = await post(
            settlementUser.token,
            "/operations/settlements/payments",
            {
              allocations: [{ amount: 10, orderId: orderMismatch.id }],
              amount: 10,
              cashAccountId: companyCashAccountId,
              traderId: traderA,
            },
          )
            .set("X-Idempotency-Key", `reverse-denied-base-${randomUUID()}`)
            .expect(201);
          await post(
            settlementUser.token,
            `/operations/settlements/payments/${anotherReversible.body.settlementId}/reverse`,
            { reason: "no permission" },
          ).expect(403);
          // Money Received reversal blocked.
          const blockedSettlement = await post(
            settlementUser.token,
            "/operations/settlements/payments",
            {
              allocations: [{ amount: 55, orderId: orderReverseBlocked.id }],
              amount: 55,
              cashAccountId: companyCashAccountId,
              traderId: traderA,
            },
          )
            .set("X-Idempotency-Key", `reverse-blocked-base-${randomUUID()}`)
            .expect(201);
          await post(
            settlementUser.token,
            `/operations/settlements/payments/${blockedSettlement.body.settlementId}/confirm-receipt`,
            {},
          )
            .set("X-Idempotency-Key", `reverse-blocked-receipt-${randomUUID()}`)
            .expect(201);
          const blockedReverse = await post(
            admin.token,
            `/operations/settlements/payments/${blockedSettlement.body.settlementId}/reverse`,
            { reason: "attempt after receipt" },
          );
          expect(blockedReverse.status).toBe(409);
          expect(blockedReverse.body.error?.code).toBe("settlement_reversal_blocked_by_receipt");

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
