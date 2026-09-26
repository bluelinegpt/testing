# BluelineGPT Backend and Web Baseline Testing

## Tooling

Use Node 24 and the repository lockfile/package manager. Normal unit/component tests require no internet, production credential, Firebase, WebSocket, or voice service. On this Windows workspace, installed dependency links require normal host filesystem access.

Commands from `C:\Dev\BlueLineGPT`:

```text
pnpm --filter @blueline/api test
pnpm --filter @blueline/web test
pnpm --filter @blueline/api typecheck
pnpm --filter @blueline/web typecheck
pnpm --filter @blueline/api build
pnpm --filter @blueline/web build
pnpm lint
pnpm format:check
pnpm migrations:validate
```

The API and web unit suites are green as of Prompt 11. Typecheck/build are not green because of separately documented accounting, payroll, operations fast-entry, exact-optional-property, and localization compile defects. Do not interpret green transpile-only tests as a production build.

## Database suites

Database tests are intentionally environment-gated and appear as skipped in the normal API suite when the test database configuration is unavailable. Before enabling them, provide a disposable PostgreSQL test database, apply all 58 migrations, use deterministic Company-scoped fixtures, and never point tests at staging or production. Run the repository-specific `test:*:database`, HTTP, integrity, reconciliation, and concurrency scripts. Preserve transaction cleanup and tenant assertions.

## Test environment

- Web uses Vitest, jsdom, Testing Library, and `apps/web/src/test/setup.ts`.
- Browser compatibility code must tolerate unavailable optional APIs such as `matchMedia`; tests must not require a developer browser.
- API uses Vitest. Repository fakes must implement the current interface, including authentication profile resolution.
- Keep UTC timestamps fixed in fixtures and format UAE display explicitly.
- External communication/notification/voice/offline-sync infrastructure remains out of scope and must use honest ports/test doubles until later prompts implement it.
- Never weaken tenant, authorization, financial, masking, HTML escaping, or idempotency assertions.

## Current gate

Prompt 12 must not begin until API and web typecheck/build are clean and the required database security/integrity suites run in a reproducible test database. Unit/component tests alone are insufficient.
