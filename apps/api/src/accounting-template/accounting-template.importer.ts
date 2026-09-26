import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { type Transaction, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { loadApprovedTemplate } from "./accounting-template.registry.js";
import type { AccountingTemplate } from "./accounting-template.types.js";

/**
 * Applies an approved Accounting Template to a newly created Company.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN IMPORT IS, AND IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is the creation of Company-owned CONFIGURATION rows from a
 * Company-independent description. It is not a copy of another Company. The
 * template contains no identifier of any kind, so there is nothing to copy even
 * if this code tried: every row created here gets a freshly generated
 * identifier owned by the new Company.
 *
 * The bridge between the two worlds is a runtime map from stable template key
 * to newly created account id, built once as the Chart of Accounts is inserted
 * and then used to resolve every mapping, every named configuration slot and
 * every Cash/Bank GL link. Template keys are NOT persisted in place of foreign
 * keys — the schema uses real account identifiers and so does this.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER OWNS THE TRANSACTION
 * ---------------------------------------------------------------------------
 *
 * The caller passes a transaction and this method only ever throws or returns.
 * That is what makes "a failed import must not leave a half-configured tenant"
 * true by construction rather than by cleanup code: the Company row itself is
 * created in the same transaction, so a throw anywhere below removes the
 * Company as well as its partial Accounting setup.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT CREATED
 * ---------------------------------------------------------------------------
 *
 * No opening balance batch or line. No journal. No journal line. No accounting
 * event. No transaction of any kind. A new Company begins with zero financial
 * history, and `verifyImport` proves it before the caller is allowed to commit.
 */

export interface ImportSummary {
  readonly templateCode: string;
  readonly templateVersion: number;
  readonly templateSha256: string;
  readonly accounts: number;
  readonly accountMappings: number;
  readonly expenseTypes: number;
  readonly generalExpenseCategories: number;
  readonly allowanceTypes: number;
  readonly referencePrefixes: number;
  readonly cashAccounts: number;
  readonly bankAccounts: number;
  readonly businessDayStart: string;
  readonly businessDayTimezone: string;
  readonly fiscalYearStartMonth: number;
  readonly resolvedAccountSlots: number;
  /**
   * Always false. Automatic posting must be enabled by an accountable Company
   * user through the Accounting Setup Wizard - see createConfiguration.
   */
  readonly automaticPostingEnabled: boolean;
  readonly automaticPostingAreas: readonly string[];
  readonly fiscalYearCode: string;
  readonly fiscalYearStart: string;
  readonly fiscalYearEnd: string;
  readonly accountingPeriods: number;
  readonly areas: number;
}

/** Named configuration slots, mapped from template key name to column. */
const configurationSlotColumns: Readonly<Record<string, string>> = {
  accountsPayable: "default_accounts_payable_account_id",
  accountsReceivable: "default_accounts_receivable_account_id",
  bank: "default_bank_account_id",
  cash: "default_cash_account_id",
  currentYearEarnings: "current_year_earnings_account_id",
  deliveryRevenue: "default_delivery_revenue_account_id",
  outsourcedDriverPayable: "default_outsourced_driver_payable_account_id",
  payrollPayable: "default_payroll_payable_account_id",
  retainedEarnings: "retained_earnings_account_id",
  rounding: "default_rounding_account_id",
  serviceFeeRevenue: "default_service_fee_revenue_account_id",
  suspense: "default_suspense_account_id",
  traderPayable: "default_trader_payable_account_id",
  vatInput: "default_vat_input_account_id",
  vatOutput: "default_vat_output_account_id",
};

/**
 * Company-scoped setup rows are created with NO creator account.
 *
 * `created_by_account_id` on every one of these tables is a COMPOSITE foreign
 * key to `accounts(id, company_id)`. A Platform Administrator has
 * `company_id = null`, so naming them here would not merely be inaccurate — the
 * foreign key would reject the row outright. Who performed the onboarding is
 * recorded where it belongs: the Platform audit trail.
 */
const platformCreator = null;

export interface ImportInput {
  readonly companyId: string;
  readonly templateCode: string;
  readonly templateVersion: number;
  readonly actorAccountId: string | null;
  /** The Company's own adoption date — never the source Company's. */
  readonly effectiveFrom: string;
  /** Company base currency selected during onboarding; no FX conversion. */
  readonly baseCurrency: string;
  /**
   * Company-chosen business-day start (HH:MM). Falls back to the template
   * default when the Platform Administrator does not override it.
   */
  readonly businessDayStart?: string | undefined;
}

@Injectable()
export class AccountingTemplateImporter {
  public async apply(
    transaction: Transaction<DatabaseSchema>,
    input: ImportInput,
  ): Promise<ImportSummary> {
    const { template, sha256, approved } = loadApprovedTemplate(
      input.templateCode,
      input.templateVersion,
    );

    const accountIdByKey = await this.createChartOfAccounts(transaction, template, input);
    await this.createAccountMappings(transaction, template, accountIdByKey, input);
    const resolvedSlots = await this.createConfiguration(
      transaction,
      template,
      accountIdByKey,
      input,
    );
    await this.createBalancePolicy(transaction, template, input);
    await this.createCashAndBankAccounts(transaction, template, accountIdByKey, input);
    await this.createExpenseSetup(transaction, template, input);
    await this.createAllowanceTypes(transaction, template, input);
    await this.createReferenceCounters(transaction, template, input);
    // AFTER the reference counters: the `area` counter must already exist,
    // at 1, for the codes reserved here to start at AREA-000001 rather than
    // colliding with whatever `on conflict do nothing` above happened to skip.
    const areasCreated = await this.createAreas(transaction, template, input);
    await this.createBusinessDay(transaction, template, input);
    const fiscal = await this.createFiscalCalendar(transaction, template, input);
    await this.verifyImport(transaction, template, input.companyId);

    return {
      templateCode: approved.templateCode,
      templateVersion: approved.templateVersion,
      templateSha256: sha256,
      accounts: template.accounts.length,
      accountMappings: template.accountMappings.length,
      expenseTypes: template.expenseTypes.length,
      generalExpenseCategories: template.generalExpenseCategories.length,
      allowanceTypes: template.allowanceTypes.length,
      referencePrefixes: template.referenceNumberPrefixes.length,
      cashAccounts: template.defaultCashAccounts.length,
      bankAccounts: template.defaultBankAccounts.length,
      areas: areasCreated,
      businessDayStart: input.businessDayStart ?? template.businessDay.startTime,
      businessDayTimezone: template.businessDay.timezone,
      fiscalYearStartMonth: template.fiscalPolicy.fiscalYearStartMonth,
      resolvedAccountSlots: resolvedSlots,
      automaticPostingEnabled: false,
      automaticPostingAreas:
        template.accountingConfiguration.standardDefaults.automaticPostingAreas,
      fiscalYearCode: fiscal.code,
      fiscalYearStart: fiscal.start,
      fiscalYearEnd: fiscal.end,
      accountingPeriods: fiscal.periods,
    };
  }

  /**
   * Creates the Chart of Accounts and returns the key → new-id map.
   *
   * Parents are inserted before children (the template's hierarchy is already
   * validated as acyclic), so a parent key always resolves by the time a child
   * needs it.
   */
  private async createChartOfAccounts(
    transaction: Transaction<DatabaseSchema>,
    template: AccountingTemplate,
    input: ImportInput,
  ): Promise<Map<string, string>> {
    const byKey = new Map(template.accounts.map((account) => [account.key, account]));
    const idByKey = new Map<string, string>();
    const inserted = new Set<string>();

    const insert = async (key: string, guard: ReadonlySet<string>): Promise<void> => {
      if (inserted.has(key)) return;
      const account = byKey.get(key);
      if (account === undefined) {
        throw new Error(
          `Accounting template references account key '${key}' which it does not define.`,
        );
      }
      if (account.parentAccountKey !== null) {
        if (guard.has(key)) {
          throw new Error(`Accounting template hierarchy contains a cycle at '${key}'.`);
        }
        await insert(account.parentAccountKey, new Set([...guard, key]));
      }
      const id = randomUUID();
      await sql`
        insert into chart_of_accounts (
          id, company_id, parent_account_id, code, name_en, name_ar, account_type, account_class,
          normal_balance, is_posting_account, is_active, is_contra_account, is_control_account,
          control_account_type, is_system_account, system_purpose, currency, description,
          effective_from, created_by_account_id
        ) values (
          ${id}::uuid, ${input.companyId}::uuid,
          ${account.parentAccountKey === null ? null : (idByKey.get(account.parentAccountKey) ?? null)}::uuid,
          ${account.code}, ${account.nameEn}, ${account.nameAr}, ${account.accountType},
          ${account.accountClass}, ${account.normalBalance}, ${account.isPostingAccount},
          ${account.isActive}, ${account.isContraAccount}, ${account.isControlAccount},
          ${account.controlAccountType}, ${account.isSystemAccount}, ${account.systemPurpose},
          ${input.baseCurrency}, ${account.description},
          ${input.effectiveFrom}::date, ${platformCreator}
        )
      `.execute(transaction);
      idByKey.set(key, id);
      inserted.add(key);
    };

    // Deterministic order, so a failure is reproducible.
    for (const account of [...template.accounts].sort((a, b) =>
      a.code.localeCompare(b.code, "en"),
    )) {
      await insert(account.key, new Set());
    }
    return idByKey;
  }

  private resolve(idByKey: ReadonlyMap<string, string>, key: string | null): string | null {
    if (key === null) return null;
    const id = idByKey.get(key);
    if (id === undefined) {
      // The validator already proved every key resolves within the template, so
      // reaching here means the import itself is inconsistent. Aborting is the
      // only safe outcome: a null would silently create a mapping that posts
      // nowhere.
      throw new Error(`Accounting template key '${key}' did not resolve to a created account.`);
    }
    return id;
  }

  private async createAccountMappings(
    transaction: Transaction<DatabaseSchema>,
    template: AccountingTemplate,
    idByKey: ReadonlyMap<string, string>,
    input: ImportInput,
  ): Promise<void> {
    for (const mapping of template.accountMappings) {
      await sql`
        insert into account_mappings (
          id, company_id, mapping_key, debit_account_id, credit_account_id, vat_account_id,
          fee_account_id, expense_account_id, payable_account_id, effective_from, is_active,
          created_by_account_id
        ) values (
          ${randomUUID()}::uuid, ${input.companyId}::uuid, ${mapping.mappingKey},
          ${this.resolve(idByKey, mapping.debitAccountKey)}::uuid,
          ${this.resolve(idByKey, mapping.creditAccountKey)}::uuid,
          ${this.resolve(idByKey, mapping.vatAccountKey)}::uuid,
          ${this.resolve(idByKey, mapping.feeAccountKey)}::uuid,
          ${this.resolve(idByKey, mapping.expenseAccountKey)}::uuid,
          ${this.resolve(idByKey, mapping.payableAccountKey)}::uuid,
          ${input.effectiveFrom}::date, ${mapping.isActive}, ${platformCreator}
        )
      `.execute(transaction);
    }
  }

  /** Returns how many named account slots the template actually filled. */
  private async createConfiguration(
    transaction: Transaction<DatabaseSchema>,
    template: AccountingTemplate,
    idByKey: ReadonlyMap<string, string>,
    input: ImportInput,
  ): Promise<number> {
    const defaults = template.accountingConfiguration.standardDefaults;
    const slots = template.accountingConfiguration.defaultAccountKeys;

    // -----------------------------------------------------------------
    // AUTOMATIC POSTING IS NEVER ENABLED BY AN IMPORT
    // -----------------------------------------------------------------
    //
    // accounting_configurations_automatic_shape_check requires that whenever
    // automatic_posting_enabled is true, automatic_posting_enabled_by_account_id
    // and automatic_posting_enabled_at are both set - and that account column is
    // a COMPOSITE foreign key to accounts(id, company_id).
    //
    // So the schema already insists that switching automatic posting on is an
    // act by an accountable COMPANY user. At Company-creation time no such user
    // exists yet, and a Platform Administrator cannot stand in for one.
    //
    // That is a rule worth keeping rather than working around: automatic posting
    // starts writing to the ledger the moment it is on, and nobody should be
    // able to point at a new tenant and find no one accountable for having
    // enabled it. The template's chosen AREAS are still carried over, so the
    // Company's Accounting Setup Wizard has the intended configuration waiting;
    // only the switch itself is left off.
    //
    // -----------------------------------------------------------------
    // ONE INSERT, NOT AN INSERT THEN AN UPDATE
    // -----------------------------------------------------------------
    //
    // The named account slots are part of the same INSERT. An earlier shape
    // inserted the row and then UPDATEd the slots, which tripped the table's
    // optimistic-locking trigger (accounting_configuration_version_conflict):
    // the configuration is version-guarded precisely so nobody edits it blindly,
    // and creating a row is not an edit.
    //
    // Only the COLUMN names are interpolated, and they come from
    // configurationSlotColumns - a fixed allow-list in this file. Every value
    // remains a bound parameter.
    const slotColumns: string[] = [];
    const slotValues: ReturnType<typeof sql>[] = [];
    for (const [slot, column] of Object.entries(configurationSlotColumns)) {
      const id = this.resolve(idByKey, slots[slot] ?? null);
      if (id === null) continue;
      slotColumns.push(column);
      slotValues.push(sql`${id}::uuid`);
    }
    const extraColumns =
      slotColumns.length > 0
        ? sql`, ${sql.join(
            slotColumns.map((column) => sql.raw(column)),
            sql`, `,
          )}`
        : sql``;
    const extraValues = slotColumns.length > 0 ? sql`, ${sql.join(slotValues, sql`, `)}` : sql``;

    await sql`
      insert into accounting_configurations (
        company_id, accounting_enabled, automatic_posting_enabled, base_currency,
        fiscal_year_start_month, default_accounting_method, segregation_policy,
        automatic_posting_areas, created_by_account_id${extraColumns}
      ) values (
        ${input.companyId}::uuid, ${defaults.accountingEnabled}, false,
        ${input.baseCurrency}, ${defaults.fiscalYearStartMonth},
        ${defaults.defaultAccountingMethod}, ${defaults.segregationPolicy},
        ${[...defaults.automaticPostingAreas]}::text[], ${platformCreator}${extraValues}
      )
    `.execute(transaction);

    return slotColumns.length;
  }

  private async createBalancePolicy(
    transaction: Transaction<DatabaseSchema>,
    template: AccountingTemplate,
    input: ImportInput,
  ): Promise<void> {
    const policy = template.balancePolicy;
    await sql`
      insert into company_balance_policies (
        id, company_id, cash_policy, bank_policy, bank_overdraft_limit, override_permission,
        effective_from, is_active, change_reason, created_by_account_id
      ) values (
        ${randomUUID()}::uuid, ${input.companyId}::uuid, ${policy.cashPolicy}, ${policy.bankPolicy},
        ${policy.bankOverdraftLimit}::numeric, ${policy.overridePermission},
        ${input.effectiveFrom}::date, true,
        'Initial policy applied from the approved Accounting Template',
        ${platformCreator}
      )
    `.execute(transaction);
  }

  /**
   * Cash and Bank definitions.
   *
   * The template carries a SHAPE — a code, a type and a GL link — and no bank
   * identity whatsoever. The placeholder values written here are neutral and
   * are listed in the Company's required inputs, so a Platform Administrator
   * replaces them with the real details. Nothing about another Company's bank
   * or cash custodian can arrive by this path, because the template has no
   * field capable of carrying it.
   */
  private async createCashAndBankAccounts(
    transaction: Transaction<DatabaseSchema>,
    template: AccountingTemplate,
    idByKey: ReadonlyMap<string, string>,
    input: ImportInput,
  ): Promise<void> {
    for (const cash of template.defaultCashAccounts) {
      await sql`
        insert into company_cash_accounts (
          id, company_id, cash_account_code, cash_account_name, cash_account_name_ar,
          cash_account_type, linked_gl_account_id, currency, effective_from, is_active,
          description, created_by_account_id
        ) values (
          ${randomUUID()}::uuid, ${input.companyId}::uuid, ${cash.code}, ${cash.name},
          ${cash.nameAr}, ${cash.cashAccountType},
          ${this.resolve(idByKey, cash.glAccountKey)}::uuid, ${input.baseCurrency},
          ${input.effectiveFrom}::date, ${cash.isActive},
          'Created from the approved Accounting Template', ${platformCreator}
        )
      `.execute(transaction);
    }

    for (const bank of template.defaultBankAccounts) {
      await sql`
        insert into company_bank_accounts (
          id, company_id, bank_account_code, bank_name, account_name, account_type,
          linked_gl_account_id, currency, effective_from, is_active, description,
          created_by_account_id
        ) values (
          ${randomUUID()}::uuid, ${input.companyId}::uuid, ${bank.code}, ${bank.name},
          ${bank.name}, ${bank.accountType},
          ${this.resolve(idByKey, bank.glAccountKey)}::uuid, ${input.baseCurrency},
          ${input.effectiveFrom}::date, ${bank.isActive},
          'Placeholder created from the approved Accounting Template. Enter the Company bank details.',
          ${platformCreator}
        )
      `.execute(transaction);
    }
  }

  private async createExpenseSetup(
    transaction: Transaction<DatabaseSchema>,
    template: AccountingTemplate,
    input: ImportInput,
  ): Promise<void> {
    for (const type of template.expenseTypes) {
      await sql`
        insert into expense_types (id, company_id, code, name_en, name_ar, display_name, is_active)
        values (
          ${randomUUID()}::uuid, ${input.companyId}::uuid, ${type.code}, ${type.nameEn},
          ${type.nameAr}, ${type.displayName}, ${type.isActive}
        )
        on conflict (company_id, lower(code)) do nothing
      `.execute(transaction);
    }
    for (const category of template.generalExpenseCategories) {
      await sql`
        insert into general_expense_categories (
          id, company_id, code, name_en, name_ar, description, default_expense_mapping_key,
          default_vat_treatment, is_active, effective_from, created_by_account_id
        ) values (
          ${randomUUID()}::uuid, ${input.companyId}::uuid, ${category.code}, ${category.nameEn},
          ${category.nameAr}, ${category.description}, ${category.defaultExpenseMappingKey},
          ${category.defaultVatTreatment}, ${category.isActive}, ${input.effectiveFrom}::date,
          ${platformCreator}
        )
      `.execute(transaction);
    }
  }

  private async createAllowanceTypes(
    transaction: Transaction<DatabaseSchema>,
    template: AccountingTemplate,
    input: ImportInput,
  ): Promise<void> {
    for (const allowance of template.allowanceTypes) {
      await sql`
        insert into allowance_types (id, company_id, code, name, name_ar, is_active)
        values (
          ${randomUUID()}::uuid, ${input.companyId}::uuid, ${allowance.code}, ${allowance.name},
          ${allowance.nameAr}, ${allowance.isActive}
        )
      `.execute(transaction);
    }
  }

  /**
   * Reference prefixes, with counters that always start at 1.
   *
   * `company_reference_counters` is keyed `(company_id, reference_type)` and
   * every business reference built from it is unique per Company, so two
   * Companies initialised from the same template can both start at ORD-1
   * without colliding. The source Company's watermark is not in the template
   * and is not consulted.
   */
  private async createReferenceCounters(
    transaction: Transaction<DatabaseSchema>,
    template: AccountingTemplate,
    input: ImportInput,
  ): Promise<void> {
    for (const prefix of template.referenceNumberPrefixes) {
      await sql`
        insert into company_reference_counters (company_id, reference_type, prefix, next_value)
        values (${input.companyId}::uuid, ${prefix.referenceType}, ${prefix.prefix}, 1)
        on conflict (company_id, reference_type) do nothing
      `.execute(transaction);
    }
  }

  /**
   * Delivery Areas, from the template's canonical list.
   *
   * Absent for a `schemaVersion: 1` template — `template.areas` is optional so
   * older templates parse unchanged — in which case a Company starts with
   * none, exactly as it did before this section existed.
   *
   * Codes are reserved from the `area` reference counter in ONE update for the
   * whole batch, immediately after `createReferenceCounters` has set it to 1,
   * so an Area created by hand afterwards can never be handed a code this
   * import already used.
   */
  private async createAreas(
    transaction: Transaction<DatabaseSchema>,
    template: AccountingTemplate,
    input: ImportInput,
  ): Promise<number> {
    const areas = template.areas ?? [];
    if (areas.length === 0) return 0;

    const emirates = (
      await sql<{ code: string; id: string }>`select id, code from emirates`.execute(transaction)
    ).rows;
    const emirateByCode = new Map(emirates.map((row) => [row.code, row.id]));
    const rows = areas
      .map((area) => ({ ...area, emirateId: emirateByCode.get(area.emirateCode) }))
      .filter((area): area is (typeof areas)[number] & { emirateId: string } => area.emirateId !== undefined);
    if (rows.length === 0) return 0;

    const reserved = (
      await sql<{ prefix: string; start: string }>`
        update company_reference_counters
           set next_value = next_value + ${rows.length}, updated_at = now()
         where company_id = ${input.companyId}::uuid and reference_type = 'area'
        returning prefix, (next_value - ${rows.length})::text as start
      `.execute(transaction)
    ).rows[0];
    if (reserved === undefined) return 0;
    const start = Number(reserved.start);

    const values = rows.map(
      (area, index) =>
        sql`(
          ${input.companyId}::uuid,
          ${`${reserved.prefix}-${String(start + index).padStart(6, "0")}`},
          ${area.emirateId}::uuid,
          ${area.nameEn},
          ${area.nameAr},
          true
        )`,
    );
    const inserted = await sql<{ id: string }>`
      insert into areas (company_id, code, emirate_id, name_en, name_ar, is_active)
      values ${sql.join(values, sql`, `)}
      on conflict do nothing
      returning id
    `.execute(transaction);
    return inserted.rows.length;
  }

  /**
   * The initial business-day rule only.
   *
   * `effective_from` is left null so the rule applies from the beginning of the
   * Company's history. Superseded rules from the source Company are not in the
   * template and no history row is fabricated here.
   */
  private async createBusinessDay(
    transaction: Transaction<DatabaseSchema>,
    template: AccountingTemplate,
    input: ImportInput,
  ): Promise<void> {
    await sql`
      insert into company_business_day_configurations (
        id, company_id, timezone, business_day_start, effective_from, is_active,
        change_reason, created_by_account_id
      ) values (
        ${randomUUID()}::uuid, ${input.companyId}::uuid, ${template.businessDay.timezone},
        ${`${input.businessDayStart ?? template.businessDay.startTime}:00`}::time,
        '-infinity'::date, true,
        'Initial business-day rule applied from the approved Accounting Template',
        ${platformCreator}
      )
    `.execute(transaction);
  }

  /**
   * Generates the Company's OWN fiscal year and periods.
   *
   * -----------------------------------------------------------------
   * POLICY IS TEMPLATED; THE CALENDAR IS NOT
   * -----------------------------------------------------------------
   *
   * The template carries a fiscal *policy* — start month, period model, periods
   * per year — and deliberately no dated rows. Cloning a source Company's dated
   * year would hand a Company created in 2027 a calendar belonging to 2026, and
   * `validate_accounting_period_calendar` would then refuse every period while
   * `assert_period_open_for_posting` refused every posting.
   *
   * So the year is derived from the NEW Company's own start date: the fiscal
   * year that CONTAINS that date, given the policy's start month. With a
   * January start and an August creation date, that is 1 Jan - 31 Dec of the
   * same year; with an April start it would be April of the same year, and with
   * a creation date in February it would be April of the PREVIOUS year.
   *
   * -----------------------------------------------------------------
   * EXACTLY ONE PERIOD IS CREATED `open` — THE ONE CONTAINING TODAY
   * -----------------------------------------------------------------
   *
   * Every OTHER period still sits at `future` until someone opens it — that
   * part of the original reasoning stands: opening a period ahead of its own
   * time is a real accounting decision with a posting consequence, and
   * onboarding must not make that call for periods that have not arrived yet.
   *
   * The one period covering the Company's own creation date is different: a
   * Company created today, using an approved template, has nothing to decide
   * about THAT period — of course today can post. Leaving it `future` too
   * meant Automatic Posting was unconditionally blocked for every new
   * Company until a human found the Fiscal Periods screen and opened it by
   * hand, which is the exact first-day friction the standard starter roles
   * fix (see standard-company-roles.ts) was already removing for Roles.
   * Decided 2026-08-15, at the request of the person actually onboarding
   * Companies.
   */
  private async createFiscalCalendar(
    transaction: Transaction<DatabaseSchema>,
    template: AccountingTemplate,
    input: ImportInput,
  ): Promise<{ code: string; start: string; end: string; periods: number }> {
    const startMonth = template.fiscalPolicy.fiscalYearStartMonth;
    const [year, month] = input.effectiveFrom.split("-").map(Number) as [number, number, number];
    // The fiscal year containing the Company's start date.
    const startYear = month >= startMonth ? year : year - 1;

    const pad = (value: number): string => String(value).padStart(2, "0");
    const monthStart = (offset: number): { y: number; m: number } => {
      const absolute = startMonth - 1 + offset;
      return { y: startYear + Math.floor(absolute / 12), m: (absolute % 12) + 1 };
    };
    const lastDay = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

    const first = monthStart(0);
    const last = monthStart(template.fiscalPolicy.periodsPerYear - 1);
    const yearStart = `${first.y}-${pad(first.m)}-01`;
    const yearEnd = `${last.y}-${pad(last.m)}-${pad(lastDay(last.y, last.m))}`;
    const code = `FY-${startYear}`;

    const fiscalYearId = randomUUID();
    await sql`
      insert into fiscal_years (
        id, company_id, fiscal_year_code, name, start_date, end_date, status,
        created_by_account_id, opened_at
      ) values (
        ${fiscalYearId}::uuid, ${input.companyId}::uuid, ${code},
        ${`Fiscal Year ${startYear}`}, ${yearStart}::date, ${yearEnd}::date, 'open',
        ${platformCreator}, now()
      )
    `.execute(transaction);

    for (let index = 0; index < template.fiscalPolicy.periodsPerYear; index += 1) {
      const period = monthStart(index);
      const periodStart = `${period.y}-${pad(period.m)}-01`;
      const periodEnd = `${period.y}-${pad(period.m)}-${pad(lastDay(period.y, period.m))}`;
      // Only the period covering the Company's own creation date opens
      // immediately -- see this method's own comment above for why.
      const status = input.effectiveFrom >= periodStart && input.effectiveFrom <= periodEnd
        ? "open"
        : "future";
      await sql`
        insert into accounting_periods (
          id, company_id, fiscal_year_id, period_number, period_code, name,
          period_start, period_end, status, is_adjustment_period, created_by_account_id,
          opened_at, opened_by_account_id
        ) values (
          ${randomUUID()}::uuid, ${input.companyId}::uuid, ${fiscalYearId}::uuid,
          ${index + 1}, ${`${startYear}-P${pad(index + 1)}`}, ${`Period ${index + 1}`},
          ${periodStart}::date, ${periodEnd}::date,
          ${status}, false, ${platformCreator},
          ${status === "open" ? sql`now()` : null},
          ${status === "open" ? platformCreator : null}
        )
      `.execute(transaction);
    }

    return {
      code,
      start: yearStart,
      end: yearEnd,
      periods: template.fiscalPolicy.periodsPerYear,
    };
  }

  /**
   * Proves the import before the caller is allowed to commit.
   *
   * This is onboarding validation, not the future cross-module integrity
   * engine: it checks only that THIS Company's own initialisation is complete
   * and self-consistent. Any failure throws, which rolls the whole Company back.
   */
  public async verifyImport(
    transaction: Transaction<DatabaseSchema>,
    template: AccountingTemplate,
    companyId: string,
  ): Promise<void> {
    const problems: string[] = [];
    const count = async (statement: ReturnType<typeof sql<{ n: string }>>): Promise<number> =>
      Number((await statement.execute(transaction)).rows[0]?.n ?? 0);

    const accounts = await count(
      sql<{
        n: string;
      }>`select count(*)::bigint n from chart_of_accounts where company_id = ${companyId}::uuid`,
    );
    if (accounts !== template.accounts.length) {
      problems.push(`Chart of Accounts: expected ${template.accounts.length}, found ${accounts}`);
    }

    const mappings = await count(
      sql<{
        n: string;
      }>`select count(*)::bigint n from account_mappings where company_id = ${companyId}::uuid`,
    );
    if (mappings !== template.accountMappings.length) {
      problems.push(
        `Account mappings: expected ${template.accountMappings.length}, found ${mappings}`,
      );
    }

    // Every mapping slot that names an account must point at an account owned
    // by THIS Company. A cross-Company account id here would be the worst
    // possible outcome of an import, so it is checked explicitly.
    const danglingMappings = await count(
      sql<{ n: string }>`
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
      `,
    );
    if (danglingMappings > 0) {
      problems.push(
        `${danglingMappings} account mapping(s) reference an account outside this Company`,
      );
    }

    const configuration = (
      await sql<Record<string, string | null>>`
        select * from accounting_configurations where company_id = ${companyId}::uuid
      `.execute(transaction)
    ).rows[0];
    if (configuration === undefined) {
      problems.push("Accounting configuration was not created");
    } else {
      for (const [slot, column] of Object.entries(configurationSlotColumns)) {
        const expected = template.accountingConfiguration.defaultAccountKeys[slot] ?? null;
        const actual = configuration[column] ?? null;
        if (expected !== null && actual === null) {
          problems.push(`Accounting configuration slot '${slot}' did not resolve`);
        }
        if (expected === null && actual !== null) {
          problems.push(
            `Accounting configuration slot '${slot}' was set but the template leaves it empty`,
          );
        }
      }
    }

    const orphanCash = await count(
      sql<{ n: string }>`
        select count(*)::bigint n from company_cash_accounts c
         where c.company_id = ${companyId}::uuid
           and not exists (
             select 1 from chart_of_accounts a
              where a.id = c.linked_gl_account_id and a.company_id = ${companyId}::uuid
           )
      `,
    );
    const orphanBank = await count(
      sql<{ n: string }>`
        select count(*)::bigint n from company_bank_accounts b
         where b.company_id = ${companyId}::uuid
           and (b.linked_gl_account_id is null
             or not exists (
               select 1 from chart_of_accounts a
                where a.id = b.linked_gl_account_id and a.company_id = ${companyId}::uuid
             ))
      `,
    );
    if (orphanCash > 0) problems.push(`${orphanCash} Cash account(s) have no Company GL link`);
    if (orphanBank > 0) problems.push(`${orphanBank} Bank account(s) have no Company GL link`);

    // Zero financial history. Checked here rather than trusted, because this is
    // the guarantee the whole template format exists to provide.
    for (const [label, table] of [
      ["opening balance batches", "opening_balance_batches"],
      ["opening balance lines", "opening_balance_lines"],
      ["accounting events", "accounting_events"],
      ["journal entries", "journal_entries"],
      ["journal lines", "journal_lines"],
      ["cash/bank movements", "cash_bank_movements"],
      ["general expenses", "general_expenses"],
      ["orders", "orders"],
    ] as const) {
      const rows = await count(
        sql<{
          n: string;
        }>`select count(*)::bigint n from ${sql.table(table)} where company_id = ${companyId}::uuid`,
      );
      if (rows !== 0) problems.push(`New Company must have zero ${label}, found ${rows}`);
    }

    const fiscalYears = await count(
      sql<{
        n: string;
      }>`select count(*)::bigint n from fiscal_years where company_id = ${companyId}::uuid`,
    );
    if (fiscalYears !== 1) problems.push(`Expected exactly one fiscal year, found ${fiscalYears}`);
    const periods = await count(
      sql<{
        n: string;
      }>`select count(*)::bigint n from accounting_periods where company_id = ${companyId}::uuid`,
    );
    if (periods !== template.fiscalPolicy.periodsPerYear) {
      problems.push(
        `Accounting periods: expected ${template.fiscalPolicy.periodsPerYear}, found ${periods}`,
      );
    }
    // Every period must belong to this Company's own fiscal year.
    const strayPeriods = await count(
      sql<{ n: string }>`
        select count(*)::bigint n from accounting_periods p
         where p.company_id = ${companyId}::uuid
           and not exists (
             select 1 from fiscal_years f
              where f.id = p.fiscal_year_id and f.company_id = ${companyId}::uuid
           )
      `,
    );
    if (strayPeriods > 0) {
      problems.push(`${strayPeriods} accounting period(s) belong to another Company's fiscal year`);
    }

    // `area` is excluded deliberately: `createAreas` above is the one place
    // this importer creates rows and advances the counter it just used to
    // number them, in the same transaction as everything else. Every other
    // counter genuinely should still read 1 -- nothing else this importer
    // does creates an order, a journal or any other numbered record.
    const staleCounters = await count(
      sql<{ n: string }>`
        select count(*)::bigint n from company_reference_counters
         where company_id = ${companyId}::uuid and next_value <> 1 and reference_type <> 'area'
      `,
    );
    if (staleCounters > 0) {
      problems.push(`${staleCounters} reference counter(s) did not start at 1`);
    }
    // Its own, correct expectation: exactly as many as were actually seeded.
    const areaCounter = await count(
      sql<{ n: string }>`
        select next_value::bigint - 1 as n from company_reference_counters
         where company_id = ${companyId}::uuid and reference_type = 'area'
      `,
    );
    if (areaCounter !== (template.areas ?? []).length) {
      problems.push(
        `Area reference counter: expected ${(template.areas ?? []).length} reserved, found ${areaCounter}`,
      );
    }

    if (problems.length > 0) {
      throw new Error(
        `Accounting setup validation failed for the new Company:\n  - ${problems.join("\n  - ")}`,
      );
    }
  }
}
