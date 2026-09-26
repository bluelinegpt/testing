import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Separates the Company-entered Serial Number from Tawseelhub's globally
 * unique public identifier. Historical serial_number values are never moved,
 * rewritten or interpreted as PSystem Serials.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  // A user-entered legacy value in the generated namespace would make fallback
  // tracking ambiguous with a future PSystem Serial. Values provably issued by
  // the immediately preceding generator are adopted below without changing the
  // historical Serial Number; every unproven lookalike still blocks migration.
  await sql`
    do $$
    declare conflicting_count bigint;
    begin
      select count(*)::bigint into conflicting_count
        from orders o
       where o.serial_number_normalized ~ '^[a-z]{3}[0-9]{7,}$'
         and not exists (
           select 1
             from companies c
             join shipment_prefix_reservations r
               on r.prefix=c.shipment_prefix and r.current_company_id=c.id
             join company_shipment_serial_counters counter
               on counter.company_id=c.id and counter.series=''
            where c.id=o.company_id
              and c.shipment_serial_enabled_at is not null
              and o.serial_number=upper(c.shipment_prefix)
                ||lpad(substring(o.serial_number_normalized from 4)::bigint::text,7,'0')
              and substring(o.serial_number_normalized from 4)::bigint > 0
              and substring(o.serial_number_normalized from 4)::bigint < counter.next_value
         );
      if conflicting_count > 0 then
        raise exception
          'Cannot reserve PSystem Serial namespace: % historical Serial Number value(s) conflict',
          conflicting_count using errcode='unique_violation';
      end if;
    end $$;

    alter table orders
      add column psystem_serial text,
      add column psystem_serial_normalized text,
      add constraint orders_psystem_serial_pair_check check (
        (psystem_serial is null and psystem_serial_normalized is null)
        or (
          psystem_serial ~ '^[A-Z]{3}[0-9]{7,}$'
          and psystem_serial_normalized = lower(psystem_serial)
        )
      );

    create unique index orders_psystem_serial_normalized_unique
      on orders(psystem_serial_normalized)
      where psystem_serial_normalized is not null;

    update orders o
       set psystem_serial=o.serial_number,
           psystem_serial_normalized=o.serial_number_normalized
      from companies c
      join shipment_prefix_reservations r
        on r.prefix=c.shipment_prefix and r.current_company_id=c.id
      join company_shipment_serial_counters counter
        on counter.company_id=c.id and counter.series=''
     where c.id=o.company_id
       and c.shipment_serial_enabled_at is not null
       and o.serial_number_normalized ~ '^[a-z]{3}[0-9]{7,}$'
       and o.serial_number=upper(c.shipment_prefix)
         ||lpad(substring(o.serial_number_normalized from 4)::bigint::text,7,'0')
       and substring(o.serial_number_normalized from 4)::bigint > 0
       and substring(o.serial_number_normalized from 4)::bigint < counter.next_value;

    drop index if exists orders_generated_shipment_serial_unique;

    create function protect_order_psystem_serial() returns trigger as $$
    begin
      if new.psystem_serial is distinct from old.psystem_serial
         or new.psystem_serial_normalized is distinct from old.psystem_serial_normalized then
        raise exception 'PSystem Serial is immutable'
          using errcode='integrity_constraint_violation';
      end if;
      return new;
    end; $$ language plpgsql;

    create trigger orders_psystem_serial_immutable
      before update of psystem_serial, psystem_serial_normalized on orders
      for each row execute function protect_order_psystem_serial();

    create function allocate_company_psystem_serial(
      requested_company_id uuid,
      requested_series text default ''
    ) returns text as $$
    declare company_prefix text; allocated_value bigint;
    begin
      if requested_series <> '' then
        raise exception 'PSystem Serial Series is not enabled'
          using errcode='feature_not_supported';
      end if;
      select c.shipment_prefix into company_prefix
        from companies c
        join shipment_prefix_reservations r
          on r.prefix=c.shipment_prefix and r.current_company_id=c.id
       where c.id=requested_company_id
         and c.shipment_serial_enabled_at is not null
       for update of c;
      if company_prefix is null then
        return null;
      end if;
      insert into company_shipment_serial_counters(company_id,series,next_value)
      values(requested_company_id,requested_series,2)
      on conflict(company_id,series) do update
        set next_value=company_shipment_serial_counters.next_value+1,updated_at=now()
      returning next_value-1 into allocated_value;
      update shipment_prefix_reservations
         set first_used_at=coalesce(first_used_at,now())
       where prefix=company_prefix and current_company_id=requested_company_id;
      return company_prefix||requested_series||lpad(allocated_value::text,7,'0');
    end; $$ language plpgsql;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop function if exists allocate_company_psystem_serial(uuid,text);
    drop trigger if exists orders_psystem_serial_immutable on orders;
    drop function if exists protect_order_psystem_serial();
    drop index if exists orders_psystem_serial_normalized_unique;
    alter table orders drop constraint if exists orders_psystem_serial_pair_check,
      drop column if exists psystem_serial_normalized,
      drop column if exists psystem_serial;
  `.execute(database);
}
