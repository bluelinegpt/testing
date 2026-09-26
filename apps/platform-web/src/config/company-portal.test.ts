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

  it("keeps distinct Company tenant hosts in local development", () => {
    vi.stubGlobal("location", { hostname: "localhost", protocol: "http:" });

    expect(companyPortalUrl("dana")).toBe("http://danaapp.localhost:5177");
    expect(companyPortalUrl("speed")).toBe("http://speedapp.localhost:5177");
  });
});
