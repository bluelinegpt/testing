# Tawseelhub Salla Integration

Status: **integration ready — real Salla test connection pending**.

This document describes the first real commerce provider adapter built on the existing Tawseelhub Commerce Integration Foundation. It does not create a separate Salla order system. Salla orders enter Tawseelhub through the shared commerce event ledger and become normal Tawseelhub Orders.

## What is implemented

- Salla provider registration in the existing provider router.
- OAuth start endpoint for authenticated Trader Portal users.
- OAuth callback endpoint for Salla authorization returns.
- Short-lived OAuth state table to protect callback state.
- Salla webhook signature verification using the raw request body and `X-Salla-Signature`.
- Salla order webhook normalization into the generic commerce order shape.
- Salla event mapping for created, updated, cancelled, app-authorized, and app-revoked events.
- COD vs prepaid detection.
- Customer, mobile, address, location, items, order number, amount, and currency mapping.
- Provider capability display in Trader Portal and Platform support views.
- Trader Portal “Connect Salla” action that redirects to the Salla authorization URL when Salla credentials are configured.

## What is intentionally not complete without real Salla access

- Real Salla sandbox/test-store authorization.
- Real test order import from a Salla store.
- Production secret-vault binding for actual access and refresh token material.
- Confirmed outbound status push to Salla.

Until those external pieces are available, do not mark the connector as “ACCEPTED — SALLA SANDBOX/TEST”.

## Configuration

Salla remains disabled by default:

```env
SALLA_INTEGRATION_ENABLED=false
SALLA_CLIENT_ID=
SALLA_CLIENT_SECRET=
SALLA_REDIRECT_URI=http://localhost:3000/api/v1/integrations/commerce/salla/oauth/callback
SALLA_WEBHOOK_SECRET=
```

Enable only after the Salla app/test store is ready:

```env
SALLA_INTEGRATION_ENABLED=true
```

## External Salla setup required

1. Create or obtain a Salla partner/developer app.
2. Configure the OAuth redirect URL:
   `http://localhost:3000/api/v1/integrations/commerce/salla/oauth/callback`
   for local testing, and the production API callback URL for live testing.
3. Request the required scopes:
   `orders.read orders.write webhooks.read_write offline_access`.
4. Configure webhooks to call:
   `/api/v1/integrations/commerce/salla/webhook/:connectionReference`
5. Use the same webhook secret in Salla and `SALLA_WEBHOOK_SECRET`.
6. Connect the test store from Trader Portal → Integrations → Connect Salla.
7. Create a real Salla test order.
8. Confirm the Platform event ledger shows the Salla event as succeeded or duplicate.
9. Confirm a normal Tawseelhub Order is created and linked through the commerce integration order link.

## Tawseelhub connect flow

Normal merchant setup is owned by the Trader Portal:

```text
Trader Portal
→ Integrations
→ Connect Salla
```

Platform Administration may monitor the resulting connection, inspect sanitized events, retry failed events after a mapping/configuration fix, and assist with support. Platform is not the normal place to initiate a merchant's Salla connection.

## Official Salla references used

- OAuth authorization and token endpoints: `https://docs.salla.dev/421118m0`
- Webhook verification and events: `https://docs.salla.dev/421119m0`
- Merchant API orders endpoint: `https://docs.salla.dev/5394146e0`
- Rate limiting behavior and headers: `https://docs.salla.dev/421125m0`

## Acceptance rule

Local code and fixture tests can only reach:

**INTEGRATION READY — REAL SALLA TEST CONNECTION PENDING**

Full acceptance requires a real Salla test store connection and a real Salla test order import.
