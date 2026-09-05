# Tawseelhub public-site SEO and tracking

## Ownership and publishing

Platform Administrators manage articles under **Website Content**. Articles begin as drafts and may be published immediately, scheduled, unpublished, or archived. Public APIs expose only published articles whose publication time has arrived. Changing the slug of a published article creates a permanent redirect record. Publication history is append-only.

Content is stored as validated structured blocks, never executable HTML. Image URLs must use HTTPS and every featured image requires alt text. Do not publish unreviewed sample or AI-generated copy.

## Search

- Submit `https://tawseelhub.com/sitemap.xml` in Google Search Console.
- Add the Search Console verification token in Website Content settings. Only the token is stored; arbitrary verification scripts are not accepted.
- Canonicals, Open Graph/Twitter metadata, robots directives, and `BlogPosting` JSON-LD are generated from CMS fields.
- English is served at the root path and Arabic at `/ar`. Reciprocal `en`/`ar` alternates are emitted only when both localized records are published; each version self-canonicalizes. `x-default` points to English when an English version exists and is omitted for Arabic-only content.
- Private quote-result and completion routes are disallowed in `robots.txt` and must remain absent from the sitemap.
- The canonical sitemap is `https://tawseelhub.com/sitemap.xml`. The public-web server proxies it to the live database-backed XML endpoint `GET /api/v1/public/website/sitemap.xml`, so publishing, scheduled publication, unpublishing, indexability changes, and slug changes require no sitemap edit or public-web rebuild. Responses use a short cache (`max-age=60`) with stale revalidation.
- Sitemap membership derives from each locale's CMS lifecycle. It contains visible published public pages, indexable published/due-scheduled English and Arabic Blog articles and their non-empty localized categories, and indexable published Help Center articles. It excludes drafts, future schedules, unpublished/archived content, tracking and quote-result routes, query URLs, previews, APIs, and authenticated routes. Sitemap entries use the XHTML namespace for the same honest language alternates used in HTML.
- Blog `lastmod` uses the meaningful published-content timestamp, then initial publication/scheduled-live time, with the record timestamp only as a legacy fallback.
- Canonical Blog overrides must use `https://tawseelhub.com`, contain no query or fragment, and are validated again at the service boundary. Marketing query parameters never enter generated canonicals.
- Published slug renames automatically create permanent redirects. Earlier aliases are flattened to the newest path, and returning to an earlier slug removes the conflicting redirect first to prevent loops.
- English redirects remain under `/blog/...`; Arabic redirects remain under `/ar/blog/...`. A rename never crosses languages implicitly.
- Production public pages use `index,follow,max-image-preview:large`. Tracking/quote results and public search-query variants use `noindex,follow`. Local, staging, and direct `*.onrender.com` traffic receives `X-Robots-Tag: noindex, nofollow`; the Render origin also serves a deny-all robots file.

## Public website Render service

The live sitemap and database-driven HTTP redirects require `apps/public-web` to run as a Render **Web Service**, not as a static-site-only origin. Use build command `pnpm --filter @blueline/public-web build`, start command `pnpm --filter @blueline/public-web start`, and set `PUBLIC_API_BASE_URL` to the deployed API base ending in `/api/v1`. Set `PUBLIC_SEO_ENVIRONMENT=production` only on the canonical production service. Keep `tawseelhub.com` as the custom domain; the service's `onrender.com` hostname remains noindex. Configure `www.tawseelhub.com` on the same service so the server can permanently normalize it to the non-www hostname.

## Google Search Console operation

1. Add/verify the Domain property `tawseelhub.com` using Google's DNS TXT record (the existing CMS token remains available for URL-prefix verification if needed).
2. In **Sitemaps**, submit `sitemap.xml` once.
3. Confirm the response is HTTP 200 and the reported discovered URL count is plausible.
4. Review **Page indexing** and the sitemap status after releases; inspect unexpected excluded, soft-404, redirect, or canonical findings.
5. Use URL Inspection for a newly published article and request indexing when an urgent recrawl is useful. Sitemap submission is discovery guidance, not an indexing guarantee.

The single `tawseelhub.com` Domain property covers both root English URLs and `/ar` Arabic URLs. Arabic does not need a separate property merely because it uses a subdirectory; submit the one bilingual sitemap.

## Structured data and social sharing

Published Blog responses expose a public-only SEO model with one JSON-LD graph containing stable Tawseelhub `Organization` and `WebSite` entities, the visible breadcrumb hierarchy, and a `BlogPosting`. Article dates use publication and meaningful published-content timestamps. The real author name is represented as a `Person`; no profile URL or credentials are invented before public author pages exist.

Social fallback order is: explicit social title/description/image, then SEO title/meta description/featured image, then the article title/excerpt. A separate social image carries its own alt text and measured dimensions. Uploaded PNG, JPEG and WebP media records retain detected dimensions; metadata never guesses missing dimensions. CMS warnings for missing alt text and unusually long overrides are advisory rather than arbitrary publication blockers.

The public server and build prerenderer put canonical, robots, Open Graph, X/Twitter, and JSON-LD metadata in initial HTML. JSON-LD escapes `<`, Unicode line separators, and paragraph separators before insertion; HTML attributes are escaped. Publication remains the cache boundary: draft preview values are visible only to authorized editors, while live metadata continues using published columns until Save & Publish completes.

## Performance and production monitoring

- The Agent/LiveAvatar interface is loaded only after the initial page becomes idle, keeping its SDK out of the critical render path.
- Blog listing images are lazy-decoded with reserved dimensions. The visible article hero is eager, high-priority and dimensioned; inline article images are lazy-decoded.
- Hashed Vite assets use a one-year immutable cache. Public HTML uses a one-minute cache with stale revalidation. Sitemap and RSS retain short independent cache windows so publication changes become visible promptly.
- The Node public server applies Brotli or gzip to compressible responses when requested and exposes an uncached `/healthz` endpoint for the Render Web Service health check.
- Run `pnpm --filter @blueline/public-web audit:performance` after a production build. It enforces the measured initial JS/CSS budget; lazy Agent chunks are not counted as initial assets.
- Platform Administration → Website → Editorial SEO → Health has an explicit **Run live checks** action. It checks the canonical production homepage, robots, sitemap, EN/AR RSS and structured data. It intentionally does not invent Search Console or field Core Web Vitals data.
- Run `pnpm --filter @blueline/public-web certify:seo -- https://tawseelhub.com` only after deployment. The bounded crawler accepts only the canonical Tawseelhub origin and checks at most 250 sitemap URLs plus their internal links and hreflang targets.

Manual validation for a deployed published article:

1. Use **View page source** and confirm canonical, robots, `og:*`, `twitter:*`, and `application/ld+json` exist before JavaScript runs.
2. Test the URL in Google Rich Results Test and Schema.org Validator.
3. Refresh cached sharing data with Facebook Sharing Debugger and LinkedIn Post Inspector.
4. Inspect the X card using X's currently available card/post inspection flow; external renderings are approximations and may change.

## Analytics and privacy

Settings accept either Google Tag Manager (`GTM-…`) or direct GA4 (`G-…`). GTM takes precedence when both are present, preventing double initialization. Tracking loads asynchronously and only in the configured environment; failures never block the site. Direct GA4 enables IP anonymization.

Documented conversion events include demo, Trader application, customer quote, offer selection, and Blog engagement. Payloads are allow-listed and must not include names, emails, mobile numbers, addresses, notes, package contents, or other personal data. UTM attribution is limited to source, medium, and campaign.

Microsoft Clarity is optional. When enabled, form controls are marked for masking. Before production activation, confirm the Privacy Policy covers analytics/session replay and apply the consent behavior required by the operating markets.

## Release checklist

### Editorial SEO (Prompt 4)

Platform Administration → Website → Blog → **Editorial SEO** is the operational workspace for categories, tags, topic hubs, public authors, redirects, safe Blog 404 monitoring, and SEO-health counts. The article editor provides the per-article readiness checklist, search/social previews, primary and secondary categories, controlled tags, cornerstone designation, and editorial related-article overrides. Readiness labels are CMS completeness checks, not Google ranking scores.

- Categories become indexable only when an editor enables indexing and the page has a description plus published, indexable content.
- Tags default to `noindex`; selected, curated, described, populated tag pages may be indexed.
- Topic hubs are independently published curated pages, not free-form page-builder pages.
- Author pages expose only approved public profile fields. Empty profiles remain `noindex`; private account and contact data are never returned.
- English RSS is `/blog/rss.xml`; Arabic RSS is `/ar/blog/rss.xml`. Draft, future-scheduled, unpublished, and noindex articles are excluded.
- The sitemap includes only indexable, populated category, tag, topic, and author pages and uses explicit EN/AR translation links.
- Blog 404 monitoring strips query strings, retains only the referrer origin, and excludes tracking/private routes.
- Automatic and safe manual internal redirects are visible with hit counts. Manual targets must be published internal Blog content and loops are rejected.

Migration `20260969000000_blog_editorial_seo.ts` supplies these additive fields and relationships. Apply it through the normal migration process before deploying the corresponding API and CMS builds; creating this code does not alter Neon automatically.

1. Verify the canonical production base URL and environment.
2. Publish a reviewed test article, confirm listing/article/category pages and metadata, then unpublish it.
3. Confirm unpublished content returns 404 and disappears from sitemap entries.
4. Validate the root sitemap and robots file in the deployed environment.
5. Use GA4 DebugView or GTM Preview to check each conversion once, with no duplicate events or PII.
6. Confirm Clarity masking before enabling it in production.
