# BluelineGPT

BluelineGPT is a multi-tenant delivery management platform for UAE delivery companies. The repository contains the application foundation, PostgreSQL Phase 1 schema, and server-side authentication/RBAC foundation. Business modules remain under implementation and the product is not production-ready.

## Applications

- `apps/api`: NestJS versioned API foundation.
- `apps/web`: React and TypeScript administration portal with Arabic/English direction support.
- `apps/mobile`: Flutter boundary and preparation notes; no Flutter application exists yet.

## Platform Constraints

- PostgreSQL is the only production persistent database.
- Authenticated Company context and granular permissions are enforced server-side for protected API routes.
- Monetary values use decimal types; floating-point money is prohibited.
- Confirmed financial records are corrected through reversal or adjustment.
- Web and Flutter clients share versioned APIs and do not own business rules.

## Prerequisites

- Node.js 24
- pnpm 11
- PostgreSQL 18-compatible development server
- Flutter SDK for the future mobile implementation

## Quick Start

1. Copy `.env.example` to `.env` and replace placeholder values locally.
2. Install dependencies with `pnpm install`.
3. Start the API with `pnpm --filter @blueline/api dev`.
4. Start the web application with `pnpm --filter @blueline/web dev`.
5. Run all checks with `pnpm validate`.

Use `pnpm ci:validate` for formatting, linting, typing, tests, builds, supported secret signatures, migration naming, and production dependency audit. Local container instructions are in the deployment guide.

Before starting the API for the first time, run `pnpm --filter @blueline/api db:migrate`. The API fails startup when mandatory configuration is missing. Liveness can run independently, while readiness returns an error when PostgreSQL is unavailable.

## Current Limitations

- Authentication, revocable sessions, Company request context, identity-kind/RBAC guards,
  one-time platform bootstrap, and Company custom-role APIs exist. Account provisioning,
  password recovery delivery, and privileged-account MFA remain incomplete.
- Existing Company users can be listed, assigned active Company roles, unlocked, and
  deactivated with immediate session revocation and last-administrator protection.
- The PostgreSQL schema exists, but application repositories and business APIs are not yet implemented.
- The web portal currently covers Company login and Company user/role administration only;
  order, finance, trader, driver, and platform-administration screens remain unimplemented.
- Local/CI deployment definitions exist, but production infrastructure, the mobile application,
  and end-to-end business coverage remain incomplete.

## Documentation

- [Architecture overview](Documentation/Architecture/ARCHITECTURE_OVERVIEW.md)
- [Local development](Documentation/Development/LOCAL_DEVELOPMENT.md)
- [Configuration reference](Documentation/Operations/CONFIGURATION_REFERENCE.md)
- [Troubleshooting](Documentation/Operations/TROUBLESHOOTING.md)
- [Deployment gate](Documentation/Deployment/DEPLOYMENT_GUIDE.md)
- [Deployment architecture](Documentation/Architecture/DEPLOYMENT_ARCHITECTURE.md)
- [CI/CD guide](Documentation/Deployment/CI_CD_GUIDE.md)
- [Environment strategy](Documentation/Operations/ENVIRONMENT_STRATEGY.md)
- [Monitoring and alerting](Documentation/Operations/MONITORING_AND_ALERTING.md)
- [Backup and restore](Documentation/Operations/BACKUP_AND_RESTORE.md)
- [Disaster recovery](Documentation/Operations/DISASTER_RECOVERY_PLAN.md)
- [Production runbooks](Documentation/Operations/PRODUCTION_RUNBOOKS.md)
- [Production-readiness assessment](Documentation/Planning/PROMPT_15_PRODUCTION_READINESS_REPORT.md)
- [Production operations assessment](Documentation/Planning/PROMPT_16_PRODUCTION_OPERATIONS_REPORT.md)
- [Prompt 1 completion report](Documentation/Planning/PROMPT_1_COMPLETION_REPORT.md)

The approved requirements baseline is `Documentation/BluelineGPT_FINAL_MASTER_REQUIREMENTS_v3.0.docx`.
