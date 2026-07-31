import { Inject, Injectable } from "@nestjs/common";

import { CompanyProfileService } from "../company-profile/company-profile.service.js";
import { DriverCollectionPdfService } from "../operations/driver-collection-pdf.service.js";
import type {
  AccountingReportKind,
  AccountingReportQueryDto,
} from "./accounting-report.dto.js";
import {
  accountingReportHtml,
  type AccountingReportDocument,
} from "./accounting-report-html.js";
import {
  AccountingReportService,
  type AccountingReportEnvelope,
} from "./accounting-report.service.js";
import { accountingXlsx } from "./accounting-xlsx.js";

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

const arTitles: Readonly<Record<string, string>> = {
  "account-statement": "كشف حساب",
  "balance-sheet": "الميزانية العمومية",
  "cash-movement": "حركة النقد",
  "general-expenses": "تقرير المصروفات العامة",
  "general-ledger": "دفتر الأستاذ العام",
  "profit-and-loss": "قائمة الأرباح والخسائر",
  "trial-balance": "ميزان المراجعة",
  vat: "أساس تقرير ضريبة القيمة المضافة",
};
const arColumns: Readonly<Record<string, string>> = {
  accountClass: "فئة الحساب", accountNameAr: "الاسم بالعربية", accountNameEn: "اسم الحساب",
  accountType: "نوع الحساب", accountingDate: "التاريخ المحاسبي", amount: "المبلغ",
  categoryCode: "رمز الفئة", categoryNameAr: "الفئة بالعربية", categoryNameEn: "الفئة",
  closingBalance: "الرصيد الختامي", closingCredit: "دائن ختامي", closingDebit: "مدين ختامي",
  code: "رمز الحساب", credit: "دائن", date: "التاريخ", debit: "مدين",
  description: "الوصف", direction: "الاتجاه", expenseDate: "تاريخ المصروف",
  expenseNumber: "رقم المصروف", journalNumber: "رقم القيد", netVat: "صافي الضريبة",
  openingBalance: "الرصيد الافتتاحي", openingCredit: "دائن افتتاحي", openingDebit: "مدين افتتاحي",
  operationalApproved: "المعتمد تشغيلياً", operationalOutstanding: "المتبقي تشغيلياً",
  operationalPaid: "المدفوع تشغيلياً", payee: "المستفيد", paymentStatus: "حالة الدفع",
  periodCredit: "دائن الفترة", periodDebit: "مدين الفترة", postedNet: "الصافي المُرحّل",
  recoverableVat: "الضريبة القابلة للاسترداد", reference: "المرجع",
  runningBalance: "الرصيد الجاري", section: "القسم", source: "المصدر", status: "الحالة",
};
const arWarnings: Readonly<Record<string, string>> = {
  accounting_report_bank_reconciliation_unavailable: "لا تتوفر مطابقة كاملة مع كشف البنك؛ لا يعرض التقرير حالة المقاصة البنكية.",
  accounting_report_open_period_provisional: "يتضمن التقرير فترة مفتوحة أو معاد فتحها، ولذلك تُعد نتائجه مؤقتة.",
  accounting_report_query_limit_exceeded: "بلغ التقرير حد الصفوف. ضيّق المعايير لتضمين جميع الصفوف.",
  accounting_report_reconciliation_difference_possible: "تظهر القيم التشغيلية بجانب القيود المُرحّلة وتبقى أي فروقات ظاهرة للمطابقة.",
  accounting_report_reconciliation_difference: "يوجد فرق في ضوابط مطابقة التقرير. لم تتم إضافة أي سطر موازن اصطناعي.",
  accounting_report_vat_not_tax_return: "هذا أساس لتقرير الضريبة فقط، وليس إقراراً أو تقديماً للهيئة الاتحادية للضرائب ولا استشارة ضريبية.",
};

function localizedTable(report: AccountingReportEnvelope, language: "en" | "ar") {
  if (language === "en") {
    return { columns: report.columns, rows: report.items, title: report.title, warnings: report.warnings };
  }
  const columns = report.columns.map((column) => arColumns[column] ?? column);
  const rows = report.items.map((row) => Object.fromEntries(report.columns.map((column, index) =>
    [columns[index]!, row[column]])));
  return {
    columns,
    rows,
    title: arTitles[report.kind] ?? report.title,
    warnings: report.warningCodes.map((code) => arWarnings[code]).filter((value): value is string => value !== undefined),
  };
}

@Injectable()
export class AccountingReportExportService {
  public constructor(
    @Inject(AccountingReportService) private readonly reports: AccountingReportService,
    @Inject(CompanyProfileService) private readonly profiles: CompanyProfileService,
    @Inject(DriverCollectionPdfService) private readonly pdf: DriverCollectionPdfService,
  ) {}

  public async tabular(kind: AccountingReportKind, query: AccountingReportQueryDto, format: "csv" | "xlsx") {
    const report = await this.reports.report(kind, query, "export");
    const table = localizedTable(report, query.language ?? "en");
    await this.reports.auditGeneration(kind, format, report.filters);
    if (format === "xlsx") {
      return {
        body: accountingXlsx(table.columns, table.rows, [
          [query.language === "ar" ? "التقرير" : "Report", table.title],
          ["Currency", report.currency],
          ["Snapshot", report.snapshotAt],
          ["Data Source", report.dataSource],
          ...Object.entries(report.filters).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ...table.warnings.map((warning) => [query.language === "ar" ? "تنبيه" : "Warning", warning] as const),
        ]),
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        extension: "xlsx",
        report,
      };
    }
    const metadata = [
      [query.language === "ar" ? "التقرير" : "Report", table.title],
      ["Currency", report.currency],
      ["Snapshot", report.snapshotAt],
      ["Data Source", report.dataSource],
      ...Object.entries(report.filters).filter(([, value]) => value !== undefined),
    ];
    const rows = [
      ...metadata.map((row) => row.map(csvCell).join(",")),
      ...table.warnings.map((warning) => [csvCell(query.language === "ar" ? "تنبيه" : "Warning"), csvCell(warning)].join(",")),
      "",
      table.columns.map(csvCell).join(","),
      ...table.rows.map((row) => table.columns.map((column) => csvCell(row[column])).join(",")),
    ];
    return {
      body: Buffer.from(`\ufeff${rows.join("\r\n")}`, "utf8"),
      contentType: "text/csv; charset=utf-8",
      extension: "csv",
      report,
    };
  }

  public async reportPdf(kind: AccountingReportKind, query: AccountingReportQueryDto) {
    const report = await this.reports.report(kind, query, "pdf");
    const document = this.reportDocument(report, query.language ?? "en");
    const rendered = await this.render(document, query.language ?? "en");
    await this.reports.auditGeneration(kind, "pdf", report.filters);
    return { body: rendered, report };
  }

  public async documentPdf(
    type: "journal" | "opening-balance" | "expense" | "expense-payment" | "cash-bank-movement",
    id: string,
    language: "en" | "ar",
  ) {
    const data = await this.reports.document(type, id);
    const now = new Date().toISOString();
    const body = await this.render({
      ...data,
      filters: { documentId: id },
      generatedAt: now,
      snapshotAt: now,
    }, language);
    await this.reports.auditGeneration(type, "pdf", { documentId: id });
    return { body, reference: String(data.items[0]?.["Document Number"] ?? type) };
  }

  private reportDocument(report: AccountingReportEnvelope, language: "en" | "ar"): AccountingReportDocument {
    const table = localizedTable(report, language);
    return {
      columns: table.columns,
      filters: report.filters,
      generatedAt: report.generatedAt,
      rows: table.rows,
      snapshotAt: report.snapshotAt,
      title: table.title,
      warnings: table.warnings,
    };
  }

  private async render(document: AccountingReportDocument, language: "en" | "ar"): Promise<Buffer> {
    const branding = await this.profiles.branding();
    let logoDataUrl: string | undefined;
    if (branding.hasLogo) {
      const logo = await this.profiles.logoContent().catch(() => undefined);
      if (logo !== undefined) logoDataUrl = `data:${logo.mediaType};base64,${logo.bytes.toString("base64")}`;
    }
    const built = accountingReportHtml({ branding, document, language, ...(logoDataUrl === undefined ? {} : { logoDataUrl }) });
    return this.pdf.renderPdf(built.html, built.footer);
  }
}
