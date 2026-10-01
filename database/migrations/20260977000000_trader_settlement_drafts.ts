import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Stage 1: persisted, financially inert Trader settlement drafts. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table trader_settlement_drafts (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      trader_id uuid not null,
      status text not null default 'draft' check (status = 'draft'),
      payload jsonb not null,
      created_by_account_id uuid not null,
      updated_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (id, company_id),
      foreign key (trader_id, company_id) references traders(id, company_id) on delete restrict,
      foreign key (created_by_account_id, company_id) references accounts(id, company_id) on delete restrict,
      foreign key (updated_by_account_id, company_id) references accounts(id, company_id) on delete restrict
    );
    create index trader_settlement_drafts_company_updated_idx
      on trader_settlement_drafts(company_id, updated_at desc);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table trader_settlement_drafts`.execute(database);
}
