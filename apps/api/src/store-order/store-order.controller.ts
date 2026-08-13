import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { RequireIdentityKinds } from "../authentication/authentication.decorators.js";
import { IdentityContextAccessor } from "../security/identity-context.js";

import type { CustomerOrderDetailView, CustomerOrderSummaryView, Page } from "./store-order.service.js";
import { StoreOrderService } from "./store-order.service.js";
import { CustomerOrderListQueryDto } from "./store-order.dto.js";

/**
 * §2-9: Customer My Orders / Order Detail -- authenticated Customer only.
 * Ownership is never taken from the request; `IdentityContextAccessor`'s
 * `identityId` is the authenticated Account id, and every service call
 * re-resolves the owning `commerce_customers` row from it server-side
 * (`resolveCommerceCustomerId`), exactly like the existing Profile/Address
 * controllers in `commerce-customer`.
 */
@ApiTags("commerce-customer-orders")
@RequireIdentityKinds("customer")
@Controller("commerce/customer/orders")
export class CustomerStoreOrderController {
  public constructor(
    @Inject(StoreOrderService) private readonly storeOrders: StoreOrderService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  @ApiOperation({ summary: "List the authenticated Customer's own Store Orders, newest first" })
  @Get()
  public list(
    @Query() query: CustomerOrderListQueryDto,
  ): Promise<Page<CustomerOrderSummaryView>> {
    return this.storeOrders.customerOrderSummaryPage(this.identities.current().identityId, {
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
  }

  @ApiOperation({ summary: "Show one of the authenticated Customer's own Store Orders" })
  @Get(":storeOrderNumber")
  public detail(
    @Param("storeOrderNumber") storeOrderNumber: string,
  ): Promise<CustomerOrderDetailView> {
    return this.storeOrders.customerOrderDetailView(
      this.identities.current().identityId,
      storeOrderNumber,
    );
  }
}
