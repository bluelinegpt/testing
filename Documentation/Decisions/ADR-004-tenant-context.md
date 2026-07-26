# ADR-004: Tenant Context Foundation

## Status

Accepted as architecture; runtime enforcement is blocked pending the authoritative database schema, identity persistence, and membership model.

## Context

Company users must never select or switch tenants, and cross-tenant access is critical.

## Decision

Resolve tenant context from authenticated server-side membership. Require tenant-aware services and data access, explicit tenant context for jobs, and separate privileged Platform Administrator operations. Evaluate PostgreSQL RLS as defense in depth.

## Consequences

No client company ID can grant scope. Every tenant feature requires cross-tenant tests. Prompt 1 defines ports without an insecure default implementation.

## Alternatives Considered

- Client-selected tenant: prohibited by requirements.
- Database per tenant: rejected for Phase 1 operational complexity.
