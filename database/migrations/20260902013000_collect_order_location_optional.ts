import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Collect tasks may be created before their customer location is known. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders alter column area_id drop not null;
    alter table orders add constraint orders_area_required_by_type_check check (
      order_type = 'collect_order' or area_id is not null
    );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    do $$
    begin
      if exists (select 1 from orders where area_id is null) then
        raise exception 'Cannot restore mandatory Order Areas while location-free Collect Orders exist';
      end if;
    end $$;
    alter table orders drop constraint orders_area_required_by_type_check;
    alter table orders alter column area_id set not null;
  `.execute(database);
}
