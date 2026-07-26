# Infrastructure Decision Checklist

## Gate Rule

Version 3.0 requires these decisions before production infrastructure implementation. Prompt 0 does not select a cloud provider or deploy infrastructure.

## Hosting and Residency

- [ ] Approve cloud provider.
- [ ] Approve primary deployment region.
- [ ] Confirm UAE/customer contractual data-residency requirements.
- [ ] Select application hosting model.
- [ ] Select managed PostgreSQL offering and supported version.
- [ ] Select private object-storage service and region.
- [ ] Decide environment topology: development, test, staging, production.
- [ ] Decide tenant subdomain and DNS model.
- [ ] Confirm custom-domain policy, if any.

## Availability and Recovery

- [ ] Approve uptime target and maintenance-window policy.
- [ ] Approve database backup frequency and retention.
- [ ] Approve object-storage versioning/backup policy.
- [ ] Approve RPO.
- [ ] Approve RTO.
- [ ] Approve high-availability and failover design.
- [ ] Approve disaster-recovery region/site strategy.
- [ ] Define restore-test frequency and evidence owner.
- [ ] Define incident severity and escalation contacts.

## Security

- [ ] Select secret-management service and rotation process.
- [ ] Define encryption at rest and key ownership/rotation.
- [ ] Define TLS certificate issuance and renewal.
- [ ] Define network boundaries, ingress, egress, firewall/WAF needs.
- [ ] Define administrative access and break-glass controls.
- [ ] Approve identity provider/service for application authentication if external.
- [ ] Reconfirm MFA exclusion and privileged-account compensating controls.
- [ ] Select upload malware/content scanning approach.
- [ ] Define vulnerability scanning and patch timelines.
- [ ] Define audit/security/financial/document retention periods.

## Operations and Observability

- [ ] Select centralized structured logging.
- [ ] Select metrics and tracing.
- [ ] Define dashboards for availability, latency, errors, PostgreSQL, jobs, storage, and security.
- [ ] Define alerts, thresholds, on-call recipient, and escalation.
- [ ] Define log redaction and access controls.
- [ ] Define environment configuration management.
- [ ] Define deployment strategy and rollback.
- [ ] Define database migration execution and rollback ownership.
- [ ] Define capacity review and cost monitoring.

## External Services

- [ ] Select transactional email provider and sender-domain controls.
- [ ] Define map/navigation provider and API-key restrictions.
- [ ] Define future SMS provider decision gate.
- [ ] Define future WhatsApp provider decision gate.
- [ ] Define international-delivery integration approach when APIs enter scope.

## Governance Evidence

- [ ] Record each decision in an approved ADR or infrastructure decision record.
- [ ] Record owner, date, rationale, cost, security impact, and exit/review criteria.
- [ ] Validate backup restore and disaster recovery before release.
- [ ] Validate production access, secrets, monitoring, alerting, and rollback before go-live.

## Current Status

All checklist items are OPEN. This does not block Prompt 1 local foundation work. It blocks production infrastructure implementation and final release readiness.
