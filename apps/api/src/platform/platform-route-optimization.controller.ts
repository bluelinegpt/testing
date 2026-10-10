import { Body, Controller, Get, Inject, Param, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import {
  type CompanyRouteOptimization,
  RouteOptimizationAdminService,
  type RouteKillSwitch,
} from "../route-planning/route-optimization-admin.service.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { correlationIdOf } from "./platform-audit.service.js";
import {
  PLATFORM_COMPANIES_READ,
  PLATFORM_COMPANY_ROUTE_OPTIMIZATION_MANAGE,
  RequirePlatformPermissions,
} from "./platform-authorization.js";
// Runtime DTO imports are required so Nest can emit validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ConfigureRouteKillSwitchDto,
  UpdateCompanyRouteOptimizationDto,
} from "./platform-route-optimization.dto.js";
import { PlatformTargetCompanyGuard } from "./platform-target-company.guard.js";

/**
 * Platform Administration → Company → Route planning, and the Platform-wide
 * kill switch. Reading follows `platform.companies.read`; changing needs
 * `platform.company_route_optimization.manage`.
 */
@ApiTags("platform route optimization")
@ApiBearerAuth()
@Controller("platform")
export class PlatformRouteOptimizationController {
  public constructor(
    @Inject(RouteOptimizationAdminService) private readonly routes: RouteOptimizationAdminService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  private actor(request: Request) {
    return {
      accountId: this.identities.current().identityId,
      correlationId: correlationIdOf(request),
    };
  }

  @ApiOperation({ summary: "A Company's route planning switch, pins and usage" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @UseGuards(PlatformTargetCompanyGuard)
  @Get("companies/:companyId/route-optimization")
  public overview(@Param("companyId") companyId: string): Promise<CompanyRouteOptimization> {
    return this.routes.overview(companyId);
  }

  @ApiOperation({ summary: "Switch route planning on or off for a Company" })
  @RequirePlatformPermissions(PLATFORM_COMPANY_ROUTE_OPTIMIZATION_MANAGE)
  @UseGuards(PlatformTargetCompanyGuard)
  @Put("companies/:companyId/route-optimization")
  public update(
    @Param("companyId") companyId: string,
    @Body() input: UpdateCompanyRouteOptimizationDto,
    @Req() request: Request,
  ): Promise<CompanyRouteOptimization> {
    return this.routes.update(companyId, input, this.actor(request));
  }

  @ApiOperation({ summary: "The Platform-wide route planning kill switch" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("route-optimization/kill-switch")
  public killSwitch(): Promise<RouteKillSwitch> {
    return this.routes.killSwitch();
  }

  @ApiOperation({ summary: "Turn the Platform-wide route planning kill switch on or off" })
  @RequirePlatformPermissions(PLATFORM_COMPANY_ROUTE_OPTIMIZATION_MANAGE)
  @Put("route-optimization/kill-switch")
  public configure(
    @Body() input: ConfigureRouteKillSwitchDto,
    @Req() request: Request,
  ): Promise<RouteKillSwitch> {
    return this.routes.configureKillSwitch(input, this.actor(request));
  }
}
