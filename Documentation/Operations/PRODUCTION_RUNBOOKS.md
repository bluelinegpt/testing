# Production Runbooks

These runbooks become executable only after monitoring, ownership, provider consoles, and escalation contacts are approved. Role labels are proposed responsibilities, not assigned people or approved support roles. Never paste secrets or customer data into incident channels.

## Common Incident Procedure

Declare environment/severity, assign an Incident Commander, timestamp actions, preserve correlation and deployment IDs, stop risky changes, communicate impact, and prefer reversible containment. After recovery, verify health and critical workflows, monitor stability, complete an incident review, and track corrective actions.

## Application Unavailable

- **Symptoms/detection:** Liveness fails, ingress returns 5xx, or containers restart.
- **Act/investigate:** Freeze releases; inspect platform events, resource pressure, logs, configuration, and recent image digest.
- **Recover/escalate:** Replace unhealthy instances or roll back to the last verified image. Escalate according to the approved incident policy, or immediately when data integrity or security may be at risk.

## PostgreSQL Unavailable or Slow

- **Symptoms/detection:** Readiness `503`, connection alerts, query timeout, or high latency.
- **Act/investigate:** Protect writes; inspect managed database status, connections, locks, storage, network, and recent migrations.
- **Recover/escalate:** Use managed failover or approved restore. Database Owner must approve termination of sessions, failover, or restore.

## AI Provider Unavailable, Invalid Key, Timeout, or Rate Limit

- **Symptoms/detection:** Future AI telemetry reports authentication, timeout, rate-limit, or provider failures.
- **Act/investigate:** Mark the feature unavailable/degraded, verify provider status and secret version without exposing it, and inspect retry/rate usage.
- **Recover/escalate:** Rotate an invalid key through the secret service or wait/back off for rate limits. Never return simulated output as live AI. Escalate sustained business impact.

## MCP or Tool Unavailable

- **Symptoms/detection:** Future discovery/invocation checks fail or validated output is absent.
- **Act/investigate:** Disable the affected tool path, inspect authorization, endpoint health, timeout, and audit trail.
- **Recover/escalate:** Restore the approved server/configuration and revalidate permissions and output. Escalate any unauthorized invocation as a security incident.

## Deployment or Migration Failure

- **Symptoms/detection:** Pipeline, migration, readiness, smoke, or release verification fails.
- **Act/investigate:** Stop promotion and traffic shift; preserve logs and exact artifact/schema versions.
- **Recover/escalate:** Roll back compatible application images or apply an approved forward migration correction. Never automatically migrate down or continue after a critical failure.

## Backup Failure

- **Symptoms/detection:** Backup job fails or recovery point exceeds the approved age.
- **Act/investigate:** Confirm scope, storage/access status, encryption key availability, and last valid recovery point.
- **Recover/escalate:** Retry only after cause correction. Page the Database Owner immediately when RPO may be breached.

## Restore Operation

- **Symptoms/detection:** Authorized recovery is required after loss/corruption.
- **Act/investigate:** Follow `BACKUP_AND_RESTORE.md`; confirm destination and recovery point with Incident Commander and Database Owner.
- **Recover/escalate:** Validate in isolation before cutover. Escalate discrepancies in tenant, financial, audit, or migration integrity.

## High Error Rate or Performance Degradation

- **Symptoms/detection:** Sustained 5xx, latency, saturation, connection, or slow-query alert.
- **Act/investigate:** Correlate by endpoint, release, dependency, tenant, and resource; capture bounded profiles/query plans where safe.
- **Recover/escalate:** Roll back regressions, scale within approved limits, or disable the affected feature. Do not hide errors or blindly raise limits.

## Security Incident or Secret Compromise

- **Symptoms/detection:** Unauthorized access, credential exposure, anomalous authentication/tool use, or integrity alert.
- **Act/investigate:** Engage Security Owner, contain access, preserve evidence, revoke affected credentials, and restrict traffic.
- **Recover/escalate:** Rotate secrets, rebuild from trusted artifacts, validate audit/data integrity, and follow legal/customer notification decisions. Never delete evidence during containment.
