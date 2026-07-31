# BluelineGPT Accounting Foundations

> The setup and activation UX derives readiness from these foundations. See
> `ACCOUNTING_SETUP_AND_ACTIVATION.md`. No parallel Accounting model was introduced.

## Scope

Accounting Prompt 1 extends BluelineGPT's existing partial Accounting schema. It establishes
Company-scoped, AED-only double-entry foundations without enabling operational posting.

Accounting Prompt 2 adds controlled backend operations for configuration, the Chart of Accounts,
the Fiscal calendar, Manual Journals, and Opening Balances. Accounting Prompts 3–5 add operational
posting, General Expenses, payments, and Cash/Bank management. Accounting Prompt 6 adds the
Company-scoped UI described in `ACCOUNTING_UI_AND_OPERATIONS.md`. Financial reports, PDFs,
year-end closing entries, Bank statement import, and full Bank reconciliation remain deferred.

Operational modules remain their own source of truth. Accounting does not change Order, COD,
Trader, Driver Collection, Payroll, Outsourced Driver fee, payment, settlement, or reversal
calculations and statuses.

## Existing model and compatibility

Migration `20260713230020_finance_accounting.ts` already created:

- `accounting_periods`
- `chart_of_accounts`
- `journal_entries`
- `journal_lines`
- the `journal` Company reference-counter type
- basic posted-journal balance and immutability triggers

The Accounting Prompt 1 migration evolves those tables in place. `accounting_periods` remains the
physical name for Fiscal Periods, `business_date` remains the Journal Date, `source_type` remains
the Journal Source, and `is_posting_account` remains the Posting Allowed flag. This avoids parallel
models and preserves existing references.

Legacy Accounting Period rows are attached to one Company-scoped `LEGACY` Fiscal Year. Existing
generic Account Classes are derived only from Account Type. They should be reviewed and
reclassified through a later controlled Chart of Accounts workflow before Accounting is enabled.

## Double-entry and money

- Every posted Journal must contain at least two Lines.
- Total Debit and Total Credit are derived from Lines and must be equal and greater than zero.
- Header totals are stored for stable querying but are not accepted as frontend-authoritative.
- A Line must contain exactly one positive side: Debit or Credit.
- Money uses `numeric(18,2)` and shared `Decimal`-based domain helpers.
- Exchange Rate uses `numeric(18,6)`.
- Base currency is AED and the current exchange rate is fixed at 1.
- Malformed values, excessive precision, negative amounts, non-finite values, overflow-shaped
  inputs, empty input, and scientific notation are rejected by the shared Accounting parser.

## Company isolation

All Accounting records carry Company scope. Composite foreign keys protect Account, Period,
Journal, Line, operational dimension, mapping, event, and opening-balance relationships. Read
queries always use the active tenant Company. Generic `subledger_id`, future
`general_expense_id`, and future `company_cash_account_id` cannot receive concrete foreign keys
until those approved entity tables/contracts exist.

## Accounting configuration

`accounting_configurations` stores one configuration per Company:

- Accounting Enabled
- Automatic Posting Enabled (database-constrained to `false` in this prompt)
- AED Base Currency
- Fiscal Year Start Month
- Accounting Method
- nullable System, Control, Cash, Bank, VAT, payable, and revenue Account assignments
- actor, timestamp, and version metadata

No fabricated Account IDs are seeded. Composite foreign keys enforce Company scope. A validation
trigger requires assigned Accounts to be active posting Accounts and applies specific compatibility
checks for Cash, Bank, Retained Earnings, and Current-Year Earnings.

`accounting_configuration_history` receives an immutable version snapshot on every configuration
insert or update. Version updates must advance exactly once. Application-level changes in later
prompts must also use the existing audit writer.

## Chart of Accounts

Account Codes are trimmed, non-empty text and remain unique per Company using the existing
case-normalized index. Leading zeroes are preserved.

Accounts support:

- English and Arabic names
- Type and Class
- Parent hierarchy
- Posting or summary behavior
- Control and System purposes
- active and effective dates
- normal balance
- explicit contra indicator
- AED currency
- actor, deactivation, timestamp, and version fields

### Types, Classes, and normal balance

Stable Account Types are Asset, Liability, Equity, Revenue, and Expense. Stable Classes cover Cash,
Bank, Receivables, fixed assets, payables, VAT, Equity, Revenue, and Expense classifications.

A database trigger and shared domain guard enforce each Class's compatible Type. Default normal
balances are Debit for Asset and Expense and Credit for Liability, Equity, and Revenue. An opposite
normal balance requires the explicit contra indicator; it is never inferred from the Account name.

### Hierarchy and cycles

Parent relationships use a Company-scoped self-reference. Parent and child Types and effective
date ranges must be compatible. Self-parenting is rejected.

Cycle prevention is layered:

1. `AccountingFoundationService` performs a recursive ancestor check in Company scope.
2. A database trigger repeats the recursive ancestor check as the final concurrency guard.

The stable conflict is `accounting_account_hierarchy_cycle`.

### Posting, summary, Control, and System Accounts

`is_posting_account` distinguishes posting Accounts from summary Accounts. Journal and Opening
Balance Lines reject summary or inactive Accounts.

Control Accounts are posting Accounts with a controlled purpose. Journal and Opening Balance
triggers require the appropriate Trader, Driver, Employee/Payroll, receivable, or VAT source
reference. Manual posting exceptions are not implemented.

Active System Account purpose is unique per Company. System purposes include Retained Earnings,
Current-Year Earnings, Rounding, and Suspense. No automatic Suspense or Rounding entry is created.

Accounts cannot be deleted. Type, Class, Code, or Normal Balance cannot be changed after posted or
reversed Journal history exists. Deactivation preserves all history.

## Fiscal calendar

`fiscal_years` supports Draft, Open, Closed, and Reopened states. Reopening requires an actor,
timestamp, and reason.

The evolved `accounting_periods` table represents Fiscal Periods and supports Future, Open,
Soft Closed, Closed, and Reopened states, deterministic Period numbers and codes, Adjustment
Period identification, lifecycle actors, and reason metadata.

Company-scoped database overlap triggers reject intersecting Fiscal Years and Fiscal Periods.
Periods must remain inside their Fiscal Year. Service-level posting-period resolution requires
exactly one Period for the Journal Date.

Posting is permitted only when both Fiscal Year and Fiscal Period are Open or Reopened. Future,
Soft Closed, and Closed Periods are rejected with stable errors. Calendar deletion or date changes
are blocked when dependent or posted history exists.

Prompt 2 provides deterministic monthly Period generation, opening, soft closing, closing, and
reasoned reopening. Closing is blocked by unposted Journals, incomplete Opening Balance Batches,
or other unresolved Accounting dependencies. Retained-earnings entries and year-end closing
entries remain deferred.

## Journal foundations

Journal Headers support:

- Company Journal Number
- Manual, Opening Balance, Operational, Adjustment, Closing, and Reversal types
- stable source and operational entity references
- Journal Date, Fiscal Year, and Fiscal Period
- AED currency and rate
- stored authoritative Debit and Credit totals
- correlation and idempotency references
- approval, posting, cancellation, and reversal metadata
- permanent original and reversing Journal links

Lifecycle constants support:

`draft -> balanced -> approved -> posted -> reversed`

Alternative controlled paths are `balanced -> draft` and `draft -> cancelled`. Database and domain
guards reject other transitions. Row locking is required by the later operational services.

The existing atomic Company reference counter remains the only numbering mechanism. A future
Journal creation service calls `AccountingFoundationService.nextJournalNumber` and allocates
`JRN-000001` at persistent Journal creation. Idempotency must be reserved before that call so a
replay does not consume a new number. Numbers are never reused.

Posted Journals and Lines are immutable. A posted Header may only make the controlled transition to
Reversed while linking a separate Reversal Journal and retaining all original financial fields.
Cancelled and reversed history also remains immutable.

## Journal Lines and reporting dimensions

Lines have deterministic numbers and verified Account and Company relationships. Reporting-ready
foreign keys cover Trader, Driver, Employee, Order, Trader Settlement, Driver Collection, Payroll
Period, Payroll Payment, Outsourced Driver Fee Accrual, Outsourced Driver Fee Payment, and Company
Bank Account. Generic source and subledger references supplement these relationships.

Prompt 2 snapshots Account Code and English/Arabic Account names onto Journal and Opening Balance
Lines. Existing Lines are backfilled from their linked Account; new Lines snapshot automatically.
Reversal Journals copy the original snapshots rather than rebuilding historical labels.

Indexes support Company/date, Period, Account, source, status, operational dimensions, and reversal
queries. Historical reports must read stored Journal and Account references rather than
recalculate from current operational master data.

## Accounting Events and posting contracts

`AccountingEventContract` is a typed, versioned fact contract. Operational modules provide typed
financial components, mapping keys, amount, Debit/Credit intent, subledger context, and source
references; they do not choose General Ledger Accounts.

`accounting_events` and `accounting_event_components` retain those facts in typed columns.
Supplementary JSON may add metadata but is not the only financial representation.

Duplicate protection uses:

- unique Company/Event Type/Source Type/Source ID/Event Version identity
- unique Company/idempotency key
- a SHA-256 hash of canonical event content
- permanent Event-to-Journal and reversal relationships

Retries with the same identity must compare hashes. A hash mismatch is
`accounting_event_payload_mismatch`; an identical posted retry returns the stored Event/Journal in
the later posting service. Posted Event identity, hash, and Journal relationship are immutable.
No Event processing or Journal creation is active in this prompt.

## Effective-dated Account mappings

`account_mappings` stores Company-scoped effective date ranges and optional Debit, Credit, VAT,
Fee, Expense, and Payable Accounts. Active ranges for a Mapping Key cannot overlap.

All assigned Accounts must be active posting Accounts in the same Company. Compatibility is based
on Account Type and Class, not names. Revenue, payable, and expense mappings receive specific
database checks. Historical mapping identity and Accounts cannot be rewritten; replacement uses a
new effective-dated row, while an existing row may only be end-dated/deactivated.

The read-only mapping-completeness endpoint groups required, configured, missing, inactive, and
summary-Account issues by Orders, Trader Receivables, Trader Settlements, Driver Collections,
Driver Expenses, Employee Payroll, Outsourced Driver Fees, General Expenses, Cash/Bank Transfers,
and VAT. It always reports automatic posting as disabled.

## Opening Balances

Opening Balance Batch and Line tables support Company reference, effective date, Fiscal Year and
Period, AED totals, lifecycle actors, posting Journal link, and Reversal Journal link. Lines use the
same one-sided amount, posting Account, Company, and Control Account subledger rules as Journal
Lines. Header totals are derived from Lines and validation requires equality greater than zero.
Batch references use the existing atomic Company counter with key
`accounting_opening_balance` and `OB-000001` formatting.

A posted Batch links to exactly one Journal. Reversal links a separate posted Reversal Journal
while the original Batch, Lines, and Journal remain stored.

## Prompt 2 operational lifecycle

Manual Accounting can be enabled only after an AED configuration exists, an open Fiscal Year and
Period exist, active posting Accounts exist, and configured system assignments remain
Company-scoped and compatible. Automatic posting remains database-disabled.

Draft Journals may be incomplete or unbalanced. Line changes run under a Journal row lock and the
database recalculates authoritative Header totals. Validation requires at least two valid active
posting Accounts and exact non-zero AED Debit/Credit equality. Manual Control Account posting is
prohibited.

The normal Journal lifecycle is `draft -> balanced -> approved -> posted`. An editable Balanced
Journal first returns to Draft. Unposted Draft, Balanced, or Approved Journals may be cancelled
with a reason; cancellation preserves history and creates no opposite financial entry. A Posted
Journal can only be corrected by a reasoned reversal in an Open or Reopened Period. Reversal
creates and posts a distinct Journal with Debit and Credit swapped, then links both immutable
records.

Opening Balance Batches use `OB-000001` Company numbering and support Draft, Validated, Approved,
Posted, and Reversed states. Posting an Approved Batch creates exactly one linked
`opening_balance` Journal in the same transaction. Reversal uses the operator's reversal date,
requires an Open or Reopened Period, and creates one linked posted Reversal Journal without
changing the original Lines.

Self-approval and self-posting are blocked when another active Company user has the corresponding
permission. A single-user Company may complete the lifecycle so Accounting cannot become
permanently unusable. Administrator fallback does not bypass this segregation policy.

Fiscal Year and Period rows are locked before financial records for posting and reversal. Closing
uses the same calendar locks and checks incomplete dependencies, preventing a concurrent close
and post from both succeeding.

Every financial write requires an `X-Idempotency-Key`. A canonical request hash detects key reuse
with different content, while exact completed retries return the stored response. Idempotency is
reserved before `JRN-` or `OB-` numbering, so retries do not consume extra references.

## Permissions and audit

Permission foundations:

- `accounting.view`
- `accounting.manage`
- `accounting.approve`
- `accounting.post`
- `accounting.reverse`
- `accounting.periods.manage`
- `accounting.chart_of_accounts.manage`
- `accounting.configuration.manage`

No permission is granted to any existing role by the Accounting migration. The established
`users_roles.manage` administrator fallback applies only where explicitly declared.

`AccountingFoundationService.audit` delegates to the existing `OperationsHistoryWriter` and
existing `audit_events` table. Later write workflows must audit configuration, Accounts, Fiscal
calendar, lifecycle changes, Events, mappings, and Opening Balances with Company, actor, entity,
correlation, and reason metadata. No second audit or idempotency subsystem is introduced.

## Accounting API

All routes are Company-scoped and permission guarded. The foundation read routes remain:

- `GET /operations/accounting/configuration`
- `GET /operations/accounting/accounts`
- `GET /operations/accounting/accounts/:accountId`
- `GET /operations/accounting/fiscal-years`
- `GET /operations/accounting/fiscal-periods`
- `GET /operations/accounting/mappings/completeness`
- `GET /operations/accounting/foundation-metadata`

Prompt 2 adds configuration readiness and management; Account hierarchy, dependency and lifecycle;
Fiscal Year and Period creation, generation and lifecycle; Manual Journal creation, editing,
validation, approval, posting, cancellation and reversal; and the equivalent Opening Balance
operations. All use the existing `/operations/accounting` route root.

Prompt 2 route groups:

- Configuration: `POST /configuration`, `PATCH /configuration`,
  `GET /configuration/completeness`, `POST /configuration/enable-manual-accounting`.
- Accounts: `GET /accounts/hierarchy`, `GET /accounts/:accountId/dependencies`,
  `POST /accounts`, `PATCH /accounts/:accountId`, `POST /accounts/:accountId/activate`,
  `POST /accounts/:accountId/deactivate`.
- Fiscal Years: `GET /fiscal-years/:fiscalYearId`,
  `GET /fiscal-years/:fiscalYearId/dependencies`, `POST /fiscal-years`,
  and `POST /fiscal-years/:fiscalYearId/{open|close|reopen}`.
- Fiscal Periods: `GET /fiscal-periods/:periodId`,
  `GET /fiscal-periods/:periodId/dependencies`, `POST /fiscal-periods`,
  `POST /fiscal-periods/generate`, and
  `POST /fiscal-periods/:periodId/{open|soft-close|close|reopen}`.
- Journals: `GET /journals/summary`, `GET /journals`, `GET /journals/:journalId`,
  `POST /journals`, `PATCH /journals/:journalId`, line add/update/delete/replace routes,
  and `POST /journals/:journalId/{validate|approve|post|cancel|reverse}`.
- Opening Balances: `GET /opening-balances/summary`, `GET /opening-balances`,
  `GET /opening-balances/:batchId`, `POST /opening-balances`,
  `PATCH /opening-balances/:batchId`, line add/update/delete/replace routes, and
  `POST /opening-balances/:batchId/{validate|approve|post|reverse}`.

## Known limitations and deferred functionality

- Existing generic Account Class backfills require controlled review.
- Account labels are snapshotted on financial Lines. Trader, Driver, Employee, and other
  subledger display names remain resolved through their immutable Company-scoped IDs because the
  Prompt 1 Line schema did not include entity-name snapshot columns.
- Fiscal boundaries are date-only. The readiness query uses the existing Company timezone setting
  and falls back to Asia/Dubai only when no Company setting exists.
- Accounting Prompt 4 adds the controlled General Expense and Expense Payment source models.
  `general_expense_id` and `general_expense_payment_id` are now Company-scoped Journal Line
  relationships. A selected Cash posting Account is retained in `company_cash_account_id`;
  Visa rows retain the existing Company Bank Account relationship.
- Configuration compatibility is strongest for explicit Cash, Bank, and earnings assignments;
  later management services must apply the complete purpose matrix before configuration changes.
- Prompt 3 adds the source-level automatic operational integration described in
  `AUTOMATIC_OPERATIONAL_ACCOUNTING.md`. It remains disabled for every Company until an authorized
  user passes readiness and explicitly enables selected operational areas.
- Accounting UI is implemented at source level through Accounting Prompt 6.
- Financial Reports, bounded CSV/XLSX exports, print views, and bilingual server PDFs are
  implemented at source level through Accounting Prompt 7. See `FINANCIAL_REPORTS_AND_PDFS.md`.
- Year-end closing and Retained Earnings posting are not implemented.
- Multi-currency and foreign exchange are not implemented; Accounting remains AED-only.
- Bank reconciliation, fixed assets, depreciation, budgeting, procurement,
  consolidation, and digital signatures are deferred.

Accounting Prompt 4 adds the General Expense operational area without enabling it for any Company.
Its readiness requires effective mappings for Expense cost, Input VAT, General Expense Payable,
Cash payment, and Bank/Visa payment. Approval and payment remain separate durable Accounting
Events. See `GENERAL_EXPENSES_AND_PAYMENTS.md`.

Accounting Prompt 5 adds the source-level Company Cash and Bank account masters and controlled
Cash/Bank Movement ledger. The operational area is not enabled automatically. See
`BANK_AND_CASH_MANAGEMENT.md`.

No runtime validation, tests, typecheck, lint, build, migration validation, database verification,
or browser testing was performed for this development task.

## Setup automation extension

The additive `20260801160000_accounting_setup_automation.ts` migration adds Manual Accounting
activation metadata and an audited, revocable Zero Opening confirmation. Deterministic
Chart-of-Accounts analysis and one authoritative mandatory-mapping catalog reuse the existing
Account and effective-dated mapping models. Structural compatibility is mandatory before
name/synonym scoring; no confidence level creates a mapping automatically. Setup analysis never
changes mapping history, posted Journals, operational data, or Company activation state.
The same additive migration permits the `accounts_payable` control purpose already required by
the existing General Expense posting resolver, resolving that schema/contract mismatch without
editing the historical Accounting foundation migration.

The completeness contract now includes mandatory effective mappings, validity and date issues,
Fiscal Period, Cash/Bank GL links, Opening or Zero Opening, Manual Accounting eligibility, and
area readiness. Controlled activation locks and re-evaluates these foundations in one transaction.
See `ACCOUNTING_SETUP_AND_ACTIVATION.md` for routes, scoring, audit, idempotency, and limitations.
