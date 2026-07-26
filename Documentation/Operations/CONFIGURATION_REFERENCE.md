# Configuration Reference

All secrets and environment-specific values remain outside source control. `.env.example` contains placeholders only.

| Variable                         | Required | Purpose                                 | Notes                                     |
| -------------------------------- | -------: | --------------------------------------- | ----------------------------------------- |
| `NODE_ENV`                       |      Yes | `development`, `test`, or `production`  | Defaults to development locally           |
| `API_PORT`                       |      Yes | API listener port                       | Default 3000                              |
| `API_PUBLIC_URL`                 |    Later | Public API URL                          | Infrastructure decision                   |
| `WEB_PUBLIC_URL`                 |    Later | Public web URL                          | Used for links/CORS                       |
| `DATABASE_URL`                   |      Yes | PostgreSQL connection                   | Never log or commit                       |
| `DATABASE_POOL_MIN`              |      Yes | Minimum idle connections                | Default 0                                 |
| `DATABASE_POOL_MAX`              |      Yes | Maximum pool connections                | Default 10; tune by environment           |
| `DATABASE_CONNECTION_TIMEOUT_MS` |      Yes | PostgreSQL connection timeout           | Default 5000; range 100-120000            |
| `DATABASE_QUERY_TIMEOUT_MS`      |      Yes | PostgreSQL query timeout                | Default 10000; range 100-120000           |
| `CORS_ORIGINS`                   |      Yes | Comma-separated allowed web origins     | No wildcard with credentials              |
| `LOG_LEVEL`                      |      Yes | Structured log threshold                | Default `info`                            |
| `REQUEST_BODY_LIMIT_MB`          |      Yes | General JSON/form limit                 | Maximum 10; endpoints may be lower        |
| `RATE_LIMIT_TTL_MS`              |      Yes | Rate-limit window                       | Default 60000                             |
| `RATE_LIMIT_MAX`                 |      Yes | Requests per window                     | Default 100; tune by endpoint later       |
| `AUTH_LOCKOUT_MINUTES`           |      Yes | Temporary five-failure account lockout  | Default 15; range 1-1440                  |
| `AUTH_SESSION_TTL_MINUTES`       |      Yes | Opaque authentication session lifetime  | Default 720; range 5-10080                |
| `BLUELINE_BOOTSTRAP_USERNAME`    | One time | Initial platform administrator username | Process environment only; never `.env`    |
| `BLUELINE_BOOTSTRAP_PASSWORD`    | One time | Initial platform administrator password | Process environment only; clear after use |
| `FILE_STORAGE_PROVIDER`          |    Later | Private storage adapter                 | Unconfigured until gate                   |
| `EMAIL_PROVIDER`                 |    Later | Email adapter                           | Unconfigured until gate                   |
| `VITE_API_BASE_URL`              |      Yes | Web API base URL                        | Example ends in `/api/v1`                 |
| `WEB_PORT`                       |      Yes | Static web listener                     | Container default 8080                    |
| `WEB_CONNECT_SRC`                |      Yes | Web Content Security Policy API sources | Production default `'self' https:`        |
| `POSTGRES_DB`                    |    Local | Local Compose database name             | Not application runtime config            |
| `POSTGRES_USER`                  |    Local | Local Compose database user             | Not application runtime config            |
| `POSTGRES_PASSWORD`              |    Local | Local Compose database password         | Must be supplied outside Compose          |
| `SMOKE_API_BASE_URL`             |     Test | Smoke-test API target                   | Default loopback API                      |
| `SMOKE_WEB_BASE_URL`             |     Test | Smoke-test web target                   | Default loopback web                      |
| `SMOKE_TIMEOUT_MS`               |     Test | Per-check smoke timeout                 | Default 5000                              |

## Validation

API startup validates environment, port, database URL, pool limits, timeouts, log level, CORS origins, and request limit. The minimum pool size cannot exceed the maximum. Production additionally requires HTTPS CORS origins and a non-local PostgreSQL URL with managed credentials and TLS mode. Missing or invalid mandatory values fail startup without printing secret contents.

## Environment Policy

- Development uses local values only.
- Test uses isolated PostgreSQL and synthetic data.
- Production uses managed secret/configuration services selected at the Infrastructure Decision Gate.
- Production secrets are never stored in `.env` files committed or packaged with artifacts.
