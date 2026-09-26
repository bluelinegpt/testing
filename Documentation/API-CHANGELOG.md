# Tawseelhub API Changelog

This changelog starts from the current documented `v1` API surface. It does not backfill every historical repository change.

## 2026-08-20 — v1 documentation baseline

| Area | Change type | Summary |
| --- | --- | --- |
| Public API | Documentation | Documented public quote, demo, Trader application, Agent, CMS, Blog, tracking, and storefront read surfaces. |
| Authentication | Documentation | Documented browser/session authentication, CSRF header behavior, and future external partner API-key gap. |
| Commerce integrations | Documentation | Documented Trader-owned Salla/Shopify/WooCommerce connection model and Platform support/monitoring role. |
| Webhooks | Documentation | Documented provider webhook lifecycle, signature verification, idempotency, mapping failures, and retries. |
| OpenAPI | Documentation | Recorded that current Swagger/OpenAPI is development-only and not a safe public partner schema. |

## Deprecation policy

Deprecated APIs should be announced before removal where practical. No fixed contractual removal window is approved yet.

Breaking changes require an explicit version strategy. Additive compatible changes may remain in `/api/v1` according to project conventions.
