# Tawseelhub SEO production certification

## Current classification

**SEO NOT READY** until the pending SEO migrations and applications are deployed and the live checks below pass. Local implementation alone is not production certification. After deployment and live technical validation, the expected classification is **SEO PRODUCTION READY — SEARCH CONSOLE / FIELD DATA PENDING** until Google has accumulated reporting and real-user Core Web Vitals data.

## Architecture and measured budget

The canonical public site must remain a Render Web Service using `apps/public-web/serve.mjs`; a Render Static Site cannot provide database-backed sitemap/RSS, server redirects, dynamic publication metadata, or correct HTTP 404 behavior. Render should health-check `/healthz`. Hashed assets are immutable, public HTML is briefly cached, and sitemap/RSS use short cache windows. The managed ingress may compress responses too, but the application server also negotiates Brotli/gzip and never compresses an already encoded upstream object.

The build-time performance audit measures only CSS/JavaScript referenced by the initial HTML. Its current release budget is 700 kB raw and 220 kB gzip. This baseline is deliberately enforced after deferring the Agent/LiveAvatar SDK; revisit it from measured builds instead of reducing it arbitrarily. The deferred Agent remains available after idle and is not part of initial page assets.

Real LCP, INP and CLS cannot be certified from repository code. Review Search Console Core Web Vitals/CrUX after sufficient traffic. Lab results are diagnostic and must be run on mobile against the deployed custom domain, not the noindex Render origin.

## Google Search Console

No Search Console API credentials are present and no API integration is implemented. This is an intentional safe degraded state: publishing, the public site, sitemap and CMS do not depend on Google. Search performance and indexing data must not be represented as live application metrics.

Manual acceptance:

1. In Search Console, add the Domain property `tawseelhub.com`.
2. Add Google's TXT verification record at the DNS provider. Do not put the TXT token in source control.
3. After verification, submit only `https://tawseelhub.com/sitemap.xml`.
4. Confirm the sitemap succeeds and inspect the homepage, one English Blog article and one Arabic Blog article.
5. Review Pages/Indexing for noindex, duplicate canonical, redirect, 404 and server-error findings.
6. Review Enhancements where Google recognizes supported structured data. Rich results are never guaranteed.
7. Review Core Web Vitals on mobile and desktop after field data accumulates.
8. Review Performance by page and query. Filter Arabic visibility by URLs beginning `/ar/`, not by guessing from query language.

Search Console reports are delayed. URL Inspection is appropriate for selected important URLs; do not run uncontrolled bulk inspection or attempt automatic indexing manipulation.

## Release and live certification

1. Verify the production schema and create a verified Neon backup.
2. Review and apply pending social, international and editorial SEO migrations in timestamp order.
3. Deploy API, Platform Web, then Public Web. Never deploy schema-dependent frontend/API code before migrations.
4. Confirm `PUBLIC_API_BASE_URL`, canonical custom domains, `PUBLIC_SEO_ENVIRONMENT=production`, and the `/healthz` Render health check.
5. Confirm the direct `*.onrender.com` origin remains `noindex, nofollow` with deny-all robots behavior.
6. Run the Platform live Production SEO checks.
7. Run `pnpm --filter @blueline/public-web certify:seo -- https://tawseelhub.com`.
8. Test a real 301/308 redirect, a missing Blog URL returning HTTP 404, EN/AR RSS, sitemap XML and production robots.
9. View source for representative home, Blog, article, category, author and topic pages. Confirm production canonical, robots, hreflang, JSON-LD and social metadata exist before JavaScript.
10. Run mobile Lighthouse for home, Blog, EN/AR articles, category, author, topic, pricing and contact. Record results with date, device/network profile and deployed commit.

Scheduled publishing and unpublishing must be tested after migration: page availability, sitemap, RSS, hreflang and related-content membership must change together within the documented short cache window.

## Monthly maintenance

- Review Search Console indexing errors, Core Web Vitals and sitemap status.
- Review clicks, impressions, CTR, average position, top pages and top queries without exposing query analytics publicly.
- Compare recent performance with prior periods and investigate declining important pages.
- Review CMS orphan, stale, broken-link, redirect, image-size/dimension/alt and taxonomy warnings.
- Refresh meaningful article content when appropriate; infrastructure-only releases must not change `dateModified` or sitemap `lastmod`.
- Validate important redirects and sample English/Arabic canonical and hreflang pairs.

## Rollback

Roll back application services independently to their last known compatible commits. If public SSR metadata or sitemap is malformed, roll back Public Web first; if API responses are incompatible, roll back API and dependent UIs together. Disable a faulty manual redirect through the CMS rather than editing production data directly. SEO migrations are additive; prefer a forward corrective migration after restoring application compatibility. Do not destructively restore Neon without an approved incident decision and verified backup.
