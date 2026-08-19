# Tawseelhub Google Ads conversion measurement

This note documents the public Tawseelhub website measurement layer added for Google Ads / GA4 reporting.

## Current architecture

Public website actions call the shared analytics helper in `apps/public-web/src/analytics.ts`.

The helper:

- emits one controlled event object per action;
- includes `event_id`, `occurred_at`, `page`, `locale`, and safe campaign attribution;
- pushes to `window.dataLayer` only when tracking is enabled for the current environment and analytics consent is not denied;
- keeps local safe debug sinks at `window.__TAWSEELHUB_ANALYTICS_EVENTS__` and `#tawseelhub-analytics-debug` for local/browser acceptance;
- suppresses duplicate primary conversion events by confirmed business reference.

GTM remains the preferred production path. GTM should map these dataLayer events to GA4 and Google Ads conversions. Direct Google Ads conversion IDs/labels are not hard-coded in the website source.

## Primary conversion events

Recommended Google Ads primary conversions:

- `demo_request_submitted` — fires only after the API returns a `DEMO-xxxxxx` reference.
- `delivery_quote_submitted` — fires only after the API returns a `QTE-xxxxxx` reference.
- `trader_application_submitted` — fires only after the API returns a `TRD-APP-xxxxxx` reference.

These events may include the public business reference and safe segmentation metadata. They must not include contact names, emails, full mobile numbers, addresses, package free text, Agent transcript text, internal comments, or private Delivery Company identity.

## Secondary / engagement events

Recommended secondary conversions or GA4 engagement events:

- `whatsapp_contact_started`
- `agent_opened`
- `agent_business_intent_detected`
- `agent_handoff_requested`
- `agent_whatsapp_handoff_started`
- `pricing_viewed`
- `pricing_cta_clicked`
- `cta_clicked`
- Blog engagement events such as `blog_article_view` and `blog_cta_clicked`

Do not use `purchase` for demo, quote, pricing, or CTA events.

## Attribution

The public website stores first-session campaign attribution in session storage only:

- `utm_source`
- `utm_medium`
- `utm_campaign`
- `utm_content`
- `utm_term`
- `gclid`
- landing page

Demo, Send a Package, and Trader submissions forward safe attribution fields to the backend. The backend stores `gclid` with the lead/quote/application for future offline conversion work.

## Consent and environment behavior

Tracking is controlled by the existing public site tracking settings:

- GTM container ID
- GA4 measurement ID
- analytics enabled
- Clarity project ID / enabled
- tracking environment

Local development does not send to production tracking unless settings explicitly allow the development environment. If `localStorage["tawseelhub.analytics_consent"]` is `denied`, the helper still records a local debug event but does not push to `dataLayer`.

## Deferred

- Production Google Ads conversion IDs and labels.
- Enhanced conversions using hashed customer data.
- Server-side GTM or direct server-side conversion reporting.
- Offline conversion upload API.
- Google Ads campaign-management API.
- Storefront ad monetization.
