import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create sequence company_website_request_reference_seq;
    create table company_website_delivery_requests (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      company_website_id uuid not null references company_websites(id) on delete restrict,
      public_reference text not null unique,
      source_channel text not null default 'company_public_website' check (source_channel = 'company_public_website'),
      contact_name text not null, mobile text not null, email text,
      pickup_emirate text not null, pickup_location text not null,
      delivery_emirate text not null, delivery_location text not null,
      package_description text not null, quantity integer not null check (quantity between 1 and 100),
      approximate_weight_kg numeric(12,3) not null check (approximate_weight_kg > 0),
      cod_required boolean not null, cod_amount numeric(14,2) not null default 0 check (cod_amount >= 0),
      requested_at timestamptz, notes text, status text not null default 'received' check (status in ('received','reviewing','quoted','accepted','closed','cancelled')),
      idempotency_key text, utm_source text, utm_campaign text,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      constraint company_website_request_cod_check check ((cod_required and cod_amount >= 0) or (not cod_required and cod_amount = 0))
    );
    create unique index company_website_delivery_requests_idempotency
      on company_website_delivery_requests(company_website_id, idempotency_key)
      where idempotency_key is not null;
    create index company_website_delivery_requests_company_created
      on company_website_delivery_requests(company_id, created_at desc);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table if exists company_website_delivery_requests; drop sequence if exists company_website_request_reference_seq;`.execute(database);
}
