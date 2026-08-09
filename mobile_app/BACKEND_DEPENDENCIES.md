# Mobile backend dependencies

## Confirmed repository contracts

- API prefix: `/api/v1`
- `POST /auth/login`: identifier and password; Company is resolved from host
- `GET /auth/me`: authenticated identity and sorted effective permissions
- `POST /auth/logout`: revokes the current bearer session
- Errors: `{ "error": { "code", "message", "details", "correlationId" } }`
- Company scope is server-resolved and enforced; callers cannot select another
  Company through request data
- Money is serialized as fixed decimal strings

The current login response provides an access token but no refresh token.
Refresh behavior must remain disabled until the backend defines it.

## Missing contracts

- Device registration/upsert, token refresh, logout cleanup, platform, app
  version, locale, User, Company, and notification-category fields
- Notification payload allowlist and authorization-safe deep-link identifiers
- FCM/APNS server infrastructure and role/permission recipient rules
- Authenticated WebSocket URL, handshake, Company binding, subscriptions,
  sequencing, missed-event recovery, acknowledgements, and message APIs
- Conversation, text-message, read/delivered state, and voice metadata endpoints
- Offline sync cursor, idempotent command contracts, conflict versioning, expiry,
  and authoritative server timestamps
- Supported mobile role codes and permission-to-feature mapping
- Forgot-password API

These gaps are represented by interfaces only. No local simulation is considered
production behavior.
