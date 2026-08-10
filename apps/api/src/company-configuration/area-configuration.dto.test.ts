import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";

import { AreaListQueryDto, AreaSearchQueryDto } from "./area-configuration.dto.js";

describe("AreaSearchQueryDto", () => {
  it.each([
    ["true", true],
    ["false", false],
  ])("converts query-string activeOnly=%s to %s", async (raw, expected) => {
    const input = plainToInstance(AreaSearchQueryDto, { activeOnly: raw });
    await expect(validate(input)).resolves.toEqual([]);
    expect(input.activeOnly).toBe(expected);
  });

  it("rejects an invalid activeOnly value", async () => {
    const input = plainToInstance(AreaSearchQueryDto, { activeOnly: "yes" });
    const errors = await validate(input);
    expect(errors.map((error) => error.property)).toContain("activeOnly");
  });

  it("accepts the browser area-search query string", async () => {
    const input = plainToInstance(AreaSearchQueryDto, {
      activeOnly: "true",
      emirateId: "e57d2626-3fa4-46f5-b4c8-935a903a6957",
      limit: "20",
      offset: "0",
      search: "",
    });

    await expect(validate(input)).resolves.toEqual([]);
    expect(input.limit).toBe(20);
    expect(input.offset).toBe(0);
  });
});

describe("AreaListQueryDto", () => {
  it("accepts the browser area-list paging query string", async () => {
    const input = plainToInstance(AreaListQueryDto, {
      page: "1",
      pageSize: "25",
      status: "all",
    });

    await expect(validate(input)).resolves.toEqual([]);
    expect(input.page).toBe(1);
    expect(input.pageSize).toBe(25);
  });
});
