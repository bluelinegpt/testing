import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";

import { OptionalAuthentication } from "../authentication/authentication.decorators.js";

import { PlaceStoreOrderDto } from "./store-order-submission.dto.js";
import type { PlaceStoreOrderResult } from "./store-order-submission.service.js";
import { StoreOrderSubmissionService } from "./store-order-submission.service.js";

/**
 * Customer Commerce Prompt C3 -- "Place Order".
 *
 * `@OptionalAuthentication()` for the same reason as `CommerceCheckoutController`
 * (see that decorator's own doc comment): guest and logged-in Customer share
 * one route, and a logged-in Customer's identity here is a real functional
 * dependency (§22 -- `commerce_customer_id` on the created Store Order),
 * never merely attribution the way `@Public()` treats it elsewhere. This is
 * a SEPARATE endpoint from `commerce/checkout/validate` (§6): that route
 * only ever previews, this one persists -- keeping them apart means a
 * client can never accidentally create a Store Order by calling the wrong
 * one, and the two are throttled independently to match their different
 * risk profiles.
 *
 * The response is `CustomerOrderDetailView` (the exact shape My Orders and
 * guest tracking already return) plus the raw tracking token -- no internal
 * Trader/Storefront/relationship id, and no `awaiting_trader_confirmation`
 * status is ever paired here with anything a Customer-safe caller shouldn't
 * see, because `loadCustomerOrderDetail` already excludes them (see its own
 * doc comment on `CustomerOrderDetailView`).
 */
@ApiTags("commerce-checkout")
@Controller("commerce/store-orders")
export class StoreOrderSubmissionController {
  public constructor(
    @Inject(StoreOrderSubmissionService) private readonly submission: StoreOrderSubmissionService,
  ) {}

  @OptionalAuthentication()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Revalidate a reviewed Checkout and place a COD Store Order" })
  @Post()
  public placeOrder(@Body() input: PlaceStoreOrderDto): Promise<PlaceStoreOrderResult> {
    return this.submission.placeOrder(input);
  }
}
