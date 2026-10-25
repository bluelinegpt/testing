import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
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
import {
  type RouteFeedbackReport,
  RouteFeedbackService,
} from "./route-feedback.service.js";
import {
  type RouteSetup,
  RouteSetupService,
  type SuggestPinsResult,
} from "./route-setup.service.js";

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
  public constructor(
    @Inject(RouteSetupService) private readonly setup: RouteSetupService,
    @Inject(RouteFeedbackService) private readonly feedback: RouteFeedbackService,
  ) {}

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

  @ApiOperation({ summary: "Look up the next batch of Areas without a pin on Google (suggestions only)" })
  @Post("suggestions")
  public suggestPins(@Req() request: Request): Promise<SuggestPinsResult> {
    return this.setup.suggestPins(correlationId(request));
  }

  @ApiOperation({ summary: "Accept every Google suggestion that carries no warning" })
  @Post("suggestions/accept-clean")
  public acceptClean(
    @Req() request: Request,
  ): Promise<{ readonly accepted: number; readonly setup: RouteSetup }> {
    return this.setup.acceptCleanSuggestions(correlationId(request));
  }

  @ApiOperation({ summary: "Accept one Area's Google suggestion as its pin" })
  @Post("areas/:areaId/suggestion/accept")
  public acceptSuggestion(
    @Param("areaId", ParseUUIDPipe) areaId: string,
    @Req() request: Request,
  ): Promise<RouteSetup> {
    return this.setup.acceptSuggestion(areaId, correlationId(request));
  }

  @ApiOperation({ summary: "Reject one Area's Google suggestion" })
  @Post("areas/:areaId/suggestion/reject")
  public rejectSuggestion(
    @Param("areaId", ParseUUIDPipe) areaId: string,
    @Req() request: Request,
  ): Promise<RouteSetup> {
    return this.setup.rejectSuggestion(areaId, correlationId(request));
  }

  @ApiOperation({ summary: "Driver route feedback for the last 30 days" })
  @Get("feedback")
  public feedbackReport(): Promise<RouteFeedbackReport> {
    return this.feedback.report();
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
