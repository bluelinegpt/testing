import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import type {
  AccountingActivationDto,
  AccountingActivationPreviewDto,
  AccountingAreaChangeDto,
  AccountingMappingDecisionDto,
  AccountingSetupDateQueryDto,
  AccountingZeroOpeningDto,
} from "./accounting-setup.dto.js";
import { AccountingSetupService } from "./accounting-setup.service.js";
import type { AccountingReasonDto } from "./accounting.dto.js";

@ApiTags("accounting-setup")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/accounting")
export class AccountingSetupController {
  public constructor(
    @Inject(AccountingSetupService) private readonly setup: AccountingSetupService,
  ) {}

  @Get("setup/mapping-suggestions")
  @RequireAnyPermission("accounting.view", "accounting.configuration.manage", "users_roles.manage")
  public suggestions(@Query() query: AccountingSetupDateQueryDto) {
    return this.setup.mappingSuggestions(query.effectiveOn);
  }

  @Get("setup/mapping-issues")
  @RequireAnyPermission("accounting.view", "accounting.configuration.manage", "users_roles.manage")
  public issues(@Query() query: AccountingSetupDateQueryDto) {
    return this.setup.mappingIssues(query.effectiveOn);
  }

  @Post("setup/mapping-suggestions/:suggestionId/decision")
  @RequireAnyPermission("accounting.configuration.manage", "users_roles.manage")
  public decide(
    @Param("suggestionId") suggestionId: string,
    @Body() input: AccountingMappingDecisionDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.setup.decideSuggestion(suggestionId, input, key);
  }

  @Get("setup/zero-opening")
  @RequireAnyPermission("accounting.view", "accounting.configuration.manage", "users_roles.manage")
  public zeroOpening(@Query() query: AccountingSetupDateQueryDto) {
    return this.setup.zeroOpeningStatus(query.effectiveOn);
  }

  @Post("setup/zero-opening/confirm")
  @RequireAnyPermission("accounting.configuration.manage", "users_roles.manage")
  public confirmZeroOpening(
    @Body() input: AccountingZeroOpeningDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.setup.confirmZeroOpening(input, key);
  }

  @Post("setup/zero-opening/revoke")
  @RequireAnyPermission("accounting.configuration.manage", "users_roles.manage")
  public revokeZeroOpening(
    @Body() input: AccountingReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.setup.revokeZeroOpening(input.reason, key);
  }

  @Get("dashboard/actions")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public actions() {
    return this.setup.dashboardActions();
  }

  @Get("dashboard/financial-snapshot")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public snapshot() {
    return this.setup.financialSnapshot();
  }

  @Get("dashboard/recent-activity")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public activity(@Query("limit") limit?: string) {
    return this.setup.recentActivity(limit === undefined ? 30 : Number(limit));
  }

  @Get("setup/automatic-posting/areas")
  @RequireAnyPermission("accounting.view", "accounting.configuration.manage", "users_roles.manage")
  public areas() {
    return this.setup.areaReadiness();
  }

  @Post("setup/automatic-posting/areas/enable")
  @RequireAnyPermission("accounting.configuration.manage", "users_roles.manage")
  public enableArea(
    @Body() input: AccountingAreaChangeDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.setup.changeArea(input, true, key);
  }

  @Post("setup/automatic-posting/areas/disable")
  @RequireAnyPermission("accounting.configuration.manage", "users_roles.manage")
  public disableArea(
    @Body() input: AccountingAreaChangeDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.setup.changeArea(input, false, key);
  }

  @Post("setup/activation-preview")
  @RequireAnyPermission("accounting.configuration.manage", "users_roles.manage")
  public preview(@Body() input: AccountingActivationPreviewDto) {
    return this.setup.activationPreview(input);
  }

  @Post("setup/activate-manual-accounting")
  @RequireAnyPermission("accounting.configuration.manage", "users_roles.manage")
  public activate(
    @Body() input: AccountingActivationDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.setup.activateManualAccounting(input, key);
  }
}
