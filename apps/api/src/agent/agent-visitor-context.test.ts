import { describe, expect, it } from "vitest";

import { coarseUserAgent, trustedCountryCode } from "./agent.controller.js";

describe("Agent visitor context", () => {
  it("accepts country only from the Cloudflare request context", () => {
    expect(trustedCountryCode({ "cf-ipcountry": "ae", "cf-ray": "ray-id" } as never, true)).toBe("AE");
    expect(trustedCountryCode({ "cf-ipcountry": "SA" } as never, true)).toBeUndefined();
    expect(trustedCountryCode({ "cf-ipcountry": "AE", "cf-ray": "spoofed" } as never, false)).toBeUndefined();
    expect(trustedCountryCode({ "x-country": "AE" } as never, true)).toBeUndefined();
  });

  it("derives only coarse device, browser and OS families", () => {
    expect(coarseUserAgent("Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile")).toEqual({
      browserFamily: "Chrome",
      deviceCategory: "mobile",
      operatingSystemFamily: "Android",
    });
  });
});
