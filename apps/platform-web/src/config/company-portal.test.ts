import { afterEach, describe, expect, it, vi } from "vitest";

import { companyPortalUrl } from "./company-portal";

afterEach(() => vi.unstubAllGlobals());

describe("companyPortalUrl", () => {
  it("uses the operational app hostname convention in production", () => {
    vi.stubGlobal("location", { hostname: "platform.tawseelhub.com", protocol: "https:" });
    expect(companyPortalUrl("dana")).toBe("https://danaapp.tawseelhub.com");
  });

  it("uses the operational app hostname from Render", () => {
    vi.stubGlobal("location", {
      hostname: "bluelinegpt-platform-test.onrender.com",
      protocol: "https:",
    });
    expect(companyPortalUrl("speed")).toBe("https://speedapp.tawseelhub.com");
  });
});
