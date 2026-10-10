import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { CompanyConfigurationModule } from "../company-configuration/company-configuration.module.js";
import { RoutePlanningController } from "./route-planning.controller.js";
import { RoutePlanningService } from "./route-planning.service.js";
import { ROUTE_PROVIDER, UnavailableRouteProvider } from "./route-provider.js";

/**
 * Driver route planning. A module of its own, so it does not touch the
 * Orders module. No routing engine is bound yet: `UnavailableRouteProvider`
 * makes every plan use the deterministic fallback ordering and never spends
 * an engine call. The engine choice (Google Routes vs the stored Area
 * travel-time matrix) replaces this one provider binding.
 */
@Module({
  controllers: [RoutePlanningController],
  imports: [AuthenticationModule, CompanyConfigurationModule],
  providers: [
    RoutePlanningService,
    { provide: ROUTE_PROVIDER, useClass: UnavailableRouteProvider },
  ],
})
export class RoutePlanningModule {}
