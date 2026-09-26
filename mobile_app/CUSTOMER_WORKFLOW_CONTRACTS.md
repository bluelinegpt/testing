# Customer Mobile Workflow Contracts

## Verified access model

BluelineGPT currently supports secure single-Order tracking, not full Customer accounts. Operations creates a 32-byte random URL-safe token, stores only its SHA-256 hash, and defaults expiry to 30 days. `GET /public/tracking/{token}` validates the exact 43-character token shape, hash, revocation, expiry, active Company, and Order relationship. Access is recorded. Invalid, expired and revoked tokens share a non-disclosing not-found response.

The Customer-safe response contains Company name, Order number, Customer name, area, delivery status, delivered time and last update. Mobile deliberately omits the returned Driver name. It receives no address, mobile, COD, delivery fee, Trader values, settlement, reconciliation, internal notes, IDs or audit payloads.

## Missing contracts

| Capability                 | Required secure contract                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| Full Customer account      | Approved identity linkage, authentication/recovery, active state, Company and Customer permissions |
| Customer Orders            | Customer-derived paginated active/recent list and bounded Order/reference search                   |
| Detail/timeline            | Token- or Customer-scoped safe detail and curated chronological events                             |
| Tracking lifecycle         | Explicit expiry/revocation error semantics and safe token renewal request                          |
| Notifications              | Customer-scoped inbox/read state and token/account-authorized deep links                           |
| Real-time                  | Per-Order authorized channel, replay cursor, revocation disconnect and deduplication               |
| Office conversation        | Customer-to-Office only with Order/token context and retention policy                              |
| Support request            | Server categories, notes, status and Office response                                               |
| Reschedule/address request | Eligibility, approval workflow and preserved original values                                       |
| Cache retention            | Approved maximum age, protected persistence, tracking-exit deletion and revocation behavior        |

No mobile-number lookup, predictable identifier lookup, local ownership, Customer cancellation, direct Driver/Trader contact, GPS, or internal Order DTO is used.
