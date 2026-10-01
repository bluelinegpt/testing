import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Let a settlement draft actually record that it was confirmed.
 *
 * `20260977000000` created the table with an inline `check (status = 'draft')`,
 * and `20260978000000` added `confirmed_settlement_id` without widening it. So
 * writing `status='confirmed'` at confirmation time violated
 * `trader_settlement_drafts_status_check`, and the service was changed to stop
 * writing the column rather than to fix the constraint. That left `status`
 * permanently `'draft'` while the API type and the saved-drafts table both
 * branch on `'confirmed'` — a confirmed draft rendered as an editable one.
 *
 * This widens the constraint, backfills every draft that already has a
 * confirmed settlement, and then ties the two columns together so they can
 * never disagree again: `status = 'confirmed'` exactly when
 * `confirmed_settlement_id` is present. Both columns are `not null`-safe in
 * that expression, so the check is never indeterminate.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table trader_settlement_drafts
      drop constraint if exists trader_settlement_drafts_status_check;
    alter table trader_settlement_drafts
      add constraint trader_settlement_drafts_status_check
        check (status in ('draft', 'confirmed'));
    update trader_settlement_drafts
       set status = 'confirmed'
     where confirmed_settlement_id is not null
       and status <> 'confirmed';
    alter table trader_settlement_drafts
      add constraint trader_settlement_drafts_status_consistent
        check ((status = 'confirmed') = (confirmed_settlement_id is not null));
    create index trader_settlement_drafts_company_status_idx
      on trader_settlement_drafts(company_id, status, updated_at desc);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists trader_settlement_drafts_company_status_idx;
    alter table trader_settlement_drafts
      drop constraint if exists trader_settlement_drafts_status_consistent;
    alter table trader_settlement_drafts
      drop constraint if exists trader_settlement_drafts_status_check;
    update trader_settlement_drafts
       set status = 'draft'
     where status <> 'draft';
    alter table trader_settlement_drafts
      add constraint trader_settlement_drafts_status_check
        check (status = 'draft');
  `.execute(database);
}
