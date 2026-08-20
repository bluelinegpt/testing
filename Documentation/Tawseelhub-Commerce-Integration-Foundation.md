# Tawseelhub Commerce Integration Foundation

This foundation creates a provider-independent way for external commerce stores to send shipment orders into Tawseelhub without creating a second operational order system.

## Architecture

- Commerce providers are registered through a provider router.
- Each provider exposes one normalized interface: capabilities, webhook verification, webhook parsing, health check, and outbound status push.
- Provider-specific payloads are translated into a normalized commerce order/event before Tawseelhub touches operational data.
- Accepted provider orders are imported into the normal `orders` table and linked through `commerce_integration_order_links`.
- Event intake, retries, diagnostics, and sanitized payload snapshots live in `commerce_integration_events`.

## Provider interface

Every adapter must implement:

1. provider key and label;
2. capability flags;
3. webhook signature verification;
4. webhook parsing into `NormalizedCommerceEvent`;
5. provider health check;
6. outbound status sync.

The active adapters are:

- `mock_commerce`, for local development/acceptance only;
- `salla`, enabled only when `SALLA_INTEGRATION_ENABLED=true`;
- `shopify`, enabled only when `SHOPIFY_INTEGRATION_ENABLED=true`;
- `woocommerce`, enabled only when `WOOCOMMERCE_INTEGRATION_ENABLED=true`.

WooCommerce uses the provider-approved REST API key model and connects from the authenticated Trader Portal, not Platform Administration.

## Capability model

Capabilities are explicit booleans:

- inbound orders;
- inbound order updates;
- inbound cancellations;
- outbound fulfillment/status;
- products/customers/inventory;
- webhooks/polling;
- OAuth/API key style auth.

The Trader Portal reads these flags for connection cards. Platform reads them only for diagnostics and provider readiness.

## Connection model

Connections belong to:

- Company;
- Trader;
- Trader Commerce profile;
- provider;
- external store identity.

The same Trader may have multiple stores and multiple providers. Active store uniqueness is protected by provider plus external store ID, not by provider alone.

## Ownership model

The Trader Portal owns normal store connection and lifecycle actions:

- connect Salla;
- connect Shopify;
- connect Mock Commerce in local/test only;
- view the Trader's own connected stores;
- request sync;
- disconnect/reconnect the Trader's own connection;
- maintain mapping fixes available to that Trader.

Trader Portal APIs derive Company, Trader, and Trader Commerce profile from the authenticated Trader session. Browser payloads must not be trusted for `companyId` or `traderId`.

Platform Administration is a support and monitoring console only. Platform users may view connections, inspect sanitized event logs, retry failed events, test health, force disconnect/reconnect for support, and manage mapping fixes. Platform should not present the normal Salla/Shopify connect flow, because that creates ownership ambiguity and lets an operator pick the Trader manually.

## Credentials model

Credential rows store credential kind and a secret reference. Secret material is not returned to API callers. Platform diagnostics show only safe state such as “credential configured,” health, and sanitized errors.

The Mock provider uses deterministic local signing from the connection reference and does not require real credentials.

Salla and Shopify use OAuth plus signed webhooks. The database stores credential references only; access tokens, refresh tokens where applicable, app secrets, and webhook secrets must stay in the configured secret store or environment, never in Platform payloads.

## Webhook flow

1. Provider sends a webhook to `/integrations/commerce/:provider/webhook/:connectionReference`.
2. Tawseelhub resolves Company and Trader from the secure connection reference.
3. The provider verifies the signature.
4. Invalid signatures create a rejected diagnostic event and do not process an order.
5. Valid payloads are normalized and recorded in the event ledger.
6. Processing imports, updates, cancels, or records the event.

Webhook callers cannot choose internal Company or Trader IDs.

## Event idempotency

The ledger enforces one event per `(connection_id, external_event_id)`. Replays are accepted as duplicates and do not create another Tawseelhub Order.

Order imports are also protected by `(connection_id, external_order_id)` in `commerce_integration_order_links`, so a new duplicate create event for the same external order is ignored.

## Canonical Order mapping

Imported orders become normal Tawseelhub Orders:

- Company and Trader come from the connection.
- Area is resolved from Tawseelhub Area data or manual area mappings.
- COD is mapped to the normal COD/payable fields.
- Service fee is intentionally zero with an explicit override reason until pricing rules are expanded for commerce imports.
- The external order reference is saved in the link table and searchable metadata.
- Delivery starts as normal `new`.

Driver assignment, settlement, reporting, and operational handling remain the existing Tawseelhub workflows.

## Retry and mapping model

Mapping or processing failures are retained in the event log with a safe error code/message. Platform staff can add an area mapping and retry the failed event.

Mock acceptance includes:

- external area `Aweer`;
- mapping it to Tawseelhub Area `Al Aweer`;
- retrying the failed event.

## Mock Provider testing

The Mock Provider supports development-only actions:

- connect mock store;
- send order created;
- replay same event;
- send order update;
- send order cancellation;
- send invalid signature;
- send mapping failure;
- send provider timeout;
- send processing failure;
- retry failed event;
- set health degraded/healthy;
- disconnect/reconnect;
- outbound delivered status.

Mock provider is disabled in production.

## Future adapter guide

Salla and Shopify now follow this adapter path. For WooCommerce, implement only the adapter behind this interface:

1. register provider metadata and capabilities;
2. add auth/connect flow;
3. store credentials as secret references;
4. verify provider webhooks;
5. translate events into `NormalizedCommerceEvent`;
6. normalize orders into canonical Tawseelhub fields;
7. implement outbound status push;
8. add provider-specific unit tests and replay/idempotency tests.

Do not add provider-specific order tables, separate settlement workflows, or separate driver workflows.
