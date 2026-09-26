# Accounting Event Lifecycle

Phase 4 — processing timeline, failure explainability, and safe single-Event
reprocessing.

**Source-level implementation only.** No reprocessing was executed, no Journal
or Accounting Event data was modified, no browser or database validation was
performed, and production readiness is not claimed.

---

## 1. Technical states (as stored)

`accounting_events.processing_status` is constrained to exactly nine values
(`20260801120000_accounting_operational_integration.ts`):

```
received · processing · validated · posted · failed
retry_pending · blocked_configuration · reversed · ignored_duplicate
```

### 1.1 Two findings that shape everything below

**`blocked_configuration` is never written.** It exists in the check
constraint and is read by eligibility, report and summary queries — but no code
path sets it. Searching the whole backend finds only readers.

**A configuration-blocked Event therefore sits in `received` forever.** The
processor's claim query (`accounting-event.repository.ts`) requires:

```sql
join accounting_configurations c on c.company_id = e.company_id
where e.processing_status in ('received','retry_pending')
  and c.accounting_enabled and c.automatic_posting_enabled
  and e.operational_area = any(c.automatic_posting_areas)
```

An Event failing any of those three conditions is simply never claimed. Nothing
on the Event row records why. Before this phase the screen showed a bare
"Received" badge and the User had no way to learn that a switch was off.

---

## 2. Business lifecycle states

`accounting-event-lifecycle.ts` is the single mapper. Every screen — list,
detail, badge, action eligibility — resolves state through it.

| Business state | Derived from | Tone |
| --- | --- | --- |
| Posted | `posted` | success |
| Reversed | `reversed` | info |
| Duplicate Journal Prevented | `ignored_duplicate` | info |
| Processing | `processing` | info |
| Failed | `failed` / `blocked_configuration` | danger |
| Retry Pending | `retry_pending` | warning |
| Configuration Required | `received`/`validated` + `accounting_enabled=false` | warning |
| Waiting for Automatic Posting | `received`/`validated` + `automatic_posting_enabled=false` | warning |
| Waiting for *{Area}* Automatic Posting | `received`/`validated` + Area not in `automatic_posting_areas` | warning |
| Awaiting Processing | `received`/`validated`, nothing blocking | info |

The waiting states are derived from **configuration flags the query layer now
returns alongside the Event** (`accountingEnabled`, `automaticPostingEnabled`,
`areaEnabled`) — one join to `accounting_configurations`, which holds one row
per Company. They are not invented, and they are not stored on the Event.

### 2.1 Waiting is not failure

An Event waiting on a disabled Area is reported as *waiting*, with the Area
named ("Waiting for Driver Collections Automatic Posting") and a link to the
Automatic Posting screen. It is never shown as Failed, never counted as an
error, and no Reprocess action is offered — re-queueing it would do nothing,
because the processor's claim query would still skip it.

---

## 3. Failure classification

Two-level, both from stored values:

1. **`error_code`** — the specific code the posting service raised
   (`accounting_event_mapping_missing`, `accounting_event_period_closed`, …).
   18 codes are mapped to friendly categories.
2. **`failure_category`** — the coarse bucket the processor persists
   (`transient`, `configuration`, `period`, `source`, `validation`, `system`),
   used when the code is unrecognised.

Each category carries a friendly title, a plain-language explanation, a
recommended next action, and whether a retry alone can clear it. Only
`transient` is retryable without a change.

The raw driver message is never surfaced: `safe_error_summary` is written by the
processor from a curated map or an `ApplicationException` message, and
`safeIdentifier()` already refuses to persist anything that is not a bare
identifier. No SQL, stack trace or constraint name reaches the UI.

**A configuration blocker outranks the recorded failure.** If the Area was
switched off after a failure, the required action is to turn it back on,
whatever the last error said.

---

## 4. Processing Timeline

Built **only from stored data**. Two sources:

| Source | Provides |
| --- | --- |
| Event row | `created_at`, `validated_at`, `processing_locked_at`, `processed_at`, `next_attempt_at` |
| `audit_events` (append-only) | every `accounting.operational_event.failed` and `accounting.event.reprocessing_requested`, with actor name and reason |

### 4.1 Schema limitation (reported, not worked around)

**The Event row stores only the LATEST attempt.** `last_attempt_at`,
`failed_at`, `error_code` and `safe_error_summary` are overwritten on each run,
so the row alone cannot show attempt history — a successful reprocess would
erase every earlier failure from the screen.

The append-only audit trail is used instead for anything historical, which is
why prior failures survive a later success. **No migration was added**: an
attempt-history table would be the complete fix, but the audit trail already
carries the facts and adding schema was not justified for this phase.

Consequences to be aware of:

- Per-attempt failure *messages* are not recoverable beyond the latest one; the
  audit rows record the error code and category, not the full summary.
- Stages the schema does not timestamp (Source Validated, Configuration
  Checked, Mapping Resolved, Fiscal Period Checked) are **omitted**, not
  invented.

Entries are merged and sorted chronologically, and all times render in
`Asia/Dubai` — never as raw ISO strings.

---

## 5. Reprocessing eligibility

`reprocessingReadiness()` returns concrete blockers rather than a bare boolean:

| Blocker | Meaning |
| --- | --- |
| `event_already_posted` | Terminal |
| `event_currently_processing` | A worker holds it |
| `event_reversed` | Terminal |
| `event_ignored_duplicate` | Terminal |
| `event_status_not_reprocessable` | Not in a retryable state |
| `event_journal_already_exists` | A Journal already owns this Event |
| `accounting_disabled` | Company gate |
| `automatic_posting_disabled` | Company gate |
| `operational_area_disabled` | Area gate |
| `source_record_missing` | Source no longer resolves |

The configuration gates are included precisely because the processor applies
them on claim: without them, reprocessing a blocked Event would report success
and then silently do nothing.

---

## 6. Reprocessing flow

The existing endpoint was **reused and hardened**, not duplicated:

```
GET  operations/accounting/events/:eventId/reprocessing-readiness   (preview)
POST operations/accounting/events/:eventId/reprocess                (action)
```

1. The screen fetches readiness and shows the preview: Event Type, Area, Source
   Transaction, Accounting Date, lifecycle status, attempts, latest failure,
   eligibility and every blocker.
2. Confirmation is required; an optional note is captured.
3. `reprocess()` **re-runs the same readiness check inside the transaction** and
   refuses with `409` plus the blocker list if anything changed since the page
   loaded. The button is never the authority.
4. On success the Event returns to `received` with `next_attempt_at=now()`, and
   the **normal processor** picks it up. Nothing here writes a Journal.
5. The detail screen refreshes and shows the resulting state.

**Duplicate Journals cannot result**: `event_journal_already_exists` blocks any
Event that already owns one, the request is idempotency-key protected via
`reserveIdempotency`, and `journal_entries_accounting_event_unique` is a unique
index on `(company_id, accounting_event_id)`.

### 6.1 Audit

The existing audit infrastructure is used (`support.audit`). The record now also
captures the **prior** status, attempt count and failure category, so the
timeline can describe what the Event was before the request after the row itself
has moved on. Internal audit identifiers are never shown.

---

## 7. Permissions and Company isolation

No permission or role grant was added. Reprocessing continues to require
`accounting.post` or `accounting.manage`; viewing requires `accounting.view`.
Frontend checks are advisory — the backend re-asserts on every request.

Every query in this phase is Company-scoped: `company_id` appears in the WHERE
clause and in every JOIN condition, including the reverse reversal lookup, the
configuration join and the audit history. Company always comes from the
authenticated context, never from request input. No global Event lookup exists.

---

## 8. Reversal relationships

`accounting_events` stores only the child → parent edge
(`reversal_of_event_id`). The **reverse** edge is now resolved in the query
layer with a Company-scoped `LEFT JOIN LATERAL … LIMIT 1`, so:

- Original Event → Reversal Event ✅ (new)
- Reversal Event → Original Event ✅
- Original Journal → Reversal Journal ✅ (new, via `reversed_by_journal_id`)
- Reversal Journal → Original Journal ✅ (new, via `reversal_of_id`)

No migration, and no relationship is fabricated: an Event with no reversing
child shows "Not Reversed".

---

## 9. Performance

- Event detail: 4 queries (header, components, source transaction, history) —
  per screen, never per row or per timeline entry.
- Event list: still **one** query; the configuration join is a single row.
- Reprocessing preview: reuses `detail()`, adding no per-blocker lookup.
- Audit history bounded at 50; related records bounded at 50.

**Pre-existing N+1 found and reported, not changed:**
`general-expense-query.service.ts` `detail()` calls `resolveMappingAccount`
inside `lines.rows.map(async …)` — one account-resolution query per Expense
line.

No performance claim is made; nothing was measured.

---

## 10. Known limitations

1. Per-attempt failure history is limited to what the audit trail records (§4.1).
2. `blocked_configuration` remains dead in the schema; the blocker is derived
   rather than stored, so a report querying that status still returns nothing.
3. Timeline stages without a stored timestamp are omitted.
4. Fiscal-period and mapping status are **not** pre-checked in the preview —
   only Company/Area gates, Journal ownership and source presence are. A closed
   period still surfaces as a failure after the retry rather than before it.
5. The reprocess preview does not show expected Journal lines; no existing
   preview service covers operational Events, and duplicating posting logic in
   the frontend was explicitly out of scope.
