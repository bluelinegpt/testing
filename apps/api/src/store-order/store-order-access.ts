import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * Customer-side access resolution for the Store Order domain (Shared
 * Commerce Foundation Prompt 3B).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NEW, RATHER THAN REUSING `storefront-access.ts`
 * ---------------------------------------------------------------------------
 *
 * `accessibleStorefrontIds`/`accessibleCommerceIds` (`storefront/
 * storefront-access.ts`) answer "which Stores may this Trader/Company
 * actor reach" -- reused as-is here for the Trader side of Store Order
 * access (a Store Order's `trader_commerce_id` must be one of those). There
 * is no existing helper for the OTHER side of a Store Order: "which Store
 * Orders may this Customer reach", because no Customer-facing domain
 * existed before 3A/3B. This mirrors `commerce-customer-profile.service.ts`'s
 * own pattern exactly: resolve `commerce_customers.id` from the
 * authenticated account, never from a client-supplied id.
 */
export async function resolveCommerceCustomerId(
  database: Kysely<DatabaseSchema>,
  accountId: string,
): Promise<string | undefined> {
  const result = await sql<{ id: string }>`
    select id from commerce_customers where account_id = ${accountId}::uuid
  `.execute(database);
  return result.rows[0]?.id;
}
