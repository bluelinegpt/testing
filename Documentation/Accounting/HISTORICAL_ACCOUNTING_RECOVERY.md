# Historical Accounting Recovery

## Scope and repository decision

This is the source-level Accounting Prompt 10 implementation: a read-only preview of historical
records missing their Accounting Events or Journals, a frontend for reviewing it, and the creation
of a dedicated recovery batch from rows the server classifies eligible.

**Controlled recovery execution is NOT implemented.** Prompt 10D specified it but was never
executed as a prompt; no completion report exists for it, and this document does not claim
otherwise. A recovery batch can be created, reviewed, revalidated and cancelled — it cannot be
run. Every execution entry point refuses the type explicitly (see Controlled execution below).

The governing decision carries over from the batch framework: **recovery owns no accounting
rule**. The preview predicts what the authoritative machinery — the capture trigger, the mapping
resolver, the period guard — would decide, restating none of it, and it must never be more
permissive than the poster. Where a rule already has one shared definition (the Order
accounting-required predicate), the preview imports it rather than copying it.

## Supported sources

Exactly two, and no others:

- **Delivered Orders** missing an `order_delivered` Accounting Event;
- **Outsourced Driver Fee Accruals** missing an `outsourced_driver_fee_accrued` Accounting Event
  or Journal.

No other historical source type is supported. Adding one is a separate future prompt, because
each source type needs its own authoritative eligibility question and (eventually) its own
authoritative posting path.

## Preview endpoint

`GET /operations/accounting/recovery/preview`

- **Permissions**: `accounting.post` or `accounting.manage`, `company_user` identity — posting
  authority rather than plain view, because the preview reveals exactly which records posting
  would touch.
- **Filters**: `sourceType`, `dateFrom`, `dateTo`, `sourceReference` (contains-match),
  `classification`, with server-side allow-listed sorting (source date, accounting date, amount,
  reference, classification) and pagination (max 200).
- **Read-only**: the service holds no transaction manager and executes only SELECTs. No database
  write, no Accounting Event, no Journal, no batch.
- **Classification totals**: returned for the whole filtered surface (classification filter
  deliberately excluded from the grouping), so a screen can say "eligible: N of M" without a
  second scan.
- **Shape**: one reusable unioned rows fragment shared by the page query, the totals query and
  batch revalidation — one classifier, three consumers, no drift. Set-based LATERAL lookups; no
  per-row application loop, no N+1, no in-memory aggregation.

## Classification model

Seven classifications; every row lands in exactly one:

`eligible`, `already_posted`, `duplicate`, `blocked`, `closed_period`, `invalid_source_data`,
`no_accounting_required`.

Precedence, top to bottom: financial substance → duplication → success → stuckness → period →
mappings → eligible. Duplication outranks success because two posted results for one source is
the worse fact. Each row also carries a blocking code from the module's own vocabulary (never raw
SQL, stack traces or constraint names) and a `recommendedAction`:

- `create_missing_event` — eligible; requires recovery execution, which does not exist yet;
- `reprocess_event` — an Event exists but is stuck; the existing Event-reprocessing batch handles
  it today;
- `review_manually` — reversed/duplicate/invalid states no automated path should touch;
- `none` — nothing to do (already posted, no accounting required, closed period until reopened).

**The backend is authoritative.** The frontend renders classifications and never computes one,
and the batch-creation flow re-runs the classifier regardless of what the client sends.

## Delivered Orders

- Only Orders with an **authoritative `delivered_at`** enter the surface. Current Delivery Status
  alone is never the deciding factor, and a missing timestamp is never guessed. The accounting
  date is `(delivered_at at time zone 'Asia/Dubai')::date`, exactly as the operational loader
  derives it.
- **No Accounting Required Orders never become eligible.** The test is the ONE shared definition
  in `order-accounting-classification.ts` (imported, not restated — two raw-string exports were
  added there for fragment composition). Their action is `none`; by construction no zero-value
  Event or Journal can ever be proposed or created.
- **Existing Event/Journal detection**: a LATERAL over `accounting_events` counts active claims
  (`reversed` and `ignored_duplicate` excluded — a reversed posting is not a live claim), finds
  the latest Event and its Journal, and drives `already_posted` / `duplicate` / `blocked`.
- **Closed periods** classify `closed_period` when the covering period is not `open`/`reopened` —
  mirroring `assert_period_open_for_posting`'s own test, which remains the enforcer. A date with
  no period at all is `blocked` (`accounting_period_missing`).
- **Mapping/source-data validation**: the preview asks `account_mappings` the same
  effective-dated question `AccountMappingResolver` asks, per required key
  (`order_cod_receivable`, `trader_payable`, `service_fee_revenue`, `output_vat`), each
  conditioned on the same source columns the loader reads — including the loader's exact
  financial-model revenue fallback. A required key without an effective mapping is
  `invalid_source_data`. The resolver stays authoritative at posting time; the preview may only
  be stricter, never looser.

The Order amount shown is the same impact total the shared predicate tests — a display of the
source's stored figures, not an input to posting.

## Outsourced Driver Fee Accruals

- The amount is the accrual's **immutable `earned_amount`** — never recalculated from current fee
  rules. What was accrued is what recovery would post.
- **Reversed accruals are excluded**: a reversed accrual withdrew its claim, and recovery must not
  repost it. A zero-earned accrual is `no_accounting_required`.
- Expected Event: `outsourced_driver_fee_accrued`; the same Event/Journal detection, closed-period
  and mapping validation as Orders, with the accrual's two mapping keys
  (`outsourced_driver_fee_expense`, `outsourced_driver_payable`) checked on
  `accrual_business_date`.

## Frontend preview

Route `/accounting/historical-recovery`, a **Historical Recovery** entry in the Accounting
sidebar's Monitoring group.

- **Filters and URL state**: Source Type, Date From/To, Source Reference, Classification —
  URL-backed through the shared list-state helper; server-side only. An inverted date range is
  caught client-side before any request, because an empty page for an inverted range would read
  as "no gaps" — a wrong answer, not an unhelpful one.
- **Classification summary**: seven responsive cards showing the server's whole-surface totals —
  a merge of server rows, never a recount of the current page.
- **Preview table**: all thirteen columns (source type/reference/date, accounting date, amount,
  expected posting type, classification, Event, Journal, period, period status, blocking reason,
  recommended action), horizontally scrollable, with per-classification badge tones and verbatim
  fallback for unrecognised codes.
- **Links** only where identifiers exist, through the verified route map: Orders by ORDER NUMBER
  (that route consumes the number, not the id), accruals by id, Events and Journals by id,
  periods to the fiscal-periods detail. Nothing is fabricated.
- **No Accounting Required rows** state "No recovery is required." in place of an action.
- **No Execute action exists.** Selection (below) creates a plan; no frontend classification
  logic exists, and the only client-side numbers are page math and the summed server totals.

## Recovery batch creation

Dedicated batch type: **`historical_accounting_recovery`**, distinct from
`accounting_event_reprocess` and `operational_posting_retry` by necessity — eligible recovery
rows have no Accounting Event yet, so a type whose execution is "reprocess the Event" has nothing
to call. Journal Review remains unsupported (see the Batch Operations document).

`POST /operations/accounting/recovery/batches` (`accounting.post`/`accounting.manage`,
`x-idempotency-key`): optional reason plus up to 200 selected preview rows, each carrying source
type/id/reference, expected posting type, classification snapshot, accounting date and amount.

- **Selection is limited to eligible rows** in the UI — the checkbox does not render for anything
  else — and the server does not rely on that: every selected source is **revalidated** through
  `classifySources`, the same fragment the preview renders. Only rows STILL `eligible` are
  enrolled.
- **The client snapshot is evidence, never authority.** It is stored in
  `classification_snapshot` beside the server verdict for audit comparison; the item's own
  columns (posting type, accounting date, amount) always carry the server's values.
- **Accepted/rejected reasons** are returned per item: the current classification, `not_found`
  (covering nonexistent and cross-Company alike, revealing nothing), or
  `enrolled_in_active_recovery_batch`. Zero accepted rows refuses creation — no empty batch is
  left behind.
- **Duplicate prevention**: the `(batch_job_id, source_type, source_id)` unique index prevents
  the same source twice in one batch; a service rule rejects sources enrolled in another ACTIVE
  recovery batch. Cross-batch exclusivity is deliberately not a unique index, because "active" is
  a status-dependent condition a static index cannot express without also blocking legitimate
  re-enrolment after a cancelled batch.
- The batch is created through the existing framework — reference sequence, immutable
  transitions, audit, idempotency — and lands `ready` through the lifecycle's own
  `draft → validating → ready` moves, with `last_validated_at` set: it genuinely was validated on
  the way in. **No Event, Journal or financial record is created; only batch tables are
  written.**
- The generic batch create/add-items endpoints refuse the recovery type
  (`accounting_batch_type_requires_recovery_endpoint`); recovery batches carry per-item facts the
  generic contract cannot.
- Migration `20260805280000_historical_recovery_batch_support.ts` (created, **not executed**)
  widens the batch CHECKs for the new type and item source types, adds the four item snapshot
  columns, and adds the three recovery-only validation statuses so revalidation stores the
  classifier's verdict verbatim instead of collapsing three distinct facts into `blocked`.
- On the frontend, creation shows accepted/rejected counts and per-row reasons — a partial
  acceptance stays on screen until the user explicitly opens the batch — and navigates to the
  Batch Operations detail.

## Controlled execution — NOT IMPLEMENTED

Recovery execution does not exist. What exists today, deliberately:

- `AccountingBatchService.execute()` refuses the type with
  `accounting_recovery_execution_unavailable` — rather than silently running items through the
  Event-reprocess path, which would look up Events these sources do not have and fail every item;
- the batch detail reports `metadata.executionImplemented: false` for this type, and the UI
  therefore never offers Execute;
- revalidating an existing recovery batch works (the batch validate endpoint delegates to the
  recovery classifier and stores verdicts verbatim), and cancelling works.

The specified-but-unbuilt execution (Prompt 10D) requires: final per-item revalidation through
the recovery classifier; posting through the authoritative Event capture/source-loader/mapping/
period services with no duplicated calculation; item-level failure isolation; retry of unfinished
items only; resulting Event/Journal references; recounted counters; and immutable transitions —
all within the existing batch execute lifecycle. None of that exists yet, and nothing in the
current code pretends it does.

## Closed-period handling

Stated plainly, and true of everything implemented:

- closed-period items classify `closed_period` and remain blocked from enrolment;
- periods are never reopened automatically — period governance is the Closing feature's, and a
  human decision;
- the Accounting Date is never changed to dodge a closed period;
- records are never posted into a different period. (Nothing is posted at all; when execution
  exists it inherits these rules from the period guard it must reuse.)

## No Accounting Required handling

- No Accounting Required Orders never create an Accounting Event and never create a Journal — at
  preview they are non-eligible by the shared predicate, at creation they are rejected, and no
  execution path exists that could touch them;
- the UI records them as a settled non-outcome: "No recovery is required.";
- no historical amount or account is ever guessed — amounts shown are the source's stored
  figures, and account resolution belongs to the mapping resolver alone.

## Idempotency, concurrency and isolation

- Batch creation reserves the idempotency key through the shared helpers; exact replay returns
  the stored result, and the framework's batch row lock, item uniqueness and immutable transition
  log all apply unchanged.
- Item claiming, immediate pre-execution revalidation and duplicate Event/Journal prevention at
  run time are execution-phase guarantees — specified, not yet implemented.
- Company isolation is end to end: preview branches, laterals and mapping subqueries;
  revalidation; enrolment checks; batch and item inserts. A cross-Company source is absent or
  `not_found`, never `forbidden`.

## Known limitations

- **Only two source types** are supported; others require separate future prompts.
- **Recovery execution is not implemented** (Prompt 10D has no completion report); eligible rows
  can be enrolled but not run.
- **No browser validation** was performed on any screen in this feature.
- **No focused recovery tests** exist — preview, creation or otherwise — and no recovery
  execution tests can exist yet.
- **No real recovery batch was executed**, and none can be.
- **Historical rows remain unchanged** — the feature has not altered a single source record.
- **Closed-period items require manual period governance**; nothing here reopens anything.
- **Journal creation may occur asynchronously** after an Event requeue where the
  `reprocess_event` path is used — a stuck-Event row recovered through the existing reprocessing
  batch shows its Journal only after the normal processor posts it.
- The preview's mapping check is a prediction; the mapping resolver remains authoritative at
  posting time and may still refuse a row the preview called eligible.
- **No production-readiness claim is made.**

## Verification status

Stated exactly, from the completion reports that exist:

- **API typecheck passed** for 10A and 10C.
- **Web typecheck passed** for 10B and 10C.
- **Migration ordering validation passed** at 10C (83 ordered files); the 10C migration was
  created and **NOT executed**.
- **10D was not implemented**; no completion report exists for it and no claim is made.
- **No tests** were written or run for this feature.
- **No browser validation** was performed.
- **No real recovery execution** occurred.
- **No build** was run.
- **No database verification** was performed.
- **No production-readiness claim** is made.

## Final status

`PROMPT_10_PARTIAL`

Implemented and reported: 10A (preview backend), 10B (preview frontend), 10C (recovery batch
creation, backend and frontend, with its unexecuted migration). Not implemented: 10D (controlled
recovery execution). The feature is safe in its partial state — every execution entry point
refuses the recovery type explicitly rather than failing obscurely.

No code, localization, stylesheet, migration, configuration or database change was made in this
documentation phase, and no tests, typecheck, lint, build, browser testing, migration execution,
recovery execution or commit was performed for it.
