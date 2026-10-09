import { Body, Controller, Get, Inject, Put, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
  RequirePermissions,
} from "../authentication/authentication.decorators.js";
// Runtime class value required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SaveOrderViewsMenuDto } from "./order-views.dto.js";
import { type OrderViewsMenu, OrderViewsService } from "./order-views.service.js";

/**
 * The anyone-who-can-see-Orders list. Reading the menu must be open to them:
 * the Orders screen builds its tabs from it.
 */
export const ORDER_VIEWS_READ_PERMISSIONS = [
  "orders.edit_before_processing",
  "orders.driver_self_service",
  "orders.assign_driver",
  "orders.update_delivery_status",
  "reconciliations.create",
  "reconciliations.reverse",
  "settlements.create",
  "settlements.reverse",
  "order_views.manage",
  "users_roles.manage",
] as const;

@ApiTags("company-configuration")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequirePermissions("users_roles.manage")
@Controller("configuration/order-views")
export class OrderViewsController {
  public constructor(@Inject(OrderViewsService) private readonly orderViews: OrderViewsService) {}

  @RequirePermissions()
  @RequireAnyPermission(...ORDER_VIEWS_READ_PERMISSIONS)
  @ApiOperation({ summary: "Show this Company's Orders menu (standard menu when never saved)" })
  @Get()
  public menu(): Promise<OrderViewsMenu> {
    return this.orderViews.menu();
  }

  @RequirePermissions()
  @RequireAnyPermission("order_views.manage", "users_roles.manage")
  @ApiOperation({ summary: "Replace this Company's Orders menu" })
  @Put()
  public save(@Body() input: SaveOrderViewsMenuDto, @Req() request: Request): Promise<OrderViewsMenu> {
    return this.orderViews.save(
      {
        enabled: input.enabled,
        expectedVersion: input.expectedVersion,
        views: input.views,
      },
      this.correlationId(request),
    );
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}
