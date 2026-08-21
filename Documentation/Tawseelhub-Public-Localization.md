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

`apps/public-web/src/public-localization.ts` owns the shared public locale state:

- `tawseelhub.locale` in browser local storage stores `en` or `ar`.
- `tawseelhub:locale-changed` is dispatched when the language changes.
- `usePublicLocale()` lets independent components, including forms and Ask Tawseelhub, stay in sync.
- The main public layout sets `<html lang>` and `<html dir>` for accessibility and RTL layout.

Arabic keeps the Tawseelhub brand name in English as `Tawseelhub`.

## URL strategy

English and Arabic use the same public routes. The language toggle changes page text, direction and metadata without changing the URL.

CMS-backed blog/help content is requested with the active locale. If an Arabic CMS article is not published yet, the page shell remains localized and the normal unavailable/not-found handling is shown instead of auto-translating unpublished content.

## Forms and data safety

Localized forms show Arabic labels and options, but payloads keep canonical backend values where required:

- Country labels are localized for display; submitted country names remain canonical English names.
- Emirate/package values keep their existing backend codes.
- Phone, email, URL and numeric inputs stay left-to-right.
- Analytics payloads include `locale`.

## SEO metadata

`routeMetadata` contains route-level title and description for both languages. Dynamic blog/help article metadata still comes from CMS/article APIs and is applied per route.

The current public site uses one URL per logical page and persists language in browser state. Because there are not separate `/ar/...` URLs yet, the site must not publish fake Arabic sitemap URLs. In this model, canonical URLs remain the public route URLs, and `hreflang` support is limited until a URL-based locale strategy is approved.

This means raw production HTML is intentionally crawlable as English/x-default today. Arabic is a complete user-facing UI locale after the visitor switches language, but Arabic Blog/Help pages do not have independently crawlable URLs for search engines yet. Do not emit `hreflang="ar"` unless a future routing change creates stable server-readable Arabic URLs, such as `/ar/...`, that return Arabic HTML without relying on local storage.

If an Arabic Blog article is not published, the site must not create half-Arabic metadata for the English article. It should keep the English article and English metadata for the crawlable URL. If an Arabic Help article exists in CMS, it can be shown to Arabic users through the current locale state, but independent Arabic indexing still requires a future locale URL architecture.

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
