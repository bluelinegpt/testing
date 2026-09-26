# Tawseelhub Developer Index

Tawseelhub is a Delivery Operating System for delivery companies, Traders, customer quote requests, and commerce integrations.

This index is the entry point for developer-facing API and integration documentation. It documents the approved integration surface only; it is not a dump of every internal Platform Administration route.

## Getting started

- [API overview](Tawseelhub-API-Overview.md)
- [Public API guide](Tawseelhub-Public-API.md)
- [Integration troubleshooting](Tawseelhub-Integration-Troubleshooting.md)
- [API changelog](API-CHANGELOG.md)
- [HTTP examples](examples/tawseelhub-public-api.http)

## Authentication

Tawseelhub currently supports browser/session authentication for Tawseelhub users and provider-specific authorization for commerce providers. A dedicated external partner API-key model is not yet published.

See [API overview](Tawseelhub-API-Overview.md#authentication-models).

## Public APIs

Public endpoints are intentionally limited:

- Send a Package quote requests
- Demo requests
- Trader applications
- public website/CMS reads
- public Blog reads
- public Agent website-chat endpoints
- public tracking/media/storefront reads where used by Tawseelhub public experiences

See [Public API guide](Tawseelhub-Public-API.md).

## Commerce integrations

- [Commerce Integration Foundation](Tawseelhub-Commerce-Integration-Foundation.md)
- [Salla integration](Tawseelhub-Salla-Integration.md)
- [Shopify integration](Tawseelhub-Shopify-Integration.md)
- [WooCommerce integration](Tawseelhub-WooCommerce-Integration.md)

Normal store setup is owned by:

```text
Trader Portal
→ Integrations
→ Connect <Provider>
```

Platform Administration is for monitoring, diagnostics, support, retry, and authorized force-disconnect actions.

## Webhooks

Commerce webhooks enter Tawseelhub through the provider adapter, are signature-verified from the raw request body, checked for replay/idempotency, stored in the event ledger, normalized, and then imported as canonical Tawseelhub Orders when valid.

See [Commerce Integration Foundation](Tawseelhub-Commerce-Integration-Foundation.md#webhook-flow).

## Errors and support

All standard API errors return a safe `error` object with `code`, `message`, and `correlationId`. Use the `correlationId` when reporting an issue to Tawseelhub support.

See [API overview](Tawseelhub-API-Overview.md#standard-error-model) and [Integration troubleshooting](Tawseelhub-Integration-Troubleshooting.md).

## Security

Security topics covered:

- authentication and CSRF behavior
- provider OAuth state
- webhook signatures and replay protection
- credential handling
- tenant isolation
- reference-number privacy
- WooCommerce public HTTPS store URL requirement

Start with [API overview](Tawseelhub-API-Overview.md#security-overview).

## Changelog

See [API changelog](API-CHANGELOG.md).
