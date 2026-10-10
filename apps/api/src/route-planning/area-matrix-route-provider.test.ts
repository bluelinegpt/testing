import { describe, expect, it } from "vitest";

import {
  AreaMatrixRouteProvider,
  haversineMeters,
  orderWithinBlock,
  sequenceAreas,
} from "./area-matrix-route-provider.js";
import type { RouteProviderStop } from "./route-provider.js";

// Approximate Area centres, for geometry only.
const SHJ = "sharjah";
const AJM = "ajman";
const RAK = "rak";
const stop = (
  areaId: string,
  emirateId: string,
  latitude: number,
  longitude: number,
): RouteProviderStop => ({
  areaId,
  emirateId,
  latitude,
  longitude,
});
const sharjah = [
  stop("shj-rolla", SHJ, 25.358, 55.389),
  stop("shj-majaz", SHJ, 25.326, 55.383),
  stop("shj-nahda", SHJ, 25.302, 55.371),
];
const ajman = [
  stop("ajm-nuaimiya", AJM, 25.392, 55.453),
  stop("ajm-rashidiya", AJM, 25.408, 55.443),
];
const dubaiBranch = { latitude: 25.27, longitude: 55.38 };

describe("stored-pin Area engine", () => {
  it("measures straight-line distance in metres", () => {
    const meters = haversineMeters(
      { latitude: 25.2, longitude: 55.3 },
      { latitude: 25.3, longitude: 55.3 },
    );
    expect(meters).toBeGreaterThan(11_000);
    expect(meters).toBeLessThan(11_200);
  });

  it("works each Emirate as one block and finishes near the branch", () => {
    const result = sequenceAreas({
      start: { latitude: 25.41, longitude: 55.45 }, // GPS in Ajman
      end: dubaiBranch,
      stops: [...sharjah, ...ajman],
    });
    const emirates = result.orderedAreaIds.map((id) => id.slice(0, 3));
    expect(emirates).toEqual(["ajm", "ajm", "shj", "shj", "shj"]);
    // Sharjah, nearer Dubai, is worked last and ends at its southern Area.
    expect(result.orderedAreaIds.at(-1)).toBe("shj-nahda");
  });

  it("never interleaves Emirates, even for a small mixed run", () => {
    const result = sequenceAreas({
      start: dubaiBranch,
      end: dubaiBranch,
      stops: [
        stop("rak-nakheel", RAK, 25.79, 55.97),
        ...ajman,
        stop("rak-dafan", RAK, 25.78, 55.95),
      ],
    });
    const emirates = result.orderedAreaIds.map((id) => id.slice(0, 3));
    const changes = emirates.filter(
      (value, index) => index > 0 && value !== emirates[index - 1],
    ).length;
    expect(changes).toBe(1);
  });

  it("orders Areas along a line regardless of input order (nearest-neighbour + 2-opt)", () => {
    const line = [0.04, 0.01, 0.03, 0.0, 0.02].map((offset, index) =>
      stop(`p${offset.toFixed(2)}`, SHJ, 25.3 + offset, 55.4 + index * 0),
    );
    const ordered = orderWithinBlock(line, { latitude: 25.29, longitude: 55.4 }, null).map(
      (item) => item.areaId,
    );
    expect(ordered).toEqual(["p0.00", "p0.01", "p0.02", "p0.03", "p0.04"]);
  });

  it("is deterministic: the same stops always give the same route", () => {
    const request = { start: null, end: dubaiBranch, stops: [...ajman, ...sharjah] };
    const first = sequenceAreas(request).orderedAreaIds;
    const shuffled = sequenceAreas({
      ...request,
      stops: [...sharjah].reverse().concat([...ajman].reverse()),
    });
    expect(shuffled.orderedAreaIds).toEqual(first);
  });

  it("is free and local: unmetered, returns every Area with an estimate", async () => {
    const engine = new AreaMatrixRouteProvider();
    expect(engine).toMatchObject({ name: "area_matrix", available: true, metered: false });
    const result = await engine.plan({ start: dubaiBranch, end: dubaiBranch, stops: sharjah });
    expect([...result.orderedAreaIds].sort()).toEqual(sharjah.map((item) => item.areaId).sort());
    expect(result.distanceMeters).toBeGreaterThan(0);
    expect(result.durationSeconds).toBeGreaterThan(0);
  });
});
