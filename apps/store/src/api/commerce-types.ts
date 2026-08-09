/**
 * The Commerce vocabulary this application understands.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------------------------------------------------------
 *
 * There is no Driver, Settlement, Reconciliation, Receivable, Accounting Event
 * or Company here, and no type in this file is imported from the Delivery
 * Portal. That is the isolation rule made concrete: if a Delivery concept were
 * ever needed to render a shop page, the Store would have quietly become part
 * of the operations application again.
 *
 * These shapes mirror the API's PUBLIC projections. The backend allow-list is
 * the authority — a field absent there cannot be obtained by declaring it here
 * — but stating the shape explicitly means a widened backend response does not
 * silently start flowing into customer-facing code.
 *
 * Note what is missing from `PublicStore`: no `companyId`, no `traderId`, no
 * `traderCommerceId`, no relationship rows. A shop's public identity is its
 * slug, and its owner is nobody's business but its own.
 */

export interface PublicStoreSummary {
  readonly displayName: string;
  readonly logoUrl: string | null;
  readonly slug: string;
  readonly status: "published" | "temporarily_closed";
  readonly storeDescription: string | null;
}

export interface PublicStoreBusinessHours {
  readonly days: string;
  readonly time: string;
}

export interface PublicStore extends PublicStoreSummary {
  readonly brandAccentColor: string | null;
  readonly brandPrimaryColor: string | null;
  readonly businessHours: readonly PublicStoreBusinessHours[];
  readonly businessTemplate: string;
  readonly coverUrl: string | null;
  readonly customerSupport: string | null;
  readonly deliveryInformation: string | null;
  readonly publicEmail: string | null;
  readonly publicMobile: string | null;
  readonly publicWhatsapp: string | null;
  readonly returnPolicy: string | null;
  readonly terms: string | null;
  readonly theme: string;
}

/**
 * A category BELONGING TO ONE STORE.
 *
 * Named `StoreCategory`, not `Category`, because a platform-wide marketplace
 * taxonomy is a different thing that does not exist yet. Collapsing the two
 * names now would make the later distinction a rename across the codebase
 * instead of a new type beside this one.
 */
export interface StoreCategory {
  readonly name: string;
  readonly slug: string;
}

export interface PublicProductMedia {
  readonly altText: string | null;
  readonly mediaType: "image" | "video";
  readonly posterUrl: string | null;
  readonly url: string;
}

export interface PublicProductOptionGroup {
  readonly isRequired: boolean;
  readonly name: string;
  readonly values: readonly { readonly value: string }[];
}

export interface PublicProduct {
  readonly availabilityStatus: "available" | "unavailable";
  readonly brand: string | null;
  readonly categoryName: string | null;
  readonly categorySlug: string | null;
  readonly currency: string;
  readonly name: string;
  readonly previousPrice: string | null;
  readonly primaryImage: { readonly altText: string | null; readonly url: string } | null;
  readonly productCode: string | null;
  readonly sellingPrice: string;
  readonly slug: string;
}

export interface PublicProductDetail extends PublicProduct {
  readonly fullDescription: string | null;
  readonly maximumQuantity: number | null;
  readonly media: readonly PublicProductMedia[];
  readonly minimumQuantity: number | null;
  readonly options: readonly PublicProductOptionGroup[];
  readonly shortDescription: string | null;
  readonly templateAttributes: Readonly<Record<string, unknown>>;
}

/** Why a public request did not produce content. Never a raw API error. */
export type CommerceFailure = "not_found" | "unavailable";

export type CommerceResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "error"; readonly reason: CommerceFailure };

/**
 * PLATFORM marketplace taxonomy — deliberately not called `Category`.
 *
 * `StoreCategory` above is the Trader's own shelf label inside one shop. This
 * is the Platform vocabulary shared across every shop. They are different
 * systems with different owners, and the type names say so, so a future reader
 * cannot mistake one for the other at a glance.
 */
export interface MarketplaceSubcategory {
  readonly displayOrder: number;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly slug: string;
}

export interface MarketplaceCategory {
  readonly descriptionAr: string | null;
  readonly descriptionEn: string | null;
  readonly displayOrder: number;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly slug: string;
  readonly subcategoryCount: number;
}

export interface MarketplaceCategoryDetail {
  readonly descriptionAr: string | null;
  readonly descriptionEn: string | null;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly slug: string;
  readonly subcategories: readonly MarketplaceSubcategory[];
}

/** A Product as it appears on a marketplace Category page. */
export interface MarketplaceProduct {
  readonly availabilityStatus: "available" | "unavailable";
  readonly brand: string | null;
  readonly currency: string;
  readonly name: string;
  readonly previousPrice: string | null;
  readonly primaryImage: { readonly altText: string | null; readonly url: string } | null;
  readonly sellingPrice: string;
  readonly slug: string;
  readonly storeName: string;
  readonly storeSlug: string;
}

export interface Paged<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}
