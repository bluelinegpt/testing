import { Decimal } from "decimal.js";

import { code128Svg } from "./code128-svg.js";
import {
  escapeHtml,
  INVOICE_CSS,
  referenceKey,
  shortDate,
  todayLong,
} from "./lahthza-trader-invoice-html.js";
import type { TraderCollectionReportData } from "./trader-receivable.service.js";

/**
 * The Trader Receipt (COL) printed like the Trader Invoice (Aiman, 1 Nov
 * 2026, every Company): logo, barcode of the receipt number, the employee who
 * received the money, the date, one Trader line, one table sorted by
 * reference number with the invoice's columns, the total, the signatures and
 * the one-week review note.
 *
 * Reference No is the Order's reference number, or its Order number when it
 * has none (or the receivable number for a charge with no Order).
 */
type Language = "ar" | "en";

const LABELS = {
  ar: {
    accountantSignature: "توقيع المحاسب",
    amount: "المبلغ",
    bank: "تحويل بنكي",
    cash: "نقدي",
    collected: "محصّل",
    customer: "العميل",
    customerAddress: "عنوان العميل",
    date: "التاريخ",
    delPrice: "سعر التوصيل",
    employee: "الموظف",
    note: "يرجي مراجعة الحسابات خلال أسبوع فقط من أستلام المبالغ وكشف الحساب والشركة غير مسؤولة بعد إنتهاء هذه المدة",
    partiallyCollected: "محصّل جزئياً",
    payment: "طريقة الدفع",
    printedOn: "تاريخ الطباعة",
    proPrice: "سعر المنتج",
    reference: "رقم المرجع",
    reversed: "هذا الإيصال معكوس",
    status: "الحالة",
    title: "إيصال استلام من التاجر",
    totalAmount: "المبلغ الإجمالي",
    totalCount: "عدد الطلبات",
    trader: "التاجر",
    traderSignature: "توقيع التاجر",
    vat: "الضريبة",
  },
  en: {
    accountantSignature: "Accountant Signature",
    amount: "Amount",
    bank: "Bank transfer",
    cash: "Cash",
    collected: "Collected",
    customer: "Customer",
    customerAddress: "Customer Address",
    date: "Date",
    delPrice: "Del Price",
    employee: "Employee",
    note: "Please review the accounts within only a week of receiving the amounts and the account statement, and the company is not responsible after the end of this period",
    partiallyCollected: "Partially collected",
    payment: "Payment",
    printedOn: "Printed on",
    proPrice: "Pro Price",
    reference: "Reference No",
    reversed: "This receipt has been reversed",
    status: "Status",
    title: "Trader Receipt",
    totalAmount: "Total Amount",
    totalCount: "Total Count",
    trader: "Trader",
    traderSignature: "Trader Signature",
    vat: "VAT",
  },
} as const;

const amount = (value: Decimal.Value) => new Decimal(value).toFixed(2);

export function buildTraderReceiptHtml(data: TraderCollectionReportData, language: Language): string {
  const labels = LABELS[language];
  const header = data.header;
  const ar = language === "ar";
  const place = (emirate: string | null | undefined, area: string | null | undefined) =>
    [emirate, area].filter((part) => part !== null && part !== undefined && part !== "").join(", ");

  const rows = data.lines
    .map((line) => {
      const hasOrder = line.orderNumber !== null;
      const reference =
        (line.referenceNumber ?? "").trim() !== ""
          ? (line.referenceNumber ?? "")
          : (line.orderNumber ?? line.receivableNumber);
      return {
        address: place(
          ar ? (line.emirateNameAr ?? line.emirateName) : line.emirateName,
          ar ? (line.areaNameAr ?? line.areaName) : line.areaName,
        ),
        amount: new Decimal(line.amountCollectedNow),
        customer: hasOrder ? (line.customerName ?? "") : line.reason,
        customerMobile: hasOrder ? (line.customerMobileNumber ?? "") : "",
        delPrice: amount(line.originalAmountDue),
        orderNumber: hasOrder && reference !== line.orderNumber ? line.orderNumber : null,
        proPrice: hasOrder ? amount(line.orderCodAmount ?? 0) : "",
        reference,
        status:
          line.receivableStatus === "partially_collected" ? labels.partiallyCollected : labels.collected,
      };
    })
    .sort(
      (a, b) =>
        referenceKey(a.reference) - referenceKey(b.reference) || a.reference.localeCompare(b.reference),
    );
  const total = rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
  const traderName = ar ? (header.traderNameAr ?? header.traderName) : header.traderName;
  const payment = `${header.paymentMethod === "bank_transfer" ? labels.bank : labels.cash}${
    header.paymentReference ? ` · ${header.paymentReference}` : ""
  }`;
  const reversed = header.status === "reversed";
  const logo =
    header.company.logoDataUri == null
      ? `<div class="brand">${escapeHtml(ar ? (header.company.nameAr ?? header.company.nameEn) : header.company.nameEn)}</div>`
      : `<img class="logo" alt="" src="${escapeHtml(header.company.logoDataUri)}">`;

  const body = rows
    .map(
      (row, index) =>
        `<tr><td class="c">${index + 1}</td><td class="c">${escapeHtml(row.reference)}${
          row.orderNumber === null ? "" : `<br><small>${escapeHtml(row.orderNumber)}</small>`
        }</td>` +
        `<td class="c">${escapeHtml(row.customer)}${row.customerMobile === "" ? "" : `,<br><bdi dir="ltr">${escapeHtml(row.customerMobile)}</bdi>`}</td>` +
        `<td class="c">${escapeHtml(row.address)}</td>` +
        `<td class="n">${escapeHtml(row.proPrice)}</td><td class="n">${escapeHtml(row.delPrice)}</td>` +
        `<td class="n">${row.proPrice === "" ? "" : "0.00"}</td><td class="c">${escapeHtml(row.status)}</td>` +
        `<td class="n"><bdi dir="ltr">${amount(row.amount)}</bdi></td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="${language}" dir="${ar ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(labels.title)} ${escapeHtml(header.collectionNumber)}</title>
<style>
${INVOICE_CSS}</style>
</head>
<body>
${reversed ? `<div class="watermark">${escapeHtml(labels.reversed)}</div>` : ""}
<div class="box top">
  <div>${logo}<div class="title">${escapeHtml(labels.title)}</div></div>
  <div class="mid">${code128Svg(header.collectionNumber)}<div class="number">${escapeHtml(header.collectionNumber)}</div>
    <div class="employee">${escapeHtml(labels.employee)} : <bdi>${escapeHtml(header.receivedBy)}</bdi></div></div>
  <div class="date">${escapeHtml(labels.date)} : <bdi dir="ltr">${escapeHtml(shortDate(header.paymentDate))}</bdi></div>
</div>
${reversed ? `<div class="flags">${escapeHtml(labels.reversed)}${header.reversalReason ? ` — ${escapeHtml(header.reversalReason)}` : ""}</div>` : ""}
<div class="box party">
  <div>${escapeHtml(labels.trader)} : ${header.traderMobile ? `<bdi dir="ltr">${escapeHtml(header.traderMobile)}</bdi> , ` : ""}${escapeHtml(traderName)}</div>
  <div>${escapeHtml(labels.payment)} : ${escapeHtml(payment)}</div>
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
