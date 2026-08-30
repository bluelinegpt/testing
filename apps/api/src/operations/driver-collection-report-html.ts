import type { DriverCollectionReportData } from "./driver-cash-reconciliation.service.js";

/**
 * Pure HTML document builder for the Driver Collection Report (§10/§13). Never
 * calls any API and never touches reconciliation data — it only formats the
 * already-resolved `DriverCollectionReportData` snapshot. Rendered to a real
 * PDF file server-side by `driver-collection-pdf.service.ts` via a headless
 * Chromium (Playwright), so this same HTML never needs to run in a User's
 * browser: the authoritative document is generated entirely on the server.
 */

export type ReportLanguage = "en" | "ar";

interface Labels {
  readonly additionalFees: string;
  readonly amount: string;
  readonly amountDueToTrader: string;
  readonly area: string;
  readonly businessDate: string;
  readonly cashTotal: string;
  readonly cod: string;
  readonly collectionStatus: string;
  readonly companyApprover: string;
  readonly companyReceiver: string;
  readonly confirmedBy: string;
  readonly confirmedDate: string;
  readonly createdBy: string;
  readonly createdDate: string;
  readonly customer: string;
  readonly customerAmountToCollect: string;
  readonly deliveryDate: string;
  readonly description: string;
  readonly difference: string;
  readonly driver: string;
  readonly driverExpenses: string;
  readonly driverFeeOffset: string;
  readonly driverSignature: string;
  readonly driverType: string;
  readonly driverTypeEmployee: string;
  readonly driverTypeOutsourced: string;
  readonly emirate: string;
  readonly enteredBy: string;
  readonly expenseType: string;
  readonly externalReference: string;
  readonly generatedAt: string;
  readonly grossCollections: string;
  readonly lineNumber: string;
  readonly netExpected: string;
  readonly notes: string;
  readonly numberOfOrders: string;
  readonly orderSerial: string;
  readonly paymentMethod: string;
  readonly paymentMethodCash: string;
  readonly paymentMethodNotAssigned: string;
  readonly paymentMethodVisa: string;
  readonly reason: string;
  readonly recordedDate: string;
  readonly reconciliationNumber: string;
  readonly reference: string;
  readonly serviceFee: string;
  readonly signatureDate: string;
  readonly status: string;
  readonly statusConfirmed: string;
  readonly statusDraft: string;
  readonly title: string;
  readonly totalDeductions: string;
  readonly trader: string;
  readonly vat: string;
  readonly visaTotal: string;
}

const LABELS: Record<ReportLanguage, Labels> = {
  ar: {
    additionalFees: "رسوم إضافية",
    amount: "المبلغ",
    amountDueToTrader: "المستحق للتاجر",
    area: "المنطقة",
    businessDate: "تاريخ التحصيل",
    cashTotal: "إجمالي النقدي",
    cod: "الدفع عند الاستلام",
    collectionStatus: "حالة تحصيل السائق",
    companyApprover: "المعتمد",
    companyReceiver: "أمين الصندوق / موظف العمليات",
    confirmedBy: "أكده",
    confirmedDate: "تاريخ التأكيد",
    createdBy: "أنشأه",
    createdDate: "تاريخ الإنشاء",
    customer: "العميل",
    customerAmountToCollect: "المبلغ المطلوب تحصيله",
    deliveryDate: "تاريخ التسليم",
    description: "الوصف",
    difference: "الفرق",
    driver: "السائق",
    driverExpenses: "مصاريف السائق",
    driverFeeOffset: "خصم رسوم السائق الخارجي",
    driverSignature: "توقيع السائق",
    driverType: "نوع السائق",
    driverTypeEmployee: "موظف",
    driverTypeOutsourced: "خارجي",
    emirate: "الإمارة",
    enteredBy: "أدخله",
    expenseType: "نوع المصروف",
    externalReference: "الرقم المرجعي الخارجي",
    generatedAt: "تاريخ ووقت إنشاء التقرير",
    grossCollections: "إجمالي التحصيلات من العملاء",
    lineNumber: "#",
    netExpected: "الصافي المتوقع من السائق",
    notes: "ملاحظات",
    numberOfOrders: "عدد الطلبات",
    orderSerial: "الرقم التسلسلي للطلب",
    paymentMethod: "طريقة الدفع",
    paymentMethodCash: "نقدي",
    paymentMethodNotAssigned: "غير محدد",
    paymentMethodVisa: "فيزا (بطاقة / بنك)",
    reason: "السبب",
    recordedDate: "تاريخ التسجيل",
    reconciliationNumber: "رقم التسوية",
    reference: "المرجع",
    serviceFee: "رسوم الخدمة",
    signatureDate: "التاريخ",
    status: "الحالة",
    statusConfirmed: "مؤكد",
    statusDraft: "مسودة",
    title: "تقرير تحصيل السائق",
    totalDeductions: "إجمالي الخصومات",
    trader: "التاجر",
    vat: "ضريبة القيمة المضافة",
    visaTotal: "إجمالي الفيزا",
  },
  en: {
    additionalFees: "Additional Fees",
    amount: "Amount",
    amountDueToTrader: "Amount Due to Trader",
    area: "Area",
    businessDate: "Business/Collection Date",
    cashTotal: "Cash Total",
    cod: "COD Amount",
    collectionStatus: "Driver Reconciliation Status",
    companyApprover: "Approver",
    companyReceiver: "Cashier/Operations User",
    confirmedBy: "Confirmed By",
    confirmedDate: "Confirmed Date",
    createdBy: "Created By",
    createdDate: "Created Date",
    customer: "Customer",
    customerAmountToCollect: "Customer Amount to Collect",
    deliveryDate: "Delivery Date",
    description: "Description",
    difference: "Difference",
    driver: "Driver",
    driverExpenses: "Driver Expenses",
    driverFeeOffset: "Outsourced Driver Fee Offset",
    driverSignature: "Driver",
    driverType: "Driver Type",
    driverTypeEmployee: "Employee",
    driverTypeOutsourced: "Outsourced",
    emirate: "Emirate",
    enteredBy: "Entered By",
    expenseType: "Expense Type",
    externalReference: "External Reference Number",
    generatedAt: "Generated Date and Time",
    grossCollections: "Gross Customer Collections",
    lineNumber: "#",
    netExpected: "Net Expected from Driver",
    notes: "Notes",
    numberOfOrders: "Number of Orders",
    orderSerial: "Order Serial Number",
    paymentMethod: "Payment Method",
    paymentMethodCash: "Cash",
    paymentMethodNotAssigned: "Not Assigned",
    paymentMethodVisa: "Visa (card / bank)",
    reason: "Reason",
    recordedDate: "Recorded Date",
    reconciliationNumber: "Reconciliation Number",
    reference: "Reference",
    serviceFee: "Service Fee",
    signatureDate: "Date",
    status: "Status",
    statusConfirmed: "Confirmed",
    statusDraft: "Draft",
    title: "Driver Collection Report",
    totalDeductions: "Total Deductions",
    trader: "Trader",
    vat: "VAT",
    visaTotal: "Visa Total",
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

function paymentMethodLabel(labels: Labels, method: "cash" | "visa" | null): string {
  if (method === "cash") return labels.paymentMethodCash;
  if (method === "visa") return labels.paymentMethodVisa;
  return labels.paymentMethodNotAssigned;
}

function statusLabel(labels: Labels, status: "confirmed" | "draft"): string {
  return status === "confirmed" ? labels.statusConfirmed : labels.statusDraft;
}

function driverTypeLabel(labels: Labels, type: "employee" | "outsourced"): string {
  return type === "employee" ? labels.driverTypeEmployee : labels.driverTypeOutsourced;
}

/**
 * Pure: builds the full report HTML document. Never calls any API and never
 * mutates data — a failure here can only ever throw before any PDF bytes are
 * produced, so it cannot corrupt or partially alter the confirmed
 * reconciliation it describes.
 */
export function buildDriverCollectionReportHtml(
  data: DriverCollectionReportData,
  language: ReportLanguage,
  generatedAt: string,
): string {
  const labels = LABELS[language];
  const dir = language === "ar" ? "rtl" : "ltr";
  const orderRows = data.orders
    .map(
      (order, index) =>
        "<tr>" +
        `<td class="num">${index + 1}</td>` +
        `<td class="mono">${escapeHtml(order.serialNumber)}</td>` +
        `<td class="mono">${order.referenceNumber === null ? "" : escapeHtml(order.referenceNumber)}</td>` +
        `<td>${order.deliveryDate === null ? "" : escapeHtml(order.deliveryDate.slice(0, 10))}</td>` +
        `<td>${escapeHtml(order.traderName)}</td>` +
        `<td>${escapeHtml(order.customerName)}</td>` +
        `<td>${order.emirateName === null ? "" : escapeHtml(order.emirateName)}</td>` +
        `<td>${escapeHtml(order.areaName)}</td>` +
        `<td class="num">${money(order.codAmount)}</td>` +
        `<td class="num">${money(order.customerAmountToCollect)}</td>` +
        `<td class="num">${money(order.serviceFee)}</td>` +
        `<td class="num">${money(order.additionalFees)}</td>` +
        `<td class="num">${money(order.vatAmount)}</td>` +
        `<td class="num">${money(order.totalDeductions)}</td>` +
        `<td class="num">${money(order.traderPayable)}</td>` +
        `<td>${paymentMethodLabel(labels, order.paymentMethod)}</td>` +
        `<td>${escapeHtml(order.driverReconciliationStatusLabel)}</td>` +
        "</tr>",
    )
    .join("");
  const orderTable =
    `<table class="grid"><thead><tr>` +
    [
      labels.lineNumber,
      labels.orderSerial,
      labels.externalReference,
      labels.deliveryDate,
      labels.trader,
      labels.customer,
      labels.emirate,
      labels.area,
      labels.cod,
      labels.customerAmountToCollect,
      labels.serviceFee,
      labels.additionalFees,
      labels.vat,
      labels.totalDeductions,
      labels.amountDueToTrader,
      labels.paymentMethod,
      labels.collectionStatus,
    ]
      .map((label) => `<th>${escapeHtml(label)}</th>`)
      .join("") +
    `</tr></thead><tbody>${orderRows}</tbody></table>`;

  const expenseRows = data.expenses
    .map(
      (expense) =>
        "<tr>" +
        `<td>${escapeHtml(expense.expenseType)}</td>` +
        `<td class="num">${money(expense.amount)}</td>` +
        `<td>${expense.description === null ? "" : escapeHtml(expense.description)}</td>` +
        `<td>${expense.reason === null ? "" : escapeHtml(expense.reason)}</td>` +
        `<td>${expense.reference === null ? "" : escapeHtml(expense.reference)}</td>` +
        `<td>${escapeHtml(expense.enteredBy)}</td>` +
        `<td>${escapeHtml(expense.recordedAt.slice(0, 10))}</td>` +
        "</tr>",
    )
    .join("");
  const expenseTable =
    data.expenses.length === 0
      ? ""
      : `<h2 class="section-title">${escapeHtml(labels.driverExpenses)}</h2>` +
        `<table class="grid"><thead><tr>` +
        [
          labels.expenseType,
          labels.amount,
          labels.description,
          labels.reason,
          labels.reference,
          labels.enteredBy,
          labels.recordedDate,
        ]
          .map((label) => `<th>${escapeHtml(label)}</th>`)
          .join("") +
        `</tr></thead><tbody>${expenseRows}</tbody></table>`;

  const headerMeta = (label: string, value: string) =>
    `<div class="meta-item"><span class="meta-label">${escapeHtml(label)}</span>` +
    `<span class="meta-value">${escapeHtml(value)}</span></div>`;

  const header =
    `<header class="report-header">` +
    `<div class="company-block">` +
    (data.header.company.logoDataUri == null
      ? ""
      : `<img class="company-logo" alt="" src="${escapeHtml(data.header.company.logoDataUri)}">`) +
    `<div class="company-identity">` +
    `<div class="company-name">${escapeHtml(data.header.company.nameEn)}` +
    (data.header.company.nameAr === null ? "" : ` / ${escapeHtml(data.header.company.nameAr)}`) +
    `</div>` +
    (data.header.company.subtitleEn === null && data.header.company.subtitleAr === null
      ? ""
      : `<div class="company-subtitle">${escapeHtml(
          language === "ar"
            ? (data.header.company.subtitleAr ?? data.header.company.subtitleEn ?? "")
            : (data.header.company.subtitleEn ?? data.header.company.subtitleAr ?? ""),
        )}</div>`) +
    (data.header.company.telephone === null
      ? ""
      : `<div class="company-telephone">${escapeHtml(data.header.company.telephone)}</div>`) +
    `</div></div>` +
    `<h1 class="report-title">${escapeHtml(labels.title)}</h1>` +
    `<div class="meta-grid">` +
    headerMeta(labels.reconciliationNumber, data.header.reconciliationNumber) +
    headerMeta(labels.status, statusLabel(labels, data.header.status)) +
    headerMeta(labels.driver, data.header.driverName) +
    headerMeta(labels.driverType, driverTypeLabel(labels, data.header.driverType)) +
    headerMeta(
      labels.paymentMethod,
      paymentMethodLabel(labels, data.header.collectionPaymentMethod),
    ) +
    headerMeta(labels.businessDate, data.header.businessDate) +
    headerMeta(labels.createdDate, data.header.createdAt.slice(0, 16).replace("T", " ")) +
    headerMeta(
      labels.confirmedDate,
      data.header.confirmedAt === null
        ? ""
        : data.header.confirmedAt.slice(0, 16).replace("T", " "),
    ) +
    headerMeta(labels.createdBy, data.header.createdBy) +
    headerMeta(labels.confirmedBy, data.header.confirmedBy) +
    headerMeta(labels.generatedAt, generatedAt) +
    `</div>` +
    (data.header.notes === null
      ? ""
      : `<div class="notes-block"><strong>${escapeHtml(labels.notes)}:</strong> ${escapeHtml(data.header.notes)}</div>`) +
    `</header>`;

  const summaryLine = (label: string, value: string) =>
    `<div class="summary-line"><span>${escapeHtml(label)}</span><span>${value}</span></div>`;
  const summary =
    `<section class="summary-section">` +
    `<h2 class="section-title">${escapeHtml(labels.numberOfOrders)}: ${data.summary.orderCount}</h2>` +
    summaryLine(labels.grossCollections, money(data.summary.grossCollections)) +
    summaryLine(labels.cashTotal, money(data.summary.cashTotal)) +
    summaryLine(labels.visaTotal, money(data.summary.visaTotal)) +
    summaryLine(labels.driverExpenses, money(data.summary.driverExpenses)) +
    summaryLine(labels.driverFeeOffset, money(data.summary.driverFeeOffset ?? "0")) +
    summaryLine(labels.netExpected, money(data.summary.netExpected)) +
    summaryLine(labels.amount, money(data.summary.actualReceived)) +
    summaryLine(labels.difference, money(data.summary.difference)) +
    `</section>`;

  const signatures =
    `<div class="signatures">` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.driverSignature)}</span></div>` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.companyReceiver)}</span></div>` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.companyApprover)}</span></div>` +
    `</div>`;

  const style = `
    @page { size: A4; margin: 14mm 12mm 18mm; }
    * { box-sizing: border-box; }
    body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; color: #111; margin: 0; font-size: 11px; }
    .report-header { border-bottom: 2px solid #333; margin-bottom: 10px; padding-bottom: 8px; }
    .company-block { display: flex; align-items: center; gap: 10px; }
    .company-logo { width: 48px; height: 48px; object-fit: contain; }
    .company-name { font-size: 16px; font-weight: 800; }
    .company-subtitle, .company-telephone { font-size: 11px; color: #444; }
    .report-title { font-size: 18px; margin: 8px 0 6px; }
    .meta-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 16px; font-size: 11px; }
    .meta-item { display: flex; justify-content: space-between; border-bottom: 1px dotted #ccc; padding: 2px 0; }
    .meta-label { color: #555; }
    .meta-value { font-weight: 600; }
    .notes-block { margin-top: 8px; font-size: 11px; }
    .section-title { font-size: 13px; margin: 14px 0 6px; }
    table.grid { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 10px; }
    table.grid th, table.grid td { border: 1px solid #999; padding: 3px 5px; text-align: start; }
    table.grid thead { display: table-header-group; }
    table.grid thead th { background: #f0f0f0; }
    table.grid td.num, table.grid th.num { text-align: end; white-space: nowrap; }
    .mono { font-variant-numeric: tabular-nums; }
    .summary-section { margin-top: 12px; max-width: 360px; }
    .summary-line { display: flex; justify-content: space-between; border-bottom: 1px solid #ddd; padding: 4px 0; font-size: 12px; }
    .signatures { display: flex; justify-content: space-between; gap: 24px; margin-top: 48px; }
    .sign-box { flex: 1; text-align: center; font-size: 11px; }
    .sign-line { border-top: 1px solid #333; margin-bottom: 6px; height: 40px; }
    tr { break-inside: avoid; }
  `;

  return (
    `<!doctype html><html dir="${dir}" lang="${language}"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(labels.title)} ${escapeHtml(data.header.reconciliationNumber)}</title>` +
    `<style>${style}</style></head><body>` +
    header +
    orderTable +
    expenseTable +
    summary +
    signatures +
    `</body></html>`
  );
}
