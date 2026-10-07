import { sql, type Kysely } from "kysely";

import type { DatabaseSchema } from "./database.types.js";

export const LEGACY_MIGRATION_ALIASES = [
  {
    legacyName: "20260902012000_collect_order_assignment_customer_optional",
    currentName: "20260902012500_collect_order_assignment_customer_optional",
    reason: "Recorded under the colliding timestamp before the repair was renamed",
  },
  {
    legacyName: "20260964000000_resolve_historical_accounting_event_classification",
    currentName: "20260972500000_resolve_historical_accounting_event_classification",
    reason: "Recorded under the original timestamp before the migration was renamed",
  },
  {
    legacyName: "20260973000000_gcc_international_order_type",
    currentName: "20260975000000_gcc_international_order_type",
    reason: "Recorded under the original timestamp before the migration was renamed",
  },
  {
    legacyName: "20260974000000_international_carrier_status",
    currentName: "20260976000000_international_carrier_status",
    reason: "Recorded under the original timestamp before the migration was renamed",
  },
] as const;

export async function recordedLegacyMigrationNames(database: Kysely<DatabaseSchema>) {
  const result = await sql<{ name: string }>`
    select name from kysely_migration
    where name in (${sql.join(LEGACY_MIGRATION_ALIASES.map(({ legacyName }) => sql`${legacyName}`))})
    order by name
  `.execute(database);
  return new Set(result.rows.map(({ name }) => name));
}
