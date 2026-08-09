import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type pg from "pg";

import { deriveAccountKeys, deriveEntityKey } from "./accounting-template.keys.js";
import type {
  AccountingTemplate,
  TemplateAccount,
  TemplateAccountMapping,
  TemplateAccountType,
  TemplateArea,
  TemplateNormalBalance,
} from "./accounting-template.types.js";
import { validateAccountingTemplate } from "./accounting-template.validator.js";

/**
 * The canonical UAE Areas, read from the SAME file `dev:import-areas` and
 * `seedCompanyAreas` use — never from the source Company's live `areas`
 * table. See `TemplateArea` for why.
 *
 * A missing or unreadable seed file produces an EMPTY areas section rather
 * than failing the export. The rest of the template — the source Company's
 * actual accounting setup — is the export's primary purpose, and a
 * deployment without the seed file legitimately produces a template with no
 * Areas rather than no template at all.
 */
export async function readCanonicalAreas(): Promise<readonly TemplateArea[]> {
  // Resolved from this file's own URL, not `process.cwd()` -- the exporter
  // runs from different working directories (the CLI, the API server, tests),
  // and this file sits four levels below the repository root in every one of
  // them: accounting-template -> src -> api -> apps -> repository root.
  const file = fileURLToPath(new URL("../../../../database/seeds/uae-areas.json", import.meta.url));
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as { emirateCode: string; nameEn: string; nameAr: string }[])
      .map((area) => ({ emirateCode: area.emirateCode, nameEn: area.nameEn, nameAr: area.nameAr }))
      .sort(
        (left, right) =>
          left.emirateCode.localeCompare(right.emirateCode, "en") ||
          left.nameEn.localeCompare(right.nameEn, "en"),
      );
  } catch {
    return [];
  }
}

/**
 * Reads a Company's Accounting SETUP and turns it into a reusable template.
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY, PROVEN BY THE DATABASE ITSELF
 * ---------------------------------------------------------------------------
 *
 * Every statement runs inside `begin transaction read only`, so PostgreSQL —
 * not a code review — refuses any write. The source Company cannot be modified
 * by this module even if a future edit introduced an UPDATE by mistake.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE WORK
 * ---------------------------------------------------------------------------
 *
 * Reading and building are deliberately separate. `readSetup` does the I/O;
 * `buildTemplate` is a pure function from rows to template. That split is what
 * lets the key derivation, the hierarchy handling, the exclusion rules and the
 * determinism all be tested exhaustively without a database, leaving only
 * "does this match the real Company" for the gated database test.
 */

export interface AccountRow {
  code: string;
  name_en: string;
  name_ar: string | null;
  account_type: string;
  account_class: string;
  normal_balance: string;
  parent_code: string | null;
  is_posting_account: boolean;
  is_active: boolean;
  is_contra_account: boolean;
  is_control_account: boolean;
  control_account_type: string | null;
  is_system_account: boolean;
  system_purpose: string | null;
  currency: string;
  description: string | null;
}

export interface MappingRow {
  mapping_key: string;
  is_active: boolean;
  debit_code: string | null;
  credit_code: string | null;
  vat_code: string | null;
  fee_code: string | null;
  expense_code: string | null;
  payable_code: string | null;
}

export interface ConfigurationRow {
  accounting_enabled: boolean;
  automatic_posting_enabled: boolean;
  base_currency: string;
  fiscal_year_start_month: number;
  default_accounting_method: string;
  segregation_policy: string;
  automatic_posting_areas: string[];
  retained_earnings_code: string | null;
  current_year_earnings_code: string | null;
  rounding_code: string | null;
  suspense_code: string | null;
  cash_code: string | null;
  bank_code: string | null;
  vat_output_code: string | null;
  vat_input_code: string | null;
  accounts_receivable_code: string | null;
  accounts_payable_code: string | null;
  payroll_payable_code: string | null;
  outsourced_driver_payable_code: string | null;
  trader_payable_code: string | null;
  service_fee_revenue_code: string | null;
  delivery_revenue_code: string | null;
}

export interface BalancePolicyRow {
  cash_policy: string;
  bank_policy: string;
  bank_overdraft_limit: string;
  override_permission: string;
}

export interface CashAccountRow {
  cash_account_code: string;
  cash_account_name: string;
  cash_account_name_ar: string | null;
  cash_account_type: string;
  currency: string;
  is_active: boolean;
  gl_code: string;
}

export interface BankAccountRow {
  bank_account_code: string;
  account_type: string;
  currency: string;
  is_active: boolean;
  gl_code: string | null;
}

export interface BusinessDayRow {
  timezone: string;
  business_day_start: string;
}

export interface ExpenseTypeRow {
  code: string;
  name_en: string;
  name_ar: string | null;
  display_name: string;
  is_active: boolean;
}

export interface ExpenseCategoryRow {
  code: string;
  name_en: string;
  name_ar: string | null;
  description: string | null;
  default_expense_mapping_key: string;
  default_vat_treatment: string;
  is_active: boolean;
}

export interface AllowanceTypeRow {
  code: string;
  name: string;
  name_ar: string | null;
  is_active: boolean;
}

export interface ReferencePrefixRow {
  reference_type: string;
  prefix: string;
}

export interface CompanySetup {
  companyName: string;
  accounts: AccountRow[];
  mappings: MappingRow[];
  configuration: ConfigurationRow | undefined;
  balancePolicy: BalancePolicyRow | undefined;
  cashAccounts: CashAccountRow[];
  bankAccounts: BankAccountRow[];
  businessDay: BusinessDayRow | undefined;
  expenseTypes: ExpenseTypeRow[];
  expenseCategories: ExpenseCategoryRow[];
  allowanceTypes: AllowanceTypeRow[];
  referencePrefixes: ReferencePrefixRow[];
}

export interface TemplateIdentity {
  readonly templateCode: string;
  readonly templateVersion: number;
  readonly name: string;
  readonly countryCode: string;
}

/**
 * Fields a new Company must supply or decide for itself.
 *
 * Each entry is here because copying the source Company's value would be
 * wrong, not merely unnecessary.
 */
const requiredCompanyInputs = [
  "bankAccountDetails.bankName",
  "bankAccountDetails.accountName",
  "bankAccountDetails.accountNumber",
  "bankAccountDetails.iban",
  "bankAccountDetails.swiftCode",
  "cashAccount.locationOrCustodian",
  "fiscalYear.startDate",
  "accounting.manualActivationDate",
  "vat.registrationAndRate",
  "openingBalances",
] as const;

const excludedFromTemplate = [
  {
    item: "opening_balance_batches, opening_balance_lines",
    reason:
      "Financial history. A template must carry no balance; the new Company establishes its own opening balances after initialisation.",
  },
  {
    item: "fiscal_years, accounting_periods (dated rows)",
    reason:
      "Dated to the source Company's calendar. A Company created later would inherit periods it cannot post into; only the fiscal policy is reusable.",
  },
  {
    item: "company_reference_counters.next_value",
    reason:
      "A transactional watermark counting the source Company's documents. Only the prefixes are reusable; every new sequence starts at 1.",
  },
  {
    item: "company_bank_accounts identity fields (bank name, account name, number, IBAN, SWIFT)",
    reason:
      "Commercially sensitive and specific to one Company. Seeding them into another Company would be a real disclosure, not a convenience.",
  },
  {
    item: "company_cash_accounts.location_or_custodian",
    reason: "Names a physical office and custodian of the source Company.",
  },
  {
    item: "chart_of_accounts / account_mappings effective_from dates",
    reason:
      "Adoption dates of the source Company. The importer sets these from the new Company's own start date.",
  },
  {
    item: "accounting_configurations.manual_accounting_activation_date and change-reason/actor columns",
    reason: "Records when one Company switched Accounting on, and who did it.",
  },
  {
    item: "accounting_configuration_history",
    reason: "An audit trail of the source Company's configuration changes.",
  },
  {
    item: "payment methods",
    reason:
      "Not Company configuration. They are code-level enumerations enforced by CHECK constraints (for example cash/visa on driver collections), so there is nothing per-Company to carry.",
  },
  {
    item: "areas, emirates",
    reason:
      "Operational geography rather than Accounting setup. Emirates are global reference data and Areas are imported by their own tool.",
  },
  {
    item: "audit_events, accounts, roles, permissions, sessions",
    reason: "Identity, security and audit data — never part of an Accounting template.",
  },
  {
    item: "all transactional tables",
    reason:
      "Orders, customers, traders, drivers, employees, journals, accounting events, settlements, collections, reconciliations, payroll, expenses, cash/bank movements, batch and recovery execution history.",
  },
] as const;

/** Builds the template. Pure: same rows in, byte-identical template out. */
export function buildTemplate(
  setup: CompanySetup,
  identity: TemplateIdentity,
  areas: readonly TemplateArea[] = [],
): AccountingTemplate {
  if (setup.accounts.length === 0) {
    throw new Error("Refusing to export: the Company has no Chart of Accounts.");
  }
  if (setup.configuration === undefined) {
    throw new Error("Refusing to export: the Company has no Accounting configuration.");
  }
  if (setup.businessDay === undefined) {
    throw new Error("Refusing to export: the Company has no active Business Day configuration.");
  }
  if (setup.balancePolicy === undefined) {
    throw new Error("Refusing to export: the Company has no active balance policy.");
  }

  const keys = deriveAccountKeys(
    setup.accounts.map((account) => ({
      code: account.code,
      accountType: account.account_type,
      accountClass: account.account_class,
    })),
  );
  const keyOf = (code: string | null): string | null => {
    if (code === null) return null;
    const key = keys.get(code);
    if (key === undefined) {
      // Reachable only if a mapping points at an account outside the exported
      // set. Failing loudly is the whole point: a silent null would produce a
      // template whose posting rules are quietly incomplete.
      throw new Error(`Refusing to export: account code "${code}" is referenced but not exported.`);
    }
    return key;
  };
  const requireKey = (code: string, what: string): string => {
    const key = keyOf(code);
    if (key === null) throw new Error(`Refusing to export: ${what} has no account.`);
    return key;
  };

  const accounts: TemplateAccount[] = setup.accounts
    .map((account) => ({
      key: requireKey(account.code, `account ${account.code}`),
      code: account.code,
      nameEn: account.name_en,
      nameAr: account.name_ar,
      accountType: account.account_type as TemplateAccountType,
      accountClass: account.account_class,
      normalBalance: account.normal_balance as TemplateNormalBalance,
      parentAccountKey: keyOf(account.parent_code),
      isPostingAccount: account.is_posting_account,
      isActive: account.is_active,
      isContraAccount: account.is_contra_account,
      isControlAccount: account.is_control_account,
      controlAccountType: account.control_account_type,
      isSystemAccount: account.is_system_account,
      systemPurpose: account.system_purpose,
      currency: account.currency,
      description: account.description,
    }))
    // Deterministic order: by account code, which is unique per Company.
    .sort((left, right) => left.code.localeCompare(right.code, "en"));

  const accountMappings: TemplateAccountMapping[] = setup.mappings
    .map((mapping) => ({
      mappingKey: mapping.mapping_key,
      isActive: mapping.is_active,
      debitAccountKey: keyOf(mapping.debit_code),
      creditAccountKey: keyOf(mapping.credit_code),
      vatAccountKey: keyOf(mapping.vat_code),
      feeAccountKey: keyOf(mapping.fee_code),
      expenseAccountKey: keyOf(mapping.expense_code),
      payableAccountKey: keyOf(mapping.payable_code),
    }))
    .sort((left, right) => left.mappingKey.localeCompare(right.mappingKey, "en"));

  const configuration = setup.configuration;
  const template: AccountingTemplate = {
    schemaVersion: 1,
    templateCode: identity.templateCode,
    templateVersion: identity.templateVersion,
    name: identity.name,
    countryCode: identity.countryCode,
    currency: configuration.base_currency,
    source: { type: "company_export", companyName: setup.companyName },
    accounts,
    accountMappings,
    accountingConfiguration: {
      standardDefaults: {
        accountingEnabled: configuration.accounting_enabled,
        automaticPostingEnabled: configuration.automatic_posting_enabled,
        baseCurrency: configuration.base_currency,
        fiscalYearStartMonth: configuration.fiscal_year_start_month,
        defaultAccountingMethod: configuration.default_accounting_method,
        segregationPolicy: configuration.segregation_policy,
        automaticPostingAreas: [...configuration.automatic_posting_areas].sort((left, right) =>
          left.localeCompare(right, "en"),
        ),
      },
      defaultAccountKeys: {
        accountsPayable: keyOf(configuration.accounts_payable_code),
        accountsReceivable: keyOf(configuration.accounts_receivable_code),
        bank: keyOf(configuration.bank_code),
        cash: keyOf(configuration.cash_code),
        currentYearEarnings: keyOf(configuration.current_year_earnings_code),
        deliveryRevenue: keyOf(configuration.delivery_revenue_code),
        outsourcedDriverPayable: keyOf(configuration.outsourced_driver_payable_code),
        payrollPayable: keyOf(configuration.payroll_payable_code),
        retainedEarnings: keyOf(configuration.retained_earnings_code),
        rounding: keyOf(configuration.rounding_code),
        serviceFeeRevenue: keyOf(configuration.service_fee_revenue_code),
        suspense: keyOf(configuration.suspense_code),
        traderPayable: keyOf(configuration.trader_payable_code),
        vatInput: keyOf(configuration.vat_input_code),
        vatOutput: keyOf(configuration.vat_output_code),
      },
      companyDecisions: [
        "manualAccountingActivationDate",
        "fiscalYearStartDate",
        "vatRegistrationAndRate",
      ],
    },
    balancePolicy: {
      cashPolicy: setup.balancePolicy.cash_policy,
      bankPolicy: setup.balancePolicy.bank_policy,
      bankOverdraftLimit: setup.balancePolicy.bank_overdraft_limit,
      overridePermission: setup.balancePolicy.override_permission,
    },
    defaultCashAccounts: setup.cashAccounts
      .map((cash) => ({
        key: deriveEntityKey("CASH", cash.cash_account_code),
        code: cash.cash_account_code,
        name: cash.cash_account_name,
        nameAr: cash.cash_account_name_ar,
        cashAccountType: cash.cash_account_type,
        glAccountKey: requireKey(cash.gl_code, `cash account ${cash.cash_account_code}`),
        currency: cash.currency,
        isActive: cash.is_active,
        requiresCompanyInput: ["locationOrCustodian"],
      }))
      .sort((left, right) => left.code.localeCompare(right.code, "en")),
    // The bank definition is a SHAPE, not an account. Name, number, IBAN and
    // SWIFT are omitted entirely rather than blanked, so there is no field for
    // one Company's banking details to hide in.
    defaultBankAccounts: setup.bankAccounts
      .filter((bank) => bank.gl_code !== null)
      .map((bank) => ({
        key: deriveEntityKey("BANK", bank.bank_account_code),
        code: bank.bank_account_code,
        name: "Main Bank",
        accountType: bank.account_type,
        glAccountKey: requireKey(bank.gl_code as string, `bank account ${bank.bank_account_code}`),
        currency: bank.currency,
        isActive: bank.is_active,
        requiresCompanyInput: ["bankName", "accountName", "accountNumber", "iban", "swiftCode"],
      }))
      .sort((left, right) => left.code.localeCompare(right.code, "en")),
    businessDay: {
      timezone: setup.businessDay.timezone,
      // `time` comes back as HH:MM:SS; the template stores the HH:MM the
      // configuration screen works in.
      startTime: setup.businessDay.business_day_start.slice(0, 5),
      isDefault: true,
      companyMayOverride: true,
    },
    fiscalPolicy: {
      fiscalYearStartMonth: configuration.fiscal_year_start_month,
      periodModel: "calendar_month",
      periodsPerYear: 12,
      timezone: setup.businessDay.timezone,
      generatedOnCompanyCreation: true,
    },
    expenseTypes: setup.expenseTypes
      .map((type) => ({
        key: deriveEntityKey("EXPENSE_TYPE", type.code),
        code: type.code,
        nameEn: type.name_en,
        nameAr: type.name_ar,
        displayName: type.display_name,
        isActive: type.is_active,
      }))
      .sort((left, right) => left.code.localeCompare(right.code, "en")),
    generalExpenseCategories: setup.expenseCategories
      .map((category) => ({
        key: deriveEntityKey("EXPENSE_CATEGORY", category.code),
        code: category.code,
        nameEn: category.name_en,
        nameAr: category.name_ar,
        description: category.description,
        defaultExpenseMappingKey: category.default_expense_mapping_key,
        defaultVatTreatment: category.default_vat_treatment,
        isActive: category.is_active,
      }))
      .sort((left, right) => left.code.localeCompare(right.code, "en")),
    allowanceTypes: setup.allowanceTypes
      .map((allowance) => ({
        key: deriveEntityKey("ALLOWANCE", allowance.code),
        code: allowance.code,
        name: allowance.name,
        nameAr: allowance.name_ar,
        isActive: allowance.is_active,
      }))
      .sort((left, right) => left.code.localeCompare(right.code, "en")),
    referenceNumberPrefixes: setup.referencePrefixes
      .map((counter) => ({ referenceType: counter.reference_type, prefix: counter.prefix }))
      .sort((left, right) => left.referenceType.localeCompare(right.referenceType, "en")),
    // Present only when non-empty. `areas` is optional precisely so a
    // template built with none — v1, or a re-export in an environment
    // without the seed file — serialises with NO `areas` key at all,
    // producing bytes byte-for-byte identical to what v1 already has
    // committed and hash-pinned. Emitting `"areas": []` unconditionally would
    // silently change v1's canonical form the moment anyone re-ran the
    // exporter, invalidating a hash this repository treats as fixed.
    ...(areas.length > 0 ? { areas } : {}),
    openingBalances: [],
    requiredCompanyInputs: [...requiredCompanyInputs],
    excludedFromTemplate: excludedFromTemplate.map((entry) => ({ ...entry })),
  };

  // The exporter never writes a template it would refuse to read.
  validateAccountingTemplate(template);
  return template;
}

const accountCode = (column: string): string =>
  `(select x.code from chart_of_accounts x where x.id = m.${column})`;

/**
 * Reads the setup from one Company, inside a read-only transaction.
 *
 * Only the CURRENTLY EFFECTIVE row is read wherever a table is effective-dated:
 * the source Company's superseded Business Day rules and deactivated policies
 * are history, not configuration a new Company should inherit.
 */
export async function readSetup(client: pg.PoolClient, companyId: string): Promise<CompanySetup> {
  await client.query("begin transaction read only");
  try {
    const company = (
      await client.query<{ name_en: string; code: string }>(
        "select name_en, code from companies where id = $1",
        [companyId],
      )
    ).rows[0];
    if (company === undefined) {
      throw new Error(`No Company found for id '${companyId}'`);
    }

    const accounts = (
      await client.query<AccountRow>(
        `select a.code, a.name_en, a.name_ar, a.account_type, a.account_class, a.normal_balance,
                (select p.code from chart_of_accounts p where p.id = a.parent_account_id) as parent_code,
                a.is_posting_account, a.is_active, a.is_contra_account, a.is_control_account,
                a.control_account_type, a.is_system_account, a.system_purpose, a.currency, a.description
           from chart_of_accounts a
          where a.company_id = $1
          order by a.code`,
        [companyId],
      )
    ).rows;

    const mappings = (
      await client.query<MappingRow>(
        `select m.mapping_key, m.is_active,
                ${accountCode("debit_account_id")} as debit_code,
                ${accountCode("credit_account_id")} as credit_code,
                ${accountCode("vat_account_id")} as vat_code,
                ${accountCode("fee_account_id")} as fee_code,
                ${accountCode("expense_account_id")} as expense_code,
                ${accountCode("payable_account_id")} as payable_code
           from account_mappings m
          where m.company_id = $1 and m.is_active = true and m.effective_to is null
          order by m.mapping_key`,
        [companyId],
      )
    ).rows;

    const configuration = (
      await client.query<ConfigurationRow>(
        `select k.accounting_enabled, k.automatic_posting_enabled, k.base_currency,
                k.fiscal_year_start_month, k.default_accounting_method, k.segregation_policy,
                k.automatic_posting_areas,
                (select x.code from chart_of_accounts x where x.id = k.retained_earnings_account_id) as retained_earnings_code,
                (select x.code from chart_of_accounts x where x.id = k.current_year_earnings_account_id) as current_year_earnings_code,
                (select x.code from chart_of_accounts x where x.id = k.default_rounding_account_id) as rounding_code,
                (select x.code from chart_of_accounts x where x.id = k.default_suspense_account_id) as suspense_code,
                (select x.code from chart_of_accounts x where x.id = k.default_cash_account_id) as cash_code,
                (select x.code from chart_of_accounts x where x.id = k.default_bank_account_id) as bank_code,
                (select x.code from chart_of_accounts x where x.id = k.default_vat_output_account_id) as vat_output_code,
                (select x.code from chart_of_accounts x where x.id = k.default_vat_input_account_id) as vat_input_code,
                (select x.code from chart_of_accounts x where x.id = k.default_accounts_receivable_account_id) as accounts_receivable_code,
                (select x.code from chart_of_accounts x where x.id = k.default_accounts_payable_account_id) as accounts_payable_code,
                (select x.code from chart_of_accounts x where x.id = k.default_payroll_payable_account_id) as payroll_payable_code,
                (select x.code from chart_of_accounts x where x.id = k.default_outsourced_driver_payable_account_id) as outsourced_driver_payable_code,
                (select x.code from chart_of_accounts x where x.id = k.default_trader_payable_account_id) as trader_payable_code,
                (select x.code from chart_of_accounts x where x.id = k.default_service_fee_revenue_account_id) as service_fee_revenue_code,
                (select x.code from chart_of_accounts x where x.id = k.default_delivery_revenue_account_id) as delivery_revenue_code
           from accounting_configurations k
          where k.company_id = $1`,
        [companyId],
      )
    ).rows[0];

    const balancePolicy = (
      await client.query<BalancePolicyRow>(
        `select cash_policy, bank_policy, bank_overdraft_limit::text as bank_overdraft_limit,
                override_permission
           from company_balance_policies
          where company_id = $1 and is_active = true and effective_to is null
          order by effective_from nulls first
          limit 1`,
        [companyId],
      )
    ).rows[0];

    const cashAccounts = (
      await client.query<CashAccountRow>(
        `select c.cash_account_code, c.cash_account_name, c.cash_account_name_ar,
                c.cash_account_type, c.currency, c.is_active,
                (select x.code from chart_of_accounts x where x.id = c.linked_gl_account_id) as gl_code
           from company_cash_accounts c
          where c.company_id = $1 and c.is_active = true and c.effective_to is null
          order by c.cash_account_code`,
        [companyId],
      )
    ).rows;

    const bankAccounts = (
      await client.query<BankAccountRow>(
        `select b.bank_account_code, b.account_type, b.currency, b.is_active,
                (select x.code from chart_of_accounts x
                  where x.id = coalesce(b.linked_gl_account_id, b.gl_account_id)) as gl_code
           from company_bank_accounts b
          where b.company_id = $1 and b.is_active = true and b.effective_to is null
          order by b.bank_account_code`,
        [companyId],
      )
    ).rows;

    const businessDay = (
      await client.query<BusinessDayRow>(
        `select timezone, business_day_start::text as business_day_start
           from company_business_day_configurations
          where company_id = $1 and is_active = true and effective_to is null
          order by effective_from desc nulls last
          limit 1`,
        [companyId],
      )
    ).rows[0];

    const expenseTypes = (
      await client.query<ExpenseTypeRow>(
        `select code, name_en, name_ar, display_name, is_active
           from expense_types where company_id = $1 order by code`,
        [companyId],
      )
    ).rows;

    const expenseCategories = (
      await client.query<ExpenseCategoryRow>(
        `select code, name_en, name_ar, description, default_expense_mapping_key,
                default_vat_treatment, is_active
           from general_expense_categories
          where company_id = $1 and effective_to is null
          order by code`,
        [companyId],
      )
    ).rows;

    const allowanceTypes = (
      await client.query<AllowanceTypeRow>(
        `select code, name, name_ar, is_active
           from allowance_types where company_id = $1 order by code`,
        [companyId],
      )
    ).rows;

    const referencePrefixes = (
      await client.query<ReferencePrefixRow>(
        `select reference_type, prefix
           from company_reference_counters where company_id = $1 order by reference_type`,
        [companyId],
      )
    ).rows;

    return {
      companyName: company.name_en,
      accounts,
      mappings,
      configuration,
      balancePolicy,
      cashAccounts,
      bankAccounts,
      businessDay,
      expenseTypes,
      expenseCategories,
      allowanceTypes,
      referencePrefixes,
    };
  } finally {
    // Nothing to commit — the transaction was read-only from the first
    // statement. Rolling back is how it is closed.
    await client.query("rollback");
  }
}
