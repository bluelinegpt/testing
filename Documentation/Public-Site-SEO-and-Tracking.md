# Tawseelhub public-site SEO and tracking

## Ownership and publishing

Platform Administrators manage articles under **Website Content**. Articles begin as drafts and may be published immediately, scheduled, unpublished, or archived. Public APIs expose only published articles whose publication time has arrived. Changing the slug of a published article creates a permanent redirect record. Publication history is append-only.

Content is stored as validated structured blocks, never executable HTML. Image URLs must use HTTPS and every featured image requires alt text. Do not publish unreviewed sample or AI-generated copy.

## Search

- Submit `https://tawseelhub.com/sitemap.xml` in Google Search Console.
- Add the Search Console verification token in Website Content settings. Only the token is stored; arbitrary verification scripts are not accepted.
- Canonicals, Open Graph/Twitter metadata, robots directives, and `BlogPosting` JSON-LD are generated from CMS fields.
- English and `x-default` alternates are emitted today. Add an Arabic alternate only when the matching Arabic URL is real and publicly available.
- Private quote-result and completion routes are disallowed in `robots.txt` and must remain absent from the sitemap.
- The public blog sitemap feed is `GET /api/v1/public/blog/sitemap-entries`; the deployment build must merge those published entries into the root sitemap.

## Analytics and privacy

Settings accept either Google Tag Manager (`GTM-…`) or direct GA4 (`G-…`). GTM takes precedence when both are present, preventing double initialization. Tracking loads asynchronously and only in the configured environment; failures never block the site. Direct GA4 enables IP anonymization.

Documented conversion events include demo, Trader application, customer quote, offer selection, and Blog engagement. Payloads are allow-listed and must not include names, emails, mobile numbers, addresses, notes, package contents, or other personal data. UTM attribution is limited to source, medium, and campaign.

Microsoft Clarity is optional. When enabled, form controls are marked for masking. Before production activation, confirm the Privacy Policy covers analytics/session replay and apply the consent behavior required by the operating markets.

## Release checklist

1. Verify the canonical production base URL and environment.
2. Publish a reviewed test article, confirm listing/article/category pages and metadata, then unpublish it.
3. Confirm unpublished content returns 404 and disappears from sitemap entries.
4. Validate the root sitemap and robots file in the deployed environment.
5. Use GA4 DebugView or GTM Preview to check each conversion once, with no duplicate events or PII.
6. Confirm Clarity masking before enabling it in production.
