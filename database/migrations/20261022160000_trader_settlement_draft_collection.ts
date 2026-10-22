import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * One-screen Trader Settlement: "the Trader owes" (Aiman, 22 Oct 2026).
 *
 * When the ticked fees are more than the orders to pay, posting the one-screen
 * settlement collects the difference FROM the Trader. A Trader Settlement can
 * only pay a Trader (net >= 0), so that post is recorded as a Trader Collection
 * for the fees, plus a Settlement for any orders paid. The draft is the one
 * document that holds both, so it now also remembers its Collection.
 *
 * Additive: one nullable column and its foreign key, and the draft status rule
 * widened from "confirmed = has a Settlement" to "confirmed = has a Settlement
 * or a Collection". No existing row changes: every confirmed draft today has a
 * Settlement and no Collection, which satisfies both the old and new rule.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table trader_settlement_drafts
      add column if not exists confirmed_collection_id uuid
  `.execute(database);
  await sql`
    alter table trader_settlement_drafts
      drop constraint if exists trader_settlement_drafts_confirmed_collection_fk
  `.execute(database);
  await sql`
    alter table trader_settlement_drafts
      add constraint trader_settlement_drafts_confirmed_collection_fk
      foreign key (confirmed_collection_id, company_id)
      references trader_collections(id, company_id) on delete restrict
  `.execute(database);
  await sql`
    create unique index if not exists trader_settlement_drafts_confirmed_collection_uq
      on trader_settlement_drafts(company_id, confirmed_collection_id)
      where confirmed_collection_id is not null
  `.execute(database);
  await sql`
    alter table trader_settlement_drafts
      drop constraint if exists trader_settlement_drafts_status_consistent
  `.execute(database);
  await sql`
    alter table trader_settlement_drafts
      add constraint trader_settlement_drafts_status_consistent
      check ((status = 'confirmed') = (confirmed_settlement_id is not null or confirmed_collection_id is not null))
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table trader_settlement_drafts
      drop constraint if exists trader_settlement_drafts_status_consistent
  `.execute(database);
  await sql`
    alter table trader_settlement_drafts
      add constraint trader_settlement_drafts_status_consistent
      check ((status = 'confirmed') = (confirmed_settlement_id is not null))
  `.execute(database);
  await sql`drop index if exists trader_settlement_drafts_confirmed_collection_uq`.execute(database);
  await sql`
    alter table trader_settlement_drafts
      drop constraint if exists trader_settlement_drafts_confirmed_collection_fk
  `.execute(database);
  await sql`
    alter table trader_settlement_drafts drop column if exists confirmed_collection_id
  `.execute(database);
}
