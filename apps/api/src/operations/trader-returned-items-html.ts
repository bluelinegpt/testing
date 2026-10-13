import type { ReportLanguage } from "./driver-collection-report-html.js";

/**
 * Pure HTML document builder for the Trader Returned Items report: the paper
 * that goes back to ONE Trader with their Cancelled / Returned Orders, signed
 * on handover. Same layout and renderer as the Driver Shipment Manifest
 * (`driver-shipment-manifest-html.ts`), headed by the Trader instead of the
 * Driver. Never calls any API and never mutates Order data.
 */

export interface ReturnedItemsOrder {
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  /** cancelled | returned_to_branch | returned_to_trader (closed after return included). */
  readonly returnKind: "cancelled" | "returned_to_branch" | "returned_to_trader";
  readonly orderNumber: string;
  readonly packageCount: number;
  readonly reason: string | null;
  readonly referenceNumber: string | null;
  readonly serialNumber: string;
}

export interface ReturnedItemsData {
  readonly header: {
    readonly company: {
      readonly hasLogo: boolean;
      readonly logoDataUri: string | null;
      readonly nameAr: string | null;
      readonly nameEn: string;
      readonly subtitleAr: string | null;
      readonly subtitleEn: string | null;
      readonly telephone: string | null;
    };
    readonly generatedBy: string;
    readonly orderCount: number;
    readonly reportNumber: string;
    readonly traderMobile: string | null;
    readonly traderName: string;
  };
  readonly orders: readonly ReturnedItemsOrder[];
  readonly summary: {
    readonly countCancelled: number;
    readonly countReturned: number;
    readonly totalOrders: number;
    readonly totalPackages: number;
    readonly totalValue: string;
  };
}

interface Labels {
  readonly area: string;
  readonly cancelled: string;
  readonly customer: string;
  readonly externalReference: string;
  readonly lineNumber: string;
  readonly mobile: string;
  readonly operationsHandover: string;
  readonly orderValue: string;
  readonly packages: string;
  readonly reason: string;
  readonly reportDate: string;
  readonly returnedToBranch: string;
  readonly returnedToTrader: string;
  readonly status: string;
  readonly summaryTitle: string;
  readonly title: string;
  readonly totalCancelled: string;
  readonly totalOrders: string;
  readonly totalPackages: string;
  readonly totalReturned: string;
  readonly totalValue: string;
  readonly trader: string;
  readonly traderReceived: string;
  readonly driverHandover: string;
}

const LABELS: Record<ReportLanguage, Labels> = {
  ar: {
    area: "المنطقة",
    cancelled: "ملغى",
    customer: "العميل",
    driverHandover: "المندوب",
    externalReference: "الرقم المرجعي الخارجي",
    lineNumber: "الرقم",
    mobile: "هاتف العميل",
    operationsHandover: "تسليم العمليات",
    orderValue: "قيمة الطلب",
    packages: "الطرود",
    reason: "السبب",
    reportDate: "تاريخ التقرير",
    returnedToBranch: "مرتجع للفرع",
    returnedToTrader: "مرتجع للتاجر",
    status: "الحالة",
    summaryTitle: "عدد الطلبات",
    title: "كشف المرتجعات للتاجر",
    totalCancelled: "ملغاة",
    totalOrders: "إجمالي الطلبات",
    totalPackages: "إجمالي الطرود",
    totalReturned: "مرتجعة",
    totalValue: "إجمالي قيمة الطلبات",
    trader: "التاجر",
    traderReceived: "استلمه التاجر",
  },
  en: {
    area: "Area",
    cancelled: "Cancelled",
    customer: "Customer",
    driverHandover: "Driver",
    externalReference: "External Reference Number",
    lineNumber: "No",
    mobile: "Customer Mobile",
    operationsHandover: "Operations Handover",
    orderValue: "Order Value",
    packages: "Packages",
    reason: "Reason",
    reportDate: "Report Date",
    returnedToBranch: "Returned to Branch",
    returnedToTrader: "Returned to Trader",
    status: "Status",
    summaryTitle: "Number of Orders",
    title: "Trader Returned Items",
    totalCancelled: "Cancelled",
    totalOrders: "Total Orders",
    totalPackages: "Total Packages",
    totalReturned: "Returned",
    totalValue: "Total Order Value",
    trader: "Trader",
    traderReceived: "Received by Trader",
  },
};

export function returnedItemsKindLabel(
  kind: ReturnedItemsOrder["returnKind"],
  language: ReportLanguage,
): string {
  const labels = LABELS[language];
  return kind === "cancelled"
    ? labels.cancelled
    : kind === "returned_to_branch"
      ? labels.returnedToBranch
      : labels.returnedToTrader;
}

export function returnedItemsColumns(language: ReportLanguage): readonly string[] {
  const labels = LABELS[language];
  return [
    labels.lineNumber,
    labels.externalReference,
    labels.customer,
    labels.mobile,
    labels.area,
    labels.status,
    labels.reason,
    labels.packages,
    labels.orderValue,
  ];
}

export function returnedItemsTitle(language: ReportLanguage): string {
  return LABELS[language].title;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildTraderReturnedItemsHtml(
  data: ReturnedItemsData,
  language: ReportLanguage,
  generatedAt: string,
): string {
  const labels = LABELS[language];
  const dir = language === "ar" ? "rtl" : "ltr";

  const orderRows = data.orders
    .map(
      (order) =>
        "<tr>" +
        `<td class="mono">${escapeHtml(order.serialNumber)}</td>` +
        `<td class="mono">${order.referenceNumber === null ? "" : escapeHtml(order.referenceNumber)}</td>` +
        `<td>${escapeHtml(order.customerName)}</td>` +
        `<td class="mono">${escapeHtml(order.customerMobileNumber)}</td>` +
        `<td>${escapeHtml(order.areaName)}</td>` +
        `<td>${escapeHtml(returnedItemsKindLabel(order.returnKind, language))}</td>` +
        `<td>${order.reason === null ? "" : escapeHtml(order.reason)}</td>` +
        `<td class="num">${order.packageCount}</td>` +
        `<td class="num">${escapeHtml(order.codAmount)}</td>` +
        "</tr>",
    )
    .join("");
  const orderTable =
    `<table class="grid"><thead><tr>` +
    returnedItemsColumns(language)
      .map((label) => `<th>${escapeHtml(label)}</th>`)
      .join("") +
    `</tr></thead><tbody>${orderRows}</tbody></table>`;

  const company = data.header.company;
  const header =
    `<header class="report-header">` +
    `<div class="company-block">` +
    (company.logoDataUri == null
      ? ""
      : `<img class="company-logo" alt="" src="${escapeHtml(company.logoDataUri)}">`) +
    `<div class="company-identity">` +
    `<div class="company-name">${escapeHtml(company.nameEn)}` +
    (company.nameAr === null ? "" : ` / ${escapeHtml(company.nameAr)}`) +
    `</div>` +
    (company.subtitleEn === null && company.subtitleAr === null
      ? ""
      : `<div class="company-subtitle">${escapeHtml(
          language === "ar"
            ? (company.subtitleAr ?? company.subtitleEn ?? "")
            : (company.subtitleEn ?? company.subtitleAr ?? ""),
        )}</div>`) +
    (company.telephone === null
      ? ""
      : `<div class="company-telephone">${escapeHtml(company.telephone)}</div>`) +
    `</div></div>` +
    `<h1 class="report-title">${escapeHtml(labels.title)}</h1>` +
    `<div class="header-meta">` +
    `<div class="meta-date">${escapeHtml(labels.reportDate)}: ${escapeHtml(generatedAt)}</div>` +
    `<div class="meta-party">${escapeHtml(labels.trader)}: ${escapeHtml(data.header.traderName)}` +
    (data.header.traderMobile === null || data.header.traderMobile === ""
      ? ""
      : ` <span class="meta-mobile">${escapeHtml(data.header.traderMobile)}</span>`) +
    `</div>` +
    `</div>` +
    `</header>`;

  const summaryLine = (label: string, value: string) =>
    `<div class="summary-line"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
  const summary =
    `<section class="summary-section">` +
    `<h2 class="section-title">${escapeHtml(labels.summaryTitle)}</h2>` +
    `<div class="summary-row">` +
    summaryLine(labels.totalOrders, String(data.summary.totalOrders)) +
    summaryLine(labels.totalPackages, String(data.summary.totalPackages)) +
    summaryLine(labels.totalValue, data.summary.totalValue) +
    `</div>` +
    `<div class="summary-row">` +
    summaryLine(labels.totalCancelled, String(data.summary.countCancelled)) +
    summaryLine(labels.totalReturned, String(data.summary.countReturned)) +
    `<div class="summary-line summary-spacer"></div>` +
    `</div>` +
    `</section>`;

  const signatures =
    `<div class="signatures">` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.operationsHandover)}</span></div>` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.driverHandover)}</span></div>` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.traderReceived)}</span></div>` +
    `</div>`;

  const style = `
    @page { size: A4 portrait; margin: 10mm 7mm 14mm; }
    * { box-sizing: border-box; }
    body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; color: #111; margin: 0; font-size: 9px; }
    .report-header { border-bottom: 2px solid #333; margin-bottom: 10px; padding-bottom: 8px; }
    .company-block { display: flex; align-items: center; gap: 10px; }
    .company-logo { width: 78px; height: 78px; object-fit: contain; }
    .company-name { font-size: 14px; font-weight: 800; }
    .company-subtitle, .company-telephone { font-size: 9px; color: #444; }
    .report-title { font-size: 16px; margin: 6px 0 5px; }
    .header-meta { margin-top: 4px; }
    .meta-date { font-size: 10px; color: #333; text-align: right; margin-bottom: 3px; }
    .meta-party { font-size: 15px; font-weight: 800; text-align: right; }
    .meta-mobile { font-size: 11px; font-weight: 400; color: #333; }
    .section-title { font-size: 13px; margin: 14px 0 6px; }
    table.grid { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 12px; margin-bottom: 8px; }
    table.grid th, table.grid td { border: 1px solid #999; padding: 4px; text-align: start; overflow-wrap: anywhere; line-height: 1.25; }
    table.grid thead { display: table-header-group; }
    table.grid thead th { background: #f0f0f0; }
    table.grid td.num, table.grid th.num { text-align: end; white-space: nowrap; }
    .mono { font-variant-numeric: tabular-nums; }
    table.grid th:nth-child(1), table.grid td:nth-child(1) { width: 6%; }
    table.grid th:nth-child(2), table.grid td:nth-child(2) { width: 11%; }
    table.grid th:nth-child(3), table.grid td:nth-child(3) { width: 12%; }
    table.grid th:nth-child(4), table.grid td:nth-child(4) { width: 13%; }
    table.grid th:nth-child(5), table.grid td:nth-child(5) { width: 11%; }
    table.grid th:nth-child(6), table.grid td:nth-child(6) { width: 12%; }
    table.grid th:nth-child(7), table.grid td:nth-child(7) { width: 14%; }
    table.grid th:nth-child(8), table.grid td:nth-child(8) { width: 11%; }
    table.grid th:nth-child(9), table.grid td:nth-child(9) { width: 10%; }
    .summary-section { margin-top: 12px; max-width: 620px; }
    .summary-row { display: flex; gap: 24px; }
    .summary-line { flex: 1; display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid #ddd; padding: 3px 0; font-size: 10px; }
    .summary-spacer { border-bottom: 0; }
    .signatures { display: flex; justify-content: space-between; gap: 18px; margin-top: 32px; }
    .sign-box { flex: 1; text-align: center; font-size: 9px; }
    .sign-line { border-top: 1px solid #333; margin-bottom: 5px; height: 30px; }
    tr { break-inside: avoid; }
  `;

  return (
    `<!doctype html><html dir="${dir}" lang="${language}"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(labels.title)} ${escapeHtml(data.header.reportNumber)}</title>` +
    `<style>${style}</style></head><body>` +
    header +
    orderTable +
    summary +
    signatures +
    `</body></html>`
  );
}
