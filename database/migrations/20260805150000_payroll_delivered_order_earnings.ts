import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Brings employee per-delivered-Order earnings into monthly payroll.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE COMPONENT
 * ---------------------------------------------------------------------------
 *
 * `employee_driver_commission` already exists and is tempting to reuse. It is
 * not the same thing: it is fed by `commission_calculations`, has its own
 * accrued/payable lifecycle, and is reported as commission. Folding flat
 * per-delivery earnings into it would make both numbers unexplainable — nobody
 * could tell afterwards which part of a payslip came from which rule.
 *
 * So `delivered_order_earnings` is its own column on the entry, its own total
 * on the period, and its own line of the payslip: "Delivered Order Earnings".
 *
 * ---------------------------------------------------------------------------
 * WHY THE ALLOCATION LIVES ON THE EARNING
 * ---------------------------------------------------------------------------
 *
 * `employee_order_earnings.payroll_period_id` is what makes "paid once" a
 * database fact rather than a query convention. A single-valued column cannot
 * name two periods, so no earning can appear in two payrolls no matter how the
 * calculation is written, retried, or raced.
 *
 * The alternative — a link table like `payroll_commission_links` — allows the
 * same snapshot to be linked from two periods and relies on the application to
 * notice. For money that is exactly the guarantee worth having in the schema.
 *
 * The link back to `payroll_entry_id` is kept alongside so a payslip line can
 * be expanded to its Orders without re-deriving anything.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MIGRATION DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * No payment, no Accounting Event, no Journal, no financial transaction, and no
 * Employee bank details. Payroll stays cash-only. Existing rows get 0 and no
 * historical period changes: `total_paid + total_outstanding = total_net_salary`
 * still holds, because a zero component moves no total.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    -- Default 0 so every existing entry keeps its current gross and net, and
    -- the period totals check continues to hold without a backfill.
    alter table payroll_entries
      add column delivered_order_earnings numeric(18, 2) not null default 0,
      add constraint payroll_entries_delivered_order_earnings_check
        check (delivered_order_earnings >= 0);

    alter table payroll_periods
      add column total_delivered_order_earnings numeric(18, 2) not null default 0,
      add constraint payroll_periods_delivered_order_earnings_check
        check (total_delivered_order_earnings >= 0);

    comment on column payroll_entries.delivered_order_earnings is
      'Flat per-delivered-Order earnings allocated to this Payroll line, summed from immutable employee_order_earnings snapshots. Not commission.';

    -- Allocation. Null means the earning is still unpaid and available to the
    -- next Payroll period that covers it.
    alter table employee_order_earnings
      add column payroll_period_id uuid,
      add column payroll_entry_id uuid,
      add column allocated_at timestamptz,

      add constraint employee_order_earnings_period_fk
        foreign key (payroll_period_id, company_id)
        references payroll_periods(id, company_id) on delete restrict,
      add constraint employee_order_earnings_entry_fk
        foreign key (payroll_entry_id, company_id)
        references payroll_entries(id, company_id) on delete restrict,

      -- All three together or none at all. A half-written allocation would read
      -- as "unpaid" to one query and "paid" to another.
      add constraint employee_order_earnings_allocation_shape_check check (
        (payroll_period_id is null and payroll_entry_id is null and allocated_at is null)
        or (payroll_period_id is not null and payroll_entry_id is not null
            and allocated_at is not null)
      );

    -- The selection query: unallocated earnings for one Employee in one month.
    -- Partial, because allocated rows are never scanned by it and there will be
    -- far more of them over time.
    create index employee_order_earnings_unallocated_index
      on employee_order_earnings (company_id, employee_id, earning_month)
      where payroll_period_id is null;

    -- Expanding a payslip line back to its Orders.
    create index employee_order_earnings_allocation_index
      on employee_order_earnings (company_id, payroll_entry_id)
      where payroll_entry_id is not null;

    comment on column employee_order_earnings.payroll_period_id is
      'The Payroll period this earning was allocated to. Single-valued on purpose: an earning cannot be paid in two periods. Null means unpaid and still eligible.';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists employee_order_earnings_allocation_index;
    drop index if exists employee_order_earnings_unallocated_index;

    alter table employee_order_earnings
      drop constraint if exists employee_order_earnings_allocation_shape_check,
      drop constraint if exists employee_order_earnings_entry_fk,
      drop constraint if exists employee_order_earnings_period_fk,
      drop column if exists allocated_at,
      drop column if exists payroll_entry_id,
      drop column if exists payroll_period_id;

    alter table payroll_periods
      drop constraint if exists payroll_periods_delivered_order_earnings_check,
      drop column if exists total_delivered_order_earnings;

    alter table payroll_entries
      drop constraint if exists payroll_entries_delivered_order_earnings_check,
      drop column if exists delivered_order_earnings;
  `.execute(database);
}
