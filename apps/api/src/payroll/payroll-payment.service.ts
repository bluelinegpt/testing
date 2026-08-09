import { createHash } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { BalanceEnforcementCoordinator } from "../accounting/balance-enforcement.coordinator.js";
import type { BalanceEnforcementResult } from "../accounting/balance-enforcement.coordinator.js";
import { PaymentFundingAccountService } from "../accounting/payment-funding-account.service.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type {
  ConfirmPayrollPaymentDto,
  PayrollPaymentAllocationDto,
  PayrollPaymentProposalDto,
} from "./payroll.dto.js";
import { payrollIdempotencyOperations } from "./payroll-foundation.constants.js";
import { PayrollOperationSupport } from "./payroll-operation.support.js";
import { PayrollOperationalRepository } from "./payroll-operational.repository.js";

interface PayableLine {
  readonly employeeId: string;
  readonly employeeName: string;
  readonly employeeNumber: string;
  readonly lineId: string;
  readonly outstanding: string;
  readonly periodId: string;
  readonly status: string;
}

export interface PayrollPaymentProposal {
  readonly allocations: readonly {
    readonly amount: string;
    readonly employeeId: string;
    readonly employeeName: string;
    readonly employeeNumber: string;
    readonly lineId: string;
    readonly outstandingBefore: string;
    readonly remainingOutstanding: string;
  }[];
  readonly periodId: string;
  readonly totalAmount: string;
}

export interface PayrollPaymentResult {
  /**
   * The balance this payment was judged against omits confirmed payments that
   * never recorded which account funded them. ADVISORY -- it never blocks.
   *
   * Optional because only a freshly confirmed payment has it: a replay resolved
   * from the payment row rather than the stored response body cannot
   * reconstruct the coverage that applied at the time, and inventing one would
   * be worse than omitting it.
   */
  readonly balanceCoverage?: {
    readonly generalExpenseCashRowsWithoutCompanyCashAccount: number;
    readonly outsourcedDriverFeeCashPaymentsWithoutCashAccount: number;
    readonly payrollPaymentsWithoutCashAccount: number;
    readonly traderSettlementCashPaymentsWithoutCashAccount: number;
  };
  readonly balanceCoverageIncomplete?: boolean;
  readonly paymentId: string;
  readonly paymentNumber: string;
  readonly periodId: string;
  readonly status: string;
  readonly totalAmount: string;
}

@Injectable()
export class PayrollPaymentService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(PayrollOperationSupport) private readonly support: PayrollOperationSupport,
    @Inject(PayrollOperationalRepository)
    private readonly repository: PayrollOperationalRepository,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
    @Inject(PaymentFundingAccountService)
    private readonly fundingAccounts: PaymentFundingAccountService,
    @Inject(BalanceEnforcementCoordinator)
    private readonly balanceEnforcement: BalanceEnforcementCoordinator,
  ) {}

  public async proposal(input: PayrollPaymentProposalDto): Promise<PayrollPaymentProposal> {
    this.support.assertPermission("payroll.pay");
    const { companyId } = this.support.context();
    const lines = await this.loadPayableLines(
      this.database,
      companyId,
      input.periodId,
      input.lineIds,
      false,
    );
    return this.buildProposal(input, lines);
  }

  public async confirm(
    input: ConfirmPayrollPaymentDto,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<PayrollPaymentResult> {
    this.support.assertPermission("payroll.pay");
    this.validateAcknowledgement(input);
    const { actorId, companyId } = this.support.context();
    const allocations = this.normalizedAllocations(input.allocations);
    const total = allocations.reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
    const requestMaterial = {
      acknowledgementType: input.acknowledgementType,
      acknowledgementValue: input.acknowledgementValue?.trim() ?? "",
      allocations,
      // Part of the request identity, alongside accountId. Re-sending one key
      // with a different override reason is a DIFFERENT request -- it asks for
      // a payment to be authorised on different grounds -- and must be rejected
      // as a reused key rather than silently replayed as the original.
      balanceOverrideReason: input.balanceOverrideReason?.trim() ?? "",
      cashVoucherReference: input.cashVoucherReference.trim(),
      externalReference: input.externalReference?.trim() ?? "",
      notes: input.notes?.trim() ?? "",
      paymentDate: input.paymentDate,
      periodId: input.periodId,
      accountId: input.accountId,
    };
    const requestHash = createHash("sha256").update(JSON.stringify(requestMaterial)).digest("hex");

    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency<PayrollPaymentResult>(transaction, {
        companyId,
        idempotencyKey,
        operation: payrollIdempotencyOperations.paymentConfirmation,
        payload: requestMaterial,
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      if (reservation.replayResourceId !== undefined) {
        return this.paymentResult(transaction, companyId, reservation.replayResourceId);
      }
      const period = await sql<{ status: string }>`
        select status from payroll_periods
         where id=${input.periodId}::uuid and company_id=${companyId}::uuid
         for update
      `.execute(transaction);
      if (
        period.rows[0] === undefined ||
        !["approved", "partially_paid", "paid"].includes(period.rows[0].status)
      ) {
        throw new ApplicationException(
          "payroll_payment_period_not_approved",
          "Payments require an approved Payroll period",
          HttpStatus.CONFLICT,
        );
      }
      const lines = await this.loadPayableLines(
        transaction,
        companyId,
        input.periodId,
        allocations.map((line) => line.lineId),
        true,
      );
      const byId = new Map(lines.map((line) => [line.lineId, line]));
      for (const allocation of allocations) {
        const line = byId.get(allocation.lineId);
        if (line === undefined) {
          throw new ApplicationException(
            "payroll_line_not_payable",
            "A selected Payroll line is no longer payable",
            HttpStatus.CONFLICT,
          );
        }
        if (line.employeeId !== allocation.employeeId) {
          throw new ApplicationException(
            "payroll_payment_employee_mismatch",
            "A payment allocation Employee does not match its Payroll line",
            HttpStatus.CONFLICT,
          );
        }
        if (new Decimal(allocation.amount).greaterThan(line.outstanding)) {
          throw new ApplicationException(
            "payroll_payment_exceeds_outstanding",
            "A Payroll payment allocation exceeds the current outstanding salary",
            HttpStatus.CONFLICT,
          );
        }
      }
      const paymentNumber = await this.history.nextReferenceNumber(
        transaction,
        companyId,
        "payroll_payment",
        "PAYPMT",
      );
      // Immediately before the insert: an account deactivated or removed
      // between proposal and confirmation must fail here, not silently fund
      // a payment. Throwing inside the transaction rolls back everything
      // written so far in it.
      const fundingAccount = await this.fundingAccounts.payrollAccount(input.accountId);
      // Balance control. The coordinator LOCKS the Cash account, then reads its
      // balance behind that lock, then judges -- in that order, in this
      // transaction. Reading before locking would decide against a figure two
      // concurrent payments could each see and each spend.
      //
      // It is called AFTER the funding-account validation above (which is
      // unchanged) and BEFORE the insert below, so a blocked payment throws
      // while nothing has been written: the throw rolls back the reference
      // number and every prior statement in this transaction.
      const enforcement = await this.balanceEnforcement.evaluate(transaction, {
        actorId,
        actorPermissions: this.support.permissions(),
        deductions: [
          { accountId: fundingAccount.accountId, amount: total.toFixed(2), kind: "cash" },
        ],
        sourceReference: paymentNumber,
        sourceType: "payroll_payment",
        ...(input.balanceOverrideReason === undefined
          ? {}
          : { overrideReason: input.balanceOverrideReason }),
      });
      if (!enforcement.allowed) this.balanceBlocked(enforcement);
      const created = await sql<{ id: string }>`
        insert into payroll_payments (
          company_id, payroll_period_id, payment_number, payment_date,
          payment_method, total_amount, cash_voucher_reference, external_reference,
          acknowledgement_type, acknowledgement_value, notes, status,
          paid_by_account_id, idempotency_key, request_hash, confirmed_at,
          company_cash_account_id
        ) values (
          ${companyId}::uuid, ${input.periodId}::uuid, ${paymentNumber},
          ${input.paymentDate}::date, 'cash', ${total.toFixed(2)},
          ${input.cashVoucherReference.trim()}, ${input.externalReference?.trim() || null},
          ${input.acknowledgementType}, ${input.acknowledgementValue?.trim() || null},
          ${input.notes?.trim() || null}, 'confirmed', ${actorId}::uuid,
          ${idempotencyKey!.trim()}, ${requestHash},
          -- Created already confirmed, so the server clock at insert is the
          -- authoritative confirmation instant. payment_date stays the
          -- accounting day and is unaffected.
          now(),
          ${fundingAccount.accountId}::uuid
        )
        returning id
      `.execute(transaction);
      const paymentId = created.rows[0]!.id;
      // The override audit is written only now, with the payment row it
      // justifies already inserted and its id known. Written before the insert
      // it would survive as an accusation about money that never moved if
      // anything below rolled the payment back.
      if (enforcement.requiresOverrideAudit) {
        await this.balanceEnforcement.recordOverrides(transaction, {
          actorId,
          overrideReason: input.balanceOverrideReason ?? "",
          result: enforcement,
          sourceEntityId: paymentId,
          sourceReference: paymentNumber,
          sourceType: "payroll_payment",
        });
      }
      for (let index = 0; index < allocations.length; index += 1) {
        const allocation = allocations[index]!;
        const allocationCreated = await sql<{ id: string }>`
          insert into payroll_payment_allocations (
            company_id, payroll_payment_id, payroll_line_id, employee_id,
            allocated_amount, allocation_order
          ) values (
            ${companyId}::uuid, ${paymentId}::uuid, ${allocation.lineId}::uuid,
            ${allocation.employeeId}::uuid, ${allocation.amount}, ${index + 1}
          )
          returning id
        `.execute(transaction);
        const allocationId = allocationCreated.rows[0]!.id;
        await sql`
          update payroll_entries
             set amount_paid=amount_paid+${allocation.amount},
                 outstanding_amount=net_salary-(amount_paid+${allocation.amount}),
                 status=case
                   when net_salary=(amount_paid+${allocation.amount}) then 'paid'
                   else 'partially_paid'
                 end,
                 updated_at=now(), version=version+1
           where id=${allocation.lineId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        await this.history.audit(transaction, {
          action: "payroll.allocation.created",
          actorId,
          after: {
            amount: allocation.amount,
            employeeId: allocation.employeeId,
            lineId: allocation.lineId,
            paymentId,
          },
          companyId,
          correlationId,
          subjectId: allocationId,
          subjectType: "payroll_payment_allocation",
        });
      }
      await this.repository.recalculatePeriodTotals(transaction, companyId, input.periodId);
      const periodStatus = await this.repository.refreshSettlementStatuses(
        transaction,
        companyId,
        input.periodId,
      );
      await this.history.audit(transaction, {
        action: "payroll.payment.confirmed",
        actorId,
        after: {
          allocationCount: allocations.length,
          amount: total.toFixed(2),
          paymentNumber,
          periodId: input.periodId,
          periodStatus,
          status: "confirmed",
        },
        companyId,
        correlationId,
        subjectId: paymentId,
        subjectType: "payroll_payment",
      });
      const result: PayrollPaymentResult = {
        balanceCoverage: enforcement.coverage,
        balanceCoverageIncomplete: enforcement.balanceCoverageIncomplete,
        paymentId,
        paymentNumber,
        periodId: input.periodId,
        status: "confirmed",
        totalAmount: total.toFixed(2),
      };
      await this.support.completeIdempotency(transaction, {
        companyId,
        idempotencyKey: idempotencyKey!,
        operation: payrollIdempotencyOperations.paymentConfirmation,
        resourceId: paymentId,
        resourceType: "payroll_payment",
        responseBody: result,
        responseStatus: 201,
      });
      return result;
    });
  }

  public async reverse(
    paymentId: string,
    reason: string,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<PayrollPaymentResult> {
    this.support.assertPermission("payroll.reverse");
    if (reason.trim().length === 0) {
      throw new ApplicationException(
        "payroll_reversal_reason_required",
        "A payment reversal reason is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency<PayrollPaymentResult>(transaction, {
        companyId,
        idempotencyKey,
        operation: payrollIdempotencyOperations.paymentReversal,
        payload: { paymentId, reason: reason.trim() },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      if (reservation.replayResourceId !== undefined) {
        return this.paymentResult(transaction, companyId, reservation.replayResourceId);
      }
      const paymentResult = await sql<{
        amount: string;
        paymentNumber: string;
        periodId: string;
        status: string;
      }>`
        select total_amount::text as amount, payment_number as "paymentNumber",
               payroll_period_id as "periodId", status
          from payroll_payments
         where id=${paymentId}::uuid and company_id=${companyId}::uuid
         for update
      `.execute(transaction);
      const payment = paymentResult.rows[0];
      if (payment === undefined) {
        throw new ApplicationException(
          "payroll_payment_not_found",
          "The Payroll payment was not found",
          HttpStatus.NOT_FOUND,
        );
      }
      if (payment.status === "reversed") {
        throw new ApplicationException(
          "payroll_payment_already_reversed",
          "This Payroll payment has already been reversed",
          HttpStatus.CONFLICT,
        );
      }
      await sql`select id from payroll_periods
        where id=${payment.periodId}::uuid and company_id=${companyId}::uuid
        for update`.execute(transaction);
      const allocations = await sql<{
        amount: string;
        employeeId: string;
        id: string;
        lineId: string;
      }>`
        select id, payroll_line_id as "lineId", employee_id as "employeeId",
               allocated_amount::text as amount
          from payroll_payment_allocations
         where company_id=${companyId}::uuid and payroll_payment_id=${paymentId}::uuid
           and reversed_at is null
         order by allocation_order
         for update
      `.execute(transaction);
      const lineIds = allocations.rows.map((row) => row.lineId);
      await sql`select id from payroll_entries
        where company_id=${companyId}::uuid and id=any(${lineIds}::uuid[])
        for update`.execute(transaction);
      await sql`
        update payroll_payment_allocations
           set reversed_at=now()
         where company_id=${companyId}::uuid and payroll_payment_id=${paymentId}::uuid
           and reversed_at is null
      `.execute(transaction);
      for (const allocation of allocations.rows) {
        const active = await sql<{ total: string }>`
          select coalesce(sum(allocated_amount),0)::text as total
            from payroll_payment_allocations
           where company_id=${companyId}::uuid and payroll_line_id=${allocation.lineId}::uuid
             and reversed_at is null
        `.execute(transaction);
        const paid = new Decimal(active.rows[0]!.total);
        await sql`
          update payroll_entries
             set amount_paid=${paid.toFixed(2)},
                 outstanding_amount=net_salary-${paid.toFixed(2)},
                 status=case
                   when ${paid.toFixed(2)}::numeric=0 then 'approved'
                   when net_salary=${paid.toFixed(2)}::numeric then 'paid'
                   else 'partially_paid'
                 end,
                 updated_at=now(), version=version+1
           where id=${allocation.lineId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        await this.history.audit(transaction, {
          action: "payroll.allocation.reversed",
          actorId,
          after: { allocationId: allocation.id, amount: allocation.amount, paymentId },
          companyId,
          correlationId,
          subjectId: allocation.id,
          subjectType: "payroll_payment_allocation",
        });
      }
      await sql`
        update payroll_payments
           set status='reversed', reversed_by_account_id=${actorId}::uuid,
               reversed_at=now(), reversal_reason=${reason.trim()},
               updated_at=now(), version=version+1
         where id=${paymentId}::uuid and company_id=${companyId}::uuid
      `.execute(transaction);
      await this.repository.recalculatePeriodTotals(transaction, companyId, payment.periodId);
      const periodStatus = await this.repository.refreshSettlementStatuses(
        transaction,
        companyId,
        payment.periodId,
      );
      await this.history.audit(transaction, {
        action: "payroll.payment.reversed",
        actorId,
        after: {
          amount: payment.amount,
          fromStatus: payment.status,
          periodStatus,
          reason: reason.trim(),
          status: "reversed",
        },
        companyId,
        correlationId,
        subjectId: paymentId,
        subjectType: "payroll_payment",
      });
      const result = {
        paymentId,
        paymentNumber: payment.paymentNumber,
        periodId: payment.periodId,
        status: "reversed",
        totalAmount: payment.amount,
      };
      await this.support.completeIdempotency(transaction, {
        companyId,
        idempotencyKey: idempotencyKey!,
        operation: payrollIdempotencyOperations.paymentReversal,
        resourceId: paymentId,
        resourceType: "payroll_payment",
        responseBody: result,
      });
      return result;
    });
  }

  private async loadPayableLines(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    periodId: string,
    lineIds: readonly string[],
    lock: boolean,
  ): Promise<readonly PayableLine[]> {
    const locking = lock ? sql`for update of l` : sql``;
    const result = await sql<PayableLine>`
      select l.id as "lineId", l.employee_id as "employeeId",
             l.employee_name_snapshot as "employeeName",
             l.employee_number_snapshot as "employeeNumber",
             l.payroll_period_id as "periodId", l.status,
             l.outstanding_amount::text as outstanding
        from payroll_entries l
        join payroll_periods p on p.id=l.payroll_period_id and p.company_id=l.company_id
       where l.company_id=${companyId}::uuid and l.payroll_period_id=${periodId}::uuid
         and l.id=any(${lineIds}::uuid[])
         and p.status in ('approved','partially_paid','paid')
         and l.status in ('approved','partially_paid')
         and not l.salary_hold_snapshot and l.outstanding_amount>0
       order by l.employee_number_snapshot, l.id
       ${locking}
    `.execute(database);
    return result.rows;
  }

  private buildProposal(
    input: PayrollPaymentProposalDto,
    lines: readonly PayableLine[],
  ): PayrollPaymentProposal {
    const lineMap = new Map(lines.map((line) => [line.lineId, line]));
    if (
      new Set(input.lineIds).size !== input.lineIds.length ||
      lines.length !== input.lineIds.length
    ) {
      throw new ApplicationException(
        "payroll_line_not_payable",
        "One or more selected Payroll lines are no longer payable",
        HttpStatus.CONFLICT,
      );
    }
    const explicit =
      input.allocations === undefined
        ? new Map<string, Decimal>()
        : new Map(input.allocations.map((line) => [line.lineId, new Decimal(line.amount)]));
    if (
      input.allocations !== undefined &&
      (explicit.size !== input.allocations.length ||
        input.allocations.some((line) => !lineMap.has(line.lineId)) ||
        input.lineIds.some((lineId) => !explicit.has(lineId)))
    ) {
      throw new ApplicationException(
        "payroll_payment_duplicate_allocation",
        "Explicit payment allocations must match each selected Payroll line exactly once",
        HttpStatus.CONFLICT,
      );
    }
    let remaining = input.totalAmount === undefined ? null : new Decimal(input.totalAmount);
    const allocations = input.lineIds.map((lineId) => {
      const line = lineMap.get(lineId)!;
      const outstanding = new Decimal(line.outstanding);
      const amount =
        explicit.get(lineId) ??
        (remaining === null ? outstanding : Decimal.min(remaining, outstanding));
      if (!amount.isPositive() || amount.greaterThan(outstanding)) {
        throw new ApplicationException(
          "payroll_payment_exceeds_outstanding",
          "A proposed allocation is invalid or exceeds outstanding salary",
          HttpStatus.CONFLICT,
        );
      }
      if (remaining !== null) remaining = remaining.minus(amount);
      return {
        amount: amount.toFixed(2),
        employeeId: line.employeeId,
        employeeName: line.employeeName,
        employeeNumber: line.employeeNumber,
        lineId,
        outstandingBefore: outstanding.toFixed(2),
        remainingOutstanding: outstanding.minus(amount).toFixed(2),
      };
    });
    if (remaining !== null && !remaining.isZero()) {
      throw new ApplicationException(
        "payroll_payment_exceeds_outstanding",
        "The proposed total exceeds the selected Employees' outstanding salary",
        HttpStatus.CONFLICT,
      );
    }
    const total = allocations.reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
    return { allocations, periodId: input.periodId, totalAmount: total.toFixed(2) };
  }

  private normalizedAllocations(
    allocations: readonly PayrollPaymentAllocationDto[],
  ): readonly { amount: string; employeeId: string; lineId: string }[] {
    const seen = new Set<string>();
    return allocations.map((allocation) => {
      if (seen.has(allocation.lineId)) {
        throw new ApplicationException(
          "payroll_payment_duplicate_allocation",
          "A Payroll line cannot appear twice in one payment",
          HttpStatus.CONFLICT,
        );
      }
      seen.add(allocation.lineId);
      return {
        amount: new Decimal(allocation.amount).toDecimalPlaces(2).toFixed(2),
        employeeId: allocation.employeeId,
        lineId: allocation.lineId,
      };
    });
  }

  private validateAcknowledgement(input: ConfirmPayrollPaymentDto): void {
    if (input.cashVoucherReference.trim().length === 0) {
      throw new ApplicationException(
        "payroll_cash_voucher_required",
        "A cash voucher or reference is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      input.acknowledgementType === "typed_name" &&
      (input.acknowledgementValue?.trim().length ?? 0) === 0
    ) {
      throw new ApplicationException(
        "payroll_acknowledgement_required",
        "A typed acknowledgement name is required",
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Reject a payment the balance policy will not permit.
   *
   * Throwing rather than returning is what guarantees the "no payment, no
   * Event, no Journal, no audit" outcome: this runs inside the confirmation
   * transaction and before the insert, so the rollback undoes the reference
   * number and every statement taken so far, and nothing downstream ever runs.
   *
   * The details are the figures the person needs in order to act -- their own
   * balance, what they tried to pay, where it would land, and the rule that
   * stopped it. They are business facts about the User's own Company, not
   * internals: no account ids, no policy row id, no SQL, no coverage internals
   * beyond the fact that a gap exists and how many records it spans.
   */
  private balanceBlocked(enforcement: BalanceEnforcementResult): never {
    throw new ApplicationException(
      enforcement.failureCode ?? "balance_would_go_negative",
      enforcement.failureReason ?? "This payment is not permitted by the balance policy",
      HttpStatus.CONFLICT,
      // Formatting comes from the coordinator, which owns the figures. The
      // local copy this replaced could only describe ONE account and could not
      // say which; the shared version labels every account by kind, so a
      // workflow that later funds from two says which one refused.
      this.balanceEnforcement.blockedDetails(enforcement),
    );
  }

  private async paymentResult(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    paymentId: string,
  ): Promise<PayrollPaymentResult> {
    const result = await sql<PayrollPaymentResult>`
      select id as "paymentId", payment_number as "paymentNumber",
             payroll_period_id as "periodId", status, total_amount::text as "totalAmount"
        from payroll_payments
       where id=${paymentId}::uuid and company_id=${companyId}::uuid
    `.execute(database);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "payroll_payment_not_found",
        "The Payroll payment was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return result.rows[0];
  }
}
