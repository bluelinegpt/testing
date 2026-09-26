import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Allow same-day / incremental Driver Earning calculations.
 *
 * Product decision (approved 2026-08-31): instead of "the current day cannot
 * be calculated until tomorrow", earnings are captured incrementally -- each
 * confirmed period claims its source orders at the ORDER level
 * (employee_driver_earning_period_delivery_sources for deliveries,
 * employee_collect_order_earnings.earning_period_id for collections), and
 * every calculation already excludes previously-claimed orders. With
 * double-counting prevented per order, the per-employee date-range exclusion
 * constraint is no longer the integrity mechanism and actively blocks the
 * new workflow (a second same-day period necessarily overlaps the first).
 *
 * Data untouched; this only drops the range-overlap rule.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table employee_driver_earning_periods
      drop constraint if exists employee_driver_earning_periods_no_overlap;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  // Best-effort restore: fails if overlapping periods were created while the
  // constraint was absent -- those rows are legitimate under the new model
  // and must be resolved manually before reverting.
  await sql`
    alter table employee_driver_earning_periods
      add constraint employee_driver_earning_periods_no_overlap
      exclude using gist(company_id with =,employee_id with =,daterange(date_from,date_to,'[]') with &&)
      where(status<>'reversed');
  `.execute(database);
}
