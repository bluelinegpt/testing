# Accounting UI Layout Standard

**Source-level visual implementation only.** No browser testing, no runtime
validation, no database verification. No business logic, API contract, route or
financial record was changed. **Production visual readiness is not claimed
until the screens listed in §12 have been reviewed manually in a browser.**

Everything below lives in one appended block at the end of
`apps/web/src/styles.css`, headed `ACCOUNTING UI LAYOUT STANDARD`.

---

## 1. Three rules the whole block follows

1. **Colours come from theme tokens**, never hardcoded — light and dark work
   from one rule set.
2. **Spacing uses logical properties** (`padding-inline`, `margin-block`,
   `border-inline-start`), so Arabic RTL mirrors with no second stylesheet —
   while codes, dates and amounts are pinned LTR where they must stay readable.
3. **Nothing changes behaviour.** Container, type and spacing only.

## 2. Spacing scale

One scale on `.accounting-page` / `.accounting-workspace`, so no screen invents
its own values:

```
--acc-space-1 .35rem · -2 .6rem · -3 1rem · -4 1.5rem · -5 2rem
--acc-radius .85rem
--acc-shadow 0 1px 2px rgb(16 25 54 / 6%)   /* restrained by design */
```

Financial density reads better with borders than with stacked shadows.

## 3. Typography hierarchy

| Element | Size | Weight |
| --- | --- | --- |
| Page title (`h1`) | 1.5rem (1.28rem narrow) | 650 |
| Section heading (`h2`/`h3`, panel headings) | 1.02rem | 620 |
| Field label (`dt`) | 0.82rem | 500, `--text-secondary` |
| Field value (`dd`) | 0.95rem | 550, `--text-primary` |
| Table header | 0.8rem | 600 |
| Table cell | 0.9rem | normal, `--text-primary` |
| Summary card value | 1.15rem | 640 |

One section-heading style covers Summary, Journal Lines, Related Records,
Source Transaction, Processing Timeline, Failure Details, Employee Lines,
Allocated Orders, Settled Receivables, Collections and Payments.

## 4. Contrast

Table cells, field values and summary values are `--text-primary`; labels are
`--text-secondary`. **No pale grey (`--text-muted`) on any value, table body
cell, form label or Related Record.** Dark mode overrides table headers, row
hover and the Technical Details surface to the dark subtle token.

## 5. Money and references

```css
direction: ltr; unicode-bidi: isolate; font-variant-numeric: tabular-nums;
```

`isolate`, deliberately **not** `bidi-override`: it keeps the value LTR inside
an RTL page without reversing any characters. Tabular figures make columns of
money line up on the decimal regardless of digit widths.

Money cells are right-aligned via `text-align: end` on `td.is-money`.
`AccountingTable` now tags those cells — a one-line **presentational** change
(`className={column.money === true ? "is-money" : undefined}`); no data,
formatting or behaviour was touched.

Business references (`JRN-000021`, `ORD-000017`) are LTR-isolated and
`white-space: nowrap` so they never break mid-reference.

## 6. Layout primitives

- **Page shell** — flex column, `gap: --acc-space-4`, `padding-inline: clamp(0.75rem, 2vw, 1.5rem)`. Content never touches the viewport edge.
- **Header** — `.page-heading` wraps; `.heading-actions` uses `margin-inline-start: auto` and wraps, so actions cannot escape the viewport.
- **Summary cards / detail grids / forms** — all `repeat(auto-fit, minmax(N, 1fr))`, giving 4 → 2 → 1 columns from a single rule with equal card heights per row.
- **Panels** — one surface: token background, 1px token border, `--acc-radius`, no competing shadow.
- **Tables** — token header background, `text-align: start` headers, row hover, `border-collapse`. `.table-scroll-x` / `.table-shell` get `overflow-x: auto` + `scrollbar-gutter: stable` so the scrollbar stays reachable.
- **Technical Details** — dashed border on the subtle surface, secondary-coloured summary, `overflow-wrap: anywhere` so long identifiers wrap rather than stretch the panel.

## 7. Responsive breakpoints

| Width | Behaviour |
| --- | --- |
| > 900px | 3–4 column detail grids, 4 summary cards where they fit |
| ≤ 900px | grids tighten to `minmax(11rem, …)` |
| ≤ 640px | **single column everywhere** — detail grids, forms, summary cards; header actions go full-width; action bars stack `flex-direction: column` so no button is clipped |

## 8. RTL

Every spacing and border property in the block is logical. Amounts, references
and codes are LTR-isolated. Nothing uses `left`/`right` physical properties.

## 9. Light and dark

All surfaces, borders and text use tokens. The **Phase 4 lifecycle chips and
banners were the one genuine defect found**: they hardcoded light-mode pastels
(`#dcfce7`, `#fee2e2`, `#fef3c7`, `#dbeafe`) and read as light pills stranded on
a dark page. They now use `--success-subtle` / `--danger-subtle` /
`--warning-subtle` / `--primary-subtle` pairs, with a dark-mode override using
`color-mix(in srgb, currentcolor 18%, transparent)`. The superseded hardcoded
rules were deleted.

## 10. Accessibility

- One `:focus-visible` ring (2px primary, 2px offset) across the module.
- Disabled controls: `opacity .55` **and** `cursor: not-allowed` — not colour alone.
- Sortable headers are real `<button>`s (Phase 5A-1) and keep the focus ring.
- Semantic table structure untouched.

## 11. Known limitations

1. **Sticky table headers and a sticky first reference column were not added.** Both need a defined scroll container height per table; applying them blind to every Accounting table risked clipping. Deferred.
2. **`.accounting-page label { display: flex; flex-direction: column }`** now applies module-wide. Screens that relied on an inline label layout will change shape — see §12.
3. Two hardcoded colours remain at `styles.css:4624/4629` in a **different, non-Accounting** class family. Left alone deliberately: out of scope.
4. The layout standard is appended last and wins on equal specificity, but earlier per-screen rules with higher specificity still override it in places. Duplicate base rules for `.accounting-detail-grid`, `.accounting-preview-panel` and `.accounting-technical-details` now exist in two places; they were **not** deleted, because removing rules that other screens may depend on cannot be verified without a browser.
5. Reports (Trial Balance, P&L, Balance Sheet, General Ledger, Account Statement, Cash Movement, General Expense) inherit the page, table and card standard but received **no report-specific layout work**.

## 12. Screens requiring manual visual review

Highest risk first — these are where the module-wide `label`, `table` and
`.accounting-page` rules are most likely to shift an existing layout:

1. Manual Journal editor (dense inline line-item inputs)
2. General Expense form and Expense Payment form
3. Cash/Bank Movement form
4. Accounting Setup Wizard
5. All seven report screens
6. Accounting Event detail (lifecycle banner, timeline, failure panel)
7. The eight Accounting-linked operational detail dialogs
8. Dark mode across all of the above
9. Arabic RTL across all of the above
