# Delivery Company website custom domains

## Selected architecture

One multi-tenant Company Web service continues to serve every public website.
An external hostname is never converted to a Company slug. The API performs an
exact lookup in `company_website_domains` and accepts only a row whose hostname,
ownership, SSL, and lifecycle are all active. Company application hosts remain
under the separate `companyslugapp.tawseelhub.com` classifier.

The automated adapter uses Cloudflare for SaaS Custom Hostnames. Cloudflare's
hostname `status` and `ssl.status` are separate; Tawseelhub marks a domain active
only when both are `active`. The API token and provider reference remain
server-side. See the official [Cloudflare for SaaS setup](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/)
and [Custom Hostnames API](https://developers.cloudflare.com/api/resources/custom_hostnames/).

## Neon

1. Take and verify the required Neon backup/restore point.
2. Apply migrations through
   `20260941000000_company_website_custom_domains.ts`.
3. Run schema verification before enabling provider configuration.

The migration creates `company_website_domains` and adds `source_hostname` to
public delivery requests and Agent conversations. It does not alter Orders,
settlements, reconciliation, Accounting, Journal Entries, or `file_objects`.

## Cloudflare

1. Enable Cloudflare for SaaS on the Tawseelhub zone and confirm quota.
2. Create a proxied fallback-origin DNS record that reaches the existing Company
   Web origin and mark it Active in Custom Hostnames.
3. Create a friendly proxied CNAME target, for example
   `customers.tawseelhub.com`, pointing at that fallback origin.
4. Ensure the fallback origin can accept the original customer `Host`. If Render
   rejects unregistered hostnames, either register each hostname on the same
   Render service or use an approved Cloudflare origin-routing configuration
   that preserves the original hostname to Tawseelhub while routing to a Render-
   accepted origin. Do not enable domains until this is proven in staging.
5. Create an API token with only the zone's Custom Hostnames read/write access.
   Store it in the API service secret manager.

Required API environment:

```text
COMPANY_WEBSITE_DOMAIN_PROVIDER=cloudflare
CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN=<secret>
CLOUDFLARE_CUSTOM_HOSTNAMES_ZONE_ID=<zone-id>
COMPANY_WEBSITE_CUSTOM_DOMAIN_CNAME_TARGET=customers.tawseelhub.com
```

Required Company Web runtime environment:

```text
WEB_ALLOW_CUSTOM_DOMAINS=true
WEB_TENANT_HOST_SUFFIX=tawseelhub.com
```

The customer receives the TXT ownership and certificate-validation records
returned by Cloudflare plus the configured CNAME target. Apex domains require
the registrar/DNS provider to support CNAME flattening/ALIAS, or Cloudflare's
separately purchased Apex Proxying capability. Tawseelhub does not invent an A
record for apex domains.

## Render

No new Render service is created. The existing Company Web service remains the
only origin. Render documents automatic TLS and per-service custom-domain
registration, including plan quotas; if the Cloudflare fallback-origin design
cannot deliver arbitrary original hosts to the current service, automate or
manually register each verified hostname on this same service using Render's
[Custom Domains API](https://api-docs.render.com/reference/create-custom-domain).
This is an infrastructure prerequisite, not a per-Company deployment.

## Domain-owner DNS action

The Platform Domains screen displays the provider-returned TXT records exactly.
The owner adds each record at their authoritative DNS provider, waits for
propagation, and then points the desired hostname to
`COMPANY_WEBSITE_CUSTOM_DOMAIN_CNAME_TARGET` using CNAME, ALIAS/ANAME, or
provider-supported CNAME flattening. Registrar UI labels vary; record type,
fully qualified name, and value must be preserved exactly.

## Lifecycle and recovery

`pending_verification → verified/pending_ssl → active` is provider-driven.
Failures record a redacted actionable message. Refresh reconciles local state
with Cloudflare. Make Primary requires active ownership and SSL and uses both
domain and Website versions. Disable stops routing without disabling the
fallback site. Remove deletes the provider resource and mapping while preserving
the Website. The fallback `companyslug.tawseelhub.com` remains available and
redirects in the SPA to the primary hostname with path, query, and fragment
preserved.

## Security notes

- Unicode and punycode hostnames, IPs, wildcards, URLs, paths, reserved test
  domains, and all Tawseelhub-owned hostnames are rejected.
- Database uniqueness and exact active-row lookup prevent duplicate claims and
  fuzzy tenant resolution.
- Production ignores tenant-host simulation headers.
- Public APIs remain same-origin; authenticated CORS is not widened.
- Session cookies remain host-only, `HttpOnly`, `Secure`, `SameSite=Lax`, and
  `/api` scoped, so a custom public host cannot receive a Company app session.
- Provider credentials are never returned, audited, or logged.

## Release gate

Do not mark custom domains production-ready until staging proves: provider
ownership, Cloudflare and/or Render origin routing, certificate activation,
fallback redirect, canonical and sitemap changes, tracking/request/Agent tenant
binding, removal recovery, and a two-Company Host-header adversarial test.
