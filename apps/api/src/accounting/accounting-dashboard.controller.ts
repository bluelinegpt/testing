import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import { AccountingDashboardService } from "./accounting-dashboard.service.js";
// Imported as a value, not a type: `emitDecoratorMetadata` can only record a
// DTO class for the global ValidationPipe when the symbol survives to runtime,
// so the query contract is actually validated rather than accepted unchecked.
import { AccountingDashboardQueryDto } from "./accounting-dashboard.dto.js";

/**
 * Read-only Accounting Dashboard.
 *
 * One GET, no mutation and no write path of any kind. Its own route prefix
 * rather than a `kind` under the accounting reports controller, which ends in a
 * catch-all `@Get(":kind")` that would swallow it.
 */
@ApiTags("accounting-reports")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/reports/accounting-dashboard")
export class AccountingDashboardController {
  public constructor(
    @Inject(AccountingDashboardService) private readonly dashboard: AccountingDashboardService,
  ) {}

  /** Five sections, the applied filters, the Company timezone and metadata. */
  @Get()
  @RequireAnyPermission("accounting.view", "accounting.manage")
  public summary(@Query() query: AccountingDashboardQueryDto) {
    return this.dashboard.summary(query);
  }
}
