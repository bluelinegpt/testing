import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { RequireIdentityKinds } from "../authentication/authentication.decorators.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
// The DTO classes must stay runtime imports: Nest reads them from decorator
// metadata to run the ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  DeferRouteOrderDto,
  PlanRouteDto,
  ReplanRouteDto,
  ReverseRouteDto,
} from "./route-planning.dto.js";
import { type RouteResponse, RoutePlanningService } from "./route-planning.service.js";

/**
 * Driver route planning (Areas, not addresses -- this is not turn-by-turn
 * navigation). The Driver works only on his own run over his own assigned
 * Orders; the Company and Driver always come from the session.
 *
 * Every write takes an `x-idempotency-key`, so a double tap on a slow
 * connection returns the first result instead of spending a second engine
 * call or recording a second action.
 */
@ApiTags("route-planning")
@ApiBearerAuth()
@RequireIdentityKinds("driver")
@Controller("portal/driver/route")
export class RoutePlanningController {
  public constructor(@Inject(RoutePlanningService) private readonly routes: RoutePlanningService) {}

  @ApiOperation({ summary: "Today's route for the authenticated Driver, over live Orders" })
  @Get()
  public current(): Promise<RouteResponse> {
    return this.routes.current();
  }

  @ApiOperation({ summary: "Plan my route (returns the existing run for today if there is one)" })
  @Post("plan")
  @HttpCode(HttpStatus.OK)
  public plan(
    @Body() input: PlanRouteDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
  ): Promise<RouteResponse> {
    return this.routes.plan(input, requireKey(idempotencyKey));
  }

  @ApiOperation({ summary: "Recompute today's route" })
  @Post("replan")
  @HttpCode(HttpStatus.OK)
  public replan(
    @Body() input: ReplanRouteDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
  ): Promise<RouteResponse> {
    return this.routes.replan(input, requireKey(idempotencyKey));
  }

  @ApiOperation({ summary: "Reverse the route direction (no engine call)" })
  @Post("reverse")
  @HttpCode(HttpStatus.OK)
  public reverse(
    @Body() input: ReverseRouteDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
  ): Promise<RouteResponse> {
    return this.routes.reverse(input.expectedRevision, requireKey(idempotencyKey));
  }

  @ApiOperation({ summary: "Defer an Order to the end of the route (no Order change)" })
  @Post("defer")
  @HttpCode(HttpStatus.OK)
  public defer(
    @Body() input: DeferRouteOrderDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
  ): Promise<RouteResponse> {
    return this.routes.defer(input.orderId, input.expectedRevision, requireKey(idempotencyKey));
  }
}

export function requireKey(value: string | undefined): string {
  const key = value?.trim() ?? "";
  if (key.length < 8 || key.length > 200) {
    throw new ApplicationException(
      "route_idempotency_key_required",
      "An x-idempotency-key header of 8 to 200 characters is required",
      HttpStatus.BAD_REQUEST,
    );
  }
  return key;
}
