import type { TraderAccountStatement } from "./trader-account-statement.service.js";

export type TraderAccountStatementLanguage = "en" | "ar";

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function buildTraderAccountStatementHtml(
  data: TraderAccountStatement,
  language: TraderAccountStatementLanguage,
): string {
  const ar = language === "ar";
  const labels = ar
    ? {
        amount: "المبلغ",
        balance: "الرصيد",
        credit: "دائن",
        date: "التاريخ",
        debit: "مدين",
        description: "البيان",
        from: "من",
        opening: "الرصيد الافتتاحي",
        summary: "الملخص",
        title: "كشف حساب التاجر",
        to: "إلى",
        transaction: "المرجع",
      }
    : {
        amount: "Amount",
        balance: "Balance",
        credit: "Credit",
        date: "Date",
        debit: "Debit",
        description: "Description",
        from: "From",
        opening: "Opening balance",
        summary: "Summary",
        title: "Trader Account Statement",
        to: "To",
        transaction: "Reference",
      };
  const rows = data.transactions
    .map(
      (line) => `<tr>
        <td>${line.lineNumber}</td>
        <td>${escapeHtml(line.date)}</td>
        <td>${escapeHtml(line.reference)}</td>
        <td>${escapeHtml(line.description)}</td>
        <td class="money">${escapeHtml(line.debit)}</td>
        <td class="money">${escapeHtml(line.credit)}</td>
        <td class="money">${escapeHtml(line.runningBalance)}</td>
      </tr>`,
    )
    .join("");
  const settlementDetails = data.settlements
    .map(
      (settlement) => `<section class="settlement">
        <h2>${escapeHtml(settlement.settlementNumber)} · ${escapeHtml(settlement.date)} · AED ${escapeHtml(settlement.amount)}${settlement.isReversed ? ` · ${ar ? "معكوس" : "Reversed"}` : ""}</h2>
        <div class="muted">${escapeHtml(settlement.paymentMethod)} · ${escapeHtml(settlement.paymentReference ?? "-")}</div>
        <table><thead><tr><th>${ar ? "الطلب" : "Order"}</th><th>${ar ? "تاريخ التسليم" : "Delivery date"}</th><th>${ar ? "المستحق الأصلي" : "Original payable"}</th><th>${ar ? "المسدد سابقاً" : "Previously settled"}</th><th>${ar ? "المسدد في التسوية" : "Settled now"}</th><th>${ar ? "المتبقي" : "Remaining"}</th><th>${ar ? "الحالة" : "Status"}</th></tr></thead>
        <tbody>${settlement.allocations.map((allocation) => `<tr><td>${escapeHtml(allocation.serialNumber)}<br><span class="muted">${escapeHtml(allocation.orderNumber)}</span></td><td>${escapeHtml(allocation.deliveryDate ?? "-")}</td><td class="money">${escapeHtml(allocation.originalTraderPayable)}</td><td class="money">${escapeHtml(allocation.previouslySettled)}</td><td class="money">${escapeHtml(allocation.allocatedAmount)}</td><td class="money">${escapeHtml(allocation.remainingAfterSettlement)}</td><td>${escapeHtml(allocation.status)}</td></tr>`).join("")}</tbody></table>
      </section>`,
    )
    .join("");
  return `<!doctype html>
<html lang="${language}" dir="${ar ? "rtl" : "ltr"}">
<head><meta charset="utf-8"><style>
@page{size:A4;margin:14mm 12mm 18mm}*{box-sizing:border-box}body{font-family:Arial,"Noto Sans Arabic",sans-serif;color:#182033;font-size:10px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:13px;margin:14px 0 5px}.muted{color:#667085}.header{display:flex;justify-content:space-between;border-bottom:2px solid #3158e8;padding-bottom:10px;margin-bottom:12px}.brand{display:flex;gap:9px}.logo{width:48px;height:48px;object-fit:contain}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}.card{border:1px solid #d9dfeb;border-radius:6px;padding:8px}.card strong{display:block;font-size:14px;margin-top:4px}
table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}th{background:#eef2ff;text-align:${ar ? "right" : "left"};padding:6px;border:1px solid #d9dfeb}td{padding:6px;border:1px solid #e2e6ef;vertical-align:top;overflow-wrap:anywhere}.money{text-align:end;font-variant-numeric:tabular-nums}
.warning{margin-top:10px;padding:8px;background:#fff7e6;border:1px solid #f4c66a}.footer-note{margin-top:10px;color:#667085}.settlement{break-inside:avoid;margin-top:14px}
</style></head>
<body>
  <section class="header"><div class="brand">${data.company.logoDataUri === null ? "" : `<img class="logo" alt="" src="${escapeHtml(data.company.logoDataUri)}">`}<div><h1>${labels.title}</h1><div>${escapeHtml(data.trader.number)} · ${escapeHtml(ar ? data.trader.nameAr || data.trader.nameEn : data.trader.nameEn)}</div></div></div>
  <div><strong>${escapeHtml(ar ? data.company.nameAr || data.company.nameEn : data.company.nameEn)}</strong><br>${labels.from}: ${escapeHtml(data.period.from)}<br>${labels.to}: ${escapeHtml(data.period.to)}</div></section>
  <section class="cards">
    <div class="card">${labels.opening}<strong>AED ${escapeHtml(data.summary.openingBalance)}</strong></div>
    <div class="card">${labels.debit}<strong>AED ${escapeHtml(data.summary.totalPayable)}</strong></div>
    <div class="card">${labels.credit}<strong>AED ${escapeHtml(data.summary.netPayments)}</strong></div>
  </section>
  <section class="cards">
    <div class="card">${ar ? "الدفع عند الاستلام" : "COD collected"}<strong>AED ${escapeHtml(data.summary.codCollected)}</strong></div>
    <div class="card">${ar ? "رسوم الخدمة" : "Service fees"}<strong>AED ${escapeHtml(data.summary.serviceFeesDeducted)}</strong></div>
    <div class="card">${ar ? "المبلغ المستحق" : "Outstanding"}<strong>AED ${escapeHtml(data.summary.outstandingAmount)}</strong></div>
  </section>
  <table><thead><tr><th>#</th><th>${labels.date}</th><th>${labels.transaction}</th><th>${labels.description}</th><th>${labels.debit}</th><th>${labels.credit}</th><th>${labels.balance}</th></tr></thead>
  <tbody>${rows}</tbody></table>
  ${settlementDetails}
  ${data.warnings.length === 0 ? "" : `<div class="warning">${data.warnings.map(escapeHtml).join("<br>")}</div>`}
  <div class="footer-note">${labels.summary}: AED ${escapeHtml(data.summary.closingBalance)} · ${escapeHtml(data.generatedAt)} (Asia/Dubai)</div>
</body></html>`;
}
