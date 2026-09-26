import { Decimal } from "decimal.js";

import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  accountingAccountClasses,
  type AccountingAccountClass,
  type AccountingAccountType,
  type AccountingFiscalPeriodStatus,
  type AccountingFiscalYearStatus,
  type AccountingJournalStatus,
  type AccountingNormalBalance,
} from "./accounting.constants.js";

const badRequest = 400;
const conflict = 409;

const moneyPattern = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
const exchangeRatePattern = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
type AccountingNumeric = Decimal | number | string;

function decimalFromInput(value: unknown, pattern: RegExp, errorCode: string): Decimal {
  const normalized = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!pattern.test(normalized)) {
    throw new ApplicationException(
      errorCode,
      "The Accounting numeric value is invalid",
      badRequest,
    );
  }
  try {
    const decimal = new Decimal(normalized);
    if (!decimal.isFinite()) throw new Error("non-finite");
    return decimal;
  } catch {
    throw new ApplicationException(
      errorCode,
      "The Accounting numeric value is invalid",
      badRequest,
    );
  }
}

export function parseAccountingMoney(value: unknown, allowZero = true): Decimal {
  const decimal = decimalFromInput(value, moneyPattern, "accounting_invalid_numeric_value");
  if (decimal.isNegative() || (!allowZero && decimal.isZero())) {
    throw new ApplicationException(
      "accounting_negative_amount_not_allowed",
      allowZero
        ? "Accounting amounts cannot be negative"
        : "The Accounting amount must be greater than zero",
      badRequest,
    );
  }
  return decimal;
}

export function parseAccountingExchangeRate(value: unknown): Decimal {
  const rate = decimalFromInput(value, exchangeRatePattern, "accounting_invalid_exchange_rate");
  // Decimal.isPositive() is a SIGN check that returns true for zero, so it can
  // never enforce "greater than zero" — compare against zero explicitly.
  if (!rate.greaterThan(0)) {
    throw new ApplicationException(
      "accounting_invalid_exchange_rate",
      "The Accounting exchange rate must be greater than zero",
      badRequest,
    );
  }
  return rate;
}

export function assertAccountingCompanyScope(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new ApplicationException(
      "accounting_cross_company_access",
      "The Accounting record does not belong to the active Company",
      conflict,
    );
  }
}

export function assertAccountClassCompatibility(
  accountType: AccountingAccountType,
  accountClass: AccountingAccountClass,
): void {
  if (!(accountingAccountClasses[accountType] as readonly string[]).includes(accountClass)) {
    throw new ApplicationException(
      "accounting_account_class_type_mismatch",
      "The Account Class is incompatible with the Account Type",
      badRequest,
    );
  }
}

export function assertAccountNormalBalance(
  accountType: AccountingAccountType,
  normalBalance: AccountingNormalBalance,
  isContraAccount: boolean,
): void {
  const expected = accountType === "asset" || accountType === "expense" ? "debit" : "credit";
  if (normalBalance !== expected && !isContraAccount) {
    throw new ApplicationException(
      "accounting_account_normal_balance_invalid",
      "The normal balance is incompatible with the Account Type",
      badRequest,
    );
  }
}

export function assertJournalLineAmounts(
  debit: AccountingNumeric,
  credit: AccountingNumeric,
): void {
  const debitAmount = parseAccountingMoney(debit);
  const creditAmount = parseAccountingMoney(credit);
  // greaterThan(0), not isPositive(): Decimal.isPositive() is a sign check
  // that returns true for zero, which made every single-sided line (e.g.
  // debit 5000 / credit 0) read as "both sides entered" and rejected all
  // Manual Journal lines.
  if (debitAmount.greaterThan(0) && creditAmount.greaterThan(0)) {
    throw new ApplicationException(
      "accounting_journal_line_both_sides_entered",
      "A Journal Line cannot contain both a Debit and a Credit",
      badRequest,
    );
  }
  if (debitAmount.isZero() && creditAmount.isZero()) {
    throw new ApplicationException(
      "accounting_journal_line_amount_required",
      "A Journal Line requires either a Debit or a Credit",
      badRequest,
    );
  }
}

export function accountingJournalTotals(
  lines: readonly {
    readonly credit: AccountingNumeric;
    readonly debit: AccountingNumeric;
  }[],
): { readonly credit: Decimal; readonly debit: Decimal } {
  if (lines.length < 2) {
    throw new ApplicationException(
      "accounting_journal_no_lines",
      "A balanced Journal requires at least two Lines",
      badRequest,
    );
  }
  const totals = lines.reduce<{ credit: Decimal; debit: Decimal }>(
    (sum, line) => {
      assertJournalLineAmounts(line.debit, line.credit);
      return {
        credit: sum.credit.plus(parseAccountingMoney(line.credit)),
        debit: sum.debit.plus(parseAccountingMoney(line.debit)),
      };
    },
    { credit: new Decimal(0), debit: new Decimal(0) },
  );
  if (!totals.debit.greaterThan(0) || !totals.credit.greaterThan(0)) {
    throw new ApplicationException(
      "accounting_journal_zero_total",
      "Journal Debit and Credit totals must be greater than zero",
      conflict,
    );
  }
  if (!totals.debit.equals(totals.credit)) {
    throw new ApplicationException(
      "accounting_journal_not_balanced",
      "Journal Debit and Credit totals must be equal",
      conflict,
    );
  }
  return totals;
}

export function assertJournalTransition(
  from: AccountingJournalStatus,
  to: AccountingJournalStatus,
): void {
  const allowed: Readonly<Record<AccountingJournalStatus, readonly AccountingJournalStatus[]>> = {
    approved: ["posted"],
    balanced: ["draft", "approved"],
    cancelled: [],
    draft: ["balanced", "cancelled"],
    posted: ["reversed"],
    reversed: [],
  };
  if (from !== to && !allowed[from].includes(to)) {
    throw new ApplicationException(
      "accounting_journal_invalid_transition",
      `An Accounting Journal cannot transition from ${from} to ${to}`,
      conflict,
    );
  }
}

export function assertPostingPeriodOpen(input: {
  readonly fiscalPeriodStatus: AccountingFiscalPeriodStatus;
  readonly fiscalYearStatus: AccountingFiscalYearStatus;
}): void {
  if (input.fiscalYearStatus === "closed") {
    throw new ApplicationException(
      "accounting_fiscal_year_closed",
      "The Fiscal Year is closed",
      conflict,
    );
  }
  if (input.fiscalPeriodStatus === "soft_closed") {
    throw new ApplicationException(
      "accounting_fiscal_period_soft_closed",
      "The Fiscal Period is soft-closed",
      conflict,
    );
  }
  if (
    !["open", "reopened"].includes(input.fiscalYearStatus) ||
    !["open", "reopened"].includes(input.fiscalPeriodStatus)
  ) {
    throw new ApplicationException(
      "accounting_fiscal_period_closed",
      "The Fiscal Period is not open for posting",
      conflict,
    );
  }
}
