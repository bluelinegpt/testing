import { createHash, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingManagementService } from "./accounting-management.service.js";
import type { AccountingOperationSupport } from "./accounting-operation.support.js";
import { AutomaticPostingService } from "./automatic-posting.service.js";
import {
  CompanyAccountingModeService,
  disableConfirmationFor,
  enableConfirmationFor,
} from "./company-accounting-mode.service.js";

/**
 * Company Accounting Mode -- certification against the real schema.
 *
 * WHY THESE FIXTURES ARE COMMITTED
 * --------------------------------
 * The previews are read-only BY POSTGRESQL (`set transaction read only`),
 * which can only be issued as the first statement of a real transaction, and
 * the execute paths take real row and advisory locks. Running them inside one
 * rolled-back test transaction would test neither. So every case creates its
 * OWN freshly-generated Companies (code prefix `ACCMODE-`) in the disposable
 * database and works only on those UUIDs. No pre-existing Company is read for
 * a decision or written.
 *
 * Gated twice: RUN_INTEGRITY_DATABASE=true, and DATABASE_URL must name the
 * database in BLUELINE_DISPOSABLE_DB_NAME. It never runs against anything
 * else.
 */

const disposableName = process.env.BLUELINE_DISPOSABLE_DB_NAME ?? "";
const databaseUrl = process.env.DATABASE_URL ?? "";
const runDatabaseTests =
  process.env.RUN_INTEGRITY_DATABASE === "true" &&
  disposableName.length > 0 &&
  databaseUrl.endsWith(`/${disposableName}`);

const today = new Date().toISOString().slice(0, 10);

describe.skipIf(!runDatabaseTests)("Company Accounting Mode (database)", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let service: CompanyAccountingModeService;
  let platformActorId: string;
  const importer = new AccountingTemplateImporter();

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const transactions = new KyselyTransactionManager(db);
    // readinessForCompany never touches the Company-session support object.
    const automaticPosting = new AutomaticPostingService(
      db,
      transactions,
      {} as AccountingOperationSupport,
    );
    service = new CompanyAccountingModeService(db, transactions, automaticPosting);
    // The approved template seeds Areas for every UAE emirate code it names; a
    // bare disposable database may hold only some. Insert-if-missing only:
    // existing reference rows are never changed.
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
        values (${code}, ${code}, ${code}, ${100 + index})
        on conflict (code) do nothing`.execute(db);
    }
    platformActorId = randomUUID();
    // A Platform account (company_id NULL). Disabled, so it needs no role; it
    // only has to exist for audit_events.actor_account_id.
    await sql`insert into accounts(id, company_id, account_kind, username, password_hash, status)
      values (${platformActorId}::uuid, null, 'platform_administrator',
              ${`accmode.platform.${platformActorId}`}, 'x', 'disabled')`.execute(db);
  });

  afterAll(async () => {
    await db?.destroy();
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  async function createCompany(): Promise<{ id: string; code: string }> {
    const id = randomUUID();
    const code = `ACCMODE-${id.slice(0, 8)}`;
    await sql`insert into companies(id, code, subdomain, name_en, status, activated_at)
      values (${id}::uuid, ${code}, ${`accmode-${id.slice(0, 8)}`}, 'Accounting mode test',
              'active', now())`.execute(db);
    return { code, id };
  }

  /** The real new-Company setup path: the approved template, as Platform applies it. */
  async function createTemplateCompany(): Promise<{ id: string; code: string }> {
    const company = await createCompany();
    await db.transaction().execute((transaction) =>
      importer.apply(transaction, {
        actorAccountId: null,
        baseCurrency: "AED",
        companyId: company.id,
        effectiveFrom: today,
        templateCode: "UAE_DELIVERY_STANDARD",
        templateVersion: 3,
      }),
    );
    return company;
  }

  /**
   * A Company exactly as an existing accounting-ON Company looks today:
   * complete setup and `accounting_enabled = true`, set BEFORE this feature
   * is exercised (the state a pre-existing production row is already in).
   */
  async function createEnabledCompany() {
    const company = await createTemplateCompany();
    await sql`update accounting_configurations
                 set accounting_enabled = true, version = version + 1
               where company_id = ${company.id}::uuid`.execute(db);
    return company;
  }

  async function companyAccount(companyId: string): Promise<string> {
    const id = randomUUID();
    await sql`insert into accounts(id, company_id, account_kind, username, password_hash, status)
      values (${id}::uuid, ${companyId}::uuid, 'company_user', ${`accmode.${id}`}, 'x', 'disabled')`.execute(
      db,
    );
    return id;
  }

  /** Calls the SAME capture function every operational trigger calls. */
  async function capture(companyId: string, sourceId = randomUUID()) {
    await sql`select enqueue_operational_accounting_event(
        ${companyId}::uuid, 'orders', 'order_delivered', 'order', ${sourceId}::uuid,
        ${`ORD-${sourceId.slice(0, 6)}`}, current_date, null::uuid, ${randomUUID()})`.execute(db);
    return sourceId;
  }

  async function config(companyId: string) {
    const row = await sql<{
      accountingEnabled: boolean;
      automaticPostingEnabled: boolean;
      version: string;
    }>`select accounting_enabled as "accountingEnabled",
              automatic_posting_enabled as "automaticPostingEnabled", version::text as version
         from accounting_configurations where company_id = ${companyId}::uuid`.execute(db);
    return row.rows[0];
  }

  async function count(table: string, companyId: string, extra = sql``): Promise<number> {
    const row = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}
      where company_id = ${companyId}::uuid ${extra}`.execute(db);
    return row.rows[0]!.n;
  }

  /** Every accounting-relevant row of one Company, as a single hash. */
  async function accountingFingerprint(companyId: string): Promise<string> {
    const row = await sql<{ payload: string | null }>`
      select string_agg(payload, '|' order by payload) as payload from (
        select 'evt:' || to_jsonb(e)::text as payload from accounting_events e
         where e.company_id = ${companyId}::uuid
        union all
        select 'jrn:' || to_jsonb(j)::text from journal_entries j where j.company_id = ${companyId}::uuid
        union all
        select 'lin:' || to_jsonb(l)::text from journal_lines l where l.company_id = ${companyId}::uuid
        union all
        select 'per:' || to_jsonb(p)::text from accounting_periods p where p.company_id = ${companyId}::uuid
        union all
        select 'fy:' || to_jsonb(y)::text from fiscal_years y where y.company_id = ${companyId}::uuid
        union all
        select 'map:' || to_jsonb(m)::text from account_mappings m where m.company_id = ${companyId}::uuid
        union all
        select 'coa:' || to_jsonb(a)::text from chart_of_accounts a where a.company_id = ${companyId}::uuid
      ) s`.execute(db);
    return createHash("sha256")
      .update(row.rows[0]?.payload ?? "")
      .digest("hex");
  }

  /** Write-side state the previews must never move. */
  async function writeSurface(companyId: string) {
    return {
      audit: await count("audit_events", companyId),
      config: await config(companyId),
      events: await count("accounting_events", companyId),
      fingerprint: await accountingFingerprint(companyId),
      history: await count("accounting_configuration_history", companyId),
    };
  }

  /** A real, balanced, POSTED journal for history-preservation checks. */
  async function postedJournal(companyId: string): Promise<string> {
    const creator = await companyAccount(companyId);
    const period = await sql<{ id: string; fiscalYearId: string }>`
      select p.id, p.fiscal_year_id as "fiscalYearId" from accounting_periods p
       where p.company_id = ${companyId}::uuid and ${today}::date between p.period_start and p.period_end`.execute(
      db,
    );
    const accounts = await sql<{ id: string }>`
      select id from chart_of_accounts
       where company_id = ${companyId}::uuid and is_active and is_posting_account
         and not is_control_account and account_type in ('asset','revenue')
       order by account_type, code limit 2`.execute(db);
    const [debitAccount, creditAccount] = accounts.rows;
    const journalId = randomUUID();
    await db.transaction().execute(async (transaction) => {
      await sql`insert into journal_entries(
          id, company_id, journal_number, accounting_period_id, fiscal_year_id, business_date,
          source_type, description, created_by_account_id, journal_type)
        values (${journalId}::uuid, ${companyId}::uuid, ${`JRN-T-${journalId.slice(0, 6)}`},
          ${period.rows[0]!.id}::uuid, ${period.rows[0]!.fiscalYearId}::uuid, ${today}::date,
          'manual', 'Accounting mode history fixture', ${creator}::uuid, 'manual')`.execute(
        transaction,
      );
      await sql`insert into journal_lines(company_id, journal_entry_id, account_id, debit, credit, line_number)
        values (${companyId}::uuid, ${journalId}::uuid, ${debitAccount!.id}::uuid, 25, 0, 1),
               (${companyId}::uuid, ${journalId}::uuid, ${creditAccount!.id}::uuid, 0, 25, 2)`.execute(
        transaction,
      );
      // draft -> balanced -> approved -> posted, through the journal's own guards.
      await sql`update journal_entries set status = 'balanced', version = version + 1
                 where id = ${journalId}::uuid`.execute(transaction);
      await sql`update journal_entries
                   set status = 'approved', approved_by_account_id = ${creator}::uuid,
                       approved_at = now(), version = version + 1
                 where id = ${journalId}::uuid`.execute(transaction);
      await sql`update journal_entries
                   set status = 'posted', posted_by_account_id = ${creator}::uuid,
                       posted_at = now(), version = version + 1
                 where id = ${journalId}::uuid`.execute(transaction);
    });
    return journalId;
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

  const actor = () => ({ accountId: platformActorId, correlationId: `accmode-${randomUUID()}` });

  async function enableFor(companyId: string, reason = "Company is ready for GL") {
    const preview = await service.previewEnable(companyId);
    return service.enable(
      companyId,
      {
        confirmation: preview.confirmation,
        expectedConfigurationVersion: preview.expectedConfigurationVersion,
        reason,
      },
      actor(),
    );
  }

  async function disableFor(companyId: string, reason = "Company does not use GL") {
    const preview = await service.previewDisable(companyId);
    return service.disable(
      companyId,
      {
        confirmation: preview.confirmation,
        expectedConfigurationVersion: preview.expectedConfigurationVersion,
        reason,
      },
      actor(),
    );
  }

  // ---------------------------------------------------------------------------
  // 1-4, 17. Defaults and existing-Company compatibility
  // ---------------------------------------------------------------------------

  it("1. creates a NEW Company with Accounting OFF, with the full template setup in place", async () => {
    const company = await createTemplateCompany();
    expect(await config(company.id)).toMatchObject({
      accountingEnabled: false,
      automaticPostingEnabled: false,
    });
    // The setup is complete, so OFF is a choice, not a missing setup.
    expect(await count("chart_of_accounts", company.id)).toBeGreaterThan(2);
    expect(await count("account_mappings", company.id)).toBeGreaterThan(0);
    // And OFF really is OFF: the capture function writes nothing.
    await capture(company.id);
    expect(await count("accounting_events", company.id)).toBe(0);
    expect((await service.status(company.id)).accountingMode).toBe("disabled");
  });

  it("2 + 17. an existing ENABLED Company stays enabled and still captures events as before", async () => {
    const company = await createEnabledCompany();
    const before = await config(company.id);
    await service.status(company.id);
    await service.previewEnable(company.id);
    await service.previewDisable(company.id);
    expect(await config(company.id)).toEqual(before);
    expect(before?.accountingEnabled).toBe(true);
    const sourceId = await capture(company.id);
    const events = await sql<{ status: string; area: string }>`
      select processing_status as status, operational_area as area from accounting_events
       where company_id = ${company.id}::uuid and source_entity_id = ${sourceId}::uuid`.execute(db);
    expect(events.rows).toEqual([{ area: "orders", status: "received" }]);
  });

  it("3. an existing DISABLED Company stays disabled and captures nothing", async () => {
    const company = await createTemplateCompany();
    const before = await writeSurface(company.id);
    await service.status(company.id);
    await service.previewEnable(company.id);
    await service.previewDisable(company.id);
    expect(await writeSurface(company.id)).toEqual(before);
    await capture(company.id);
    expect(await count("accounting_events", company.id)).toBe(0);
  });

  it("4. a Company with NO configuration stays OFF and is never given a row", async () => {
    const company = await createCompany();
    const status = await service.status(company.id);
    expect(status).toMatchObject({
      accountingEnabled: false,
      accountingMode: "disabled",
      configurationExists: false,
    });
    const preview = await service.previewEnable(company.id);
    expect(preview.executable).toBe(false);
    expect(preview.blockers.map((b) => b.code)).toContain("accounting_configuration");
    const refused = await refusal(enableFor(company.id));
    expect(refused.errorCode).toBe("accounting_enable_blocked");
    expect(await count("accounting_configurations", company.id)).toBe(0);
    expect(await count("audit_events", company.id)).toBe(0);
    await capture(company.id);
    expect(await count("accounting_events", company.id)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 5, 6, 13, 15, 16. Enable
  // ---------------------------------------------------------------------------

  it("5 + 13 + 15. enables only after a read-only preview, and audits the change", async () => {
    const company = await createTemplateCompany();
    const before = await writeSurface(company.id);
    const preview = await service.previewEnable(company.id);
    expect(await writeSurface(company.id)).toEqual(before); // 13: zero writes
    expect(preview).toMatchObject({
      alreadyEnabled: false,
      blockers: [],
      confirmation: enableConfirmationFor(company.code),
      effects: { automaticPostingAfterEnable: false, backfillOfDisabledPeriod: "none" },
      executable: true,
    });

    const correlationId = `accmode-enable-${randomUUID()}`;
    const result = await service.enable(
      company.id,
      {
        confirmation: preview.confirmation,
        expectedConfigurationVersion: preview.expectedConfigurationVersion,
        reason: "Company starts using GL",
      },
      { accountId: platformActorId, correlationId },
    );
    expect(result.changed).toBe(true);
    const after = await config(company.id);
    expect(after).toMatchObject({ accountingEnabled: true, automaticPostingEnabled: false });
    expect(BigInt(after!.version)).toBe(BigInt(before.config!.version) + 1n);

    const audit = await sql<Record<string, unknown>>`
      select actor_account_id::text as actor, action, subject_id as subject, reason,
             before_data as before, after_data as after, correlation_id as correlation,
             actor_role as role, source
        from audit_events where company_id = ${company.id}::uuid`.execute(db);
    expect(audit.rows).toEqual([
      {
        action: "platform.company.accounting_enabled",
        actor: platformActorId,
        after: expect.objectContaining({ accountingEnabled: true }),
        before: expect.objectContaining({ accountingEnabled: false }),
        correlation: correlationId,
        reason: "Company starts using GL",
        role: "platform_administrator",
        source: "platform_portal",
        subject: company.id,
      },
    ]);
    // The configuration history row is attributed to no Company user.
    const history = await sql<{ by: string | null; reason: string | null }>`
      select changed_by_account_id::text as by, change_reason as reason
        from accounting_configuration_history
       where company_id = ${company.id}::uuid and configuration_version = ${after!.version}::bigint`.execute(
      db,
    );
    expect(history.rows).toEqual([
      { by: null, reason: "Platform: Accounting enabled. Company starts using GL" },
    ]);
  });

  it("6 + 16. refuses to enable while required setup is missing, and writes nothing", async () => {
    const company = await createCompany();
    // A configuration row, but no chart of accounts, mappings or fiscal calendar.
    await sql`insert into accounting_configurations(company_id) values (${company.id}::uuid)`.execute(
      db,
    );
    const before = await writeSurface(company.id);
    const preview = await service.previewEnable(company.id);
    const codes = preview.blockers.map((b) => `${b.code}${b.detail ? `:${b.detail}` : ""}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        "open_fiscal_year",
        "open_fiscal_period",
        "two_posting_accounts",
        `open_fiscal_period_for_activation_date:${today}`,
        "required_mapping_missing:orders:order_cod_receivable",
      ]),
    );
    const refused = await refusal(enableFor(company.id));
    expect(refused.errorCode).toBe("accounting_enable_blocked");
    expect(refused.validationDetails).toEqual(
      expect.arrayContaining([
        "open_fiscal_period",
        "required_mapping_missing:orders:order_cod_receivable",
      ]),
    );
    expect(await writeSurface(company.id)).toEqual(before);
  });

  it("16. refuses a wrong confirmation or a stale preview without writing", async () => {
    const company = await createTemplateCompany();
    const preview = await service.previewEnable(company.id);
    const before = await writeSurface(company.id);
    const mismatch = await refusal(
      service.enable(
        company.id,
        {
          confirmation: `ENABLE ACCOUNTING SOMEONE-ELSE`,
          expectedConfigurationVersion: preview.expectedConfigurationVersion,
          reason: "x",
        },
        actor(),
      ),
    );
    expect(mismatch.errorCode).toBe("accounting_mode_confirmation_mismatch");
    const stale = await refusal(
      service.enable(
        company.id,
        { confirmation: preview.confirmation, expectedConfigurationVersion: "999999", reason: "x" },
        actor(),
      ),
    );
    expect(stale.errorCode).toBe("accounting_mode_preview_stale");
    const noReason = await refusal(
      service.enable(
        company.id,
        {
          confirmation: preview.confirmation,
          expectedConfigurationVersion: preview.expectedConfigurationVersion,
          reason: "   ",
        },
        actor(),
      ),
    );
    expect(noReason.errorCode).toBe("accounting_mode_reason_required");
    expect(await writeSurface(company.id)).toEqual(before);
  });

  // ---------------------------------------------------------------------------
  // 7-10, 14. Disable
  // ---------------------------------------------------------------------------

  it("7 + 14 + 15. disables with no unresolved work, after a read-only preview, and audits it", async () => {
    const company = await createEnabledCompany();
    const before = await writeSurface(company.id);
    const preview = await service.previewDisable(company.id);
    expect(await writeSurface(company.id)).toEqual(before); // 14: zero writes
    expect(preview).toMatchObject({
      attentionRequired: false,
      confirmation: disableConfirmationFor(company.code),
      executable: true,
    });
    const result = await disableFor(company.id, "Company keeps its books elsewhere");
    expect(result.changed).toBe(true);
    expect("postDisableVerification" in result && result.postDisableVerification).toMatchObject({
      failed: 0,
      otherUnresolved: 0,
      pending: 0,
    });
    expect(await config(company.id)).toMatchObject({ accountingEnabled: false });
    const audit = await sql<{ action: string; reason: string }>`
      select action, reason from audit_events where company_id = ${company.id}::uuid`.execute(db);
    expect(audit.rows).toEqual([
      {
        action: "platform.company.accounting_disabled",
        reason: "Company keeps its books elsewhere",
      },
    ]);
    // OFF really is OFF for future operations.
    await capture(company.id);
    expect(await count("accounting_events", company.id)).toBe(0);
  });

  it("8 + 16. refuses to disable while events are PENDING, and changes nothing", async () => {
    const company = await createEnabledCompany();
    await capture(company.id);
    const before = await writeSurface(company.id);
    const preview = await service.previewDisable(company.id);
    expect(preview.attentionRequired).toBe(true);
    expect(preview.unresolved.pending).toBe(1);
    expect(preview.unresolved.sampleEventIds).toHaveLength(1);
    const refused = await refusal(disableFor(company.id));
    expect(refused.errorCode).toBe("accounting_disable_requires_attention");
    expect(refused.validationDetails).toContain("pending_accounting_events:1");
    expect(await writeSurface(company.id)).toEqual(before);
  });

  it("9 + 16. refuses to disable while events have FAILED, and changes nothing", async () => {
    const company = await createEnabledCompany();
    const sourceId = await capture(company.id);
    await sql`update accounting_events set processing_status = 'failed'
               where company_id = ${company.id}::uuid and source_entity_id = ${sourceId}::uuid`.execute(
      db,
    );
    const before = await writeSurface(company.id);
    const refused = await refusal(disableFor(company.id));
    expect(refused.errorCode).toBe("accounting_disable_requires_attention");
    expect(refused.validationDetails).toContain("failed_accounting_events:1");
    expect(refused.validationDetails).not.toContain("pending_accounting_events:1");
    expect(await writeSurface(company.id)).toEqual(before);
  });

  it("10 + 11. disable and re-enable leave history untouched and backfill nothing", async () => {
    const company = await createEnabledCompany();
    // History: a resolved Accounting Event and a POSTED journal.
    const historicalSource = await capture(company.id);
    await sql`update accounting_events set processing_status = 'ignored_no_accounting_required'
               where company_id = ${company.id}::uuid and source_entity_id = ${historicalSource}::uuid`.execute(
      db,
    );
    const journalId = await postedJournal(company.id);
    const history = await accountingFingerprint(company.id);

    await disableFor(company.id);
    expect(await accountingFingerprint(company.id)).toBe(history); // 10

    // While OFF, an operation runs: the capture path records nothing.
    const offPeriodSource = await capture(company.id);
    expect(await accountingFingerprint(company.id)).toBe(history);

    const reenabled = await enableFor(company.id, "Back on GL");
    expect(reenabled.changed).toBe(true);
    // 11: the OFF-period operation was NOT backfilled, and history is intact.
    expect(await accountingFingerprint(company.id)).toBe(history);
    const offPeriodEvents = await sql<{ n: number }>`
      select count(*)::int as n from accounting_events
       where company_id = ${company.id}::uuid and source_entity_id = ${offPeriodSource}::uuid`.execute(
      db,
    );
    expect(offPeriodEvents.rows[0]!.n).toBe(0);
    const journal = await sql<{ status: string }>`
      select status from journal_entries where id = ${journalId}::uuid`.execute(db);
    expect(journal.rows[0]!.status).toBe("posted");
    // Operations AFTER re-enable are captured again.
    await capture(company.id);
    expect(
      await count("accounting_events", company.id, sql`and processing_status = 'received'`),
    ).toBe(1);
    // Both changes are audited, in order.
    const audit = await sql<{ action: string }>`
      select action from audit_events where company_id = ${company.id}::uuid order by occurred_at`.execute(
      db,
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      "platform.company.accounting_disabled",
      "platform.company.accounting_enabled",
    ]);
  });

  it("is idempotent: enabling an enabled Company or disabling a disabled one writes nothing", async () => {
    const on = await createEnabledCompany();
    const off = await createTemplateCompany();
    const onBefore = await writeSurface(on.id);
    const offBefore = await writeSurface(off.id);
    expect((await enableFor(on.id)).changed).toBe(false);
    expect((await disableFor(off.id)).changed).toBe(false);
    expect(await writeSurface(on.id)).toEqual(onBefore);
    expect(await writeSurface(off.id)).toEqual(offBefore);
  });

  // ---------------------------------------------------------------------------
  // 12. Tenant isolation
  // ---------------------------------------------------------------------------

  it("12. changing Company A never reads into or modifies Company B", async () => {
    const companyA = await createEnabledCompany();
    const companyB = await createEnabledCompany();
    // B has unresolved work; it must not block A, and A's change must not touch B.
    await capture(companyB.id);
    const bBefore = await writeSurface(companyB.id);

    // A's confirmation cannot be satisfied with B's code.
    const previewA = await service.previewDisable(companyA.id);
    const crossed = await refusal(
      service.disable(
        companyA.id,
        {
          confirmation: disableConfirmationFor(companyB.code),
          expectedConfigurationVersion: previewA.expectedConfigurationVersion,
          reason: "x",
        },
        actor(),
      ),
    );
    expect(crossed.errorCode).toBe("accounting_mode_confirmation_mismatch");

    expect(previewA.unresolved.pending).toBe(0);
    expect((await disableFor(companyA.id)).changed).toBe(true);
    expect(await config(companyA.id)).toMatchObject({ accountingEnabled: false });
    expect(await writeSurface(companyB.id)).toEqual(bBefore);

    // And B's own disable is still refused by B's own pending event.
    const refusedB = await refusal(disableFor(companyB.id));
    expect(refusedB.validationDetails).toContain("pending_accounting_events:1");

    // An unknown Company UUID is a 404, never another Company.
    const unknown = await refusal(service.previewDisable(randomUUID()));
    expect(unknown.errorCode).toBe("company_not_found");
  });

  // ---------------------------------------------------------------------------
  // A1. Enabled-area readiness
  // ---------------------------------------------------------------------------

  it("A1. blocks enable on an ENABLED area's missing setup, grouped by area; a disabled area only warns", async () => {
    const company = await createTemplateCompany();
    // Payroll ENABLED but its mapping removed; general expenses DISABLED and unmapped too.
    await sql`update accounting_configurations
                 set automatic_posting_areas = array['orders','employee_payroll'], version = version + 1
               where company_id = ${company.id}::uuid`.execute(db);
    await sql`update account_mappings set is_active = false
               where company_id = ${company.id}::uuid
                 and mapping_key in ('employee_payroll_payable','general_expense_payable')`.execute(
      db,
    );
    const preview = await service.previewEnable(company.id);
    expect(preview.enabledAreas).toEqual(["orders", "employee_payroll"]);
    expect(preview.enabledAreasSource).toBe("configured");
    expect(preview.blockersByArea).toEqual({
      employee_payroll: {
        invalid_mapping: [],
        missing_mapping: ["employee_payroll_payable"],
        other: [],
      },
    });
    expect(preview.warningsByArea.general_expenses?.missing_mapping).toContain(
      "general_expense_payable",
    );
    const refused = await refusal(enableFor(company.id));
    expect(refused.errorCode).toBe("accounting_enable_blocked");
    expect(refused.validationDetails).toEqual([
      "required_mapping_missing:employee_payroll:employee_payroll_payable",
    ]);
    expect(await config(company.id)).toMatchObject({ accountingEnabled: false });
  });

  it("A1. a GL-less cash drawer (created while OFF) blocks enable; an ON Company can never get one", async () => {
    const off = await createTemplateCompany();
    const actorId = await companyAccount(off.id);
    await sql`insert into company_cash_accounts(company_id,cash_account_code,cash_account_name,
        cash_account_type,effective_from,created_by_account_id)
      values (${off.id}::uuid,'CASH-NOGL','Drawer without GL','petty_cash',current_date,
              ${actorId}::uuid)`.execute(db);
    const preview = await service.previewEnable(off.id);
    expect(preview.blockers).toEqual([
      // The enabled Cash/Bank area's own readiness also flags it...
      { code: "cash_bank_linked_gl_invalid", detail: "cash_bank_management" },
      // ...and the drawer blocks whichever areas are enabled.
      { code: "cash_account_without_gl", detail: "CASH-NOGL" },
    ]);

    const on = await createEnabledCompany();
    const onActor = await companyAccount(on.id);
    await expect(
      sql`insert into company_cash_accounts(company_id,cash_account_code,cash_account_name,
          cash_account_type,effective_from,created_by_account_id)
        values (${on.id}::uuid,'CASH-NOGL','Drawer without GL','petty_cash',current_date,
                ${onActor}::uuid)`.execute(db),
    ).rejects.toThrow(/accounting_cash_account_gl_required/u);
  });

  // ---------------------------------------------------------------------------
  // A2. Disable concurrency
  // ---------------------------------------------------------------------------

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

  /** Captures one Event inside a transaction that stays open until released. */
  function inFlightCapture(companyId: string, outcome: "commit" | "rollback") {
    const captured = deferred();
    const release = deferred();
    const done = db
      .transaction()
      .execute(async (transaction) => {
        await sql`select enqueue_operational_accounting_event(
            ${companyId}::uuid, 'orders', 'order_delivered', 'order', ${randomUUID()}::uuid,
            'ORD-INFLIGHT', current_date, null::uuid, ${randomUUID()})`.execute(transaction);
        captured.resolve();
        await release.promise;
        if (outcome === "rollback") throw new Error("rolled back on purpose");
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.message === "rolled back on purpose")) throw error;
      });
    return { captured: captured.promise, done, release: release.resolve };
  }

  it("A2. disable WAITS for an in-flight capture, then refuses with it reported; other Companies are not blocked", async () => {
    const company = await createEnabledCompany();
    const other = await createEnabledCompany();
    const operation = inFlightCapture(company.id, "commit");
    await operation.captured;

    // Company B is not blocked by Company A's open operation.
    const otherResult = await disableFor(other.id);
    expect(otherResult.changed).toBe(true);

    let settled = false;
    const disabling = disableFor(company.id).finally(() => {
      settled = true;
    });
    await pause(600);
    expect(settled).toBe(false); // waiting on the in-flight operation's lock
    operation.release();
    await operation.done;
    const refused = await refusal(disabling);
    expect(refused.errorCode).toBe("accounting_disable_requires_attention");
    expect(refused.validationDetails).toContain("pending_accounting_events:1");
    expect(await config(company.id)).toMatchObject({ accountingEnabled: true });
  });

  it("A2. when the in-flight operation rolls back, disable succeeds cleanly", async () => {
    const company = await createEnabledCompany();
    const operation = inFlightCapture(company.id, "rollback");
    await operation.captured;
    const disabling = disableFor(company.id);
    await pause(300);
    operation.release();
    await operation.done;
    const result = await disabling;
    expect(result).toMatchObject({ changed: true, outcome: "disabled" });
    expect(await count("accounting_events", company.id)).toBe(0);
  });

  it("A2. a capture that arrives while the disable holds the row waits, then records nothing", async () => {
    const company = await createEnabledCompany();
    const disableHeld = deferred();
    const releaseDisable = deferred();
    // Mimic the disable's row lock and flag change, held open.
    const disabling = db.transaction().execute(async (transaction) => {
      await sql`select 1 from accounting_configurations
                 where company_id = ${company.id}::uuid for update`.execute(transaction);
      await sql`update accounting_configurations set accounting_enabled = false, version = version + 1
                 where company_id = ${company.id}::uuid`.execute(transaction);
      disableHeld.resolve();
      await releaseDisable.promise;
    });
    await disableHeld.promise;
    let captureSettled = false;
    const capturing = capture(company.id).finally(() => {
      captureSettled = true;
    });
    await pause(500);
    expect(captureSettled).toBe(false); // the capture gate waits on the row
    releaseDisable.resolve();
    await disabling;
    await capturing;
    expect(await count("accounting_events", company.id)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // The old unguarded path
  // ---------------------------------------------------------------------------

  it("closes the generic configuration save as a way to switch Accounting OFF", async () => {
    const enabled = await createEnabledCompany();
    const disabled = await createTemplateCompany();
    const managementFor = async (companyId: string) => {
      const actorId = await companyAccount(companyId);
      const support = {
        assertPermission: () => undefined,
        audit: async () => undefined,
        completeIdempotency: async () => undefined,
        context: () => ({ actorId, companyId }),
        reserveIdempotency: async () => ({}),
      } as unknown as AccountingOperationSupport;
      return new AccountingManagementService(db, new KyselyTransactionManager(db), support);
    };

    const before = await writeSurface(enabled.id);
    const refused = await refusal(
      (await managementFor(enabled.id)).updateConfiguration({ accountingEnabled: false }, "k"),
    );
    expect(refused.errorCode).toBe("accounting_disable_requires_controlled_operation");
    expect(await writeSurface(enabled.id)).toEqual(before);

    // Already OFF: sending `false` is still accepted and stays OFF.
    await (await managementFor(disabled.id)).updateConfiguration({ accountingEnabled: false }, "k");
    expect(await config(disabled.id)).toMatchObject({ accountingEnabled: false });
  });
});
