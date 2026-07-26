# Deployment Guide

## Current Status

BluelineGPT has no supported production deployment. The current repository is an engineering foundation and localized web shell. Do not expose it to production traffic or real customer data.

Reproducible container definitions and CI validation now exist, but they are preparation artifacts rather than evidence of an approved production environment.

## Release Gate

A production deployment requires all of the following evidence:

- Approved PostgreSQL schema, controlled migrations, backup and restore testing.
- Runtime tenant isolation, authentication, granular authorization, and security tests.
- Completed business modules and end-to-end tests for approved workflows.
- Managed secrets, TLS, private file storage, monitoring, alerting, and audit retention.
- CI release pipeline with dependency, static, integration, migration, and artifact checks.
- Capacity, recovery, user acceptance, and rollback validation in a production-like environment.
- A final release review that returns `READY` or `READY WITH CONDITIONS`.

## Foundation Artifact Checks

Until the release gate is satisfied, the repository can only produce development validation artifacts. Run `pnpm validate` to check formatting, linting, types, unit tests, and builds. Run `pnpm audit --prod` to check known production dependency vulnerabilities.

Run `pnpm ci:validate` for the full local CI gate. Docker is also required to validate `Dockerfile.api`, `Dockerfile.web`, and `compose.local.yaml`.

## Local Containers

1. Set a non-default local `POSTGRES_PASSWORD` in the shell or an uncommitted `.env`.
2. Run `docker compose -f compose.local.yaml build`.
3. Run `docker compose -f compose.local.yaml up -d`.
4. Run `pnpm smoke` after all services are healthy.
5. Stop services with `docker compose -f compose.local.yaml down`.

Do not use `compose.local.yaml` in staging or production. Do not add `-v` to the down command unless intentionally deleting disposable local PostgreSQL data.

## Controlled Production Sequence

When all release and infrastructure gates are approved: verify immutable artifacts and configuration, confirm a recent backup, run the reviewed migration as a one-off job, deploy the API and web images, verify liveness/readiness and critical workflows, and monitor the release window. Stop immediately on migration, readiness, security, or smoke-test failure.

Rollback application images to the last verified digest when no incompatible migration has committed. Database changes use an approved forward correction by default; restore is reserved for an authorized recovery decision.

## Configuration

Environment settings are documented in `Documentation/Operations/CONFIGURATION_REFERENCE.md`. Production secrets must be supplied by the future managed secret service and must never be committed, logged, or packaged with the application.

## Health Endpoints

- `/api/v1/health/live` verifies that the API process is responsive.
- `/api/v1/health/ready` verifies database readiness and returns `503` promptly when PostgreSQL is unavailable.

Liveness alone is not evidence that the application is ready to receive traffic.

See the CI/CD, migration, monitoring, backup/restore, disaster recovery, and runbook documents before enabling any deployment job.
