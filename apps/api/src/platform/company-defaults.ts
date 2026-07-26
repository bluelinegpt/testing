import { type Kysely, type Transaction, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * Company-scoped reconciliation Expense Types created for every Company.
 *
 * `code` is the stable internal identifier and is immutable once created
 * (enforced by `normalize_expense_type_name`). `name` is only the initial
 * display Name; a Company may rename it in English, Arabic or mixed text.
 * `OTHER` additionally requires a description on every expense entry
 * (enforced by `validate_reconciliation_expense_description`).
 */
export const defaultExpenseTypes = [
  { code: "PETROL", name: "Petrol" },
  { code: "WATER", name: "Water" },
  { code: "PARKING", name: "Parking" },
  { code: "VEHICLE", name: "Vehicle-related" },
  { code: "OTHER", name: "Other" },
] as const;

export type CompanyDefaultsExecutor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

/**
 * Seeds the per-Company defaults required by the reconciliation workflow.
 *
 * Idempotent: repeated provisioning of the same Company inserts nothing further
 * and never overwrites a Company's own renames or deactivations.
 */
export async function seedCompanyDefaults(
  executor: CompanyDefaultsExecutor,
  companyId: string,
): Promise<void> {
  const codes = defaultExpenseTypes.map((expenseType) => expenseType.code);
  const names = defaultExpenseTypes.map((expenseType) => expenseType.name);
  await sql`
    insert into expense_types (company_id, code, name_en, display_name)
    select ${companyId}::uuid, seed.code, seed.name, seed.name
      from unnest(${codes}::text[], ${names}::text[]) as seed (code, name)
    on conflict (company_id, lower(code)) do nothing
  `.execute(executor);
}
