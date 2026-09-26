import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { CreatePayrollAdjustmentDto } from "./payroll.dto.js";
import { payrollIdempotencyOperations } from "./payroll-foundation.constants.js";
import { PayrollOperationSupport } from "./payroll-operation.support.js";
import { PayrollOperationalRepository } from "./payroll-operational.repository.js";

export interface PayrollAdjustmentResult {
  readonly adjustmentId: string;
  readonly amount: string;
  readonly lineId: string;
  readonly status: string;
}

@Injectable()
export class PayrollAdjustmentService {
  public constructor(
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(PayrollOperationSupport) private readonly support: PayrollOperationSupport,
    @Inject(PayrollOperationalRepository)
    private readonly repository: PayrollOperationalRepository,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
  ) {}

  public async create(
    lineId: string,
    input: CreatePayrollAdjustmentDto,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<PayrollAdjustmentResult> {
    this.support.assertPermission("payroll.manage");
    const { actorId, companyId } = this.support.context();
    const amount = new Decimal(input.amount).toDecimalPlaces(2);
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency<PayrollAdjustmentResult>(
        transaction,
        {
          companyId,
          idempotencyKey,
          operation: payrollIdempotencyOperations.adjustmentCreate,
          payload: {
            adjustmentType: input.adjustmentType,
            amount: amount.toFixed(2),
            direction: input.direction,
            employeeId: input.employeeId ?? "",
            lineId,
            notes: input.notes?.trim() ?? "",
            reason: input.reason.trim(),
            sourceReference: input.sourceReference?.trim() ?? "",
          },
        },
      );
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      if (reservation.replayResourceId !== undefined) {
        return this.result(transaction, companyId, reservation.replayResourceId);
      }
      const lineResult = await sql<{
        employeeId: string;
        periodId: string;
        periodStatus: string;
        status: string;
      }>`
        select l.employee_id as "employeeId", l.payroll_period_id as "periodId",
               l.status, p.status as "periodStatus"
          from payroll_entries l
          join payroll_periods p on p.id=l.payroll_period_id and p.company_id=l.company_id
         where l.id=${lineId}::uuid and l.company_id=${companyId}::uuid
         for update of l, p
      `.execute(transaction);
      const line = lineResult.rows[0];
      if (line === undefined) {
        throw new ApplicationException(
          "payroll_line_not_found",
          "The Payroll line was not found",
          HttpStatus.NOT_FOUND,
        );
      }
      if (!["draft", "calculated"].includes(line.periodStatus) || line.status === "held") {
        throw new ApplicationException(
          line.status === "held" ? "payroll_line_held" : "payroll_adjustment_not_allowed",
          line.status === "held"
            ? "Adjustments are not allowed for a held Payroll line"
            : "Adjustments are allowed only before Payroll approval",
          HttpStatus.CONFLICT,
        );
      }
      if (input.employeeId !== undefined && input.employeeId !== line.employeeId) {
        throw new ApplicationException(
          "payroll_payment_employee_mismatch",
          "The Employee does not match the Payroll line",
          HttpStatus.CONFLICT,
        );
      }
      const created = await sql<{ id: string }>`
        insert into payroll_adjustments (
          company_id, payroll_period_id, payroll_line_id, employee_id,
          adjustment_type, direction, amount, reason, source_reference, notes,
          created_by_account_id
        ) values (
          ${companyId}::uuid, ${line.periodId}::uuid, ${lineId}::uuid,
          ${line.employeeId}::uuid, ${input.adjustmentType}, ${input.direction},
          ${amount.toFixed(2)}, ${input.reason.trim()},
          ${input.sourceReference?.trim() || null}, ${input.notes?.trim() || null},
          ${actorId}::uuid
        )
        returning id
      `.execute(transaction);
      const adjustmentId = created.rows[0]!.id;
      await this.repository.recalculateLine(transaction, companyId, lineId);
      await this.repository.recalculatePeriodTotals(transaction, companyId, line.periodId);
      await this.history.audit(transaction, {
        action: "payroll.adjustment.added",
        actorId,
        after: {
          adjustmentType: input.adjustmentType,
          amount: amount.toFixed(2),
          direction: input.direction,
          employeeId: line.employeeId,
          lineId,
          reason: input.reason.trim(),
        },
        companyId,
        correlationId,
        subjectId: adjustmentId,
        subjectType: "payroll_adjustment",
      });
      const result = {
        adjustmentId,
        amount: amount.toFixed(2),
        lineId,
        status: "active",
      };
      await this.support.completeIdempotency(transaction, {
        companyId,
        idempotencyKey: idempotencyKey!,
        operation: payrollIdempotencyOperations.adjustmentCreate,
        resourceId: adjustmentId,
        resourceType: "payroll_adjustment",
        responseBody: result,
        responseStatus: 201,
      });
      return result;
    });
  }

  public async reverse(
    adjustmentId: string,
    reason: string,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<PayrollAdjustmentResult> {
    this.support.assertPermission("payroll.reverse");
    if (reason.trim().length === 0) {
      throw new ApplicationException(
        "payroll_reversal_reason_required",
        "An adjustment reversal reason is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency<PayrollAdjustmentResult>(
        transaction,
        {
          companyId,
          idempotencyKey,
          operation: payrollIdempotencyOperations.adjustmentReversal,
          payload: { adjustmentId, reason: reason.trim() },
        },
      );
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      if (reservation.replayResourceId !== undefined) {
        return this.result(transaction, companyId, reservation.replayResourceId);
      }
      const adjustmentResult = await sql<{
        amount: string;
        lineId: string;
        periodId: string;
        periodStatus: string;
        status: string;
      }>`
        select a.amount::text as amount, a.payroll_line_id as "lineId",
               a.payroll_period_id as "periodId", a.status,
               p.status as "periodStatus"
          from payroll_adjustments a
          join payroll_periods p on p.id=a.payroll_period_id and p.company_id=a.company_id
         where a.id=${adjustmentId}::uuid and a.company_id=${companyId}::uuid
         for update of a, p
      `.execute(transaction);
      const adjustment = adjustmentResult.rows[0];
      if (adjustment === undefined) {
        throw new ApplicationException(
          "payroll_adjustment_not_found",
          "The Payroll adjustment was not found",
          HttpStatus.NOT_FOUND,
        );
      }
      if (adjustment.status === "reversed") {
        throw new ApplicationException(
          "payroll_adjustment_already_reversed",
          "This Payroll adjustment has already been reversed",
          HttpStatus.CONFLICT,
        );
      }
      if (!["draft", "calculated"].includes(adjustment.periodStatus)) {
        throw new ApplicationException(
          "payroll_adjustment_not_allowed",
          "Approved Payroll adjustments cannot be reversed directly",
          HttpStatus.CONFLICT,
        );
      }
      await sql`
        update payroll_adjustments
           set status='reversed', reversed_by_account_id=${actorId}::uuid,
               reversed_at=now(), reversal_reason=${reason.trim()},
               updated_at=now(), version=version+1
         where id=${adjustmentId}::uuid and company_id=${companyId}::uuid
      `.execute(transaction);
      await this.repository.recalculateLine(transaction, companyId, adjustment.lineId);
      await this.repository.recalculatePeriodTotals(transaction, companyId, adjustment.periodId);
      await this.history.audit(transaction, {
        action: "payroll.adjustment.reversed",
        actorId,
        after: {
          fromStatus: adjustment.status,
          reason: reason.trim(),
          status: "reversed",
        },
        companyId,
        correlationId,
        subjectId: adjustmentId,
        subjectType: "payroll_adjustment",
      });
      const result = {
        adjustmentId,
        amount: adjustment.amount,
        lineId: adjustment.lineId,
        status: "reversed",
      };
      await this.support.completeIdempotency(transaction, {
        companyId,
        idempotencyKey: idempotencyKey!,
        operation: payrollIdempotencyOperations.adjustmentReversal,
        resourceId: adjustmentId,
        resourceType: "payroll_adjustment",
        responseBody: result,
      });
      return result;
    });
  }

  private async result(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    adjustmentId: string,
  ): Promise<PayrollAdjustmentResult> {
    const result = await sql<PayrollAdjustmentResult>`
      select id as "adjustmentId", payroll_line_id as "lineId",
             amount::text as amount, status
        from payroll_adjustments
       where id=${adjustmentId}::uuid and company_id=${companyId}::uuid
    `.execute(database);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "payroll_adjustment_not_found",
        "The Payroll adjustment was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return result.rows[0];
  }
}
