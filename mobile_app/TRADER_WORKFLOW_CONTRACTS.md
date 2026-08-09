# Trader Mobile Workflow Contracts

This document records the backend contracts verified during Prompt 4 and the
contracts still required. Flutter never accepts a Trader ID from input, a deep
link, or cached preferences. Ownership must be derived from the authenticated
session by the API.

## Verified contracts

### Trader profile

- `GET /portal/trader/profile`
- Authentication: active session with Trader identity.
- Isolation: company and Trader are derived by the server.
- Purpose: verifies the active user-to-Trader relationship.

### Active areas and Emirates

- `GET /portal/trader/areas`
- Authentication and isolation: same as Trader profile.
- Response: active areas containing `id`, localized area names, `emirateId`,
  and localized Emirate names.
- Mobile behavior: Emirates are derived from this response; selecting an
  Emirate filters its areas. No free-text values are accepted.

### Trader Orders

- `GET /portal/trader/orders`
- Authentication: Trader identity.
- Isolation: returns only Orders for the Trader linked to the session.
- Current limitation: newest 100 records only; no paging, filters, search, or
  stable continuation token is exposed. The app labels this limitation and
  does not perform an unbounded local scan.

### Create Trader Order

- `POST /portal/trader/orders`
- Header: `X-Idempotency-Key`.
- Isolation: sender Trader and company are server-derived.
- Accepted request fields: server serial number, optional reference number,
  area ID, customer name/mobile/address, COD, and optional notes.
- The mobile repository preserves references as text, normalizes UAE phone
  input, safely parses AED values, and never sends an arbitrary Trader ID.
- Server serial source currently verified at
  `GET /operations/orders/next-serial-number`; its permission compatibility
  with every mobile Trader must be resolved before enabling submission.

## Missing Trader-safe contracts

The following APIs must derive company and Trader from the active session,
reject cross-Trader identifiers with 403/404, use AED, localize safe messages,
and produce auditable mutations. The app currently shows safe unavailable
states for these capabilities.

| Capability           | Required contract                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard            | `GET /portal/trader/dashboard`; status counts, financial summary, limited recent activity; independently nullable sections             |
| Pricing preview      | `POST /portal/trader/orders/price-preview`; area and COD input; fee, expected net, effective/version token output; 409 on price change |
| Idempotency recovery | Lookup by idempotency key or deterministic replay response after a timeout                                                             |
| Order list           | Paginated `GET /portal/trader/orders` with cursor/page, status, Emirate, area, dates, search and sort                                  |
| Order details        | `GET /portal/trader/orders/{id}` with safe customer, financial, delivery and settlement fields                                         |
| Order history        | Paginated `GET /portal/trader/orders/{id}/history` with safe labels and timestamps                                                     |
| Cancellation reasons | `GET /portal/trader/order-cancellation-reasons`; active localized reasons                                                              |
| Cancellation         | `POST /portal/trader/orders/{id}/cancel`; reason, notes and current version; 409 returns current status                                |
| Financial summary    | `GET /portal/trader/finance/summary`; server-calculated period totals and explicit availability states                                 |
| Settlements          | Paginated list/detail endpoints with allocations and reversal state; no arbitrary Trader ID                                            |
| Settlement receipt   | Short-lived authenticated download response, never a permanent public URL                                                              |
| Account statement    | Server-calculated summary and rows for month/date range with maximum-period validation                                                 |
| Statement PDF        | Authenticated, short-lived English/Arabic PDF generation/download                                                                      |
| Notifications        | Trader-scoped inbox/read endpoints and ownership-checked Order/settlement navigation payloads                                          |
| Order conversation   | Trader-to-Office conversation lookup/create; no Trader-to-Driver route                                                                 |

All list contracts require stable sorting and duplicate-safe pagination. All
mutations require validation errors, authorization errors, conflict behavior,
and idempotency semantics to be documented by the backend. No missing endpoint
is simulated inside Flutter.
