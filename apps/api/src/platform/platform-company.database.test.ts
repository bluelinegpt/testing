import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Logger } from "nestjs-pino";
import { Pool } from "pg";
import request from "supertest";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { loadApprovedTemplate } from "../accounting-template/accounting-template.registry.js";
import { AppModule } from "../app.module.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { configuration } from "../configuration/environment.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApiExceptionFilter } from "../presentation/errors/api-exception.filter.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import { PLATFORM_SUPER_ADMIN_ROLE_CODE } from "./platform-authorization.js";

const runTests = process.env.RUN_PLATFORM_COMPANY_DATABASE === "true";
const rollbackMarker = Symbol("rollback platform company test");

/**
 * Company onboarding against the real schema.
 *
 * Everything runs inside ONE transaction that is always rolled back, so the
 * Companies it creates never outlive the run. That is also why the source
 * Company is never touched: this suite creates its own fixtures and asserts
 * against those.
 *
 * Gated behind `RUN_PLATFORM_COMPANY_DATABASE=true`, matching every other
 * database-backed suite here.
 */
describe.skipIf(!runTests)("Platform Company onboarding", () => {
  it("creates, initialises, validates and governs a Company", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const { template } = loadApprovedTemplate("UAE_DELIVERY_STANDARD", 1);

    let savepointDepth = 0;
    try {
      await database.transaction().execute(async (transaction) => {
        const module = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(DATABASE)
          .useValue(transaction)
          .overrideProvider(KyselyTransactionManager)
          .useValue({
            /**
             * A SAVEPOINT per service transaction.
             *
             * The usual override in this repository is a bare
             * `work(transaction)` pass-through, which is fine for services that
             * only read or whose failures the test does not exercise. It is
             * wrong here: this suite has to prove that a FAILED Company
             * creation leaves nothing behind, and a pass-through silently
             * discards the rollback — every insert made before the throw would
             * survive inside the outer transaction and the test would pass a
             * guarantee production does not have.
             *
             * Savepoints reproduce real rollback semantics inside the test's
             * single outer transaction, so what is asserted here is what
             * `database.transaction()` actually does in production.
             */
            execute: async (work: (value: typeof transaction) => Promise<unknown>) => {
              savepointDepth += 1;
              const name = `service_txn_${savepointDepth}`;
              await sql.raw(`savepoint ${name}`).execute(transaction);
              try {
                const result = await work(transaction);
                await sql.raw(`release savepoint ${name}`).execute(transaction);
                return result;
              } catch (error) {
                await sql.raw(`rollback to savepoint ${name}`).execute(transaction);
                throw error;
              }
            },
          })
          .overrideProvider(CompanyHostResolver)
          .useValue({
            resolve: (host: string | undefined) => host?.split(".")[0],
            isReservedHost: () => false,
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
          const suffix = randomUUID().slice(0, 8);

          // ---------------------------------------------------------------
          // Platform actors: one with manage, one read-only
          // ---------------------------------------------------------------
          const password = "platform-password-value";
          const hash = await hasher.hash(password);
          const managerId = randomUUID();
          const readerId = randomUUID();
          const managerName = `mgr.${suffix}`;
          const readerName = `rdr.${suffix}`;
          await sql`
            insert into accounts (id, company_id, account_kind, username, password_hash, status, password_changed_at)
            values (${managerId}::uuid, null, 'platform_administrator', ${managerName}, ${hash}, 'active', now()),
                   (${readerId}::uuid, null, 'platform_administrator', ${readerName}, ${hash}, 'active', now())
          `.execute(transaction);

          const superRole = (
            await sql<{ id: string }>`
              select id from roles where company_id is null and lower(code) = ${PLATFORM_SUPER_ADMIN_ROLE_CODE}
            `.execute(transaction)
          ).rows[0];
          expect(superRole).toBeDefined();
          await sql`
            insert into account_roles (account_id, role_id, company_id)
            values (${managerId}::uuid, ${superRole?.id}::uuid, null)
          `.execute(transaction);

          // Read-only Platform role: access + read, no manage.
          const readRoleId = randomUUID();
          await sql`
            insert into roles (id, company_id, code, name, is_system)
            values (${readRoleId}::uuid, null, ${`platform_reader_${suffix}`}, ${`Platform Reader ${suffix}`}, false)
          `.execute(transaction);
          await sql`
            insert into role_permissions (role_id, permission_code)
            values (${readRoleId}::uuid, 'platform.access'), (${readRoleId}::uuid, 'platform.companies.read')
          `.execute(transaction);
          await sql`
            insert into account_roles (account_id, role_id, company_id)
            values (${readerId}::uuid, ${readRoleId}::uuid, null)
          `.execute(transaction);

          const signIn = async (username: string): Promise<string> => {
            const response = await request(server)
              .post("/api/v1/platform/auth/login")
              .send({ identifier: username, password })
              .expect(200);
            return (response.headers["set-cookie"] as unknown as string[])[0]?.split(";")[0] ?? "";
          };
          const manageCookie = await signIn(managerName);
          const readCookie = await signIn(readerName);

          const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
            name: `Test Delivery ${suffix}`,
            subdomain: `tst${suffix}`,
            environment: "sandbox",
            countryCode: "AE",
            timezone: "Asia/Dubai",
            defaultLanguage: "en",
            accountingTemplateCode: "UAE_DELIVERY_STANDARD",
            accountingTemplateVersion: 1,
            contactName: "Ops Lead",
            businessDayStart: "07:30",
            ...overrides,
          });
          const create = (cookie: string, body: Record<string, unknown>) =>
            request(server)
              .post("/api/v1/platform/companies")
              .set("Cookie", cookie)
              .set("X-Blueline-Session", "cookie")
              .send(body);

          // ---------------------------------------------------------------
          // Permissions
          // ---------------------------------------------------------------
          await create(
            readCookie,
            payload({ subdomain: `ro${suffix}` }),
          ).expect(403);
          await request(server)
            .get("/api/v1/platform/companies")
            .set("Cookie", readCookie)
            .expect(200);
          await request(server).get("/api/v1/platform/companies").expect(401);

          // ---------------------------------------------------------------
          // Validation
          // ---------------------------------------------------------------
          await create(manageCookie, payload({ subdomain: "platform" })).expect(400);
          await create(manageCookie, payload({ environment: "prod" })).expect(400);
          await create(manageCookie, payload({ timezone: "Mars/Olympus" })).expect(400);
          await create(manageCookie, payload({ defaultLanguage: "fr" })).expect(400);
          await create(manageCookie, payload({ name: "   " })).expect(400);
          // Nothing outside the declared contract is accepted.
          await create(manageCookie, payload({ companyId: randomUUID() })).expect(400);
          await create(manageCookie, payload({ code: "BROWSER-CHOSEN" })).expect(400);
          await create(manageCookie, payload({ status: "active" })).expect(400);

          // An unapproved template is refused, and no Company survives it.
          await create(
            manageCookie,
            payload({
              accountingTemplateCode: "SOMETHING_ELSE",
              subdomain: `bad${suffix}`,
            }),
          ).expect(400);
          const afterBadTemplate = (
            await sql<{ n: string }>`
              select count(*)::bigint n from companies where subdomain = ${`bad${suffix}`}
            `.execute(transaction)
          ).rows[0];
          expect(Number(afterBadTemplate?.n)).toBe(0);

          // ---------------------------------------------------------------
          // Create
          // ---------------------------------------------------------------
          const created = await create(manageCookie, payload()).expect(201);
          const companyId = created.body.companyId as string;
          expect(companyId).toMatch(/^[0-9a-f-]{36}$/);

          const company = (
            await sql<Record<string, unknown>>`
              select * from companies where id = ${companyId}::uuid
            `.execute(transaction)
          ).rows[0];
          expect(company?.status).toBe("draft");
          expect(company?.code).toMatch(/^CMP-\d{6,}$/);
          expect(company?.environment).toBe("sandbox");
          expect(company?.accounting_setup_status).toBe("ready");
          expect(company?.accounting_template_code).toBe("UAE_DELIVERY_STANDARD");
          expect(company?.accounting_template_version).toBe(1);
          expect(company?.accounting_template_sha256).toBe(
            "2d66f8ee57cc17ce732a2ee3158f8e40131b8e815dfa9355ff13551070e06581",
          );
          expect(company?.contact_name).toBe("Ops Lead");

          // Duplicates are refused.
          await create(manageCookie, payload()).expect(409);

          // ---------------------------------------------------------------
          // Accounting setup matches the template exactly
          // ---------------------------------------------------------------
          const counts = async (table: string): Promise<number> =>
            Number(
              (
                await sql<{ n: string }>`
                  select count(*)::bigint n from ${sql.table(table)} where company_id = ${companyId}::uuid
                `.execute(transaction)
              ).rows[0]?.n ?? 0,
            );

          expect(await counts("chart_of_accounts")).toBe(template.accounts.length);
          expect(await counts("account_mappings")).toBe(template.accountMappings.length);
          expect(await counts("expense_types")).toBe(template.expenseTypes.length);
          expect(await counts("general_expense_categories")).toBe(
            template.generalExpenseCategories.length,
          );
          expect(await counts("allowance_types")).toBe(template.allowanceTypes.length);
          expect(await counts("company_reference_counters")).toBe(
            template.referenceNumberPrefixes.length,
          );
          expect(await counts("company_cash_accounts")).toBe(template.defaultCashAccounts.length);
          expect(await counts("company_bank_accounts")).toBe(template.defaultBankAccounts.length);
          expect(await counts("company_balance_policies")).toBe(1);
          expect(await counts("accounting_configurations")).toBe(1);
          expect(await counts("company_business_day_configurations")).toBe(1);

          // ---------------------------------------------------------------
          // Zero transactional history — the whole point
          // ---------------------------------------------------------------
          for (const table of [
            "opening_balance_batches",
            "opening_balance_lines",
            "accounting_events",
            "accounting_event_components",
            "journal_entries",
            "journal_lines",
            "orders",
            "customers",
            "traders",
            "drivers",
            "employees",
            "trader_settlements",
            "trader_collections",
            "driver_reconciliations",
            "payroll_entries",
            "payroll_periods",
            "general_expenses",
            "cash_bank_movements",
          ]) {
            expect({ table, rows: await counts(table) }).toEqual({ table, rows: 0 });
          }

          // ---------------------------------------------------------------
          // Fresh, Company-owned identifiers — nothing from the source Company
          // ---------------------------------------------------------------
          const sourceAccountIds = (
            await sql<{ id: string }>`
              select id from chart_of_accounts
               where company_id = 'dd28829b-2b7c-4851-a0be-181b92673e84'::uuid
            `.execute(transaction)
          ).rows.map((row) => row.id);
          const newAccounts = (
            await sql<{ id: string; code: string }>`
              select id, code from chart_of_accounts where company_id = ${companyId}::uuid order by code
            `.execute(transaction)
          ).rows;
          for (const account of newAccounts) {
            expect(sourceAccountIds).not.toContain(account.id);
          }
          expect(newAccounts.map((a) => a.code)).toEqual(
            [...template.accounts].map((a) => a.code).sort((l, r) => l.localeCompare(r, "en")),
          );

          // Every mapping resolves to an account owned by THIS Company.
          const dangling = (
            await sql<{ n: string }>`
              select count(*)::bigint n from account_mappings m
               where m.company_id = ${companyId}::uuid
                 and exists (
                   select 1 from (values
                     (m.debit_account_id), (m.credit_account_id), (m.vat_account_id),
                     (m.fee_account_id), (m.expense_account_id), (m.payable_account_id)
                   ) as slot(account_id)
                   where slot.account_id is not null
                     and not exists (
                       select 1 from chart_of_accounts a
                        where a.id = slot.account_id and a.company_id = ${companyId}::uuid
                     )
                 )
            `.execute(transaction)
          ).rows[0];
          expect(Number(dangling?.n)).toBe(0);

          // Mapping keys are contracts and must survive verbatim.
          const mappingKeys = (
            await sql<{ mapping_key: string }>`
              select mapping_key from account_mappings where company_id = ${companyId}::uuid order by mapping_key
            `.execute(transaction)
          ).rows.map((row) => row.mapping_key);
          expect(mappingKeys).toEqual(
            [...template.accountMappings]
              .map((m) => m.mappingKey)
              .sort((l, r) => l.localeCompare(r, "en")),
          );

          // Named configuration slots resolved.
          const configuration = (
            await sql<Record<string, string | null>>`
              select * from accounting_configurations where company_id = ${companyId}::uuid
            `.execute(transaction)
          ).rows[0];
          expect(configuration?.default_cash_account_id).not.toBeNull();
          expect(configuration?.default_trader_payable_account_id).not.toBeNull();
          // The template leaves suspense empty; the import must not invent it.
          expect(configuration?.default_suspense_account_id).toBeNull();
          expect(configuration?.base_currency).toBe("AED");

          // Cash and bank link to this Company's own GL accounts.
          const glLinks = (
            await sql<{ n: string }>`
              select count(*)::bigint n from company_cash_accounts c
               where c.company_id = ${companyId}::uuid
                 and exists (select 1 from chart_of_accounts a
                              where a.id = c.linked_gl_account_id and a.company_id = ${companyId}::uuid)
            `.execute(transaction)
          ).rows[0];
          expect(Number(glLinks?.n)).toBe(template.defaultCashAccounts.length);

          // No source bank identity or custodian travelled.
          const bank = (
            await sql<{ bank_name: string; description: string | null }>`
              select bank_name, description from company_bank_accounts where company_id = ${companyId}::uuid
            `.execute(transaction)
          ).rows[0];
          expect(bank?.bank_name).not.toContain("DEV-DEMO");
          const cash = (
            await sql<{ location_or_custodian: string | null }>`
              select location_or_custodian from company_cash_accounts where company_id = ${companyId}::uuid
            `.execute(transaction)
          ).rows[0];
          expect(cash?.location_or_custodian).toBeNull();

          // Counters start at 1.
          const staleCounters = (
            await sql<{ n: string }>`
              select count(*)::bigint n from company_reference_counters
               where company_id = ${companyId}::uuid and next_value <> 1
            `.execute(transaction)
          ).rows[0];
          expect(Number(staleCounters?.n)).toBe(0);

          // Business day: exactly one active rule, from the template.
          const businessDay = (
            await sql<{ timezone: string; start: string; effective_to: string | null }>`
              select timezone, business_day_start::text as start, effective_to::text as effective_to
                from company_business_day_configurations where company_id = ${companyId}::uuid
            `.execute(transaction)
          ).rows;
          expect(businessDay).toHaveLength(1);
          expect(businessDay[0]?.timezone).toBe(template.businessDay.timezone);
          // The Company's chosen start wins over the template default.
          expect(businessDay[0]?.start.slice(0, 5)).toBe("07:30");
          expect(template.businessDay.startTime).toBe("08:00");
          expect(businessDay[0]?.effective_to).toBeNull();

          // ---------------------------------------------------------------
          // Fiscal calendar: generated from THIS Company's own date
          // ---------------------------------------------------------------
          expect(await counts("fiscal_years")).toBe(1);
          expect(await counts("accounting_periods")).toBe(template.fiscalPolicy.periodsPerYear);

          const fiscalYear = (
            await sql<{
              fiscal_year_code: string;
              start_date: string;
              end_date: string;
              status: string;
            }>`
              select fiscal_year_code, start_date::text, end_date::text, status
                from fiscal_years where company_id = ${companyId}::uuid
            `.execute(transaction)
          ).rows[0];
          const thisYear = new Date().getUTCFullYear();
          // January start month, so the year containing today is this calendar
          // year - not the source Company's 2026 calendar.
          expect(fiscalYear?.fiscal_year_code).toBe(`FY-${thisYear}`);
          expect(fiscalYear?.start_date).toBe(`${thisYear}-01-01`);
          expect(fiscalYear?.end_date).toBe(`${thisYear}-12-31`);
          expect(fiscalYear?.status).toBe("open");

          const periods = (
            await sql<{
              period_code: string;
              period_number: number;
              period_start: string;
              period_end: string;
              status: string;
            }>`
              select period_code, period_number, period_start::text, period_end::text, status
                from accounting_periods where company_id = ${companyId}::uuid
               order by period_number
            `.execute(transaction)
          ).rows;
          expect(periods).toHaveLength(12);
          expect(periods[0]?.period_code).toBe(`${thisYear}-P01`);
          expect(periods[0]?.period_start).toBe(`${thisYear}-01-01`);
          expect(periods[0]?.period_end).toBe(`${thisYear}-01-31`);
          expect(periods[11]?.period_code).toBe(`${thisYear}-P12`);
          expect(periods[11]?.period_end).toBe(`${thisYear}-12-31`);
          // February's end proves the month length is computed, not assumed.
          const februaryEnd = new Date(Date.UTC(thisYear, 2, 0)).getUTCDate();
          expect(periods[1]?.period_end).toBe(
            `${thisYear}-02-${String(februaryEnd).padStart(2, "0")}`,
          );
          // Created `future`: opening a period is an accounting decision with a
          // posting consequence, not something onboarding makes silently.
          expect(periods.every((period) => period.status === "future")).toBe(true);

          // Every period belongs to THIS Company's fiscal year.
          const strayPeriods = (
            await sql<{ n: string }>`
              select count(*)::bigint n from accounting_periods p
               where p.company_id = ${companyId}::uuid
                 and not exists (
                   select 1 from fiscal_years f
                    where f.id = p.fiscal_year_id and f.company_id = ${companyId}::uuid
                 )
            `.execute(transaction)
          ).rows[0];
          expect(Number(strayPeriods?.n)).toBe(0);

          // ---------------------------------------------------------------
          // A second Company from the same template does not collide
          // ---------------------------------------------------------------
          const second = await create(
            manageCookie,
            payload({
              subdomain: `ts2${suffix}`,
              name: `Second Delivery ${suffix}`,
              environment: "demo",
            }),
          ).expect(201);
          const secondId = second.body.companyId as string;
          const secondCounters = (
            await sql<{ n: string }>`
              select count(*)::bigint n from company_reference_counters
               where company_id = ${secondId}::uuid and next_value = 1
            `.execute(transaction)
          ).rows[0];
          expect(Number(secondCounters?.n)).toBe(template.referenceNumberPrefixes.length);
          // Same codes, different Companies, no unique-constraint collision:
          // every business reference is scoped per Company.
          const sharedCodes = (
            await sql<{ n: string }>`
              select count(*)::bigint n from chart_of_accounts a
               join chart_of_accounts b on b.code = a.code
               where a.company_id = ${companyId}::uuid and b.company_id = ${secondId}::uuid
            `.execute(transaction)
          ).rows[0];
          expect(Number(sharedCodes?.n)).toBe(template.accounts.length);

          // ---------------------------------------------------------------
          // Readiness is server-derived
          // ---------------------------------------------------------------
          const readiness = await request(server)
            .get(`/api/v1/platform/companies/${companyId}/readiness`)
            .set("Cookie", manageCookie)
            .expect(200);
          const items = readiness.body.items as { key: string; state: string; required: boolean }[];
          const state = (key: string) => items.find((entry) => entry.key === key);
          expect(state("accountingSetup")?.state).toBe("complete");
          expect(state("companyAdmin")?.state).toBe("incomplete");
          expect(state("openingBalance")?.required).toBe(false);
          expect(state("openingBalance")?.state).toBe("optional");
          expect(state("bankDetails")?.required).toBe(false);
          // Company Admin is the only thing standing between draft and active.
          expect(readiness.body.canActivate).toBe(false);
          expect(readiness.body.blockedBy).toEqual(["companyAdmin"]);
          expect(readiness.body.nextStep).toBe("Create Company Administrator");

          // ---------------------------------------------------------------
          // Lifecycle
          // ---------------------------------------------------------------
          const act = (id: string, action: string, cookie: string, body: object = {}) =>
            request(server)
              .post(`/api/v1/platform/companies/${id}/${action}`)
              .set("Cookie", cookie)
              .set("X-Blueline-Session", "cookie")
              .send(body);

          // Activation is refused while the Company is not ready.
          await act(companyId, "activate", manageCookie).expect(409);
          // Read-only cannot drive lifecycle.
          await act(companyId, "activate", readCookie).expect(403);
          // Draft cannot be suspended.
          await act(companyId, "suspend", manageCookie, { reason: "too early" }).expect(409);

          // Give the Company an administrator so it becomes activatable.
          const companyAccountId = randomUUID();
          const companyRoleId = randomUUID();
          const companyUsername = `user.${suffix}`;
          const companyPassword = "company-password-value";
          await sql`
            insert into accounts (id, company_id, account_kind, username, password_hash, status, password_changed_at)
            values (${companyAccountId}::uuid, ${companyId}::uuid, 'company_user', ${companyUsername},
                    ${await hasher.hash(companyPassword)}, 'active', now())
          `.execute(transaction);
          await sql`
            insert into roles (id, company_id, code, name, is_system)
            values (${companyRoleId}::uuid, ${companyId}::uuid, 'company_admin', 'Company Administrator', true)
          `.execute(transaction);
          await sql`
            insert into role_permissions (role_id, permission_code)
            values (${companyRoleId}::uuid, 'users_roles.manage')
          `.execute(transaction);
          await sql`
            insert into account_roles (account_id, role_id, company_id)
            values (${companyAccountId}::uuid, ${companyRoleId}::uuid, ${companyId}::uuid)
          `.execute(transaction);
          await sql`
            insert into company_users (company_id, account_id, display_name, name_en)
            values (${companyId}::uuid, ${companyAccountId}::uuid, 'Test Admin', 'Test Admin')
          `.execute(transaction);

          // A draft Company cannot sign in.
          await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `tst${suffix}.test.local`)
            .send({ identifier: companyUsername, password: companyPassword })
            .expect(401);

          await act(companyId, "activate", manageCookie, { reason: "onboarding complete" }).expect(
            204,
          );
          const activated = (
            await sql<{ status: string; activated_at: Date | null; by: string | null }>`
              select status, activated_at, status_changed_by_account_id as by
                from companies where id = ${companyId}::uuid
            `.execute(transaction)
          ).rows[0];
          expect(activated?.status).toBe("active");
          expect(activated?.activated_at).not.toBeNull();
          expect(activated?.by).toBe(managerId);

          // Now sign-in works.
          const companyLogin = await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `tst${suffix}.test.local`)
            .send({ identifier: companyUsername, password: companyPassword })
            .expect(200);
          const companyCookie =
            (companyLogin.headers["set-cookie"] as unknown as string[])[0]?.split(";")[0] ?? "";

          // A Company user can never reach the Platform Company API.
          await request(server)
            .get("/api/v1/platform/companies")
            .set("Cookie", companyCookie)
            .expect(403);
          await request(server)
            .get(`/api/v1/platform/companies/${companyId}`)
            .set("Cookie", companyCookie)
            .expect(403);

          // Suspension: a reason is mandatory.
          await act(companyId, "suspend", manageCookie).expect(400);
          await act(companyId, "suspend", manageCookie, { reason: "non-payment" }).expect(204);

          // Suspension stops sign-in and kills the existing session, and
          // destroys nothing.
          await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `tst${suffix}.test.local`)
            .send({ identifier: companyUsername, password: companyPassword })
            .expect(401);
          await request(server).get("/api/v1/auth/me").set("Cookie", companyCookie).expect(401);
          expect(await counts("chart_of_accounts")).toBe(template.accounts.length);
          expect(await counts("account_mappings")).toBe(template.accountMappings.length);
          expect(
            Number(
              (
                await sql<{ n: string }>`
                  select count(*)::bigint n from accounts where company_id = ${companyId}::uuid
                `.execute(transaction)
              ).rows[0]?.n ?? 0,
            ),
          ).toBe(1);

          // Platform read stays available while suspended.
          await request(server)
            .get(`/api/v1/platform/companies/${companyId}`)
            .set("Cookie", readCookie)
            .expect(200);

          // Reactivation restores operation without recreating anything.
          await act(companyId, "reactivate", manageCookie, { reason: "payment received" }).expect(
            204,
          );
          await request(server)
            .post("/api/v1/auth/login")
            .set("Host", `tst${suffix}.test.local`)
            .send({ identifier: companyUsername, password: companyPassword })
            .expect(200);
          expect(await counts("chart_of_accounts")).toBe(template.accounts.length);

          // Terminal state, and no route back out of it.
          await act(companyId, "close", manageCookie, {
            reason: "closed",
            confirmation: `CLOSE ${String(company?.code)}`,
          }).expect(204);
          await act(companyId, "activate", manageCookie, { reason: "reopen" }).expect(409);
          await act(companyId, "reactivate", manageCookie, { reason: "reopen" }).expect(409);
          expect(await counts("chart_of_accounts")).toBe(template.accounts.length);

          // There is no deletion route at all.
          await request(server)
            .delete(`/api/v1/platform/companies/${companyId}`)
            .set("Cookie", manageCookie)
            .set("X-Blueline-Session", "cookie")
            .expect(404);

          // ---------------------------------------------------------------
          // Profile edit cannot touch protected fields
          // ---------------------------------------------------------------
          await request(server)
            .patch(`/api/v1/platform/companies/${secondId}`)
            .set("Cookie", manageCookie)
            .set("X-Blueline-Session", "cookie")
            .send({ name: `Renamed ${suffix}` })
            .expect(204);
          for (const forbidden of [
            { environment: "development" },
            { code: "HACKED" },
            { subdomain: "platform" },
            { status: "active" },
          ]) {
            await request(server)
              .patch(`/api/v1/platform/companies/${secondId}`)
              .set("Cookie", manageCookie)
              .set("X-Blueline-Session", "cookie")
              .send(forbidden)
              .expect(400);
          }
          const afterEdit = (
            await sql<{ name_en: string; environment: string; code: string }>`
              select name_en, environment, code from companies where id = ${secondId}::uuid
            `.execute(transaction)
          ).rows[0];
          expect(afterEdit?.name_en).toBe(`Renamed ${suffix}`);
          expect(afterEdit?.environment).toBe("demo");

          // ---------------------------------------------------------------
          // Rollback: a failing import leaves nothing behind
          // ---------------------------------------------------------------
          const importer = app.get(AccountingTemplateImporter);
          const failingCode = `RB-${suffix.toUpperCase()}`;
          await sql`savepoint rollback_probe`.execute(transaction);
          const brokenTemplate = {
            ...template,
            // One extra account the import will create, so the verification's
            // expected-count check fails after rows already exist.
            accounts: [
              ...template.accounts,
              { ...template.accounts[0]!, key: "GHOST", code: "9999" },
            ],
          };
          await expect(
            (async () => {
              const id = randomUUID();
              await sql`
                insert into companies (id, code, subdomain, name_en, status, environment, country_code)
                values (${id}::uuid, ${failingCode}, ${`rb${suffix}`}, 'Rollback Probe', 'draft', 'sandbox', 'AE')
              `.execute(transaction);
              await importer.verifyImport(transaction, brokenTemplate, id);
            })(),
          ).rejects.toThrow(/Accounting setup validation failed/);
          await sql`rollback to savepoint rollback_probe`.execute(transaction);
          await sql`release savepoint rollback_probe`.execute(transaction);
          const rolledBack = (
            await sql<{ n: string }>`
              select count(*)::bigint n from companies where code = ${failingCode}
            `.execute(transaction)
          ).rows[0];
          expect(Number(rolledBack?.n)).toBe(0);

          // ---------------------------------------------------------------
          // Audit
          // ---------------------------------------------------------------
          const auditRows = (
            await sql<{ action: string; source: string; company_id: string | null; actor: string }>`
              select action, source, company_id, actor_account_id as actor
                from audit_events where company_id = ${companyId}::uuid order by occurred_at
            `.execute(transaction)
          ).rows;
          const actions = auditRows.map((row) => row.action);
          expect(actions).toContain("platform.company.created");
          expect(actions).toContain("platform.company.accounting_setup_applied");
          expect(actions).toContain("platform.company.activated");
          expect(actions).toContain("platform.company.suspended");
          expect(actions).toContain("platform.company.reactivated");
          expect(actions).toContain("platform.company.closed");
          for (const row of auditRows) {
            expect(row.source).toBe("platform_portal");
            expect(row.actor).toBe(managerId);
          }
          const suspendAudit = (
            await sql<{ reason: string | null }>`
              select reason from audit_events
               where company_id = ${companyId}::uuid and action = 'platform.company.suspended'
            `.execute(transaction)
          ).rows[0];
          expect(suspendAudit?.reason).toBe("non-payment");
          // No secret is ever written.
          const serialised = JSON.stringify(auditRows);
          expect(serialised).not.toContain(password);
          expect(serialised).not.toContain(companyPassword);
        } finally {
          await app?.close();
        }

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      await database.destroy();
    }
  }, 240_000);
});
