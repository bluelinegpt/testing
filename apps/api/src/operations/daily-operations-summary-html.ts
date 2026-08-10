import type { DailyOperationsSummaryReport } from "./daily-operations-summary.service.js";

/**
 * Pure HTML document builder for the Daily Operations Summary PDF. Never
 * calls any API and never touches report data beyond formatting the
 * already-resolved snapshot — rendered to a real PDF server-side by the
 * SAME shared Chromium renderer every other report PDF already uses
 * (`DriverCollectionPdfService`), never a second PDF engine.
 */

export type ReportLanguage = "en" | "ar";

interface Labels {
  readonly amount: string;
  readonly breakEven: string;
  readonly businessDate: string;
  readonly businessDayMode: string;
  readonly calendarDate: string;
  readonly calendarDayMode: string;
  readonly dateMode: string;
  readonly deliveredOrders: string;
  readonly description: string;
  readonly driver: string;
  readonly driverCode: string;
  readonly expenseType: string;
  readonly expensesTitle: string;
  readonly grandTotal: string;
  readonly negative: string;
  readonly netResult: string;
  readonly payee: string;
  readonly period: string;
  readonly positive: string;
  readonly reference: string;
  readonly status: string;
  readonly summaryTitle: string;
  readonly title: string;
  readonly totalDeliveryIncome: string;
  readonly totalExpenses: string;
  readonly totalOrders: string;
}

const LABELS: Readonly<Record<ReportLanguage, Labels>> = {
  en: {
    amount: "Amount",
    breakEven: "Break-even / Zero",
    businessDate: "Business Date",
    businessDayMode: "Business Day",
    calendarDate: "Calendar Date",
    calendarDayMode: "Calendar Day",
    dateMode: "Date Mode",
    deliveredOrders: "Delivered Orders",
    description: "Description",
    driver: "Driver",
    driverCode: "Driver Code",
    expenseType: "Type",
    expensesTitle: "Expenses and Payments",
    grandTotal: "Grand Total",
    negative: "Negative",
    netResult: "Net Result",
    payee: "Payee",
    period: "Period",
    positive: "Positive",
    reference: "Reference",
    status: "Status",
    summaryTitle: "Driver Delivery Summary",
    title: "Daily Operations Summary",
    totalDeliveryIncome: "Total Delivery Income",
    totalExpenses: "Total Expenses",
    totalOrders: "Total Orders",
  },
  ar: {
    amount: "المبلغ",
    breakEven: "تعادل / صفر",
    businessDate: "تاريخ يوم العمل",
    businessDayMode: "يوم العمل",
    calendarDate: "التاريخ الميلادي",
    calendarDayMode: "اليوم الميلادي",
    dateMode: "نوع التاريخ",
    deliveredOrders: "الطلبات المُسلَّمة",
    description: "الوصف",
    driver: "السائق",
    driverCode: "رمز السائق",
    expenseType: "النوع",
    expensesTitle: "المصروفات والمدفوعات",
    grandTotal: "الإجمالي الكلي",
    negative: "سلبي",
    netResult: "صافي النتيجة",
    payee: "المستفيد",
    period: "الفترة",
    positive: "إيجابي",
    reference: "المرجع",
    status: "الحالة",
    summaryTitle: "ملخص تسليم السائقين",
    title: "الملخص التشغيلي اليومي",
    totalDeliveryIncome: "إجمالي إيرادات التوصيل",
    totalExpenses: "إجمالي المصروفات",
    totalOrders: "إجمالي الطلبات",
  },
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function money(value: string): string {
  return `AED ${escapeHtml(value)}`;
}

export function buildDailyOperationsSummaryHtml(
  report: DailyOperationsSummaryReport,
  language: ReportLanguage,
  generatedAt: string,
): string {
  const labels = LABELS[language];
  const dir = language === "ar" ? "rtl" : "ltr";

  const driverRows = report.driverSummary
    .map(
      (row) =>
        "<tr>" +
        `<td>${escapeHtml(row.driverName)}</td>` +
        `<td class="mono">${escapeHtml(row.driverCode)}</td>` +
        `<td class="num">${row.deliveredOrders}</td>` +
        `<td class="num">${money(row.deliveryIncome)}</td>` +
        "</tr>",
    )
    .join("");
  const driverTable =
    `<table class="grid"><thead><tr>` +
    [labels.driver, labels.driverCode, labels.deliveredOrders, labels.amount]
      .map((label) => `<th>${escapeHtml(label)}</th>`)
      .join("") +
    `</tr></thead><tbody>${driverRows}` +
    `<tr class="total-row"><td colspan="2">${escapeHtml(labels.grandTotal)}</td>` +
    `<td class="num">${report.totalOrders}</td><td class="num">${money(report.totalDeliveryIncome)}</td></tr>` +
    `</tbody></table>`;

  const expenseRows = report.expenses
    .map(
      (row) =>
        "<tr>" +
        `<td>${escapeHtml(row.businessDate)}</td>` +
        `<td>${escapeHtml(row.calendarDate)}</td>` +
        `<td>${escapeHtml(row.type)}</td>` +
        `<td>${escapeHtml(row.description)}</td>` +
        `<td>${row.payee === null ? "" : escapeHtml(row.payee)}</td>` +
        // No hyperlink in a static PDF -- the identifying reference itself is
        // printed, which is what a reader needs to look the source record up.
        `<td class="mono">${escapeHtml(row.reference)}</td>` +
        `<td class="num">${money(row.amount)}</td>` +
        "</tr>",
    )
    .join("");
  // Both dates always shown, in either mode -- exactly the pairing that
  // explains a payment at 00:xx before the cutoff: Business Date 10 Aug,
  // Calendar Date 11 Aug.
  const expenseTable =
    `<table class="grid"><thead><tr>` +
    [
      labels.businessDate,
      labels.calendarDate,
      labels.expenseType,
      labels.description,
      labels.payee,
      labels.reference,
      labels.amount,
    ]
      .map((label) => `<th>${escapeHtml(label)}</th>`)
      .join("") +
    `</tr></thead><tbody>${expenseRows}` +
    `<tr class="total-row"><td colspan="6">${escapeHtml(labels.totalExpenses)}</td>` +
    `<td class="num">${money(report.totalExpenses)}</td></tr>` +
    `</tbody></table>`;

  const netLabel =
    report.netStatus === "positive"
      ? labels.positive
      : report.netStatus === "negative"
        ? labels.negative
        : labels.breakEven;
  const netSign = Number(report.netResult) > 0 ? "+" : "";
  const netClass =
    report.netStatus === "positive" ? "net-positive" : report.netStatus === "negative" ? "net-negative" : "";

  const style = `
    @page { size: A4; margin: 14mm 12mm 18mm; }
    * { box-sizing: border-box; }
    body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; color: #111; margin: 0; font-size: 11px; }
    .report-header { border-bottom: 2px solid #333; margin-bottom: 10px; padding-bottom: 8px; }
    .report-title { font-size: 18px; margin: 8px 0 6px; }
    .meta-line { font-size: 11px; color: #444; }
    .section-title { font-size: 13px; margin: 14px 0 6px; }
    table.grid { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 10px; }
    table.grid th, table.grid td { border: 1px solid #999; padding: 3px 5px; text-align: start; }
    table.grid thead th { background: #f0f0f0; }
    table.grid td.num, table.grid th.num { text-align: end; white-space: nowrap; }
    .mono { font-variant-numeric: tabular-nums; }
    .total-row { font-weight: 700; background: #f7f7f7; }
    .summary-section { margin-top: 12px; max-width: 360px; }
    .summary-line { display: flex; justify-content: space-between; border-bottom: 1px solid #ddd; padding: 4px 0; font-size: 12px; }
    .net-positive { color: #146c2e; font-weight: 800; }
    .net-negative { color: #a01818; font-weight: 800; }
    tr { break-inside: avoid; }
  `;

  const dateModeLabel = report.dateMode === "calendar_day" ? labels.calendarDayMode : labels.businessDayMode;

  return (
    `<!doctype html><html dir="${dir}" lang="${language}"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(labels.title)}</title>` +
    `<style>${style}</style></head><body>` +
    `<div class="report-header"><div class="report-title">${escapeHtml(labels.title)}</div>` +
    `<div class="meta-line">${escapeHtml(labels.dateMode)}: ${escapeHtml(dateModeLabel)}</div>` +
    `<div class="meta-line">${escapeHtml(labels.period)}: ${escapeHtml(report.metadata.dateFrom)} — ${escapeHtml(report.metadata.dateTo)}</div>` +
    `<div class="meta-line">${escapeHtml(generatedAt)}</div></div>` +
    `<div class="section-title">${escapeHtml(labels.summaryTitle)}</div>${driverTable}` +
    `<div class="section-title">${escapeHtml(labels.expensesTitle)}</div>${expenseTable}` +
    `<div class="summary-section">` +
    `<div class="summary-line"><span>${escapeHtml(labels.totalOrders)}</span><span>${report.totalOrders}</span></div>` +
    `<div class="summary-line"><span>${escapeHtml(labels.totalDeliveryIncome)}</span><span>${money(report.totalDeliveryIncome)}</span></div>` +
    `<div class="summary-line"><span>${escapeHtml(labels.totalExpenses)}</span><span>${money(report.totalExpenses)}</span></div>` +
    `<div class="summary-line ${netClass}"><span>${escapeHtml(labels.netResult)}</span><span>${netSign}${money(report.netResult)}</span></div>` +
    `<div class="summary-line ${netClass}"><span>${escapeHtml(labels.status)}</span><span>${escapeHtml(netLabel)}</span></div>` +
    `</div></body></html>`
  );
}
