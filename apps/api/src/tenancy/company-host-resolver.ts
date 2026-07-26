import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AppConfiguration } from "../configuration/environment.js";

/**
 * Resolves which Company a login attempt belongs to, from the request host.
 *
 * The Company is never taken from the request body. A client-supplied Company
 * identifier would let anyone aim a login at any tenant, and would keep the
 * public Company list alive as an enumeration surface. Instead:
 *
 *   1. production  - the tenant label of the host, e.g. `acme.bluelinegpt.com`
 *   2. development - a configured fallback subdomain, for localhost and IPs
 *
 * When neither yields a Company the caller must fail with the same generic
 * invalid-credentials response used for a wrong password, so an unresolved host
 * is indistinguishable from a bad login and reveals nothing about which
 * Companies exist.
 */
@Injectable()
export class CompanyHostResolver {
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
    return this.fromHost(host) ?? this.developmentSubdomain;
  }

  private fromHost(host: string | undefined): string | undefined {
    if (host === undefined) return undefined;
    // Strip the port and any IPv6 brackets before matching.
    const hostname = host.trim().toLowerCase().replace(/^\[|\]$/g, "").split(":")[0];
    if (hostname === undefined || hostname.length === 0) return undefined;
    if (this.hostSuffix === undefined) return undefined;
    if (!hostname.endsWith(`.${this.hostSuffix}`)) return undefined;

    const label = hostname.slice(0, -(this.hostSuffix.length + 1));
    // Only a single leading label identifies a tenant. `a.b.example.com` is
    // ambiguous and must not silently resolve to `a`.
    if (label.length === 0 || label.includes(".")) return undefined;
    // `www.example.com` is the marketing host, not a tenant.
    if (label === "www") return undefined;
    return label;
  }
}
