# Multi-Tenancy Strategy

## Implementation Status

This document records the accepted target architecture. It is not evidence of implemented isolation. The repository currently has only foundation contracts; it has no company, membership, authentication, tenant-owned business schema, scoped repository, or cross-company integration test. Business endpoints must not be exposed until those controls exist and pass two-company security tests.

## Model

Use a shared PostgreSQL database/shared schema with mandatory `company_id` on every tenant-owned record. Platform-owned records remain outside normal tenant operations.

## Identity to Tenant

- Normal tenant context is resolved from the authenticated server-side identity and membership.
- Company users, Traders, and Drivers do not choose or switch companies.
- Client-supplied company identifiers never establish authorization.
- Platform Administrator actions use an explicit privileged context and enhanced audit.

## Foundation Port

`TenantContextAccessor` defines how future request and job scopes provide `companyId` and `identityId`. Prompt 1 intentionally provides no insecure fallback context. Runtime identity-to-company resolution and enforcement remain blocked by the missing persistence model.

## Data Rules

- Tenant-owned keys and foreign keys include `company_id` where needed.
- Tenant-aware unique indexes prevent cross-company collisions without global leakage.
- Repositories require tenant scope and apply it by construction.
- PostgreSQL row-level security is evaluated in Prompt 2/3 as defense in depth.
- Background jobs persist and restore tenant context explicitly.
- Cache and object-storage keys include tenant scope.

## Public and Platform Contexts

Public tracking uses a separate minimal query path keyed by random revocable tokens. It is not a general tenant bypass. Platform operations are separate commands with explicit permissions and audit events.

## Required Tests

Every tenant-owned feature creates tenants A and B and attempts cross-tenant reads, writes, references, list filtering, reports, exports, files, jobs, and guessed identifiers. Tests must fail closed.
