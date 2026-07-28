import { createHash } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

import { CompanyProfileService } from "../company-profile/company-profile.service.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { traderSettlementPageSizes } from "./operations.dto.js";
import type {
  ConfirmTraderSettlementReceiptDto,
  CreateTraderSettlementDto,
  ProposeTraderAllocationDto,
  TraderSettlementAllocationLineDto,
  TraderSettlementEligibleOrdersQueryDto,
  TraderSettlementFilterDto,
  TraderSettlementListQueryDto,
  TraderSettlementSummaryQueryDto,
} from "./operations.dto.js";

const defaultPageSize = 25;
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{16,128}$/;
const idempotencyOperationCreate = "trader_settlements.create";
const idempotencyOperationReceipt = "trader_settlements.money_received";
const receiptConfirmedAction = "trader_settlement.receipt_confirmed";

interface EligibleTraderOrder {
  readonly deliveredAt: string | null;
  readonly deliveryStatus: string;
  readonly driverReconciliationStatus: string;
  readonly id: string;
  readonly orderNumber: string;
  readonly outstandingBalance: string;
  readonly serialNumber: string;
  readonly settlementStatus: string;
  readonly traderChargesFull: string;
  readonly traderDeductionsFull: string;
  readonly traderGrossPayableFull: string;
  readonly traderId: string;
  readonly traderName: string;
  readonly traderNetPayableFull: string;
  readonly traderPaidAmount: string;
  readonly traderPaidServiceFeeFull: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface TraderEligibleOrderRow {
  readonly additionalFees: string;
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerName: string;
  readonly deliveryDate: string | null;
  readonly emirateName: string | null;
  readonly id: string;
  readonly originalAmountDueToTrader: string;
  readonly outstandingBalance: string;
  readonly previouslyPaid: string;
  readonly referenceNumber: string | null;
  readonly serialNumber: string;
  readonly settlementStatus: string;
  readonly totalDeductions: string;
  readonly vatAmount: string;
}

export interface TraderAllocationProposalLine {
  readonly allocatedAmount: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly outstandingAfter: string;
  readonly outstandingBefore: string;
  readonly serialNumber: string;
}

export interface TraderAllocationProposal {
  readonly allocations: readonly TraderAllocationProposalLine[];
  readonly requestedAmount: string;
  readonly totalAllocated: string;
  readonly traderId: string;
  readonly unallocatedAmount: string;
}

export interface CreateTraderSettlementResult {
  readonly amount: string;
  readonly orderCount: number;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly settlementId: string;
  readonly settlementNumber: string;
  readonly traderId: string;
  readonly traderName: string;
}

export interface TraderSettlementListRow {
  readonly confirmedBy: string;
  readonly createdBy: string;
  readonly isReversed: boolean;
  readonly moneyReceivedAt: string | null;
  readonly moneyReceivedConfirmed: boolean;
  readonly moneySentAt: string | null;
  readonly orderCount: number;
  readonly paymentAmount: string;
  readonly paymentDate: string;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly paymentReference: string | null;
  readonly previouslyPaid: string;
  readonly remainingOutstanding: string;
  readonly settlementId: string;
  readonly settlementNumber: string;
  readonly status: "confirmed" | "reversed";
  readonly traderName: string;
}

export interface TraderSettlementSummary {
  readonly eligibleOrders: number;
  readonly eligibleTraderPayable: string;
  readonly moneyReceivedAmount: string;
  readonly moneySentAmount: string;
  readonly partiallySettledAmount: string;
  readonly remainingOutstanding: string;
  readonly reversedPayments: number;
  readonly tradersWithOutstandingBalance: number;
  readonly unsettledAmount: string;
}

interface MaskedBankSnapshot {
  readonly accountName: string;
  readonly accountNumberMasked: string;
  readonly bankName: string;
  readonly ibanMasked: string;
  readonly swiftCode: string | null;
}

export interface TraderSettlementDetailOrder {
  readonly additionalFees: string;
  readonly amountPaidNow: string;
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerName: string;
  readonly deliveryDate: string | null;
  readonly emirateName: string | null;
  readonly orderSettlementStatus: string;
  readonly originalTraderPayable: string;
  readonly previouslyPaid: string;
  readonly referenceNumber: string | null;
  readonly remainingOutstanding: string;
  readonly serialNumber: string;
  readonly serviceFee: string;
  readonly totalDeductions: string;
  readonly vatAmount: string;
}

interface TraderSettlementSummaryTotals {
  readonly amountPaidNow: string;
  readonly orderCount: number;
  readonly previouslyPaid: string;
  readonly remainingOutstanding: string;
  readonly totalAdditionalFees: string;
  readonly totalCod: string;
  readonly totalDeductions: string;
  readonly totalOriginalTraderPayable: string;
  readonly totalServiceFees: string;
  readonly totalVat: string;
}

export interface TraderSettlementDetail {
  readonly beneficiaryBank: MaskedBankSnapshot | null;
  readonly confirmedBy: string;
  readonly moneyReceivedBy: string | null;
  readonly moneyReceivedDate: string | null;
  readonly moneyReceivedNotes: string | null;
  readonly moneyReceivedReference: string | null;
  readonly notes: string | null;
  readonly orders: readonly TraderSettlementDetailOrder[];
  readonly paymentDate: string;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly paymentReference: string | null;
  readonly reversalOfSettlementNumber: string | null;
  readonly reversalReason: string | null;
  readonly reversedBySettlementNumber: string | null;
  readonly settlementId: string;
  readonly settlementNumber: string;
  readonly sourceBank: { readonly accountName: string; readonly bankName: string } | null;
  readonly status: "confirmed" | "reversed";
  readonly summary: TraderSettlementSummaryTotals;
  readonly traderName: string;
}

export interface TraderSettlementReportData {
  readonly header: {
    readonly beneficiaryBank: MaskedBankSnapshot | null;
    readonly company: {
      readonly hasLogo: boolean;
      readonly nameAr: string | null;
      readonly nameEn: string;
      readonly subtitleAr: string | null;
      readonly subtitleEn: string | null;
      readonly telephone: string | null;
    };
    readonly confirmedBy: string;
    readonly createdBy: string;
    readonly generatedAt: string;
    readonly moneyReceivedBy: string | null;
    readonly moneyReceivedDate: string | null;
    readonly moneyReceivedNotes: string | null;
    readonly moneyReceivedReference: string | null;
    readonly paymentDate: string;
    readonly paymentMethod: "bank_transfer" | "cash";
    readonly paymentReference: string | null;
    readonly settlementNumber: string;
    readonly sourceBank: { readonly accountName: string; readonly bankName: string } | null;
    readonly status: "confirmed" | "reversed";
    readonly traderName: string;
  };
  readonly orders: readonly TraderSettlementDetailOrder[];
  readonly summary: TraderSettlementSummaryTotals;
}

/**
 * The authoritative Trader Settlement service (Phase 4 Checkpoint 4).
 *
 * Reuses `trader_settlements` / `trader_settlement_orders` /
 * `trader_settlement_payments`, `orders.trader_paid_amount` /
 * `trader_outstanding_balance`, `trader_bank_accounts`, `company_bank_accounts`,
 * `idempotency_records`, `order_status_history`, `order_events` and
 * `audit_events` exactly as they already exist — no duplicate settlement,
 * payment, allocation or bank-account model.
 */
@Injectable()
export class TraderSettlementService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
    @Inject(CompanyProfileService) private readonly companyProfile: CompanyProfileService,
  ) {}

  /**
   * Eligible Orders for one Trader (§4/§5). No Order is hidden by omission: an
   * Order that can never be settled (cancelled, driver cash not yet
   * reconciled, no Trader payable) is excluded in SQL rather than left for the
   * caller to filter, but an already fully-paid Order remains visible unless
   * `outstandingOnly` narrows the list — the operator can still browse a
   * Trader's settled history through this same endpoint.
   */
  public async eligibleOrders(
    query: TraderSettlementEligibleOrdersQueryDto,
  ): Promise<Page<TraderEligibleOrderRow>> {
    this.assertAnyPermission("settlements.create");
    const { companyId } = this.tenants.current();
    const { limit, offset, page, pageSize } = this.pagination(query);
    const search = query.search?.trim() || null;
    const direction = query.sortDirection === "desc" ? "desc" : "asc";
    const sortColumn =
      query.sortBy === "serialNumber"
        ? "coalesce(o.serial_number, o.order_number)"
        : query.sortBy === "outstandingBalance"
          ? "o.trader_outstanding_balance"
          : "o.delivered_at";
    const filters = sql`
      o.company_id = ${companyId}::uuid
        and o.trader_id = ${query.traderId}::uuid
        and o.delivery_status = 'delivered'
        and o.driver_reconciliation_status in ('reconciled', 'not_applicable')
        and o.trader_settlement_status <> 'not_eligible'
        and o.trader_settlement_status <> 'reversed'
        and (${search}::text is null
             or o.order_number ilike '%' || ${search} || '%'
             or o.serial_number ilike '%' || ${search} || '%'
             or o.reference_number ilike '%' || ${search} || '%'
             or o.customer_name ilike '%' || ${search} || '%')
        and (${query.serialNumber ?? null}::text is null
             or coalesce(o.serial_number, o.order_number)
                ilike '%' || ${query.serialNumber ?? null} || '%')
        and (${query.referenceNumber ?? null}::text is null
             or o.reference_number ilike '%' || ${query.referenceNumber ?? null} || '%')
        and (${query.emirateId ?? null}::uuid is null or exists (
             select 1 from areas a
              where a.id = o.area_id and a.company_id = o.company_id
                and a.emirate_id = ${query.emirateId ?? null}::uuid
        ))
        and (${query.areaId ?? null}::uuid is null or o.area_id = ${query.areaId ?? null}::uuid)
        and (${query.deliveredFrom ?? null}::date is null
             or o.delivered_at::date >= ${query.deliveredFrom ?? null}::date)
        and (${query.deliveredTo ?? null}::date is null
             or o.delivered_at::date <= ${query.deliveredTo ?? null}::date)
        and (${query.settlementStatus ?? null}::text is null
             or o.trader_settlement_status = ${query.settlementStatus ?? null}::text)
        and (${query.outstandingOnly === true} = false or o.trader_outstanding_balance > 0)
    `;
    const result = await sql<Omit<TraderEligibleOrderRow, never> & { total: number }>`
      select o.id, coalesce(o.serial_number, o.order_number) as "serialNumber",
             o.reference_number as "referenceNumber", o.delivered_at::text as "deliveryDate",
             o.customer_name as "customerName",
             coalesce(e.name_en, null) as "emirateName",
             coalesce(o.customer_area_name_snapshot, a.name_en, '') as "areaName",
             o.cod_amount::text as "codAmount", o.service_fee::text as "serviceFee",
             coalesce(o.additional_fees, 0)::text as "additionalFees",
             coalesce(o.vat_amount, 0)::text as "vatAmount",
             coalesce(o.total_deductions, 0)::text as "totalDeductions",
             o.trader_net_payable::text as "originalAmountDueToTrader",
             o.trader_paid_amount::text as "previouslyPaid",
             o.trader_outstanding_balance::text as "outstandingBalance",
             o.trader_settlement_status as "settlementStatus",
             count(*) over()::int as total
        from orders o
        left join areas a on a.id = o.area_id and a.company_id = o.company_id
        left join emirates e on e.id = a.emirate_id
       where ${filters}
       order by ${sql.raw(sortColumn)} ${sql.raw(direction)},
                coalesce(o.serial_number, o.order_number) ${sql.raw(direction)}
       limit ${limit} offset ${offset}
    `.execute(this.database);
    return this.page(result.rows, page, pageSize);
  }

  /**
   * Oldest-first default allocation (§6): read-only, writes nothing. Sorted by
   * Delivery Date ascending with the Serial Number as a stable tie-breaker.
   * The final Order in the walk absorbs whatever remains of the payment, up to
   * its own outstanding balance — never beyond it.
   */
  public async proposeAllocation(
    input: ProposeTraderAllocationDto,
  ): Promise<TraderAllocationProposal> {
    this.assertAnyPermission("settlements.create");
    const { companyId } = this.tenants.current();
    const orders = await this.resolveEligibleOrdersForTrader(
      this.database,
      companyId,
      input.traderId,
      false,
    );
    let remaining = new Decimal(input.amount);
    const allocations: TraderAllocationProposalLine[] = [];
    for (const order of orders) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const outstanding = new Decimal(order.outstandingBalance);
      if (outstanding.lessThanOrEqualTo(0)) continue;
      const allocated = Decimal.min(remaining, outstanding);
      allocations.push({
        allocatedAmount: this.money(allocated).toFixed(2),
        orderId: order.id,
        orderNumber: order.orderNumber,
        outstandingAfter: this.money(outstanding.minus(allocated)).toFixed(2),
        outstandingBefore: this.money(outstanding).toFixed(2),
        serialNumber: order.serialNumber,
      });
      remaining = remaining.minus(allocated);
    }
    const totalAllocated = allocations.reduce(
      (sum, line) => sum.plus(line.allocatedAmount),
      new Decimal(0),
    );
    return {
      allocations,
      requestedAmount: this.money(new Decimal(input.amount)).toFixed(2),
      totalAllocated: totalAllocated.toFixed(2),
      traderId: input.traderId,
      unallocatedAmount: this.money(remaining).toFixed(2),
    };
  }

  /**
   * Create a Trader payment (§8), full or partial. Every allocation is
   * revalidated against the LOCKED, current outstanding balance — never the
   * value the caller supplied — so a stale proposal or a concurrent second
   * payment can never over-allocate. The corrected confirmation-guard trigger
   * (see migration 20260729100000) validates the header totals against this
   * settlement's own `allocated_amount` sum at UPDATE time, so the INSERT is
   * deliberately followed by a separate UPDATE to 'confirmed' rather than a
   * single INSERT with status already 'confirmed' (which would bypass the
   * `before update of status` trigger entirely).
   */
  public async createPayment(
    input: CreateTraderSettlementDto,
    correlationId: string,
    idempotencyKey?: string,
  ): Promise<CreateTraderSettlementResult> {
    this.assertAnyPermission("settlements.create");
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const key = idempotencyKey?.trim() ?? "";
    if (!idempotencyKeyPattern.test(key)) {
      throw new ApplicationException(
        "idempotency_key_invalid",
        "A valid idempotency key is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const requestHash = this.materialFingerprint(input);

    return this.transactions.execute(async (transaction) => {
      const reserved = await sql<{ id: string }>`
        insert into idempotency_records (
          company_id, operation, idempotency_key, request_hash, expires_at
        ) values (
          ${companyId}::uuid, ${idempotencyOperationCreate}, ${key}, ${requestHash},
          now() + interval '24 hours'
        )
        on conflict (company_id, operation, idempotency_key) do nothing
        returning id
      `.execute(transaction);
      if (reserved.rows[0] === undefined) {
        const existing = await sql<{ requestHash: string; resourceId: string | null }>`
          select request_hash as "requestHash", resource_id as "resourceId"
          from idempotency_records
          where company_id = ${companyId}::uuid
            and operation = ${idempotencyOperationCreate}
            and idempotency_key = ${key}
          for update
        `.execute(transaction);
        const record = existing.rows[0];
        if (record === undefined || record.requestHash !== requestHash) {
          throw new ApplicationException(
            "idempotency_key_reused",
            "This submission key was already used for different settlement details",
            HttpStatus.CONFLICT,
          );
        }
        if (record.resourceId !== null) {
          return this.settlementResult(transaction, companyId, record.resourceId);
        }
        throw new ApplicationException(
          "settlement_submission_in_progress",
          "This settlement submission is already being processed",
          HttpStatus.CONFLICT,
        );
      }

      // 1. Validate the allocation shape before touching any row.
      const allocated = input.allocations.filter((line) => line.amount > 0);
      if (allocated.length === 0) {
        throw new ApplicationException(
          "settlement_allocation_empty",
          "Allocate the payment to at least one Order",
          HttpStatus.BAD_REQUEST,
        );
      }
      const orderIds = allocated.map((line) => line.orderId);
      if (new Set(orderIds).size !== orderIds.length) {
        throw new ApplicationException(
          "settlement_allocation_duplicate_order",
          "The same Order cannot receive two allocation rows",
          HttpStatus.BAD_REQUEST,
        );
      }
      const allocationTotal = allocated.reduce(
        (sum, line) => sum.plus(line.amount),
        new Decimal(0),
      );
      if (!this.money(allocationTotal).equals(this.money(new Decimal(input.amount)))) {
        throw new ApplicationException(
          "settlement_allocation_mismatch",
          "The total allocation must equal the payment amount exactly",
          HttpStatus.BAD_REQUEST,
        );
      }

      // 2. Lock the allocated Orders in a deterministic order, then revalidate
      //    everything against the locked, current values.
      const orders = await this.lockOrdersForSettlement(transaction, companyId, orderIds);
      this.assertOrdersSettleable(orders, input.traderId);
      const amountByOrder = new Map(allocated.map((line) => [line.orderId, line.amount]));
      const overAllocated = orders.filter((order) => {
        const amount = amountByOrder.get(order.id) ?? 0;
        return new Decimal(amount).greaterThan(order.outstandingBalance);
      });
      if (overAllocated.length > 0) {
        throw new ApplicationException(
          "settlement_allocation_exceeds_outstanding",
          "One or more allocations exceed the Order's current outstanding balance",
          HttpStatus.CONFLICT,
          overAllocated.map((order) => order.orderNumber),
        );
      }

      // 3. Resolve and validate the payment method and bank accounts.
      const payment = await this.resolveFinancialPayment(transaction, companyId, {
        ...(input.bankAccountId === undefined ? {} : { bankAccountId: input.bankAccountId }),
        ...(input.bankReference === undefined ? {} : { bankReference: input.bankReference }),
        ...(input.paymentMethod === undefined ? {} : { paymentMethod: input.paymentMethod }),
      });
      const beneficiary =
        payment.method === "bank_transfer"
          ? await this.resolveTraderBeneficiary(
              transaction,
              companyId,
              input.traderId,
              input.traderBankAccountId,
            )
          : null;

      const traderName = orders[0]?.traderName ?? "";
      // The header describes THIS settlement's own payment only — gross_payable
      // and net_payable both equal the sum of allocations, with no separate
      // deductions/charges/adjustments attributed at the header level. This is
      // the only shape the unconditional `trader_settlements_amounts_check`
      // CHECK constraint can satisfy for a partial payment (see migration
      // 20260729100000). Each Order's own full gross/deductions/adjustments
      // remain fully preserved on its `trader_settlement_orders` line and on
      // `orders` itself, untouched by this simplification.
      const netPayable = this.money(allocationTotal);

      // 4. Write everything atomically: header (draft, then confirmed so the
      //    trigger actually validates it), lines, payment, Order updates.
      const settlementNumber = await this.history.nextReferenceNumber(
        transaction,
        companyId,
        "settlement",
        "SET",
      );
      const header = await sql<{ id: string }>`
        insert into trader_settlements (
          company_id, settlement_number, trader_id, business_date,
          gross_payable, service_fee_deductions, other_deductions, charges,
          adjustments, net_payable, status, created_by_account_id
        ) values (
          ${companyId}::uuid, ${settlementNumber}, ${input.traderId}::uuid,
          coalesce(${input.paymentDate ?? null}::date, current_date),
          ${netPayable.toNumber()}, 0, 0, 0, 0, ${netPayable.toNumber()},
          'draft', ${identity.identityId}::uuid
        )
        returning id
      `.execute(transaction);
      const settlementId = header.rows[0]?.id;
      if (settlementId === undefined) {
        throw new Error("Trader settlement creation did not return an identifier");
      }

      for (const order of orders) {
        const amount = new Decimal(amountByOrder.get(order.id) ?? 0);
        await sql`
          insert into trader_settlement_orders (
            company_id, settlement_id, order_id, gross_payable,
            deductions_and_charges, adjustments, net_payable, allocated_amount
          ) values (
            ${companyId}::uuid, ${settlementId}::uuid, ${order.id}::uuid,
            ${this.money(new Decimal(order.traderGrossPayableFull)).toNumber()},
            ${this.money(
              new Decimal(order.traderPaidServiceFeeFull)
                .plus(order.traderDeductionsFull)
                .plus(order.traderChargesFull),
            ).toNumber()},
            0, ${this.money(new Decimal(order.traderNetPayableFull)).toNumber()},
            ${this.money(amount).toNumber()}
          )
        `.execute(transaction);
      }
      await sql`
        insert into trader_settlement_payments (
          company_id, settlement_id, payment_method, amount, company_bank_account_id,
          bank_reference, created_by_account_id, payment_at,
          trader_bank_account_id, trader_bank_account_snapshot
        ) values (
          ${companyId}::uuid, ${settlementId}::uuid, ${payment.method}, ${netPayable.toNumber()},
          ${payment.bankAccountId}::uuid, ${payment.bankReference},
          ${identity.identityId}::uuid, coalesce(${input.paymentDate ?? null}::date::timestamptz, now()),
          ${beneficiary?.id ?? null}::uuid,
          ${beneficiary === null ? null : JSON.stringify(beneficiary.snapshot)}::jsonb
        )
      `.execute(transaction);
      await sql`
        update trader_settlements
           set status = 'confirmed', confirmed_by_account_id = ${identity.identityId}::uuid,
               confirmed_at = now(), updated_at = now()
         where id = ${settlementId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);

      const actorRole = await this.history.actorRole(transaction, companyId, identity.identityId);
      for (const order of orders) {
        const amount = new Decimal(amountByOrder.get(order.id) ?? 0);
        const newPaid = new Decimal(order.traderPaidAmount).plus(amount);
        const fullyPaid = newPaid.greaterThanOrEqualTo(order.traderNetPayableFull);
        const newStatus = fullyPaid ? "money_sent_to_trader" : "partially_settled";
        await sql`
          update orders
             set trader_paid_amount = ${this.money(newPaid).toNumber()},
                 trader_settlement_status = ${newStatus},
                 updated_at = now(), version = version + 1
           where id = ${order.id}::uuid and company_id = ${companyId}::uuid
        `.execute(transaction);
        await this.history.statusHistory(transaction, {
          actorId: identity.identityId,
          companyId,
          from: order.settlementStatus,
          orderId: order.id,
          statusDimension: "trader_settlement",
          to: newStatus,
        });
        await this.history.orderEvent(transaction, {
          actorId: identity.identityId,
          actorRole,
          category: "financial_change",
          companyId,
          correlationId,
          eventType: fullyPaid ? "trader_settlement.money_sent" : "trader_settlement.partial_payment",
          fieldName: "trader_settlement_status",
          newValue: {
            allocatedAmount: this.money(amount).toFixed(2),
            outstandingAfter: this.money(
              new Decimal(order.traderNetPayableFull).minus(newPaid),
            ).toFixed(2),
            settlementNumber,
            status: newStatus,
          },
          orderId: order.id,
          previousValue: order.settlementStatus,
          relatedSettlementId: settlementId,
          source: "web_portal",
        });
      }
      await this.history.audit(transaction, {
        action: "trader_settlement.create",
        actorId: identity.identityId,
        after: {
          amount: netPayable.toFixed(2),
          // `trader_settlements` has no `notes` column; the create-time note is
          // captured here on the append-only audit trail instead, and read back
          // by `settlementHeader()` for the detail/report-data views.
          notes: input.notes?.trim() || null,
          orderCount: orders.length,
          paymentMethod: payment.method,
          settlementNumber,
          traderId: input.traderId,
        },
        companyId,
        correlationId,
        subjectId: settlementId,
        subjectType: "trader_settlement",
      });
      await sql`
        update idempotency_records
           set response_status = 201, resource_type = 'trader_settlement',
               resource_id = ${settlementId}::uuid, completed_at = now()
         where company_id = ${companyId}::uuid
           and operation = ${idempotencyOperationCreate}
           and idempotency_key = ${key}
      `.execute(transaction);

      return {
        amount: netPayable.toFixed(2),
        orderCount: orders.length,
        paymentMethod: payment.method,
        settlementId,
        settlementNumber,
        traderId: input.traderId,
        traderName,
      };
    });
  }

  /**
   * Money Received confirmation (§12): a separate action after Money Sent.
   * The original payment amount, allocations, Payment Date and reference are
   * never touched — only orders this settlement fully paid (currently
   * `money_sent_to_trader`) advance to `money_received_by_trader`; an Order
   * this settlement only partially paid stays `partially_settled` regardless,
   * since it was never "sent" to completion in the first place. The
   * settlement-level confirmation itself (including on an all-partial
   * settlement with no order to flip) is recorded as an `audit_events` marker
   * keyed by `subject_type = 'trader_settlement'`, which is also the
   * authoritative source for duplicate-confirmation rejection.
   */
  public async confirmMoneyReceived(
    settlementId: string,
    input: ConfirmTraderSettlementReceiptDto,
    correlationId: string,
    idempotencyKey?: string,
  ): Promise<{ readonly orderCount: number; readonly settlementId: string }> {
    this.assertAnyPermission("settlements.create");
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const key = idempotencyKey?.trim() ?? "";
    if (!idempotencyKeyPattern.test(key)) {
      throw new ApplicationException(
        "idempotency_key_invalid",
        "A valid idempotency key is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ notes: input.notes?.trim() ?? "", receivedDate: input.receivedDate ?? "", reference: input.reference?.trim() ?? "", settlementId }))
      .digest("hex");

    return this.transactions.execute(async (transaction) => {
      const reserved = await sql<{ id: string }>`
        insert into idempotency_records (
          company_id, operation, idempotency_key, request_hash, expires_at
        ) values (
          ${companyId}::uuid, ${idempotencyOperationReceipt}, ${key}, ${requestHash},
          now() + interval '24 hours'
        )
        on conflict (company_id, operation, idempotency_key) do nothing
        returning id
      `.execute(transaction);
      if (reserved.rows[0] === undefined) {
        const existing = await sql<{ requestHash: string; resourceId: string | null }>`
          select request_hash as "requestHash", resource_id as "resourceId"
          from idempotency_records
          where company_id = ${companyId}::uuid
            and operation = ${idempotencyOperationReceipt}
            and idempotency_key = ${key}
          for update
        `.execute(transaction);
        const record = existing.rows[0];
        if (record === undefined || record.requestHash !== requestHash) {
          throw new ApplicationException(
            "idempotency_key_reused",
            "This submission key was already used for a different receipt confirmation",
            HttpStatus.CONFLICT,
          );
        }
        if (record.resourceId !== null) {
          return { orderCount: 0, settlementId: record.resourceId };
        }
        throw new ApplicationException(
          "settlement_submission_in_progress",
          "This receipt confirmation is already being processed",
          HttpStatus.CONFLICT,
        );
      }

      const settlement = (
        await sql<{ reversalOfId: string | null; status: string; traderId: string }>`
          select status, reversal_of_id as "reversalOfId", trader_id as "traderId"
            from trader_settlements
           where id = ${settlementId}::uuid and company_id = ${companyId}::uuid
           for update
        `.execute(transaction)
      ).rows[0];
      if (settlement === undefined) {
        throw new ApplicationException(
          "settlement_not_found",
          "Trader settlement not found",
          HttpStatus.NOT_FOUND,
        );
      }
      if (settlement.reversalOfId !== null) {
        throw new ApplicationException(
          "settlement_receipt_invalid_target",
          "A reversal record cannot itself receive a Money Received confirmation",
          HttpStatus.BAD_REQUEST,
        );
      }
      if (settlement.status !== "confirmed") {
        throw new ApplicationException(
          "trader_settlement_not_sent",
          "Only a settlement whose money has been sent can be confirmed as received",
          HttpStatus.CONFLICT,
        );
      }
      const alreadyReversed = (
        await sql<{ id: string }>`
          select id from trader_settlements
           where company_id = ${companyId}::uuid and reversal_of_id = ${settlementId}::uuid
           limit 1
        `.execute(transaction)
      ).rows[0];
      if (alreadyReversed !== undefined) {
        throw new ApplicationException(
          "trader_settlement_reversed",
          "This settlement has been reversed and cannot receive further confirmation",
          HttpStatus.CONFLICT,
        );
      }
      const alreadyConfirmed = (
        await sql<{ id: string }>`
          select id from audit_events
           where company_id = ${companyId}::uuid and subject_type = 'trader_settlement'
             and subject_id = ${settlementId} and action = ${receiptConfirmedAction}
           limit 1
        `.execute(transaction)
      ).rows[0];
      if (alreadyConfirmed !== undefined) {
        throw new ApplicationException(
          "trader_settlement_receipt_already_confirmed",
          "Money Received has already been confirmed for this settlement",
          HttpStatus.CONFLICT,
        );
      }

      const links = (
        await sql<{ orderId: string; orderNumber: string; settlementStatus: string }>`
          select o.id as "orderId", o.order_number as "orderNumber",
                 o.trader_settlement_status as "settlementStatus"
            from trader_settlement_orders link
            join orders o on o.id = link.order_id and o.company_id = link.company_id
           where link.settlement_id = ${settlementId}::uuid and link.company_id = ${companyId}::uuid
           order by o.id
           for update of o
        `.execute(transaction)
      ).rows;

      const actorRole = await this.history.actorRole(transaction, companyId, identity.identityId);
      let flipped = 0;
      for (const link of links) {
        if (link.settlementStatus !== "money_sent_to_trader") continue;
        flipped += 1;
        await sql`
          update orders set trader_settlement_status = 'money_received_by_trader',
                            updated_at = now(), version = version + 1
           where id = ${link.orderId}::uuid and company_id = ${companyId}::uuid
        `.execute(transaction);
        await this.history.statusHistory(transaction, {
          actorId: identity.identityId,
          companyId,
          from: "money_sent_to_trader",
          orderId: link.orderId,
          statusDimension: "trader_settlement",
          to: "money_received_by_trader",
        });
        await this.history.orderEvent(transaction, {
          actorId: identity.identityId,
          actorRole,
          category: "financial_change",
          companyId,
          correlationId,
          eventType: "trader_settlement.money_received",
          fieldName: "trader_settlement_status",
          newValue: {
            notes: input.notes?.trim() || null,
            receivedDate: input.receivedDate ?? null,
            reference: input.reference?.trim() || null,
            status: "money_received_by_trader",
          },
          orderId: link.orderId,
          previousValue: "money_sent_to_trader",
          relatedSettlementId: settlementId,
          source: "web_portal",
        });
      }
      await this.history.audit(transaction, {
        action: receiptConfirmedAction,
        actorId: identity.identityId,
        after: {
          confirmedBy: identity.identityId,
          notes: input.notes?.trim() || null,
          orderCount: flipped,
          receivedDate: input.receivedDate ?? null,
          reference: input.reference?.trim() || null,
        },
        companyId,
        correlationId,
        subjectId: settlementId,
        subjectType: "trader_settlement",
      });
      await sql`
        update idempotency_records
           set response_status = 200, resource_type = 'trader_settlement',
               resource_id = ${settlementId}::uuid, completed_at = now()
         where company_id = ${companyId}::uuid
           and operation = ${idempotencyOperationReceipt}
           and idempotency_key = ${key}
      `.execute(transaction);
      return { orderCount: flipped, settlementId };
    });
  }

  /**
   * Safe reversal (§13). Blocked once Money Received is confirmed — reversing
   * money the Trader has already acknowledged receiving would misstate the
   * ledger with no compensating real-world event — so the operator sees a
   * clear business error rather than a silent no-op or a corrupted balance.
   * The original settlement, its lines and its payment are never mutated or
   * deleted; a zero-value, header-only compensating record is created
   * (mirroring Driver Cash Reconciliation's reversal shape) and Order paid /
   * outstanding balances are restored from it.
   */
  public async reverse(
    settlementId: string,
    reason: string,
    correlationId: string,
  ): Promise<{
    readonly orderCount: number;
    readonly reversalSettlementId: string;
    readonly reversalSettlementNumber: string;
    readonly settlementId: string;
  }> {
    this.assertAnyPermission("settlements.reverse");
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const trimmedReason = reason.trim();
    if (trimmedReason === "") {
      throw new ApplicationException(
        "settlement_reversal_reason_required",
        "A reason is required to reverse a Trader settlement",
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.transactions.execute(async (transaction) => {
      const original = (
        await sql<{
          reversalOfId: string | null;
          settlementNumber: string;
          status: string;
          traderId: string;
        }>`
          select settlement_number as "settlementNumber", reversal_of_id as "reversalOfId",
                 status, trader_id as "traderId"
            from trader_settlements
           where id = ${settlementId}::uuid and company_id = ${companyId}::uuid
           for update
        `.execute(transaction)
      ).rows[0];
      if (original === undefined) {
        throw new ApplicationException(
          "settlement_not_found",
          "Trader settlement not found",
          HttpStatus.NOT_FOUND,
        );
      }
      if (original.reversalOfId !== null) {
        throw new ApplicationException(
          "settlement_reversal_invalid",
          "A reversal entry cannot itself be reversed",
          HttpStatus.BAD_REQUEST,
        );
      }
      if (original.status !== "confirmed") {
        throw new ApplicationException(
          "settlement_not_confirmed",
          "Only a confirmed settlement can be reversed",
          HttpStatus.BAD_REQUEST,
        );
      }
      const existingReversal = (
        await sql<{ id: string }>`
          select id from trader_settlements
           where company_id = ${companyId}::uuid and reversal_of_id = ${settlementId}::uuid
           limit 1
        `.execute(transaction)
      ).rows[0];
      if (existingReversal !== undefined) {
        throw new ApplicationException(
          "settlement_already_reversed",
          "This settlement has already been reversed",
          HttpStatus.CONFLICT,
        );
      }
      const moneyReceived = (
        await sql<{ id: string }>`
          select id from audit_events
           where company_id = ${companyId}::uuid and subject_type = 'trader_settlement'
             and subject_id = ${settlementId} and action = ${receiptConfirmedAction}
           limit 1
        `.execute(transaction)
      ).rows[0];
      if (moneyReceived !== undefined) {
        throw new ApplicationException(
          "settlement_reversal_blocked_by_receipt",
          "Cannot reverse: Money Received has already been confirmed for this settlement",
          HttpStatus.CONFLICT,
        );
      }

      const links = (
        await sql<{
          allocatedAmount: string;
          orderId: string;
          settlementStatus: string;
          traderNetPayable: string;
          traderPaidAmount: string;
        }>`
          select o.id as "orderId", link.allocated_amount as "allocatedAmount",
                 o.trader_settlement_status as "settlementStatus",
                 o.trader_paid_amount::text as "traderPaidAmount",
                 o.trader_net_payable::text as "traderNetPayable"
            from trader_settlement_orders link
            join orders o on o.id = link.order_id and o.company_id = link.company_id
           where link.settlement_id = ${settlementId}::uuid and link.company_id = ${companyId}::uuid
           order by o.id
           for update of o
        `.execute(transaction)
      ).rows;

      const reversalNumber = await this.history.nextReferenceNumber(
        transaction,
        companyId,
        "settlement",
        "SET",
      );
      const reversalHeader = (
        await sql<{ id: string }>`
          insert into trader_settlements (
            company_id, settlement_number, trader_id, business_date,
            gross_payable, service_fee_deductions, other_deductions, charges,
            adjustments, net_payable, status, created_by_account_id,
            confirmed_by_account_id, confirmed_at, reversal_of_id
          ) values (
            ${companyId}::uuid, ${reversalNumber}, ${original.traderId}::uuid, current_date,
            0, 0, 0, 0, 0, 0, 'confirmed', ${identity.identityId}::uuid,
            ${identity.identityId}::uuid, now(), ${settlementId}::uuid
          ) returning id
        `.execute(transaction)
      ).rows[0];
      const reversalId = reversalHeader?.id;
      if (reversalId === undefined) throw new Error("Reversal settlement ID was not returned");

      const actorRole = await this.history.actorRole(transaction, companyId, identity.identityId);
      for (const link of links) {
        const newPaid = Decimal.max(
          0,
          new Decimal(link.traderPaidAmount).minus(link.allocatedAmount),
        );
        const newStatus = newPaid.lessThanOrEqualTo(0)
          ? "unsettled"
          : newPaid.greaterThanOrEqualTo(link.traderNetPayable)
            ? "settled"
            : "partially_settled";
        await sql`
          update orders set trader_paid_amount = ${this.money(newPaid).toNumber()},
                            trader_settlement_status = ${newStatus},
                            updated_at = now(), version = version + 1
           where id = ${link.orderId}::uuid and company_id = ${companyId}::uuid
        `.execute(transaction);
        await this.history.statusHistory(transaction, {
          actorId: identity.identityId,
          companyId,
          from: link.settlementStatus,
          orderId: link.orderId,
          reason: trimmedReason,
          statusDimension: "trader_settlement",
          to: newStatus,
        });
        await this.history.orderEvent(transaction, {
          actorId: identity.identityId,
          actorRole,
          category: "financial_change",
          companyId,
          correlationId,
          eventType: "trader_settlement.reversed",
          fieldName: "trader_settlement_status",
          newValue: {
            restoredOutstanding: this.money(
              new Decimal(link.traderNetPayable).minus(newPaid),
            ).toFixed(2),
            reversalSettlementNumber: reversalNumber,
            reversedSettlementNumber: original.settlementNumber,
            status: newStatus,
          },
          orderId: link.orderId,
          previousValue: link.settlementStatus,
          reason: trimmedReason,
          relatedSettlementId: reversalId,
          source: "web_portal",
        });
      }
      await this.history.audit(transaction, {
        action: "trader_settlement.reverse",
        actorId: identity.identityId,
        after: {
          orderCount: links.length,
          reason: trimmedReason,
          reversalSettlementNumber: reversalNumber,
          reversedSettlementNumber: original.settlementNumber,
        },
        companyId,
        correlationId,
        subjectId: settlementId,
        subjectType: "trader_settlement",
      });

      return {
        orderCount: links.length,
        reversalSettlementId: reversalId,
        reversalSettlementNumber: reversalNumber,
        settlementId,
      };
    });
  }

  public async list(query: TraderSettlementListQueryDto): Promise<Page<TraderSettlementListRow>> {
    this.assertAnyPermission("settlements.create");
    const { companyId } = this.tenants.current();
    const { limit, offset, page, pageSize } = this.pagination(query);
    const direction = query.sortDirection === "asc" ? "asc" : "desc";
    const sortColumn =
      query.sortBy === "settlementNumber" ? "s.settlement_number" : "s.business_date";
    const filters = this.settlementFilters(companyId, query);
    const result = await sql<TraderSettlementListRow & { total: number }>`
      select s.id as "settlementId", s.settlement_number as "settlementNumber",
             t.name_en as "traderName", s.business_date::text as "paymentDate",
             coalesce(p.payment_method, 'cash') as "paymentMethod",
             p.bank_reference as "paymentReference",
             coalesce(lines.total, 0)::int as "orderCount",
             s.net_payable::text as "paymentAmount",
             coalesce(lines."previouslyPaid", 0)::text as "previouslyPaid",
             coalesce(lines."remainingOutstanding", 0)::text as "remainingOutstanding",
             s.confirmed_at::text as "moneySentAt",
             (received.id is not null) as "moneyReceivedConfirmed",
             received.occurred_at::text as "moneyReceivedAt",
             coalesce(creator.username, 'Legacy/Unknown') as "createdBy",
             coalesce(confirmer.username, 'Legacy/Unknown') as "confirmedBy",
             exists (
               select 1 from trader_settlements rv
                where rv.company_id = s.company_id and rv.reversal_of_id = s.id
             ) as "isReversed",
             count(*) over()::int as total
        from trader_settlements s
        join traders t on t.id = s.trader_id and t.company_id = s.company_id
        left join accounts creator
          on creator.id = s.created_by_account_id and creator.company_id = s.company_id
        left join accounts confirmer
          on confirmer.id = s.confirmed_by_account_id and confirmer.company_id = s.company_id
        left join lateral (
          select payment_method, bank_reference from trader_settlement_payments p
           where p.settlement_id = s.id and p.company_id = s.company_id limit 1
        ) p on true
        left join lateral (
          select count(*)::int as total,
                 coalesce(sum(o.trader_paid_amount - link.allocated_amount), 0) as "previouslyPaid",
                 coalesce(sum(o.trader_outstanding_balance), 0) as "remainingOutstanding"
            from trader_settlement_orders link
            join orders o on o.id = link.order_id and o.company_id = link.company_id
           where link.settlement_id = s.id and link.company_id = s.company_id
        ) lines on true
        left join lateral (
          select id, occurred_at from audit_events
           where company_id = s.company_id and subject_type = 'trader_settlement'
             and subject_id = s.id::text and action = ${receiptConfirmedAction}
           order by occurred_at limit 1
        ) received on true
       where ${filters}
       order by ${sql.raw(sortColumn)} ${sql.raw(direction)}, s.created_at desc
       limit ${limit} offset ${offset}
    `.execute(this.database);
    const items = result.rows.map((row) => ({
      ...row,
      status: row.isReversed ? ("reversed" as const) : ("confirmed" as const),
    }));
    return this.page(items, page, pageSize);
  }

  public async summary(query: TraderSettlementSummaryQueryDto): Promise<TraderSettlementSummary> {
    this.assertAnyPermission("settlements.create");
    const { companyId } = this.tenants.current();
    const orderFilters = sql`
      o.company_id = ${companyId}::uuid
        and o.delivery_status = 'delivered'
        and o.driver_reconciliation_status in ('reconciled', 'not_applicable')
        and o.trader_settlement_status not in ('not_eligible', 'reversed')
        and (${query.traderId ?? null}::uuid is null or o.trader_id = ${query.traderId ?? null}::uuid)
        and (${query.deliveredFrom ?? null}::date is null
             or o.delivered_at::date >= ${query.deliveredFrom ?? null}::date)
        and (${query.deliveredTo ?? null}::date is null
             or o.delivered_at::date <= ${query.deliveredTo ?? null}::date)
    `;
    const orderTotals = await sql<{
      eligibleOrders: number;
      eligibleTraderPayable: string;
      partiallySettledAmount: string;
      remainingOutstanding: string;
      tradersWithOutstandingBalance: number;
      unsettledAmount: string;
    }>`
      select
        count(*) filter (where o.trader_outstanding_balance > 0)::int as "eligibleOrders",
        coalesce(sum(o.trader_outstanding_balance) filter (where o.trader_outstanding_balance > 0), 0)::text
          as "eligibleTraderPayable",
        coalesce(sum(o.trader_net_payable) filter (where o.trader_settlement_status = 'unsettled'), 0)::text
          as "unsettledAmount",
        coalesce(sum(o.trader_paid_amount) filter (where o.trader_settlement_status = 'partially_settled'), 0)::text
          as "partiallySettledAmount",
        coalesce(sum(o.trader_outstanding_balance), 0)::text as "remainingOutstanding",
        count(distinct o.trader_id) filter (where o.trader_outstanding_balance > 0)::int
          as "tradersWithOutstandingBalance"
        from orders o
       where ${orderFilters}
    `.execute(this.database);
    const filters = this.settlementFilters(companyId, query);
    const settlementTotals = await sql<{ moneyReceivedAmount: string; moneySentAmount: string; reversedPayments: number }>`
      select
        coalesce(sum(s.net_payable) filter (where s.reversal_of_id is null), 0)::text as "moneySentAmount",
        coalesce(sum(s.net_payable) filter (
          where s.reversal_of_id is null and exists (
            select 1 from audit_events a
             where a.company_id = s.company_id and a.subject_type = 'trader_settlement'
               and a.subject_id = s.id::text and a.action = ${receiptConfirmedAction}
          )
        ), 0)::text as "moneyReceivedAmount",
        count(*) filter (where s.reversal_of_id is not null)::int as "reversedPayments"
        from trader_settlements s
        join traders t on t.id = s.trader_id and t.company_id = s.company_id
       where ${filters} or s.reversal_of_id is not null
    `.execute(this.database);
    const orderRow = orderTotals.rows[0] ?? {
      eligibleOrders: 0,
      eligibleTraderPayable: "0.00",
      partiallySettledAmount: "0.00",
      remainingOutstanding: "0.00",
      tradersWithOutstandingBalance: 0,
      unsettledAmount: "0.00",
    };
    const settlementRow = settlementTotals.rows[0] ?? {
      moneyReceivedAmount: "0.00",
      moneySentAmount: "0.00",
      reversedPayments: 0,
    };
    return {
      eligibleOrders: orderRow.eligibleOrders,
      eligibleTraderPayable: new Decimal(orderRow.eligibleTraderPayable).toFixed(2),
      moneyReceivedAmount: new Decimal(settlementRow.moneyReceivedAmount).toFixed(2),
      moneySentAmount: new Decimal(settlementRow.moneySentAmount).toFixed(2),
      partiallySettledAmount: new Decimal(orderRow.partiallySettledAmount).toFixed(2),
      remainingOutstanding: new Decimal(orderRow.remainingOutstanding).toFixed(2),
      reversedPayments: settlementRow.reversedPayments,
      tradersWithOutstandingBalance: orderRow.tradersWithOutstandingBalance,
      unsettledAmount: new Decimal(orderRow.unsettledAmount).toFixed(2),
    };
  }

  public async detail(settlementId: string): Promise<TraderSettlementDetail> {
    this.assertAnyPermission("settlements.create");
    const { companyId } = this.tenants.current();
    const header = await this.settlementHeader(companyId, settlementId);
    const orders = await this.settlementOrders(companyId, settlementId);
    return {
      beneficiaryBank: header.beneficiaryBank,
      confirmedBy: header.confirmedBy,
      moneyReceivedBy: header.moneyReceivedBy,
      moneyReceivedDate: header.moneyReceivedDate,
      moneyReceivedNotes: header.moneyReceivedNotes,
      moneyReceivedReference: header.moneyReceivedReference,
      notes: header.notes,
      orders: orders.lines,
      paymentDate: header.paymentDate,
      paymentMethod: header.paymentMethod,
      paymentReference: header.paymentReference,
      reversalOfSettlementNumber: header.reversalOfSettlementNumber,
      reversalReason: header.reversalReason,
      reversedBySettlementNumber: header.reversedBySettlementNumber,
      settlementId,
      settlementNumber: header.settlementNumber,
      sourceBank: header.sourceBank,
      status: header.status,
      summary: orders.summary,
      traderName: header.traderName,
    };
  }

  /**
   * Server-authoritative Trader Settlement Statement report-data (§18),
   * mandatory for Checkpoint 5. Built entirely from stored snapshots, never
   * from live catalog state, so regeneration is stable. No PDF is generated
   * here.
   */
  public async reportData(settlementId: string): Promise<TraderSettlementReportData> {
    this.assertAnyPermission(["settlements.create", "reports.export"]);
    const { companyId } = this.tenants.current();
    const header = await this.settlementHeader(companyId, settlementId);
    const orders = await this.settlementOrders(companyId, settlementId);
    const branding = await this.companyProfile.branding();
    const generatedAt = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Dubai",
      year: "numeric",
    }).format(new Date());
    return {
      header: {
        beneficiaryBank: header.beneficiaryBank,
        company: {
          hasLogo: branding.hasLogo,
          nameAr: branding.nameAr,
          nameEn: branding.nameEn,
          subtitleAr: branding.subtitleAr,
          subtitleEn: branding.subtitleEn,
          telephone: branding.telephone,
        },
        confirmedBy: header.confirmedBy,
        createdBy: header.createdBy,
        generatedAt: `${generatedAt} (UAE)`,
        moneyReceivedBy: header.moneyReceivedBy,
        moneyReceivedDate: header.moneyReceivedDate,
        moneyReceivedNotes: header.moneyReceivedNotes,
        moneyReceivedReference: header.moneyReceivedReference,
        paymentDate: header.paymentDate,
        paymentMethod: header.paymentMethod,
        paymentReference: header.paymentReference,
        settlementNumber: header.settlementNumber,
        sourceBank: header.sourceBank,
        status: header.status,
        traderName: header.traderName,
      },
      orders: orders.lines,
      summary: orders.summary,
    };
  }

  // ---------------------------------------------------------------------
  // Shared internals
  // ---------------------------------------------------------------------

  private async settlementHeader(
    companyId: string,
    settlementId: string,
  ): Promise<{
    readonly beneficiaryBank: MaskedBankSnapshot | null;
    readonly confirmedBy: string;
    readonly createdBy: string;
    readonly moneyReceivedBy: string | null;
    readonly moneyReceivedDate: string | null;
    readonly moneyReceivedNotes: string | null;
    readonly moneyReceivedReference: string | null;
    readonly notes: string | null;
    readonly paymentDate: string;
    readonly paymentMethod: "bank_transfer" | "cash";
    readonly paymentReference: string | null;
    readonly reversalOfSettlementNumber: string | null;
    readonly reversalReason: string | null;
    readonly reversedBySettlementNumber: string | null;
    readonly settlementNumber: string;
    readonly sourceBank: { readonly accountName: string; readonly bankName: string } | null;
    readonly status: "confirmed" | "reversed";
    readonly traderName: string;
  }> {
    const row = (
      await sql<{
        beneficiaryAccountName: string | null;
        beneficiaryAccountNumber: string | null;
        beneficiaryBankName: string | null;
        beneficiaryIban: string | null;
        beneficiarySwiftCode: string | null;
        businessDate: string;
        confirmedBy: string;
        createdBy: string;
        paymentMethod: "bank_transfer" | "cash" | null;
        paymentReference: string | null;
        reversalOfSettlementNumber: string | null;
        reversedBySettlementNumber: string | null;
        settlementNumber: string;
        sourceAccountName: string | null;
        sourceBankName: string | null;
        status: string;
        traderName: string;
      }>`
        select s.settlement_number as "settlementNumber", s.status,
               s.business_date::text as "businessDate", t.name_en as "traderName",
               coalesce(creator.username, 'Legacy/Unknown') as "createdBy",
               coalesce(confirmer.username, 'Legacy/Unknown') as "confirmedBy",
               p.payment_method as "paymentMethod", p.bank_reference as "paymentReference",
               cb.bank_name as "sourceBankName", cb.account_name as "sourceAccountName",
               p.trader_bank_account_snapshot ->> 'bankName' as "beneficiaryBankName",
               p.trader_bank_account_snapshot ->> 'accountName' as "beneficiaryAccountName",
               p.trader_bank_account_snapshot ->> 'accountNumber' as "beneficiaryAccountNumber",
               p.trader_bank_account_snapshot ->> 'iban' as "beneficiaryIban",
               p.trader_bank_account_snapshot ->> 'swiftCode' as "beneficiarySwiftCode",
               original.settlement_number as "reversalOfSettlementNumber",
               reversal.settlement_number as "reversedBySettlementNumber"
          from trader_settlements s
          join traders t on t.id = s.trader_id and t.company_id = s.company_id
          left join accounts creator
            on creator.id = s.created_by_account_id and creator.company_id = s.company_id
          left join accounts confirmer
            on confirmer.id = s.confirmed_by_account_id and confirmer.company_id = s.company_id
          left join lateral (
            select payment_method, bank_reference, trader_bank_account_snapshot, company_bank_account_id
              from trader_settlement_payments pay
             where pay.settlement_id = s.id and pay.company_id = s.company_id
             limit 1
          ) p on true
          left join company_bank_accounts cb
            on cb.id = p.company_bank_account_id and cb.company_id = s.company_id
          left join trader_settlements original
            on original.id = s.reversal_of_id and original.company_id = s.company_id
          left join trader_settlements reversal
            on reversal.reversal_of_id = s.id and reversal.company_id = s.company_id
         where s.id = ${settlementId}::uuid and s.company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "settlement_not_found",
        "Trader settlement not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const receipt = (
      await sql<{ notes: string | null; occurredAt: string; reference: string | null }>`
        select occurred_at::text as "occurredAt",
               after_data ->> 'notes' as notes, after_data ->> 'reference' as reference
          from audit_events
         where company_id = ${companyId}::uuid and subject_type = 'trader_settlement'
           and subject_id = ${settlementId} and action = ${receiptConfirmedAction}
         order by occurred_at limit 1
      `.execute(this.database)
    ).rows[0];
    // `trader_settlements` has no `notes` column; the create-time note lives on
    // the append-only audit trail instead (see `createPayment()`).
    const created = (
      await sql<{ notes: string | null }>`
        select after_data ->> 'notes' as notes from audit_events
         where company_id = ${companyId}::uuid and subject_type = 'trader_settlement'
           and subject_id = ${settlementId} and action = 'trader_settlement.create'
         order by occurred_at limit 1
      `.execute(this.database)
    ).rows[0];
    // `reverse()` records the reason against the ORIGINAL settlement's own
    // audit trail (subject_id = the settlement that was reversed), so this
    // only resolves when the record being viewed is that original.
    const reversal =
      row.reversedBySettlementNumber === null
        ? undefined
        : (
            await sql<{ reason: string | null }>`
              select after_data ->> 'reason' as reason from audit_events
               where company_id = ${companyId}::uuid and subject_type = 'trader_settlement'
                 and subject_id = ${settlementId} and action = 'trader_settlement.reverse'
               order by occurred_at desc limit 1
            `.execute(this.database)
          ).rows[0];
    return {
      beneficiaryBank:
        row.beneficiaryBankName === null || row.beneficiaryAccountName === null
          ? null
          : {
              accountName: row.beneficiaryAccountName,
              accountNumberMasked: this.maskAccountNumber(row.beneficiaryAccountNumber ?? ""),
              bankName: row.beneficiaryBankName,
              ibanMasked: this.maskIban(row.beneficiaryIban ?? ""),
              swiftCode: row.beneficiarySwiftCode,
            },
      confirmedBy: row.confirmedBy,
      createdBy: row.createdBy,
      moneyReceivedBy: receipt === undefined ? null : row.confirmedBy,
      moneyReceivedDate: receipt?.occurredAt ?? null,
      moneyReceivedNotes: receipt?.notes ?? null,
      moneyReceivedReference: receipt?.reference ?? null,
      notes: created?.notes ?? null,
      paymentDate: row.businessDate,
      paymentMethod: row.paymentMethod ?? "cash",
      paymentReference: row.paymentReference,
      reversalOfSettlementNumber: row.reversalOfSettlementNumber,
      reversalReason: reversal?.reason ?? null,
      reversedBySettlementNumber: row.reversedBySettlementNumber,
      settlementNumber: row.settlementNumber,
      sourceBank:
        row.sourceBankName === null
          ? null
          : { accountName: row.sourceAccountName ?? "", bankName: row.sourceBankName },
      status: row.reversedBySettlementNumber === null ? "confirmed" : "reversed",
      traderName: row.traderName,
    };
  }

  private async settlementOrders(
    companyId: string,
    settlementId: string,
  ): Promise<{
    readonly lines: readonly TraderSettlementDetailOrder[];
    readonly summary: TraderSettlementSummaryTotals;
  }> {
    const rows = (
      await sql<{
        additionalFees: string;
        allocatedAmount: string;
        areaName: string;
        codAmount: string;
        customerName: string;
        deliveryDate: string | null;
        emirateName: string | null;
        orderSettlementStatus: string;
        outstandingBalance: string;
        referenceNumber: string | null;
        serialNumber: string;
        serviceFee: string;
        totalDeductions: string;
        traderNetPayable: string;
        traderPaidAmount: string;
        vatAmount: string;
      }>`
        select coalesce(o.serial_number, o.order_number) as "serialNumber",
               o.reference_number as "referenceNumber", o.delivered_at::text as "deliveryDate",
               o.customer_name as "customerName", e.name_en as "emirateName",
               coalesce(o.customer_area_name_snapshot, a.name_en, '') as "areaName",
               o.cod_amount::text as "codAmount", o.service_fee::text as "serviceFee",
               coalesce(o.additional_fees, 0)::text as "additionalFees",
               coalesce(o.vat_amount, 0)::text as "vatAmount",
               coalesce(o.total_deductions, 0)::text as "totalDeductions",
               o.trader_net_payable::text as "traderNetPayable",
               o.trader_paid_amount::text as "traderPaidAmount",
               o.trader_outstanding_balance::text as "outstandingBalance",
               o.trader_settlement_status as "orderSettlementStatus",
               link.allocated_amount as "allocatedAmount"
          from trader_settlement_orders link
          join orders o on o.id = link.order_id and o.company_id = link.company_id
          left join areas a on a.id = o.area_id and a.company_id = o.company_id
          left join emirates e on e.id = a.emirate_id
         where link.settlement_id = ${settlementId}::uuid and link.company_id = ${companyId}::uuid
         order by coalesce(o.serial_number, o.order_number)
      `.execute(this.database)
    ).rows;
    const lines: TraderSettlementDetailOrder[] = rows.map((row) => ({
      additionalFees: new Decimal(row.additionalFees).toFixed(2),
      amountPaidNow: new Decimal(row.allocatedAmount).toFixed(2),
      areaName: row.areaName,
      codAmount: new Decimal(row.codAmount).toFixed(2),
      customerName: row.customerName,
      deliveryDate: row.deliveryDate,
      emirateName: row.emirateName,
      orderSettlementStatus: row.orderSettlementStatus,
      originalTraderPayable: new Decimal(row.traderNetPayable).toFixed(2),
      previouslyPaid: new Decimal(row.traderPaidAmount)
        .minus(row.allocatedAmount)
        .toFixed(2),
      referenceNumber: row.referenceNumber,
      remainingOutstanding: new Decimal(row.outstandingBalance).toFixed(2),
      serialNumber: row.serialNumber,
      serviceFee: new Decimal(row.serviceFee).toFixed(2),
      totalDeductions: new Decimal(row.totalDeductions).toFixed(2),
      vatAmount: new Decimal(row.vatAmount).toFixed(2),
    }));
    const totals = lines.reduce(
      (acc, line) => ({
        amountPaidNow: acc.amountPaidNow.plus(line.amountPaidNow),
        previouslyPaid: acc.previouslyPaid.plus(line.previouslyPaid),
        remainingOutstanding: acc.remainingOutstanding.plus(line.remainingOutstanding),
        totalAdditionalFees: acc.totalAdditionalFees.plus(line.additionalFees),
        totalCod: acc.totalCod.plus(line.codAmount),
        totalDeductions: acc.totalDeductions.plus(line.totalDeductions),
        totalOriginalTraderPayable: acc.totalOriginalTraderPayable.plus(line.originalTraderPayable),
        totalServiceFees: acc.totalServiceFees.plus(line.serviceFee),
        totalVat: acc.totalVat.plus(line.vatAmount),
      }),
      {
        amountPaidNow: new Decimal(0),
        previouslyPaid: new Decimal(0),
        remainingOutstanding: new Decimal(0),
        totalAdditionalFees: new Decimal(0),
        totalCod: new Decimal(0),
        totalDeductions: new Decimal(0),
        totalOriginalTraderPayable: new Decimal(0),
        totalServiceFees: new Decimal(0),
        totalVat: new Decimal(0),
      },
    );
    return {
      lines,
      summary: {
        amountPaidNow: totals.amountPaidNow.toFixed(2),
        orderCount: lines.length,
        previouslyPaid: totals.previouslyPaid.toFixed(2),
        remainingOutstanding: totals.remainingOutstanding.toFixed(2),
        totalAdditionalFees: totals.totalAdditionalFees.toFixed(2),
        totalCod: totals.totalCod.toFixed(2),
        totalDeductions: totals.totalDeductions.toFixed(2),
        totalOriginalTraderPayable: totals.totalOriginalTraderPayable.toFixed(2),
        totalServiceFees: totals.totalServiceFees.toFixed(2),
        totalVat: totals.totalVat.toFixed(2),
      },
    };
  }

  /**
   * Shared filter predicate for the Trader Settlement list and summary
   * endpoints, so the summary cards always describe the same slice the list
   * shows. Excludes synthetic reversal-marker rows — a reversal is exposed as
   * a flag on the ORIGINAL settlement, never as a row of its own.
   */
  private settlementFilters(
    companyId: string,
    query: TraderSettlementFilterDto,
  ): ReturnType<typeof sql> {
    return sql`
      s.company_id = ${companyId}::uuid
        and s.reversal_of_id is null
        and (${query.traderId ?? null}::uuid is null or s.trader_id = ${query.traderId ?? null}::uuid)
        and (${query.settlementNumber ?? null}::text is null
             or s.settlement_number ilike '%' || ${query.settlementNumber ?? null} || '%')
        and (${query.paymentDateFrom ?? null}::date is null
             or s.business_date >= ${query.paymentDateFrom ?? null}::date)
        and (${query.paymentDateTo ?? null}::date is null
             or s.business_date <= ${query.paymentDateTo ?? null}::date)
        and (${query.settlementStatus ?? null}::text is null
             or ${query.settlementStatus ?? null}::text = 'all'
             or (${query.settlementStatus ?? null}::text = 'confirmed' and not exists (
                  select 1 from trader_settlements rv
                   where rv.company_id = s.company_id and rv.reversal_of_id = s.id
                ))
             or (${query.settlementStatus ?? null}::text = 'reversed' and exists (
                  select 1 from trader_settlements rv
                   where rv.company_id = s.company_id and rv.reversal_of_id = s.id
                ))
        )
        and (${query.moneyReceivedStatus ?? null}::text is null
             or ${query.moneyReceivedStatus ?? null}::text = 'all'
             or (${query.moneyReceivedStatus ?? null}::text = 'received' and exists (
                  select 1 from audit_events a
                   where a.company_id = s.company_id and a.subject_type = 'trader_settlement'
                     and a.subject_id = s.id::text and a.action = ${receiptConfirmedAction}
                ))
             or (${query.moneyReceivedStatus ?? null}::text = 'not_received' and not exists (
                  select 1 from audit_events a
                   where a.company_id = s.company_id and a.subject_type = 'trader_settlement'
                     and a.subject_id = s.id::text and a.action = ${receiptConfirmedAction}
                ))
        )
        and (${query.paymentMethod ?? null}::text is null or exists (
             select 1 from trader_settlement_payments p
              where p.settlement_id = s.id and p.company_id = s.company_id
                and p.payment_method = ${query.paymentMethod ?? null}
        ))
        and (${query.paymentReference ?? null}::text is null or exists (
             select 1 from trader_settlement_payments p
              where p.settlement_id = s.id and p.company_id = s.company_id
                and p.bank_reference ilike '%' || ${query.paymentReference ?? null} || '%'
        ))
        and (
          (${query.orderSerialNumber ?? null}::text is null
           and ${query.referenceNumber ?? null}::text is null
           and ${query.deliveredFrom ?? null}::date is null
           and ${query.deliveredTo ?? null}::date is null
           and ${query.outstandingOnly !== true})
          or exists (
            select 1
              from trader_settlement_orders link
              join orders o on o.id = link.order_id and o.company_id = link.company_id
             where link.settlement_id = s.id and link.company_id = s.company_id
               and (${query.orderSerialNumber ?? null}::text is null
                    or coalesce(o.serial_number, o.order_number)
                       ilike '%' || ${query.orderSerialNumber ?? null} || '%')
               and (${query.referenceNumber ?? null}::text is null
                    or o.reference_number ilike '%' || ${query.referenceNumber ?? null} || '%')
               and (${query.deliveredFrom ?? null}::date is null
                    or o.delivered_at::date >= ${query.deliveredFrom ?? null}::date)
               and (${query.deliveredTo ?? null}::date is null
                    or o.delivered_at::date <= ${query.deliveredTo ?? null}::date)
               and (${query.outstandingOnly !== true} or o.trader_outstanding_balance > 0)
          )
        )
    `;
  }

  private async resolveEligibleOrdersForTrader(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    traderId: string,
    lock: boolean,
  ): Promise<readonly EligibleTraderOrder[]> {
    const result = await sql<EligibleTraderOrder>`
      select o.id, o.order_number as "orderNumber",
             coalesce(o.serial_number, o.order_number) as "serialNumber",
             o.delivered_at::text as "deliveredAt",
             o.delivery_status as "deliveryStatus",
             o.driver_reconciliation_status as "driverReconciliationStatus",
             o.trader_settlement_status as "settlementStatus",
             o.trader_id as "traderId", t.name_en as "traderName",
             o.trader_gross_payable::text as "traderGrossPayableFull",
             o.trader_paid_service_fee::text as "traderPaidServiceFeeFull",
             o.trader_deductions::text as "traderDeductionsFull",
             o.trader_charges::text as "traderChargesFull",
             o.trader_net_payable::text as "traderNetPayableFull",
             o.trader_paid_amount::text as "traderPaidAmount",
             o.trader_outstanding_balance::text as "outstandingBalance"
        from orders o
        join traders t on t.id = o.trader_id and t.company_id = o.company_id
       where o.company_id = ${companyId}::uuid
         and o.trader_id = ${traderId}::uuid
         and o.delivery_status = 'delivered'
         and o.driver_reconciliation_status in ('reconciled', 'not_applicable')
         and o.trader_settlement_status in ('unsettled', 'partially_settled')
         and o.trader_outstanding_balance > 0
       order by o.delivered_at asc nulls last,
                coalesce(o.serial_number, o.order_number) asc, o.id asc
       ${sql.raw(lock ? "for update of o" : "")}
    `.execute(database);
    return result.rows;
  }

  private async lockOrdersForSettlement(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    orderIds: readonly string[],
  ): Promise<readonly EligibleTraderOrder[]> {
    if (orderIds.length === 0) return [];
    const result = await sql<EligibleTraderOrder>`
      select o.id, o.order_number as "orderNumber",
             coalesce(o.serial_number, o.order_number) as "serialNumber",
             o.delivered_at::text as "deliveredAt",
             o.delivery_status as "deliveryStatus",
             o.driver_reconciliation_status as "driverReconciliationStatus",
             o.trader_settlement_status as "settlementStatus",
             o.trader_id as "traderId", t.name_en as "traderName",
             o.trader_gross_payable::text as "traderGrossPayableFull",
             o.trader_paid_service_fee::text as "traderPaidServiceFeeFull",
             o.trader_deductions::text as "traderDeductionsFull",
             o.trader_charges::text as "traderChargesFull",
             o.trader_net_payable::text as "traderNetPayableFull",
             o.trader_paid_amount::text as "traderPaidAmount",
             o.trader_outstanding_balance::text as "outstandingBalance"
        from orders o
        join traders t on t.id = o.trader_id and t.company_id = o.company_id
       where o.company_id = ${companyId}::uuid
         and o.id in (${sql.join(orderIds.map((id) => sql`${id}::uuid`))})
       order by o.id
       for update of o
    `.execute(database);
    return result.rows;
  }

  private assertOrdersSettleable(
    orders: readonly EligibleTraderOrder[],
    traderId: string,
  ): void {
    if (orders.length === 0) {
      throw new ApplicationException(
        "settlement_allocation_empty",
        "Allocate the payment to at least one Order",
        HttpStatus.BAD_REQUEST,
      );
    }
    const wrongTrader = orders.filter((order) => order.traderId !== traderId);
    if (wrongTrader.length > 0) {
      throw new ApplicationException(
        "settlement_trader_mismatch",
        "All selected Orders must belong to the same Trader",
        HttpStatus.CONFLICT,
      );
    }
    const ineligible = orders.filter(
      (order) =>
        order.deliveryStatus !== "delivered" ||
        !["reconciled", "not_applicable"].includes(order.driverReconciliationStatus) ||
        !["unsettled", "partially_settled"].includes(order.settlementStatus),
    );
    if (ineligible.length > 0) {
      throw new ApplicationException(
        "settlement_order_ineligible",
        "Every selected Order must be Delivered, with Driver cash reconciled, and not yet fully settled",
        HttpStatus.CONFLICT,
        ineligible.map((order) => order.orderNumber),
      );
    }
  }

  private async resolveFinancialPayment(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    input: { bankAccountId?: string; bankReference?: string; paymentMethod?: "bank_transfer" | "cash" },
  ): Promise<{
    readonly bankAccountId: string | null;
    readonly bankReference: string | null;
    readonly method: "bank_transfer" | "cash";
  }> {
    const method = input.paymentMethod ?? "cash";
    const bankAccountId = input.bankAccountId?.trim() || null;
    const bankReference = input.bankReference?.trim() || null;
    if (method === "cash") {
      if (bankAccountId !== null || bankReference !== null) {
        throw new ApplicationException(
          "cash_payment_bank_details_not_allowed",
          "Cash payments cannot include bank account or bank reference",
          HttpStatus.BAD_REQUEST,
        );
      }
      return { bankAccountId: null, bankReference: null, method };
    }
    if (bankAccountId === null || bankReference === null) {
      throw new ApplicationException(
        "bank_payment_incomplete",
        "Bank account and bank reference are required for bank transfer payments",
        HttpStatus.BAD_REQUEST,
      );
    }
    const existing = await sql<{ id: string }>`
      select id from company_bank_accounts
       where id = ${bankAccountId}::uuid and company_id = ${companyId}::uuid and is_active
       limit 1
    `.execute(database);
    if (existing.rows[0] === undefined) {
      throw new ApplicationException(
        "bank_account_not_found",
        "The selected bank account is not active in this Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    return { bankAccountId, bankReference, method };
  }

  private async resolveTraderBeneficiary(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    traderId: string,
    requestedId?: string,
  ): Promise<{ readonly id: string; readonly snapshot: Record<string, string> }> {
    const result = await sql<{
      accountName: string;
      accountNumber: string;
      bankName: string;
      iban: string;
      id: string;
      swiftCode: string | null;
    }>`
      select id, bank_name as "bankName", account_name as "accountName",
             account_number as "accountNumber", iban, swift_code as "swiftCode"
        from trader_bank_accounts
       where company_id = ${companyId}::uuid and trader_id = ${traderId}::uuid and is_active
         and (${requestedId ?? null}::uuid is null or id = ${requestedId ?? null}::uuid)
       order by case when id = ${requestedId ?? null}::uuid then 0 when is_default then 1 else 2 end,
                created_at desc
       limit 1
    `.execute(database);
    const account = result.rows[0];
    if (account === undefined) {
      throw new ApplicationException(
        "trader_beneficiary_required",
        "An active Trader beneficiary bank account is required for bank transfer",
        HttpStatus.BAD_REQUEST,
      );
    }
    return {
      id: account.id,
      snapshot: {
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        bankName: account.bankName,
        iban: account.iban,
        swiftCode: account.swiftCode ?? "",
      },
    };
  }

  private async settlementResult(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    settlementId: string,
  ): Promise<CreateTraderSettlementResult> {
    const result = await sql<CreateTraderSettlementResult & { total: number }>`
      select s.id as "settlementId", s.settlement_number as "settlementNumber",
             s.trader_id as "traderId", t.name_en as "traderName",
             s.net_payable::text as "amount",
             coalesce(p.payment_method, 'cash') as "paymentMethod",
             coalesce(lines.total, 0)::int as "orderCount"
        from trader_settlements s
        join traders t on t.id = s.trader_id and t.company_id = s.company_id
        left join lateral (
          select payment_method from trader_settlement_payments p
           where p.settlement_id = s.id and p.company_id = s.company_id limit 1
        ) p on true
        left join lateral (
          select count(*)::int as total from trader_settlement_orders link
           where link.settlement_id = s.id and link.company_id = s.company_id
        ) lines on true
       where s.id = ${settlementId}::uuid and s.company_id = ${companyId}::uuid
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "settlement_not_found",
        "Trader settlement not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private maskAccountNumber(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length <= 4) return "*".repeat(trimmed.length);
    return `${"*".repeat(trimmed.length - 4)}${trimmed.slice(-4)}`;
  }

  private maskIban(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length <= 8) return "*".repeat(trimmed.length);
    return `${trimmed.slice(0, 4)}${"*".repeat(trimmed.length - 8)}${trimmed.slice(-4)}`;
  }

  private materialFingerprint(input: CreateTraderSettlementDto): string {
    const material = {
      allocations: input.allocations
        .map((line: TraderSettlementAllocationLineDto) =>
          [line.orderId, new Decimal(line.amount).toFixed(2)].join("|"),
        )
        .sort(),
      amount: new Decimal(input.amount).toFixed(2),
      bankAccountId: input.bankAccountId ?? "",
      bankReference: input.bankReference?.trim() ?? "",
      notes: input.notes?.trim() ?? "",
      paymentDate: input.paymentDate ?? "",
      paymentMethod: input.paymentMethod ?? "cash",
      traderBankAccountId: input.traderBankAccountId ?? "",
      traderId: input.traderId,
    };
    return createHash("sha256").update(JSON.stringify(material)).digest("hex");
  }

  private money(amount: Decimal): Decimal {
    return amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  private pagination(query: { page?: number; pageSize?: number }): {
    limit: number;
    offset: number;
    page: number;
    pageSize: number;
  } {
    const page = Number.isInteger(query.page) && (query.page ?? 0) > 0 ? (query.page ?? 1) : 1;
    const requested = query.pageSize ?? defaultPageSize;
    const pageSize = traderSettlementPageSizes.includes(
      requested as (typeof traderSettlementPageSizes)[number],
    )
      ? requested
      : defaultPageSize;
    return { limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
  }

  private page<T extends { total?: number }>(
    rows: readonly T[],
    page: number,
    pageSize: number,
  ): Page<T> {
    return { items: rows, page, pageSize, total: rows[0]?.total ?? 0 };
  }

  private assertAnyPermission(permission: string | readonly string[]): void {
    const permissions = this.identities.current().permissions;
    const required = Array.isArray(permission) ? permission : [permission];
    if (
      !permissions.has("users_roles.manage") &&
      !required.some((candidate) => permissions.has(candidate))
    ) {
      throw new ApplicationException(
        "permission_denied",
        "The authenticated account does not have permission for this operation",
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
