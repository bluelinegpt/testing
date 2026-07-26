# Architecture Recommendation

## Decision Status

The Project Owner approved the TypeScript platform direction on 2026-07-13. Prompt 1 implements NestJS/TypeScript for the API, React/TypeScript for the web application, Flutter for the future mobile application, and PostgreSQL. The decision and supported-version policy are recorded in ADR-001.

## Recommended System Shape

Use a modular monolith for Phase 1:

- One versioned backend API deployment.
- One PostgreSQL database with controlled migrations.
- One responsive web application with Platform, Company, and Trader contexts.
- One Flutter codebase with Driver and Trader role experiences.
- Private object storage for documents/photos/generated artifacts.
- A durable background-job process hosted with the backend initially.

Do not begin with microservices. Extract a service only after measured operational or ownership pressure justifies it.

## Recommended Repository Structure

```text
BlueLineGPT/
  apps/
    api/
    web/
    mobile/
  database/
    baseline/
    migrations/
    seeds/
    docs/
  tests/
    architecture/
    integration/
    security/
    performance/
  Documentation/
    Architecture/
    ADR/
    API/
    Database/
    Security/
    Testing/
    Planning/
  tooling/
  .github/workflows/ or equivalent-ci/
```

Adjust naming to the selected framework, but preserve ownership boundaries.

## Backend Architecture

Each module should contain:

- Domain: entities, value objects, invariants, calculations, transition policies.
- Application: use cases, commands/queries, authorization requirements, transaction boundaries.
- Infrastructure: PostgreSQL mappings/repositories, object storage, jobs, external integrations.
- API: versioned request/response contracts and endpoint composition.

Recommended modules:

1. Platform and SaaS Metering
2. Identity and Access
3. Companies and Configuration
4. Areas and Localization
5. Traders and Pricing
6. Drivers and Documents
7. Orders and Assignment
8. Workflow and Audit
9. Imports
10. Collections and Reconciliation
11. Expenses and Settlements
12. Finance, VAT, and General Ledger
13. Payroll and Driver Payables
14. Reports and Dashboard
15. Public Tracking
16. International Shipments
17. Files and Document Generation

Modules may share infrastructure primitives, but must not reach directly into another module's tables or bypass its application rules.

## Technology Recommendation

Approved by the Project Owner on 2026-07-13:

- Backend: NestJS and TypeScript with OpenAPI, Kysely, PostgreSQL, validation, structured logging, and Vitest.
- Web: TypeScript and React with an RTL-capable accessible component system, typed API client, query caching, and established localization library.
- Mobile: Flutter/Dart as mandated, using generated/typed API contracts and secure platform token storage.
- Database: PostgreSQL as mandated.

Why this direction: it preserves strong transactional and security foundations while using the delivery team's preferred TypeScript ecosystem across the API and web application.

Exact framework versions and libraries must be selected during Prompt 1 and recorded in ADR-001. Avoid selecting unsupported or end-of-life releases.

## API Architecture

- REST/JSON under `/api/v1` unless an approved ADR selects otherwise.
- OpenAPI is the contract for web/mobile clients.
- Stable external DTOs; do not expose persistence entities.
- Central validation and consistent problem/error responses.
- Idempotency keys for retryable financial/critical commands.
- Optimistic concurrency/version tokens for editable aggregates.
- Bounded pagination, filters, sorting, and export jobs.
- Correlation IDs without leaking secrets or sensitive content.

## Multi-Tenancy

Recommended model: shared database and shared schema with mandatory tenant keys.

- Authentication resolves a platform identity and tenant membership.
- Tenant endpoints derive company context server-side.
- Every tenant-owned table carries non-null `company_id`.
- Composite foreign keys and unique constraints include `company_id` where required.
- Data-access APIs require tenant context and apply filters automatically.
- PostgreSQL RLS is evaluated as defense in depth during Prompt 2/3.
- Platform Administrator access uses explicit privileged commands and audit records.
- Background jobs store and restore tenant context explicitly.
- File keys and metadata are tenant-scoped; download is authorized every time.
- Cache keys include tenant and authorization-relevant scope.

## Workflow Architecture

Store separate delivery, reconciliation, settlement, return, and accounting states. Use explicit transition policies rather than unrestricted field updates.

Each transition records:

- Aggregate and tenant identifiers.
- Previous and new states.
- Actor, role/permission, source, time, and reason.
- Correlation/idempotency key.
- Related financial/reversal references.

Transitions with financial consequences execute in one PostgreSQL transaction and publish post-commit events/jobs through an outbox or equivalent reliable mechanism.

## Financial Architecture

- Use decimal domain types and PostgreSQL `NUMERIC(18,2)` for posted monetary values.
- Centralize V3 formulas as tested domain policies.
- Keep COD principal, service-fee revenue, VAT liability, trader payable, driver payable, cash/bank, expenses, and adjustments distinct.
- Generate balanced immutable journal entries from confirmed business events.
- Corrections create linked reversals/adjustments; never update posted records destructively.
- Lock accounting periods and require explicit permissions for close/reopen.
- Use idempotency and unique business references for posting, reconciliation, settlement, and payroll.

Approval is required for VAT-inclusive/exclusive treatment, revenue net of VAT, and rounding sequence before Prompt 20.

## Web Architecture

- One responsive application may host Platform, Company, and Trader route groups.
- Server authorization remains authoritative; navigation hides unauthorized modules only for usability.
- Localization keys, logical CSS properties, and RTL testing begin in Prompt 1.
- Keep the dashboard concise; activate financial KPIs only when their source modules are delivered.
- Use generated typed API clients to prevent duplicated financial/workflow rules.

## Flutter Architecture

- One Flutter application with role-specific navigation after authentication.
- Feature modules for shared identity/localization, Driver, Trader, files/camera/GPS, and API access.
- Tokens use platform secure storage.
- Business calculations and authorization remain on the backend.
- Mobile supports online-only behavior for Phase 1 and handles retry/idempotency for critical updates.

## Cross-Cutting Controls

- Structured logging with redaction and tenant/correlation context.
- Central error handling and safe client messages.
- Metrics/tracing for API, PostgreSQL, jobs, imports, reports, and storage.
- Private object storage with content validation and audited access.
- Configuration and secrets outside source control.
- Automated architecture tests to preserve module boundaries.

## Initial ADR Set

1. ADR-001 Technology stack and supported versions
2. ADR-002 Modular-monolith and repository layout
3. ADR-003 Tenant-isolation strategy and RLS decision
4. ADR-004 Authentication/session model
5. ADR-005 PostgreSQL access and migration approach
6. ADR-006 API and idempotency conventions
7. ADR-007 Financial posting and reversal model
8. ADR-008 Object storage and upload security
9. ADR-009 Background jobs and reliable event processing
10. ADR-010 Localization/RTL strategy

## Architecture Blockers

- Backend/web stack and Git initialization were approved and completed on 2026-07-13.
- Expected SQL schema or authorization to create one before Prompt 2 implementation.
- VAT/revenue clarification before financial implementation.
- Expanded permission matrix before Prompt 4 is finalized.
