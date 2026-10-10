import { ValidationPipe } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { requireKey } from "./route-planning.controller.js";
import { DeferRouteOrderDto, PlanRouteDto, ReplanRouteDto } from "./route-planning.dto.js";

const pipe = new ValidationPipe({ forbidNonWhitelisted: true, transform: true, whitelist: true });

async function validate<T>(metatype: new () => T, value: unknown): Promise<T> {
  return pipe.transform(value, { metatype, type: "body" }) as Promise<T>;
}

describe("route planning DTOs", () => {
  it("accepts an empty plan body and a GPS start", async () => {
    await expect(validate(PlanRouteDto, {})).resolves.toBeDefined();
    await expect(
      validate(PlanRouteDto, { startLatitude: 25.2, startLongitude: 55.3 }),
    ).resolves.toMatchObject({ startLatitude: 25.2 });
  });

  it("rejects an undeclared field (forbidNonWhitelisted)", async () => {
    await expect(validate(PlanRouteDto, { driverId: "x" })).rejects.toThrow();
  });

  it("rejects coordinates out of range and a non-uuid Area", async () => {
    await expect(
      validate(PlanRouteDto, { startLatitude: 95, startLongitude: 55 }),
    ).rejects.toThrow();
    await expect(validate(PlanRouteDto, { startAreaId: "dubai" })).rejects.toThrow();
  });

  it("requires a positive integer revision", async () => {
    await expect(validate(ReplanRouteDto, {})).rejects.toThrow();
    await expect(validate(ReplanRouteDto, { expectedRevision: 0 })).rejects.toThrow();
    await expect(
      validate(DeferRouteOrderDto, { orderId: "not-a-uuid", expectedRevision: 1 }),
    ).rejects.toThrow();
  });

  it("requires an idempotency key of 8 to 200 characters", () => {
    expect(() => requireKey(undefined)).toThrow();
    expect(() => requireKey("short")).toThrow();
    expect(requireKey("  plan-0001  ")).toBe("plan-0001");
  });
});

describe("route setup and Platform DTOs", () => {
  it("requires both coordinates for a pin or the branch", async () => {
    const { RoutePointDto } = await import("./route-planning.dto.js");
    await expect(validate(RoutePointDto, { latitude: 25.2 })).rejects.toThrow();
    await expect(validate(RoutePointDto, { latitude: 25.2, longitude: 200 })).rejects.toThrow();
    await expect(
      validate(RoutePointDto, { latitude: "25.2", longitude: "55.3" }),
    ).resolves.toMatchObject({ latitude: 25.2 });
  });

  it("Platform update takes no provider (fixed to the free engine) and a version", async () => {
    const { UpdateCompanyRouteOptimizationDto } =
      await import("../platform/platform-route-optimization.dto.js");
    await expect(
      validate(UpdateCompanyRouteOptimizationDto, {
        isEnabled: true,
        dailyCallBudget: 10,
        expectedVersion: 0,
        provider: "google_routes",
      }),
    ).rejects.toThrow();
    await expect(
      validate(UpdateCompanyRouteOptimizationDto, { isEnabled: true, dailyCallBudget: 10 }),
    ).rejects.toThrow();
    await expect(
      validate(UpdateCompanyRouteOptimizationDto, {
        isEnabled: true,
        dailyCallBudget: 10,
        expectedVersion: 0,
      }),
    ).resolves.toBeDefined();
  });
});
