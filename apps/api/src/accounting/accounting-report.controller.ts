import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
// Imported as values, not types: `emitDecoratorMetadata` can only record a
// DTO class for the global ValidationPipe when the symbol survives to runtime,
// so these query contracts are actually validated.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AccountingDocumentQueryDto,
  AccountingReportExportQueryDto,
  AccountingReportQueryDto,
} from "./accounting-report.dto.js";
import { accountingReportKinds, type AccountingReportKind } from "./accounting-report.dto.js";
import { AccountingReportExportService } from "./accounting-report-export.service.js";
import { safeAccountingFilename } from "./accounting-report-html.js";
import { AccountingReportService } from "./accounting-report.service.js";

@ApiTags("accounting-reports")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/accounting/reports")
export class AccountingReportController {
  public constructor(
    @Inject(AccountingReportService) private readonly reports: AccountingReportService,
    @Inject(AccountingReportExportService) private readonly exports: AccountingReportExportService,
  ) {}

  @Get("readiness")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public readiness() {
    return this.reports.readiness();
  }

  @Get("documents/journals/:id/pdf")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public journalPdf(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: AccountingDocumentQueryDto,
    @Res() response: Response,
  ) {
    return this.sendDocument("journal", id, query, response);
  }

  @Get("documents/opening-balances/:id/pdf")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public openingPdf(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: AccountingDocumentQueryDto,
    @Res() response: Response,
  ) {
    return this.sendDocument("opening-balance", id, query, response);
  }

  @Get("documents/expenses/:id/pdf")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public expensePdf(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: AccountingDocumentQueryDto,
    @Res() response: Response,
  ) {
    return this.sendDocument("expense", id, query, response);
  }

  @Get("documents/expense-payments/:id/pdf")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public paymentPdf(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: AccountingDocumentQueryDto,
    @Res() response: Response,
  ) {
    return this.sendDocument("expense-payment", id, query, response);
  }

  @Get("documents/cash-bank-movements/:id/pdf")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public movementPdf(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: AccountingDocumentQueryDto,
    @Res() response: Response,
  ) {
    return this.sendDocument("cash-bank-movement", id, query, response);
  }

  @Get(":kind/export")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public async export(
    @Param("kind") value: string,
    @Query() query: AccountingReportExportQueryDto,
    @Res() response: Response,
  ) {
    const kind = this.kind(value);
    const output = await this.exports.tabular(kind, query, query.format);
    const filename = safeAccountingFilename(
      `${kind}-${output.report.snapshotAt.slice(0, 10)}.${output.extension}`,
    );
    response.setHeader("Content-Type", output.contentType);
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    response.setHeader("X-Report-Snapshot", output.report.snapshotAt);
    if (output.report.truncated) response.setHeader("X-Report-Truncated", "true");
    response.send(output.body);
  }

  @Get(":kind/pdf")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public async pdf(
    @Param("kind") value: string,
    @Query() query: AccountingReportQueryDto,
    @Res() response: Response,
  ) {
    const kind = this.kind(value);
    const output = await this.exports.reportPdf(kind, query);
    const filename = safeAccountingFilename(`${kind}-${output.report.snapshotAt.slice(0, 10)}.pdf`);
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    response.setHeader("X-Report-Snapshot", output.report.snapshotAt);
    if (output.report.truncated) response.setHeader("X-Report-Truncated", "true");
    response.send(output.body);
  }

  @Get(":kind")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public report(@Param("kind") value: string, @Query() query: AccountingReportQueryDto) {
    return this.reports.report(this.kind(value), query);
  }

  private kind(value: string): AccountingReportKind {
    if (!accountingReportKinds.includes(value as AccountingReportKind)) {
      throw new ApplicationException(
        "accounting_report_not_found",
        "The requested Accounting report is not available",
        HttpStatus.NOT_FOUND,
      );
    }
    return value as AccountingReportKind;
  }

  private async sendDocument(
    type: "journal" | "opening-balance" | "expense" | "expense-payment" | "cash-bank-movement",
    id: string,
    query: AccountingDocumentQueryDto,
    response: Response,
  ) {
    const document = await this.exports.documentPdf(type, id, query.language ?? "en");
    const disposition = query.disposition === "attachment" ? "attachment" : "inline";
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${safeAccountingFilename(`${type}-${document.reference}.pdf`)}"`,
    );
    response.send(document.body);
  }
}
