import type { TraderSettlementReportData } from "./trader-settlement.service.js";

/**
 * Pure HTML document builder for the Trader Settlement Statement (Phase 4
 * Checkpoint 5, §19-23). Never calls any API and never touches settlement
 * data — it only formats the already-resolved `TraderSettlementReportData`
 * snapshot. Rendered to a real PDF file server-side by the shared
 * `DriverCollectionPdfService` via a headless Chromium (Playwright); this is
 * a separate document from the Driver Collection Report and the Driver
 * Shipment Manifest and must not be merged with either.
 */

export type ReportLanguage = "en" | "ar";

interface Labels {
  readonly additionalFees: string;
  readonly amountPaidNow: string;
  readonly area: string;
  readonly beneficiaryBank: string;
  readonly cod: string;
  readonly companyAuthorization: string;
  readonly confirmedBy: string;
  readonly createdBy: string;
  readonly customer: string;
  readonly deliveryDate: string;
  readonly emirate: string;
  readonly externalReference: string;
  readonly generatedAt: string;
  readonly lineNumber: string;
  readonly moneyReceivedDate: string;
  readonly moneyReceivedNotice: string;
  readonly moneyReceivedNotes: string;
  readonly moneyReceivedReference: string;
  readonly moneySentDate: string;
  readonly notes: string;
  readonly numberOfOrders: string;
  readonly orderSerial: string;
  readonly originalTraderPayable: string;
  readonly paymentDate: string;
  readonly paymentMethod: string;
  readonly paymentMethodBankTransfer: string;
  readonly paymentMethodCash: string;
  readonly paymentReference: string;
  readonly preparedBy: string;
  readonly previouslyPaid: string;
  readonly remainingOutstanding: string;
  readonly reversalDate: string;
  readonly reversalNotice: string;
  readonly reversalOf: string;
  readonly reversalReason: string;
  readonly reversedBy: string;
  readonly reversedByUser: string;
  readonly serviceFee: string;
  readonly settlementNumber: string;
  readonly settlementStatus: string;
  readonly sourceBank: string;
  readonly status: string;
  readonly statusConfirmed: string;
  readonly statusMoneyReceived: string;
  readonly statusMoneySent: string;
  readonly statusNotEligible: string;
  readonly statusPartiallySettled: string;
  readonly statusReversed: string;
  readonly statusSettled: string;
  readonly statusUnsettled: string;
  readonly title: string;
  readonly totalDeductions: string;
  readonly trader: string;
  readonly traderAcknowledgement: string;
  readonly vat: string;
}

const LABELS: Record<ReportLanguage, Labels> = {
  ar: {
    additionalFees: "رسوم إضافية",
    amountPaidNow: "المبلغ المدفوع الآن",
    area: "المنطقة",
    beneficiaryBank: "حساب التاجر المستفيد",
    cod: "الدفع عند الاستلام",
    companyAuthorization: "اعتماد الشركة",
    confirmedBy: "أرسله",
    createdBy: "أنشأه",
    customer: "العميل",
    deliveryDate: "تاريخ التسليم",
    emirate: "الإمارة",
    externalReference: "الرقم المرجعي الخارجي",
    generatedAt: "تاريخ ووقت إنشاء التقرير",
    lineNumber: "#",
    moneyReceivedDate: "تاريخ استلام التاجر للمبلغ",
    moneyReceivedNotice: "تم تأكيد استلام التاجر للمبلغ",
    moneyReceivedNotes: "ملاحظات الاستلام",
    moneyReceivedReference: "مرجع الاستلام",
    moneySentDate: "تاريخ إرسال المبلغ",
    notes: "ملاحظات",
    numberOfOrders: "عدد الطلبات",
    orderSerial: "الرقم التسلسلي للطلب",
    originalTraderPayable: "المستحق الأصلي للتاجر",
    paymentDate: "تاريخ الدفعة",
    paymentMethod: "طريقة الدفع",
    paymentMethodBankTransfer: "تحويل بنكي",
    paymentMethodCash: "نقدي",
    paymentReference: "المرجع البنكي",
    preparedBy: "أعده",
    previouslyPaid: "مدفوع سابقاً",
    remainingOutstanding: "الرصيد المتبقي",
    reversalDate: "تاريخ العكس",
    reversalNotice: "تم عكس هذه التسوية",
    reversalOf: "عكس للتسوية رقم",
    reversalReason: "سبب العكس",
    reversedBy: "تم عكسها بواسطة التسوية رقم",
    reversedByUser: "تم العكس بواسطة",
    serviceFee: "رسوم الخدمة",
    settlementNumber: "رقم التسوية",
    settlementStatus: "حالة الطلب",
    sourceBank: "حساب الشركة المرسل",
    status: "الحالة",
    statusConfirmed: "مؤكدة",
    statusMoneyReceived: "استلم التاجر المبلغ",
    statusMoneySent: "تم إرسال المبلغ للتاجر",
    statusNotEligible: "غير مؤهل",
    statusPartiallySettled: "تسوية جزئية",
    statusReversed: "معكوسة",
    statusSettled: "مسواة",
    statusUnsettled: "غير مسواة",
    title: "كشف تسوية التاجر",
    totalDeductions: "إجمالي الخصومات",
    trader: "التاجر",
    traderAcknowledgement: "إقرار التاجر",
    vat: "ضريبة القيمة المضافة",
  },
  en: {
    additionalFees: "Additional Fees",
    amountPaidNow: "Amount Paid Now",
    area: "Area",
    beneficiaryBank: "Trader Beneficiary Bank",
    cod: "COD Amount",
    companyAuthorization: "Company Authorization",
    confirmedBy: "Money Sent By",
    createdBy: "Created By",
    customer: "Customer",
    deliveryDate: "Delivery Date",
    emirate: "Emirate",
    externalReference: "External Reference Number",
    generatedAt: "Generated Date and Time",
    lineNumber: "#",
    moneyReceivedDate: "Money Received Date",
    moneyReceivedNotice: "Money Received by Trader confirmed.",
    moneyReceivedNotes: "Receipt Notes",
    moneyReceivedReference: "Receipt Reference",
    moneySentDate: "Money Sent Date",
    notes: "Notes",
    numberOfOrders: "Number of Orders",
    orderSerial: "Order Serial Number",
    originalTraderPayable: "Original Trader Payable",
    paymentDate: "Payment Date",
    paymentMethod: "Payment Method",
    paymentMethodBankTransfer: "Bank Transfer",
    paymentMethodCash: "Cash",
    paymentReference: "Payment Reference",
    preparedBy: "Prepared By",
    previouslyPaid: "Previously Paid",
    remainingOutstanding: "Remaining Outstanding",
    reversalDate: "Reversal Date",
    reversalNotice: "This settlement has been reversed.",
    reversalOf: "Reversal of settlement",
    reversalReason: "Reversal Reason",
    reversedBy: "Reversed by settlement",
    reversedByUser: "Reversed By",
    serviceFee: "Service Fee",
    settlementNumber: "Settlement Number",
    settlementStatus: "Order Settlement Status",
    sourceBank: "Company Source Bank",
    status: "Status",
    statusConfirmed: "Confirmed",
    statusMoneyReceived: "Money Received by Trader",
    statusMoneySent: "Money Sent to Trader",
    statusNotEligible: "Not Eligible",
    statusPartiallySettled: "Partially Settled",
    statusReversed: "Reversed",
    statusSettled: "Settled",
    statusUnsettled: "Unsettled",
    title: "Trader Settlement Statement",
    totalDeductions: "Total Deductions",
    trader: "Trader",
    traderAcknowledgement: "Trader Acknowledgement",
    vat: "VAT",
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

function paymentMethodLabel(labels: Labels, method: "bank_transfer" | "cash"): string {
  return method === "bank_transfer" ? labels.paymentMethodBankTransfer : labels.paymentMethodCash;
}

function settlementStatusLabel(labels: Labels, status: "confirmed" | "reversed"): string {
  return status === "reversed" ? labels.statusReversed : labels.statusConfirmed;
}

function orderStatusLabel(labels: Labels, status: string): string {
  switch (status) {
    case "unsettled":
      return labels.statusUnsettled;
    case "partially_settled":
      return labels.statusPartiallySettled;
    case "settled":
      return labels.statusSettled;
    case "money_sent_to_trader":
      return labels.statusMoneySent;
    case "money_received_by_trader":
      return labels.statusMoneyReceived;
    case "reversed":
      return labels.statusReversed;
    default:
      return labels.statusNotEligible;
  }
}

function dateOnly(value: string | null): string {
  return value === null ? "" : value.slice(0, 10);
}

function dateTime(value: string | null | undefined): string {
  return value == null ? "" : value.slice(0, 16).replace("T", " ");
}

/**
 * Pure: builds the full report HTML document. Never calls any API and never
 * mutates data — a failure here can only ever throw before any PDF bytes are
 * produced, so it cannot corrupt or partially alter the confirmed settlement
 * it describes.
 */
export function buildTraderSettlementStatementHtml(
  data: TraderSettlementReportData,
  language: ReportLanguage,
): string {
  const labels = LABELS[language];
  const dir = language === "ar" ? "rtl" : "ltr";
  const header = data.header;

  const orderRows = data.orders
    .map(
      (order, index) =>
        "<tr>" +
        `<td class="num">${index + 1}</td>` +
        `<td class="mono">${escapeHtml(order.serialNumber)}</td>` +
        `<td class="mono">${order.referenceNumber === null ? "" : escapeHtml(order.referenceNumber)}</td>` +
        `<td>${dateOnly(order.deliveryDate)}</td>` +
        `<td>${escapeHtml(order.customerName)}</td>` +
        `<td>${order.emirateName === null ? "" : escapeHtml(order.emirateName)}</td>` +
        `<td>${escapeHtml(order.areaName)}</td>` +
        `<td class="num">${money(order.codAmount)}</td>` +
        `<td class="num">${money(order.serviceFee)}</td>` +
        `<td class="num">${money(order.originalTraderPayable)}</td>` +
        `<td class="num">${money(order.previouslyPaid)}</td>` +
        `<td class="num">${money(order.amountPaidNow)}</td>` +
        `<td class="num">${money(order.remainingOutstanding)}</td>` +
        `<td>${escapeHtml(orderStatusLabel(labels, order.orderSettlementStatus))}</td>` +
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
      labels.customer,
      labels.emirate,
      labels.area,
      labels.cod,
      labels.serviceFee,
      labels.originalTraderPayable,
      labels.previouslyPaid,
      labels.amountPaidNow,
      labels.remainingOutstanding,
      labels.settlementStatus,
    ]
      .map((label) => `<th>${escapeHtml(label)}</th>`)
      .join("") +
    `</tr></thead><tbody>${orderRows}</tbody></table>`;

  const headerMeta = (label: string, value: string) =>
    `<div class="meta-item"><span class="meta-label">${escapeHtml(label)}</span>` +
    `<span class="meta-value">${escapeHtml(value)}</span></div>`;

  const bankLine = (label: string, bankName: string, accountName: string, masked: string | null) =>
    `<div class="bank-item"><span class="bank-label">${escapeHtml(label)}</span>` +
    `<span class="bank-value">${escapeHtml(bankName)} — ${escapeHtml(accountName)}` +
    (masked === null ? "" : ` (${escapeHtml(masked)})`) +
    `</span></div>`;

  const bankSection =
    header.sourceBank === null && header.beneficiaryBank === null
      ? ""
      : `<div class="bank-section">` +
        (header.sourceBank === null
          ? ""
          : bankLine(
              labels.sourceBank,
              header.sourceBank.bankName,
              header.sourceBank.accountName,
              null,
            )) +
        (header.beneficiaryBank === null
          ? ""
          : bankLine(
              labels.beneficiaryBank,
              header.beneficiaryBank.bankName,
              header.beneficiaryBank.accountName,
              header.beneficiaryBank.ibanMasked || header.beneficiaryBank.accountNumberMasked,
            )) +
        `</div>`;

  const reportHeader =
    `<header class="report-header">` +
    `<div class="company-block">` +
    (header.company.logoDataUri == null
      ? ""
      : `<img class="company-logo" alt="" src="${escapeHtml(header.company.logoDataUri)}">`) +
    `<div class="company-identity">` +
    `<div class="company-name">${escapeHtml(header.company.nameEn)}` +
    (header.company.nameAr === null ? "" : ` / ${escapeHtml(header.company.nameAr)}`) +
    `</div>` +
    (header.company.subtitleEn === null && header.company.subtitleAr === null
      ? ""
      : `<div class="company-subtitle">${escapeHtml(
          language === "ar"
            ? (header.company.subtitleAr ?? header.company.subtitleEn ?? "")
            : (header.company.subtitleEn ?? header.company.subtitleAr ?? ""),
        )}</div>`) +
    (header.company.telephone === null
      ? ""
      : `<div class="company-telephone">${escapeHtml(header.company.telephone)}</div>`) +
    `</div></div>` +
    `<h1 class="report-title">${escapeHtml(labels.title)}</h1>` +
    `<div class="meta-grid">` +
    headerMeta(labels.settlementNumber, header.settlementNumber) +
    headerMeta(labels.status, settlementStatusLabel(labels, header.status)) +
    headerMeta(labels.trader, header.traderName) +
    headerMeta(labels.paymentDate, header.paymentDate) +
    headerMeta(labels.paymentMethod, paymentMethodLabel(labels, header.paymentMethod)) +
    headerMeta(labels.paymentReference, header.paymentReference ?? "") +
    headerMeta(labels.moneySentDate, dateTime(header.moneySentAt)) +
    headerMeta(labels.moneyReceivedDate, dateTime(header.moneyReceivedDate)) +
    headerMeta(labels.createdBy, header.createdBy) +
    headerMeta(labels.confirmedBy, header.confirmedBy) +
    headerMeta(labels.generatedAt, header.generatedAt) +
    `</div>` +
    bankSection +
    `</header>`;

  const notices: string[] = [];
  if (header.moneyReceivedDate !== null) {
    notices.push(
      `<div class="notice notice-positive"><strong>${escapeHtml(labels.moneyReceivedNotice)}</strong>` +
        (header.moneyReceivedReference === null
          ? ""
          : ` ${escapeHtml(labels.moneyReceivedReference)}: ${escapeHtml(header.moneyReceivedReference)}.`) +
        (header.moneyReceivedNotes === null
          ? ""
          : ` ${escapeHtml(labels.moneyReceivedNotes)}: ${escapeHtml(header.moneyReceivedNotes)}.`) +
        `</div>`,
    );
  }
  if (header.status === "reversed" || header.reversedBySettlementNumber !== null) {
    notices.push(
      `<div class="notice notice-negative"><strong>${escapeHtml(labels.reversalNotice)}</strong>` +
        (header.reversedBySettlementNumber === null
          ? ""
          : ` ${escapeHtml(labels.reversedBy)}: ${escapeHtml(header.reversedBySettlementNumber)}.`) +
        (header.reversalDate === null
          ? ""
          : ` ${escapeHtml(labels.reversalDate)}: ${escapeHtml(dateTime(header.reversalDate))}.`) +
        (header.reversedBy === null
          ? ""
          : ` ${escapeHtml(labels.reversedByUser)}: ${escapeHtml(header.reversedBy)}.`) +
        (header.reversalReason === null
          ? ""
          : ` ${escapeHtml(labels.reversalReason)}: ${escapeHtml(header.reversalReason)}.`) +
        `</div>`,
    );
  }
  if (header.reversalOfSettlementNumber !== null) {
    notices.push(
      `<div class="notice notice-negative"><strong>${escapeHtml(labels.reversalOf)}:</strong> ` +
        `${escapeHtml(header.reversalOfSettlementNumber)}` +
        (header.reversalReason === null
          ? ""
          : ` — ${escapeHtml(labels.reversalReason)}: ${escapeHtml(header.reversalReason)}`) +
        `</div>`,
    );
  }
  const noticeSection =
    notices.length === 0 ? "" : `<div class="notices">${notices.join("")}</div>`;

  const summaryLine = (label: string, value: string) =>
    `<div class="summary-line"><span>${escapeHtml(label)}</span><span>${value}</span></div>`;
  const summary =
    `<section class="summary-section">` +
    `<h2 class="section-title">${escapeHtml(labels.numberOfOrders)}: ${data.summary.orderCount}</h2>` +
    summaryLine(labels.cod, money(data.summary.totalCod)) +
    summaryLine(labels.serviceFee, money(data.summary.totalServiceFees)) +
    summaryLine(labels.originalTraderPayable, money(data.summary.totalOriginalTraderPayable)) +
    summaryLine(labels.previouslyPaid, money(data.summary.previouslyPaid)) +
    summaryLine(labels.amountPaidNow, money(data.summary.amountPaidNow)) +
    summaryLine(labels.remainingOutstanding, money(data.summary.remainingOutstanding)) +
    `</section>`;

  const signatures =
    `<div class="signatures">` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.preparedBy)}</span></div>` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.companyAuthorization)}</span></div>` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.traderAcknowledgement)}</span></div>` +
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
    .bank-section { margin-top: 8px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 16px; font-size: 11px; }
    .bank-item { display: flex; justify-content: space-between; border-bottom: 1px dotted #ccc; padding: 2px 0; }
    .bank-label { color: #555; }
    .bank-value { font-weight: 600; }
    .notices { margin-top: 8px; }
    .notice { font-size: 11px; padding: 4px 8px; margin-bottom: 4px; border-inline-start: 3px solid; }
    .notice-positive { background: #eef8f0; border-color: #2e7d32; }
    .notice-negative { background: #fdeeee; border-color: #c62828; }
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
    `<title>${escapeHtml(labels.title)} ${escapeHtml(header.settlementNumber)}</title>` +
    `<style>${style}</style></head><body>` +
    reportHeader +
    noticeSection +
    orderTable +
    summary +
    signatures +
    `</body></html>`
  );
}
