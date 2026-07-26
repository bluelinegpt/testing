# Security Standards

## Core Rules

- Authenticate every protected request.
- Authorize granular permissions server-side.
- Derive tenant context server-side and fail closed.
- Never commit or log secrets, tokens, passwords, sensitive documents, or unnecessary personal/financial data.
- Use TLS in deployed environments and private storage by default.

## Foundation Controls

- Helmet security headers.
- Explicit CORS allowlist.
- Global server-side validation with unknown-field rejection.
- Safe centralized errors with correlation IDs.
- Structured JSON logging with redaction.
- Global rate-limit guard and request-size limit.
- Mandatory configuration validation.
- PostgreSQL readiness separated from liveness.

## Authentication and Sessions

Passwords use Node's adaptive `scrypt` implementation with per-password random salts. Login
issues a 256-bit opaque Bearer token; PostgreSQL stores only its SHA-256 hash. Sessions are
revocable, expire by configuration, and are revalidated with account, Company, role, and
permission state on every protected request. Five failed attempts cause a configurable
temporary lockout. Company login and platform-administrator login are separate routes.

The server derives Company context from the authenticated account/session, never from a
caller-supplied Company ID. Health and login routes are explicitly public; all other routes
fail closed through the global authentication guard. Password-reset storage exists, but no
recovery endpoint is exposed until an approved delivery provider and recovery workflow exist.

Platform and Company routes may additionally require an explicit identity kind. Platform
administrators cannot enter Company role administration even if future permission names
overlap. The initial platform administrator is created only by an operator-run command that
uses environment-held input, requires a 16-character minimum password, serializes concurrent
attempts with a PostgreSQL advisory lock, refuses to run after the first platform account,
and appends an audit event. Bootstrap credentials must never be stored in `.env` or shell
history.

Company identity administration denies self-deactivation and removal of the caller's own
`users_roles.manage` access. Role updates, role assignment, and user deactivation also reject
any transition that would remove the final active Company administrator. System roles are
immutable through the custom-role API, disabled users cannot be unlocked, and deactivation
revokes all active sessions in the same transaction.

## Files

Business modules depend on `FileStoragePort`, not a cloud SDK. Files are private, tenant-scoped, type/content/size validated, malware-scanned where selected, and accessed through authorized audited operations. Metadata belongs in PostgreSQL.

## Logging and Errors

Allowlist log fields. Redact authorization, cookies, passwords, and tokens. Client errors omit stack traces, SQL, internal paths, and sensitive identifiers. Server diagnostics remain access-controlled.

## Security Verification

CI will run secret, dependency, static, authorization, cross-tenant, and upload tests as the relevant implementation appears. A failed tenant-isolation test is release-blocking.
