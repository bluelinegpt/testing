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
    const resolver = createResolver({ hostSuffix: "bluelinegpt.com" });
    expect(resolver.resolve("acme.bluelinegpt.com")).toBe("acme");
  });

  it("ignores the port when matching the host", () => {
    const resolver = createResolver({ hostSuffix: "bluelinegpt.com" });
    expect(resolver.resolve("acme.bluelinegpt.com:443")).toBe("acme");
  });

  it("falls back to the configured development Company for a bare host", () => {
    const resolver = createResolver({
      developmentCompanySubdomain: "dev",
      hostSuffix: "bluelinegpt.com",
    });
    expect(resolver.resolve("localhost:5174")).toBe("dev");
    expect(resolver.resolve("127.0.0.1:3000")).toBe("dev");
  });

  it("resolves nothing when no host matches and no development fallback is set", () => {
    const resolver = createResolver({ hostSuffix: "bluelinegpt.com" });
    expect(resolver.resolve("localhost:5174")).toBeUndefined();
    expect(resolver.resolve(undefined)).toBeUndefined();
  });

  it("refuses to guess a tenant from an ambiguous multi-label host", () => {
    const resolver = createResolver({ hostSuffix: "bluelinegpt.com" });
    // "a.b.bluelinegpt.com" must not silently resolve to "a".
    expect(resolver.resolve("a.b.bluelinegpt.com")).toBeUndefined();
  });

  it("does not treat the marketing host as a tenant", () => {
    const resolver = createResolver({ hostSuffix: "bluelinegpt.com" });
    expect(resolver.resolve("www.bluelinegpt.com")).toBeUndefined();
  });

  it("does not resolve a host that merely ends with the suffix text", () => {
    const resolver = createResolver({ hostSuffix: "bluelinegpt.com" });
    // An attacker-controlled "evilbluelinegpt.com" must not match.
    expect(resolver.resolve("evilbluelinegpt.com")).toBeUndefined();
  });

  it("prefers the host tenant over the development fallback", () => {
    const resolver = createResolver({
      developmentCompanySubdomain: "dev",
      hostSuffix: "bluelinegpt.com",
    });
    expect(resolver.resolve("acme.bluelinegpt.com")).toBe("acme");
  });
});
