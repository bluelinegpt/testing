import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { RequireIdentityKinds } from "../authentication/authentication.decorators.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";

import type { Page, StoreOrderView } from "./store-order.service.js";
import { StoreOrderService } from "./store-order.service.js";
import { TraderStoreOrderListQueryDto } from "./store-order.dto.js";

/**
 * Customer Commerce Prompt C5, Part B/F/G/J -- the Trader Portal's own
 * Store Order inbox and the three explicit lifecycle actions (Accept,
 * Cancel, Complete External).
 *
 * Trader-only (`RequireIdentityKinds("trader")`): a Company user (Delivery
 * Company staff) has no route here at all -- a zero-Company Store Order is
 * not theirs to act on (§47), and there is no separate "Company Store
 * Order" surface to accidentally expose it through. Ownership is resolved
 * the SAME way `StorefrontService.callerTraderId()` already does for the
 * Trader Portal's own Store screens -- `identity.profileId`, never a
 * client-supplied Trader id -- so cross-Trader access is impossible by
 * construction, not merely checked (§49).
 */
@ApiTags("trader-store-orders")
@RequireIdentityKinds("trader")
@Controller("portal/trader/store-orders")
export class TraderStoreOrderController {
  public constructor(
    @Inject(StoreOrderService) private readonly storeOrders: StoreOrderService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  @ApiOperation({ summary: "List the authenticated Trader's own Store Orders, newest first" })
  @Get()
  public list(@Query() query: TraderStoreOrderListQueryDto): Promise<Page<StoreOrderView>> {
    const { callerTraderId, companyId } = this.callerContext();
    return this.storeOrders.traderStoreOrderPage(callerTraderId, companyId, {
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.search === undefined ? {} : { search: query.search }),
    });
  }

  @ApiOperation({ summary: "Show one of the authenticated Trader's own Store Orders" })
  @Get(":storeOrderId")
  public detail(@Param("storeOrderId") storeOrderId: string): Promise<StoreOrderView> {
    const { callerTraderId, companyId } = this.callerContext();
    return this.storeOrders.traderStoreOrderDetail(callerTraderId, companyId, storeOrderId);
  }

  @ApiOperation({ summary: "Accept a Store Order awaiting the Trader's confirmation" })
  @HttpCode(HttpStatus.OK)
  @Post(":storeOrderId/accept")
  public accept(@Param("storeOrderId") storeOrderId: string): Promise<StoreOrderView> {
    const { callerTraderId, companyId } = this.callerContext();
    return this.storeOrders.traderAcceptStoreOrder(callerTraderId, companyId, storeOrderId);
  }

  @ApiOperation({ summary: "Cancel a Store Order awaiting the Trader's confirmation" })
  @HttpCode(HttpStatus.OK)
  @Post(":storeOrderId/cancel")
  public cancel(@Param("storeOrderId") storeOrderId: string): Promise<StoreOrderView> {
    const { callerTraderId, companyId } = this.callerContext();
    return this.storeOrders.traderCancelStoreOrder(callerTraderId, companyId, storeOrderId);
  }

  @ApiOperation({ summary: "Mark an accepted no-Company Store Order fulfilled outside Tawseelhub" })
  @HttpCode(HttpStatus.OK)
  @Post(":storeOrderId/complete-external")
  public completeExternal(@Param("storeOrderId") storeOrderId: string): Promise<StoreOrderView> {
    const { callerTraderId, companyId } = this.callerContext();
    return this.storeOrders.traderCompleteExternalStoreOrder(callerTraderId, companyId, storeOrderId);
  }

  /** Same pattern as `StorefrontService.callerTraderId()`: `identity.profileId`
   * is the Trader's own id, never accepted from the request. */
  private callerContext(): { readonly callerTraderId: string; readonly companyId: string } {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const callerTraderId = identity.profileId ?? identity.profileLinkId;
    if (callerTraderId === undefined) {
      throw new ApplicationException(
        "storefront_trader_context_required",
        "This Trader account is not linked to a Trader record",
        HttpStatus.FORBIDDEN,
      );
    }
    return { callerTraderId, companyId: identity.companyId };
  }
}
