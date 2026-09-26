# Tawseelhub Public API

Base path:

```text
/api/v1
```

Test/staging API currently used by Render test services:

```text
https://bluelinegpt-api-test.onrender.com/api/v1
```

Local development:

```text
http://localhost:3000/api/v1
```

Use JSON requests with `Content-Type: application/json`.

## Health

### Live

```http
GET /api/v1/health/live
```

### Ready

```http
GET /api/v1/health/ready
```

These endpoints are public-safe health checks. They should not be treated as a dependency-detail status page.

## Send a Package quote

### Create quote request

```http
POST /api/v1/public/customer-quotes
```

Creates a public customer quote request and returns a `QTE-...` reference plus an access token for result access.

Important fields:

- requester: `requesterName`, `requesterMobile`, optional `requesterEmail`
- pickup contact: `pickupContactName`, `pickupMobile`
- recipient: `recipientName`, `recipientMobile`
- pickup route: `pickupCountryCode`, `pickupCountryName`, `pickupEmirate`, `pickupArea`, `pickupCity`, `pickupDistrict`, `pickupAddress`
- delivery route: `deliveryCountryCode`, `deliveryCountryName`, `deliveryEmirate`, `deliveryArea`, `deliveryCity`, `deliveryDistrict`, `deliveryAddress`
- package: `packageType`, `description`, `weightKg`, `lengthCm`, `widthCm`, `heightCm`, `quantity`
- service: `requestedServiceType`, `pickupDate`, optional `pickupTimeWindow`
- COD: `codRequired`, `codAmount` when COD is required
- value: optional `declaredValue`, `declaredValueCurrency`, `quoteCurrency`
- consent: `goodsConfirmation`
- attribution: `landingPage`, `referrer`, UTM fields, `gclid`

Supported emirate codes:

```text
abu_dhabi, dubai, sharjah, ajman, umm_al_quwain, ras_al_khaimah, fujairah
```

Supported package types:

```text
document, small_parcel, medium_parcel, large_parcel, box, fragile_item, food, electronics, clothing, other
```

Supported service types:

```text
standard, same_day, express
```

COD restrictions:

- COD amount is required only when `codRequired` is true.
- International/COD availability depends on the actual quote workflow and provider/company capability. Do not assume COD is available for every international shipment.

### UAE example

```json
{
  "requesterName": "Sample Customer",
  "requesterMobile": "+971501112222",
  "requesterEmail": "customer@example.com",
  "pickupCountryCode": "AE",
  "pickupCountryName": "United Arab Emirates",
  "pickupEmirate": "ajman",
  "pickupArea": "Al Rashidiya",
  "pickupAddress": "Sample pickup building, Ajman",
  "pickupContactName": "Sample Customer",
  "pickupMobile": "+971501112222",
  "deliveryCountryCode": "AE",
  "deliveryCountryName": "United Arab Emirates",
  "deliveryEmirate": "dubai",
  "deliveryArea": "Business Bay",
  "deliveryAddress": "Sample delivery tower, Dubai",
  "recipientName": "Sample Recipient",
  "recipientMobile": "+971502223333",
  "packageType": "small_parcel",
  "description": "Small package",
  "weightKg": 1,
  "lengthCm": 25,
  "widthCm": 20,
  "heightCm": 10,
  "quantity": 1,
  "requestedServiceType": "standard",
  "pickupDate": "2026-08-25",
  "codRequired": false,
  "specialHandlingFlags": [],
  "declaredValue": 100,
  "declaredValueCurrency": "AED",
  "quoteCurrency": "AED",
  "goodsConfirmation": true,
  "landingPage": "/send-package"
}
```

Typical response shape is business-result oriented and includes a `QTE-...` reference and access token. Exact pricing/result fields may differ depending on whether the route receives instant offers or requires manual quotation.

### International example

```json
{
  "requesterName": "Sample Customer",
  "requesterMobile": "+971501112222",
  "pickupCountryCode": "AE",
  "pickupCountryName": "United Arab Emirates",
  "pickupEmirate": "dubai",
  "pickupArea": "JLT",
  "pickupAddress": "Sample pickup address, Dubai",
  "pickupContactName": "Sample Customer",
  "pickupMobile": "+971501112222",
  "deliveryCountryCode": "GB",
  "deliveryCountryName": "United Kingdom",
  "deliveryCity": "London",
  "deliveryDistrict": "Westminster",
  "deliveryAddress": "Sample street, London SW1A",
  "recipientName": "Sample Recipient",
  "recipientMobile": "+447700900123",
  "packageType": "document",
  "description": "Documents",
  "weightKg": 0.5,
  "lengthCm": 32,
  "widthCm": 24,
  "heightCm": 2,
  "quantity": 1,
  "requestedServiceType": "standard",
  "pickupDate": "2026-08-25",
  "codRequired": false,
  "specialHandlingFlags": [],
  "declaredValue": 25,
  "declaredValueCurrency": "AED",
  "quoteCurrency": "AED",
  "goodsConfirmation": true,
  "landingPage": "/send-package"
}
```

International routes may return manual/custom quote handling rather than instant pricing.

### Retrieve quote result

```http
GET /api/v1/public/customer-quotes/{reference}?token={accessToken}
```

The `QTE-...` reference alone is not authorization. The access token is required for private quote details.

### Select an offer

```http
POST /api/v1/public/customer-quotes/{reference}/select
```

Body:

```json
{
  "accessToken": "sample-access-token-from-create-response",
  "publicOfferId": "OFF-SAMPLE12345"
}
```

Use the real `accessToken` and `publicOfferId` returned by the quote workflow; do not invent them in production calls.

## Demo requests

### Submit demo request

```http
POST /api/v1/public/demo-requests
```

Required fields:

- `companyName`
- `contactPerson`
- `mobileNumber`
- `email`
- `country`
- `preferredContactMethod`: `phone`, `whatsapp`, or `email`
- `consent`: must be `true`
- `landingPage`

Conditional/optional fields:

- `emirate` for UAE context
- `website`
- `approximateDriverCount`
- `approximateMonthlyOrders`
- `approximateTraderCount`
- `currentSystem`
- `mainChallenges`
- `featuresOfInterest`
- `additionalNotes`
- attribution fields

Example:

```json
{
  "companyName": "Sample Delivery LLC",
  "contactPerson": "Sample Manager",
  "mobileNumber": "+971501112222",
  "email": "demo@example.com",
  "country": "United Arab Emirates",
  "emirate": "dubai",
  "approximateDriverCount": 25,
  "approximateMonthlyOrders": 2500,
  "approximateTraderCount": 80,
  "preferredContactMethod": "whatsapp",
  "featuresOfInterest": ["order_management", "driver_management", "cod_collections", "reports"],
  "mainChallenges": "Need better COD and driver assignment visibility.",
  "consent": true,
  "landingPage": "/request-demo"
}
```

Responses use a `DEMO-...` reference for support follow-up.

## Trader application

### Submit Trader application

```http
POST /api/v1/public/trader-applications
```

Required fields:

- `storeName`
- `contactPerson`
- `mobileNumber`
- `email`
- `primaryCategory`
- `additionalCategories`
- `pickupEmirate`
- `pickupArea`
- `channels`
- `monthlyOrderRange`
- `deliveryEmirates`
- `paymentMix`
- `fragileProducts`
- `temperatureControlled`
- `hasExistingDeliveryCompany`
- `consent`: must be `true`
- `landingPage`

If `hasExistingDeliveryCompany` is true, provide `existingDeliveryCompanyName`.

Example:

```json
{
  "storeName": "Sample Fashion Store",
  "contactPerson": "Sample Trader",
  "mobileNumber": "0501234567",
  "email": "trader@example.com",
  "website": "https://store.example.com",
  "primaryCategory": "fashion",
  "additionalCategories": [],
  "pickupEmirate": "dubai",
  "pickupArea": "Business Bay",
  "channels": [
    { "type": "shopify", "url": "https://store.example.com" }
  ],
  "monthlyOrderRange": "1001_3000",
  "deliveryEmirates": ["dubai", "sharjah", "ajman"],
  "paymentMix": "mixed",
  "codPercentage": 60,
  "fragileProducts": false,
  "temperatureControlled": false,
  "hasExistingDeliveryCompany": false,
  "consent": true,
  "landingPage": "/traders/register"
}
```

Responses use a `TRD-APP-...` reference. Platform approval/rejection APIs are internal and not public developer APIs.

## Public Agent API

The public Agent API powers website chat. It does not expose Platform staff comments, private review fields, or internal orchestration details.

### Start conversation

```http
POST /api/v1/public/agent/conversations
```

Body:

```json
{
  "language": "en",
  "visitorId": "anonymous-browser-id"
}
```

Response includes a conversation token/reference used by the website client.

### Get conversation

```http
GET /api/v1/public/agent/conversations/{token}
```

Returns the public conversation state/messages available to that token.

### Send message

```http
POST /api/v1/public/agent/conversations/{token}/messages
```

Body:

```json
{
  "message": "I need a delivery quote",
  "inboundMessageId": "client-generated-unique-message-id",
  "language": "en"
}
```

Conceptual public states:

- Yousef active: automated assistant is replying.
- Waiting for Human: the visitor requested or needs a human.
- Human active: Platform staff has taken over.

When the human-agent option is disabled, the public flow should collect safe contact information and explain that the operations team will get back to the visitor. Platform staff usernames and internal assignments are not public.

## Public CMS and Blog

### Website content

```http
GET /api/v1/public/website/content
GET /api/v1/public/website/sitemap-entries
GET /api/v1/public/website/media/{id}
```

Only published public content/media should be returned. Draft/edit endpoints live under Platform and are internal.

### Blog

```http
GET /api/v1/public/blog
GET /api/v1/public/blog/categories
GET /api/v1/public/blog/articles/{slug}
GET /api/v1/public/blog/settings
GET /api/v1/public/blog/sitemap-entries
```

Published articles are public. Draft previews and blog editor APIs are Platform-only.

## Public tracking and storefront reads

Public read routes used by public/storefront experiences include:

```http
GET /api/v1/public/tracking/{token}
POST /api/v1/public/store-orders/track
GET /api/v1/public/storefronts
GET /api/v1/public/storefronts/{slug}
GET /api/v1/public/storefronts/{slug}/categories
GET /api/v1/public/storefronts/{slug}/products
GET /api/v1/public/storefronts/{slug}/products/{productSlug}
GET /api/v1/public/commerce-media/{fileId}
```

Tracking tokens and customer/store order references are not general authentication credentials. They should be treated as private customer links.
