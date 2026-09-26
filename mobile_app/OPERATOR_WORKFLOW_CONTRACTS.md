# Operator Mobile Workflow Contracts

## Verified contracts

- `GET /operations/orders` is Company-scoped and permission-protected. It supports page sizes 25/50/100, server search, delivery status, cash/settlement status, Trader, Driver, Area and date filters, quick views, and stable server sorting.
- `GET /operations/orders/{id}` returns one Company-scoped Order with safe status history and detailed internal events. Mobile renders only the safe history subset and does not expose raw event payloads, correlation IDs, internal financial ledger values, VAT, payroll, or settlements.
- `GET /operations/drivers` returns Company-active operational Driver records and requires an Order-related permission.
- `POST /operations/orders/bulk-assign/preview` and `POST /operations/orders/bulk-assign` require `orders.assign_driver` (or administration), validate active same-Company Drivers and assignable Orders, and record audit/history. Mobile uses explicit Order IDs and previews before confirmation.
- `PATCH /operations/orders/{id}/status` and bulk status exist, but their broad transition model is not exposed as an arbitrary mobile selector.

## Missing dedicated mobile contracts

Required contracts must be Company-derived, permission-specific, auditable, versioned, idempotent, conflict-safe, paginated where applicable, and publish authorized notification/real-time events.

| Capability             | Required contract                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Focused dashboard      | Operational status counts excluding Closed, urgent counts, limited activity, partial availability |
| Alerts                 | Paginated structured attention items, server priority/wait thresholds and valid actions           |
| Reassignment           | Pre-delivery-only endpoint with old/new Driver, required reason, version and conflict response    |
| Failure review         | Attempt detail, structured reasons and backend-calculated valid next actions                      |
| Retry/reschedule       | Dedicated decisions preserving attempt history; approved scheduling fields only                   |
| Return instruction     | Operator instruction distinct from Driver readiness and physical Branch receipt                   |
| Branch receipt         | Permission-specific confirmation with pending status/version and receipt notes                    |
| Cancellation           | Dedicated eligibility/reasons endpoint and mutation with conflict payload                         |
| Driver COD summary     | Read-only totals and differences without reconciliation mutations                                 |
| Conversations          | Operator-to-Driver/Trader/Customer only, Order context and unread state                           |
| Notifications/realtime | Company/permission scoped inbox, subscriptions, replay cursor and deduplication                   |

No missing endpoint is simulated in Flutter. Sensitive Operator decisions require connectivity.
