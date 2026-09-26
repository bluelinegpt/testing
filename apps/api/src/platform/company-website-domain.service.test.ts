import { describe, expect, it } from "vitest";
import { normalizeCustomDomainHostname } from "./company-website-domain.service.js";
describe("Delivery Company website custom domains", () => {
  it.each([
    ["Dana.COM", "dana.com"],
    ["delivery.dana.com.", "delivery.dana.com"],
  ])("normalizes %s", (input, expected) =>
    expect(normalizeCustomDomainHostname(input, "tawseelhub.com")).toBe(expected),
  );
  it.each([
    "https://dana.com",
    "dana.com/contact",
    "*.dana.com",
    "dana.tawseelhub.com",
    "danaapp.tawseelhub.com",
    "127.0.0.1",
    "localhost",
    "dána.com",
    "xn--dna-ula.com",
    "example.com",
    "a..com",
    "dana.c",
  ])("rejects unsafe or reserved hostname %s", (hostname) =>
    expect(() => normalizeCustomDomainHostname(hostname, "tawseelhub.com")).toThrow(),
  );
});
