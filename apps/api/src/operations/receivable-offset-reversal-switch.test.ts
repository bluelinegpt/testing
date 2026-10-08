import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { RECEIVABLE_OFFSET_REVERSAL_ENABLED } from "./receivable-offset-reversal-switch.js";

describe("Single-receivable offset reversal kill switch", () => {
  const controller = readFileSync(resolve(process.cwd(), "src/operations/trader-receivable.controller.ts"), "utf8");

  it("is disabled until Settlements can apply Trader Credits", () => {
    expect(RECEIVABLE_OFFSET_REVERSAL_ENABLED).toBe(false);
  });

  it("refuses the execute route with a 409 before calling the service, and marks the preview as not executable", () => {
    const execute = controller.slice(controller.indexOf('@Post(":receivableId/reverse")'));
    expect(execute.indexOf("if (!RECEIVABLE_OFFSET_REVERSAL_ENABLED)")).toBeGreaterThan(-1);
    expect(execute.indexOf("if (!RECEIVABLE_OFFSET_REVERSAL_ENABLED)")).toBeLessThan(execute.indexOf("this.offsetReversals.execute("));
    expect(execute).toContain("HttpStatus.CONFLICT");
    expect(controller).toContain("executionAvailable: false,");
  });
});
