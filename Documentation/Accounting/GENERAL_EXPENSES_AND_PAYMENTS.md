# General Expenses and Payments

## Scope and repository decision

This is the source-level Accounting Prompt 4 backend implementation. The repository already had
`operating_expenses`, but that table is a legacy single-amount, single-attachment,
`draft`/`confirmed` model. It cannot safely represent immutable line and VAT snapshots, approval
and payable recognition, partial payments, multiple Cash/Visa rows, or independent payment
reversals. It is therefore preserved unchanged as read-only historical data. No legacy row is
deleted, rewritten, converted, or automatically posted.

The implementation adds an additive General Expense model and reuses:

- Company context and composite Company foreign keys;
- `company_reference_counters`;
- `file_objects`;
- `company_bank_accounts`;
- Chart of Accounts and effective-dated Account mappings;
- Fiscal Period posting guards and the Journal engine;
- the Prompt 3 Accounting event queue, processor, readiness and reprocessing services;
- the existing audit writer and idempotency records;
- the established Cash/Visa terminology.

No new permissions or role grants are introduced.

## Data model

The additive model contains:

- `general_expense_categories`;
- `general_expenses`;
- `general_expense_lines`;
- `general_expense_payments`;
- `general_expense_payment_rows`;
- `general_expense_attachments`.

Expense categories are effective-dated, Company-scoped, deactivated rather than historically
deleted, and carry default Expense mapping and VAT treatment. Categories are not seeded.

An Expense number is allocated from the existing atomic counter when the persistent draft is
created (`EXP-000001`). Drafts may remain incomplete. A Payment number is allocated only inside
the atomic create-and-confirm Payment transaction (`EXPPAY-000001`); there is no draft Payment
or Payment cancellation lifecycle.

Supported payees are linked Employee, Driver, or Trader records when supplied, or a stable manual
name snapshot for Supplier, Government, Landlord, Service Provider, or Other payees. This does
not create Supplier AP or new master records. Employee reimbursement can retain the Employee
relationship but remains distinct from Payroll. Driver Collection-owned expenses and Outsourced
Driver fees remain owned by their source modules and must not be duplicated.

## Lines, authoritative totals and VAT

Clients submit quantity, unit amount, VAT treatment, VAT rate, and an optional recoverable
percentage. The backend uses `decimal.js`, AED half-up rounding, and database `numeric` columns.

For each line:

```text
Net = Quantity × Unit Amount
VAT = Net × VAT Rate
Gross = Net + VAT
Expense Cost = Net + Non-Recoverable VAT
```

Header subtotal, total VAT, recoverable VAT, non-recoverable VAT, and gross total are the sums of
the calculated line snapshots. Client totals are never accepted. Zero/negative lines, malformed
numbers, unsupported precision, non-finite values, overflows, and invalid rates are rejected.

Zero-rated, exempt, and out-of-scope lines have zero VAT. Standard-rated VAT is recoverable;
non-recoverable VAT is included in Expense cost. Partially recoverable VAT uses the submitted,
validated percentage. Approval freezes the line and VAT facts.

The approval Journal is:

```text
Debit  Expense cost (Net + Non-Recoverable VAT), by effective line mapping
Debit  Recoverable Input VAT, when non-zero
Credit General Expense Payable
```

`general_expense_payable` must resolve to an active posting Accounts Payable control Account, and
the General Expense subledger identity is retained on the Journal Line.

## Attachments

Attachments reuse `file_objects` and the existing private `FileStoragePort`; no storage subsystem
or internal path is exposed. Existing active, clean, Company-owned files can be linked, or
signature-validated PDF, PNG, and JPEG evidence up to 10 MB can be uploaded. Stored bytes are
cleaned up if the metadata transaction fails, so upload failure cannot partially create a
financial record. Multiple Expense attachments and payment evidence links are supported. File
name, media type, and size are snapshotted. Attachments do not determine financial amounts, and no
OCR or invoice extraction is implemented.

## Lifecycle

Supported Expense lifecycle:

```text
draft → submitted → approved → partially_paid → paid
submitted → rejected → draft
submitted → draft (withdrawal)
draft/rejected → cancelled
approved/partially_paid/paid → reversed, after all successful Payments are reversed
```

Submission validates required dates, a positive calculated total, at least one line, active
Company category, and payee identity. Rejection and cancellation require reasons. Approval uses
`accounting.approve`, snapshots approved/outstanding amounts, and atomically creates
`general_expense_approved`. Accounting configuration, mapping, or Period failures do not roll
back the operational approval; the durable Event stays visible and reprocessable.

Approved Headers and Lines are financially frozen. Corrections require payment reversal,
recognition reversal, and replacement. History is never destructively deleted.

## Payments

Approval and payment are deliberately separate. Direct-paid Expenses are supported only as
sequential approve then pay operations so recognition and Cash/Bank movement remain independently
traceable.

One Payment belongs to one Expense. Partial payments, multiple Payments against one Expense, and
multiple rows within one Payment are supported. The service locks the Expense, rechecks its
version and outstanding amount, validates every destination, allocates the Payment number, writes
the confirmed header and rows, updates paid/outstanding totals, and creates the Accounting Event
in one transaction. Unallocated amounts and overpayment are impossible.

Cash and Visa remain separate:

- `cash` requires an active Company-owned Chart of Accounts posting Account classified as Cash;
- `visa` requires an active AED Company Bank Account;
- the Payment header stores independent Cash and Visa totals;
- rows retain their destination and appear as separate Journal credits.

The Payment Journal is:

```text
Debit  General Expense Payable
Credit Cash, per Cash row
Credit Bank, per Visa row
```

Payment never recognizes Expense cost again.

Payment creation and confirmation are atomic, so no draft Payment cancellation route exists.
Payment reversal locks the Payment and Expense, reverses the confirmed operational state exactly
once, restores outstanding, and creates `general_expense_payment_reversed`. The Prompt 3 reversal
engine uses the original posted Journal lines, not current mappings.

Expense recognition reversal is allowed only after every confirmed Payment has been reversed and
paid amount is zero. It creates `general_expense_reversed` and reverses only the recognition
Journal. This ordering prevents an Expense Payable from being removed while settled Cash/Bank
history remains active.

## Accounting Events and readiness

The four typed events are:

- `general_expense_approved`;
- `general_expense_payment_completed`;
- `general_expense_reversed`;
- `general_expense_payment_reversed`.

Event identity is unique by Company, type, source, and version. A stable payload hash detects
conflicting retries. Approval/payment state and the Event are written in the same transaction.
Events are created even while automatic posting is disabled; the Prompt 3 processor only claims
them after the Company explicitly enables Accounting and the `general_expenses` area.

Readiness requires:

- `general_expense`;
- `input_vat`;
- `general_expense_payable`;
- `general_expense_cash_payment`;
- `general_expense_bank_payment`;
- an open or reopened Fiscal Period;
- active AED Accounting configuration;
- active posting Accounts, including an Accounts Payable control Account.

No Company or area is enabled automatically. Missing mappings, invalid Accounts, and closed or
soft-closed Periods remain durable event failures. Authorized users can use the existing Prompt 3
event detail, readiness, preview, and reprocess routes with `accounting.post` or
`accounting.manage`. No Suspense fallback exists.

## Segregation, idempotency, concurrency and audit

The practical Accounting Prompt 2 segregation policy is reused:

- an Expense creator cannot approve when another active authorized approver exists;
- the creator or approver cannot record payment when another active `accounting.manage` user
  exists;
- a single-user Company may continue through the workflow;
- `users_roles.manage` does not bypass the segregation check;
- reversal uses the existing reversal segregation guard.

Every financial mutation requires the existing idempotency key format. Same-key/same-payload
retries replay the completed response; changed payloads conflict. Row locks, optimistic versions,
unique Expense/Payment numbers, source-ownership uniqueness, event identity uniqueness, positive
amount checks, and outstanding/approved database checks protect concurrency and overpayment.

Lifecycle, category, attachment, approval, payment, and reversal mutations write the existing
Company-scoped audit stream without attachment contents or raw exceptions.

## Routes

All routes use `/operations/accounting/general-expenses`.

- Categories: `GET/POST /categories`, `PATCH /categories/:categoryId`,
  `GET /categories/:categoryId/dependencies`, and
  `POST /categories/:categoryId/{activate|deactivate}`.
- Expenses: `GET /summary`, `GET /`, `POST /`, `GET/PATCH /:expenseId`,
  `GET /:expenseId/validate`.
- Lifecycle: `POST /:expenseId/submit`, `/withdraw`, `/approve`, `/reject`,
  `/return-to-draft`, `/cancel`, and `/reverse`.
- Evidence: `POST /:expenseId/attachments`, `POST /:expenseId/attachments/upload`,
  `GET /attachments/:attachmentId/content`, and
  `POST /:expenseId/attachments/:attachmentId/deactivate` while the Expense remains editable.
- Payments: `POST /:expenseId/payments`, `GET /payments/:paymentId`,
  `POST /payments/:paymentId/reverse`.
- Reconciliation: `GET /reconciliation/summary`, `GET /reconciliation`,
  `POST /reconciliation/preview-backfill`.

Read operations use `accounting.view`; mutation operations reuse `accounting.manage`,
`accounting.approve`, and `accounting.reverse`. Accounting configuration and mapping management
continue to use their existing permissions.

## Reconciliation and historical preview

Expense detail exposes operational facts, lines, Payments, attachments, Events, Journal links,
safe failures, and retry state. Reconciliation compares approved Expenses and confirmed Payments
to their durable Events and Journals.

Historical backfill is preview-only. It identifies already represented, non-financial, eligible
new-model, and structurally incompatible legacy rows. Execution is deferred because the
repository has no approved bounded durable backfill job framework and legacy
`operating_expenses` lacks the facts needed for safe VAT/payable reconstruction. No historical
Expense or Payment is back-posted.

## Known limitations and deferred scope

- No General Expense, category, payment, attachment, event, or reconciliation UI.
- No financial or Expense reports, PDF, exports, Trial Balance, General Ledger, P&L, Balance
  Sheet, VAT Report, or Cash Movement report.
- No Bank reconciliation, Bank statement import, cheque workflow, corporate-card
  reconciliation, or petty-cash replenishment.
- No Supplier AP, Supplier invoice, purchase order, procurement, fixed asset, depreciation,
  budget, closing, year-end, Retained Earnings, multi-currency, OCR, or digital signatures.
- Supplier/landlord/service-provider payees are manual snapshots because no approved Supplier
  master or AP subledger is introduced here.
- Historical backfill execution remains deferred.
- Automatic posting remains disabled unless explicitly enabled by Company and area.

No migration was executed. No tests, typecheck, lint, build, migration validation, database
verification, or browser testing was run. This is source-level development only and does not
claim production readiness.
