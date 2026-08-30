import { describe, expect, it, vi } from "vitest";

import { PublicCompanyWebsiteController } from "./company-website.controller.js";

describe("PublicCompanyWebsiteController tenant host forwarding", () => {
  it("uses the original Website hostname forwarded by the production web proxy", async () => {
    const resolvePublic = vi.fn().mockResolvedValue({ availability: "published" });
    const controller = new PublicCompanyWebsiteController({ resolvePublic } as never, {} as never);

    await controller.get({
      headers: {
        host: "bluelinegpt-api-test.onrender.com",
        "x-blueline-tenant-host": "lahza.tawseelhub.com",
      },
      hostname: "bluelinegpt-api-test.onrender.com",
    } as never);

    expect(resolvePublic).toHaveBeenCalledWith("lahza.tawseelhub.com");
  });

  it("falls back to Host when the request did not pass through the web proxy", async () => {
    const resolvePublic = vi.fn().mockResolvedValue({ availability: "published" });
    const controller = new PublicCompanyWebsiteController({ resolvePublic } as never, {} as never);

    await controller.get({
      headers: { host: "lahza.tawseelhub.com" },
      hostname: "lahza.tawseelhub.com",
    } as never);

    expect(resolvePublic).toHaveBeenCalledWith("lahza.tawseelhub.com");
  });
});
