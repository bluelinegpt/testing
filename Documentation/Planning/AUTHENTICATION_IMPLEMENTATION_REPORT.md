# Authentication Implementation Report

Implementation date: 2026-07-13

## Implemented

- Separate Company and platform-administrator login routes.
- Salted adaptive scrypt password hashing and constant-work dummy verification.
- Opaque 256-bit Bearer sessions with only SHA-256 token hashes stored in PostgreSQL.
- Configurable 5-failure temporary lockout and session expiration.
- Immediate logout revocation and account/Company/session revalidation per request.
- Database-resolved role permissions and a reusable `RequirePermissions` guard contract.
- Async request identity and Company context initialized for the full HTTP lifecycle.
- Database scope triggers preventing cross-Company session and reset-token records.
- Explicit platform/Company identity-kind policies in the global authorization guard.
- One-time, concurrency-serialized, audited platform-administrator bootstrap command.
- Company-scoped permission catalog, role listing, and transactional custom-role creation.
- Custom-role update/deactivation with system-role and last-administrator protection.
- Company user listing, active-role replacement, unlock, and reason-required deactivation.
- Immediate session revocation for deactivated users and self-lockout prevention.
- Responsive English/Arabic Company login and identity-administration screens.
- In-memory-only web access tokens, user listing, role assignment, unlock/deactivate actions,
  and custom-role create/edit controls.

## Verification

- 31 API unit tests passed, including hashing, token uniqueness, lockout, permission denial,
  session revalidation, and request context behavior.
- A PostgreSQL-backed API test passed with two Companies using the same username: wrong-
  Company credentials failed, each login resolved its own Company and permissions, and logout
  revoked the session immediately. Generated test rows were removed by exact UUID.
- A second PostgreSQL/API journey runs entirely inside a forced rollback transaction. It
  verifies singleton platform bootstrap, platform denial from Company role routes, independent
  same-code role creation for two Companies, isolated role lists, and scoped audit events.
- The journey now also verifies role update, protected system roles, cross-Company role/user
  identifiers, self-lockout denial, user listing isolation, role assignment, unlock, user
  deactivation, session revocation, and append-only audit records before forced rollback.
- Rollback-only schema verification passed 51 business tables and 15 hardening triggers,
  including rejected cross-Company session and password-reset records.
- Nine web tests passed, including login, Bearer-token use, localization/RTL behavior, API
  errors/timeouts, and authenticated workspace loading.
- Desktop and 390-pixel mobile browser checks passed for login, users, roles, and the role
  permission editor without horizontal overflow.

## Remaining

- `B-006`: approve the complete sensitive permission matrix before affected endpoints ship.
- Implement account invitation/provisioning and approved password-recovery delivery.
- Decide privileged-account controls while MFA remains excluded from current requirements.
- Apply trusted Company context and object authorization to every domain repository/API.
- Resolve `B-009` before implementing Company provisioning or lifecycle transitions.
