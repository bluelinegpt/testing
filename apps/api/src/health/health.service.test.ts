import { ServiceUnavailableException } from "@nestjs/common";
import { vi } from "vitest";

import type { DatabaseHealthService } from "../infrastructure/database/database-health.service.js";
import { HealthService } from "./health.service.js";

describe("HealthService", () => {
  it("reports liveness without exposing dependencies", () => {
    const database = { check: vi.fn() } as unknown as DatabaseHealthService;
    expect(new HealthService(database).live()).toEqual({
      status: "ok",
      version: expect.any(String),
    });
  });

  it("reports readiness when PostgreSQL responds", async () => {
    const database = {
      check: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseHealthService;
    await expect(new HealthService(database).ready()).resolves.toEqual({
      status: "ok",
      version: expect.any(String),
    });
  });

  it("returns a safe unavailable response when PostgreSQL fails", async () => {
    const database = {
      check: vi.fn().mockRejectedValue(new Error("connection detail")),
    } as unknown as DatabaseHealthService;
    await expect(new HealthService(database).ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
