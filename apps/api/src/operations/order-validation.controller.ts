import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";

import { RequirePlatformPermissions, PLATFORM_INTEGRITY_READ } from "../platform/platform-authorization.js";
// Runtime imports are required for Nest dependency injection and validation metadata.
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { OrderValidationLookup } from "./order-validation.lookup.js";
import { OrderValidationService } from "./order-validation.service.js";
import { OrderLookupQueryDto, OrderValidationQueryDto } from "./order-validation.dto.js";
/* eslint-enable @typescript-eslint/consistent-type-imports */

@Controller("platform/companies/:companyId/repair-center/orders")
export class OrderValidationController {
  public constructor(
    private readonly lookup: OrderValidationLookup,
    private readonly validation: OrderValidationService,
  ) {}

  @Get("lookup")
  @RequirePlatformPermissions(PLATFORM_INTEGRITY_READ)
  public lookupOrder(@Param("companyId", ParseUUIDPipe) companyId: string, @Query() query: OrderLookupQueryDto) {
    return this.lookup.resolve(companyId, query.q);
  }

  @Get(":orderId/validation")
  @RequirePlatformPermissions(PLATFORM_INTEGRITY_READ)
  public validateOrder(
    @Param("companyId", ParseUUIDPipe) companyId: string,
    @Param("orderId", ParseUUIDPipe) orderId: string,
    @Query() query: OrderValidationQueryDto,
  ) {
    return this.validation.validate(companyId, orderId, query.version);
  }
}
