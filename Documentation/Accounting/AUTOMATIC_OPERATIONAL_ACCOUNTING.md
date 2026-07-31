# Automatic Operational Accounting

## Scope and processing model

Accounting Prompt 3 is a source-level implementation. It integrates Orders, distinct Trader
Receivables and collections, Trader Settlements, Driver Collections, Employee Payroll, Payroll
cash payments, Outsourced Driver fee accruals, and separate fee payments with the Prompt 1/2
ledger.

The repository had no queue, outbox, scheduler, or job framework. The existing
`accounting_events` table is therefore reused as the durable database-backed queue instead of
creating a parallel outbox. Additive capture triggers enqueue an Event in the same database
transaction as the authoritative operational status transition. A focused processor claims rows
with `FOR UPDATE SKIP LOCKED`, validates and posts in a separate transaction, and recovers stale
claims. This provides durable asynchronous delivery without coupling operational success to
Accounting configuration or posting success.

Automatic posting remains disabled by default and was not enabled for any Company. Capture occurs
only after a Company explicitly enables selected areas. Disabling stops capture and processing of
new Events; it does not alter posted Journals or delete queued/failed Events.

## Readiness and activation

Readiness is Company-scoped and returned per selected area. It checks:

- Manual Accounting enabled and AED base currency.
- An Open/Reopened Fiscal Year and Period on the activation date.
- All required effective mappings.
- Active Posting Accounts behind the mappings.
- Area-specific warnings and blockers.

Enable/disable requires `accounting.configuration.manage`, an idempotency key, a reason, and an
audit event. No role receives Accounting permissions automatically.

## Event lifecycle, versioning, and identity

Operational capture writes version 1 with a stable Company/Event/source identity and operation
key. The processor reloads authoritative source facts and replaces the capture hash with a
canonical SHA-256 hash over stable facts, typed components, Accounting Date, and source identity.
Volatile processing timestamps are excluded.

The lifecycle is:

`received -> processing -> validated -> posted`

Safe failures become `retry_pending` or `failed`. Configuration/Period/source/validation failures
remain durable with a stable code, category, safe summary, attempt count, and review metadata.
Reversal marks the original Event `reversed` and posts a separate reversal Event and Journal.

Database uniqueness prevents duplicate source Events and idempotency keys. A previously validated
Event whose authoritative payload hash changes fails with
`accounting_event_payload_mismatch`; posted history is never rewritten.

Transient lock/deadlock/serialization failures use exponential delay (5 seconds, capped at 5
minutes), with five automatic attempts. Configuration, mapping, Period, source, and balance
failures require operator correction and controlled reprocessing. Manual reprocessing is bounded
to 100 Events and adds five attempts while preserving prior attempt history.

## Accounting Date, mappings, and Journal posting

The processor uses the stored operational business date. Delivery timestamps use the existing
Asia/Dubai fallback convention. It never shifts an Event into a later Period. Closed,
Soft-Closed, Future, or missing Periods block before a Journal Number is allocated.

Mappings are resolved by Company, mapping key, and the original Accounting Date. The mapped
Account must be active and posting-enabled. Missing, overlapping, inactive, summary, or
cross-Company mappings block posting. Suspense is never selected.

Only after source, date, Period, mapping, and balance validation does the processor reserve a
Company `JRN-000001` reference. It creates an Operational Journal, source dimensions, Account
code/name snapshots, and at least two non-zero Lines; moves it through Balanced and Approved; and
posts it atomically. Automatic approval bypasses the Manual approval action, but database balance,
Period, Account, control-subledger, and immutability guards still apply. Manual endpoints reject
Operational Journals.

## Posting ownership and entries

- **Order delivery** owns COD/receivable recognition. Stored Customer Amount Due is debited;
  stored Trader payable, Company revenue, and output VAT are credited. Non-COD/zero-value Orders
  do not receive invented Lines; an unbalanced legacy snapshot becomes a visible source exception.
  Cancellation before recognition has no reversal. Return/cancellation after recognized delivery
  creates a linked operational reversal.
- **Trader Receivable** owns only manual/penalty/recovery/refund/service-charge obligations that
  are distinct from Order delivery. Trader Collection owns receipt of that receivable. It does not
  duplicate Trader Settlement or Driver Collection money.
- **Trader Settlement** owns payment to the Trader: Trader Payable is debited and each persisted
  Cash/Bank payment row is credited separately. Settlement/Trader dimensions remain on Lines;
  Order allocations remain in the verified operational allocation table and source metadata.
- **Driver Collection** owns collection Cash/Bank movement, embedded Driver expenses, and
  collection-offset fee deductions. Cash and Bank rows are separate. Gross COD control is
  credited; Cash/Bank, embedded expense, and fee-offset payable are debited. Embedded expenses do
  not create independent Journals.
- **Employee Payroll approval** recognizes Payroll Expense and Payroll Payable. A confirmed
  Payroll cash payment separately debits Payroll Payable and credits Cash. Non-cash Employee
  Payroll payment fails source validation. Payment reversal is a linked Accounting reversal.
- **Outsourced Driver fee accrual** debits fee expense and credits Driver payable. A separate cash
  payment debits Driver payable and credits Cash. A `driver_collection`/`collection_offset`
  payment is deliberately not captured as a separate fee-payment Event because Driver Collection
  owns that exact movement.

Operational reversals clone the original posted Line snapshots with Debit/Credit swapped, post on
the approved reversal date in an Open/Reopened Period, link both Journals and Events, and preserve
the original Journal. Accounting never reverses an operational record.

## Reconciliation, status, and backfill

Read APIs expose Event summaries/details, safe error and retry state, linked Journal, and
operational-source status. Reconciliation compares typed Event component totals with linked
Journal totals and reports queued, failed, missing-link, mismatch, posted, and reversed results.
It is read-only and never repairs operational or ledger data.

Historical backfill is preview-only. The preview counts delivered Orders, confirmed Settlements
and Driver Collections, approved Payroll periods, and fee accruals without Events for a bounded
date range. Execution is deliberately deferred because the repository does not have a general
durable bounded backfill-job framework. No historical record is posted automatically.

## APIs

- `GET /operations/accounting/automatic-posting/status`
- `GET /operations/accounting/automatic-posting/readiness`
- `POST /operations/accounting/automatic-posting/enable`
- `POST /operations/accounting/automatic-posting/disable`
- `GET /operations/accounting/events/summary`
- `GET /operations/accounting/events`
- `GET /operations/accounting/events/:eventId`
- `GET /operations/accounting/events/:eventId/reprocessing-readiness`
- `POST /operations/accounting/events/:eventId/reprocess`
- `POST /operations/accounting/events/reprocess-preview`
- `POST /operations/accounting/events/reprocess`
- `GET /operations/accounting/reconciliation/summary`
- `GET /operations/accounting/reconciliation`
- `GET /operations/accounting/reconciliation/:area/:sourceId`
- `POST /operations/accounting/reconciliation/preview-backfill`
- `GET /operations/accounting/operational-status/:area/:sourceId`

Read APIs reuse `accounting.view`; reprocessing and backfill preview reuse `accounting.post`;
activation reuses `accounting.configuration.manage`; existing Administrator fallback remains
explicit. No new permission key or role grant is introduced.

## Known limitations and deferred work

- Historical backfill execution is deferred.
- The repository does not store the last modifying actor on Orders; a post-delivery Order reversal
  capture retains the Order creator as the accountable fallback actor and preserves the
  operational source/correlation identity.
- Trader Settlement Order allocation traceability remains in the existing allocation table and
  Event metadata rather than adding another ledger allocation table.
- Standalone Driver expenses outside Driver Collection are not captured because the approved
  operational source inspected here records them inside Driver Collection.
- An invalid legacy Order financial snapshot is reported rather than silently balanced with a
  Suspense or invented amount.
- No UI, Event-monitoring UI, Accounting report, General Expense workflow, Bank workflow, Bank
  reconciliation, closing Journal, or Retained Earnings posting is implemented.

No runtime validation was performed. No migration was executed. No tests, typecheck, lint, build,
migration validation, database verification, or browser testing was run. This is not a production
readiness claim.
