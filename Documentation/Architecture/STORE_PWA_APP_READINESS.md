# Store PWA / App Readiness

Shared Commerce Foundation Prompt 3D. This document records the current
state of `apps/store`'s installability/offline/native-wrapper readiness and
the decisions behind it, for whoever picks up Capacitor packaging or the
future Flutter Customer app.

## Current Web auth model

`apps/store` authenticates Customers with an **HTTP-only, secure, `SameSite=Lax`
cookie** issued by the API (`apps/api/src/authentication/session-cookie.ts`),
scoped to `/api`. State-changing requests additionally carry a fixed
`X-Blueline-Session: cookie` header as CSRF defence-in-depth. There is no
token in `localStorage`, `sessionStorage`, or IndexedDB anywhere in this
codebase, and Prompt 3D introduces none — the cookie remains the single
source of truth, and the client re-derives session state by calling the
API's `me` endpoint (`customer-session-context.tsx`), never by reading a
locally stored credential.

**This is deliberate and does not change for PWA/installability.** A Web
App Manifest and a service worker do not require moving auth into
client-readable storage; nothing in Prompt 3D touches the cookie model.

## Capacitor compatibility (not implemented)

No Capacitor package is installed or configured. This section documents
what a **future** Capacitor wrapper would need to account for, given the
current architecture — nothing here is a commitment to build it, and no
Capacitor-specific code exists in `apps/store` today.

- **Cookie behaviour inside a native WebView**: Capacitor's WebView
  (`https://` custom scheme or a real origin, depending on configuration)
  may not share cookie storage with a system browser the way a normal tab
  does. If the wrapper serves the app from its own origin, first-party
  cookie behaviour should work identically to the web build; if it proxies
  through a different scheme, a native secure-storage/session adapter that
  still treats the cookie as opaque (never reads or duplicates its value
  into JS-accessible storage) may be needed. This is an integration
  question for whoever builds the wrapper — not solved here, and Web auth
  is not weakened in anticipation of it (§35).
- **Android package ID / iOS bundle ID**: not yet chosen. No placeholder ID
  is invented in this prompt; whoever configures the Capacitor project picks
  one that matches whatever app-store listing is approved at that time.
- **Deep-link domain / universal & app links**: the Store's existing routes
  (`/en/...`, `/ar/...`, `/{store-slug}`, `/{store-slug}/products/{slug}`,
  `/account/orders/{number}`, `/track`) are already real, reloadable URLs
  under one public origin (`STORE_PUBLIC_ORIGIN`) — the same shape iOS
  Universal Links / Android App Links need. No `apple-app-site-association`
  or Android `assetlinks.json` exists yet; both would need to be added
  under that origin once a real bundle/package ID is chosen.
- **Push entitlements**: none requested or configured (§38). The
  `NotificationPublisher` abstraction (`apps/api/src/notifications/`) exists
  so a future APNs/FCM integration has a single, already-tested seam to
  implement against, but no entitlement, certificate, or SDK is present.

## Browser-only assumption audit (§33-34)

Reviewed every Customer/Store flow for patterns that would break inside a
native WebView wrapper:

- **No arbitrary popup windows.** Nothing in `apps/store` calls
  `window.open()`. `ShareControl.tsx` uses `navigator.share()` (the OS share
  sheet) with a `navigator.clipboard.writeText()` fallback — both are
  wrapper-compatible; neither depends on desktop browser chrome.
- **No hard-coded `localhost`.** All API calls go through
  `storeConfiguration.apiBaseUrl` (same-origin relative path in production,
  proxied in dev); no component or client file references `localhost`
  directly. The server itself defaults `STORE_API_ORIGIN`/`STORE_PUBLIC_ORIGIN`
  to `localhost` only as a LOCAL DEV fallback, overridden by environment in
  any real deployment.
- **No hover-only actions.** The Store's interactive surface (buttons,
  cards, links) all respond to click/tap directly; `:hover` styling in
  `store.css` is decoration on top of a working tap target, not a
  requirement to reveal one.
- **No unsupported cross-origin auth requirement.** The cookie is first-party
  to the Store's own origin; nothing requires a third-party cookie or a
  cross-origin `fetch` with credentials to a different origin.
- **Internal navigation is exclusively React Router** (`<Link>`/`useNavigate`
  throughout `apps/store/src/pages`); the only literal `window.location`
  usage is inside `ShareControl.tsx` to read the CURRENT canonical URL for
  sharing (never to navigate), and inside `customer-session-context.tsx`'s
  guard pages via `<Navigate>` (a router primitive, not raw
  `window.location.assign`). External links (Support/Privacy/Terms,
  WhatsApp) are ordinary `<a>` elements, which is exactly the "native-
  compatible route" §34 asks for — no direct `window.location =`
  assignment is scattered through the codebase.

## Future Flutter Customer app compatibility

The Flutter app (a later, separate project phase) would consume the SAME
API contracts this prompt did not change: `commerce/customer-auth/*`,
`commerce/customer/*`, `public/store-orders/track`, and the public
Storefront/Product/Marketplace reads. Nothing about Prompt 3D's manifest,
service worker, or cache headers is web-only-coupled at the API layer —
the API's `no-store` discipline on Customer-scoped routes and its
enumeration-safe tracking contract apply identically to any client. The
`NotificationPublisher` event contract (§37-40) is channel-neutral for the
same reason: a future Flutter app's push integration and a future
Capacitor wrapper's push integration would both consume the same event
types without either coupling the Store Order domain to their SDK.
