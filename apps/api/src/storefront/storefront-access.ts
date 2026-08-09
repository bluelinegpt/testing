import { sql } from "kysely";

/**
 * Who may reach which Storefront, expressed once.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP IS THE SHOP, ACCESS IS THE RELATIONSHIP
 * ---------------------------------------------------------------------------
 *
 * Until 0B-1 every Store query said `company_id = <session Company>`. That
 * conflated two different questions -- who OWNS this Store, and who may act on
 * it -- and answered both with the Delivery Company. A shop that changed
 * Delivery Company would have changed owner, and a shop with no Delivery
 * Company could not be reached at all.
 *
 * Ownership now belongs to `trader_commerce_id`. This module answers only the
 * access question, and answers it differently for the two kinds of actor:
 *
 *   Trader actor    -- reaches the Stores of the Trader Commerce identity its
 *                      own Trader record is linked to. Note this reads
 *                      `trader_commerce_company_links`, which is IDENTITY, not
 *                      `trader_delivery_company_relationships`, which is
 *                      SERVICE. A Trader whose last Delivery Company is
 *                      suspended, terminated, or deleted outright keeps its
 *                      shop; that is the entire point of the conversion.
 *
 *   Company user    -- reaches only the Stores of Trader Commerce identities
 *                      its Company currently has an ACTIVE relationship with.
 *                      Being a user of some Company grants nothing by itself.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SUBQUERY AND NOT A JOIN CONDITION
 * ---------------------------------------------------------------------------
 *
 * Every caller applies it as `<something>.storefront_id in (...)`, including
 * the loaders that fetch a Category, a media row or an option group by its own
 * id. Those rows have no Company column worth trusting any more, and giving
 * each call site its own hand-written join is how one of them eventually ends
 * up missing the predicate. One expression, interpolated everywhere, is
 * auditable by reading a single function.
 *
 * `users_roles.manage` deliberately does NOT appear here. Company-administrator
 * escalation decides which OPERATIONS a user may perform; it does not widen
 * which Stores exist for them. An administrator of a Company with no
 * relationship to a shop resolves to an empty set exactly like any other user
 * of that Company, which is what stops the permission becoming a global
 * Commerce super-admin.
 */
export function accessibleStorefrontIds(input: {
  readonly callerTraderId: string | null;
  readonly companyId: string;
}) {
  if (input.callerTraderId !== null) {
    return sql`
      select storefront.id
        from trader_storefronts storefront
        join trader_commerce_company_links link
          on link.trader_commerce_id = storefront.trader_commerce_id
       where link.trader_id = ${input.callerTraderId}::uuid
    `;
  }
  return sql`
    select storefront.id
      from trader_storefronts storefront
      join trader_delivery_company_relationships relationship
        on relationship.trader_commerce_id = storefront.trader_commerce_id
     where relationship.company_id = ${input.companyId}::uuid
       and relationship.status = 'active'
  `;
}

/**
 * The Trader Commerce identities the actor may act for.
 *
 * Same rule as above, one level up: used where the subject is the shop itself
 * rather than one of its Storefronts -- listing Delivery Company relationships,
 * for instance, which exist per Commerce identity and not per Store.
 */
export function accessibleCommerceIds(input: {
  readonly callerTraderId: string | null;
  readonly companyId: string;
}) {
  if (input.callerTraderId !== null) {
    return sql`
      select link.trader_commerce_id
        from trader_commerce_company_links link
       where link.trader_id = ${input.callerTraderId}::uuid
    `;
  }
  return sql`
    select relationship.trader_commerce_id
      from trader_delivery_company_relationships relationship
     where relationship.company_id = ${input.companyId}::uuid
       and relationship.status = 'active'
  `;
}
