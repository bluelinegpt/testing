# Infrastructure Decision Gate

Production infrastructure must not be implemented until the Project Owner approves the decisions tracked in `Documentation/Planning/INFRASTRUCTURE_DECISION_CHECKLIST.md`.

## Required Approval Areas

- Cloud provider, deployment region, and data residency.
- Application, PostgreSQL, object storage, DNS/subdomains, and TLS.
- Backup frequency/retention, RPO, RTO, uptime, high availability, and disaster recovery.
- Monitoring, logging, alerting, incident ownership, and cost controls.
- Secret management, encryption, administrative access, scanning, and patching.
- Email and future messaging providers.
- Deployment, rollback, migration, and restore-test processes.

## Gate Evidence

Each decision requires an owner, date, rationale, security/data impact, cost, implementation plan, and validation evidence. Prompt 1 local development does not imply a production-provider choice.
