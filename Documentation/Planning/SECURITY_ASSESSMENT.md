# Security Assessment

## Context

The workspace contains no running application or infrastructure. Findings are security-readiness gaps, not verified exploitable vulnerabilities. Version 3.0 is the governing control baseline.

## Critical

No current exploitable application finding can be established because no code, database, secrets, or deployment exists.

Release must be blocked if cross-tenant isolation, authorization, financial immutability, or private-file access tests fail.

## High

| Finding                                            | Impact                                  | Required Control                                                                                                |
| -------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Tenant isolation is not implemented                | Cross-company disclosure/modification   | Server-derived tenant context, tenant-aware queries/FKs/uniques, defense-in-depth RLS, attack tests             |
| Authentication/session security is not implemented | Account compromise                      | Adaptive hashing, secure reset, lockout, rate limiting, short-lived access and revocable refresh/session design |
| Granular authorization is not implemented          | Privilege escalation/financial abuse    | Deny-by-default permission policies enforced in backend use cases                                               |
| Driver identity files have no storage design       | Sensitive document exposure             | Private object storage, authorization, malware/type/size validation, signed short-lived access, audit           |
| Financial/audit immutability is not implemented    | Fraud or loss of evidence               | Append-only history, reversals, restricted permissions, transaction boundaries                                  |
| MFA is excluded                                    | Higher privileged-account takeover risk | Reconfirm decision; strengthen platform/admin recovery, monitoring, rate limiting, and session controls         |

## Medium

| Finding                                  | Required Decision or Control                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Permission matrix is incomplete          | Expand before Prompt 4 and test each sensitive action                                           |
| Password reset/recovery details absent   | Single-use expiring tokens, notification, session revocation, no account enumeration            |
| Token/session lifetimes absent           | Define access/refresh lifetime, rotation, revocation, device/session management                 |
| CORS/CSRF policy absent                  | Explicit origins; same-site/anti-CSRF controls where cookie auth is used                        |
| Mobile token storage absent              | Platform secure storage; never plaintext preferences/logs                                       |
| Public tracking expiration undecided     | Approve expiration/revocation policy before production                                          |
| Audit retention only “at least one year” | Define category-specific security, financial, and document retention                            |
| Log redaction rules absent               | Structured allowlist logging; exclude credentials, tokens, IDs/documents, and sensitive finance |
| Upload controls not selected             | MIME/content signature, size, malware scanning, quarantine, authorized download                 |
| Secrets management not selected          | Environment-specific managed secret store; rotation and least privilege                         |

## Low

- No dependency, secret, static-analysis, or container scanning is configured.
- No security headers or content-security policy can be assessed.
- No incident-response or vulnerability-disclosure procedure exists.

## Tenant Isolation Strategy

- Derive `company_id` from authenticated membership; never trust a client-supplied company identifier.
- Require tenant scope in every tenant-owned repository/query and composite relationship.
- Use PostgreSQL row-level security as a second barrier where compatible with the selected data-access approach.
- Separate Platform Administrator commands from tenant commands and audit privileged access.
- Include tenant context in jobs, caches, files, reports, exports, and logs.
- Public tracking queries use only random tokens and return a strict DTO; they never create a general tenant bypass.

## Cross-Tenant Test Set

For tenants A and B, attempt:

- Read/update/delete by guessed identifiers.
- Foreign-key association across tenants.
- List/filter/search/report/export leakage.
- Attachment metadata and download leakage.
- Background-job execution under the wrong tenant.
- Cache-key collisions.
- Public tracking token enumeration and data expansion.
- Platform-context abuse by tenant accounts.

Every test must fail closed and be part of CI.

## Security Gates

- Prompt 1: threat model, security ADRs, scanning baseline, secret policy.
- Prompt 3: tenant isolation design and cross-tenant tests.
- Prompt 4: authentication, session, recovery, lockout, and RBAC tests.
- Each feature prompt: input, authorization, tenant, logging, audit, and abuse-case tests.
- Prompt 23: independent security review, dependency scan, attack tests, and release evidence.
