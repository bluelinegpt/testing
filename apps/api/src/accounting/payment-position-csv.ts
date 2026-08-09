import type {
  PaymentPositionMetadata,
  PaymentPositionPartySummary,
  PaymentPositionTransaction,
} from "./payment-position.service.js";

/**
 * CSV for the Unified Payment Position.
 *
 * ===========================================================================
 * WHY NOT THE SHARED EXPORT PIPELINE
 * ===========================================================================
 *
 * `AccountingReportExportService.tabular()` serialises one table of columns and
 * rows. This report has two, with different columns and different meanings --
 * positions per party, and the transactions behind them. Flattening them into a
 * single table would either drop the per-party roll-up or repeat it on every
 * transaction row, and neither is the report.
 *
 * So the SERIALISATION is new and the CALCULATION is not. This file receives
 * the objects `PaymentPositionService` already produced and turns them into
 * text. It contains no arithmetic: no `+`, no `-`, no total. Not even the
 * running balance, which arrives already computed by a window function over the
 * whole filtered set.
 */

/**
 * Quote every cell, always.
 *
 * Unconditional quoting is what preserves source references and leading zeros
 * as written: an unquoted `007` is a number to most parsers, a quoted one is
 * text. Matches `csvCell` in the shared export service so the two agree.
 */
function cell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

const labels = {
  ar: {
    accountingEvent: "الحدث المحاسبي",
    direction: "الاتجاه",
    dueDate: "تاريخ الاستحقاق",
    filters: "عوامل التصفية",
    grandTotals: "الإجماليات",
    journal: "القيد",
    lastMovementDate: "آخر دفع / تحصيل",
    originalAmount: "المبلغ الأصلي",
    outstandingAmount: "القائم",
    overdueAmount: "المتأخر",
    overdueNote:
      "لا يسجل أي مصدر تاريخ استحقاق. يعني التأخر بقاء المبلغ قائماً لأكثر من {days} يوماً، وتواريخ الاستحقاق مشتقة من هذا الحد وليست شروط سداد متفقاً عليها.",
    parties: "الأوضاع حسب الطرف",
    partyName: "الطرف",
    partyReference: "مرجع الطرف",
    partyType: "نوع الطرف",
    runningBalance: "الرصيد التراكمي",
    settledAmount: "المدفوع / المحصّل",
    sort: "الترتيب",
    sourceReference: "المرجع",
    status: "الحالة",
    title: "الوضع الموحد للمدفوعات",
    transactionCount: "عدد الحركات",
    transactionDate: "تاريخ الحركة",
    transactionType: "النوع",
    transactions: "الحركات",
    truncated: "تنبيه: بلغ التصدير الحد الأقصى للصفوف وتم اقتطاعه.",
    warning: "تنبيه",
  },
  en: {
    accountingEvent: "Accounting Event",
    direction: "Direction",
    dueDate: "Due Date",
    filters: "Filters",
    grandTotals: "Totals",
    journal: "Journal",
    lastMovementDate: "Last Payment / Collection",
    originalAmount: "Original Amount",
    outstandingAmount: "Outstanding",
    overdueAmount: "Overdue",
    overdueNote:
      "No source records a due date. Overdue means outstanding for more than {days} days, and the due dates shown are derived from that threshold rather than agreed payment terms.",
    parties: "Positions by Party",
    partyName: "Party",
    partyReference: "Party Reference",
    partyType: "Party Type",
    runningBalance: "Running Balance",
    settledAmount: "Paid / Collected",
    sort: "Sort",
    sourceReference: "Reference",
    status: "Status",
    title: "Unified Payment Position",
    transactionCount: "Transactions",
    transactionDate: "Transaction Date",
    transactionType: "Type",
    transactions: "Transactions",
    truncated: "Warning: the export reached its row limit and was truncated.",
    warning: "Warning",
  },
} as const;

export type PaymentPositionLanguage = keyof typeof labels;

/** Both sections as one CSV, in the same order as the screen. */
export function paymentPositionCsv(input: {
  readonly filters: Readonly<Record<string, string | boolean | number | undefined>>;
  readonly language: PaymentPositionLanguage;
  readonly metadata: PaymentPositionMetadata;
  readonly parties: readonly PaymentPositionPartySummary[];
  readonly sort: string;
  readonly totals: {
    readonly originalAmount: string;
    readonly outstandingAmount: string;
    readonly overdueAmount: string;
    readonly settledAmount: string;
    readonly transactionCount: number;
  };
  readonly transactions: readonly PaymentPositionTransaction[];
  readonly truncated: boolean;
}): Buffer {
  const l = labels[input.language];
  const pair = (label: string, value: unknown) => [cell(label), cell(value)].join(",");
  const lines: string[] = [cell(l.title), ""];

  lines.push(cell(l.filters));
  for (const [key, value] of Object.entries(input.filters)) {
    if (value !== undefined && value !== "" && value !== false) lines.push(pair(key, value));
  }
  lines.push(pair(l.sort, input.sort));
  lines.push("");

  // Stated in the export as well as on screen: a CSV read on its own must not
  // let a derived due date pass for an agreed payment term.
  lines.push(
    pair(l.warning, l.overdueNote.replace("{days}", String(input.metadata.overdueAfterDays))),
  );
  if (input.truncated) lines.push(pair(l.warning, l.truncated));
  lines.push("");

  lines.push(cell(l.grandTotals));
  lines.push(pair(l.originalAmount, input.totals.originalAmount));
  lines.push(pair(l.settledAmount, input.totals.settledAmount));
  lines.push(pair(l.outstandingAmount, input.totals.outstandingAmount));
  lines.push(pair(l.overdueAmount, input.totals.overdueAmount));
  lines.push(pair(l.transactionCount, input.totals.transactionCount));
  lines.push("");

  lines.push(cell(l.parties));
  lines.push(
    [
      l.partyType,
      l.partyName,
      l.partyReference,
      l.direction,
      l.originalAmount,
      l.settledAmount,
      l.outstandingAmount,
      l.overdueAmount,
      l.transactionCount,
      l.lastMovementDate,
      l.runningBalance,
    ]
      .map(cell)
      .join(","),
  );
  for (const party of input.parties) {
    lines.push(
      [
        party.partyType,
        party.partyName ?? "",
        party.partyReference ?? "",
        party.direction,
        party.originalAmount,
        party.settledAmount,
        party.outstandingAmount,
        party.overdueAmount,
        party.transactionCount,
        party.lastMovementDate ?? "",
        party.runningBalance,
      ]
        .map(cell)
        .join(","),
    );
  }
  lines.push("");

  lines.push(cell(l.transactions));
  lines.push(
    [
      l.partyType,
      l.partyName,
      l.transactionType,
      l.sourceReference,
      l.transactionDate,
      l.dueDate,
      l.direction,
      l.originalAmount,
      l.settledAmount,
      l.outstandingAmount,
      l.status,
      l.accountingEvent,
      l.journal,
    ]
      .map(cell)
      .join(","),
  );
  for (const row of input.transactions) {
    lines.push(
      [
        row.partyType,
        row.partyName ?? "",
        row.transactionType,
        row.sourceReference,
        row.transactionDate,
        row.dueDate ?? "",
        // Direction stays a WORD. The service returns magnitudes; negating one
        // here would be this file doing arithmetic.
        row.direction,
        row.originalAmount,
        row.settledAmount,
        row.outstandingAmount,
        row.status,
        row.accountingEventId ?? "",
        row.journalNumber ?? "",
      ]
        .map(cell)
        .join(","),
    );
  }

  // BOM so Excel opens UTF-8 correctly, which is what makes the Arabic export
  // readable; CRLF to match the shared export service.
  return Buffer.from(`\ufeff${lines.join("\r\n")}`, "utf8");
}
