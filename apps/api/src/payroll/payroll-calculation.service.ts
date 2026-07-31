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
          (
            employee.salaryHoldFrom === null ||
            employee.salaryHoldReason?.trim().length === 0 ||
            (
              employee.salaryHoldTo !== null &&
              employee.salaryHoldFrom !== null &&
              employee.salaryHoldTo < employee.salaryHoldFrom
            )
          )
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
        if (allowanceResult.rows.length > 4 || allowanceCodes.size !== allowanceResult.rows.length) {
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
        const basic = this.prorateMonthlyAmount(
          salaryRow.amount,
          payableDays,
          periodDays,
        );
        const gross = basic.plus(allowanceTotal).plus(commission.amount);
        const lineId = await this.upsertCalculatedLine(transaction, {
          actorId,
          allowanceTotal,
          basic,
          commission: commission.amount,
          companyId,
          employee,
          gross,
          periodId,
          periodReference: period.periodReference,
          salaryVersionId: salaryRow.id,
        });
        await sql`
          delete from payroll_line_allowances
           where company_id=${companyId}::uuid and payroll_line_id=${lineId}::uuid
        `.execute(transaction);
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
      const response = recalculationChanges === undefined
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
        employee_driver_commission, allowance_total, earning_adjustments_total,
        deduction_adjustments_total, advances, gross_earnings, net_salary,
        amount_paid, outstanding_amount, salary_hold_snapshot,
        salary_hold_reason_snapshot, salary_hold_from_snapshot, salary_hold_to_snapshot,
        status, source_marker, created_by_account_id, calculated_by_account_id, calculated_at
      ) values (
        ${companyId}::uuid, ${this.lineReference(periodReference, employee)},
        ${periodId}::uuid, ${employee.id}::uuid, ${employee.employeeNumber ?? "UNASSIGNED"},
        ${employee.nameEn}, ${employee.nameAr}, ${employee.employeeType},
        ${employee.department}, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, true,
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
        earning_adjustments_total=0, deduction_adjustments_total=0, advances=0,
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
      commission: Decimal;
      companyId: string;
      employee: EmployeeCandidate;
      gross: Decimal;
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
        basic_salary_snapshot, employee_driver_commission, allowance_total,
        earning_adjustments_total, deduction_adjustments_total, advances,
        gross_earnings, net_salary, amount_paid, outstanding_amount,
        salary_hold_snapshot, status, source_marker, created_by_account_id,
        calculated_by_account_id, calculated_at
      ) values (
        ${input.companyId}::uuid, ${this.lineReference(input.periodReference, input.employee)},
        ${input.periodId}::uuid, ${input.employee.id}::uuid,
        ${input.employee.employeeNumber ?? "UNASSIGNED"}, ${input.employee.nameEn},
        ${input.employee.nameAr}, ${input.employee.employeeType}, ${input.employee.department},
        ${input.salaryVersionId}::uuid, ${input.basic.toFixed(2)},
        ${input.commission.toFixed(2)}, ${input.allowanceTotal.toFixed(2)}, 0, 0, 0,
        ${input.gross.toFixed(2)}, ${input.gross.toFixed(2)}, 0,
        ${input.gross.toFixed(2)}, false, 'calculated', 'new_payroll',
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
        allowance_total=excluded.allowance_total,
        earning_adjustments_total=payroll_entries.earning_adjustments_total,
        deduction_adjustments_total=payroll_entries.deduction_adjustments_total,
        gross_earnings=excluded.gross_earnings+payroll_entries.earning_adjustments_total,
        net_salary=excluded.gross_earnings+payroll_entries.earning_adjustments_total
          -payroll_entries.deduction_adjustments_total-payroll_entries.advances,
        outstanding_amount=excluded.gross_earnings+payroll_entries.earning_adjustments_total
          -payroll_entries.deduction_adjustments_total-payroll_entries.advances
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

  private async resolveCommission(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    employee: EmployeeCandidate,
    start: string,
    end: string,
    periodId: string,
  ): Promise<
    | { amount: Decimal; calculationId: string | null }
    | { exception: CalculationException }
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
    if (candidates.length > 1 || result.rows.some((row) => row.linkedPeriodId !== null && row.linkedPeriodId !== periodId)) {
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
             total_earning_adjustments::text as "earningAdjustments",
             total_deductions::text as deductions,
             (total_basic_salary+total_allowances+
               total_employee_driver_commission+total_earning_adjustments)::text
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
             p.total_earning_adjustments::text as "earningAdjustments",
             p.total_deductions::text as deductions,
             (p.total_basic_salary+p.total_allowances+
               p.total_employee_driver_commission+p.total_earning_adjustments)::text
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
