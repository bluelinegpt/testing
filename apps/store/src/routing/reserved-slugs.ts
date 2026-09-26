/**
 * Marketplace words a Store slug may never be.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIST EXISTS BEFORE THE ROUTES DO
 * ---------------------------------------------------------------------------
 *
 * The Store lives at `/{store-slug}` — the marketplace root namespace itself.
 * That is the right URL for a shop and it means every future top-level page
 * competes with it: the day `/cart` ships, a shop that already claimed the slug
 * `cart` either breaks the cart or is silently unreachable, and by then real
 * links to it exist.
 *
 * Reserving the words NOW costs nothing. Reserving them later means telling a
 * Trader their shop address is being taken away.
 *
 * Only a handful of these routes are implemented in this prompt. The rest are
 * reserved precisely because they are not implemented yet.
 */
export const reservedStoreSlugs: ReadonlySet<string> = new Set([
  // Implemented or imminent marketplace surfaces.
  "categories",
  "category",
  "search",
  // Customer account surfaces (Shared Commerce Foundation Prompt 3A).
  "register",
  "login",
  "logout",
  "forgot-password",
  "reset-password",
  "account",
  "orders",
  "cart",
  "checkout",
  "track",
  "wishlist",
  // Support and legal.
  "support",
  "help",
  "contact",
  "privacy",
  "terms",
  "about",
  // Infrastructure names that must never resolve to a shop.
  "admin",
  "api",
  "assets",
  "static",
  "public",
  "health",
  "manifest",
  "sw",
]);

/**
 * Whether a path segment may be treated as a Store slug.
 *
 * Case-insensitive because the Storefront slug index is: `Cart` and `cart` are
 * one word, and a reservation that only matched lowercase would be trivially
 * sidestepped.
 */
export function isReservedStoreSlug(slug: string): boolean {
  return reservedStoreSlugs.has(slug.trim().toLowerCase());
}
