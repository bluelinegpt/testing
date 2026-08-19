import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Keep Collect Orders assignable and allow their Customer to be omitted. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders drop constraint orders_customer_provenance_check;
    alter table orders add constraint orders_customer_provenance_check check (
      (customer_provenance_status = 'legacy_unattributed'
        and customer_id is null and customer_address_id is null
        and customer_code_snapshot is null and customer_reference_snapshot is null
        and customer_area_code_snapshot is null and customer_area_name_snapshot is null
        and customer_location_link_snapshot is null and customer_delivery_notes_snapshot is null)
      or
      (customer_provenance_status = 'resolved'
        and customer_id is not null and customer_address_id is not null
        and customer_code_snapshot is not null and customer_area_code_snapshot is not null
        and customer_area_name_snapshot is not null
        and btrim(customer_code_snapshot) <> '' and btrim(customer_area_code_snapshot) <> ''
        and btrim(customer_area_name_snapshot) <> '')
      or
      (customer_provenance_status = 'not_applicable' and order_type = 'collect_order'
        and customer_id is null and customer_address_id is null
        and customer_code_snapshot is null and customer_reference_snapshot is null
        and customer_area_code_snapshot is null and customer_area_name_snapshot is null
        and customer_area_name_ar_snapshot is null and area_name_fallback_used is null
        and customer_location_link_snapshot is null and customer_delivery_notes_snapshot is null)
    );

    update orders
       set delivery_status = 'collect_order', updated_at = now(), version = version + 1
     where order_type = 'collect_order' and delivery_status = 'new';

    create or replace function enforce_initial_order_assignment() returns trigger language plpgsql as $$
    declare
      current_driver_id uuid;
      current_delivery_status text;
    begin
      select assigned_driver_id, delivery_status into current_driver_id, current_delivery_status
      from orders where id = new.order_id and company_id = new.company_id;
      if not found or current_driver_id is distinct from new.driver_id then
        raise exception using errcode = '23514',
          message = 'Active assignment Driver must match the Order current Driver';
      end if;
      if current_delivery_status not in ('assigned_to_driver', 'hold', 'collect_order') then
        raise exception using errcode = '23514',
          message = 'Only a newly assigned, held, or Collect Order can receive an active assignment';
      end if;
      return new;
    end;
    $$;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    do $$
    begin
      if exists (
        select 1 from orders
        where customer_provenance_status = 'not_applicable' and order_type = 'collect_order'
      ) then
        raise exception 'Cannot restore mandatory Collect Order Customers while customerless Collect Orders exist';
      end if;
    end $$;

    alter table orders drop constraint orders_customer_provenance_check;
    alter table orders add constraint orders_customer_provenance_check check (
      (customer_provenance_status = 'legacy_unattributed'
        and customer_id is null and customer_address_id is null
        and customer_code_snapshot is null and customer_reference_snapshot is null
        and customer_area_code_snapshot is null and customer_area_name_snapshot is null
        and customer_location_link_snapshot is null and customer_delivery_notes_snapshot is null)
      or
      (customer_provenance_status = 'resolved'
        and customer_id is not null and customer_address_id is not null
        and customer_code_snapshot is not null and customer_area_code_snapshot is not null
        and customer_area_name_snapshot is not null
        and btrim(customer_code_snapshot) <> '' and btrim(customer_area_code_snapshot) <> ''
        and btrim(customer_area_name_snapshot) <> '')
    );

    create or replace function enforce_initial_order_assignment() returns trigger language plpgsql as $$
    declare
      current_driver_id uuid;
      current_delivery_status text;
    begin
      select assigned_driver_id, delivery_status into current_driver_id, current_delivery_status
      from orders where id = new.order_id and company_id = new.company_id;
      if not found or current_driver_id is distinct from new.driver_id then
        raise exception using errcode = '23514',
          message = 'Active assignment Driver must match the Order current Driver';
      end if;
      if current_delivery_status not in ('assigned_to_driver', 'hold') then
        raise exception using errcode = '23514',
          message = 'Only a newly assigned or held Order can receive an active assignment';
      end if;
      return new;
    end;
    $$;
  `.execute(database);
}
