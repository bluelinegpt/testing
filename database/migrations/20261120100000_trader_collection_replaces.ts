import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Trader Collection "Reverse & adjust" / "Post again" (Aiman, 20 Nov 2026).
 *
 * A Trader Collection posted from the Trader Collections screen (not from a
 * one-screen settlement draft) could only be reversed: there was no way to
 * change it and post it again. Now reversing it can also open a draft with the
 * same fees, and a reversed collection can be posted again from a draft.
 *
 * Both tables remember which collection the new one replaces, so the old and
 * the new collection can show each other ("replaced by" / "replaces"):
 *   - trader_settlement_drafts.replaces_collection_id: set when the draft is
 *     opened from a collection; it survives every later save of the draft
 *     (saves replace only `payload`);
 *   - trader_collections.replaces_collection_id: copied from the draft when the
 *     draft is posted as a collection.
 *
 * Additive only: two nullable columns, their foreign keys and one partial
 * unique index. No existing row changes, so nothing here can fail on data.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  for (const table of ["trader_settlement_drafts", "trader_collections"] as const) {
    await sql`
      alter table ${sql.table(table)} add column if not exists replaces_collection_id uuid
    `.execute(database);
    await sql`
      alter table ${sql.table(table)} drop constraint if exists ${sql.ref(`${table}_replaces_collection_fk`)}
    `.execute(database);
    await sql`
      alter table ${sql.table(table)}
        add constraint ${sql.ref(`${table}_replaces_collection_fk`)}
        foreign key (replaces_collection_id, company_id)
        references trader_collections(id, company_id) on delete restrict
    `.execute(database);
  }
  // One live replacement per collection. A replacement that is itself reversed
  // no longer counts, so the original can be posted again once more.
  await sql`
    create unique index if not exists trader_collections_replaces_live_uq
      on trader_collections(company_id, replaces_collection_id)
      where replaces_collection_id is not null and status = 'confirmed'
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop index if exists trader_collections_replaces_live_uq`.execute(database);
  for (const table of ["trader_collections", "trader_settlement_drafts"] as const) {
    await sql`
      alter table ${sql.table(table)} drop constraint if exists ${sql.ref(`${table}_replaces_collection_fk`)}
    `.execute(database);
    await sql`
      alter table ${sql.table(table)} drop column if exists replaces_collection_id
    `.execute(database);
  }
}
