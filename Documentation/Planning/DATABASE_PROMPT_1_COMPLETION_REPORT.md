# Database Prompt 1 Completion Report

Date: 2026-07-15

## Scope completed

- Enforced valid values and append-only behavior for Order status history.
- Made assignment history undeletable, protected assignment identity, and prevented closed
  assignments from being rewritten or reopened.
- Enforced exact agreement between `orders.assigned_driver_id` and the active assignment.
- Prevented assignment changes and new active assignments for final-status Orders.
- Updated current Order creation/import assignment writes to preserve current/history agreement.
- Added payment actor and payment timestamp capture to current reconciliation and settlement
  payment creation.
- Added database confirmation validation for reconciliation and settlement eligibility, source
  amounts, aggregate totals, payment totals, actor traceability, and confirmed immutability.
- Updated Kysely types, schema catalog verification, safe API error translation, and tests.

## Confirmed payable rules

- Net greater than zero: payment sum must exactly equal the confirmed net.
- Net equal to zero: no payment rows may exist.
- Net below zero: rejected; no approved negative-payable workflow exists.
- Individual payment rows remain constrained to an amount greater than zero.

## Validation

- Pre-migration audit found no violating existing operational or confirmed financial records.
- Development migrations applied successfully through
  `20260715014000_financial_line_update_guard`.
- Schema verification passes with 52 business tables, 23 hardening triggers, and 7 integrity
  functions.
- Rollback-only PostgreSQL integrity tests pass and leave no test records.
- API error translation test verifies database details are not returned to clients.

## Query-plan review

Read-only `EXPLAIN (ANALYZE, BUFFERS)` checks were run against development data. Active
assignment lookup used `order_assignments_active_unique` and completed in approximately 0.14 ms.
Reconciliation and settlement payment aggregates completed in approximately 0.18 ms and 0.07
ms. PostgreSQL selected sequential scans for the current two-row payment tables; the verified
parent indexes remain available as those tables grow.

## Rollback and recovery

Migrations are forward-only after shared use. Do not delete migration history, drop the new
columns, or disable integrity triggers as an application rollback. If a production issue is
found, stop affected writes, preserve evidence, and release a new reviewed forward migration.
The application code can be rolled back only to a version that still writes assignment history
and payment traceability fields consistently with this schema.

## Deferred by approval

- Reassignment APIs and workflows.
- Unassignment APIs and workflows.
- Reconciliation and settlement reversal APIs, services, screens, workflows, and workflow tests.
- New financial formulas, VAT settlement fields, frontend screens, and other business workflows.

The existing reversal columns remain unchanged for future approved work.

## Environment limitation

The configured PostgreSQL role can migrate and test the development database but cannot create a
separate empty database. Clean-database migration execution therefore remains an environment
validation item for a PostgreSQL administrator or CI role with database-creation permission.
No destructive workaround was used.
