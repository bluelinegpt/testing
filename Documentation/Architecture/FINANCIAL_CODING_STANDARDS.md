# Financial Coding Standards

## Money

- Never use JavaScript `number` for money.
- Accept and serialize monetary values as decimal strings.
- Use a decimal library in application/domain code.
- Store posted monetary values as PostgreSQL `NUMERIC(18,2)`.
- Round half-up to two decimals at approved posting/output boundaries.

The Prompt 1 `Money` value object demonstrates safe decimal parsing, addition, subtraction, range validation, and half-up rounding. It is a foundation type, not a complete finance implementation.

## Accounting Meaning

- COD principal is not company revenue.
- VAT is a tax liability and not company revenue.
- Trader payable, driver payable, cash/bank, expenses, refunds, adjustments, and service-fee revenue remain distinct.
- Posted entries must balance.

## Calculation Ownership

Financial formulas live once in domain/application policies and are covered by golden tests. Web, Flutter, controllers, and database triggers do not duplicate authoritative formulas.

## Transactions and Idempotency

Reconciliation, settlement, posting, reversal, payroll, and other critical commands use PostgreSQL transactions. Retryable commands use immutable idempotency keys and return the original result when safely repeated.

## Immutability and Corrections

Confirmed/posted records are not edited or deleted. Corrections create linked reversal or adjustment records preserving actor, reason, time, original reference, and audit history.

## Open Accounting Decisions

Before Prompt 20, approve VAT-inclusive/exclusive pricing, revenue net of VAT, calculation sequence, percentage intermediate precision, invoice/credit-note behavior, and adjustment approvals.
