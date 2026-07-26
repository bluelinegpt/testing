# Date, Number, and Currency Formatting

## Dates

The web foundation uses `Intl.DateTimeFormat` with `en-AE` or `ar-AE` and defaults display to `Asia/Dubai`. Stored system timestamps remain timezone-aware UTC values; business dates remain separate.

## Numbers

Operational counts may use `Intl.NumberFormat`. Non-finite values are rejected. Parsing and calculations must never depend on localized display strings.

## Currency

Currency display accepts a fixed-precision decimal string plus an ISO currency code. The formatter groups and localizes digits without converting the amount to JavaScript `number`. It does not calculate, round, or infer company currency.

Company base currency and VAT behavior remain blocked until the tenant configuration schema and authorization foundation exist. AED is a confirmed Phase 1 default, not a hardcoded global source of truth.
