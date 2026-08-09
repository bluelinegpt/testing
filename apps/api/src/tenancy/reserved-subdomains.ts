/**
 * Host labels that may never belong to a Company.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE LIST AND NOT A CHECK IN THE RESOLVER
 * ---------------------------------------------------------------------------
 *
 * `CompanyHostResolver` used to exclude exactly one name — `www` — inline. That
 * was fine while `www` was the only non-tenant host. It stops being fine the
 * moment a second application is served from the same domain: the Platform
 * Administration Portal answers on `platform.bluelinegpt.com`, and a resolver
 * that does not know the word `platform` would happily read that host as the
 * tenant label of a Company whose subdomain is `platform`.
 *
 * Two independent things therefore have to agree, forever:
 *
 *   1. host resolution must refuse to read a reserved label as a Company, and
 *   2. a Company must never be able to claim a reserved label in the first
 *      place.
 *
 * If those two lists were written separately they would drift, and the drift
 * would be silent until the day a Company registered `platform` and took over
 * the Platform Portal's hostname. So the list lives here once, the resolver
 * reads it, and the database check constraint added by
 * `20260808100000_platform_administration_foundation` is generated from exactly
 * these words. The test `reserved-subdomains.test.ts` asserts the two stay in
 * step.
 *
 * ---------------------------------------------------------------------------
 * WHY MORE THAN `platform` AND `www`
 * ---------------------------------------------------------------------------
 *
 * Reserving a word costs nothing today. Un-reserving one later means telling a
 * Company its address is being taken away, after real links to it exist. The
 * names below are the ones this product has already committed to (`store` is a
 * shipped application; `api` is the API host) plus the small set that every
 * multi-tenant deployment eventually needs.
 */
export const reservedCompanySubdomains: readonly string[] = [
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "cdn",
  "dashboard",
  "internal",
  "mail",
  "platform",
  "static",
  "status",
  "store",
  "support",
  "www",
];

const reservedSet: ReadonlySet<string> = new Set(reservedCompanySubdomains);

/**
 * Whether a candidate Company subdomain is reserved.
 *
 * Case- and whitespace-insensitive, because `companies_subdomain_unique` is
 * built on `lower(subdomain)`: `Platform` and `platform` are one name, and a
 * reservation that only matched the lowercase spelling would be sidestepped by
 * typing a capital letter.
 */
export function isReservedCompanySubdomain(subdomain: string): boolean {
  return reservedSet.has(subdomain.trim().toLowerCase());
}
