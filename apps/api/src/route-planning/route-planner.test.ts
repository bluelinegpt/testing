import { describe, expect, it, vi } from "vitest";

import {
  collapseDuplicateAreas,
  deferOrder,
  fallbackOrder,
  planRoute,
  reverseStops,
  type RouteArea,
  type RoutePlanInput,
} from "./route-planner.js";
import { ROUTE_PROVIDER_WAYPOINT_CEILING, type RouteProvider } from "./route-provider.js";

function area(
  id: string,
  name: string,
  options: { verified?: boolean; emirate?: string; order?: number } = {},
): RouteArea {
  const verified = options.verified ?? true;
  return {
    id,
    emirateId: options.emirate ?? "dubai",
    emirateOrder: options.order ?? 1,
    nameEn: name,
    latitude: verified ? 25.2 : null,
    longitude: verified ? 55.3 : null,
    coordinatesVerified: verified,
  };
}

/** A paid engine double: metered, 25 stops per request, counts its calls. */
function provider(
  orderedAreaIds?: (ids: string[]) => string[],
): RouteProvider & { plan: ReturnType<typeof vi.fn> } {
  return {
    name: "google_routes",
    available: true,
    metered: true,
    maxStops: ROUTE_PROVIDER_WAYPOINT_CEILING,
    plan: vi.fn((request: { stops: readonly { areaId: string }[] }) => {
      const ids = request.stops.map((stop) => stop.areaId);
      return Promise.resolve({
        orderedAreaIds: orderedAreaIds ? orderedAreaIds(ids) : ids,
        responseId: "r1",
      });
    }),
  };
}

function input(
  overrides: Partial<RoutePlanInput> & { areas: readonly RouteArea[] },
): RoutePlanInput {
  return {
    gate: { companyEnabled: true, platformEnabled: true },
    provider: provider(),
    start: null,
    end: null,
    reserveCall: () => Promise.resolve(true),
    ...overrides,
  };
}

describe("planRoute gates", () => {
  it("makes no reservation and no engine call when the Company is disabled", async () => {
    const engine = provider();
    const reserveCall = vi.fn(() => Promise.resolve(true));
    const result = await planRoute(
      input({
        areas: [area("a", "Al Barsha")],
        provider: engine,
        reserveCall,
        gate: { companyEnabled: false, platformEnabled: true },
      }),
    );
    expect(result).toMatchObject({
      resultSource: "fallback",
      fallbackReason: "disabled",
      reserved: false,
    });
    expect(engine.plan).not.toHaveBeenCalled();
    expect(reserveCall).not.toHaveBeenCalled();
  });

  it("the Platform kill switch wins over an enabled Company", async () => {
    const engine = provider();
    const reserveCall = vi.fn(() => Promise.resolve(true));
    const result = await planRoute(
      input({
        areas: [area("a", "Al Barsha")],
        provider: engine,
        reserveCall,
        gate: { companyEnabled: true, platformEnabled: false },
      }),
    );
    expect(result.fallbackReason).toBe("kill_switch");
    expect(engine.plan).not.toHaveBeenCalled();
    expect(reserveCall).not.toHaveBeenCalled();
  });

  it("falls back without spending the budget when no Area has a verified pin", async () => {
    const engine = provider();
    const reserveCall = vi.fn(() => Promise.resolve(true));
    const result = await planRoute(
      input({
        areas: [area("a", "Al Barsha", { verified: false })],
        provider: engine,
        reserveCall,
      }),
    );
    expect(result.fallbackReason).toBe("unverified_coordinates");
    expect(result.stops).toEqual([{ areaId: "a", isSequenced: false }]);
    expect(reserveCall).not.toHaveBeenCalled();
    expect(engine.plan).not.toHaveBeenCalled();
  });

  it("never reserves or calls when no provider is configured", async () => {
    const reserveCall = vi.fn(() => Promise.resolve(true));
    const unavailable: RouteProvider = {
      name: "none",
      available: false,
      metered: true,
      maxStops: 25,
      plan: vi.fn(),
    };
    const result = await planRoute(
      input({ areas: [area("a", "Al Barsha")], provider: unavailable, reserveCall }),
    );
    expect(result.fallbackReason).toBe("provider_unavailable");
    expect(reserveCall).not.toHaveBeenCalled();
    expect(unavailable.plan).not.toHaveBeenCalled();
  });

  it("falls back, and records the reservation, when the daily budget is used up", async () => {
    const engine = provider();
    const result = await planRoute(
      input({
        areas: [area("a", "Al Barsha")],
        provider: engine,
        reserveCall: () => Promise.resolve(false),
      }),
    );
    expect(result).toMatchObject({
      resultSource: "fallback",
      fallbackReason: "budget",
      reserved: true,
    });
    expect(engine.plan).not.toHaveBeenCalled();
  });

  it("calls the engine once and never retries on failure", async () => {
    const failing: RouteProvider & { plan: ReturnType<typeof vi.fn> } = {
      name: "google_routes",
      available: true,
      metered: true,
      maxStops: 25,
      plan: vi.fn(() => Promise.reject(new Error("503"))),
    };
    const result = await planRoute(
      input({ areas: [area("a", "Al Barsha"), area("b", "Deira")], provider: failing }),
    );
    expect(result).toMatchObject({
      resultSource: "fallback",
      fallbackReason: "provider_error",
      reserved: true,
    });
    expect(failing.plan).toHaveBeenCalledTimes(1);
  });
});

describe("planRoute with the free stored-pin engine", () => {
  it("never reserves budget for an unmetered engine, even when the budget is used up", async () => {
    const reserveCall = vi.fn(() => Promise.resolve(false));
    const free: RouteProvider & { plan: ReturnType<typeof vi.fn> } = {
      ...provider(),
      name: "area_matrix",
      metered: false,
      maxStops: 60,
    };
    const result = await planRoute(
      input({ areas: [area("a", "Al Barsha"), area("b", "Deira")], provider: free, reserveCall }),
    );
    expect(result).toMatchObject({ resultSource: "provider", reserved: false });
    expect(reserveCall).not.toHaveBeenCalled();
    expect(free.plan).toHaveBeenCalledTimes(1);
  });

  it("passes the end point and each stop's Emirate to the engine", async () => {
    const engine = provider();
    const branch = { latitude: 25.3, longitude: 55.4 };
    await planRoute(input({ areas: [area("a", "Al Barsha")], provider: engine, end: branch }));
    expect(engine.plan.mock.calls[0]?.[0]).toMatchObject({
      end: branch,
      stops: [{ areaId: "a", emirateId: "dubai" }],
    });
  });
});

describe("planRoute ordering", () => {
  it("uses the engine order for verified Areas and lists unverified ones unsequenced at the end", async () => {
    const engine = provider((ids) => [...ids].reverse());
    const result = await planRoute(
      input({
        areas: [
          area("a", "Al Barsha"),
          area("b", "Deira"),
          area("c", "Western Region", { verified: false }),
        ],
        provider: engine,
      }),
    );
    expect(result.resultSource).toBe("provider");
    expect(result.stops).toEqual([
      { areaId: "b", isSequenced: true },
      { areaId: "a", isSequenced: true },
      { areaId: "c", isSequenced: false },
    ]);
    expect(result.partialOptimization).toBe(false);
  });

  it("collapses duplicate Area names in one Emirate to a single stop", async () => {
    const engine = provider();
    const result = await planRoute(
      input({
        areas: [
          area("a2", "Al  Barsha"),
          area("a1", "al barsha"),
          area("x", "Al Barsha", { emirate: "sharjah", order: 3 }),
        ],
        provider: engine,
      }),
    );
    expect(result.stops.map((stop) => stop.areaId).sort()).toEqual(["a1", "x"]);
    expect(engine.plan.mock.calls[0]?.[0].stops).toHaveLength(2);
  });

  it("above the waypoint ceiling: partial optimization plus fallback, nothing truncated, one call", async () => {
    const areas = Array.from({ length: ROUTE_PROVIDER_WAYPOINT_CEILING + 3 }, (_, index) =>
      area(`id-${String(index).padStart(2, "0")}`, `Area ${String(index).padStart(2, "0")}`),
    );
    const engine = provider((ids) => [...ids].reverse());
    const result = await planRoute(input({ areas, provider: engine }));
    expect(engine.plan).toHaveBeenCalledTimes(1);
    expect(engine.plan.mock.calls[0]?.[0].stops).toHaveLength(ROUTE_PROVIDER_WAYPOINT_CEILING);
    expect(result.partialOptimization).toBe(true);
    expect(result.stops).toHaveLength(areas.length);
    expect(result.stops.filter((stop) => stop.isSequenced)).toHaveLength(
      ROUTE_PROVIDER_WAYPOINT_CEILING,
    );
    expect(result.stops.slice(-3).map((stop) => stop.areaId)).toEqual(["id-25", "id-26", "id-27"]);
  });

  it("ignores ids the engine invents and keeps every Area", async () => {
    const engine = provider(() => ["ghost", "b"]);
    const result = await planRoute(
      input({ areas: [area("a", "Al Barsha"), area("b", "Deira")], provider: engine }),
    );
    expect(result.stops.map((stop) => stop.areaId)).toEqual(["b", "a"]);
    expect(result.partialOptimization).toBe(true);
  });

  it("fallback order is Emirate display order, then name, then id", () => {
    const ordered = fallbackOrder([
      area("3", "Rolla", { emirate: "sharjah", order: 3 }),
      area("2", "Deira"),
      area("1", "Al Barsha"),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["1", "2", "3"]);
  });

  it("maps every duplicate to its representative, preferring a verified Area", () => {
    const { representativeOf } = collapseDuplicateAreas([
      area("z-verified", "Al Qusais"),
      area("a-unverified", "Al Qusais", { verified: false }),
    ]);
    expect(representativeOf.get("a-unverified")).toBe("z-verified");
  });
});

describe("reverse and defer", () => {
  it("reverses the sequenced stops in code and keeps unsequenced ones last", () => {
    expect(
      reverseStops([
        { areaId: "a", isSequenced: true },
        { areaId: "b", isSequenced: true },
        { areaId: "c", isSequenced: false },
      ]).map((stop) => stop.areaId),
    ).toEqual(["b", "a", "c"]);
  });

  it("reverses a fallback run as a whole", () => {
    expect(
      reverseStops([
        { areaId: "a", isSequenced: false },
        { areaId: "b", isSequenced: false },
      ]).map((stop) => stop.areaId),
    ).toEqual(["b", "a"]);
  });

  it("defer moves an Order to the end, once", () => {
    expect(deferOrder(["x", "y"], "x")).toEqual(["y", "x"]);
    expect(deferOrder([], "x")).toEqual(["x"]);
  });
});
