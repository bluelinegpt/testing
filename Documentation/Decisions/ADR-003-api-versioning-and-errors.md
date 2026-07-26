# ADR-003: API Versioning and Error Contract

## Status

Accepted.

## Context

Web and Flutter require stable shared APIs and safe consistent errors.

## Decision

Use REST/JSON under `/api/v1`, OpenAPI documentation, cursor-capable pagination, fixed decimal strings for money, and the standard safe error envelope documented in API standards.

## Consequences

Breaking changes require a new major path. Clients can generate typed contracts. Errors remain supportable through correlation IDs without exposing internals.

## Alternatives Considered

- Header-only versioning: less visible and unnecessary for the initial system.
- GraphQL: no requirement justifies the additional complexity.
