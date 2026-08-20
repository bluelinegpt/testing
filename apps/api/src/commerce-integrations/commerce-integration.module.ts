import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import {
  CommerceIntegrationWebhookController,
  PlatformCommerceIntegrationController,
  TraderCommerceIntegrationController,
} from "./commerce-integration.controller.js";
import { CommerceIntegrationService } from "./commerce-integration.service.js";
import { CommerceProviderRouter } from "./commerce-provider.router.js";

@Module({
  imports: [AuthenticationModule],
  controllers: [CommerceIntegrationWebhookController, PlatformCommerceIntegrationController, TraderCommerceIntegrationController],
  providers: [CommerceIntegrationService, CommerceProviderRouter],
})
export class CommerceIntegrationModule {}
