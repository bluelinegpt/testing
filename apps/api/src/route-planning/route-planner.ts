import type { RoutePoint, RouteProvider, RouteProviderResult } from "./route-provider.js";

/**
 * Pure route-planning rules: which Areas are sequenced, in what order, and
 * whether the routing engine is called at all. No database, no Nest.
 *
 * The engine is called at most once per plan, never retried, and only when
 * every gate passes: Company enabled, Platform kill switch on, at least one
 * Area with a verified pin, a configured provider, and -- for a paid engine
 * only -- a successful budget reservation. Every other path is the
 * deterministic fallback ordering.
 */

export type RouteFallbackReason =
  | "disabled"
  | "kill_switch"
  | "unverified_coordinates"
  | "provider_unavailable"
  | "budget"
  | "provider_error";

export interface RouteArea {
  readonly id: string;
  readonly emirateId: string;
  /** Emirate display order; the first key of the fallback ordering. */
  readonly emirateOrder: number;
  readonly nameEn: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly coordinatesVerified: boolean;
}

export interface RouteGate {
  readonly companyEnabled: boolean;
  readonly platformEnabled: boolean;
}

export interface PlannedStop {
  readonly areaId: string;
  /** True only when the engine placed this Area. */
  readonly isSequenced: boolean;
}

export interface RoutePlanResult {
  readonly stops: readonly PlannedStop[];
  readonly resultSource: "provider" | "fallback";
  readonly fallbackReason: RouteFallbackReason | null;
  /** Engine used, but some verified Areas were beyond its waypoint ceiling. */
  readonly partialOptimization: boolean;
  readonly providerResult: RouteProviderResult | null;
  /** True when a budget reservation was taken (so the outcome must be recorded). */
  readonly reserved: boolean;
}

export interface RoutePlanInput {
  readonly areas: readonly RouteArea[];
  readonly gate: RouteGate;
  readonly provider: RouteProvider;
  readonly start: RoutePoint | null;
  /** Usually the branch: the Driver returns there to hand over cash. */
  readonly end: RoutePoint | null;
  /** Atomically reserves one paid engine call; resolves false when over budget. */
  readonly reserveCall: () => Promise<boolean>;
}

/** Name used to detect the same place entered twice in one Emirate. */
export function normalizeAreaName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Collapses Areas that share a normalized name inside one Emirate.
 *
 * Returns the representatives (a verified Area wins, then the lowest id) and
 * a map from every input Area id to its representative, so Orders filed under
 * a duplicate still land on the single stop for that place.
 */
export function collapseDuplicateAreas(areas: readonly RouteArea[]): {
  readonly representatives: readonly RouteArea[];
  readonly representativeOf: ReadonlyMap<string, string>;
} {
  const groups = new Map<string, RouteArea[]>();
  for (const area of areas) {
    const key = `${area.emirateId}\u0000${normalizeAreaName(area.nameEn)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [area]);
    else group.push(area);
  }
  const representatives: RouteArea[] = [];
  const representativeOf = new Map<string, string>();
  for (const group of groups.values()) {
    const chosen = [...group].sort(
      (a, b) =>
        Number(b.coordinatesVerified) - Number(a.coordinatesVerified) || a.id.localeCompare(b.id),
    )[0] as RouteArea;
    representatives.push(chosen);
    for (const member of group) representativeOf.set(member.id, chosen.id);
  }
  return { representatives, representativeOf };
}

/** Deterministic fallback: Emirate display order, then Area name, then id. */
export function fallbackOrder(areas: readonly RouteArea[]): readonly RouteArea[] {
  return [...areas].sort(
    (a, b) =>
      a.emirateOrder - b.emirateOrder ||
      normalizeAreaName(a.nameEn).localeCompare(normalizeAreaName(b.nameEn)) ||
      a.id.localeCompare(b.id),
  );
}

function hasVerifiedPin(
  area: RouteArea,
): area is RouteArea & { latitude: number; longitude: number } {
  return area.coordinatesVerified && area.latitude !== null && area.longitude !== null;
}

function fallback(
  areas: readonly RouteArea[],
  reason: RouteFallbackReason,
  reserved: boolean,
): RoutePlanResult {
  return {
    stops: fallbackOrder(areas).map((area) => ({ areaId: area.id, isSequenced: false })),
    resultSource: "fallback",
    fallbackReason: reason,
    partialOptimization: false,
    providerResult: null,
    reserved,
  };
}

export async function planRoute(input: RoutePlanInput): Promise<RoutePlanResult> {
  const { representatives } = collapseDuplicateAreas(input.areas);
  if (!input.gate.companyEnabled) return fallback(representatives, "disabled", false);
  if (!input.gate.platformEnabled) return fallback(representatives, "kill_switch", false);

  const ordered = fallbackOrder(representatives);
  const verified = ordered.filter(hasVerifiedPin);
  const unverified = ordered.filter((area) => !hasVerifiedPin(area));
  if (verified.length === 0) return fallback(representatives, "unverified_coordinates", false);
  if (!input.provider.available) return fallback(representatives, "provider_unavailable", false);
  const metered = input.provider.metered;
  if (metered && !(await input.reserveCall())) return fallback(representatives, "budget", true);

  const sent = verified.slice(0, input.provider.maxStops);
  let result: RouteProviderResult;
  try {
    result = await input.provider.plan({
      start: input.start,
      end: input.end,
      stops: sent.map((area) => ({
        areaId: area.id,
        emirateId: area.emirateId,
        latitude: area.latitude,
        longitude: area.longitude,
      })),
    });
  } catch {
    // One attempt only. A retry storm against a paid API is how a quota
    // becomes an invoice.
    return fallback(representatives, "provider_error", metered);
  }

  const sentIds = new Set(sent.map((area) => area.id));
  const placed: string[] = [];
  for (const id of result.orderedAreaIds) {
    if (sentIds.has(id) && !placed.includes(id)) placed.push(id);
  }
  const placedSet = new Set(placed);
  const leftOver = verified.filter((area) => !placedSet.has(area.id));
  return {
    stops: [
      ...placed.map((areaId) => ({ areaId, isSequenced: true })),
      ...leftOver.map((area) => ({ areaId: area.id, isSequenced: false })),
      ...unverified.map((area) => ({ areaId: area.id, isSequenced: false })),
    ],
    resultSource: "provider",
    fallbackReason: null,
    partialOptimization: leftOver.length > 0,
    providerResult: result,
    reserved: metered,
  };
}

/**
 * Reverse direction: the stored sequence reversed in our own code, never a
 * second engine call. Unsequenced Areas stay at the end in their order.
 */
export function reverseStops(stops: readonly PlannedStop[]): readonly PlannedStop[] {
  const sequenced = stops.filter((stop) => stop.isSequenced);
  const rest = stops.filter((stop) => !stop.isSequenced);
  if (sequenced.length === 0) return [...rest].reverse();
  return [...sequenced].reverse().concat(rest);
}

/** Defer: the Order moves to the end of the run. Only the run changes. */
export function deferOrder(deferred: readonly string[], orderId: string): readonly string[] {
  return [...deferred.filter((id) => id !== orderId), orderId];
}
