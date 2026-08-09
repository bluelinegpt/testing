# BluelineGPT Mobile Release and Operations Runbook

## Release identity

- Product: BluelineGPT
- Current source version: `1.0.0+1` (candidate only; build number must be incremented before any store upload)
- Android production ID: `com.bluelinegpt.mobile`
- iOS production ID: `com.bluelinegpt.mobile`
- Production display name: BluelineGPT
- Release tag convention: `mobile-v<semantic-version>-build.<number>`

No production endpoints, store account, signing identity, support contact, privacy-policy URL, or rollout owner is approved in the repository. Supply and approve them before release.

## Required production flags

Production builds must define `ENVIRONMENT_NAME=production`, non-loopback `https` `API_BASE_URL`, non-loopback `wss` `REALTIME_URL`, `ENABLE_VERBOSE_LOGGING=false`, and `ENABLE_MOCK_SERVICES=false`. The application now refuses to start when these controls are unsafe. Flags only control availability; backend authorization remains mandatory.

Keep communication, voice, push, customer access, and offline mutation unavailable until their authoritative backend contracts, storage, credentials, and security tests pass. Do not implement security as a client-only flag.

## Deployment sequence

1. Name the release owner, security approver, incident lead, and rollback authority.
2. Approve privacy/retention decisions and store disclosures.
3. Test a database restore; record RPO, RTO, owner, evidence, and timestamp.
4. Validate secrets, TLS, CORS/CSP, production database, private object storage, Firebase/APNS, monitoring, and alerts.
5. Deploy backward-compatible backend contracts and durable workers.
6. Apply forward-safe migrations after backup; validate liveness, readiness, and dependency health.
7. Deploy web; verify login, permissions, Company isolation, communication, Arabic/RTL, and browser security headers.
8. Enable WebSocket and notification workers for internal accounts; verify sequencing, retry, token ownership, and dead-letter handling.
9. Build signed mobile artifacts in protected CI. Retain checksums, symbol/mapping files, provenance, and test evidence.
10. Release to internal testers only. Execute the smoke checklist and security isolation tests.
11. Run a controlled pilot only after all Critical/High findings close and Android/iOS device tests pass.
12. Use staged rollout with live monitoring and a named stop authority.

## Rollback

Trigger rollback for authentication/tenant leakage, duplicate COD, data corruption, public voice access, token leakage, unsafe status transitions, sustained crash/error increase, or failed health dependencies.

- Backend/web: stop traffic expansion, disable affected workers/features, restore the previous compatible artifact, validate schema compatibility, health, authentication, and isolation.
- Database: prefer forward correction. Down-migrate only when the migration is explicitly reversible and data-loss impact is approved. Restore only under the tested recovery procedure.
- Notifications/WebSocket: pause workers/connections without discarding durable events; preserve idempotency and cursors.
- Mobile: halt store rollout. A published binary cannot be instantly removed from devices, so use server-side compatibility and approved kill switches; never bypass authorization.
- After rollback: reconcile pending actions/COD/notifications, preserve audit evidence, notify affected owners, and open an incident review.

## Smoke checklist

Record environment, build, tester, timestamp, Company/user IDs (not credentials), correlation IDs, and pass/fail for: health, four role logins, unsupported role, logout/deactivation, Trader Order creation/ownership, Operator assignment permission, Driver start/Cash/Bank/failure, cancellation/return rules, Customer-safe tracking, settlement/statement isolation, notification history/tap authorization, text/voice authorization, offline delivery/conflict/message/voice, token rotation, multi-device read state, Arabic/RTL, and account switching cache cleanup.

## Pilot plan

Recommended only after certification gates close: 2–5 Traders, 3–10 Drivers, 2 Operators, and limited Customers for at least five business days. Provide a named support channel, daily defect/security review, immediate escalation for financial or isolation incidents, and measurable go/no-go thresholds: no Critical/High defect, no duplicate COD, no cross-Company access, successful notification token ownership, bounded sync backlog, acceptable crash-free rate, and approved participant feedback.

## Store preparation

Google Play requires approved icons/feature graphic/screenshots, privacy-policy URL, Data Safety declaration, notification/microphone/background explanations, review account, content rating, countries, support contact, release notes, signing/upload key custody, and internal/closed/staged rollout plans.

App Store requires the approved icon set/screenshots, privacy/support URLs, App Privacy disclosure, microphone/push/background descriptions, review account, age rating, export-compliance decision, distribution certificates/profiles, APNS, TestFlight evidence, and phased-release stop plan.

Do not submit to either store without explicit authorization.

## Monitoring and incident response

Monitor authentication failures/revocations, forbidden/cross-tenant attempts, API latency/errors, database connections/locks, active sockets/reconnects, push invalid-token/failure/backlog, pending sync age/conflicts, prevented COD duplicates, voice failures, worker dead letters, and mobile crash/ANR rates. Alerts need owners, severity, paging targets, thresholds, and runbooks.

Security incidents involving isolation, credentials, COD, voice, or account compromise require immediate containment, evidence preservation, credential/session revocation as applicable, privacy/legal assessment, affected-data analysis, approved communications, recovery validation, and post-incident review. No private contact list is currently approved; operations must supply it before pilot.

## Backup, retention, and privacy gates

No tested restore evidence, RPO/RTO, backup owner, or approved message/voice/notification/device/cache retention schedule exists. Voice must be private, short-lived where pending, excluded from inappropriate backups, scoped by Company/user/conversation, and deleted after approved lifecycle completion. Legal/privacy owners must approve policy links, store disclosures, audit retention, tracking-token expiry, and data-subject handling. This document does not claim legal compliance.
