# ADR-002: Modular Monolith

## Status

Accepted.

## Context

Phase 1 contains many operational and financial domains but has no evidence requiring independent service deployment.

## Decision

Use one modular backend deployment with explicit domain/application/infrastructure/presentation boundaries and one PostgreSQL database.

## Consequences

Transactions and operations remain simpler. Module boundaries must be enforced in code review and tests. Future extraction remains possible through explicit contracts.

## Alternatives Considered

- Microservices: rejected as premature operational complexity.
- Single unstructured application: rejected because it encourages coupling and duplicated rules.
