# ADR-007: Localization and Document Direction

## Status

Accepted for the web foundation.

## Context

BluelineGPT requires maintainable English and Arabic presentation with LTR and RTL behavior. Business calculations and authorization must remain language-independent.

## Decision

Use `i18next` and `react-i18next` with separate typed resource modules. English is the fallback. Persist only the web device locale locally, normalize it to `en` or `ar`, and set root `lang` and `dir` attributes centrally. Use `Intl` through shared formatters; currency values enter those formatters as decimal strings and are not converted to floating point.

## Consequences

Future features must add both catalogs, use translation keys, test both directions, and keep backend error codes stable. A future authenticated user preference may replace the device default without changing the translation contract.

## Alternatives Considered

- Inline component dictionaries: rejected because they fragment translation ownership.
- CSS-only direction switching: rejected because document semantics would be incorrect.
- JavaScript `number` for currency display: rejected because it violates the financial precision standard.
