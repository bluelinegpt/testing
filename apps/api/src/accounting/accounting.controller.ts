import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import { AccountingQueryService } from "./accounting-query.service.js";

@ApiTags("accounting")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequireAnyPermission("accounting.view", "users_roles.manage")
@Controller("operations/accounting")
export class AccountingController {
  public constructor(
    @Inject(AccountingQueryService) private readonly queries: AccountingQueryService,
  ) {}

  @ApiOperation({ summary: "Read the active Company's Accounting configuration" })
  @Get("configuration")
  public configuration() {
    return this.queries.configuration();
  }

  @ApiOperation({ summary: "Read the active Company's Chart of Accounts" })
  @Get("accounts")
  public accounts(@Query("activeOnly") activeOnly?: string, @Query("search") search?: string) {
    return this.queries.accounts({
      ...(activeOnly === undefined ? {} : { activeOnly }),
      ...(search === undefined ? {} : { search }),
    });
  }

  @ApiOperation({ summary: "Read one Company-scoped Accounting Account" })
  @Get("accounts/:accountId")
  public account(@Param("accountId", new ParseUUIDPipe()) accountId: string) {
    return this.queries.account(accountId);
  }

  @ApiOperation({ summary: "Read the active Company's Fiscal Years" })
  @Get("fiscal-years")
  public fiscalYears() {
    return this.queries.fiscalYears();
  }

  @ApiOperation({ summary: "Read the active Company's Fiscal Periods" })
  @Get("fiscal-periods")
  public fiscalPeriods(@Query("fiscalYearId") fiscalYearId?: string) {
    return this.queries.fiscalPeriods(fiscalYearId);
  }

  @ApiOperation({ summary: "Read Accounting mapping readiness without enabling posting" })
  @Get("mappings/completeness")
  public mappingCompleteness(@Query("effectiveOn") effectiveOn?: string) {
    return this.queries.mappingCompleteness(effectiveOn);
  }

  @ApiOperation({ summary: "Read stable Accounting foundation constants" })
  @Get("foundation-metadata")
  public metadata() {
    return this.queries.metadata();
  }
}
