import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Petrol was available to Driver Collections as an expense type, but the
 * General Expenses setup seeded only Office Supplies. Give every existing
 * Company the same Petrol category that new accounting templates expose.
 *
 * The Company/code unique key makes the insert idempotent and preserves any
 * Petrol category a Company already created for itself.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into general_expense_categories (
      company_id, code, name_en, name_ar, description,
      default_expense_mapping_key, default_vat_treatment, is_active,
      effective_from
    )
    select c.id, 'EXP-PETROL', 'Petrol', 'بنزين',
           'Petrol and vehicle fuel expenses',
           'general_expense', 'out_of_scope', true, current_date
      from companies c
     where not exists (
       select 1
         from general_expense_categories existing
        where existing.company_id = c.id
          and upper(existing.code) = 'EXP-PETROL'
     )
  `.execute(database);
}

export async function down(): Promise<void> {
  // Reference data may be used by General Expenses after rollout. Removing it
  // on rollback would either fail or destroy a valid Company configuration.
}
