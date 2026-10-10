import { Inject, Injectable } from "@nestjs/common";

import { AreaMatrixRouteProvider } from "./area-matrix-route-provider.js";
import {
  type RouteProvider,
  type RouteProviderRegistry,
  UnavailableRouteProvider,
} from "./route-provider.js";

/**
 * Picks the engine for a Company's `provider` setting. Only the stored-pin
 * Area engine exists; `google_routes` (and anything unknown) resolves to an
 * unavailable provider, which the planner never calls.
 */
@Injectable()
export class DefaultRouteProviderRegistry implements RouteProviderRegistry {
  private readonly google = new UnavailableRouteProvider("google_routes");
  private readonly none = new UnavailableRouteProvider("none");

  public constructor(
    @Inject(AreaMatrixRouteProvider) private readonly areaMatrix: AreaMatrixRouteProvider,
  ) {}

  public forCompany(provider: string): RouteProvider {
    if (provider === "area_matrix") return this.areaMatrix;
    if (provider === "google_routes") return this.google;
    return this.none;
  }
}
