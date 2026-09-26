# BluelineGPT Mobile Integration — Prompt 12A Status

Date: 2026-08-08

## Status

`BLOCKED`

Prompt 13 remains blocked. The Customer messaging implementation is in progress and must not yet receive the Prompt 13 handoff marker.

## Migration-count investigation

The prior observed count was 60; the current validator reports 103.

- The validator scans only `database/migrations` and accepts only production migration filenames matching a fourteen-digit timestamp followed by a lowercase descriptive name.
- There are 103 files in that directory, no duplicate timestamps, no archived directory, generated migration output, test migration, or SQL file included in that count.
- Git currently tracks 58 migration files and the working tree contains 45 additive migration files awaiting normal repository review. This explains the difference from the older 60-file observation: the current workspace contains later legitimate BluelineGPT work in addition to the original tracked baseline.
- The validator discovery logic has not broadened; it uses one fixed directory. Migration ordering validation passed for all 103 files.
- The configured guarded database is `blueline` on localhost. Its authenticated migration history could not be read: two read-only attempts timed out. No migration was applied and no database data was changed in this closure slice.

## Implemented Customer identity slice

- `POST /api/v1/communication/customer/sessions` accepts only the established high-entropy tracking credential. It stores only a SHA-256 hash of the new, 32-byte Customer messaging token.
- A Customer messaging principal is separate from an internal account session. Each validation rechecks token hash, session expiry/revocation, tracking-token expiry/revocation, Company activity, Order scope, and Customer active status.
- Customer REST routes use `x-customer-messaging-token` and are limited to resolve, message history, text send, mark-read, unread count, and event recovery for one Customer-to-Office Order conversation.
- Customer WebSocket access uses the separate `customerToken` handshake value. The server resolves the allowed conversation itself and rejects a supplied different conversation identifier.
- Migration `20260810700000_customer_messaging_session_scope.ts` adds explicit session-backed Customer participant and durable-event scope. It does not manufacture an internal user for the Customer.

## Security properties

- Order number, external reference, mobile number, Customer name, Company ID, and Customer ID are never accepted as messaging authorization.
- Customers cannot select a Trader, Driver, Operator, or another Customer conversation.
- Customer events are stored and replayed against the Customer messaging session, not a company-wide account event stream.
- Session expiry, tracking-token revocation, Company inactivity, and Customer deactivation fail closed for REST and WebSocket revalidation.

## Validation completed for this slice

- API formatting for changed source files: passed.
- API communication lint: passed.
- API typecheck: passed.
- API production build: passed.
- Existing WebSocket gateway regression suite: 6 passed.
- Migration ordering validation: 103 migrations passed.
- Secret scan: passed.
- API typecheck: passed.
- API production build: passed.

## Validation blocked or incomplete

- Database-backed security, integration, migration-application, and cleanup tests were not run because authenticated access to the guarded `blueline` database timed out. PostgreSQL port 5432 is reachable, but this does not prove that the configured credentials/session can execute queries.
- The complete API suite was not run: an attempt was rejected because it can execute destructive database tests while guarded access is unverified. A safe non-database run started after typecheck/build but exceeded the execution window during Vitest reporting, so it is not recorded as passed.
- Web and mobile full regressions have not been run in this closure slice.

## Remaining mandatory closure

1. Apply the new migration in the guarded database environment and add Customer database/integration fixtures.
2. Add and run Customer session, REST, WebSocket, cross-company, cross-role, prohibited-route, revocation, and replay security tests.
3. Add explicit event-driven `permission.changed` and `session.revoked` delivery/disconnect behavior.
4. Run the full API, web, mobile, migration, secret, and UTF-8 baseline.
5. Document a production multi-instance broker/fanout choice before production deployment.

## Final decision

`Prompt 13 — BLOCKED`

Do not issue `READY_FOR_BLUELINEGPT_MOBILE_INTEGRATION_PROMPT_13` until the remaining security tests and full baseline have passed.
