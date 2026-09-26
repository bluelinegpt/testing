import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";

import { CustomerStoreOrderController } from "./store-order.controller.js";
import { PublicStoreOrderTrackingController } from "./store-order-tracking.controller.js";
import { StoreOrderService } from "./store-order.service.js";
import { TraderStoreOrderController } from "./trader-store-order.controller.js";

/**
 * Shared Commerce Foundation Prompts 3B/3C/3D: the Store Order domain.
 *
 * Deliberately self-contained: `accessibleCommerceIds` (Trader-side scoping)
 * is imported directly from `storefront/storefront-access.ts` as a plain
 * function -- it is not a Nest provider -- so this module does not need to
 * import `StorefrontModule` and gains no dependency on the rest of the
 * Storefront domain. `AuthenticationModule` is imported only for
 * `IdentityContextAccessor`, the same dependency `CommerceCustomerModule`
 * takes for the identical reason. `NotificationsModule` (3D) supplies the
 * `NotificationPublisher` abstraction -- today bound to a no-op -- so this
 * domain depends on an interface, never on a push/email/WhatsApp provider.
 *
 * 3C is the first prompt to expose this domain over HTTP: a Customer-scoped
 * My Orders/Detail controller and a public, enumeration-safe tracking
 * controller. Cart/Checkout (which would call `createStoreOrder` itself)
 * still has no controller here -- that remains a later prompt.
 */
@Module({
  controllers: [CustomerStoreOrderController, PublicStoreOrderTrackingController, TraderStoreOrderController],
  exports: [StoreOrderService],
  imports: [AuthenticationModule, NotificationsModule],
  providers: [StoreOrderService],
})
export class StoreOrderModule {}
