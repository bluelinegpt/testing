import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";

import {
  DailyOperationsSummaryOrdersQueryDto,
  DailyOperationsSummaryQueryDto,
  DailyOperationsSummaryTodayQueryDto,
} from "./daily-operations-summary.dto.js";

describe("DailyOperationsSummaryQueryDto — dateMode", () => {
  it("accepts a request that omits dateMode (defaulted by the service, not the DTO)", async () => {
    const input = plainToInstance(DailyOperationsSummaryQueryDto, {
      dateFrom: "2026-08-10",
      dateTo: "2026-08-10",
    });
    await expect(validate(input)).resolves.toEqual([]);
    expect(input.dateMode).toBeUndefined();
  });

  it("accepts business_day", async () => {
    const input = plainToInstance(DailyOperationsSummaryQueryDto, {
      dateFrom: "2026-08-10",
      dateMode: "business_day",
      dateTo: "2026-08-10",
    });
    await expect(validate(input)).resolves.toEqual([]);
  });

  it("accepts calendar_day", async () => {
    const input = plainToInstance(DailyOperationsSummaryQueryDto, {
      dateFrom: "2026-08-10",
      dateMode: "calendar_day",
      dateTo: "2026-08-10",
    });
    await expect(validate(input)).resolves.toEqual([]);
  });

  it("rejects an unrecognized dateMode rather than silently falling back", async () => {
    const input = plainToInstance(DailyOperationsSummaryQueryDto, {
      dateFrom: "2026-08-10",
      dateMode: "utc_day",
      dateTo: "2026-08-10",
    });
    const errors = await validate(input);
    expect(errors.map((error) => error.property)).toContain("dateMode");
  });
});

describe("DailyOperationsSummaryOrdersQueryDto — dateMode", () => {
  it("accepts calendar_day alongside a required driverId", async () => {
    const input = plainToInstance(DailyOperationsSummaryOrdersQueryDto, {
      dateFrom: "2026-08-10",
      dateMode: "calendar_day",
      dateTo: "2026-08-10",
      driverId: "3f6d6b0e-6b8a-4a8e-9a0f-7a2f5d6c9b1a",
    });
    await expect(validate(input)).resolves.toEqual([]);
  });

  it("rejects an unrecognized dateMode", async () => {
    const input = plainToInstance(DailyOperationsSummaryOrdersQueryDto, {
      dateFrom: "2026-08-10",
      dateMode: "gregorian",
      dateTo: "2026-08-10",
      driverId: "3f6d6b0e-6b8a-4a8e-9a0f-7a2f5d6c9b1a",
    });
    const errors = await validate(input);
    expect(errors.map((error) => error.property)).toContain("dateMode");
  });
});

describe("DailyOperationsSummaryTodayQueryDto", () => {
  it("accepts an empty request", async () => {
    const input = plainToInstance(DailyOperationsSummaryTodayQueryDto, {});
    await expect(validate(input)).resolves.toEqual([]);
  });

  it("accepts business_day and calendar_day", async () => {
    for (const dateMode of ["business_day", "calendar_day"]) {
      const input = plainToInstance(DailyOperationsSummaryTodayQueryDto, { dateMode });
      await expect(validate(input)).resolves.toEqual([]);
    }
  });

  it("rejects an unrecognized dateMode", async () => {
    const input = plainToInstance(DailyOperationsSummaryTodayQueryDto, { dateMode: "fiscal_day" });
    const errors = await validate(input);
    expect(errors.map((error) => error.property)).toContain("dateMode");
  });
});
