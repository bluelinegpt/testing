import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { RequireAnyPermission, RequireIdentityKinds } from "../authentication/authentication.decorators.js";
import type {
  DailyOperationsSummaryExportQueryDto,
  DailyOperationsSummaryOrdersQueryDto,
  DailyOperationsSummaryQueryDto,
  DailyOperationsSummaryTodayQueryDto,
} from "./daily-operations-summary.dto.js";
import { DailyOperationsSummaryService } from "./daily-operations-summary.service.js";

/**
 * Daily Operations Summary — read-only management report.
 *
 * Office-only, matching the same gate the existing `/reports` route already
 * uses (`reports.financial.view` for viewing, `reports.export` for PDF/
 * Excel, `users_roles.manage` as the administrator override). A Driver
 * self-service User's Role never holds either permission (see the audit in
 * the report), so this Company-wide report is never reachable from there.
 */
@RequireIdentityKinds("company_user")
@ApiTags("operations")
@Controller("operations/reports/daily-operations-summary")
export class DailyOperationsSummaryController {
  public constructor(
    @Inject(DailyOperationsSummaryService)
    private readonly summary: DailyOperationsSummaryService,
  ) {}

  @RequireAnyPermission("reports.financial.view", "reports.export", "users_roles.manage")
  @ApiOperation({ summary: "Daily Operations Summary — driver delivery, expenses, net result" })
  @Get()
  public report(@Query() query: DailyOperationsSummaryQueryDto) {
    return this.summary.report(query);
  }

  /**
   * "Today" in the requested Date Mode -- what the Today/Yesterday/This
   * Week/This Month quick filters resolve against instead of the viewer's
   * own local calendar date, which drifts from the Company's date for as
   * long as the Business Day cutoff has not yet passed (see §2, §6).
   */
  @RequireAnyPermission("reports.financial.view", "reports.export", "users_roles.manage")
  @ApiOperation({ summary: "Daily Operations Summary — current date in the requested Date Mode" })
  @Get("today")
  public async today(
    @Query() query: DailyOperationsSummaryTodayQueryDto,
  ): Promise<{ date: string }> {
    return { date: await this.summary.currentDate(query.dateMode) };
  }

  /**
   * The Orders behind one Driver's row -- opened from "View Orders" in the
   * Driver Delivery Summary.
   */
  @RequireAnyPermission("reports.financial.view", "reports.export", "users_roles.manage")
  @ApiOperation({ summary: "Daily Operations Summary — one Driver's contributing Orders" })
  @Get("orders")
  public orders(@Query() query: DailyOperationsSummaryOrdersQueryDto) {
    return this.summary.driverOrders(query);
  }

  @RequireAnyPermission("reports.export", "users_roles.manage")
  @ApiOperation({ summary: "Daily Operations Summary — downloadable PDF" })
  @Get("pdf")
  public async pdf(
    @Query() query: DailyOperationsSummaryExportQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const language = query.language === "ar" ? "ar" : "en";
    const { bytes, filename } = await this.summary.pdf(query, language);
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    response.send(bytes);
  }

  @RequireAnyPermission("reports.export", "users_roles.manage")
  @ApiOperation({ summary: "Daily Operations Summary — downloadable Excel workbook" })
  @Get("excel")
  public async excel(
    @Query() query: DailyOperationsSummaryQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const { bytes, filename } = await this.summary.excel(query);
    response.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    response.send(bytes);
  }
}
