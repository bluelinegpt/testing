# Tawseelhub Public Website Localization

This note documents how the public Tawseelhub website supports English and Arabic.

## Scope

The bilingual layer applies to `apps/public-web`, including:

- Public navigation and footer.
- Homepage marketing sections.
- Delivery company, trader, integrations, send-a-package, pricing, about, contact and not-found pages.
- Request Demo, Send a Package quote and Trader Registration forms.
- Blog and Help Center listing/article shells.
- Ask Tawseelhub website widget labels and fallback quick actions.

It does not change Platform Administration, company portals, trader operational apps, API behavior or database records.

## Locale source of truth

`apps/public-web/src/public-localization.ts` owns the shared public locale routing:

- The URL is authoritative: root paths are English and `/ar` paths are Arabic. Local storage is only a remembered preference and never creates an indexable language variant.
- `tawseelhub:locale-changed` is dispatched when the language changes.
- `usePublicLocale()` lets independent components, including forms and Ask Tawseelhub, stay in sync.
- The main public layout sets `<html lang>` and `<html dir>` for accessibility and RTL layout.

Arabic keeps the Tawseelhub brand name in English as `Tawseelhub`.

## URL strategy

English uses unprefixed routes such as `/pricing` and `/blog/article-slug`. Arabic uses real crawlable routes such as `/ar/pricing` and `/ar/blog/مقال`. Arabic slugs use normalized Unicode Arabic characters; transliteration is not forced. Unsafe separators, dot segments, query/fragment characters, controls and bidi override/isolate characters are rejected.

The language switch preserves the equivalent static page and uses the article/category translation relationship for dynamic Blog routes. If a matching translation is not published, it goes to the target-language Blog or Resources section rather than inventing a soft-404 article URL.

## Forms and data safety

Localized forms show Arabic labels and options, but payloads keep canonical backend values where required:

- Country labels are localized for display; submitted country names remain canonical English names.
- Emirate/package values keep their existing backend codes.
- Phone, email, URL and numeric inputs stay left-to-right.
- Analytics payloads include `locale`.

## SEO metadata

`routeMetadata` contains route-level title and description for both languages. Dynamic blog/help article metadata still comes from CMS/article APIs and is applied per route.

Every published locale self-canonicalizes. Published translation pairs emit self-referential and reciprocal `hreflang`; an unpublished or unlinked translation emits no alternate. English is `x-default` when present. Initial Arabic HTML is emitted as `<html lang="ar" dir="rtl">`, with localized Open Graph (`ar_AE`), JSON-LD language, breadcrumb labels/URLs, and social text before hydration.

Blog translations are separate records joined by `translation_group_id`. This preserves independent slugs, drafts, publication state, content timestamps, SEO fields and social fields. Existing records receive singleton group identities during migration, but no translation relationship is guessed. Editors explicitly link the matching opposite-language record. Categories use the same optional editorial pairing concept while remaining separate localized records.

Changing an Arabic slug creates and flattens redirects entirely inside `/ar/blog`; English does the same under `/blog`. Query language variants are redirected to the path-based canonical, and tracking parameters never change canonical URLs.

## Fallback rule

When CMS content is missing, each public page falls back to local English or Arabic copy. Do not leave raw internal keys, untranslated placeholder text, or machine-readable objects in the UI.

## Controlled Arabic glossary

Use these Arabic terms consistently in public UI:

| English term | Arabic public term |
| --- | --- |
| Delivery Operating System | نظام تشغيل التوصيل |
| Order | طلب |
| Delivery Company | شركة توصيل |
| Trader | تاجر |
| Driver | سائق |
| COD | الدفع عند الاستلام / COD |
| Collection | التحصيل |
| Reconciliation | المطابقة / التسوية حسب السياق |
| Settlement | تسوية |
| Accounting | المحاسبة |
| Payroll | الرواتب |
| Quote | عرض |
| Shipment | شحنة |
| Package | طرد / شحنة حسب السياق |
| Store | متجر |
| Integration | تكامل |
| Help Center | مركز المساعدة |
| Live Agent | موظف مباشر |

Keep product/platform proper names unchanged, including `Tawseelhub`, `Yousef`, `Salla`, `Shopify`, `WooCommerce`, and `AED`.

## Adding future translation keys

For fixed public UI, add translations to `public-localization.ts` or the page-local copy map only when the text is not CMS-managed. For CMS-controlled content, create or edit the proper locale record in the Platform CMS instead of hard-coding business content in the frontend.
