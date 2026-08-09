import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Indexes the Daily Cash and Financial Activity Report cannot do without.
 *
 * Four of its seven cash sources had no index on `confirmed_at`. The other
 * three got theirs in `20260805130000_operational_confirmation_timestamps`;
 * this closes the set.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE REQUIRED AND NOT MERELY NICE
 * ---------------------------------------------------------------------------
 *
 * The report asks each source two questions: what moved inside an 08:00-08:00
 * window, and what the balance was BEFORE it. The second is the reason these
 * indexes are not optional. "Everything confirmed before this instant" is an
 * unbounded range that grows by one day every day, so without an index the
 * opening balance degrades into a full scan of every payment the Company has
 * ever confirmed — on a report that runs daily, per Company.
 *
 * ---------------------------------------------------------------------------
 * SHAPE
 * ---------------------------------------------------------------------------
 *
 * `(company_id, confirmed_at)` and partial on `confirmed_at is not null`.
 *
 * company_id leads because every query is tenant-scoped first and time-scoped
 * second. The partial predicate matches the report's own filter: rows without
 * an authoritative instant are excluded from Business Date activity rather than
 * estimated, so they are never read and do not belong in the index.
 *
 * Nothing else is added. `journal_entries (company_id, business_date desc)`
 * already exists and serves the Income Statement section unchanged.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create index if not exists driver_reconciliations_confirmed_at_index
      on driver_reconciliations (company_id, confirmed_at)
      where confirmed_at is not null;

    create index if not exists trader_settlements_confirmed_at_index
      on trader_settlements (company_id, confirmed_at)
      where confirmed_at is not null;

    create index if not exists general_expense_payments_confirmed_at_index
      on general_expense_payments (company_id, confirmed_at)
      where confirmed_at is not null;

    create index if not exists cash_bank_movements_confirmed_at_index
      on cash_bank_movements (company_id, confirmed_at)
      where confirmed_at is not null;

    -- The Settlement branch joins payments to their header. Without this the
    -- join is a scan per Settlement in the window.
    create index if not exists trader_settlement_payments_settlement_index
      on trader_settlement_payments (company_id, settlement_id);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists trader_settlement_payments_settlement_index;
    drop index if exists cash_bank_movements_confirmed_at_index;
    drop index if exists general_expense_payments_confirmed_at_index;
    drop index if exists trader_settlements_confirmed_at_index;
    drop index if exists driver_reconciliations_confirmed_at_index;
  `.execute(database);
}
