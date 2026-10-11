import { Body, Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from "class-validator";
import type { Request } from "express";

import { IdentityContextAccessor } from "../security/identity-context.js";
import {
  RESET_DOMAINS,
  RESET_PRESETS,
  type ResetDomain,
  type ResetPreset,
  USER_MODES,
  type UserMode,
} from "./company-data-reset.domains.js";
import { type CompanyDataResetExecution, CompanyDataResetService } from "./company-data-reset.service.js";
import type { CompanyDataResetPlan } from "./company-data-reset.planner.js";
import { correlationIdOf } from "./platform-audit.service.js";
import { PLATFORM_COMPANIES_RESET, RequirePlatformPermissions } from "./platform-authorization.js";
import { PlatformTargetCompanyGuard } from "./platform-target-company.guard.js";

const trim = ({ value }: { value: unknown }): unknown => (typeof value === "string" ? value.trim() : value);

/** What to reset: a preset plus explicit options. Never data, never SQL. */
export class CompanyDataResetPlanDto {
  @IsIn(RESET_PRESETS)
  public preset!: ResetPreset;

  @IsOptional()
  @ArrayUnique()
  @ArrayMaxSize(RESET_DOMAINS.length)
  @IsIn(RESET_DOMAINS, { each: true })
  public domains?: ResetDomain[];

  @IsOptional()
  @IsIn(USER_MODES)
  public userMode?: UserMode;

  @IsOptional()
  @ArrayUnique()
  @ArrayMaxSize(500)
  @IsUUID("all", { each: true })
  public selectedAccountIds?: string[];

  @IsOptional()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsUUID("all", { each: true })
  public deleteAdminAccountIds?: string[];

  @IsOptional()
  @IsIn(["KEEP", "RESET"])
  public tradersCustomers?: "KEEP" | "RESET";

  @IsOptional()
  @IsIn(["KEEP", "RESET"])
  public workforce?: "KEEP" | "RESET";
}

export class CompanyDataResetExecuteDto extends CompanyDataResetPlanDto {
  @Matches(/^crp1:[0-9a-f]{64}$/u)
  public planVersion!: string;

  @Transform(trim)
  @IsString()
  @Length(7, 80)
  public confirmation!: string;
}

/**
 * Company Data Reset (Company Data Reset, Prompt 1): preview a deterministic
 * reset plan, then execute exactly that plan. Platform-only, behind the
 * existing `platform.companies.reset` permission; the Company comes only from
 * the path (PlatformTargetCompanyGuard). Production Companies are refused.
 */
@ApiTags("platform company data reset")
@ApiBearerAuth()
@Controller("platform/companies/:companyId/data-reset")
@UseGuards(PlatformTargetCompanyGuard)
export class CompanyDataResetController {
  public constructor(
    @Inject(CompanyDataResetService) private readonly resets: CompanyDataResetService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  @ApiOperation({ summary: "Preview a Company Data Reset plan (read-only)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_RESET)
  @HttpCode(200)
  @Post("preview")
  public preview(@Param("companyId") companyId: string, @Body() input: CompanyDataResetPlanDto): Promise<CompanyDataResetPlan> {
    return this.resets.preview(companyId, input);
  }

  @ApiOperation({ summary: "Execute exactly the previewed Company Data Reset plan" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_RESET)
  @HttpCode(200)
  @Post("execute")
  public execute(
    @Param("companyId") companyId: string,
    @Body() input: CompanyDataResetExecuteDto,
    @Req() request: Request,
  ): Promise<CompanyDataResetExecution> {
    return this.resets.execute(companyId, input, {
      accountId: this.identities.current().identityId,
      correlationId: correlationIdOf(request),
    });
  }
}
