import { HttpStatus, Inject, Injectable } from "@nestjs/common";
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

export interface PayrollPeriodMutationResult {
  readonly periodId: string;
  readonly periodReference: string;
  readonly status: string;
}

@Injectable()
export class PayrollPeriodService {
  public constructor(
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(PayrollOperationSupport) private readonly support: PayrollOperationSupport,
    @Inject(PayrollOperationalRepository)
    private readonly repository: PayrollOperationalRepository,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
  ) {}

  public async create(
    payrollMonth: string,
    notes: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<PayrollPeriodMutationResult> {
    this.support.assertPermission("payroll.manage");
    const { actorId, companyId } = this.support.context();
    const range = this.support.monthRange(payrollMonth);
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency<PayrollPeriodMutationResult>(
        transaction,
        {
          companyId,
          idempotencyKey,
          operation: payrollIdempotencyOperations.periodCreate,
          payload: { notes: notes?.trim() ?? "", payrollMonth },
        },
      );
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      if (reservation.replayResourceId !== undefined) {
        return this.periodResult(transaction, companyId, reservation.replayResourceId);
      }
      const existing = await sql<{ status: string }>`
        select status
          from payroll_periods
         where company_id=${companyId}::uuid
           and payroll_month=${`${payrollMonth}-01`}::date
         order by created_at, id
         for update
      `.execute(transaction);
      if (existing.rows.some((period) => period.status !== "reversed")) {
        throw new ApplicationException(
          "payroll_period_already_exists",
          "A Payroll period already exists for this Company and month",
          HttpStatus.CONFLICT,
        );
      }
      const periodReference =
        existing.rows.length === 0
          ? range.reference
          : `${range.reference}-R${existing.rows.length + 1}`;
      const created = await sql<{ id: string }>`
        insert into payroll_periods (
          company_id, period_reference, payroll_month, period_start, period_end,
          status, notes, created_by_account_id
        ) values (
          ${companyId}::uuid, ${periodReference}, ${`${payrollMonth}-01`}::date,
          ${range.start}::date, ${range.end}::date, 'draft',
          ${notes?.trim() || null}, ${actorId}::uuid
        )
        on conflict do nothing
        returning id
      `.execute(transaction);
      const periodId = created.rows[0]?.id;
      if (periodId === undefined) {
        throw new ApplicationException(
          "payroll_period_already_exists",
          "A Payroll period already exists for this Company and month",
          HttpStatus.CONFLICT,
        );
      }
      await this.history.audit(transaction, {
        action: "payroll.period.created",
        actorId,
        after: { payrollMonth, periodReference, status: "draft" },
        companyId,
        correlationId,
        subjectId: periodId,
        subjectType: "payroll_period",
      });
      const result = { periodId, periodReference, status: "draft" };
      await this.support.completeIdempotency(transaction, {
        companyId,
        idempotencyKey: idempotencyKey!,
        operation: payrollIdempotencyOperations.periodCreate,
        resourceId: periodId,
        resourceType: "payroll_period",
        responseBody: result,
        responseStatus: 201,
      });
      return result;
    });
  }

  public async approve(
    periodId: string,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<PayrollPeriodMutationResult> {
    this.support.assertPermission("payroll.approve");
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency<PayrollPeriodMutationResult>(
        transaction,
        {
          companyId,
          idempotencyKey,
          operation: payrollIdempotencyOperations.approval,
          payload: { periodId },
        },
      );
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      if (reservation.replayResourceId !== undefined) {
        return this.periodResult(transaction, companyId, reservation.replayResourceId);
      }
      const period = await this.lockPeriod(transaction, companyId, periodId);
      assertPayrollPeriodStatus(period.status);
      if (period.status !== "calculated") {
        throw new ApplicationException(
          "payroll_period_not_calculated",
          "Only a calculated Payroll period can be approved",
          HttpStatus.CONFLICT,
        );
      }
      assertPayrollPeriodTransition(period.status, "approved");
      await sql`select id from payroll_entries
        where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
        for update`.execute(transaction);
      const recalculableLines = await sql<{ id: string }>`
        select id from payroll_entries
         where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
           and source_marker='new_payroll'
      `.execute(transaction);
      for (const line of recalculableLines.rows) {
        await this.repository.recalculateLine(transaction, companyId, line.id);
      }
      const validation = await sql<{ blocking: number; invalidLines: number; lineCount: number }>`
        select
          (select count(*)::integer from payroll_calculation_exceptions e
            where e.company_id=${companyId}::uuid
              and e.payroll_period_id=${periodId}::uuid
              and e.status='active' and e.severity='blocking') as blocking,
          count(*) filter (
            where (l.status='held' and (
              l.net_salary<>0 or l.basic_salary_snapshot<>0 or l.allowance_total<>0
              or l.employee_driver_commission<>0
            )) or (l.status<>'held' and l.salary_version_id is null)
              or (l.source_marker='new_payroll' and l.allowance_total<>coalesce((
                select sum(a.amount) from payroll_line_allowances a
                 where a.company_id=l.company_id and a.payroll_line_id=l.id
              ),0))
              or (l.source_marker='new_payroll' and l.employee_driver_commission<>coalesce((
                select sum(c.amount) from payroll_commission_links c
                 where c.company_id=l.company_id and c.payroll_entry_id=l.id
              ),0))
          )::integer as "invalidLines",
          count(*)::integer as "lineCount"
        from payroll_entries l
        where l.company_id=${companyId}::uuid and l.payroll_period_id=${periodId}::uuid
      `.execute(transaction);
      const check = validation.rows[0]!;
      if (check.blocking > 0) {
        throw new ApplicationException(
          "payroll_period_has_exceptions",
          "Blocking Payroll calculation exceptions must be resolved before approval",
          HttpStatus.CONFLICT,
        );
      }
      if (check.lineCount === 0 || check.invalidLines > 0) {
        throw new ApplicationException(
          "payroll_line_invalid_snapshot",
          "Payroll contains missing or invalid Employee snapshots",
          HttpStatus.CONFLICT,
        );
      }
      await this.repository.recalculatePeriodTotals(transaction, companyId, periodId);
      await sql`
        update payroll_entries
           set status=case when status='held' then 'held' else 'approved' end,
               approved_by_account_id=${actorId}::uuid, approved_at=now(),
               updated_at=now(), version=version+1
         where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
           and status in ('draft','calculated','held')
      `.execute(transaction);
      await sql`
        update payroll_periods
           set status='approved', approved_by_account_id=${actorId}::uuid,
               approved_at=now(), updated_at=now(), version=version+1
         where id=${periodId}::uuid and company_id=${companyId}::uuid
      `.execute(transaction);
      await this.history.audit(transaction, {
        action: "payroll.period.approved",
        actorId,
        after: { fromStatus: period.status, status: "approved" },
        companyId,
        correlationId,
        subjectId: periodId,
        subjectType: "payroll_period",
      });
      const result = {
        periodId,
        periodReference: period.periodReference,
        status: "approved",
      };
      await this.support.completeIdempotency(transaction, {
        companyId,
        idempotencyKey: idempotencyKey!,
        operation: payrollIdempotencyOperations.approval,
        resourceId: periodId,
        resourceType: "payroll_period",
        responseBody: result,
      });
      return result;
    });
  }

  public async close(
    periodId: string,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<PayrollPeriodMutationResult> {
    this.support.assertPermission("payroll.approve");
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency<PayrollPeriodMutationResult>(
        transaction,
        {
          companyId,
          idempotencyKey,
          operation: payrollIdempotencyOperations.periodClose,
          payload: { periodId },
        },
      );
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      if (reservation.replayResourceId !== undefined) {
        return this.periodResult(transaction, companyId, reservation.replayResourceId);
      }
      const period = await this.lockPeriod(transaction, companyId, periodId);
      assertPayrollPeriodStatus(period.status);
      if (!["approved", "partially_paid", "paid"].includes(period.status)) {
        throw new ApplicationException(
          "payroll_period_has_outstanding_balance",
          "A Payroll period can close only after all non-held lines are fully paid",
          HttpStatus.CONFLICT,
        );
      }
      const outstanding = await sql<{ total: number }>`
        select count(*)::integer as total from payroll_entries
         where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
           and status not in ('held','reversed') and outstanding_amount>0
      `.execute(transaction);
      if ((outstanding.rows[0]?.total ?? 0) > 0) {
        throw new ApplicationException(
          "payroll_period_has_outstanding_balance",
          "Outstanding Payroll balances must be paid before closing the period",
          HttpStatus.CONFLICT,
        );
      }
      const unresolvedExceptions = await sql<{ total: number }>`
        select count(*)::integer as total
         from payroll_calculation_exceptions
         where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
           and status='active' and severity='blocking'
      `.execute(transaction);
      if ((unresolvedExceptions.rows[0]?.total ?? 0) > 0) {
        throw new ApplicationException(
          "payroll_period_has_exceptions",
          "Unresolved blocking Payroll calculation exceptions must be cleared before closing",
          HttpStatus.CONFLICT,
        );
      }
      if (period.status !== "paid") {
        assertPayrollPeriodTransition(period.status, "paid");
        await sql`
          update payroll_periods
             set status='paid', updated_at=now(), version=version+1
           where id=${periodId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
      }
      assertPayrollPeriodTransition("paid", "closed");
      await sql`
        update payroll_periods
           set status='closed', closed_by_account_id=${actorId}::uuid, closed_at=now(),
               updated_at=now(), version=version+1
         where id=${periodId}::uuid and company_id=${companyId}::uuid
      `.execute(transaction);
      await this.history.audit(transaction, {
        action: "payroll.period.closed",
        actorId,
        after: { fromStatus: period.status, status: "closed" },
        companyId,
        correlationId,
        subjectId: periodId,
        subjectType: "payroll_period",
      });
      const result = {
        periodId,
        periodReference: period.periodReference,
        status: "closed",
      };
      await this.support.completeIdempotency(transaction, {
        companyId,
        idempotencyKey: idempotencyKey!,
        operation: payrollIdempotencyOperations.periodClose,
        resourceId: periodId,
        resourceType: "payroll_period",
        responseBody: result,
      });
      return result;
    });
  }

  public async reverse(
    periodId: string,
    reason: string,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<PayrollPeriodMutationResult> {
    this.support.assertPermission("payroll.reverse");
    if (reason.trim().length === 0) {
      throw new ApplicationException(
        "payroll_reversal_reason_required",
        "A Payroll reversal reason is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency<PayrollPeriodMutationResult>(
        transaction,
        {
          companyId,
          idempotencyKey,
          operation: payrollIdempotencyOperations.periodReversal,
          payload: { periodId, reason: reason.trim() },
        },
      );
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      if (reservation.replayResourceId !== undefined) {
        return this.periodResult(transaction, companyId, reservation.replayResourceId);
      }
      const period = await this.lockPeriod(transaction, companyId, periodId);
      assertPayrollPeriodStatus(period.status);
      if (period.status === "reversed") {
        throw new ApplicationException(
          "payroll_already_reversed",
          "This Payroll period has already been reversed",
          HttpStatus.CONFLICT,
        );
      }
      assertPayrollPeriodTransition(period.status, "reversed");
      const activePayments = await sql<{ total: number }>`
        select count(*)::integer as total from payroll_payments
         where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
           and status='confirmed'
      `.execute(transaction);
      if ((activePayments.rows[0]?.total ?? 0) > 0) {
        throw new ApplicationException(
          "payroll_period_has_active_payments",
          "Reverse all active Payroll payments before reversing this period",
          HttpStatus.CONFLICT,
        );
      }
      await sql`
        update payroll_entries
           set status='reversed', reversed_by_account_id=${actorId}::uuid,
               reversed_at=now(), reversal_reason=${reason.trim()},
               updated_at=now(), version=version+1
         where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
           and status<>'reversed'
      `.execute(transaction);
      await sql`
        update payroll_periods
           set status='reversed', reversed_by_account_id=${actorId}::uuid,
               reversed_at=now(), reversal_reason=${reason.trim()},
               updated_at=now(), version=version+1
         where id=${periodId}::uuid and company_id=${companyId}::uuid
      `.execute(transaction);
      await this.history.audit(transaction, {
        action: "payroll.period.reversed",
        actorId,
        after: { fromStatus: period.status, reason: reason.trim(), status: "reversed" },
        companyId,
        correlationId,
        subjectId: periodId,
        subjectType: "payroll_period",
      });
      const result = {
        periodId,
        periodReference: period.periodReference,
        status: "reversed",
      };
      await this.support.completeIdempotency(transaction, {
        companyId,
        idempotencyKey: idempotencyKey!,
        operation: payrollIdempotencyOperations.periodReversal,
        resourceId: periodId,
        resourceType: "payroll_period",
        responseBody: result,
      });
      return result;
    });
  }

  private async lockPeriod(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    periodId: string,
  ): Promise<{ periodReference: string; status: string }> {
    const result = await sql<{ periodReference: string; status: string }>`
      select period_reference as "periodReference", status
        from payroll_periods
       where id=${periodId}::uuid and company_id=${companyId}::uuid
       for update
    `.execute(database);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "payroll_period_not_found",
        "The Payroll period was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return result.rows[0];
  }

  private async periodResult(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    periodId: string,
  ): Promise<PayrollPeriodMutationResult> {
    const period = await sql<PayrollPeriodMutationResult>`
      select id as "periodId", period_reference as "periodReference", status
        from payroll_periods
       where id=${periodId}::uuid and company_id=${companyId}::uuid
    `.execute(database);
    if (period.rows[0] === undefined) {
      throw new ApplicationException(
        "payroll_period_not_found",
        "The Payroll period was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return period.rows[0];
  }
}
