# Deprecated endpoint: `POST operations/orders/:orderId/reconcile-cash`

Status: **Deprecated — scheduled for removal**
Deprecated in: Driver Cash Reconciliation phase (July 2026)
Earliest removal: the release after the one that ships this phase

## What it is now

A compatibility wrapper only. It holds no financial logic of its own: it resolves
the Order's collected amount and delegates to
`DriverCashReconciliationService.confirm()`, so eligibility validation, row
locking, the Net Expected formula, idempotency, payment validation, status
changes, history and audit are identical to
`POST operations/cash/reconciliations/selected`.

Behaviour it gained when it became a wrapper:

- requires `reconciliations.create` (or the `users_roles.manage` fallback);
  previously it was reachable with `users_roles.manage` only
- accepts `x-idempotency-key` and reuses it across retries; a request-specific
  fallback key is generated only when a caller omits one
- Driver Payable Deduction is fixed at AED 0.00, matching the approved decision
- rejects a payment amount that does not equal Net Expected, where the original
  implementation silently used the Order's collected amount

Behaviour it lost, deliberately:

- the original per-Order float arithmetic
- the original absence of idempotency
- the ability to bypass expense and payment validation

## Why it still exists

No BluelineGPT web caller remains — the web application was migrated to the
new reconciliation workspace at `/operations/driver-reconciliations/new`, and the
old single-Order dialog and bulk reconcile action were removed. It is retained
for one compatibility release in case an external integration calls it, since we
have no telemetry proving otherwise.

## Removal criteria

Remove when **both** hold:

1. One full release has shipped with the endpoint marked deprecated.
2. There is evidence no external integration depends on it — either access-log
   review over the deprecation window, or written confirmation from the product
   owner that no third-party integration exists.

## Removal steps

1. Delete `reconcileOrderCash` from `apps/api/src/operations/operations.controller.ts`.
2. Delete `confirmSingleOrder` from
   `apps/api/src/operations/driver-cash-reconciliation.service.ts`.
3. Remove the legacy-wrapper cases from
   `apps/api/src/operations/driver-cash-reconciliation.database.test.ts` and
   `apps/api/src/operations/reconciliation-http.database.test.ts`.
4. Remove this document, or move it to a historical decisions archive.

No database migration is required; the endpoint owns no schema.

## Usage observability

The application already logs every request through `nestjs-pino` with the route
path, status and correlation ID, so calls to this endpoint are visible in the
existing request log without adding a new logging subsystem. No dedicated metric
was introduced.

To review usage over the deprecation window, filter the API request logs for:

```
req.url contains "/reconcile-cash"
```

## Constraint

Do not add new functionality to this endpoint. Any new reconciliation capability
belongs on `POST operations/cash/reconciliations/selected`.
