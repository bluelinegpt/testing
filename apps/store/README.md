# `@blueline/store` — BluelineGPT Store

The public, customer-facing Commerce application. Deployed separately from the
Delivery Company portal and served at **`store.bluelinegpt.com`**.

## Boundary

```
apps/store  → public / customer Commerce (this app)
apps/web    → Delivery operations + Trader Store management (temporarily)
apps/api    → shared modular backend
apps/mobile → Flutter operational app
```

This application imports nothing from `apps/web`. It has no concept of a Driver,
Settlement, Reconciliation, Receivable or Accounting Event, and it never
requires a Delivery Company session — every page here works anonymously.

Authenticated **Trader** Store configuration and Product management deliberately
remain in `apps/web` for now. Moving them would mean redesigning Trader
authentication in the same change, and the two are worth separating.

## Local development

The API must be running on port 3000.

```bash
pnpm --filter @blueline/store dev
```

Serves on **http://127.0.0.1:5175**. (5174 is the Delivery Portal; 5173 and 8787
belong to other applications and must not be used.)

Vite proxies `/api` to `http://localhost:3000`, so the browser talks to the
Store's own origin. `VITE_API_BASE_URL` therefore defaults to the relative
`/api/v1` — an absolute API origin would make future customer sessions
cross-site and the browser would withhold a `SameSite=Lax` cookie.

## Commands

```bash
pnpm --filter @blueline/store typecheck
pnpm --filter @blueline/store test
pnpm --filter @blueline/store build
```

## Environment variables

All of these reach the browser. **Never put a secret here.**

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `/api/v1` | Keep relative so the API is same-origin. |
| `VITE_STORE_SITE_NAME` | `BluelineGPT Store` | Header and title text. |
| `VITE_DEFAULT_LANGUAGE` | `en` | `en` or `ar`. |
| `VITE_STORE_PUBLIC_ENABLED` | `true` | Kill switch for the whole public Store. |
| `VITE_MARKETPLACE_HOME_ENABLED` | `true` | Kill switch for the marketplace root only. |

Both flags are read only by this application. Disabling the marketplace has no
effect on Delivery operations.

## API boundary

Public, anonymous, allow-listed endpoints only:

```
GET /api/v1/public/storefronts                                  list published Stores
GET /api/v1/public/storefronts/{slug}                           resolve one Store
GET /api/v1/public/storefronts/{slug}/categories                Store categories
GET /api/v1/public/storefronts/{slug}/products                  Store products
GET /api/v1/public/storefronts/{slug}/products/{productSlug}    one Product
```

The backend public projections are authoritative. No Company ID, Trader ID,
Trader Commerce ID, relationship row, settlement, receivable, accounting or
audit field is exposed, and the client translates every failure into
`not_found` or `unavailable` so raw API errors never reach a customer.

## Routes

Implemented:

```
/                                    marketplace root
/{store-slug}                        public Store
/{store-slug}/products/{product-slug} public Product
```

Reserved — routed to a placeholder so a Store slug can never claim them:

```
/categories /search /register /login /account /orders
/cart /checkout /track /support /privacy /terms
```

`src/routing/reserved-slugs.ts` holds the full list, including infrastructure
words (`api`, `admin`, `assets`, `static`, …).

## Design

`src/styles/tokens.css` holds the design tokens, copied **verbatim** from
`apps/web/src/styles.css`. The blue/white identity is shared with the Delivery
Portal on purpose; nothing here re-picks a colour. That file is the single place
a future theme system replaces.

Layout is mobile-first and uses CSS logical properties throughout, so Arabic RTL
mirrors from the `dir` attribute alone with no second stylesheet.

## Future intent

Structured so the following are additive rather than rewrites:

- **PWA** — stable root, every route deep-links, no browser-local critical
  state, no absolute API origin. Manifest and service worker come later.
- **Capacitor** — no popup-only navigation, no hover-only interaction, no
  cross-origin dependency.
- **Customer accounts** — routes reserved, no Delivery session assumed anywhere.

Not implemented here: media upload transport, marketplace search, Platform
categories, customer authentication, cart, checkout, Store Orders, ratings.
