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
// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AreaListQueryDto,
  AreaSearchQueryDto,
  CreateAreaDto,
  UpdateAreaDto,
  UpdateAreaStatusDto,
} from "./area-configuration.dto.js";
import {
  type AreaPage,
  type AreaSearchPage,
  AreaConfigurationService,
  type ConfiguredArea,
  type Emirate,
} from "./area-configuration.service.js";

/**
 * Areas and the Emirate master.
 *
 * Guarded with the existing configuration permission rather than a new
 * Area-specific one: Areas are configuration master data managed by the same
 * administrators as Traders, Customers and bank accounts, and every sibling
 * configuration controller already uses this code. Introducing a granular
 * permission would require editing every existing Role to restore access.
 */
@ApiTags("configuration")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequirePermissions("users_roles.manage")
@Controller("configuration")
export class AreaConfigurationController {
  public constructor(
    @Inject(AreaConfigurationService) private readonly areas: AreaConfigurationService,
  ) {}

  @ApiOperation({ summary: "List the UAE Emirate master" })
  @RequireAnyPermission("orders.create", "users_roles.manage")
  @Get("emirates")
  public emirates(): Promise<readonly Emirate[]> {
    return this.areas.emirates();
  }

  @ApiOperation({ summary: "List Areas with search, Emirate and status filters" })
  @Get("areas")
  public list(@Query() query: AreaListQueryDto): Promise<AreaPage> {
    return this.areas.list(query);
  }

  @ApiOperation({ summary: "Typeahead search over Areas for the shared selector" })
  @RequireAnyPermission("orders.create", "users_roles.manage")
  @Get("areas/search")
  public search(@Query() query: AreaSearchQueryDto): Promise<AreaSearchPage> {
    return this.areas.search(query);
  }

  @ApiOperation({ summary: "Return one Area" })
  @Get("areas/:areaId")
  public get(@Param("areaId", ParseUUIDPipe) areaId: string): Promise<ConfiguredArea> {
    return this.areas.get(areaId);
  }

  @ApiOperation({ summary: "Create an Area under an Emirate" })
  @RequireAnyPermission("orders.create", "users_roles.manage")
  @Post("areas")
  public create(@Body() input: CreateAreaDto, @Req() request: Request): Promise<ConfiguredArea> {
    return this.areas.create(input, this.correlationId(request));
  }

  @ApiOperation({ summary: "Update an Area" })
  @Patch("areas/:areaId")
  public update(
    @Param("areaId", ParseUUIDPipe) areaId: string,
    @Body() input: UpdateAreaDto,
    @Req() request: Request,
  ): Promise<ConfiguredArea> {
    return this.areas.update(areaId, input, this.correlationId(request));
  }

  @ApiOperation({ summary: "Enable or disable an Area" })
  @Patch("areas/:areaId/status")
  public setStatus(
    @Param("areaId", ParseUUIDPipe) areaId: string,
    @Body() input: UpdateAreaStatusDto,
    @Req() request: Request,
  ): Promise<ConfiguredArea> {
    return this.areas.setStatus(areaId, input.isActive, this.correlationId(request));
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}
