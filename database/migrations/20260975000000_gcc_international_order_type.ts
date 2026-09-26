import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Adds International references without removing the original text snapshots.
 * Snapshots remain available for historical readability and deterministic,
 * non-guessing backfill of records created by the first draft.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table destination_countries (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      name text not null,
      normalized_name text not null,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (company_id, normalized_name),
      check (char_length(btrim(name)) between 2 and 120),
      check (normalized_name = lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))),
      check (char_length(normalized_name) between 2 and 120)
    );
    alter table orders add column if not exists destination_country_name text;
    alter table orders add column if not exists third_party_delivery_company_name text;
    alter table orders add column destination_country_id uuid;
    alter table orders add column third_party_delivery_company_id uuid;
    do $$
    begin
      if exists (
        select 1
          from third_party_delivery_companies
         group by company_id, lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))
        having count(*) > 1
      ) then
        raise exception using
          errcode = '23505',
          message = 'Cannot normalize third-party delivery company uniqueness: duplicate names exist';
      end if;
    end $$;
    alter table third_party_delivery_companies drop constraint if exists third_party_delivery_name_unique;
    drop index if exists public.third_party_delivery_name_unique;
    create unique index third_party_delivery_name_unique
      on third_party_delivery_companies (company_id, lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')));
    alter table orders drop constraint if exists orders_area_required_by_type_check;
    alter table orders add constraint orders_area_required_by_type_check
      check (order_type in ('collect_order', 'gcc_international') or area_id is not null);
    alter table orders drop constraint if exists orders_order_type_check;
    alter table orders add constraint orders_order_type_check
      check (order_type in ('delivery', 'collect_order', 'gcc_international'));
    alter table orders add constraint orders_destination_country_company_fk
      foreign key (destination_country_id, company_id)
      references destination_countries(id, company_id) on delete restrict;
    alter table orders add constraint orders_third_party_delivery_company_company_fk
      foreign key (third_party_delivery_company_id, company_id)
      references third_party_delivery_companies(id, company_id) on delete restrict;
    create index destination_countries_company_active_name_idx
      on destination_countries (company_id, is_active, normalized_name);
    create index orders_company_destination_country_id_idx
      on orders (company_id, destination_country_id);
    create index orders_company_third_party_delivery_company_idx
      on orders (company_id, third_party_delivery_company_id);
    alter table orders add constraint orders_gcc_international_reference_check
      check (order_type <> 'gcc_international'
        or ((destination_country_id is not null and third_party_delivery_company_id is not null)
          or (destination_country_name is not null and third_party_delivery_company_name is not null)));
    update orders o set destination_country_id = c.id
      from destination_countries c
     where o.order_type = 'gcc_international' and o.company_id = c.company_id
       and o.destination_country_id is null
       and c.normalized_name = lower(regexp_replace(btrim(o.destination_country_name), '\\s+', ' ', 'g'))
       and 1 = (select count(*) from destination_countries c2 where c2.company_id = o.company_id
                and c2.normalized_name = lower(regexp_replace(btrim(o.destination_country_name), '\\s+', ' ', 'g')));
    update orders o set third_party_delivery_company_id = c.id
      from third_party_delivery_companies c
     where o.order_type = 'gcc_international' and o.company_id = c.company_id
       and o.third_party_delivery_company_id is null
       and lower(regexp_replace(btrim(c.name), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim(o.third_party_delivery_company_name), '\\s+', ' ', 'g'))
       and 1 = (select count(*) from third_party_delivery_companies c2 where c2.company_id = o.company_id
                and lower(regexp_replace(btrim(c2.name), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim(o.third_party_delivery_company_name), '\\s+', ' ', 'g')));
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders drop constraint if exists orders_gcc_international_reference_check;
    alter table orders drop constraint if exists orders_destination_country_company_fk;
    alter table orders drop constraint if exists orders_third_party_delivery_company_company_fk;
    alter table orders drop constraint if exists orders_order_type_check;
    alter table orders add constraint orders_order_type_check
      check (order_type in ('delivery', 'collect_order'));
    drop index if exists orders_company_destination_country_id_idx;
    drop index if exists orders_company_third_party_delivery_company_idx;
    drop index if exists destination_countries_company_active_name_idx;
    alter table orders drop column if exists destination_country_id;
    alter table orders drop column if exists third_party_delivery_company_id;
    drop table if exists destination_countries;
    drop index if exists third_party_delivery_name_unique;
    create unique index third_party_delivery_name_unique
      on third_party_delivery_companies (company_id, lower(name));
  `.execute(database);
}
