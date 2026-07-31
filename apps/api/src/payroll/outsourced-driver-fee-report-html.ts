import type {
  DailyDriverFeeAccrualReportData,
  DriverEarningsStatementData,
  DriverFeePaymentReceiptData,
  DriverFeeReportLanguage,
  OutstandingDriverFeesReportData,
} from "./outsourced-driver-fee-report.types.js";

const text = {
  en: {
    accrualReport: "Daily Driver Fee Accrual Report",
    authorization: "Company Authorization",
    driverAcknowledgement: "Driver Acknowledgement",
    earnings: "Outsourced Driver Earnings Statement",
    internal: "Confidential — Internal Use",
    outstanding: "Outstanding Driver Fees Report",
    paidBy: "Paid By",
    receipt: "Outsourced Driver Fee Payment Receipt",
  },
  ar: {
    accrualReport: "تقرير استحقاق رسوم السائقين اليومي",
    authorization: "اعتماد الشركة",
    driverAcknowledgement: "إقرار السائق",
    earnings: "كشف أرباح السائق الخارجي",
    internal: "سري — للاستخدام الداخلي",
    outstanding: "تقرير رسوم السائقين المستحقة",
    paidBy: "دُفع بواسطة",
    receipt: "إيصال دفع رسوم السائق الخارجي",
  },
} as const;

const escape = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const labels: Record<string, { ar: string; en: string }> = {
  accrualBusinessDate: { ar: "تاريخ الاستحقاق", en: "Accrual Date" },
  accrualCount: { ar: "عدد الاستحقاقات", en: "Accrual Count" },
  accrualStatus: { ar: "حالة الاستحقاق", en: "Accrual Status" },
  activePaid: { ar: "المدفوع الفعلي", en: "Active Paid" },
  allocationCount: { ar: "عدد التخصيصات", en: "Allocation Count" },
  allocationStatus: { ar: "حالة التخصيص", en: "Allocation Status" },
  amount: { ar: "المبلغ", en: "Amount" },
  amountPaid: { ar: "المبلغ المدفوع", en: "Amount Paid" },
  asOf: { ar: "كما في تاريخ", en: "As of Date" },
  backfillCount: { ar: "استحقاقات الإضافة المعتمدة", en: "Authorized Backfill Accruals" },
  closingOutstanding: { ar: "الرصيد المستحق الختامي", en: "Closing Outstanding" },
  collectionOffsetAmount: { ar: "خصم التحصيل", en: "Collection Offset" },
  collectionOffsets: { ar: "خصومات تحصيل السائق", en: "Collection Offsets" },
  createdAt: { ar: "تاريخ الإنشاء", en: "Created At" },
  createdBy: { ar: "أنشئ بواسطة", en: "Created By" },
  deliveryDate: { ar: "تاريخ التسليم", en: "Delivery Date" },
  deliveryCount: { ar: "استحقاقات التسليم", en: "Delivery Accruals" },
  driverCode: { ar: "رمز السائق", en: "Driver Code" },
  driverCount: { ar: "عدد السائقين", en: "Driver Count" },
  driverName: { ar: "السائق", en: "Driver" },
  driversWithOutstanding: { ar: "السائقون ذوو الرصيد المستحق", en: "Drivers with Outstanding" },
  earnedAmount: { ar: "المبلغ المكتسب", en: "Earned Amount" },
  externalReference: { ar: "المرجع الخارجي", en: "External Reference" },
  feesEarned: { ar: "الرسوم المكتسبة", en: "Fees Earned" },
  feeRate: { ar: "سعر الرسم", en: "Fee Rate" },
  from: { ar: "من تاريخ", en: "From" },
  lastCollectionOffsetDate: { ar: "آخر تاريخ خصم تحصيل", en: "Last Collection Offset Date" },
  lastPaymentDate: { ar: "آخر تاريخ دفع", en: "Last Payment Date" },
  linkedDriverCollection: { ar: "تحصيل السائق المرتبط", en: "Linked Driver Collection" },
  line: { ar: "م", en: "#" },
  notes: { ar: "ملاحظات", en: "Notes" },
  oldestOutstandingDate: { ar: "أقدم تاريخ مستحق", en: "Oldest Outstanding Date" },
  openingOutstanding: { ar: "الرصيد المستحق الافتتاحي", en: "Opening Outstanding" },
  orderNumber: { ar: "رقم الطلب", en: "Order Number" },
  outstanding: { ar: "المستحق", en: "Outstanding" },
  paidBefore: { ar: "المدفوع سابقاً", en: "Paid Before" },
  paidBy: { ar: "دُفع بواسطة", en: "Paid By" },
  paidDuringPeriod: { ar: "المدفوع خلال الفترة", en: "Paid During Period" },
  paidThisPayment: { ar: "المدفوع بهذه الدفعة", en: "Paid by this Payment" },
  paymentDate: { ar: "تاريخ الدفع", en: "Payment Date" },
  paymentMethod: { ar: "طريقة الدفع", en: "Payment Method" },
  paymentNumber: { ar: "رقم الدفعة", en: "Payment Number" },
  paymentSource: { ar: "مصدر الدفع", en: "Payment Source" },
  recoveryAmount: { ar: "مبلغ الاسترداد", en: "Recovery Amount" },
  recoveryRequired: { ar: "مطلوب استرداده", en: "Recovery Required" },
  reconciliationCount: { ar: "استحقاقات المطابقة اليومية", en: "Daily Reconciliation Accruals" },
  remainingOutstanding: { ar: "المتبقي المستحق", en: "Remaining Outstanding" },
  remainingDriverOutstanding: { ar: "إجمالي المستحق المتبقي للسائق", en: "Remaining Driver Outstanding" },
  reversedAmount: { ar: "المبلغ المعكوس", en: "Reversed Amount" },
  reversedAt: { ar: "تاريخ العكس", en: "Reversed At" },
  reversedBy: { ar: "عكس بواسطة", en: "Reversed By" },
  reversedPayments: { ar: "الدفعات المعكوسة", en: "Reversed Payments" },
  reversalReason: { ar: "سبب العكس", en: "Reversal Reason" },
  separatePaymentAmount: { ar: "الدفعة النقدية المنفصلة", en: "Separate Cash Payment" },
  separatePayments: { ar: "دفعات نقدية منفصلة", en: "Separate Cash Payments" },
  serialNumber: { ar: "الرقم التسلسلي", en: "Serial Number" },
  source: { ar: "المصدر", en: "Source" },
  status: { ar: "الحالة", en: "Status" },
  to: { ar: "إلى تاريخ", en: "To" },
  totalActivePaid: { ar: "إجمالي المدفوع الفعلي", en: "Total Active Paid" },
  totalEarned: { ar: "إجمالي المكتسب", en: "Total Earned" },
  totalPaid: { ar: "إجمالي المدفوع", en: "Total Paid" },
  totalOutstanding: { ar: "إجمالي المستحق", en: "Total Outstanding" },
  totalRecoveryRequired: { ar: "إجمالي المطلوب استرداده", en: "Total Recovery Required" },
  unpaidAccrualCount: { ar: "عدد الاستحقاقات غير المسددة", en: "Unpaid Accrual Count" },
  unpaidOrderCount: { ar: "عدد الطلبات غير المسددة", en: "Unpaid Order Count" },
  voucherReference: { ar: "مرجع سند الصرف", en: "Cash Voucher Reference" },
};

function label(key: string, language: DriverFeeReportLanguage): string {
  return labels[key]?.[language] ?? key.replace(/([A-Z])/g, " $1");
}

function doc(
  title: string,
  company: DriverEarningsStatementData["company"],
  generatedAt: string,
  language: DriverFeeReportLanguage,
  body: string,
) {
  const rtl = language === "ar";
  return `<!doctype html><html lang="${language}" dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><style>
  @page{size:A4;margin:14mm 12mm 18mm}*{box-sizing:border-box}body{font-family:"Noto Sans Arabic","Segoe UI",Arial,sans-serif;color:#172033;font-size:10px}
  header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #3156d9;padding-bottom:10px;margin-bottom:12px}.brand{display:flex;gap:10px;align-items:center}.logo{max-height:44px;max-width:110px}h1{font-size:20px;margin:0;color:#243b8f}h2{font-size:13px;margin:14px 0 6px}.muted{color:#647087}.meta,.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0}.box{border:1px solid #dfe4f1;border-radius:5px;padding:6px}.box span{display:block;color:#647087}.box strong{font-size:11px}table{width:100%;border-collapse:collapse;font-size:8.5px}thead{display:table-header-group}th{background:#eef2ff;color:#243b8f}th,td{border:1px solid #dfe4f1;padding:4px;text-align:${rtl ? "right" : "left"};vertical-align:top}tr{break-inside:avoid}.warning{background:#fff7df;border:1px solid #efc24f;padding:7px}.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:28px}.signature{border-top:1px solid #647087;padding-top:6px;text-align:center}.mono{direction:ltr;unicode-bidi:isolate}.internal{margin-top:12px;color:#647087;text-align:center}
  </style></head><body><header><div class="brand">${company.logoDataUri === null ? "" : `<img class="logo" src="${escape(company.logoDataUri)}">`}<div><strong>${escape(company.nameEn)}</strong>${company.nameAr === null ? "" : `<div>${escape(company.nameAr)}</div>`}</div></div><h1>${escape(title)}</h1></header>${body}<div class="internal">${escape(text[language].internal)} · ${escape(generatedAt)}</div></body></html>`;
}

function boxes(values: Record<string, unknown>, language: DriverFeeReportLanguage, kind: "meta" | "summary" = "summary") {
  return `<section class="${kind}">${Object.entries(values).map(([key, value]) => `<div class="box"><span>${escape(label(key, language))}</span><strong>${escape(value)}</strong></div>`).join("")}</section>`;
}

function table(rows: readonly Record<string, unknown>[], keys: readonly string[], language: DriverFeeReportLanguage) {
  return `<table><thead><tr>${keys.map((key) => `<th>${escape(label(key, language))}</th>`).join("")}</tr></thead><tbody>${rows.map((row, index) => `<tr>${keys.map((key) => `<td${["orderNumber", "serialNumber", "paymentNumber", "driverCode"].includes(key) ? ' class="mono"' : ""}>${escape(key === "line" ? index + 1 : row[key])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

export function buildDriverEarningsStatementHtml(data: DriverEarningsStatementData, language: DriverFeeReportLanguage) {
  const keys = ["line","orderNumber","serialNumber","deliveryDate","accrualBusinessDate","feeRate","earnedAmount","paidBefore","paidDuringPeriod","separatePaymentAmount","collectionOffsetAmount","reversedAmount","closingOutstanding","recoveryAmount","accrualStatus"];
  return doc(text[language].earnings, data.company, data.generatedAt, language,
    boxes({driverName:data.driver.name,driverCode:data.driver.code,from:data.from,to:data.to},language,"meta")+
    boxes(data.summary,language)+(data.warnings.length===0?"":`<div class="warning">${data.warnings.map(escape).join("<br>")}</div>`)+table(data.lines,keys,language));
}

export function buildOutstandingDriverFeesHtml(data: OutstandingDriverFeesReportData, language: DriverFeeReportLanguage) {
  return doc(text[language].outstanding,data.company,data.generatedAt,language,
    boxes({asOf:data.asOf},language,"meta")+boxes(data.summary,language)+table(data.lines,["line","driverName","driverCode","earnedAmount","activePaid","outstanding","oldestOutstandingDate","unpaidOrderCount","partiallyPaidCount","recoveryAmount","lastPaymentDate","lastCollectionOffsetDate"],language));
}

export function buildDailyDriverFeeAccrualHtml(data: DailyDriverFeeAccrualReportData, language: DriverFeeReportLanguage) {
  return doc(text[language].accrualReport,data.company,data.generatedAt,language,
    boxes({from:data.from,to:data.to},language,"meta")+boxes(data.summary,language)+table(data.lines,["line","accrualBusinessDate","deliveryDate","driverName","driverCode","orderNumber","serialNumber","feeRate","earnedAmount","source","status","createdBy","createdAt"],language));
}

export function buildDriverFeePaymentReceiptHtml(data: DriverFeePaymentReceiptData, language: DriverFeeReportLanguage) {
  const source = String(data.header.paymentSource ?? "");
  const sourceLabel = source === "driver_collection"
    ? (language === "ar" ? "خصم مقابل تحصيل السائق" : "Driver Collection Fee Offset")
    : (language === "ar" ? "دفعة نقدية منفصلة" : "Separate Cash Payment");
  const receiptHeader = {
    paymentNumber: data.header.paymentNumber,
    driverName: data.header.driverName,
    driverCode: data.header.driverCode,
    paymentDate: data.header.paymentDate,
    paymentMethod: data.header.paymentMethod,
    paymentSource: sourceLabel,
    amountPaid: data.header.amountPaid,
    voucherReference: data.header.voucherReference,
    externalReference: data.header.externalReference,
    linkedDriverCollection: data.header.linkedDriverCollection,
    status: data.header.status,
    paidBy: data.header.paidBy,
    createdAt: data.header.createdAt,
    reversalReason: data.header.reversalReason,
    reversedBy: data.header.reversedBy,
    reversedAt: data.header.reversedAt,
    notes: data.header.notes,
  };
  return doc(text[language].receipt,data.company,data.generatedAt,language,
    boxes(receiptHeader,language,"meta")+table(data.allocations,["line","orderNumber","serialNumber","deliveryDate","accrualBusinessDate","earnedAmount","paidBefore","paidThisPayment","remainingOutstanding","accrualStatus","allocationStatus"],language)+boxes(data.summary,language)+`<section class="signatures"><div class="signature">${text[language].paidBy}</div><div class="signature">${text[language].authorization}</div><div class="signature">${text[language].driverAcknowledgement}</div></section>`);
}

export function driverFeeReportFooter(language: DriverFeeReportLanguage) {
  return `<div style="font-size:8px;width:100%;padding:0 12mm;color:#647087;display:flex;justify-content:space-between;direction:${language === "ar" ? "rtl" : "ltr"}"><span>${text[language].internal}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
}
