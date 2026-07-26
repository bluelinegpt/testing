# Git Workflow

## Repository

Prompt 1 initialized Git with `main` as the default branch. No commit is created automatically; the Project Owner controls the initial commit and remote.

## Branching

- `main` remains releasable and protected once a remote is configured.
- Use short-lived branches such as `feature/prompt-3-tenant-foundation` or `fix/health-readiness`.
- Avoid long-running integration branches unless a release process later requires them.

## Pull Requests

Every pull request includes requirement/prompt references, summary, security/tenant/financial impact, migrations, tests, documentation, screenshots when UI changes, and unresolved decisions.

At least one qualified review is required. Security, financial, schema, and infrastructure changes require the relevant specialist review.

## Required Checks

Run `pnpm validate`, plus PostgreSQL integration/security/performance suites when relevant. Tests must not be bypassed. Migration files and lockfiles receive deliberate review.

## Commit Hygiene

- Keep commits focused and messages descriptive.
- Never commit `.env`, credentials, uploads, private documents, or build output.
- Do not rewrite shared migration history.
- Generated files are committed only when the documented toolchain requires them.

## CI Hosting

The remote Git provider is unknown. Prompt 1 therefore provides provider-neutral scripts and does not guess a workflow format. Once selected, CI must install with the lockfile, run `pnpm validate`, run supply-chain/security checks, and later use an isolated PostgreSQL service for integration tests.
