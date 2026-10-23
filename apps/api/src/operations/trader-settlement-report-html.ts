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
  /** The net when the Trader owes (fees above the orders): money received from him. */
  readonly amountCollectedFromTrader: string;
  readonly traderCreditsPaidBack: string;
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
  readonly statusDraft: string;
  readonly draftNotice: string;
  readonly amendedNotice: string;
  readonly originalNotice: string;
  readonly originalWatermark: string;
  readonly removedLine: string;
  readonly recoveredAs: string;
  readonly originalNet: string;
  readonly amendedNet: string;
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
  readonly traderMobile: string;
  readonly traderAcknowledgement: string;
  readonly vat: string;
}

const LABELS: Record<ReportLanguage, Labels> = {
  ar: {
    additionalFees: "رسوم إضافية",
    amountPaidNow: "المبلغ المدفوع الآن",
    amountCollectedFromTrader: "المبلغ المحصّل من التاجر",
    traderCreditsPaidBack: "أرصدة دائنة للتاجر مدفوعة",
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
    statusDraft: "مسودة — غير مرحّلة",
    draftNotice: "مسودة للمراجعة فقط — لم يتم ترحيلها ولم يُدفع أي مبلغ.",
    amendedNotice: "فاتورة معدّلة — تم إلغاء الطلبات التالية من هذه الفاتورة بعد ترحيلها:",
    originalNotice: "النسخة الأصلية كما تم ترحيلها أول مرة — تم تعديل هذه الفاتورة لاحقاً:",
    originalWatermark: "نسخة أصلية — معدّلة",
    removedLine: "{order} (المرجع {reference}) أُلغي بموجب {correction} بتاريخ {date}: {reason}. المبلغ {amount}",
    recoveredAs: "يُسترد من التاجر بموجب {receivable}",
    originalNet: "صافي الدفعة الأصلي",
    amendedNet: "صافي الدفعة بعد التعديل",
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
    traderMobile: "جوال التاجر",
    traderAcknowledgement: "إقرار التاجر",
    vat: "ضريبة القيمة المضافة",
  },
  en: {
    additionalFees: "Additional Fees",
    amountPaidNow: "Amount Paid Now",
    amountCollectedFromTrader: "Amount Collected from Trader",
    traderCreditsPaidBack: "Trader Credits paid back",
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
    statusDraft: "Draft — not posted",
    draftNotice: "Draft for review only — not posted, no money has been paid.",
    amendedNotice: "Amended invoice — these Orders were removed from it after it was posted:",
    originalNotice: "ORIGINAL COPY, as first posted — this invoice was amended later:",
    originalWatermark: "ORIGINAL — AMENDED",
    removedLine: "{order} (ref {reference}) removed by {correction} on {date}: {reason}. Amount {amount}",
    recoveredAs: "to be recovered from the Trader as {receivable}",
    originalNet: "Original net payment",
    amendedNet: "Net payment after amendment",
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
    traderMobile: "Trader Mobile",
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

function settlementStatusLabel(labels: Labels, status: "confirmed" | "reversed" | "draft"): string {
  if (status === "draft") return labels.statusDraft;
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
  const isDraft = data.header.status === "draft";
  // XYZ Deliver services asked (11 Oct 2026) for a compact Trader Invoice PDF:
  // no Delivery Date, COD Amount or Service Fee -- only Amount Paid Now, in the
  // table and in the summary. Every other Company keeps the full invoice.
  const isCompactInvoiceCompany = data.companyId === "dd28829b-2b7c-4851-a0be-181b92673e84";
  const showFullColumns = !isCompactInvoiceCompany;
  // Additional Fees are deducted from the Trader's payable exactly like the
  // Service Fee. Printing only the Service Fee left an Order such as COD
  // 230.00, Service Fee 16.00, Additional Fees 16.00, Paid 198.00 not adding up,
  // nor the summary totals. Per Aiman (12 Oct 2026) the two are COMBINED into
  // one column and one summary line headed "Service Fee + Additional Fees".
  // The combined heading is used only when at least one Order carries
  // Additional Fees, so other invoices keep the plain "Service Fee" heading.
  const totalAdditionalFees = data.orders
    .reduce((sum, order) => sum.plus(order.additionalFees), new Decimal(0));
  const showAdditionalFees = showFullColumns && totalAdditionalFees.gt(0);
  const feeLabel = showAdditionalFees
    ? `${labels.serviceFee} + ${labels.additionalFees}`
    : labels.serviceFee;
  // COD-shortfall Companies (Aiman, 22 Oct 2026): a fee deduction row prints
  // its Order's COD, the fee that row covers (COD + amount deducted) and a
  // negative Amount Paid Now, so every row reads COD - fee = paid and the
  // columns add up to the totals: ORD-000023 COD 1.00, fee 20.00, -19.00.
  const deductionMoney = showFullColumns && header.deductionRowsShowOrderMoney === true;
  const deductionCod = (line: (typeof data.receivableOffsets)[number]) =>
    deductionMoney ? new Decimal(line.orderCodAmount ?? 0) : new Decimal(0);
  const deductionFee = (line: (typeof data.receivableOffsets)[number]) =>
    deductionCod(line).plus(line.amountApplied).toFixed(2);
  const totalDeductionCod = data.receivableOffsets.reduce(
    (sum, line) => sum.plus(deductionCod(line)),
    new Decimal(0),
  );

  // Columns are built from one list so a header and every row's cell can never
  // disagree in count. Per Aiman (13 Oct 2026):
  //  - a column that has no data on THIS invoice (empty, or 0.00 on every row)
  //    is left off; #, Reference and Amount Paid Now always print;
  //  - there is no separate Order Number column -- a row without a Reference
  //    Number shows its Order Number in the Reference column instead;
  //  - an Order paid across several Settlements shows "Previously Paid" (what
  //    earlier Settlements paid before this one) and "Remaining Outstanding"
  //    (what was still owed right after this one). ORD-000649 (104.00): 60.00
  //    on SET-000101 (remaining 44.00), 44.00 on SET-000102 (previously 60.00).
  type Row =
    | { readonly kind: "order"; readonly order: (typeof data.orders)[number] }
    | { readonly kind: "deduction"; readonly line: (typeof data.receivableOffsets)[number] };
  interface Column {
    readonly label: string;
    readonly numeric: boolean;
    readonly cell: (row: Row) => string;
    /** True when this row has something to print in the column. */
    readonly has: (row: Row) => boolean;
    readonly always?: boolean;
  }
  const rows: Row[] = [
    ...data.orders.map((order) => ({ kind: "order" as const, order })),
    ...data.receivableOffsets.map((line) => ({ kind: "deduction" as const, line })),
  ];
  const nonZero = (value: string | null | undefined) => value != null && new Decimal(value).gt(0);
  const text = (value: string | null | undefined) => value != null && value.trim() !== "";
  const textColumn = (
    label: string,
    pick: (row: Row) => string | null | undefined,
    className = "",
  ): Column => ({
    cell: (row) => `<td${className === "" ? "" : ` class="${className}"`}>${escapeHtml(pick(row) ?? "")}</td>`,
    has: (row) => text(pick(row)),
    label,
    numeric: false,
  });
  const orderFee = (order: (typeof data.orders)[number]) =>
    new Decimal(order.serviceFee).plus(order.additionalFees).toFixed(2);
  const paidBefore = (order: (typeof data.orders)[number]) => order.paidBeforeThisPayment ?? "0.00";
  const remainingAfter = (order: (typeof data.orders)[number]) => order.remainingAfterThisPayment ?? "0.00";
  const columns: Column[] = [
    {
      always: true,
      cell: (row) => `<td class="num">${rows.indexOf(row) + 1}</td>`,
      has: () => true,
      label: labels.lineNumber,
      numeric: false,
    },
    {
      always: true,
      cell: (row) =>
        `<td class="mono">${escapeHtml(
          row.kind === "order"
            ? (row.order.referenceNumber ?? row.order.orderNumber)
            : (row.line.referenceNumber ??
                row.line.orderNumber ??
                row.line.sourceReference ??
                // A charge added by hand has no Order: its own number identifies it.
                row.line.receivableNumber),
        )}</td>`,
      has: () => true,
      label: labels.externalReference,
      numeric: false,
    },
    ...(showFullColumns
      ? [
          textColumn(labels.deliveryDate, (row) =>
            row.kind === "order" ? dateOnly(row.order.deliveryDate) : dateOnly(row.line.businessDate),
          ),
        ]
      : []),
    textColumn(labels.customer, (row) =>
      row.kind === "order"
        ? row.order.customerName
        : // A charge added by hand has no customer: print what it is for.
          (row.line.customerName ?? (row.line.orderNumber == null ? row.line.reason : null))),
    textColumn(
      labels.customerMobile,
      (row) => (row.kind === "order" ? row.order.customerMobileNumber : row.line.customerMobileNumber),
      "mono",
    ),
    textColumn(labels.emirate, (row) => {
      const source = row.kind === "order" ? row.order : row.line;
      return language === "ar" ? (source.emirateNameAr ?? source.emirateName ?? "") : (source.emirateName ?? "");
    }),
    textColumn(labels.area, (row) => {
      const source = row.kind === "order" ? row.order : row.line;
      return language === "ar" ? (source.areaNameAr ?? source.areaName ?? "") : (source.areaName ?? "");
    }),
    ...(showFullColumns
      ? [
          {
            cell: (row: Row) =>
              `<td class="num">${
                row.kind === "order"
                  ? tableMoney(row.order.codAmount)
                  : deductionCod(row.line).gt(0)
                    ? tableMoney(deductionCod(row.line).toFixed(2))
                    : ZERO_CELL
              }</td>`,
            has: (row: Row) =>
              row.kind === "order" ? nonZero(row.order.codAmount) : deductionCod(row.line).gt(0),
            label: labels.cod,
            numeric: true,
          },
          // Full invoice: a receivable deduction sits under the fee column.
          {
            cell: (row: Row) =>
              row.kind === "order"
                ? `<td class="num">${tableMoney(orderFee(row.order))}</td>`
                : deductionMoney
                  ? `<td class="num">${tableMoney(deductionFee(row.line))}</td>`
                  : `<td class="num negative">${tableMoney(row.line.amountApplied, true)}</td>`,
            has: (row: Row) => (row.kind === "order" ? nonZero(orderFee(row.order)) : nonZero(row.line.amountApplied)),
            label: feeLabel,
            numeric: true,
          },
          {
            cell: (row: Row) =>
              `<td class="num">${row.kind === "order" ? tableMoney(paidBefore(row.order)) : ZERO_CELL}</td>`,
            has: (row: Row) => row.kind === "order" && nonZero(paidBefore(row.order)),
            label: labels.previouslyPaid,
            numeric: true,
          },
        ]
      : []),
    {
      always: true,
      // Compact invoice has no fee column, so a deduction shows as a negative
      // Amount Paid Now -- the column still adds up to the summary.
      cell: (row) =>
        row.kind === "order"
          ? `<td class="num">${tableMoney(row.order.amountPaidNow)}</td>`
          : showFullColumns && !deductionMoney
            ? `<td class="num">${ZERO_CELL}</td>`
            : `<td class="num negative">${tableMoney(row.line.amountApplied, true)}</td>`,
      has: () => true,
      label: labels.amountPaidNow,
      numeric: true,
    },
    ...(showFullColumns
      ? [
          {
            cell: (row: Row) =>
              `<td class="num">${row.kind === "order" ? tableMoney(remainingAfter(row.order)) : ZERO_CELL}</td>`,
            has: (row: Row) => row.kind === "order" && nonZero(remainingAfter(row.order)),
            label: labels.remainingOutstanding,
            numeric: true,
          },
        ]
      : []),
  ];
  const visibleColumns = columns.filter((column) => column.always === true || rows.some(column.has));

  // Money headers take `num` too, so a header and the figures beneath it
  // resolve to the SAME edge (`text-align: end` resolves to LEFT under
  // dir="rtl" while plain headers used `start`, i.e. right).
  const orderTable =
    `<table class="grid"><thead><tr>` +
    visibleColumns
      .map((column) =>
        column.numeric
          ? `<th class="num">${escapeHtml(column.label)}</th>`
          : `<th>${escapeHtml(column.label)}</th>`,
      )
      .join("") +
    `</tr></thead><tbody>`;
  const combinedRows = rows
    .map((row) => `<tr>${visibleColumns.map((column) => column.cell(row)).join("")}</tr>`)
    .join("");

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

  const amendment = header.amendment ?? null;
  const reportHeader =
    (isDraft ? `<div class="draft-watermark">${escapeHtml(labels.statusDraft)}</div>` : "") +
    (amendment?.version === "original"
      ? `<div class="draft-watermark watermark-original">${escapeHtml(labels.originalWatermark)}</div>`
      : "") +
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
    // Trader's mobile on every Company's invoice (Aiman, 21 Oct 2026); left
    // off when the Trader has none saved rather than printing an empty line.
    (header.traderMobile ? headerMeta(labels.traderMobile, header.traderMobile, "ltr-value") : "") +
    headerMeta(labels.paymentDate, header.paymentDate) +
    headerMeta(labels.paymentMethod, paymentMethodLabel(labels, header.paymentMethod)) +
    headerMeta(labels.paymentReference, header.paymentReference ?? "") +
    (isDraft ? "" : headerMeta(labels.moneySentDate, dateTime(header.moneySentAt))) +
    (header.hideMoneyReceived === true
      ? ""
      : headerMeta(labels.moneyReceivedDate, dateTime(header.moneyReceivedDate))) +
    // AL Fahd Al Maliky asked for the creating user and the user who sent
    // the money ("Money Sent By" / "أرسله") to be left off its invoices;
    // every other Company still prints both.
    (isFahdAlMalikiCompany ? "" : headerMeta(labels.createdBy, header.createdBy)) +
    (isFahdAlMalikiCompany || isDraft ? "" : headerMeta(labels.confirmedBy, header.confirmedBy)) +
    headerMeta(labels.generatedAt, header.generatedAt) +
    `</div>` +
    bankSection +
    `</header>`;

  const notices: string[] = [];
  if (isDraft) {
    notices.push(`<div class="notice notice-draft"><strong>${escapeHtml(labels.draftNotice)}</strong></div>`);
  }
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
  if (amendment !== null) {
    const fill = (template: string, values: Readonly<Record<string, string>>) =>
      Object.entries(values).reduce(
        (text, [key, value]) => text.replaceAll(`{${key}}`, escapeHtml(value)),
        escapeHtml(template),
      );
    notices.push(
      `<div class="notice notice-amended"><strong>${escapeHtml(
        amendment.version === "original" ? labels.originalNotice : labels.amendedNotice,
      )}</strong><ul class="amendment-lines">` +
        amendment.removedLines
          .map(
            (line) =>
              `<li>${fill(labels.removedLine, {
                amount: line.amount,
                correction: line.correctionNumber,
                date: dateTime(line.correctedAt),
                order: line.serialNumber,
                reason: line.reason,
                reference: line.referenceNumber ?? "—",
              })}${
                line.recoveryReceivableNumber === null
                  ? ""
                  : ` — ${fill(labels.recoveredAs, { receivable: line.recoveryReceivableNumber })}`
              }</li>`,
          )
          .join("") +
        `</ul>` +
        `<div>${escapeHtml(labels.originalNet)}: <strong>${escapeHtml(amendment.originalNetPayment)}</strong> · ` +
        `${escapeHtml(labels.amendedNet)}: <strong>${escapeHtml(amendment.amendedNetPayment)}</strong></div>` +
        `</div>`,
    );
  }
  const noticeSection =
    notices.length === 0 ? "" : `<div class="notices">${notices.join("")}</div>`;

  // A deduction row's fee is COD + amount deducted, so its COD joins both
  // totals (0 unless the Company prints deduction rows with their Order money).
  // COD-shortfall Companies: a 0-due Order (pays the Trader 0.00) counts in
  // the fee total only up to its COD -- the rest of its fee was paid by the
  // customer directly or collected elsewhere, never through this invoice
  // (ORD-000037: COD 0, fee 30, paid by the customer). The row still prints
  // its full fee; the totals then read COD - fees = amount paid / collected.
  const zeroDueFeesOutsideInvoice = deductionMoney
    ? data.orders.reduce((sum, order) => {
        const zeroDue =
          new Decimal(order.amountPaidNow).isZero() && new Decimal(order.originalTraderPayable).isZero();
        if (!zeroDue) return sum;
        const fee = new Decimal(orderFee(order));
        return sum.plus(Decimal.max(fee.minus(Decimal.min(fee, new Decimal(order.codAmount))), 0));
      }, new Decimal(0))
    : new Decimal(0);
  const totalFees = new Decimal(data.summary.totalServiceFees)
    .plus(data.summary.traderFeeDeductions)
    .plus(totalAdditionalFees)
    .plus(totalDeductionCod)
    .minus(zeroDueFeesOutsideInvoice);
  const totalCod = new Decimal(data.summary.totalCod).plus(totalDeductionCod).toFixed(2);
  const totalPaidBefore = data.orders.reduce((sum, order) => sum.plus(paidBefore(order)), new Decimal(0));
  const totalRemainingAfter = data.orders.reduce((sum, order) => sum.plus(remainingAfter(order)), new Decimal(0));
  const summaryLine = (label: string, value: string) =>
    `<div class="summary-line"><span>${escapeHtml(label)}</span><span>${value}</span></div>`;
  const totalDetailRows = data.orders.length + data.receivableOffsets.length;
  const summary =
    `<section class="summary-section">` +
    `<h2 class="section-title">${escapeHtml(labels.numberOfOrders)}: ${totalDetailRows}</h2>` +
    // A summary line that is 0.00 is left off, like an empty column; Amount
    // Paid Now always prints.
    (showFullColumns && nonZero(totalCod)
      ? summaryLine(labels.cod, money(totalCod))
      : "") +
    (showFullColumns && totalFees.gt(0) ? summaryLine(feeLabel, money(totalFees.toFixed(2))) : "") +
    ((data.creditApplications ?? []).length === 0
      ? ""
      : summaryLine(
          `${labels.traderCreditsPaidBack} (${(data.creditApplications ?? [])
            .map((credit) => credit.creditNumber)
            .join(", ")})`,
          money(data.summary.traderCreditsApplied ?? "0.00"),
        )) +
    (showFullColumns && totalPaidBefore.gt(0)
      ? summaryLine(labels.previouslyPaid, money(totalPaidBefore.toFixed(2)))
      : "") +
    // The Trader owes (one-screen, 22 Oct 2026): the net is what he paid us.
    (new Decimal(data.summary.netPayment).lessThan(0)
      ? summaryLine(labels.amountCollectedFromTrader, money(new Decimal(data.summary.netPayment).negated().toFixed(2)))
      : summaryLine(labels.amountPaidNow, money(data.summary.netPayment))) +
    (showFullColumns && totalRemainingAfter.gt(0)
      ? summaryLine(labels.remainingOutstanding, money(totalRemainingAfter.toFixed(2)))
      : "") +
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
    .notice-draft { background: #fff7e0; border-color: #b45309; }
    .notice-amended { background: #fff4e5; border-color: #c2410c; }
    .amendment-lines { margin: 4px 0; padding-inline-start: 18px; }
    .watermark-original { color: rgba(194, 65, 12, 0.12); font-size: 54px; }
    .draft-watermark { position: fixed; top: 40%; left: 0; right: 0; text-align: center;
      font-size: 64px; font-weight: 800; color: rgba(180, 83, 9, 0.12); transform: rotate(-24deg);
      pointer-events: none; z-index: 0; }
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
    /* Money headings may wrap (the figures never do), so an invoice that
       needs every column still fits A4 portrait. */
    table.grid th.num { white-space: normal; }
    .negative { color: #a32626; }
    /* A phone number keeps its own left-to-right order on the Arabic invoice. */
    .ltr-value { direction: ltr; unicode-bidi: isolate; }
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
