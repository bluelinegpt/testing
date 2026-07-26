# Database Migration Guide

## Current Status

Five approved forward migrations define the Phase 1 schema and authentication persistence. They have been applied to an
isolated PostgreSQL 18 instance and the local development database. CI applies and verifies
them against disposable PostgreSQL 18. Production execution, representative-volume lock
behavior, upgrade compatibility, managed backup/restore, and forward recovery remain
unvalidated.

## File Policy

- Place approved Kysely JavaScript or TypeScript migrations in `database/migrations`.
- Name files `YYYYMMDDHHMMSS_description.js` or `.ts` with a unique UTC timestamp.
- Never modify a migration after shared execution.
- Link each migration to approved requirements and include risk, lock-duration, data-volume, verification, correction, and rollback notes.
- Destructive or irreversible changes require explicit owner approval and a verified pre-deployment backup.

## Deployment Procedure

1. Validate the baseline, migration chain, and target schema against a production-like PostgreSQL copy.
2. Estimate locks and duration using representative data.
3. Confirm backup success and restore evidence.
4. Place the application in the approved compatibility or maintenance state if required.
5. Run `pnpm --filter @blueline/api db:migrate` in development/staging, or the compiled one-off migration command in the approved release image.
6. Stop on any migration error. Do not deploy the application.
7. Verify migration history, constraints, indexes, data counts, and critical queries.
   Run `pnpm --filter @blueline/api db:verify` for the rollback-only integrity suite.
8. Deploy the compatible application image, run readiness/smoke checks, and monitor database errors and latency.

## Failure and Rollback

Do not automatically run `migrateDown` in production. If a migration fails before commit, investigate and retry only after correction and approval. If it commits but the application fails, prefer rolling back the application when schema compatibility permits or apply a reviewed forward correction. Restore the database only when incident command determines that forward recovery cannot meet integrity requirements.
