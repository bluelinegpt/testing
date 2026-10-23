# Tawseelhub SEO indexing audit — 23 October 2026

## Scope and release state

Code and content committed as 5e9af6ef, with registry commit 65913d2f. On 24 October (Asia/Dubai), the user authorized release: a verified full remote backup preceded the single content migration, followed by API and public website deployment. No schema changes, Search Console changes, indexing requests, validation restarts or sitemap submissions. Unrelated registry/mobile/worktree changes were preserved. The published Arabic delivery-management content was not edited.

## Confirmed findings

- Production `/resources/order-statuses` returns 200, one H1, self-canonical, indexable robots. Its original seeded body is only two general paragraphs. This is insufficient practical guidance, but the historical Soft 404 cause cannot be proven from the current response.
- Each of `/ar/resources/trader-portal-basics`, `/ar/resources/reports-overview`, `/ar/resources/create-an-order`, `/ar/resources/contact-support` currently serves English content with its English canonical. That consolidation is appropriate; these are not genuine Arabic translations. The React Help cards nevertheless localized fallback destinations into `/ar/resources/...`, unlike the server shell.
- Help metadata did not expose actual published translation pairs. Arabic article text direction was based on the requested UI language, even for English fallback content.
- Build-time Help generation only processed English. The dynamic-build loop also used a nonexistent sitemap `key` to recognize Guides, and generated `categorys` instead of `categories`. A failed category request stopped later dynamic page generation under a generic warning.
- The generated static sitemap included noindex routes such as `/track` and did not exclude canonicalized-away routes. The API Help sitemap query also did not exclude authored non-self-canonical Help rows.
- `/track` is intentionally transactional and noindex. The public Shopify category API reports `robots_index=false`, `article_count=0`, description `Planned Shopify delivery workflow guidance.` Its noindex is intentional and is preserved.
- The current Arabic commercial page's CSS, both initial JS files and logo all returned HTTP 200 under a Googlebot user-agent, with CSS/JS/PNG content types and immutable caching for hashed bundles. Referenced build assets exist locally. No reproducible security, asset-path, content-type or caching defect was found. Google live-test errors alone do not establish a permanent fault.

## Local changes

- `apps/api/src/website-cms/website-cms.service.ts`: retain canonical English fallback with noindex for a mismatched requested locale; return only published, indexable, self-canonical language alternates; set related-link locale; exclude noncanonical Help sitemap records.
- `apps/public-web/src/App.tsx`, `help-center-client.ts`: cards/related links use the actual content language, article lang/dir follow its content, and client metadata preserves the API language pairs and fallback noindex.
- `apps/public-web/serve.mjs`: runtime Help metadata emits actual alternates and enforces fallback noindex even while talking to an older API.
- `apps/public-web/scripts/prerender.mjs`, `prerender-route-policy.mjs`: generate both Help language paths, noindex fallbacks, recognize keyless service entries, request `categories`, filter noindex/noncanonical/query sitemap targets, and report the actual dynamic-feed failure.
- `apps/public-web/scripts/verify-prerender-output.mjs`: retain the media metadata check without hardcoding the API hostname; the same public media can be served through the canonical domain.
- Content migration `database/migrations/20261023110000_order_status_help_content.ts` plus `content/order-statuses-en.json`: expanded English order-status guide with status meanings/actions, permitted transition examples, COD workflow, common exceptions and related Help links. It updates only the exact original published seed (body/title/summary/canonical checks); customized CMS content is not overwritten. Rollback deliberately does not erase subsequently edited content.
- Regression coverage: API Help-language tests, React server-rendered Help tests, runtime HTML and prerender-policy tests.

## Business-rule evidence

The content follows `OrdersWorkflowService.statusIneligibility` and assignment validation in `apps/api/src/operations/orders-workflow.service.ts`, the status labels in `driver-shipment-manifest.service.ts`, and the separate cash-status rule in `driver-cash-status-rule.ts`. No operational code was changed. It describes New, In Branch, Assigned to Driver, Out for Delivery, Delivered, Hold, Returned to Branch, Returned to Trader, Cancelled, Collect Order and Closed. It does not equate physical delivery with financial completion. It scopes the example to local deliveries and identifies the GCC/international exception. Driver actions and office actions are not presented as interchangeable. The guide does not promise every next action is available to every role.

## Verification

- API focused tests: 5 passed.
- React/SEO focused tests: 15 passed.
- Node server/policy/content tests: 26 passed.
- API type check and production build: passed.
- Public web type check and production build against public read-only CMS feeds: passed.
- Migration filename/order validation: 268 files passed. Migration was not run against PostgreSQL; runtime SQL/application requires the backup/schema gates below.
- Existing prerender check: passed, all 77 generated pages have nonempty HTML bodies.
- Initial asset budget: 516,646 bytes raw / 147,177 gzip, below 700,000 / 220,000.
- Generated affected Help pages: one H1, correct canonical, existing local assets; fallback pages noindex; `/track` excluded from generated sitemap; published Arabic commercial page retained.
- Local HTTP port 5174: six affected routes returned 200 HTML with one H1. The expanded status content was injected as a test fixture to simulate the unapplied migration, not written to the live CMS.
- Lint: 53 existing errors in `website-cms.service.ts` (46) and `App.tsx` (7); baseline checked from HEAD yields the same counts. Focused lint is not globally clean. No unrelated cleanup or suppressions added.

## Remaining release actions

1. Review the content and diff. Verify live Help table columns and the exact seed before writing; take and verify a backup first. Apply the single content migration only through the approved ordered migration process. If its guard matches zero records, review the authored CMS article and transfer the approved content manually through the CMS rather than weakening the guard.
2. Deploy API changes, then rebuild and deploy public-web against that API after the content change. This is necessary for static HTML snapshots and new reciprocal metadata to include the migrated content. No production behavior is changed by this local audit.
3. The Render UI previously identified public-web as a Static Site. A Static Site cannot execute `serve.mjs`. If the canonical domain uses that service directly and live CMS updates must appear without rebuilding, use the documented Render Web Service setup: build `pnpm --filter @blueline/public-web build`, start `pnpm --filter @blueline/public-web start`, health `/healthz`, production `PUBLIC_API_BASE_URL` ending `/api/v1`, `PUBLIC_SEO_ENVIRONMENT=production`, and the existing custom domains. Do not change Cloudflare/security controls speculatively. Current proxy/origin routing was not independently audited; no hosting setting was changed.
4. After authorized deployment, verify the actual canonical-domain HTML, assets, fallback URLs, translated language pairs and sitemap membership. API tests cover a real translation pair; the four audited Arabic routes intentionally remain English fallbacks until real Arabic content is created.
5. Continue the already-running Search Console validation. Do not restart it, request indexing again or resubmit the sitemap for this work. A release does not establish indexing or ranking success.

## Limits

No new Arabic translations were invented or published. Current hosting challenge/rate-limit logs are unavailable, so the reported one-off Google asset errors cannot be attributed to a specific hosting cause. The historical Soft 404 remains Google's classification until Google recrawls/reassesses; no timeline is promised.

## Authorized release evidence — 24 October 2026 (Asia/Dubai)

- Verified the remote database against the published article ID, required columns, exact original seed and ordered migration ledger. Only the SEO content migration was pending after the project's existing compatibility aliases.
- Full custom-format backup: `.backups/seo-release-20261023/before-seo.dump`, 48,205,367 bytes, SHA256 `aa7223d0fc76307108d064185f0257f80ab6ff5bb204dba43dccb5a218c6cf00`. Archive listing and full extraction to NUL passed; no database restore was performed. Original article row saved separately and verified. TLS certificate verification retained.
- Normal ordered migration runner reported `20261023110000_order_status_help_content: Success`. Remote ledger, published status, canonical, title and exact expanded 30-block body verified afterward.
- API Render deployment `dep-dbdrqidg1s2s73aseafg` succeeded at 65913d2f. API returns fallback noindex and reciprocal actual English/Arabic pairs.
- Actual canonical website host is Render Web Service `tawseelhub-public-web-service` (`srv-dafgtd740ujc73b88p5g`), not the older Static Site. First deployment `dep-dbdrrrkipgvc739u1ibg` succeeded, but build content feeds failed because PUBLIC_API_BASE_URL was absent (only VITE_API_BASE_URL was configured). Added the public, non-secret PUBLIC_API_BASE_URL for the existing API and triggered a rebuild.
- Canonical-domain checks: expanded English order-status article and four Arabic fallback URLs return 200 and one H1; fallback URLs are noindex with English canonicals. Actual Arabic what-is-tawseelhub remains self-canonical/indexable with language alternates. Track and empty Shopify category retain intentional noindex. Sitemap excludes track and fallback URLs and includes the published Arabic commercial page.
- Googlebot requests returned 200 with correct types for current CSS, initial scripts and logo.
- Separate Arabic Courier Management draft was not published. Registry remains awaiting human confirmation by project policy, even after deployment verification.

- Corrected public website rebuild `dep-dbdrss3l550s73869fug` succeeded and went Live at 00:08 Asia/Dubai on 24 October, at 65913d2f. Content-feed warning is absent from the corrected build logs. Render registry service name corrected; human-confirmation status preserved.
