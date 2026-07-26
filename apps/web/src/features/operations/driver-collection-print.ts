// Dedicated Driver-collection print document (browser print-to-PDF, §12).
//
// A pure builder that turns a collection's data into a self-contained A4, RTL, Arabic-capable
// HTML document. It never touches the live application screen and never calls any API — printing
// must not mutate reconciliation or financial records. `openDriverCollectionPrint` opens the
// document in a new window for preview / print / reprint.

export interface DriverCollectionPrintOrder {
  readonly address: string;
  readonly amountToCollect: string;
  readonly areaNameAr: string;
  readonly companyFees: string;
  readonly customerMobile: string;
  readonly customerName: string;
  readonly notes: string | null;
  readonly referenceNumber: string | null;
  readonly serialNumber: string;
  readonly status: string;
  readonly traderPayable: string;
}

export interface DriverCollectionPrintTrader {
  readonly companyFees: string;
  readonly gross: string;
  readonly orderCount: number;
  readonly orders: readonly DriverCollectionPrintOrder[];
  readonly traderName: string;
  readonly traderPayable: string;
}

export interface DriverCollectionPrintData {
  readonly actualReceived: string;
  readonly businessDate: string;
  readonly companyName: string;
  readonly difference: string;
  readonly driverExpenses: string;
  readonly driverName: string;
  readonly gross: string;
  readonly netExpected: string;
  readonly paymentMethod: "cash" | "visa";
  readonly reconciliationNumber: string;
  readonly totalOrders: number;
  readonly totalTraders: number;
  readonly traders: readonly DriverCollectionPrintTrader[];
}

export interface DriverCollectionPrintLabels {
  readonly actualReceived: string;
  readonly address: string;
  readonly amountToCollect: string;
  readonly area: string;
  readonly cash: string;
  readonly collectionDate: string;
  readonly collectionNumber: string;
  readonly companyFees: string;
  readonly companyReceiverSignature: string;
  readonly customer: string;
  readonly difference: string;
  readonly driver: string;
  readonly driverExpenses: string;
  readonly driverSignature: string;
  readonly grossCustomerCollections: string;
  readonly mobile: string;
  readonly netExpected: string;
  readonly notes: string;
  readonly numberOfOrders: string;
  readonly orderStatus: string;
  readonly paymentMethod: string;
  readonly referenceNumber: string;
  readonly serialNumber: string;
  readonly signatureDate: string;
  readonly title: string;
  readonly totalOrders: string;
  readonly totalTraders: string;
  readonly trader: string;
  readonly traderPayable: string;
  readonly visa: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(value: string): string {
  return `AED ${escapeHtml(value)}`;
}

function orderRow(order: DriverCollectionPrintOrder): string {
  return (
    "<tr>" +
    `<td class="mono">${escapeHtml(order.serialNumber)}</td>` +
    `<td class="mono">${order.referenceNumber === null ? "" : escapeHtml(order.referenceNumber)}</td>` +
    `<td>${escapeHtml(order.customerName)}</td>` +
    `<td class="mono">${escapeHtml(order.customerMobile)}</td>` +
    `<td>${escapeHtml(order.areaNameAr)}</td>` +
    `<td>${escapeHtml(order.address)}</td>` +
    `<td class="num">${money(order.amountToCollect)}</td>` +
    `<td class="num">${money(order.companyFees)}</td>` +
    `<td class="num">${money(order.traderPayable)}</td>` +
    `<td>${escapeHtml(order.status)}</td>` +
    `<td>${order.notes === null ? "" : escapeHtml(order.notes)}</td>` +
    "</tr>"
  );
}

function traderPage(
  data: DriverCollectionPrintData,
  trader: DriverCollectionPrintTrader,
  labels: DriverCollectionPrintLabels,
  methodLabel: string,
): string {
  // The header block is repeated on every Trader page (§12).
  const header =
    `<header class="page-header">` +
    `<div class="company">${escapeHtml(data.companyName)}</div>` +
    `<div class="meta">` +
    `<span>${escapeHtml(labels.driver)}: ${escapeHtml(data.driverName)}</span>` +
    `<span>${escapeHtml(labels.collectionNumber)}: <b class="mono">${escapeHtml(data.reconciliationNumber)}</b></span>` +
    `<span>${escapeHtml(labels.collectionDate)}: ${escapeHtml(data.businessDate)}</span>` +
    `<span>${escapeHtml(labels.paymentMethod)}: ${escapeHtml(methodLabel)}</span>` +
    `<span>${escapeHtml(labels.trader)}: <b>${escapeHtml(trader.traderName)}</b></span>` +
    `</div></header>`;
  const rows = trader.orders.map(orderRow).join("");
  const totals =
    `<tfoot><tr class="totals">` +
    `<td colspan="6">${escapeHtml(labels.numberOfOrders)}: ${trader.orderCount}</td>` +
    `<td class="num">${money(trader.gross)}</td>` +
    `<td class="num">${money(trader.companyFees)}</td>` +
    `<td class="num">${money(trader.traderPayable)}</td>` +
    `<td colspan="2"></td>` +
    `</tr></tfoot>`;
  const table =
    `<table class="orders"><thead><tr>` +
    `<th>${escapeHtml(labels.serialNumber)}</th>` +
    `<th>${escapeHtml(labels.referenceNumber)}</th>` +
    `<th>${escapeHtml(labels.customer)}</th>` +
    `<th>${escapeHtml(labels.mobile)}</th>` +
    `<th>${escapeHtml(labels.area)}</th>` +
    `<th>${escapeHtml(labels.address)}</th>` +
    `<th>${escapeHtml(labels.amountToCollect)}</th>` +
    `<th>${escapeHtml(labels.companyFees)}</th>` +
    `<th>${escapeHtml(labels.traderPayable)}</th>` +
    `<th>${escapeHtml(labels.orderStatus)}</th>` +
    `<th>${escapeHtml(labels.notes)}</th>` +
    `</tr></thead><tbody>${rows}</tbody>${totals}</table>`;
  return `<section class="trader-page">${header}${table}</section>`;
}

function summaryPage(data: DriverCollectionPrintData, labels: DriverCollectionPrintLabels): string {
  const line = (label: string, value: string) =>
    `<div class="summary-line"><span>${escapeHtml(label)}</span><span>${value}</span></div>`;
  return (
    `<section class="summary-page">` +
    `<h2>${escapeHtml(labels.title)}</h2>` +
    line(labels.totalTraders, String(data.totalTraders)) +
    line(labels.totalOrders, String(data.totalOrders)) +
    line(labels.grossCustomerCollections, money(data.gross)) +
    line(labels.driverExpenses, money(data.driverExpenses)) +
    line(labels.netExpected, money(data.netExpected)) +
    line(labels.actualReceived, money(data.actualReceived)) +
    line(labels.difference, money(data.difference)) +
    `<div class="signatures">` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.driverSignature)}</span></div>` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.companyReceiverSignature)}</span></div>` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.signatureDate)}</span></div>` +
    `</div></section>`
  );
}

const STYLE = `
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; color: #111; margin: 0; }
  .trader-page { page-break-after: always; }
  .summary-page { page-break-before: always; }
  .page-header { border-bottom: 2px solid #333; margin-bottom: 8px; padding-bottom: 6px; }
  .page-header .company { font-size: 18px; font-weight: 800; }
  .page-header .meta { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12px; margin-top: 4px; }
  table.orders { width: 100%; border-collapse: collapse; font-size: 11px; }
  table.orders th, table.orders td { border: 1px solid #999; padding: 4px 6px; text-align: start; }
  table.orders thead th { background: #f0f0f0; }
  table.orders td.num, table.orders th:nth-child(n+7):nth-child(-n+9) { text-align: end; white-space: nowrap; }
  .mono { font-variant-numeric: tabular-nums; }
  tr.totals td { font-weight: 800; background: #f7f7f7; }
  .summary-page h2 { font-size: 16px; }
  .summary-line { display: flex; justify-content: space-between; border-bottom: 1px solid #ddd; padding: 6px 0; font-size: 13px; }
  .signatures { display: flex; justify-content: space-between; gap: 24px; margin-top: 48px; }
  .sign-box { flex: 1; text-align: center; }
  .sign-line { border-top: 1px solid #333; margin-bottom: 6px; height: 40px; }
`;

/** Pure: builds the full print document HTML. Never calls any API. */
export function buildDriverCollectionPrintDocument(
  data: DriverCollectionPrintData,
  labels: DriverCollectionPrintLabels,
): string {
  const methodLabel = data.paymentMethod === "visa" ? labels.visa : labels.cash;
  const pages = data.traders.map((trader) => traderPage(data, trader, labels, methodLabel)).join("");
  return (
    `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(labels.title)} ${escapeHtml(data.reconciliationNumber)}</title>` +
    `<style>${STYLE}</style></head><body>` +
    pages +
    summaryPage(data, labels) +
    `</body></html>`
  );
}

/** Opens the print document in a new window for preview / print / reprint. Read-only. */
export function openDriverCollectionPrint(
  data: DriverCollectionPrintData,
  labels: DriverCollectionPrintLabels,
): void {
  const printWindow = window.open("", "_blank", "noopener,noreferrer");
  if (printWindow === null) return;
  printWindow.document.write(buildDriverCollectionPrintDocument(data, labels));
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}
