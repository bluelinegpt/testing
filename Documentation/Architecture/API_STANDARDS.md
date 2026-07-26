# API Standards

## Versioning

Initial APIs use `/api/v1`. Add a new major path only for breaking contract changes. Additive compatible fields remain in the current version. Deprecation must be documented with migration guidance and a removal date.

Web and Flutter consume the same OpenAPI-described backend APIs. Persistence entities are never exposed directly.

## Requests

- JSON uses UTF-8 and camelCase names.
- Server-side validation is mandatory and rejects unknown fields.
- Request bodies are limited to 10 MB at the foundation level; individual endpoints should be stricter.
- Dates/times use ISO 8601. Timestamps are UTC; business dates are explicit date values.
- Money is serialized as fixed decimal strings, never binary floating-point numbers.
- Critical retryable commands will require an idempotency key.

## Responses

Successful single-resource responses return the resource DTO. Collections return `items` and an optional opaque `nextCursor`. Default page size is 25 and maximum is 100.

Filtering and sorting use documented allowlists. Unbounded lists and arbitrary database field sorting are prohibited.

## Errors

Errors use:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed.",
    "details": ["field must not be empty"],
    "correlationId": "request-correlation-id"
  }
}
```

Categories include validation, authentication, authorization, not found, conflict, concurrency conflict, rate limit, business rule violation, and internal error. Production errors never expose stack traces, SQL, paths, secrets, or security internals.

## HTTP Conventions

- `200`: successful query/update.
- `201`: resource created.
- `204`: successful command with no body.
- `400`: validation.
- `401`: unauthenticated.
- `403`: unauthorized.
- `404`: unavailable in the authorized scope.
- `409`: state/concurrency conflict.
- `429`: rate limit.
- `500`: safe unexpected error.
- `503`: dependency readiness failure.
