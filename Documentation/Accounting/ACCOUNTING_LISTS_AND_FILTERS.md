# Accounting Lists, Filtering, Sorting and Pagination

Phase 5A. **Source-level implementation only.** No runtime validation, no
browser testing, no live database inspection, no migration executed, no
financial data modified. Production readiness is not claimed.

This phase is **partial**. It delivers the shared sorting contract and closes a
pagination-correctness defect; it does not deliver the full per-list column,
filter and URL-state programme in the brief. §5 records exactly what remains.

---

## 1. Audit — what already existed

The brief lists problems as if none of this were built. Most of it was.

| List | Server-side filters | Pagination + total | Server-side sort | Deterministic order |
| --- | --- | --- | --- | --- |
| Manual Journals | ✅ 20 filters | ✅ | **added here** | ✅ (Phase 1) |
| Opening Balances | ✅ 14 filters | ✅ | **added here** | **fixed here** |
| Accounting Events | ✅ 5 filters | ✅ | **added here** | ✅ |
| General Expenses | ✅ | ✅ | ✅ already | ✅ |
| Expense Payments | ✅ | ✅ | ✅ already | ✅ |
| Cash/Bank Movements | ✅ | ✅ | ✅ already | ✅ |
| Driver Collections | ✅ | ✅ | ✅ already | ✅ |
| Trader Settlements | ✅ | ✅ | ✅ already | ✅ |
| Trader Receivables | ✅ | ✅ | ✅ already | ✅ |
| Trader Collections | ✅ | ✅ | ✅ already | ✅ |
| Payroll Periods / Payments | ✅ | ✅ | ❌ | not audited in depth |
| Fee accruals / payments | ✅ | ✅ | ❌ | not audited in depth |
| Chart of Accounts, Fiscal Years/Periods, Mappings, Cash/Bank Accounts | ✅ | bounded, unpaginated | ❌ | ✅ |

Configuration lists are deliberately unpaginated: their row counts are bounded
by the Company's own setup (accounts, periods, mappings), not by transaction
volume, so paginating them would add controls without solving a problem.

### 1.1 Defect found and fixed

**Opening Balances pagination could repeat or omit rows.** The list ordered by

```sql
order by b.effective_date desc, b.batch_number desc
```

Two problems:

1. `batch_number desc` is **lexical**. `BAL-000010` sorts before `BAL-000009`
   as soon as the sequence outgrows its zero-padding width.
2. There is **no final tiebreaker**. When two batches share an effective date
   and the numbers tie in the collation, PostgreSQL may return them in a
   different order per query — and offset pagination then shows a row twice or
   skips it entirely.

Now:

```sql
order by <requested sort> <direction> nulls last,
         b.effective_date desc,
         nullif(regexp_replace(b.batch_number,'[^0-9]','','g'),'')::bigint desc nulls last,
         b.id desc
```

---

## 2. Shared sorting contract

`AccountingOperationSupport.sorting(query, allowed, fallback)`:

- The client sends a **business key** (`journalDate`, `totalDebit`), never a
  column name.
- The key is looked up in an **allowlist the query owns**. Nothing from the
  request reaches the SQL fragment — the interpolated value is always a literal
  from the caller's own map, which is what makes `sql.raw` safe here.
- An unrecognised key falls back to the list default rather than erroring, so a
  stale bookmark degrades instead of breaking.
- Direction is `asc` only when explicitly requested; otherwise `desc`.
- The resolved `sortBy` / `sortDirection` are echoed in the response.

`numericReferenceOrder(column)` orders a business reference by its **numeric**
sequence:

```sql
nullif(regexp_replace(<column>, '[^0-9]', '', 'g'), '')::bigint
```

`[^0-9]` rather than `\D` — inside a JS template literal the backslash escape
collapses to a literal `D` and would strip the letter D out of the reference.

### 2.1 Allowlisted sort keys

| List | Keys | Default |
| --- | --- | --- |
| Manual Journals | businessDate, createdAt, description, journalNumber, status, totalCredit, totalDebit | businessDate desc |
| Opening Balances | batchNumber, effectiveDate, status, totalCredit, totalDebit | effectiveDate desc |
| Accounting Events | accountingDate, amount, attemptCount, createdAt, eventType, journalNumber, sourceReference, status | createdAt desc |

Validated twice: `@IsIn` on the DTO rejects unknown values at the HTTP
boundary, and the query layer's allowlist is the final authority.

### 2.2 Deterministic tail

Every one of the three ends in a unique column so offset pagination is stable:

- Journals: requested → `business_date desc` → numeric journal number → `created_at desc` → `j.id desc`
- Opening Balances: requested → `effective_date desc` → numeric batch number → `b.id desc`
- Events: requested → `created_at desc` → `e.id desc`

---

## 3. Pagination contract

Unchanged and already correct: `page`, `pageSize` (clamped 1–200, default 50),
`total`, `totalPages`, plus `sortBy` and `sortDirection` added by this phase.
Counts come from `count(*) over()` in the same query under the same filters, so
the total always matches the filtered set.

---

## 4. Company isolation and validation

Every list query already carries `company_id` in its WHERE clause and in every
JOIN condition, taken from authenticated context and never from request input.
Filters are validated by `class-validator` DTOs (`@IsUUID`, `@IsIn`,
`@Matches(datePattern)`, `@IsInt`, `@Min`, `@Max`) behind a global
`ValidationPipe` with `whitelist` and `forbidNonWhitelisted`, so an unknown
query parameter is rejected rather than ignored.

No query in this phase adds a join, a request, or a row scan.

---

## 4a. Phase 5A-1 — visible frontend integration

Delivered for **Manual Journals, Opening Balances and Accounting Events** only.

### URL is the single source of truth

`use-list-state.ts` keeps page, page size, sort and every filter in the query
string. That is what makes the browser do the work: Back and Forward restore a
list exactly, a refresh keeps it, and the address bar is a shareable
description of the view. **No parallel `sessionStorage` copy exists** for these
three, so there is nothing to drift out of step.

| Parameter | Meaning | Omitted when |
| --- | --- | --- |
| `page` | 1-based page | page 1 |
| `pageSize` | 25 / 50 / 100 | 25 |
| `sort` | allowlisted business key | screen default |
| `direction` | `asc` / `desc` | screen default |
| `dateFrom`, `dateTo` | date-only `YYYY-MM-DD` | empty |
| `journalNumber` / `batchNumber` / `sourceReference` | reference search | empty |
| `status`, `journalSource`, `fiscalYearId`, `eventType`, `area` | screen filters | empty |

Every value is validated on read: a bad `page`, an unknown `pageSize`, or a
hand-edited `sort` falls back to the screen default rather than throwing or
sending a request the DTO would reject. Nothing sensitive is placed in the URL.

### Sorting

`SortableHeader` renders a real `<button>` inside the `<th>`, so headers are
keyboard-operable with no extra key handling, and `aria-label` announces the
current direction. Clicks cycle **preferred → opposite → screen default**.

Sort keys come from a per-screen `sortKeys` map that **mirrors the server
allowlist exactly**; a column absent from it stays a plain header, so the UI
can never request a sort the DTO would reject. All sorting is server-side.

| List | Sortable columns | Default |
| --- | --- | --- |
| Manual Journals | Journal Number (numeric), Journal Date, Description, Total Debit, Total Credit, Status | Journal Date desc |
| Opening Balances | Reference (numeric), Effective Date, Status, Total Debit, Total Credit | Effective Date desc |
| Accounting Events | Event, Source Reference, Amount, Accounting Date, Status, Attempts, Journal Number (numeric) | Received desc |

### Pagination

`AccountingPagination` shows *Showing 26–50 of 437 records*, a 25/50/100 size
selector, and Previous/Next disabled at the ends. **The total is the server's
`total`** — never derived from the loaded page. A stale URL pointing past the
end is clamped back to the last real page by an effect.

### Filter behaviour

Filter changes reset to page 1; `Clear Filters` drops the filters and the page
but **keeps the sort the User chose**; an active-filter count is shown whenever
any filter applies. Empty filters are omitted from the request entirely, so the
backend never has to distinguish `""` from absent. `From`/`To` constrain each
other through the native `min`/`max` attributes rather than a second validation
path.

### Defect fixed: the search box was producing a 400

The list previously sent `search=<text>` as a query parameter. **None of these
three DTOs declares `search`**, and the API runs with
`forbidNonWhitelisted: true` — so the request was rejected the moment anyone
typed in the box. It was only invisible because an empty value is stripped
before the request is built. The box now maps to each screen's real reference
filter (`journalNumber`, `batchNumber`, `sourceReference`).

### Company switch

Changing Company clears the query string with a **replace**, not a push, so the
previous Company's filtered URL is not left in history for Back to return to.

### Request-loop safety

Two loops were identified and closed during implementation: a fresh `[]`
literal for `filterKeys` would have changed the memo dependency on every
render, and the page-clamp effect originally depended on the whole controls
object, whose identity changes on every state write. The effect now depends on
primitives, and the fallback array is a module constant. One list-state change
produces exactly one request.

### Not covered by 5A-1

Column sets are unchanged — this phase added sorting, pagination, filter state
and URL state to the **existing** columns; it did not add the new columns
listed in §§5–7 of the brief (Difference, Created By, Fiscal Year, Currency,
Journal-present filters, Balanced/Unbalanced, Account and Created By filters,
or the Event quick-filter chips). Those need new backend filter fields.

## 5. Not delivered in Phase 5A

Stated plainly so the gap is not mistaken for completion:

1. **No frontend work at all.** No sortable headers, no shared filter
   component, no pagination footer showing "Showing 26–50 of 437", no
   `Clear Filters`, no active-filter count. The sorting contract is available
   over HTTP but no screen sends `sortBy` yet.
2. **No URL query-state preservation** (§6). List state still lives in
   component state and the existing `sessionStorage` filter persistence on the
   Payments and Movements screens. Detail navigation preserves the list because
   the list stays mounted (Phase 3B), but a refresh does not restore filters.
3. **No per-list column or filter additions** from §§8–19. The existing
   columns and filters stand.
4. **Payroll and Outsourced Driver Fee lists were not given sorting**, and
   their ordering determinism was not audited in depth.
5. **No localization keys added** — none were needed, because no new UI was
   built.
6. **Selection semantics unchanged** (§21). The Accounting Events list has
   checkbox selection scoped to the current page; it is not labelled
   "Select All Matching" and no batch framework was added.

---

## 6. Pre-existing N+1

`general-expense-query.service.ts` `detail()` calls `resolveMappingAccount`
inside `lines.rows.map(async …)` — one account-resolution query per Expense
line. Reported in Phases 4 and 5A; not changed, as it is on a detail screen
rather than a list.
