import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
// Imported as a value, not a type: `emitDecoratorMetadata` can only record a
// DTO class for the global ValidationPipe when the symbol survives to runtime,
// so this query contract is actually validated.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PaymentPositionQueryDto } from "./payment-position.dto.js";
import { paymentPositionCsv } from "./payment-position-csv.js";
import { safeAccountingFilename } from "./accounting-report-html.js";
import { PaymentPositionService } from "./payment-position.service.js";

/**
 * Read-only. Two GETs, no mutation and no write path of any kind.
 *
 * Its own route prefix rather than a `kind` under the accounting reports
 * controller, which ends in a catch-all `@Get(":kind")` that would swallow it.
 */
@ApiTags("accounting-reports")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/reports/payment-position")
export class PaymentPositionController {
  public constructor(
    @Inject(PaymentPositionService) private readonly positions: PaymentPositionService,
  ) {}

  /** One row per party and direction, with grand totals and metadata. */
  @Get()
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public summary(@Query() query: PaymentPositionQueryDto) {
    return this.positions.summary(query);
  }

  /** The individual obligations behind those positions. */
  @Get("transactions")
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public transactions(@Query() query: PaymentPositionQueryDto) {
    return this.positions.transactions(query);
  }

  /**
   * The same position as CSV.
   *
   * Built entirely server-side from the same service reads the screen makes,
   * so the export cannot drift from what was displayed and the browser never
   * holds the full row set.
   */
  @Get("export")
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public async export(
    @Query() query: PaymentPositionQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const language = query.language ?? "en";
    const data = await this.positions.exportData(query);
    const body = paymentPositionCsv({
      filters: {
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        direction: query.direction,
        outstandingOnly: query.outstandingOnly,
        overdueOnly: query.overdueOnly,
        partyId: query.partyId,
        partyType: query.partyType,
      },
      language,
      metadata: data.metadata,
      parties: data.parties,
      sort: `${query.sortBy ?? "outstandingAmount"} ${query.sortDirection ?? "desc"}`,
      totals: data.totals,
      transactions: data.transactions,
      truncated: data.truncated,
    });
    const name = safeAccountingFilename(`payment-position-${language}.csv`);
    response
      .setHeader("Content-Type", "text/csv; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename="${name}"`)
      .send(body);
  }
}
