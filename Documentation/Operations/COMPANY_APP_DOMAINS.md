# Delivery Company application domains

Operational Company portals use `companyslugapp.tawseelhub.com`. Public Company
websites use `companyslug.tawseelhub.com`. The shared Company web service
classifies the exact hostname and renders the authenticated portal or public
website shell without sharing authentication or tenant context between them.

For Dana, the operational portal is `https://danaapp.tawseelhub.com`. The
previous operational address was `https://dana.tawseelhub.com`.

## Production configuration

API service:

- `BLUELINE_TENANT_HOST_SUFFIX=tawseelhub.com`
- Add `https://danaapp.tawseelhub.com` to the exact comma-separated
  `CORS_ORIGINS` list if the browser calls the API cross-origin. The normal
  same-origin `/api` web proxy does not require a wildcard origin.
- Do not set `BLUELINE_DEV_COMPANY_SUBDOMAIN` in production.

Company web service:

- `WEB_TENANT_HOST_SUFFIX=tawseelhub.com`
- `API_PROXY_TARGET` remains the existing API service origin.
- Build with `VITE_API_BASE_URL=/api/v1`.
- Leave `WEB_LEGACY_TENANT_REDIRECTS` unset. Public Company hostnames now belong
  to the Company website module and must never redirect into the operational app.

Cloudflare needs a proxied DNS record for `danaapp.tawseelhub.com` targeting
the existing Company web service's Render hostname. Render needs the same custom
domain added to that service and verified. Do not attach `dana.tawseelhub.com`
to the Company web service except for the explicitly configured migration
redirect window.

Cookies remain host-only because the API deliberately emits no `Domain`
attribute. A session issued on `danaapp.tawseelhub.com` is therefore not sent to
`dana.tawseelhub.com` or another Company's app host. Production cookies remain
`Secure`, `HttpOnly`, `SameSite=Lax`, and scoped to `/api`.

Local development remains `http://localhost:5174`; the API uses
`BLUELINE_DEV_COMPANY_SUBDOMAIN` as its development-only tenant fallback.
