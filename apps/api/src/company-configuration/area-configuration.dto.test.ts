import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";

import { AreaSearchQueryDto } from "./area-configuration.dto.js";

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
});
