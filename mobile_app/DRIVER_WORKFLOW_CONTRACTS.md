# Driver Mobile Workflow Contracts

## Verified backend contracts

- `GET /portal/driver/orders` derives the Driver profile and Company from the authenticated session, restricts results to `assigned_driver_id`, includes only assigned, out-for-delivery, delivered and returned-to-branch Orders, sorts newest first, and limits results to 100.
- `PATCH /portal/driver/orders/{orderId}/status` re-verifies Company and Driver assignment, records blocked cross-Driver access, and permits Driver transitions from Assigned to Out for Delivery and from Out for Delivery to Delivered or Returned to Branch.
- The verified response contains safe delivery fields needed by the Driver. It does not expose Trader settlement or bank data.

The current transition DTO accepts only `status` and an optional 300-character reason. It does not persist payment method, Bank reference, actual COD supplied by the Driver, attempt reason codes, client action time, or an idempotency record. Although the mobile client sends an idempotency header, the endpoint does not currently document or persist it.

## Required Driver-safe contracts

Every endpoint must derive Driver and Company from the session, reject cross-Driver resources with 403/404, provide auditable conflict behavior, and never accept a Driver ID from the client.

| Capability             | Required backend behavior                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard              | Assigned/status counts, today metrics, COD split and limited activity with explicit unavailable sections                                      |
| Assigned Orders        | Cursor/page pagination, stable sort, status/Emirate/Area filters and bounded server search                                                    |
| Order detail/history   | Assigned-Driver scoped detail plus a paginated safe event timeline                                                                            |
| Start Delivery         | Persist idempotency key and original client action time; deterministic timeout recovery                                                       |
| Confirm Delivered      | Actual COD, Cash/Bank, conditional Bank reference, optional private Driver notes, version and idempotency; documented difference rules        |
| Failure reasons        | Active localized reason codes and visibility metadata                                                                                         |
| Delivery attempt       | Reason code, optional notes, action time, idempotency and current version without automatically cancelling                                    |
| Return instruction     | Operator-created instruction and Driver acknowledgment separate from final branch receipt unless the approved backend authority remains final |
| COD summary            | Server-calculated informational totals; no reconciliation mutation                                                                            |
| Offline sync           | Action status/recovery API, version conflict payload, expiry policy and server-time rules                                                     |
| Notifications/realtime | Driver-scoped inbox/read state and authorized Order payloads                                                                                  |
| Order conversation     | Driver-to-Office only; no Driver-to-Trader or Driver-to-Customer chat                                                                         |

No missing production behavior is simulated locally. Offline actions are not marked successful until confirmed by the server.
