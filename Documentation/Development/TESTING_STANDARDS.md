# Testing Standards

## Principles

- Test behavior and risks, not line counts.
- Use real PostgreSQL for persistence tests; no SQLite or in-memory substitute.
- Every tenant-owned feature includes at least two-tenant isolation tests.
- Financial and workflow rules use stable golden cases.
- Tests are deterministic, isolated, readable, and safe for CI.

## Prompt 1 Foundation

- Configuration validation tests.
- Decimal money and rounding tests.
- Liveness/readiness service tests.
- English-to-Arabic RTL web-shell test.
- Static TypeScript checks, ESLint, Prettier, and production builds.

## Future Layers

- Domain unit tests for formulas and transitions.
- PostgreSQL integration tests for constraints, transactions, migrations, and concurrency.
- API tests for validation, authentication, permissions, idempotency, and tenant isolation.
- Web browser tests and Flutter unit/widget/integration tests.
- Security, performance, regression, and UAT evidence by release.

## Naming and Location

Unit tests remain near source as `*.test.ts` or `*.test.tsx`. Cross-module integration, security, and performance suites live under top-level `tests/` when introduced.

## Prohibited Practices

- Removing or weakening a test to make a build pass.
- Mocking away the behavior being proven.
- Sharing mutable test data between tenants/suites.
- Using real customer data or credentials.
- Claiming a pass without executing the command.

See `Documentation/Planning/TEST_STRATEGY.md` for the complete release strategy.
