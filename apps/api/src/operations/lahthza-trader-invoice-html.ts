import { Decimal } from "decimal.js";

import { code128Svg } from "./code128-svg.js";
import type { TraderSettlementReportData } from "./trader-settlement.service.js";

/**
 * Lahthza's Trader settlement invoice (Aiman, 25 Oct 2026).
 *
 * Laid out like the Trader payment sheet Lahthza used before ("Client
 * Payment"): logo, barcode of the invoice number, the issuing employee, the
 * date, one Trader line, one table sorted by reference number, the total, the
 * signatures and the one-week review note -- no more, no less. Only Lahthza's
 * settlement invoice uses it; every other Company and the 0.00 invoice keep
 * the standard layout (trader-settlement-report-html.ts).
 */
export const LAHTHZA_COMPANY_ID = "4d9095cb-3da6-4b8b-9d8e-ff01f8192bdb";

type Language = "ar" | "en";

const LABELS = {
  ar: {
    address: "العنوان",
    amount: "المبلغ",
    amended: "فاتورة معدّلة بعد الترحيل",
    accountantSignature: "توقيع المحاسب",
    customer: "العميل",
    customerAddress: "عنوان العميل",
    date: "التاريخ",
    delivered: "تم التسليم",
    delPrice: "سعر التوصيل",
    draft: "مسودة — غير مرحّلة",
    employee: "الموظف",
    note: "يرجي مراجعة الحسابات خلال أسبوع فقط من أستلام المبالغ وكشف الحساب والشركة غير مسؤولة بعد إنتهاء هذه المدة",
    original: "النسخة الأصلية — عُدّلت لاحقاً",
    printedOn: "تاريخ الطباعة",
    proPrice: "سعر المنتج",
    reference: "رقم المرجع",
    reversed: "هذه الفاتورة معكوسة",
    status: "الحالة",
    title: "فاتورة التاجر",
    totalAmount: "المبلغ الإجمالي",
    totalCount: "عدد الطلبات",
    trader: "التاجر",
    traderCredit: "رصيد دائن للتاجر",
    traderSignature: "توقيع التاجر",
    vat: "الضريبة",
  },
  en: {
    address: "Address",
    amount: "Amount",
    amended: "Amended after posting",
    accountantSignature: "Accountant Signature",
    customer: "Customer",
    customerAddress: "Customer Address",
    date: "Date",
    delivered: "Delivered",
    delPrice: "Del Price",
    draft: "DRAFT — not posted",
    employee: "Employee",
    note: "Please review the accounts within only a week of receiving the amounts and the account statement, and the company is not responsible after the end of this period",
    original: "ORIGINAL — amended later",
    printedOn: "Printed on",
    proPrice: "Pro Price",
    reference: "Reference No",
    reversed: "This invoice has been reversed",
    status: "Status",
    title: "Trader Invoice",
    totalAmount: "Total Amount",
    totalCount: "Total Count",
    trader: "Trader",
    traderCredit: "Trader credit",
    traderSignature: "Trader Signature",
    vat: "VAT",
  },
} as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 2026-10-25 -> 25-Oct-2026 (the old sheet's format). */
function shortDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (match === null) return value;
  return `${match[3]}-${MONTHS[Number(match[2]) - 1] ?? match[2]}-${match[1]}`;
}

function todayLong(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "numeric", timeZone: "Asia/Dubai", year: "numeric",
  }).formatToParts(new Date());
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("day")}-${MONTHS_LONG[Number(pick("month")) - 1] ?? pick("month")}-${pick("year")}`;
}

const amount = (value: Decimal.Value) => new Decimal(value).toFixed(2);

interface Row {
  readonly address: string;
  readonly amount: Decimal;
  readonly customer: string;
  readonly customerMobile: string;
  readonly delPrice: string;
  readonly proPrice: string;
  readonly reference: string;
  readonly status: string;
  readonly vat: string;
}

function referenceKey(reference: string): number {
  const digits = reference.replace(/[^0-9]/gu, "");
  return digits === "" ? Number.POSITIVE_INFINITY : Number(digits);
}

export function buildLahthzaTraderInvoiceHtml(
  data: TraderSettlementReportData,
  language: Language,
): string {
  const labels = LABELS[language];
  const header = data.header;
  const place = (emirate: string | null | undefined, area: string | null | undefined) =>
    [emirate, area].filter((part) => part !== null && part !== undefined && part !== "").join(", ");

  const rows: Row[] = [];
  // Orders paid now, and "Nothing to pay" Orders printed at 0.00.
  for (const line of data.orders) {
    rows.push({
      address: place(
        language === "ar" ? (line.emirateNameAr ?? line.emirateName) : line.emirateName,
        language === "ar" ? (line.areaNameAr ?? line.areaName) : line.areaName,
      ),
      amount: new Decimal(line.amountPaidNow),
      customer: line.customerName,
      customerMobile: line.customerMobileNumber,
      delPrice: amount(new Decimal(line.serviceFee).plus(line.additionalFees)),
      proPrice: amount(line.codAmount),
      reference: line.referenceNumber ?? line.serialNumber,
      status: labels.delivered,
      vat: amount(line.vatAmount),
    });
  }
  // Trader fees deducted now: the Order's COD, its fee (COD + amount
  // deducted, so every row reads COD - fee = amount) and a negative amount.
  for (const fee of data.receivableOffsets) {
    const hasOrder = fee.orderNumber !== null && fee.orderNumber !== undefined;
    const cod = new Decimal(hasOrder ? (fee.orderCodAmount ?? 0) : 0);
    rows.push({
      address: place(
        language === "ar" ? (fee.emirateNameAr ?? fee.emirateName) : fee.emirateName,
        language === "ar" ? (fee.areaNameAr ?? fee.areaName) : fee.areaName,
      ),
      amount: new Decimal(fee.amountApplied).negated(),
      customer: hasOrder ? (fee.customerName ?? "") : fee.reason,
      customerMobile: hasOrder ? (fee.customerMobileNumber ?? "") : "",
      delPrice: amount(cod.plus(fee.amountApplied)),
      proPrice: amount(cod),
      reference: fee.referenceNumber ?? fee.receivableNumber,
      status: hasOrder ? labels.delivered : "—",
      vat: amount(0),
    });
  }
  // Trader credits paid back now.
  for (const credit of data.creditApplications ?? []) {
    rows.push({
      address: "",
      amount: new Decimal(credit.amountApplied),
      customer: `${labels.traderCredit} ${credit.creditNumber}`,
      customerMobile: credit.reason,
      delPrice: "",
      proPrice: "",
      reference: credit.sourceReferenceNumber ?? credit.creditNumber,
      status: "—",
      vat: "",
    });
  }
  rows.sort(
    (a, b) =>
      referenceKey(a.reference) - referenceKey(b.reference) || a.reference.localeCompare(b.reference),
  );
  const total = rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));

  const party = header.invoiceParty;
  const employee = party === undefined
    ? header.createdBy
    : [party.employeeName, party.employeeMobile].filter((part) => part !== null && part !== "").join(", ");
  const traderAddress = party === undefined
    ? null
    : language === "ar" ? (party.traderAddressAr ?? party.traderAddressEn) : party.traderAddressEn;
  const invoiceNumber = header.settlementNumber;
  const barcodeValue = invoiceNumber.split(" / ")[0] ?? invoiceNumber;
  const isDraft = header.status === "draft";
  const flags = [
    isDraft ? labels.draft : null,
    header.status === "reversed" || header.reversedBySettlementNumber !== null
      ? `${labels.reversed}${header.reversedBySettlementNumber === null ? "" : ` (${header.reversedBySettlementNumber})`}`
      : null,
    header.amendment == null
      ? null
      : `${header.amendment.version === "original" ? labels.original : labels.amended}: ${header.amendment.removedLines
          .map((line) => `${line.referenceNumber ?? line.serialNumber} — ${line.correctionNumber}`)
          .join(", ")}`,
  ].filter((flag): flag is string => flag !== null);

  const logo =
    header.company.logoDataUri == null
      ? `<div class="brand">${escapeHtml(language === "ar" ? (header.company.nameAr ?? header.company.nameEn) : header.company.nameEn)}</div>`
      : `<img class="logo" alt="" src="${escapeHtml(header.company.logoDataUri)}">`;

  const body = rows
    .map(
      (row, index) =>
        `<tr><td class="c">${index + 1}</td><td class="c">${escapeHtml(row.reference)}</td>` +
        `<td class="c">${escapeHtml(row.customer)}${row.customerMobile === "" ? "" : `,<br><bdi dir="ltr">${escapeHtml(row.customerMobile)}</bdi>`}</td>` +
        `<td class="c">${escapeHtml(row.address)}</td>` +
        `<td class="n">${escapeHtml(row.proPrice)}</td><td class="n">${escapeHtml(row.delPrice)}</td>` +
        `<td class="n">${escapeHtml(row.vat)}</td><td class="c">${escapeHtml(row.status)}</td>` +
        `<td class="n${row.amount.isNegative() ? " neg" : ""}"><bdi dir="ltr">${amount(row.amount)}</bdi></td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="${language}" dir="${language === "ar" ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(labels.title)} ${escapeHtml(invoiceNumber)}</title>
<style>
  /* Lahthza brand colours, from the logo: blue and orange. */
  :root { --blue: #1d6fb8; --blue-dark: #134f86; --blue-soft: #eaf3fb; --orange: #f26a1b; --red: #c62828; --red-soft: #fdecea; }
  @page { size: A4; margin: 12mm 10mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: Arial, "Segoe UI", Tahoma, sans-serif; color: #1b1b1b; font-size: 12px; }
  .box { border: 1.5px solid var(--blue); border-radius: 4px; }
  .top { display: grid; grid-template-columns: 1fr 1.1fr 1fr; align-items: end; padding: 8px 12px;
    border-top: 6px solid var(--blue); border-bottom: 3px solid var(--orange); }
  .logo { max-height: 70px; max-width: 220px; display: block; }
  .brand { font-size: 22px; font-weight: 800; color: var(--blue); }
  .title { font-size: 20px; font-weight: 700; margin-top: 6px; color: var(--blue-dark); }
  .mid { text-align: center; }
  .barcode { width: 190px; height: 58px; display: block; margin: 0 auto; }
  .number { font-size: 14px; margin-top: 2px; font-weight: 700; color: var(--blue-dark); }
  .employee { font-size: 13px; margin-top: 4px; }
  .date { text-align: end; font-size: 13px; font-weight: 700; color: var(--blue-dark); }
  .party { display: flex; justify-content: space-between; gap: 12px; padding: 6px 12px; margin-top: 10px;
    font-size: 14px; background: var(--blue-soft); }
  table { width: 100%; border-collapse: collapse; border: 1.5px solid var(--blue); border-top: 0; margin-top: 6px; }
  thead { display: table-header-group; }
  th { background: var(--blue); color: #fff; border: 1px solid var(--blue-dark); padding: 6px 4px; font-size: 13px; font-weight: 700; }
  td { border: 1px solid #b9cfe4; padding: 5px 4px; vertical-align: top; font-size: 12.5px; }
  tbody tr:nth-child(even) td { background: var(--blue-soft); }
  td.c { text-align: center; }
  td.n { text-align: end; white-space: nowrap; }
  td.neg { color: #c0392b; font-weight: 700; }
  tr { page-break-inside: avoid; }
  .totals { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; font-size: 14px; font-weight: 700; }
  .totals .count { color: var(--blue-dark); }
  .totals .count span { margin-inline-start: 60px; }
  .totals .sum { background: var(--red-soft); border: 1.5px solid var(--red); border-radius: 4px; padding: 6px 12px; color: var(--blue-dark); }
  .totals .sum span { margin-inline-start: 50px; font-size: 17px; color: var(--red); }
  .printed { margin-top: 10px; font-size: 13px; color: #555; }
  .signs { display: flex; justify-content: space-between; margin-top: 22px; font-size: 14px; color: var(--blue-dark); }
  .notes { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 26px; padding-top: 8px; border-top: 2px solid var(--orange); }
  .note { font-size: 11.5px; line-height: 1.5; color: #444; }
  .flags { margin-top: 6px; font-size: 12px; font-weight: 700; color: #b42318; }
  .watermark { position: fixed; top: 42%; left: 0; right: 0; text-align: center; font-size: 60px;
    font-weight: 800; color: rgba(180, 35, 24, 0.12); transform: rotate(-24deg); z-index: 0; }
</style>
</head>
<body>
${isDraft ? `<div class="watermark">${escapeHtml(labels.draft)}</div>` : ""}
<div class="box top">
  <div>${logo}<div class="title">${escapeHtml(labels.title)}</div></div>
  <div class="mid">${code128Svg(barcodeValue)}<div class="number">${escapeHtml(invoiceNumber)}</div>
    <div class="employee">${escapeHtml(labels.employee)} : <bdi>${escapeHtml(employee)}</bdi></div></div>
  <div class="date">${escapeHtml(labels.date)} : <bdi dir="ltr">${escapeHtml(shortDate(header.paymentDate))}</bdi></div>
</div>
${flags.length === 0 ? "" : `<div class="flags">${flags.map(escapeHtml).join("<br>")}</div>`}
<div class="box party">
  <div>${escapeHtml(labels.trader)} : ${header.traderMobile ? `<bdi dir="ltr">${escapeHtml(header.traderMobile)}</bdi> , ` : ""}${escapeHtml(header.traderName)}</div>
  ${traderAddress === null ? "" : `<div>${escapeHtml(labels.address)} : ${escapeHtml(traderAddress)}</div>`}
</div>
<table>
  <thead><tr>
    <th>#</th><th>${escapeHtml(labels.reference)}</th><th>${escapeHtml(labels.customer)}</th>
    <th>${escapeHtml(labels.customerAddress)}</th><th>${escapeHtml(labels.proPrice)}</th>
    <th>${escapeHtml(labels.delPrice)}</th><th>${escapeHtml(labels.vat)}</th>
    <th>${escapeHtml(labels.status)}</th><th>${escapeHtml(labels.amount)}</th>
  </tr></thead>
  <tbody>${body}</tbody>
</table>
<div class="totals">
  <div class="count">${escapeHtml(labels.totalCount)}<span>${rows.length}</span></div>
  <div class="sum">${escapeHtml(labels.totalAmount)}<span><bdi dir="ltr">${amount(total)}</bdi></span></div>
</div>
<div class="printed">${escapeHtml(labels.printedOn)} : <bdi dir="ltr">${escapeHtml(todayLong())}</bdi></div>
<div class="signs">
  <div>${escapeHtml(labels.accountantSignature)}______________________</div>
  <div>${escapeHtml(labels.traderSignature)}______________________</div>
</div>
<div class="notes" dir="ltr">
  <div class="note" dir="ltr">${escapeHtml(LABELS.en.note)}</div>
  <div class="note" dir="rtl">${escapeHtml(LABELS.ar.note)}</div>
</div>
</body>
</html>`;
}
