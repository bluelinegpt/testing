import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * Orders AI (the AI tab and its question box), switched on or off per Company
 * by the Platform (`company_ai_settings`). No row means off.
 */
export async function companyOrdersAiEnabled(
  database: Kysely<DatabaseSchema>,
  companyId: string,
): Promise<boolean> {
  const result = await sql<{ enabled: boolean }>`
    select orders_ai_enabled as enabled
      from company_ai_settings
     where company_id = ${companyId}::uuid
  `.execute(database);
  return result.rows[0]?.enabled === true;
}
