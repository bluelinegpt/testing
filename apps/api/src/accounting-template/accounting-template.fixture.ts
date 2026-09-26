import type { CompanySetup, TemplateIdentity } from "./accounting-template.exporter.js";

/**
 * A minimal but complete Company setup, for tests.
 *
 * Deliberately small and hand-written rather than a dump of the real Company:
 * a fixture that mirrored production would make every assertion about *rules*
 * (key derivation, exclusion, ordering) depend on data that changes whenever
 * someone edits a Chart of Accounts. The real Company is exercised separately,
 * read-only, by the gated database test.
 *
 * It intentionally includes the two shapes that are easy to get wrong: a parent
 * account with a child, and two accounts sharing one account class.
 */
export const testTemplateIdentity: TemplateIdentity = {
  templateCode: "TEST_TEMPLATE",
  templateVersion: 1,
  name: "Test Template",
  countryCode: "AE",
};

export function companySetupFixture(): CompanySetup {
  return {
    companyName: "Fixture Delivery Services",
    accounts: [
      account({ code: "1000", nameEn: "Main Cash", type: "asset", cls: "cash", balance: "debit" }),
      account({ code: "1010", nameEn: "Main Bank", type: "asset", cls: "bank", balance: "debit" }),
      account({
        code: "1100",
        nameEn: "Receivables",
        type: "asset",
        cls: "accounts_receivable",
        balance: "debit",
        isControl: true,
        controlType: "accounts_receivable",
      }),
      // Two accounts, one class: both must end up suffixed.
      account({
        code: "1110",
        nameEn: "Input VAT",
        type: "asset",
        cls: "other_receivable",
        balance: "debit",
      }),
      account({
        code: "1120",
        nameEn: "Other Receivable",
        type: "asset",
        cls: "other_receivable",
        balance: "debit",
        parent: "1100",
      }),
      account({
        code: "2000",
        nameEn: "Trader Payable",
        type: "liability",
        cls: "trader_payable",
        balance: "credit",
        isControl: true,
        controlType: "trader_payable",
      }),
      account({
        code: "4000",
        nameEn: "Delivery Revenue",
        type: "revenue",
        cls: "delivery_revenue",
        balance: "credit",
      }),
      account({
        code: "5030",
        nameEn: "General Expense",
        type: "expense",
        cls: "general_expense",
        balance: "debit",
      }),
    ],
    mappings: [
      mapping({ key: "trader_payable", payable: "2000" }),
      mapping({ key: "delivery_revenue", credit: "4000" }),
      mapping({ key: "general_expense", expense: "5030" }),
      mapping({ key: "order_cod_receivable", debit: "1100" }),
      mapping({ key: "input_vat", vat: "1110" }),
    ],
    configuration: {
      accounting_enabled: true,
      automatic_posting_enabled: true,
      base_currency: "AED",
      fiscal_year_start_month: 1,
      default_accounting_method: "accrual",
      segregation_policy: "single_user",
      automatic_posting_areas: ["orders", "general_expenses"],
      retained_earnings_code: null,
      current_year_earnings_code: null,
      rounding_code: null,
      suspense_code: null,
      cash_code: "1000",
      bank_code: "1010",
      vat_output_code: null,
      vat_input_code: "1110",
      accounts_receivable_code: "1100",
      accounts_payable_code: null,
      payroll_payable_code: null,
      outsourced_driver_payable_code: null,
      trader_payable_code: "2000",
      service_fee_revenue_code: null,
      delivery_revenue_code: "4000",
    },
    balancePolicy: {
      cash_policy: "block",
      bank_policy: "allow_within_overdraft",
      bank_overdraft_limit: "0.00",
      override_permission: "accounting.manage",
    },
    cashAccounts: [
      {
        cash_account_code: "CASH-0001",
        cash_account_name: "Main Cash",
        cash_account_name_ar: null,
        cash_account_type: "main_cash",
        currency: "AED",
        is_active: true,
        gl_code: "1000",
      },
    ],
    bankAccounts: [
      {
        bank_account_code: "BANK-0001",
        account_type: "current",
        currency: "AED",
        is_active: true,
        gl_code: "1010",
      },
    ],
    businessDay: { timezone: "Asia/Dubai", business_day_start: "08:00:00" },
    expenseTypes: [
      {
        code: "PETROL",
        name_en: "Petrol",
        name_ar: null,
        display_name: "Petrol",
        is_active: true,
      },
    ],
    expenseCategories: [
      {
        code: "EXP-OFFICE",
        name_en: "Office Supplies",
        name_ar: null,
        description: null,
        default_expense_mapping_key: "general_expense",
        default_vat_treatment: "out_of_scope",
        is_active: true,
      },
    ],
    allowanceTypes: [{ code: "TR001", name: "Transportation", name_ar: null, is_active: true }],
    referencePrefixes: [{ reference_type: "journal", prefix: "JRN" }],
  };
}

function account(input: {
  code: string;
  nameEn: string;
  type: string;
  cls: string;
  balance: string;
  parent?: string;
  isControl?: boolean;
  controlType?: string;
}): CompanySetup["accounts"][number] {
  return {
    code: input.code,
    name_en: input.nameEn,
    name_ar: null,
    account_type: input.type,
    account_class: input.cls,
    normal_balance: input.balance,
    parent_code: input.parent ?? null,
    is_posting_account: true,
    is_active: true,
    is_contra_account: false,
    is_control_account: input.isControl ?? false,
    control_account_type: input.controlType ?? null,
    is_system_account: false,
    system_purpose: null,
    currency: "AED",
    description: null,
  };
}

function mapping(input: {
  key: string;
  debit?: string;
  credit?: string;
  vat?: string;
  fee?: string;
  expense?: string;
  payable?: string;
}): CompanySetup["mappings"][number] {
  return {
    mapping_key: input.key,
    is_active: true,
    debit_code: input.debit ?? null,
    credit_code: input.credit ?? null,
    vat_code: input.vat ?? null,
    fee_code: input.fee ?? null,
    expense_code: input.expense ?? null,
    payable_code: input.payable ?? null,
  };
}
