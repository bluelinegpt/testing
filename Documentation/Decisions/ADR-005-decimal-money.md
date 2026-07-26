# ADR-005: Decimal Money Handling

## Status

Accepted.

## Context

Financial integrity requirements prohibit floating-point money and mandate PostgreSQL `NUMERIC(18,2)` with half-up rounding.

## Decision

Represent API money as decimal strings, use `decimal.js` in TypeScript domain code, and persist posted amounts as `NUMERIC(18,2)`.

## Consequences

UI and API code must not convert money to JavaScript numbers. Central domain formulas and golden tests are mandatory.

## Alternatives Considered

- JavaScript number: rejected due to binary floating-point error.
- Integer minor units only: workable for AED but less aligned with approved PostgreSQL numeric requirements and future percentage calculations.
