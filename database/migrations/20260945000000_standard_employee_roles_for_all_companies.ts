import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * The original employee-role migration seeded Companies that existed at that
 * moment, but Company creation did not repeat the seed. Backfill the same
 * approved standard list and repair a historical DRIVER code whose flag was
 * left false. This is additive except for that narrow, authoritative flag
 * correction; Company-specific names and activation choices remain untouched.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    update employee_roles
       set is_driver_role = true, updated_at = now(), version = version + 1
     where (lower(code) = 'driver' or lower(btrim(name_en)) = 'driver')
       and is_driver_role = false
  `.execute(database);

  await sql`
    insert into employee_roles (company_id, code, name_en, name_ar, is_driver_role)
    select company.id, seed.code, seed.name_en, seed.name_ar, seed.is_driver_role
      from companies company
      cross join (values
        ('DRIVER', 'Driver', 'سائق', true),
        ('CUSTOMER_SERVICE', 'Customer Service', 'خدمة العملاء', false),
        ('WAREHOUSE', 'Warehouse', 'المستودع', false),
        ('OPERATIONS', 'Operations', 'العمليات', false),
        ('ACCOUNTS', 'Accounts', 'الحسابات', false)
      ) as seed(code, name_en, name_ar, is_driver_role)
     where not exists (
       select 1 from employee_roles existing
        where existing.company_id=company.id
          and (lower(existing.code)=lower(seed.code)
            or lower(btrim(existing.name_en))=lower(btrim(seed.name_en)))
     )
    on conflict do nothing
  `.execute(database);
}

export async function down(): Promise<void> {
  // Deliberately non-destructive. These Company-owned reference rows may be in
  // use by Employees after deployment and must not be removed automatically.
}
