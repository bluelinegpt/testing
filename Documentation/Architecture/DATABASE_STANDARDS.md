# Database Standards

## Platform

PostgreSQL is the sole production persistent database. The Project Owner authorized a new
schema design from the approved Version 3.0 requirements on 2026-07-13. Three controlled
baseline migrations now define the Phase 1 schema; unresolved business rules remain outside
the database until approved.

## Schema Rules

- Use snake_case identifiers and explicit constraints.
- Tenant-owned records carry non-null `company_id`.
- Use tenant-aware foreign keys and unique indexes where required.
- Use `NUMERIC(18,2)` for posted monetary values unless an approved rule requires more precision.
- Use UTC timestamps for system events and separate business/posting dates.
- Use concurrency tokens/version checks for mutable aggregates.
- Confirmed financial and audit records are not destructively updated or deleted.

## Migrations

- Baseline SQL is preserved under `database/baseline` when supplied.
- Approved changes are forward migrations under `database/migrations`.
- Migrations are reviewed, tested against PostgreSQL, and never silently rewritten after shared use.
- Destructive changes require explicit approval and a correction/rollback plan.
- Production migration execution is a controlled deployment step, never application startup behavior.

## Transactions

The application use case owns the transaction boundary. Infrastructure repositories participate in that transaction. Nested independent transactions are prohibited. Retryable operations must be idempotent, and retries are limited to known transient failures.

## Query and Index Standards

- Every query is tenant-scoped where applicable.
- Select only required columns and use bounded pagination.
- Index by measured access patterns, beginning with tenant plus status/date/reference paths.
- Avoid per-row query loops and unbounded report queries.
- Explain plans are required for critical reports and high-volume operations.

## Testing

Database tests use real PostgreSQL, apply the baseline/migrations, and validate constraints, precision, transactions, concurrency, tenant isolation, and migration behavior. SQLite and in-memory substitutes are not accepted for persistence tests.
