import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Drop the stale `unique (company_id, period_start, period_end)` constraint
 * on `payroll_periods`, left over from before the `reversed` status existed.
 *
 * `20260731110000_employee_payroll_financial_foundations` correctly added
 * `payroll_periods_active_month_unique` -- a PARTIAL unique index on
 * `(company_id, payroll_month) where status <> 'reversed'` -- so a Company can
 * reverse a Payroll period and create a fresh one for the same month. That is
 * exactly what `PayrollPeriodService.create()` already implements: it checks
 * `existing.rows.some((period) => period.status !== "reversed")` and only
 * blocks a genuinely conflicting (non-reversed) period, generating a distinct
 * `-R2`/`-R3` reference suffix for the recreated one.
 *
 * But the ORIGINAL table definition (`20260713230020_finance_accounting`,
 * written before `reversed` existed) also carries a plain, non-partial
 * `unique (company_id, period_start, period_end)`. period_start/period_end
 * are derived one-to-one from payroll_month, so this is the same uniqueness
 * dimension as `payroll_periods_active_month_unique` -- except this older
 * constraint has no status exclusion, so it silently blocks the exact
 * "reverse, then recreate" case the newer index was built to allow: the
 * INSERT hits `on conflict do nothing`, returns no row, and the service
 * reports "A Payroll period already exists for this Company and month" even
 * though the only existing period for that month is reversed.
 *
 * Dropping it is safe: `payroll_periods_active_month_unique` already
 * enforces "at most one non-reversed period per Company per month", which is
 * the only invariant this table actually needs -- and reversed periods are
 * meant to coexist with their replacement, never to collide with it.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table payroll_periods
      drop constraint payroll_periods_company_id_period_start_period_end_key;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table payroll_periods
      add constraint payroll_periods_company_id_period_start_period_end_key
      unique (company_id, period_start, period_end);
  `.execute(database);
}
