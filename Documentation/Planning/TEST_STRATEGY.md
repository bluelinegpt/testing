# Test Strategy

## Current State

The TypeScript workspace, NestJS API, React web application, Vitest suites, build tooling,
and CI candidate exist. Current automated coverage is limited to configuration, health,
shared money primitives, localization, the application shell, and the web API client.

There is no authoritative business schema, deterministic domain fixture set, PostgreSQL
integration suite, authentication or authorization implementation, Company isolation
suite, complete business workflow, financial workflow, browser E2E suite, Flutter
application, performance suite, or executable UAT environment. Release acceptance must
therefore distinguish foundation checks that pass from business scenarios that are blocked.

## Test Pyramid and Ownership

| Layer                  | Purpose                   | Required Coverage                                                                   |
| ---------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| Domain unit            | Fast business-rule proof  | Financial formulas, VAT, pricing, payroll, eligibility, transitions                 |
| Application unit       | Use-case orchestration    | Authorization requirements, validation, idempotency decisions                       |
| PostgreSQL integration | Real persistence behavior | Transactions, constraints, migrations, concurrency, tenant filtering/RLS            |
| API                    | External behavior         | Validation, versioning, errors, auth, permissions, idempotency, pagination          |
| Web UI                 | Critical journeys         | Admin/operations/cashier/finance/trader flows, localization, accessibility          |
| Flutter unit/widget    | Mobile logic/UI           | Driver/trader states, localization, offline-error handling, secure storage adapters |
| Flutter integration    | Device journeys           | Login, API, maps, call, GPS, photo, status updates                                  |
| Security               | Abuse resistance          | Cross-tenant, IDOR, upload, token, rate limit, CORS/CSRF, log leakage               |
| Performance            | Capacity/SLO evidence     | API, dashboard, reports, imports, concurrency, jobs                                 |
| UAT                    | Business acceptance       | Release-specific end-to-end scenarios and signed evidence                           |

## Framework Selection

Select tools after ADR-001 confirms the stack. For the recommended stack:

- Backend: Vitest and Supertest for the NestJS/TypeScript API, with mocking used sparingly and real PostgreSQL integration through disposable test databases or containers.
- API: in-process application host plus HTTP contract tests and generated OpenAPI validation.
- Web: TypeScript unit/component tests and browser automation such as Playwright.
- Flutter: `flutter_test`, widget tests, integration tests, and mocked platform adapters where device hardware is unavailable.
- Performance: k6 or an equivalent scriptable load tool.
- Security: dependency/secret/SAST scanning in CI plus focused DAST/authorization tests against a disposable environment.

Record exact tools and versions in Prompt 1.

## Mandatory Suites

### Tenant and Authorization

- At least tenants A and B in every integration fixture.
- Cross-tenant read/write/delete/reference/file/report/export attempts.
- Platform Administrator versus Company Administrator boundaries.
- Deny-by-default tests for every permission code.
- Trader own-data and Driver assigned-order boundaries.

### Financial Golden Cases

- V3 Cases 1-4 for COD/service-fee payer combinations.
- Customer amount due/collected.
- Trader gross/net payable.
- Employee and outsourced driver calculations.
- Return fees, expenses, refunds, credits, and approved adjustments.
- VAT enabled/disabled and inclusive/exclusive behavior once approved.
- Revenue excludes COD and VAT.
- Half-up rounding, percentage edge cases, zero/negative prevention.
- Balanced journals, period locks, reversals, and repeated idempotency keys.

### Workflow

- Every allowed transition in each of the five dimensions.
- Every invalid transition and unauthorized actor.
- Delivered/returned/cancelled terminal behavior.
- Physical-return dependency before financial close.
- Reconciliation/settlement/accounting reversal behavior.
- Concurrent update conflict and audit history.

### Excel Import

- Official template versions and required columns.
- Missing/invalid values with row and column messages.
- Invalid area, mobile, payment condition, amount, and duplicates.
- All-or-nothing behavior.
- Up to 5,000 rows, malformed files, formula/macro/content attacks, and 10 MB boundary where applicable.
- Idempotent/repeated uploads and SaaS metering behavior.

### Web and Flutter

- Role-specific navigation and protected routes.
- Arabic/English switching and mirrored RTL layout.
- Long Arabic/English labels, numbers, currency, dates, and printed documents.
- Driver maps/call/GPS/photo permissions and failures.
- Secure token lifecycle and session expiration.
- Responsive web viewports and supported mobile OS/device matrix.

## Performance Plan

Targets introduced by Prompt 0:

- 5,000 orders/day/company.
- 20 concurrent authenticated users/company.
- API p95 <= 2 seconds.
- Dashboard <= 3 seconds.
- Standard reports <= 10 seconds.
- Excel import up to 5,000 rows.
- Attachment up to 10 MB.

Test with multiple active tenants and realistic skew, not one empty tenant. Measure database queries, connection pool, API latency, report memory, import throughput, job queues, storage, and error rate. Define warm/cold cache assumptions and dataset size before claiming success.

## CI Gates

- Every change: format, lint, build, unit tests, architecture tests, secret/dependency scan.
- Database changes: migration apply/rollback validation and PostgreSQL integration tests.
- Protected-feature changes: API/authorization/cross-tenant tests.
- Release candidate: full UI/mobile regression, security, performance, recovery, and UAT evidence.

Tests must not be removed, skipped, or weakened to obtain a passing build without a documented approved reason.

## Test Data

- Synthetic data only; no production personal documents or credentials.
- Deterministic factories for companies, roles, traders, drivers, orders, and finance.
- Stable financial golden fixtures.
- Large generated datasets for reports/import/performance.
- Isolated database per suite or deterministic cleanup with no cross-test tenant leakage.

## Acceptance Evidence

Each release retains requirement-to-test mapping, CI results, security scan results, performance results where applicable, migration evidence, unresolved defects, and Project Owner/UAT decision.
