# Environment Strategy

| Environment | Purpose                     | Configuration and secrets              | Data                                          | Logging and controls                                                        |
| ----------- | --------------------------- | -------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| Local       | Developer feedback          | Local `.env`, never committed          | Local PostgreSQL and synthetic data           | Debug/info; Swagger allowed; loopback HTTP                                  |
| Test        | Automated isolated checks   | CI variables and ephemeral credentials | Disposable PostgreSQL once schema exists      | Deterministic logs; no customer data                                        |
| Staging     | Release rehearsal           | Selected managed secret service        | Production-like synthetic data                | HTTPS, production security settings, monitoring and alerts                  |
| Production  | Approved customer operation | Managed secret/configuration service   | Managed PostgreSQL and private object storage | HTTPS only, Swagger disabled, centralized logs, metrics, alerts and backups |

## Production Rules

- `CORS_ORIGINS` is mandatory, uses HTTPS, has no paths, and never contains `*`.
- `DATABASE_URL` cannot use a local host or placeholder password and must request PostgreSQL TLS using `sslmode=require`, `verify-ca`, or `verify-full`.
- `VITE_API_BASE_URL` is embedded during the web image build. It is public configuration and must use the production API URL; it must never contain secrets.
- Production services do not read committed `.env` files. The platform injects configuration at runtime.
- Staging and production use separate databases, credentials, encryption keys, DNS, storage, and access policies.
- AI, authentication, MCP, storage, and email secret variables are added only with their implementing modules and startup validation.

The complete variable list is in `Documentation/Operations/CONFIGURATION_REFERENCE.md`.
