# Requirements Gap Analysis

## Baseline

Primary source: `Documentation/BluelineGPT_FINAL_MASTER_REQUIREMENTS_v3.0.docx`.

Version 3.0 is newer than and explicitly supersedes Versions 1.0 and 2.0. No newer approved baseline exists. The legacy `System Menu Studyver1.docx` may inform UI discovery but cannot change confirmed requirements.

## Repository-to-Requirement Status

Because no application code, schema, or infrastructure exists, every implementation module is Not Started.

|   # | Module                      | Status            | Evidence / Primary Gap                   |
| --: | --------------------------- | ----------------- | ---------------------------------------- |
|   1 | Platform Administration     | Not Started       | No source or schema                      |
|   2 | Company Administration      | Not Started       | No source or schema                      |
|   3 | Authentication              | Not Started       | No identity configuration                |
|   4 | Users                       | Not Started       | No source or schema                      |
|   5 | Roles                       | Not Started       | No RBAC model                            |
|   6 | Permissions                 | Not Started       | V3 matrix exists; no implementation      |
|   7 | Company Configuration       | Not Started       | No source or schema                      |
|   8 | Areas                       | Not Started       | No source or schema                      |
|   9 | Arabic/English Localization | Not Started       | No web/mobile projects                   |
|  10 | Traders                     | Not Started       | No source or schema                      |
|  11 | Trader Pricing              | Not Started       | No source or schema                      |
|  12 | Drivers                     | Not Started       | No source or schema                      |
|  13 | Driver Documents            | Not Started       | No private storage design                |
|  14 | Orders                      | Not Started       | No source or schema                      |
|  15 | Excel Import                | Not Started       | No template/parser/validation            |
|  16 | Order Assignment            | Not Started       | No source or schema                      |
|  17 | Delivery Workflow           | Not Started       | V3 transitions documented only           |
|  18 | Driver Reconciliation       | Not Started       | No source or schema                      |
|  19 | Cash Collection             | Not Started       | No source or schema                      |
|  20 | Split Payments              | Not Started       | No source or schema                      |
|  21 | Expenses                    | Not Started       | No source or schema                      |
|  22 | Trader Settlement           | Not Started       | No source or schema                      |
|  23 | Finance                     | Not Started       | No ledger/data model                     |
|  24 | General Ledger              | Not Started       | No chart/posting rules implemented       |
|  25 | VAT                         | Not Started       | Basic rules partial; no implementation   |
|  26 | Payroll                     | Not Started       | No source or schema                      |
|  27 | Driver Payables             | Not Started       | No source or schema                      |
|  28 | Reports                     | Not Started       | No query/report engine                   |
|  29 | Dashboard                   | Not Started       | KPI definitions only                     |
|  30 | Public Tracking             | Not Started       | Token controls documented only           |
|  31 | Barcode                     | Not Started       | No generation/scanning implementation    |
|  32 | Waybill                     | Not Started       | No template/generator                    |
|  33 | International Shipments     | Not Started       | No source or schema                      |
|  34 | Flutter Foundation          | Not Started       | No Dart project                          |
|  35 | Driver Mobile App           | Not Started       | No Dart project                          |
|  36 | Trader Mobile App           | Not Started       | No Dart project                          |
|  37 | Audit Trail                 | Not Started       | No append-only audit design              |
|  38 | SaaS Metering               | Not Started       | No events/schema                         |
|  39 | Security                    | Not Started       | Requirements only                        |
|  40 | Testing                     | Not Started       | No test projects/configuration           |
|  41 | Documentation               | Foundation Exists | Requirements plus Prompt 0 planning docs |
|  42 | CI/CD                       | Not Started       | No Git or workflow files                 |
|  43 | Deployment Readiness        | Not Started       | Infrastructure gate unresolved           |

## Requirements-Level Gaps and Conflicts

| Finding                                                                                                | Classification                      | Impact                                          | Recommendation                                                  | Approval                              |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | ------------------------------------- |
| Part I lists financial states inside the order status list while `WF-001` requires separate dimensions | Conflicting                         | Developers may build one combined status column | Treat `WF-001` to `WF-008` as binding and align Part I wording  | Documentation correction              |
| Permission matrix omits several sensitive operations                                                   | Partially Compliant / Security Risk | Inconsistent or overbroad authorization         | Expand matrix before Prompt 4                                   | Project Owner                         |
| `FIN-005` does not explicitly exclude VAT from company revenue                                         | Financial Integrity Risk            | Revenue and profit may be overstated            | Define revenue net of VAT and update formula/test cases         | Project Owner/accounting reviewer     |
| VAT inclusion/exclusion and calculation sequence are unspecified                                       | Partially Compliant                 | Invoice, rounding, and ledger discrepancies     | Approve tax basis, line/document rounding, credit-note behavior | Project Owner/accounting reviewer     |
| SQL schema is referenced but absent                                                                    | Missing / Data Integrity Risk       | Prompt 2 cannot validate or implement database  | Supply schema or authorize a new schema design                  | Project Owner                         |
| Approval record is blank                                                                               | Missing governance evidence         | “FINAL” status lacks named approval             | Complete owner/business/technical approvals                     | Project Owner                         |
| Prompt 0 adds measurable performance/import/file targets not present in V3                             | Partially Compliant                 | Baseline authority is unclear                   | Record targets in approved baseline or ADR                      | Project Owner/technical reviewer      |
| Tracking-token expiration remains undecided                                                            | Security Risk                       | Old links could remain valid indefinitely       | Approve expiration policy before production                     | Project Owner/security reviewer       |
| One-year audit retention may not equal financial-record retention                                      | Data Integrity / Governance Risk    | Required records may be removed too early       | Define retention by record category and jurisdiction            | Project Owner/legal/accounting review |

## Traceability Assessment

Part II onward uses stable IDs (`BR`, `WF`, `FIN`, `ARCH`, `DB`, `SEC`, and others). Most Part I requirements do not have individual identifiers, and the V3 traceability matrix refers to Part I generically. Before UAT, assign stable IDs or create a section/acceptance-case mapping so every requirement has implementation and test evidence.

## Conclusion

The requirements baseline is strong enough for architecture planning. Implementation compliance cannot be claimed because the software and schema do not exist. Database work is blocked; Prompt 1 foundation planning can proceed after stack and Git authorization.
