import type { TraderCollectionReportData } from "./trader-receivable.service.js";

/**
 * Pure HTML document builder for the Trader Payment Receipt — the receipt for
 * a Trader Collection (Trader -> Company), the reverse money-flow direction
 * from the Trader Settlement Statement. Never calls any API and never
 * touches collection data — it only formats the already-resolved
 * `TraderCollectionReportData` snapshot. Rendered to a real PDF file
 * server-side by the shared `DriverCollectionPdfService` via headless
 * Chromium; this is a separate document from the Trader Settlement
 * Statement, the Driver Collection Report, and the Driver Shipment
 * Manifest, and must not be merged with any of them.
 */

export type ReportLanguage = "en" | "ar";

interface Labels {
  readonly amountCollectedNow: string;
  readonly amountReceived: string;
  readonly amountReceivedNow: string;
  readonly businessDate: string;
  readonly companyAuthorization: string;
  readonly companyBankAccount: string;
  readonly generatedAt: string;
  readonly lineNumber: string;
  readonly notes: string;
  readonly numberOfReceivables: string;
  readonly originalAmountDue: string;
  readonly paymentDate: string;
  readonly paymentMethod: string;
  readonly paymentMethodBankTransfer: string;
  readonly paymentMethodCash: string;
  readonly paymentReference: string;
  readonly preparedBy: string;
  readonly previouslyCollected: string;
  readonly reason: string;
  readonly receivableNumber: string;
  readonly receivableStatus: string;
  readonly receiptNumber: string;
  readonly receivedBy: string;
  readonly remainingDue: string;
  readonly reversalDate: string;
  readonly reversalNotice: string;
  readonly reversalReason: string;
  readonly reversedBy: string;
  readonly sourceReference: string;
  readonly sourceType: string;
  readonly status: string;
  readonly statusCancelled: string;
  readonly statusCollected: string;
  readonly statusConfirmed: string;
  readonly statusOutstanding: string;
  readonly statusPartiallyCollected: string;
  readonly statusReversed: string;
  readonly title: string;
  readonly totalOriginalAmountDue: string;
  readonly trader: string;
  readonly traderRepresentative: string;
  readonly sourceTypeDamagedOrLostShipmentRecovery: string;
  readonly sourceTypeManualAdjustment: string;
  readonly sourceTypeOther: string;
  readonly sourceTypeOverpaymentRecovery: string;
  readonly sourceTypeRefundDue: string;
  readonly sourceTypeServiceCharge: string;
  readonly sourceTypeTraderPenalty: string;
}

const LABELS: Record<ReportLanguage, Labels> = {
  ar: {
    amountCollectedNow: "المبلغ المحصل الآن",
    amountReceived: "المبلغ المستلم",
    amountReceivedNow: "المبلغ المستلم الآن",
    businessDate: "تاريخ العملية",
    companyAuthorization: "اعتماد الشركة",
    companyBankAccount: "حساب الشركة البنكي",
    generatedAt: "تاريخ ووقت إنشاء الإيصال",
    lineNumber: "#",
    notes: "ملاحظات",
    numberOfReceivables: "عدد المبالغ المستحقة",
    originalAmountDue: "المبلغ المستحق الأصلي",
    paymentDate: "تاريخ الدفعة",
    paymentMethod: "طريقة الدفع",
    paymentMethodBankTransfer: "تحويل بنكي",
    paymentMethodCash: "نقدي",
    paymentReference: "المرجع البنكي",
    preparedBy: "أعده",
    previouslyCollected: "محصل سابقاً",
    reason: "السبب",
    receivableNumber: "رقم المستحق",
    receivableStatus: "حالة المستحق",
    receiptNumber: "رقم الإيصال",
    receivedBy: "استلمه",
    remainingDue: "الرصيد المتبقي",
    reversalDate: "تاريخ العكس",
    reversalNotice: "تم عكس هذا التحصيل",
    reversalReason: "سبب العكس",
    reversedBy: "تم العكس بواسطة",
    sourceReference: "المرجع",
    sourceType: "نوع المصدر",
    status: "الحالة",
    statusCancelled: "ملغى",
    statusCollected: "محصل بالكامل",
    statusConfirmed: "مؤكد",
    statusOutstanding: "مستحق",
    statusPartiallyCollected: "محصل جزئياً",
    statusReversed: "معكوس",
    title: "إيصال استلام مبلغ من التاجر",
    totalOriginalAmountDue: "إجمالي المبلغ المستحق الأصلي",
    trader: "التاجر",
    traderRepresentative: "ممثل التاجر",
    sourceTypeDamagedOrLostShipmentRecovery: "استرداد شحنة تالفة أو مفقودة",
    sourceTypeManualAdjustment: "تسوية يدوية",
    sourceTypeOther: "أخرى",
    sourceTypeOverpaymentRecovery: "استرداد دفعة زائدة",
    sourceTypeRefundDue: "مبلغ مسترد مستحق",
    sourceTypeServiceCharge: "رسوم خدمة",
    sourceTypeTraderPenalty: "غرامة تاجر",
  },
  en: {
    amountCollectedNow: "Amount Collected Now",
    amountReceived: "Amount Received",
    amountReceivedNow: "Amount Received Now",
    businessDate: "Business Date",
    companyAuthorization: "Company Authorization",
    companyBankAccount: "Company Bank Account",
    generatedAt: "Generated Date and Time",
    lineNumber: "#",
    notes: "Notes",
    numberOfReceivables: "Number of Receivables",
    originalAmountDue: "Original Amount Due",
    paymentDate: "Payment Date",
    paymentMethod: "Payment Method",
    paymentMethodBankTransfer: "Bank Transfer",
    paymentMethodCash: "Cash",
    paymentReference: "Payment Reference",
    preparedBy: "Prepared By",
    previouslyCollected: "Previously Collected",
    reason: "Reason",
    receivableNumber: "Receivable Number",
    receivableStatus: "Receivable Status",
    receiptNumber: "Receipt Number",
    receivedBy: "Received By",
    remainingDue: "Remaining Due",
    reversalDate: "Reversal Date",
    reversalNotice: "This collection has been reversed.",
    reversalReason: "Reversal Reason",
    reversedBy: "Reversed By",
    sourceReference: "Source Reference",
    sourceType: "Source Type",
    status: "Status",
    statusCancelled: "Cancelled",
    statusCollected: "Collected",
    statusConfirmed: "Confirmed",
    statusOutstanding: "Outstanding",
    statusPartiallyCollected: "Partially Collected",
    statusReversed: "Reversed",
    title: "Trader Payment Receipt",
    totalOriginalAmountDue: "Total Original Amount Due",
    trader: "Trader",
    traderRepresentative: "Trader Representative",
    sourceTypeDamagedOrLostShipmentRecovery: "Damaged or Lost Shipment Recovery",
    sourceTypeManualAdjustment: "Manual Adjustment",
    sourceTypeOther: "Other",
    sourceTypeOverpaymentRecovery: "Overpayment Recovery",
    sourceTypeRefundDue: "Refund Due",
    sourceTypeServiceCharge: "Service Charge",
    sourceTypeTraderPenalty: "Trader Penalty",
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

function collectionStatusLabel(labels: Labels, status: "confirmed" | "reversed"): string {
  return status === "reversed" ? labels.statusReversed : labels.statusConfirmed;
}

function receivableStatusLabel(labels: Labels, status: string): string {
  switch (status) {
    case "outstanding":
      return labels.statusOutstanding;
    case "partially_collected":
      return labels.statusPartiallyCollected;
    case "collected":
      return labels.statusCollected;
    case "cancelled":
      return labels.statusCancelled;
    case "reversed":
      return labels.statusReversed;
    default:
      return status;
  }
}

function sourceTypeLabel(labels: Labels, sourceType: string): string {
  switch (sourceType) {
    case "manual_adjustment":
      return labels.sourceTypeManualAdjustment;
    case "trader_penalty":
      return labels.sourceTypeTraderPenalty;
    case "overpayment_recovery":
      return labels.sourceTypeOverpaymentRecovery;
    case "refund_due":
      return labels.sourceTypeRefundDue;
    case "service_charge":
      return labels.sourceTypeServiceCharge;
    case "damaged_or_lost_shipment_recovery":
      return labels.sourceTypeDamagedOrLostShipmentRecovery;
    default:
      return labels.sourceTypeOther;
  }
}

function dateOnly(value: string | null): string {
  return value === null ? "" : value.slice(0, 10);
}

function dateTime(value: string | null): string {
  return value === null ? "" : value.slice(0, 16).replace("T", " ");
}

/**
 * Pure: builds the full receipt HTML document. Never calls any API and never
 * mutates data — a failure here can only ever throw before any PDF bytes are
 * produced, so it cannot corrupt or partially alter the confirmed collection
 * it describes.
 */
export function buildTraderPaymentReceiptHtml(
  data: TraderCollectionReportData,
  language: ReportLanguage,
): string {
  const labels = LABELS[language];
  const dir = language === "ar" ? "rtl" : "ltr";
  const header = data.header;

  const lineRows = data.lines
    .map(
      (line, index) =>
        "<tr>" +
        `<td class="num">${index + 1}</td>` +
        `<td class="mono">${escapeHtml(line.receivableNumber)}</td>` +
        `<td>${escapeHtml(sourceTypeLabel(labels, line.sourceType))}</td>` +
        `<td class="mono">${line.sourceReference === null ? "" : escapeHtml(line.sourceReference)}</td>` +
        `<td>${dateOnly(line.businessDate)}</td>` +
        `<td>${escapeHtml(line.reason)}</td>` +
        `<td class="num">${money(line.originalAmountDue)}</td>` +
        `<td class="num">${money(line.previouslyCollected)}</td>` +
        `<td class="num">${money(line.amountCollectedNow)}</td>` +
        `<td class="num">${money(line.remainingDue)}</td>` +
        `<td>${escapeHtml(receivableStatusLabel(labels, line.receivableStatus))}</td>` +
        "</tr>",
    )
    .join("");
  const lineTable =
    `<table class="grid"><thead><tr>` +
    [
      labels.lineNumber,
      labels.receivableNumber,
      labels.sourceType,
      labels.sourceReference,
      labels.businessDate,
      labels.reason,
      labels.originalAmountDue,
      labels.previouslyCollected,
      labels.amountCollectedNow,
      labels.remainingDue,
      labels.receivableStatus,
    ]
      .map((label) => `<th>${escapeHtml(label)}</th>`)
      .join("") +
    `</tr></thead><tbody>${lineRows}</tbody></table>`;

  const headerMeta = (label: string, value: string) =>
    `<div class="meta-item"><span class="meta-label">${escapeHtml(label)}</span>` +
    `<span class="meta-value">${escapeHtml(value)}</span></div>`;

  const bankSection =
    header.companyBankAccount === null
      ? ""
      : `<div class="bank-section"><div class="bank-item">` +
        `<span class="bank-label">${escapeHtml(labels.companyBankAccount)}</span>` +
        `<span class="bank-value">${escapeHtml(header.companyBankAccount.bankName)} — ` +
        `${escapeHtml(header.companyBankAccount.accountName)}` +
        (header.companyBankAccount.ibanMasked === ""
          ? header.companyBankAccount.accountNumberMasked === ""
            ? ""
            : ` (${escapeHtml(header.companyBankAccount.accountNumberMasked)})`
          : ` (${escapeHtml(header.companyBankAccount.ibanMasked)})`) +
        `</span></div></div>`;

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
    headerMeta(labels.receiptNumber, header.collectionNumber) +
    headerMeta(labels.status, collectionStatusLabel(labels, header.status)) +
    headerMeta(labels.trader, header.traderName) +
    headerMeta(labels.paymentDate, header.paymentDate) +
    headerMeta(labels.paymentMethod, paymentMethodLabel(labels, header.paymentMethod)) +
    headerMeta(labels.paymentReference, header.paymentReference ?? "") +
    headerMeta(labels.receivedBy, header.receivedBy) +
    headerMeta(labels.generatedAt, header.generatedAt) +
    `</div>` +
    bankSection +
    `</header>`;

  const notices: string[] = [];
  if (header.status === "reversed") {
    notices.push(
      `<div class="notice notice-negative"><strong>${escapeHtml(labels.reversalNotice)}</strong>` +
        (header.reversalDate === null
          ? ""
          : ` ${escapeHtml(labels.reversalDate)}: ${escapeHtml(dateTime(header.reversalDate))}.`) +
        (header.reversedBy === null
          ? ""
          : ` ${escapeHtml(labels.reversedBy)}: ${escapeHtml(header.reversedBy)}.`) +
        (header.reversalReason === null
          ? ""
          : ` ${escapeHtml(labels.reversalReason)}: ${escapeHtml(header.reversalReason)}.`) +
        `</div>`,
    );
  }
  const noticeSection =
    notices.length === 0 ? "" : `<div class="notices">${notices.join("")}</div>`;

  const summaryLine = (label: string, value: string) =>
    `<div class="summary-line"><span>${escapeHtml(label)}</span><span>${value}</span></div>`;
  const summary =
    `<section class="summary-section">` +
    `<h2 class="section-title">${escapeHtml(labels.numberOfReceivables)}: ${data.summary.receivableCount}</h2>` +
    summaryLine(labels.totalOriginalAmountDue, money(data.summary.totalOriginalAmountDue)) +
    summaryLine(labels.previouslyCollected, money(data.summary.previouslyCollected)) +
    summaryLine(labels.amountReceivedNow, money(data.summary.amountReceivedNow)) +
    summaryLine(labels.remainingDue, money(data.summary.remainingDue)) +
    (data.summary.notes === null ? "" : summaryLine(labels.notes, escapeHtml(data.summary.notes))) +
    `</section>`;

  const signatures =
    `<div class="signatures">` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.receivedBy)}</span></div>` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.companyAuthorization)}</span></div>` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.traderRepresentative)}</span></div>` +
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
    `<title>${escapeHtml(labels.title)} ${escapeHtml(header.collectionNumber)}</title>` +
    `<style>${style}</style></head><body>` +
    reportHeader +
    noticeSection +
    lineTable +
    summary +
    signatures +
    `</body></html>`
  );
}
