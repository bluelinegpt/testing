# Coding Standards

## General

- Use meaningful names and small focused units.
- Preserve domain/application/infrastructure/presentation boundaries.
- Avoid circular dependencies, global mutable state, god services, and generic dumping-ground folders.
- Prefer explicit contracts over hidden coupling.
- Comments explain non-obvious reasons, not visible syntax.

## TypeScript

- Strict TypeScript is mandatory.
- Do not use `any`; validate external unknown values before use.
- Use type-only imports where applicable.
- Treat optional and nullable values deliberately.
- Do not suppress compiler or lint errors without a documented reason.

## API and Security

- Validate all requests server-side and reject unknown fields.
- Authorize every protected use case and enforce tenant scope server-side.
- Return safe errors and preserve correlation IDs.
- Never log secrets, tokens, passwords, identity documents, or unnecessary personal/financial data.

## Dates and Time

- System timestamps use UTC.
- Business/posting dates are separate explicit values.
- Use the `Clock` abstraction in testable business logic instead of uncontrolled time calls.
- Localize display in presentation layers only.

## Money

- JavaScript `number` is prohibited for monetary values.
- Use decimal strings at API boundaries and `Money`/decimal types in domain code.
- Centralize formulas and cover them with golden tests.

## Files and Jobs

- Modules use provider ports, not cloud SDKs directly.
- Jobs carry tenant context, correlation, and idempotency information.
- Files are private and authorized by default.

## Change Discipline

No prompt silently adds features, removes requirements, modifies approved SQL, or weakens tests. Significant decisions require an ADR.
