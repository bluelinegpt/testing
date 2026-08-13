import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { PLATFORM_COMPANIES_READ, RequirePlatformPermissions } from "./platform-authorization.js";
// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CompanyOverviewQueryDto,
  CompanyRankingQueryDto,
  PlatformDashboardQueryDto,
} from "./platform-dashboard.dto.js";
import { PlatformDashboardService } from "./platform-dashboard.service.js";

/**
 * The Platform Dashboard API.
 *
 * Every route here is read-only and gated by `platform.companies.read` — the
 * same permission that already gates seeing a Company at all. A dedicated
 * `platform.dashboard.read` permission was deliberately not created: nothing
 * on this Dashboard reveals more than the existing Company/Order data a
 * `platform.companies.read` holder can already reach one Company at a time,
 * so a second permission would only add a control nobody asked for.
 */
@ApiTags("platform dashboard")
@Controller("platform/dashboard")
export class PlatformDashboardController {
  public constructor(
    @Inject(PlatformDashboardService) private readonly dashboard: PlatformDashboardService,
  ) {}

  @ApiBearerAuth()
  @ApiOperation({ summary: "Platform Dashboard KPI summary" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("summary")
  public summary(@Query() query: PlatformDashboardQueryDto): Promise<object> {
    return this.dashboard.summary(query);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Orders Trend chart series" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("orders-trend")
  public ordersTrend(@Query() query: PlatformDashboardQueryDto): Promise<object> {
    return this.dashboard.ordersTrend(query);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Order Status Distribution for the selected period" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("order-status")
  public orderStatus(@Query() query: PlatformDashboardQueryDto): Promise<object> {
    return this.dashboard.orderStatusDistribution(query);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Top Companies ranked by a selected metric" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("company-ranking")
  public companyRanking(@Query() query: CompanyRankingQueryDto): Promise<object> {
    return this.dashboard.companyRanking(query);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Companies grouped by current lifecycle status" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("companies-by-status")
  public companiesByStatus(@Query() query: PlatformDashboardQueryDto): Promise<object> {
    return this.dashboard.companiesByStatus(query);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Companies grouped by current environment" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("companies-by-environment")
  public companiesByEnvironment(@Query() query: PlatformDashboardQueryDto): Promise<object> {
    return this.dashboard.companiesByEnvironment(query);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Orders by Emirate for the selected period" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("orders-by-emirate")
  public ordersByEmirate(@Query() query: PlatformDashboardQueryDto): Promise<object> {
    return this.dashboard.ordersByEmirate(query);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Paginated, sortable Company Overview table" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("company-overview")
  public companyOverview(@Query() query: CompanyOverviewQueryDto): Promise<object> {
    return this.dashboard.companyOverview(query);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Needs Attention alerts derived from real Platform data" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("needs-attention")
  public needsAttention(): Promise<object> {
    return this.dashboard.needsAttention();
  }
}
