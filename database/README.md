# Database Foundation

PostgreSQL is mandatory. On 2026-07-13, the Project Owner authorized a new schema design from
the approved Version 3.0 requirements. The controlled migrations now define the Phase 1
business schema.

- `baseline/`: retained for any future owner-supplied legacy baseline; currently empty.
- `migrations/`: ordered TypeScript migrations for tenancy/security, delivery operations,
  and finance/accounting.

Database connectivity, migration execution, and rollback-only integrity verification live in
`apps/api/src/infrastructure/database`.

```powershell
pnpm --filter @blueline/api db:migrate
pnpm --filter @blueline/api db:verify
```

Migrations are forward-only after shared use. Corrections require a new migration.

## Database Prompt 1 integrity migrations

- `20260715010000_operational_history_assignment_integrity`: validates status-history values,
  makes status and assignment history append-only, and keeps the current Order Driver aligned
  with the active assignment.
- `20260715011000_financial_confirmation_integrity`: adds payment actor/timestamp traceability
  and validates reconciliation and settlement totals at confirmation.
- `20260715012000_integrity_trigger_forward_repair`: forward-only repair that restores the
  integrity functions and triggers without changing business data.
- `20260715013000_financial_line_source_integrity`: requires draft financial lines to match
  the eligible Order and its current financial source values.
- `20260715014000_financial_line_update_guard`: applies those source checks to amount-only
  line edits as well as inserts and identity edits.

The optional rollback-only integrity suite uses the configured development database and leaves
no test records behind:

```powershell
$env:RUN_INTEGRITY_DATABASE='true'
pnpm --filter @blueline/api test:integrity:database
```
