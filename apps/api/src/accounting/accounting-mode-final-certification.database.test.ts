import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { TraderReceivableService } from "../operations/trader-receivable.service.js";
import { PlatformCompanyService } from "../platform/platform-company.service.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { CashBankManagementService } from "./cash-bank-management.service.js";
import { CompanyAccountingModeService } from "./company-accounting-mode.service.js";
import { FundingAccountBalanceService } from "./funding-account-balance.service.js";

/**
 * Phase 1 Prompt 4 -- final Accounting-mode certification, end to end through
 * the real services (AppModule compiled, not initialised; disposable DB):
 *
 *   H. new Company OFF -> operational finance, no GL, balance enforced ->
 *      enable preview -> enable -> no backfill -> capture after activation ->
 *      disable blocked by unresolved work -> disable -> re-enable -> no
 *      backfill -> captured again.
 *   E. Bank accounts: GL optional while OFF (operational, balance-controlled,
 *      no Event), mandatory while ON, and a GL-less active bank account blocks
 *      enabling until someone links it (never auto-mapped).
 */

const disposableName = process.env.BLUELINE_DISPOSABLE_DB_NAME ?? "";
const databaseUrl = process.env.DATABASE_URL ?? "";
const runDatabaseTests =
  process.env.RUN_INTEGRITY_DATABASE === "true" &&
  disposableName.length > 0 &&
  databaseUrl.endsWith(`/${disposableName}`);

const today = new Date().toISOString().slice(0, 10);

const PERMISSIONS = [
  "accounting.view",
  "accounting.manage",
  "accounting.approve",
  "accounting.reverse",
  "accounting.configuration.manage",
  "trader_receivables.create",
  "trader_receivables.view",
];

interface Actor {
  readonly companyId: string;
  readonly actorId: string;
}

describe.skipIf(!runDatabaseTests)("Accounting mode final certification", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let store: RequestSecurityContextStore;
  let get: <T>(type: new (...args: never[]) => T) => T;
  let platformActor: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(db)
      .compile();
    get = (type) => module.get(type, { strict: false });
    store = module.get(RequestSecurityContextStore, { strict: false });
    const emirateCodes = [
      "AAN",
      "AJM",
      "AUH",
      "DXB",
      "EST",
      "FUJ",
      "OAA",
      "RAK",
      "SHJ",
      "UAQ",
      "WST",
    ];
    for (const [index, code] of emirateCodes.entries()) {
      await sql`insert into emirates(code, name_en, name_ar, display_order)
        values (${code}, ${code}, ${code}, ${100 + index}) on conflict (code) do nothing`.execute(
        db,
      );
    }
    platformActor = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${platformActor}::uuid,null,'platform_administrator',${`final.p.${platformActor}`},'x','disabled')`.execute(
      db,
    );
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  function as<T>(actor: Actor, work: () => Promise<T>) {
    return store.run(
      {
        identity: {
          companyId: actor.companyId,
          forcePasswordChange: false,
          identityId: actor.actorId,
          kind: "company_user",
          permissions: new Set(PERMISSIONS),
          sessionId: randomUUID(),
        },
        tenant: { companyId: actor.companyId, identityId: actor.actorId },
      },
      work,
    );
  }

  const key = (label: string) => `final.${label}.${randomUUID()}`;
  const platform = () => ({ accountId: platformActor, correlationId: randomUUID() });

  async function companyUser(companyId: string): Promise<Actor> {
    const actorId = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${actorId}::uuid,${companyId}::uuid,'company_user',${`final.${actorId}`},'x','disabled')`.execute(
      db,
    );
    return { actorId, companyId };
  }

  /** A Company exactly as the Platform creates it. */
  async function platformCompany(): Promise<Actor & { traderId: string; cashAccountId: string }> {
    const suffix = randomUUID().slice(0, 8);
    const created = await get(PlatformCompanyService).create(
      {
        accountingTemplateCode: "UAE_DELIVERY_STANDARD",
        baseCurrency: "AED",
        businessDayStart: "07:30",
        contactName: "Ops Lead",
        countryCode: "AE",
        defaultLanguage: "en",
        environment: "sandbox",
        name: `Final Cert ${suffix}`,
        subdomain: `finalcert${suffix}`,
        timezone: "Asia/Dubai",
      },
      platform(),
    );
    const actor = await companyUser(created.companyId);
    const traderId = randomUUID();
    await sql`insert into traders(id,company_id,code,name_en,mobile_number)
      values (${traderId}::uuid,${created.companyId}::uuid,${`T-${suffix}`},'Trader','971500000003')`.execute(
      db,
    );
    const cashAccountId = (
      await sql<{ id: string }>`select id from company_cash_accounts
        where company_id=${created.companyId}::uuid and cash_account_type='main_cash'`.execute(db)
    ).rows[0]!.id;
    return { ...actor, cashAccountId, traderId };
  }

  async function events(companyId: string) {
    return (
      await sql<{ n: number }>`select count(*)::int as n from accounting_events
        where company_id=${companyId}::uuid`.execute(db)
    ).rows[0]!.n;
  }

  async function journals(companyId: string) {
    return (
      await sql<{ n: number }>`select count(*)::int as n from journal_entries
        where company_id=${companyId}::uuid`.execute(db)
    ).rows[0]!.n;
  }

  /** One operational transaction: a manual Trader receivable collected in cash. */
  async function receivableAndCollection(actor: Actor & { traderId: string }, amount: number) {
    const receivable = (await as(actor, () =>
      get(TraderReceivableService).createReceivable(
        {
          amountDue: amount,
          businessDate: today,
          reason: "Operational",
          sourceType: "manual_adjustment",
          traderId: actor.traderId,
        } as never,
        randomUUID(),
        key("receivable"),
      ),
    )) as { receivableId?: string; id?: string };
    const receivableId = (receivable.receivableId ?? receivable.id)!;
    await as(actor, () =>
      get(TraderReceivableService).confirmCollection(
        {
          allocations: [{ amount, receivableId }],
          amountReceived: amount,
          paymentDate: today,
          paymentMethod: "cash",
          traderId: actor.traderId,
        } as never,
        randomUUID(),
        key("collection"),
      ),
    );
    return receivableId;
  }

  async function sourceEvents(companyId: string, sourceId: string) {
    return (
      await sql<{ n: number }>`select count(*)::int as n from accounting_events
        where company_id=${companyId}::uuid and source_entity_id=${sourceId}::uuid`.execute(db)
    ).rows[0]!.n;
  }

  async function refusal(work: Promise<unknown>): Promise<ApplicationException> {
    try {
      await work;
    } catch (error) {
      if (error instanceof ApplicationException) return error;
      throw error;
    }
    throw new Error("expected the operation to be refused");
  }

  async function enable(companyId: string, reason: string) {
    const mode = get(CompanyAccountingModeService);
    const preview = await mode.previewEnable(companyId);
    return mode.enable(
      companyId,
      {
        confirmation: preview.confirmation,
        expectedConfigurationVersion: preview.expectedConfigurationVersion,
        reason,
      },
      platform(),
    );
  }

  async function disable(companyId: string, reason: string) {
    const mode = get(CompanyAccountingModeService);
    const preview = await mode.previewDisable(companyId);
    return mode.disable(
      companyId,
      {
        confirmation: preview.confirmation,
        expectedConfigurationVersion: preview.expectedConfigurationVersion,
        reason,
      },
      platform(),
    );
  }

  // ---------------------------------------------------------------------------
  // H. The complete Accounting-mode lifecycle
  // ---------------------------------------------------------------------------

  it("H. new Company OFF -> operate -> enable -> capture -> disable (guarded) -> re-enable, never backfilling", async () => {
    const mode = get(CompanyAccountingModeService);
    const company = await platformCompany();

    // NEW COMPANY -> Accounting OFF.
    expect(await mode.status(company.companyId)).toMatchObject({ accountingEnabled: false });

    // OFF: operational finance works, no Event, no Journal.
    const offReceivable = await receivableAndCollection(company, 25);
    const balance = async () =>
      Number(
        (
          await as(company, () =>
            get(FundingAccountBalanceService).current("cash", company.cashAccountId),
          )
        ).balance,
      );
    expect(await balance()).toBe(25);
    expect(await events(company.companyId)).toBe(0);
    expect(await journals(company.companyId)).toBe(0);

    // OFF: operational balance enforcement works.
    const cash = get(CashBankManagementService);
    const overdraw = (await as(company, () =>
      cash.createMovement(
        {
          accountingDate: today,
          amount: "1000",
          classificationMappingKey: "cash_bank_withdrawal_owner",
          movementDate: today,
          movementType: "cash_withdrawal",
          sourceCashAccountId: company.cashAccountId,
        } as never,
        key("overdraw"),
      ),
    )) as { id: string };
    const refused = await refusal(
      as(company, () => cash.confirmMovement(overdraw.id, undefined, key("overdraw-confirm"))),
    );
    expect(refused.errorCode).toBe("balance_would_go_negative");
    expect(await balance()).toBe(25);

    // Enable preview checks every enabled area; the template left it ready.
    const preview = await mode.previewEnable(company.companyId);
    expect(preview).toMatchObject({ blockers: [], executable: true });
    expect(preview.enabledAreas.length).toBeGreaterThan(0);

    // Enable -> ON, with no backfill of the OFF period.
    expect((await enable(company.companyId, "Go live")).changed).toBe(true);
    expect(await mode.status(company.companyId)).toMatchObject({ accountingEnabled: true });
    expect(await sourceEvents(company.companyId, offReceivable)).toBe(0);
    expect(await events(company.companyId)).toBe(0);

    // After activation: normal capture.
    const onReceivable = await receivableAndCollection(company, 10);
    expect(await sourceEvents(company.companyId, onReceivable)).toBeGreaterThan(0);

    // Disable preview: the unresolved (unprocessed) work blocks disable.
    const disablePreview = (await mode.previewDisable(company.companyId)) as {
      blockers: readonly unknown[];
      executable: boolean;
    };
    expect(disablePreview.executable).toBe(false);
    expect(disablePreview.blockers.length).toBeGreaterThan(0);
    await refusal(disable(company.companyId, "Too early"));
    expect(await mode.status(company.companyId)).toMatchObject({ accountingEnabled: true });

    // Resolve the work (the Accounting module would post it), then disable.
    await sql`update accounting_events set processing_status='ignored_no_accounting_required'
               where company_id=${company.companyId}::uuid`.execute(db);
    expect((await disable(company.companyId, "Pause GL")).changed).toBe(true);
    const eventsWhenDisabled = await events(company.companyId);

    // OFF again: operations record nothing in the ledger.
    const pausedReceivable = await receivableAndCollection(company, 5);
    expect(await events(company.companyId)).toBe(eventsWhenDisabled);

    // Re-enable: no historical backfill; new work is captured again.
    expect((await enable(company.companyId, "Resume GL")).changed).toBe(true);
    expect(await sourceEvents(company.companyId, pausedReceivable)).toBe(0);
    expect(await sourceEvents(company.companyId, offReceivable)).toBe(0);
    expect(await events(company.companyId)).toBe(eventsWhenDisabled);
    const resumedReceivable = await receivableAndCollection(company, 7);
    expect(await sourceEvents(company.companyId, resumedReceivable)).toBeGreaterThan(0);
    expect(await journals(company.companyId)).toBe(0); // processor not running here
  });

  // ---------------------------------------------------------------------------
  // E. Bank accounts and the Accounting mode
  // ---------------------------------------------------------------------------

  const bankInput = (code: string, linkedGlAccountId?: string) => ({
    accountName: `Account ${code}`,
    accountType: "current",
    bankName: "Emirates Bank",
    code,
    effectiveFrom: today,
    ...(linkedGlAccountId === undefined ? {} : { linkedGlAccountId }),
  });

  it("E. OFF: a bank account needs no GL, works operationally, is balance-controlled and writes no Event", async () => {
    const companyId = randomUUID();
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`BANKOFF-${companyId.slice(0, 8)}`},${`bankoff-${companyId.slice(0, 8)}`},
              'Bank OFF','active',now())`.execute(db);
    const actor = await companyUser(companyId);
    const cash = get(CashBankManagementService);
    const created = (await as(actor, () =>
      cash.createBankAccount(bankInput("BANK-OFF") as never, key("bank")),
    )) as { id: string };
    const stored = await sql<{ gl: string | null }>`select linked_gl_account_id as gl
      from company_bank_accounts where id=${created.id}::uuid`.execute(db);
    expect(stored.rows[0]!.gl).toBeNull();
    // No fake Chart of Accounts was created for it.
    const coa = await sql<{ n: number }>`select count(*)::int as n from chart_of_accounts
      where company_id=${companyId}::uuid`.execute(db);
    expect(coa.rows[0]!.n).toBe(0);

    // Operational opening balance into the bank, then a withdrawal it covers.
    const opening = (await as(actor, () =>
      cash.createMovement(
        {
          accountingDate: today,
          amount: "500",
          destinationBankAccountId: created.id,
          movementDate: today,
          movementType: "opening_balance",
        } as never,
        key("bank-opening"),
      ),
    )) as { id: string };
    await as(actor, () => cash.confirmMovement(opening.id, undefined, key("bank-opening-confirm")));
    const bankBalance = async () =>
      Number(
        (await as(actor, () => get(FundingAccountBalanceService).current("bank", created.id)))
          .balance,
      );
    expect(await bankBalance()).toBe(500);
    // Balance-controlled: a withdrawal beyond funds is refused.
    const overdraw = (await as(actor, () =>
      cash.createMovement(
        {
          accountingDate: today,
          amount: "800",
          classificationMappingKey: "cash_bank_withdrawal_owner",
          movementDate: today,
          movementType: "bank_withdrawal",
          sourceBankAccountId: created.id,
        } as never,
        key("bank-overdraw"),
      ),
    )) as { id: string };
    const refused = await refusal(
      as(actor, () => cash.confirmMovement(overdraw.id, undefined, key("bank-overdraw-confirm"))),
    );
    expect(refused.errorCode).toBe("balance_would_go_negative");
    expect(await bankBalance()).toBe(500);
    expect(await events(companyId)).toBe(0);
    expect(await journals(companyId)).toBe(0);

    // Editing it while OFF still needs no GL.
    const version = await sql<{ version: string }>`select version::text from company_bank_accounts
      where id=${created.id}::uuid`.execute(db);
    await as(actor, () =>
      cash.updateBankAccount(
        created.id,
        {
          ...bankInput("BANK-OFF"),
          accountName: "Renamed",
          version: Number(version.rows[0]!.version),
        } as never,
        key("bank-update"),
      ),
    );
  });

  it("E. ON: the GL account stays mandatory for a bank account", async () => {
    const companyId = randomUUID();
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`BANKON-${companyId.slice(0, 8)}`},${`bankon-${companyId.slice(0, 8)}`},
              'Bank ON','active',now())`.execute(db);
    await db.transaction().execute((transaction) =>
      new AccountingTemplateImporter().apply(transaction, {
        actorAccountId: null,
        baseCurrency: "AED",
        companyId,
        effectiveFrom: today,
        templateCode: "UAE_DELIVERY_STANDARD",
        templateVersion: 3,
      }),
    );
    await sql`update accounting_configurations set accounting_enabled = true, version = version + 1
               where company_id = ${companyId}::uuid`.execute(db);
    const actor = await companyUser(companyId);
    const cash = get(CashBankManagementService);
    const refused = await refusal(
      as(actor, () => cash.createBankAccount(bankInput("BANK-NOGL") as never, key("bank-on"))),
    );
    expect(refused.errorCode).toBe("accounting_cash_bank_linked_gl_invalid");
    const bankGl = await sql<{ id: string }>`select id from chart_of_accounts
      where company_id=${companyId}::uuid and account_type='asset' and account_class='bank'
        and is_active and is_posting_account limit 1`.execute(db);
    const created = (await as(actor, () =>
      cash.createBankAccount(bankInput("BANK-GL", bankGl.rows[0]!.id) as never, key("bank-on-gl")),
    )) as { id: string };
    expect(created.id).toBeDefined();
  });

  it("E. OFF -> ON: a GL-less active bank account blocks enabling until it is linked; never auto-mapped", async () => {
    const company = await platformCompany();
    const cash = get(CashBankManagementService);
    const created = (await as(company, () =>
      cash.createBankAccount(bankInput("BANK-NOGL") as never, key("bank-nogl")),
    )) as { id: string };
    const mode = get(CompanyAccountingModeService);
    const blocked = await mode.previewEnable(company.companyId);
    expect(blocked.executable).toBe(false);
    expect(blocked.blockers).toEqual(
      expect.arrayContaining([{ code: "bank_account_without_gl", detail: "BANK-NOGL" }]),
    );
    await refusal(enable(company.companyId, "Too early"));
    // Not auto-mapped by the preview or the refused enable.
    const stillNull = await sql<{ gl: string | null }>`select linked_gl_account_id as gl
      from company_bank_accounts where id=${created.id}::uuid`.execute(db);
    expect(stillNull.rows[0]!.gl).toBeNull();
    // Someone links it; enabling is then possible.
    const bankGl = await sql<{ id: string }>`select id from chart_of_accounts
      where company_id=${company.companyId}::uuid and account_type='asset' and account_class='bank'
        and is_active and is_posting_account limit 1`.execute(db);
    const version = await sql<{ version: string }>`select version::text from company_bank_accounts
      where id=${created.id}::uuid`.execute(db);
    await as(company, () =>
      cash.updateBankAccount(
        created.id,
        {
          ...bankInput("BANK-NOGL", bankGl.rows[0]!.id),
          version: Number(version.rows[0]!.version),
        } as never,
        key("bank-link"),
      ),
    );
    const ready = await mode.previewEnable(company.companyId);
    expect(ready.blockers).toEqual([]);
    expect((await enable(company.companyId, "Go live")).changed).toBe(true);
  });
});
