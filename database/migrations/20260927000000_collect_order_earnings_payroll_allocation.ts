import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Lets a Collect-Order's Collection Earning reach Payroll directly, the same
 * way `employee_order_earnings` (Delivery Earnings) already does -- no
 * separate "Confirm & Lock Earnings" step required.
 *
 * ---------------------------------------------------------------------------
 * THE ASYMMETRY THIS FIXES
 * ---------------------------------------------------------------------------
 *
 * `employee_order_earnings` (Delivery Earnings) has always had
 * `payroll_period_id`/`payroll_entry_id`/`allocated_at` (see
 * `20260805150000_payroll_delivered_order_earnings`), so Payroll's raw
 * calculation reads and claims it directly the moment an Order is delivered.
 *
 * `employee_collect_order_earnings` (Collection Earnings for the
 * `collect_order` Order type, captured automatically by
 * `capture_employee_collect_order_earning` on close) never got the same
 * columns -- its only path into Payroll was through
 * `employee_driver_earning_periods.earning_period_id`, a manual lock a user
 * has to trigger separately from the Payroll screen entirely. Both are
 * captured automatically at the same trustworthy moment (delivery / close);
 * only one of them required an extra step to actually get paid.
 *
 * Mirrors `20260805150000` exactly: same three columns, same allocation-shape
 * check, same partial indexes.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table employee_collect_order_earnings
      add column payroll_period_id uuid,
      add column payroll_entry_id uuid,
      add column allocated_at timestamptz,

      add constraint employee_collect_order_earnings_period_fk
        foreign key (payroll_period_id, company_id)
        references payroll_periods(id, company_id) on delete restrict,
      add constraint employee_collect_order_earnings_entry_fk
        foreign key (payroll_entry_id, company_id)
        references payroll_entries(id, company_id) on delete restrict,

      -- All three together or none at all, exactly like
      -- employee_order_earnings_allocation_shape_check: a half-written
      -- allocation would read as "unpaid" to one query and "paid" to another.
      add constraint employee_collect_order_earnings_allocation_shape_check check (
        (payroll_period_id is null and payroll_entry_id is null and allocated_at is null)
        or (payroll_period_id is not null and payroll_entry_id is not null
            and allocated_at is not null)
      );

    -- The selection query: unallocated, unlocked earnings for one Employee.
    create index employee_collect_order_earnings_unallocated_index
      on employee_collect_order_earnings (company_id, employee_id, closed_at)
      where payroll_period_id is null and earning_period_id is null;

    -- Expanding a payslip line back to its Orders.
    create index employee_collect_order_earnings_allocation_index
      on employee_collect_order_earnings (company_id, payroll_entry_id)
      where payroll_entry_id is not null;

    comment on column employee_collect_order_earnings.payroll_period_id is
      'The Payroll period this Collect-Order earning was allocated to directly (bypassing the Driver Earning Period lock). Single-valued: an earning cannot be paid in two periods. Null means unpaid and still eligible.';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists employee_collect_order_earnings_allocation_index;
    drop index if exists employee_collect_order_earnings_unallocated_index;

    alter table employee_collect_order_earnings
      drop constraint if exists employee_collect_order_earnings_allocation_shape_check,
      drop constraint if exists employee_collect_order_earnings_entry_fk,
      drop constraint if exists employee_collect_order_earnings_period_fk,
      drop column if exists allocated_at,
      drop column if exists payroll_entry_id,
      drop column if exists payroll_period_id;
  `.execute(database);
}
