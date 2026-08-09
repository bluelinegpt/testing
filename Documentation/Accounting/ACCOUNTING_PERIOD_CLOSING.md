# Accounting Period Closing

## Scope and repository decision

This is the source-level Accounting Prompt 7 implementation: the human process that precedes
closing an accounting period, the automated checks that judge whether it may close, the Monthly
Close and Reopen execution, and the Year-End financial execution.

The workflow is deliberately a separate model from the period it governs. `accounting_periods`
records a state; a closing workflow records an event log — who checked what, who reviewed it, who
approved it, and when. If the checklist lived on `accounting_periods`, reopening a period would
either destroy the evidence of how it was closed the first time or leave a second set of
half-truthful columns. They have different lifetimes and belong in different tables.

The implementation reuses:

- Company context and composite Company foreign keys;
- fiscal years and accounting periods, including their calendar guards;
- the Chart of Accounts and the configured retained-earnings account;
- the existing Journal engine and the system-generated posting pattern;
- `AccountingReportService` for Trial Balance, Profit and Loss and Balance Sheet availability;
- the existing audit writer, idempotency records and permission model.

No new permission is introduced. `accounting.manage` covers preparation, `accounting.approve`
covers review, approval and every execution action, and `accounting.view` covers reading.

## Data model

Migration `20260805190000_accounting_period_closing.ts` adds:

- `closing_workflows`;
- `closing_workflow_tasks`;
- `closing_task_comments`;
- `closing_task_attachments`;
- `closing_workflow_reviews`;
- `closing_workflow_transitions`.

`closing_workflow_transitions` is insert-only: no `updated_at`, no `version`, and a trigger that
rejects UPDATE and DELETE. A period close is the control an auditor examines first, and a
transition history that can be edited afterwards is not a history. A workflow that has any
transition cannot be deleted at all; the lawful way to abandon one is to cancel it, which keeps
the record and the reason.

Maker-checker is expressed in the schema as well as in code. CHECK constraints forbid the
approver from being the submitter and the reviewer from being the submitter. A service can be
bypassed by a script or a future endpoint; a constraint cannot.

## Workflow foundation

### Types and statuses

Two workflow types: `monthly`, which names one accounting period, and `year_end`, which spans the
whole fiscal year and names no period. A CHECK enforces that pairing in both directions — a
Monthly Closing without a period is meaningless, and a Year-End Closing with one is a category
error.

Eleven statuses: `draft`, `in_progress`, `blocked`, `ready_for_review`, `under_review`,
`changes_requested`, `ready_for_approval`, `approved`, `closed`, `reopened`, `cancelled`.

Legality of a move is described once, as data, in `accounting-closing.templates.ts`. The service
adds only what a table cannot express: who may make each move, what each move must stamp, and
which moves require a reason. The database CHECKs constrain the values a status may take and who
may approve; they cannot express that `closed` may not go straight back to `in_progress`.

### Template task population

Creating a workflow writes one checklist row per template item — eleven for Monthly, eleven for
Year-End — carrying `task_key` for identity and `task_label_snapshot` for wording. Renaming a
template item later therefore does not rewrite what a completed checklist said at the time it was
completed.

### Duplicate prevention

A partial unique index permits one ACTIVE workflow per Company, fiscal year, period and type.
Closed and cancelled workflows are excluded, so a period can be closed again after a reopen
without deleting the first attempt. The period id is coalesced to a sentinel because NULL never
conflicts with itself, which would otherwise let two Year-End workflows coexist.

The service also pre-checks for a friendly message naming the existing workflow number; the index
is the guarantee for two callers racing.

### Workflow numbering

Numbers are `CLOSE-000001`, derived from `closing_workflows` under a per-Company
`pg_advisory_xact_lock`, with the `(company_id, workflow_number)` unique index as the backstop.

They are deliberately NOT drawn from `company_reference_counters`. That table's `reference_type`
is an allow-list CHECK which does not include `closing_workflow`, so the original implementation
was rejected at insert and creating a workflow could not succeed at all. This was found by the
readiness test suite and corrected without a migration.

### Company isolation

The Company is taken from the tenant context and never accepted from a caller. Every select,
insert, update and lock is Company-scoped, and joins are Company-matched. A cross-Company
workflow, task, period or account is reported as `not found`, identically to one that does not
exist — distinguishing them would turn these endpoints into an existence oracle for another
tenant's identifiers.

## User workflow

Create a workflow (type, fiscal year, period for Monthly, due date, priority, assignee, notes),
then work the checklist: set each task's status, assign an owner, and record notes. Comments are
append-only, optionally attached to one task, with author and timestamp recorded by the server;
there is no edit and no delete, in the API or the interface.

Review and approval move the workflow through `ready_for_review`, `under_review` and
`ready_for_approval` to `approved`. Each review or approval DECISION is written as its own row in
`closing_workflow_reviews` and never overwritten, so a workflow that went round the loop three
times shows three decisions. Every status change appends a row to the immutable transition
timeline with actor, timestamp, reason and correlation reference.

### Attachments are metadata only

`closing_task_attachments` stores a file name, content type, byte size, a storage key and the
uploading actor. **No file is uploaded, stored, streamed or downloaded by this feature.** The
storage key points at whatever the Files module holds, so an attachment can be moved or re-hosted
without rewriting closing evidence. The interface states this before the fields rather than after,
so a reader learns it is recording a reference before composing one.

### Frontend

`/accounting/closing-workflows` provides a server-filtered, sorted and paginated list with
URL-backed state, a create dialog, and a detail page carrying the summary, checklist, comments,
attachment metadata, review decisions and the transition timeline. Task status and assignment are
editable in place for `accounting.manage`; readers see values only.

## Readiness checks

`POST /accounting/closing-workflows/:id/readiness-check` runs every automated check and stores the
result; `GET /accounting/closing-workflows/:id/readiness` returns the last stored results without
running anything. Running is permitted only on a workflow that is neither closed nor cancelled,
and is safe to repeat.

Each result carries a status, a message, an optional count and amount, an optional in-application
source route, the checked timestamp, the checking actor and a check version. Results are stored in
the existing `closing_workflow_tasks.check_result` and `checked_at` columns.

### Statuses

`passed`, `failed`, `warning`, `not_applicable`. A template item with no automated equivalent is
recorded as `not_applicable` rather than left blank: "nobody has checked this" and "there is
nothing to check automatically" are different answers and must stay distinguishable.

### Monthly checks

| Task key | Question | Classification |
| --- | --- | --- |
| `operational_transactions_posted` | Accounting Events awaiting processing | blocking |
| `failed_accounting_events_resolved` | Events failed or blocked by configuration | blocking |
| `unposted_journals_reviewed` | Journals not posted, reversed or cancelled | blocking |
| `cash_bank_reconciled` | Confirmed Movements with no posted Event | blocking |
| `trader_driver_balances_reviewed` | Outstanding Trader and Driver balances | warning |
| `payroll_reviewed` | Payroll periods still draft or calculated | blocking |
| `expenses_reviewed` | General Expenses still draft or submitted | blocking |
| `trial_balance_reviewed` | Trial Balance available and balancing | blocking |
| `profit_and_loss_reviewed` | Profit and Loss activity exists | blocking |
| `balance_sheet_reviewed` | Balance Sheet activity exists | blocking |
| `final_approval` | A person's decision | not applicable |

Outstanding Trader and Driver balances warn rather than block. An outstanding balance is normal
trading; the check exists so the figure is seen before sign-off, not to prevent it.

### Year-End checks

| Task key | Question | Classification |
| --- | --- | --- |
| `all_monthly_periods_closed` | Periods in the year not closed | blocking |
| `final_trial_balance` | Balances, and the ledger is complete | blocking |
| `final_profit_and_loss` | Statement available | blocking |
| `final_balance_sheet` | Statement available | blocking |
| `closing_journal_prepared` | A Closing Journal already exists | warning |
| `next_fiscal_year_created` | The next fiscal year exists | warning |
| `next_periods_created` | Twelve periods exist | warning |
| `first_new_period_opened` | The first new period is open | warning |
| `profit_loss_transferred` | Execution-only | not applicable |
| `balances_carried_forward` | Execution-only | not applicable |
| `prior_year_locked` | Execution-only | not applicable |

The Year-End template has no key for failed Accounting Events or unposted Journals, and inventing
checklist items is not permitted. Both are folded into `final_trial_balance`, where they actually
bite: a Trial Balance computed over an incomplete ledger is not final. The failure message
distinguishes "does not balance" from "ledger incomplete".

`closing_journal_prepared` reports whether one ALREADY exists and warns if so. A year closed twice
is the mistake it watches for.

### Reuse rather than recomputation

Trial Balance, Profit and Loss and Balance Sheet availability come from `AccountingReportService`.
A second implementation of those would eventually disagree with the report a person is reading,
and a period close is the worst possible moment to discover that. All seventeen operational counts
come from a single grouped statement rather than one query per task — eleven round trips would
also be eleven separate snapshots of a moving database.

### Blocking rules

A mandatory task that has an automated check must be `passed`, `warning` or `not_applicable`.
`failed` blocks, and so does **never evaluated** — otherwise a workflow could reach approval by
simply never running the checks. Warnings never block. Manual tasks never block: the checklist a
person completes is a separate question from the automated evidence.

The gate is applied inside the transition transaction for `ready_for_approval` and `approved`, and
it VALIDATES the stored results rather than re-running them. Re-evaluating inside a transition
would mean a rejected move had still written to every task.

### Rerun behaviour

A rerun REPLACES the automated result on each task in one statement and touches nothing else — not
the task's manual status, assignee or notes, and not comments, attachments or the workflow status.
No task is duplicated.

### Readiness frontend

The detail page carries a Run Readiness Check action for `accounting.manage`, a summary panel
(ready/not ready, last checked, checked by, the four counts and a blocking count), and a per-task
Automated Check column separate from the manual Status column. When readiness is not satisfied,
`Ready for Approval` and `Approve` are disabled and every blocking item is named individually;
other valid actions stay available, because a workflow that fails its checks still needs to be
sent back for changes or cancelled.

The last checked timestamp is displayed and nothing is claimed beyond it. The backend exposes no
freshness rule, so the interface invents none.

## Monthly Close and Reopen

Two dedicated endpoints:

- `POST /accounting/closing-workflows/:id/close`
- `POST /accounting/closing-workflows/:id/reopen`

Both require `accounting.approve`, a matching workflow `version`, and an idempotency key. Close
takes an optional reason; reopen requires one, and the database agrees — `accounting_periods` will
not accept a `reopened` status without a non-blank `reopen_reason`.

### Close

Permitted only when the workflow is Monthly and `approved`, the actor is not the submitter,
readiness passes when re-evaluated at execution time, and the period exists in the same Company
and fiscal year and is not already closed. A Year-End workflow is refused with
`accounting_year_end_execution_not_implemented` by this endpoint.

Both rows are locked and both are updated in one transaction. A period closed while its workflow
still reads `approved` would claim a control that was never completed; a workflow reading `closed`
over an open period would claim a close that never happened. Either half alone is false, so the
transaction is the unit. No Journal and no Accounting Event is written: closing a period states
what may still be posted to it, and is not a financial event of its own.

### Reopen

Permitted only when the workflow is Monthly and `closed`, the period is currently `closed`, and
two Company-scoped dependency checks pass:

- no LATER period in the same fiscal year is closed — a closed February cannot sit on top of a
  reopened January, because that later close was signed off against figures the reopen is about to
  allow to change. This is refused rather than cascaded: silently reopening February would undo a
  second person's sign-off without their knowledge;
- no closed Year-End workflow exists for the same fiscal year.

Neither later periods nor Year-End workflows are altered; they are only consulted.

Reopen deletes and rewrites nothing. The approval that closed the period, the readiness results,
the checklist, comments, attachments and the original `approved -> closed` transition all remain;
a `closed -> reopened` row is appended beside them.

### The generic transition endpoint cannot Close or Reopen

`POST /:id/transitions` refuses `closed` and `reopened` with
`accounting_closing_use_execution_endpoint`. That endpoint moves a workflow status and nothing
else, and allowing it to write these statuses would let a workflow read `closed` over a period
that is still open. The frontend transition action map likewise offers neither.

## Year-End financial execution

`POST /accounting/closing-workflows/:id/year-end-execute`, requiring `accounting.approve`, a
matching `version` and an idempotency key.

Permitted only when the workflow is `year_end` and `approved`, the actor is not the submitter,
readiness passes, the fiscal year is not already closed, every period in the year is closed, no
`closing` Journal already exists for the year, and the configured retained-earnings account
resolves to an active, posting, equity account.

Everything below happens in ONE transaction. A partial year-end is worse than none: a Closing
Journal without a carry-forward leaves the new year with no opening position; a carry-forward
without a locked prior year invites a second execution that would double it.

### What execution does

1. Posts exactly one Closing Journal (`journal_type = 'closing'`, `source_type = 'period_close'`)
   dated the fiscal year's end date, in that year's final period.
2. Zeroes every Revenue and Expense account by posting its own balance back against it, and moves
   the net to retained earnings — a profit credits it, a loss debits it. Balance-sheet accounts are
   untouched; transferring one here would move an asset into equity.
3. Creates the next fiscal year, or reuses an existing one whose start date follows and whose end
   date matches. A year with different dates is refused rather than adopted.
4. Creates exactly twelve accounting periods through the repository's own generator, or reuses a
   complete set of twelve. A partial set of one to eleven is refused rather than topped up.
5. Opens the first period of the new year; later periods stay in their generated `future` state.
6. Posts a carry-forward Journal (`journal_type = 'opening_balance'`) dated the new year's start
   date, in its first period, from Balance Sheet accounts only, read AFTER the Closing Journal so
   the position carried is the final one.
7. Locks the prior fiscal year (`status = 'closed'`, with actor, timestamp and reason).
8. Moves the workflow to `closed`, appends the `approved -> closed` transition, and completes the
   seven execution checklist tasks.

### Carry-forward dimension decision

**This is an implemented design decision, not a claim about accounting standards, and it is the
part of this feature most worth challenging before the first real year-end.**

Balance-sheet balances are carried forward per account AND per party: `subledger_type`,
`subledger_id`, `trader_id`, `driver_id` and `employee_id`. Those dimensions describe a balance
that genuinely continues into the new year — a Trader owed money on 31 December is owed it on
1 January, and losing that detail would make the new year's receivables un-ageable.

Document references are deliberately NOT copied: Order, Trader Settlement, Driver Collection,
Payroll Period, Payroll Payment, outsourced Driver fee accrual and payment, General Expense,
General Expense Payment, and Cash/Bank Movement. An opening balance is a statement of position,
not a re-issue of last year's documents, and stamping a new-year opening line with a prior-year
Order identifier would attach it to a transaction that is closed and cannot move again.

### Why it does not use the manual Journal service

`ManualJournalService` enforces posting segregation — the poster must differ from the approver —
which is correct for a human-authored Journal and impossible for an automated one where a single
actor authorises the whole execution. Year-End follows the pattern
`OperationalJournalPostingService` already established for system-generated Journals: insert as
draft, write the lines, then step `balanced -> approved -> posted`. Balance is asserted in
application code before anything is written and enforced again by the database's
`validate_posted_journal_balance` trigger on posting, so the entry is validated twice and by the
same rules a manual Journal faces.

### Idempotency and concurrency

The workflow row is locked first and the idempotency reservation is fingerprinted against what was
locked; the fiscal year row is locked too. Exact replay returns the original result. A changed
version or reason under the same key is rejected as a payload mismatch.

No new uniqueness migration was required. Two executions of the same workflow serialise on the
workflow lock; two different Year-End workflows for the same Company and fiscal year cannot
coexist because the active-workflow unique index forbids it; and the prior-Closing-Journal check
runs while the fiscal year row is held.

### Year-End frontend

`Execute Year-End` appears only for a Year-End workflow that is `approved`, to a user with
`accounting.approve`, when readiness is satisfied. The confirmation enumerates all seven actions
individually rather than summarising them — one confirmation authorises seven distinct financial
actions, and a reader is entitled to see each before agreeing to all of them. On success the
screen shows the Closing Journal, the carry-forward Journal, the next fiscal year, the period
count and the first opened period, with links built from the identifiers the response returned.

## Known limitations

Schema and model:

- task-level due date is not supported; due date lives on the workflow;
- task-level priority is not supported; priority lives on the workflow;
- there is no task completion-evidence field. `check_result` is reserved for the automated
  evaluation and its null state must stay distinguishable from a failed check, so a person's
  assertion cannot be written there. These three fields are refused by the API rather than
  accepted and discarded;
- attachment bytes, upload and download are not implemented; metadata only;
- task check-result history has no dedicated table. A rerun overwrites the current answer. Prior
  result SETS remain recoverable from `audit_events`, each readiness run writing one entry
  containing the full check set, but they are not queryable per task;
- `checked_by` and the check version have no columns and are stored inside the `check_result`
  JSON.

Interface:

- user selectors load at most 100 Company accounts, that endpoint's own page-size limit, with no
  search or paging in the selector. An actor outside that page renders as an em dash rather than a
  name;
- the Year-End result panel is transient component state and disappears on navigation. The durable
  record is the workflow, the Journals, the checklist and the timeline;
- no screen in this feature has been browser-validated.

Execution:

- Year-End financial execution has never been executed or tested;
- Monthly Close and Reopen have no focused tests; their concurrency and rollback behaviour is
  argued from the code rather than demonstrated;
- the readiness interface has not been browser-tested.

## Verification status

Stated exactly, with no broader claim:

- API typecheck passed for every backend phase where it was reported.
- Web typecheck passed for every frontend phase where it was reported.
- The readiness focused suite passed: **24 tests**, covering Monthly and Year-End checks, result
  persistence and rerun, the transition gate, and Company isolation.
- Monthly Close and Reopen have **no focused tests**.
- Year-End financial execution has **no tests**.
- **No browser validation** was performed on any screen in this feature.
- **No real Year-End execution** has been run.
- No production-readiness claim is made for this feature.

Three defects were found by the readiness suite and corrected: workflow numbering could never
succeed against the reference-counter CHECK; three Accounting Event states counted as neither
failed nor waiting; and the open-period test named a period status that does not exist. A fourth
finding was recorded rather than fixed — a Trial Balance imbalance is unreachable, because
`validate_posted_journal_balance` refuses to post lines that do not agree, so that branch of the
check is defensive only.

## Deferred

Year-End reversal, closing-Journal reversal, multi-year reopening, soft-close semantics,
adjustment periods, period-close reporting and exports, scheduled or automated closing, and any
Year-End behaviour for a fiscal year that is not twelve monthly periods are outside Accounting
Prompt 7.

No tests, typecheck, lint, build, migration validation, database verification, browser testing,
migration execution, Year-End execution, or commit was performed for this documentation phase.
