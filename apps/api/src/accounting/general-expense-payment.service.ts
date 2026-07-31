import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import { GeneralExpenseAccountingEventWriter } from "./general-expense-accounting-event.writer.js";
import type {
  CreateGeneralExpensePaymentDto,
  GeneralExpenseReasonDto,
} from "./general-expense.dto.js";

interface PayableExpense {
  readonly accountingDate: string;
  readonly approvedBy: string;
  readonly correlationId: string;
  readonly createdBy: string;
  readonly expenseNumber: string;
  readonly id: string;
  readonly outstandingAmount: string;
  readonly paidAmount: string;
  readonly status: string;
  readonly version: string;
}

interface PaymentRecord {
  readonly accountingDate: string;
  readonly amount: string;
  readonly confirmedBy: string;
  readonly correlationId: string;
  readonly expenseId: string;
  readonly paymentNumber: string;
  readonly status: string;
  readonly version: string;
}

@Injectable()
export class GeneralExpensePaymentService {
  public constructor(
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
    @Inject(AccountingOperationSupport) private readonly support: AccountingOperationSupport,
    @Inject(GeneralExpenseAccountingEventWriter)
    private readonly eventWriter: GeneralExpenseAccountingEventWriter,
  ) {}

  public async createAndConfirm(
    expenseId: string,
    input: CreateGeneralExpensePaymentDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.manage");
    const context = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "general_expense_payment.confirm",
        payload: { expenseId, ...input },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const expense = await this.lockedExpense(transaction, expenseId);
      if (!["approved", "partially_paid"].includes(expense.status)) {
        this.conflict("accounting_general_expense_not_payable");
      }
      if (Number(expense.version) !== input.expenseVersion) {
        this.conflict("accounting_general_expense_stale_version");
      }
      if (
        (context.actorId === expense.createdBy || context.actorId === expense.approvedBy)
        && (await this.support.hasAlternateAuthorizedActor(transaction, "accounting.manage"))
      ) {
        this.conflict("accounting_general_expense_payment_segregation_blocked");
      }
      let amount = new Decimal(0);
      let cashAmount = new Decimal(0);
      let visaAmount = new Decimal(0);
      for (const row of input.rows) {
        let rowAmount: Decimal;
        try {
          rowAmount = new Decimal(row.amount);
        } catch {
          this.conflict("accounting_general_expense_payment_amount_invalid");
        }
        if (!rowAmount!.isFinite() || !rowAmount!.isPositive()) {
          this.conflict("accounting_general_expense_payment_amount_invalid");
        }
        const rounded = rowAmount!.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        if (!rounded.equals(rowAmount!)) {
          this.conflict("accounting_general_expense_payment_amount_invalid");
        }
        await this.assertDestination(transaction, row);
        amount = amount.plus(rounded);
        if (row.paymentMethod === "cash") cashAmount = cashAmount.plus(rounded);
        else visaAmount = visaAmount.plus(rounded);
      }
      if (amount.greaterThan(expense.outstandingAmount)) {
        this.conflict("accounting_general_expense_payment_exceeds_outstanding");
      }
      const paymentNumber = await this.history.nextReferenceNumber(
        transaction,
        context.companyId,
        "general_expense_payment",
        "EXPPAY",
      );
      const payment = await sql<{ correlationId: string; id: string }>`
        insert into general_expense_payments (
          company_id,payment_number,general_expense_id,payment_date,accounting_date,
          amount,cash_amount,visa_amount,reference_number,notes,
          confirmed_by_account_id
        ) values (
          ${context.companyId}::uuid,${paymentNumber},${expenseId}::uuid,
          ${input.paymentDate}::date,${input.accountingDate ?? input.paymentDate}::date,
          ${amount.toFixed(2)}::numeric,${cashAmount.toFixed(2)}::numeric,
          ${visaAmount.toFixed(2)}::numeric,${input.referenceNumber?.trim() || null},
          ${input.notes?.trim() || null},${context.actorId}::uuid
        )
        returning id,correlation_id::text as "correlationId"
      `.execute(transaction);
      const paymentId = payment.rows[0]!.id;
      let rowNumber = 0;
      for (const row of input.rows) {
        rowNumber += 1;
        await sql`
          insert into general_expense_payment_rows (
            company_id,general_expense_payment_id,row_number,payment_method,
            amount,cash_account_id,company_bank_account_id,reference_number,
            created_by_account_id
          ) values (
            ${context.companyId}::uuid,${paymentId}::uuid,${rowNumber},
            ${row.paymentMethod},${new Decimal(row.amount).toFixed(2)}::numeric,
            ${row.cashAccountId ?? null}::uuid,${row.companyBankAccountId ?? null}::uuid,
            ${row.referenceNumber?.trim() || null},${context.actorId}::uuid
          )
        `.execute(transaction);
      }
      const paid = new Decimal(expense.paidAmount).plus(amount);
      const outstanding = new Decimal(expense.outstandingAmount).minus(amount);
      const status = outstanding.isZero() ? "paid" : "partially_paid";
      await sql`
        update general_expenses
           set paid_amount=${paid.toFixed(2)}::numeric,
               outstanding_amount=${outstanding.toFixed(2)}::numeric,
               status=${status},payment_status=${status},
               fully_paid_at=case when ${status}='paid' then now() else null end,
               updated_by_account_id=${context.actorId}::uuid,
               updated_at=now(),version=version+1
         where id=${expenseId}::uuid and company_id=${context.companyId}::uuid
      `.execute(transaction);
      const eventId = await this.eventWriter.enqueue(transaction, {
        accountingDate: input.accountingDate ?? input.paymentDate,
        actorId: context.actorId,
        companyId: context.companyId,
        correlationId: payment.rows[0]!.correlationId,
        description: `General Expense payment ${paymentNumber} confirmed`,
        eventType: "general_expense_payment_completed",
        metadata: {
          cashAmount: cashAmount.toFixed(2),
          expenseId,
          expenseNumber: expense.expenseNumber,
          paymentAmount: amount.toFixed(2),
          paymentNumber,
          visaAmount: visaAmount.toFixed(2),
        },
        sourceEntityId: paymentId,
        sourceEntityType: "general_expense_payment",
        sourceReference: paymentNumber,
      });
      const response = {
        accountingEventId: eventId,
        amount: amount.toFixed(2),
        cashAmount: cashAmount.toFixed(2),
        expenseId,
        outstandingAmount: outstanding.toFixed(2),
        paymentId,
        paymentNumber,
        status: "confirmed",
        visaAmount: visaAmount.toFixed(2),
      };
      await this.support.audit(transaction, {
        action: "general_expense_payment_confirmed",
        after: response,
        correlationId: payment.rows[0]!.correlationId,
        subjectId: paymentId,
        subjectType: "general_expense_payment",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "general_expense_payment.confirm",
        resourceId: paymentId,
        resourceType: "general_expense_payment",
        responseBody: response,
      });
      return response;
    });
  }

  public async reverse(
    paymentId: string,
    input: GeneralExpenseReasonDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.reverse");
    const context = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "general_expense_payment.reverse",
        payload: { paymentId, ...input },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const payment = await this.lockedPayment(transaction, paymentId);
      if (payment.status === "reversed") {
        this.conflict("accounting_general_expense_payment_already_reversed");
      }
      if (Number(payment.version) !== input.version) {
        this.conflict("accounting_general_expense_payment_stale_version");
      }
      const expense = await this.lockedExpense(transaction, payment.expenseId);
      const reasonValue = input.reason.trim();
      if (reasonValue.length === 0) {
        this.conflict("accounting_general_expense_payment_reversal_reason_required");
      }
      await this.support.enforceReversalSegregation(transaction, {
        approvedBy: expense.approvedBy,
        createdBy: expense.createdBy,
        postedBy: payment.confirmedBy,
      });
      const originalEventId = await this.eventWriter.originalEventId(transaction, {
        companyId: context.companyId,
        eventType: "general_expense_payment_completed",
        sourceEntityId: paymentId,
        sourceEntityType: "general_expense_payment",
      });
      await sql`
        update general_expense_payments
           set status='reversed',reversed_by_account_id=${context.actorId}::uuid,
               reversed_at=now(),reversal_reason=${reasonValue},
               updated_at=now(),version=version+1
         where id=${paymentId}::uuid and company_id=${context.companyId}::uuid
      `.execute(transaction);
      const paid = new Decimal(expense.paidAmount).minus(payment.amount);
      if (paid.isNegative()) this.conflict("accounting_general_expense_payment_balance_conflict");
      const approvedAmount = paid.plus(expense.outstandingAmount);
      const outstanding = approvedAmount.minus(paid);
      const expenseStatus = paid.isZero() ? "approved" : "partially_paid";
      await sql`
        update general_expenses
           set paid_amount=${paid.toFixed(2)}::numeric,
               outstanding_amount=${outstanding.toFixed(2)}::numeric,
               status=${expenseStatus},
               payment_status=${paid.isZero() ? "unpaid" : "partially_paid"},
               fully_paid_at=null,updated_by_account_id=${context.actorId}::uuid,
               updated_at=now(),version=version+1
         where id=${payment.expenseId}::uuid and company_id=${context.companyId}::uuid
      `.execute(transaction);
      const eventId = await this.eventWriter.enqueue(transaction, {
        accountingDate: input.accountingDate ?? payment.accountingDate,
        actorId: context.actorId,
        companyId: context.companyId,
        correlationId: payment.correlationId,
        description: `General Expense payment ${payment.paymentNumber} reversed`,
        eventType: "general_expense_payment_reversed",
        metadata: {
          expenseId: payment.expenseId,
          paymentAmount: payment.amount,
          paymentNumber: payment.paymentNumber,
          reason: reasonValue,
        },
        reversalOfEventId: originalEventId,
        sourceEntityId: paymentId,
        sourceEntityType: "general_expense_payment",
        sourceReference: payment.paymentNumber,
      });
      const response = {
        accountingEventId: eventId,
        expenseId: payment.expenseId,
        outstandingAmount: outstanding.toFixed(2),
        paymentId,
        status: "reversed",
      };
      await this.support.audit(transaction, {
        action: "general_expense_payment_reversed",
        after: { ...response, reason: reasonValue },
        correlationId: payment.correlationId,
        subjectId: paymentId,
        subjectType: "general_expense_payment",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "general_expense_payment.reverse",
        resourceId: paymentId,
        resourceType: "general_expense_payment",
        responseBody: response,
      });
      return response;
    });
  }

  private async assertDestination(
    database: Kysely<DatabaseSchema>,
    row: CreateGeneralExpensePaymentDto["rows"][number],
  ): Promise<void> {
    const { companyId } = this.support.context();
    if (row.paymentMethod === "cash") {
      if (row.cashAccountId === undefined || row.companyBankAccountId !== undefined) {
        this.conflict("accounting_general_expense_cash_account_required");
      }
      const account = await sql<{ valid: boolean }>`
        select exists (
          select 1 from chart_of_accounts
           where id=${row.cashAccountId!}::uuid and company_id=${companyId}::uuid
             and is_active and is_posting_account
             and account_type='asset' and account_class='cash'
        ) as valid
      `.execute(database);
      if (!(account.rows[0]?.valid ?? false)) {
        this.conflict("accounting_general_expense_cash_account_invalid");
      }
      return;
    }
    if (row.companyBankAccountId === undefined || row.cashAccountId !== undefined) {
      this.conflict("accounting_general_expense_bank_account_required");
    }
    const bank = await sql<{ valid: boolean }>`
      select exists (
        select 1 from company_bank_accounts
         where id=${row.companyBankAccountId!}::uuid and company_id=${companyId}::uuid
           and is_active and currency='AED'
      ) as valid
    `.execute(database);
    if (!(bank.rows[0]?.valid ?? false)) {
      this.conflict("accounting_general_expense_bank_account_invalid");
    }
  }

  private async lockedExpense(
    database: Kysely<DatabaseSchema>,
    expenseId: string,
  ): Promise<PayableExpense> {
    const { companyId } = this.support.context();
    const result = await sql<PayableExpense>`
      select id,expense_number as "expenseNumber",accounting_date::text as "accountingDate",
             outstanding_amount::text as "outstandingAmount",
             paid_amount::text as "paidAmount",status,
             created_by_account_id as "createdBy",approved_by_account_id as "approvedBy",
             correlation_id::text as "correlationId",version::text
        from general_expenses
       where id=${expenseId}::uuid and company_id=${companyId}::uuid
       for update
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "accounting_general_expense_not_found",
        "The General Expense was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private async lockedPayment(
    database: Kysely<DatabaseSchema>,
    paymentId: string,
  ): Promise<PaymentRecord> {
    const { companyId } = this.support.context();
    const result = await sql<PaymentRecord>`
      select id,payment_number as "paymentNumber",general_expense_id as "expenseId",
             accounting_date::text as "accountingDate",amount::text,status,
             confirmed_by_account_id as "confirmedBy",
             correlation_id::text as "correlationId",version::text
        from general_expense_payments
       where id=${paymentId}::uuid and company_id=${companyId}::uuid
       for update
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "accounting_general_expense_payment_not_found",
        "The General Expense Payment was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private conflict(code: string): never {
    throw new ApplicationException(
      code,
      "The General Expense Payment operation is not allowed",
      HttpStatus.CONFLICT,
    );
  }
}
