import type {
  DailyCashActivityReport,
  DailyCashActivityRow,
} from "./daily-cash-activity.service.js";

/**
 * CSV for the Daily Cash and Financial Activity Report.
 *
 * ===========================================================================
 * WHY THIS IS NOT THE SHARED EXPORT PIPELINE
 * ===========================================================================
 *
 * `AccountingReportExportService.tabular()` serialises an
 * `AccountingReportEnvelope`: metadata key/value lines, then ONE table of
 * columns and rows. Every accounting report it serves has that shape.
 *
 * This report does not. It has three sections with three different shapes --
 * Cash Activity (label/amount pairs, Cash and Bank kept apart), Income
 * Statement Activity (a different set of label/amount pairs on a different
 * calendar), and the drill-down (a wide transaction table). Flattening them
 * into one table would either lose the separation between Cash and Income --
 * the whole point of the report -- or need the envelope redesigned, which the
 * prompt's PDF rule explicitly rules out for this phase.
 *
 * So the SERIALISATION is new and the CALCULATION is not. This file receives
 * the exact objects `DailyCashActivityService` already returned to the screen
 * and turns them into text. It performs no arithmetic of any kind: there is no
 * `+`, no `-`, and no total computed here. Search for one and you will not find
 * it, which is the intended guarantee.
 */

/**
 * Quote every cell, always.
 *
 * Unconditional quoting is what preserves Reference Numbers and leading zeros
 * as written: an unquoted `007` is a number to most parsers, a quoted one is
 * text. Matches `csvCell` in the shared export service so both files agree.
 */
function cell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

const labels = {
  ar: {
    account: "الحساب",
    accountingEvent: "الحدث المحاسبي",
    amount: "المبلغ",
    authoritativeTimestamps: "الطابع الزمني المعتمد لكل مصدر",
    bankCollected: "المحصّل بنك / فيزا",
    bankPaid: "المدفوع بنك / فيزا",
    businessDate: "تاريخ يوم العمل",
    businessDayStart: "بداية يوم العمل",
    cashActivity: "النشاط النقدي",
    cashCollected: "النقد المحصّل",
    cashPaid: "النقد المدفوع",
    closingBank: "الرصيد البنكي الختامي",
    closingCash: "النقد الختامي",
    column: "العمود",
    confirmedAt: "وقت التأكيد",
    coverage: "التغطية",
    coverageComplete: "جميع السجلات",
    coverageProspective: "من تاريخ الترحيل فصاعداً",
    direction: "الاتجاه",
    directionIn: "محصّل",
    directionOut: "مدفوع",
    drillDown: "الحركات",
    expensesRecognized: "المصروفات المعترف بها",
    filters: "عوامل التصفية",
    incomeStatement: "نشاط قائمة الدخل",
    incomeStatementNote:
      "معترف بها في تاريخ القيد، لا في نافذة يوم العمل. النقد المحصّل ليس إيراداً والنقد المدفوع ليس مصروفاً.",
    journal: "القيد",
    metadata: "نافذة يوم العمل",
    netBank: "صافي الحركة البنكية",
    netCash: "صافي حركة النقد",
    netIncomeActivity: "صافي نشاط الدخل",
    openingBank: "الرصيد البنكي الافتتاحي",
    openingCash: "النقد الافتتاحي",
    outstandingToCollect: "المستحق التحصيل",
    outstandingToPay: "المستحق السداد",
    party: "الطرف",
    partyType: "نوع الطرف",
    paymentMethod: "الطريقة",
    revenueRecognized: "الإيرادات المعترف بها",
    segments: "شرائح الإعداد المطبّقة",
    sourceReference: "المرجع",
    sourceType: "المصدر",
    table: "الجدول",
    timezone: "المنطقة الزمنية",
    title: "النشاط النقدي والمالي اليومي",
    truncated: "تنبيه: بلغ التصدير الحد الأقصى للصفوف وتم اقتطاعه.",
    warning: "تنبيه",
    windowEnd: "نهاية النافذة",
    windowStart: "بداية النافذة",
  },
  en: {
    account: "Account",
    accountingEvent: "Accounting Event",
    amount: "Amount",
    authoritativeTimestamps: "Authoritative Timestamp per Source",
    bankCollected: "Bank / Visa Collected",
    bankPaid: "Bank / Visa Paid",
    businessDate: "Business Date",
    businessDayStart: "Business Day Start",
    cashActivity: "Cash Activity",
    cashCollected: "Cash Collected",
    cashPaid: "Cash Paid",
    closingBank: "Closing Bank",
    closingCash: "Closing Cash",
    column: "Column",
    confirmedAt: "Confirmed At",
    coverage: "Coverage",
    coverageComplete: "All rows",
    coverageProspective: "From migration onward",
    direction: "Direction",
    directionIn: "Collected",
    directionOut: "Paid",
    drillDown: "Movements",
    expensesRecognized: "Expenses Recognised",
    filters: "Filters",
    incomeStatement: "Income Statement Activity",
    incomeStatementNote:
      "Recognised on the Accounting Date, not the Business Day window. Cash collected is not revenue and cash paid is not expense.",
    journal: "Journal",
    metadata: "Business Day Window",
    netBank: "Net Bank Movement",
    netCash: "Net Cash Movement",
    netIncomeActivity: "Net Income Activity",
    openingBank: "Opening Bank",
    openingCash: "Opening Cash",
    outstandingToCollect: "Outstanding to Collect",
    outstandingToPay: "Outstanding to Pay",
    party: "Party",
    partyType: "Party Type",
    paymentMethod: "Method",
    revenueRecognized: "Revenue Recognised",
    segments: "Applied Configuration Segments",
    sourceReference: "Reference",
    sourceType: "Source",
    table: "Table",
    timezone: "Timezone",
    title: "Daily Cash and Financial Activity",
    truncated: "Warning: the export reached its row limit and was truncated.",
    warning: "Warning",
    windowEnd: "Window End",
    windowStart: "Window Start",
  },
} as const;

export type DailyCashActivityLanguage = keyof typeof labels;

/**
 * The whole report as one sectioned CSV.
 *
 * Section order mirrors the screen exactly -- Cash Activity, Income Statement
 * Activity, window metadata, then the drill-down -- so a reader comparing the
 * two is comparing the same document in a different medium. Cash and Bank/Visa
 * stay on separate rows throughout, and no row is labelled both.
 */
export function dailyCashActivityCsv(input: {
  readonly filters: Readonly<Record<string, string | undefined>>;
  readonly language: DailyCashActivityLanguage;
  readonly report: DailyCashActivityReport;
  readonly rows: readonly DailyCashActivityRow[];
  readonly truncated: boolean;
}): Buffer {
  const l = labels[input.language];
  const { cashActivity, incomeStatementActivity: income, metadata } = input.report;
  const pair = (label: string, value: unknown) => [cell(label), cell(value)].join(",");
  const lines: string[] = [pair(l.title, metadata.businessDate), ""];

  lines.push(cell(l.filters));
  for (const [key, value] of Object.entries(input.filters)) {
    if (value !== undefined && value !== "") lines.push(pair(key, value));
  }
  lines.push("");

  if (metadata.excludedRowsWithoutTimestamp > 0) {
    lines.push(
      pair(
        l.warning,
        input.language === "ar"
          ? `${metadata.excludedRowsWithoutTimestamp} سجل مؤكّد بدون وقت تأكيد معتمد، مستبعد من النشاط النقدي ولم يُقدَّر.`
          : `${metadata.excludedRowsWithoutTimestamp} confirmed record(s) carry no authoritative confirmation time, are excluded from Cash Activity, and are not estimated.`,
      ),
    );
  }
  if (input.truncated) lines.push(pair(l.warning, l.truncated));
  lines.push("");

  // Cash Activity. Cash and Bank are adjacent but never merged.
  lines.push(cell(l.cashActivity));
  for (const [label, value] of [
    [l.openingCash, cashActivity.openingCashBalance],
    [l.openingBank, cashActivity.openingBankBalance],
    [l.cashCollected, cashActivity.cashCollected],
    [l.bankCollected, cashActivity.bankCollected],
    [l.cashPaid, cashActivity.cashPaid],
    [l.bankPaid, cashActivity.bankPaid],
    [l.netCash, cashActivity.netCashMovement],
    [l.netBank, cashActivity.netBankMovement],
    [l.closingCash, cashActivity.closingCashBalance],
    [l.closingBank, cashActivity.closingBankBalance],
    [l.outstandingToCollect, cashActivity.outstandingToCollect],
    [l.outstandingToPay, cashActivity.outstandingToPay],
  ] as const) {
    lines.push(pair(label, value));
  }
  lines.push("");

  // Income Statement Activity, under its own heading and carrying the same
  // note the screen shows, so a CSV read on its own cannot be mistaken for a
  // cash statement.
  lines.push(cell(l.incomeStatement));
  lines.push(pair(l.warning, l.incomeStatementNote));
  lines.push(pair(l.revenueRecognized, income.revenueRecognized));
  lines.push(pair(l.expensesRecognized, income.expensesRecognized));
  lines.push(pair(l.netIncomeActivity, income.netIncomeActivity));
  lines.push("");

  lines.push(cell(l.metadata));
  lines.push(pair(l.businessDate, metadata.businessDate));
  lines.push(pair(l.windowStart, metadata.startUtc));
  lines.push(pair(l.windowEnd, metadata.displayEnd));
  lines.push(pair(l.timezone, metadata.timezone));
  lines.push(pair(l.businessDayStart, metadata.businessDayStart));
  lines.push("");

  lines.push(cell(l.segments));
  lines.push(
    [l.businessDate, l.businessDayStart, l.timezone, l.windowStart, l.windowEnd]
      .map(cell)
      .join(","),
  );
  for (const segment of metadata.segments) {
    lines.push(
      [
        `${segment.businessDateFrom} - ${segment.businessDateTo}`,
        segment.businessDayStart,
        segment.timezone,
        segment.startUtc,
        segment.displayEnd,
      ]
        .map(cell)
        .join(","),
    );
  }
  lines.push("");

  lines.push(cell(l.authoritativeTimestamps));
  lines.push([l.sourceType, l.table, l.column, l.coverage].map(cell).join(","));
  for (const source of metadata.authoritativeTimestamps) {
    lines.push(
      [
        source.sourceType,
        source.table,
        source.column,
        source.historicalNulls ? l.coverageProspective : l.coverageComplete,
      ]
        .map(cell)
        .join(","),
    );
  }
  lines.push("");

  lines.push(cell(l.drillDown));
  lines.push(
    [
      l.sourceType,
      l.sourceReference,
      l.partyType,
      l.party,
      l.paymentMethod,
      l.direction,
      l.account,
      l.amount,
      l.confirmedAt,
      l.businessDate,
      l.accountingEvent,
      l.journal,
    ]
      .map(cell)
      .join(","),
  );
  for (const row of input.rows) {
    lines.push(
      [
        row.sourceType,
        row.sourceReference,
        row.partyType,
        row.partyName ?? "",
        row.paymentMethod,
        // Direction stays a WORD, not a sign. The service returns magnitudes;
        // negating one here would be this file doing arithmetic.
        row.direction === "in" ? l.directionIn : l.directionOut,
        row.cashAccountName ?? row.bankAccountName ?? "",
        row.amount,
        row.confirmedAt,
        row.businessDate ?? "",
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
