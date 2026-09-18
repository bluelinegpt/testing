# SEO Guides

SEO Guides are public long-form content pages that are independent from Blog posts.

## Public URLs

- English: `/guides/:slug`
- Arabic: `/ar/guides/:slug`

Only published Guides (or scheduled Guides whose scheduled time has arrived) resolve publicly. Indexable Guides with sitemap inclusion enabled are added automatically to the database-backed sitemap. A slug rename creates a permanent flattened redirect through the existing public redirect table.

## Platform workflow

Platform Administration → SEO Guides supports draft creation and editing, preview data, SEO readiness, scheduling, publishing, unpublishing, archiving, and private source-document revisions. English and Arabic are separate records linked by a shared translation group ID; changing a record's language is intentionally refused.

Guides are not Blog posts and are not included in Blog queries, Blog RSS, Blog categories, Resources, or public navigation by default.

## Private consultant sources

PDF and DOCX sources are written under `seo-source-documents/<year>/<guide-id>/v<revision>-<uuid>.<ext>` using the configured `FileStoragePort`. Production uses the existing private Cloudflare R2 configuration (`FILE_STORAGE_PROVIDER=r2` plus the existing R2 credentials and bucket variables). No new environment variable is required.

The public API never returns the storage key, uploader account, checksum, publication history, or other administrative metadata. Source download requires a Platform session and `platform.website.read`. Upload requires `platform.website.manage`. Objects are never overwritten, and archiving a Guide does not delete source revisions.

## Deployment

Apply migration `20260970000000_seo_guides.ts` before serving the new API routes. Deploy the API, Platform admin, and public website together so the CMS, public endpoint, sitemap, runtime SSR, and prerender paths stay aligned.
