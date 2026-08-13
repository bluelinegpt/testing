import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../authentication/authentication.decorators.js";

import type { TrackingResultView } from "./store-order.service.js";
import { StoreOrderService } from "./store-order.service.js";
import { TrackStoreOrderDto } from "./store-order.dto.js";

/**
 * §27-30: public, unauthenticated, enumeration-safe Store Order tracking.
 *
 * POST rather than GET (§27): Order number, mobile and tracking token are
 * verification input, not a resource address, so none of the three belongs
 * in a URL/query string that ends up in access logs or browser history.
 *
 * Stricter-than-global throttling mirrors the exact idiom already used by
 * `PublicStorefrontProductController` (`storefront/product.controller.ts`) --
 * the same `@Throttle` decorator, no second throttling system introduced.
 */
@ApiTags("public-store-order-tracking")
@Controller("public/store-orders")
export class PublicStoreOrderTrackingController {
  public constructor(@Inject(StoreOrderService) private readonly storeOrders: StoreOrderService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify and track a Store Order by number, mobile and tracking token" })
  @Post("track")
  public track(@Body() input: TrackStoreOrderDto): Promise<TrackingResultView> {
    return this.storeOrders.trackStoreOrder(input);
  }
}
