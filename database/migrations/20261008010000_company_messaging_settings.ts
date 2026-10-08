import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table company_messaging_settings (
      company_id uuid primary key references companies(id) on delete restrict,
      messaging_enabled boolean not null default true,
      office_to_driver boolean not null default true,
      office_to_trader boolean not null default true,
      driver_to_office boolean not null default true,
      trader_to_office boolean not null default true,
      customer_to_office boolean not null default true,
      driver_trader boolean not null default false,
      trader_customer_location boolean not null default true,
      voice_messages_enabled boolean not null default true,
      presence_enabled boolean not null default true,
      retention text not null default 'keep_forever',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint company_messaging_settings_retention_check
        check (retention in ('keep_forever', '3', '6', '12', '24'))
    );
    insert into company_messaging_settings (company_id)
      select id from companies
      on conflict (company_id) do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table if exists company_messaging_settings`.execute(database);
}
