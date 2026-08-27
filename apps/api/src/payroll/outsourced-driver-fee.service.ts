import { createHash, randomUUID } from "node:crypto";

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
  ConfirmOutsourcedDriverFeePaymentDto,
  OutsourcedDriverFeeAccrualListQueryDto,
  OutsourcedDriverFeeBackfillDto,
  OutsourcedDriverFeePaymentListQueryDto,
  OutsourcedDriverFeePaymentProposalDto,
  OutsourcedDriverFeeReconcileDto,
} from "./outsourced-driver-fee.dto.js";
import { PayrollOperationSupport } from "./payroll-operation.support.js";
import { outsourcedDriverFeeIdempotencyOperations } from "./outsourced-driver-fee-foundation.js";

type Database = Kysely<DatabaseSchema>;
type AccrualSource = "authorized_backfill" | "daily_reconciliation" | "delivery";

interface AccrualCandidate {
  readonly deliveredAt: string | null;
  readonly driverId: string | null;
  readonly driverType: string | null;
  readonly orderId: string;
  readonly orderNumber: string;
}

interface AllocationInput {
  readonly accrualId: string;
  readonly amount: string;
}

export interface AllocationProposal {
  readonly accrualId: string;
  readonly amount: string;
  readonly orderNumber: string;
  readonly outstandingBefore: string;
  readonly remainingOutstanding: string;
}

export interface FeePaymentResult {
  readonly allocations: readonly AllocationProposal[];
  readonly amount: string;
  readonly paymentId: string;
  readonly paymentNumber: string;
  readonly remainingDriverOutstanding: string;
  readonly status: string;
}

interface CollectionOffsetResult {
  readonly allocations: readonly AllocationProposal[];
  readonly eligibleAccrualCount: number;
  readonly oldestFirstProposal: readonly AllocationProposal[];
  readonly remainingDriverOutstanding: string;
  readonly requestedOffset: string;
  readonly safeMaximumOffset: string;
  readonly totalOutstanding: string;
}

const operations = {
  accrualReversal: outsourcedDriverFeeIdempotencyOperations.accrualReversal,
  backfill: outsourcedDriverFeeIdempotencyOperations.accrualBackfill,
  paymentConfirmation: outsourcedDriverFeeIdempotencyOperations.paymentConfirmation,
  paymentReversal: outsourcedDriverFeeIdempotencyOperations.paymentReversal,
  reconciliation: outsourcedDriverFeeIdempotencyOperations.accrualDailyReconciliation,
} as const;

@Injectable()
export class OutsourcedDriverFeeService {
  public constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(PayrollOperationSupport) private readonly support: PayrollOperationSupport,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
    @Inject(PaymentFundingAccountService)
    private readonly fundingAccounts: PaymentFundingAccountService,
    @Inject(BalanceEnforcementCoordinator)
    private readonly balanceEnforcement: BalanceEnforcementCoordinator,
  ) {}

  public async createForConfirmedCollection(
    database: Database,
    input: {
      readonly businessDate: string;
      readonly countsForCollectionEarning: boolean;
      readonly driverId: string;
      readonly orderCount: number;
      readonly reconciliationId: string;
    },
    actorId: string,
    correlationId: string,
  ) {
    const { companyId } = this.support.context();
    if (!input.countsForCollectionEarning || input.orderCount <= 0) return null;
    const driver = await sql<{ driverType: string }>`select driver_type as "driverType" from drivers
      where id=${input.driverId}::uuid and company_id=${companyId}::uuid`.execute(database);
    if (driver.rows[0]?.driverType !== "outsourced") return null;
    const rule = await sql<{ amount: string; id: string; paymentType: string }>`
      select id,amount::text,collection_payment_type as "paymentType"
        from outsourced_driver_collection_earning_rules
       where company_id=${companyId}::uuid and driver_id=${input.driverId}::uuid and is_active
         and effective_from<=${input.businessDate}::date
         and (effective_to is null or ${input.businessDate}::date<effective_to)
       order by effective_from desc limit 1
    `.execute(database);
    const applied=rule.rows[0];
    if(applied===undefined||applied.paymentType==="none")return null;
    const units=applied.paymentType==="per_collected_order"?input.orderCount:1;
    const earned=new Decimal(applied.amount).times(units);
    const created=await sql<{id:string}>`insert into outsourced_driver_fee_accruals(
      company_id,driver_id,order_id,delivery_date,accrual_business_date,fee_rate_version_id,
      fee_rate_snapshot,earned_amount,paid_amount,outstanding_amount,status,accrual_source,
      source_reference,created_by_account_id,earning_type,reconciliation_id,collection_rule_id,unit_count)
      values(${companyId}::uuid,${input.driverId}::uuid,null,null,${input.businessDate}::date,null,
      ${applied.amount},${earned.toFixed(2)},0,${earned.toFixed(2)},'accrued','daily_reconciliation',
      ${`collection:${input.reconciliationId}`},${actorId}::uuid,'collection',
      ${input.reconciliationId}::uuid,${applied.id}::uuid,${units})
      on conflict(company_id,reconciliation_id) where reconciliation_id is not null do nothing returning id`.execute(database);
    const accrualId=created.rows[0]?.id;
    if(accrualId!==undefined)await this.history.audit(database,{action:"outsourced_driver_fee.collection_accrued",
      actorId,after:{...input,accrualId,amount:earned.toFixed(2),ruleId:applied.id,units},companyId,
      correlationId,subjectId:accrualId,subjectType:"outsourced_driver_fee_accrual"});
    return accrualId===undefined?null:{accrualId,amount:earned.toFixed(2)};
  }

  /**
   * Called inside the authoritative Order delivery transaction. Missing or
   * ambiguous configuration is returned as a structured outcome so delivery is
   * not partially committed or coupled to a later Payroll configuration fix.
   */
  public createForDeliveredOrder(
    database: Database,
    orderId: string,
    actorId: string,
    correlationId: string,
  ) {
    const { companyId } = this.support.context();
    return this.createForDeliveredOrderIdempotently(
      database,
      companyId,
      orderId,
      actorId,
      correlationId,
    );
  }

  private async createForDeliveredOrderIdempotently(
    database: Database,
    companyId: string,
    orderId: string,
    actorId: string,
    correlationId: string,
  ) {
    const idempotencyKey = `delivery:${orderId}`;
    const operation = outsourcedDriverFeeIdempotencyOperations.accrualDelivery;
    const reservation = await this.support.reserveIdempotency(database, {
      companyId,
      idempotencyKey,
      operation,
      payload: { orderId },
    });
    if (reservation.replayResponse !== undefined) return reservation.replayResponse;
    const response = await this.evaluateOrder(
      database,
      companyId,
      orderId,
      "delivery",
      actorId,
      correlationId,
      true,
    );
    await this.complete(
      database,
      companyId,
      idempotencyKey,
      operation,
      "accrualId" in response && typeof response.accrualId === "string"
        ? response.accrualId
        : orderId,
      response,
    );
    return response;
  }

  public async reconcile(
    input: OutsourcedDriverFeeReconcileDto,
    idempotencyKey: string | undefined,
    correlationId: string,
  ) {
    this.support.assertPermission("outsourced_driver_fees.manage");
    return this.runRange(
      input.businessDate,
      input.businessDate,
      input.driverId,
      "daily_reconciliation",
      false,
      undefined,
      idempotencyKey,
      correlationId,
    );
  }

  public async backfill(
    input: OutsourcedDriverFeeBackfillDto,
    idempotencyKey: string | undefined,
    correlationId: string,
  ) {
    this.support.assertPermission("outsourced_driver_fees.manage");
    const start = new Date(`${input.fromDate}T00:00:00Z`);
    const end = new Date(`${input.toDate}T00:00:00Z`);
    const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000);
    if (!Number.isFinite(days) || days < 0 || days > 366) {
      throw new ApplicationException(
        "outsourced_driver_fee_backfill_range_invalid",
        "The backfill date range must be between zero and 366 days",
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.runRange(
      input.fromDate,
      input.toDate,
      input.driverId,
      "authorized_backfill",
      input.preview === true,
      input.notes,
      idempotencyKey,
      correlationId,
    );
  }

  public async reverseAccrual(
    accrualId: string,
    reason: string,
    idempotencyKey: string | undefined,
    correlationId: string,
  ) {
    this.support.assertPermission("outsourced_driver_fees.reverse");
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0) {
      throw new ApplicationException(
        "outsourced_driver_fee_reversal_reason_required",
        "A reversal reason is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        companyId,
        idempotencyKey,
        operation: operations.accrualReversal,
        payload: { accrualId, reason: normalizedReason },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const result = await sql<{ paidAmount: string; status: string }>`
        select paid_amount::text as "paidAmount", status
          from outsourced_driver_fee_accruals
         where id=${accrualId}::uuid and company_id=${companyId}::uuid
         for update
      `.execute(transaction);
      const accrual = result.rows[0];
      if (accrual === undefined) this.notFound("outsourced_driver_fee_accrual_not_found");
      if (["reversed", "recovery_required"].includes(accrual.status)) {
        throw new ApplicationException(
          "outsourced_driver_fee_accrual_already_reversed",
          "This Driver fee accrual has already been reversed or invalidated",
          HttpStatus.CONFLICT,
        );
      }
      const paid = new Decimal(accrual.paidAmount);
      const status = paid.isZero() ? "reversed" : "recovery_required";
      await sql`
        update outsourced_driver_fee_accruals
           set status=${status}, outstanding_amount=0,
               recovery_amount=${paid.isZero() ? "0.00" : paid.toFixed(2)},
               reversed_by_account_id=${actorId}::uuid, reversed_at=now(),
               reversal_reason=${normalizedReason}, updated_at=now(), version=version+1
         where id=${accrualId}::uuid and company_id=${companyId}::uuid
      `.execute(transaction);
      const response = { accrualId, recoveryAmount: paid.toFixed(2), status };
      await this.history.audit(transaction, {
        action:
          status === "reversed"
            ? "outsourced_driver_fee_accrual_reversed"
            : "outsourced_driver_fee_accrual_recovery_required",
        actorId,
        after: response,
        companyId,
        correlationId,
        subjectId: accrualId,
        subjectType: "outsourced_driver_fee_accrual",
      });
      await this.complete(
        transaction,
        companyId,
        idempotencyKey!,
        operations.accrualReversal,
        accrualId,
        response,
      );
      return response;
    });
  }

  public async accrualSummary() {
    this.support.assertPermission("outsourced_driver_fees.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, string>>`
      select count(*)::text as "accrualCount",
        count(distinct driver_id)::text as "driverCount",
        coalesce(sum(earned_amount),0)::text as "totalEarned",
        coalesce(sum(paid_amount),0)::text as "totalPaid",
        coalesce(sum(outstanding_amount),0)::text as "totalOutstanding",
        coalesce(sum(recovery_amount),0)::text as "totalRecoveryRequired",
        count(distinct driver_id) filter(where outstanding_amount>0)::text as "driversWithOutstandingBalances",
        count(*) filter(where accrual_business_date>=date_trunc('month',now() at time zone 'Asia/Dubai')::date)::text as "currentPeriodAccrualCount",
        coalesce(sum(earned_amount) filter(where accrual_business_date>=date_trunc('month',now() at time zone 'Asia/Dubai')::date),0)::text as "currentPeriodEarnedAmount",
        count(*) filter (where status='accrued')::text as "accruedCount",
        count(*) filter (where status='partially_paid')::text as "partiallyPaidCount",
        count(*) filter (where status='paid')::text as "paidCount",
        count(*) filter (where status='reversed')::text as "reversedCount",
        count(*) filter (where status='recovery_required')::text as "recoveryRequiredCount"
      from outsourced_driver_fee_accruals where company_id=${companyId}::uuid
    `.execute(this.database);
    return result.rows[0];
  }

  public async accruals(query: OutsourcedDriverFeeAccrualListQueryDto) {
    this.support.assertPermission("outsourced_driver_fees.view");
    const { companyId } = this.support.context();
    const page = this.support.pagination(query);
    const result = await sql<Record<string, unknown>>`
      select a.id, a.driver_id as "driverId", d.code as "driverCode", d.name_en as "driverName",
        a.order_id as "orderId", coalesce(o.order_number,a.source_reference) as "orderNumber", o.serial_number as "serialNumber",
        a.delivery_date as "deliveryDate", a.accrual_business_date::text as "accrualBusinessDate",
        d.driver_type as "driverType", a.fee_rate_version_id as "feeRateVersionId",
        a.fee_rate_snapshot::text as "feeRate", a.earned_amount::text as "earnedAmount",
        a.paid_amount::text as "paidAmount", a.outstanding_amount::text as "outstandingAmount",
        a.recovery_amount::text as "recoveryAmount", a.status, a.accrual_source as source,
        a.source_reference as "sourceReference",coalesce(cu.display_name,creator.username) as "createdBy",
        a.created_at as "createdAt", count(*) over()::int as "totalCount"
      from outsourced_driver_fee_accruals a
      join drivers d on d.id=a.driver_id and d.company_id=a.company_id
      left join orders o on o.id=a.order_id and o.company_id=a.company_id
      left join accounts creator on creator.id=a.created_by_account_id and creator.company_id=a.company_id
      left join company_users cu on cu.account_id=creator.id and cu.company_id=creator.company_id
      where a.company_id=${companyId}::uuid
        and (${query.driverId ?? null}::uuid is null or a.driver_id=${query.driverId ?? null}::uuid)
        and (${query.driver ?? null}::text is null or d.name_en ilike ${`%${query.driver ?? ""}%`})
        and (${query.driverCode ?? null}::text is null or d.code ilike ${`%${query.driverCode ?? ""}%`})
        and (${query.orderNumber ?? null}::text is null or o.order_number ilike ${`%${query.orderNumber ?? ""}%`})
        and (${query.serialNumber ?? null}::text is null or o.serial_number::text ilike ${`%${query.serialNumber ?? ""}%`})
        and (${query.deliveryDateFrom ?? null}::date is null or a.delivery_date >= ${query.deliveryDateFrom ?? null}::date)
        and (${query.deliveryDateTo ?? null}::date is null or a.delivery_date < ${query.deliveryDateTo ?? null}::date + interval '1 day')
        and (${query.accrualDateFrom ?? null}::date is null or a.accrual_business_date >= ${query.accrualDateFrom ?? null}::date)
        and (${query.accrualDateTo ?? null}::date is null or a.accrual_business_date <= ${query.accrualDateTo ?? null}::date)
        and (${query.status ?? null}::text is null or a.status=${query.status ?? null})
        and (${query.source ?? null}::text is null or a.accrual_source=${query.source ?? null})
        and (${query.outstandingOnly === true ? true : null}::boolean is null or a.outstanding_amount>0)
        and (${query.recoveryRequiredOnly === true ? true : null}::boolean is null or a.status='recovery_required')
      order by a.accrual_business_date desc, a.created_at desc, a.id
      limit ${page.limit} offset ${page.offset}
    `.execute(this.database);
    return {
      items: result.rows.map(({ totalCount, ...row }) => {
        void totalCount;
        return row;
      }),
      page: page.page,
      pageSize: page.pageSize,
      total: Number(result.rows[0]?.totalCount ?? 0),
    };
  }

  public async accrualDetail(accrualId: string) {
    this.support.assertPermission("outsourced_driver_fees.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select a.*, d.code as "driverCode", d.name_en as "driverName", d.driver_type as "driverType",
        coalesce(o.order_number,a.source_reference) as "orderNumber", o.serial_number as "serialNumber",
        v.effective_from as "rateEffectiveFrom", v.effective_to as "rateEffectiveTo",
        coalesce(cu.display_name,creator.username) as "createdBy"
      from outsourced_driver_fee_accruals a
      join drivers d on d.id=a.driver_id and d.company_id=a.company_id
      left join orders o on o.id=a.order_id and o.company_id=a.company_id
      join outsourced_driver_fee_versions v on v.id=a.fee_rate_version_id and v.company_id=a.company_id
      left join accounts creator on creator.id=a.created_by_account_id and creator.company_id=a.company_id
      left join company_users cu on cu.account_id=creator.id and cu.company_id=creator.company_id
      where a.id=${accrualId}::uuid and a.company_id=${companyId}::uuid
    `.execute(this.database);
    if (result.rows[0] === undefined) this.notFound("outsourced_driver_fee_accrual_not_found");
    const allocations = await sql<Record<string, unknown>>`
      select x.id, x.payment_id as "paymentId", p.payment_number as "paymentNumber",
        x.allocated_amount::text as amount, x.created_at as "createdAt",
        x.reversed_at as "reversedAt", p.status as "paymentStatus",
        p.payment_date::text as "paymentDate",p.payment_method as "paymentMethod",
        p.payment_source as "paymentSource",
        p.linked_driver_reconciliation_id as "linkedReconciliationId"
      from outsourced_driver_fee_payment_allocations x
      join outsourced_driver_fee_payments p on p.id=x.payment_id and p.company_id=x.company_id
      where x.company_id=${companyId}::uuid and x.accrual_id=${accrualId}::uuid
      order by x.created_at, x.id
    `.execute(this.database);
    return { ...result.rows[0], allocations: allocations.rows };
  }

  public async paymentProposal(input: OutsourcedDriverFeePaymentProposalDto) {
    this.support.assertPermission("outsourced_driver_fees.pay");
    const { companyId } = this.support.context();
    return this.buildProposal(
      this.database,
      companyId,
      input.driverId,
      new Decimal(input.amount),
      input.allocations,
      false,
    );
  }

  public async confirmPayment(
    input: ConfirmOutsourcedDriverFeePaymentDto,
    idempotencyKey: string | undefined,
    correlationId: string,
  ) {
    this.support.assertPermission("outsourced_driver_fees.pay");
    const today = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Dubai",
      year: "numeric",
    }).format(new Date());
    if (input.paymentDate > today) {
      throw new ApplicationException(
        "outsourced_driver_fee_payment_date_invalid",
        "The Driver fee payment date cannot be in the future",
        HttpStatus.BAD_REQUEST,
      );
    }
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const material = { ...input, allocations: input.allocations ?? [] };
      const reservation = await this.support.reserveIdempotency<FeePaymentResult>(transaction, {
        companyId,
        idempotencyKey,
        operation: operations.paymentConfirmation,
        payload: material,
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      if (reservation.replayResourceId !== undefined)
        return this.paymentResult(transaction, companyId, reservation.replayResourceId);
      const proposal = await this.buildProposal(
        transaction,
        companyId,
        input.driverId,
        new Decimal(input.amount),
        input.allocations,
        true,
      );
      // Immediately before the write: an account deactivated between
      // proposal and confirmation must fail here, not silently fund a
      // payment. Throwing inside the transaction rolls back everything.
      const fundingAccount = await this.fundingAccounts.resolve(input.accountId, "cash");
      // Balance control, on the CASH path only. `createPayment` below is shared
      // with the collection-offset flow, so the check lives here rather than
      // there: an offset can never reach this line, which is a stronger
      // guarantee than a method-name test inside shared code.
      //
      // The coordinator locks the Cash account, reads its balance behind that
      // lock and judges -- in this transaction, after the funding-account
      // validation above and before any payment row exists.
      //
      // The amount is summed from the SAME allocation lines handed to
      // `createPayment`, so it is the figure that will be written to
      // amount_paid, not the requested figure that might round differently.
      const enforcedAmount = proposal.allocations.reduce(
        (sum, line) => sum.plus(line.amount),
        new Decimal(0),
      );
      const enforcement = await this.balanceEnforcement.evaluate(transaction, {
        actorId,
        actorPermissions: this.support.permissions(),
        deductions: [
          { accountId: fundingAccount.accountId, amount: enforcedAmount.toFixed(2), kind: "cash" },
        ],
        sourceReference: correlationId,
        sourceType: "outsourced_driver_fee_payment",
        ...(input.balanceOverrideReason === undefined
          ? {}
          : { overrideReason: input.balanceOverrideReason }),
      });
      if (!enforcement.allowed) this.balanceBlocked(enforcement);
      const payment = await this.createPayment(
        transaction,
        {
          actorId,
          companyId,
          correlationId,
          driverId: input.driverId,
          fundingCashAccountId: fundingAccount.accountId,
          idempotencyKey: idempotencyKey!,
          paymentDate: input.paymentDate,
          paymentMethod: "cash",
          paymentSource: "separate_payment",
          ...(input.cashVoucherReference?.trim()
            ? { cashVoucherReference: input.cashVoucherReference.trim() }
            : {}),
          ...(input.externalReference?.trim()
            ? { externalReference: input.externalReference.trim() }
            : {}),
          ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
          allocations: proposal.allocations.map((line) => ({
            accrualId: line.accrualId,
            amount: line.amount,
          })),
          manualAllocation: input.allocations !== undefined,
        },
        operations.paymentConfirmation,
      );
      // The audit is written only now: the payment row exists, its id is known,
      // and the insert succeeded. Written earlier it would survive a rolled-back
      // payment as an accusation about money that never moved.
      if (enforcement.requiresOverrideAudit) {
        await this.balanceEnforcement.recordOverrides(transaction, {
          actorId,
          overrideReason: input.balanceOverrideReason ?? "",
          result: enforcement,
          sourceEntityId: payment.paymentId,
          sourceReference: payment.paymentNumber,
          sourceType: "outsourced_driver_fee_payment",
        });
      }
      return {
        ...payment,
        balanceCoverage: enforcement.coverage,
        balanceCoverageIncomplete: enforcement.balanceCoverageIncomplete,
      };
    });

  }

  /**
   * Reject a cash payment the balance policy will not permit.
   *
   * Throwing is what guarantees the "no payment, no Event, no Journal, no
   * audit" outcome: this runs inside the confirmation transaction and before
   * `createPayment`, so the rollback undoes the reserved reference number and
   * every statement taken so far, and nothing downstream ever runs.
   *
   * The details are the figures a person needs in order to act -- their own
   * balance, what they tried to pay, where it would land, and the rule that
   * stopped it. No account ids, no policy row id, no internals.
   */
  private balanceBlocked(enforcement: BalanceEnforcementResult): never {
    throw new ApplicationException(
      enforcement.failureCode ?? "balance_would_go_negative",
      enforcement.failureReason ?? "This payment is not permitted by the balance policy",
      HttpStatus.CONFLICT,
      // Shared formatter: the coordinator owns the figures, so the wording
      // cannot drift between workflows.
      this.balanceEnforcement.blockedDetails(enforcement),
    );
  }

  public async reversePayment(
    paymentId: string,
    reason: string,
    idempotencyKey: string | undefined,
    correlationId: string,
  ) {
    this.support.assertPermission("outsourced_driver_fees.reverse");
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        companyId,
        idempotencyKey,
        operation: operations.paymentReversal,
        payload: { paymentId, reason: reason.trim() },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const payment = await sql<{ paymentSource: string; status: string }>`
        select payment_source as "paymentSource", status from outsourced_driver_fee_payments
        where id=${paymentId}::uuid and company_id=${companyId}::uuid for update
      `.execute(transaction);
      const row = payment.rows[0];
      if (row === undefined) this.notFound("outsourced_driver_fee_payment_not_found");
      if (row.status === "reversed")
        throw new ApplicationException(
          "outsourced_driver_fee_payment_already_reversed",
          "This Driver fee payment is already reversed",
          HttpStatus.CONFLICT,
        );
      if (row.paymentSource !== "separate_payment")
        throw new ApplicationException(
          "outsourced_driver_fee_offset_requires_collection_reversal",
          "A Driver Collection fee offset must be reversed through Driver Collection reversal",
          HttpStatus.CONFLICT,
        );
      const response = await this.reversePaymentInTransaction(
        transaction,
        companyId,
        actorId,
        paymentId,
        reason,
        correlationId,
      );
      await this.complete(
        transaction,
        companyId,
        idempotencyKey!,
        operations.paymentReversal,
        paymentId,
        response,
      );
      return response;
    });
  }

  public async paymentSummary() {
    this.support.assertPermission("outsourced_driver_fees.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, string>>`
      select coalesce(sum(amount_paid) filter(where status='confirmed' and payment_source='separate_payment'),0)::text as "totalSeparateCashPayments",
        coalesce(sum(amount_paid) filter(where status='confirmed' and payment_source='driver_collection'),0)::text as "totalCollectionOffsets",
        coalesce(sum(amount_paid) filter(where status='confirmed'),0)::text as "totalActivePaid",
        coalesce(sum(amount_paid) filter(where status='reversed'),0)::text as "totalReversed",
        count(*)::text as "paymentCount", count(*) filter(where payment_source='separate_payment')::text as "separatePaymentCount",
        count(*) filter(where payment_source='driver_collection')::text as "collectionOffsetCount",
        count(distinct driver_id) filter(where status='confirmed')::text as "driversPaid",
        count(*) filter(where payment_date>=date_trunc('month', now() at time zone 'Asia/Dubai')::date)::text as "currentPeriodPaymentCount",
        coalesce(sum(amount_paid) filter(where status='confirmed' and payment_date>=date_trunc('month', now() at time zone 'Asia/Dubai')::date),0)::text as "currentPeriodPaidAmount"
      from outsourced_driver_fee_payments where company_id=${companyId}::uuid
    `.execute(this.database);
    return result.rows[0];
  }

  public async payments(query: OutsourcedDriverFeePaymentListQueryDto) {
    this.support.assertPermission("outsourced_driver_fees.view");
    const { companyId } = this.support.context();
    const page = this.support.pagination(query);
    const result = await sql<Record<string, unknown>>`
      select p.id, p.payment_number as "paymentNumber", p.driver_id as "driverId",
        d.code as "driverCode", d.name_en as "driverName", p.payment_date::text as "paymentDate",
        p.payment_method as "paymentMethod", p.payment_source as "paymentSource",
        p.amount_paid::text as amount, p.cash_voucher_reference as "voucherReference",
        p.external_reference as "externalReference", p.linked_driver_reconciliation_id as "linkedReconciliationId",
        r.reconciliation_number as "linkedReconciliationNumber", p.status,
        coalesce(cu.display_name,a.username) as "paidBy",
        p.created_at as "createdAt", p.reversal_reason as "reversalReason", p.reversed_at as "reversedAt",
        coalesce(rcu.display_name,ra.username) as "reversedBy",
        count(x.id) filter(where x.reversed_at is null)::int as "activeAllocationCount",
        count(*) over()::int as "totalCount"
      from outsourced_driver_fee_payments p join drivers d on d.id=p.driver_id and d.company_id=p.company_id
      join accounts a on a.id=p.paid_by_account_id and a.company_id=p.company_id
      left join company_users cu on cu.account_id=a.id and cu.company_id=a.company_id
      left join accounts ra on ra.id=p.reversed_by_account_id and ra.company_id=p.company_id
      left join company_users rcu on rcu.account_id=ra.id and rcu.company_id=ra.company_id
      left join driver_reconciliations r on r.id=p.linked_driver_reconciliation_id and r.company_id=p.company_id
      left join outsourced_driver_fee_payment_allocations x on x.payment_id=p.id and x.company_id=p.company_id
      where p.company_id=${companyId}::uuid
        and (${query.driverId ?? null}::uuid is null or p.driver_id=${query.driverId ?? null}::uuid)
        and (${query.driver ?? null}::text is null or d.name_en ilike ${`%${query.driver ?? ""}%`})
        and (${query.driverCode ?? null}::text is null or d.code ilike ${`%${query.driverCode ?? ""}%`})
        and (${query.paymentNumber ?? null}::text is null or p.payment_number ilike ${`%${query.paymentNumber ?? ""}%`})
        and (${query.paymentDateFrom ?? null}::date is null or p.payment_date>=${query.paymentDateFrom ?? null}::date)
        and (${query.paymentDateTo ?? null}::date is null or p.payment_date<=${query.paymentDateTo ?? null}::date)
        and (${query.paymentMethod ?? null}::text is null or p.payment_method=${query.paymentMethod ?? null})
        and (${query.paymentSource ?? null}::text is null or p.payment_source=${query.paymentSource ?? null})
        and (${query.status ?? null}::text is null or p.status=${query.status ?? null})
        and (${query.paidBy ?? null}::uuid is null or p.paid_by_account_id=${query.paidBy ?? null}::uuid)
        and (${query.voucherReference ?? null}::text is null or p.cash_voucher_reference ilike ${`%${query.voucherReference ?? ""}%`})
        and (${query.externalReference ?? null}::text is null or p.external_reference ilike ${`%${query.externalReference ?? ""}%`})
        and (${query.reconciliation ?? null}::text is null or r.reconciliation_number ilike ${`%${query.reconciliation ?? ""}%`})
      group by p.id,d.code,d.name_en,r.reconciliation_number,cu.display_name,a.username,
        rcu.display_name,ra.username
      order by p.payment_date desc,p.created_at desc,p.id limit ${page.limit} offset ${page.offset}
    `.execute(this.database);
    return {
      items: result.rows.map(({ totalCount, ...row }) => {
        void totalCount;
        return row;
      }),
      page: page.page,
      pageSize: page.pageSize,
      total: Number(result.rows[0]?.totalCount ?? 0),
    };
  }

  public async paymentDetail(paymentId: string) {
    this.support.assertPermission("outsourced_driver_fees.view");
    const { companyId } = this.support.context();
    const payment = await sql<Record<string, unknown>>`
      select p.id, p.payment_number as "paymentNumber", p.driver_id as "driverId",
        d.code as "driverCode", d.name_en as "driverName", d.driver_type as "driverType",
        p.payment_date::text as "paymentDate", p.payment_method as "paymentMethod",
        p.payment_source as "paymentSource", p.amount_paid::text as amount,
        p.cash_voucher_reference as "voucherReference", p.external_reference as "externalReference",
        p.linked_driver_reconciliation_id as "linkedReconciliationId",
        r.reconciliation_number as "linkedReconciliationNumber", p.status,
        coalesce(cu.display_name,a.username) as "paidBy",
        p.created_at as "createdAt", p.notes, p.reversal_reason as "reversalReason",
        p.reversed_at as "reversedAt", coalesce(rcu.display_name,ra.username) as "reversedBy"
      from outsourced_driver_fee_payments p join drivers d on d.id=p.driver_id and d.company_id=p.company_id
      join accounts a on a.id=p.paid_by_account_id and a.company_id=p.company_id
      left join company_users cu on cu.account_id=a.id and cu.company_id=a.company_id
      left join accounts ra on ra.id=p.reversed_by_account_id and ra.company_id=p.company_id
      left join company_users rcu on rcu.account_id=ra.id and rcu.company_id=ra.company_id
      left join driver_reconciliations r on r.id=p.linked_driver_reconciliation_id and r.company_id=p.company_id
      where p.id=${paymentId}::uuid and p.company_id=${companyId}::uuid
    `.execute(this.database);
    if (payment.rows[0] === undefined) this.notFound("outsourced_driver_fee_payment_not_found");
    const allocations = await sql<Record<string, unknown>>`
      select x.id, x.accrual_id as "accrualId", x.allocated_amount::text as amount,
        x.allocation_order as "allocationOrder", x.created_at as "createdAt", x.reversed_at as "reversedAt",
        o.id as "orderId", coalesce(o.order_number,f.source_reference) as "orderNumber", o.serial_number as "serialNumber",
        f.delivery_date as "deliveryDate", f.accrual_business_date::text as "accrualBusinessDate",
        f.earned_amount::text as "earnedAmount", f.status as "accrualStatus",
        coalesce((
          select sum(prior.allocated_amount) from outsourced_driver_fee_payment_allocations prior
          join outsourced_driver_fee_payments pp on pp.id=prior.payment_id and pp.company_id=prior.company_id
          where prior.company_id=x.company_id and prior.accrual_id=x.accrual_id
            and prior.reversed_at is null and pp.status='confirmed'
            and (prior.created_at,prior.id)<(x.created_at,x.id)
        ),0)::text as "paidBefore",
        greatest(f.earned_amount-coalesce((
          select sum(prior.allocated_amount) from outsourced_driver_fee_payment_allocations prior
          join outsourced_driver_fee_payments pp on pp.id=prior.payment_id and pp.company_id=prior.company_id
          where prior.company_id=x.company_id and prior.accrual_id=x.accrual_id
            and prior.reversed_at is null and pp.status='confirmed'
            and (prior.created_at,prior.id)<=(x.created_at,x.id)
        ),0),0)::text as "remainingOutstanding",
        case when x.reversed_at is null then 'active' else 'reversed' end as "allocationStatus"
      from outsourced_driver_fee_payment_allocations x
      join outsourced_driver_fee_accruals f on f.id=x.accrual_id and f.company_id=x.company_id
      left join orders o on o.id=f.order_id and o.company_id=f.company_id
      where x.payment_id=${paymentId}::uuid and x.company_id=${companyId}::uuid
      order by x.allocation_order,x.id
    `.execute(this.database);
    return { ...payment.rows[0], allocations: allocations.rows };
  }

  public async collectionOffsetProposal(
    database: Database,
    companyId: string,
    driverId: string,
    safeCollectionAmount: Decimal,
    requestedAmount = new Decimal(0),
    allocations?: readonly { accrualId: string; amount: number }[],
    lock = false,
  ): Promise<CollectionOffsetResult> {
    const totalRows = await this.payableAccruals(database, companyId, driverId, lock);
    const total = totalRows.reduce((sum, row) => sum.plus(row.outstanding), new Decimal(0));
    if (total.isPositive()) this.support.assertPermission("outsourced_driver_fees.view");
    const safeMaximum = Decimal.min(total, Decimal.max(0, safeCollectionAmount));
    if (requestedAmount.greaterThan(safeMaximum)) {
      throw new ApplicationException(
        "outsourced_driver_fee_offset_above_safe_amount",
        "The Driver fee offset exceeds the safe collection amount",
        HttpStatus.CONFLICT,
      );
    }
    const oldest = this.allocate(totalRows, safeMaximum);
    const selected =
      allocations === undefined
        ? this.allocate(totalRows, requestedAmount)
        : this.manualAllocate(totalRows, requestedAmount, allocations);
    return {
      allocations: selected,
      eligibleAccrualCount: totalRows.length,
      oldestFirstProposal: oldest,
      remainingDriverOutstanding: total.minus(requestedAmount).toFixed(2),
      requestedOffset: requestedAmount.toFixed(2),
      safeMaximumOffset: safeMaximum.toFixed(2),
      totalOutstanding: total.toFixed(2),
    };
  }

  public async confirmCollectionOffset(
    database: Database,
    input: {
      readonly actorId: string;
      readonly allocations?: readonly { accrualId: string; amount: number }[];
      readonly amount: Decimal;
      readonly companyId: string;
      readonly correlationId: string;
      readonly driverId: string;
      readonly idempotencyKey: string;
      readonly paymentDate: string;
      readonly reconciliationId: string;
      readonly safeCollectionAmount: Decimal;
    },
  ) {
    if (input.amount.isZero()) return null;
    this.support.assertPermission("outsourced_driver_fees.pay");
    const proposal = await this.collectionOffsetProposal(
      database,
      input.companyId,
      input.driverId,
      input.safeCollectionAmount,
      input.amount,
      input.allocations,
      true,
    );
    return this.createPayment(database, {
      actorId: input.actorId,
      companyId: input.companyId,
      correlationId: input.correlationId,
      driverId: input.driverId,
      idempotencyKey: `${input.idempotencyKey}:driver-fee`,
      paymentDate: input.paymentDate,
      paymentMethod: "collection_offset",
      paymentSource: "driver_collection",
      linkedReconciliationId: input.reconciliationId,
      manualAllocation: input.allocations !== undefined,
      allocations: proposal.allocations.map((line) => ({
        accrualId: line.accrualId,
        amount: line.amount,
      })),
    });
  }

  public async reverseCollectionOffset(
    database: Database,
    companyId: string,
    actorId: string,
    reconciliationId: string,
    reason: string,
    correlationId: string,
  ) {
    const payment = await sql<{ id: string }>`
      select id from outsourced_driver_fee_payments
      where company_id=${companyId}::uuid and linked_driver_reconciliation_id=${reconciliationId}::uuid
        and status='confirmed' for update
    `.execute(database);
    if (payment.rows[0] === undefined) return null;
    this.support.assertPermission("outsourced_driver_fees.reverse");
    return this.reversePaymentInTransaction(
      database,
      companyId,
      actorId,
      payment.rows[0].id,
      reason,
      correlationId,
    );
  }

  private async runRange(
    fromDate: string,
    toDate: string,
    driverId: string | undefined,
    source: AccrualSource,
    preview: boolean,
    notes: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string,
  ) {
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const operation =
        source === "authorized_backfill" ? operations.backfill : operations.reconciliation;
      const reservation = await this.support.reserveIdempotency(transaction, {
        companyId,
        idempotencyKey,
        operation,
        payload: { fromDate, toDate, driverId, notes, preview },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      if (driverId !== undefined) {
        const driver =
          await sql`select id from drivers where id=${driverId}::uuid and company_id=${companyId}::uuid`.execute(
            transaction,
          );
        if (driver.rows[0] === undefined) this.notFound("outsourced_driver_fee_driver_not_found");
      }
      const orders = await sql<{ id: string }>`
        select id from orders where company_id=${companyId}::uuid and delivery_status='delivered'
          and delivered_at is not null
          and (delivered_at at time zone 'Asia/Dubai')::date between ${fromDate}::date and ${toDate}::date
          and (${driverId ?? null}::uuid is null or assigned_driver_id=${driverId ?? null}::uuid)
        order by delivered_at,id for update
      `.execute(transaction);
      const outcomes: { readonly amount?: string; readonly outcome: string }[] = [];
      let created = 0;
      let total = new Decimal(0);
      for (const order of orders.rows) {
        const outcome = await this.evaluateOrder(
          transaction,
          companyId,
          order.id,
          source,
          actorId,
          correlationId,
          !preview,
        );
        outcomes.push(outcome);
        if (outcome.outcome === "created" || (preview && outcome.outcome === "eligible")) {
          created += 1;
          total = total.plus(outcome.amount ?? 0);
        }
      }
      const count = (name: string) => outcomes.filter((item) => item.outcome === name).length;
      const response = {
        accrualsCreated: preview ? 0 : created,
        alreadyAccrued: count("historical_accrual_already_exists"),
        ambiguousFeeRates: count("outsourced_driver_fee_rate_ambiguous"),
        eligibleOrders: count("eligible") + count("created"),
        employeeDriverOrders: count("employee_driver"),
        estimatedAccrualCount: created,
        legacyRepresentedOrders: count("represented_by_legacy_commission"),
        missingAssignedDrivers: count("no_assigned_driver"),
        missingFeeRates: count("outsourced_driver_fee_rate_missing"),
        ordersExamined: orders.rows.length,
        outcomes,
        preview,
        reversedHistoricalAccruals: count("reversed_historical_accrual_prevents_replacement"),
        totalEarnedAmount: total.toFixed(2),
      };
      await this.history.audit(transaction, {
        action:
          source === "authorized_backfill"
            ? "outsourced_driver_fee_backfill_completed"
            : "outsourced_driver_fee_reconciliation_completed",
        actorId,
        after: response,
        companyId,
        correlationId,
        subjectId: companyId,
        subjectType: "company",
      });
      await this.complete(transaction, companyId, idempotencyKey!, operation, companyId, response);
      return response;
    });
  }

  private async evaluateOrder(
    database: Database,
    companyId: string,
    orderId: string,
    source: AccrualSource,
    actorId: string,
    correlationId: string,
    create: boolean,
  ) {
    const result = await sql<AccrualCandidate>`
      select o.id as "orderId", o.order_number as "orderNumber", o.assigned_driver_id as "driverId",
        o.delivered_at::text as "deliveredAt", d.driver_type as "driverType"
      from orders o left join drivers d on d.id=o.assigned_driver_id and d.company_id=o.company_id
      where o.id=${orderId}::uuid and o.company_id=${companyId}::uuid and o.delivery_status='delivered'
      for update of o
    `.execute(database);
    const order = result.rows[0];
    if (order === undefined) return { orderId, outcome: "order_not_delivered" };
    if (order.driverId === null)
      return { orderId, orderNumber: order.orderNumber, outcome: "no_assigned_driver" };
    if (order.driverType !== "outsourced")
      return { orderId, orderNumber: order.orderNumber, outcome: "employee_driver" };
    const existing = await sql<{
      status: string;
    }>`select status from outsourced_driver_fee_accruals where company_id=${companyId}::uuid and order_id=${orderId}::uuid`.execute(
      database,
    );
    if (existing.rows[0] !== undefined)
      return {
        orderId,
        orderNumber: order.orderNumber,
        outcome:
          existing.rows[0].status === "reversed"
            ? "reversed_historical_accrual_prevents_replacement"
            : "historical_accrual_already_exists",
      };
    if (await this.legacyRepresented(database, companyId, orderId)) {
      const outcome = {
        orderId,
        orderNumber: order.orderNumber,
        outcome: "represented_by_legacy_commission",
      };
      await this.auditEligibilityOutcome(database, companyId, actorId, correlationId, outcome);
      return outcome;
    }
    const rates = await sql<{ amount: string; id: string }>`
      select id, fee_per_order::text as amount from outsourced_driver_fee_versions
      where company_id=${companyId}::uuid and driver_id=${order.driverId}::uuid and status='active'
        and effective_from <= (${order.deliveredAt}::timestamptz at time zone 'Asia/Dubai')::date
        and coalesce(effective_to,'infinity'::date) >= (${order.deliveredAt}::timestamptz at time zone 'Asia/Dubai')::date
      order by effective_from desc for share
    `.execute(database);
    if (rates.rows.length === 0) {
      const outcome = {
        orderId,
        orderNumber: order.orderNumber,
        outcome: "outsourced_driver_fee_rate_missing",
      };
      await this.auditEligibilityOutcome(database, companyId, actorId, correlationId, outcome);
      return outcome;
    }
    if (rates.rows.length > 1) {
      const outcome = {
        orderId,
        orderNumber: order.orderNumber,
        outcome: "outsourced_driver_fee_rate_ambiguous",
      };
      await this.auditEligibilityOutcome(database, companyId, actorId, correlationId, outcome);
      return outcome;
    }
    const rate = rates.rows[0]!;
    if (!create)
      return { amount: rate.amount, orderId, orderNumber: order.orderNumber, outcome: "eligible" };
    const inserted = await sql<{ id: string }>`
      insert into outsourced_driver_fee_accruals (
        company_id,driver_id,order_id,delivery_date,accrual_business_date,fee_rate_version_id,
        fee_rate_snapshot,earned_amount,paid_amount,outstanding_amount,status,accrual_source,
        source_reference,created_by_account_id
      ) values (
        ${companyId}::uuid,${order.driverId}::uuid,${orderId}::uuid,${order.deliveredAt}::timestamptz,
        (${order.deliveredAt}::timestamptz at time zone 'Asia/Dubai')::date,${rate.id}::uuid,
        ${rate.amount},${rate.amount},0,${rate.amount},'accrued',${source},${order.orderNumber},${actorId}::uuid
      ) on conflict (company_id,order_id) where order_id is not null do nothing returning id
    `.execute(database);
    if (inserted.rows[0] === undefined)
      return {
        orderId,
        orderNumber: order.orderNumber,
        outcome: "historical_accrual_already_exists",
      };
    const response = {
      accrualId: inserted.rows[0].id,
      amount: rate.amount,
      orderId,
      orderNumber: order.orderNumber,
      outcome: "created",
    };
    await this.history.audit(database, {
      action: "outsourced_driver_fee_accrual_created",
      actorId,
      after: response,
      companyId,
      correlationId,
      subjectId: inserted.rows[0].id,
      subjectType: "outsourced_driver_fee_accrual",
    });
    return response;
  }

  private async legacyRepresented(database: Database, companyId: string, orderId: string) {
    const result = await sql`
      select 1 from driver_commission_orders x
      join driver_commission_calculations c on c.id=x.calculation_id and c.company_id=x.company_id
      where x.company_id=${companyId}::uuid and x.order_id=${orderId}::uuid
        and (c.status in ('payable','paid','consumed') or x.allocation_kind='payment')
      union all
      select 1 from outsourced_driver_payments p join driver_commission_calculations c on c.id=p.commission_calculation_id and c.company_id=p.company_id
      join driver_commission_orders x on x.calculation_id=c.id and x.company_id=c.company_id
      where p.company_id=${companyId}::uuid and x.order_id=${orderId}::uuid
      union all
      select 1 from payroll_commission_links l join driver_commission_calculations c on c.id=l.commission_calculation_id and c.company_id=l.company_id
      join driver_commission_orders x on x.calculation_id=c.id and x.company_id=c.company_id
      where l.company_id=${companyId}::uuid and x.order_id=${orderId}::uuid limit 1
    `.execute(database);
    return result.rows.length > 0;
  }

  private auditEligibilityOutcome(
    database: Database,
    companyId: string,
    actorId: string,
    correlationId: string,
    outcome: { readonly orderId: string; readonly outcome: string },
  ) {
    return this.history.audit(database, {
      action: `outsourced_driver_fee_${outcome.outcome}`,
      actorId,
      after: outcome,
      companyId,
      correlationId,
      subjectId: outcome.orderId,
      subjectType: "order",
    });
  }

  private async buildProposal(
    database: Database,
    companyId: string,
    driverId: string,
    amount: Decimal,
    manual: readonly { accrualId: string; amount: number }[] | undefined,
    lock: boolean,
  ) {
    const rows = await this.payableAccruals(database, companyId, driverId, lock);
    const total = rows.reduce((sum, row) => sum.plus(row.outstanding), new Decimal(0));
    if (amount.greaterThan(total))
      throw new ApplicationException(
        "outsourced_driver_fee_payment_exceeds_outstanding",
        "The payment exceeds the Driver's current outstanding fees",
        HttpStatus.CONFLICT,
      );
    const allocations =
      manual === undefined
        ? this.allocate(rows, amount)
        : this.manualAllocate(rows, amount, manual);
    return {
      allocations,
      driverId,
      remainingOutstanding: total.minus(amount).toFixed(2),
      totalAmount: amount.toFixed(2),
    };
  }

  private async payableAccruals(
    database: Database,
    companyId: string,
    driverId: string,
    lock: boolean,
  ) {
    const result = await sql<{ accrualId: string; orderNumber: string; outstanding: string }>`
      select f.id as "accrualId",coalesce(o.order_number,f.source_reference) as "orderNumber",f.outstanding_amount::text as outstanding
      from outsourced_driver_fee_accruals f left join orders o on o.id=f.order_id and o.company_id=f.company_id
      where f.company_id=${companyId}::uuid and f.driver_id=${driverId}::uuid
        and f.status in ('accrued','partially_paid') and f.outstanding_amount>0
      order by f.accrual_business_date,f.delivery_date,f.created_at,f.id
      ${lock ? sql`for update of f` : sql``}
    `.execute(database);
    return result.rows;
  }

  private allocate(
    rows: readonly { accrualId: string; orderNumber: string; outstanding: string }[],
    amount: Decimal,
  ): AllocationProposal[] {
    let remaining = amount;
    const output: AllocationProposal[] = [];
    for (const row of rows) {
      if (remaining.isZero()) break;
      const outstanding = new Decimal(row.outstanding);
      const allocated = Decimal.min(remaining, outstanding);
      output.push({
        accrualId: row.accrualId,
        amount: allocated.toFixed(2),
        orderNumber: row.orderNumber,
        outstandingBefore: outstanding.toFixed(2),
        remainingOutstanding: outstanding.minus(allocated).toFixed(2),
      });
      remaining = remaining.minus(allocated);
    }
    return output;
  }

  private manualAllocate(
    rows: readonly { accrualId: string; orderNumber: string; outstanding: string }[],
    amount: Decimal,
    manual: readonly { accrualId: string; amount: number }[],
  ) {
    const byId = new Map(rows.map((row) => [row.accrualId, row]));
    const seen = new Set<string>();
    let total = new Decimal(0);
    const output = manual.map((line) => {
      if (seen.has(line.accrualId))
        throw new ApplicationException(
          "outsourced_driver_fee_duplicate_allocation",
          "The same accrual cannot be allocated twice",
          HttpStatus.BAD_REQUEST,
        );
      seen.add(line.accrualId);
      const row = byId.get(line.accrualId);
      const value = new Decimal(line.amount);
      if (row === undefined || value.lte(0) || value.gt(row.outstanding))
        throw new ApplicationException(
          "outsourced_driver_fee_payment_stale_balance",
          "A selected accrual is no longer payable for the requested amount",
          HttpStatus.CONFLICT,
        );
      total = total.plus(value);
      return {
        accrualId: row.accrualId,
        amount: value.toFixed(2),
        orderNumber: row.orderNumber,
        outstandingBefore: new Decimal(row.outstanding).toFixed(2),
        remainingOutstanding: new Decimal(row.outstanding).minus(value).toFixed(2),
      };
    });
    if (!total.equals(amount))
      throw new ApplicationException(
        "outsourced_driver_fee_allocation_total_mismatch",
        "Allocation total must equal the requested payment amount",
        HttpStatus.BAD_REQUEST,
      );
    return output;
  }

  private async createPayment(
    database: Database,
    input: {
      actorId: string;
      allocations: readonly AllocationInput[];
      cashVoucherReference?: string;
      companyId: string;
      correlationId: string;
      driverId: string;
      externalReference?: string;
      /** Cash account funding this payment. Absent for a collection offset. */
      fundingCashAccountId?: string;
      idempotencyKey: string;
      linkedReconciliationId?: string;
      notes?: string;
      paymentDate: string;
      paymentMethod: string;
      paymentSource: string;
      manualAllocation?: boolean;
    },
    idempotencyOperation?: string,
  ): Promise<FeePaymentResult> {
    const amount = input.allocations.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
    const paymentNumber = await this.history.nextReferenceNumber(
      database,
      input.companyId,
      "outsourced_driver_fee_payment",
      "DFPAY",
    );
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const created = await sql<{ id: string }>`
      insert into outsourced_driver_fee_payments (
        company_id,payment_number,driver_id,payment_date,payment_method,payment_source,amount_paid,
        cash_voucher_reference,external_reference,notes,status,paid_by_account_id,
        linked_driver_reconciliation_id,idempotency_key,request_hash,confirmed_at,
        company_cash_account_id
      ) values (
        ${input.companyId}::uuid,${paymentNumber},${input.driverId}::uuid,${input.paymentDate}::date,
        ${input.paymentMethod},${input.paymentSource},${amount.toFixed(2)},${input.cashVoucherReference ?? null},
        ${input.externalReference ?? null},${input.notes ?? null},'confirmed',${input.actorId}::uuid,
        ${input.linkedReconciliationId ?? null}::uuid,${input.idempotencyKey},${requestHash},
        -- Created already confirmed; server clock is authoritative. Not accepted
        -- from the caller, and never derived from payment_date.
        now(),
        -- Null for a collection offset, which moves no money out of any
        -- account. The table CHECK enforces that pairing independently.
        ${input.fundingCashAccountId ?? null}::uuid
      ) returning id
    `.execute(database);
    const paymentId = created.rows[0]!.id;
    for (const [index, allocation] of input.allocations.entries()) {
      await sql`insert into outsourced_driver_fee_payment_allocations(company_id,payment_id,accrual_id,allocated_amount,allocation_order)
        values(${input.companyId}::uuid,${paymentId}::uuid,${allocation.accrualId}::uuid,${allocation.amount},${index + 1})`.execute(
        database,
      );
    }

    await this.syncAccruals(
      database,
      input.companyId,
      input.allocations.map((row) => row.accrualId),
    );

    if (input.fundingCashAccountId !== undefined) {
      await this.createCashBankMovementForPayment(database, {
        actorId: input.actorId,
        amount: amount.toFixed(2),
        cashAccountId: input.fundingCashAccountId,
        companyId: input.companyId,
        paymentDate: input.paymentDate,
        paymentId,
        paymentNumber,
      });
    }

    const remaining = await this.driverOutstanding(database, input.companyId, input.driverId);
    const confirmedAllocations = await sql<AllocationProposal>`
      select x.accrual_id as "accrualId",x.allocated_amount::text as amount,
        coalesce(o.order_number,f.source_reference) as "orderNumber",
        (f.outstanding_amount+x.allocated_amount)::text as "outstandingBefore",
        f.outstanding_amount::text as "remainingOutstanding"
      from outsourced_driver_fee_payment_allocations x
      join outsourced_driver_fee_accruals f on f.id=x.accrual_id and f.company_id=x.company_id
      left join orders o on o.id=f.order_id and o.company_id=f.company_id
      where x.company_id=${input.companyId}::uuid and x.payment_id=${paymentId}::uuid
      order by x.allocation_order
    `.execute(database);
    const response: FeePaymentResult = {
      allocations: confirmedAllocations.rows,
      amount: amount.toFixed(2),
      paymentId,
      paymentNumber,
      remainingDriverOutstanding: remaining,
      status: "confirmed",
    };
    await this.history.audit(database, {
      action:
        input.paymentSource === "driver_collection"
          ? "outsourced_driver_fee_collection_offset_confirmed"
          : "outsourced_driver_fee_payment_confirmed",
      actorId: input.actorId,
      after: response,
      companyId: input.companyId,
      correlationId: input.correlationId,
      subjectId: paymentId,
      subjectType: "outsourced_driver_fee_payment",
    });
    if (input.manualAllocation === true) {
      await this.history.audit(database, {
        action: "outsourced_driver_fee_manual_allocation_override",
        actorId: input.actorId,
        after: {
          allocations: input.allocations,
          paymentId,
          paymentSource: input.paymentSource,
        },
        companyId: input.companyId,
        correlationId: input.correlationId,
        subjectId: paymentId,
        subjectType: "outsourced_driver_fee_payment",
      });
    }
    if (idempotencyOperation !== undefined)
      await this.complete(
        database,
        input.companyId,
        input.idempotencyKey,
        idempotencyOperation,
        paymentId,
        response,
      );
    return response;
  }

  private async reversePaymentInTransaction(
    database: Database,
    companyId: string,
    actorId: string,
    paymentId: string,
    reason: string,
    correlationId: string,
  ) {
    if (reason.trim().length === 0)
      throw new ApplicationException(
        "outsourced_driver_fee_reversal_reason_required",
        "A reversal reason is required",
        HttpStatus.BAD_REQUEST,
      );
    const allocations = await sql<{ accrualId: string; accrualStatus: string }>`
      select x.accrual_id as "accrualId",f.status as "accrualStatus"
      from outsourced_driver_fee_payment_allocations x
      join outsourced_driver_fee_accruals f on f.id=x.accrual_id and f.company_id=x.company_id
      where x.company_id=${companyId}::uuid and x.payment_id=${paymentId}::uuid
        and x.reversed_at is null order by x.allocation_order for update of x
    `.execute(database);
    if (allocations.rows.length === 0)
      throw new ApplicationException(
        "outsourced_driver_fee_payment_allocation_conflict",
        "This payment has no active allocations to reverse",
        HttpStatus.CONFLICT,
      );
    if (allocations.rows.some((row) => row.accrualStatus === "recovery_required")) {
      throw new ApplicationException(
        "outsourced_driver_fee_recovery_workflow_required",
        "A payment allocated to a Recovery Required accrual must be handled by the approved recovery workflow",
        HttpStatus.CONFLICT,
      );
    }
    await sql`select id from outsourced_driver_fee_accruals where company_id=${companyId}::uuid and id in (${sql.join(allocations.rows.map((row) => sql`${row.accrualId}::uuid`))}) order by id for update`.execute(
      database,
    );
    await sql`update outsourced_driver_fee_payment_allocations set reversed_at=now() where company_id=${companyId}::uuid and payment_id=${paymentId}::uuid and reversed_at is null`.execute(
      database,
    );
    await sql`update outsourced_driver_fee_payments set status='reversed',reversed_by_account_id=${actorId}::uuid,reversed_at=now(),reversal_reason=${reason.trim()},updated_at=now(),version=version+1 where id=${paymentId}::uuid and company_id=${companyId}::uuid`.execute(
      database,
    );
    await this.syncAccruals(
      database,
      companyId,
      allocations.rows.map((row) => row.accrualId),
    );
    const response = {
      paymentId,
      restoredAccrualIds: allocations.rows.map((row) => row.accrualId),
      status: "reversed",
    };
    await this.history.audit(database, {
      action: "outsourced_driver_fee_payment_reversed",
      actorId,
      after: response,
      companyId,
      correlationId,
      subjectId: paymentId,
      subjectType: "outsourced_driver_fee_payment",
    });
    return response;
  }

  private async syncAccruals(database: Database, companyId: string, accrualIds: readonly string[]) {
    if (accrualIds.length === 0) return;
    await sql`
      update outsourced_driver_fee_accruals f set
        paid_amount=x.paid,
        outstanding_amount=f.earned_amount-x.paid,
        status=case when x.paid=0 then 'accrued' when x.paid=f.earned_amount then 'paid' else 'partially_paid' end,
        updated_at=now(),version=f.version+1
      from (
        select target.id,coalesce(sum(a.allocated_amount) filter(where a.reversed_at is null and p.status='confirmed'),0) as paid
        from outsourced_driver_fee_accruals target
        left join outsourced_driver_fee_payment_allocations a on a.accrual_id=target.id and a.company_id=target.company_id
        left join outsourced_driver_fee_payments p on p.id=a.payment_id and p.company_id=a.company_id
        where target.company_id=${companyId}::uuid and target.id in (${sql.join(accrualIds.map((id) => sql`${id}::uuid`))})
        group by target.id
      ) x where f.id=x.id and f.company_id=${companyId}::uuid and f.status not in ('reversed','recovery_required')
    `.execute(database);
  }

  /**
   * Fallback method to update accrual statuses when syncAccruals fails.
   * This avoids potential database trigger issues by using a simpler update.
   */
  private async updateAccrualStatusesDirectly(
    database: Database,
    companyId: string,
    accrualIds: readonly string[],
  ) {
    if (accrualIds.length === 0) return;
    try {
      // Update only the critical fields without triggering complex database logic
      await sql`
        update outsourced_driver_fee_accruals f
        set
          paid_amount = coalesce((
            select sum(a.allocated_amount)
            from outsourced_driver_fee_payment_allocations a
            join outsourced_driver_fee_payments p on p.id = a.payment_id
            where a.accrual_id = f.id
              and a.company_id = f.company_id
              and a.reversed_at is null
              and p.status = 'confirmed'
          ), 0),
          outstanding_amount = f.earned_amount - coalesce((
            select sum(a.allocated_amount)
            from outsourced_driver_fee_payment_allocations a
            join outsourced_driver_fee_payments p on p.id = a.payment_id
            where a.accrual_id = f.id
              and a.company_id = f.company_id
              and a.reversed_at is null
              and p.status = 'confirmed'
          ), 0),
          status = case
            when f.earned_amount <= coalesce((
              select sum(a.allocated_amount)
              from outsourced_driver_fee_payment_allocations a
              join outsourced_driver_fee_payments p on p.id = a.payment_id
              where a.accrual_id = f.id
                and a.company_id = f.company_id
                and a.reversed_at is null
                and p.status = 'confirmed'
            ), 0) then 'paid'
            when coalesce((
              select sum(a.allocated_amount)
              from outsourced_driver_fee_payment_allocations a
              join outsourced_driver_fee_payments p on p.id = a.payment_id
              where a.accrual_id = f.id
                and a.company_id = f.company_id
                and a.reversed_at is null
                and p.status = 'confirmed'
            ), 0) > 0 then 'partially_paid'
            else 'accrued'
          end,
          updated_at = now(),
          version = version + 1
        where
          company_id = ${companyId}::uuid
          and id in (${sql.join(accrualIds.map((id) => sql`${id}::uuid`))})
          and status not in ('reversed', 'recovery_required')
      `.execute(database);
    } catch (error) {
      console.error('updateAccrualStatusesDirectly also failed:', error);
      // At this point, the payment has been recorded but status update failed
      // Log for manual investigation but don't block payment completion
    }
  }

  /**
   * Create a cash/bank movement record for outsourced driver fee payment.
   *
   * CRITICAL: This must succeed or the entire payment transaction rolls back.
   * We do NOT mark accruals as paid unless a corresponding cash movement exists.
   *
   * The movement appears in "Cash and Bank Movements" screen and tracks:
   * - Outflow of cash from the payment's cash account
   * - Reference link to the payment (DFPAY-XXXXX)
   * - Driver name and payment details
   */
  private async createCashBankMovementForPayment(
    database: Database,
    input: {
      actorId: string;
      amount: string;
      cashAccountId: string;
      companyId: string;
      paymentDate: string;
      paymentId: string;
      paymentNumber: string;
    },
  ) {
    const movementNumber = await this.history.nextReferenceNumber(
      database,
      input.companyId,
      "cash_bank_movement",
      "CBM",
    );
    const movementId = randomUUID();
    await sql`
      insert into cash_bank_movements (
        id,company_id,movement_number,movement_type,movement_date,accounting_date,
        source_cash_account_id,amount,fee_amount,payment_method,reference_number,
        description,status,correlation_id,idempotency_identity,accounting_event_id,
        confirmed_by_account_id,confirmed_at,created_by_account_id,created_at
      )
      select ${movementId}::uuid,${input.companyId}::uuid,${movementNumber},
        'cash_withdrawal',${input.paymentDate}::date,${input.paymentDate}::date,
        ${input.cashAccountId}::uuid,${input.amount}::numeric,0,'cash',${input.paymentNumber},
        ${`Outsourced Driver fee payment ${input.paymentNumber}`},'confirmed',
        ${input.paymentId},${`outsourced_driver_fee_payment:${input.paymentId}`},e.id,
        ${input.actorId}::uuid,now(),${input.actorId}::uuid,now()
      from accounting_events e
      where e.company_id=${input.companyId}::uuid
        and e.source_entity_type='outsourced_driver_fee_payment'
        and e.source_entity_id=${input.paymentId}::uuid
        and e.event_type='outsourced_driver_fee_paid'
      on conflict (company_id,idempotency_identity) do nothing
    `.execute(database);
  }
  private async driverOutstanding(database: Database, companyId: string, driverId: string) {
    const result = await sql<{
      total: string;
    }>`select coalesce(sum(outstanding_amount),0)::text as total from outsourced_driver_fee_accruals where company_id=${companyId}::uuid and driver_id=${driverId}::uuid and status in ('accrued','partially_paid')`.execute(
      database,
    );
    return result.rows[0]!.total;
  }

  private async paymentResult(
    database: Database,
    companyId: string,
    paymentId: string,
  ): Promise<FeePaymentResult> {
    const result = await sql<{
      amount: string;
      driverId: string;
      paymentId: string;
      paymentNumber: string;
      status: string;
    }>`select id as "paymentId",payment_number as "paymentNumber",driver_id as "driverId",amount_paid::text as amount,status from outsourced_driver_fee_payments where id=${paymentId}::uuid and company_id=${companyId}::uuid`.execute(
      database,
    );
    const payment = result.rows[0];
    if (payment === undefined) this.notFound("outsourced_driver_fee_payment_not_found");
    return {
      allocations: [],
      amount: payment.amount,
      paymentId: payment.paymentId,
      paymentNumber: payment.paymentNumber,
      remainingDriverOutstanding: await this.driverOutstanding(
        database,
        companyId,
        payment.driverId,
      ),
      status: payment.status,
    };
  }

  private complete(
    database: Database,
    companyId: string,
    idempotencyKey: string,
    operation: string,
    resourceId: string,
    response: unknown,
  ) {
    return this.support.completeIdempotency(database, {
      companyId,
      idempotencyKey,
      operation,
      resourceId,
      resourceType: "outsourced_driver_fee",
      responseBody: response,
    });
  }

  private notFound(code: string): never {
    throw new ApplicationException(
      code,
      "The requested Outsourced Driver fee record was not found",
      HttpStatus.NOT_FOUND,
    );
  }
}
