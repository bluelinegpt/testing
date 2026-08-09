# Company Business Day Configuration

## Purpose

A delivery Company does not stop at midnight. Cash collected at 02:00 belongs to
the previous working day, and every daily report the business actually reads is
built around that.

Before this feature the system had no such concept: it grouped by calendar date
in `Asia/Dubai`, which splits one working night across two report lines. The
business day makes the real working day explicit and configurable.

## The default rule

| Setting | Value |
| --- | --- |
| Timezone | `Asia/Dubai` |
| Business Day Start | `08:00` |
| Duration | exactly 24 hours |

Business Date **04 Aug 2026** therefore covers:

```
start          2026-08-04 08:00:00.000  local
end (display)  2026-08-05 07:59:59.999  local
end (query)    2026-08-05 08:00:00.000  local, EXCLUSIVE
```

There is **no separate Business Day End setting.** The end is always the next day
at the same start time. Storing it independently could only ever create a gap or
an overlap that nothing would notice.

## Half-open ranges

Queries use:

```
timestamp >= startUtc  AND  timestamp < endUtc
```

Never `timestamp <= 07:59:59`. A closed upper bound at a whole second silently
drops everything in the final 999 milliseconds — a transaction at
`07:59:59.400` would belong to no business day at all.

Half-open ranges also guarantee the two properties the rule depends on:

- **No gap.** Every instant falls in some window.
- **No overlap.** Every instant falls in exactly one.

## Business Date assignment

The instant is converted to Company-local time **first**. Deriving the date from
the UTC calendar would put 03:00 Dubai on the previous day for four hours every
night — precisely the error this feature exists to remove.

| Local instant | Business Date |
| --- | --- |
| 04 Aug 2026 07:59 | **03 Aug 2026** |
| 04 Aug 2026 08:00 | 04 Aug 2026 |
| 04 Aug 2026 23:59 | 04 Aug 2026 |
| 05 Aug 2026 02:00 | **04 Aug 2026** |
| 05 Aug 2026 07:59 | **04 Aug 2026** |
| 05 Aug 2026 08:00 | 05 Aug 2026 |

## Calendar Date vs Business Date

Two different questions, both legitimate:

- **Calendar Date** — "what does the wall calendar say?" Existing date filtering
  is unchanged wherever it is still the right question.
- **Business Date** — "which working day did this belong to?" A new mode, added
  only where a report describes operational activity.

They are never silently substituted for one another.

## Business Date vs Accounting Date

These are also distinct and must stay so.

| | Business Date | Accounting Date |
| --- | --- | --- |
| Answers | which working day | which fiscal period |
| Derived from | transaction timestamp + business-day rule | Journal Date / Accounting Date |
| Used by | daily operational reporting | financial statements |

**Journal Date is not replaced by Business Date.** No Accounting Event or Journal
is rewritten, re-dated or reinterpreted by this feature.

### Report classification

**Must keep using Accounting Date** — Trial Balance, General Ledger, Account
Statement, Profit and Loss, Balance Sheet. Changing a financial statement's
period logic to timestamp-based business-day logic would make the statements
disagree with the ledger they are drawn from.

The full classification — which reports can offer Business Date mode, which
cannot, and the exact column each one uses — is set out under
[Report classification and the authoritative timestamp](#report-classification-and-the-authoritative-timestamp)
below. That section is authoritative; it mirrors
`apps/api/src/company-configuration/business-day-report-sources.ts`.

## Derived, not stored

**No transaction carries a Business Date column.** It is computed from the
transaction's own authoritative timestamp and the rule effective at that
timestamp.

This avoids a duplicated value that can drift out of agreement with the timestamp
it was derived from, and it means nothing has to be backfilled. The cost is that
the rule must be effective-dated — which it is.

## Effective dating

If the rule were a single mutable setting, changing the start from 08:00 to 06:00
would silently re-group every report ever produced. Yesterday's signed-off Daily
Cash Report would print different numbers tomorrow.

`company_business_day_configurations`:

| Column | Notes |
| --- | --- |
| `company_id` | tenant scope |
| `timezone` | carried per period, not read from `company_settings` |
| `business_day_start` | `time`, so the database rejects `25:00` unaided |
| `effective_from`, `effective_to` | half-open `[)`; null `effective_to` means still in force |
| `change_reason` | mandatory, non-blank (CHECK) |
| `is_active`, `created_by_account_id`, `created_at`, `version` | |

Constraints:

- `exclude using gist (company_id with =, daterange(effective_from, effective_to, '[)') with &&) where (is_active)` — the same idiom as `account_mappings` and `accounting_periods`. `btree_gist` was already enabled by `20260717010000_trader_configuration`.
- `effective_to > effective_from`.
- Index on `(company_id, effective_from, effective_to) where is_active`.

**Why timezone is carried per period:** the timezone is half of the rule. Reading
a 2026 timestamp against a timezone adopted in 2028 would produce exactly the
silent rewrite this table exists to prevent. `company_settings.timezone` still
exists and is not duplicated as the Company's *current* timezone — it is seeded
into the first period and remains the setting used elsewhere in the system.

### Seeding

One open-ended row per Company, with `effective_from = '-infinity'` so every
historical timestamp resolves rather than falling into a hole before the first
period. The Company's already-configured timezone is reused rather than assumed.

### Changing the rule

- **Future dates only.** A change effective today or earlier is rejected
  (`business_day_effective_from_not_future`). Re-cutting an elapsed period would
  retroactively change reports that have already been read and acted on.
- The open period is closed at exactly the new start, so the two are adjacent —
  no gap, no overlap.
- A future period not yet reached is *replaced*, not stacked, so changing your
  mind before it starts does not leave two competing future rules.
- A reason is mandatory and the change is written to `audit_events` as
  `business_day.configure`.
- Nothing is deleted once a period has elapsed.

## API

All routes sit on the existing `configuration` controller, gated by
`RequireIdentityKinds("company_user")` and `RequirePermissions("users_roles.manage")`
— the permission that already governs Company settings. **No new permission and
no new role grant were added.**

| Route | Purpose |
| --- | --- |
| `GET configuration/business-day` | every rule this Company has adopted |
| `POST configuration/business-day` | adopt a rule from a future date |
| `GET configuration/business-day/window?businessDateFrom&businessDateTo` | resolve a Business Date range to its exact UTC window |

**Company is taken from the authenticated tenant context in the service, never
from a route, body or query parameter.** No caller can read or reshape another
Company's calendar.

Contracts are additive: `BusinessDayConfiguration` and `BusinessDayWindow` are new
types; nothing existing was renamed or removed.

## Validation

- **Timezone** — must contain `/` and be accepted by the runtime's own IANA
  database via `Intl.DateTimeFormat`. Asking `Intl` beats any allowlist this
  codebase could carry: it cannot go stale. A bare offset such as `+04:00` is
  rejected because it carries no DST history.
- **Start time** — `HH:mm` or `HH:mm:ss`, 24-hour, validated at the DTO and again
  in the service.
- **Dates** — strict `YYYY-MM-DD`.
- **From ≤ To** — enforced before any query is built.
- **Overlap** — enforced by the database, not only by the service.
- **No client-supplied UTC window is ever accepted.** The browser asks the
  backend to resolve a window; a boundary computed in the client would be built
  from the viewer's own clock and zone, and the backend would have no way to tell
  a wrong one from a right one.

## Local-time arithmetic

`Intl.DateTimeFormat` with an IANA `timeZone` is the only mechanism used. Fixed
offsets are deliberately never used: `Asia/Dubai` has no DST today, but the
Company list is not restricted to it and a hardcoded `+04` would be wrong the
moment it is.

Converting a local wall-clock time to a UTC instant runs the offset correction
twice, because the offset itself can differ either side of a DST boundary; the
second pass settles it.

## Performance design

- UTC boundaries are computed **once, in JavaScript**, before the query is built.
- Filtering compares an indexed `timestamptz` column directly against those
  boundaries: `timestamp >= startUtc and timestamp < endUtc`.
- The indexed column is never wrapped in a function or an `at time zone` cast in
  the `WHERE` clause, so an index remains usable.
- A range spanning many Business Dates is **one continuous window**, never one
  query per day.
- All queries stay Company-scoped, and detail results stay paginated.

No index was added: the design deliberately reuses the existing timestamp columns
and their indexes rather than introducing a derived column to index.

**Performance is a design property here, not a measured one.** No `EXPLAIN` was
run and no runtime validation was performed.

## Rule-change-safe ranges

A range that straddles a rule change cannot be one window.

If the day starts at 08:00 until 14 Aug and 06:00 from 15 Aug, applying one rule
across 14–16 Aug is wrong however it is chosen: the old rule misplaces two hours
of every later night, the new rule misplaces two hours of the first one.

`BusinessDayService.segments(from, to)` cuts the range into one segment per rule.
Each segment is still a single continuous range — a per-**day** loop would
multiply every report by the number of days requested, which is a different and
worse mistake.

### The transition boundary

Computed naively, two rules meeting produces an overlap or a gap:

```
14 Aug under the 08:00 rule ends   15 Aug 08:00
15 Aug under the 06:00 rule starts 15 Aug 06:00
                                   ^^^^^^^^^^^^
        those two hours belong to both days
```

Had the new rule started *later* rather than earlier, they would belong to
neither.

Segments are therefore **chained**: each ends exactly where the next begins.

```
segment 1   14 Aug          14 Aug 08:00  →  15 Aug 06:00   (rule A)
segment 2   15 Aug – 16 Aug 15 Aug 06:00  →  17 Aug 06:00   (rule B)
```

The transition day is correspondingly shorter or longer than 24 hours. That is
unavoidable and honest — the same thing a daylight-saving change does to a
calendar day. Every other day keeps its full 24 hours, and across the range every
instant still belongs to exactly one segment.

### Using the result

`window(from, to)` returns the outer span **plus** the segments, and a
`spansRuleChange` flag.

- `spansRuleChange === false` — one rule; `startUtc`/`endUtc` are safe to filter
  on directly.
- `spansRuleChange === true` — the outer span includes the transition slack.
  Callers must filter per segment. The flag is returned rather than left for the
  reader to infer.

All rules are fetched in **one** query and resolved in memory. Resolving each day
against the database would turn a month-long report into thirty round trips to
answer a question the first row already contained. The in-memory predicate
mirrors `configurationFor` exactly — `effective_from <= date < effective_to` — so
a range and a single date can never disagree.

---

## Report classification and the authoritative timestamp

Mapped once, in
`apps/api/src/company-configuration/business-day-report-sources.ts`. The
alternative is every report service picking a column on its own and two reports
quietly disagreeing about what happened on a given night.

### The rule that decides capability

A Business Date window is **intraday**. Placing a record inside it requires
knowing the time of day the record happened.

Most money records in this repository **do not record that**. `payment_date`,
`movement_date`, `business_date` and `accounting_date` are `date` columns chosen
by a person, not instants observed by the system. A record dated 05 Aug carries
no evidence of whether it happened at 02:00 or 22:00.

Two tempting substitutes are rejected outright:

- **`created_at`** — when the row was typed, not when the money moved. A payment
  entered on Monday for Friday's cash would land in Monday's report. Available is
  not the same as authoritative.
- **Journal Date** — a period assignment, not an operational instant. Reading it
  as activity conflates the two calendars this feature exists to keep apart.

### Group A — Accounting Date only

Trial Balance, General Ledger, Account Statement, Profit and Loss, Balance Sheet.
Listed in the map rather than omitted, so a later reader can see they were
considered and excluded, not forgotten.

### Group B — Business-Date-capable

| Report | Table | Timestamp |
| --- | --- | --- |
| Order delivery activity | `orders` | `delivered_at` |
| Driver Collection activity | `driver_reconciliations` | `confirmed_at` |
| Trader Settlement activity | `trader_settlements` | `confirmed_at` |
| Cash/Bank Movement activity | `cash_bank_movements` | `confirmed_at` |
| General Expense payment activity | `general_expense_payments` | `confirmed_at` |
| Accounting Event activity | `accounting_events` | `created_at` / `processed_at` / `failed_at` |

`delivered_at` is the only one captured automatically by the system; the
`confirmed_at` columns on Driver Collections and Trader Settlements are tied to
the confirmed status by a CHECK constraint, so they cannot be present on a draft
or absent on a confirmed row.

**Accounting Event activity is ambiguous by nature** and the map says so rather
than guessing. "How many Events arrived last night" means `created_at`; "how many
were processed" means `processed_at`; "what failed" means `failed_at`. It must be
exposed as an explicit activity measure, never defaulted.

### Group C — not suitable, with the reason

| Report | Why not |
| --- | --- |
| Trader Collection activity | `payment_date` is date-only and user-chosen; the only timestamps are `created_at` and `reversed_at`, neither of which is when the money moved |
| Payroll Payment activity | `payment_date` date-only; no confirmation instant on the table |
| Outsourced Driver Fee Payment activity | `payment_date` date-only; no confirmation instant on the table |
| **Cash Movement report** | **Name collision.** `journal_entries.business_date` is the *Accounting* date of the Journal, not the Company Business Date. This report is built from posted Journal lines — a financial report wearing an operational name — and stays on Accounting Date |
| General Expense recognition | `expense_date` is a date-only decision. Only the *payment* carries an instant, which is why payment activity is capable and recognition is not |
| Payroll Period summary | month-anchored; a business day does not divide a payroll period |
| Trader Receivable activity | another name collision: an existing date-only `business_date` with its own established meaning, deliberately left alone |

Three of the reports the brief listed as Business-Date-capable — Trader
Collection, Payroll Payment and Outsourced Driver Fee Payment — **cannot be**
without a schema change to capture a confirmation instant. They are excluded for
a source-supported reason rather than filtered on `created_at`.

---

## Confirmation timestamps added

Migration `20260805130000_operational_confirmation_timestamps` — **created, not
executed** — adds a nullable `timestamptz confirmed_at` to:

- `trader_collections`
- `payroll_payments`
- `outsourced_driver_fee_payments`

These three stored only `payment_date`, a `date` chosen by a person. That is the
right field for accounting and it is unchanged, but it carries no time of day, so
it cannot place a record inside an intraday window.

### Prospective only — nothing backfilled

Historical rows keep `confirmed_at = null`, deliberately.

There is no honest value to write there. `created_at` is when the row was typed,
not when the money moved — a payment entered Monday for Friday's cash would land
in Monday's report. `payment_date` has no time of day, so any conversion invents
an hour nobody observed. Either would produce a number that looks authoritative
and is not, and would be indistinguishable from a real one forever after.

So: Business Date mode **excludes** those rows and the report says so. Calendar
Date mode continues to serve them from `payment_date` exactly as before.
**Guessed and authoritative rows are never mixed in one Business Date total.**

### When they are set

All three tables default `status` to `'confirmed'` — records are created directly
in their final state rather than moving through a draft. Each writing service
sets `confirmed_at` to the **server's own clock**, in the same transaction as the
insert:

| Service | Site |
| --- | --- |
| `trader-receivable.service.ts` | Trader Collection insert |
| `payroll-payment.service.ts` | Payroll Payment insert |
| `outsourced-driver-fee.service.ts` | Fee Payment insert |

**No client supplies it.** A confirmation time accepted from a request would let
a caller place money in whichever business day suited them. `reversed_at` stays
separate: reversing a payment does not change when it was confirmed.

### Indexes

One per table, in the migration: `(company_id, confirmed_at) where confirmed_at
is not null` — Company-leading, matching the predicate shape a Business Date
report issues, and partial so historical rows that can never satisfy it stay out
of the index.

---

## Shared Date Mode contract

`apps/api/src/company-configuration/report-date-mode.ts`.

Without one contract each report would grow its own notion of "business date",
and the first time two disagreed the argument would be about money. Reports ask
`ReportDateModeService.resolve(report, request)` and get back both a predicate
and the description of the window that predicate implements — from the same
resolution, so the number on screen and the caption above it cannot drift.

Modes: `accounting_date`, `calendar_date`, `business_date`. `dateModesFor(report)`
decides which a given report may use.

A report asked for a mode it does not support is **refused**
(`report_date_mode_not_supported`), never quietly downgraded. Silently serving
Calendar Date results to somebody who asked for Business Date is the exact
failure this feature exists to prevent.

`resolve()` returns: applied mode, selected dates, segment list, outer display
window, timezone, Business Day Start, authoritative timestamp label,
`spansRuleChange`, and `excludesHistoricalRows`.

### The predicate is set-based

Three shapes were available:

| Shape | Why not |
| --- | --- |
| one query per Business Date | multiplies a month-long report by thirty |
| load all rows, filter in JS | unbounded memory; breaks pagination; totals stop matching the page |
| **bounded OR over segments** | **one query, index-usable** |

The third is used. Segment count is bounded by the number of rule changes the
range crosses — one or two in practice.

The column is compared directly, never wrapped in `at time zone` or any other
function, so an index on it stays usable. Both bounds are UTC instants computed
once per request. Segments are contiguous and non-overlapping by construction, so
no row matches twice and no `distinct` is needed.

### Warning codes

`warningCodes()` returns `business_day_multiple_rules_applied` and
`business_day_historical_confirmation_unavailable` as codes, not sentences, so
the frontend localizes them. A report must not present a total that silently
omits rows.

---

## Timezone divergence

The Company **display** timezone (`company_settings.timezone`) and the
**business-day** timezone (per effective-dated period) are separate on purpose:
the business-day rule is effective-dated and must not be rewritten when a display
preference changes.

Divergence is therefore legitimate, and the Company Profile panel **warns**
rather than blocks. Nothing is synchronised and no historical configuration is
rewritten. A new business-day rule defaults to the Company's current display
timezone. Reports display the timezone actually used.

---

## Integrated screens

Three operational screens filter by Business Date: **Driver Collections**,
**Trader Settlements**, **Trader Collections**.

| Screen | Authoritative timestamp | Report key |
| --- | --- | --- |
| Driver Collections | `driver_reconciliations.confirmed_at` | `driver-collection-activity` |
| Trader Settlements | `trader_settlements.confirmed_at` | `trader-settlement-activity` |
| Trader Collections | `trader_collections.confirmed_at` | `trader-collection-activity` |

### Request parameters

Added to each screen's existing filter state — nothing else changed:

```
dateMode=business_date
businessDateFrom=YYYY-MM-DD
businessDateTo=YYYY-MM-DD
```

Each screen already built its query with a generic walk over its filter object,
so declaring the three keys in the filter defaults is all it takes for the
request to carry them and for **Clear Filters** to reset them.

**No UTC boundary is ever sent.** The browser sends two calendar dates; the
backend resolves the window.

Calendar Date mode is unchanged: same labels, same parameters, same results. The
predicate is a match-everything expression in that mode, so the existing calendar
filters needed no conditional.

### Frontend controls

One component — `apps/web/src/features/operations/BusinessDateFilterControls.tsx`
— used by all three screens. Three copies of "which day does 02:00 belong to"
would eventually disagree, and the disagreement would be about money.

It renders Date Mode, the two Business Date fields, and the backend's resolved
summary: Business Date range, Applied Window, Company Timezone, Business Day
Start and Authoritative Timestamp.

Design decisions worth recording:

- **Nothing is recomputed in the browser.** Every displayed value comes from
  `appliedDateMode` exactly as the server resolved it.
- The summary renders **only** when the server says it applied Business Date
  mode. Showing a window beside Calendar Date results would describe a query
  that never ran.
- `displayEnd` is shown, never `endUtc`. The latter is the exclusive bound the
  query used; displaying it would claim the window covers a moment it does not.
- Switching mode **clears the other mode's dates**, so a stale value cannot
  survive invisibly into a request it does not belong in.
- The control sits beside the list rather than inside the filter bar, because
  the summary describes the response.
- Segment rows are keyed by the window itself, never by `configurationId` — a
  configuration identifier is not something a user should see.

### Warnings

- **Historical exclusion.** When `excludesHistoricalRows` is true the screen
  shows: *Some historical transactions are excluded from Business Date mode
  because no authoritative confirmation timestamp was recorded.* Noticeable but
  not fatal — the rows shown are correct, some older ones simply cannot be placed
  in a business day. No count is estimated and nothing was deleted. Never shown
  in Calendar Date mode.
- **Multiple rules.** When `spansRuleChange` is true the screen shows *Multiple
  Business Day Rules Applied* / *Configuration Changed During Selected Range*,
  with an expandable table of the resolved segments (Business Date range, Window
  Start, Window End, Timezone, Business Day Start). The table scrolls inside
  itself so a long range cannot widen the page.

### Filter behaviour

Every screen routes the change through its existing `applyFilter`-style handler,
which already resets the page to 1 and preserves sort, page size and all other
filters. No new state model was introduced and no new request effect was added,
so no duplicate-request loop is possible.

An inverted range is flagged in the field before the request goes out; the
backend rejects it as well.

### URL and navigation state

**None of these three screens uses URL-backed filter state** — each holds
filters in local component state. Per the phase brief, the existing pattern was
preserved rather than introducing a competing persistence model.

Consequence, stated plainly: browser Back/Forward and a direct refresh do **not**
restore Date Mode on these screens, exactly as they do not restore the existing
filters today. Migrating them to URL-backed state is a separate change.

### Row-level Business Date

**Not yet displayed.** The lists do not return a per-row Business Date, and the
frontend must not derive one — that is precisely the duplicated-logic failure the
shared resolver exists to prevent. Adding it means one additive backend field per
list, computed with `BusinessDayService`.

### Exports

None of the three screens has a list export. Driver Collections and Trader
Settlements produce **per-record PDFs** (a single reconciliation, a single
settlement statement), which are not filtered views and are unaffected by Date
Mode. Nothing to align, and no export system was created.

### Responsive behaviour

Fields sit in one row on desktop, wrap on laptop and tablet, and stack below
640px. The summary is a `minmax(220px, 1fr)` auto-fit grid. Segment tables scroll
in their own container. Dates, times, timezone names and timestamp labels carry
`dir="ltr"` so they stay readable in Arabic.

---

### Driver Collections URL state

Driver Collections is URL-backed, reusing `apps/web/src/features/accounting/use-list-state.ts`
— the same helper the Accounting lists use. No second URL-state mechanism was
created and the Accounting screens are unchanged.

**The URL is the authoritative list state.** No local or `sessionStorage` copy of
these fields remains to drift out of step with it.

Query parameters: every Driver Collections filter key (`dateMode`,
`businessDateFrom`, `businessDateTo`, `dateFrom`, `dateTo`, `driverId`,
`driverType`, `driverFeeStatus`, `reconciliationStatus`, `collectionPaymentMethod`,
`orderSerialNumber`, `referenceNumber`, `traderId`, `customerName`, `emirateId`,
`areaId`, `orderStatus`, `deliveredFrom`, `deliveredTo`), plus `page`, `pageSize`,
`sort` and `direction`. Defaults and empty values are omitted. Nothing sensitive
is stored — only page numbers, a sort key, and values the User typed or chose.

Behaviour:

- **Refresh** restores the view; **Back/Forward** restore filters, page and sort,
  because each deliberate change is a history push.
- **Copying the URL** reproduces the view.
- **Detail navigation** uses the existing `useRouteDetail` pattern, so returning
  lands back on the originating list URL.
- **Login return** preserves the full requested URL through the existing
  `landingPath` redirect; no Dashboard bounce when a valid list URL exists.
- **Company switch** clears the query with `replace`, not push, so the previous
  Company's filtered URL cannot be reached with Back.
- **Invalid values fall back safely**: page below 1 becomes 1, an unlisted page
  size becomes 25, an unknown sort key becomes the screen default, and an empty
  filter is treated as absent rather than sent as `""`.

Request-loop safeguards:

- `filterKeys` is a module-level constant. A fresh array literal per render
  would recompute state every render and re-fire the request effect forever.
- The request effect depends on the memoized filter object and primitives, never
  on a newly built object.
- Multi-key changes (switching Date Mode clears the other mode's dates) go
  through one `setFilters` write, so a second write cannot start from the first
  one's stale state and lose it.
- Sort keys are allowlisted before leaving the browser.

Server-side filtering, pagination, sorting, totals and counts are unchanged.

### Trader Settlements URL state

Trader Settlements is URL-backed, reusing the same
`apps/web/src/features/accounting/use-list-state.ts` helper and its additive
`setFilters(patch)` write. No new hook was created; Accounting and Driver
Collections are unchanged.

**The URL is the authoritative list state.** The previous local `filters`, `page`
and `pageSize` state was removed, not shadowed, so no parallel copy remains.

Query parameters: every Trader Settlements filter key (`dateMode`,
`businessDateFrom`, `businessDateTo`, `paymentDateFrom`, `paymentDateTo`,
`settlementNumber`, `traderId`, `orderSerialNumber`, `referenceNumber`,
`paymentMethod`, `paymentReference`, `settlementStatus`, `moneyReceivedStatus`,
`outstandingOnly`, `deliveredFrom`, `deliveredTo`), plus `page`, `pageSize`,
`sort` and `direction`. Defaults and empty values are omitted. Nothing sensitive
is stored.

`outstandingOnly` is a boolean in the screen's state but text in a URL, so it is
encoded as `true`/absent and decoded back to a boolean in one memoized place
rather than at each use.

Behaviour matches Driver Collections: refresh restores the view; Back/Forward
restore filters, page and sort; a copied URL reproduces the view; detail
navigation uses the existing `useRouteDetail` pattern so returning lands on the
originating URL; login return preserves the full requested URL; a Company switch
clears the query with **replace**, not push, so the previous Company's filters
cannot be reached with Back. Invalid values fall back safely — page below 1
becomes 1, an unlisted page size becomes 25, an unknown sort key becomes the
default, empty filters are treated as absent.

Request-loop safeguards: `filterKeys` is a module-level constant; the merged
filter object is memoized; multi-key changes go through one `setFilters` write;
sort keys are allowlisted before leaving the browser.

`presetTraderId` is applied only as a **fallback** and is never written to the
URL. Writing it during render would be a normalization effect firing on every
mount, and the User must still be able to clear the filter.

There is no sorting or page-size UI on this screen, so `sort`, `direction` and
`pageSize` stay at their defaults and do not appear in the URL. The plumbing
honours them if present; no controls were invented.

### Trader Collections URL state

Trader Collections is URL-backed, reusing the same
`apps/web/src/features/accounting/use-list-state.ts` helper, its
`setFilters(patch)` write, its Company-switch reset and its normalization. No new
hook; Accounting, Driver Collections and Trader Settlements are unchanged.

**The URL is the authoritative Collections list state.** The local
`collectionFilters`, `collectionPage` and `collectionPageSize` state was removed,
not shadowed.

Query parameters: `dateMode`, `businessDateFrom`, `businessDateTo`,
`paymentDateFrom`, `paymentDateTo`, `collectionNumber`, `traderId`,
`receivableNumber`, `paymentMethod`, `paymentReference`, `status`, plus `page`,
`pageSize`, `sort` and `direction`. Defaults and empty values are omitted;
nothing sensitive is stored.

**Only the Collections tab is URL-backed. Receivables keeps local state, and that
is deliberate.** The two filter models share key names — `traderId`,
`receivableNumber`, `status`, `paymentDateFrom`/`To` — so putting both in one flat
query string under their own names would make every one of them ambiguous.
Migrating Receivables later requires distinct keys (a prefix, or a nested
namespace), not a second hook reading the same ones. Until then there is no
collision, because only one model is in the URL.

The same separation applies to dates: Business Date filters here belong to the
**Collection transaction** (`confirmed_at`). `trader_receivables.business_date`
remains a separate concept and has no URL key on this screen.

**Tab behaviour.** The initial tab is Collections when the URL carries any
Collection filter or a Collection detail id, otherwise Receivables. It is
computed once in a `useState` initializer — deriving it on every render would
fight the User's own tab clicks. Receivable filter changes never write to the
query string, so they cannot overwrite Collection state, and Collection
parameters are never sent to the Receivable list request.

Behaviour otherwise matches the other two screens: refresh restores the view;
Back/Forward restore filters, page and sort; a copied URL reproduces the view;
detail navigation uses the existing `useRouteDetail` pattern so Close and Back
return to the same filtered Collections list; login return preserves the full
requested URL; a Company switch clears the query with **replace**, not push.
Invalid values fall back safely — page below 1 becomes 1, an unlisted page size
becomes 25, an unknown sort key becomes the default, empty filters are absent.

Request-loop safeguards: `collectionFilterKeys` is a module-level constant; the
merged filter object is memoized; multi-key changes go through one `setFilters`
write; sort keys are allowlisted before leaving the browser; the tab initializer
runs once rather than on every render.

There is no sorting or page-size UI on this screen, so `sort`, `direction` and
`pageSize` stay at their defaults and do not appear in the URL. The plumbing
honours them if present; no controls were invented.

---

## Order Delivery Activity

A frontend quick view inside the existing Orders module — not a separate module,
route or page. It reuses the Orders list, filters, row rendering, detail route,
permissions and query infrastructure.

### The view is frontend state; the API sees something else

The URL stores the selected view as `quickView=delivery`. **That parameter is
frontend state only.** The API never receives it — the request builder sends
`quickView` only for the five values the backend implements (`active`, `all`,
`hold`, `cancelled`, `closed`).

Delivery Activity reaches the backend as **`deliveredOnly=true`**.

This separation is deliberate: a URL parameter and an API parameter that happen
to share a name do not have to mean the same thing. Sending `quickView=delivery`
to a backend whose predicate is a chain of equality checks would match no branch
and silently return nothing.

### What the view includes

Every Order with an authoritative `orders.delivered_at`, **including an Order
whose current status later became Returned or Cancelled**. The view reports that
a delivery occurred; the current Delivery Status stays visible in its own column.

It is **not** based on `delivery_status = 'delivered'`.

### Calendar Date mode

```
dateMode=calendar_date
deliveryDateFrom=YYYY-MM-DD
deliveryDateTo=YYYY-MM-DD
```

Filters the **Company-local** calendar date of `delivered_at` — a UTC date would
push deliveries before 04:00 Dubai onto the previous day.

`dateFrom` and `dateTo` are untouched and continue to mean **Order Date**,
everywhere including inside this view.

### Business Date mode

```
dateMode=business_date
businessDateFrom=YYYY-MM-DD
businessDateTo=YYYY-MM-DD
```

Resolved against the effective-dated Company Business Day configuration through
`ReportDateModeService`, producing segmented half-open UTC windows. One Business
Day resolution per request; no per-day query loop.

The backend is authoritative. **The browser calculates neither Business Dates nor
UTC boundaries** — a boundary derived in the browser would be built from the
viewer's own clock and zone, and the server could not tell a wrong one from a
right one.

### Row display

| Column | Source | Formatter |
| --- | --- | --- |
| Delivery Date and Time | `deliveredAt` only | `formatDateTime` |
| Delivery Business Date | `deliveryBusinessDate` only | `formatDate` |

Both columns appear only in Delivery Activity. A null in either shows
**`Historical Delivery Timestamp Unavailable`** — not a dash, because the absence
is meaningful and a dash reads as a loading gap or a UI defect.

There is **no fallback** to Order Date, Created At, Updated At, status history, or
any browser-timezone calculation.

### Metadata and warnings

The response carries `appliedDateMode`, rendered by the shared
`BusinessDateFilterControls`: applied Date Mode, selected range, Window Start,
Window End, Company Timezone, Business Day Start, and Authoritative Timestamp —
shown as **Delivery Date and Time**.

When a range crosses a Business Day rule change, the multiple-rule notice and the
resolved segments are shown in an expandable panel. When the backend reports
exclusions, the Orders-specific wording appears: *Some historical delivered
Orders are excluded because no authoritative delivery timestamp was recorded.*

All of it is backend-derived. Nothing is reconstructed in the browser, and no
configuration identifiers are displayed.

### Export

The list, the count and the export share **one** Delivery Activity predicate
(`deliveryActivity()` in `operations.service.ts`). Three copies would eventually
disagree, and the disagreement would be an export that does not match the screen
it came from.

Calendar Date and Business Date semantics are therefore identical to the screen,
as is the default ordering:

1. `delivered_at` descending
2. numeric Order sequence descending
3. `id` descending

The tiebreakers exist because two Orders delivered in the same second must land
in a fixed order, or offset pagination can repeat one row and skip another. Order
Number is compared numerically — lexically, `ORD-9` sorts after `ORD-10`.

The temporary `orders_export_delivery_activity_unsupported` (501) refusal has been
removed.

**CSV metadata headers remain deferred.** The current CSV builder emits a header
row followed by data rows and has no metadata mechanism; adding one would mean
redesigning the export format.

### URL-backed list state

The URL is the **authoritative** Orders list state, using the shared
`use-list-state.ts` helper. Persisted: the quick view, all Delivery Activity
fields, every existing Orders filter under its existing key, page, page size,
sort and direction. Defaults and empty values are omitted; nothing sensitive is
stored.

Refresh, browser Back/Forward, a copied URL, and returning from an Order detail
all restore the view. Login return preserves the full requested URL. A Company
switch clears the query with **replace**, not push, so another Company's filters
cannot be reached with Back.

**Clear Filters** keeps the current view and page size, clears the other filters
and resets the page. In Delivery Activity it also restores `deliveredOnly=true`
and `dateMode=calendar_date` so the view stays usable; it does not switch back to
Active.

### Request-loop safeguards

- Filter keys are a module-level constant, derived from the filter defaults. A
  literal created during render would produce new state every render and re-fire
  the request effect forever.
- The merged filter object is memoized.
- **No duplicate page reset after a filter write.** The helper already resets to
  page 1; an effect doing it again would push a second history entry for one user
  action, and Back would appear not to work.
- **No duplicate page reset after a page-size change**, for the same reason.
- Quick-view and Date Mode transitions are one atomic `setFilters` write —
  separate writes would each start from the same stale snapshot.
- No conflicting local or `sessionStorage` persistence remains; the previous
  local state was removed, not shadowed.

### Verification status

Verified **only** through source inspection and syntax parsing.

- No runtime verification.
- No browser testing. Back/Forward, refresh, export and Company switching are
  described from the source, **not** from having been exercised in a browser.
- No database verification.
- Migrations remain unexecuted.
- **No production-readiness claim is made.**
- **A TypeScript typecheck and an application build remain required before
  deployment.**
- Specifically: the Orders URL-state integration casts the generic filter map
  (`as unknown as Record<string, string>`) to bridge the typed `OrderFilters`
  object and the helper's string map. That cast is a real type-safety concern and
  **must be validated during typecheck** — parse-only checking cannot see it.

---

## Known limitations

- **Business Date integration covers four operational screens only** — Driver
  Collections, Trader Settlements, Trader Collections and Order Delivery
  Activity. Each uses the shared `BusinessDateFilterControls`; Calendar Date and
  Business Date each send their own backend-supported fields, and the backend
  remains authoritative for every window. Orders Delivery Activity uses the
  Delivery Date fields, never the normal Order Date fields.

  Every other report is either Accounting-Date-only by design or still needs
  separate integration. Business Date is **not** available across BluelineGPT
  generally.
- **Order Delivery Activity is implemented** — see the section above. CSV export
  metadata headers remain deferred, and the Orders URL-state filter-map cast
  still needs a typecheck.
- **Row-level Business Date is displayed on all four integrated screens**, from
  backend fields only: `confirmationBusinessDate` on Driver Collections and
  Trader Settlements, the same field labelled *Transaction Business Date* on
  Trader Collections, and `deliveryBusinessDate` on Order Delivery Activity.

  A historical row with no authoritative timestamp shows the relevant
  *timestamp unavailable* message in place of a date. Those values are **not**
  calculated, estimated or backfilled — the absence is reported as an absence.
- **All four integrated screens are URL-backed**, sharing `use-list-state.ts`,
  so Date Mode, dates, filters, page, page size and sort survive refresh and
  Back/Forward. On Trader Collections only the Collections tab is URL-backed;
  Receivables keeps local state because the two filter models share key names.
- **Five screens still do not consume the Date Mode contract:** General Expense
  Payment, Payroll Payment, Outsourced Driver Fee Payment, Cash/Bank operational
  activity and Accounting Event activity. `ReportDateModeService` and
  `BusinessDayService` are in place for them; their filters, frontend controls,
  row-level Business Date and export alignment are outstanding.
- **Accounting Event activity has no activity-measure selector.** Its three
  candidate timestamps remain ambiguous by nature; the map requires an explicit
  choice and the screen cannot yet offer one, so it keeps its existing
  behaviour rather than defaulting to one timestamp.
- **`confirmed_at` is populated only at insert.** All three tables create records
  already confirmed, so there is no status transition to hook. Were a draft state
  added later, the transition would need to set it.
- **Business Date is not yet displayed on transaction detail screens.** The
  resolver exposes `businessDateOf`, but no screen calls it.
- **Date-only fields cannot carry a business day.** General Expense date and
  Trader Receivable business date have no time of day; only timestamped events
  can be placed in a window.
- **`company_settings.timezone` and the business-day timezone can diverge** if
  one is changed without the other. The business-day rule is authoritative for
  business-day resolution; the setting continues to serve its existing callers.

## Verification status

Source-level only.

- **No browser testing** was performed.
- **No runtime validation** was performed.
- **No database verification** was performed and no live data was inspected.
- **No migration was executed.** `20260805120000_company_business_day_configuration`
  and `20260805130000_operational_confirmation_timestamps` exist on disk and have
  not been run.
- **No historical timestamp was backfilled, guessed or derived.**
- **No historical migration was modified.**
- **No historical record was changed, re-dated or backfilled.**
- **No Journal, Accounting Event or financial record was created or modified.**
- **No permission and no role grant was added.**
- **Production readiness is not claimed.**
