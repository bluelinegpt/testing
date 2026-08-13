import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { payrollIdempotencyOperations } from "./payroll-foundation.constants.js";
import {
  assertPayrollPeriodStatus,
  assertPayrollPeriodTransition,
} from "./payroll-foundation.guards.js";
import { PayrollOperationSupport } from "./payroll-operation.support.js";
import { PayrollOperationalRepository } from "./payroll-operational.repository.js";

interface CalculationException {
  readonly category: string;
  readonly code: string;
  readonly employeeId: string | null;
  readonly employeeName: string | null;
  readonly employeeNumber: string | null;
  readonly message: string;
  readonly severity: "blocking" | "warning";
}

interface EmployeeCandidate {
  readonly deactivatedOn: string | null;
  readonly department: string | null;
  readonly employeeNumber: string | null;
  readonly employeeType: string | null;
  readonly endedOn: string | null;
  readonly hiredOn: string | null;
  readonly id: string;
  readonly isActive: boolean;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly payrollEligible: boolean;
  readonly salaryHold: boolean;
  readonly salaryHoldFrom: string | null;
  readonly salaryHoldReason: string | null;
  readonly salaryHoldTo: string | null;
}

export interface PayrollCalculationResult {
  readonly blockingExceptionCount: number;
  readonly calculatedEmployees: number;
  readonly consideredEmployees: number;
  readonly exceptions: readonly CalculationException[];
  readonly heldEmployees: number;
  readonly periodId: string;
  readonly skippedEmployees: number;
  readonly status: "calculated" | "draft";
  readonly totals: {
    readonly basicSalary: string;
    readonly deductions: string;
    readonly deliveredOrderEarnings: string;
    readonly driverCommission: string;
    readonly earningAdjustments: string;
    readonly grossEarnings: string;
    readonly netSalary: string;
    readonly totalAllowances: string;
  };
  readonly warningCount: number;
  readonly recalculationChanges?: {
    readonly employeesAdded: readonly string[];
    readonly employeesMovedToHeld: readonly string[];
    readonly employeesReleasedFromHold: readonly string[];
    readonly employeesRemoved: readonly string[];
    readonly newExceptions: readonly string[];
    readonly newTotals: PayrollCalculationResult["totals"];
    readonly previousTotals: PayrollCalculationResult["totals"];
    readonly resolvedExceptions: readonly string[];
  };
}

interface CalculationSnapshot {
  readonly exceptions: ReadonlySet<string>;
  readonly lines: ReadonlyMap<string, string>;
  readonly totals: PayrollCalculationResult["totals"];
}

@Injectable()
export class PayrollCalculationService {
  public constructor(
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(PayrollOperationSupport) private readonly support: PayrollOperationSupport,
    @Inject(PayrollOperationalRepository)
    private readonly repository: PayrollOperationalRepository,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
  ) {}

  public calculate(
    periodId: string,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<PayrollCalculationResult> {
    return this.run(periodId, false, idempotencyKey, correlationId);
  }

  public recalculate(
    periodId: string,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<PayrollCalculationResult> {
    return this.run(periodId, true, idempotencyKey, correlationId);
  }

  private async run(
    periodId: string,
    recalculation: boolean,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<PayrollCalculationResult> {
    this.support.assertPermission("payroll.manage");
    const { actorId, companyId } = this.support.context();
    const operation = recalculation
      ? payrollIdempotencyOperations.recalculation
      : payrollIdempotencyOperations.calculation;
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency<PayrollCalculationResult>(
        transaction,
        {
          companyId,
          idempotencyKey,
          operation,
          payload: { periodId, recalculation },
        },
      );
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      if (reservation.replayResourceId !== undefined) {
        return this.calculationResult(transaction, companyId, periodId);
      }
      const periodResult = await sql<{
        end: string;
        periodReference: string;
        start: string;
        status: string;
      }>`
        select period_start::text as start, period_end::text as "end",
               period_reference as "periodReference", status
          from payroll_periods
         where id=${periodId}::uuid and company_id=${companyId}::uuid
         for update
      `.execute(transaction);
      const period = periodResult.rows[0];
      if (period === undefined) {
        throw new ApplicationException(
          "payroll_period_not_found",
          "The Payroll period was not found",
          HttpStatus.NOT_FOUND,
        );
      }
      assertPayrollPeriodStatus(period.status);
      if (!["draft", "calculated"].includes(period.status)) {
        throw new ApplicationException(
          "payroll_recalculation_not_allowed",
          "Payroll can be calculated only before approval",
          HttpStatus.CONFLICT,
        );
      }

      const before = recalculation
        ? await this.calculationSnapshot(transaction, companyId, periodId)
        : undefined;
      const runId = randomUUID();
      await sql`
        update payroll_calculation_exceptions
           set status='resolved', resolved_at=now()
         where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
           and status='active'
      `.execute(transaction);

      // Release THIS period's Order-earning allocations before recomputing.
      //
      // Reachable only for a draft or calculated period -- the status guard
      // above already rejected everything else -- and scoped to this period, so
      // an earning paid in an approved period is never touched.
      //
      // Releasing first is what makes recalculation correct rather than merely
      // idempotent. An Employee who becomes ineligible, goes on Salary Hold, or
      // drops out of the period this run would otherwise leave earnings pinned
      // to a Payroll line that no longer exists, and those earnings would never
      // be payable again. Every still-eligible earning is re-allocated below in
      // the same transaction, so nothing escapes and no snapshot is deleted --
      // only the pointer moves.
      await sql`
        update employee_order_earnings
           set payroll_period_id=null, payroll_entry_id=null, allocated_at=null
         where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
      `.execute(transaction);
      // Collection facts are released on the same terms and for the same
      // reason: a fact still pointing at a deleted line would never be payable.
      await sql`
        update employee_driver_collection_facts
           set payroll_period_id=null, payroll_entry_id=null, allocated_at=null
         where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
      `.execute(transaction);
      // Recalculation also releases the additive early-payment links. The
      // payment/allocation history itself remains immutable; only its draft
      // Payroll destination is recomputed.
      await sql`
        update employee_variable_earning_payment_allocations a
           set payroll_entry_id=null
          from payroll_entries l
         where a.company_id=${companyId}::uuid and a.payroll_entry_id=l.id
           and l.company_id=a.company_id and l.payroll_period_id=${periodId}::uuid
      `.execute(transaction);
      await sql`update employee_driver_earning_period_payroll_allocations a
        set reversed_at=now() from payroll_entries l
        where a.company_id=${companyId}::uuid and a.payroll_entry_id=l.id
          and l.company_id=a.company_id and l.payroll_period_id=${periodId}::uuid
          and a.reversed_at is null`.execute(transaction);
      await sql`
        delete from employee_salary_advance_payroll_allocations a using payroll_entries l
         where a.company_id=${companyId}::uuid and a.payroll_entry_id=l.id
           and l.company_id=a.company_id and l.payroll_period_id=${periodId}::uuid
      `.execute(transaction);
      await this.refreshSalaryAdvanceBalances(transaction, companyId);

      const employees = await sql<EmployeeCandidate>`
        select id, employee_number as "employeeNumber", name_en as "nameEn",
               name_ar as "nameAr", employee_type as "employeeType", department,
               payroll_eligible as "payrollEligible", is_active as "isActive",
               hired_on::text as "hiredOn", ended_on::text as "endedOn",
               deactivated_at::date::text as "deactivatedOn",
               salary_hold as "salaryHold", salary_hold_reason as "salaryHoldReason",
               salary_hold_from::text as "salaryHoldFrom",
               salary_hold_to::text as "salaryHoldTo"
          from employees
         where company_id=${companyId}::uuid
         order by employee_number nulls last, id
      `.execute(transaction);

      const exceptions: CalculationException[] = [];
      const retainedEmployeeIds: string[] = [];
      let calculatedEmployees = 0;
      let heldEmployees = 0;
      for (const employee of employees.rows) {
        const exclusion = this.eligibilityException(employee, period.start, period.end);
        if (exclusion !== undefined) {
          exceptions.push(exclusion);
          continue;
        }
        if (
          employee.salaryHold &&
          (employee.salaryHoldFrom === null ||
            employee.salaryHoldReason?.trim().length === 0 ||
            (employee.salaryHoldTo !== null &&
              employee.salaryHoldFrom !== null &&
              employee.salaryHoldTo < employee.salaryHoldFrom))
        ) {
          exceptions.push(
            this.exception(
              employee,
              "payroll_salary_hold_invalid",
              "Salary Hold",
              "Salary Hold requires a reason, a start date, and a valid date range",
              "blocking",
            ),
          );
          continue;
        }
        if (this.holdApplies(employee, period.start, period.end)) {
          const activeAdjustments = await sql<{ total: number }>`
            select count(a.id)::integer as total
              from payroll_entries l
              join payroll_adjustments a
                on a.payroll_line_id=l.id and a.company_id=l.company_id
             where l.company_id=${companyId}::uuid
               and l.payroll_period_id=${periodId}::uuid
               and l.employee_id=${employee.id}::uuid and a.status='active'
          `.execute(transaction);
          if ((activeAdjustments.rows[0]?.total ?? 0) > 0) {
            retainedEmployeeIds.push(employee.id);
            exceptions.push(
              this.exception(
                employee,
                "payroll_held_line_has_adjustments",
                "Salary Hold",
                "Active adjustments must be reversed before placing this Payroll line on hold",
                "blocking",
              ),
            );
            continue;
          }
          await this.upsertHeldLine(
            transaction,
            companyId,
            periodId,
            period.periodReference,
            employee,
            actorId,
          );
          retainedEmployeeIds.push(employee.id);
          heldEmployees += 1;
          exceptions.push(
            this.exception(
              employee,
              "payroll_line_held",
              "Salary Hold",
              "Employee is included as a held, non-payable Payroll line",
              "warning",
            ),
          );
          await this.history.audit(transaction, {
            action: "payroll.line.held",
            actorId,
            after: {
              employeeId: employee.id,
              periodId,
              reason: employee.salaryHoldReason,
              status: "held",
            },
            companyId,
            correlationId,
            subjectId: employee.id,
            subjectType: "employee",
          });
          continue;
        }
        const existingLegacy = await sql<{ id: string }>`
          select id from payroll_entries
           where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
             and employee_id=${employee.id}::uuid and source_marker='legacy'
        `.execute(transaction);
        if (existingLegacy.rows[0] !== undefined) {
          retainedEmployeeIds.push(employee.id);
          calculatedEmployees += 1;
          exceptions.push(
            this.exception(
              employee,
              "payroll_legacy_line_preserved",
              "Legacy compatibility",
              "Existing legacy Payroll line was preserved without recalculation",
              "warning",
            ),
          );
          continue;
        }

        const salaryReferenceDate =
          employee.endedOn !== null && employee.endedOn < period.end
            ? employee.endedOn
            : period.end;
        const salary = await sql<{ amount: string; effectiveFrom: string; id: string }>`
          select id, basic_salary::text as amount,
                 effective_from::text as "effectiveFrom"
            from employee_salary_versions
           where company_id=${companyId}::uuid and employee_id=${employee.id}::uuid
             and effective_from<=${salaryReferenceDate}::date
             and coalesce(effective_to,'infinity'::date)>=${salaryReferenceDate}::date
           order by effective_from, id
        `.execute(transaction);
        if (salary.rows.length !== 1) {
          exceptions.push(
            this.exception(
              employee,
              salary.rows.length === 0
                ? "payroll_line_missing_salary"
                : "payroll_salary_history_ambiguous",
              "Salary",
              salary.rows.length === 0
                ? "No salary version is effective on the Payroll period end date"
                : "More than one salary version is effective on the Payroll period end date",
              "blocking",
            ),
          );
          continue;
        }

        const allowanceResult = await sql<{
          allowanceCode: string;
          allowanceName: string;
          allowanceNameAr: string | null;
          allowanceTypeId: string;
          amount: string;
          employeeAllowanceId: string;
        }>`
          select a.id as "employeeAllowanceId", a.allowance_type_id as "allowanceTypeId",
                 t.code as "allowanceCode", t.name as "allowanceName",
                 t.name_ar as "allowanceNameAr", a.amount::text as amount
            from employee_allowances a
            join allowance_types t on t.id=a.allowance_type_id and t.company_id=a.company_id
           where a.company_id=${companyId}::uuid and a.employee_id=${employee.id}::uuid
             and a.is_active and a.effective_from<=${salaryReferenceDate}::date
             and coalesce(a.effective_to,'infinity'::date)>=${salaryReferenceDate}::date
           order by t.code, a.id
        `.execute(transaction);
        const allowanceCodes = new Set(allowanceResult.rows.map((row) => row.allowanceTypeId));
        if (
          allowanceResult.rows.length > 4 ||
          allowanceCodes.size !== allowanceResult.rows.length
        ) {
          exceptions.push(
            this.exception(
              employee,
              allowanceResult.rows.length > 4
                ? "payroll_allowance_limit_exceeded"
                : "payroll_allowance_history_ambiguous",
              "Allowance",
              "Effective allowance history is overlapping or exceeds four allowances",
              "blocking",
            ),
          );
          continue;
        }

        const commission = await this.resolveCommission(
          transaction,
          companyId,
          employee,
          period.start,
          period.end,
          periodId,
        );
        if ("exception" in commission) {
          exceptions.push(commission.exception);
          continue;
        }
        const orderEarnings = await this.resolveDeliveredOrderEarnings(
          transaction,
          companyId,
          employee.id,
          period.start,
          period.end,
        );
        const collectionEarnings = await this.resolveCollectionEarnings(
          transaction,
          companyId,
          employee.id,
          period.start,
          period.end,
        );
        const earningPeriods = await this.resolveDriverEarningPeriods(
          transaction,
          companyId,
          employee.id,
          period.start,
          period.end,
        );
        const variableAlreadyPaid = await this.resolveVariableAlreadyPaid(
          transaction,
          companyId,
          orderEarnings.earningIds,
          collectionEarnings.factIds,
        ).then((amount) => amount.plus(earningPeriods.interimPaid));
        const salaryRow = salary.rows[0]!;
        const payableStart = this.latestDate(
          period.start,
          employee.hiredOn ?? salaryRow.effectiveFrom,
        );
        const payableEnd = this.earliestDate(period.end, employee.endedOn ?? period.end);
        const periodDays = this.calendarDaysInclusive(period.start, period.end);
        const payableDays = this.calendarDaysInclusive(payableStart, payableEnd);
        const proratedAllowances = allowanceResult.rows.map((row) => ({
          ...row,
          payableAmount: this.prorateMonthlyAmount(row.amount, payableDays, periodDays),
        }));
        const allowanceTotal = proratedAllowances.reduce(
          (sum, row) => sum.plus(row.payableAmount),
          new Decimal(0),
        );
        const basic = this.prorateMonthlyAmount(salaryRow.amount, payableDays, periodDays);
        // Deliberately NOT prorated. A per-delivery earning is owed for work
        // that happened on a specific day; scaling it by payable days would pay
        // a mid-month joiner less than the deliveries they actually made.
        // Collection earnings join delivery earnings in being deliberately NOT
        // prorated, for the same reason: the collections happened on real days.
        const gross = basic
          .plus(allowanceTotal)
          .plus(commission.amount)
          .plus(orderEarnings.amount)
          .plus(earningPeriods.delivery)
          .plus(collectionEarnings.amount)
          .plus(earningPeriods.collection);
        const salaryAdvanceRecovery = await this.salaryAdvanceAvailable(
          transaction,
          companyId,
          employee.id,
          period.end,
          gross.minus(variableAlreadyPaid),
        );
        const lineId = await this.upsertCalculatedLine(transaction, {
          actorId,
          allowanceTotal,
          basic,
          collectionEarnings: collectionEarnings.amount.plus(earningPeriods.collection),
          commission: commission.amount,
          companyId,
          deliveredOrderEarnings: orderEarnings.amount.plus(earningPeriods.delivery),
          employee,
          gross,
          salaryAdvanceRecovery,
          variableAlreadyPaid,
          periodId,
          periodReference: period.periodReference,
          salaryVersionId: salaryRow.id,
        });
        await sql`
          delete from payroll_line_allowances
           where company_id=${companyId}::uuid and payroll_line_id=${lineId}::uuid
        `.execute(transaction);
        for (const earningPeriod of earningPeriods.items) {
          const allocated = Decimal.max(
            new Decimal(earningPeriod.totalEarnings).minus(earningPeriod.interimPaid),
            0,
          );
          await sql`insert into employee_driver_earning_period_payroll_allocations(
            company_id,period_id,payroll_entry_id,allocated_amount)
            values(${companyId}::uuid,${earningPeriod.id}::uuid,${lineId}::uuid,
              ${allocated.toFixed(2)})`.execute(transaction);
        }
        for (const allowance of proratedAllowances) {
          await sql`
            insert into payroll_line_allowances (
              company_id, payroll_line_id, allowance_type_id, allowance_code_snapshot,
              allowance_name_snapshot, allowance_name_ar_snapshot, amount,
              source_employee_allowance_id
            ) values (
              ${companyId}::uuid, ${lineId}::uuid, ${allowance.allowanceTypeId}::uuid,
              ${allowance.allowanceCode}, ${allowance.allowanceName},
              ${allowance.allowanceNameAr}, ${allowance.payableAmount.toFixed(2)},
              ${allowance.employeeAllowanceId}::uuid
            )
          `.execute(transaction);
        }
        // Claim the snapshots for this line. The payroll_period_id is null
        // guard is not redundant with the release above: it is the last word on
        // "paid once" if this ever runs alongside another period.
        if (orderEarnings.earningIds.length > 0) {
          await sql`
            update employee_order_earnings
               set payroll_period_id=${periodId}::uuid,
                   payroll_entry_id=${lineId}::uuid,
                   allocated_at=now()
             where company_id=${companyId}::uuid
               and id = any(${orderEarnings.earningIds}::uuid[])
               and payroll_period_id is null
          `.execute(transaction);
        }
        /* Same paid-once mechanism for collection facts, and the `payroll_period_id
           is null` guard is the last word on it: a fact already claimed by another
           period cannot be re-claimed here, whatever the calculation order. Facts
           worth nothing are allocated too, so enabling a rule retrospectively
           cannot make an old collection resurface in a future payroll. */
        if (collectionEarnings.factIds.length > 0) {
          await sql`
            update employee_driver_collection_facts
               set payroll_period_id=${periodId}::uuid,
                   payroll_entry_id=${lineId}::uuid,
                   allocated_at=now()
             where company_id=${companyId}::uuid
               and id = any(${collectionEarnings.factIds}::uuid[])
               and payroll_period_id is null
          `.execute(transaction);
        }
        await sql`
          update employee_variable_earning_payment_allocations
             set payroll_entry_id=${lineId}::uuid
           where company_id=${companyId}::uuid and reversed_at is null
             and (
               employee_order_earning_id=any(${orderEarnings.earningIds}::uuid[])
               or employee_collection_fact_id=any(${collectionEarnings.factIds}::uuid[])
             )
        `.execute(transaction);
        await this.allocateSalaryAdvances(
          transaction,
          companyId,
          employee.id,
          lineId,
          period.end,
          salaryAdvanceRecovery,
        );
        await sql`
          delete from payroll_commission_links
           where company_id=${companyId}::uuid and payroll_entry_id=${lineId}::uuid
             and source_marker='new_payroll'
        `.execute(transaction);
        if (commission.calculationId !== null) {
          await sql`
            insert into payroll_commission_links (
              company_id, payroll_entry_id, commission_calculation_id, amount, source_marker
            ) values (
              ${companyId}::uuid, ${lineId}::uuid, ${commission.calculationId}::uuid,
              ${commission.amount.toFixed(2)}, 'new_payroll'
            )
          `.execute(transaction);
        }
        await this.repository.recalculateLine(transaction, companyId, lineId);
        retainedEmployeeIds.push(employee.id);
        calculatedEmployees += 1;
        await this.history.audit(transaction, {
          action: "payroll.line.calculated",
          actorId,
          after: {
            employeeId: employee.id,
            netSalary: gross.toFixed(2),
            periodId,
            status: "calculated",
          },
          companyId,
          correlationId,
          subjectId: lineId,
          subjectType: "payroll_line",
        });
      }

      await this.removeStaleUnapprovedLines(
        transaction,
        companyId,
        periodId,
        retainedEmployeeIds,
        exceptions,
      );
      for (const exception of exceptions) {
        await sql`
          insert into payroll_calculation_exceptions (
            company_id, payroll_period_id, calculation_run_id, employee_id,
            employee_number_snapshot, employee_name_snapshot, exception_code,
            message, category, severity
          ) values (
            ${companyId}::uuid, ${periodId}::uuid, ${runId}::uuid,
            ${exception.employeeId}::uuid, ${exception.employeeNumber},
            ${exception.employeeName}, ${exception.code}, ${exception.message},
            ${exception.category}, ${exception.severity}
          )
        `.execute(transaction);
      }
      await this.repository.recalculatePeriodTotals(transaction, companyId, periodId);
      const blocking = exceptions.filter((item) => item.severity === "blocking").length;
      const status = blocking === 0 ? "calculated" : "draft";
      assertPayrollPeriodTransition(period.status, status);
      await sql`
        update payroll_entries
           set status=case when status='held' then 'held' else ${status} end,
               calculated_by_account_id=${actorId}::uuid, calculated_at=now(),
               updated_at=now(), version=version+1
         where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
           and status in ('draft','calculated','held')
      `.execute(transaction);
      await sql`
        update payroll_periods
           set status=${status}, calculation_date=current_date,
               calculated_by_account_id=${actorId}::uuid, calculated_at=now(),
               updated_at=now(), version=version+1
         where id=${periodId}::uuid and company_id=${companyId}::uuid
      `.execute(transaction);
      const afterSnapshot = recalculation
        ? await this.calculationSnapshot(transaction, companyId, periodId)
        : undefined;
      const recalculationChanges =
        before !== undefined && afterSnapshot !== undefined
          ? this.recalculationChanges(before, afterSnapshot)
          : undefined;
      await this.history.audit(transaction, {
        action: recalculation ? "payroll.period.recalculated" : "payroll.period.calculated",
        actorId,
        after: {
          blockingExceptions: blocking,
          calculatedEmployees,
          fromStatus: period.status,
          heldEmployees,
          status,
          warningCount: exceptions.filter((item) => item.severity === "warning").length,
          ...(recalculationChanges === undefined ? {} : { recalculationChanges }),
        },
        companyId,
        correlationId,
        subjectId: periodId,
        subjectType: "payroll_period",
      });
      const result = await this.calculationResult(transaction, companyId, periodId);
      const response =
        recalculationChanges === undefined
          ? result
          : {
              ...result,
              recalculationChanges,
            };
      await this.support.completeIdempotency(transaction, {
        companyId,
        idempotencyKey: idempotencyKey!,
        operation,
        resourceId: periodId,
        resourceType: "payroll_period",
        responseBody: response,
      });
      return response;
    });
  }

  private eligibilityException(
    employee: EmployeeCandidate,
    periodStart: string,
    periodEnd: string,
  ): CalculationException | undefined {
    if (!employee.payrollEligible) {
      return this.exception(
        employee,
        "payroll_employee_not_enabled",
        "Eligibility",
        "Employee Payroll is not enabled",
        "warning",
      );
    }
    if (
      (employee.hiredOn !== null && employee.hiredOn > periodEnd) ||
      (employee.endedOn !== null && employee.endedOn < periodStart)
    ) {
      return this.exception(
        employee,
        "payroll_employee_date_excluded",
        "Eligibility",
        "Employee employment dates do not overlap this Payroll period",
        "warning",
      );
    }
    if (
      !employee.isActive &&
      (employee.deactivatedOn === null || employee.deactivatedOn < periodStart)
    ) {
      return this.exception(
        employee,
        "payroll_employee_inactive",
        "Eligibility",
        "Employee was inactive before the Payroll period began",
        "warning",
      );
    }
    return undefined;
  }

  private holdApplies(employee: EmployeeCandidate, start: string, end: string): boolean {
    return (
      employee.salaryHold &&
      employee.salaryHoldFrom !== null &&
      employee.salaryHoldFrom <= end &&
      (employee.salaryHoldTo === null || employee.salaryHoldTo >= start)
    );
  }

  private async upsertHeldLine(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    periodId: string,
    periodReference: string,
    employee: EmployeeCandidate,
    actorId: string,
  ): Promise<void> {
    const line = await sql<{ id: string }>`
      insert into payroll_entries (
        company_id, payroll_number, payroll_period_id, employee_id,
        employee_number_snapshot, employee_name_snapshot, employee_name_ar_snapshot,
        employment_type_snapshot, department_snapshot, basic_salary_snapshot,
        employee_driver_commission, delivered_order_earnings, allowance_total,
        earning_adjustments_total,
        deduction_adjustments_total, advances, gross_earnings, net_salary,
        amount_paid, outstanding_amount, salary_hold_snapshot,
        salary_hold_reason_snapshot, salary_hold_from_snapshot, salary_hold_to_snapshot,
        status, source_marker, created_by_account_id, calculated_by_account_id, calculated_at
      ) values (
        ${companyId}::uuid, ${this.lineReference(periodReference, employee)},
        ${periodId}::uuid, ${employee.id}::uuid, ${employee.employeeNumber ?? "UNASSIGNED"},
        ${employee.nameEn}, ${employee.nameAr}, ${employee.employeeType},
        ${employee.department}, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, true,
        ${employee.salaryHoldReason}, ${employee.salaryHoldFrom}::date,
        ${employee.salaryHoldTo}::date, 'held', 'new_payroll',
        ${actorId}::uuid, ${actorId}::uuid, now()
      )
      on conflict (company_id, payroll_period_id, employee_id) do update set
        employee_number_snapshot=excluded.employee_number_snapshot,
        employee_name_snapshot=excluded.employee_name_snapshot,
        employee_name_ar_snapshot=excluded.employee_name_ar_snapshot,
        employment_type_snapshot=excluded.employment_type_snapshot,
        department_snapshot=excluded.department_snapshot, salary_version_id=null,
        basic_salary_snapshot=0, allowance_total=0, employee_driver_commission=0,
        delivered_order_earnings=0,
        earning_adjustments_total=0, deduction_adjustments_total=0, advances=0,
        variable_earnings_already_paid=0,salary_advance_recovery=0,
        gross_earnings=0, net_salary=0, amount_paid=0, outstanding_amount=0,
        salary_hold_snapshot=true,
        salary_hold_reason_snapshot=excluded.salary_hold_reason_snapshot,
        salary_hold_from_snapshot=excluded.salary_hold_from_snapshot,
        salary_hold_to_snapshot=excluded.salary_hold_to_snapshot,
        status='held', calculated_by_account_id=excluded.calculated_by_account_id,
        calculated_at=now(), updated_at=now(), version=payroll_entries.version+1
      where payroll_entries.source_marker='new_payroll'
        and payroll_entries.approved_at is null
      returning id
    `.execute(database);
    const lineId = line.rows[0]?.id;
    if (lineId === undefined) {
      throw new ApplicationException(
        "payroll_legacy_line_immutable",
        "A legacy Payroll line already exists for this Employee and period",
        HttpStatus.CONFLICT,
      );
    }
    await sql`delete from payroll_line_allowances
      where company_id=${companyId}::uuid and payroll_line_id=${lineId}::uuid`.execute(database);
    await sql`delete from payroll_commission_links
      where company_id=${companyId}::uuid and payroll_entry_id=${lineId}::uuid
        and source_marker='new_payroll'`.execute(database);
  }

  private async upsertCalculatedLine(
    database: Kysely<DatabaseSchema>,
    input: {
      actorId: string;
      allowanceTotal: Decimal;
      basic: Decimal;
      collectionEarnings: Decimal;
      commission: Decimal;
      companyId: string;
      deliveredOrderEarnings: Decimal;
      employee: EmployeeCandidate;
      gross: Decimal;
      salaryAdvanceRecovery: Decimal;
      variableAlreadyPaid: Decimal;
      periodId: string;
      periodReference: string;
      salaryVersionId: string;
    },
  ): Promise<string> {
    const result = await sql<{ id: string }>`
      insert into payroll_entries (
        company_id, payroll_number, payroll_period_id, employee_id,
        employee_number_snapshot, employee_name_snapshot, employee_name_ar_snapshot,
        employment_type_snapshot, department_snapshot, salary_version_id,
        basic_salary_snapshot, employee_driver_commission, delivered_order_earnings,
        collection_earnings, allowance_total,
        earning_adjustments_total, deduction_adjustments_total, advances,
        variable_earnings_already_paid, salary_advance_recovery,
        gross_earnings, net_salary, amount_paid, outstanding_amount,
        salary_hold_snapshot, status, source_marker, created_by_account_id,
        calculated_by_account_id, calculated_at
      ) values (
        ${input.companyId}::uuid, ${this.lineReference(input.periodReference, input.employee)},
        ${input.periodId}::uuid, ${input.employee.id}::uuid,
        ${input.employee.employeeNumber ?? "UNASSIGNED"}, ${input.employee.nameEn},
        ${input.employee.nameAr}, ${input.employee.employeeType}, ${input.employee.department},
        ${input.salaryVersionId}::uuid, ${input.basic.toFixed(2)},
        ${input.commission.toFixed(2)}, ${input.deliveredOrderEarnings.toFixed(2)},
        ${input.collectionEarnings.toFixed(2)},
        ${input.allowanceTotal.toFixed(2)}, 0, 0, 0,
        ${input.variableAlreadyPaid.toFixed(2)},${input.salaryAdvanceRecovery.toFixed(2)},
        ${input.gross.toFixed(2)},
        ${input.gross.minus(input.variableAlreadyPaid).minus(input.salaryAdvanceRecovery).toFixed(2)}, 0,
        ${input.gross.minus(input.variableAlreadyPaid).minus(input.salaryAdvanceRecovery).toFixed(2)},
        false, 'calculated', 'new_payroll',
        ${input.actorId}::uuid, ${input.actorId}::uuid, now()
      )
      on conflict (company_id, payroll_period_id, employee_id) do update set
        employee_number_snapshot=excluded.employee_number_snapshot,
        employee_name_snapshot=excluded.employee_name_snapshot,
        employee_name_ar_snapshot=excluded.employee_name_ar_snapshot,
        employment_type_snapshot=excluded.employment_type_snapshot,
        department_snapshot=excluded.department_snapshot,
        salary_version_id=excluded.salary_version_id,
        basic_salary_snapshot=excluded.basic_salary_snapshot,
        employee_driver_commission=excluded.employee_driver_commission,
        delivered_order_earnings=excluded.delivered_order_earnings,
        collection_earnings=excluded.collection_earnings,
        allowance_total=excluded.allowance_total,
        earning_adjustments_total=payroll_entries.earning_adjustments_total,
        deduction_adjustments_total=payroll_entries.deduction_adjustments_total,
        variable_earnings_already_paid=excluded.variable_earnings_already_paid,
        salary_advance_recovery=excluded.salary_advance_recovery,
        gross_earnings=excluded.gross_earnings+payroll_entries.earning_adjustments_total,
        net_salary=excluded.gross_earnings+payroll_entries.earning_adjustments_total
          -payroll_entries.deduction_adjustments_total-payroll_entries.advances
          -excluded.variable_earnings_already_paid-excluded.salary_advance_recovery,
        outstanding_amount=excluded.gross_earnings+payroll_entries.earning_adjustments_total
          -payroll_entries.deduction_adjustments_total-payroll_entries.advances
          -excluded.variable_earnings_already_paid-excluded.salary_advance_recovery
          -payroll_entries.amount_paid,
        salary_hold_snapshot=false, salary_hold_reason_snapshot=null,
        salary_hold_from_snapshot=null, salary_hold_to_snapshot=null,
        status='calculated', calculated_by_account_id=excluded.calculated_by_account_id,
        calculated_at=now(), updated_at=now(), version=payroll_entries.version+1
      where payroll_entries.source_marker='new_payroll'
        and payroll_entries.approved_at is null
      returning id
    `.execute(database);
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new ApplicationException(
        "payroll_legacy_line_immutable",
        "A legacy Payroll line already exists for this Employee and period",
        HttpStatus.CONFLICT,
      );
    }
    return id;
  }

  /**
   * Unpaid per-delivered-Order earnings for one Employee in one Payroll period.
   *
   * Reads only immutable `employee_order_earnings` snapshots written at delivery
   * time. It never re-derives an amount from current Orders or current rule
   * rates: raising a rate in March must not restate February, and an Order
   * returned after delivery must not erase work that was actually done.
   *
   * Two filters, both required and neither redundant:
   *
   *   - `earning_month` -- the Company-LOCAL calendar month of the delivery,
   *     resolved when the snapshot was written. This is the authoritative month.
   *   - the period boundaries -- narrows a partial-month period to the days it
   *     actually covers.
   *
   * Both are evaluated in the Company timezone. Comparing a timestamptz against
   * a date without saying which zone would silently use the SERVER's, and a
   * delivery at 02:00 Dubai on the 1st would land in the previous month.
   *
   * `payroll_period_id is null` is what makes this "unpaid": earnings already
   * allocated to another period are invisible here, and this period's own
   * allocations were released at the start of the run so they are picked up
   * again. `for update of e` holds them until the transaction ends.
   */
  /**
   * Price this Employee's collection facts for the period.
   *
   * The counterpart to `resolveDeliveredOrderEarnings`, and deliberately shaped
   * differently. A delivery earning is already money by the time Payroll sees
   * it -- the rate was frozen into the snapshot at delivery. A collection fact
   * is not: it records only what happened, so the rate is resolved HERE, per
   * fact, against the fact's own `business_date`.
   *
   * Resolving per fact rather than once per period is what makes a mid-month
   * rate change come out right: two facts in the same payroll month can legally
   * carry different rates, and the half-open `[)` rule window decides which.
   *
   * `for update` on the facts is what makes the later allocation safe against a
   * concurrent calculation of an adjacent period.
   */
  private async resolveVariableAlreadyPaid(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    deliveryIds: readonly string[],
    collectionIds: readonly string[],
  ): Promise<Decimal> {
    const result = await sql<{ amount: string }>`
      select coalesce(sum(a.allocated_amount),0)::text as amount
        from employee_variable_earning_payment_allocations a
        join employee_variable_earning_payments p
          on p.id=a.payment_id and p.company_id=a.company_id
       where a.company_id=${companyId}::uuid and a.reversed_at is null
         and p.status='confirmed'
         and (a.employee_order_earning_id=any(${deliveryIds}::uuid[])
           or a.employee_collection_fact_id=any(${collectionIds}::uuid[]))
    `.execute(database);
    return new Decimal(result.rows[0]?.amount ?? 0);
  }

  private async salaryAdvanceAvailable(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    employeeId: string,
    periodEnd: string,
    maximum: Decimal,
  ): Promise<Decimal> {
    const result = await sql<{ amount: string }>`
      select coalesce(sum(outstanding_amount),0)::text as amount
        from employee_salary_advances
       where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid
         and status in('confirmed','partially_recovered') and payment_date<=${periodEnd}::date
    `.execute(database);
    return Decimal.min(new Decimal(result.rows[0]?.amount ?? 0), Decimal.max(maximum, 0));
  }

  private async allocateSalaryAdvances(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    employeeId: string,
    lineId: string,
    periodEnd: string,
    amount: Decimal,
  ): Promise<void> {
    if (amount.isZero()) return;
    const advances = await sql<{ id: string; outstanding: string }>`
      select id,outstanding_amount::text as outstanding from employee_salary_advances
       where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid
         and status in('confirmed','partially_recovered') and payment_date<=${periodEnd}::date
       order by payment_date,created_at,id for update
    `.execute(database);
    let remaining = amount;
    let order = 1;
    for (const advance of advances.rows) {
      if (remaining.isZero()) break;
      const allocated = Decimal.min(remaining, advance.outstanding);
      await sql`insert into employee_salary_advance_payroll_allocations(
        company_id,advance_id,payroll_entry_id,allocated_amount,allocation_order)
        values(${companyId}::uuid,${advance.id}::uuid,${lineId}::uuid,
          ${allocated.toFixed(2)},${order})`.execute(database);
      await sql`update employee_salary_advances
        set recovered_amount=recovered_amount+${allocated.toFixed(2)},
            outstanding_amount=outstanding_amount-${allocated.toFixed(2)},
            status=case when outstanding_amount-${allocated.toFixed(2)}=0
              then 'recovered' else 'partially_recovered' end,
            updated_at=now(),version=version+1
        where id=${advance.id}::uuid and company_id=${companyId}::uuid`.execute(database);
      remaining = remaining.minus(allocated);
      order += 1;
    }
  }

  private async refreshSalaryAdvanceBalances(
    database: Kysely<DatabaseSchema>,
    companyId: string,
  ): Promise<void> {
    await sql`update employee_salary_advances a set
      recovered_amount=coalesce((select sum(p.allocated_amount)
        from employee_salary_advance_payroll_allocations p
        where p.company_id=a.company_id and p.advance_id=a.id and p.reversed_at is null),0),
      outstanding_amount=a.amount_paid-coalesce((select sum(p.allocated_amount)
        from employee_salary_advance_payroll_allocations p
        where p.company_id=a.company_id and p.advance_id=a.id and p.reversed_at is null),0),
      status=case when coalesce((select sum(p.allocated_amount)
        from employee_salary_advance_payroll_allocations p
        where p.company_id=a.company_id and p.advance_id=a.id and p.reversed_at is null),0)=0 then 'confirmed'
        when coalesce((select sum(p.allocated_amount)
          from employee_salary_advance_payroll_allocations p
          where p.company_id=a.company_id and p.advance_id=a.id and p.reversed_at is null),0)=a.amount_paid
          then 'recovered' else 'partially_recovered' end,
      updated_at=now(),version=a.version+1
      where a.company_id=${companyId}::uuid and a.status<>'reversed'`.execute(database);
  }

  private async resolveCollectionEarnings(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    employeeId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<{ amount: Decimal; collectedOrders: number; collections: number; factIds: string[] }> {
    const result = await sql<{
      collectedOrderCount: number;
      id: string;
      paymentType: string | null;
      rate: string | null;
    }>`
      select f.id, f.collected_order_count as "collectedOrderCount",
             r.collection_payment_type as "paymentType",
             r.amount::text as rate
        from employee_driver_collection_facts f
        -- The rule in force on the collection's own Business Date. A left join
        -- because an unenrolled Employee is an ordinary case, not an error:
        -- the fact still exists and is simply worth nothing.
        left join employee_collection_earning_rules r
          on r.company_id = f.company_id
         and r.employee_id = f.employee_id
         and r.is_active
         and r.effective_from <= f.business_date
         and (r.effective_to is null or f.business_date < r.effective_to)
       where f.company_id=${companyId}::uuid and f.employee_id=${employeeId}::uuid
         and f.counts_for_collection_earning
         and f.payroll_period_id is null
         and f.business_date between ${periodStart}::date and ${periodEnd}::date
         and not exists(select 1 from employee_driver_earning_periods p
           where p.company_id=f.company_id and p.employee_id=f.employee_id and p.status<>'reversed'
             and f.business_date between p.date_from and p.date_to)
       order by f.business_date, f.id
         for update of f
    `.execute(database);

    let amount = new Decimal(0);
    let collectedOrders = 0;
    let collections = 0;
    for (const row of result.rows) {
      collectedOrders += Number(row.collectedOrderCount);
      collections += 1;
      // No rule, or an explicit `none`, is worth nothing -- but the fact is
      // still allocated below, so it cannot resurface in a later period after
      // someone enables a rule retrospectively.
      if (row.paymentType === "per_collected_order") {
        amount = amount.plus(new Decimal(row.rate ?? 0).times(row.collectedOrderCount));
      } else if (row.paymentType === "flat_per_confirmed_collection") {
        // Legacy read compatibility only: new flat rules are rejected by both
        // Employee and outsourced collection rule write DTOs/services.
        amount = amount.plus(new Decimal(row.rate ?? 0));
      }
    }
    return { amount, collectedOrders, collections, factIds: result.rows.map((row) => row.id) };
  }

  private async resolveDeliveredOrderEarnings(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    employeeId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<{ amount: Decimal; earningIds: string[] }> {
    const result = await sql<{ amount: string; id: string }>`
      select e.id, e.applied_amount::text as amount
        from employee_order_earnings e
        left join company_settings cs on cs.company_id = e.company_id
       where e.company_id=${companyId}::uuid and e.employee_id=${employeeId}::uuid
         and e.payroll_period_id is null
         and e.earning_month = date_trunc('month', ${periodStart}::date)::date
         and (e.delivered_at at time zone coalesce(cs.timezone, 'Asia/Dubai'))::date
               between ${periodStart}::date and ${periodEnd}::date
         and not exists(select 1 from employee_driver_earning_period_delivery_sources s
           where s.company_id=e.company_id and s.employee_order_earning_id=e.id)
       order by e.delivered_at, e.id
         for update of e
    `.execute(database);
    return {
      amount: result.rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)),
      earningIds: result.rows.map((row) => row.id),
    };
  }

  private async resolveDriverEarningPeriods(
    database: Kysely<DatabaseSchema>, companyId: string, employeeId: string,
    periodStart: string, periodEnd: string,
  ) {
    const result = await sql<{ collection: string; delivery: string; id: string; interimPaid: string; totalEarnings: string }>`
      select p.id,p.delivery_earnings::text as delivery,p.collection_earnings::text as collection,
        p.total_earnings::text as "totalEarnings",coalesce(i.paid,0)::text as "interimPaid"
      from employee_driver_earning_periods p
      left join lateral(select sum(a.allocated_amount) as paid
        from employee_driver_earning_period_payment_allocations a
        join employee_variable_earning_payments ep on ep.id=a.payment_id and ep.company_id=a.company_id
        where a.company_id=p.company_id and a.period_id=p.id and a.reversed_at is null
          and ep.status='confirmed') i on true
      where p.company_id=${companyId}::uuid and p.employee_id=${employeeId}::uuid and p.status<>'reversed'
        and p.date_from>=${periodStart}::date and p.date_to<=${periodEnd}::date
        and not exists(select 1 from employee_driver_earning_period_payroll_allocations pa
          join payroll_entries pe on pe.id=pa.payroll_entry_id and pe.company_id=pa.company_id
          where pa.company_id=p.company_id and pa.period_id=p.id and pa.reversed_at is null
            and pe.approved_at is not null)
      order by p.date_from,p.id for update of p`.execute(database);
    return {
      collection: result.rows.reduce((sum,row)=>sum.plus(row.collection),new Decimal(0)),
      delivery: result.rows.reduce((sum,row)=>sum.plus(row.delivery),new Decimal(0)),
      interimPaid: result.rows.reduce((sum,row)=>sum.plus(row.interimPaid),new Decimal(0)),
      items: result.rows,
    };
  }

  private async resolveCommission(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    employee: EmployeeCandidate,
    start: string,
    end: string,
    periodId: string,
  ): Promise<
    { amount: Decimal; calculationId: string | null } | { exception: CalculationException }
  > {
    const result = await sql<{
      amount: string;
      calculationId: string;
      linkedPeriodId: string | null;
    }>`
      select c.id as "calculationId", c.net_payable::text as amount,
             linked.payroll_period_id as "linkedPeriodId"
        from drivers d
        join driver_commission_calculations c
          on c.driver_id=d.id and c.company_id=d.company_id
        left join payroll_commission_links l
          on l.commission_calculation_id=c.id and l.company_id=c.company_id
        left join payroll_entries linked
          on linked.id=l.payroll_entry_id and linked.company_id=l.company_id
       where d.company_id=${companyId}::uuid and d.employee_id=${employee.id}::uuid
         and d.driver_type='employee'
         and c.status in ('accrued','payable')
         and c.period_start>=${start}::date and c.period_end<=${end}::date
       order by c.period_start, c.id
    `.execute(database);
    const candidates = result.rows.filter(
      (row) => row.linkedPeriodId === null || row.linkedPeriodId === periodId,
    );
    if (candidates.length === 0) return { amount: new Decimal(0), calculationId: null };
    if (
      candidates.length > 1 ||
      result.rows.some((row) => row.linkedPeriodId !== null && row.linkedPeriodId !== periodId)
    ) {
      return {
        exception: this.exception(
          employee,
          "payroll_commission_conflict",
          "Driver commission",
          "Employee Driver commission calculations or Payroll links conflict",
          "blocking",
        ),
      };
    }
    return {
      amount: new Decimal(candidates[0]!.amount),
      calculationId: candidates[0]!.calculationId,
    };
  }

  private async removeStaleUnapprovedLines(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    periodId: string,
    retainedEmployeeIds: readonly string[],
    exceptions: CalculationException[],
  ): Promise<void> {
    await sql`select id from payroll_entries
      where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
        and source_marker='new_payroll' and approved_at is null
      for update`.execute(database);
    const stale = await sql<{
      employeeId: string;
      employeeName: string;
      employeeNumber: string;
      id: string;
      adjustmentCount: number;
    }>`
      select l.id, l.employee_id as "employeeId",
             l.employee_name_snapshot as "employeeName",
             l.employee_number_snapshot as "employeeNumber",
             count(a.id) filter (where a.status='active')::integer as "adjustmentCount"
        from payroll_entries l
        left join payroll_adjustments a
          on a.payroll_line_id=l.id and a.company_id=l.company_id
       where l.company_id=${companyId}::uuid and l.payroll_period_id=${periodId}::uuid
         and l.source_marker='new_payroll' and l.approved_at is null
         and not (l.employee_id = any(${retainedEmployeeIds}::uuid[]))
       group by l.id
    `.execute(database);
    for (const line of stale.rows) {
      if (line.adjustmentCount > 0) {
        exceptions.push({
          category: "Adjustment",
          code: "payroll_stale_line_has_adjustments",
          employeeId: line.employeeId,
          employeeName: line.employeeName,
          employeeNumber: line.employeeNumber,
          message: "An excluded Employee has active Payroll adjustments",
          severity: "blocking",
        });
        continue;
      }
      await sql`delete from payroll_line_allowances
        where company_id=${companyId}::uuid and payroll_line_id=${line.id}::uuid`.execute(database);
      await sql`delete from payroll_commission_links
        where company_id=${companyId}::uuid and payroll_entry_id=${line.id}::uuid
          and source_marker='new_payroll'`.execute(database);
      await sql`delete from payroll_entries
        where company_id=${companyId}::uuid and id=${line.id}::uuid`.execute(database);
    }
  }

  private exception(
    employee: EmployeeCandidate,
    code: string,
    category: string,
    message: string,
    severity: "blocking" | "warning",
  ): CalculationException {
    return {
      category,
      code,
      employeeId: employee.id,
      employeeName: employee.nameEn,
      employeeNumber: employee.employeeNumber,
      message,
      severity,
    };
  }

  private lineReference(periodReference: string, employee: EmployeeCandidate): string {
    const employeePart = (employee.employeeNumber ?? employee.id.slice(0, 8))
      .replaceAll(/[^A-Za-z0-9-]/g, "")
      .toUpperCase();
    return `${periodReference}-${employeePart}`;
  }

  private calendarDaysInclusive(start: string, end: string): number {
    const startTime = Date.parse(`${start}T00:00:00.000Z`);
    const endTime = Date.parse(`${end}T00:00:00.000Z`);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
      return 0;
    }
    return Math.floor((endTime - startTime) / 86_400_000) + 1;
  }

  private latestDate(first: string, second: string): string {
    return first >= second ? first : second;
  }

  private earliestDate(first: string, second: string): string {
    return first <= second ? first : second;
  }

  private prorateMonthlyAmount(
    monthlyAmount: string,
    payableDays: number,
    periodDays: number,
  ): Decimal {
    if (payableDays <= 0 || periodDays <= 0) return new Decimal(0);
    return new Decimal(monthlyAmount)
      .times(payableDays)
      .dividedBy(periodDays)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  private async calculationSnapshot(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    periodId: string,
  ): Promise<CalculationSnapshot> {
    const totals = await sql<PayrollCalculationResult["totals"]>`
      select total_basic_salary::text as "basicSalary",
             total_allowances::text as "totalAllowances",
             total_employee_driver_commission::text as "driverCommission",
             total_delivered_order_earnings::text as "deliveredOrderEarnings",
             total_earning_adjustments::text as "earningAdjustments",
             total_deductions::text as deductions,
             (total_basic_salary+total_allowances+total_employee_driver_commission
               +total_delivered_order_earnings+total_earning_adjustments)::text
               as "grossEarnings",
             total_net_salary::text as "netSalary"
        from payroll_periods
       where id=${periodId}::uuid and company_id=${companyId}::uuid
    `.execute(database);
    const lines = await sql<{ employeeId: string; status: string }>`
      select employee_id as "employeeId", status
        from payroll_entries
       where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
         and status<>'reversed'
    `.execute(database);
    const exceptions = await sql<{ key: string }>`
      select coalesce(employee_id::text, '') || ':' || exception_code as key
        from payroll_calculation_exceptions
       where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
         and status='active'
    `.execute(database);
    const emptyTotals: PayrollCalculationResult["totals"] = {
      basicSalary: "0.00",
      deductions: "0.00",
      deliveredOrderEarnings: "0.00",
      driverCommission: "0.00",
      earningAdjustments: "0.00",
      grossEarnings: "0.00",
      netSalary: "0.00",
      totalAllowances: "0.00",
    };
    return {
      exceptions: new Set(exceptions.rows.map((row) => row.key)),
      lines: new Map(lines.rows.map((row) => [row.employeeId, row.status])),
      totals: totals.rows[0] ?? emptyTotals,
    };
  }

  private recalculationChanges(
    before: CalculationSnapshot,
    after: CalculationSnapshot,
  ): NonNullable<PayrollCalculationResult["recalculationChanges"]> {
    const beforeEmployees = new Set(before.lines.keys());
    const afterEmployees = new Set(after.lines.keys());
    return {
      employeesAdded: [...afterEmployees].filter((id) => !beforeEmployees.has(id)),
      employeesMovedToHeld: [...after.lines]
        .filter(([id, status]) => status === "held" && before.lines.get(id) !== "held")
        .map(([id]) => id),
      employeesReleasedFromHold: [...after.lines]
        .filter(([id, status]) => status !== "held" && before.lines.get(id) === "held")
        .map(([id]) => id),
      employeesRemoved: [...beforeEmployees].filter((id) => !afterEmployees.has(id)),
      newExceptions: [...after.exceptions].filter((key) => !before.exceptions.has(key)),
      newTotals: after.totals,
      previousTotals: before.totals,
      resolvedExceptions: [...before.exceptions].filter((key) => !after.exceptions.has(key)),
    };
  }

  private async calculationResult(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    periodId: string,
  ): Promise<PayrollCalculationResult> {
    const period = await sql<{
      basicSalary: string;
      calculatedEmployees: number;
      consideredEmployees: number;
      deductions: string;
      deliveredOrderEarnings: string;
      driverCommission: string;
      earningAdjustments: string;
      grossEarnings: string;
      heldEmployees: number;
      netSalary: string;
      status: "calculated" | "draft";
      totalAllowances: string;
    }>`
      select p.status,
             (select count(*)::integer from employees e
               where e.company_id=p.company_id) as "consideredEmployees",
             count(l.id) filter (where l.status<>'held')::integer as "calculatedEmployees",
             count(l.id) filter (where l.status='held')::integer as "heldEmployees",
             p.total_basic_salary::text as "basicSalary",
             p.total_allowances::text as "totalAllowances",
             p.total_employee_driver_commission::text as "driverCommission",
             p.total_delivered_order_earnings::text as "deliveredOrderEarnings",
             p.total_earning_adjustments::text as "earningAdjustments",
             p.total_deductions::text as deductions,
             (p.total_basic_salary+p.total_allowances+p.total_employee_driver_commission
               +p.total_delivered_order_earnings+p.total_earning_adjustments)::text
               as "grossEarnings",
             p.total_net_salary::text as "netSalary"
        from payroll_periods p
        left join payroll_entries l
          on l.payroll_period_id=p.id and l.company_id=p.company_id and l.status<>'reversed'
       where p.id=${periodId}::uuid and p.company_id=${companyId}::uuid
       group by p.id
    `.execute(database);
    const exceptions = await sql<CalculationException>`
      select employee_id as "employeeId", employee_number_snapshot as "employeeNumber",
             employee_name_snapshot as "employeeName", exception_code as code,
             message, category, severity
        from payroll_calculation_exceptions
       where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
         and status='active'
       order by severity, created_at, id
    `.execute(database);
    const row = period.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "payroll_period_not_found",
        "The Payroll period was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const blocking = exceptions.rows.filter((item) => item.severity === "blocking").length;
    const warning = exceptions.rows.length - blocking;
    return {
      blockingExceptionCount: blocking,
      calculatedEmployees: row.calculatedEmployees,
      consideredEmployees: row.consideredEmployees,
      exceptions: exceptions.rows,
      heldEmployees: row.heldEmployees,
      periodId,
      skippedEmployees: exceptions.rows.filter((item) => item.category === "Eligibility").length,
      status: row.status,
      totals: {
        basicSalary: row.basicSalary,
        deductions: row.deductions,
        deliveredOrderEarnings: row.deliveredOrderEarnings,
        driverCommission: row.driverCommission,
        earningAdjustments: row.earningAdjustments,
        grossEarnings: row.grossEarnings,
        netSalary: row.netSalary,
        totalAllowances: row.totalAllowances,
      },
      warningCount: warning,
    };
  }
}
