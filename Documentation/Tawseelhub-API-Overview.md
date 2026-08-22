# Tawseelhub API Overview

Tawseelhub exposes a versioned HTTP API for its public website, Trader Portal, Company operations portal, Platform Administration, and commerce integrations.

This document is developer-facing but intentionally selective. It describes approved integration surfaces and classifies internal surfaces without exposing internal Platform Administration details.

## API version and base URLs

All current Nest API routes are served under:

```text
/api/v1
```

Current deployed test API used by the website and Platform:

```text
https://bluelinegpt-api-test.onrender.com/api/v1
```

Local development:

```text
http://localhost:3000/api/v1
```

Production public website is live at:

```text
https://tawseelhub.com
```

A dedicated production API hostname is not separately confirmed in repository configuration at the time of this documentation. Do not publish a guessed future hostname.

## API surface classification

| Surface | Examples | Audience | Developer-doc status |
| --- | --- | --- | --- |
| Public APIs | quote requests, demo requests, Trader applications, public CMS/blog, public Agent, public tracking/media reads | website and approved public clients | Documented intentionally |
| Authenticated Trader APIs | Trader profile/orders, Trader-owned commerce connections | logged-in Traders | Documented at integration level |
| Authenticated Company APIs | delivery operations, drivers, orders, COD, settlements, reports | delivery company staff | Internal product API, not public partner API |
| Partner/integration APIs | commerce webhooks and provider callbacks | approved commerce providers/partners | Documented where intentional |
| Platform/Admin APIs | Platform companies, Agent console, CMS editor, lead management, audit, internal support controls | Tawseelhub staff only | Excluded from public developer docs |

## Public vs internal route inventory

Approved public/documented routes include:

- `GET /api/v1/health/live`
- `GET /api/v1/health/ready`
- `POST /api/v1/public/customer-quotes`
- `GET /api/v1/public/customer-quotes/:reference?token=...`
- `POST /api/v1/public/customer-quotes/:reference/select`
- `POST /api/v1/public/demo-requests`
- `POST /api/v1/public/trader-applications`
- `POST /api/v1/public/agent/conversations`
- `GET /api/v1/public/agent/conversations/:token`
- `POST /api/v1/public/agent/conversations/:token/messages`
- `GET /api/v1/public/agent/whatsapp/settings`
- `GET /api/v1/public/website/content`
- `GET /api/v1/public/website/sitemap-entries`
- `GET /api/v1/public/website/media/:id`
- `GET /api/v1/public/blog`
- `GET /api/v1/public/blog/categories`
- `GET /api/v1/public/blog/articles/:slug`
- `GET /api/v1/public/blog/settings`
- `GET /api/v1/public/blog/sitemap-entries`
- `GET /api/v1/public/tracking/:token`
- `POST /api/v1/public/store-orders/track`
- `GET /api/v1/public/storefronts`
- `GET /api/v1/public/storefronts/:slug`
- `GET /api/v1/public/storefronts/:slug/categories`
- `GET /api/v1/public/storefronts/:slug/products`
- `GET /api/v1/public/storefronts/:slug/products/:productSlug`
- `GET /api/v1/public/commerce-media/:fileId`
- `POST /api/v1/integrations/commerce/:provider/webhook/:connectionReference`
- `GET /api/v1/integrations/commerce/salla/oauth/callback`
- `GET /api/v1/integrations/commerce/shopify/oauth/callback`

Authenticated Trader integration routes are under:

- `GET /api/v1/portal/trader/commerce-integrations/providers`
- `GET /api/v1/portal/trader/commerce-integrations/connections`
- `POST /api/v1/portal/trader/commerce-integrations/connections/salla/start`
- `POST /api/v1/portal/trader/commerce-integrations/connections/shopify/start`
- `POST /api/v1/portal/trader/commerce-integrations/connections/woocommerce/connect`
- `POST /api/v1/portal/trader/commerce-integrations/connections/:id/disconnect`
- `POST /api/v1/portal/trader/commerce-integrations/connections/:id/reconnect`
- `POST /api/v1/portal/trader/commerce-integrations/connections/:id/sync`
- `POST /api/v1/portal/trader/commerce-integrations/connections/:id/area-mappings`
- `GET /api/v1/portal/trader/commerce-integrations/connections/:id/areas`
- `GET /api/v1/portal/trader/commerce-integrations/connections/:id/events`

Do not expose as public developer APIs:

- `platform/*` routes
- staff-only Agent controls
- internal comments/review actions
- internal financial administration
- audit and integrity internals
- secret/provider configuration internals
- mock/simulation actions except in local development documentation
- destructive administration actions

## Versioning policy

Current API version is `v1`.

Additive compatible changes may remain in `v1` according to project conventions. Breaking changes require an explicit version strategy. No `v2` API is currently documented or implied.

## Authentication models

### Public endpoints

Public website endpoints marked as public do not require a Tawseelhub login. They may still require a reference plus access token for customer-specific results.

### Tawseelhub user/session authentication

Authenticated Trader, Company, and Platform APIs use server-side sessions. Requests may use:

- `Authorization: Bearer <session-token>` for API clients that already have a session token.
- an HttpOnly `blueline_session` cookie for browser sessions.

Cookie-authenticated mutating requests must also carry:

```http
X-Blueline-Session: cookie
```

This is the CSRF protection for cookie transport. The cookie value itself must never be exposed in documentation or logs.

Unauthorized requests return `401` with `authentication_required` or `authentication_error` style responses. Permission failures return `403`.

### Commerce provider authorization

Provider authorization is not Tawseelhub user login:

- Salla uses provider OAuth and signed webhooks.
- Shopify uses provider OAuth, callback HMAC verification, and signed webhooks.
- WooCommerce uses WooCommerce REST API Consumer Key/Consumer Secret and signed webhooks.

Tawseelhub never asks Traders to share Salla, Shopify, WordPress, WooCommerce admin, hosting, or cPanel passwords.

### Future external partner credentials

A dedicated external partner API-key/token model is not currently published. Treat “external partner API credentials” as a future controlled capability, not an existing public feature.

## Standard request conventions

- Request and response body format: JSON.
- Encoding: UTF-8.
- Dates/timestamps: ISO 8601 strings where APIs accept date/time values.
- Operational display timezone: UAE operations use `Asia/Dubai` where shown in reports/UI.
- Country codes: ISO-style two-letter uppercase country codes where requested, for example `AE`, `GB`.
- Currency codes: three-letter uppercase codes, for example `AED`, `GBP`.
- Money/decimal values: use decimal JSON numbers in public form submissions; server-side money calculations use decimal-safe handling. Do not rely on binary floating-point rounding in client code.
- Phone numbers: public quote phones normalize to E.164-style values where possible. UAE `050...` can normalize to `+97150...`. International numbers should use appropriate country context and E.164-compatible formatting.
- References such as `QTE-000001`, `DEMO-000001`, `TRD-APP-000001`, `ORD-...`, and `AGT-...` are business references, not authentication.

## Standard error model

Errors use this shape:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed.",
    "correlationId": "request-correlation-id",
    "details": ["field must be valid"]
  }
}
```

`details` appears mainly for validation/application errors. Server errors are sanitized; stack traces are not returned to clients.

Common codes/statuses:

| Status | Common code | Meaning |
| --- | --- | --- |
| 400 | `validation_error` | Request body/query failed validation |
| 401 | `authentication_required` / `authentication_error` | Login/session required or invalid |
| 403 | `permission_denied`, `authorization_error`, `csrf_header_required` | Not allowed or missing CSRF session header |
| 404 | `resource_not_found` | Resource not found or not accessible |
| 409 | `conflict`, `database_integrity_conflict` | Duplicate/current state conflict |
| 429 | `rate_limit_exceeded` | Request was throttled |
| 500 | `internal_server_error` | Unexpected server error; message is sanitized |

## Correlation ID

Every error response includes `correlationId`. When reporting an API issue, provide:

- endpoint
- timestamp
- environment/base URL
- `correlationId`
- sanitized request summary

Do not send secrets, session cookies, provider tokens, or customer private data in support messages.

## Pagination and filters

Tawseelhub does not yet expose one single global pagination contract for every endpoint. Common Platform/internal list DTOs use:

- `page`
- `pageSize`
- `search`
- `status`
- date/status filters where implemented
- sort values such as `newest` / `oldest`

Public Blog currently supports list query filters such as language/category/pagination as implemented by the public Blog controller/service. Public CMS reads are content snapshots rather than paginated administrative lists.

## Rate limiting

Some public submission endpoints have explicit throttles:

- customer quotes: limited submission/result/select requests per minute
- demo requests: limited submissions per minute
- Trader applications: limited submissions per minute
- public Agent messages: limited conversation/message requests per minute

Tawseelhub should not publish a contractual public quota until approved. Provider APIs such as Salla, Shopify, and WooCommerce also have their own rate limits; provider-specific docs should be followed for those.

## Idempotency and duplicate protection

Do not assume global `Idempotency-Key` support for all APIs.

Known duplicate/idempotency controls:

- Commerce events are idempotent by provider connection plus external event ID.
- Commerce order imports are protected by connection plus external order ID.
- Demo submissions use duplicate/fingerprint protection.
- Trader applications use duplicate/fingerprint protection.
- Customer quotes use business reference/access-token flow and duplicate handling in the quote workflow.
- Agent message APIs accept `inboundMessageId` for duplicate-resistant inbound message handling where supplied.

## Reference numbers

References are customer/support friendly:

- `QTE-...`: customer quote request
- `DEMO-...`: demo request
- `TRD-APP-...`: Trader application
- `ORD-...`: operational Order
- `AGT-...`: Agent conversation

A reference alone does not authorize private detail access. Quote result access also requires the access token returned by the quote request.

## OpenAPI / Swagger status

The API has Swagger/OpenAPI tooling enabled only outside production:

```text
/api/docs
```

It is generated from the whole Nest application and may include internal routes in development. It is therefore an internal development aid, not a public developer portal and not a safe public partner schema.

A controlled public OpenAPI document for intentionally documented surfaces is recommended as a future step.

## Security overview

- Tenant context is resolved server-side from the authenticated session and/or secure connection reference.
- Traders can manage only integrations and Orders within their authorized Tawseelhub context.
- Platform APIs are staff-only and excluded from public developer docs.
- Provider webhooks require signature verification.
- OAuth callbacks require provider callback verification and server-side state.
- Credential values/secrets are not returned to browser clients.
- Public references are not authentication.
- WooCommerce production store URLs must be public HTTPS URLs. Internal/private network URLs are rejected.
- Tawseelhub does not require provider password sharing.
