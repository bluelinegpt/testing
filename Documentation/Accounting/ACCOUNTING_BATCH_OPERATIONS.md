# Accounting Batch Operations

## Scope and repository decision

This is the source-level Accounting Prompt 9 implementation: controlled batch operations that plan,
validate and execute existing single-item accounting actions across many records.

The governing decision is that **the batch module owns no accounting rule**. A batch type may exist
only where an authoritative single-item service already owns both the read-only eligibility check
and the execution of that action. The batch contributes selection, classification, sequencing,
outcome recording and audit — never eligibility logic, never a posting map, never an account
resolution or amount derivation.

The reason is the failure mode batching amplifies. A second copy of a rule agrees on the day it is
written and disagrees later, silently, across hundreds of records at once. Every design choice
below that looks expensive — one readiness call per item, a 200-item cap, revalidation at execution
time — is the cost of refusing that copy, and is paid deliberately.

The implementation reuses:

- Company context and composite Company foreign keys;
- the Accounting module's idempotency reservation, audit writer and permission model;
- `AccountingOperationSupport` pagination and allow-listed sorting;
- `AccountingEventQueryService` for both readiness and execution;
- the frontend's list-state, Modal, badge and pagination conventions.

No new permission is introduced. `accounting.post` or `accounting.manage` covers create, add
items, validate, execute and cancel — batching is an amplifier of an authority the actor already
holds, never an escalation — and `accounting.view` covers reading.

## Supported batch types

Two, both delegating to the same authoritative pair:

| Batch type | Validation | Execution |
| --- | --- | --- |
| Accounting Event Reprocessing | `AccountingEventQueryService.reprocessingReadiness` | `AccountingEventQueryService.reprocess` |
| Operational Posting Retry | `AccountingEventQueryService.reprocessingReadiness` | `AccountingEventQueryService.reprocess` |

Sharing one service pair is deliberate, not an oversight: in this repository, "retry this
operational posting" *is* re-queueing the operational Accounting Event that failed to post. There
is no separate operational retry service, and inventing one inside the batch module would be
exactly the duplication the rule forbids. The two types differ only in enrolment —
`operational_posting_retry` additionally requires the Event to carry an operational area, and an
Event without one classifies as `invalid` for that type.

`batchTypeServices` in `accounting-batch.constants.ts` is this contract written down as data, and
the batch detail response echoes it as `metadata.singleItemService`, so a reviewer can check the
rule without reading the implementation.

### Journal Review is unavailable

Recorded in `unsupportedBatchTypes` with the reason, so the omission reads as a decision rather
than a gap. `ManualJournalService.validate()` is not read-only: it flips a Journal between `draft`
and `balanced` as a side effect, so it cannot serve as the rerunnable, record-free validation this
feature requires. The approve and post paths have no read-only readiness counterpart, and writing
one inside the batch module would duplicate the Journal transition and segregation rules. The
lawful fix is a readiness method on `ManualJournalService` itself — a change to that service,
outside Prompt 9. The UI states this on the list screen rather than silently omitting the option.

## Data model

Migration `20260805270000_accounting_batch_operations.ts` (created in 9A, **not executed**) adds:

- `accounting_batch_jobs` — reference, type, status, requester, reason, execution counters,
  correlation id, lifecycle timestamps, audit columns, `version`;
- `accounting_batch_items` — source type/id/reference, validation and execution status,
  `validation_reasons` jsonb, error code/message, resulting Event and Journal references,
  timestamps, correlation id;
- `accounting_batch_transitions` — insert-only status history.

Constraints that carry the guarantees:

- `(company_id, batch_reference)` unique; `(id, company_id)` composite keys throughout, with
  composite-company FKs to accounts, Events and Journals;
- `(batch_job_id, source_type, source_id)` unique — the same source cannot be enrolled twice in
  one batch, enforced where it cannot be bypassed;
- a counts CHECK (each counter ≥ 0, their sum ≤ `total_items`) and a cancellation CHECK requiring
  `cancelled_at` and a reason together in both directions;
- a result CHECK: resulting references and `executed_at` can exist only once the item actually ran;
- a trigger freezing item identity (`company_id`, `batch_job_id`, `source_type`, `source_id`)
  after insert — classification stays writable because validation is rerunnable, but what an item
  *points at* cannot change, or a batch could be validated against one set of records and executed
  against another;
- a trigger rejecting UPDATE and DELETE on transitions, and a trigger refusing to delete a batch
  that has any transition. The lawful way to abandon a batch is to cancel it, which keeps the
  record and the reason.

Execution counters live only on the job and describe execution; **classification counts are always
read from the item rows**, never duplicated onto the job, so the two cannot disagree.

## Batch lifecycle

Eight statuses: `draft`, `validating`, `ready`, `processing`, `partially_completed`, `completed`,
`failed`, `cancelled`.

Legality is described once, as data, in `canTransitionBatch`:

| From | To |
| --- | --- |
| `draft` | `validating`, `cancelled` |
| `validating` | `ready`, `draft`, `cancelled` |
| `ready` | `draft`, `validating`, `processing`, `cancelled` |
| `processing` | `completed`, `partially_completed`, `failed` |
| `partially_completed` | `processing`, `cancelled` |
| `failed` | `processing`, `cancelled` |
| `completed` | — |
| `cancelled` | — |

Three moves worth explaining:

- `ready -> draft` happens when items are added to a validated batch: the new items are
  unclassified, so the batch is no longer the thing that was reviewed.
- `failed` and `partially_completed` are **retryable, not terminal** — execution re-enters them to
  process only the unfinished items.
- `completed` and `cancelled` are dead ends. A finished batch can never run again.

`processing` cannot be cancelled: it only resolves through finalisation.

## Batch creation and items

- **Batch reference** — `BATCH-000001` per Company, derived from the table under an advisory lock
  rather than from `company_reference_counters`, whose `type` CHECK does not permit a batch
  counter.
- **Reason** — required and substantive (5–500 characters). A batch is a control record; one
  created without a stated purpose is not reviewable later.
- **Initial items** — the create endpoint accepts `sourceIds`, so a batch can be created and
  populated in one idempotent request that cannot leave an empty batch behind if a second call
  fails.
- **Later addition** — the add-items endpoint accepts more sources on a Draft or Ready batch; a
  Ready batch that gains items returns to Draft.
- **200-item cap** (`accountingBatchMaxItems`) — exists because validation and execution cost one
  authoritative service call per item rather than one cheap set query. The cheap query would be a
  second copy of the eligibility rule; the cap keeps the honest version's cost predictable.
- **Duplicate prevention** — the unique index plus `on conflict do nothing`; a repeated add is a
  counted no-op, not an error and not a second item. The UI also de-duplicates pasted ids as a
  courtesy, but the database is what guarantees it.
- **Immutable identity** — frozen by trigger after insert, as above.
- **Company isolation** — every statement filters on `company_id`. A foreign batch is *not found*,
  never *forbidden* — a 403 would confirm the record exists. Items naming another Company's
  records are enrolled silently and classify as `invalid` at validation, because refusing them at
  enrolment would turn the add-items endpoint into an existence oracle.

## Validation

Read-only, idempotent, rerunnable. Classifications:

| Classification | Meaning | Decided by |
| --- | --- | --- |
| `eligible` | the single-item action can run now | readiness service |
| `blocked` | readiness reported blockers | readiness service |
| `already_processed` | already posted / Journal exists | readiness blockers |
| `duplicate` | enrolled in another live batch | batch module (batch-level fact) |
| `invalid` | source not found / not owned / wrong shape for the type | batch module (batch-level fact) |

Stated clearly:

- **Validation creates no Accounting Event, no Journal and no financial record.** It writes only
  to the batch's own item rows.
- **Each item delegates to the existing readiness service.** The batch module decides only the two
  batch-level facts readiness cannot see (duplicate enrolment, invalid source); everything about
  the Event itself is the readiness service's answer.
- **Rerunning validation replaces current verdicts.** Every item is reclassified from scratch, so
  a rerun converges on the current truth rather than accumulating stale verdicts.
- **Blocker codes are preserved verbatim** in `validation_reasons` — the reason a person acts on
  is the reason the authoritative service actually gave, never a summary.

Shape: a short claiming transaction (row lock, idempotency, `validating` status — so an
interrupted sweep is visible rather than silently looking reviewed), classification outside any
transaction (holding a write transaction across up to 200 multi-query reads would pin a connection
and lock the batch row for the whole sweep), then a short recording transaction ending in `ready`.
Batch-level facts resolve in two grouped queries for the whole set; only the eligibility question
costs a call per item.

## Execution

`POST /operations/accounting/batches/:batchId/execute`, requiring `accounting.post` or
`accounting.manage`, an `x-idempotency-key`, and `expectedVersion` — the version the caller last
saw, because execution must act on the batch that was *reviewed*, not the batch as it happens to
be now.

Eligibility: Company-owned; status `ready`, `partially_completed` or `failed`; validation has
completed (`last_validated_at` set); at least one unfinished eligible item exists; version matches.
`completed`, `cancelled` and `processing` are refused.

Shape — short claim, item loop, short finalisation:

1. **Claim transaction**: batch row lock, idempotency reserve/replay, status + version +
   validation + runnable checks, `processing`, `started_at = coalesce(started_at, now())`,
   version increment, immutable transition, commit. The transaction ends before any item is
   touched.
2. **Item loop**, one item at a time, each step in its own small transaction:
   - claim with `for update skip locked` restricted to unfinished items;
   - **revalidate immediately** through `reprocessingReadiness` — the verdict that matters is the
     one from now, not from validation;
   - when eligible, execute through **one call to `AccountingEventQueryService.reprocess`** — the
     same method the Event screen uses, with its own permission check, readiness enforcement,
     idempotency reservation and audit intact;
   - record outcome, error code/message, resulting references, timestamp and correlation.
3. **Finalisation transaction**: recount from the item rows, set final status and `completed_at`,
   immutable transition, audit event, idempotency completion.

**No posting logic is duplicated in the batch module.** `reprocess` itself only re-queues the
Event; the normal processor remains the only thing that posts. A consequence stated deliberately:
**`resulting_journal_id` is usually null at execution time** — success means "the Event was
accepted back into the queue", and the Journal appears later when the processor posts it. The
column records a Journal where the Event already carries one.

**One item's failure cannot roll back another's success**: items never share a transaction. A
failed item records its failure and the loop continues.

Item outcomes: `succeeded`; `failed` (with the service's own error code); `skipped` with
validation `already_processed` (the work already exists) or `duplicate` (enrolled elsewhere —
settled without touching the Event); and `blocked` / `invalid`, which record their verdict but
deliberately stay *unfinished* so a later retry revalidates them once the blocker is fixed —
marking them skipped would make them unretryable.

## Retry

The **same execute endpoint** — there is no separate retry route; the UI merely relabels the
action *Retry Unfinished Items* for `partially_completed` and `failed` batches.

- Only unfinished items (`execution_status` in `pending`, `failed`) are selected.
- Succeeded, skipped, duplicate, already-processed and cancelled items are never rerun.
- Blocked, invalid and failed items are revalidated through readiness before any execution.

## Final status and counters

Counters — `succeeded_count`, `failed_count`, `skipped_count`, `duplicate_count` — are
**recalculated from the authoritative item rows** at finalisation, never accumulated in memory.

Final status:

- nothing succeeded and something failed → `failed`;
- any failure, or any still-unfinished blocked/invalid item → `partially_completed`;
- every item settled (succeeded, skipped, duplicate or already-processed) → `completed`.

`completed_at` is set at finalisation for all three, and the final transition and an
`accounting.batch.executed` audit event are written.

## Idempotency and concurrency

- **Batch row lock** serialises create-adjacent actions and the execute claim; a concurrent
  execute finds `processing` and is refused.
- **Item `for update skip locked`** is a second fence: two workers can never hold the same item
  even if the batch-level gate were bypassed. No item can be processed twice in one run, and
  terminal items are excluded by the claim predicate.
- **Idempotency**: create, add items, validate, execute and cancel all reserve
  `x-idempotency-key` through the module's shared helpers. Exact replay returns the stored
  response. `expectedVersion` is part of the execute payload, so the same key with a changed
  version is a **payload mismatch, refused** — never silently replayed.
- **Per-item reprocess keys are fresh per attempt**, deliberately: a deterministic key would
  replay the first attempt's stored answer forever and make retry impossible. The duplicate
  protection execution actually relies on is `reprocess`'s own status guard, which refuses an
  Event that is not failed/blocked/retry-pending — and nothing in this path creates an Event or a
  Journal at all, so no duplicate of either can arise from a batch.
- **Immutable transitions** record every status move; the table refuses UPDATE and DELETE.
- **Company isolation end to end**: batch, items, tallies, outcome writes and the source-Event
  read are all Company-filtered; readiness and reprocess resolve under the same tenant context;
  resulting Event and Journal references are composite-company FKs.

## Frontend

Route `/accounting/batch-operations` (list) and `/accounting/batch-operations/:id` (detail), a
**Batch Operations** entry in the Accounting sidebar's Monitoring group. All existing Accounting
pages are preserved.

- **List** — server-side filtering (status, type, reference, created range), allow-listed sorting
  and pagination, URL-backed through the shared list-state hook. Shows references, type, status,
  requester, dates and execution counters.
- **Create** — the two supported types only, with per-type hints; reason required; a Source IDs
  textarea that parses pasted spreadsheet columns, counts recognised ids and refuses malformed
  ones. Initial items travel in the create request.
- **Detail** — summary cards, full timestamp/counter grid, the single-item service metadata block
  (the reuse rule made visible on screen), classification cards from `validationCounts`, the
  immutable transition timeline, and the item table.
- **Validate Batch** — calls the validate endpoint, disabled while running, refreshes on
  completion; a notice states validation is read-only.
- **Execute Batch / Retry Unfinished Items** — shown only for `ready` /
  `partially_completed`-or-`failed` batches with unfinished eligible items, the required
  permission, and `metadata.executionImplemented` true. The confirmation modal shows the batch
  summary, classification counts, unfinished count and execution service, and warns that each item
  is revalidated immediately before running and that **succeeded items remain committed even if a
  later item fails** — a batch is not one all-or-nothing transaction. Submits the on-screen
  `version` as `expectedVersion` with a fresh idempotency key; on success the detail refreshes in
  place and a result banner shows the final status and the four counters, with a distinct partial-
  completion message.
- **Processing state** — a non-editable notice with a manual Refresh; Execute/Retry hidden. No
  automatic polling exists on the page and none was invented.
- **Cancel Batch** — reason required; explains that nothing is deleted. No delete action exists.
- **Item table** — source type/reference/id, validation and execution badges, verbatim reason
  codes (translated where known, shown raw otherwise), error code/message, resulting Event and
  Journal links only where the backend returned ids, validated/executed timestamps.
- **No Journal Review option** anywhere, with the on-screen explanation of why.

No financial value is computed in the frontend; the only numbers it produces are the client-side
estimate of unfinished eligible items (eligible minus succeeded, labelled as an estimate in code,
with the backend authoritative) and rendered-element counts.

## Known limitations

- **No focused batch tests** exist — foundation, validation or execution, backend or frontend.
- **No browser validation** was performed on any screen in this feature.
- **No runtime batch execution has ever been performed.** The execution path has never run against
  a database.
- **Process interruption can leave a batch in `processing`.** Completed items are durably
  recorded and the state is visible, but `processing` is not executable and no operator-recovery
  or release mechanism is implemented; releasing such a batch is a manual, deliberate decision.
- **The list endpoint does not return classification counts**, so the list's five classification
  columns show unavailable values (em dashes) rather than fabricated zeros. The counts appear on
  the detail.
- **Journal Review is unsupported**, for the reason documented above.
- **The resulting Journal may be unavailable immediately after reprocess** — posting happens
  asynchronously in the normal processor, so a succeeded item can legitimately show no Journal
  link yet.
- **No automatic polling while processing**; progress is seen by manual refresh.
- **No production-readiness claim is made** for this feature.

## Verification status

Stated exactly, with no broader claim:

- **API typecheck passed** for Prompts 9A and 9C.
- **Web typecheck passed** for Prompts 9B and 9C-UI.
- **The migration was created in 9A and has NOT been executed.** Migration ordering validation
  passed at creation time (82 ordered files).
- **No tests** were written or run.
- **No browser validation** was performed.
- **No real batch execution** was performed.
- **No build** was run.
- **No database verification** was performed.
- **No production-readiness claim** is made.

## Deferred

Batch execution for any new action type (each requires its own authoritative read-only readiness
and execution pair first — Journal Review being the documented example), classification counts on
the list endpoint, operator recovery for an interrupted `processing` batch, automatic progress
polling, batch exports, scheduled or automated batches, and any concurrency beyond
one-item-at-a-time sequential execution are outside Accounting Prompt 9.

## Final status

`PROMPT_9_IMPLEMENTATION_COMPLETE_TESTING_DEFERRED`

No code, localization, stylesheet, migration, configuration or database change was made in this
documentation phase, and no tests, typecheck, lint, build, browser testing, migration execution,
batch execution, database verification or commit was performed for it.
