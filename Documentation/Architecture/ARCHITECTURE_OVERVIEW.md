# Architecture Overview

## Purpose

BluelineGPT uses a TypeScript-first modular monolith for Phase 1: a NestJS API, React web application, future Flutter mobile application, and PostgreSQL. This keeps deployment simple while preserving explicit module ownership and future extraction options.

## Runtime Components

- `apps/api`: versioned backend API and all authoritative business rules.
- `apps/web`: responsive Platform, Company, and Trader web presentation.
- `apps/mobile`: Flutter boundary for Driver and Trader presentation, beginning in Prompt 15.
- PostgreSQL: sole persistent business database.
- Private object storage: future provider-neutral file persistence.
- Background jobs: future durable jobs for documents, expiry checks, reports, and notifications.

## Layers

1. Presentation parses requests, invokes application use cases, and formats safe responses.
2. Application coordinates use cases, authorization, transactions, and module contracts.
3. Domain owns invariants, calculations, and workflow policies without framework dependencies.
4. Infrastructure implements PostgreSQL, files, jobs, email, logging, and external integrations.
5. Shared contains narrowly reusable errors, time, money, pagination, and security contracts.

Dependencies flow inward. Domain never depends on presentation or infrastructure. Presentation does not access PostgreSQL directly.

## Foundation Implemented in Prompt 1

- `/api/v1` convention and development OpenAPI document.
- Central validation, errors, structured logging, correlation IDs, rate limiting, CORS, and security headers.
- PostgreSQL pool, readiness check, migration runner, and transaction manager.
- Decimal money value and testable clock.
- Tenant/identity, file-storage, and background-job ports.
- React shell with Arabic/English and RTL/LTR behavior.
- Workspace build, formatting, lint, type-checking, and tests.

No business modules or business database tables are implemented.

## Future Module Shape

Modules are added only by their approved prompts. A typical module contains `domain`, `application`, `infrastructure`, and `presentation` folders. Cross-module calls use application contracts or domain events; they do not read another module's tables directly.

## Deployment Direction

Phase 1 should deploy one API, one web application, one Flutter application, one PostgreSQL database, and provider-neutral supporting services. Cloud and production topology remain controlled by the Infrastructure Decision Gate.
