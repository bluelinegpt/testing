import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { StoreOrderModule } from "../store-order/store-order.module.js";

import { CommerceCheckoutController } from "./commerce-checkout.controller.js";
import { CommerceCheckoutService } from "./commerce-checkout.service.js";
import { StoreOrderSubmissionController } from "./store-order-submission.controller.js";
import { StoreOrderSubmissionService } from "./store-order-submission.service.js";

/**
 * Customer Commerce Prompt C2/C3 -- Checkout preview and Store Order
 * submission.
 *
 * Self-contained, mirroring `StoreOrderModule`'s shape: `AuthenticationModule`
 * is imported only for `RequestSecurityContextStore` (best-effort session
 * read for a logged-in Customer) and `resolveCommerceCustomerId` is imported
 * directly as a plain function from `store-order-access.ts`, not via a
 * module dependency on `StoreOrderModule` for THAT reason. `StoreOrderModule`
 * IS imported now (new in C3) for exactly one thing: `StoreOrderService`,
 * which `StoreOrderSubmissionService` calls to actually persist a Store
 * Order after this module's own revalidation. `NotificationsModule` is not
 * imported here directly -- it is `StoreOrderModule`'s own dependency,
 * already satisfied wherever `StoreOrderModule` itself is composed.
 */
@Module({
  controllers: [CommerceCheckoutController, StoreOrderSubmissionController],
  exports: [CommerceCheckoutService],
  imports: [AuthenticationModule, StoreOrderModule],
  providers: [CommerceCheckoutService, StoreOrderSubmissionService],
})
export class CommerceCheckoutModule {}
