import { HttpStatus, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";

@Injectable()
export class PayrollOperationalRepository {
  public async recalculateLine(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    lineId: string,
  ): Promise<void> {
    await sql`select id from payroll_entries
      where id=${lineId}::uuid and company_id=${companyId}::uuid for update`.execute(database);
    const result = await sql<{
      advances: string;
      allowanceTotal: string;
      basicSalary: string;
      collectionEarnings: string;
      commission: string;
      deliveredOrderEarnings: string;
      earningAdjustments: string;
      deductionAdjustments: string;
      held: boolean;
      paid: string;
      salaryAdvanceRecovery: string;
      variableAlreadyPaid: string;
    }>`
      select l.basic_salary_snapshot::text as "basicSalary",
             l.allowance_total::text as "allowanceTotal",
             l.employee_driver_commission::text as commission,
             l.delivered_order_earnings::text as "deliveredOrderEarnings",
             l.collection_earnings::text as "collectionEarnings",
             l.advances::text as advances, l.amount_paid::text as paid,
             l.variable_earnings_already_paid::text as "variableAlreadyPaid",
             l.salary_advance_recovery::text as "salaryAdvanceRecovery",
             l.salary_hold_snapshot as held,
             coalesce(sum(a.amount) filter (
               where a.status='active' and a.direction='earning'
             ),0)::text as "earningAdjustments",
             coalesce(sum(a.amount) filter (
               where a.status='active' and a.direction='deduction'
             ),0)::text as "deductionAdjustments"
        from payroll_entries l
       left join payroll_adjustments a
          on a.payroll_line_id=l.id and a.company_id=l.company_id
       where l.id=${lineId}::uuid and l.company_id=${companyId}::uuid
       group by l.id
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "payroll_line_not_found",
        "The Payroll line was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const earning = row.held ? new Decimal(0) : new Decimal(row.earningAdjustments);
    const deduction = row.held ? new Decimal(0) : new Decimal(row.deductionAdjustments);
    // A held line pays nothing, including Order earnings. Those snapshots are
    // never allocated to a held line in the first place, so they stay unpaid and
    // remain eligible for a later period rather than being forfeited.
    /* THIS IS THE AUTHORITATIVE GROSS. It runs after the calculation INSERT and
       after every adjustment, and it OVERWRITES `gross_earnings` -- so any
       component missing from this sum is silently dropped from the payslip even
       when the calculation computed it correctly and stored it in its own
       column. That is exactly how collection earnings were lost: the INSERT
       wrote 3009, this recomputation then wrote 3006 back over it.

       Every variable component must therefore appear here, in `payroll_entries_amounts_check`,
       and in the calculation service's own `gross`. Adding a component to one
       without the others reintroduces the same defect. */
    const gross = row.held
      ? new Decimal(0)
      : new Decimal(row.basicSalary)
          .plus(row.allowanceTotal)
          .plus(row.commission)
          .plus(row.deliveredOrderEarnings)
          .plus(row.collectionEarnings)
          .plus(earning);
    const net = gross
      .minus(deduction)
      .minus(row.held ? 0 : row.advances)
      .minus(row.held ? 0 : row.variableAlreadyPaid)
      .minus(row.held ? 0 : row.salaryAdvanceRecovery);
    if (net.isNegative()) {
      throw new ApplicationException(
        "payroll_line_negative_net_salary",
        "Payroll adjustments cannot make Net Salary negative",
        HttpStatus.CONFLICT,
      );
    }
    const outstanding = net.minus(row.paid);
    if (outstanding.isNegative()) {
      throw new ApplicationException(
        "payroll_payment_exceeds_outstanding",
        "Existing Payroll payments exceed the recalculated Net Salary",
        HttpStatus.CONFLICT,
      );
    }
    await sql`
      update payroll_entries
         set earning_adjustments_total=${earning.toFixed(2)},
             deduction_adjustments_total=${deduction.toFixed(2)},
             gross_earnings=${gross.toFixed(2)}, net_salary=${net.toFixed(2)},
             outstanding_amount=${outstanding.toFixed(2)},
             updated_at=now(), version=version+1
       where id=${lineId}::uuid and company_id=${companyId}::uuid
    `.execute(database);
  }

  public async recalculatePeriodTotals(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    periodId: string,
  ): Promise<void> {
    await sql`
      update payroll_periods p
         set total_employees=totals.employee_count,
             total_basic_salary=totals.basic_salary,
             total_allowances=totals.allowances,
             total_employee_driver_commission=totals.driver_commission,
             total_delivered_order_earnings=totals.delivered_order_earnings,
             total_collection_earnings=totals.collection_earnings,
             total_earning_adjustments=totals.earning_adjustments,
             total_deductions=totals.deductions,
             total_net_salary=totals.net_salary,
             total_paid=totals.paid,
             total_outstanding=totals.outstanding,
             updated_at=now(), version=p.version+1
        from (
          select count(*) filter (where status <> 'reversed')::integer as employee_count,
                 coalesce(sum(basic_salary_snapshot) filter (where status <> 'reversed'),0) as basic_salary,
                 coalesce(sum(allowance_total) filter (where status <> 'reversed'),0) as allowances,
                 coalesce(sum(employee_driver_commission) filter (where status <> 'reversed'),0)
                   as driver_commission,
                 coalesce(sum(delivered_order_earnings) filter (where status <> 'reversed'),0)
                   as delivered_order_earnings,
                 coalesce(sum(collection_earnings) filter (where status <> 'reversed'),0)
                   as collection_earnings,
                 coalesce(sum(earning_adjustments_total) filter (where status <> 'reversed'),0)
                   as earning_adjustments,
                 coalesce(sum(deduction_adjustments_total + advances
                   + variable_earnings_already_paid + salary_advance_recovery)
                   filter (where status <> 'reversed'),0) as deductions,
                 coalesce(sum(net_salary) filter (where status <> 'reversed'),0) as net_salary,
                 coalesce(sum(amount_paid) filter (where status <> 'reversed'),0) as paid,
                 coalesce(sum(outstanding_amount) filter (where status <> 'reversed'),0) as outstanding
            from payroll_entries
           where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
        ) totals
       where p.id=${periodId}::uuid and p.company_id=${companyId}::uuid
    `.execute(database);
  }

  public async refreshSettlementStatuses(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    periodId: string,
  ): Promise<"approved" | "paid" | "partially_paid"> {
    const lines = await sql<{
      hasOutstanding: boolean;
      paidCount: number;
      payableCount: number;
    }>`
      select count(*) filter (
               where status <> 'held' and status <> 'reversed'
             )::integer as "payableCount",
             count(*) filter (
               where status <> 'held' and status <> 'reversed' and amount_paid > 0
             )::integer as "paidCount",
             coalesce(bool_or(
               status <> 'held' and status <> 'reversed' and outstanding_amount > 0
             ),false) as "hasOutstanding"
        from payroll_entries
       where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
    `.execute(database);
    const summary = lines.rows[0]!;
    const status =
      summary.paidCount === 0 ? "approved" : summary.hasOutstanding ? "partially_paid" : "paid";
    await sql`
      update payroll_entries
         set status=case
               when status='held' or status='reversed' then status
               when amount_paid=0 then 'approved'
               when outstanding_amount=0 then 'paid'
               else 'partially_paid'
             end,
             updated_at=now(), version=version+1
       where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
    `.execute(database);
    await sql`
      update payroll_periods
         set status=${status}, updated_at=now(), version=version+1
       where id=${periodId}::uuid and company_id=${companyId}::uuid
         and status <> 'reversed'
    `.execute(database);
    return status;
  }
}
