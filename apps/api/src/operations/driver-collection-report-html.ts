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
  readonly cashNetExpected: string;
  readonly cashOrders: string;
  readonly cashTotal: string;
  readonly fees: string;
  readonly methodColumn: string;
  readonly methodVisaShort: string;
  readonly statusRecDriver: string;
  readonly closedNothingToCollect: string;
  readonly cod: string;
  readonly companyPaidDriver: string;
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
  readonly paymentMethodMixed: string;
  readonly paymentMethodNone: string;
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
  readonly visaOrders: string;
  readonly visaToBank: string;
  readonly visaTotal: string;
  readonly zeroOrders: string;
}

const LABELS: Record<ReportLanguage, Labels> = {
  ar: {
    additionalFees: "رسوم إضافية",
    amount: "المبلغ",
    amountDueToTrader: "مبلغ التاجر",
    area: "المنطقة",
    businessDate: "تاريخ التحصيل",
    cashNetExpected: "صافي النقد",
    cashOrders: "طلبات نقدية",
    cashTotal: "إجمالي النقدي",
    closedNothingToCollect: "لاشي",
    fees: "الرسوم",
    methodColumn: "فيزا/نقدي",
    methodVisaShort: "فيزا",
    statusRecDriver: "تحصيل مندوب",
    cod: "COD",
    companyPaidDriver: "النقد المدفوع للمندوب",
    collectionStatus: "حالة تحصيل المندوب",
    companyApprover: "المعتمد",
    companyReceiver: "أمين الصندوق / موظف العمليات",
    confirmedBy: "أكده",
    confirmedDate: "تاريخ التأكيد",
    createdBy: "أنشأه",
    createdDate: "تاريخ الإنشاء",
    customer: "العميل",
    customerAmountToCollect: "المحصّل",
    deliveryDate: "التسليم",
    description: "الوصف",
    difference: "الفرق",
    driver: "المندوب",
    driverExpenses: "مصاريف المندوب",
    driverFeeOffset: "خصم رسوم المندوب الخارجي",
    driverSignature: "توقيع المندوب",
    driverType: "نوع المندوب",
    driverTypeEmployee: "موظف",
    driverTypeOutsourced: "خارجي",
    emirate: "الإمارة",
    enteredBy: "أدخله",
    expenseType: "نوع المصروف",
    externalReference: "الرقم المرجعي الخارجي",
    generatedAt: "تاريخ ووقت إنشاء التقرير",
    grossCollections: "إجمالي التحصيلات من العملاء",
    lineNumber: "#",
    netExpected: "الصافي المتوقع من المندوب",
    notes: "ملاحظات",
    numberOfOrders: "عدد الطلبات",
    orderSerial: "الرقم التسلسلي للطلب",
    paymentMethod: "طريقة الدفع",
    paymentMethodCash: "نقدي",
    paymentMethodMixed: "مختلط (نقدي + فيزا)",
    paymentMethodNone: "لا يوجد تحصيل",
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
    title: "تقرير تحصيل المندوب",
    totalDeductions: "إجمالي الخصومات",
    trader: "التاجر",
    vat: "ضريبة القيمة المضافة",
    visaOrders: "طلبات فيزا",
    visaToBank: "فيزا إلى البنك",
    visaTotal: "إجمالي الفيزا",
    zeroOrders: "طلبات بدون تحصيل",
  },
  en: {
    additionalFees: "Additional Fees",
    amount: "Amount",
    amountDueToTrader: "Trader Amount",
    area: "Area",
    businessDate: "Business/Collection Date",
    cashNetExpected: "Net Cash",
    cashOrders: "Cash Orders",
    cashTotal: "Cash Total",
    closedNothingToCollect: "Nothing",
    fees: "Fees",
    methodColumn: "Visa/Cash",
    methodVisaShort: "Visa",
    statusRecDriver: "Rec Driver",
    cod: "COD",
    companyPaidDriver: "Cash Paid to Driver",
    collectionStatus: "Driver Reconciliation Status",
    companyApprover: "Approver",
    companyReceiver: "Cashier/Operations User",
    confirmedBy: "Confirmed By",
    confirmedDate: "Confirmed Date",
    createdBy: "Created By",
    createdDate: "Created Date",
    customer: "Customer",
    customerAmountToCollect: "Collected",
    deliveryDate: "Delivered",
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
    paymentMethodMixed: "Mixed (Cash + Visa)",
    paymentMethodNone: "Nothing to collect",
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
    visaOrders: "Visa Orders",
    visaToBank: "Visa to Bank",
    visaTotal: "Visa Total",
    zeroOrders: "Nothing to collect",
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

function paymentMethodLabel(
  labels: Labels,
  method: "cash" | "mixed" | "none" | "visa" | null,
): string {
  if (method === "cash") return labels.paymentMethodCash;
  if (method === "visa") return labels.paymentMethodVisa;
  if (method === "mixed") return labels.paymentMethodMixed;
  if (method === "none") return labels.paymentMethodNone;
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
  // Cash, Visa and Nothing-to-collect Orders are printed as separate
  // sections, each with its own count and subtotal (11 Oct 2026).
  const sectionOf = (order: (typeof data.orders)[number]) =>
    order.paymentMethod === "visa" ? "visa" : order.paymentMethod === "none" ? "none" : "cash";
  // Order columns, kept short (Aiman, 11 Oct 2026): one Reference column
  // (External Reference, else the Order Number), Service Fee + Additional Fees
  // combined as Fees, no VAT or Total Deductions, and a short status.
  const cents = (value: string) => Math.round(Number(value) * 100);
  // Amounts inside the Order tables carry no currency (the section titles and
  // summary say AED), so every row fits on one line.
  const plain = (value: string) => escapeHtml(value);
  const shortMethod = (method: (typeof data.orders)[number]["paymentMethod"]) =>
    method === "visa" ? labels.methodVisaShort : method === "cash" ? labels.paymentMethodCash : "—";
  const referenceOf = (order: (typeof data.orders)[number]) =>
    order.referenceNumber !== null && order.referenceNumber.trim() !== ""
      ? order.referenceNumber
      : (order.orderNumber ?? order.serialNumber);
  const orderStatusLabel = (order: (typeof data.orders)[number]) => {
    if (order.driverReconciliationStatus !== "reconciled") {
      return order.driverReconciliationStatusLabel;
    }
    return order.paymentMethod === "none" ? labels.closedNothingToCollect : labels.statusRecDriver;
  };
  const orderRowsFor = (orders: typeof data.orders) => orders
    .map(
      (order, index) =>
        "<tr>" +
        `<td class="num">${index + 1}</td>` +
        `<td class="mono">${escapeHtml(referenceOf(order))}</td>` +
        `<td>${order.deliveryDate === null ? "" : escapeHtml(order.deliveryDate.slice(0, 10))}</td>` +
        `<td>${escapeHtml(order.traderName)}</td>` +
        `<td>${escapeHtml(order.customerName)}</td>` +
        `<td>${order.emirateName === null ? "" : escapeHtml(order.emirateName)}</td>` +
        `<td>${escapeHtml(order.areaName)}</td>` +
        `<td class="num">${plain(order.codAmount)}</td>` +
        `<td class="num">${plain(order.customerAmountToCollect)}</td>` +
        `<td class="num">${plain(((cents(order.serviceFee) + cents(order.additionalFees)) / 100).toFixed(2))}</td>` +
        `<td class="num">${plain(order.traderPayable)}</td>` +
        `<td>${escapeHtml(shortMethod(order.paymentMethod))}</td>` +
        `<td>${escapeHtml(orderStatusLabel(order))}</td>` +
        "</tr>",
    )
    .join("");
  const orderTableFor = (orders: typeof data.orders) =>
    `<table class="grid orders"><thead><tr>` +
    [
      labels.lineNumber,
      labels.reference,
      labels.deliveryDate,
      labels.trader,
      labels.customer,
      labels.emirate,
      labels.area,
      labels.cod,
      labels.customerAmountToCollect,
      labels.fees,
      labels.amountDueToTrader,
      labels.methodColumn,
      labels.status,
    ]
      .map((label) => `<th>${escapeHtml(label)}</th>`)
      .join("") +
    `</tr></thead><tbody>${orderRowsFor(orders)}</tbody></table>`;
  const orderSection = (key: "cash" | "none" | "visa", title: string) => {
    const orders = data.orders.filter((order) => sectionOf(order) === key);
    if (orders.length === 0) return "";
    const subtotal = orders
      .reduce((total, order) => total + Math.round(Number(order.customerAmountToCollect) * 100), 0) / 100;
    return (
      `<h3 class="section-title order-section-title">${escapeHtml(title)} (${orders.length}) &middot; ` +
      `${money(subtotal.toFixed(2))}</h3>` +
      orderTableFor(orders)
    );
  };
  const orderTable =
    orderSection("cash", labels.cashOrders) +
    orderSection("visa", labels.visaOrders) +
    orderSection("none", labels.zeroOrders);

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

  const summaryLine = (label: string, value: string, className = "summary-line") =>
    `<div class="${className}"><span>${escapeHtml(label)}</span><span>${value}</span></div>`;
  const summary =
    `<section class="summary-section">` +
    `<h2 class="section-title">${escapeHtml(labels.numberOfOrders)}: ${data.summary.orderCount}</h2>` +
    summaryLine(labels.grossCollections, money(data.summary.grossCollections)) +
    summaryLine(`${labels.cashTotal} (${data.summary.cashOrderCount})`, money(data.summary.cashTotal)) +
    summaryLine(`${labels.visaTotal} (${data.summary.visaOrderCount})`, money(data.summary.visaTotal)) +
    (data.summary.zeroOrderCount > 0
      ? summaryLine(labels.zeroOrders, String(data.summary.zeroOrderCount))
      : "") +
    summaryLine(labels.driverExpenses, money(data.summary.driverExpenses)) +
    summaryLine(labels.driverFeeOffset, money(data.summary.driverFeeOffset ?? "0")) +
    // The last line is the cash that actually changed hands (Aiman, 11 Oct
    // 2026): collected from the Driver, or paid to the Driver when expenses
    // were higher than the cash. Confirmation only succeeds when the cash
    // entered equals this amount, so it is the actual figure, not an estimate.
    // Visa Total above already shows what went to the bank.
    (Number(data.summary.companyPaidDriver) > 0
      ? summaryLine(labels.companyPaidDriver, money(data.summary.companyPaidDriver), "summary-line summary-final")
      : summaryLine(
          labels.cashNetExpected,
          money(Number(data.summary.cashNetExpected) < 0 ? "0.00" : data.summary.cashNetExpected),
          "summary-line summary-final",
        )) +
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
    .company-logo { width: 52px; height: 52px; object-fit: contain; }
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
    table.grid.orders th, table.grid.orders td { white-space: nowrap; }
    .mono { font-variant-numeric: tabular-nums; }
    .summary-section { margin-top: 12px; max-width: 360px; }
    .summary-line { display: flex; justify-content: space-between; border-bottom: 1px solid #ddd; padding: 4px 0; font-size: 12px; }
    .summary-final { color: #c62828; font-weight: 800; font-size: 13px; border-top: 2px solid #c62828; border-bottom: 2px solid #c62828; margin-top: 4px; }
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
