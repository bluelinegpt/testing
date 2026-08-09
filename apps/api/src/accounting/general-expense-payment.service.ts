import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import { BalanceEnforcementCoordinator } from "./balance-enforcement.coordinator.js";
import type {
  BalanceEnforcementResult,
  FundingAccountDeduction,
} from "./balance-enforcement.coordinator.js";
import { GeneralExpenseAccountingEventWriter } from "./general-expense-accounting-event.writer.js";
import type {
  CreateGeneralExpensePaymentDto,
  GeneralExpenseReasonDto,
} from "./general-expense.dto.js";
import { PaymentFundingAccountService } from "./payment-funding-account.service.js";

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
    @Inject(PaymentFundingAccountService)
    private readonly fundingAccounts: PaymentFundingAccountService,
    @Inject(BalanceEnforcementCoordinator)
    private readonly balanceEnforcement: BalanceEnforcementCoordinator,
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
      // Segregation of duties on payment release mirrors Journal posting
      // (`enforcePostingSegregation`): the user who APPROVED the expenditure
      // must not also release the money, while another authorized user is
      // available to do it instead.
      //
      // The previous condition also excluded the CREATOR, with `or`. Because
      // create/approve segregation already forces those to be two different
      // people, that barred both of them and made an Expense unpayable in any
      // Company with two Accounting users — a deadlock, not a control. Data
      // entry is not an authorisation step, and dual control is still
      // guaranteed: whoever approved the Expense cannot be the one who pays it.
      if (
        context.actorId === expense.approvedBy &&
        (await this.support.hasAlternateAuthorizedActor(transaction, "accounting.manage"))
      ) {
        this.conflict("accounting_general_expense_payment_segregation_blocked");
      }
      let amount = new Decimal(0);
      let cashAmount = new Decimal(0);
      let visaAmount = new Decimal(0);
      // Positionally aligned with `input.rows`: the GL account each cash row
      // resolved to, derived during validation so the insert below writes the
      // account that was actually checked rather than re-deriving it.
      const cashGlAccountIds: (string | null)[] = [];
      // Deductions, grouped by the account they leave. Two rows drawing on one
      // drawer are ONE deduction of their combined total: judged separately,
      // two 6,000 rows would both pass against a 10,000 balance because nothing
      // ever asked about the 12,000 they add up to.
      //
      // Keyed on the funding account -- the Cash or Bank account -- never the
      // GL account. A GL code can be shared by two Cash accounts, so grouping
      // on it would pool the balances of drawers that are not the same drawer.
      const deductions = new Map<string, { accountId: string; amount: Decimal; kind: "bank" | "cash" }>();
      for (const row of input.rows) {
        let rowAmount: Decimal;
        try {
          rowAmount = new Decimal(row.amount);
        } catch {
          this.conflict("accounting_general_expense_payment_amount_invalid");
        }
        // greaterThan(0): a payment row must carry a real amount, and
        // Decimal.isPositive() is a sign check that accepts zero.
        if (!rowAmount!.isFinite() || !rowAmount!.greaterThan(0)) {
          this.conflict("accounting_general_expense_payment_amount_invalid");
        }
        const rounded = rowAmount!.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        if (!rounded.equals(rowAmount!)) {
          this.conflict("accounting_general_expense_payment_amount_invalid");
        }
        cashGlAccountIds.push(await this.assertDestination(transaction, row));
        // Accumulated only AFTER assertDestination has passed, so a deduction
        // can never name an account this payment was not allowed to use.
        const kind = row.paymentMethod === "cash" ? "cash" : "bank";
        const accountId =
          row.paymentMethod === "cash" ? row.companyCashAccountId! : row.companyBankAccountId!;
        const key = `${kind}:${accountId}`;
        const existing = deductions.get(key);
        deductions.set(key, {
          accountId,
          amount: (existing?.amount ?? new Decimal(0)).plus(rounded),
          kind,
        });
        amount = amount.plus(rounded);
        if (row.paymentMethod === "cash") cashAmount = cashAmount.plus(rounded);
        else visaAmount = visaAmount.plus(rounded);
      }
      if (amount.greaterThan(expense.outstandingAmount)) {
        this.conflict("accounting_general_expense_payment_exceeds_outstanding");
      }
      // Balance control, for every account this payment draws on, in ONE call.
      // The coordinator locks them all in its own deterministic order before
      // reading any balance, so two concurrent split payments over the same
      // pair of accounts queue rather than deadlock -- and so no balance is
      // read that another transaction could still move.
      //
      // All-or-nothing: the coordinator allows only when EVERY account passes,
      // and this throws on anything less. Half a split payment is not a payment
      // the caller asked for, and the Expense would be left part-settled
      // against money that never left.
      const enforcement = await this.balanceEnforcement.evaluate(transaction, {
        actorId: context.actorId,
        actorPermissions: this.support.permissions(),
        deductions: [...deductions.values()].map<FundingAccountDeduction>((entry) => ({
          accountId: entry.accountId,
          amount: entry.amount.toFixed(2),
          kind: entry.kind,
        })),
        sourceType: "general_expense_payment",
        ...(input.balanceOverrideReason === undefined
          ? {}
          : { overrideReason: input.balanceOverrideReason }),
      });
      if (!enforcement.allowed) this.balanceBlocked(enforcement);
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
      for (const [index, row] of input.rows.entries()) {
        rowNumber += 1;
        // Both identities are recorded: the drawer the money left
        // (`company_cash_account_id`) and the GL account it credits
        // (`cash_account_id`). Deriving either from the other later is a guess
        // once a Company reuses a GL code on a replacement Cash Account.
        await sql`
          insert into general_expense_payment_rows (
            company_id,general_expense_payment_id,row_number,payment_method,
            amount,company_cash_account_id,cash_account_id,company_bank_account_id,
            reference_number,created_by_account_id
          ) values (
            ${context.companyId}::uuid,${paymentId}::uuid,${rowNumber},
            ${row.paymentMethod},${new Decimal(row.amount).toFixed(2)}::numeric,
            ${row.companyCashAccountId ?? null}::uuid,${cashGlAccountIds[index] ?? null}::uuid,
            ${row.companyBankAccountId ?? null}::uuid,
            ${row.referenceNumber?.trim() || null},${context.actorId}::uuid
          )
        `.execute(transaction);
      }
      // Only now, with the payment AND all of its rows inserted. One audit per
      // overridden funding account, keyed to this payment; the coordinator
      // skips any that already exist and the unique index behind it makes that
      // a guarantee rather than a check.
      if (enforcement.requiresOverrideAudit) {
        await this.balanceEnforcement.recordOverrides(transaction, {
          actorId: context.actorId,
          overrideReason: input.balanceOverrideReason ?? "",
          result: enforcement,
          sourceEntityId: paymentId,
          sourceReference: paymentNumber,
          sourceType: "general_expense_payment",
        });
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
        // Advisory, never blocking: the balances this payment was judged
        // against exclude confirmed payments that never recorded which account
        // funded them.
        balanceCoverage: enforcement.coverage,
        balanceCoverageIncomplete: enforcement.balanceCoverageIncomplete,
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

  public async reverse(paymentId: string, input: GeneralExpenseReasonDto, idempotencyKey?: string) {
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

  /**
   * Validate a row's destination and, for Cash, DERIVE its GL account.
   *
   * The client names a Cash Account -- the drawer. It does not name the GL
   * account, and is not believed if it tries: the GL id is read from the Cash
   * Account's own `linked_gl_account_id`. Accepting both from the caller would
   * let a valid Cash Account be paired with an unrelated GL account, and the
   * two columns written from that pair would disagree forever with no way to
   * tell which one was the lie.
   *
   * Returns the derived GL account id for a cash row, `null` for Bank/Visa.
   */
  private async assertDestination(
    database: Kysely<DatabaseSchema>,
    row: CreateGeneralExpensePaymentDto["rows"][number],
  ): Promise<string | null> {
    const { companyId } = this.support.context();
    if (row.paymentMethod === "cash") {
      if (row.companyCashAccountId === undefined || row.companyBankAccountId !== undefined) {
        this.conflict("accounting_general_expense_cash_account_required");
      }
      // Company scope, active status and Cash kind, checked once for every
      // workflow that funds a payment.
      const funding = await this.fundingAccounts.resolve(row.companyCashAccountId!, "cash");
      if (funding.linkedGlAccountId === null) {
        this.conflict("accounting_general_expense_cash_account_invalid");
      }
      // The GL account behind the drawer must still be postable today: the same
      // `is_posting_account` gate as before, on an id the client never chose.
      const account = await sql<{ valid: boolean }>`
        select exists (
          select 1 from chart_of_accounts
           where id=${funding.linkedGlAccountId!}::uuid and company_id=${companyId}::uuid
             and is_active and is_posting_account
             and account_type='asset' and account_class='cash'
        ) as valid
      `.execute(database);
      if (!(account.rows[0]?.valid ?? false)) {
        this.conflict("accounting_general_expense_cash_account_invalid");
      }
      return funding.linkedGlAccountId;
    }
    if (row.companyBankAccountId === undefined || row.companyCashAccountId !== undefined) {
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
    return null;
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

  /**
   * Reject a payment the balance policy will not permit, in full.
   *
   * Throwing is what makes this all-or-nothing: it runs inside the confirmation
   * transaction and before the payment header exists, so the rollback undoes
   * the reserved reference number, the Expense row lock and every statement
   * taken so far. No payment, no rows, no Expense status change, no Accounting
   * Event, no Journal, no override audit.
   *
   * Detail formatting comes from the coordinator, which owns the figures, so a
   * split payment blocked on one of two accounts reports both -- kind-labelled,
   * so nobody goes looking at the wrong drawer.
   */
  private balanceBlocked(enforcement: BalanceEnforcementResult): never {
    throw new ApplicationException(
      enforcement.failureCode ?? "balance_would_go_negative",
      enforcement.failureReason ?? "This payment is not permitted by the balance policy",
      HttpStatus.CONFLICT,
      this.balanceEnforcement.blockedDetails(enforcement),
    );
  }

  private conflict(code: string): never {
    throw new ApplicationException(
      code,
      "The General Expense Payment operation is not allowed",
      HttpStatus.CONFLICT,
    );
  }
}
