import { describe, expect, it } from "vitest";

import { isAllowedCompanyWebsitePreviewParent } from "./preview-origin.js";

describe("Company Website preview parent origins", () => {
  it.each([
    "http://127.0.0.1:5176",
    "http://localhost:5176",
    "https://platform.tawseelhub.com",
    "https://bluelinegpt-platform-test.onrender.com",
  ])("allows the authorized Platform origin %s", (origin) => {
    expect(isAllowedCompanyWebsitePreviewParent(origin)).toBe(true);
  });

  it("rejects unrelated framing origins", () => {
    expect(isAllowedCompanyWebsitePreviewParent("https://example.com")).toBe(false);
  });
});
