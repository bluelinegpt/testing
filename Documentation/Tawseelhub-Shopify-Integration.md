# Tawseelhub Shopify Integration

Status: **integration ready — real Shopify test connection pending**.

This connector uses the existing Tawseelhub Commerce Integration Foundation. It does not create a separate Shopify Orders system: accepted Shopify order events become normal Tawseelhub Trader Orders and then continue through the existing delivery, Driver, COD, accounting, settlement, and reporting workflows.

## Shopify API target

- Admin API version: `2026-07`, configured by `SHOPIFY_ADMIN_API_VERSION`.
- OAuth model: Shopify authorization-code grant for an embedded/public app style install. Offline access tokens are returned by the normal token exchange and do not use refresh tokens for this flow.
- Admin API approach: GraphQL Admin API for shop identity and webhook subscription registration.
- Webhook verification: `X-Shopify-Hmac-SHA256`, calculated as Base64 HMAC-SHA256 of the raw request body using the Shopify app client secret, with an optional `SHOPIFY_WEBHOOK_SECRET` override.
- Callback verification: Shopify callback `hmac` is verified by removing `hmac`/`signature`, sorting remaining query parameters, joining them as `key=value`, and checking HMAC-SHA256 hex with the client secret.
- Webhook topics registered: `ORDERS_CREATE`, `ORDERS_UPDATED`, `ORDERS_CANCELLED`, `APP_UNINSTALLED`.
- Rate limit model: Shopify GraphQL Admin API uses query-cost throttling/leaky bucket behavior. Any future manual sync should stay bounded and retry only after safe backoff.
- Fulfillment model: Shopify’s current fulfillment flow is based on Fulfillment Order objects and `fulfillmentCreate`; direct obsolete fulfillment assumptions must not be used.

## Configuration

Shopify remains disabled by default:

```env
SHOPIFY_INTEGRATION_ENABLED=false
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
SHOPIFY_REDIRECT_URI=http://localhost:3000/api/v1/integrations/commerce/shopify/oauth/callback
SHOPIFY_ADMIN_API_VERSION=2026-07
SHOPIFY_WEBHOOK_CALLBACK_BASE_URL=http://localhost:3000
SHOPIFY_WEBHOOK_SECRET=
```

Enable only after a Shopify development app and test store are ready:

```env
SHOPIFY_INTEGRATION_ENABLED=true
```

For local OAuth/webhooks, Shopify usually requires a publicly reachable HTTPS URL. Use Render staging, an approved secure tunnel, or Shopify development tooling. Do not expose a random local development machine insecurely.

## Requested scopes

The connector requests the minimum current scopes needed by the implemented flow:

- `read_orders` — import Shopify orders and order updates.
- `read_fulfillments` — inspect fulfillment state/fulfillment orders before outbound sync.
- `write_fulfillments` — prepare delivered-status fulfillment synchronization.

Product and inventory synchronization are intentionally deferred.

## Connect flow

1. Platform user opens Platform → Commerce Integrations.
2. User selects the Tawseelhub Company/Trader commerce relationship.
3. User enters the Shopify store domain, for example `example.myshopify.com`.
4. Tawseelhub normalizes and validates that it is a legitimate `*.myshopify.com` domain.
5. Tawseelhub creates a random one-time OAuth state linked server-side to the intended Company/Trader/Profile.
6. User authorizes the app in Shopify.
7. Tawseelhub validates state and Shopify callback HMAC.
8. Tawseelhub exchanges the code for an access token.
9. Tawseelhub confirms the stable Shopify shop identity through the GraphQL Admin API.
10. Tawseelhub registers the required webhooks.
11. The connection is marked Connected only after verification succeeds.

## Order mapping

Shopify events are normalized into the generic commerce event/order shape:

- external ID: stable Shopify order ID / GraphQL GID;
- external reference: Shopify order name such as `#1001`;
- customer: shipping name, order customer, email/contact email, and phone where present;
- guest checkout: supported; no Shopify customer account is required;
- shipping address: shipping address is preferred; billing is only used as a documented fallback if shipping is absent;
- UAE area: city/province/address detail is mapped through the existing Tawseelhub area mapping and retry model;
- international/unsupported currency: non-AED currently fails safely for manual mapping/review rather than silent FX conversion;
- COD: detected from configured/provider payment gateway names such as Cash on Delivery/COD, not from order total alone;
- prepaid: COD becomes `0`;
- discounts/tax/shipping charge: Shopify customer-facing sale amounts are kept separate from Tawseelhub delivery service fees;
- items: product ID, SKU, title, quantity, and grams-to-kg weight snapshot where available;
- package count: defaults to Tawseelhub’s current import default and does not assume every line item quantity is a physical package.

## Platform behavior

Platform → Commerce Integrations shows Shopify as a real provider when enabled. It can:

- start Shopify OAuth;
- show Shopify connections in the same connection table as Salla/Mock;
- show status, health, last webhook/success/error, imported order count, and failed event count;
- test health using the existing connection health action;
- disconnect/reconnect while preserving historical orders/events;
- use the existing event retry/area mapping workflow.

## Security rules

- Webhooks without a valid Shopify HMAC are rejected and cannot create/update/cancel orders.
- OAuth state is random, short-lived, one-time use, and server-side linked to the intended Tawseelhub Trader context.
- Shopify shop identity is verified after token exchange; the mutable display name is not used as the stable identity.
- The same active Shopify shop cannot be connected to conflicting Tawseelhub Traders because uniqueness is provider plus external store identity.
- Access tokens and secrets are not returned to Platform UI/API payloads.

## External Shopify setup required

1. Create a Shopify Partner/development app.
2. Configure redirect URL:
   `http://localhost:3000/api/v1/integrations/commerce/shopify/oauth/callback`
   for local testing, or the Render/staging equivalent for HTTPS testing.
3. Configure app scopes:
   `read_orders,read_fulfillments,write_fulfillments`.
4. Configure `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_REDIRECT_URI`, `SHOPIFY_WEBHOOK_CALLBACK_BASE_URL`, and enable `SHOPIFY_INTEGRATION_ENABLED=true`.
5. Connect a Shopify development store from Platform → Commerce Integrations → Connect Shopify.
6. Create a test COD order.
7. Create a prepaid test order.
8. Create a guest checkout test order.
9. Verify each imported event creates or updates exactly one normal Tawseelhub Order.
10. Replay a webhook and confirm it is duplicate-safe.
11. Test disconnect/reconnect and app uninstall.

## Deferred until real Shopify credentials/store access

- Real Shopify development-store authorization.
- Real webhook delivery from Shopify.
- Real COD/prepaid/guest/discount order browser acceptance.
- Real manual sync against Shopify order cursors.
- Real fulfillment-order lookup and `fulfillmentCreate` execution when a Tawseelhub Order is delivered.
- Persistent secure token material retrieval from the final secret-vault implementation. The database already stores secret references, not secret values.
- Inventory sync, full product/catalog sync, Shopify Billing, and marketplace/storefront scope.

## Acceptance rule

Local implementation and fixture tests can only reach:

**INTEGRATION READY — REAL SHOPIFY TEST CONNECTION PENDING**

Full acceptance requires a real Shopify development/test store connection and at least one real Shopify test order imported into Tawseelhub as one canonical normal Order through the Generic Commerce Integration Foundation.
