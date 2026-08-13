import { sql } from "kysely";

/**
 * All (company_id, trader_id) legacy Trader pairs sharing one Trader Commerce
 * identity -- the fan-out `orders` reads need for the Trader Portal's "one
 * common Trader Order history" view (Trader Portal Prompt 3T-C, Part C).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS INSTEAD OF WIDENING THE SESSION
 * ---------------------------------------------------------------------------
 *
 * `accounts.company_id`, `IdentityContext.companyId` and `TenantContext.companyId`
 * are all single-Company by construction, and dozens of call sites -- most
 * pointedly Driver Cash Reconciliation and Trader Settlements -- depend on that
 * being true for exactly one Company per session. Rewriting the session to
 * carry a list would touch every one of them for a benefit this feature does
 * not need: read access, not a different login.
 *
 * Instead this mirrors the pattern `apps/api/src/storefront/storefront-access.ts`
 * already established for Storefronts/Products: resolve the caller's own
 * `trader_id` to its `trader_commerce_id` via `trader_commerce_company_links`
 * (an IDENTITY table, unique per `trader_id`), then expand back out to every
 * `trader_id` -- across every Company -- linked to that same identity. Only
 * `status = 'active'` links contribute, matching `accessibleStorefrontIds`.
 *
 * Read-only: nothing here writes to `orders`, `trader_commerce_company_links`,
 * or any reconciliation/settlement table, and the caller's own single-Company
 * session (`identity.companyId`, `traderForAccount`) is never touched.
 */
export function traderCommerceOrderScopePairs(callerTraderId: string) {
  return sql<{ companyId: string; traderId: string }>`
    select link.company_id as "companyId", link.trader_id as "traderId"
      from trader_commerce_company_links link
     where link.status = 'active'
       and link.trader_commerce_id = (
         select owned.trader_commerce_id
           from trader_commerce_company_links owned
          where owned.trader_id = ${callerTraderId}::uuid
       )
  `;
}
