import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ConfigService } from "@nestjs/config";

import type { AppConfiguration } from "../configuration/environment.js";

import { CompanyHostResolver } from "./company-host-resolver.js";
import { isReservedCompanySubdomain, reservedCompanySubdomains } from "./reserved-subdomains.js";

function resolverFor(settings: {
  hostSuffix?: string | undefined;
  developmentCompanySubdomain?: string | undefined;
}): CompanyHostResolver {
  const config = {
    get: (key: string) =>
      key === "tenancy.hostSuffix" ? settings.hostSuffix : settings.developmentCompanySubdomain,
  } as unknown as ConfigService<AppConfiguration, true>;
  return new CompanyHostResolver(config);
}

describe("reserved Company subdomains", () => {
  it("reserves the Platform host label", () => {
    expect(isReservedCompanySubdomain("platform")).toBe(true);
  });

  it("keeps reserving the names that were reserved before", () => {
    expect(isReservedCompanySubdomain("www")).toBe(true);
  });

  it("matches regardless of case and surrounding whitespace", () => {
    // `companies_subdomain_unique` indexes `lower(subdomain)`, so `Platform`
    // and `platform` are one name. A reservation that only caught the lowercase
    // spelling would be sidestepped by typing a capital letter.
    expect(isReservedCompanySubdomain("Platform")).toBe(true);
    expect(isReservedCompanySubdomain("PLATFORM")).toBe(true);
    expect(isReservedCompanySubdomain("  platform  ")).toBe(true);
  });

  it("does not reserve an ordinary Company name", () => {
    expect(isReservedCompanySubdomain("acme")).toBe(false);
    expect(isReservedCompanySubdomain("dana")).toBe(false);
  });

  /**
   * The resolver and the database must agree forever. If they drift, a Company
   * could be stored with a subdomain the resolver refuses to read, and that
   * Company's sign-in page would simply stop working with no error anywhere.
   */
  it("matches the database check constraint word for word", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "../../database/migrations/20260808100000_platform_administration_foundation.ts",
      ),
      "utf8",
    );
    const clause = /not in \(([\s\S]*?)\)\s*\)\s*not valid/.exec(migration)?.[1];
    expect(clause).toBeDefined();
    const inConstraint = [...(clause ?? "").matchAll(/'([a-z0-9-]+)'/g)]
      .map((match) => match[1])
      .sort();
    expect(inConstraint).toEqual([...reservedCompanySubdomains].sort());
  });
});

describe("Company host resolution", () => {
  it("resolves an ordinary tenant host to its Company subdomain", () => {
    const resolver = resolverFor({ hostSuffix: "bluelinegpt.com" });
    expect(resolver.resolve("acme.bluelinegpt.com")).toBe("acme");
    expect(resolver.resolve("acme.bluelinegpt.com:443")).toBe("acme");
    expect(resolver.resolve("ACME.BlueLineGPT.com")).toBe("acme");
  });

  it("refuses to read the Platform host as a Company", () => {
    const resolver = resolverFor({ hostSuffix: "bluelinegpt.com" });
    expect(resolver.resolve("platform.bluelinegpt.com")).toBeUndefined();
    expect(resolver.isReservedHost("platform.bluelinegpt.com")).toBe(true);
  });

  /**
   * The defect this guards against is specific and would only appear in
   * development: a reserved host that merely failed to resolve would fall
   * through to the configured development Company, and Company sign-in would
   * then succeed on the Platform host.
   */
  it("does not fall back to the development Company on a reserved host", () => {
    const resolver = resolverFor({
      hostSuffix: "bluelinegpt.com",
      developmentCompanySubdomain: "dev",
    });
    expect(resolver.resolve("platform.bluelinegpt.com")).toBeUndefined();
    expect(resolver.resolve("www.bluelinegpt.com")).toBeUndefined();
    expect(resolver.resolve("acme.bluelinegpt.com")).toBe("acme");
    expect(resolver.resolve("localhost")).toBe("dev");
  });

  it("honours a reserved label in local development where no host suffix is configured", () => {
    const resolver = resolverFor({ developmentCompanySubdomain: "dev" });
    expect(resolver.resolve("platform.localhost")).toBeUndefined();
    expect(resolver.resolve("localhost")).toBe("dev");
    expect(resolver.resolve("127.0.0.1")).toBe("dev");
  });

  it("still refuses an ambiguous multi-label host", () => {
    const resolver = resolverFor({ hostSuffix: "bluelinegpt.com" });
    expect(resolver.resolve("a.b.bluelinegpt.com")).toBeUndefined();
  });

  it("still refuses a host outside the configured suffix", () => {
    const resolver = resolverFor({ hostSuffix: "bluelinegpt.com" });
    expect(resolver.resolve("acme.example.com")).toBeUndefined();
  });

  it("reports an ordinary tenant host as not reserved", () => {
    const resolver = resolverFor({ hostSuffix: "bluelinegpt.com" });
    expect(resolver.isReservedHost("acme.bluelinegpt.com")).toBe(false);
    expect(resolver.isReservedHost("localhost")).toBe(false);
  });
});
