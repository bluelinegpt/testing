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

/**
 * Workforce roles available to every Delivery Company from its first day.
 *
 * These are Employee classifications, not authentication/RBAC roles. In
 * particular, DRIVER's flag is what makes an Employee eligible for the
 * existing Employee -> operational Driver synchronization. Driver Portal
 * access remains governed separately by the Driver/account linkage and
 * tenant-scoped account kind.
 */
export const defaultEmployeeRoles = [
  { code: "DRIVER", nameEn: "Driver", nameAr: "سائق", isDriverRole: true },
  {
    code: "CUSTOMER_SERVICE",
    nameEn: "Customer Service",
    nameAr: "خدمة العملاء",
    isDriverRole: false,
  },
  { code: "WAREHOUSE", nameEn: "Warehouse", nameAr: "المستودع", isDriverRole: false },
  { code: "OPERATIONS", nameEn: "Operations", nameAr: "العمليات", isDriverRole: false },
  { code: "ACCOUNTS", nameEn: "Accounts", nameAr: "الحسابات", isDriverRole: false },
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

/**
 * Seeds the standard Employee-role list for a new or existing Company.
 *
 * Idempotency deliberately keys on the immutable role code. Existing names,
 * translations, activation choices and flags are not overwritten here. The
 * forward migration that repairs the historical missing-Driver-default gap
 * handles the one authoritative DRIVER flag correction explicitly.
 */
export async function seedStandardEmployeeRoles(
  executor: CompanyDefaultsExecutor,
  companyId: string,
): Promise<void> {
  const codes = defaultEmployeeRoles.map((role) => role.code);
  const namesEn = defaultEmployeeRoles.map((role) => role.nameEn);
  const namesAr = defaultEmployeeRoles.map((role) => role.nameAr);
  const driverFlags = defaultEmployeeRoles.map((role) => role.isDriverRole);
  await sql`
    insert into employee_roles (company_id, code, name_en, name_ar, is_driver_role)
    select ${companyId}::uuid, seed.code, seed.name_en, seed.name_ar, seed.is_driver_role
      from unnest(
        ${codes}::text[], ${namesEn}::text[], ${namesAr}::text[], ${driverFlags}::boolean[]
      ) as seed (code, name_en, name_ar, is_driver_role)
    on conflict (company_id, lower(code)) do nothing
  `.execute(executor);
}
