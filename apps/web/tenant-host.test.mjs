import { describe, expect, it } from "vitest";

import {
  classifyCompanyAppHost,
  isValidExternalWebsiteHost,
  parseLegacyTenantRedirects,
} from "./tenant-host.mjs";

describe("Company application host routing", () => {
  it("accepts the app convention and preserves localhost development", () => {
    expect(classifyCompanyAppHost("danaapp.tawseelhub.com", "tawseelhub.com")).toBe("company-app");
    expect(classifyCompanyAppHost("speedapp.tawseelhub.com:443", "tawseelhub.com")).toBe(
      "company-app",
    );
    expect(classifyCompanyAppHost("localhost:5174", "tawseelhub.com")).toBe("local");
  });

  it("distinguishes public Company websites from app hosts", () => {
    expect(classifyCompanyAppHost("dana.tawseelhub.com", "tawseelhub.com")).toBe("company-website");
    expect(classifyCompanyAppHost("danaapp.tawseelhub.com", "tawseelhub.com")).toBe("company-app");
  });

  it("rejects unknown and malformed hosts", () => {
    expect(classifyCompanyAppHost("danaapp.attacker.test", "tawseelhub.com")).toBe("rejected");
    expect(classifyCompanyAppHost("a.bapp.tawseelhub.com", "tawseelhub.com")).toBe("rejected");
    expect(classifyCompanyAppHost("app.tawseelhub.com", "tawseelhub.com")).toBe("rejected");
  });
  it("allows only syntactically safe external website hosts for the public shell", () => {
    expect(isValidExternalWebsiteHost("dana.com", "tawseelhub.com")).toBe(true);
    expect(isValidExternalWebsiteHost("DANA.COM:443", "tawseelhub.com")).toBe(true);
    for (const host of [
      "dana.tawseelhub.com",
      "danaapp.tawseelhub.com",
      "xn--dna-ula.com",
      "*.dana.com",
      "127.0.0.1",
    ])
      expect(isValidExternalWebsiteHost(host, "tawseelhub.com")).toBe(false);
  });

  it("parses only explicit HTTPS legacy redirects", () => {
    const redirects = parseLegacyTenantRedirects(
      "dana.tawseelhub.com=https://danaapp.tawseelhub.com",
    );
    expect(redirects.get("dana.tawseelhub.com")).toBe("https://danaapp.tawseelhub.com");
    expect(() =>
      parseLegacyTenantRedirects("dana.tawseelhub.com=http://danaapp.tawseelhub.com"),
    ).toThrow();
  });
});
