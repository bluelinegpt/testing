# Accounting UI and Operations

> Accounting navigation is now grouped into Setup, Transactions, Monitoring, and Reports. A
> Company-scoped Setup Wizard links authoritative blockers to the existing configuration screens.

## Scope

Accounting Prompt 6 adds the Company-scoped Accounting workspace and operational screens on top
of the Accounting Prompt 1–5 backend. The backend remains authoritative for balances, lifecycle
transitions, period controls, posting, segregation of duties, idempotency, and audit.

No Accounting report, PDF, Bank statement import, full Bank reconciliation, Supplier Accounts
Payable, procurement, cheque-management, or other Prompt 7 workflow is included.

## Routes

The `/accounting` workspace provides:

- overview and configuration;
- effective-dated Account mappings;
- Chart of Accounts;
- Fiscal Years and Fiscal Periods;
- Manual Journals and Opening Balances;
- Accounting Events and bounded Event recovery;
- General Expense Categories, General Expenses, and Expense Payments;
- Cash Accounts, Bank Accounts, Cash/Bank Movements, Cashbook, and Bank Ledger;
- Accounting reconciliation and historical backfill preview.

List and detail screens use stable deep links such as `/accounting/journals/:id`,
`/accounting/events/:id`, and `/accounting/cash-bank-movements/:id`.

## Company and permission isolation

The authenticated session supplies Company scope to the backend. Every frontend Accounting query
key also includes the active Company ID. `AccountingWorkspace` is keyed by Company ID so switching
Company unmounts stale forms, dialogs, selections, and cached screen state.

Actions are shown only for the corresponding real permission:

- `accounting.view`
- `accounting.manage`
- `accounting.approve`
- `accounting.post`
- `accounting.reverse`
- `accounting.periods.manage`
- `accounting.chart_of_accounts.manage`
- `accounting.configuration.manage`

The Administrator fallback remains `users_roles.manage`. Frontend visibility is not an
authorization boundary; every operation is re-authorized by the backend.

## Financial safety

- Backend Decimal values remain strings in frontend Accounting types and rendering.
- Authoritative balances are never updated optimistically.
- User-entered monetary values use the shared safe numeric parser.
- Manual Journal and Opening Balance line DTOs currently require JavaScript numbers at the
  existing backend boundary; conversion occurs only after safe input normalization.
- Date-only fields are passed as `YYYY-MM-DD` strings and are not converted through browser
  timestamps.
- Cash and Visa are separate payment methods and require their corresponding Account reference.
- Bank Account list/detail responses expose masked Account Numbers and IBAN values only.
- Successful mutations increment the workspace revision and reload the affected authoritative
  list, detail, summary, Event, Journal, balance, or reconciliation resource.
- Version and segregation failures are translated to stable business messages. Raw SQL,
  constraints, stacks, storage paths, and Event payloads are not displayed.

## Operational behavior

Automatic posting can only be enabled from the explicit confirmation flow when the backend
readiness result is ready. Mapping history is effective-dated: a mapping is created as a new row
and an existing row is closed by setting its Effective To date; it is not destructively replaced.

Event recovery supports a backend-bounded maximum of 100 selected Events. The UI requests a
preview first and then requires an explicit reason before reprocessing. Historical backfill is
preview-only.

General Expenses support a server-authoritative line on creation, lifecycle review, attachments,
Cash/Visa payment recording, and reversal. Cash/Bank Movements support validation, confirmation,
cancellation, reversal, attachments, and Accounting status visibility.

## Localization and accessibility

The workspace has English and proper Unicode Arabic translations. RTL layout is supported while
codes, amounts, Account Numbers, IBAN values, and references are isolated with bidirectional text
markup. Forms use labels, tables use headings, dialogs use the shared accessible Modal, and
loading/error regions expose status and alert roles.

## Known backend boundaries

Accounting Prompt 7 extends this workspace with `/accounting/reports`, eight report pages, bounded
exports, bilingual server PDFs, and document actions on Journal, Opening Balance, Expense, Expense
Payment, and Cash/Bank Movement details. It reuses `accounting.view` and grants no role new access.
See `FINANCIAL_REPORTS_AND_PDFS.md` for routes, calculations, security boundaries, and limitations.

- Opening Balance cancellation is not available because the current backend status model and
  route do not include a cancelled state.
- Manual Journal and Opening Balance attachments do not have backend routes.
- General Expense editing remains governed by the existing full-version update contract.
- Reconciliation is an operational comparison view; Bank statement import and full Bank
  reconciliation are deferred.
- Historical backfill execution is intentionally unavailable.

## Setup assistant and dashboard actions

The existing `/accounting/setup` route now includes deterministic Mapping Review, alternatives,
confidence/evidence, compatibility status, mapping date issues, Zero Opening confirm/revoke,
area-by-area posting readiness, activation preview, and explicit Manual Accounting activation.
The existing `/accounting` Overview also consumes server-authoritative actions, Posted-ledger
financial snapshot, and bounded recent activity endpoints.

All new query identities are Company-scoped. Mapping or activation mutations refresh the
authoritative resources rather than applying optimistic financial values. Account Codes, dates,
amounts, Journal Numbers, and references retain LTR isolation in RTL. New English and professional
Arabic labels cover confidence, mapping decisions, Zero Opening, area readiness, Unavailable,
Provisional, warnings, and activation. No new frontend route was required because the existing
Setup Wizard and Overview routes were extended.
