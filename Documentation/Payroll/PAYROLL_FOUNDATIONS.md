# BluelineGPT Payroll Foundations

## Status

Employee Payroll now has a Company-scoped backend workflow for monthly period
creation, calculation, recalculation, approval, adjustments, cash payments,
payment reversal, period close/reversal, and operational queries. Payroll UI,
Payslips, reports, exports, and Accounting postings remain future work.

Outsourced Driver fee tables remain database and domain foundations only.
Accrual generation, payments, reversal APIs, and Driver Collection integration
are not operational.

## Employee eligibility and Salary Hold

- `employees.payroll_eligible` defaults to `false`. Existing and new Employees
  must be explicitly enabled by an Administrator.
- Salary Hold records an active flag, reason, start date, and optional end date.
  An open-ended hold is allowed. Services require a reason and start date when
  activating a hold.
- Removing a hold does not erase its historical reason or dates.
- No Employee bank-account or payment-method fields are introduced. Employee
  Payroll is cash only.

## Effective-dated salary and allowances

Existing `employee_salary_versions`, `allowance_types`, and
`employee_allowances` remain authoritative.

- Salary and allowance amounts cannot be negative.
- Salary versions cannot overlap for an Employee.
- Active allowance periods cannot overlap for the same Employee and allowance
  type.
- No more than four allowances may apply simultaneously.
- Company allowance types now support an optional Arabic name.
- Payroll calculation uses the salary and allowances effective on the
  Payroll period end date.
- Approved Payroll stores immutable salary and allowance snapshots. Material
  changes to a used master record are rejected; later corrections require a new
  effective-dated record.

## Employee Payroll model

`payroll_periods` supports:

`draft -> calculated -> approved -> partially_paid/paid -> closed`, with a preserved
`reversed` state.

One non-reversed period is allowed per Company and calendar month. Period totals
are server-authoritative.

Legacy `payroll_entries` are evolved into Payroll lines. Each line snapshots the
Employee identity, employment type, Salary Version, Basic Salary, total
allowances, Employee Driver commission, adjustments, gross earnings, Net Salary,
paid amount, outstanding amount, and Salary Hold state.

Payroll lines use:

`draft`, `calculated`, `approved`, `partially_paid`, `paid`, `held`, `reversed`.

Legacy records are marked `legacy`; unsafe automatic financial conversion is
not performed.

## Allowance snapshots and adjustments

`payroll_line_allowances` retains up to four allowance code/name/amount
snapshots. Source relationships are optional for historical resilience, while
snapshot values remain immutable.

`payroll_adjustments` stores positive amounts with an explicit direction:

- Earning
- Deduction

Supported classifications are bonus, penalty, unpaid leave, advance recovery,
correction, and other. `unpaid_leave` is only a financial classification; no
attendance or leave subsystem is introduced.

## Employee cash payments

`payroll_payments` and `payroll_payment_allocations` prepare partial cash
payments. One payment may allocate across Employees, and one Payroll line may
receive multiple partial payments.

Acknowledgement options are:

- Checkbox
- Typed name
- Physical-signature area on a future printed document

No biometric or signature-image data is stored. Confirmed payments and
allocations are immutable; reversal preserves the original records.
Deferred database guards require each confirmed payment total to equal its
active allocations and require reversed payments to have no active allocation.
Later services must still lock and revalidate affected Payroll lines while
updating paid and outstanding totals.

Payment numbers use the Company-scoped `payroll_payment` counter with the
`PAYPMT` prefix. Payslip references will be derived later from Payroll period
and Employee Number.

## Employee Payroll backend

The backend is exposed under `/operations/payroll` and provides:

- monthly period creation and lifecycle queries;
- calculation and recalculation with structured blocking/warning exceptions;
- immutable salary, allowance, Employee identity, Salary Hold, and Employee
  Driver commission snapshots;
- pre-approval earning/deduction adjustments and controlled reversal;
- approval and server-authoritative summary/detail queries;
- cash-payment proposals, partial or batch confirmation, allocation history,
  and controlled payment reversal;
- fully-paid period close and controlled period reversal.

Every financial mutation uses the existing transaction, audit, Company
permission, reference-counter, and idempotency infrastructure. Payroll
idempotency records retain the original response body so an exact same-key
retry can return the original mutation result.

Calendar period dates are derived from the requested `YYYY-MM` and do not
depend on the API server's local timezone. No Payroll timestamps are converted
into a separate timezone model in this phase.

Legacy Payroll lines and commission links remain read-only and are surfaced
with their legacy source marker. They are not recalculated or converted into
new payment history automatically.

## Outsourced Driver fee rates and accruals

Outsourced Driver compensation is separate from Employee Payroll.

`outsourced_driver_fee_versions` holds Driver-specific, effective-dated fixed
fees. There is no Company default rate in this phase. Active periods cannot
overlap, and a rate used by an accrual is immutable.

`outsourced_driver_fee_accruals` provides one historical accrual identity per
Company and Order. The uniqueness remains in force after reversal, so a
replacement accrual cannot be created accidentally; a later explicitly
authorized correction design would have to address that case. The accrual
retains the rate snapshot, earned, paid, outstanding, and recovery amounts.

Accrual statuses:

- Accrued
- Partially paid
- Paid
- Reversed
- Recovery required

Accrual sources:

- Delivery
- Daily reconciliation
- Authorized backfill

Delivery-time creation, manually triggered daily reconciliation, and authorized
backfill are implemented. An unattended scheduled reconciliation job remains
deferred.

Unpaid accrual reversal can close the earning. If a paid earning becomes
invalid, it enters `recovery_required`; prior payment history is never erased.
Recovery is distinct from the amount still payable and no recovery collection
workflow is implemented here.

The current Order workflow makes `orders.assigned_driver_id` immutable after
delivery and keeps assignment-history rows. Accordingly, the delivered Order's
current assigned Driver is the authoritative delivering Driver for this
foundation. The accrual guard requires the same Driver and exact
`delivered_at` timestamp. If post-delivery reassignment is introduced later, a
dedicated delivery-time Driver snapshot will be required before this rule can
change safely.

The Company settings model stores a timezone and defaults it to `Asia/Dubai`.
Future accrual services must derive and pass `accrual_business_date` explicitly
using that Company setting. The database stores both the timestamp and business
date and does not derive the date from the server's local timezone.

## Legacy Driver commission coexistence

Legacy fixed-fee fields, Driver commission rules/calculations/Order links,
Payroll commission links, and legacy outsourced payments remain untouched.
They are read-only legacy history for the new model. Future accrual services
must check whether an Order is already represented by a payable, paid, or
consumed legacy calculation, a legacy payment allocation, an outsourced
payment, or a Payroll commission link to prevent double-counting.

No automatic legacy conversion is performed because settled calculations do not
map safely to per-Order partial-payment allocations without operational review.

Specific compatibility limits are:

- `outsourced_driver_payments` is one record per commission calculation; the
  amount is implied by the calculation and there is no partial-allocation or
  reversal history.
- `driver_commission_orders` marks calculation-level accrual/payment
  participation but is not a payment-allocation ledger.
- `payroll_commission_links` links a calculation to an Employee Payroll line
  and cannot be converted safely into Outsourced Driver fee allocations.
- Existing `driver_payable_deduction` values do not identify a fee accrual or
  legacy payment source, so they cannot be mapped automatically.

A future controlled conversion must review each calculation, its Order links,
settlement status, legacy payment, Payroll link, and reconciliation deductions
before recording any source marker. Records with missing Order allocation,
mixed settlement state, or unexplained deductions remain read-only.

## Outsourced Driver fee payments

`outsourced_driver_fee_payments` and its allocation table support:

- A separate cash payment
- A Driver Collection offset
- Partial payments
- One payment across several accruals
- Several payments against one accrual
- Deterministic oldest-first allocation
- Authorized manual allocation

Payment numbers use the Company-scoped `outsourced_driver_fee_payment` counter
with future prefix `DFPAY`.

The Driver Collection relationship reuses `driver_payable_deduction` and links
one active offset payment to one reconciliation. It does not change COD,
Customer Amount to Collect, Trader payable, Driver Expenses, or Cash/Visa
classification. Collection reversal reverses linked allocations atomically.

The database enforces Company/Driver scope, positive amounts, unique
payment-to-accrual allocation, one active collection-offset payment per
reconciliation, immutable reversal history, and deferred equality between each
payment amount and its active allocations. Outstanding revalidation and
coordinated row locking remain responsibilities of the later transactional
payment service.

## Permissions, idempotency, audit, and reversal

Employee Payroll permissions:

- `payroll.view`
- `payroll.manage`
- `payroll.approve`
- `payroll.pay`
- `payroll.reverse`

Outsourced fee permissions:

- `outsourced_driver_fees.view`
- `outsourced_driver_fees.manage`
- `outsourced_driver_fees.pay`
- `outsourced_driver_fees.reverse`

Permissions are added to the catalog only. No role receives them automatically;
`users_roles.manage` remains the Administrator fallback.

Future services reuse `idempotency_records` and `audit_events`. Company scope,
request hashes, unique constraints, and row locking remain mandatory. Financial
records are never destructively deleted. Reversals retain the original record,
actor, timestamp, reason, and allocation history.

## Future Accounting events

No journal entries are created. Future integrations may consume versioned events
for:

- Payroll approved, paid, and reversed
- Outsourced fee accrual created or reversed
- Accrual marked recovery required
- Fee payment or Driver Collection offset confirmed or reversed

Each event contract should carry Company, event type/version, source type/ID,
effective date, AED amount, idempotency identifier, and creation time. No new
outbox framework is introduced because the repository has no established one.

## Outsourced Driver fee operations and workspace

The operational services now create fee accruals at Order delivery and support
idempotent daily reconciliation and authorized backfill. Missing or ambiguous
effective rates do not block Order delivery: the delivery audit records the
exception, and reconciliation/backfill returns the affected Order as a
structured outcome for operational correction. Existing fee accruals and Orders
represented by legacy commission Order links, legacy outsourced payments, or
Payroll commission links are excluded so the same delivery cannot create a
second financial obligation.

Separate cash payments use the Company-scoped `DFPAY` reference, propose
oldest-first allocations by accrual business date, delivery timestamp, and
accrual ID, and revalidate every selected accrual under lock at confirmation.
Authorized manual allocation sends the explicit allocation set and records the
proposal and override in the audit event. A payment amount must equal its active
allocations; zero allocations, stale balances, overpayment, duplicate
allocations, duplicate idempotency use with different payloads, and
cross-Company access are rejected.

Driver Collection preview calculates the safe fee offset as the minimum of the
Driver's active outstanding fee balance and Gross Customer Collections minus
Driver Expenses. Confirmation creates the reconciliation, linked fee-payment
header, allocations, accrual balance changes, and audit history in one
transaction. Collection reversal locks and reverses the linked fee payment and
allocations in the same transaction before reversing the reconciliation.
Recovery-required accruals are excluded from normal payable and offset balances;
if historical allocations have entered recovery, ordinary payment or collection
reversal is blocked pending a future controlled recovery workflow.

The `/payroll` workspace includes an Outsourced Driver Fees tab for accruals,
payments, reconciliation/backfill results, separate cash-payment allocation,
reversals, and receipt actions. Driver Collection preview and detail show the
stored fee deduction separately from expenses and show the historically linked
fee-payment reference. The detail and PDF Net Expected amount use:

```text
Gross Customer Collections
− Driver Expenses
− Outsourced Driver Fee Offset
= Net Expected from Driver
```

The reporting layer provides Company-scoped JSON and bilingual PDF endpoints
for Driver Earnings Statements, Outstanding Driver Fees, Daily Driver Fee
Accruals, and Driver Fee Payment Receipts. It reuses Company branding and the
shared Chromium renderer. Statement opening and closing balances are calculated
as of the requested UAE business dates from immutable accrual and allocation
events. Reversed payment allocations remain visible as reversed history and are
added back to the event-based balance. Recovery Required is reported in a
separate total and is never added to normal Driver outstanding payable.

No Payroll Prompt 5 migration was required. Recovery collection, recovery
settlement, Accounting journals, digital signatures, employee banking,
attendance, leave, overtime, and salary proration remain deferred.
