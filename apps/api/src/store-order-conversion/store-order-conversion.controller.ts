import { Controller, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { RequirePlatformPermissions } from "../platform/platform-authorization.js";
import { PLATFORM_STORE_ORDER_CONVERSION_MANAGE } from "../platform/platform-authorization.js";

import type { ConvertedStoreOrder } from "./store-order-conversion.service.js";
import { StoreOrderConversionService } from "./store-order-conversion.service.js";

/**
 * Customer Commerce Prompt C4 -- "Store Order → Delivery Order".
 *
 * Platform-Administrator-only for now (§42-44 of the prompt): this is
 * explicitly a distinct, manually-triggered action, not yet wired into C3's
 * submission flow and not yet exposed to a Company or Delivery Company
 * self-service surface -- widening who may call it is a later, separate
 * decision (see the C4 completion report's automatic-conversion
 * recommendation). Gated by `platform.store_order_conversion.manage`
 * (`RequirePlatformPermissions`, the same mechanism every other Platform
 * route uses), never anonymous, never a Trader or Delivery Company session.
 *
 * The conversion itself does not trust anything from this route beyond the
 * Store Order NUMBER in the path -- no Company id, Trader id, or money
 * field is accepted here at all, so there is nothing for a caller (even an
 * authorized one) to tamper with (§65-67 of the prompt).
 */
@ApiTags("commerce-store-order-conversion")
@Controller("commerce/store-orders")
export class StoreOrderConversionController {
  public constructor(
    @Inject(StoreOrderConversionService) private readonly conversion: StoreOrderConversionService,
  ) {}

  @RequirePlatformPermissions(PLATFORM_STORE_ORDER_CONVERSION_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Convert a confirmed, Company-assigned Store Order into a Delivery Order" })
  @Post(":storeOrderNumber/convert-to-delivery")
  public convert(
    @Param("storeOrderNumber") storeOrderNumber: string,
    @Req() request: Request,
  ): Promise<ConvertedStoreOrder> {
    return this.conversion.convertToDeliveryOrder(storeOrderNumber, this.correlationId(request));
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}
