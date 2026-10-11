import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DriverCashReconciliationService } from "../operations/driver-cash-reconciliation.service.js";
import { PlatformCompanyService } from "./platform-company.service.js";

/**
 * 2026-10-05 -- a Company created WITHOUT a setup template.
 *
 * Found on a local database: such a Company (template "None") could never be
 * activated (readiness requires the setup and it could only be applied at
 * creation) and had no Cash account, so a cash Driver Collection failed with a
 * raw database 409.
 *
 * Disposable database only (RUN_INTEGRITY_DATABASE + a disposable name):
 * Companies created here are committed to that throwaway database.
 */
const url = process.env.DATABASE_URL ?? "";
const run =
  process.env.RUN_INTEGRITY_DATABASE === "true" &&
  process.env.BLUELINE_ALLOW_DISPOSABLE_DATABASE === "1" &&
  (process.env.BLUELINE_DISPOSABLE_DB_NAME ?? "") !== "" &&
  url.endsWith(`/${process.env.BLUELINE_DISPOSABLE_DB_NAME}`);

describe.skipIf(!run)("Company setup template applied after creation", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let companies: PlatformCompanyService;
  let collections: DriverCashReconciliationService;
  let actorId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 4 });
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DATABASE).useValue(db).compile();
    companies = module.get(PlatformCompanyService, { strict: false });
    collections = module.get(DriverCashReconciliationService, { strict: false });
    actorId = (await sql<{ id: string }>`select id from accounts where company_id is null order by created_at limit 1`.execute(db)).rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  const actor = () => ({ accountId: actorId, correlationId: randomUUID() });
  const create = async (template?: string) =>
    (
      await companies.create(
        {
          name: `Setup Template ${randomUUID().slice(0, 8)}`,
          environment: "development",
          baseCurrency: "AED",
          countryCode: "AE",
          timezone: "Asia/Dubai",
          defaultLanguage: "en",
          ...(template === undefined ? {} : { accountingTemplateCode: template }),
        },
        actor(),
      )
    ).companyId;
  const mainCash = (companyId: string) =>
    sql<{ n: number }>`select count(*)::int n from company_cash_accounts
      where company_id = ${companyId}::uuid and is_active and cash_account_type = 'main_cash'`.execute(db);
  const populate = (companyId: string) =>
    db.transaction().execute((transaction) =>
      (collections as unknown as {
        populatePaymentAccounts: (t: unknown, c: string, p: unknown[]) => Promise<Array<{ cashAccountId?: string }>>;
      }).populatePaymentAccounts(transaction, companyId, [{ amount: "10.00", paymentMethod: "cash" }]),
    );

  it("a Company created with no template is blocked on setup, names the fix, and a cash Driver Collection refuses clearly", async () => {
    const companyId = await create();
    const readiness = (await companies.readiness(companyId)) as {
      blockedBy: string[];
      canActivate: boolean;
      items: Array<{ key: string; note: string | null }>;
      nextStep: string;
    };
    expect(readiness.blockedBy).toContain("accountingSetup");
    expect(readiness.canActivate).toBe(false);
    expect(readiness.nextStep).toBe("Apply a setup template");
    expect(readiness.items.find((item) => item.key === "accountingSetup")?.note).toMatch(/Configuration & Accounting/u);
    expect((await mainCash(companyId)).rows[0]!.n).toBe(0);
    await expect(populate(companyId)).rejects.toMatchObject({ errorCode: "cash_account_not_configured" });
  });

  it("applying the template afterwards gives the full setup (Accounting stays OFF), Main Cash, and readiness no longer blocks on it", async () => {
    const companyId = await create();
    const result = (await companies.applySetupTemplate(companyId, { templateCode: "UAE_DELIVERY_STANDARD" }, actor())) as {
      accountingSetup: { templateCode: string; areas: number };
    };
    expect(result.accountingSetup.templateCode).toBe("UAE_DELIVERY_STANDARD");
    const row = (
      await sql<{ status: string; code: string | null; enabled: boolean | null }>`
        select c.accounting_setup_status as status, c.accounting_template_code as code, a.accounting_enabled as enabled
          from companies c left join accounting_configurations a on a.company_id = c.id
         where c.id = ${companyId}::uuid`.execute(db)
    ).rows[0]!;
    expect(row).toEqual({ status: "ready", code: "UAE_DELIVERY_STANDARD", enabled: false });
    expect((await mainCash(companyId)).rows[0]!.n).toBeGreaterThan(0);
    const readiness = (await companies.readiness(companyId)) as { blockedBy: string[]; nextStep: string };
    expect(readiness.blockedBy).not.toContain("accountingSetup");
    expect(readiness.nextStep).toBe("Create Company Administrator");
    const filled = await populate(companyId);
    expect(filled[0]?.cashAccountId).toBeTruthy();
    const audit = (
      await sql<{ n: number }>`select count(*)::int n from audit_events
        where company_id = ${companyId}::uuid and action = 'platform.company.accounting_setup_applied'`.execute(db)
    ).rows[0]!.n;
    expect(audit).toBe(1);
  });

  it("refuses a second apply, a Company that already has setup data, a non-draft Company, and an unapproved template -- changing nothing", async () => {
    const withTemplate = await create("UAE_DELIVERY_STANDARD");
    await expect(
      companies.applySetupTemplate(withTemplate, { templateCode: "UAE_DELIVERY_STANDARD" }, actor()),
    ).rejects.toMatchObject({ errorCode: "company_setup_already_applied" });

    const partial = await create();
    await sql`insert into expense_types (company_id, code, name_en, display_name, is_active)
      values (${partial}::uuid, 'FUEL', 'Fuel', 'Fuel', true)`.execute(db);
    await expect(
      companies.applySetupTemplate(partial, { templateCode: "UAE_DELIVERY_STANDARD" }, actor()),
    ).rejects.toMatchObject({ errorCode: "company_setup_conflict" });
    expect((await mainCash(partial)).rows[0]!.n).toBe(0);

    const closed = await create();
    await sql`update companies set status = 'closed', closed_at = now() where id = ${closed}::uuid`.execute(db);
    await expect(
      companies.applySetupTemplate(closed, { templateCode: "UAE_DELIVERY_STANDARD" }, actor()),
    ).rejects.toMatchObject({ errorCode: "company_setup_template_draft_only" });

    const other = await create();
    await expect(companies.applySetupTemplate(other, { templateCode: "NOT_A_TEMPLATE" }, actor())).rejects.toMatchObject({
      errorCode: "accounting_template_not_approved",
    });
    const untouched = (
      await sql<{ status: string; coa: number }>`select c.accounting_setup_status as status,
          (select count(*)::int from chart_of_accounts where company_id = c.id) as coa
          from companies c where c.id = ${other}::uuid`.execute(db)
    ).rows[0]!;
    expect(untouched).toEqual({ status: "not_configured", coa: 0 });
  });
});
