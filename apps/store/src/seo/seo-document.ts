/**
 * Route metadata generation.
 *
 * ---------------------------------------------------------------------------
 * ONE MODULE, NO REACT
 * ---------------------------------------------------------------------------
 *
 * Everything here is pure: route + public Commerce data + locale + origin in,
 * a `SeoDocument` out. Nothing imports React, nothing touches the DOM, and no
 * metadata rule lives in a component. That is what lets the production server
 * call these functions to build HTML *before* any JavaScript runs — the whole
 * point of the exercise, since a crawler that never executes React would
 * otherwise see one hard-coded title for every page on the site.
 *
 * It also means the rules are testable as functions rather than through a
 * rendered tree.
 *
 * ---------------------------------------------------------------------------
 * FALLBACKS ARE DETERMINISTIC, NEVER GENERATED
 * ---------------------------------------------------------------------------
 *
 * Every title and description resolves through a fixed chain ending in data the
 * Trader already supplied. When the chain runs out, the tag is OMITTED rather
 * than filled with invented copy: an absent description is a gap a Trader can
 * close, whereas a machine-written one is a claim about their business that
 * nobody approved.
 */

export type SeoLocale = "ar" | "en";

export const seoLocales: readonly SeoLocale[] = ["en", "ar"];

export function isSeoLocale(value: string): value is SeoLocale {
  return value === "en" || value === "ar";
}

export interface SeoAlternate {
  readonly href: string;
  readonly hrefLang: string;
}

export interface SeoDocument {
  readonly alternates: readonly SeoAlternate[];
  readonly canonical: string;
  readonly description: string | null;
  readonly imageUrl: string | null;
  /** schema.org objects. Serialised safely by the renderer, never by hand. */
  readonly jsonLd: readonly Record<string, unknown>[];
  readonly locale: SeoLocale;
  readonly ogType: string;
  readonly robots: string;
  readonly siteName: string;
  readonly title: string;
}

/** A trimmed non-empty string, or null. Blank is never a value. */
function text(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** First non-blank candidate, or null when the whole chain is empty. */
function firstOf(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const value = text(candidate);
    if (value !== null) return value;
  }
  return null;
}

/**
 * A public origin that is safe to build canonical URLs from.
 *
 * A misconfigured origin is not a cosmetic problem: it puts somebody else's
 * hostname into every canonical tag on the site and asks search engines to
 * credit them. So the value is parsed, restricted to http/https, and stripped
 * of any path, query or fragment — and an unusable one throws at startup rather
 * than silently producing wrong canonicals in production.
 */
export function normaliseOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`STORE_PUBLIC_ORIGIN is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`STORE_PUBLIC_ORIGIN must be http or https: ${raw}`);
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * A canonical URL for a locale and path.
 *
 * Query strings are dropped entirely. Tracking parameters, UI state and filter
 * combinations do not create new documents, and treating them as if they did is
 * how a four-page catalogue acquires ten thousand indexable URLs.
 */
export function canonicalUrl(origin: string, locale: SeoLocale, path: string): string {
  const clean = path.split("?")[0]?.split("#")[0] ?? "";
  const trimmed = clean.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? `${origin}/${locale}` : `${origin}/${locale}/${trimmed}`;
}

/**
 * Locale alternates plus `x-default`.
 *
 * Emitted only for paths that genuinely exist in both languages — which, for
 * this Store, is all of them: the slug is language-neutral and the same
 * resource is served in either language. `x-default` points at English as the
 * configured default.
 */
export function localeAlternates(origin: string, path: string): readonly SeoAlternate[] {
  return [
    { href: canonicalUrl(origin, "en", path), hrefLang: "en" },
    { href: canonicalUrl(origin, "ar", path), hrefLang: "ar" },
    { href: canonicalUrl(origin, "en", path), hrefLang: "x-default" },
  ];
}

/** An absolute URL for a relative public media path. */
export function absoluteMediaUrl(origin: string, url: string | null): string | null {
  const value = text(url);
  if (value === null) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `${origin}${value.startsWith("/") ? "" : "/"}${value}`;
}

const ROBOTS_INDEX = "index,follow";
const ROBOTS_NOINDEX = "noindex,follow";

export interface StoreSeoInput {
  readonly displayName: string;
  readonly logoUrl?: string | null;
  readonly publicMobile?: string | null;
  readonly seoDescriptionAr?: string | null;
  readonly seoDescriptionEn?: string | null;
  readonly seoIndexable?: boolean;
  readonly seoTitleAr?: string | null;
  readonly seoTitleEn?: string | null;
  readonly slug: string;
  readonly socialImageUrl?: string | null;
  readonly status?: string;
  readonly storeDescription?: string | null;
}

export function storeSeoDocument(input: {
  readonly locale: SeoLocale;
  readonly origin: string;
  readonly siteName: string;
  readonly store: StoreSeoInput;
}): SeoDocument {
  const { locale, origin, siteName, store } = input;
  const path = store.slug;

  const title =
    locale === "ar"
      ? // Arabic override, then the Store's own name. There is no Arabic
        // display name in the data model, so English is the honest last resort
        // rather than a translation nobody wrote.
        (firstOf(store.seoTitleAr, store.seoTitleEn, store.displayName) ?? store.displayName)
      : (firstOf(store.seoTitleEn, store.displayName) ?? store.displayName);

  const description =
    locale === "ar"
      ? firstOf(store.seoDescriptionAr, store.seoDescriptionEn, store.storeDescription)
      : firstOf(store.seoDescriptionEn, store.storeDescription);

  const imageUrl = absoluteMediaUrl(origin, store.socialImageUrl ?? store.logoUrl ?? null);
  const canonical = canonicalUrl(origin, locale, path);

  // A shop that is not publicly resolvable never reaches this function, so the
  // only remaining question is whether its owner asked to be left out.
  const indexable = store.seoIndexable !== false;

  const jsonLd: Record<string, unknown>[] = [
    {
      "@context": "https://schema.org",
      "@type": "Store",
      name: store.displayName,
      url: canonical,
      ...(description === null ? {} : { description }),
      ...(imageUrl === null ? {} : { logo: imageUrl, image: imageUrl }),
      ...(text(store.publicMobile) === null ? {} : { telephone: text(store.publicMobile) }),
    },
  ];

  return {
    alternates: localeAlternates(origin, path),
    canonical,
    description,
    imageUrl,
    jsonLd,
    locale,
    ogType: "website",
    robots: indexable ? ROBOTS_INDEX : ROBOTS_NOINDEX,
    siteName,
    title,
  };
}

export interface ProductSeoInput {
  readonly availabilityStatus?: string;
  readonly brand?: string | null;
  readonly currency?: string;
  readonly fullDescription?: string | null;
  readonly lifecycleStatus?: string;
  readonly media?: readonly { readonly altText: string | null; readonly url: string }[];
  readonly name: string;
  readonly primaryImage?: { readonly url: string } | null;
  readonly productCode?: string | null;
  readonly sellingPrice?: string;
  readonly seoDescriptionAr?: string | null;
  readonly seoDescriptionEn?: string | null;
  readonly seoIndexable?: boolean;
  readonly seoTitleAr?: string | null;
  readonly seoTitleEn?: string | null;
  readonly shortDescription?: string | null;
  readonly slug: string;
  readonly socialImageUrl?: string | null;
}

export function productSeoDocument(input: {
  readonly locale: SeoLocale;
  readonly origin: string;
  readonly product: ProductSeoInput;
  readonly siteName: string;
  readonly store: StoreSeoInput;
}): SeoDocument {
  const { locale, origin, product, siteName, store } = input;
  const path = `${store.slug}/products/${product.slug}`;
  const canonical = canonicalUrl(origin, locale, path);

  const explicitTitle =
    locale === "ar"
      ? firstOf(product.seoTitleAr, product.seoTitleEn)
      : firstOf(product.seoTitleEn);
  // Deterministic, and deliberately not keyword-stuffed: the Product and the
  // shop it comes from, nothing else.
  const title = explicitTitle ?? `${product.name} — ${store.displayName}`;

  const description =
    locale === "ar"
      ? firstOf(
          product.seoDescriptionAr,
          product.seoDescriptionEn,
          product.shortDescription,
          product.fullDescription,
        )
      : firstOf(product.seoDescriptionEn, product.shortDescription, product.fullDescription);

  // Explicit social image, then the Product's own first image, then the shop's.
  // No development placeholder is ever substituted.
  const firstMedia = product.media?.[0]?.url ?? product.primaryImage?.url ?? null;
  const imageUrl = absoluteMediaUrl(
    origin,
    product.socialImageUrl ?? firstMedia ?? store.socialImageUrl ?? store.logoUrl ?? null,
  );

  // A draft Product is not publicly resolvable at all. An UNAVAILABLE Product
  // still is — the public Store shows it and labels it — so it stays indexable
  // unless its owner opted out.
  const indexable = product.seoIndexable !== false && product.lifecycleStatus !== "draft";

  const availability =
    product.availabilityStatus === "unavailable"
      ? "https://schema.org/OutOfStock"
      : "https://schema.org/InStock";

  const offers: Record<string, unknown> = {
    "@type": "Offer",
    availability,
    priceCurrency: product.currency ?? "AED",
    url: canonical,
    seller: { "@type": "Store", name: store.displayName },
  };
  if (text(product.sellingPrice) !== null) offers.price = text(product.sellingPrice);

  const jsonLd: Record<string, unknown>[] = [
    {
      "@context": "https://schema.org",
      "@type": "Product",
      name: product.name,
      offers,
      ...(description === null ? {} : { description }),
      ...(imageUrl === null ? {} : { image: imageUrl }),
      ...(text(product.brand) === null
        ? {}
        : { brand: { "@type": "Brand", name: text(product.brand) } }),
      ...(text(product.productCode) === null ? {} : { sku: text(product.productCode) }),
      // No aggregateRating and no reviewCount. There is no rating data in this
      // system, and inventing one to earn a rich result would be a lie told at
      // scale.
    },
  ];

  return {
    alternates: localeAlternates(origin, path),
    canonical,
    description,
    imageUrl,
    jsonLd,
    locale,
    ogType: "product",
    robots: indexable ? ROBOTS_INDEX : ROBOTS_NOINDEX,
    siteName,
    title,
  };
}

export interface TaxonomySeoInput {
  readonly descriptionAr?: string | null;
  readonly descriptionEn?: string | null;
  readonly nameAr?: string | null;
  readonly nameEn: string;
  readonly seoDescriptionAr?: string | null;
  readonly seoDescriptionEn?: string | null;
  readonly seoIndexable?: boolean;
  readonly seoTitleAr?: string | null;
  readonly seoTitleEn?: string | null;
  readonly slug: string;
}

export function taxonomySeoDocument(input: {
  readonly category: TaxonomySeoInput;
  readonly locale: SeoLocale;
  readonly origin: string;
  readonly siteName: string;
  readonly subcategory?: TaxonomySeoInput;
}): SeoDocument {
  const { category, locale, origin, siteName, subcategory } = input;
  const subject = subcategory ?? category;
  const path =
    subcategory === undefined
      ? `categories/${category.slug}`
      : `categories/${category.slug}/${subcategory.slug}`;
  const canonical = canonicalUrl(origin, locale, path);

  const localName =
    locale === "ar" ? (firstOf(subject.nameAr, subject.nameEn) ?? subject.nameEn) : subject.nameEn;
  const title =
    (locale === "ar"
      ? firstOf(subject.seoTitleAr, subject.seoTitleEn)
      : firstOf(subject.seoTitleEn)) ?? localName;

  const description =
    locale === "ar"
      ? firstOf(subject.seoDescriptionAr, subject.seoDescriptionEn, subject.descriptionEn)
      : firstOf(subject.seoDescriptionEn, subject.descriptionEn);

  // A breadcrumb trail is the one structured type this page can state truthfully.
  // No ItemList of Products: the page is paged, so listing "the" Products would
  // describe only whichever page happened to be rendered.
  const trail: Record<string, unknown>[] = [
    {
      "@type": "ListItem",
      item: canonicalUrl(origin, locale, "categories"),
      name: "Categories",
      position: 1,
    },
    {
      "@type": "ListItem",
      item: canonicalUrl(origin, locale, `categories/${category.slug}`),
      name: locale === "ar" ? (firstOf(category.nameAr, category.nameEn) ?? category.nameEn) : category.nameEn,
      position: 2,
    },
  ];
  if (subcategory !== undefined) {
    trail.push({ "@type": "ListItem", item: canonical, name: localName, position: 3 });
  }

  return {
    alternates: localeAlternates(origin, path),
    canonical,
    description,
    imageUrl: null,
    jsonLd: [
      { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: trail },
    ],
    locale,
    ogType: "website",
    robots: subject.seoIndexable === false ? ROBOTS_NOINDEX : ROBOTS_INDEX,
    siteName,
    title,
  };
}

/** The marketplace root. */
export function marketplaceSeoDocument(input: {
  readonly locale: SeoLocale;
  readonly origin: string;
  readonly siteName: string;
}): SeoDocument {
  const canonical = canonicalUrl(input.origin, input.locale, "");
  return {
    alternates: localeAlternates(input.origin, ""),
    canonical,
    description:
      input.locale === "ar"
        ? "تسوّق من المتاجر المحلية في الإمارات وادفع نقدًا عند الاستلام."
        : "Shop local stores across the UAE and pay cash on delivery.",
    imageUrl: null,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: input.siteName,
        url: canonical,
      },
    ],
    locale: input.locale,
    ogType: "website",
    robots: ROBOTS_INDEX,
    siteName: input.siteName,
    title: input.siteName,
  };
}

/**
 * The Category index.
 *
 * A real, indexable page rather than a fall-through to not-found. It is listed
 * in the sitemap, so publishing it as `noindex` would ask a crawler to fetch a
 * page and then discard it.
 *
 * No `ItemList` of Categories: the taxonomy is Platform-managed and changes
 * without any signal here, and structured data that quietly drifts out of date
 * is worse than none.
 */
export function categoryIndexSeoDocument(input: {
  readonly locale: SeoLocale;
  readonly origin: string;
  readonly siteName: string;
}): SeoDocument {
  const canonical = canonicalUrl(input.origin, input.locale, "categories");
  return {
    alternates: localeAlternates(input.origin, "categories"),
    canonical,
    description:
      input.locale === "ar"
        ? "تصفّح فئات السوق."
        : "Browse the marketplace by category.",
    imageUrl: null,
    jsonLd: [],
    locale: input.locale,
    ogType: "website",
    robots: ROBOTS_INDEX,
    siteName: input.siteName,
    title: input.locale === "ar" ? "الفئات" : "Categories",
  };
}

/** Metadata for a page that does not exist. Never indexable. */
export function notFoundSeoDocument(input: {
  readonly locale: SeoLocale;
  readonly origin: string;
  readonly path: string;
  readonly siteName: string;
}): SeoDocument {
  return {
    alternates: [],
    canonical: canonicalUrl(input.origin, input.locale, input.path),
    description: null,
    imageUrl: null,
    jsonLd: [],
    locale: input.locale,
    ogType: "website",
    robots: "noindex,nofollow",
    siteName: input.siteName,
    title: input.siteName,
  };
}
