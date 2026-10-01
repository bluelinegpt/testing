import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * At most one OPEN settlement draft per Trader.
 *
 * A draft reserves nothing, so two open drafts for the same Trader could hold
 * the same Order — and only the first confirmation could ever succeed, because
 * confirmation revalidates against live outstanding balances. Rather than warn
 * about that collision, this removes it: with one open draft per Trader, two
 * drafts cannot share an Order at all, since an Order belongs to one Trader.
 *
 * The index is partial on `status = 'draft'`. Confirmed drafts are kept forever
 * as the record of what was confirmed, and any number of them may exist for a
 * Trader — only work in progress is limited.
 *
 * Existing duplicates are resolved by keeping the most recently updated open
 * draft per Trader and deleting the rest. Nothing financial is lost: an open
 * draft has posted no Event, no Journal and no cash movement, and no Order or
 * receivable balance references it.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from trader_settlement_drafts stale
     using trader_settlement_drafts keep
     where stale.status = 'draft'
       and keep.status = 'draft'
       and stale.company_id = keep.company_id
       and stale.trader_id = keep.trader_id
       and (keep.updated_at, keep.id) > (stale.updated_at, stale.id);
    create unique index trader_settlement_drafts_one_open_per_trader_uq
      on trader_settlement_drafts(company_id, trader_id)
      where status = 'draft';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists trader_settlement_drafts_one_open_per_trader_uq;
  `.execute(database);
}
