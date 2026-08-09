import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Let `gross_earnings` actually contain the variable earnings.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 *
 * `payroll_entries_amounts_check` pins the gross to an exact sum:
 *
 *   gross_earnings = basic_salary_snapshot
 *                  + allowance_total
 *                  + employee_driver_commission
 *                  + earning_adjustments_total
 *
 * `20260805150000_payroll_delivered_order_earnings` added
 * `delivered_order_earnings` as its own component and had the calculation add
 * it to the gross -- but never widened this constraint. The two have disagreed
 * ever since. Any Employee with a non-zero per-delivery earning therefore
 * cannot have a Payroll line written at all: the INSERT is rejected outright.
 *
 * That defect was invisible because the component defaults to 0, and a zero
 * moves no total, so every existing row and every Employee without an earning
 * rule satisfies the old formula perfectly. It only appears the moment the
 * feature is actually used, which is what the end-to-end payroll test does.
 *
 * `collection_earnings` from `20260810200000_employee_collection_earnings`
 * would have hit exactly the same wall, so both are added here together.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SAFE ON EXISTING DATA
 * ---------------------------------------------------------------------------
 *
 * Both columns are `not null default 0` on every existing row, so the widened
 * formula is arithmetically identical to the old one for all stored history:
 * adding two zeroes changes nothing. The constraint is therefore added VALIDATED
 * rather than NOT VALID -- there is no legacy row it could reject, and leaving
 * it unvalidated would weaken a money invariant for no benefit.
 *
 * The period-level `payroll_periods_totals_check` needs no change: it asserts
 * `total_paid + total_outstanding = total_net_salary`, which is a statement
 * about payment rather than about which components make up the gross.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table payroll_entries drop constraint payroll_entries_amounts_check;
    alter table payroll_entries add constraint payroll_entries_amounts_check check (
      basic_salary_snapshot >= 0
      and employee_driver_commission >= 0
      and delivered_order_earnings >= 0
      and collection_earnings >= 0
      and allowance_total >= 0
      and earning_adjustments_total >= 0
      and deduction_adjustments_total >= 0
      and advances >= 0
      and gross_earnings >= 0
      and net_salary >= 0
      and amount_paid >= 0
      and outstanding_amount >= 0
      and amount_paid <= net_salary
      -- The whole point of this migration: the two variable components now
      -- belong to the gross, exactly as the calculation service computes it.
      and gross_earnings = basic_salary_snapshot
                         + allowance_total
                         + employee_driver_commission
                         + delivered_order_earnings
                         + collection_earnings
                         + earning_adjustments_total
      and net_salary = gross_earnings - deduction_adjustments_total - advances
      and outstanding_amount = net_salary - amount_paid
    );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  /*
   * Restores the narrower formula. Note this is only reversible while every
   * `delivered_order_earnings` and `collection_earnings` is zero -- once a
   * Payroll has genuinely paid one, the old constraint is false for that row
   * and the ALTER will fail. That is the correct behaviour: the down migration
   * refusing is a better outcome than silently invalidating paid history.
   */
  await sql`
    alter table payroll_entries drop constraint payroll_entries_amounts_check;
    alter table payroll_entries add constraint payroll_entries_amounts_check check (
      basic_salary_snapshot >= 0
      and employee_driver_commission >= 0
      and allowance_total >= 0
      and earning_adjustments_total >= 0
      and deduction_adjustments_total >= 0
      and advances >= 0
      and gross_earnings >= 0
      and net_salary >= 0
      and amount_paid >= 0
      and outstanding_amount >= 0
      and amount_paid <= net_salary
      and gross_earnings = basic_salary_snapshot + allowance_total
                         + employee_driver_commission + earning_adjustments_total
      and net_salary = gross_earnings - deduction_adjustments_total - advances
      and outstanding_amount = net_salary - amount_paid
    );
  `.execute(database);
}
