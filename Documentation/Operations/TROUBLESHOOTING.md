# Troubleshooting

## API Does Not Start

Check the required settings in `.env.example`. Startup intentionally fails on missing or invalid configuration without printing secret values. Confirm that `DATABASE_POOL_MIN` does not exceed `DATABASE_POOL_MAX`.

## Liveness Works but Readiness Fails

This means the API process is running but PostgreSQL cannot accept the readiness query. Verify the database host, port, credentials, and network access. Connection and query waits are bounded by `DATABASE_CONNECTION_TIMEOUT_MS` and `DATABASE_QUERY_TIMEOUT_MS`.

## Web Shell Cannot Reach the API

Check `VITE_API_BASE_URL` and `CORS_ORIGINS`. The browser origin must exactly match an approved CORS origin. The current web shell has no business screens, so successful loading does not validate an operational workflow.

## API Documentation Is Missing in Production

This is expected. Swagger is available for local development and is disabled when `NODE_ENV=production`.

## Authentication, Tenant, AI, or MCP Features Are Missing

These capabilities are not implemented in the current repository. Interfaces and planning documents do not provide runtime behavior or security. Refer to the production-readiness assessment before planning a release.

## Production Configuration Is Rejected

Production intentionally rejects wildcard/non-HTTPS CORS origins, local PostgreSQL hosts, the placeholder database password, and PostgreSQL URLs without an approved TLS mode. Use environment-specific values from the future managed secret/configuration services; do not weaken validation.

## Container Build Cannot Be Run

Install an approved Docker-compatible engine and rerun both Dockerfile builds. A TypeScript build alone does not validate container layers, permissions, health checks, or Compose behavior.

## Smoke Test Fails

Confirm the web `/healthz`, API liveness, and API readiness endpoints directly. Readiness failure commonly means PostgreSQL is unavailable. Set `SMOKE_WEB_BASE_URL` and `SMOKE_API_BASE_URL` when targets differ from local defaults.
