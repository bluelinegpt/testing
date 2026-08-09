import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { FilesModule } from "../files/files.module.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";

import {
  PublicStorefrontProductController,
  StorefrontProductController,
} from "./product.controller.js";
import { StorefrontProductService } from "./product.service.js";
import {
  CommerceMediaController,
  PublicCommerceMediaController,
} from "./commerce-media.controller.js";
import { CommerceMediaService } from "./commerce-media.service.js";
import { StorefrontDeliveryService } from "./storefront-delivery.service.js";
import { PublicStorefrontController, StorefrontController } from "./storefront.controller.js";
import { StorefrontService } from "./storefront.service.js";

/**
 * Trader Storefront profile and configuration.
 *
 * Deliberately self-contained: it provides `OperationsHistoryWriter` directly
 * (a dependency-free writer) rather than importing the whole Operations module,
 * so the Storefront domain does not acquire a dependency on order, settlement
 * or reconciliation services it has no business reaching.
 */
@Module({
  controllers: [
    StorefrontController,
    PublicStorefrontController,
    StorefrontProductController,
    PublicStorefrontProductController,
    CommerceMediaController,
    PublicCommerceMediaController,
  ],
  exports: [
    StorefrontService,
    StorefrontProductService,
    StorefrontDeliveryService,
    CommerceMediaService,
  ],
  imports: [AuthenticationModule, FilesModule],
  providers: [
    StorefrontService,
    StorefrontProductService,
    StorefrontDeliveryService,
    CommerceMediaService,
    OperationsHistoryWriter,
  ],
})
export class StorefrontModule {}
