import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import {
  CommerceIntegrationWebhookController,
  PlatformCommerceIntegrationController,
} from "./commerce-integration.controller.js";
import { CommerceIntegrationService } from "./commerce-integration.service.js";
import { CommerceProviderRouter } from "./commerce-provider.router.js";

@Module({
  imports: [AuthenticationModule],
  controllers: [CommerceIntegrationWebhookController, PlatformCommerceIntegrationController],
  providers: [CommerceIntegrationService, CommerceProviderRouter],
})
export class CommerceIntegrationModule {}
