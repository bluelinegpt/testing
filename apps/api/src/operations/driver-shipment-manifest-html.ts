import type { ReportLanguage } from "./driver-collection-report-html.js";

/**
 * Pure HTML document builder for the Driver Shipment Manifest (§6-§10). A
 * separate, independent document from the Driver Collection Report: this one
 * describes shipments to be delivered, never financial reconciliation, and
 * never requires the selected Orders to be reconciled. Rendered to a real PDF
 * file server-side by `driver-collection-pdf.service.ts` (the same headless
 * Chromium renderer, reused rather than a second PDF system) — this HTML
 * never runs in a User's browser.
 */

export interface ManifestOrder {
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  readonly customerSecondMobileNumber: string | null;
  readonly deliveryInstructions: string | null;
  readonly deliveryStatus: string;
  readonly deliveryStatusLabel: string;
  readonly emirateName: string | null;
  readonly notes: string | null;
  readonly orderNumber: string;
  readonly referenceNumber: string | null;
  readonly serialNumber: string;
  readonly serviceFee: string;
  readonly traderName: string;
}

export interface ManifestData {
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
    readonly driverMobile: string;
    readonly driverName: string;
    readonly driverType: "employee" | "outsourced";
    readonly generatedBy: string;
    readonly manifestNumber: string;
    readonly orderCount: number;
  };
  readonly orders: readonly ManifestOrder[];
  readonly summary: {
    readonly countAssignedToDriver: number;
    readonly countCancelled: number;
    readonly countDelivered: number;
    readonly countNew: number;
    readonly countOutForDelivery: number;
    readonly countReturned: number;
    readonly totalCod: string;
    readonly totalOrders: number;
  };
}

interface Labels {
  readonly area: string;
  readonly cancelled: string;
  readonly cod: string;
  readonly customer: string;
  readonly delivered: string;
  readonly deliveryInstructions: string;
  readonly deliveryStatus: string;
  readonly driver: string;
  readonly driverMobile: string;
  readonly driverSignature: string;
  readonly driverType: string;
  readonly driverTypeEmployee: string;
  readonly driverTypeOutsourced: string;
  readonly emirate: string;
  readonly externalReference: string;
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly lineNumber: string;
  readonly manifestNumber: string;
  readonly mobile: string;
  readonly newStatus: string;
  readonly notes: string;
  readonly numberOfOrders: string;
  readonly operationsHandover: string;
  readonly orderSerial: string;
  readonly orderNumber: string;
  readonly outForDelivery: string;
  readonly receivedBy: string;
  readonly returned: string;
  readonly reportDate: string;
  readonly secondMobile: string;
  readonly serviceFee: string;
  readonly title: string;
  readonly totalCod: string;
  readonly totalOrders: string;
  readonly trader: string;
}

const LABELS: Record<ReportLanguage, Labels> = {
  ar: {
    area: "المنطقة",
    cancelled: "ملغى",
    cod: "الدفع عند الاستلام",
    customer: "العميل",
    delivered: "تم التسليم",
    deliveryInstructions: "تعليمات التوصيل",
    deliveryStatus: "حالة التوصيل",
    driver: "السائق",
    driverMobile: "جوال السائق",
    driverSignature: "توقيع السائق",
    driverType: "نوع السائق",
    driverTypeEmployee: "موظف",
    driverTypeOutsourced: "متعاقد خارجي",
    emirate: "الإمارة",
    externalReference: "الرقم المرجعي الخارجي",
    generatedAt: "تاريخ ووقت الإنشاء",
    generatedBy: "أنشأه",
    lineNumber: "#",
    manifestNumber: "رقم الكشف",
    mobile: "جوال العميل",
    newStatus: "جديد",
    notes: "ملاحظات",
    numberOfOrders: "عدد الطلبات",
    operationsHandover: "تسليم العمليات",
    orderSerial: "الرقم التسلسلي للطلب",
    orderNumber: "رقم الطلب",
    outForDelivery: "خرج للتوصيل",
    receivedBy: "استلمه / أرجعه",
    returned: "مرتجع",
    reportDate: "تاريخ التقرير",
    secondMobile: "جوال إضافي",
    serviceFee: "رسوم الخدمة",
    title: "كشف شحنات السائق",
    totalCod: "إجمالي الدفع عند الاستلام",
    totalOrders: "إجمالي الطلبات",
    trader: "التاجر",
  },
  en: {
    area: "Area",
    cancelled: "Cancelled",
    cod: "COD Amount",
    customer: "Customer",
    delivered: "Delivered",
    deliveryInstructions: "Delivery Instructions",
    deliveryStatus: "Delivery Status",
    driver: "Driver",
    driverMobile: "Driver Mobile",
    driverSignature: "Driver",
    driverType: "Driver Type",
    driverTypeEmployee: "Employee",
    driverTypeOutsourced: "Outsourced",
    emirate: "Emirate",
    externalReference: "External Reference Number",
    generatedAt: "Generated Date and Time",
    generatedBy: "Generated By",
    lineNumber: "#",
    manifestNumber: "Manifest Number",
    mobile: "Customer Mobile",
    newStatus: "New",
    notes: "Notes",
    numberOfOrders: "Number of Orders",
    operationsHandover: "Operations Handover",
    orderSerial: "Order Serial Number",
    orderNumber: "Order Number",
    outForDelivery: "Out for Delivery",
    receivedBy: "Returned/Received By",
    returned: "Returned",
    reportDate: "Report Date",
    secondMobile: "Second Mobile",
    serviceFee: "Service Fee",
    title: "Driver Shipment Manifest",
    totalCod: "Total COD",
    totalOrders: "Total Orders",
    trader: "Trader",
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

/**
 * Pure: builds the full manifest HTML document. Never calls any API and never
 * mutates Order data — a failure here can only throw before any PDF bytes are
 * produced, so it can never corrupt the Orders it describes.
 */
export function buildDriverShipmentManifestHtml(
  data: ManifestData,
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
        `<td>${escapeHtml(order.traderName)}</td>` +
        `<td>${escapeHtml(order.customerName)}</td>` +
        `<td class="mono">${escapeHtml(order.customerMobileNumber)}</td>` +
        `<td>${escapeHtml(order.areaName)}</td>` +
        `<td class="num">${money(order.codAmount)}</td>` +
        /* Notes, not Delivery Status. A manifest is signed at handover, when
           every Order on it is going out, so the status column read the same on
           every line. A free-text note is what the Driver actually needs in
           front of them. */
        `<td>${order.notes === null ? "" : escapeHtml(order.notes)}</td>` +
        "</tr>",
    )
    .join("");
  const orderTable =
    `<table class="grid"><thead><tr>` +
    [
      labels.orderSerial,
      labels.externalReference,
      labels.trader,
      labels.customer,
      labels.mobile,
      labels.area,
      labels.cod,
      labels.notes,
    ]
      .map((label) => `<th>${escapeHtml(label)}</th>`)
      .join("") +
    `</tr></thead><tbody>${orderRows}</tbody></table>`;

  const headerMeta = (label: string, value: string) =>
    `<div class="meta-item"><span class="meta-label">${escapeHtml(label)}</span>` +
    `<span class="meta-value">${escapeHtml(value)}</span></div>`;

  const header =
    `<header class="report-header">` +
    `<div class="company-block">` +
    (data.header.company.logoDataUri == null
      ? ""
      : `<img class="company-logo" alt="" src="${escapeHtml(data.header.company.logoDataUri)}">`) +
    `<div class="company-identity">` +
    `<div class="company-name">${escapeHtml(data.header.company.nameEn)}` +
    (data.header.company.nameAr === null ? "" : ` / ${escapeHtml(data.header.company.nameAr)}`) +
    `</div>` +
    (data.header.company.subtitleEn === null && data.header.company.subtitleAr === null
      ? ""
      : `<div class="company-subtitle">${escapeHtml(
          language === "ar"
            ? (data.header.company.subtitleAr ?? data.header.company.subtitleEn ?? "")
            : (data.header.company.subtitleEn ?? data.header.company.subtitleAr ?? ""),
        )}</div>`) +
    (data.header.company.telephone === null
      ? ""
      : `<div class="company-telephone">${escapeHtml(data.header.company.telephone)}</div>`) +
    `</div></div>` +
    `<h1 class="report-title">${escapeHtml(labels.title)}</h1>` +
    `<div class="meta-grid">` +
    headerMeta(labels.reportDate, generatedAt) +
    headerMeta(labels.driver, data.header.driverName) +
    `</div>` +
    `</header>`;

  const summaryLine = (label: string, value: string) =>
    `<div class="summary-line"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
  /* Two figures only, side by side. The per-status breakdown (Packages, New,
     Out for Delivery, Delivered, Returned, Cancelled) was removed: a manifest is
     handed over at dispatch, when every Order on it is going out, so those
     counts were either all zero or restated the Delivery Status column. */
  const summary =
    `<section class="summary-section">` +
    `<h2 class="section-title">${escapeHtml(labels.numberOfOrders)}</h2>` +
    `<div class="summary-row">` +
    summaryLine(labels.totalOrders, String(data.summary.totalOrders)) +
    summaryLine(labels.totalCod, money(data.summary.totalCod)) +
    `</div>` +
    `</section>`;

  const signatures =
    `<div class="signatures">` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.driverSignature)}</span></div>` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.operationsHandover)}</span></div>` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.receivedBy)}</span></div>` +
    `</div>`;

  const style = `
    @page { size: A4 portrait; margin: 10mm 7mm 14mm; }
    * { box-sizing: border-box; }
    body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; color: #111; margin: 0; font-size: 9px; }
    .report-header { border-bottom: 2px solid #333; margin-bottom: 10px; padding-bottom: 8px; }
    .company-block { display: flex; align-items: center; gap: 10px; }
    .company-logo { width: 44px; height: 44px; object-fit: contain; }
    .company-name { font-size: 14px; font-weight: 800; }
    .company-subtitle, .company-telephone { font-size: 9px; color: #444; }
    .report-title { font-size: 16px; margin: 6px 0 5px; }
    .meta-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 3px 18px; font-size: 8.5px; }
    .meta-item { display: flex; justify-content: space-between; border-bottom: 1px dotted #ccc; padding: 2px 0; }
    .meta-label { color: #555; }
    .meta-value { font-weight: 600; }
    .section-title { font-size: 13px; margin: 14px 0 6px; }
    table.grid { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 12px; margin-bottom: 8px; }
    table.grid th, table.grid td { border: 1px solid #999; padding: 4px; text-align: start; overflow-wrap: anywhere; line-height: 1.25; }
    table.grid thead { display: table-header-group; }
    table.grid thead th { background: #f0f0f0; }
    table.grid td.num, table.grid th.num { text-align: end; white-space: nowrap; }
    .mono { font-variant-numeric: tabular-nums; }
     /* Every approved manifest column is explicitly sized. The percentages
        total 100 so PDF pagination cannot assign an unpredictable remainder. */
    table.grid th:nth-child(1), table.grid td:nth-child(1) { width: 7%; }
    table.grid th:nth-child(2), table.grid td:nth-child(2) { width: 10%; }
    table.grid th:nth-child(3), table.grid td:nth-child(3) { width: 18%; }
    table.grid th:nth-child(4), table.grid td:nth-child(4) { width: 10%; }
    table.grid th:nth-child(5), table.grid td:nth-child(5) { width: 12%; }
    table.grid th:nth-child(6), table.grid td:nth-child(6) { width: 8%; }
    table.grid th:nth-child(7), table.grid td:nth-child(7) { width: 10%; }
    table.grid th:nth-child(8), table.grid td:nth-child(8) { width: 25%; }
    .summary-section { margin-top: 12px; max-width: 460px; }
    /* Side by side rather than stacked. Each keeps its own underline so the
       label still reads as attached to its own figure. */
    .summary-row { display: flex; gap: 24px; }
    .summary-line { flex: 1; display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid #ddd; padding: 3px 0; font-size: 10px; }
    .signatures { display: flex; justify-content: space-between; gap: 18px; margin-top: 32px; }
    .sign-box { flex: 1; text-align: center; font-size: 9px; }
    .sign-line { border-top: 1px solid #333; margin-bottom: 5px; height: 30px; }
    tr { break-inside: avoid; }
  `;

  return (
    `<!doctype html><html dir="${dir}" lang="${language}"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(labels.title)} ${escapeHtml(data.header.manifestNumber)}</title>` +
    `<style>${style}</style></head><body>` +
    header +
    orderTable +
    summary +
    signatures +
    `</body></html>`
  );
}
