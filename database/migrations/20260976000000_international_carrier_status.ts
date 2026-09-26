import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Adds the carrier handoff lifecycle without changing Domestic delivery_status. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders add column if not exists international_carrier_status text;
    create or replace function set_international_carrier_status() returns trigger language plpgsql as $$
    begin
      if new.order_type = 'gcc_international' and new.international_carrier_status is null then
        new.international_carrier_status := 'ready_for_carrier';
      elsif new.order_type <> 'gcc_international' then
        new.international_carrier_status := null;
      end if;
      return new;
    end;
    $$;
    drop trigger if exists orders_international_carrier_status_defaults on orders;
    create trigger orders_international_carrier_status_defaults
      before insert or update of order_type, international_carrier_status on orders
      for each row execute function set_international_carrier_status();
    alter table orders drop constraint if exists orders_international_carrier_status_check;
    alter table orders add constraint orders_international_carrier_status_check check (
      (order_type = 'gcc_international' and (international_carrier_status in ('ready_for_carrier', 'handed_to_carrier', 'in_transit') or international_carrier_status is null))
      or (order_type <> 'gcc_international' and international_carrier_status is null)
    );
    create index if not exists orders_company_international_carrier_status_idx
      on orders (company_id, international_carrier_status)
      where order_type = 'gcc_international';
    update orders
       set international_carrier_status = 'ready_for_carrier'
     where order_type = 'gcc_international'
       and delivery_status not in ('delivered', 'returned_to_branch', 'returned_to_trader', 'cancelled', 'closed')
       and international_carrier_status is null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists orders_company_international_carrier_status_idx;
    alter table orders drop constraint if exists orders_international_carrier_status_check;
    drop trigger if exists orders_international_carrier_status_defaults on orders;
    drop function if exists set_international_carrier_status();
    alter table orders drop column if exists international_carrier_status;
  `.execute(database);
}
