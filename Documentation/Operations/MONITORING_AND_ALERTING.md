# Monitoring and Alerting

## Current Implementation

The API emits structured JSON logs with service, environment, request/correlation ID, response status, and duration. Sensitive request headers and common credential fields are redacted. API liveness/readiness and web liveness endpoints exist. Container health checks call liveness endpoints.

No metrics, tracing, centralized log, dashboard, paging, or alert provider is selected or deployed. AI, MCP, authentication, jobs, and business metrics cannot be monitored because those components do not exist.

## Required Platform Signals

- Web/API availability, container restarts, CPU, memory, and saturation.
- API request rate, p50/p95/p99 latency, 4xx/5xx rate, and readiness failures.
- PostgreSQL availability, connections, storage, replication/backup state, deadlocks, slow queries, and transaction failures.
- Ingress TLS expiry, request rejection, and WAF events if selected.
- Backup age, backup failure, restore-test age, deployment/migration status, and image vulnerability status.
- Future authentication failures, job failures, storage capacity, AI provider/model/status/latency/tokens/cost/fallback, and MCP invocation/status/latency.

AI telemetry must identify live provider, model, outcome, latency, retry count, rate limit, token usage, and response provenance without storing credentials or full confidential prompts. Fallback or cached output must never be labeled as a live provider response.

## Initial Alert Catalogue

Thresholds below are starting points for staging tuning, not contractual service levels.

| Alert                  | Severity | Initial trigger                                           | Owner                       | First action                                                   |
| ---------------------- | -------- | --------------------------------------------------------- | --------------------------- | -------------------------------------------------------------- |
| API unavailable        | Critical | Liveness fails for 5 minutes                              | On-call operations          | Check deployment/container and rollback if release-related     |
| PostgreSQL unavailable | Critical | Readiness and database checks fail for 2 minutes          | On-call plus database owner | Protect writes, inspect managed database, invoke recovery plan |
| Migration failed       | Critical | Migration job exits nonzero                               | Release owner               | Stop deployment and preserve logs                              |
| Backup failed/stale    | Critical | Failed job or no successful backup within approved window | Database owner              | Retry safely and investigate storage/access                    |
| High API errors        | High     | 5xx above 5% for 10 minutes with meaningful traffic       | On-call engineering         | Correlate by release, endpoint, and dependency                 |
| High API latency       | High     | p95 above 2 seconds for 15 minutes                        | On-call engineering         | Check saturation, database, and external dependencies          |
| Connections near limit | High     | PostgreSQL usage above 80% for 10 minutes                 | Database owner              | Find leaks/long queries; do not blindly raise limit            |
| Storage capacity       | High     | Less than 20% free or forecast breach                     | Operations                  | Identify growth and expand through change control              |
| Repeated auth failures | High     | Tuned anomaly threshold after auth exists                 | Security owner              | Investigate source/user and apply incident controls            |
| AI/MCP unavailable     | High     | Sustained failures after integration exists               | Integration owner           | Enable explicit degraded state; investigate provider           |

Every paging alert requires a dashboard link, runbook link, environment, service, start time, and correlation/deployment identifiers. Tune noisy alerts before production approval.
