import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { CompanyConfigurationModule } from "../company-configuration/company-configuration.module.js";
import { OperationsModule } from "../operations/operations.module.js";
import { RoutePlanningController } from "./route-planning.controller.js";
import { RoutePlanningService } from "./route-planning.service.js";
import { AreaMatrixRouteProvider } from "./area-matrix-route-provider.js";
import { ROUTE_PROVIDERS } from "./route-provider.js";
import { DefaultRouteProviderRegistry } from "./route-provider.registry.js";
import { RouteSetupController } from "./route-setup.controller.js";
import { RouteSetupService } from "./route-setup.service.js";
import { AreaGeocoder, GEOCODER_FETCH } from "./area-geocoder.js";
import { RouteFeedbackService } from "./route-feedback.service.js";

/**
 * Driver route planning. A module of its own, so it does not touch the
 * Orders module. The engine is chosen per Company through the registry; the
 * stored-pin Area engine is the only one implemented (no external call, no
 * per-run cost). Route planning stays off until the Platform enables it.
 */
@Module({
  controllers: [RoutePlanningController, RouteSetupController],
  imports: [AuthenticationModule, CompanyConfigurationModule, OperationsModule],
  providers: [
    RoutePlanningService,
    RouteSetupService,
    RouteFeedbackService,
    AreaGeocoder,
    { provide: GEOCODER_FETCH, useValue: (url: string, init?: RequestInit) => fetch(url, init) },
    AreaMatrixRouteProvider,
    { provide: ROUTE_PROVIDERS, useClass: DefaultRouteProviderRegistry },
  ],
})
export class RoutePlanningModule {}
