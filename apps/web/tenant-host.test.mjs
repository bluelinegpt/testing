import { describe, expect, it } from "vitest";

import { classifyCompanyAppHost, parseLegacyTenantRedirects } from "./tenant-host.mjs";

describe("Company application host routing", () => {
  it("accepts the app convention and preserves localhost development", () => {
    expect(classifyCompanyAppHost("danaapp.tawseelhub.com", "tawseelhub.com")).toBe("company-app");
    expect(classifyCompanyAppHost("speedapp.tawseelhub.com:443", "tawseelhub.com")).toBe(
      "company-app",
    );
    expect(classifyCompanyAppHost("localhost:5174", "tawseelhub.com")).toBe("local");
  });

  it("rejects public, unknown, and malformed hosts", () => {
    expect(classifyCompanyAppHost("dana.tawseelhub.com", "tawseelhub.com")).toBe("rejected");
    expect(classifyCompanyAppHost("danaapp.attacker.test", "tawseelhub.com")).toBe("rejected");
    expect(classifyCompanyAppHost("a.bapp.tawseelhub.com", "tawseelhub.com")).toBe("rejected");
    expect(classifyCompanyAppHost("app.tawseelhub.com", "tawseelhub.com")).toBe("rejected");
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
