import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * The ONE answer to "does this operation capture GL Accounting?".
 *
 * It calls the same database function the operational capture triggers call
 * (`accounting_capture_enabled`, migration 20260984000000), so application
 * writers and triggers can never disagree about a Company's mode. When the
 * answer is yes the function takes a FOR KEY SHARE lock on the Company's
 * configuration row for the rest of the caller's transaction: a controlled
 * Accounting disable then waits for this operation to finish rather than
 * leaving an Event captured "just before" the switch unreported.
 *
 * Always pass the caller's TRANSACTION, never the pool, or the lock is
 * released before the operation commits.
 */
export async function isAccountingCaptureEnabled(
  database: Kysely<DatabaseSchema>,
  companyId: string,
): Promise<boolean> {
  const result = await sql<{ enabled: boolean }>`
    select accounting_capture_enabled(${companyId}::uuid) as enabled
  `.execute(database);
  return result.rows[0]?.enabled === true;
}

/**
 * Was GL Accounting ON for the Company at that moment? Read from the existing
 * configuration history. Used so a record created while Accounting was OFF is
 * never treated as a missing-Event accounting failure after it is turned on.
 */
export async function wasAccountingEnabledAt(
  database: Kysely<DatabaseSchema>,
  companyId: string,
  at: Date | string,
): Promise<boolean> {
  const result = await sql<{ enabled: boolean }>`
    select accounting_enabled_at(${companyId}::uuid, ${at}::timestamptz) as enabled
  `.execute(database);
  return result.rows[0]?.enabled === true;
}
