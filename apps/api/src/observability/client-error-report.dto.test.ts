import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";

import { ReportClientErrorDto } from "./client-error-report.dto.js";

/**
 * Error Handler follow-up prompt, §10: proves `sourceApp: "public-web"` is
 * now accepted (it was rejected before this fix — `apps/public-web`'s
 * reports have always failed validation), and that the allow-list is still
 * a real allow-list, not accidentally opened up to any string.
 */
describe("ReportClientErrorDto", () => {
  it("accepts sourceApp: public-web", async () => {
    const input = plainToInstance(ReportClientErrorDto, {
      message: "Uncaught client error",
      sourceApp: "public-web",
    });
    const errors = await validate(input);
    expect(errors).toEqual([]);
  });

  it.each(["web", "api", "platform-web", "store", "mobile"])(
    "still accepts the pre-existing sourceApp %s",
    async (sourceApp) => {
      const input = plainToInstance(ReportClientErrorDto, { message: "boom", sourceApp });
      const errors = await validate(input);
      expect(errors).toEqual([]);
    },
  );

  it("rejects an unknown sourceApp", async () => {
    const input = plainToInstance(ReportClientErrorDto, {
      message: "boom",
      sourceApp: "some-other-app",
    });
    const errors = await validate(input);
    expect(errors.map((error) => error.property)).toContain("sourceApp");
  });
});
