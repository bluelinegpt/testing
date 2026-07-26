# BluelineGPT Database Schema

## Status

The Phase 1 PostgreSQL schema was authorized, created, isolated-tested, and applied to the
local `blueline` development database on 2026-07-13. It contains 51 BluelineGPT business
tables plus Kysely's 2 migration-control tables.

## Migration Layers

1. Core tenancy and security: Companies, settings, banks, accounts, roles, permissions,
   Company users, employees, private-file metadata, reference counters, idempotency, and
   append-only audit.
2. Delivery operations: Areas, Traders and pricing, vehicles, Drivers and documents, imports,
   Orders and items, assignment/status history, attachments, international shipments,
   tracking, and billable-order usage events.
3. Finance and accounting: expenses, Driver reconciliation and split payments, Trader
   settlement and payments, payroll, accounting periods, chart of accounts, journals, and
   immutable financial controls.
4. Scope and financial hardening: account/role and profile scope checks, audit actor scope,
   international/Driver/Trader relationship guards, and immutable confirmed financial detail
   rows.
5. Authentication persistence: revocable opaque sessions, password-reset token metadata,
   approved permission codes, and database-enforced account/Company token scope.

## Company Isolation

Every Company-owned table has a non-null `company_id`. Parent tables expose `(id,
company_id)` uniqueness, and child relationships use composite foreign keys wherever they
prevent a record from referencing another Company's account, Area, Trader, Driver, Order,
file, payment, or financial record. Platform accounts are the deliberate nullable-Company
exception.

The API now derives trusted Company context from a live authenticated session and resolves
permissions from PostgreSQL on each protected request. Every future repository must still
scope object queries by that context. PostgreSQL RLS remains a later defense-in-depth decision.

## Workflow and Financial Controls

Orders store separate delivery, Driver reconciliation, Trader settlement, return, and
accounting statuses. A row constraint prevents financial closure while a physical return is
at the branch or otherwise unresolved.

All monetary values use `NUMERIC(18,2)`. Confirmed expenses, reconciliations, settlements,
payroll entries, posted journals, posted journal lines, and audit events reject destructive
mutation. Corrections use linked reversal records. Journal posting requires at least two
non-zero balanced lines and an open accounting period.

The database stores approved financial snapshots and enforces arithmetic identities for
reconciliation, settlement, payroll, and journal balance. It does not invent VAT-inclusive/
exclusive calculation sequencing or unresolved revenue/VAT treatment (`B-004`, `B-005`).

## Verification

Run:

```powershell
pnpm --filter @blueline/api db:migrate
pnpm --filter @blueline/api db:verify
```

`db:verify` checks all expected tables, cross-Company reference and token rejection, append-only audit,
unbalanced-journal rejection, successful balanced posting, and posted journal/header-line
immutability inside a transaction that is always rolled back.

CI runs both commands against disposable PostgreSQL 18 before container validation.

## Remaining Work

- Implement exact Kysely row types with each repository rather than generic table inventory.
- Apply authenticated Company context to each new domain repository and object-authorization check.
- Implement domain services and transactional status/financial behavior.
- Resolve `B-004` through `B-009` before affected application behavior.
- Add representative-volume query-plan, migration-upgrade, backup/restore, and performance evidence.
