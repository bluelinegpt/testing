import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import {
  RequireIdentityKinds,
  RequirePermissions,
} from "../authentication/authentication.decorators.js";
// The DTO class must stay a runtime import: Nest reads it from decorator
// metadata to run the ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { RoutePointDto } from "./route-planning.dto.js";
import { type RouteSetup, RouteSetupService } from "./route-setup.service.js";

/**
 * Configuration › Route planning: Area pins and the branch location.
 *
 * Guarded with the same configuration permission as the other master-data
 * screens (`users_roles.manage`). Switching route planning on or off is not
 * here -- that is a Platform decision.
 */
@ApiTags("configuration")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequirePermissions("users_roles.manage")
@Controller("configuration/route-planning")
export class RouteSetupController {
  public constructor(@Inject(RouteSetupService) private readonly setup: RouteSetupService) {}

  @ApiOperation({ summary: "Route planning setup: status, branch and Area pins" })
  @Get()
  public read(): Promise<RouteSetup> {
    return this.setup.setup();
  }

  @ApiOperation({ summary: "Save and confirm an Area's pin" })
  @Put("areas/:areaId/coordinates")
  public setAreaPin(
    @Param("areaId", ParseUUIDPipe) areaId: string,
    @Body() input: RoutePointDto,
    @Req() request: Request,
  ): Promise<RouteSetup> {
    return this.setup.setAreaPin(areaId, input, correlationId(request));
  }

  @ApiOperation({ summary: "Remove an Area's pin" })
  @Delete("areas/:areaId/coordinates")
  public clearAreaPin(
    @Param("areaId", ParseUUIDPipe) areaId: string,
    @Req() request: Request,
  ): Promise<RouteSetup> {
    return this.setup.clearAreaPin(areaId, correlationId(request));
  }

  @ApiOperation({ summary: "Save the branch location (where a run ends)" })
  @Put("branch")
  public setBranch(@Body() input: RoutePointDto, @Req() request: Request): Promise<RouteSetup> {
    return this.setup.setBranch(input, correlationId(request));
  }
}

function correlationId(request: Request): string {
  return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
}
