export const accountingCurrencies = ["AED"] as const;
export type AccountingCurrency = (typeof accountingCurrencies)[number];

export const accountingAccountTypes = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
] as const;
export type AccountingAccountType = (typeof accountingAccountTypes)[number];

export const accountingAccountClasses = {
  asset: [
    "cash",
    "bank",
    "accounts_receivable",
    "other_receivable",
    "prepaid_expense",
    "fixed_asset",
    "accumulated_depreciation",
    "other_asset",
  ],
  liability: [
    "trader_payable",
    "driver_payable",
    "payroll_payable",
    "accounts_payable",
    "vat_payable",
    "accrued_liability",
    "other_liability",
  ],
  equity: [
    "share_capital",
    "retained_earnings",
    "current_year_earnings",
    "owner_equity",
    "other_equity",
  ],
  revenue: [
    "delivery_revenue",
    "service_fee_revenue",
    "additional_fee_revenue",
    "other_operating_revenue",
    "other_income",
  ],
  expense: [
    "driver_expense",
    "outsourced_driver_fee_expense",
    "payroll_expense",
    "administrative_expense",
    "bank_charge",
    "general_expense",
    "vat_expense",
    "other_expense",
  ],
} as const satisfies Readonly<Record<AccountingAccountType, readonly string[]>>;

export type AccountingAccountClass =
  (typeof accountingAccountClasses)[AccountingAccountType][number];

export const accountingNormalBalances = ["debit", "credit"] as const;
export type AccountingNormalBalance = (typeof accountingNormalBalances)[number];

export const accountingControlAccountTypes = [
  "trader_payable",
  "driver_payable",
  "payroll_payable",
  "accounts_payable",
  "accounts_receivable",
  "vat",
] as const;

export const accountingFiscalYearStatuses = ["draft", "open", "closed", "reopened"] as const;
export type AccountingFiscalYearStatus = (typeof accountingFiscalYearStatuses)[number];

export const accountingFiscalPeriodStatuses = [
  "future",
  "open",
  "soft_closed",
  "closed",
  "reopened",
] as const;
export type AccountingFiscalPeriodStatus = (typeof accountingFiscalPeriodStatuses)[number];

export const accountingJournalStatuses = [
  "draft",
  "balanced",
  "approved",
  "posted",
  "reversed",
  "cancelled",
] as const;
export type AccountingJournalStatus = (typeof accountingJournalStatuses)[number];

export const accountingJournalTypes = [
  "manual",
  "opening_balance",
  "operational",
  "adjustment",
  "closing",
  "reversal",
] as const;
export type AccountingJournalType = (typeof accountingJournalTypes)[number];

export const accountingJournalSources = [
  "manual",
  "opening_balance",
  "order",
  "trader_receivable",
  "trader_settlement",
  "driver_collection",
  "driver_expense",
  "employee_payroll",
  "outsourced_driver_fee",
  "general_expense",
  "bank_transfer",
  "cash_bank_management",
  "period_close",
  "system",
] as const;
export type AccountingJournalSource = (typeof accountingJournalSources)[number];

export const accountingEventTypes = [
  "order_delivered",
  "order_recognition_reversed",
  "trader_receivable_recognized",
  "trader_receivable_reversed",
  "trader_receivable_payment_received",
  "trader_receivable_payment_reversed",
  "trader_settlement_confirmed",
  "trader_settlement_reversed",
  "driver_collection_confirmed",
  "driver_collection_reversed",
  "driver_expense_confirmed",
  "employee_payroll_approved",
  "employee_payroll_reversed",
  "employee_payroll_paid",
  "employee_payroll_payment_reversed",
  "outsourced_driver_fee_accrued",
  "outsourced_driver_fee_accrual_reversed",
  "outsourced_driver_fee_paid",
  "outsourced_driver_fee_payment_reversed",
  "general_expense_approved",
  "general_expense_payment_completed",
  "general_expense_reversed",
  "general_expense_payment_reversed",
  "bank_transfer_confirmed",
  "bank_transfer_reversed",
  "cash_deposit_confirmed",
  "cash_withdrawal_confirmed",
  "bank_deposit_confirmed",
  "bank_withdrawal_confirmed",
  "cash_to_bank_transfer_confirmed",
  "bank_to_cash_transfer_confirmed",
  "bank_to_bank_transfer_confirmed",
  "cash_to_cash_transfer_confirmed",
  "cash_bank_movement_reversed",
] as const;
export type AccountingEventType = (typeof accountingEventTypes)[number];

export const accountingComponentTypes = [
  "cod_receivable",
  "delivery_revenue",
  "service_fee_revenue",
  "additional_fee_revenue",
  "output_vat",
  "trader_payable",
  "trader_settlement",
  "driver_collection_cash",
  "driver_expense",
  "payroll_expense",
  "payroll_payable",
  "payroll_cash_payment",
  "outsourced_driver_fee_expense",
  "outsourced_driver_payable",
  "outsourced_driver_payment",
  "general_expense",
  "input_vat",
  "general_expense_payable",
  "general_expense_payment",
  "cash_transfer",
  "bank_transfer",
  "cash_bank_account",
  "cash_bank_external_source",
  "cash_bank_external_destination",
  "cash_bank_fee",
] as const;
export type AccountingComponentType = (typeof accountingComponentTypes)[number];

export const accountingRequiredMappingGroups = {
  orders: [
    "order_cod_receivable",
    "delivery_revenue",
    "service_fee_revenue",
    "additional_fee_revenue",
  ],
  traderReceivables: ["order_cod_receivable"],
  traderSettlements: ["trader_payable", "trader_settlement_cash", "trader_settlement_bank"],
  driverCollections: ["driver_collection_cash", "driver_collection_fee_offset"],
  driverExpenses: ["driver_expense"],
  employeePayroll: [
    "employee_payroll_expense",
    "employee_payroll_payable",
    "employee_payroll_cash_payment",
  ],
  outsourcedDriverFees: [
    "outsourced_driver_fee_expense",
    "outsourced_driver_payable",
    "outsourced_driver_cash_payment",
  ],
  generalExpenses: [
    "general_expense",
    "input_vat",
    "general_expense_payable",
    "general_expense_cash_payment",
    "general_expense_bank_payment",
  ],
  cashAndBankTransfers: ["cash_transfer", "bank_transfer"],
  cashBankManagement: [
    "bank_charge",
    "cash_bank_deposit_owner_contribution",
    "cash_bank_deposit_refund",
    "cash_bank_deposit_loan",
    "cash_bank_withdrawal_owner",
    "cash_bank_withdrawal_refund",
    "cash_bank_withdrawal_loan_repayment",
  ],
  vat: ["output_vat", "input_vat"],
} as const;

export const accountingPermissionCodes = [
  "accounting.view",
  "accounting.manage",
  "accounting.approve",
  "accounting.post",
  "accounting.reverse",
  "accounting.periods.manage",
  "accounting.chart_of_accounts.manage",
  "accounting.configuration.manage",
] as const;

export const accountingReferenceDefinitions = {
  journal: { prefix: "JRN", referenceType: "journal" },
  openingBalance: {
    prefix: "OB",
    referenceType: "accounting_opening_balance",
  },
  generalExpense: { prefix: "EXP", referenceType: "general_expense" },
  generalExpensePayment: {
    prefix: "EXPPAY",
    referenceType: "general_expense_payment",
  },
  cashBankMovement: {
    prefix: "CBM",
    referenceType: "cash_bank_movement",
  },
} as const;

export const cashBankMovementTypes = [
  "cash_deposit",
  "cash_withdrawal",
  "bank_deposit",
  "bank_withdrawal",
  "cash_to_bank_transfer",
  "bank_to_cash_transfer",
  "bank_to_bank_transfer",
  "cash_to_cash_transfer",
  "opening_balance",
] as const;
export type CashBankMovementType = (typeof cashBankMovementTypes)[number];

export const cashBankMovementStatuses = ["draft", "confirmed", "cancelled", "reversed"] as const;

export const cashBankClassificationMappingKeys = [
  "cash_bank_deposit_owner_contribution",
  "cash_bank_deposit_refund",
  "cash_bank_deposit_loan",
  "cash_bank_withdrawal_owner",
  "cash_bank_withdrawal_refund",
  "cash_bank_withdrawal_loan_repayment",
] as const;

export const cashAccountTypes = [
  "main_cash",
  "branch_cash",
  "petty_cash",
  "cash_drawer",
  "safe",
  "other",
] as const;

export const bankAccountTypes = ["current", "savings", "merchant", "settlement", "other"] as const;

export const accountingAutomaticPostingEnabledByDefault = false as const;

/**
 * Segregation of Duties across the whole Accounting module — approving,
 * posting, paying, confirming a Cash/Bank Movement and reversing.
 *
 * - `strict`      — dual control is always required, whether or not a second
 *                   authorized user currently exists.
 * - `conditional` — dual control is required only while a second authorized
 *                   user is actually available, so a record can never wait on
 *                   a person who does not exist.
 * - `single_user` — one authorized accountant may perform every step.
 *
 * The effective value is a COMPANY decision stored in
 * `accounting_configurations.segregation_policy`; this list is the contract,
 * and `accountingDefaultSegregationPolicy` is only the fallback used when a
 * Company has no Accounting configuration row yet.
 *
 * Accountability is unaffected by any policy: `created_by`, `approved_by`,
 * `posted_by`, `confirmed_by` and `reversed_by` are always recorded, and every
 * action is always written to `audit_events`. The policy only decides whether
 * those columns must hold DIFFERENT accounts.
 */
export const accountingSegregationPolicies = ["strict", "conditional", "single_user"] as const;
export type AccountingSegregationPolicy = (typeof accountingSegregationPolicies)[number];

/** Fallback for a Company with no Accounting configuration row yet. */
export const accountingDefaultSegregationPolicy: AccountingSegregationPolicy = "single_user";
