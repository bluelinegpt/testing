import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AppConfiguration } from "../configuration/environment.js";
import { isReservedCompanySubdomain } from "./reserved-subdomains.js";

/**
 * Resolves which Company a login attempt belongs to, from the request host.
 *
 * The Company is never taken from the request body. A client-supplied Company
 * identifier would let anyone aim a login at any tenant, and would keep the
 * public Company list alive as an enumeration surface. Instead:
 *
 *   1. production  - the app tenant label of the host, e.g.
 *      `acmeapp.tawseelhub.com` resolves to Company subdomain `acme`
 *   2. development - a configured fallback subdomain, for localhost and IPs
 *
 * When neither yields a Company the caller must fail with the same generic
 * invalid-credentials response used for a wrong password, so an unresolved host
 * is indistinguishable from a bad login and reveals nothing about which
 * Companies exist.
 *
 * ---------------------------------------------------------------------------
 * A RESERVED HOST IS NOT AN UNRESOLVED HOST
 * ---------------------------------------------------------------------------
 *
 * `platform.bluelinegpt.com` serves the Platform Administration Portal, not a
 * tenant. Treating it as merely "unresolved" would be a real defect in
 * development, because an unresolved host falls back to the configured
 * development Company — which would make Company sign-in succeed on the
 * Platform host. So the three outcomes are distinguished explicitly, and a
 * reserved host returns `undefined` WITHOUT consulting the fallback.
 */
type HostOutcome =
  { kind: "company"; subdomain: string } | { kind: "reserved" } | { kind: "unknown" };
@Injectable()
export class CompanyHostResolver {
  private static readonly applicationLabelSuffix = "app";
  private readonly hostSuffix: string | undefined;
  private readonly developmentSubdomain: string | undefined;

  public constructor(@Inject(ConfigService) config: ConfigService<AppConfiguration, true>) {
    this.hostSuffix = config.get("tenancy.hostSuffix", { infer: true });
    this.developmentSubdomain = config.get("tenancy.developmentCompanySubdomain", {
      infer: true,
    });
  }

  /** Returns the Company subdomain for a request host, or undefined. */
  public resolve(host: string | undefined): string | undefined {
    const outcome = this.classify(host);
    if (outcome.kind === "company") return outcome.subdomain;
    // A reserved host is deliberately NOT eligible for the development
    // fallback: falling back there would let a Company sign in on the Platform
    // host in development, which is exactly the ambiguity the reservation
    // exists to remove.
    if (outcome.kind === "reserved") return undefined;
    return this.developmentSubdomain;
  }

  /** Whether the request host is a reserved, non-tenant host. */
  public isReservedHost(host: string | undefined): boolean {
    return this.classify(host).kind === "reserved";
  }

  private classify(host: string | undefined): HostOutcome {
    if (host === undefined) return { kind: "unknown" };
    // Strip the port and any IPv6 brackets before matching.
    const hostname = host
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .split(":")[0];
    if (hostname === undefined || hostname.length === 0) return { kind: "unknown" };

    if (this.hostSuffix !== undefined && hostname.endsWith(`.${this.hostSuffix}`)) {
      const label = hostname.slice(0, -(this.hostSuffix.length + 1));
      // Only a single leading label identifies a tenant. `a.b.example.com` is
      // ambiguous and must not silently resolve to `a`.
      if (label.length === 0 || label.includes(".")) return { kind: "unknown" };
      if (!label.endsWith(CompanyHostResolver.applicationLabelSuffix)) {
        return { kind: "unknown" };
      }
      const subdomain = label.slice(0, -CompanyHostResolver.applicationLabelSuffix.length);
      if (subdomain.length === 0 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(subdomain)) {
        return { kind: "unknown" };
      }
      return isReservedCompanySubdomain(subdomain)
        ? { kind: "reserved" }
        : { kind: "company", subdomain };
    }

    // No configured suffix, or a host that does not sit under it. A tenant can
    // never be identified here — but a reserved label still has to be honoured,
    // because local development runs on hosts like `platform.localhost` where
    // no suffix is configured at all.
    const leading = hostname.includes(".") ? hostname.split(".")[0] : undefined;
    if (leading !== undefined && isReservedCompanySubdomain(leading)) return { kind: "reserved" };
    return { kind: "unknown" };
  }
}
