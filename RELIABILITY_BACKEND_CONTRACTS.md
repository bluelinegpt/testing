# BluelineGPT Reliability Backend Contracts

Status: required dependency for production reliability. These routes are contracts, not implemented frontend endpoints. Final paths and payloads must be approved against the authoritative backend.

## Common rules

- Authenticate every request and resolve Company, user, role, permissions, and profile on the server.
- Reject client-supplied tenant ownership. Scope all records and uniqueness constraints by Company.
- Require `Idempotency-Key` for mutations; replay the original result for an equivalent request and return a stable conflict for a different payload.
- Return a correlation ID, authoritative server timestamp, resource version, and stable machine-readable error code.
- Classify retryability explicitly. Never retry unauthorized, forbidden, invalid, deactivated, or business-conflict responses automatically.
- Audit state-changing operations without storing access tokens, push tokens, message bodies, addresses, raw voice, or full bank references.

## Required contracts

| Capability              | Suggested contract                                     | Required behavior                                                                                       |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Device registration     | `PUT /mobile/device-registrations/{installationId}`    | Idempotent ownership transfer, environment binding, masked diagnostics, old-token deactivation          |
| Deregistration          | `DELETE /mobile/device-registrations/{installationId}` | Deactivate only the current authenticated user's association                                            |
| Notification history    | `GET /notifications?cursor=`                           | Authoritative paginated records and unread count                                                        |
| Notification read       | `PUT /notifications/{id}/read`                         | Object authorization, idempotency, multi-device event                                                   |
| Preferences             | `GET/PUT /notification-preferences`                    | Backend-authoritative multi-device preferences; mandatory security categories cannot be disabled        |
| Event recovery          | `GET /realtime/events?after=`                          | Ordered Company-scoped events, stable cursor, expiry/reset response                                     |
| Offline synchronization | `POST /mobile/sync/actions`                            | Bounded batch, per-action result, dependency handling, idempotent replay, no partial false confirmation |
| Action lookup           | `GET /mobile/sync/actions/{clientActionId}`            | Resolve timeout ambiguity by authenticated scope and idempotency key                                    |
| Conflict review         | `GET /operations/sync-conflicts`                       | Permission-protected Operator visibility with evidence and audit                                        |
| Message send            | `POST /conversations/{id}/messages`                    | Client message ID reconciliation, conversation authorization, idempotency                               |
| Voice upload/send       | Approved upload contract plus message mutation         | Private scoped storage, validation, retry/resume decision, confirmed cleanup                            |

## Offline action result

Each action result must return the client action ID and exactly one state: `confirmed`, `retryable_failure`, `permanent_failure`, or `conflict`. Confirmation requires a stable server confirmation ID and server version. Conflict requires a safe code, current authoritative state, and permitted next step. A timeout or missing result remains pending.

COD collection requires a database uniqueness constraint covering the logical delivery/collection operation in addition to request idempotency. A retry must never create another financial record.

## Jobs and monitoring

The backend needs a durable notification/synchronization worker with bounded exponential backoff, invalid-token deactivation, leases, dead-letter review, correlation IDs, and audit. Monitor registration failures, invalid-token rate, notification backlog, oldest pending action, conflicts, prevented COD duplicates, voice-upload failures, real-time reconnects, and failed jobs.

## Retention baseline requiring approval

Use the shortest operationally necessary retention. Pending/conflict records must survive retries and upgrades; confirmed transient voice files should be removed promptly; protected cache must be erased on logout, deactivation, Company/environment change, or account switching. Legal and financial retention must be approved by the business and security owners before production.
