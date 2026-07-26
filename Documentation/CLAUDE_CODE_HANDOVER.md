# BluelineGPT Development Handover

## Purpose

This document hands the current BluelineGPT workspace to Claude Code for continued development.

Workspace: `C:\Dev\BlueLineGPT`

BluelineGPT is a company-scoped delivery operations SaaS built with:

- React and TypeScript web application
- NestJS and TypeScript API
- PostgreSQL
- Kysely
- pnpm workspace

Do not introduce terminology, schemas, workflows, formulas, branding, or assumptions from another project.

## Operating Instructions

Work autonomously for routine repository actions, including reading files, editing project files, running builds and tests, applying approved development migrations, and updating documentation.

Stop before:

- changing confirmed business requirements
- implementing a workflow whose business decision is still unresolved
- deleting important data
- running destructive database commands
- exposing credentials or secrets
- modifying files outside `C:\Dev\BlueLineGPT`
- deploying to production
- performing irreversible operations

Do not revert unrelated user changes. The repository may contain uncommitted or untracked work.

## Ports

Use only:

- API: `http://127.0.0.1:3000/api/v1`
- Web: `http://127.0.0.1:5174`

Do not use ports `5173` or `8787`; they belong to other applications.

## Local Environment

The root `.env` contains the local development configuration. Do not print or expose its values.

Useful commands:

```powershell
pnpm --filter @blueline/api db:migrate
pnpm --filter @blueline/api db:verify
pnpm migrations:validate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Database integration tests require:

```powershell
$env:RUN_DATABASE_INTEGRATION='true'
pnpm --filter @blueline/api test
```

Start development services:

```powershell
pnpm --filter @blueline/api dev
pnpm --filter @blueline/web dev -- --port 5174
```

## Current Validation Baseline

At the last completed validation:

- Migration validation passed with 18 ordered migrations.
- Schema verification passed with 66 business tables, 53 hardening triggers, and 23 integrity functions.
- API tests: 72 passed; database-dependent tests were skipped in the normal run.
- Enabled identity/database integration tests: 2 passed.
- Web tests: 29 passed.
- API and web type checking passed.
- Lint passed.
- API production build passed.
- Web production build passed.
- The web build has a non-blocking large-chunk warning around 646 KB.

Re-run the relevant checks after any new changes; do not rely only on this baseline.

## Recently Completed Phase: Users and Roles

The approved Users and Roles administration phase is complete.

Implemented behavior includes:

- Users and Roles under Configuration
- redirects from legacy Administration URLs
- company-scoped User and Role administration
- one `display_name` field while preserving legacy name columns
- case-insensitive email uniqueness within each Company
- immutable usernames
- generated immutable Role codes
- optional one-to-one Employee/User linkage
- Active User requires an active Role
- Active Role requires a Permission
- last-administrator protection with company-level locking
- no destructive User or Role deletion
- sessions list and revocation
- one-time cryptographic temporary passwords
- 24-hour temporary-password expiry
- forced password change
- session revocation on reset/change
- audit events without secrets
- English, Arabic, and RTL UI

Important migrations:

- `database/migrations/20260718010000_user_role_administration.ts`
- `database/migrations/20260718011000_user_role_trigger_forward_repair.ts`

Main implementation files:

- `apps/api/src/users/user-administration.service.ts`
- `apps/api/src/users/user-administration.controller.ts`
- `apps/api/src/roles/role.service.ts`
- `apps/api/src/roles/role.controller.ts`
- `apps/api/src/authentication/temporary-password.service.ts`
- `apps/api/src/authentication/authentication.service.ts`
- `apps/web/src/features/administration/UserRoleConfigurationWorkspace.tsx`
- `apps/web/src/features/authentication/PasswordChangeView.tsx`
- `apps/web/src/app/CompanyAppShell.tsx`
- `apps/web/src/app/CompanyWorkspace.tsx`

Screenshots are in:

`Documentation/screenshots/user-role-administration`

Deferred from that phase:

- email reset links
- re-authentication
- direct User permissions
- more granular administration permissions

## Current Phase: Driver Cash Reconciliation

The latest prompt requested a review before implementation. The review is complete, but implementation has not started because the prompt explicitly requires business decisions and approval first.

Do not modify reconciliation code or database objects until the user approves the decisions in the next section.

### Existing Reconciliation Implementation

The repository already contains two overlapping workflows:

1. Legacy per-Order confirmation:
   - API: `POST operations/orders/:orderId/reconcile-cash`
   - UI: `/driver-cash-reconciliation`
   - no idempotency
   - one payment only
   - no expenses
   - incomplete audit coverage

2. Selected/bulk reconciliation:
   - preview: `POST operations/cash/reconciliations/preview`
   - confirm: `POST operations/cash/reconciliations/selected`
   - explicit IDs or filter plus exclusions
   - multiple expenses
   - multiple payments
   - decimal backend calculations
   - row locking
   - transaction-level atomicity
   - idempotency records
   - database confirmation guards

Primary files:

- `apps/api/src/operations/orders-workflow.service.ts`
- `apps/api/src/operations/operations.service.ts`
- `apps/api/src/operations/operations.controller.ts`
- `apps/api/src/operations/operations.dto.ts`
- `apps/web/src/features/operations/OrdersModuleWorkspace.tsx`
- `apps/web/src/features/operations/OperationsWorkspace.tsx`
- `database/migrations/20260713230020_finance_accounting.ts`
- `database/migrations/20260713230030_scope_and_financial_hardening.ts`
- `database/migrations/20260715011000_financial_confirmation_integrity.ts`
- `database/migrations/20260715013000_financial_line_source_integrity.ts`
- `database/migrations/20260715014000_financial_line_update_guard.ts`

### Current Formula

The selected/bulk service currently calculates:

```text
Net Expected
= sum(orders.amount_collected)
- sum(orders.driver_cost)
- sum(reconciliation expenses)
```

Payment Total must equal Net Expected exactly. Decimal.js is authoritative on the backend. The database independently validates header totals, line totals, expenses, payments, zero-net behavior, and negative-net rejection.

### Current Eligibility

Current application and database rules require:

- current Company
- one matching assigned Driver
- Delivery Status `delivered`
- Driver Cash Status `pending`

Returned Orders are not currently eligible.

### Important Financial Conflict

`orders.driver_cost` is populated from the legacy outsourced per-delivered-Order fee snapshot.

The newer approved Driver commission system separately supports:

- Employee commission as payroll-only accrual
- Outsourced daily or monthly commission payment with non-overlap protection
- fixed or Service-Fee percentage rules

The current bulk reconciliation code deducts `orders.driver_cost`, while the separate commission system can pay the same outsourced commission later. This could duplicate the Driver benefit.

Do not select a deduction source without explicit approval.

## Decisions Awaiting User Approval

The previous review recommended the following decisions. Ask the user to approve or amend them before implementation:

1. Eligible Delivery Statuses: use `delivered` only; defer returned-Order exceptions.
2. Driver Payable Deduction: use `0.00` during cash reconciliation.
3. Employee commission: remain payroll-only and never deduct during daily cash handover.
4. Outsourced commission: remain in the separate daily/monthly commission payment workflow and do not deduct during cash reconciliation.
5. Disabled Driver: allow completion only for already-delivered pending Orders with proven historical assignment.
6. Drafts: defer user-managed Draft reconciliations; use atomic prepare-and-confirm.
7. Payment notes: omit because they are not currently supported.
8. Bank Reference: enforce case-insensitive Company-scoped uniqueness for reconciliation Bank Transfers.
9. Printing: implement print-friendly HTML and defer PDF generation.
10. Reversal: expose no Reverse action; defer the workflow.
11. Permission: use `reconciliations.create` for view, preparation, expenses, payments, and confirmation, with `users_roles.manage` as the administrative fallback.
12. Historical records: preserve unchanged and display unavailable actors/audits as `Legacy/Unknown`.

## Read-Only Database Findings

The local development database was audited without modification.

- Driver reconciliations: 2
- Confirmed: 2
- Draft: 0
- Reversed: 0
- Reconciliation Order links: 2
- Payments: 2
- Expenses: 0
- Expense Types: 0
- Header total mismatches: 0
- Payment total mismatches: 0
- Mixed-Driver reconciliations: 0
- Wrong-Driver links: 0
- Duplicate Order links: 0
- Reconciled Orders without links: 0
- Zero-net reconciliations: 0
- Negative-net reconciliations: 0
- Existing eligible delivered/pending Orders: 0
- Active Company bank accounts: 3
- Invalid bank references: 0
- Duplicate reconciliation bank references: 0
- Outsourced Drivers: 1
- Employee Drivers: 0
- Active Driver commission rules: 1
- Commission calculations: 0

Historical quality findings:

- Both existing confirmed payment rows have no recorded actor.
- Both existing reconciliations have status history but no reconciliation-level audit event.
- Both linked Orders lack detailed `order_events` reconciliation entries.
- Payment timestamps are present.
- Historical reconciliation deductions are `0.00` even though linked Orders have `driver_cost = 7.50`.

Do not fabricate actors, audit events, deduction values, or historical provenance. Preserve these records and expose missing information as `Legacy/Unknown`.

## Expected Reconciliation Implementation Sequence

After approval:

1. Create a non-destructive migration.
2. Seed the five approved Company Expense Types: Petrol, Water, Parking, Vehicle-related, and Other.
3. Add expense actor and optional reference support.
4. Add immutable reconciliation-reference protection.
5. Add stronger one-confirmed-reconciliation-per-Order validation.
6. Add approved Bank Reference uniqueness if confirmed.
7. Complete Kysely reconciliation table types.
8. Consolidate reconciliation logic into one service.
9. Remove the legacy per-Order action from the UI and safely retire or redirect its API workflow.
10. Add searchable Driver selection and server-side eligible Order pagination.
11. Preserve explicit-ID and filter-plus-exclusions selection.
12. Retain a stable idempotency key across frontend retries.
13. Add dedicated list, preparation, and details routes.
14. Add expenses, payments, Orders, and audit sections.
15. Add print-friendly HTML.
16. Add API, database, concurrency, idempotency, authorization, tenant, web, accessibility, and RTL tests.
17. Apply migration and run the full validation suite.
18. Perform browser verification on ports 3000 and 5174 and save screenshots.

## Known Reconciliation Gaps

- Two competing reconciliation workflows
- No dedicated preparation route
- No server-paginated reconciliation list
- No searchable Driver endpoint with pending total
- Pending cash endpoint is limited to 100 rows
- Inline details show only Orders and payments
- Expenses and audit history are absent from details
- No reconciliation receipt
- No API/web reconciliation test suite
- Only database integrity tests cover confirmation rules
- Most reconciliation Kysely tables are untyped
- Frontend preview uses JavaScript Number for display calculations
- Frontend creates a new idempotency key inside each submit attempt
- Legacy endpoint has no idempotency
- No real reversal workflow
- No user-managed Draft workflow
- Bank Reference uniqueness is not enforced
- Expense Types have not been seeded

## Safety Notes for Historical Data

- Do not rewrite either existing reconciliation.
- Do not change their totals, linked Orders, payments, references, dates, or statuses.
- Do not backfill payment actors without authoritative evidence.
- Do not fabricate reconciliation audits or Order events.
- Do not recalculate historical Driver commission or `driver_cost`.
- Do not add a fake reversal action.
- Preserve Delivery Status and Trader Settlement Status during reconciliation.

## Completion Expectations

Do not report the reconciliation phase complete unless:

- one-Driver enforcement exists in frontend, backend, and database
- backend revalidates and locks selected Orders
- confirmation is atomic
- idempotency prevents duplicates
- multiple expenses and payments work
- Payment Total equals Net Expected exactly
- zero-net has no payment rows
- negative net is rejected
- confirmed records are immutable
- Order cash status changes without changing Delivery or Trader Settlement status
- each newly reconciled Order receives append-only history and audit coverage
- Company isolation is tested
- migrations, database tests, API tests, web tests, lint, type checking, and builds pass
- browser verification is completed or honestly reported as pending
