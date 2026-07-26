# Backup and Restore

## Status

No managed backup service is implemented because no production PostgreSQL or object-storage provider exists. On 2026-07-13, the local procedure mechanics were validated with an isolated PostgreSQL 18.4 cluster and synthetic data: a custom-format backup was restored into a separate database and verified as two rows totaling `31.00`. The temporary cluster was then removed.

This proves only that the local PostgreSQL tools can complete a basic backup/restore cycle. It does not validate provider backups, encryption, retention, point-in-time recovery, the absent BluelineGPT schema, tenant isolation, financial reconciliation, or production RPO/RTO.

## Required Backup Policy

- Use the selected managed PostgreSQL service's encrypted automated backups and point-in-time recovery.
- Keep backups in a separate access boundary from application runtime credentials.
- Encrypt in transit and at rest; restrict restore/delete permissions to named recovery operators.
- Back up future private object storage with versioning or an approved equivalent.
- Store infrastructure configuration as reviewed code; store secrets in the managed secret service, not backup archives or source control.
- Monitor backup success, age, retention, capacity, and deletion events.

Recommended planning targets, pending owner approval: continuous/PITR database protection with an RPO of at most one hour, daily retained recovery points for at least 35 days, and quarterly non-production restore exercises. These are proposals, not commitments.

## Restore Procedure

1. Incident Commander and Database Owner authorize the target environment, recovery point, scope, and expected data loss.
2. Prove the destination is non-production unless a production overwrite is explicitly authorized through the incident process.
3. Verify backup metadata, encryption access, checksum/provider integrity status, and the matching application/schema version.
4. Restore into an isolated database with network access restricted to recovery operators.
5. Apply only approved migrations required by the selected application version.
6. Validate migration history, constraints, representative row counts, tenant boundaries, financial totals, and critical queries.
7. Deploy the matching application image and run readiness, smoke, security, and critical workflow tests.
8. Record elapsed time, recovered point, validation evidence, discrepancies, and approval before traffic cutover.
9. Rotate exposed credentials and preserve incident evidence when compromise is suspected.

Never test restoration by overwriting production. A successful provider job is not sufficient; application-level validation and documented evidence are required.
