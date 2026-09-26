import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
alter table platform_customer_quote_requests
  add column if not exists pickup_country_code text not null default 'AE',
  add column if not exists pickup_country_name text not null default 'United Arab Emirates',
  add column if not exists pickup_city text,
  add column if not exists pickup_district text,
  add column if not exists delivery_country_code text not null default 'AE',
  add column if not exists delivery_country_name text not null default 'United Arab Emirates',
  add column if not exists delivery_city text,
  add column if not exists delivery_district text,
  add column if not exists dimension_unit text not null default 'cm' check(dimension_unit in('cm')),
  add column if not exists volumetric_weight_kg numeric(10,3),
  add column if not exists chargeable_weight_kg numeric(10,3),
  add column if not exists declared_value numeric(12,2),
  add column if not exists declared_value_currency text,
  add column if not exists quote_currency text not null default 'AED';

update platform_customer_quote_requests
set chargeable_weight_kg = coalesce(chargeable_weight_kg, weight_kg)
where chargeable_weight_kg is null;

create index if not exists platform_customer_quotes_country_route_idx
  on platform_customer_quote_requests(pickup_country_code, delivery_country_code, created_at desc);

create index if not exists platform_customer_quotes_reference_identity_idx
  on platform_customer_quote_requests(reference_number, requester_name, requester_mobile, recipient_mobile);
`.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
drop index if exists platform_customer_quotes_reference_identity_idx;
drop index if exists platform_customer_quotes_country_route_idx;
alter table platform_customer_quote_requests
  drop column if exists quote_currency,
  drop column if exists declared_value_currency,
  drop column if exists declared_value,
  drop column if exists chargeable_weight_kg,
  drop column if exists volumetric_weight_kg,
  drop column if exists dimension_unit,
  drop column if exists delivery_district,
  drop column if exists delivery_city,
  drop column if exists delivery_country_name,
  drop column if exists delivery_country_code,
  drop column if exists pickup_district,
  drop column if exists pickup_city,
  drop column if exists pickup_country_name,
  drop column if exists pickup_country_code;
`.execute(database);
}
