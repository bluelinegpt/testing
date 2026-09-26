import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Record WHEN three money movements were actually confirmed.
 *
 * Trader Collections, Payroll Payments and Outsourced Driver Fee Payments each
 * store only `payment_date` — a `date` chosen by a person. That is the right
 * field for accounting, and it stays exactly as it is. But it carries no time of
 * day, so it cannot answer the question the Company business day asks: a payment
 * dated 05 Aug gives no evidence of whether it happened at 02:00 or at 22:00,
 * and those two belong to different business days.
 *
 * Driver Collections, Trader Settlements, Cash/Bank Movements and General
 * Expense Payments already carry `confirmed_at`. These three were the gap.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT REUSE created_at
 * ---------------------------------------------------------------------------
 *
 * `created_at` is when the row was typed, not when the money moved. A payment
 * entered on Monday morning for Friday night's cash would be reported on Monday.
 * Available is not the same as authoritative, and a business-day report built on
 * the wrong column is worse than one that admits it has no answer.
 *
 * ---------------------------------------------------------------------------
 * NULLABLE, AND DELIBERATELY NOT BACKFILLED
 * ---------------------------------------------------------------------------
 *
 * Nullable so every existing row stays valid, and left null on purpose.
 *
 * There is no honest value to backfill. `created_at` is the wrong column;
 * `payment_date` has no time of day, so any conversion would be inventing an
 * hour that nobody observed. Either would produce a number that looks
 * authoritative and is not — and it would be indistinguishable from a real one
 * forever after.
 *
 * So historical rows report null, Business Date mode excludes them, and the
 * report says so out loud. Calendar Date mode continues to serve them from
 * `payment_date` exactly as before.
 *
 * The timestamps are therefore PROSPECTIVE: populated from the moment the
 * writing services set them, never reconstructed.
 *
 * ---------------------------------------------------------------------------
 * WHEN THEY ARE SET
 * ---------------------------------------------------------------------------
 *
 * All three tables default `status` to 'confirmed' — the records are created
 * directly in their final state rather than moving through a draft. Each
 * writing service therefore sets `confirmed_at` to the server's own clock in the
 * same transaction as the insert. No client supplies it; a confirmation time
 * accepted from a request could place money in whatever business day the caller
 * preferred.
 *
 * `reversed_at` stays separate and untouched: reversing a payment does not
 * change when it was confirmed.
 *
 * ---------------------------------------------------------------------------
 * INDEXES
 * ---------------------------------------------------------------------------
 *
 * One per table, Company-leading then the timestamp, matching the shape of the
 * predicate a Business Date report issues:
 *
 *     where company_id = $1 and confirmed_at >= $2 and confirmed_at < $3
 *
 * Partial on `confirmed_at is not null`, so the historical rows that can never
 * satisfy such a predicate are kept out of the index entirely.
 *
 * No row is read, written or backfilled by this migration.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table trader_collections
      add column if not exists confirmed_at timestamptz;
    alter table payroll_payments
      add column if not exists confirmed_at timestamptz;
    alter table outsourced_driver_fee_payments
      add column if not exists confirmed_at timestamptz;

    comment on column trader_collections.confirmed_at is
      'Server time the Collection was confirmed. Null on rows created before this column existed; those are excluded from Business Date reporting rather than estimated.';
    comment on column payroll_payments.confirmed_at is
      'Server time the Payment was confirmed. Null on historical rows; never derived from created_at or payment_date.';
    comment on column outsourced_driver_fee_payments.confirmed_at is
      'Server time the Payment was confirmed. Null on historical rows; never derived from created_at or payment_date.';

    create index if not exists trader_collections_confirmed_at_index
      on trader_collections (company_id, confirmed_at)
      where confirmed_at is not null;
    create index if not exists payroll_payments_confirmed_at_index
      on payroll_payments (company_id, confirmed_at)
      where confirmed_at is not null;
    create index if not exists outsourced_driver_fee_payments_confirmed_at_index
      on outsourced_driver_fee_payments (company_id, confirmed_at)
      where confirmed_at is not null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists trader_collections_confirmed_at_index;
    drop index if exists payroll_payments_confirmed_at_index;
    drop index if exists outsourced_driver_fee_payments_confirmed_at_index;
    alter table trader_collections drop column if exists confirmed_at;
    alter table payroll_payments drop column if exists confirmed_at;
    alter table outsourced_driver_fee_payments drop column if exists confirmed_at;
  `.execute(database);
}
