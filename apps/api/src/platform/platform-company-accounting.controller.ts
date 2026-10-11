import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { CompanyAccountingModeService } from "../accounting/company-accounting-mode.service.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { correlationIdOf } from "./platform-audit.service.js";
// Runtime DTO import is required so Nest can emit validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ChangeCompanyAccountingModeDto } from "./platform-company-accounting.dto.js";
import {
  PLATFORM_COMPANIES_ACCOUNTING_MODE_MANAGE,
  PLATFORM_COMPANIES_READ,
  RequirePlatformPermissions,
} from "./platform-authorization.js";
import { PlatformTargetCompanyGuard } from "./platform-target-company.guard.js";

/**
 * Platform Administration -> Companies -> selected Company -> Accounting.
 *
 * Every route names the Company by UUID and runs behind
 * `PlatformTargetCompanyGuard`, so an unknown or malformed id is a 404 before
 * the service is reached. Reading the mode and both previews need only
 * `platform.companies.read` and are read-only (enforced by PostgreSQL inside
 * the service). Changing the mode needs the dedicated
 * `platform.companies.accounting_mode.manage`; a Company administrator can
 * never hold a `platform.` code, so this grants no Company user anything.
 */
@ApiTags("platform company accounting")
@ApiBearerAuth()
@Controller("platform/companies/:companyId/accounting-mode")
@UseGuards(PlatformTargetCompanyGuard)
export class PlatformCompanyAccountingController {
  public constructor(
    @Inject(CompanyAccountingModeService)
    private readonly accountingMode: CompanyAccountingModeService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  private actor(request: Request) {
    return {
      accountId: this.identities.current().identityId,
      correlationId: correlationIdOf(request),
    };
  }

  @ApiOperation({ summary: "Current GL Accounting mode of the selected Company" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get()
  public mode(@Param("companyId") companyId: string): Promise<object> {
    return this.accountingMode.status(companyId);
  }

  @ApiOperation({ summary: "Read-only preview of enabling GL Accounting" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("enable-preview")
  public previewEnable(@Param("companyId") companyId: string): Promise<object> {
    return this.accountingMode.previewEnable(companyId);
  }

  @ApiOperation({ summary: "Read-only preview of disabling GL Accounting" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("disable-preview")
  public previewDisable(@Param("companyId") companyId: string): Promise<object> {
    return this.accountingMode.previewDisable(companyId);
  }

  @ApiOperation({ summary: "Enable GL Accounting for the selected Company" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_ACCOUNTING_MODE_MANAGE)
  @HttpCode(200)
  @Post("enable")
  public enable(
    @Param("companyId") companyId: string,
    @Body() input: ChangeCompanyAccountingModeDto,
    @Req() request: Request,
  ): Promise<object> {
    return this.accountingMode.enable(companyId, input, this.actor(request));
  }

  @ApiOperation({ summary: "Disable GL Accounting for the selected Company" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_ACCOUNTING_MODE_MANAGE)
  @HttpCode(200)
  @Post("disable")
  public disable(
    @Param("companyId") companyId: string,
    @Body() input: ChangeCompanyAccountingModeDto,
    @Req() request: Request,
  ): Promise<object> {
    return this.accountingMode.disable(companyId, input, this.actor(request));
  }
}
