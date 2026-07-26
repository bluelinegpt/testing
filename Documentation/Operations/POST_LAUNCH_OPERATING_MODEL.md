# Post-Launch Operating Model

## Current Status

BluelineGPT has not passed release acceptance and is not launched. There are no production
customers, support cases, service metrics, adoption records, customer-health results,
feedback records, or operational service commitments. This document separates controls
that exist from decisions and systems still required.

## Current Service Surface

Implemented operational signals are API liveness, PostgreSQL-backed API readiness, web
health, structured API logs, correlation IDs, safe error responses, secret scanning,
dependency auditing, build/test gates, and provider-neutral deployment, monitoring,
backup, recovery, and troubleshooting guidance.

The customer-facing delivery service is not operational because the business schema,
authentication, Company isolation, and delivery workflows are absent. Support can currently
diagnose only foundation startup, web availability, API availability, and database
readiness.

## Critical Customer Journeys

The requirements identify these future critical journeys:

1. Company activation and authenticated access.
2. Company configuration, Areas, Traders, and Drivers.
3. Manual and Excel Order creation.
4. Driver assignment, delivery, failure, and return.
5. Driver cash reconciliation and Trader settlement.
6. Reports, exports, waybills, tracking, and Arabic/English operation.

Every journey is currently blocked and must be accepted before it can become a supported
service journey.

## Issue Intake and Support Cases

No intake channel or support-case store exists. `B-008` requires approval of channels,
ownership, access, classification, escalation, communication, retention, and service
commitments before implementation.

Any future case must be Company-scoped, use synthetic or minimized diagnostic data, avoid
secrets and unnecessary personal/financial data, retain an audit trail, and prevent search,
export, attachment, and elevated-access leakage across Companies. Support personnel must
not receive direct database or production access by default.

## Incident and Problem Records

Until an approved system exists, an authorized incident record must retain:

- Identifier, environment, detected time/source, affected service and known impact.
- Correlation, release, schema, and alert identifiers without secrets.
- Timeline, containment, recovery, validation, communication decisions, and approvers.
- Evidence locations, linked support cases, follow-up actions, owners, and due dates.

Root-cause analysis must distinguish trigger, contributing conditions, detection/control
gaps, customer/financial/security/data impact, and corrective/preventive actions. A review
must be blameless, evidence-based, and must not expose customer data.

Severity, priority, status, escalation timing, notification obligations, role names, and
closure authority remain unapproved under `B-008`.

## Service Health and Customer Impact

Current health proves process/web/database reachability only. It does not prove login,
Company isolation, Order processing, financial correctness, jobs, integrations, or customer
success. Future customer-impact detection requires Company-safe telemetry for critical
journeys, failed jobs/imports/webhooks, financial exceptions, data-quality failures, and
security events. No raw customer payload should become a metric label or alert field.

## Adoption, Feedback, and Continuous Improvement

No usage or outcome telemetry exists. Adoption, time-to-value, customer health, retention,
and satisfaction must not be scored until their definitions, lawful data use, ownership,
and decision purpose are approved. Product feedback and defects should use the existing
change-control process with source, evidence, Company-safe context, impact, decision,
release link, and closure outcome.

## Operational Review Gate

A post-launch review becomes meaningful only after release acceptance and production
evidence exist. It must review service health, incidents, support demand, security and
privacy, financial and data-quality exceptions, backups/restores, capacity, release
outcomes, customer feedback, unresolved risks, and improvement actions. Targets and cadence
require approval; documentation alone is not operational evidence.
