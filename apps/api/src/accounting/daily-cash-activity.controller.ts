import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import type {
  DailyCashActivityExportQueryDto,
  DailyCashActivityQueryDto,
  DailyCashActivityRowsQueryDto,
} from "./daily-cash-activity.dto.js";
import { dailyCashActivityCsv } from "./daily-cash-activity-csv.js";
import { safeAccountingFilename } from "./accounting-report-html.js";
import { DailyCashActivityService } from "./daily-cash-activity.service.js";

/**
 * Read-only. Two GETs, no mutation of any kind.
 *
 * Its own path rather than a `kind` under the existing accounting reports
 * controller: that controller ends in a catch-all `@Get(":kind")`, and adding a
 * route there would depend on declaration order to avoid being swallowed.
 */
@ApiTags("accounting-reports")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/reports/daily-cash-activity")
export class DailyCashActivityController {
  public constructor(
    @Inject(DailyCashActivityService) private readonly reports: DailyCashActivityService,
  ) {}

  /** Cash Activity and Income Statement Activity, plus the window metadata. */
  @Get()
  @RequireAnyPermission("accounting.view", "accounting.manage")
  public report(@Query() query: DailyCashActivityQueryDto) {
    return this.reports.report(query);
  }

  /** The individual movements behind the Cash Activity totals. */
  @Get("rows")
  @RequireAnyPermission("accounting.view", "accounting.manage")
  public rows(@Query() query: DailyCashActivityRowsQueryDto) {
    return this.reports.rows(query);
  }

  /**
   * The same report as CSV.
   *
   * Generated entirely server-side from the same service calls the screen
   * makes, so the export cannot drift from what was on screen and the browser
   * never holds the full row set.
   */
  @Get("export")
  @RequireAnyPermission("accounting.view", "accounting.manage")
  public async export(
    @Query() query: DailyCashActivityExportQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const language = query.language ?? "en";
    const [report, rows] = await Promise.all([
      this.reports.report(query),
      this.reports.exportRows(query),
    ]);
    const body = dailyCashActivityCsv({
      filters: {
        accountId: query.accountId,
        businessDate: query.businessDate,
        partyId: query.partyId,
        partyType: query.partyType,
        paymentMethod: query.paymentMethod,
      },
      language,
      report,
      rows: rows.items,
      truncated: rows.truncated,
    });
    const name = safeAccountingFilename(
      `daily-cash-activity-${query.businessDate}-${language}.csv`,
    );
    response
      .setHeader("Content-Type", "text/csv; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename="${name}"`)
      .send(body);
  }
}
