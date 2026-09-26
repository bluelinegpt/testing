/**
 * The shape of a BluelineGPT Accounting Template.
 *
 * ---------------------------------------------------------------------------
 * A TEMPLATE IS CONFIGURATION, NOT A COPY OF A COMPANY
 * ---------------------------------------------------------------------------
 *
 * Every relationship in this file is expressed with a stable, human-readable
 * template key. No database identifier appears anywhere, and that is the single
 * most important property of the format: a template that carried a source
 * Company's account UUIDs could only be loaded into a database where those rows
 * already existed, which defeats the entire purpose.
 *
 * A new Company generates its own identifiers on import and is completely
 * independent of the Company the template was exported from afterwards.
 *
 * ---------------------------------------------------------------------------
 * WHAT A TEMPLATE MUST NEVER CONTAIN
 * ---------------------------------------------------------------------------
 *
 * No balance, no journal, no accounting event, no opening balance, no order,
 * no customer, trader, driver or employee, no settlement, no payroll run, and
 * no reference-counter watermark. A template describes how a Company posts, not
 * what it has posted. `openingBalances` exists solely so the format can state,
 * explicitly and checkably, that it is empty.
 */

export type TemplateAccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export type TemplateNormalBalance = "debit" | "credit";

export interface TemplateAccount {
  /** Stable semantic key. Derived from account type and class — never from a UUID. */
  readonly key: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly accountType: TemplateAccountType;
  readonly accountClass: string;
  readonly normalBalance: TemplateNormalBalance;
  /** Key of the parent account, or null for a root account. Never a UUID. */
  readonly parentAccountKey: string | null;
  readonly isPostingAccount: boolean;
  readonly isActive: boolean;
  readonly isContraAccount: boolean;
  readonly isControlAccount: boolean;
  readonly controlAccountType: string | null;
  readonly isSystemAccount: boolean;
  readonly systemPurpose: string | null;
  readonly currency: string;
  readonly description: string | null;
}

/**
 * One automatic-posting mapping.
 *
 * `mappingKey` is kept verbatim from the Accounting engine. It is already a
 * stable semantic string (`delivery_revenue`, `trader_payable`, …) that the
 * posting code looks up by name, so renaming it into a prettier convention
 * would silently break every posting rule on import.
 *
 * The six account slots mirror the engine's own columns. A mapping uses only
 * the slots its posting type needs; the rest are null.
 */
export interface TemplateAccountMapping {
  readonly mappingKey: string;
  readonly isActive: boolean;
  readonly debitAccountKey: string | null;
  readonly creditAccountKey: string | null;
  readonly vatAccountKey: string | null;
  readonly feeAccountKey: string | null;
  readonly expenseAccountKey: string | null;
  readonly payableAccountKey: string | null;
}

/**
 * Accounting configuration, split by who decides it.
 *
 * `standardDefaults` are safe to apply to any new UAE delivery Company.
 * `defaultAccountKeys` are the engine's named account slots, expressed as keys.
 * `companyDecisions` names configuration a new Company must choose for itself —
 * it is a list of field names, deliberately carrying no value, so nothing
 * Company-specific can ride along inside it.
 */
export interface TemplateAccountingConfiguration {
  readonly standardDefaults: {
    readonly accountingEnabled: boolean;
    readonly automaticPostingEnabled: boolean;
    readonly baseCurrency: string;
    readonly fiscalYearStartMonth: number;
    readonly defaultAccountingMethod: string;
    readonly segregationPolicy: string;
    readonly automaticPostingAreas: readonly string[];
  };
  readonly defaultAccountKeys: Readonly<Record<string, string | null>>;
  readonly companyDecisions: readonly string[];
}

export interface TemplateBalancePolicy {
  readonly cashPolicy: string;
  readonly bankPolicy: string;
  readonly bankOverdraftLimit: string;
  readonly overridePermission: string;
}

/**
 * A Cash or Bank account definition.
 *
 * `requiresCompanyInput` lists the fields a new Company must supply itself.
 * Bank identity — the real bank name, account number, IBAN and SWIFT — is never
 * exported: it belongs to one Company, it is commercially sensitive, and a
 * template that carried it would quietly seed every new Company with another
 * Company's banking details.
 */
export interface TemplateCashAccount {
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly nameAr: string | null;
  readonly cashAccountType: string;
  readonly glAccountKey: string;
  readonly currency: string;
  readonly isActive: boolean;
  readonly requiresCompanyInput: readonly string[];
}

export interface TemplateBankAccount {
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: string;
  readonly glAccountKey: string;
  readonly currency: string;
  readonly isActive: boolean;
  readonly requiresCompanyInput: readonly string[];
}

export interface TemplateBusinessDay {
  readonly timezone: string;
  readonly startTime: string;
  readonly isDefault: boolean;
  readonly companyMayOverride: boolean;
}

/**
 * Fiscal *policy*, never fiscal *periods*.
 *
 * A new Company generates its own fiscal year and periods from its own creation
 * date. Cloning the source Company's dated year and twelve dated periods would
 * hand a Company created in 2027 a calendar belonging to 2026, and every
 * period-open check would then refuse its first posting.
 */
export interface TemplateFiscalPolicy {
  readonly fiscalYearStartMonth: number;
  readonly periodModel: string;
  readonly periodsPerYear: number;
  readonly timezone: string;
  readonly generatedOnCompanyCreation: boolean;
}

export interface TemplateExpenseType {
  readonly key: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly displayName: string;
  readonly isActive: boolean;
}

export interface TemplateGeneralExpenseCategory {
  readonly key: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly description: string | null;
  /** References a `mappingKey` in `accountMappings`, never an account UUID. */
  readonly defaultExpenseMappingKey: string;
  readonly defaultVatTreatment: string;
  readonly isActive: boolean;
}

export interface TemplateAllowanceType {
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly nameAr: string | null;
  readonly isActive: boolean;
}

/**
 * Reference-number prefixes only.
 *
 * The counters' `next_value` is a transactional watermark — it says how many
 * journals and orders the source Company has produced — so it is excluded. A
 * new Company starts every sequence at 1.
 */
export interface TemplateReferencePrefix {
  readonly referenceType: string;
  readonly prefix: string;
}

/**
 * A delivery Area the new Company starts with.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SECTION DOES NOT COME FROM THE SOURCE COMPANY
 * ---------------------------------------------------------------------------
 *
 * Every other section of this template genuinely reflects a decision the
 * source Company made — its own Chart of Accounts, its own mappings, its own
 * balance policy. Areas are different: they are a country reference list, not
 * a Company's configuration choice, and a source Company's live `areas` table
 * drifts over time as it renames, deactivates or adds its own zones. Exporting
 * from a live Company would silently bake that Company's local edits into a
 * template meant to be reusable and Company-independent.
 *
 * So this section is populated from the canonical UAE reference list at
 * `database/seeds/uae-areas.json` — the same file the `dev:import-areas` CLI
 * reads — regardless of which Company the rest of the template was exported
 * from. There is exactly one source of truth for what the UAE's Areas are.
 *
 * No `emirateId` here: Emirates are global and looked up by `emirateCode` at
 * import time, against whichever database the template is being applied to.
 */
export interface TemplateArea {
  readonly emirateCode: string;
  readonly nameEn: string;
  readonly nameAr: string;
}

export interface AccountingTemplate {
  readonly schemaVersion: number;
  readonly templateCode: string;
  readonly templateVersion: number;
  readonly name: string;
  readonly countryCode: string;
  readonly currency: string;
  /**
   * Provenance only. Deliberately carries no Company identifier: loading this
   * template must never depend on the source Company existing, or on any
   * particular database.
   */
  readonly source: {
    readonly type: "company_export";
    readonly companyName: string;
  };
  readonly accounts: readonly TemplateAccount[];
  readonly accountMappings: readonly TemplateAccountMapping[];
  readonly accountingConfiguration: TemplateAccountingConfiguration;
  readonly balancePolicy: TemplateBalancePolicy;
  readonly defaultCashAccounts: readonly TemplateCashAccount[];
  readonly defaultBankAccounts: readonly TemplateBankAccount[];
  readonly businessDay: TemplateBusinessDay;
  readonly fiscalPolicy: TemplateFiscalPolicy;
  readonly expenseTypes: readonly TemplateExpenseType[];
  readonly generalExpenseCategories: readonly TemplateGeneralExpenseCategory[];
  readonly allowanceTypes: readonly TemplateAllowanceType[];
  readonly referenceNumberPrefixes: readonly TemplateReferencePrefix[];
  /**
   * Optional so `schemaVersion: 1` templates parse unchanged. A Company
   * initialised from v1 simply starts with none, exactly as it did before
   * this section existed.
   */
  readonly areas?: readonly TemplateArea[];
  /** Always empty. A new Company establishes its own opening balances. */
  readonly openingBalances: readonly never[];
  readonly requiredCompanyInputs: readonly string[];
  /** Documentation of what was deliberately left out, and why. */
  readonly excludedFromTemplate: readonly { readonly item: string; readonly reason: string }[];
}
