# Accounting Event Reprocess — Precheck and Controlled Execution

## Scope and repository decision

This is the source-level Accounting Prompt 11 implementation: a read-only precheck that answers
"would reprocessing this Accounting Event succeed", its display on the Event detail screen, and a
controlled execution path that re-runs the full precheck inside the reprocess flow before anything
is written.

The governing decision: **the precheck is the posting pipeline stopped before its first write**.
`OperationalJournalPostingService.process()` runs load-source → resolve-period → resolve-mappings
→ assert-balanced → write; the precheck runs the same first four steps with the same services and
stops. Nothing is restated — a blocker reported by the precheck is the exact refusal posting would
raise, carrying the pipeline's own error code. And because reprocessing only re-queues the Event
for the normal processor, the pipeline still re-checks everything itself at posting time; the
precheck makes the refusal visible before a person commits, it never makes posting more
permissive.

## Precheck backend (11A)

`POST /operations/accounting/events/:eventId/reprocess-precheck` — POST to match the sibling
`events/reprocess-preview` route, though the call is read-only. Permissions: `accounting.post`,
`accounting.manage` or `users_roles.manage`, `company_user` identity.

Checks, in one call:

- **Company isolation** — another Company's Event and a nonexistent one both answer "not found";
  every query is Company-scoped.
- **Retry eligibility** — the existing `reprocessingReadiness` blockers are included wholesale
  (status not reprocessable, currently processing, reversed, ignored duplicate, Journal on this
  Event, Accounting/Automatic-Posting/area disabled, source record missing).
- **Source existence and validity** — the operational source loader (the pipeline's own) loads
  the facts; its refusals are caught and returned as blockers, because "no, because X" is a
  result, not an error.
- **No Accounting Required exclusion** — if the loader drops every component as zero (which for
  an Order is precisely the No Accounting Required answer), the precheck blocks with
  `accounting_no_posting_required`. No zero-value posting can be previewed into existence.
- **Mapping validation** — `AccountMappingResolver.resolve` on the loader's own components; its
  refusal codes (missing, overlap, inactive/non-posting account) become the blockers, and on
  success the resolved lines are returned (mapping key, account code/name, intent, amount — no
  internal configuration ids).
- **Accounting Date validation** — the pipeline's own test; a stored Event date differing from
  the source date is a warning (posting corrects the Event to the source date, never shifts the
  posting).
- **Fiscal-period validation** — the pipeline's exact period join and tests (one period for the
  date; year open/reopened; period open/reopened with the `soft_closed` distinction), with one
  deliberate difference: no `for update` lock, so a precheck never queues behind or blocks a real
  posting.
- **Duplicate detection** — beyond readiness: another posted Event on the same source and event
  type (`accounting_event_duplicate_posted`), and a posted Journal on the source this Event does
  not own (`accounting_journal_exists_for_source`), with references returned.
- **Debit/credit preview** — totals summed from the resolver's lines by the components' own
  intent, tested with the posting service's exact balance rule.
- **Financial drift** — the components the Event recorded at validation are compared with the
  components the source produces now, per (mapping key, intent); a mismatch is the
  `source_financial_values_changed` warning.
- Reversal Events are refused with their own code — they replay a stored original and have no
  forward precheck.

The response carries `allowed`, Event id/reference/status, source type/id/reference, expected
posting type, Accounting Date, fiscal period id/status, resolved mappings, expected debit and
credit totals, existing Event/Journal references, blocker and warning code+message pairs, and
`recommendedAction` (`reprocess` / `resolve_blockers` / `none`). Unexpected failures collapse to
a generic code; no SQL, stack traces or constraint names appear anywhere.

**The precheck creates no Event and no Journal, changes no Event status, writes nothing, and is
safe to rerun** — the loader and resolver take only momentary `FOR SHARE` read locks.

## Precheck frontend (11B)

Integrated into the existing Event detail page's `EventReprocessAction` panel — no second Event
screen, no duplicate route. The panel keeps its existing visibility rule: posted, reversed and
in-flight Events show nothing at all.

- **Run Precheck** calls the endpoint, disables while running, and stamps the result with the
  time it ran.
- The result renders Allowed/Blocked as a badge, then the summary (Event reference/status, source
  type/reference, expected posting type, Accounting Date, fiscal period + status, expected debit
  and credit totals, recommended action), the resolved-mappings table, blocking reasons, warnings
  and links.
- **Links** only where identifiers exist, through the verified route map — the source record per
  entity type (Orders by order number), the duplicate posted Event, the existing Journal, and the
  fiscal period. Nothing fabricated.
- **Freshness**: the precheck timestamp and the Event status the precheck saw are shown. No
  time-based expiry was invented; the statement of record is the on-screen note that final
  execution revalidates all conditions on the server.
- **Reprocess is disabled** until the latest precheck on screen came back `allowed` — a courtesy,
  not a control, since the backend revalidates regardless. A blocked result shows why.
- **No frontend accounting calculation**: totals, mappings and verdicts are backend values
  rendered as given. Unknown blocker codes fall back to the backend's own message.

States covered: not-yet-run, loading, permission denied, every blocker family (not
retry-eligible, source not found, closed period, mapping missing, duplicate posted, No Accounting
Required), and generic backend errors.

## Controlled execution (11C)

`POST /operations/accounting/events/:eventId/reprocess` — the repository's existing route,
contract unchanged and additive (`expectedStatus` is a new optional field). Requires the
accounting permission and `x-idempotency-key`; the reason is recorded as before.

Flow, inside the existing reprocess transaction:

1. **Idempotency reservation first** — an exact replay returns the stored result before any
   validation runs.
2. **Readiness enforcement** (as before): a non-eligible Event is refused with its blockers.
3. **Stale-observation guard**: `expectedStatus` — the status the caller REVIEWED, taken from
   their precheck — is validated against the Event's current status
   (`accounting_event_state_changed` on mismatch), and is part of the hashed idempotency payload,
   so the same key with a different observed state is a payload mismatch, never a stale replay.
4. **Full precheck revalidation**: the complete precheck re-runs as a hook inside the reprocess
   flow — after the replay check, before any write — and any blocker refuses with
   `accounting_event_precheck_blocked` and the blocker codes. The frontend's precheck result is
   never trusted. (The hook is passed as a callback rather than injected, to avoid a DI cycle:
   the precheck service already depends on the Event query service.) The one precheck WARNING
   that does not refuse is financial drift: posting re-derives everything from the source, and
   the processor's own hash guard refuses a validated Event whose source changed.
5. **The existing requeue**, exactly as designed: the status-guarded UPDATE (only
   failed/blocked/retry-pending rows move) re-queues the Event for the normal processor, records
   the actor, timestamp, reason and prior state in the audit trail, preserves the failure
   history, and completes the idempotency record.

**Journal creation stays asynchronous.** Reprocess re-queues; mapping resolution, period locks,
balancing and the Journal write happen in the processor, exactly once, under the pipeline's own
guards. No synchronous Journal creation was invented; a Journal reference in any response appears
only where one already exists.

**Failure behavior**: everything above runs in one transaction — a refusal at any step rolls back
the reservation and leaves no half-transitioned Event and no partial Journal (none is ever
written here). Refusals carry the module's public codes and messages only.

## Duplicate protection and idempotency

- No duplicate successful Event and no duplicate Journal can result: the requeue's status guard
  refuses posted/reversed/in-flight Events; the precheck blocks on another posted Event or a
  posted source Journal; and the processor's claim conditions and event-hash guard hold at
  posting time regardless.
- Exact replay under the same key returns the stored result.
- A changed Event state under the same key is rejected — `expectedStatus` is hashed into the
  payload, and validated inside the transaction.
- Concurrent reprocess calls cannot run the same Event twice: the status-guarded UPDATE is the
  fence — the second caller finds the Event no longer in a reprocessable status.
- Previous failure history is preserved; a successful reprocess never hides that the Event once
  failed (the lifecycle banner states it explicitly).

## Closed period

- Closed-period sources remain blocked (`accounting_event_period_closed` /
  `accounting_event_period_soft_closed` / year closed), at precheck and again at execution.
- The period is never reopened automatically; period governance belongs to the Closing feature.
- The Accounting Date is never changed to dodge a period, and the source is never posted into
  another period — the source date is authoritative and posting corrects the Event to it.

## No Accounting Required

- No Accounting Required sources are never reprocessed: the precheck blocks them and the
  execution revalidation refuses them.
- No Event is created, no Journal is created, and no amount or account is ever guessed — amounts
  come from the loader's own components and accounts from the mapping resolver alone.

## Frontend execution result

- **Reprocess Event** enables only on a fresh `allowed` precheck; the confirmation modal shows
  the Event reference, source reference, current status, Accounting Date, fiscal period and
  status, and the expected debit/credit totals — read-only, with no editable mapping or Journal
  lines — plus the warning that all conditions are revalidated server-side before anything runs,
  and an optional reason.
- On success the Event detail refreshes and the precheck re-runs (the verdict just consumed is
  stale by definition); the route is preserved. On refusal, the specific code renders a friendly
  message and the precheck re-runs so the current conditions are visible.
- The asynchronous nature of the result is stated in the UI wording: execution re-queues the
  Event; the Journal, when one results, appears through the normal processor.

## Known limitations

- **No focused Prompt 11 tests** exist, backend or frontend.
- **No browser validation** was performed on any screen in this feature.
- **No real reprocess action was executed** during implementation.
- **The Journal is created asynchronously** by the normal processor; a successful reprocess shows
  no Journal reference until the processor posts.
- **No automatic polling** exists after execution; the user refreshes.
- The precheck's revalidation hook reads committed state concurrently with the transaction's own
  row guards; the final fence is the status-guarded UPDATE plus the processor's own posting-time
  checks, which is where correctness actually lives.
- **Unsupported source types remain unsupported**; reversal Events have no forward precheck.
- **Precheck freshness has no time-based expiry** — deliberately; server-side revalidation is the
  guarantee, not a timer.
- **No production-readiness claim is made.**

## Verification status

Stated exactly, from the completion reports that exist:

- **API typecheck passed** for 11A and for 11C.
- **Web typecheck passed** for 11B and for 11C.
- **No tests** were written or run.
- **No browser validation** was performed.
- **No real reprocess execution** occurred.
- **No migration** was created or executed anywhere in Prompt 11.
- **No production-readiness claim** is made.

## Final status

`PROMPT_11_IMPLEMENTATION_COMPLETE_TESTING_DEFERRED`

11A (precheck backend), 11B (precheck frontend) and 11C (controlled execution, backend and
frontend) are implemented with completion reports and passing typechecks. Testing, browser
validation and any real execution are deferred.

No code, localization, stylesheet, migration, configuration or database change was made in this
documentation phase, and no tests, typecheck, lint, build, browser testing, migration execution,
reprocess execution or commit was performed for it.
