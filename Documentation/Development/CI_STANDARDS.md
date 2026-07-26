# Continuous Integration Standards

## Current Foundation

The repository has provider-neutral `pnpm` scripts for formatting, linting, type checking, tests, coverage, builds, supported secret signatures, migration naming, and dependency audit. `.github/workflows/ci.yml` is a least-privilege GitHub Actions baseline; it becomes active only if GitHub is selected as the repository host. Another platform can run `pnpm ci:validate` unchanged.

## Required Pipeline

1. Check out with minimal permissions.
2. Install Node 24 and pnpm 11.
3. Install from `pnpm-lock.yaml` without lockfile changes.
4. Run `pnpm format:check`.
5. Run `pnpm lint`.
6. Run `pnpm typecheck`.
7. Run `pnpm test`.
8. Run `pnpm build`.
9. Run supported secret-signature and dependency vulnerability scans.
10. Validate API and web container builds.
11. Add PostgreSQL migration/integration and container scanning once Prompt 2 and the infrastructure gate provide their required inputs.

CI never contains production secrets. Deployment remains disabled until the release and infrastructure gates are approved.
