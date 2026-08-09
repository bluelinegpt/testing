/**
 * Trader Storefront vocabulary and the rules that govern it.
 *
 * Every list here is also a database CHECK. That duplication is deliberate and
 * one-directional: the database is authoritative, and these constants exist so
 * a bad value is refused with a field error instead of a constraint violation.
 * They are imported by the DTOs rather than retyped, so there is one list, not
 * three that drift.
 */

export const storefrontTemplates = ["fashion", "electronics", "jewelry", "general"] as const;
export type StorefrontTemplate = (typeof storefrontTemplates)[number];

export const storefrontThemes = ["luxury_minimal", "modern", "clean_light"] as const;
export type StorefrontTheme = (typeof storefrontThemes)[number];

export const storefrontStatuses = [
  "draft",
  "published",
  "temporarily_closed",
  "unpublished",
  "suspended",
] as const;
export type StorefrontStatus = (typeof storefrontStatuses)[number];

/**
 * The only statuses a public visitor may resolve.
 *
 * `temporarily_closed` is included because the shop still exists and its
 * customers should see that it is closed rather than that it is gone. Checkout
 * blocking for that state belongs to the cart work and is not implemented here.
 */
export const publiclyResolvableStatuses: readonly StorefrontStatus[] = [
  "published",
  "temporarily_closed",
];

/**
 * Route words the slug may never take.
 *
 * A Storefront slug is a path segment under `/store/`, but these names also
 * appear as application routes, well-known paths, or words a customer would
 * reasonably read as belonging to BluelineGPT rather than to a shop. Claiming
 * one would let a Trader impersonate the platform.
 */
export const reservedStorefrontSlugs: ReadonlySet<string> = new Set([
  "about",
  "account",
  "accounting",
  "admin",
  "administrator",
  "api",
  "app",
  "assets",
  "auth",
  "billing",
  "blueline",
  "bluelinegpt",
  "cart",
  "checkout",
  "config",
  "contact",
  "dashboard",
  "delivery",
  "docs",
  "drivers",
  "help",
  "internal",
  "login",
  "logout",
  "new",
  "operations",
  "orders",
  "payments",
  "payroll",
  "portal",
  "preview",
  "privacy",
  "public",
  "register",
  "reports",
  "root",
  "security",
  "settings",
  "signin",
  "signup",
  "static",
  "store",
  "storefront",
  "storefront-preview",
  "support",
  "system",
  "terms",
  "trader",
  "traders",
  "tracking",
  "www",
]);

export const storefrontSlugMinLength = 3;
export const storefrontSlugMaxLength = 63;

/** The shape the database CHECK also enforces. */
export const storefrontSlugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Normalises a candidate into slug shape.
 *
 * Used for BOTH the generated suggestion and the stored value, so what a user
 * is told is available is exactly what gets written. Arabic and other
 * non-Latin display names normalise to nothing here; the caller is expected to
 * ask for a slug rather than invent a transliteration, because a machine
 * transliteration of a shop name is a guess that ends up in a public URL.
 */
export function normaliseStorefrontSlug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, storefrontSlugMaxLength)
    .replace(/-$/, "");
}

export type SlugRejection =
  | "storefront_slug_required"
  | "storefront_slug_too_short"
  | "storefront_slug_too_long"
  | "storefront_slug_invalid"
  | "storefront_slug_reserved";

/** Every reason a slug is unusable EXCEPT already being taken, which is a read. */
export function rejectStorefrontSlug(slug: string): SlugRejection | null {
  if (slug.length === 0) return "storefront_slug_required";
  if (slug.length < storefrontSlugMinLength) return "storefront_slug_too_short";
  if (slug.length > storefrontSlugMaxLength) return "storefront_slug_too_long";
  if (!storefrontSlugPattern.test(slug)) return "storefront_slug_invalid";
  if (reservedStorefrontSlugs.has(slug)) return "storefront_slug_reserved";
  return null;
}

/**
 * Permitted status moves.
 *
 * `suspended` is absent from every source list: a suspension is lifted through
 * its own authorised operation, never by a Trader steering the status graph
 * around it.
 */
const storefrontTransitions: Readonly<Record<StorefrontStatus, readonly StorefrontStatus[]>> = {
  draft: ["published"],
  published: ["temporarily_closed", "unpublished"],
  temporarily_closed: ["published", "unpublished"],
  unpublished: ["published"],
  suspended: [],
};

export function canTransitionStorefront(from: StorefrontStatus, to: StorefrontStatus): boolean {
  return storefrontTransitions[from].includes(to);
}

/**
 * Fields a Storefront must carry before it may be published.
 *
 * Publication is the moment a Trader's shop becomes a public page, so the
 * profile has to be complete enough that a customer can identify it, contact
 * it and know its delivery and returns terms.
 */
export const requiredForPublication = [
  "displayName",
  "slug",
  "businessTemplate",
  "theme",
  "storeDescription",
  "publicMobile",
  "deliveryInformation",
  "returnPolicy",
] as const;
