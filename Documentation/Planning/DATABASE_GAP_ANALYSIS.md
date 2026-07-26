# Prompt 2 Database Gap Report

> Resolution amendment, 2026-07-13: The Project Owner authorized a new schema design after
> this historical stop report. Four forward migrations now define 49 business tables and
> have been applied and verified locally. See `DATABASE_SCHEMA_IMPLEMENTATION_REPORT.md`.

## Status

**Historical SQL status: MISSING at assessment time**  
**Current blocker status: RESOLVED by owner-authorized new schema**  
**Verified on: 2026-07-13**

Version 3.0 `DB-001` states that PostgreSQL must be used and that an existing SQL schema is the starting point. Prompt 2 repeats this as a mandatory pre-implementation gate and explicitly prohibits inventing a replacement schema. No authoritative SQL/DDL dependency is present.

PostgreSQL 18.4 is installed and `127.0.0.1:5432` accepted connections during the Prompt 2 gate. Connectivity does not resolve the missing schema dependency.

## Locations and Patterns Searched

- `C:/Dev/BlueLineGPT` recursively, including hidden files and excluding generated dependencies/build output when classifying project assets.
- `Documentation/`, `database/`, and `apps/` recursively.
- Extensions/patterns: `.sql`, `.ddl`, schema, migration, migrations, seed, seeds, PostgreSQL, database project files.
- Package/configuration and ORM mapping files that might define or generate a business schema: none found.
- `apps/api/src/infrastructure/database/run-migrations.ts` is migration tooling, not an SQL schema.

## Verified Database Assets

| Asset                  | Result          |
| ---------------------- | --------------- |
| PostgreSQL server      | Reachable       |
| PostgreSQL schema      | Missing         |
| Tables and columns     | Cannot assess   |
| Primary/foreign keys   | Cannot assess   |
| Constraints/indexes    | Cannot assess   |
| Tenant/company fields  | Cannot assess   |
| Workflow status fields | Cannot assess   |
| Financial precision    | Cannot assess   |
| Audit fields/history   | Cannot assess   |
| Migrations             | Missing         |
| Seed/reference data    | Missing         |
| Database documentation | Foundation only |

## Required Validation Domains Once SQL Is Supplied

| Domain            | Required Checks                                                               | Current Classification             |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------- |
| Tenant isolation  | `company_id` coverage, non-null rules, composite FKs/uniques, RLS feasibility | Missing / Security Risk            |
| Identity/RBAC     | users, roles, permissions, memberships, lockout, token/recovery state         | Missing / Security Risk            |
| Companies         | status, subdomain uniqueness, configuration, currency, VAT                    | Missing                            |
| Traders/pricing   | single login, area pricing, effective dates, overrides/audit                  | Missing                            |
| Drivers/documents | employee/outsourced types, expiry, private file metadata                      | Missing                            |
| Orders            | tenant scope, immutable references, monetary fields, packages/items           | Missing                            |
| Workflow          | five separate status dimensions, transition/audit history                     | Missing / Data Integrity Risk      |
| Reconciliation    | selected orders, split payments, expenses, reversals, idempotency             | Missing / Financial Integrity Risk |
| Settlements       | multi-order linkage, per-order status, reversals                              | Missing / Financial Integrity Risk |
| Finance/GL/VAT    | chart, balanced journals, periods, VAT liability, immutable posting           | Missing / Financial Integrity Risk |
| Payroll/payables  | periods, employee and outsourced calculations, approval/reversal              | Missing / Financial Integrity Risk |
| Metering          | billable order event, billing period/status, uniqueness/idempotency           | Missing                            |
| Audit             | append-oriented events, actor, tenant, timestamp, before/after, retention     | Missing / Security Risk            |
| Performance       | tenant-aware indexes, date/status/report access paths                         | Missing / Performance Risk         |

## Deferred Validation Method

1. Preserve the supplied SQL unchanged as the baseline artifact.
2. Parse every table, column, key, constraint, index, function, trigger, and enum.
3. Build a requirement-to-object matrix.
4. Run the schema in an isolated PostgreSQL development instance.
5. Test referential integrity, tenant-aware uniqueness, precision, transactions, and concurrency.
6. Document proposed migration changes with risk and rollback approach.
7. Deliver corrections only through controlled forward migrations.

## Exact Required Input

Supply the authoritative schema package described in `PROMPT_2_REQUIRED_INPUTS.md`. At minimum, database implementation cannot resume until the following are available:

1. The complete existing PostgreSQL SQL/DDL schema file.
2. Its source version and whether it represents an empty baseline or an already deployed database.
3. Any prerequisite extensions, types, functions, and ordered scripts required to apply it.
4. Existing migration history and safe reference-data scripts, if they exist.

Place approved baseline artifacts under `database/baseline/`. Do not include credentials or production data.

## Stop Decision

No business tables, migrations, seed data, ORM mappings, database tests, or ER diagram were created. This is required by the Prompt 2 missing-schema stop rule.
