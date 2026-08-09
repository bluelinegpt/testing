import { webConfiguration } from "../../configuration/environment.js";
import { fashionStore } from "../data/fashion-store.js";
import { electronicsStore } from "../data/electronics-store.js";
import { generalStore } from "../data/general-store.js";
import { jewelryStore } from "../data/jewelry-store.js";
import type {
  StoreConfig,
  StorefrontProduct,
  StorefrontProfile,
  StorefrontTemplateKey,
  StorefrontThemeKey,
} from "../types.js";

/**
 * Public Storefront resolution.
 *
 * ---------------------------------------------------------------------------
 * THE PROFILE IS REAL; THE PRODUCTS ARE STILL SAMPLES
 * ---------------------------------------------------------------------------
 *
 * `/store/:slug` now asks the API which shop lives at that address and renders
 * the persisted profile — name, template, theme, branding, contact details,
 * policies and open/closed status. The catalogue is still the static sample
 * set, because Products do not exist until Prompt 4.
 *
 * The two are kept visibly separate: the sample catalogue is chosen by the
 * REAL Storefront's business template, so a persisted Jewelry shop shows the
 * jewelry sample catalogue rather than an unrelated one. Nothing about the
 * Trader's identity comes from the samples.
 *
 * ---------------------------------------------------------------------------
 * AN UNKNOWN SLUG IS NOT A SAMPLE SHOP
 * ---------------------------------------------------------------------------
 *
 * There is deliberately no fallback here. If the API does not resolve a slug —
 * because it is unknown, draft, unpublished or suspended — the caller gets
 * `not-found` and shows the generic not-found page. Silently substituting a
 * sample Trader would put a real customer in front of a shop that is not the
 * one they were sent to.
 */

/** Exactly the allow-listed fields the public endpoint returns. */
export interface PublicStorefront {
  readonly brandAccentColor: string | null;
  readonly brandPrimaryColor: string | null;
  readonly businessHours: readonly { readonly days: string; readonly time: string }[];
  readonly businessTemplate: string;
  readonly customerSupport: string | null;
  readonly deliveryInformation: string | null;
  readonly displayName: string;
  readonly publicEmail: string | null;
  readonly publicMobile: string | null;
  readonly publicWhatsapp: string | null;
  readonly returnPolicy: string | null;
  readonly slug: string;
  readonly status: "published" | "temporarily_closed";
  readonly storeDescription: string | null;
  readonly terms: string | null;
  readonly theme: string;
  /**
   * Present ONLY when the requested slug was a retired one. It names the
   * Storefront's current address, which the caller navigates to once.
   */
  readonly canonicalSlug?: string;
}

export type PublicStorefrontResult =
  | { readonly kind: "found"; readonly storefront: PublicStorefront }
  | { readonly kind: "not-found" }
  | { readonly kind: "error" };

export async function resolvePublicStorefront(
  slug: string,
  signal?: AbortSignal,
): Promise<PublicStorefrontResult> {
  try {
    const response = await fetch(
      `${webConfiguration.apiBaseUrl}/public/storefronts/${encodeURIComponent(slug)}`,
      { headers: { Accept: "application/json" }, ...(signal === undefined ? {} : { signal }) },
    );
    if (response.status === 404) return { kind: "not-found" };
    if (!response.ok) return { kind: "error" };
    return { kind: "found", storefront: (await response.json()) as PublicStorefront };
  } catch {
    // A network failure is NOT a missing shop. Reporting it as not-found would
    // tell a customer their Trader has gone away because the API blipped.
    return { kind: "error" };
  }
}

/** The API's snake_case theme keys mapped to the prototype's token keys. */
const themeKeys: Readonly<Record<string, StorefrontThemeKey>> = {
  clean_light: "clean-light",
  luxury_minimal: "luxury-minimal",
  modern: "modern",
};

const templateKeys: Readonly<Record<string, StorefrontTemplateKey>> = {
  electronics: "electronics",
  fashion: "fashion",
  general: "general",
  jewelry: "jewelry",
};

/** Sample catalogues, selected by the REAL Storefront's business template. */
const sampleCatalogues: Readonly<Record<StorefrontTemplateKey, StoreConfig>> = {
  electronics: electronicsStore,
  fashion: fashionStore,
  general: generalStore,
  jewelry: jewelryStore,
};

/**
 * Builds the shape the existing Prompt 1–2 components already consume.
 *
 * Every profile field comes from the API. Only `categories`, `products` and the
 * delivery-charge figures come from the sample catalogue, and those are the
 * three things Prompt 4 replaces.
 */
export function toStoreConfig(
  storefront: PublicStorefront,
  products: readonly StorefrontProduct[] = [],
): StoreConfig {
  const templateKey = templateKeys[storefront.businessTemplate] ?? "general";
  const themeKey = themeKeys[storefront.theme] ?? "clean-light";
  const sample = sampleCatalogues[templateKey];

  const hours = storefront.businessHours.map((entry) => ({
    days: entry.days,
    time: entry.time,
  }));

  const profile: StorefrontProfile = {
    category: sample.profile.category,
    description: storefront.storeDescription ?? "",
    hours: hours.length > 0 ? hours : [],
    location: "",
    // A single initial, derived locally. No logo binary is fetched here.
    logoInitial: storefront.displayName.trim().charAt(0).toUpperCase() || "S",
    mobile: storefront.publicMobile ?? "",
    name: storefront.displayName,
    paymentMethod: sample.profile.paymentMethod,
    policies: {
      delivery: storefront.deliveryInformation ?? "",
      returns: storefront.returnPolicy ?? "",
    },
    slug: storefront.slug,
    whatsapp: storefront.publicWhatsapp ?? "",
  };

  // Categories are derived from the REAL catalogue so a shop never advertises
  // a section it has nothing in. The LABEL is the category's name; using the
  // slug showed customers "dev-kaftans" where the Trader wrote "Dev Kaftans".
  const categories = [
    ...new Map(
      products.map((product) => [
        product.category,
        { key: product.category, label: product.categoryLabel ?? product.category },
      ]),
    ).values(),
  ];

  return {
    categories,
    delivery: sample.delivery,
    // This store is a real, persisted Storefront. The chrome uses the flag to
    // suppress the prototype/sample-data disclaimer, which is false here and
    // was being shown to a published Trader's customers.
    isPersisted: true,
    products,
    profile,
    templateKey,
    themeKey,
  };
}

/**
 * Public Product Catalogue.
 *
 * ---------------------------------------------------------------------------
 * REAL PRODUCTS REPLACE THE SAMPLES; AN EMPTY SHOP STAYS EMPTY
 * ---------------------------------------------------------------------------
 *
 * A configured Storefront's catalogue now comes from the API. A Storefront
 * with no active Products renders the empty-catalogue state — it must NEVER
 * fall back to sample Products, because a customer would then be shown goods
 * the Trader does not sell. The sample catalogues remain reachable only from
 * the development-only `/storefront-preview` route.
 */

export interface PublicProduct {
  readonly availabilityStatus: "available" | "unavailable";
  readonly categoryName: string | null;
  readonly categorySlug: string | null;
  readonly currency: string;
  readonly name: string;
  readonly previousPrice: string | null;
  readonly primaryImage: { readonly altText: string | null; readonly url: string } | null;
  readonly productCode: string | null;
  readonly sellingPrice: string;
  readonly shortDescription: string | null;
  readonly slug: string;
  readonly templateAttributes: Readonly<Record<string, string>>;
}

export interface PublicProductDetail extends PublicProduct {
  readonly fullDescription: string | null;
  readonly maximumQuantity: number | null;
  readonly media: readonly {
    readonly altText: string | null;
    readonly mediaType: "image" | "video";
    readonly posterUrl: string | null;
    readonly url: string;
  }[];
  readonly minimumQuantity: number | null;
  readonly options: readonly {
    readonly isRequired: boolean;
    readonly name: string;
    readonly values: readonly { readonly value: string }[];
  }[];
}

async function publicGet<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const response = await fetch(`${webConfiguration.apiBaseUrl}/${path}`, {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function fetchPublicProducts(
  storefrontSlug: string,
  signal?: AbortSignal,
): Promise<{ items: readonly PublicProduct[] } | null> {
  return publicGet(
    `public/storefronts/${encodeURIComponent(storefrontSlug)}/products?pageSize=48`,
    signal,
  );
}

/**
 * One Product with its media, options and full description.
 *
 * The LIST response deliberately carries only a primary image, so a detail
 * page built from a list item shows one photo, no video and no options. The
 * detail endpoint is what supplies those, and it must be asked for.
 */
export function fetchPublicProduct(
  storefrontSlug: string,
  productSlug: string,
  signal?: AbortSignal,
): Promise<PublicProductDetail | null> {
  return publicGet(
    `public/storefronts/${encodeURIComponent(storefrontSlug)}/products/${encodeURIComponent(productSlug)}`,
    signal,
  );
}

export function fetchPublicCategories(
  storefrontSlug: string,
  signal?: AbortSignal,
): Promise<{ items: readonly { name: string; slug: string }[] } | null> {
  return publicGet(
    `public/storefronts/${encodeURIComponent(storefrontSlug)}/categories`,
    signal,
  );
}

/**
 * Maps an API Product onto the shape the shared prototype components consume.
 *
 * Size and colour come from the Product's OPTION groups when present, matched
 * by name, because the MVP option model is where those live. A Product with no
 * such group simply has none, and the components render accordingly.
 */
export function toStorefrontProduct(
  product: PublicProduct,
  detail?: PublicProductDetail,
): StorefrontProduct {
  const group = (name: RegExp) => detail?.options.find((entry) => name.test(entry.name));
  const optionValues = (name: RegExp): readonly string[] =>
    group(name)?.values.map((v) => v.value) ?? [];
  const sizeGroup = group(/size/i);

  /** "careInstructions" reads as "Care instructions" to a customer. */
  const humanise = (key: string): string =>
    key
      // Sentence case, matching the labels the authenticated editor shows:
      // "Care instructions", not "Care Instructions".
      .replace(/([a-z0-9])([A-Z])/g, (_, before: string, after: string) =>
        `${before} ${after.toLowerCase()}`,
      )
      .replace(/^./, (first) => first.toUpperCase());

  const media = (detail?.media ?? []).map((entry) => ({
    kind: entry.mediaType,
    label: entry.altText ?? product.name,
    tone: "sand",
    ...(entry.posterUrl === null ? {} : { posterUrl: entry.posterUrl }),
    url: entry.url,
  }));
  const fallbackMedia =
    product.primaryImage === null
      ? []
      : [
          {
            kind: "image" as const,
            label: product.primaryImage.altText ?? product.name,
            tone: "sand",
            url: product.primaryImage.url,
          },
        ];

  return {
    attributes: Object.entries(product.templateAttributes).map(([label, value]) => ({
      label: humanise(label),
      value,
    })),
    available: product.availabilityStatus === "available",
    badges: [],
    category: product.categorySlug ?? "all",
    categoryLabel: product.categoryName ?? product.categorySlug ?? "all",
    code: product.productCode ?? product.slug,
    colors: optionValues(/colou?r/i),
    description: detail?.fullDescription ?? product.shortDescription ?? "",
    media: media.length > 0 ? media : fallbackMedia,
    name: product.name,
    // A required group must be visibly identified before checkout can enforce
    // the choice; the asterisk is the same convention the authenticated editor
    // uses for required template attributes.
    ...(sizeGroup === undefined
      ? {}
      : { optionLabel: sizeGroup.isRequired ? `${sizeGroup.name} *` : sizeGroup.name }),
    ...(product.previousPrice === null ? {} : { previousPrice: product.previousPrice }),
    price: product.sellingPrice,
    sizes: optionValues(/size/i),
    slug: product.slug,
  };
}
