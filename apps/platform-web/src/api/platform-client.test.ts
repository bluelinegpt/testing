import { describe, expect, it } from "vitest";

import { platformApiErrorMessage } from "./platform-client.js";

describe("Platform API user-facing errors", () => {
  it("explains temporary proxy and service failures without claiming a save succeeded", () => {
    expect(platformApiErrorMessage(502, undefined)).toMatch(/could not reach.*not saved/iu);
    expect(platformApiErrorMessage(503, undefined)).toMatch(/temporarily unavailable.*not saved/iu);
  });

  it("gives a bounded retry instruction for rate limiting", () => {
    expect(platformApiErrorMessage(429, undefined)).toMatch(/wait one minute/iu);
  });

  it("preserves safe business validation messages", () => {
    expect(platformApiErrorMessage(422, "Website slug is invalid")).toBe("Website slug is invalid");
  });
});
