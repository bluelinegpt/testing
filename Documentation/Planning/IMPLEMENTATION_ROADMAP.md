# Implementation Roadmap

## Validation Result

The proposed Prompt 1-23 roadmap is technically sound with dependency gates. The sequence below preserves the numbering while clarifying what each prompt may begin and what must already be approved.

## Cross-Cutting Rule

Every prompt includes documentation, migrations where authorized, unit/integration/security tests, tenant-isolation checks, Arabic/English considerations, API documentation, and CI validation. Prompt 23 verifies these controls; it does not introduce them for the first time.

## Revised Prompt Sequence

| Prompt | Scope                                                           | Entry Gate                                            | Exit Evidence                                                                                                |
| -----: | --------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
|      1 | Project Foundation and Architecture                             | Stack/Git approval                                    | Git repository, structure, ADRs, empty app shells, CI baseline, setup docs; no speculative production schema |
|      2 | PostgreSQL Schema Validation and Database Foundation            | Existing SQL supplied or new-schema design authorized | Object-by-object gap report, approved changes, migrations, database tests/docs                               |
|      3 | Multi-Tenant SaaS Foundation                                    | Prompt 2 tenant model approved                        | Tenant context, company isolation, platform context, cross-tenant tests                                      |
|      4 | Authentication, Users, Roles and Permissions                    | Expanded permission matrix approved                   | Auth/session/recovery/lockout, granular RBAC, authorization tests                                            |
|      5 | Platform Administration                                         | Prompts 3-4 accepted                                  | Company lifecycle, first admin, disablement, usage visibility, audit                                         |
|      6 | Company Configuration and Localization                          | Company foundation accepted                           | Profile, areas, AED/VAT config, Arabic/English and RTL/LTR foundation                                        |
|      7 | Trader Management and Pricing                                   | Areas/config ready                                    | Trader account, profile, import, pricing and override audit                                                  |
|      8 | Driver Management                                               | Identity/files ready                                  | Driver types, documents, expiry, compensation profiles                                                       |
|      9 | Core Order Management                                           | Traders/pricing/drivers ready                         | Order model, references/barcodes, items/packages, create/edit/cancel rules                                   |
|     10 | Order Workflow and Status Engines                               | Order aggregate accepted                              | Five state dimensions, transitions, invalid-state and audit tests                                            |
|     11 | Excel Order Import                                              | Order validation stable                               | Template, all-or-nothing validation, row/column errors, 5,000-row tests                                      |
|     12 | Order Operations                                                | Workflow ready                                        | Assignment/reassignment, operations queues, returns, waybill groundwork                                      |
|     13 | Web Portal Dashboard and Core UI                                | API/auth/operations ready                             | Platform/company shell, role navigation, operational KPIs and alerts only                                    |
|     14 | Trader Web Portal                                               | Trader/order APIs ready                               | Own-data order, tracking, paid/unsettled journeys                                                            |
|     15 | Flutter Mobile Foundation                                       | Stable API/auth/localization                          | Android/iOS project, secure tokens, API client, role navigation, RTL                                         |
|     16 | Driver Mobile Application                                       | Prompt 15 and workflow ready                          | Assigned orders, maps/call/GPS/photo/status/history                                                          |
|     17 | Trader Mobile Application                                       | Prompt 15 and trader APIs ready                       | Create/view/track/settlement status/profile                                                                  |
|     18 | Driver Reconciliation and Cash Collection                       | Financial clarifications approved                     | Eligible orders, split payment, employee/outsourced rules, reversals                                         |
|     19 | Expenses and Trader Settlements                                 | Prompt 18 controls ready                              | Operating/order expenses, multi-order settlements, reversals, audit                                          |
|     20 | Finance, VAT and General Ledger                                 | VAT/revenue/rounding and posting rules approved       | COA, balanced posting, periods, VAT liability, trial balance/P&L                                             |
|     21 | Payroll and Driver Payables                                     | Driver/finance foundations ready                      | Payroll periods, employee/outsourced calculations, approval/reversal                                         |
|     22 | Reports, Public Tracking and International Shipments            | Source modules stable                                 | Reports/exports, secure tracking, documents, international processing                                        |
|     23 | Final Integration, Security, Performance and Release Validation | Infrastructure Gate and prior prompts accepted        | Full regression, cross-tenant/security/load/recovery/UAT evidence and release docs                           |

## Important Sequence Clarifications

- Prompt 2 is blocked today because no SQL schema exists.
- Prompt 3 must precede all tenant-owned feature work.
- Prompt 4 must precede sensitive business endpoints.
- Prompt 10 must precede financial eligibility logic.
- Prompt 13 dashboard is staged: operational KPIs first; reconciliation/settlement/revenue KPIs arrive with Prompts 18-20.
- Prompt 20 cannot proceed until VAT and revenue treatment are approved.
- Prompt 23 requires the Infrastructure Decision Gate; development environments may be local/temporary before that gate.

## Release Mapping

| Release                           | Prompts |
| --------------------------------- | ------- |
| R1 Foundation and Core Operations | 1-14    |
| R2 Flutter Mobile                 | 15-17   |
| R3 Collections and Settlements    | 18-19   |
| R4 Finance and Payroll            | 20-21   |
| R5 Completion and Hardening       | 22-23   |

## Definition of Done for Every Prompt

- Approved scope and decisions are traceable to requirement IDs.
- Code follows module boundaries and contains no secrets.
- PostgreSQL migrations are reversible/controlled where applicable.
- Backend authorization and tenant checks are tested.
- Financial/workflow changes are transactional and auditable.
- API and module documentation is updated.
- Unit/integration/API/UI tests appropriate to risk pass in CI.
- Arabic/English and RTL/LTR impact is addressed.
- No unrelated requirement or feature is silently added or removed.
