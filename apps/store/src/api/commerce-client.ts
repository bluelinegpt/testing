import { storeConfiguration } from "../config/environment.js";

import type {
  CommerceResult,
  MarketplaceCategory,
  MarketplaceCategoryDetail,
  MarketplaceProduct,
  Paged,
  PublicProduct,
  PublicProductDetail,
  PublicStore,
  PublicStoreSummary,
  StoreCategory,
} from "./commerce-types.js";

/**
 * The Store's Commerce API client.
 *
 * ---------------------------------------------------------------------------
 * WRITTEN FROM SCRATCH, NOT COPIED FROM THE PORTAL
 * ---------------------------------------------------------------------------
 *
 * The Delivery Portal's client carries Company-session assumptions — tenant
 * headers, a 401 handler that redirects to an employee login, permission-aware
 * error translation. None of that is meaningful for an anonymous shopper, and
 * importing it would have made the Store depend on the portal's auth model on
 * day one.
 *
 * ---------------------------------------------------------------------------
 * FAILURES ARE TRANSLATED, NEVER FORWARDED
 * ---------------------------------------------------------------------------
 *
 * Every call returns `ok` or one of exactly two reasons: `not_found` or
 * `unavailable`. Raw status codes, API error codes and internal identifiers do
 * not reach the UI, because a customer-facing page has nothing useful to do
 * with them and an error body is a common way for internal detail to leak out
 * of a system that was otherwise careful.
 *
 * `credentials: "omit"` is explicit: these endpoints are anonymous, and sending
 * cookies that do not exist yet would only invite a future reviewer to assume
 * this surface is authenticated.
 */

async function get<T>(path: string, signal?: AbortSignal): Promise<CommerceResult<T>> {
  try {
    const response = await fetch(`${storeConfiguration.apiBaseUrl}/${path}`, {
      credentials: "omit",
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 404) return { kind: "error", reason: "not_found" };
    if (!response.ok) return { kind: "error", reason: "unavailable" };
    return { kind: "ok", value: (await response.json()) as T };
  } catch {
    // An aborted request lands here too. The caller discards the result of a
    // superseded request either way, so there is nothing to distinguish.
    return { kind: "error", reason: "unavailable" };
  }
}

const encode = encodeURIComponent;

/** Published Stores for the marketplace. Real rows only — never padded. */
export function fetchPublicStores(
  signal?: AbortSignal,
): Promise<CommerceResult<{ items: readonly PublicStoreSummary[] }>> {
  return get("public/storefronts", signal);
}

export function fetchPublicStore(
  slug: string,
  signal?: AbortSignal,
): Promise<CommerceResult<PublicStore>> {
  return get(`public/storefronts/${encode(slug)}`, signal);
}

export function fetchStoreCategories(
  slug: string,
  signal?: AbortSignal,
): Promise<CommerceResult<{ items: readonly StoreCategory[] }>> {
  return get(`public/storefronts/${encode(slug)}/categories`, signal);
}

export function fetchStoreProducts(
  slug: string,
  signal?: AbortSignal,
): Promise<CommerceResult<{ items: readonly PublicProduct[] }>> {
  return get(`public/storefronts/${encode(slug)}/products?pageSize=48`, signal);
}

/**
 * One Product with media, options and full description.
 *
 * The list response carries only a primary image by design, so a detail page
 * built from a list item would show one photo, no video and no options. The
 * detail endpoint is what supplies those and must be asked for separately.
 */
export function fetchStoreProduct(
  storeSlug: string,
  productSlug: string,
  signal?: AbortSignal,
): Promise<CommerceResult<PublicProductDetail>> {
  return get(
    `public/storefronts/${encode(storeSlug)}/products/${encode(productSlug)}`,
    signal,
  );
}

// ------------------------------------------------ Platform marketplace taxonomy

export function fetchMarketplaceCategories(
  signal?: AbortSignal,
): Promise<CommerceResult<{ items: readonly MarketplaceCategory[] }>> {
  return get("public/marketplace/categories", signal);
}

export function fetchMarketplaceCategory(
  categorySlug: string,
  signal?: AbortSignal,
): Promise<CommerceResult<MarketplaceCategoryDetail>> {
  return get(`public/marketplace/categories/${encode(categorySlug)}`, signal);
}

export function fetchCategoryStores(
  categorySlug: string,
  signal?: AbortSignal,
): Promise<CommerceResult<{ items: readonly PublicStoreSummary[] }>> {
  return get(`public/marketplace/categories/${encode(categorySlug)}/stores`, signal);
}

/**
 * Products in a Category, or in exactly one Subcategory.
 *
 * Paged server-side. The Store never asks for "all products" — that endpoint
 * does not exist, on purpose.
 */
export function fetchCategoryProducts(
  categorySlug: string,
  options: { readonly page?: number; readonly subcategorySlug?: string } = {},
  signal?: AbortSignal,
): Promise<CommerceResult<Paged<MarketplaceProduct>>> {
  const page = options.page === undefined ? "" : `?page=${options.page}`;
  const base = `public/marketplace/categories/${encode(categorySlug)}`;
  const path =
    options.subcategorySlug === undefined
      ? `${base}/products${page}`
      : `${base}/subcategories/${encode(options.subcategorySlug)}/products${page}`;
  return get(path, signal);
}
