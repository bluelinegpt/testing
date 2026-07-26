# ADR-006: Provider-Neutral Private File Storage

## Status

Accepted as architecture; provider selection remains open.

## Context

BluelineGPT stores sensitive driver documents and other attachments while the cloud provider is undecided.

## Decision

Business modules depend on a private `FileStoragePort`. PostgreSQL stores metadata; provider storage holds bytes. Authorization, validation, and auditing surround access.

## Consequences

Cloud selection does not leak into business modules. A production provider is deferred to the Infrastructure Decision Gate.

## Alternatives Considered

- Public URLs: rejected as insecure.
- Database binary storage: rejected for operational and scaling concerns.
