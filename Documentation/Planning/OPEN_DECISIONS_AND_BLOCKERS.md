# Open Decisions and Blockers

## Actual Blockers

### Resolved Before Prompt 1 Scaffolding

| ID    | Resolution                                                                                           | Resolved On |
| ----- | ---------------------------------------------------------------------------------------------------- | ----------- |
| B-001 | TypeScript platform approved: NestJS API, React web, Flutter mobile, and PostgreSQL                  | 2026-07-13  |
| B-002 | Project Owner authorized Git initialization; the repository was initialized with `main` as HEAD      | 2026-07-13  |
| B-003 | Project Owner authorized a new PostgreSQL schema; five migrations were validated and applied locally | 2026-07-13  |

### Before Financial Implementation

| ID    | Blocker                                                              | Required Resolution                         | Owner                               |
| ----- | -------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------- |
| B-004 | VAT-inclusive/exclusive behavior and rounding sequence are undefined | Approve calculation/invoice/posting rules   | Project Owner / Accounting Reviewer |
| B-005 | `FIN-005` does not explicitly exclude VAT from revenue               | Approve corrected revenue formula and tests | Project Owner / Accounting Reviewer |

### Before Prompt 4 Permission Completion

| ID    | Blocker                                   | Required Resolution                     | Owner                             |
| ----- | ----------------------------------------- | --------------------------------------- | --------------------------------- |
| B-006 | Permission matrix omits sensitive actions | Approve expanded role/permission matrix | Project Owner / Security Reviewer |

### Before Commercial SaaS Implementation

| ID    | Blocker                                    | Required Resolution                                                                                                                                                               | Owner                                            |
| ----- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| B-007 | Commercial operating model is not approved | Approve plans/prices, trials, subscriptions, entitlements, access rules, billing and invoice process, payment method/provider, tax treatment, contracts, and commercial lifecycle | Project Owner / Product / Finance / Legal Review |

### Before Post-Launch Operation

| ID    | Blocker                                           | Required Resolution                                                                                                                                                                       | Owner                                           |
| ----- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| B-008 | Post-launch service operating model is unapproved | Approve service ownership, support channels, support access, severity/priority/status definitions, escalation, communication, incident authority, review cadence, and service commitments | Project Owner / Operations / Security / Support |

### Before SaaS Customer Launch

| ID    | Blocker                                            | Required Resolution                                                                                                                                                                                                                   | Owner                                           |
| ----- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| B-009 | Customer onboarding and launch model is incomplete | Reconcile Company lifecycle states and approve provisioning/activation authority, initial administrator flow, onboarding completion, suspension/offboarding, pilot acceptance, go-live approval, hypercare, containment, and rollback | Project Owner / Product / Operations / Security |

## Non-Blocking Decisions

| ID    | Decision                                                                       | Decision Deadline                      |
| ----- | ------------------------------------------------------------------------------ | -------------------------------------- |
| D-001 | Data-access/ORM and PostgreSQL RLS approach                                    | Prompt 2/3 design                      |
| D-002 | REST/OpenAPI conventions and authentication/session model                      | Prompt 1/4                             |
| D-003 | Object storage and upload scanning implementation                              | Before Prompt 8 production behavior    |
| D-004 | Tracking-token expiration policy                                               | Before Prompt 22 production behavior   |
| D-005 | Record-category retention periods                                              | Before production Infrastructure Gate  |
| D-006 | Privileged-account controls while MFA is excluded                              | Prompt 4                               |
| D-007 | Add Prompt 0 latency/concurrency/import/file targets to approved baseline/ADR  | Prompt 1                               |
| D-008 | Framework-supported browser and mobile OS matrix                               | Prompt 1/15                            |
| D-009 | Actual cloud/region/RPO/RTO/uptime/monitoring stack                            | Infrastructure Decision Gate           |
| D-010 | KPI date/status/filter semantics plus alert thresholds and ownership           | Before dashboard/report implementation |
| D-011 | External API, webhook, identity, connector, and synchronization scope/security | Before external integration design     |

## Documentation Corrections

These do not change business intent but should be resolved in the next controlled requirements revision:

- Align Part I combined status list with `WF-001` through `WF-008`.
- Complete the Version 3.0 approval table with names, decisions, and dates.
- Expand Part I requirement traceability beyond a generic section reference.
- Add the actual automatic Table of Contents and page numbering.
- Correct the pricing-method heading levels.
- Mark all table header rows for accessibility.

## Prompt 1 Go/No-Go

Prompt 1 scaffolding is a GO. B-001 and B-002 were resolved on 2026-07-13. Prompt 1 must not create a speculative production schema.

The schema, authentication sessions, global API guard, Company request context, and approved
permission subset are implemented and locally verified. Domain repository scoping, business
workflows, the expanded sensitive permission matrix, and unresolved financial rules remain
separate gates.
