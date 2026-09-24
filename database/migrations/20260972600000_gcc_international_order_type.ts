import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Adds the distinct GCC & International order type and destination country. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders add column destination_country_name text;
    alter table orders drop constraint if exists orders_order_type_check;
    alter table orders add constraint orders_order_type_check
      check (order_type in ('delivery', 'collect_order', 'gcc_international'));
    alter table orders add constraint orders_gcc_international_country_check
      check (order_type <> 'gcc_international'
        or (destination_country_name is not null
          and char_length(btrim(destination_country_name)) between 2 and 120));
    create index orders_company_destination_country_idx
      on orders (company_id, lower(destination_country_name));
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders drop constraint if exists orders_gcc_international_country_check;
    alter table orders drop constraint if exists orders_order_type_check;
    alter table orders add constraint orders_order_type_check
      check (order_type in ('delivery', 'collect_order'));
    drop index if exists orders_company_destination_country_idx;
    alter table orders drop column if exists destination_country_name;
  `.execute(database);
}
