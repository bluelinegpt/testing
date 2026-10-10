/**
 * The routing-engine boundary.
 *
 * Route planning never depends on a concrete engine. Each engine implements
 * this interface and the Company's `provider` setting picks one through the
 * registry. Decision 10 Oct 2026: the stored-pin Area engine
 * (`AreaMatrixRouteProvider`) is the default -- computed in our own code,
 * no external call, no per-run cost. `google_routes` has no implementation
 * yet and resolves to `UnavailableRouteProvider`, so selecting it can never
 * spend money by accident.
 */
export interface RoutePoint {
  readonly latitude: number;
  readonly longitude: number;
}

export interface RouteProviderStop extends RoutePoint {
  readonly areaId: string;
  readonly emirateId: string;
}

export interface RouteProviderRequest {
  /** Where the run begins: GPS, a chosen Area, or the branch. */
  readonly start: RoutePoint | null;
  /** Where the run ends -- usually the branch, to hand over cash. */
  readonly end: RoutePoint | null;
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
  /** True for a paid engine: each call is reserved against the daily budget. */
  readonly metered: boolean;
  /** Most stops one request may carry; Areas beyond it are listed unsequenced. */
  readonly maxStops: number;
  plan(request: RouteProviderRequest): Promise<RouteProviderResult>;
}

export interface RouteProviderRegistry {
  forCompany(provider: string): RouteProvider;
}

export const ROUTE_PROVIDERS = Symbol("ROUTE_PROVIDERS");

/** Hard ceiling on intermediate waypoints for one Google Routes request. */
export const ROUTE_PROVIDER_WAYPOINT_CEILING = 25;

/** Bound for an engine that is not configured. It is never called. */
export class UnavailableRouteProvider implements RouteProvider {
  public readonly available = false;
  public readonly metered = true;
  public readonly maxStops = ROUTE_PROVIDER_WAYPOINT_CEILING;

  public constructor(public readonly name: "google_routes" | "none" = "none") {}

  public plan(): Promise<RouteProviderResult> {
    return Promise.reject(new Error("No route provider is configured"));
  }
}
