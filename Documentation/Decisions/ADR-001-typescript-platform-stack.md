# ADR-001: TypeScript Platform Stack

## Status

Accepted by Project Owner on 2026-07-13.

## Context

The repository had no implementation stack. Requirements mandate PostgreSQL and Flutter; the Project Owner prefers React/TypeScript web and approved proceeding with a TypeScript backend.

## Decision

Use NestJS/TypeScript for the API, React/TypeScript for web, Flutter/Dart for mobile, PostgreSQL for persistence, and pnpm workspaces for JavaScript tooling.

## Consequences

Web and API share TypeScript expertise and tooling. Flutter remains a separate presentation technology. Backend business contracts remain API-based rather than shared UI code.

## Alternatives Considered

- ASP.NET Core: technically strong but not preferred by the Project Owner.
- Unstructured Node/Fastify application: lighter but provides fewer enforced module conventions.
