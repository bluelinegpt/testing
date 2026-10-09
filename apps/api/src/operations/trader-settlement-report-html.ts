import type { TraderSettlementReportData } from "./trader-settlement.service.js";
import { Decimal } from "decimal.js";

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
  readonly financialDetails: string;
  readonly generatedAt: string;
  readonly grossOrderPayable: string;
  readonly lineNumber: string;
  readonly moneyReceivedDate: string;
  readonly moneyReceivedNotice: string;
  readonly moneyReceivedNotes: string;
  readonly moneyReceivedReference: string;
  readonly moneySentDate: string;
  readonly notes: string;
  readonly numberOfOrders: string;
  readonly orderSerial: string;
  readonly orderNumber: string;
  readonly orderType: string;
  readonly customerMobile: string;
  readonly customerName: string;
  readonly originalTraderPayable: string;
  readonly receivableDeductions: string;
  readonly receivableNumber: string;
  readonly receivableReason: string;
  readonly receivableSource: string;
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
    externalReference: "الرقم المرجعي",
    financialDetails: "التفاصيل المالية",
    generatedAt: "تاريخ ووقت إنشاء التقرير",
    grossOrderPayable: "إجمالي مستحقات الطلبات (+)",
    lineNumber: "#",
    moneyReceivedDate: "تاريخ استلام التاجر للمبلغ",
    moneyReceivedNotice: "تم تأكيد استلام التاجر للمبلغ",
    moneyReceivedNotes: "ملاحظات الاستلام",
    moneyReceivedReference: "مرجع الاستلام",
    moneySentDate: "تاريخ إرسال المبلغ",
    notes: "ملاحظات",
    numberOfOrders: "عدد الطلبات",
    orderSerial: "الرقم التسلسلي للطلب",
    orderNumber: "رقم الطلب",
    orderType: "نوع الطلب",
    customerMobile: "هاتف العميل",
    customerName: "اسم العميل",
    originalTraderPayable: "المستحق الأصلي للتاجر",
    receivableDeductions: "رسوم مستحقة على التاجر (-)",
    receivableNumber: "رقم المبلغ المستحق",
    receivableReason: "السبب",
    receivableSource: "رقم الطلب",
    paymentDate: "تاريخ الدفعة",
    paymentMethod: "طريقة الدفع",
    paymentMethodBankTransfer: "تحويل بنكي",
    paymentMethodCash: "نقدي",
    paymentReference: "المرجع البنكي",
    preparedBy: "أعده",
    previouslyPaid: "مدفوع سابقاً",
    remainingOutstanding: "الرصيد المتبقي",
    reversalDate: "تاريخ العكس",
    reversalNotice: "تم عكس هذه الفاتورة",
    reversalOf: "عكس للفاتورة رقم",
    reversalReason: "سبب العكس",
    reversedBy: "تم عكسها بواسطة الفاتورة رقم",
    reversedByUser: "تم العكس بواسطة",
    serviceFee: "رسوم الخدمة",
    settlementNumber: "رقم الفاتورة",
    settlementStatus: "حالة الفاتورة",
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
    title: "فاتورة التاجر",
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
    externalReference: "Reference Number",
    financialDetails: "Financial Details",
    generatedAt: "Generated Date and Time",
    grossOrderPayable: "Gross Order Payable (+)",
    lineNumber: "#",
    moneyReceivedDate: "Money Received Date",
    moneyReceivedNotice: "Money Received by Trader confirmed.",
    moneyReceivedNotes: "Receipt Notes",
    moneyReceivedReference: "Receipt Reference",
    moneySentDate: "Money Sent Date",
    notes: "Notes",
    numberOfOrders: "Number of Orders",
    orderSerial: "Order Serial Number",
    orderNumber: "Order Number",
    orderType: "Order Type",
    customerMobile: "Customer Mobile",
    customerName: "Customer Name",
    originalTraderPayable: "Original Trader Payable",
    receivableDeductions: "Company Fee Deductions (-)",
    receivableNumber: "Receivable Number",
    receivableReason: "Reason",
    receivableSource: "Order Number",
    paymentDate: "Payment Date",
    paymentMethod: "Payment Method",
    paymentMethodBankTransfer: "Bank Transfer",
    paymentMethodCash: "Cash",
    paymentReference: "Payment Reference",
    preparedBy: "Prepared By",
    previouslyPaid: "Previously Paid",
    remainingOutstanding: "Remaining Outstanding",
    reversalDate: "Reversal Date",
    reversalNotice: "This invoice has been reversed.",
    reversalOf: "Reversal of invoice",
    reversalReason: "Reversal Reason",
    reversedBy: "Reversed by invoice",
    reversedByUser: "Reversed By",
    serviceFee: "Service Fee",
    settlementNumber: "Invoice Number",
    settlementStatus: "Invoice Status",
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
    title: "Trader Invoice",
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

/**
 * A summary amount. Isolated as a left-to-right run for the same bidi reason
 * as `tableMoney`; the currency is carried by the column heading rather than
 * repeated on every line.
 */
function money(value: string): string {
  return `<bdi dir="ltr">${escapeHtml(value)}</bdi>`;
}

/**
 * A money cell's contents, isolated from the surrounding right-to-left text.
 *
 * The document is `dir="rtl"`. An amount is a left-to-right run, and its sign,
 * decimal separator and any brackets are bidi-NEUTRAL characters: left
 * unisolated they get reordered to the far side of the number, which is why
 * `-18.00` printed as `18.00-` on every Trader invoice. `<bdi dir="ltr">` pins
 * the run; `tabular-nums` in the stylesheet stacks the decimal points down the
 * column.
 *
 * `negative` emits the real minus sign U+2212 rather than hyphen-minus, which
 * is narrower than a digit and so breaks that tabular alignment.
 */
function tableMoney(value: string, negative = false): string {
  return `<bdi dir="ltr">${negative ? "−" : ""}${escapeHtml(value)}</bdi>`;
}

/** Placeholders, so a column with nothing in it still reads as a column. */
const EMPTY_CELL = `<span class="muted">&mdash;</span>`;
const ZERO_CELL = `<bdi dir="ltr" class="muted">0.00</bdi>`;

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
  const isFahdAlMalikiCompany = data.companyId === "2f0703c3-2b3b-45ef-a6ab-de9b3694c0a1";

  const orderRows = data.orders
    .map(
      (order, index) =>
        "<tr>" +
        `<td class="num">${index + 1}</td>` +
        `<td class="mono">${escapeHtml(order.orderNumber)}</td>` +
        `<td class="mono">${order.referenceNumber === null ? "" : escapeHtml(order.referenceNumber)}</td>` +
        `<td>${dateOnly(order.deliveryDate)}</td>` +
        `<td>${escapeHtml(order.customerName)}</td>` +
        `<td>${escapeHtml(order.customerMobileNumber)}</td>` +
        `<td>${escapeHtml(language === "ar" ? (order.emirateNameAr ?? order.emirateName ?? "") : (order.emirateName ?? ""))}</td>` +
        `<td>${escapeHtml(language === "ar" ? (order.areaNameAr ?? order.areaName) : order.areaName)}</td>` +
        `<td class="num">${tableMoney(order.codAmount)}</td>` +
        `<td class="num">${tableMoney(order.serviceFee)}</td>` +
        `<td class="num">${tableMoney(order.amountPaidNow)}</td>` +
        "</tr>",
    )
    .join("");
  const orderTable =
    `<table class="grid"><thead><tr>` +
    [
      labels.lineNumber,
      labels.orderNumber,
      labels.externalReference,
      labels.deliveryDate,
      labels.customer,
      labels.customerMobile,
      labels.emirate,
      labels.area,
      labels.cod,
      labels.serviceFee,
      labels.amountPaidNow,
    ]
      // The three money headers take `num` too, so a header and the figures
      // beneath it resolve to the SAME edge. They previously disagreed:
      // `text-align: end` on the cells resolves to LEFT under dir="rtl" while
      // the plain headers used `start`, i.e. right.
      .map((label, index) =>
        index >= 8 ? `<th class="num">${escapeHtml(label)}</th>` : `<th>${escapeHtml(label)}</th>`,
      )
      .join("") +
    `</tr></thead><tbody>${orderRows}`;

  const deductionRows = data.receivableOffsets
    .map(
      (line, index) =>
        "<tr>" +
        `<td class="num">${data.orders.length + index + 1}</td>` +
        `<td class="mono">${escapeHtml(line.orderNumber ?? line.sourceReference ?? "")}</td>` +
        `<td class="mono">${escapeHtml(line.referenceNumber ?? "")}</td>` +
        `<td>${dateOnly(line.businessDate)}</td>` +
        `<td>${escapeHtml(line.customerName ?? "")}</td>` +
        `<td class="mono">${escapeHtml(line.customerMobileNumber ?? "")}</td>` +
        `<td>${escapeHtml(language === "ar" ? (line.emirateNameAr ?? line.emirateName ?? "") : (line.emirateName ?? ""))}</td>` +
        `<td>${escapeHtml(language === "ar" ? (line.areaNameAr ?? line.areaName ?? "") : (line.areaName ?? ""))}</td><td class="num">${ZERO_CELL}</td>` +
        `<td class="num negative">${tableMoney(line.amountApplied, true)}</td>` +
        `<td class="num">${ZERO_CELL}</td>` +
        // NOTE: exactly ELEVEN cells, matching the header. There was a twelfth
        // empty <td> here, so every deduction row was one cell wider than the
        // head and the order rows. The table then laid out TWELVE columns, the
        // extra one measuring 13px, which squeezed every real column and left
        // a sliver only these rows occupied -- the misalignment visible on
        // SET-000011.
        "</tr>",
    )
    .join("");
  const combinedRows = deductionRows;

  const headerMeta = (label: string, value: string, valueClass = "") =>
    `<div class="meta-item"><span class="meta-label">${escapeHtml(label)}</span>` +
    `<span class="meta-value ${valueClass}">${escapeHtml(value)}</span></div>`;

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
    `<div class="company-block${isFahdAlMalikiCompany ? " company-block-special" : ""}">` +
    (header.company.logoDataUri == null
      ? ""
      : `<img class="company-logo" alt="" src="${escapeHtml(header.company.logoDataUri)}">`) +
    `<div class="company-identity">` +
    `<div class="company-name">${escapeHtml(language === "ar" ? (header.company.nameAr ?? header.company.nameEn) : header.company.nameEn)}</div>` +
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
    `<h1 class="report-title${isFahdAlMalikiCompany ? " target-company-title" : ""}">${escapeHtml(labels.title)}</h1>` +
    `<div class="meta-grid">` +
    headerMeta(labels.settlementNumber, header.settlementNumber) +
    headerMeta(labels.status, settlementStatusLabel(labels, header.status)) +
    headerMeta(labels.trader, header.traderName, isFahdAlMalikiCompany ? "target-trader-name" : "") +
    headerMeta(labels.paymentDate, header.paymentDate) +
    headerMeta(labels.paymentMethod, paymentMethodLabel(labels, header.paymentMethod)) +
    headerMeta(labels.paymentReference, header.paymentReference ?? "") +
    headerMeta(labels.moneySentDate, dateTime(header.moneySentAt)) +
    headerMeta(labels.moneyReceivedDate, dateTime(header.moneyReceivedDate)) +
    // AL Fahd Al Maliky asked for the creating user to be left off its
    // invoices; every other Company still prints it.
    (isFahdAlMalikiCompany ? "" : headerMeta(labels.createdBy, header.createdBy)) +
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
  const totalDetailRows = data.orders.length + data.receivableOffsets.length;
  const summary =
    `<section class="summary-section">` +
    `<h2 class="section-title">${escapeHtml(labels.numberOfOrders)}: ${totalDetailRows}</h2>` +
    summaryLine(labels.cod, money(data.summary.totalCod)) +
    summaryLine(
      labels.serviceFee,
      money(new Decimal(data.summary.totalServiceFees).plus(data.summary.traderFeeDeductions).toFixed(2)),
    ) +
    summaryLine(labels.amountPaidNow, money(data.summary.netPayment)) +
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
    .company-block-special { flex-direction: column; justify-content: center; text-align: center; gap: 4px; }
    .company-logo { width: 52px; height: 52px; object-fit: contain; }
    .company-name { font-size: 16px; font-weight: 800; }
    .company-subtitle, .company-telephone { font-size: 11px; color: #444; }
    .report-title { font-size: 18px; margin: 8px 0 6px; }
    .target-company-title, .target-trader-name { color: #b42318; }
    .meta-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 18px; font-size: 11px; }
    /* Two tracks per item rather than space-between: with three columns of
       differing label widths, space-between pushed every value hard against
       its own far edge, so the values never formed a column. */
    .meta-item { display: grid; grid-template-columns: minmax(84px, 42%) 1fr; gap: 8px;
      align-items: baseline; min-height: 21px; border-bottom: 1px dotted #ccc; padding: 3px 0; }
    .meta-label { color: #555; }
    /* plaintext, not a fixed direction: these values are a mix of Arabic
       names, reference codes and timestamps, and each should take its own
       first-strong direction. Without it "00:17, 05/10/2026 (UAE)" rendered
       as "(UAE) 05/10/2026 ,00:17". */
    .meta-value { font-weight: 600; unicode-bidi: plaintext; }
    .bank-section { margin-top: 8px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 16px; font-size: 11px; }
    .bank-item { display: flex; justify-content: space-between; border-bottom: 1px dotted #ccc; padding: 2px 0; }
    .bank-label { color: #555; }
    .bank-value { font-weight: 600; }
    .notices { margin-top: 8px; }
    .notice { font-size: 11px; padding: 4px 8px; margin-bottom: 4px; border-inline-start: 3px solid; }
    .notice-positive { background: #eef8f0; border-color: #2e7d32; }
    .notice-negative { background: #fdeeee; border-color: #c62828; }
     .section-title { font-size: 13px; margin: 14px 0 6px; }
     .subsection-title { font-size: 11px; margin: 8px 0 4px; }
    table.grid { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 10px; }
    table.grid th, table.grid td { border: 1px solid #999; padding: 3px 5px; text-align: start; }
    table.grid thead { display: table-header-group; }
    table.grid thead th { background: #f0f0f0; }
    /* "start", not "end": under dir="rtl" "end" resolves to the LEFT edge, so
       the figures sat on the opposite side of the cell from their own header.
       tabular-nums stacks the decimal points down the column. */
    table.grid td.num, table.grid th.num { text-align: start; white-space: nowrap;
      font-variant-numeric: tabular-nums; }
    .negative { color: #a32626; }
    .muted { color: #8a8a8a; }
    .mono { font-variant-numeric: tabular-nums; }
    .summary-section { margin-top: 12px; max-width: 360px; }
    .summary-line { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: baseline;
      border-bottom: 1px solid #ddd; padding: 4px 0; font-size: 12px; }
    .summary-line > span:last-child { font-variant-numeric: tabular-nums; }
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
    `<h2 class="section-title">${escapeHtml(labels.financialDetails)}</h2>` +
    orderTable +
    combinedRows + `</tbody></table>` +
    summary +
    signatures +
    `</body></html>`
  );
}
