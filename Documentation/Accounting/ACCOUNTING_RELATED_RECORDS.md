# Accounting Related Records

Phase 3A — global Related Records integration across Accounting and Operations.
Phase 3B — canonical operational detail routes and bidirectional navigation.
Phase 3C/3D — clickable business references inside operational detail content (partial).

This document describes the reusable Related Records framework: what it links,
how a link is decided, what it shows when a relationship does not exist, and
which relationships deliberately have **no** link.

---

## 1. What it is

A single presentation component plus two data paths:

| Piece | File | Role |
| --- | --- | --- |
| `RelatedRecords` | `apps/web/src/features/accounting/RelatedRecords.tsx` | Renders a labelled list of business references. Links only what may be opened; shows an explicit empty state otherwise. |
| `accounting-related.ts` | `apps/web/src/features/accounting/accounting-related.ts` | Builds the record list from a **detail response already on screen**. No extra request. |
| `AccountingRelatedPanel` | `apps/web/src/features/accounting/AccountingRelatedPanel.tsx` | For **operational** screens that hold no Accounting data. Fetches from one bounded endpoint. |
| `accounting-routes.ts` | `apps/web/src/features/accounting/accounting-routes.ts` | The **verified** route map. Nothing here is inferred. |
| `SessionAccessContext` | `apps/web/src/app/SessionAccessContext.tsx` | Publishes Company, permissions and the navigator so nested dialogs need no prop threading. |

---

## 2. Route map (verified, not guessed)

Every route below was confirmed against the live route tables in
`CompanyWorkspace.tsx` and `parseAccountingRoute` in `AccountingWorkspace.tsx`.

| Record type | Route | Route consumes |
| --- | --- | --- |
| Journal | `/accounting/journals/:id` | id |
| Accounting Event | `/accounting/events/:id` | id |
| General Expense | `/accounting/expenses/:id` | id |
| Expense Payment | `/accounting/expense-payments/:id` | id |
| Cash/Bank Movement | `/accounting/cash-bank-movements/:id` | id |
| Opening Balance | `/accounting/opening-balances/:id` | id |
| Cash Account | `/accounting/cash-accounts/:id` | id |
| Bank Account | `/accounting/bank-accounts/:id` | id |
| Order | `/orders/:orderNumber` | **Order Number**, not id |
| Trader | `/configuration/traders/:code` | **Code** |
| Driver | `/configuration/drivers/:code` | **Code** |
| Employee | `/configuration/employees/:code` | **Code** |

### 2.1 Phase 3B — canonical operational detail routes

Phase 3A found that `/trader-settlements`, `/trader-receivables`,
`/cash-management`, `/payroll` and `/drivers` were **exact-match** routes, so
eight record types had no address to link to. Phase 3B added one canonical
route each:

| Record type | Canonical route | Identifier | Component |
| --- | --- | --- | --- |
| Driver Collection | `/drivers/collections/:id` | internal id | `DriverCollectionDetailDialog` |
| Trader Settlement | `/trader-settlements/:id` | internal id | `SettlementDetailDialog` |
| Trader Receivable | `/trader-receivables/:id` | internal id | `ReceivableDetailDialog` |
| Trader Collection | `/trader-receivables/collections/:id` | internal id | `CollectionDetailDialog` |
| Payroll Period | `/payroll/periods/:id` | internal id | Payroll period panel |
| Payroll Payment | `/payroll/payments/:id` | internal id | `PaymentDetailDialog` |
| Outsourced Driver Fee accrual | `/payroll/driver-fees/accruals/:id` | internal id | `AccrualDetailDialog` |
| Outsourced Driver Fee payment | `/payroll/driver-fees/payments/:id` | internal id | `PaymentDetailDialog` (fees) |

`unroutableRecordTypes` is now **empty**. It and the fallback that reads it are
kept deliberately: a future record type without a detail screen belongs there
rather than getting an invented URL.

### 2.2 Why internal identifiers, not business references

The route standard prefers a business reference (`SET-000012`). Every one of
these routes uses the record's **internal identifier** instead, because **every
corresponding backend detail endpoint is keyed by it and no by-reference lookup
exists**:

```
GET operations/cash/reconciliations/:reconciliationId
GET operations/settlements/payments/:settlementId
GET operations/trader-receivables/receivables/:receivableId
GET operations/trader-receivables/collections/:collectionId
GET operations/payroll/periods/:periodId
GET operations/payroll/payments/:paymentId
GET operations/payroll/outsourced-driver-fees/accruals/:accrualId
GET operations/payroll/outsourced-driver-fees/payments/:paymentId
```

Adding by-reference lookup would mean eight new backend endpoints and eight new
Company-scoped uniqueness guarantees — new backend surface this phase was not
scoped to build. The consequence is contained and matches the rest of the
application (`/accounting/journals/:id` has always worked this way):

- the identifier appears **only in the URL**, never in page content;
- every page shows the business reference (`SET-000012`) as its heading;
- the URL is still stable, shareable and refresh-safe.

Moving to business references later is a route-map change in
`accounting-routes.ts` plus the eight lookup endpoints — no caller changes.

### 2.3 Route-to-component mapping and dialog reuse

There is **one** detail implementation per record type. Each workspace already
owned a detail dialog; Phase 3B made that dialog addressable rather than
building a second page:

- `useRouteDetail` (`apps/web/src/app/use-route-detail.ts`) drives the state the
  workspace already had. Clicking a row **navigates** to the canonical route;
  the route seeds the state; the same dialog opens.
- The list stays mounted underneath, so its filters, sorting and page survive
  and closing returns to exactly the list the User left.
- A directly opened or refreshed URL lands on the same screen through the same
  path — there is no second code path to drift.

Payroll and Outsourced Driver Fees use a `dialog` discriminated union rather
than a plain id, so they seed that union from the route in an effect; the
principle is identical.

---

## 3. How a link is decided

`link()` in `accounting-related.ts` applies three tests in order:

1. **Does the record exist?** No reference → render the empty state, no link.
2. **Does a verified route exist?** `recordRoute()` returns `undefined` when the
   identifier the route consumes is missing → show the reference, no link.
3. **May this User open that route?** `canAccessCompanyPath()` — the same gate
   the shell uses for its menu and route guards. Denied → show the reference,
   disable the link, display *"You do not have permission to open this record"*.

The backend remains the authority. This check only avoids offering a door that
will not open; every request is still permission-checked and Company-scoped
server-side.

---

## 4. Empty states

A relationship that does not exist is never a blank cell.

| Situation | Shown |
| --- | --- |
| Relationship not applicable to this record | Not Applicable |
| Record type exists but nothing recorded | Not Created |
| Accounting has not produced a Journal yet | Journal Not Created |
| Event exists, not yet processed | Awaiting Accounting, or the Event's own status |
| Expense with no Payments | No Payments Recorded |
| A single Payment not recorded | Payment Not Recorded |
| Record not reversed | Not Reversed |
| Data unavailable | Not Available |

Keys live under `accounting.related.*` in both `en.ts` and `ar.ts`, at exact
parity (89 keys each after Phase 3B).

---

## 5. Loading and failure

`AccountingRelatedPanel` renders its own states and never propagates a failure:

- Loading → *"Loading related records…"*
- Request failed → *"Related records could not be loaded."*
- User has no Accounting access → the panel renders **nothing** (`null`), so an
  operations-only User sees no permanent error banner.

The Accounting screens do not need this: their Related Records are built from
the detail response the screen already loaded, inside the existing `LoadPanel`.

---

## 6. Backend enrichment

All additive. No existing field changed shape.

| Service | Added |
| --- | --- |
| `manual-journal.service.ts` `detail()` | `originalJournalId`, `reversalJournalId`, `accountingEventId`, `accountingEventType`, `eventSourceEntityType`, `eventSourceEntityId`, `eventSourceReference` (one LEFT JOIN to `accounting_events`) |
| `accounting-event-query.service.ts` `detail()` | camelCase `journalId`, `reversalJournalId`, `sourceEntityType`, `sourceEntityId`, `sourceReference`, plus `originalEventId` / `originalEventReference` / `originalEventType` (one LEFT JOIN to the reversed Event) |
| `general-expense-query.service.ts` `detail()` | The `events` sub-query now returns `journalNumber`, `reversalJournalNumber`, `sourceEntityType`, `sourceEntityId`, `sourceReference` via two LEFT JOINs |
| `cash-bank-query.service.ts` `detail()` | `movementNumber`, `accountingEventId`, `accountingEventType`, `reversedByMovementId`, `reversalOfMovementId` |

### 6.1 New endpoint

```
GET operations/accounting/related/:sourceEntityType/:sourceEntityId
```

Requires `accounting.view` or `users_roles.manage`. Returns every Accounting
Event raised from one operational record, with both Journal numbers resolved
inline.

- **Company-scoped**: `company_id` appears in the WHERE clause and in every
  JOIN condition.
- **No N+1**: one query, both Journal joins inline. A screen showing the panel
  makes exactly one extra request regardless of how many Events exist.
- **Bounded**: `limit 50`.
- **Closed source-type set**: `relatedSourceTypes` in
  `accounting-integration.controller.ts`. An unknown type is a 400, not an
  empty list that would read as "nothing was posted".

---

## 7. Coverage

### Accounting screens (data already on the detail response — zero extra requests)

| Screen | Related records shown |
| --- | --- |
| Journal | Source operational record, source Accounting Event, Original Journal, Reversal Journal |
| Accounting Event | Source operational record, Journal, Reversal Journal, Original Event |
| General Expense | Recognition Journal, Reversal Journal, every Expense Payment |
| Expense Payment | General Expense, Accounting Event, Payment Journal |
| Cash/Bank Movement | Source Account, Destination Account, Accounting Event, Journal, Reversal Journal, Reverses / Reversed By |
| Opening Balance | Journal, Reversal Journal |

### Operational screens (one bounded request via `AccountingRelatedPanel`)

| Screen | Source type |
| --- | --- |
| Order detail | `order` |
| Trader Settlement detail dialog | `trader_settlement` |
| Trader Receivable detail dialog | `trader_receivable` |
| Trader Collection detail dialog | `trader_collection` |
| Driver Collection detail dialog | `driver_reconciliation` |
| Payroll — selected Period | `payroll_period` |
| Payroll Payment detail dialog | `payroll_payment` |
| Outsourced Driver Fee accrual dialog | `outsourced_driver_fee_accrual` |
| Outsourced Driver Fee payment dialog | `outsourced_driver_fee_payment` |

---

## 8. Business references only

No screen renders an identifier. `accounting_events.source_reference` already
carries the business reference the capture trigger recorded (Order Number,
Settlement Number, Receivable Number, Period Reference), so the operational
source needs no lookup to display. Identifiers are used **only** to build a
route, never as display text. A record whose business reference cannot be
resolved degrades to its empty state rather than to a UUID.

---

## 9. Navigation context and Company switching

`SessionAccessContext` carries only the Company identifier, the permission list
the shell already uses, and the navigator. **No session secret, no record data
and nothing sensitive is placed in `localStorage` or `sessionStorage` by this
feature.**

Every Related Records query is keyed on `companyId` through
`accountingQueryKey`, and `AccountingWorkspace` is keyed on `companyId` at the
React level, so switching Company discards the previous Company's cached
records rather than leaving them on screen.

---

## 10. Direct refresh, permissions and Company isolation

**Direct refresh and new-tab open** are supported at source level. The router is
a single catch-all (`path: "*"`), so any URL renders `App`, and
`CompanyWorkspace` resolves the path on every render — a refresh follows the
same branch as the original navigation. `detailSegment()` accepts only a single
non-empty segment after the prefix, so `/trader-receivables/collections/<id>`
can never be read as a Receivable, and a trailing slash resolves to the list.

**Login redirect preservation.** `App` already captured the requested path at
mount (`safeRequestedPath`) but discarded it on sign-in. It is now honoured:
after authenticating, a company user lands on the URL they asked for when
`canAccessCompanyPath` allows it, otherwise on their default workspace. Nothing
is written to browser storage and no new login flow was introduced.

**Permissions.** No permission or role grant was added. `canAccessCompanyPath`
resolves `/trader-settlements/<id>` through its `/trader-settlements` prefix, so
a detail route requires exactly what its list requires. The backend remains
authoritative on every request; the frontend check only avoids offering a door
that will not open.

**Company isolation.** Every detail endpoint these routes call already scopes by
the authenticated Company. The Company is never taken from the URL, and no
cross-Company lookup endpoint was created. A record belonging to another Company
fails closed with the existing not-found response, which does not reveal whether
the reference exists elsewhere.

## 10a. Phase 3C — references inside operational detail content

`OperationalReference` (`apps/web/src/features/operations/OperationalReference.tsx`)
renders a business reference as a link when — and only when — a verified route
exists in `accounting-routes.ts` **and** `canAccessCompanyPath` allows it.
Routing knowledge stays in the one central map; no dialog writes a URL. A
reference whose route or permission is missing degrades to plain text (or to a
non-interactive span with the permission reason), never to a dead link.

`partyDisplayLabel` renders `Code — Name`, Code first so it stays LTR-readable
inside an RTL page, Arabic name preferred in Arabic mode.

### Backend additions (all additive; no contract changed)

| Service | Added | Why |
| --- | --- | --- |
| `driver-cash-reconciliation.service.ts` | `orderNumber`, `traderCode` per Order row; `driverCode`, `driverNameAr` on the header | The Order route takes the Order NUMBER, not the Serial Number the User reads; the Trader and Driver routes take a CODE |
| `trader-settlement.service.ts` | `orderNumber` per allocated Order row | Same reason |

### Wired so far

| Screen | Now clickable |
| --- | --- |
| Driver Collection detail | Driver (`Code — Name`), each Order in the selected-Orders table, each Trader in that table |
| Trader Settlement detail | Each Order in the allocated-Orders table |

Also on Driver Collection: **Gross Customer Collections** is now displayed. The
backend already computed `summary.grossCollections` but no screen rendered it.

### Phase 3D additions

| Screen | Backend added | Frontend |
| --- | --- | --- |
| Trader Receivable | `traderCode`, `traderNameAr`; per-collection `paymentMethod` and `remainingBalance` | Trader renders `Code — Name` and opens the Trader; Collections table gained Payment Method and Remaining Balance columns and each Collection Number opens its record |
| Trader Collection | `traderCode`, `traderNameAr`; `receivableId` per allocation | Trader clickable; each settled Receivable Number opens its record |
| Outsourced Driver Fee accrual | none needed — `driverCode` already returned | Driver renders `Code — Name` and is clickable; Order clickable |
| Outsourced Driver Fee payment | none needed | Order clickable in the allocations table |

`remainingBalance` is computed with a **window function** over the allocation
history (`sum(...) over (order by ... rows between unbounded preceding and
current row)`), so the whole running balance costs one pass and no per-row
query.

**Payroll Period and Payroll Payment were not changed in Phase 3D.**

### Not done in Phase 3C

The per-screen field completions in §§4–11 of the Phase 3C brief were **not**
implemented beyond the above. See the phase report for the field-by-field gap
analysis; in summary, the existing dialogs already render most of the required
content (the Settlement allocated-Orders table already carries Original Due,
Previously Settled, Current Allocation and Remaining After Settlement; the
Receivable detail already carries Original, Collected and Outstanding with its
collection history), and the genuine remaining gaps are Payroll Period
employee-level totals, Trader Collection settled-Receivable rows, and Fee
accrual/payment cross-links.

## 10b. Payroll Period and Payroll Payment detail (Phases 3D-2 / 3D-2A)

**Source-level implementation only.** No runtime validation, no browser
testing, no database verification, no financial data changed. Production
readiness is not claimed.

### Payroll Period detail — `/payroll/periods/:id`

Ten summary values, **all stored Period aggregates** on `payroll_periods`:
Employee Count, Basic Salary, Allowances, Commissions, Adjustments, Gross,
Deductions, Net, Paid, Outstanding. Nothing is summed in the browser — the
backend owns Payroll arithmetic, and re-adding formatted strings on screen
would create a second, divergent source of truth.

### Employee lines

All from `payroll_entries` snapshots, so a later master-data edit cannot
retroactively change a posted Period: Employee Number, Name, Arabic Name,
Department, Employment Type, Basic Salary, Allowances, Commissions,
Adjustments, Deductions, Gross, Net, Paid, Outstanding, Status. The Salary
Version identifier is never rendered.

### Payroll Payment detail — `/payroll/payments/:id`

Header and summary: Payment Number, Status, Payroll Period, Payment Date,
Payment Method, Payment Amount, Created By, Created At, plus **Total Applied**,
**Unapplied Amount**, **Number of Employees Paid** and **Remaining Payroll
Outstanding**. Unapplied is `total_amount − sum(allocations)`, clamped at zero
**server-side** because over-allocation is prevented upstream and a negative
value would only ever be a rounding artefact.

Employee payment lines: Employee Number — Name, Payroll Net, **Previously
Paid**, **Amount Paid in This Payment**, **Remaining Payroll Balance**, Status.
Previously Paid and Remaining Balance are computed by correlated subqueries
over `payroll_payment_allocations` in authoritative `allocation_order` — one
query, never one per Employee.

### Cash-only behaviour, and the absent Cash Account

Employee Payroll payments are **Cash-only**: `payroll_payments.payment_method`
defaults to `cash`. No Visa, bank-transfer or employee bank-account field was
added.

`payroll_payments` stores a **`cash_voucher_reference` text field only — there
is no cash-account foreign key**. A "Cash Account" is therefore **omitted
rather than invented**; the screen shows Payment Method and the Cash Voucher
Reference, which are the values that actually exist.

### Clickable references (Phase 3D-2A)

| Reference | Route | Identifier |
| --- | --- | --- |
| Payroll Period | `/payroll/periods/:id` | `periodId` |
| Original Payroll Payment | `/payroll/payments/:id` | `reversalOfPaymentId` |
| Reversal Payroll Payment | `/payroll/payments/:id` | `reversedByPaymentId` |
| Employee | `/configuration/employees/:code` | `employeeNumber` |

All go through `OperationalReference`, which resolves the path from the central
map and gates it with `canAccessCompanyPath`. Where a route or permission is
missing it renders plain text — it cannot produce a dead link. Identifiers
build routes only and are never displayed.

Unlike Trader Collections, **Payroll genuinely stores a separate reversal
Payment record** (`payroll_payments.reversal_of_payment_id`), so this
relationship is real rather than fabricated. Each row renders only when its
reference exists, so no empty card appears. The in-place reversal metadata
(Reversed At, Reversed By, Reversal Reason) is preserved unchanged.

### Event and Journal links

Not repeated in the detail list. The `AccountingRelatedPanel`
(`sourceType="payroll_period"` / `"payroll_payment"`) already owns the
Accounting Event, Journal and reversal Journal, and duplicating them would show
the same relationship twice.

### Company isolation

Every added column and join carries `company_id`, taken from authenticated
context and never from request input. The reversal joins and the allocation
subqueries are all Company-scoped.

### Known limitations

1. **No Cash Account** — no such column exists (above).
2. Payroll Period Employee lines show Number and Name as separate existing
   columns; they were not merged into one `Number — Name` cell.
3. Employee lines use the existing list pagination; no new bounding was added.


## 11. Known limitations (Phase 3B)

- Routes use internal identifiers (§2.2).
- A malformed multi-segment path under a module prefix renders that module's
  list rather than a 404.
- Closing a route-opened detail returns to its module list; returning to an
  originating Journal or Accounting Event relies on browser Back, since this
  repository has no router-state origin pattern to extend.
- Payroll Period is a selected-period panel inside the Payroll list, not a
  separate screen, so it has no dedicated Close control.
- Event → Reversal Event is still not linked: `accounting_events` stores only
  `reversal_of_event_id` (child → parent).

**This phase was implemented and verified at source level only.** No runtime,
browser, database or build validation was performed; no financial data was
changed; production readiness is not claimed.

## 12. Adding a new relationship

1. If the target has a detail screen, add it to `RoutableRecord` and to the
   `switch` in `recordRoute()` — **after confirming the route in the router**,
   not from the URL you expect it to have.
2. If it has no detail screen, add it to `unroutableRecordTypes` and use
   `reference()` instead of `link()`.
3. Add the label and empty-state keys to `accounting.related.*` in **both**
   `en.ts` and `ar.ts`.
4. If the source data is not already on the detail response, extend the
   existing query with a LEFT JOIN on the primary key **and** `company_id`.
   Do not add a second request.
