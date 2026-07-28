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
  readonly customerAddress: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  readonly customerSecondMobileNumber: string | null;
  readonly deliveryInstructions: string | null;
  readonly deliveryStatus: string;
  readonly deliveryStatusLabel: string;
  readonly emirateName: string | null;
  readonly notes: string | null;
  readonly packageCount: number;
  readonly referenceNumber: string | null;
  readonly serialNumber: string;
  readonly traderName: string;
}

export interface ManifestData {
  readonly header: {
    readonly company: {
      readonly hasLogo: boolean;
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
    readonly totalPackages: number;
  };
}

interface Labels {
  readonly address: string;
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
  readonly outForDelivery: string;
  readonly packages: string;
  readonly receivedBy: string;
  readonly returned: string;
  readonly reportDate: string;
  readonly secondMobile: string;
  readonly title: string;
  readonly totalCod: string;
  readonly totalOrders: string;
  readonly totalPackages: string;
  readonly trader: string;
}

const LABELS: Record<ReportLanguage, Labels> = {
  ar: {
    address: "عنوان العميل",
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
    outForDelivery: "خرج للتوصيل",
    packages: "الطرود",
    receivedBy: "استلمه / أرجعه",
    returned: "مرتجع",
    reportDate: "تاريخ التقرير",
    secondMobile: "جوال إضافي",
    title: "كشف شحنات السائق",
    totalCod: "إجمالي الدفع عند الاستلام",
    totalOrders: "إجمالي الطلبات",
    totalPackages: "إجمالي الطرود",
    trader: "التاجر",
  },
  en: {
    address: "Customer Address",
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
    outForDelivery: "Out for Delivery",
    packages: "Packages",
    receivedBy: "Returned/Received By",
    returned: "Returned",
    reportDate: "Report Date",
    secondMobile: "Second Mobile",
    title: "Driver Shipment Manifest",
    totalCod: "Total COD",
    totalOrders: "Total Orders",
    totalPackages: "Total Packages",
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

function driverTypeLabel(labels: Labels, type: "employee" | "outsourced"): string {
  return type === "employee" ? labels.driverTypeEmployee : labels.driverTypeOutsourced;
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
      (order, index) =>
        "<tr>" +
        `<td class="num">${index + 1}</td>` +
        `<td class="mono">${escapeHtml(order.serialNumber)}</td>` +
        `<td class="mono">${order.referenceNumber === null ? "" : escapeHtml(order.referenceNumber)}</td>` +
        `<td>${escapeHtml(order.traderName)}</td>` +
        `<td>${escapeHtml(order.customerName)}</td>` +
        `<td class="mono">${escapeHtml(order.customerMobileNumber)}</td>` +
        `<td class="mono">${order.customerSecondMobileNumber === null ? "" : escapeHtml(order.customerSecondMobileNumber)}</td>` +
        `<td>${order.emirateName === null ? "" : escapeHtml(order.emirateName)}</td>` +
        `<td>${escapeHtml(order.areaName)}</td>` +
        `<td>${escapeHtml(order.customerAddress)}</td>` +
        `<td class="num">${money(order.codAmount)}</td>` +
        `<td class="num">${order.packageCount}</td>` +
        `<td>${order.deliveryInstructions === null ? "" : escapeHtml(order.deliveryInstructions)}</td>` +
        `<td>${order.notes === null ? "" : escapeHtml(order.notes)}</td>` +
        `<td>${escapeHtml(order.deliveryStatusLabel)}</td>` +
        "</tr>",
    )
    .join("");
  const orderTable =
    `<table class="grid"><thead><tr>` +
    [
      labels.lineNumber,
      labels.orderSerial,
      labels.externalReference,
      labels.trader,
      labels.customer,
      labels.mobile,
      labels.secondMobile,
      labels.emirate,
      labels.area,
      labels.address,
      labels.cod,
      labels.packages,
      labels.deliveryInstructions,
      labels.notes,
      labels.deliveryStatus,
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
    (data.header.company.hasLogo ? `<div class="logo-placeholder"></div>` : "") +
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
    headerMeta(labels.manifestNumber, data.header.manifestNumber) +
    headerMeta(labels.reportDate, generatedAt) +
    headerMeta(labels.driver, data.header.driverName) +
    headerMeta(labels.driverMobile, data.header.driverMobile) +
    headerMeta(labels.driverType, driverTypeLabel(labels, data.header.driverType)) +
    headerMeta(labels.numberOfOrders, String(data.header.orderCount)) +
    headerMeta(labels.generatedBy, data.header.generatedBy) +
    headerMeta(labels.generatedAt, generatedAt) +
    `</div>` +
    `</header>`;

  const summaryLine = (label: string, value: string) =>
    `<div class="summary-line"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
  const summary =
    `<section class="summary-section">` +
    `<h2 class="section-title">${escapeHtml(labels.numberOfOrders)}</h2>` +
    summaryLine(labels.totalOrders, String(data.summary.totalOrders)) +
    summaryLine(labels.totalCod, money(data.summary.totalCod)) +
    summaryLine(labels.totalPackages, String(data.summary.totalPackages)) +
    summaryLine(labels.newStatus, String(data.summary.countNew)) +
    summaryLine(labels.driver, String(data.summary.countAssignedToDriver)) +
    summaryLine(labels.outForDelivery, String(data.summary.countOutForDelivery)) +
    summaryLine(labels.delivered, String(data.summary.countDelivered)) +
    summaryLine(labels.returned, String(data.summary.countReturned)) +
    summaryLine(labels.cancelled, String(data.summary.countCancelled)) +
    `</section>`;

  const signatures =
    `<div class="signatures">` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.driverSignature)}</span></div>` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.operationsHandover)}</span></div>` +
    `<div class="sign-box"><div class="sign-line"></div><span>${escapeHtml(labels.receivedBy)}</span></div>` +
    `</div>`;

  const style = `
    @page { size: A4 landscape; margin: 12mm 10mm 16mm; }
    * { box-sizing: border-box; }
    body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; color: #111; margin: 0; font-size: 10px; }
    .report-header { border-bottom: 2px solid #333; margin-bottom: 10px; padding-bottom: 8px; }
    .company-block { display: flex; align-items: center; gap: 10px; }
    .logo-placeholder { width: 40px; height: 40px; border: 1px solid #ccc; border-radius: 4px; }
    .company-name { font-size: 16px; font-weight: 800; }
    .company-subtitle, .company-telephone { font-size: 11px; color: #444; }
    .report-title { font-size: 18px; margin: 8px 0 6px; }
    .meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px 16px; font-size: 11px; }
    .meta-item { display: flex; justify-content: space-between; border-bottom: 1px dotted #ccc; padding: 2px 0; }
    .meta-label { color: #555; }
    .meta-value { font-weight: 600; }
    .section-title { font-size: 13px; margin: 14px 0 6px; }
    table.grid { width: 100%; border-collapse: collapse; font-size: 9px; margin-bottom: 10px; }
    table.grid th, table.grid td { border: 1px solid #999; padding: 3px 4px; text-align: start; }
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
    `<title>${escapeHtml(labels.title)} ${escapeHtml(data.header.manifestNumber)}</title>` +
    `<style>${style}</style></head><body>` +
    header +
    orderTable +
    summary +
    signatures +
    `</body></html>`
  );
}
