/**
 * The routing-engine boundary.
 *
 * Route planning never depends on a concrete engine. Google Routes and the
 * stored Area travel-time matrix (the two candidates in the design) each
 * implement this interface; until one is chosen and configured, the
 * `UnavailableRouteProvider` is bound and every plan uses the deterministic
 * fallback ordering. An unavailable provider is never counted against the
 * Company's daily budget, because no call is made.
 */
export interface RouteProviderStop {
  readonly areaId: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface RouteProviderRequest {
  readonly start: { readonly latitude: number; readonly longitude: number } | null;
  readonly stops: readonly RouteProviderStop[];
}

export interface RouteProviderResult {
  readonly responseId?: string;
  /** Area ids in the engine's recommended order. Unknown ids are ignored. */
  readonly orderedAreaIds: readonly string[];
  readonly distanceMeters?: number;
  readonly durationSeconds?: number;
}

export interface RouteProvider {
  readonly name: "google_routes" | "area_matrix" | "none";
  /** False when no engine is configured; the planner then makes no call. */
  readonly available: boolean;
  plan(request: RouteProviderRequest): Promise<RouteProviderResult>;
}

export const ROUTE_PROVIDER = Symbol("ROUTE_PROVIDER");

/** Hard ceiling on intermediate waypoints for one engine request. */
export const ROUTE_PROVIDER_WAYPOINT_CEILING = 25;

/** Bound until a real engine is configured. It is never called. */
export class UnavailableRouteProvider implements RouteProvider {
  public readonly name = "none" as const;
  public readonly available = false;

  public plan(): Promise<RouteProviderResult> {
    return Promise.reject(new Error("No route provider is configured"));
  }
}
