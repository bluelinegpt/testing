import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type {
  PayrollLineListQueryDto,
  PayrollPaymentListQueryDto,
  PayrollPeriodListQueryDto,
} from "./payroll.dto.js";
import { PayrollOperationSupport } from "./payroll-operation.support.js";

export interface PayrollPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

@Injectable()
export class PayrollQueryService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(PayrollOperationSupport) private readonly support: PayrollOperationSupport,
  ) {}

  public async periods(
    query: PayrollPeriodListQueryDto,
  ): Promise<PayrollPage<Record<string, unknown>>> {
    this.support.assertPermission("payroll.view");
    const { companyId } = this.support.context();
    const page = this.support.pagination(query);
    const result = await sql<Record<string, unknown> & { total: number }>`
      select p.id, p.period_reference as "periodReference",
             to_char(p.payroll_month,'YYYY-MM') as "payrollMonth",
             p.period_start::text as "periodStart", p.period_end::text as "periodEnd",
             p.status, p.total_employees as "totalEmployees",
             count(l.id) filter (where l.status='held')::integer as "heldEmployees",
             p.total_net_salary::text as "netPayroll",
             p.total_paid::text as "totalPaid",
             p.total_outstanding::text as "totalOutstanding",
             p.created_at::text as "createdAt", p.calculated_at::text as "calculatedAt",
             p.approved_at::text as "approvedAt", p.closed_at::text as "closedAt",
             p.reversed_at::text as "reversedAt",
             count(*) over()::integer as total
        from payroll_periods p
        left join payroll_entries l
          on l.payroll_period_id=p.id and l.company_id=p.company_id and l.status<>'reversed'
       where p.company_id=${companyId}::uuid
         and (${query.payrollMonth ?? null}::text is null
           or p.payroll_month=${query.payrollMonth ? `${query.payrollMonth}-01` : null}::date)
         and (${query.status ?? null}::text is null or p.status=${query.status ?? null})
         and (${query.dateFrom ?? null}::date is null or p.period_end>=${query.dateFrom ?? null}::date)
         and (${query.dateTo ?? null}::date is null or p.period_start<=${query.dateTo ?? null}::date)
         and (not ${query.outstandingOnly ?? false} or p.total_outstanding>0)
         and (${query.search ?? null}::text is null
           or p.period_reference ilike '%' || ${query.search ?? null} || '%')
       group by p.id
       order by p.payroll_month desc, p.id
       limit ${page.limit} offset ${page.offset}
    `.execute(this.database);
    return this.page(result.rows, page.page, page.pageSize);
  }

  public async periodDetail(periodId: string): Promise<Record<string, unknown>> {
    this.support.assertPermission("payroll.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select p.id, p.period_reference as "periodReference",
             to_char(p.payroll_month,'YYYY-MM') as "payrollMonth",
             p.period_start::text as "periodStart", p.period_end::text as "periodEnd",
             p.status, p.notes, p.total_employees as "totalEmployees",
             p.total_basic_salary::text as "totalBasicSalary",
             p.total_allowances::text as "totalAllowances",
             p.total_employee_driver_commission::text as "totalDriverCommission",
             p.total_earning_adjustments::text as "totalEarningAdjustments",
             p.total_deductions::text as "totalDeductions",
             (p.total_basic_salary+p.total_allowances+p.total_employee_driver_commission+
               p.total_earning_adjustments)::text as "totalGrossEarnings",
             p.total_net_salary::text as "totalNetSalary",
             p.total_paid::text as "totalPaid", p.total_outstanding::text as "totalOutstanding",
             p.created_at::text as "createdAt", p.calculated_at::text as "calculatedAt",
             p.approved_at::text as "approvedAt", p.closed_at::text as "closedAt",
             p.reversed_at::text as "reversedAt", p.reversal_reason as "reversalReason",
             creator.username as "createdBy", calculator.username as "calculatedBy",
             approver.username as "approvedBy", closer.username as "closedBy",
             reverser.username as "reversedBy",
             (select count(*)::integer from payroll_entries l
               where l.company_id=p.company_id and l.payroll_period_id=p.id
                 and l.status='held') as "heldCount",
             (select jsonb_build_object(
               'active', count(*) filter (where e.status='active'),
               'blocking', count(*) filter (where e.status='active' and e.severity='blocking'),
               'warnings', count(*) filter (where e.status='active' and e.severity='warning')
             ) from payroll_calculation_exceptions e
               where e.company_id=p.company_id and e.payroll_period_id=p.id) as "exceptionSummary"
        from payroll_periods p
        left join accounts creator on creator.id=p.created_by_account_id and creator.company_id=p.company_id
        left join accounts calculator on calculator.id=p.calculated_by_account_id and calculator.company_id=p.company_id
        left join accounts approver on approver.id=p.approved_by_account_id and approver.company_id=p.company_id
        left join accounts closer on closer.id=p.closed_by_account_id and closer.company_id=p.company_id
        left join accounts reverser on reverser.id=p.reversed_by_account_id and reverser.company_id=p.company_id
       where p.id=${periodId}::uuid and p.company_id=${companyId}::uuid
    `.execute(this.database);
    return this.required(
      result.rows[0],
      "payroll_period_not_found",
      "The Payroll period was not found",
    );
  }

  public async periodSummary(periodId: string): Promise<Record<string, unknown>> {
    this.support.assertPermission("payroll.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select count(l.id) filter (where l.status<>'reversed')::integer as "employeeCount",
             count(l.id) filter (where l.status='calculated')::integer as "calculatedCount",
             count(l.id) filter (where l.status='held')::integer as "heldCount",
             count(l.id) filter (where l.status='approved')::integer as "approvedCount",
             count(l.id) filter (where l.status='paid')::integer as "paidCount",
             count(l.id) filter (where l.status='partially_paid')::integer as "partiallyPaidCount",
             count(l.id) filter (where l.outstanding_amount>0 and l.status<>'reversed')::integer
               as "outstandingCount",
             coalesce(sum(l.basic_salary_snapshot) filter (where l.status<>'reversed'),0)::text
               as "basicSalaryTotal",
             coalesce(sum(l.allowance_total) filter (where l.status<>'reversed'),0)::text
               as "allowanceTotal",
             coalesce(sum(l.employee_driver_commission) filter (where l.status<>'reversed'),0)::text
               as "driverCommissionTotal",
             coalesce(sum(l.earning_adjustments_total) filter (where l.status<>'reversed'),0)::text
               as "earningAdjustmentTotal",
             coalesce(sum(l.deduction_adjustments_total+l.advances
               +l.variable_earnings_already_paid+l.salary_advance_recovery)
               filter (where l.status<>'reversed'),0)::text
               as "deductionTotal",
             coalesce(sum(l.net_salary) filter (where l.status<>'reversed'),0)::text
               as "netSalaryTotal",
             coalesce(sum(l.amount_paid) filter (where l.status<>'reversed'),0)::text
               as "paidTotal",
             coalesce(sum(l.outstanding_amount) filter (where l.status<>'reversed'),0)::text
               as "outstandingTotal"
        from payroll_periods p
        left join payroll_entries l
          on l.payroll_period_id=p.id and l.company_id=p.company_id
       where p.company_id=${companyId}::uuid and p.id=${periodId}::uuid
       group by p.id
    `.execute(this.database);
    return this.required(
      result.rows[0],
      "payroll_period_not_found",
      "The Payroll period was not found",
    );
  }

  public async lines(
    periodId: string,
    query: PayrollLineListQueryDto,
  ): Promise<PayrollPage<Record<string, unknown>>> {
    this.support.assertPermission("payroll.view");
    const { companyId } = this.support.context();
    const page = this.support.pagination(query);
    const result = await sql<Record<string, unknown> & { total: number }>`
      select id, payroll_number as "payrollLineReference",
             employee_id as "employeeId", employee_name_snapshot as "employeeName",
             employee_number_snapshot as "employeeNumber",
             employment_type_snapshot as "employmentType", department_snapshot as department,
             basic_salary_snapshot::text as "basicSalary", allowance_total::text as allowances,
             employee_driver_commission::text as "driverCommission",
             delivered_order_earnings::text as "deliveredOrderEarnings",
             collection_earnings::text as "collectionEarnings",
             variable_earnings_already_paid::text as "variableEarningsAlreadyPaid",
             salary_advance_recovery::text as "salaryAdvanceRecovery",
             earning_adjustments_total::text as "earningAdjustments",
             (deduction_adjustments_total+advances)::text as deductions,
             gross_earnings::text as "grossEarnings", net_salary::text as "netSalary",
             amount_paid::text as paid, outstanding_amount::text as outstanding,
             status, count(*) over()::integer as total
        from payroll_entries
       where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
         and (${query.employee ?? null}::text is null or
           employee_name_snapshot ilike '%' || ${query.employee ?? null} || '%'
           or employee_number_snapshot ilike '%' || ${query.employee ?? null} || '%')
         and (${query.status ?? null}::text is null or status=${query.status ?? null})
         and (${query.department ?? null}::text is null
           or department_snapshot ilike '%' || ${query.department ?? null} || '%')
         and (${query.employeeType ?? null}::text is null
           or employment_type_snapshot=${query.employeeType ?? null})
         and (not ${query.outstandingOnly ?? false} or outstanding_amount>0)
         and (not ${query.heldOnly ?? false} or status='held')
       order by employee_number_snapshot, id
       limit ${page.limit} offset ${page.offset}
    `.execute(this.database);
    return this.page(result.rows, page.page, page.pageSize);
  }

  public async lineDetail(lineId: string): Promise<Record<string, unknown>> {
    this.support.assertPermission("payroll.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select l.id, l.payroll_number as "payrollLineReference",
             l.employee_id as "employeeId", l.employee_number_snapshot as "employeeNumber",
             l.employee_name_snapshot as "employeeName",
             l.employee_name_ar_snapshot as "employeeNameAr",
             l.employment_type_snapshot as "employmentType",
             l.department_snapshot as department, l.source_marker as "sourceMarker",
             l.salary_version_id as "salaryVersionId",
             l.basic_salary_snapshot::text as "basicSalary",
             l.allowance_total::text as "allowanceTotal",
             l.employee_driver_commission::text as "driverCommission",
             l.delivered_order_earnings::text as "deliveredOrderEarnings",
             l.collection_earnings::text as "collectionEarnings",
             l.variable_earnings_already_paid::text as "variableEarningsAlreadyPaid",
             l.salary_advance_recovery::text as "salaryAdvanceRecovery",
             l.earning_adjustments_total::text as "earningAdjustments",
             (l.deduction_adjustments_total+l.advances)::text as deductions,
             l.gross_earnings::text as "grossEarnings", l.net_salary::text as "netSalary",
             l.amount_paid::text as paid, l.outstanding_amount::text as outstanding,
             l.status, l.salary_hold_snapshot as "salaryHold",
             l.salary_hold_reason_snapshot as "salaryHoldReason",
             l.salary_hold_from_snapshot::text as "salaryHoldFrom",
             l.salary_hold_to_snapshot::text as "salaryHoldTo",
             l.calculated_at::text as "calculatedAt", l.approved_at::text as "approvedAt",
              l.reversed_at::text as "reversedAt", l.reversal_reason as "reversalReason",
              p.id as "periodId", p.period_reference as "periodReference",
              p.period_start::text as "periodStart", p.period_end::text as "periodEnd",
              (p.period_end-p.period_start+1)::integer as "periodDays",
              sv.basic_salary::text as "monthlyBasicSalary",
              greatest(
                p.period_start,
                coalesce(e.hired_on, sv.effective_from, p.period_start)
              )::text as "payableFrom",
              least(p.period_end, coalesce(e.ended_on, p.period_end))::text as "payableTo",
              greatest(
                0,
                least(p.period_end, coalesce(e.ended_on, p.period_end))
                  - greatest(
                      p.period_start,
                      coalesce(e.hired_on, sv.effective_from, p.period_start)
                    )
                  + 1
              )::integer as "payableDays",
              calculator.username as "calculatedBy", approver.username as "approvedBy",
             coalesce((select jsonb_agg(jsonb_build_object(
               'calculationId', link.commission_calculation_id,
               'amount', link.amount::text,
               'sourceMarker', link.source_marker
             ) order by link.created_at, link.id)
               from payroll_commission_links link
              where link.company_id=l.company_id and link.payroll_entry_id=l.id),'[]'::jsonb)
               as "driverCommissionSources",
             coalesce((
               select jsonb_agg(source order by source->'deliveredAt', source->'earningId')
               from (
                 -- Individual order earnings directly allocated to payroll line
                 select jsonb_build_object(
                   'earningId', eoe.id,
                   'orderId', eoe.order_id,
                   'orderNumber', eoe.order_number,
                   'deliveredAt', eoe.delivered_at,
                   'appliedAmount', eoe.applied_amount::text,
                   'ruleId', eoe.rule_id,
                   'allocatedAt', eoe.allocated_at,
                   'sourceType', 'direct'::text
                 ) as source
                 from employee_order_earnings eoe
                 where eoe.company_id=l.company_id and eoe.payroll_entry_id=l.id

                 union all

                 -- Delivery sources from locked earning periods allocated to payroll line
                 select jsonb_build_object(
                   'earningId', ds.employee_order_earning_id,
                   'orderId', eoe.order_id,
                   'orderNumber', o.order_number,
                   'deliveredAt', (eoe.delivered_at at time zone coalesce(cs.timezone, 'Asia/Dubai'))::date::text,
                   'appliedAmount', eoe.applied_amount::text,
                   'ruleId', eoe.rule_id,
                   'allocatedAt', eoe.allocated_at,
                   'sourceType', 'earning_period'::text,
                   'earningPeriodId', epa.period_id
                 ) as source
                 from employee_driver_earning_period_payroll_allocations epa
                 join employee_driver_earning_periods ep on ep.id=epa.period_id
                   and ep.company_id=epa.company_id
                 join employee_driver_earning_period_delivery_sources ds on ds.company_id=ep.company_id
                   and ds.period_id=ep.id
                 join employee_order_earnings eoe on eoe.id=ds.employee_order_earning_id
                   and eoe.company_id=ds.company_id
                 join orders o on o.id=eoe.order_id and o.company_id=eoe.company_id
                 left join company_settings cs on cs.company_id=eoe.company_id
                 where epa.payroll_entry_id=l.id and epa.company_id=l.company_id
                   and epa.reversed_at is null
               ) combined
             ),'[]'::jsonb)
               as "deliveredOrderEarningSources",
             coalesce((select jsonb_agg(jsonb_build_object(
               'code', a.allowance_code_snapshot, 'name', a.allowance_name_snapshot,
               'nameAr', a.allowance_name_ar_snapshot, 'amount', a.amount::text,
               'sourceEmployeeAllowanceId', a.source_employee_allowance_id
             ) order by a.allowance_code_snapshot)
               from payroll_line_allowances a
              where a.company_id=l.company_id and a.payroll_line_id=l.id),'[]'::jsonb)
               as allowances,
             coalesce((select jsonb_agg(to_jsonb(adj) order by adj.created_at)
               from payroll_adjustments adj
              where adj.company_id=l.company_id and adj.payroll_line_id=l.id),'[]'::jsonb)
               as adjustments,
             coalesce((select jsonb_agg(jsonb_build_object(
               'paymentId', pay.id, 'paymentNumber', pay.payment_number,
               'paymentDate', pay.payment_date, 'amount', alloc.allocated_amount::text,
               'status', pay.status, 'allocationReversedAt', alloc.reversed_at
             ) order by pay.payment_date, pay.id)
               from payroll_payment_allocations alloc
               join payroll_payments pay on pay.id=alloc.payroll_payment_id
                 and pay.company_id=alloc.company_id
              where alloc.company_id=l.company_id and alloc.payroll_line_id=l.id),'[]'::jsonb)
               as "paymentHistory"
         from payroll_entries l
         join payroll_periods p on p.id=l.payroll_period_id and p.company_id=l.company_id
         left join employees e on e.id=l.employee_id and e.company_id=l.company_id
         left join employee_salary_versions sv on sv.id=l.salary_version_id
           and sv.company_id=l.company_id and sv.employee_id=l.employee_id
         left join accounts calculator on calculator.id=l.calculated_by_account_id
          and calculator.company_id=l.company_id
        left join accounts approver on approver.id=l.approved_by_account_id
          and approver.company_id=l.company_id
       where l.id=${lineId}::uuid and l.company_id=${companyId}::uuid
    `.execute(this.database);
    return this.required(
      result.rows[0],
      "payroll_line_not_found",
      "The Payroll line was not found",
    );
  }

  public async exceptions(periodId: string): Promise<readonly Record<string, unknown>[]> {
    this.support.assertPermission("payroll.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select id, calculation_run_id as "calculationRunId", employee_id as "employeeId",
             employee_number_snapshot as "employeeNumber",
             employee_name_snapshot as "employeeName", exception_code as code,
             message, category, severity, status, created_at::text as "createdAt",
             resolved_at::text as "resolvedAt"
        from payroll_calculation_exceptions
       where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
       order by status, severity, created_at, id
    `.execute(this.database);
    return result.rows;
  }

  public async payments(
    query: PayrollPaymentListQueryDto,
  ): Promise<PayrollPage<Record<string, unknown>>> {
    this.support.assertPermission("payroll.view");
    const { companyId } = this.support.context();
    const page = this.support.pagination(query);
    const result = await sql<Record<string, unknown> & { total: number }>`
      select pay.id, pay.payment_number as "paymentNumber",
             p.id as "periodId", p.period_reference as "payrollPeriod",
             to_char(p.payroll_month,'YYYY-MM') as "payrollMonth",
             pay.payment_date::text as "paymentDate",
             count(distinct alloc.employee_id)::integer as "employeeCount",
             pay.total_amount::text as "totalAmount",
             pay.cash_voucher_reference as "voucherReference",
             pay.acknowledgement_type as "acknowledgementType",
             pay.status, payer.username as "paidBy",
             (pay.status='reversed') as reversed,
             count(*) over()::integer as total
        from payroll_payments pay
        join payroll_periods p on p.id=pay.payroll_period_id and p.company_id=pay.company_id
        left join payroll_payment_allocations alloc
          on alloc.payroll_payment_id=pay.id and alloc.company_id=pay.company_id
        left join accounts payer on payer.id=pay.paid_by_account_id and payer.company_id=pay.company_id
       where pay.company_id=${companyId}::uuid
         and (${query.paymentNumber ?? null}::text is null
           or pay.payment_number ilike '%' || ${query.paymentNumber ?? null} || '%')
         and (${query.payrollMonth ?? null}::text is null
           or p.payroll_month=${query.payrollMonth ? `${query.payrollMonth}-01` : null}::date)
         and (${query.paymentDateFrom ?? null}::date is null
           or pay.payment_date>=${query.paymentDateFrom ?? null}::date)
         and (${query.paymentDateTo ?? null}::date is null
           or pay.payment_date<=${query.paymentDateTo ?? null}::date)
         and (${query.employeeId ?? null}::uuid is null or exists(
           select 1 from payroll_payment_allocations a
            where a.company_id=pay.company_id and a.payroll_payment_id=pay.id
              and a.employee_id=${query.employeeId ?? null}::uuid
         ))
         and (${query.employee ?? null}::text is null or exists(
           select 1
             from payroll_payment_allocations a
             join payroll_entries l on l.id=a.payroll_line_id and l.company_id=a.company_id
            where a.company_id=pay.company_id and a.payroll_payment_id=pay.id
              and (
                l.employee_name_snapshot ilike '%' || ${query.employee ?? null} || '%'
                or l.employee_number_snapshot ilike '%' || ${query.employee ?? null} || '%'
              )
         ))
         and (${query.voucherReference ?? null}::text is null
           or pay.cash_voucher_reference ilike '%' || ${query.voucherReference ?? null} || '%')
         and (${query.status ?? null}::text is null or pay.status=${query.status ?? null})
         and (${query.paidBy ?? null}::uuid is null or pay.paid_by_account_id=${query.paidBy ?? null}::uuid)
       group by pay.id, p.id, payer.id
       order by pay.payment_date desc, pay.id desc
       limit ${page.limit} offset ${page.offset}
    `.execute(this.database);
    return this.page(result.rows, page.page, page.pageSize);
  }

  public async paymentDetail(paymentId: string): Promise<Record<string, unknown>> {
    this.support.assertPermission("payroll.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select pay.id, pay.company_id as "companyId", company.name_en as "companyName",
             pay.payment_number as "paymentNumber",
             pay.payroll_period_id as "periodId", p.period_reference as "payrollPeriod",
             pay.payment_date::text as "paymentDate", pay.total_amount::text as "totalAmount",
             pay.cash_voucher_reference as "cashVoucherReference",
             pay.external_reference as "externalReference",
             pay.acknowledgement_type as "acknowledgementType",
             pay.acknowledgement_value as "acknowledgementValue",
             pay.notes, pay.status, payer.username as "paidBy",
             pay.created_at::text as "createdAt", pay.reversed_at::text as "reversedAt",
             pay.reversal_reason as "reversalReason", reverser.username as "reversedBy",
             coalesce((select jsonb_agg(jsonb_build_object(
               'allocationId', a.id, 'employeeId', a.employee_id,
               'employee', l.employee_name_snapshot,
               'employeeNameAr', l.employee_name_ar_snapshot,
               'employeeNumber', l.employee_number_snapshot,
               'payrollLineReference', l.payroll_number,
               'netSalary', l.net_salary::text,
               'previouslyPaid', coalesce((
                 select sum(prior.allocated_amount)
                   from payroll_payment_allocations prior
                   join payroll_payments prior_pay
                     on prior_pay.id=prior.payroll_payment_id
                    and prior_pay.company_id=prior.company_id
                  where prior.company_id=a.company_id
                    and prior.payroll_line_id=a.payroll_line_id
                    and prior_pay.created_at < pay.created_at
                    and (prior.reversed_at is null or prior.reversed_at > pay.created_at)
               ),0)::text,
               'amountPaidNow', a.allocated_amount::text,
               'remainingOutstanding',
                 greatest(0, l.net_salary-coalesce((
                   select sum(prior.allocated_amount)
                     from payroll_payment_allocations prior
                     join payroll_payments prior_pay
                       on prior_pay.id=prior.payroll_payment_id
                      and prior_pay.company_id=prior.company_id
                    where prior.company_id=a.company_id
                      and prior.payroll_line_id=a.payroll_line_id
                      and prior_pay.created_at < pay.created_at
                      and (prior.reversed_at is null or prior.reversed_at > pay.created_at)
                 ),0)-a.allocated_amount)::text,
               'lineStatus', l.status, 'reversedAt', a.reversed_at
             ) order by a.allocation_order)
               from payroll_payment_allocations a
               join payroll_entries l on l.id=a.payroll_line_id and l.company_id=a.company_id
              where a.company_id=pay.company_id and a.payroll_payment_id=pay.id),'[]'::jsonb)
               as allocations,
             -- Summary values, aggregated in this one query rather than summed
             -- in the browser: Total Applied is what this Payment allocated,
             -- Unapplied is whatever it paid beyond that (clamped at zero,
             -- because over-allocation is prevented upstream and a negative
             -- would only ever be a rounding artefact), and the employee count
             -- is the number of allocations it carries.
             coalesce((select sum(a.allocated_amount) from payroll_payment_allocations a
                        where a.company_id=pay.company_id
                          and a.payroll_payment_id=pay.id),0)::text as "totalApplied",
             greatest(0, pay.total_amount - coalesce((
               select sum(a.allocated_amount) from payroll_payment_allocations a
                where a.company_id=pay.company_id and a.payroll_payment_id=pay.id
             ),0))::text as "unappliedAmount",
             coalesce((select count(*)::integer from payroll_payment_allocations a
                        where a.company_id=pay.company_id
                          and a.payroll_payment_id=pay.id),0) as "employeeCount",
             -- The whole Period's outstanding balance, so the screen can show
             -- what remains after this Payment without a second request.
             p.total_outstanding::text as "remainingPayrollOutstanding",
             -- Payroll DOES store a separate reversal Payment record, unlike
             -- Trader Collections, so this relationship is real.
             pay.reversal_of_payment_id as "reversalOfPaymentId",
             original.payment_number as "reversalOfPaymentNumber",
             reversing.id as "reversedByPaymentId",
             reversing.payment_number as "reversedByPaymentNumber"
        from payroll_payments pay
        join payroll_periods p on p.id=pay.payroll_period_id and p.company_id=pay.company_id
        join companies company on company.id=pay.company_id
        left join accounts payer on payer.id=pay.paid_by_account_id and payer.company_id=pay.company_id
        left join accounts reverser on reverser.id=pay.reversed_by_account_id
          and reverser.company_id=pay.company_id
        left join payroll_payments original
          on original.id=pay.reversal_of_payment_id and original.company_id=pay.company_id
        left join payroll_payments reversing
          on reversing.reversal_of_payment_id=pay.id and reversing.company_id=pay.company_id
       where pay.id=${paymentId}::uuid and pay.company_id=${companyId}::uuid
    `.execute(this.database);
    return this.required(
      result.rows[0],
      "payroll_payment_not_found",
      "The Payroll payment was not found",
    );
  }

  private page<T extends { total: number }>(
    rows: readonly T[],
    page: number,
    pageSize: number,
  ): PayrollPage<T> {
    return { items: rows, page, pageSize, total: rows[0]?.total ?? 0 };
  }

  private required<T>(value: T | undefined, code: string, message: string): T {
    if (value === undefined) throw new ApplicationException(code, message, HttpStatus.NOT_FOUND);
    return value;
  }
}
