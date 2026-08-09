# Accounting Dashboard

## Scope and repository decision

This is the source-level Accounting Prompt 8 implementation: a read-only dashboard that composes
five sections — Cash and Bank, Money Position, Income and Expense, Accounting Health, and Recent
Activity — from services that already own each figure.

The governing decision is that the dashboard **asks; it does not decide**. Every financial figure
on the screen has an owner elsewhere. Cash and Bank balances come from `CashBankQueryService`, the
Money Position from `PaymentPositionService`, and Revenue and Expenses from
`AccountingReportService`'s Profit and Loss. The dashboard composes their answers and recomputes
none of them.

That is not a style preference. A dashboard carrying its own version of "the cash balance" would
eventually disagree with the Cash/Bank screen, and the disagreement would surface as a question
nobody could answer without reading both queries side by side. Where a number here differs from the
screen it summarises, that is a defect in the dashboard, not a second opinion.

The implementation reuses:

- Company context and the tenant accessor, with `company_id` in every query branch;
- the widened authoritative Cash/Bank balance query and its coverage counts;
- the Unified Payment Position service, called once per direction;
- `AccountingReportService` for Profit and Loss;
- the existing permission model, list-state conventions and shared UI components.

No new permission is introduced. `accounting.view` or `accounting.manage` grants access. No
migration was added and no table was created: the dashboard reads only.

## Backend summary API

One endpoint, one GET, no write path of any kind:

```
GET /operations/reports/accounting-dashboard
```

Files:

- `apps/api/src/accounting/accounting-dashboard.dto.ts`
- `apps/api/src/accounting/accounting-dashboard.service.ts`
- `apps/api/src/accounting/accounting-dashboard.controller.ts`
- registered in `apps/api/src/accounting/accounting.module.ts`

It sits under its own route prefix rather than as a `kind` on the accounting reports controller,
which ends in a catch-all `@Get(":kind")` that would swallow it. Identity is restricted to
`company_user`.

The response carries the applied filters, the Company timezone, a generated timestamp, the five
sections, and coverage and limitation metadata. The contract is additive: no existing response
shape, service signature or route was changed.

### Query shape and cost

The six independent reads are issued together rather than in sequence, so one screen does not pay
six round trips of latency serially. There is no N+1 anywhere: Accounting Health is one grouped
statement of six counts, and Recent Activity is a single `UNION ALL` limited per source *before*
the union and again after ordering. Nothing is aggregated in application memory.

Every branch — including each of the nine activity sources and each joined lookup — filters on
`company_id`, with joins constrained on `company_id` on both sides.

## Route and navigation

- Dashboard route: `/accounting/dashboard`.
- A separate menu item labelled **Dashboard**, placed above Overview in the Accounting sidebar.
- Overview is unchanged. It remains the default screen at `/accounting`, keeps its route, its menu
  entry and its content. The Dashboard neither replaces nor renames it.
- The Dashboard is read-only. It has no form that writes, no action button, and no mutation path.

Frontend files:

- `apps/web/src/features/accounting/AccountingDashboardPage.tsx` (new);
- `AccountingWorkspace.tsx` — section registration, route case, and the menu entry;
- `accounting-types.ts` — `"dashboard"` added to `AccountingSection`;
- `localization/resources/en.ts` and `ar.ts` — the `accountingDashboard` key set and the section
  label.

## Filters

Five filters: **Date From**, **Date To**, **Account**, **Party Type**, **Party**, with **Apply**
and **Clear**.

State is URL-backed, following the Accounting list-state convention. The query string is the single
source of truth, so a filtered dashboard is shareable, bookmarkable, survives a refresh, and is
restored exactly by Back. No parallel local copy exists to drift out of step with it.

Filtering is server-side only. The page forwards the values verbatim and filters nothing in the
browser. An empty filter is an absent filter and is never sent.

The API validates the contract: dates must be `YYYY-MM-DD`, `accountId` and `partyId` must be
UUIDs, and `partyType` must be one of the Payment Position party types — that list is **imported**
from the Payment Position contract rather than retyped, so the dashboard cannot accept a party type
that service cannot resolve. A start date after the end date is refused with
`accounting_dashboard_date_range_invalid`.

### Which filter reaches which section

This is the part most easily misread, so it is stated explicitly:

| Filter | Cash and Bank | Money Position | Income and Expense | Health | Recent Activity |
| --- | --- | --- | --- | --- | --- |
| Date From / Date To | Movement Activity only | yes | yes | yes | yes |
| Account | yes | no | no | no | no |
| Party Type / Party | no | yes | no | no | Party Type only, as a row filter |

**Current balances are deliberately not date-filtered.** A balance is a position as at now; there
is no as-at-date variant of the authoritative query, and pretending a date range narrows a current
balance would be false. Money Position and Profit and Loss have no account dimension, so the
Account filter does not reach them.

## Cash and Bank

Shown:

- Current Cash Balance
- Current Bank/Visa Balance
- Net Cash **Movement Activity**
- Net Bank **Movement Activity**
- Cash and Bank account counts
- historical funding-account coverage counts, as a table
- the coverage warning, when coverage is incomplete

Stated clearly, because each of these is a way the screen could be misread:

- **Movement Activity is not a full Balance Change.** The two figures do not reconcile and were
  never meant to.
- **Period movement currently includes Cash/Bank Movements only.** The balance beside it also
  counts Payroll, Driver fee, Settlement and Expense payments; the movement figure does not.
- **Current balances use the widened authoritative balance query** —
  `CashBankQueryService.balances()`, basis `opening_balances_movements_and_confirmed_payments`.
- **The dashboard does not calculate these values in the frontend.** Every amount is a string the
  server produced, which the page formats and places.

Cash and Bank stay separate everywhere. There is no combined "liquidity" figure, because that would
hide the one distinction the balance policy engine, the overdraft rules and the reconciliation
screens all turn on.

### Why the movement figure is computed in the dashboard

It is the only figure in the feature without an existing owner, and the reason is structural: no
service exposes a balance **as at a date**, so a true period delta cannot be requested. The
dashboard therefore derives it from `cash_bank_movements` directly.

The leg treatment mirrors the Movements portion of the authoritative formula exactly — a source
gives up the amount plus the fee, a destination receives the amount, a confirmed reversal undoes
its original, and a reversal row is never counted as a movement in its own right.

The fields are named as movement rather than as a balance change, the response metadata carries
`movementScope: "cash_bank_movements_only"` and a note saying the same thing in prose, and the UI
prints that note beside the cards. A user who read the period figure as the change in the balance
would conclude money is missing.

The proper fix is an as-at date parameter on `balances()`, so both numbers derive from one formula.
That changes an authoritative query four payment workflows depend on and was not made here.

### Coverage

The coverage counts are carried from the authoritative balance rows, not recounted. They report
confirmed payments recorded before funding accounts were captured, which therefore cannot be
attributed to any account and are excluded from the balances. When the total is non-zero the API
sets `coverageIncomplete` and returns a prose `coverageNote`, and the UI renders it as a warning
above the cards and again in the metadata block.

## Money Position

Shown: **Outstanding to Collect**, **Outstanding to Pay**, **Overdue Receivables**, **Overdue
Payables**, with the receivable and payable transaction counts.

These are the Unified Payment Position calculations, not a second payable/receivable ledger.
`PaymentPositionService.summary()` is called twice — once with `direction: 'receivable'` and once
with `direction: 'payable'` — because its totals are computed across whatever is filtered, and "to
collect" and "to pay" are two different filters rather than two halves of one number.

Collect and Pay are shown as separate positive amounts and are never netted. A Company owed 10,000
and owing 10,000 is not in a zero position, and any UI that lets those cancel is lying about the
position.

Drill-down: each card links to the Unified Payment Position screen carrying `direction`, the date
range, Party Type and Party, and `overdueOnly=true` on the two overdue cards. `accountId` is
deliberately dropped from those links rather than sent to be ignored, because that screen has no
account filter.

## Income and Expense

Shown separately: **Revenue**, **Expenses**, **Net Income**.

These come from `AccountingReportService.report("profit-and-loss")` and are recognised amounts from
**posted Journals**, selected by **accounting date** (`business_date`) within the filtered range.
The response metadata records this as `incomeBasis: "posted_journals_by_accounting_date"`.

Two statements the screen makes explicitly, in both languages:

- **Collections are not Revenue.** Receiving cash against an existing receivable moves a balance;
  it does not recognise income.
- **Payments are not Expenses.** Settling a payable moves a balance; the expense was recognised
  when it was incurred.

The three figures are never merged into one, and the section is visually and structurally separate
from Money Position so the two are not read as the same money.

Drill-down: each card links to `/accounting/reports/profit-and-loss`, carrying the date range.

## Accounting Health

Six counts, each with a status badge and a direct link to the screen that resolves it:

| Count | Meaning | Link |
| --- | --- | --- |
| Failed Accounting Events | `failed`, `blocked_configuration` | `/accounting/events` |
| Waiting Accounting Events | `received`, `processing`, `validated`, `retry_pending` | `/accounting/events` |
| Unposted Journals | not `posted`, `reversed` or `cancelled` | `/accounting/journals` |
| Unreconciled Cash/Bank Items | confirmed Movements with no posted Event | `/accounting/reconciliation` |
| Open Accounting Periods | status other than `closed` | `/accounting/fiscal-periods` |
| Closing Workflows Requiring Attention | `blocked`, `changes_requested`, or past due | `/accounting/closing-workflows` |

Each vocabulary above is the current one from the live CHECK constraints, not an older subset — an
Event stuck in `processing`, `retry_pending` or `blocked_configuration` is counted rather than
silently invisible.

"Requiring attention" is deliberately narrower than "active": a workflow progressing normally is
not a health problem, so only stalled, sent-back or overdue workflows are counted.

Badge colour distinguishes a problem from a fact. Zero reads as healthy; Open Periods and Waiting
Events read as neutral when non-zero, because both are normal during a live month; the rest read as
warnings. Badging an open period the same as a failed Event would train users to ignore the ones
that matter.

A count nobody can act on is not a control, which is why every one of them links out.

## Recent Activity

A single server-returned list across nine supported source types: Driver Collection, Trader
Settlement, Payroll Payment, Outsourced Driver Fee Payment, Expense Payment, Cash/Bank Movement,
Journal, Accounting Event, and Closing Workflow.

Fields per row: source type, source reference, party, amount, status, date, recorded time, source
link, Accounting Event link, Journal link. The table scrolls horizontally within its own container
so the page body never scrolls sideways.

**Links appear only when the backend returns a valid identifier or route.** The source link is used
only where the API supplied a `route`; the Event and Journal links only where those ids are
present. Everything else renders as an em dash. No URL is constructed by guessing an id into a path
— a link that cannot be proven to resolve is absent rather than navigating to a blank screen.

Two behaviours worth knowing:

- Rows are ordered by recorded time, limited to ten per source before the union and forty after it.
  The list is a recency window, not a complete ledger.
- Journal, Accounting Event and Closing Workflow rows carry no party. When a Party Type filter is
  applied they are therefore excluded, because they cannot satisfy it.

## Metadata

The response and the screen both carry:

- **applied filters** — echoed back by the API, and resolved to account and party names by the UI
  where those are known;
- **Company timezone** — from `company_settings`;
- **generated timestamp**;
- **balance basis** — `opening_balances_movements_and_confirmed_payments`;
- **movement scope** — `cash_bank_movements_only`, with the prose note;
- **coverage note** — the excluded-payments statement, or an explicit confirmation that every
  confirmed payment is attributed to a funding account.

Everything in this block is the backend's own answer about what it produced and what it could not
cover. The UI summarises none of it away.

## Localization and layout

Full EN and AR key sets. RTL is inherited from the application shell. Amounts, dates, timestamps,
references, ids, the timezone and the basis strings are wrapped in `<bdi dir="ltr">`, because a
digit group read right-to-left is a different number.

KPI cards use the existing `accounting-summary-cards` auto-fit grid, which gives four, two and one
column across desktop, tablet and narrow widths from one rule. The activity and coverage tables use
the shared horizontal-scroll container. Loading, empty and error states come from the shared
`LoadPanel` plus a per-table empty row. Only existing CSS classes are used; none were invented and
no stylesheet was changed.

## Known limitations

Interface and data:

- **No export.** There is no CSV, XLSX or PDF for the dashboard.
- **No browser validation.** No screen in this feature has been opened in a browser.
- **No focused Dashboard tests** exist, backend or frontend.
- **Period Movement Activity is not a full balance delta.** It covers Cash/Bank Movements only, and
  no as-at-date balance exists to make it one.
- **Option-loading failures do not fail the page.** If the account or party option lists cannot be
  loaded, the dashboard still renders with its data and those dropdowns are simply empty. A missing
  dropdown is a lesser fault than an error screen over data that loaded correctly.
- **The Party selector depends on Payment Position summary results.** There is no shared party
  lookup across all four party types, so the options are the parties that currently hold a
  position. A party with no open position does not appear, and the list is capped at that
  endpoint's page size.
- **Recent Activity is limited to the supported source types** listed above, and to the per-source
  and overall row limits. It is not a complete audit trail.
- **Missing Event and Journal links are shown as unavailable, never fabricated.**
- **The Dashboard frontend performs no financial calculation.** The only numbers it produces are
  counts of rendered elements.
- **No production-readiness claim is made** for this feature.

Structural:

- `general_expense_payments` has no `accounting_event_id` column, so Expense Payment rows carry no
  Event link. This is a schema fact, not an omission in the query.
- Current balances ignore the date range by design, as described under Filters.

## Verification status

Stated exactly, with no broader claim:

- **API typecheck passed** for Prompt 8A.
- **Web typecheck passed** for Prompt 8B.
- **No tests** were written or run for this feature.
- **No browser validation** was performed.
- **No build** was run.
- **No migration** was created or executed.
- **No database verification** was performed.
- **No production-readiness claim** is made.

Raw-SQL identifiers used by the dashboard service were verified against the migration definitions
rather than assumed: the `closing_workflows` status vocabulary, `accounting_events.processing_status`,
`journal_entries.status`, and the amount, number and date columns on all nine activity sources.
That is a source-reading check, not a runtime one.

## Prompt 8 closure report

1. **Backend API** — one read-only endpoint, `GET /operations/reports/accounting-dashboard`, with a
   DTO, a service and a controller registered in the Accounting module. It composes existing
   authoritative services and adds no financial formula except the movement figure described above.
2. **Frontend Dashboard** — `AccountingDashboardPage.tsx`, a read-only screen rendering all five
   sections, the filter bar, and the metadata block, with loading, empty and error states.
3. **Overview preservation** — Overview is untouched. No Overview file was edited, its route and
   menu entry are unchanged, and it remains the default screen at `/accounting`.
4. **Filters and URL state** — five filters, URL-backed, server-side only, validated at the API
   boundary; the filter-to-section matrix above records exactly what each one reaches.
5. **Dashboard sections** — Cash and Bank, Money Position, Income and Expense, Accounting Health,
   and Recent Activity, each sourced as documented in its own section.
6. **Drill-down links** — Money Position to the Unified Payment Position with direction, date range
   and party carried forward; Income and Expense to Profit and Loss with the date range; all six
   Health counts to their resolving screens; Recent Activity to the source, Event and Journal only
   where the backend supplied a route or an id.
7. **Metadata and limitations** — applied filters, timezone, generated timestamp, balance basis,
   movement scope with its prose note, and the coverage note, all surfaced from backend metadata
   rather than summarised away.
8. **Typecheck status** — API typecheck passed for 8A; Web typecheck passed for 8B.
9. **Untested areas** — everything. No focused tests exist for the endpoint or the page, no browser
   validation was performed, and no runtime query verification was run. The filter matrix, the
   movement leg treatment, the health vocabularies and the activity limits are argued from the code
   and the migrations, not demonstrated.
10. **Documentation files changed** — `Documentation/Accounting/ACCOUNTING_DASHBOARD.md` only.
11. **Final status** — `PROMPT_8_IMPLEMENTATION_COMPLETE_TESTING_DEFERRED`.

## Deferred

Dashboard exports, saved or default filter presets, per-account drill-down from the Cash and Bank
cards, an as-at-date balance and the true period balance delta it would enable, trend or
comparative periods, scheduled delivery, and any additional Recent Activity source type are outside
Accounting Prompt 8.

## Final status

`PROMPT_8_IMPLEMENTATION_COMPLETE_TESTING_DEFERRED`

No code, localization, stylesheet, migration, configuration or database change was made in this
documentation phase, and no tests, typecheck, lint, build, browser testing, database verification
or commit was performed for it.
