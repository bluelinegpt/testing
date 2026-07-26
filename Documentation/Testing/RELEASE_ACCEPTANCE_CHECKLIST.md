# BluelineGPT Release Acceptance Checklist

Assessment baseline: 2026-07-13

Use `PASS`, `FAIL`, `BLOCKED`, or `NOT APPLICABLE` with evidence. A blank item is not a pass.

## Business Acceptance

| Gate                                                     | Current status | Required evidence                                     |
| -------------------------------------------------------- | -------------- | ----------------------------------------------------- |
| Approved requirements and workflow model                 | BLOCKED        | Corrections and open business decisions approved      |
| Company onboarding and administration                    | BLOCKED        | UAT-001 and UAT-002 pass                              |
| Trader and Driver management                             | BLOCKED        | UAT-003 and UAT-004 pass                              |
| Order creation, import, assignment, delivery, and return | BLOCKED        | UAT-005 through UAT-008 pass                          |
| Driver reconciliation                                    | BLOCKED        | UAT-009 plus financial reconciliation pass            |
| Trader settlement                                        | BLOCKED        | UAT-010 plus payable and reversal cases pass          |
| Reports, exports, dashboards, tracking, and documents    | BLOCKED        | UAT-011 and print/export reconciliation pass          |
| English and Arabic business journeys                     | BLOCKED        | UAT-012 passes on supported viewports                 |
| Business owner acceptance                                | BLOCKED        | Named approver, decision, date, and retained evidence |

## Technical Acceptance

| Gate                                                       | Current status | Required evidence                                         |
| ---------------------------------------------------------- | -------------- | --------------------------------------------------------- |
| Format, lint, type checks, unit tests, and builds          | PASS           | CI-equivalent local execution                             |
| Authoritative schema and migration chain                   | BLOCKED        | `B-003` resolved; clean apply/upgrade/rollback evidence   |
| Authentication, RBAC, and object authorization             | BLOCKED        | Positive and deny-by-default API/UI tests                 |
| Company isolation                                          | BLOCKED        | UAT-013 and two-Company attack suite pass                 |
| Financial golden cases                                     | BLOCKED        | `B-004`/`B-005` resolved; deterministic cases pass        |
| Transaction, concurrency, retry, and idempotency safety    | BLOCKED        | PostgreSQL integration evidence                           |
| Audit and security regression                              | BLOCKED        | Persisted audit checks, SAST/DAST, upload and token tests |
| Browser, responsive, and accessibility coverage            | BLOCKED        | Approved support matrix and automated/manual evidence     |
| Performance and representative volume                      | BLOCKED        | Approved targets pass with two active Companies           |
| Jobs, integrations, webhooks, and files                    | BLOCKED        | Implemented-scope failure/retry/isolation evidence        |
| Deployment, rollback, observability, and incident controls | BLOCKED        | Staging release exercise and alert evidence               |
| Backup, restore, and disaster recovery                     | BLOCKED        | Release-data restore and approved RPO/RTO evidence        |
| Critical/high defects                                      | BLOCKED        | Zero open critical; high defects formally dispositioned   |

## Release Decision Rule

- `RELEASE ACCEPTED`: every applicable gate passes and approvals are retained.
- `RELEASE ACCEPTED WITH CONDITIONS`: no safety, security, isolation, data-integrity, or
  financial gate is failed/blocked; only explicitly approved non-critical conditions remain.
- `RELEASE NOT ACCEPTED`: any critical workflow or safety gate fails, is blocked, or lacks
  evidence.

Current result: **RELEASE NOT ACCEPTED**.
