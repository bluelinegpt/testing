# BluelineGPT Release UAT Scenarios

Assessment baseline: 2026-07-13

## Purpose

These scenarios define the minimum business acceptance journey for a release candidate.
They do not invent rules that are absent from the approved requirements. All scenarios are
currently **BLOCKED** because the authoritative business schema and workflows do not exist.

## Required Test Data

- Two synthetic Companies, `COMPANY_A` and `COMPANY_B`, with distinct users and Areas.
- Platform, Company Administrator, Operations, Cashier, Finance, Trader, and Driver actors
  only after the role and permission matrix is approved.
- Employee and outsourced Drivers, Traders with each approved pricing method, and Orders
  covering each approved payment condition.
- Approved financial golden cases, including VAT and rounding rules after `B-004` and
  `B-005` are resolved.
- No production personal data, credentials, documents, or payment details.

## Acceptance Scenarios

| ID      | Scenario                                                              | Minimum expected evidence                                                        | Status  |
| ------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------- |
| UAT-001 | Platform Company onboarding, activation, suspension, and reactivation | Lifecycle, authorization, audit, and access behavior                             | BLOCKED |
| UAT-002 | Company configuration and Area management                             | Validations, duplicate handling, audit, and Company scope                        | BLOCKED |
| UAT-003 | Trader creation, access, and pricing assignment                       | Approved permissions and pricing behavior                                        | BLOCKED |
| UAT-004 | Employee and outsourced Driver setup                                  | Document, compensation, eligibility, and access behavior                         | BLOCKED |
| UAT-005 | Manual Order creation                                                 | Persisted amounts, status dimensions, audit, and waybill identity                | BLOCKED |
| UAT-006 | Excel Order import                                                    | Template validation, all-or-nothing behavior, row errors, and idempotency        | BLOCKED |
| UAT-007 | Assignment and delivery                                               | Authorized transitions, concurrent-update handling, and proof evidence           | BLOCKED |
| UAT-008 | Failed delivery and physical return                                   | Separate delivery/return states and required dependencies                        | BLOCKED |
| UAT-009 | Driver cash reconciliation                                            | Expected versus received cash, adjustments, approval, and reversal               | BLOCKED |
| UAT-010 | Trader settlement                                                     | Eligible Orders, payable calculation, batching, payment, and reversal            | BLOCKED |
| UAT-011 | Reports, exports, dashboards, and public tracking                     | Correct filters/totals, permissions, Company scope, and safe tokens              | BLOCKED |
| UAT-012 | English/Arabic critical journeys                                      | Accurate translation, RTL/LTR layout, currency/date formatting, and print output | BLOCKED |
| UAT-013 | Company isolation attack journey                                      | Cross-Company ID, reference, file, export, job, and cache attempts are denied    | BLOCKED |
| UAT-014 | Backup and recovery of a release dataset                              | Restored counts, constraints, isolation, financial totals, and audit evidence    | BLOCKED |

## Execution Rules

1. Execute against an immutable release candidate in a production-like staging environment.
2. Record tester, date, build identifier, data-set identifier, result, and evidence link.
3. Treat an unexecuted or blocked scenario as not accepted; never convert it to a pass.
4. Retest every corrected defect and then run the complete critical-path regression.
5. Release requires Project Owner and designated business/finance/security acceptance.
