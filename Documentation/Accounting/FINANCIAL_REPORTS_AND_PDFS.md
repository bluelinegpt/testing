# Financial Reports, Exports, Printing, and PDFs

## Status and repository inspection

Accounting Prompt 7 adds the first Financial Report backend and frontend implementation. Before
this prompt, Accounting contained operational summaries, Journals, Opening Balances, General
Expenses, Cash/Bank ledgers, and reconciliation, but no Financial Report service or workspace.

The implementation reuses `journal_entries` and `journal_lines`, Chart of Accounts classifications,
Company/identity context, `accounting.view`, audit, General Expense and Cash/Bank snapshots, the
existing Playwright/Chromium PDF renderer, Company Profile branding, the authenticated binary API
client, Accounting table/card patterns, RTL shell, and print CSS.

No new PDF framework, permission, role grant, table, index, report cache, job queue, or migration
was introduced. Historical migrations were not modified.

## Architecture and routes

Backend routes:

- `GET /operations/accounting/reports/readiness`
- `GET /operations/accounting/reports/:report`
- `GET /operations/accounting/reports/:report/export?format=csv|xlsx`
- `GET /operations/accounting/reports/:report/pdf`
- `GET /operations/accounting/reports/documents/journals/:id/pdf`
- `GET /operations/accounting/reports/documents/opening-balances/:id/pdf`
- `GET /operations/accounting/reports/documents/expenses/:id/pdf`
- `GET /operations/accounting/reports/documents/expense-payments/:id/pdf`
- `GET /operations/accounting/reports/documents/cash-bank-movements/:id/pdf`

Whitelisted report names are Trial Balance, General Ledger, Account Statement, Profit and Loss,
Balance Sheet, Cash Movement, General Expenses, and VAT Foundation.

Frontend routes are `/accounting/reports` and `/accounting/reports/:report`. Journal, Opening
Balance, Expense, Expense Payment, and Cash/Bank Movement details expose preview, print, and
download actions.

## Report contract and controls

The shared envelope contains report identity, title, filters, AED currency, data source,
generated/snapshot timestamps, provisional state, warnings, rows, backend totals, pagination, row
count, limits, and truncation state. Money remains SQL `numeric::text`; identifiers remain strings.
Date filters remain `YYYY-MM-DD` and never pass through browser timezone conversion.

Interactive requests are limited to 200 rows, exports to 5,000 rows, and PDFs to 1,000 rows. Limit
breaches are explicit and require narrower filters. No background framework exists, so
asynchronous generation is deferred. No report cache exists; bounded Company-scoped direct
queries are used and there is therefore no cache to share across Companies or invalidate.

## Calculations

- Trial Balance uses Posting Accounts only, avoiding Summary/Posting double-counting. Opening is
  Posted history before Date From; closing is opening plus period Debit minus Credit. Differences
  remain visible and no balancing row is created.
- General Ledger and Account Statement share one calculation. Opening is calculated before Date
  From. A SQL window over deterministic Accounting Date, Journal Number, Line Number, and Line ID
  ordering produces a running balance before pagination, so pages do not restart it.
- Profit and Loss classifies Posted Lines by Account Type and Account Class, never Account names.
  Unclassified Accounts remain visible. Revenue uses Credit less Debit and Expense uses Debit less
  Credit.
- Balance Sheet uses Debit less Credit for Assets and Credit less Debit for Liabilities/Equity.
  Current Fiscal Year Revenue/Expense activity is shown as current earnings unless a Posted
  `closing` Journal exists, preventing a second inclusion after an Equity transfer. Equality and
  the exact difference are returned without an artificial row.
- Cash Movement uses Posted Cash/Bank Lines. Multi-Cash/Bank-Line and `bank_transfer` Journals are
  visible as internal transfers but excluded from consolidated external inflow/outflow totals.
- General Expense snapshots remain authoritative operational facts and are shown beside Posted
  Journal linkage totals; differences remain visible.
- VAT compares persisted approved recoverable VAT with Posted VAT Lines. It is a reporting
  foundation—not an FTA return, filing, certification, tax submission, or tax advice.

Posted Reversal Journal Lines participate on their Accounting Date exactly like other Posted Lines.
Draft, Balanced, Approved-but-unposted, Cancelled, blocked, and failed records never affect official
financial statements.

## Export, PDF, print, localization

CSV is UTF-8 with BOM, stable columns, correct escaping, Decimal strings, metadata, Arabic text, and
text identifiers. XLSX is a bounded dependency-free Open XML workbook whose cells are inline
strings, preserving leading zeros, Arabic, dates, identifiers, and Decimals without formulas or
floating-point recalculation.

PDFs reuse server-side Chromium with escaped HTML, Company English/Arabic names and subtitles,
telephone, optional private logo, filters, warnings, snapshot metadata, repeated headings, page
break protection, and page numbers. Arabic uses Unicode, RTL flow, and Chromium shaping. `bdi`
keeps Account codes, Journal/Expense/Payment/Movement numbers, references, dates, and amounts LTR.
Logo failure does not fail the report. Filenames are sanitized and never contain Bank secrets.
Bank master data continues to expose masked Account Numbers and IBANs only.

Print uses the authoritative server PDF; print CSS also hides navigation and controls.

## Permissions, security, audit

All routes require `accounting.view` or the existing Administrator fallback and scope every query
to authenticated Company context. UUIDs, report kinds, formats, and page sizes are validated.
HTML and filenames are escaped. Raw SQL, Event payloads, stack traces, storage paths, secrets, full
Bank Account Numbers, and full IBANs are not exposed.

CSV, XLSX, report PDF, and document PDF generation write bounded audit metadata (type, format,
filters, source ID), never rows, binary content, SQL, or Bank secrets. No new permission or role
grant was created. Read-only on-demand generation is not persisted, so idempotency is unnecessary.

## Known limitations and deferred work

- Advanced Fiscal Year/Period resolution, comparative columns, Account ranges, hierarchy
  expansion, branch/dimension filters, advanced grouping, and URL-persisted filters require a
  later focused enhancement. Current reports use explicit date-only ranges.
- Readiness covers Accounting enablement, Posting Accounts, Fiscal Year and Posted Journal
  availability, and unclassified Accounts. Detailed Event/reconciliation diagnostics remain in the
  existing Accounting dashboards.
- The response records a snapshot timestamp, but direct queries do not hold an unbounded
  repeatable-read transaction. A concurrent new posting may require refresh for a multi-query
  summary.
- Document PDFs provide authoritative current header/line facts and exclude attachment binaries
  and raw Event payloads.
- Report scheduling, email, persisted artifacts, distributed caching, and asynchronous generation
  are deferred.
- Bank statement import/parsing/matching, full Bank reconciliation, Bank-cleared status, VAT
  filing, period/year-end closing automation, Retained Earnings automation, Supplier AP,
  procurement, cheques, Fixed Assets, depreciation, budgeting, multi-currency, consolidation,
  OCR, and digital signatures remain deferred.

This is source-level implementation only. No runtime validation, tests, typecheck, lint, build,
migration validation, database verification, browser testing, or migration execution was
performed. Production readiness is not claimed.
