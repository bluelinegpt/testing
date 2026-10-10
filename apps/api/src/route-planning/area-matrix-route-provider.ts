import { Injectable } from "@nestjs/common";

import type {
  RoutePoint,
  RouteProvider,
  RouteProviderRequest,
  RouteProviderResult,
  RouteProviderStop,
} from "./route-provider.js";

/**
 * The stored-pin Area engine (decision 10 Oct 2026: no per-run cost).
 *
 * Works only from the Area centres administrators pin once. Distances are
 * straight-line (haversine) times a road factor -- at Area level the
 * question is only "Deira before Al Barsha", which straight-line distance
 * answers well, and a Driver who knows the roads can always reorder. No
 * external call is made, so there is no quota, no key and no bill, and it
 * works offline. A stored road-time matrix can replace `travel()` later
 * without changing anything else.
 *
 * Rules, from Aiman (10 Oct 2026):
 * - A run may cross Emirates (a small run: 5 Ajman + 5 Sharjah, or 3 Ajman +
 *   10 Ras Al Khaimah). Each Emirate is worked as one block -- the route never
 *   zig-zags between Emirates.
 * - The run usually ends back at the branch to hand over the cash, so the
 *   last block and the last Area are chosen to finish near the branch.
 */
const EARTH_RADIUS_METERS = 6_371_000;
/** Straight-line to road distance in UAE cities, a deliberate rough factor. */
const ROAD_FACTOR = 1.3;
/** Average urban driving speed used only for the displayed estimate. */
const AVERAGE_SPEED_METERS_PER_SECOND = 40_000 / 3600;
/** Above this many Emirate blocks, block order uses nearest-neighbour. */
const EXACT_BLOCK_ORDER_LIMIT = 7;

export function haversineMeters(a: RoutePoint, b: RoutePoint): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function travel(a: RoutePoint, b: RoutePoint): number {
  return haversineMeters(a, b) * ROAD_FACTOR;
}

function centroid(points: readonly RoutePoint[]): RoutePoint {
  const sum = points.reduce(
    (total, point) => ({
      latitude: total.latitude + point.latitude,
      longitude: total.longitude + point.longitude,
    }),
    { latitude: 0, longitude: 0 },
  );
  return { latitude: sum.latitude / points.length, longitude: sum.longitude / points.length };
}

/** Length of an open path, including the legs from `start` and to `end`. */
function pathLength(
  start: RoutePoint | null,
  path: readonly RoutePoint[],
  end: RoutePoint | null,
): number {
  let total = 0;
  let previous = start;
  for (const point of path) {
    if (previous !== null) total += travel(previous, point);
    previous = point;
  }
  if (previous !== null && end !== null) total += travel(previous, end);
  return total;
}

/** Nearest-neighbour from `start`, then 2-opt with both ends fixed. */
export function orderWithinBlock<T extends RoutePoint>(
  stops: readonly T[],
  start: RoutePoint | null,
  end: RoutePoint | null,
): T[] {
  if (stops.length <= 1) return [...stops];
  const remaining = [...stops];
  const path: T[] = [];
  let current = start;
  while (remaining.length > 0) {
    let bestIndex = 0;
    if (current !== null) {
      let bestDistance = Number.POSITIVE_INFINITY;
      remaining.forEach((stop, index) => {
        const distance = travel(current as RoutePoint, stop);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
    }
    const [next] = remaining.splice(bestIndex, 1) as [T];
    path.push(next);
    current = next;
  }
  let improved = true;
  let guard = 0;
  while (improved && guard < 200) {
    improved = false;
    guard += 1;
    for (let i = 0; i < path.length - 1; i += 1) {
      for (let k = i + 1; k < path.length; k += 1) {
        const candidate = [
          ...path.slice(0, i),
          ...path.slice(i, k + 1).reverse(),
          ...path.slice(k + 1),
        ];
        if (pathLength(start, candidate, end) + 1e-6 < pathLength(start, path, end)) {
          path.splice(0, path.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  return path;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

/** Order Emirate blocks by their centres, ending nearest the branch. */
function orderBlocks(
  blocks: readonly { readonly emirateId: string; readonly center: RoutePoint }[],
  start: RoutePoint | null,
  end: RoutePoint | null,
): string[] {
  if (blocks.length <= 1) return blocks.map((block) => block.emirateId);
  if (blocks.length <= EXACT_BLOCK_ORDER_LIMIT) {
    let best: string[] = [];
    let bestLength = Number.POSITIVE_INFINITY;
    for (const order of permutations(blocks)) {
      const length = pathLength(
        start,
        order.map((block) => block.center),
        end,
      );
      if (length < bestLength - 1e-6) {
        bestLength = length;
        best = order.map((block) => block.emirateId);
      }
    }
    return best;
  }
  return orderWithinBlock(
    blocks.map((block) => ({ ...block.center, emirateId: block.emirateId })),
    start,
    end,
  ).map((block) => block.emirateId);
}

export function sequenceAreas(request: RouteProviderRequest): {
  readonly orderedAreaIds: string[];
  readonly distanceMeters: number;
} {
  const byEmirate = new Map<string, RouteProviderStop[]>();
  for (const stop of request.stops) {
    const list = byEmirate.get(stop.emirateId) ?? [];
    list.push(stop);
    byEmirate.set(stop.emirateId, list);
  }
  // Deterministic input order, so the same stops always give the same route.
  for (const list of byEmirate.values()) list.sort((a, b) => a.areaId.localeCompare(b.areaId));
  const blocks = [...byEmirate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([emirateId, stops]) => ({ emirateId, center: centroid(stops) }));
  const blockOrder = orderBlocks(blocks, request.start, request.end);
  const centerOf = new Map(blocks.map((block) => [block.emirateId, block.center]));

  const ordered: RouteProviderStop[] = [];
  let entry = request.start;
  blockOrder.forEach((emirateId, index) => {
    const nextEmirate = blockOrder[index + 1];
    const exit = nextEmirate === undefined ? request.end : (centerOf.get(nextEmirate) ?? null);
    const path = orderWithinBlock(byEmirate.get(emirateId) ?? [], entry, exit);
    ordered.push(...path);
    entry = path.at(-1) ?? entry;
  });
  return {
    orderedAreaIds: ordered.map((stop) => stop.areaId),
    distanceMeters: Math.round(pathLength(request.start, ordered, request.end)),
  };
}

@Injectable()
export class AreaMatrixRouteProvider implements RouteProvider {
  public readonly name = "area_matrix" as const;
  public readonly available = true;
  public readonly metered = false;
  public readonly maxStops = 60;

  public plan(request: RouteProviderRequest): Promise<RouteProviderResult> {
    const { orderedAreaIds, distanceMeters } = sequenceAreas(request);
    return Promise.resolve({
      orderedAreaIds,
      distanceMeters,
      durationSeconds: Math.round(distanceMeters / AVERAGE_SPEED_METERS_PER_SECOND),
    });
  }
}
