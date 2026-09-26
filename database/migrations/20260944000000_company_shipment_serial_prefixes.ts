import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies
      add column shipment_prefix text,
      add column shipment_serial_enabled_at timestamptz,
      add constraint companies_shipment_prefix_format_check
        check(shipment_prefix is null or shipment_prefix ~ '^[A-Z]{3}$');

    create table shipment_prefix_reservations(
      prefix text primary key check(prefix ~ '^[A-Z]{3}$'),
      original_company_id uuid not null,
      company_code_snapshot text not null,
      company_name_snapshot text not null,
      current_company_id uuid unique references companies(id) on delete set null,
      reserved_at timestamptz not null default now(),
      activated_at timestamptz,
      first_used_at timestamptz,
      retired_at timestamptz,
      constraint shipment_prefix_reservations_activation_order_check
        check(first_used_at is null or activated_at is not null)
    );

    alter table companies add constraint companies_shipment_prefix_reservation_fk
      foreign key(shipment_prefix) references shipment_prefix_reservations(prefix)
      deferrable initially deferred;
    create unique index companies_shipment_prefix_unique on companies(shipment_prefix)
      where shipment_prefix is not null;

    create table company_shipment_serial_counters(
      company_id uuid not null references companies(id) on delete restrict,
      series text not null default '',
      next_value bigint not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key(company_id,series),
      constraint company_shipment_serial_counters_series_check
        check(series='' or series ~ '^[A-Z]$'),
      constraint company_shipment_serial_counters_value_check check(next_value>0)
    );

    create function protect_company_shipment_numbering() returns trigger as $$
    declare serial_generation_started boolean;
    begin
      if old.shipment_serial_enabled_at is not null
         and new.shipment_serial_enabled_at is distinct from old.shipment_serial_enabled_at then
        raise exception 'Company shipment serial generation activation is immutable'
          using errcode='integrity_constraint_violation';
      end if;
      if new.shipment_serial_enabled_at is not null and new.shipment_prefix is null then
        raise exception 'A shipment prefix is required before serial generation can be enabled'
          using errcode='integrity_constraint_violation';
      end if;
      if new.shipment_prefix is distinct from old.shipment_prefix then
        select old.shipment_serial_enabled_at is not null
          or exists(select 1 from company_shipment_serial_counters c
                    where c.company_id=old.id and c.next_value>1)
          or exists(select 1 from shipment_prefix_reservations r
                    where r.current_company_id=old.id and r.first_used_at is not null)
          into serial_generation_started;
        if serial_generation_started then
          raise exception 'Company shipment prefix is immutable after serial generation is activated or first used'
            using errcode='integrity_constraint_violation';
        end if;
      end if;
      return new;
    end; $$ language plpgsql;
    create trigger companies_shipment_numbering_guard
      before update of shipment_prefix,shipment_serial_enabled_at on companies
      for each row execute function protect_company_shipment_numbering();

    create function maintain_shipment_prefix_reservation() returns trigger as $$
    begin
      if tg_op='INSERT' then
        if new.shipment_prefix is not null then
          insert into shipment_prefix_reservations(prefix,original_company_id,company_code_snapshot,
            company_name_snapshot,current_company_id,activated_at)
          values(new.shipment_prefix,new.id,new.code,new.name_en,new.id,new.shipment_serial_enabled_at);
        end if;
        return new;
      end if;
      if new.shipment_prefix is distinct from old.shipment_prefix then
        if old.shipment_prefix is not null then
          update shipment_prefix_reservations set current_company_id=null,
            retired_at=coalesce(retired_at,now())
          where prefix=old.shipment_prefix and current_company_id=old.id;
        end if;
        if new.shipment_prefix is not null then
          insert into shipment_prefix_reservations(prefix,original_company_id,company_code_snapshot,
            company_name_snapshot,current_company_id)
          values(new.shipment_prefix,new.id,new.code,new.name_en,new.id);
        end if;
      end if;
      if old.shipment_serial_enabled_at is null and new.shipment_serial_enabled_at is not null then
        update shipment_prefix_reservations
           set activated_at=coalesce(activated_at,new.shipment_serial_enabled_at)
         where prefix=new.shipment_prefix and current_company_id=new.id;
      end if;
      return new;
    end; $$ language plpgsql;
    create trigger companies_shipment_prefix_reservation
      after insert or update of shipment_prefix,shipment_serial_enabled_at on companies
      for each row execute function maintain_shipment_prefix_reservation();

    create function allocate_company_shipment_serial(requested_company_id uuid,
      requested_series text default '') returns text as $$
    declare company_prefix text; allocated_value bigint;
    begin
      if requested_series<>'' then
        raise exception 'Shipment serial Series is not enabled' using errcode='feature_not_supported';
      end if;
      select c.shipment_prefix into company_prefix
        from companies c join shipment_prefix_reservations r
          on r.prefix=c.shipment_prefix and r.current_company_id=c.id
       where c.id=requested_company_id and c.shipment_serial_enabled_at is not null
       for update of c;
      if company_prefix is null then
        raise exception 'Company shipment serial generation is not enabled'
          using errcode='object_not_in_prerequisite_state';
      end if;
      insert into company_shipment_serial_counters(company_id,series,next_value)
      values(requested_company_id,requested_series,2)
      on conflict(company_id,series) do update
        set next_value=company_shipment_serial_counters.next_value+1,updated_at=now()
      returning next_value-1 into allocated_value;
      update shipment_prefix_reservations set first_used_at=coalesce(first_used_at,now())
       where prefix=company_prefix and current_company_id=requested_company_id;
      return company_prefix||requested_series||lpad(allocated_value::text,7,'0');
    end; $$ language plpgsql;

    do $$ declare conflicting_count bigint; begin
      select count(*)::bigint into conflicting_count from orders
       where serial_number_normalized ~ '^[a-z]{3}[a-z]?[0-9]{7,}$';
      if conflicting_count>0 then
        raise exception 'Cannot reserve generated shipment serial namespace: % historical value(s) match',
          conflicting_count using errcode='unique_violation';
      end if;
    end $$;
    create unique index orders_generated_shipment_serial_unique
      on orders(serial_number_normalized)
      where serial_number_normalized ~ '^[a-z]{3}[a-z]?[0-9]{7,}$';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists orders_generated_shipment_serial_unique;
    drop function if exists allocate_company_shipment_serial(uuid,text);
    drop trigger if exists companies_shipment_prefix_reservation on companies;
    drop function if exists maintain_shipment_prefix_reservation();
    drop trigger if exists companies_shipment_numbering_guard on companies;
    drop function if exists protect_company_shipment_numbering();
    drop table if exists company_shipment_serial_counters;
    alter table companies drop constraint if exists companies_shipment_prefix_reservation_fk;
    drop index if exists companies_shipment_prefix_unique;
    drop table if exists shipment_prefix_reservations;
    alter table companies drop constraint if exists companies_shipment_prefix_format_check,
      drop column if exists shipment_serial_enabled_at,
      drop column if exists shipment_prefix;
  `.execute(database);
}
