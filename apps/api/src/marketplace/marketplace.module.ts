import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { WhatsAppOutboxWriter } from "../whatsapp/whatsapp-outbox-writer.service.js";

import { MarketplaceMappingService } from "./marketplace-mapping.service.js";
import { MarketplaceTaxonomyService } from "./marketplace-taxonomy.service.js";
import {
  MarketplaceClassificationController,
  PublicMarketplaceController,
} from "./marketplace.controller.js";

/**
 * Platform Marketplace taxonomy and classification.
 *
 * Its own module rather than an addition to the Storefront module: the taxonomy
 * is Platform-owned and spans every shop, while `StorefrontModule` is about one
 * Trader's shop. Keeping them separate is what stops a later "just add the
 * category admin here" from landing in Trader-facing code.
 */
@Module({
  controllers: [PublicMarketplaceController, MarketplaceClassificationController],
  exports: [MarketplaceTaxonomyService, MarketplaceMappingService],
  imports: [AuthenticationModule],
  providers: [
    MarketplaceTaxonomyService,
    MarketplaceMappingService,
    OperationsHistoryWriter,
    WhatsAppOutboxWriter,
  ],
})
export class MarketplaceModule {}
