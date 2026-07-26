import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table company_reference_counters
      drop constraint company_reference_counters_type_check;
    alter table company_reference_counters
      add constraint company_reference_counters_type_check check (
        reference_type in (
          'order', 'payment', 'reconciliation', 'settlement', 'journal', 'payroll', 'import',
          'trader', 'area', 'customer'
        )
      );

    insert into company_reference_counters (company_id, reference_type, next_value, prefix)
    select id, 'customer', 1, 'CUS' from companies
    on conflict (company_id, reference_type) do nothing;

    create table customers (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      code text not null,
      name text not null,
      mobile_number text not null,
      second_mobile_number text,
      email text,
      customer_reference text,
      delivery_notes text,
      internal_notes text,
      status text not null default 'active',
      created_by_account_id uuid not null,
      deactivated_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint customers_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint customers_code_nonempty check (btrim(code) <> ''),
      constraint customers_name_nonempty check (btrim(name) <> ''),
      constraint customers_mobile_format check (mobile_number ~ '^9715[0-9]{8}$'),
      constraint customers_second_mobile_format check (
        second_mobile_number is null or second_mobile_number ~ '^9715[0-9]{8}$'
      ),
      constraint customers_status_check check (status in ('active', 'disabled')),
      constraint customers_delivery_notes_length check (
        delivery_notes is null or length(delivery_notes) <= 1000
      ),
      constraint customers_internal_notes_length check (
        internal_notes is null or length(internal_notes) <= 2000
      ),
      constraint customers_version_positive check (version > 0)
    );
    create unique index customers_code_unique on customers (company_id, lower(code));
    create index customers_mobile_index on customers (company_id, mobile_number);
    create index customers_second_mobile_index on customers (company_id, second_mobile_number)
      where second_mobile_number is not null;
    create index customers_name_index on customers (company_id, lower(name));
    create index customers_status_index on customers (company_id, status, created_at desc);

    create table customer_addresses (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      customer_id uuid not null,
      area_id uuid not null,
      label text,
      address text not null,
      location_link text,
      latitude numeric(9,6),
      longitude numeric(9,6),
      delivery_instructions text,
      is_default boolean not null default false,
      is_active boolean not null default true,
      created_by_account_id uuid not null,
      deactivated_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint customer_addresses_customer_fk foreign key (customer_id, company_id)
        references customers(id, company_id) on delete restrict,
      constraint customer_addresses_area_fk foreign key (area_id, company_id)
        references areas(id, company_id) on delete restrict,
      constraint customer_addresses_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint customer_addresses_address_nonempty check (btrim(address) <> ''),
      constraint customer_addresses_default_active check (not is_default or is_active),
      constraint customer_addresses_coordinates_check check (
        (latitude is null and longitude is null)
        or (latitude between -90 and 90 and longitude between -180 and 180)
      ),
      constraint customer_addresses_location_link_check check (
        location_link is null or location_link ~ '^https?://[^[:space:]]+$'
      ),
      constraint customer_addresses_instructions_length check (
        delivery_instructions is null or length(delivery_instructions) <= 1000
      ),
      constraint customer_addresses_version_positive check (version > 0)
    );
    create unique index customer_addresses_one_active_default
      on customer_addresses (company_id, customer_id) where is_active and is_default;
    create index customer_addresses_customer_index
      on customer_addresses (company_id, customer_id, is_active desc, created_at);
    create index customer_addresses_area_index
      on customer_addresses (company_id, area_id, is_active);

    alter table orders
      add column customer_id uuid,
      add column customer_address_id uuid,
      add column customer_code_snapshot text,
      add column customer_reference_snapshot text,
      add column customer_area_code_snapshot text,
      add column customer_area_name_snapshot text,
      add column customer_location_link_snapshot text,
      add column customer_delivery_notes_snapshot text,
      add column customer_provenance_status text;

    update orders
       set customer_provenance_status = 'legacy_unattributed'
     where customer_provenance_status is null;
    set constraints all immediate;

    alter table orders
      alter column customer_provenance_status set default 'resolved',
      alter column customer_provenance_status set not null,
      add constraint orders_customer_fk foreign key (customer_id, company_id)
        references customers(id, company_id) on delete restrict,
      add constraint orders_customer_address_fk foreign key (customer_address_id, company_id)
        references customer_addresses(id, company_id) on delete restrict,
      add constraint orders_customer_provenance_check check (
        (customer_provenance_status = 'legacy_unattributed'
          and customer_id is null and customer_address_id is null
          and customer_code_snapshot is null
          and customer_reference_snapshot is null
          and customer_area_code_snapshot is null
          and customer_area_name_snapshot is null
          and customer_location_link_snapshot is null
          and customer_delivery_notes_snapshot is null)
        or
        (customer_provenance_status = 'resolved'
          and customer_id is not null and customer_address_id is not null
          and customer_code_snapshot is not null
          and customer_area_code_snapshot is not null
          and customer_area_name_snapshot is not null
          and btrim(customer_code_snapshot) <> ''
          and btrim(customer_area_code_snapshot) <> ''
          and btrim(customer_area_name_snapshot) <> '')
      );
    create index orders_customer_index on orders (company_id, customer_id, order_date desc)
      where customer_id is not null;

    create function protect_customer_code() returns trigger language plpgsql as $$
    begin
      if new.code is distinct from old.code or new.company_id is distinct from old.company_id then
        raise exception using errcode = '23514', message = 'Customer code and Company are immutable';
      end if;
      return new;
    end;
    $$;
    create trigger customers_code_immutable
      before update of code, company_id on customers
      for each row execute function protect_customer_code();

    create function reject_customer_delete() returns trigger language plpgsql as $$
    begin
      raise exception using errcode = '23514', message = 'Customers and Customer addresses cannot be deleted';
    end;
    $$;
    create trigger customers_no_delete before delete on customers
      for each row execute function reject_customer_delete();
    create trigger customer_addresses_no_delete before delete on customer_addresses
      for each row execute function reject_customer_delete();

    create function protect_customer_address_identity() returns trigger language plpgsql as $$
    begin
      if new.company_id is distinct from old.company_id
         or new.customer_id is distinct from old.customer_id then
        raise exception using errcode = '23514', message = 'Customer address ownership is immutable';
      end if;
      return new;
    end;
    $$;
    create trigger customer_addresses_identity_immutable
      before update of company_id, customer_id on customer_addresses
      for each row execute function protect_customer_address_identity();

    create function validate_customer_default_address() returns trigger language plpgsql as $$
    declare
      active_count integer;
      default_count integer;
    begin
      select count(*),count(*) filter (where is_default)
        into active_count,default_count
        from customer_addresses
       where company_id = new.company_id and customer_id = new.customer_id and is_active;
      if active_count > 0 and default_count <> 1 then
        raise exception using errcode = '23514', message = 'A Customer must have exactly one active default address';
      end if;
      return new;
    end;
    $$;
    create constraint trigger customer_addresses_default_guard
      after insert or update of is_active, is_default on customer_addresses
      deferrable initially deferred
      for each row execute function validate_customer_default_address();

    create function validate_order_customer_scope() returns trigger language plpgsql as $$
    declare
      address_customer_id uuid;
      address_area_id uuid;
    begin
      if new.customer_provenance_status <> 'resolved' then
        return new;
      end if;
      select customer_id, area_id into address_customer_id, address_area_id
        from customer_addresses
       where id = new.customer_address_id and company_id = new.company_id;
      if address_customer_id is distinct from new.customer_id then
        raise exception using errcode = '23514', message = 'Order Customer address must belong to the selected Customer';
      end if;
      if address_area_id is distinct from new.area_id then
        raise exception using errcode = '23514', message = 'Order Area must match the selected Customer address';
      end if;
      return new;
    end;
    $$;
    create constraint trigger orders_customer_scope_guard
      after insert or update of company_id, customer_id, customer_address_id, area_id,
        customer_provenance_status on orders
      deferrable initially immediate
      for each row execute function validate_order_customer_scope();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists orders_customer_scope_guard on orders;
    drop function if exists validate_order_customer_scope();
    drop trigger if exists customer_addresses_default_guard on customer_addresses;
    drop function if exists validate_customer_default_address();
    drop trigger if exists customer_addresses_identity_immutable on customer_addresses;
    drop function if exists protect_customer_address_identity();
    drop trigger if exists customer_addresses_no_delete on customer_addresses;
    drop trigger if exists customers_no_delete on customers;
    drop function if exists reject_customer_delete();
    drop trigger if exists customers_code_immutable on customers;
    drop function if exists protect_customer_code();
    drop index if exists orders_customer_index;
    alter table orders
      drop constraint if exists orders_customer_provenance_check,
      drop constraint if exists orders_customer_address_fk,
      drop constraint if exists orders_customer_fk,
      drop column if exists customer_provenance_status,
      drop column if exists customer_delivery_notes_snapshot,
      drop column if exists customer_location_link_snapshot,
      drop column if exists customer_area_name_snapshot,
      drop column if exists customer_area_code_snapshot,
      drop column if exists customer_reference_snapshot,
      drop column if exists customer_code_snapshot,
      drop column if exists customer_address_id,
      drop column if exists customer_id;
    drop table if exists customer_addresses;
    drop table if exists customers;
    delete from company_reference_counters where reference_type = 'customer';
    alter table company_reference_counters
      drop constraint company_reference_counters_type_check;
    alter table company_reference_counters
      add constraint company_reference_counters_type_check check (
        reference_type in (
          'order', 'payment', 'reconciliation', 'settlement', 'journal', 'payroll', 'import',
          'trader', 'area'
        )
      );
  `.execute(database);
}
