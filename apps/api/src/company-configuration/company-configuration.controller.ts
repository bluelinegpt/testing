import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
  RequirePermissions,
} from "../authentication/authentication.decorators.js";
import {
  type BusinessDayConfiguration,
  type BusinessDayWindow,
  BusinessDayService,
} from "./business-day.service.js";
import {
  type CompanyBankAccount,
  type CompanySettings,
  CompanyConfigurationService,
} from "./company-configuration.service.js";
// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CreateBankAccountDto,
  SaveBusinessDayConfigurationDto,
  UpdateAreaStatusDto,
  UpdateCompanySettingsDto,
} from "./company-configuration.dto.js";

@ApiTags("company-configuration")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequirePermissions("users_roles.manage")
@Controller("configuration")
export class CompanyConfigurationController {
  public constructor(
    @Inject(CompanyConfigurationService)
    private readonly configuration: CompanyConfigurationService,
    @Inject(BusinessDayService)
    private readonly businessDays: BusinessDayService,
  ) {}

  // ---------------------------------------------------------------------------
  // Business day
  //
  // The Company is taken from the authenticated tenant context in the service,
  // never from a route or query parameter, so no caller can read or reshape
  // another Company's calendar.
  // ---------------------------------------------------------------------------

  @ApiOperation({ summary: "List this Company's effective-dated business-day rules" })
  @Get("business-day")
  public businessDayConfigurations(): Promise<readonly BusinessDayConfiguration[]> {
    return this.businessDays.configurations();
  }

  @ApiOperation({ summary: "Adopt a business-day rule from a future date" })
  @Post("business-day")
  public saveBusinessDay(
    @Body() input: SaveBusinessDayConfigurationDto,
    @Req() request: Request,
  ): Promise<BusinessDayConfiguration> {
    return this.businessDays.saveConfiguration(input, this.correlationId(request));
  }

  /**
   * Resolve a Business Date range to the exact window a report will query.
   *
   * The browser asks for this rather than computing it: a UTC boundary derived
   * in the client would be built from the viewer's own clock and zone, and the
   * backend would have no way to tell a wrong one from a right one.
   */
  @ApiOperation({ summary: "Resolve the UTC window for a Business Date range" })
  @Get("business-day/window")
  public businessDayWindow(
    @Query("businessDateFrom") businessDateFrom: string,
    @Query("businessDateTo") businessDateTo?: string,
  ): Promise<BusinessDayWindow> {
    return this.businessDays.window(businessDateFrom, businessDateTo);
  }

  @ApiOperation({ summary: "Show Company settings" })
  @Get("settings")
  public settings(): Promise<CompanySettings> {
    return this.configuration.settings();
  }

  @ApiOperation({ summary: "Update Company settings" })
  @Patch("settings")
  public updateSettings(
    @Body() input: UpdateCompanySettingsDto,
    @Req() request: Request,
  ): Promise<CompanySettings> {
    return this.configuration.updateSettings(input, this.correlationId(request));
  }

  // Areas moved to AreaConfigurationController (Emirate-aware, paginated).

  // Read-only: widened so the Trader Settlement payment form (which runs on
  // settlements.create, not users_roles.manage) can list source bank accounts
  // to select from. Every write route on this controller keeps the class-level
  // users_roles.manage-only gate. RequirePermissions and RequireAnyPermission
  // are independent, AND'd checks (different metadata keys) — the empty
  // RequirePermissions() clears the class-level all-of requirement for this
  // one route so RequireAnyPermission below is the only gate that applies.
  @RequirePermissions()
  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "List Company bank accounts" })
  @Get("bank-accounts")
  public bankAccounts(): Promise<readonly CompanyBankAccount[]> {
    return this.configuration.bankAccounts();
  }

  @ApiOperation({ summary: "Create a Company bank account" })
  @Post("bank-accounts")
  public createBankAccount(
    @Body() input: CreateBankAccountDto,
    @Req() request: Request,
  ): Promise<CompanyBankAccount> {
    return this.configuration.createBankAccount(input, this.correlationId(request));
  }

  @ApiOperation({ summary: "Activate or deactivate a Company bank account" })
  @Patch("bank-accounts/:bankAccountId/status")
  public updateBankAccountStatus(
    @Param("bankAccountId", new ParseUUIDPipe()) bankAccountId: string,
    @Body() input: UpdateAreaStatusDto,
    @Req() request: Request,
  ): Promise<CompanyBankAccount> {
    return this.configuration.updateBankAccountStatus(
      bankAccountId,
      input.isActive,
      this.correlationId(request),
    );
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}
