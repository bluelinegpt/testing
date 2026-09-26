# Tawseelhub Integration Troubleshooting

Use this guide for public API submissions and commerce integrations.

When reporting an issue, include:

- environment/base URL
- endpoint or provider
- timestamp
- safe business reference, if available
- `correlationId` from the API error
- sanitized request summary

Do not include passwords, session cookies, provider tokens, API secrets, webhook secrets, or real customer private data unless Tawseelhub support explicitly requests it through an approved secure channel.

## Common API errors

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `validation_error` | Required field missing or invalid format | Check request JSON, country/currency codes, phone, date, and enum values |
| `authentication_required` | Authenticated endpoint called without login/session | Sign in or use a valid server-issued session token |
| `csrf_header_required` | Cookie-authenticated mutation missed session header | Add `X-Blueline-Session: cookie` for browser cookie mutations |
| `permission_denied` | Account type/permissions do not allow operation | Use the correct Trader/Company/Platform user |
| `resource_not_found` | Resource missing or inaccessible to current tenant/session | Confirm reference/token and authorized context |
| `conflict` | Duplicate submission/current state conflict | Search by business reference; do not retry blindly |
| `rate_limit_exceeded` | Public endpoint throttled | Wait before retrying; avoid rapid duplicate submissions |
| `internal_server_error` | Unexpected server failure | Report `correlationId`; do not retry high-volume writes blindly |

## Public quote issues

### Quote result not accessible

The `QTE-...` reference alone does not authorize private result access. Use:

```text
GET /api/v1/public/customer-quotes/{reference}?token={accessToken}
```

with the access token from the create response.

### International quote is manual

Some international routes require manual quotation. This is expected when instant pricing is not available.

### Phone rejected

Use E.164-style numbers when possible, for example `+971501112222`. UAE local numbers such as `050...` may normalize to `+97150...` when country context is UAE.

## Demo request issues

### Duplicate request

Demo requests have duplicate/fingerprint protection. If the same Company/contact has already submitted recently, Tawseelhub may return a conflict instead of creating a new `DEMO-...` reference.

### UAE emirate behavior

For UAE leads, include the emirate where available. Use one of:

```text
abu_dhabi, dubai, sharjah, ajman, umm_al_quwain, ras_al_khaimah, fujairah
```

## Trader application issues

### Existing delivery company

If `hasExistingDeliveryCompany` is true, provide `existingDeliveryCompanyName`. Platform approval workflows are internal; public clients only submit the application.

### Duplicate application

Trader applications have duplicate/fingerprint protection and can return a conflict with the existing `TRD-APP-...` reference.

## Commerce integration issues

### Unauthorized provider connection

For Trader-owned connections, connect from:

```text
Trader Portal
→ Integrations
→ Connect <Provider>
```

The Platform console is for monitoring/support, not normal merchant setup.

### Webhook signature rejected

Likely causes:

- provider webhook secret/app secret mismatch
- request body changed before verification
- wrong provider/connection URL
- webhook sent to the wrong environment

Tawseelhub requires raw-body signature verification. Invalid signatures do not create or update Orders.

### Duplicate event

Commerce events are idempotent by connection plus external event ID. A replay may safely resolve as duplicate rather than creating another Order.

### Missing area mapping

External provider area/location was not recognized.

Workflow:

```text
external area not recognized
→ mapping failure in event ledger
→ Trader/Platform adds mapping
→ retry event
→ canonical Tawseelhub Order is created/updated
```

Invalid/unmapped orders are not silently created.

### Provider unavailable or rate limited

Provider APIs have their own limits and availability. Retry after safe backoff. Do not hammer OAuth/token/webhook endpoints.

### Store disconnected/revoked

If a provider app is uninstalled, token revoked, or credentials invalid:

- connection may become `revoked`, `disconnected`, `unauthorized`, or `degraded` depending on provider/state
- new events may fail
- historical Tawseelhub Orders remain canonical business records

### WooCommerce invalid store URL

Production WooCommerce Store URL must be a public HTTPS URL. Tawseelhub rejects localhost, private/internal network URLs, unsafe schemes, and redirects during connection tests.

### WooCommerce credentials rejected

Create credentials in:

```text
WooCommerce Admin
→ Settings
→ Advanced
→ REST API
```

Use Consumer Key and Consumer Secret. Do not share WordPress or WooCommerce administrator passwords.

## Health status meanings

| Status | Meaning |
| --- | --- |
| Healthy | Provider connection/API is reachable and current credentials appear valid |
| Degraded | Provider reachable but not fully healthy or recent issues exist |
| Unauthorized | Credentials/token rejected or expired |
| Disconnected | Connection intentionally disconnected |
| Revoked | Provider/app access revoked, uninstalled, or equivalent |

## Retry behavior

Retry failed events only after resolving the cause. If the canonical Tawseelhub Order already exists, retry may finish as duplicate/linked instead of creating a second Order.

## Canonical Orders

Imported Salla, Shopify, and WooCommerce Orders become normal Tawseelhub Orders. They use the normal Driver workflow, COD handling, accounting, Trader settlements, and reports. There is no provider-specific operational Order lifecycle.
