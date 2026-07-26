# Local Development

## Required Software

- Node.js 24.x
- pnpm 11.x
- PostgreSQL 18-compatible server/client
- Git
- Flutter SDK for the future approved mobile implementation

Prompt 1 was validated with Node 24.14.0, pnpm 11.7.0, and a locally running PostgreSQL 18.4 server.

## Setup

1. Clone or open the repository.
2. Run `pnpm install`.
3. Copy `.env.example` to `.env`.
4. Replace placeholder database credentials with a local development account.
5. Keep `.env` outside source control.
6. Run `pnpm validate` before opening a pull request.

## API

```powershell
pnpm --filter @blueline/api dev
```

- Liveness: `GET http://localhost:3000/api/v1/health/live`
- Readiness: `GET http://localhost:3000/api/v1/health/ready`
- OpenAPI in non-production: `http://localhost:3000/api/docs`

The API fails clearly when mandatory configuration is absent. Readiness returns 503 when PostgreSQL is unavailable or credentials/schema are unresolved.

## Web

```powershell
pnpm --filter @blueline/web dev
```

For a local Company administrator login, set `BLUELINE_DEV_COMPANY_SUBDOMAIN`,
`BLUELINE_DEV_COMPANY_USERNAME`, and `BLUELINE_DEV_COMPANY_PASSWORD` in the current shell and
run `pnpm --filter @blueline/api dev:bootstrap-company`. The command refuses to run when
`NODE_ENV=production`, creates one active development Company and administrator transactionally,
and fails if the subdomain already exists.

Open `http://localhost:5174`.

## Database

The local PostgreSQL server may be checked with `pg_isready`. Application connectivity requires a valid `DATABASE_URL`. Apply the controlled migrations before starting the API:

```powershell
pnpm --filter @blueline/api db:migrate
pnpm --filter @blueline/api db:verify
```

The verifier uses synthetic Companies inside a transaction and always rolls it back.

## One-Time Platform Bootstrap

After migrations, an authorized operator may create the first platform administrator. Do not
place either bootstrap variable in `.env` or a command argument. In PowerShell, collect the
password without command-history exposure, run the command once, and clear the process values:

```powershell
$env:BLUELINE_BOOTSTRAP_USERNAME = Read-Host "Platform username"
$secret = Read-Host "Platform password" -AsSecureString
$env:BLUELINE_BOOTSTRAP_PASSWORD = [Net.NetworkCredential]::new("", $secret).Password
pnpm --filter @blueline/api security:bootstrap-platform
Remove-Item Env:BLUELINE_BOOTSTRAP_USERNAME, Env:BLUELINE_BOOTSTRAP_PASSWORD
```

The command refuses to create a second platform administrator. Platform login is
`POST /api/v1/platform/auth/login`.

## Role APIs

Authenticated Company users with `users_roles.manage` can call:

- `GET /api/v1/roles`
- `GET /api/v1/roles/permissions`
- `POST /api/v1/roles`
- `PATCH /api/v1/roles/:roleId`
- `GET /api/v1/users`
- `PUT /api/v1/users/:accountId/roles`
- `POST /api/v1/users/:accountId/unlock`
- `POST /api/v1/users/:accountId/deactivate`

Role scope comes only from the authenticated session. Custom role creation is transactional
and append-only audited. User and role lifecycle changes are Company-scoped, audited, and
protected against self-lockout and removal of the final active administrator.

## Quality Commands

```powershell
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm validate
```

## Common Problems

- `DATABASE_URL is required`: create a local `.env` from the example.
- Readiness returns 503: verify PostgreSQL, credentials, database name, and supplied schema.
- Flutter command missing: expected while the mobile application is unimplemented; install the approved Flutter SDK before mobile work begins.
- Package build blocked: review `pnpm-workspace.yaml`; do not approve unknown lifecycle scripts casually.
