# Repair Center Rev 3 migration applicability report

Date: 2026-10-07

## Result

The migration runner now enables Kysely `allowUnorderedMigrations`. This is
safe only with the documented dependency review and disposable-database tests;
it is not permission to skip migration validation or schema verification.
The eight migrations `20260983000000` through `20260990000000` were not edited,
renumbered, or reordered.

The runner's legacy-name compatibility aliases are shared with a new read-only
`GET /api/v1/platform/integrity/migrations` check. The endpoint is protected by
`platform.integrity.read` and the existing Platform-identity permission guard.
It reports the recorded ledger, unordered mode, and whether each known legacy
alias is recorded. It performs no writes.

## Dependency and schema review

- `20260983000000` seeds the accounting-mode permission.
- `20260984000000` changes operational-finance behavior and retains its
  existing `cash_bank_movements.generated_by_source_type` missing-column and
  constraint idempotency guard unchanged.
- `20260985000000` and `20260986000000` seed Repair Center permissions.
- `20260987000000` and `20260988000000` add Repair Center recovery/audit
  structures.
- `20260989000000` adds the accounting-mode timeline function/table behavior.
- `20260990000000` adds Payroll Repair structures.
- `20260991000000` only seeds workforce permissions and does not conflict with
  the eight.
- `20260992000000` replaces the Order identifier trigger body and does not
  reference the eight's tables, permissions, or functions. Its ordering after
  the eight remains compatible.

No migration conflict was found by static review. No production database was
accessed, and no production or live ledger was edited.

## Validation evidence

| Check | Result |
|---|---|
| `node scripts/validate-migrations.mjs` | Passed: 244 ordered migration files |
| API typecheck (`tsc --noEmit -p apps/api/tsconfig.json`) | Passed |
| Scoped ESLint | Passed |
| API test runner | Not executed: Vitest config startup hit Windows sandbox `spawn EPERM` |
| API production build | Not verified: TypeScript emit hit Windows sandbox `EPERM` on existing `apps/api/dist` files |
| Disposable DB-A empty migration | Not executed: no safe disposable PostgreSQL target was available in this session |
| Disposable DB-B 236-name ledger reproduction | Not executed for the same reason |
| HTTP authorization and migration-state checks | Not executed because the test runner/database prerequisite was unavailable |

The two database cases remain required before deployment: DB-A must migrate
from empty; DB-B must contain the documented 236-name ledger, omit exactly the
eight, apply the manual column/constraint DDL, and then record exactly those
eight. The checks must also prove unordered recording, the pre-existing guarded
column/constraint, alias compatibility, read-only behavior, Platform-only
authorization, and Company-role/anonymous denial.

## Expected effects

The code change affects only migration execution ordering/compatibility and a
read-only Platform observability endpoint. The eight migration files and their
schema/data effects remain unchanged. No application data, migration ledger,
Orders, settlements, accounting journals, reconciliation objects, or
`file_objects` were modified by this work.
