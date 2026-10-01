import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Stage 2: links a financially-posted settlement to its source draft. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table trader_settlement_drafts
      add column confirmed_settlement_id uuid,
      add column confirmed_at timestamptz,
      add constraint trader_settlement_drafts_confirmed_settlement_fk
        foreign key (confirmed_settlement_id, company_id)
        references trader_settlements(id, company_id) on delete restrict;
    create unique index trader_settlement_drafts_confirmed_settlement_uq
      on trader_settlement_drafts(company_id, confirmed_settlement_id)
      where confirmed_settlement_id is not null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index trader_settlement_drafts_confirmed_settlement_uq;
    alter table trader_settlement_drafts
      drop constraint trader_settlement_drafts_confirmed_settlement_fk,
      drop column confirmed_at,
      drop column confirmed_settlement_id;
  `.execute(database);
}
