import { type Kysely, sql } from "kysely";

/**
 * Backend-generated codes for Drivers and their backing Employee records.
 *
 * Part of unifying Employees into the Driver form: both the Driver code and the
 * Employee number are now allocated from a Company-scoped reference counter
 * (DRV-000001, EMP-000001) instead of being typed by the operator. This only
 * extends the counter whitelist; the counters self-seed on first use through
 * the existing on-conflict upsert.
 */
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table company_reference_counters
      drop constraint company_reference_counters_type_check;
    alter table company_reference_counters
      add constraint company_reference_counters_type_check check (
        reference_type in (
          'order', 'payment', 'reconciliation', 'settlement', 'journal', 'payroll', 'import',
          'trader', 'area', 'customer', 'driver', 'employee'
        )
      );
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    delete from company_reference_counters where reference_type in ('driver', 'employee');
    alter table company_reference_counters
      drop constraint company_reference_counters_type_check;
    alter table company_reference_counters
      add constraint company_reference_counters_type_check check (
        reference_type in (
          'order', 'payment', 'reconciliation', 'settlement', 'journal', 'payroll', 'import',
          'trader', 'area', 'customer'
        )
      );
  `.execute(database);
}
