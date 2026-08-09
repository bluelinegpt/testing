# Authentication and access contracts

## Verified contracts

All routes use `/api/v1`, UTF-8 JSON, standardized error envelopes, and server
tenant enforcement.

### Login

- `POST /auth/login` with `{ "identifier": string, "password": string }`.
- Identifier supports username, email, or UAE-normalized mobile number.
- Company is derived exclusively from request hostname; no Company field is accepted.
- Response contains opaque `accessToken`, ISO `expiresAt`, `tokenType: Bearer`,
  and identity `id`, `companyId`, `displayName`, `username`, `kind`, permissions,
  and `forcePasswordChange`.
- `401 invalid_credentials` is intentionally generic for unknown Company,
  incorrect credentials, locked/disabled account, disabled Company, expired
  temporary password, or missing active Trader/Driver profile.
- Backend lockout starts after five failures; duration is server configuration.

### Current identity

- `GET /auth/me` with bearer authorization.
- Returns `identityId`, `companyId`, `kind`, permissions, `sessionId`,
  `forcePasswordChange`, and optional verified profile link/type/ID.
- The server rechecks session, account, Company, profile link, and permissions.
- An invalid or expired session returns `401 invalid_session`.

### Logout and password change

- `POST /auth/logout`, bearer authorization, no body, `204`.
- `POST /auth/change-password`, bearer authorization, request
  `{ "currentPassword", "newPassword" }`, `204`.
- Password errors include `current_password_invalid` and `password_reuse_denied`.

## Verified identity mapping

- `trader` and `driver` require a matching server-verified active profile.
- `company_user` is the current Operator-equivalent and requires effective permissions.
- `platform_administrator` is unsupported in the Company mobile application.
- Customer account identity is not implemented.
- The backend returns identity kind and effective permission codes, not Role names.

## Proposed missing contracts

These are documentation only and require backend approval.

### Refresh session

- Method/route: `POST /auth/refresh`.
- Request: refresh token and device ID.
- Response: rotated opaque access/refresh tokens and ISO expiries.
- Authorization: refresh-token proof; Company comes from the server session.
- Errors: `invalid_refresh_token`, `refresh_token_reused`, `session_expired`.
- Idempotency: serialize one refresh per device/session.

Until implemented, the app does not attempt refresh and returns to login after
an expired or rejected access token.

### Mobile session context

- Method/route: `GET /auth/mobile-context`; bearer authorization.
- Response: safe Company name, supported mobile capabilities, verified linked
  profile display name/state, preferred locale, and server context version.
- Errors: `mobile_role_unsupported`, `profile_inactive`, `company_access_removed`.
- Tenant isolation: every entity must match the authenticated session Company.

### Device registration

- Method/route: `PUT /mobile/devices/{deviceId}`.
- Request: FCM token, platform, environment, locale, and app version.
- Response: registration ID, token fingerprint, status, and update time.
- Authorization: bearer session; User and Company derive from the session.
- Errors: `device_token_invalid`, `device_registration_forbidden`.
- Idempotency: device ID plus environment is an upsert key.
- Deregistration: `DELETE /mobile/devices/{deviceId}`, idempotent `204`.

### Password recovery

- Method/route: `POST /auth/password-recovery`.
- Request: identifier; Company remains hostname-derived.
- Response: generic accepted response regardless of account existence.
- Authorization: public and rate-limited.
- Errors must never disclose whether the account exists.

### Real-time authentication

- Approved `wss` endpoint using bearer handshake or short-lived socket ticket.
- The server binds User and Company; the client cannot choose another Company.
- Every subscription is authorized against conversation/order and permissions.
- Errors: `realtime_unauthorized`, `subscription_forbidden`, `cursor_expired`.
- Recovery uses an ordered event cursor; push remains fallback only.

### Customer identity

- Requires an approved Customer account/link model and authenticated context.
- It must expose only Customer-owned tracking/order scope and no internal
  financial or operational data. Arbitrary Order IDs remain denied.
