# Mobile UI backend contracts

The current backend has `GET /operations/trader/profile`, paginated
`GET /operations/trader/orders`, and paginated `GET /operations/driver/orders`.
It has no mobile dashboard, notification inbox, unread count, message, Customer
tracking home, recent activity, or shared safe profile endpoint. The mobile UI
therefore renders explicit unavailable states and never fabricated counts.

The following proposed `/api/v1/mobile` contracts require backend approval. All
use bearer authorization, derive Company/User/profile scope from the verified
session, return the standard error envelope, and must never accept arbitrary
Company, Trader, Driver, or Customer IDs.

## Dashboard summaries

- `GET /mobile/dashboard/trader`, `/driver`, `/operator`, or `/customer`.
- Parameters: optional locale; no ownership ID.
- Response: `{ generatedAt, metrics: [{ key, value, valueKind }], recentItems,
attentionItems, unreadNotifications, unreadMessages }`.
- Role behavior: each route enforces matching identity and permissions. Financial
  metrics are strings and Trader-only where approved; VAT is excluded.
- Cache: private, short lived, keyed by Company/User/profile and context version.
- Errors: `mobile_role_unsupported`, `profile_inactive`, `permission_denied`,
  `dashboard_unavailable`.

## Recent Orders and activity

- `GET /mobile/orders/recent?limit=10&status=...` and
  `GET /mobile/activity?cursor=...&limit=25`.
- Response: role-projected DTOs only, plus opaque `nextCursor`.
- Pagination: limit defaults to 25 and is capped at 100.
- Customer/Driver projections exclude internal and other-owner data.

## Notification inbox

- `GET /mobile/notifications?cursor&limit&unreadOnly` returns items and opaque cursor.
- `PATCH /mobile/notifications/{id}/read` is idempotent.
- `POST /mobile/notifications/mark-all-read` accepts an optional server cutoff.
- `GET /mobile/notifications/unread-count` returns a non-negative integer and
  context version.
- Notification destinations are allowlisted typed objects, not arbitrary URLs.
- Cache: private per Company/User; pushes are not authoritative inbox history.
- Errors: `notification_not_found`, `notification_destination_forbidden`.

## Messages count

- `GET /mobile/messages/unread-count` and `GET /mobile/conversations/recent`.
- Operator remains the hub. Trader-to-Driver and Customer-to-Driver are denied.
- Conversation access is reauthorized on every deep link and request.

## Profile and account preferences

- `GET /mobile/profile` returns display name, safe Company/profile display name,
  role label, masked contact fields when approved, locale, account state, and
  mobile capability flags. It excludes raw IDs, tokens, and permission codes.
- `GET /me/preferences` exists for account text language/theme; an approved mobile
  notification-preference schema is still required.
- `PATCH /mobile/preferences` may accept locale and approved notification category
  booleans with optimistic versioning. No administration fields are accepted.

## Status compatibility

The backend delivery domain currently contains `new`, legacy `processing`,
`assigned`, `out_for_delivery`, `delivered`, combined `returned`, and `cancelled`,
with a separate return status. Mobile presentation maps `assigned` to “Assigned
to Driver.” It does not map `processing` to an approved status, and requires the
separate return status to distinguish Returned to Branch from Returned to Trader.
