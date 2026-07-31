import type { CompanyBranding } from "../company-profile/company-profile.service.js";

export interface AccountingReportDocument {
  readonly columns: readonly string[];
  readonly filters: Readonly<Record<string, string | undefined>>;
  readonly generatedAt: string;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly snapshotAt: string;
  readonly title: string;
  readonly warnings: readonly string[];
}

function escape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function safeAccountingFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").slice(0, 120);
}

export function accountingReportHtml(input: {
  readonly branding: CompanyBranding;
  readonly document: AccountingReportDocument;
  readonly language: "en" | "ar";
  readonly logoDataUrl?: string;
}): { readonly footer: string; readonly html: string } {
  const ar = input.language === "ar";
  const b = input.branding;
  const company = ar ? (b.nameAr || b.nameEn) : b.nameEn;
  const subtitle = ar ? (b.subtitleAr || b.subtitleEn) : b.subtitleEn;
  const labels = ar
    ? { generated: "تاريخ الإنشاء", snapshot: "وقت اللقطة", warning: "تنبيه", page: "الصفحة" }
    : { generated: "Generated", snapshot: "Snapshot", warning: "Warning", page: "Page" };
  const filters = Object.entries(input.document.filters)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `<span><b>${escape(key)}:</b> <bdi>${escape(value)}</bdi></span>`).join("");
  const rows = input.document.rows.map((row) =>
    `<tr>${input.document.columns.map((column) =>
      `<td><bdi>${escape(row[column])}</bdi></td>`).join("")}</tr>`).join("");
  const warnings = input.document.warnings.map((warning) =>
    `<div class="warning"><b>${labels.warning}:</b> ${escape(warning)}</div>`).join("");
  const html = `<!doctype html><html lang="${input.language}" dir="${ar ? "rtl" : "ltr"}"><head>
<meta charset="utf-8"><style>
@page{size:A4;margin:14mm 12mm 18mm}*{box-sizing:border-box}body{font-family:"Arial","Noto Sans Arabic",sans-serif;color:#172033;font-size:10px}
header{display:flex;align-items:center;gap:12px;border-bottom:2px solid #3756d9;padding-bottom:8px;margin-bottom:12px}header img{max-width:72px;max-height:52px}
h1{font-size:19px;margin:0}.company{font-size:14px;font-weight:700}.subtitle{color:#596579}.meta,.filters{display:flex;gap:12px;flex-wrap:wrap;margin:7px 0}
.warning{background:#fff4d6;border:1px solid #e3b341;padding:6px;margin:4px 0}table{width:100%;border-collapse:collapse;margin-top:9px;page-break-inside:auto}
thead{display:table-header-group}tr{page-break-inside:avoid}th,td{border:1px solid #d5dbe7;padding:5px;text-align:${ar ? "right" : "left"};vertical-align:top}
th{background:#eef2ff;font-weight:700}bdi{direction:ltr;unicode-bidi:isolate}footer{display:none}
</style></head><body><header>${input.logoDataUrl === undefined ? "" : `<img src="${input.logoDataUrl}" alt="">`}
<div><div class="company">${escape(company)}</div>${subtitle === null ? "" : `<div class="subtitle">${escape(subtitle)}</div>`}<h1>${escape(input.document.title)}</h1></div></header>
<div class="meta"><span>${labels.generated}: <bdi>${escape(input.document.generatedAt)}</bdi></span><span>${labels.snapshot}: <bdi>${escape(input.document.snapshotAt)}</bdi></span>${b.telephone === null ? "" : `<span><bdi>${escape(b.telephone)}</bdi></span>`}</div>
<div class="filters">${filters}</div>${warnings}<table><thead><tr>${input.document.columns.map((column) => `<th>${escape(column)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></body></html>`;
  const footer = `<div style="width:100%;font-size:8px;color:#667085;padding:0 12mm;text-align:center"><span>${escape(company)} · ${labels.page} <span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`;
  return { footer, html };
}
