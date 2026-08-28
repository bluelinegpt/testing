import type { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";

import type { AppConfiguration } from "../configuration/environment.js";

import { CompanyHostResolver } from "./company-host-resolver.js";

function createResolver(tenancy: {
  developmentCompanySubdomain?: string | undefined;
  hostSuffix?: string | undefined;
}) {
  const config = {
    get: (key: string) =>
      key === "tenancy.hostSuffix" ? tenancy.hostSuffix : tenancy.developmentCompanySubdomain,
  } as unknown as ConfigService<AppConfiguration, true>;
  return new CompanyHostResolver(config);
}

describe("CompanyHostResolver", () => {
  it("resolves the tenant label from a branded Company host", () => {
    const resolver = createResolver({ hostSuffix: "tawseelhub.com" });
    expect(resolver.resolve("danaapp.tawseelhub.com")).toBe("dana");
    expect(resolver.resolve("speedapp.tawseelhub.com")).toBe("speed");
  });

  it("ignores the port when matching the host", () => {
    const resolver = createResolver({ hostSuffix: "tawseelhub.com" });
    expect(resolver.resolve("danaapp.tawseelhub.com:443")).toBe("dana");
  });

  it("falls back to the configured development Company for a bare host", () => {
    const resolver = createResolver({
      developmentCompanySubdomain: "dev",
      hostSuffix: "tawseelhub.com",
    });
    expect(resolver.resolve("localhost:5174")).toBe("dev");
    expect(resolver.resolve("127.0.0.1:3000")).toBe("dev");
  });

  it("resolves nothing when no host matches and no development fallback is set", () => {
    const resolver = createResolver({ hostSuffix: "tawseelhub.com" });
    expect(resolver.resolve("localhost:5174")).toBeUndefined();
    expect(resolver.resolve(undefined)).toBeUndefined();
  });

  it("refuses to guess a tenant from an ambiguous multi-label host", () => {
    const resolver = createResolver({ hostSuffix: "tawseelhub.com" });
    // "a.b.bluelinegpt.com" must not silently resolve to "a".
    expect(resolver.resolve("a.b.tawseelhub.com")).toBeUndefined();
  });

  it("does not treat the marketing host as a tenant", () => {
    const resolver = createResolver({ hostSuffix: "tawseelhub.com" });
    expect(resolver.resolve("www.tawseelhub.com")).toBeUndefined();
  });

  it("does not resolve a host that merely ends with the suffix text", () => {
    const resolver = createResolver({ hostSuffix: "tawseelhub.com" });
    // An attacker-controlled "evilbluelinegpt.com" must not match.
    expect(resolver.resolve("eviltawseelhub.com")).toBeUndefined();
  });

  it("prefers the host tenant over the development fallback", () => {
    const resolver = createResolver({
      developmentCompanySubdomain: "dev",
      hostSuffix: "tawseelhub.com",
    });
    expect(resolver.resolve("acmeapp.tawseelhub.com")).toBe("acme");
  });

  it("does not interpret the public Company website as the operational app", () => {
    const resolver = createResolver({ hostSuffix: "tawseelhub.com" });
    expect(resolver.resolve("dana.tawseelhub.com")).toBeUndefined();
  });

  it("rejects unknown and malformed app labels safely", () => {
    const resolver = createResolver({ hostSuffix: "tawseelhub.com" });
    expect(resolver.resolve("app.tawseelhub.com")).toBeUndefined();
    expect(resolver.resolve("-danaapp.tawseelhub.com")).toBeUndefined();
    expect(resolver.resolve("dana_app.tawseelhub.com")).toBeUndefined();
  });

  it("classifies public websites and operational apps without confusing them", () => {
    const resolver = createResolver({ hostSuffix: "tawseelhub.com" });
    expect(resolver.classifyTawseelhubHost("dana.tawseelhub.com")).toEqual({
      kind: "company_website",
      slug: "dana",
    });
    expect(resolver.classifyTawseelhubHost("danaapp.tawseelhub.com")).toEqual({
      kind: "company_app",
      slug: "dana",
    });
    expect(resolver.classifyTawseelhubHost("unknown.example.com")).toEqual({ kind: "unknown" });
    expect(resolver.classifyTawseelhubHost("a.b.tawseelhub.com")).toEqual({ kind: "unknown" });
  });
});
