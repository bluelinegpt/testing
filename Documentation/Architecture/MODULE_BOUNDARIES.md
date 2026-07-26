# Module Boundaries

## Allowed Dependencies

- Presentation -> Application and presentation contracts.
- Application -> Domain, module ports, and narrow shared abstractions.
- Infrastructure -> Application ports, Domain mappings, and provider libraries.
- Domain -> Domain and narrow framework-free shared types only.

## Forbidden Dependencies

- Domain -> NestJS, React, Kysely, PostgreSQL, HTTP, storage SDKs, or job libraries.
- Presentation -> database clients or business-table queries.
- One module -> another module's infrastructure or tables.
- Web/Flutter -> authoritative business formulas or permission decisions.
- Shared -> feature-specific concepts.

## Module Ownership

Each module owns its state, use cases, API surface, migration changes, tests, and documentation. Shared tables or services require an ADR and explicit owner.

## Communication

- Synchronous: typed application services, commands, queries, or approved internal contracts.
- Asynchronous: durable post-commit jobs/events with tenant context and idempotency keys.
- Database: no uncontrolled cross-module table access; reporting projections are approved explicitly.

## Enforcement

- TypeScript import rules and architecture tests will be introduced as modules appear.
- Code review checks dependency direction and module ownership.
- Circular dependencies are prohibited.
- A growing `common` or `shared` folder must be challenged before adding content.
