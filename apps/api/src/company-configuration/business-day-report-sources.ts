/**
 * Which timestamp each report means when it says "when did this happen".
 *
 * One place, because the alternative is every report service picking a column
 * on its own and two reports quietly disagreeing about what happened on a given
 * night. A Business Date window is only as correct as the column it filters.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT DECIDES CAPABILITY
 * ---------------------------------------------------------------------------
 *
 * A Business Date window is INTRADAY: it opens at 08:00 and closes at 08:00 the
 * next day. Placing a record inside it therefore requires knowing the time of
 * day the record happened.
 *
 * Most money records in this repository do NOT record that. `payment_date`,
 * `movement_date`, `business_date` and `accounting_date` are `date` columns
 * chosen by a person, not instants observed by the system. A record dated
 * 05 Aug carries no evidence of whether it happened at 02:00 or 22:00, so no
 * amount of arithmetic can decide which business day it belongs to.
 *
 * Two tempting substitutes are rejected outright:
 *
 *   `created_at`  - when the row was typed, not when the money moved. A
 *                   payment entered on Monday for Friday's cash would land in
 *                   Monday's report. Available is not the same as authoritative.
 *   Journal Date  - an accounting period assignment, not an operational
 *                   instant. Reading it as activity conflates the two calendars
 *                   this feature exists to keep apart.
 *
 * So a report is Business-Date-capable only when the record itself carries an
 * observed instant for the thing being reported. Where it does not, the report
 * stays on its existing date basis and the reason is recorded below rather than
 * papered over.
 */

/** What a report's dates mean. */
export type ReportDateBasis =
  /** Journal/Accounting Date. Financial statements. Never a business day. */
  | "accounting_date"
  /** A user-chosen `date` column. Real, but has no time of day. */
  | "calendar_date"
  /** An observed instant. Can be placed in a business day. */
  | "business_day_capable";

export interface ReportTimestampSource {
  /** The column that decides the report, once chosen. */
  readonly column: string;
  readonly basis: ReportDateBasis;
  /**
   * True when the column was added prospectively, so older rows hold null.
   *
   * Those rows are EXCLUDED from Business Date results and the report must say
   * so. Silently dropping them would understate a total; filling them from
   * `created_at` would mix guessed rows with authoritative ones in the same
   * number, which is worse.
   */
  readonly historicalNulls?: boolean;
  /** Why this column and not another. Written for a reader, not a linter. */
  readonly rationale: string;
  readonly report: string;
  readonly table: string;
}

/**
 * Group A — financial statements. Accounting Date, permanently.
 *
 * Listed rather than omitted so a later reader can see these were considered
 * and deliberately excluded, not forgotten.
 */
export const accountingDateReports = [
  "trial-balance",
  "general-ledger",
  "account-statement",
  "profit-and-loss",
  "balance-sheet",
] as const;

export const reportTimestampSources: readonly ReportTimestampSource[] = [
  {
    basis: "business_day_capable",
    column: "delivered_at",
    rationale:
      "The moment the system observed the delivery, not a date somebody typed. The only operational instant in this set that is captured automatically.",
    report: "order-delivery-activity",
    table: "orders",
  },
  {
    basis: "business_day_capable",
    column: "confirmed_at",
    rationale:
      "Set exactly when a Driver Collection is confirmed; a CHECK constraint ties it to the confirmed status, so it cannot be present on a draft or absent on a confirmed row.",
    report: "driver-collection-activity",
    table: "driver_reconciliations",
  },
  {
    basis: "business_day_capable",
    column: "confirmed_at",
    rationale:
      "Same guarantee as Driver Collections: constrained to exist if and only if the Settlement is confirmed.",
    report: "trader-settlement-activity",
    table: "trader_settlements",
  },
  {
    basis: "business_day_capable",
    column: "confirmed_at",
    rationale:
      "Records when the Movement was confirmed into the ledger. `movement_date` and `accounting_date` sit alongside it as date-only fields and are NOT interchangeable with it.",
    report: "cash-bank-movement-activity",
    table: "cash_bank_movements",
  },
  {
    basis: "business_day_capable",
    column: "confirmed_at",
    rationale:
      "Not-null on this table, so every payment row carries the instant it was confirmed. `payment_date` remains the user's chosen accounting day and is unaffected.",
    report: "general-expense-payment-activity",
    table: "general_expense_payments",
  },
  {
    basis: "business_day_capable",
    column: "created_at | processed_at | failed_at",
    rationale:
      "AMBIGUOUS BY NATURE, so the report must choose rather than this map. 'How many Events arrived last night' means created_at; 'how many were processed' means processed_at; 'what failed' means failed_at. Exposed as an explicit activity measure, never defaulted.",
    report: "accounting-event-activity",
    table: "accounting_events",
  },

  // ---------------------------------------------------------------------------
  // Capable, but only from now on.
  // ---------------------------------------------------------------------------

  // The three below gained `confirmed_at` in
  // `20260805130000_operational_confirmation_timestamps`. It is PROSPECTIVE:
  // rows written before that migration carry null and are excluded from
  // Business Date results rather than estimated from `created_at`, which is
  // when the row was typed, or from `payment_date`, which has no time of day.
  {
    basis: "business_day_capable",
    column: "confirmed_at",
    historicalNulls: true,
    rationale:
      "Added prospectively. `payment_date` remains the accounting day; it is date-only and cannot place a record inside an intraday window.",
    report: "trader-collection-activity",
    table: "trader_collections",
  },
  {
    basis: "business_day_capable",
    column: "confirmed_at",
    historicalNulls: true,
    rationale:
      "Added prospectively. Payroll CALCULATION remains calendar-month based and is untouched; only payment activity reporting uses this column.",
    report: "payroll-payment-activity",
    table: "payroll_payments",
  },
  {
    basis: "business_day_capable",
    column: "confirmed_at",
    historicalNulls: true,
    rationale:
      "Added prospectively. Fee accrual calculation is unaffected; this column describes only when the payment was confirmed.",
    report: "outsourced-driver-fee-payment-activity",
    table: "outsourced_driver_fee_payments",
  },
  // ---------------------------------------------------------------------------
  // Group C — real reports, but no observed instant to place in a business day.
  // ---------------------------------------------------------------------------

  {
    basis: "accounting_date",
    column: "business_date",
    rationale:
      "NAME COLLISION, and an important one: journal_entries.business_date is the ACCOUNTING date of the Journal, not the Company Business Date this feature introduces. The Cash Movement report is built from posted Journal lines, so it is a financial report wearing an operational name and stays on Accounting Date.",
    report: "cash-movement",
    table: "journal_entries",
  },
  {
    basis: "calendar_date",
    column: "expense_date",
    rationale:
      "Recognition is a date-only decision. Only the PAYMENT carries an instant, which is why general-expense-payment-activity is capable and expense recognition is not.",
    report: "general-expenses",
    table: "general_expenses",
  },
  {
    basis: "calendar_date",
    column: "period_start",
    rationale: "Anchored to a month. A business day does not divide a payroll period.",
    report: "payroll-period-summary",
    table: "payroll_periods",
  },
  {
    basis: "calendar_date",
    column: "business_date",
    rationale:
      "Another name collision: this is an existing date-only field with its own established meaning. It is NOT the Company Business Date and was deliberately left alone.",
    report: "trader-receivable-activity",
    table: "trader_receivables",
  },
];

/** Reports that can honestly offer Business Date mode. */
export const businessDayCapableReports = reportTimestampSources
  .filter((source) => source.basis === "business_day_capable")
  .map((source) => source.report);

export const reportTimestampSource = (report: string): ReportTimestampSource | undefined =>
  reportTimestampSources.find((source) => source.report === report);

/**
 * Two reports, similar names, opposite meanings.
 *
 * `cash-bank-movement-activity` is OPERATIONAL: it reads
 * `cash_bank_movements.confirmed_at`, an observed instant, and can offer
 * Business Date mode.
 *
 * `cash-movement` is FINANCIAL: it is built from posted Journal lines and reads
 * `journal_entries.business_date`, which despite the column name is the
 * ACCOUNTING date. It stays Accounting-Date-based.
 *
 * Giving both the same date-mode behaviour because their names look alike would
 * silently change what a financial report means.
 */
export const dateModesFor = (report: string): readonly ReportDateMode[] => {
  if ((accountingDateReports as readonly string[]).includes(report)) return ["accounting_date"];
  const source = reportTimestampSource(report);
  if (source === undefined) return ["calendar_date"];
  if (source.basis === "accounting_date") return ["accounting_date"];
  if (source.basis === "business_day_capable") return ["calendar_date", "business_date"];
  return ["calendar_date"];
};

/** What a request may ask for. Validated per report by `dateModesFor`. */
export type ReportDateMode = "accounting_date" | "business_date" | "calendar_date";
