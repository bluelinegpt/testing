# Tawseelhub WooCommerce Integration

## Official API approach

Tawseelhub uses the WooCommerce REST API namespace `wc/v3`.

The Trader supplies WooCommerce REST API credentials generated inside WooCommerce. Tawseelhub does not ask for a WordPress administrator password, WooCommerce administrator password, hosting password, or cPanel password.

Connection uses:

- Store URL, normally `https://shop.example.com`;
- Consumer Key;
- Consumer Secret;
- WooCommerce REST API `wc/v3`;
- HTTPS in production;
- WooCommerce webhooks delivered to the generic Tawseelhub commerce webhook endpoint.

WooCommerce webhook signatures are verified with `X-WC-Webhook-Signature`, which is an HMAC-SHA256 signature over the raw request body encoded as Base64. Invalid signatures are rejected and do not create or update Tawseelhub Orders.

## Trader setup

In WooCommerce Admin:

1. Open `WooCommerce → Settings → Advanced → REST API`.
2. Create a REST API key for the store.
3. Use Read/Write permission when Tawseelhub needs webhook creation and future status sync. Read-only is not enough for automated webhook setup.
4. Copy the Consumer Key and Consumer Secret once.

In Tawseelhub Trader Portal:

1. Open `Integrations`.
2. Choose `WooCommerce`.
3. Enter Store URL, Consumer Key, and Consumer Secret.
4. Click `Connect WooCommerce`.

After save, Tawseelhub never shows the Consumer Secret again. Platform Administration also never displays credentials.

## Store URL and SSRF protection

Production connection requires HTTPS. The API rejects:

- `javascript:` and `data:` URLs;
- malformed URLs;
- localhost;
- loopback addresses;
- private RFC1918 networks;
- link-local addresses;
- cloud/internal-style local hostnames;
- redirects during connection tests.

Local/private WooCommerce test URLs are allowed only outside production and only when explicitly enabled with `WOOCOMMERCE_ALLOW_PRIVATE_STORE_URLS=true`.

## Connection test

Before a connection is marked Connected/Healthy, Tawseelhub:

1. normalizes the store origin;
2. checks the host is safe for server-side outbound requests;
3. calls a lightweight WooCommerce REST API endpoint using the supplied Consumer Key/Secret;
4. verifies credentials and API availability;
5. creates WooCommerce webhooks for order events;
6. stores only credential references in the generic commerce credentials table;
7. creates a normal commerce integration connection owned by the authenticated Trader.

The browser never sends internal Company ID or Trader ID as proof of ownership. The API derives them from the Trader login session.

## Webhooks

Tawseelhub creates WooCommerce webhooks for:

- `order.created`;
- `order.updated`;
- `order.deleted`.

All webhooks use the existing generic endpoint:

`/api/v1/integrations/commerce/woocommerce/webhook/:connectionReference`

The webhook secret is generated per connection from server-side secret material and the connection reference. It is not shown to the Trader or Platform user.

## Order mapping

WooCommerce Orders become normal Tawseelhub Trader Orders. There is no `woocommerce_orders` business order table.

The WooCommerce provider adapter maps:

- WooCommerce Order ID as canonical external machine identity;
- WooCommerce Order number as human-visible external reference;
- billing/shipping customer name, mobile, and email;
- shipping address first, billing only as fallback;
- country, state, city, postcode, address lines;
- payment method and title;
- currency;
- final WooCommerce total for COD amount when payment is COD;
- zero COD for prepaid orders;
- product ID / variation ID / SKU / item name / quantity snapshots.

Tawseelhub delivery fee remains controlled by Tawseelhub pricing rules. WooCommerce shipping charges, taxes, discounts, coupons, and fees are not converted into Tawseelhub service fees.

## COD and payment mapping

Default COD detection recognizes common WooCommerce COD labels such as:

- `cod`;
- `Cash on Delivery`;
- Arabic cash-on-delivery phrases.

Custom gateway mapping is still a configuration extension. Until configured, unknown payment methods are treated as prepaid/non-COD rather than assumed collectible cash.

## Location and area mapping

WooCommerce `shipping.state`, `shipping.city`, and address fields are normalized into the generic commerce location fields. If the area cannot be matched to Tawseelhub Area data, the generic event ledger records a safe mapping failure. Trader or Platform can add an area mapping and retry the failed event.

## Status mapping

Initial mapping:

- `order.created` creates a Tawseelhub Order when the normalized payload is eligible.
- `order.updated` updates the linked Tawseelhub Order only when the canonical lifecycle permits it.
- `order.deleted`, `cancelled`, `refunded`, `failed`, or `trash` map to a cancellation event.

Delivered outbound status is not enabled by default because WooCommerce `completed` can mean different things for different merchants. Merchant-specific outbound status mapping must be explicitly configured before Tawseelhub changes WooCommerce order status.

## Platform Administration

Platform Administration is monitor/support only:

- view connected WooCommerce stores after a Trader connects them;
- inspect health;
- inspect sanitized event logs;
- retry failed events;
- assist with mappings;
- force disconnect/reconnect for support.

Platform does not normally initiate WooCommerce connections.

## Common errors

- `woocommerce_https_required`: production Store URL must use HTTPS.
- `woocommerce_store_url_private`: URL points to localhost/private/internal network.
- `woocommerce_store_dns_failed`: DNS lookup failed.
- `woocommerce_api_unauthorized`: Consumer Key/Secret rejected or permissions insufficient.
- `woocommerce_api_unavailable`: WooCommerce REST API could not be reached.
- `woocommerce_redirect_not_allowed`: connection test returned a redirect.
- `woocommerce_webhook_base_url_not_configured`: API public callback base URL is missing.
- `woocommerce_webhook_secret_not_configured`: server webhook secret seed is missing.
- `woocommerce_webhook_setup_failed`: API credentials were valid, but webhooks could not be created.

## Deferred

- Full catalog sync;
- inventory sync;
- custom payment-method mapping UI;
- configurable outbound WooCommerce status mapping;
- scheduled historical reconciliation;
- real secret-store retrieval for later manual sync from saved credentials.
