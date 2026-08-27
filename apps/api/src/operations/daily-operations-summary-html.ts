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
  readonly amountToPay: string;
  readonly breakEven: string;
  readonly businessDate: string;
  readonly businessDayMode: string;
  readonly calendarDate: string;
  readonly customer: string;
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
  readonly paymentMethod: string;
  readonly period: string;
  readonly positive: string;
  readonly previouslyPaid: string;
  readonly reference: string;
  readonly status: string;
  readonly summaryTitle: string;
  readonly title: string;
  readonly totalDeliveryIncome: string;
  readonly totalExpenses: string;
  readonly totalOrders: string;
  readonly totalTraderPayments: string;
  readonly totalTraderPayables: string;
  readonly totalTraderReceivables: string;
  readonly trader: string;
  readonly traderPayablesTitle: string;
  readonly traderReceivablesTitle: string;
  readonly sourceReference: string;
  readonly order: string;
  readonly originalAmount: string;
  readonly previouslyCollected: string;
  readonly outstanding: string;
  readonly traderPaymentsTitle: string;
  readonly settlement: string;
}

const LABELS: Readonly<Record<ReportLanguage, Labels>> = {
  en: {
    amount: "Amount",
    amountToPay: "Amount to Pay",
    breakEven: "Break-even / Zero",
    businessDate: "Business Date",
    businessDayMode: "Business Day",
    calendarDate: "Calendar Date",
    customer: "Customer",
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
    paymentMethod: "Payment Method",
    period: "Period",
    positive: "Positive",
    previouslyPaid: "Previously Paid",
    reference: "Reference",
    status: "Status",
    summaryTitle: "Driver Delivery Summary",
    title: "Daily Operations Summary",
    totalDeliveryIncome: "Total Delivery Income",
    totalExpenses: "Total Expenses",
    totalOrders: "Total Orders",
    totalTraderPayments: "Total Trader Payments",
    totalTraderPayables: "Total Money to Pay to Traders",
    totalTraderReceivables: "Total Money to Collect from Traders",
    trader: "Trader",
    traderPayablesTitle: "Money to Pay to Traders",
    traderReceivablesTitle: "Money to Collect from Traders",
    sourceReference: "Source Reference",
    order: "Order",
    originalAmount: "Original Amount",
    previouslyCollected: "Previously Collected",
    outstanding: "Outstanding",
    traderPaymentsTitle: "Trader Payments",
    settlement: "Settlement",
  },
  ar: {
    amount: "المبلغ",
    amountToPay: "المبلغ المطلوب دفعه",
    breakEven: "تعادل / صفر",
    businessDate: "تاريخ يوم العمل",
    businessDayMode: "يوم العمل",
    calendarDate: "التاريخ الميلادي",
    customer: "العميل",
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
    paymentMethod: "طريقة الدفع",
    period: "الفترة",
    positive: "إيجابي",
    previouslyPaid: "مدفوع سابقاً",
    reference: "المرجع",
    status: "الحالة",
    summaryTitle: "ملخص تسليم السائقين",
    title: "الملخص التشغيلي اليومي",
    totalDeliveryIncome: "إجمالي إيرادات التوصيل",
    totalExpenses: "إجمالي المصروفات",
    totalOrders: "إجمالي الطلبات",
    totalTraderPayments: "إجمالي مدفوعات التجار",
    totalTraderPayables: "إجمالي المبالغ المطلوب دفعها للتجار",
    totalTraderReceivables: "إجمالي المبالغ المطلوب تحصيلها من التجار",
    trader: "التاجر",
    traderPayablesTitle: "مبالغ مطلوب دفعها للتجار",
    traderReceivablesTitle: "مبالغ مطلوبة من التجار",
    sourceReference: "مرجع المصدر",
    order: "الطلب",
    originalAmount: "المبلغ الأصلي",
    previouslyCollected: "تم تحصيله سابقاً",
    outstanding: "المتبقي",
    traderPaymentsTitle: "مدفوعات التجار",
    settlement: "التسوية",
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

  const traderPaymentRows = report.traderPayments
    .map(
      (row) =>
        "<tr>" +
        `<td>${escapeHtml(row.businessDate)}</td>` +
        `<td>${escapeHtml(row.calendarDate)}</td>` +
        `<td>${escapeHtml(row.traderName)}</td>` +
        `<td class="mono">${escapeHtml(row.orderSerialNumber === null ? row.orderNumber : row.orderSerialNumber)}</td>` +
        `<td class="mono">${row.referenceNumber === null ? "" : escapeHtml(row.referenceNumber)}</td>` +
        `<td>${escapeHtml(row.customerName)}</td>` +
        `<td class="num">${money(row.originalAmountDue)}</td>` +
        `<td class="num">${money(row.previouslyPaid)}</td>` +
        `<td class="num">${money(row.amount)}</td>` +
        "</tr>",
    )
    .join("");
  const traderPaymentTable =
    `<table class="grid compact"><thead><tr>` +
    [
      labels.businessDate,
      labels.calendarDate,
      labels.trader,
      labels.order,
      labels.reference,
      labels.customer,
      labels.originalAmount,
      labels.previouslyPaid,
      labels.amount,
    ]
      .map((label) => `<th>${escapeHtml(label)}</th>`)
      .join("") +
    `</tr></thead><tbody>${traderPaymentRows}` +
    `<tr class="total-row"><td colspan="8">${escapeHtml(labels.totalTraderPayments)}</td>` +
    `<td class="num">${money(report.totalTraderPayments)}</td></tr>` +
    `</tbody></table>`;
  const traderReceivableRows = report.traderReceivables
    .map(
      (row) =>
        "<tr>" +
        `<td>${escapeHtml(row.businessDate)}</td>` +
        `<td>${escapeHtml(row.calendarDate)}</td>` +
        `<td>${escapeHtml(row.traderName)}</td>` +
        `<td class="mono">${escapeHtml(row.receivableNumber)}</td>` +
        `<td class="mono">${row.orderSerialNumber === null ? "" : escapeHtml(row.orderSerialNumber)}</td>` +
        `<td class="mono">${row.sourceReference === null ? "" : escapeHtml(row.sourceReference)}</td>` +
        `<td class="num">${money(row.originalAmountDue)}</td>` +
        `<td class="num">${money(row.amountCollected)}</td>` +
        `<td class="num">${money(row.outstandingAmount)}</td>` +
        "</tr>",
    )
    .join("");
  const traderReceivableTable =
    `<table class="grid compact-grid"><thead><tr>` +
    [
      labels.businessDate,
      labels.calendarDate,
      labels.trader,
      labels.reference,
      labels.order,
      labels.sourceReference,
      labels.originalAmount,
      labels.previouslyCollected,
      labels.outstanding,
    ]
      .map((label) => `<th>${escapeHtml(label)}</th>`)
      .join("") +
    `</tr></thead><tbody>${traderReceivableRows}` +
    `<tr class="total-row"><td colspan="8">${escapeHtml(labels.totalTraderReceivables)}</td>` +
    `<td class="num">${money(report.totalTraderReceivables)}</td></tr>` +
    `</tbody></table>`;
  const traderPayableRows = report.traderPayables
    .map(
      (row) =>
        "<tr>" +
        `<td>${escapeHtml(row.businessDate)}</td>` +
        `<td>${escapeHtml(row.calendarDate)}</td>` +
        `<td>${escapeHtml(row.traderName)}</td>` +
        `<td class="mono">${row.orderSerialNumber === null ? escapeHtml(row.orderNumber) : escapeHtml(row.orderSerialNumber)}</td>` +
        `<td class="mono">${row.referenceNumber === null ? "" : escapeHtml(row.referenceNumber)}</td>` +
        `<td>${escapeHtml(row.customerName)}</td>` +
        `<td class="num">${money(row.originalAmountDue)}</td>` +
        `<td class="num">${money(row.previouslyPaid)}</td>` +
        `<td class="num">${money(row.outstandingAmount)}</td>` +
        "</tr>",
    )
    .join("");
  const traderPayableTable =
    `<table class="grid compact-grid"><thead><tr>` +
    [
      labels.businessDate,
      labels.calendarDate,
      labels.trader,
      labels.order,
      labels.reference,
      labels.customer,
      labels.originalAmount,
      labels.previouslyPaid,
      labels.amountToPay,
    ]
      .map((label) => `<th>${escapeHtml(label)}</th>`)
      .join("") +
    `</tr></thead><tbody>${traderPayableRows}` +
    `<tr class="total-row"><td colspan="8">${escapeHtml(labels.totalTraderPayables)}</td>` +
    `<td class="num">${money(report.totalTraderPayables)}</td></tr>` +
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
    table.grid { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 10px; table-layout: fixed; }
    table.grid th, table.grid td { border: 1px solid #999; padding: 3px 5px; text-align: start; overflow-wrap: anywhere; }
    table.compact-grid { font-size: 8.5px; }
    table.compact-grid th, table.compact-grid td { padding: 2px 3px; }
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
    (report.includeTraderReceivables ? `<div class="section-title">${escapeHtml(labels.traderReceivablesTitle)}</div>${traderReceivableTable}` : "") +
    (report.includeTraderPayables ? `<div class="section-title">${escapeHtml(labels.traderPayablesTitle)}</div>${traderPayableTable}` : "") +
    (report.includeTraderPayments ? `<div class="section-title">${escapeHtml(labels.traderPaymentsTitle)}</div>${traderPaymentTable}` : "") +
    `<div class="summary-section">` +
    `<div class="summary-line"><span>${escapeHtml(labels.totalOrders)}</span><span>${report.totalOrders}</span></div>` +
    `<div class="summary-line"><span>${escapeHtml(labels.totalDeliveryIncome)}</span><span>${money(report.totalDeliveryIncome)}</span></div>` +
    `<div class="summary-line"><span>${escapeHtml(labels.totalExpenses)}</span><span>${money(report.totalExpenses)}</span></div>` +
    (report.includeTraderReceivables ? `<div class="summary-line"><span>${escapeHtml(labels.totalTraderReceivables)}</span><span>${money(report.totalTraderReceivables)}</span></div>` : "") +
    (report.includeTraderPayables ? `<div class="summary-line"><span>${escapeHtml(labels.totalTraderPayables)}</span><span>${money(report.totalTraderPayables)}</span></div>` : "") +
    (report.includeTraderPayments ? `<div class="summary-line"><span>${escapeHtml(labels.totalTraderPayments)}</span><span>${money(report.totalTraderPayments)}</span></div>` : "") +
    `<div class="summary-line ${netClass}"><span>${escapeHtml(labels.netResult)}</span><span>${netSign}${money(report.netResult)}</span></div>` +
    `<div class="summary-line ${netClass}"><span>${escapeHtml(labels.status)}</span><span>${escapeHtml(netLabel)}</span></div>` +
    `</div></body></html>`
  );
}


