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
import { traderReceivablePageSizes } from "./operations.dto.js";
import type {
  CancelTraderReceivableDto,
  CreateTraderCollectionDto,
  CreateTraderReceivableDto,
  ProposeTraderReceivableAllocationDto,
  TraderCollectionAllocationLineDto,
  TraderCollectionFilterDto,
  TraderCollectionListQueryDto,
  TraderCollectionSummaryQueryDto,
  TraderReceivableEligibleQueryDto,
} from "./operations.dto.js";

const defaultPageSize = 25;
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{16,128}$/;
const idempotencyOperationCreateReceivable = "trader_receivables.create";
const idempotencyOperationCreateCollection = "trader_receivables.collect";
const receivableNumberReferenceType = "trader_receivable";
const receivableNumberPrefix = "RCV";
const collectionNumberReferenceType = "trader_collection";
const collectionNumberPrefix = "COL";
// The two receivable statuses a Collection may ever draw money from — a
// Receivable that is `collected`, `cancelled` or `reversed` never appears in
// the Eligible list, the allocation proposal, or a Collection confirmation.
const eligibleReceivableStatuses = ["outstanding", "partially_collected"] as const;

interface LockedReceivableRow {
  readonly amountCollected: string;
  readonly businessDate: string;
  readonly id: string;
  readonly originalAmountDue: string;
  readonly receivableNumber: string;
  readonly reason: string;
  readonly sourceReference: string | null;
  readonly sourceType: string;
  readonly status: string;
  readonly traderId: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface CreateTraderReceivableResult {
  readonly amountDue: string;
  readonly businessDate: string;
  readonly receivableId: string;
  readonly receivableNumber: string;
  readonly sourceType: string;
  readonly status: string;
  readonly traderId: string;
  readonly traderName: string;
}

export interface TraderReceivableEligibleRow {
  readonly businessDate: string;
  readonly id: string;
  readonly originalAmountDue: string;
  readonly outstandingAmount: string;
  readonly previouslyCollected: string;
  readonly reason: string;
  readonly receivableNumber: string;
  readonly sourceReference: string | null;
  readonly sourceType: string;
  readonly status: string;
  readonly traderName: string;
}

export interface TraderAllocationProposalLine {
  readonly businessDate: string;
  readonly outstandingAfter: string;
  readonly outstandingBefore: string;
  readonly proposedAmount: string;
  readonly receivableId: string;
  readonly receivableNumber: string;
}

export interface TraderAllocationProposal {
  readonly allocations: readonly TraderAllocationProposalLine[];
  readonly requestedAmount: string;
  readonly totalAllocated: string;
  readonly traderId: string;
}

export interface CreateTraderCollectionResult {
  readonly amountReceived: string;
  readonly collectionId: string;
  readonly collectionNumber: string;
  readonly paymentDate: string;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly receivableCount: number;
  readonly remainingDue: string;
  readonly traderId: string;
  readonly traderName: string;
}

export interface ReverseTraderCollectionResult {
  readonly collectionId: string;
  readonly collectionNumber: string;
  readonly receivableCount: number;
  readonly restoredAmount: string;
  readonly traderId: string;
}

export interface TraderCollectionListRow {
  readonly amountReceived: string;
  readonly collectionId: string;
  readonly collectionNumber: string;
  readonly createdAt: string;
  readonly isReversed: boolean;
  readonly paymentDate: string;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly paymentReference: string | null;
  readonly receivableCount: number;
  readonly receivedBy: string;
  readonly status: "confirmed" | "reversed";
  readonly traderName: string;
}

export interface TraderReceivableSummary {
  readonly collectedThisPeriod: string;
  readonly outstandingReceivablesCount: number;
  readonly partiallyCollectedAmount: string;
  readonly reversedCollections: number;
  readonly totalOutstandingReceivables: string;
  readonly totalRemainingDue: string;
  readonly tradersWithOutstandingReceivables: number;
}

interface MaskedBankSnapshot {
  readonly accountName: string;
  readonly accountNumberMasked: string;
  readonly bankName: string;
  readonly ibanMasked: string;
  readonly swiftCode: string | null;
}

export interface TraderCollectionAllocationDetail {
  readonly amountCollectedNow: string;
  readonly businessDate: string;
  readonly originalAmountDue: string;
  readonly previouslyCollected: string;
  readonly reason: string;
  readonly receivableNumber: string;
  readonly receivableStatus: string;
  readonly remainingDue: string;
  readonly sourceReference: string | null;
  readonly sourceType: string;
}

interface TraderCollectionSummaryTotals {
  readonly amountReceivedNow: string;
  readonly previouslyCollected: string;
  readonly receivableCount: number;
  readonly remainingDue: string;
  readonly totalOriginalAmountDue: string;
}

export interface TraderCollectionDetail {
  readonly allocations: readonly TraderCollectionAllocationDetail[];
  readonly collectionId: string;
  readonly collectionNumber: string;
  readonly companyBankAccount: MaskedBankSnapshot | null;
  readonly createdAt: string;
  readonly notes: string | null;
  readonly paymentDate: string;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly paymentReference: string | null;
  readonly receivedBy: string;
  readonly reversalDate: string | null;
  readonly reversalReason: string | null;
  readonly reversedBy: string | null;
  readonly status: "confirmed" | "reversed";
  readonly summary: TraderCollectionSummaryTotals;
  readonly traderName: string;
}

export interface TraderCollectionReportData {
  readonly header: {
    readonly collectionNumber: string;
    readonly company: {
      readonly hasLogo: boolean;
      readonly nameAr: string | null;
      readonly nameEn: string;
      readonly subtitleAr: string | null;
      readonly subtitleEn: string | null;
      readonly telephone: string | null;
    };
    readonly companyBankAccount: MaskedBankSnapshot | null;
    readonly generatedAt: string;
    readonly paymentDate: string;
    readonly paymentMethod: "bank_transfer" | "cash";
    readonly paymentReference: string | null;
    readonly receivedBy: string;
    readonly reversalDate: string | null;
    readonly reversalReason: string | null;
    readonly reversedBy: string | null;
    readonly status: "confirmed" | "reversed";
    readonly traderName: string;
  };
  readonly lines: readonly TraderCollectionAllocationDetail[];
  readonly summary: TraderCollectionSummaryTotals & { readonly notes: string | null };
}

/**
 * Trader Receivable / Collect Money from Trader — the reverse money-flow
 * direction from Trader Settlement (Trader -> Company). Deliberately its own
 * service, its own tables (`trader_receivables`, `trader_collections`,
 * `trader_collection_allocations`) and its own permissions
 * (`trader_receivables.create` / `.reverse`) — never
 * `TraderSettlementService`, `settlements.*`, `orders`, or Driver Collections.
 */
@Injectable()
export class TraderReceivableService {
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
   * Create one Trader receivable (§1). Always starts `outstanding` with
   * nothing collected — a receivable is never created pre-collected.
   */
  public async createReceivable(
    input: CreateTraderReceivableDto,
    correlationId: string,
    idempotencyKey?: string,
  ): Promise<CreateTraderReceivableResult> {
    this.assertAnyPermission("trader_receivables.create");
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
      .update(
        JSON.stringify({
          amountDue: new Decimal(input.amountDue).toFixed(2),
          businessDate: input.businessDate,
          notes: input.notes?.trim() ?? "",
          reason: input.reason.trim(),
          sourceReference: input.sourceReference?.trim() ?? "",
          sourceType: input.sourceType,
          traderId: input.traderId,
        }),
      )
      .digest("hex");

    return this.transactions.execute(async (transaction) => {
      const reserved = await sql<{ id: string }>`
        insert into idempotency_records (
          company_id, operation, idempotency_key, request_hash, expires_at
        ) values (
          ${companyId}::uuid, ${idempotencyOperationCreateReceivable}, ${key}, ${requestHash},
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
            and operation = ${idempotencyOperationCreateReceivable}
            and idempotency_key = ${key}
          for update
        `.execute(transaction);
        const record = existing.rows[0];
        if (record === undefined || record.requestHash !== requestHash) {
          throw new ApplicationException(
            "idempotency_key_reused",
            "This submission key was already used for different receivable details",
            HttpStatus.CONFLICT,
          );
        }
        if (record.resourceId !== null) {
          return this.receivableResult(transaction, companyId, record.resourceId);
        }
        throw new ApplicationException(
          "trader_receivable_submission_in_progress",
          "This receivable submission is already being processed",
          HttpStatus.CONFLICT,
        );
      }

      const trader = await this.lockActiveTrader(transaction, companyId, input.traderId);
      const receivableNumber = await this.history.nextReferenceNumber(
        transaction,
        companyId,
        receivableNumberReferenceType,
        receivableNumberPrefix,
      );
      const amountDue = this.money(new Decimal(input.amountDue));
      const created = await sql<{ id: string }>`
        insert into trader_receivables (
          company_id, receivable_number, trader_id, source_type, source_reference,
          business_date, original_amount_due, amount_collected, status, reason, notes,
          created_by_account_id
        ) values (
          ${companyId}::uuid, ${receivableNumber}, ${input.traderId}::uuid, ${input.sourceType},
          ${input.sourceReference?.trim() || null}, ${input.businessDate}::date,
          ${amountDue.toNumber()}, 0, 'outstanding', ${input.reason.trim()},
          ${input.notes?.trim() || null}, ${identity.identityId}::uuid
        )
        returning id
      `.execute(transaction);
      const receivableId = created.rows[0]?.id;
      if (receivableId === undefined) {
        throw new Error("Trader receivable creation did not return an identifier");
      }

      await this.history.audit(transaction, {
        action: "trader_receivable.create",
        actorId: identity.identityId,
        after: {
          amountDue: amountDue.toFixed(2),
          businessDate: input.businessDate,
          reason: input.reason.trim(),
          receivableNumber,
          sourceReference: input.sourceReference?.trim() || null,
          sourceType: input.sourceType,
          traderId: input.traderId,
        },
        companyId,
        correlationId,
        subjectId: receivableId,
        subjectType: "trader_receivable",
      });
      await sql`
        update idempotency_records
           set response_status = 201, resource_type = 'trader_receivable',
               resource_id = ${receivableId}::uuid, completed_at = now()
         where company_id = ${companyId}::uuid
           and operation = ${idempotencyOperationCreateReceivable}
           and idempotency_key = ${key}
      `.execute(transaction);

      return {
        amountDue: amountDue.toFixed(2),
        businessDate: input.businessDate,
        receivableId,
        receivableNumber,
        sourceType: input.sourceType,
        status: "outstanding",
        traderId: input.traderId,
        traderName: trader.nameEn,
      };
    });
  }

  /**
   * Cancel a Trader receivable (§2). Only ever allowed while nothing has been
   * collected against it — once any Collection has touched it, `cancel` is no
   * longer offered and reversal (of the Collection, not the receivable) is
   * the only path back to `outstanding`.
   */
  public async cancelReceivable(
    receivableId: string,
    input: CancelTraderReceivableDto,
    correlationId: string,
  ): Promise<{ readonly receivableId: string; readonly status: string }> {
    this.assertAnyPermission("trader_receivables.create");
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const trimmedReason = input.reason.trim();
    if (trimmedReason === "") {
      throw new ApplicationException(
        "trader_receivable_cancel_reason_required",
        "A reason is required to cancel a Trader receivable",
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.transactions.execute(async (transaction) => {
      const receivable = (
        await sql<{ status: string }>`
          select status from trader_receivables
           where id = ${receivableId}::uuid and company_id = ${companyId}::uuid
           for update
        `.execute(transaction)
      ).rows[0];
      if (receivable === undefined) {
        throw new ApplicationException(
          "trader_receivable_not_found",
          "Trader receivable not found",
          HttpStatus.NOT_FOUND,
        );
      }
      if (receivable.status !== "outstanding") {
        throw new ApplicationException(
          "trader_receivable_not_cancellable",
          "Only an outstanding receivable with nothing collected can be cancelled",
          HttpStatus.CONFLICT,
        );
      }
      await sql`
        update trader_receivables
           set status = 'cancelled', updated_at = now()
         where id = ${receivableId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      await this.history.audit(transaction, {
        action: "trader_receivable.cancel",
        actorId: identity.identityId,
        after: { reason: trimmedReason },
        companyId,
        correlationId,
        subjectId: receivableId,
        subjectType: "trader_receivable",
      });
      return { receivableId, status: "cancelled" };
    });
  }

  /**
   * Eligible receivables (§3), paginated: always restricted server-side to
   * `outstanding` / `partially_collected` — a caller-supplied `status` filter
   * outside that pair simply narrows to zero rows rather than being trusted.
   */
  public async eligibleReceivables(
    query: TraderReceivableEligibleQueryDto,
  ): Promise<Page<TraderReceivableEligibleRow>> {
    this.assertAnyPermission("trader_receivables.create");
    const { companyId } = this.tenants.current();
    const { limit, offset, page, pageSize } = this.pagination(query);
    const direction = query.sortDirection === "desc" ? "desc" : "asc";
    const sortColumn =
      query.sortBy === "receivableNumber"
        ? "r.receivable_number"
        : query.sortBy === "outstandingAmount"
          ? "r.outstanding_amount"
          : "r.business_date";
    const filters = sql`
      r.company_id = ${companyId}::uuid
        and r.status in ('outstanding', 'partially_collected')
        and (${query.traderId ?? null}::uuid is null or r.trader_id = ${query.traderId ?? null}::uuid)
        and (${query.receivableNumber ?? null}::text is null
             or r.receivable_number ilike '%' || ${query.receivableNumber ?? null} || '%')
        and (${query.sourceType ?? null}::text is null or r.source_type = ${query.sourceType ?? null}::text)
        and (${query.sourceReference ?? null}::text is null
             or r.source_reference ilike '%' || ${query.sourceReference ?? null} || '%')
        and (${query.status ?? null}::text is null or r.status = ${query.status ?? null}::text)
        and (${query.businessDateFrom ?? null}::date is null
             or r.business_date >= ${query.businessDateFrom ?? null}::date)
        and (${query.businessDateTo ?? null}::date is null
             or r.business_date <= ${query.businessDateTo ?? null}::date)
        and (${query.outstandingOnly === true} = false or r.outstanding_amount > 0)
    `;
    const result = await sql<TraderReceivableEligibleRow & { total: number }>`
      select r.id, r.receivable_number as "receivableNumber", t.name_en as "traderName",
             r.business_date::text as "businessDate", r.source_type as "sourceType",
             r.source_reference as "sourceReference", r.reason,
             r.original_amount_due::text as "originalAmountDue",
             r.amount_collected::text as "previouslyCollected",
             r.outstanding_amount::text as "outstandingAmount", r.status,
             count(*) over()::int as total
        from trader_receivables r
        join traders t on t.id = r.trader_id and t.company_id = r.company_id
       where ${filters}
       order by ${sql.raw(sortColumn)} ${sql.raw(direction)}, r.receivable_number ${sql.raw(direction)}
       limit ${limit} offset ${offset}
    `.execute(this.database);
    return this.page(result.rows, page, pageSize);
  }

  /**
   * Oldest-first default allocation proposal (§4): read-only, writes nothing.
   * Sorted by Business Date ascending with the Receivable Number as a stable
   * tie-breaker. Rejects outright when the requested amount exceeds the
   * Trader's total eligible outstanding — there is nothing sensible to
   * propose beyond that point.
   */
  public async proposeAllocation(
    input: ProposeTraderReceivableAllocationDto,
  ): Promise<TraderAllocationProposal> {
    this.assertAnyPermission("trader_receivables.create");
    const { companyId } = this.tenants.current();
    const receivables = await this.resolveEligibleReceivablesForTrader(
      this.database,
      companyId,
      input.traderId,
      false,
    );
    const totalOutstanding = receivables.reduce(
      (sum, receivable) => sum.plus(receivable.originalAmountDue).minus(receivable.amountCollected),
      new Decimal(0),
    );
    const requestedAmount = this.money(new Decimal(input.amount));
    if (requestedAmount.greaterThan(totalOutstanding)) {
      throw new ApplicationException(
        "trader_receivable_allocation_exceeds_outstanding",
        "Amount Received cannot exceed the Trader's total outstanding receivables",
        HttpStatus.BAD_REQUEST,
      );
    }
    let remaining = requestedAmount;
    const allocations: TraderAllocationProposalLine[] = [];
    for (const receivable of receivables) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const outstanding = new Decimal(receivable.originalAmountDue).minus(receivable.amountCollected);
      if (outstanding.lessThanOrEqualTo(0)) continue;
      const allocated = Decimal.min(remaining, outstanding);
      allocations.push({
        businessDate: receivable.businessDate,
        outstandingAfter: this.money(outstanding.minus(allocated)).toFixed(2),
        outstandingBefore: this.money(outstanding).toFixed(2),
        proposedAmount: this.money(allocated).toFixed(2),
        receivableId: receivable.id,
        receivableNumber: receivable.receivableNumber,
      });
      remaining = remaining.minus(allocated);
    }
    const totalAllocated = allocations.reduce(
      (sum, line) => sum.plus(line.proposedAmount),
      new Decimal(0),
    );
    return {
      allocations,
      requestedAmount: requestedAmount.toFixed(2),
      totalAllocated: totalAllocated.toFixed(2),
      traderId: input.traderId,
    };
  }

  /**
   * Confirm a Trader collection (§5), full or partial across one or more
   * receivables. Every allocation is revalidated against the LOCKED, current
   * outstanding balance of its receivable — never a stale caller-supplied
   * value — so two concurrent collections (or a stale allocation proposal)
   * can never over-allocate the same receivable.
   */
  public async confirmCollection(
    input: CreateTraderCollectionDto,
    correlationId: string,
    idempotencyKey?: string,
  ): Promise<CreateTraderCollectionResult> {
    this.assertAnyPermission("trader_receivables.create");
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
    const requestHash = this.collectionFingerprint(input);

    return this.transactions.execute(async (transaction) => {
      // 1. Reserve the idempotency key before touching any row.
      const reserved = await sql<{ id: string }>`
        insert into idempotency_records (
          company_id, operation, idempotency_key, request_hash, expires_at
        ) values (
          ${companyId}::uuid, ${idempotencyOperationCreateCollection}, ${key}, ${requestHash},
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
            and operation = ${idempotencyOperationCreateCollection}
            and idempotency_key = ${key}
          for update
        `.execute(transaction);
        const record = existing.rows[0];
        if (record === undefined || record.requestHash !== requestHash) {
          throw new ApplicationException(
            "idempotency_key_reused",
            "This submission key was already used for a different collection",
            HttpStatus.CONFLICT,
          );
        }
        if (record.resourceId !== null) {
          return this.collectionResult(transaction, companyId, record.resourceId);
        }
        throw new ApplicationException(
          "trader_collection_submission_in_progress",
          "This collection submission is already being processed",
          HttpStatus.CONFLICT,
        );
      }

      // 2. Validate the trader and the allocation shape before any lock.
      const trader = await this.lockActiveTrader(transaction, companyId, input.traderId);
      const allocated = input.allocations.filter((line) => line.amount > 0);
      if (allocated.length === 0) {
        throw new ApplicationException(
          "trader_collection_allocation_empty",
          "Allocate the collection to at least one receivable",
          HttpStatus.BAD_REQUEST,
        );
      }
      const receivableIds = allocated.map((line) => line.receivableId);
      if (new Set(receivableIds).size !== receivableIds.length) {
        throw new ApplicationException(
          "trader_collection_allocation_duplicate_receivable",
          "The same receivable cannot receive two allocation rows",
          HttpStatus.BAD_REQUEST,
        );
      }
      const allocationTotal = allocated.reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
      const amountReceived = this.money(new Decimal(input.amountReceived));
      if (!this.money(allocationTotal).equals(amountReceived)) {
        throw new ApplicationException(
          "trader_collection_allocation_mismatch",
          "The total allocation must equal Amount Received exactly",
          HttpStatus.BAD_REQUEST,
        );
      }

      // 3. Lock the allocated receivables in a deterministic order (by id),
      //    then recalculate their outstanding balance from the LOCKED row.
      const receivables = await this.lockReceivables(transaction, companyId, receivableIds);
      if (receivables.length !== receivableIds.length) {
        const foundIds = new Set(receivables.map((receivable) => receivable.id));
        throw new ApplicationException(
          "trader_receivable_not_found",
          "One or more selected receivables were not found in this Company",
          HttpStatus.NOT_FOUND,
          receivableIds.filter((id) => !foundIds.has(id)),
        );
      }
      this.assertReceivablesCollectable(receivables, input.traderId);
      const amountByReceivable = new Map(allocated.map((line) => [line.receivableId, line.amount]));
      const overAllocated = receivables.filter((receivable) => {
        const amount = amountByReceivable.get(receivable.id) ?? 0;
        const outstanding = new Decimal(receivable.originalAmountDue).minus(receivable.amountCollected);
        return new Decimal(amount).greaterThan(outstanding);
      });
      if (overAllocated.length > 0) {
        throw new ApplicationException(
          "trader_collection_allocation_exceeds_outstanding",
          "One or more allocations exceed the receivable's current outstanding balance",
          HttpStatus.CONFLICT,
          overAllocated.map((receivable) => receivable.receivableNumber),
        );
      }

      // 4. Resolve and validate the payment method and Company bank account.
      const payment = await this.resolveCollectionPayment(transaction, companyId, {
        ...(input.bankAccountId === undefined ? {} : { bankAccountId: input.bankAccountId }),
        ...(input.paymentMethod === undefined ? {} : { paymentMethod: input.paymentMethod }),
        ...(input.paymentReference === undefined ? {} : { paymentReference: input.paymentReference }),
      });

      // 5. Write everything atomically: header, allocation rows, receivable updates.
      const collectionNumber = await this.history.nextReferenceNumber(
        transaction,
        companyId,
        collectionNumberReferenceType,
        collectionNumberPrefix,
      );
      const header = await sql<{ id: string }>`
        insert into trader_collections (
          company_id, collection_number, trader_id, payment_date, payment_method,
          amount_received, company_bank_account_id, payment_reference, notes, status,
          received_by_account_id
        ) values (
          ${companyId}::uuid, ${collectionNumber}, ${input.traderId}::uuid,
          coalesce(${input.paymentDate ?? null}::date, current_date), ${payment.method},
          ${amountReceived.toNumber()}, ${payment.bankAccountId}::uuid, ${payment.paymentReference},
          ${input.notes?.trim() || null}, 'confirmed', ${identity.identityId}::uuid
        )
        returning id
      `.execute(transaction);
      const collectionId = header.rows[0]?.id;
      if (collectionId === undefined) {
        throw new Error("Trader collection creation did not return an identifier");
      }

      let remainingDue = new Decimal(0);
      for (const receivable of receivables) {
        const amount = new Decimal(amountByReceivable.get(receivable.id) ?? 0);
        await sql`
          insert into trader_collection_allocations (
            company_id, collection_id, receivable_id, amount_allocated
          ) values (
            ${companyId}::uuid, ${collectionId}::uuid, ${receivable.id}::uuid, ${this.money(amount).toNumber()}
          )
        `.execute(transaction);
        const newCollected = new Decimal(receivable.amountCollected).plus(amount);
        const outstandingAfter = new Decimal(receivable.originalAmountDue).minus(newCollected);
        const newStatus = outstandingAfter.lessThanOrEqualTo(0) ? "collected" : "partially_collected";
        await sql`
          update trader_receivables
             set amount_collected = ${this.money(newCollected).toNumber()}, status = ${newStatus},
                 updated_at = now()
           where id = ${receivable.id}::uuid and company_id = ${companyId}::uuid
        `.execute(transaction);
        remainingDue = remainingDue.plus(Decimal.max(0, outstandingAfter));
        await this.history.audit(transaction, {
          action: newStatus === "collected" ? "trader_receivable.collected" : "trader_receivable.partial_collection",
          actorId: identity.identityId,
          after: {
            allocatedAmount: this.money(amount).toFixed(2),
            collectionNumber,
            outstandingAfter: this.money(Decimal.max(0, outstandingAfter)).toFixed(2),
            receivableNumber: receivable.receivableNumber,
            status: newStatus,
          },
          companyId,
          correlationId,
          subjectId: receivable.id,
          subjectType: "trader_receivable",
        });
      }

      await this.history.audit(transaction, {
        action: "trader_collection.confirm",
        actorId: identity.identityId,
        after: {
          amountReceived: amountReceived.toFixed(2),
          collectionNumber,
          paymentMethod: payment.method,
          receivableCount: receivables.length,
          traderId: input.traderId,
        },
        companyId,
        correlationId,
        subjectId: collectionId,
        subjectType: "trader_collection",
      });
      await sql`
        update idempotency_records
           set response_status = 201, resource_type = 'trader_collection',
               resource_id = ${collectionId}::uuid, completed_at = now()
         where company_id = ${companyId}::uuid
           and operation = ${idempotencyOperationCreateCollection}
           and idempotency_key = ${key}
      `.execute(transaction);

      return {
        amountReceived: amountReceived.toFixed(2),
        collectionId,
        collectionNumber,
        paymentDate: input.paymentDate ?? new Date().toISOString().slice(0, 10),
        paymentMethod: payment.method,
        receivableCount: receivables.length,
        remainingDue: this.money(remainingDue).toFixed(2),
        traderId: input.traderId,
        traderName: trader.nameEn,
      };
    });
  }

  /**
   * Reverse a confirmed Trader collection (§6). The original collection,
   * its allocation rows, and their amounts are never modified or deleted —
   * only `status` and the `reversed_*` columns on the collection itself
   * change, and each allocated receivable's `amount_collected` is reduced
   * back by exactly the amount this collection contributed.
   */
  public async reverseCollection(
    collectionId: string,
    reason: string,
    correlationId: string,
  ): Promise<ReverseTraderCollectionResult> {
    this.assertAnyPermission("trader_receivables.reverse");
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const trimmedReason = reason.trim();
    if (trimmedReason === "") {
      throw new ApplicationException(
        "trader_collection_reversal_reason_required",
        "A reason is required to reverse a Trader collection",
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.transactions.execute(async (transaction) => {
      const collection = (
        await sql<{ collectionNumber: string; status: string; traderId: string }>`
          select collection_number as "collectionNumber", status, trader_id as "traderId"
            from trader_collections
           where id = ${collectionId}::uuid and company_id = ${companyId}::uuid
           for update
        `.execute(transaction)
      ).rows[0];
      if (collection === undefined) {
        throw new ApplicationException(
          "trader_collection_not_found",
          "Trader collection not found",
          HttpStatus.NOT_FOUND,
        );
      }
      if (collection.status === "reversed") {
        throw new ApplicationException(
          "trader_collection_already_reversed",
          "This collection has already been reversed",
          HttpStatus.CONFLICT,
        );
      }

      const allocations = (
        await sql<{
          amountAllocated: string;
          receivableId: string;
          receivableNumber: string;
          receivableOriginalAmountDue: string;
          receivableStatus: string;
        }>`
          select alloc.amount_allocated as "amountAllocated", r.id as "receivableId",
                 r.receivable_number as "receivableNumber", r.status as "receivableStatus",
                 r.original_amount_due::text as "receivableOriginalAmountDue"
            from trader_collection_allocations alloc
            join trader_receivables r on r.id = alloc.receivable_id and r.company_id = alloc.company_id
           where alloc.collection_id = ${collectionId}::uuid and alloc.company_id = ${companyId}::uuid
           order by r.id
           for update of r
        `.execute(transaction)
      ).rows;

      await sql`
        update trader_collections
           set status = 'reversed', reversed_by_account_id = ${identity.identityId}::uuid,
               reversed_at = now(), reversal_reason = ${trimmedReason}
         where id = ${collectionId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);

      let restoredAmount = new Decimal(0);
      for (const allocation of allocations) {
        // Re-read the receivable's CURRENT amount_collected under the lock
        // just taken above — it may have been advanced by a later collection
        // since this one was confirmed, and only this collection's own
        // contribution is ever backed out.
        const current = (
          await sql<{ amountCollected: string }>`
            select amount_collected::text as "amountCollected" from trader_receivables
             where id = ${allocation.receivableId}::uuid and company_id = ${companyId}::uuid
          `.execute(transaction)
        ).rows[0];
        const currentCollected = new Decimal(current?.amountCollected ?? "0");
        const newCollected = Decimal.max(0, currentCollected.minus(allocation.amountAllocated));
        const newStatus = newCollected.lessThanOrEqualTo(0) ? "outstanding" : "partially_collected";
        await sql`
          update trader_receivables
             set amount_collected = ${this.money(newCollected).toNumber()}, status = ${newStatus},
                 updated_at = now()
           where id = ${allocation.receivableId}::uuid and company_id = ${companyId}::uuid
        `.execute(transaction);
        restoredAmount = restoredAmount.plus(allocation.amountAllocated);
        await this.history.audit(transaction, {
          action: "trader_receivable.collection_reversed",
          actorId: identity.identityId,
          after: {
            collectionNumber: collection.collectionNumber,
            reason: trimmedReason,
            restoredAmount: this.money(new Decimal(allocation.amountAllocated)).toFixed(2),
            status: newStatus,
          },
          companyId,
          correlationId,
          subjectId: allocation.receivableId,
          subjectType: "trader_receivable",
        });
      }

      await this.history.audit(transaction, {
        action: "trader_collection.reverse",
        actorId: identity.identityId,
        after: {
          collectionNumber: collection.collectionNumber,
          reason: trimmedReason,
          receivableCount: allocations.length,
        },
        companyId,
        correlationId,
        subjectId: collectionId,
        subjectType: "trader_collection",
      });

      return {
        collectionId,
        collectionNumber: collection.collectionNumber,
        receivableCount: allocations.length,
        restoredAmount: this.money(restoredAmount).toFixed(2),
        traderId: collection.traderId,
      };
    });
  }

  public async list(query: TraderCollectionListQueryDto): Promise<Page<TraderCollectionListRow>> {
    this.assertAnyPermission("trader_receivables.create");
    const { companyId } = this.tenants.current();
    const { limit, offset, page, pageSize } = this.pagination(query);
    const direction = query.sortDirection === "asc" ? "asc" : "desc";
    const sortColumn = query.sortBy === "collectionNumber" ? "c.collection_number" : "c.payment_date";
    const filters = this.collectionFilters(companyId, query);
    const result = await sql<TraderCollectionListRow & { total: number }>`
      select c.id as "collectionId", c.collection_number as "collectionNumber",
             t.name_en as "traderName", c.payment_date::text as "paymentDate",
             c.payment_method as "paymentMethod", c.payment_reference as "paymentReference",
             c.amount_received::text as "amountReceived", c.status,
             (c.status = 'reversed') as "isReversed",
             coalesce(receiver.username, 'Legacy/Unknown') as "receivedBy",
             c.created_at::text as "createdAt",
             coalesce(lines.total, 0)::int as "receivableCount",
             count(*) over()::int as total
        from trader_collections c
        join traders t on t.id = c.trader_id and t.company_id = c.company_id
        left join accounts receiver
          on receiver.id = c.received_by_account_id and receiver.company_id = c.company_id
        left join lateral (
          select count(*)::int as total from trader_collection_allocations alloc
           where alloc.collection_id = c.id and alloc.company_id = c.company_id
        ) lines on true
       where ${filters}
       order by ${sql.raw(sortColumn)} ${sql.raw(direction)}, c.created_at desc
       limit ${limit} offset ${offset}
    `.execute(this.database);
    return this.page(result.rows, page, pageSize);
  }

  /**
   * Server-authoritative summary cards (§8) — never derived from a paginated
   * page of results.
   */
  public async summary(query: TraderCollectionSummaryQueryDto): Promise<TraderReceivableSummary> {
    this.assertAnyPermission("trader_receivables.create");
    const { companyId } = this.tenants.current();
    const receivableTotals = await sql<{
      outstandingReceivablesCount: number;
      partiallyCollectedAmount: string;
      totalOutstandingReceivables: string;
      totalRemainingDue: string;
      tradersWithOutstandingReceivables: number;
    }>`
      select
        count(*) filter (where r.status = 'outstanding')::int as "outstandingReceivablesCount",
        coalesce(sum(r.outstanding_amount) filter (where r.status = 'outstanding'), 0)::text
          as "totalOutstandingReceivables",
        coalesce(sum(r.amount_collected) filter (where r.status = 'partially_collected'), 0)::text
          as "partiallyCollectedAmount",
        coalesce(sum(r.outstanding_amount) filter (where r.status in ('outstanding', 'partially_collected')), 0)::text
          as "totalRemainingDue",
        count(distinct r.trader_id) filter (
          where r.status in ('outstanding', 'partially_collected') and r.outstanding_amount > 0
        )::int as "tradersWithOutstandingReceivables"
        from trader_receivables r
       where r.company_id = ${companyId}::uuid
         and (${query.traderId ?? null}::uuid is null or r.trader_id = ${query.traderId ?? null}::uuid)
    `.execute(this.database);
    const filters = this.collectionFilters(companyId, query);
    const collectionTotals = await sql<{ collectedThisPeriod: string; reversedCollections: number }>`
      select
        coalesce(sum(c.amount_received) filter (where c.status = 'confirmed'), 0)::text as "collectedThisPeriod",
        count(*) filter (where c.status = 'reversed')::int as "reversedCollections"
        from trader_collections c
        join traders t on t.id = c.trader_id and t.company_id = c.company_id
       where ${filters}
    `.execute(this.database);
    const receivableRow = receivableTotals.rows[0] ?? {
      outstandingReceivablesCount: 0,
      partiallyCollectedAmount: "0.00",
      totalOutstandingReceivables: "0.00",
      totalRemainingDue: "0.00",
      tradersWithOutstandingReceivables: 0,
    };
    const collectionRow = collectionTotals.rows[0] ?? { collectedThisPeriod: "0.00", reversedCollections: 0 };
    return {
      collectedThisPeriod: new Decimal(collectionRow.collectedThisPeriod).toFixed(2),
      outstandingReceivablesCount: receivableRow.outstandingReceivablesCount,
      partiallyCollectedAmount: new Decimal(receivableRow.partiallyCollectedAmount).toFixed(2),
      reversedCollections: collectionRow.reversedCollections,
      totalOutstandingReceivables: new Decimal(receivableRow.totalOutstandingReceivables).toFixed(2),
      totalRemainingDue: new Decimal(receivableRow.totalRemainingDue).toFixed(2),
      tradersWithOutstandingReceivables: receivableRow.tradersWithOutstandingReceivables,
    };
  }

  public async detail(collectionId: string): Promise<TraderCollectionDetail> {
    this.assertAnyPermission("trader_receivables.create");
    const { companyId } = this.tenants.current();
    const header = await this.collectionHeader(companyId, collectionId);
    const allocations = await this.collectionAllocations(companyId, collectionId);
    return {
      allocations: allocations.lines,
      collectionId,
      collectionNumber: header.collectionNumber,
      companyBankAccount: header.companyBankAccount,
      createdAt: header.createdAt,
      notes: header.notes,
      paymentDate: header.paymentDate,
      paymentMethod: header.paymentMethod,
      paymentReference: header.paymentReference,
      receivedBy: header.receivedBy,
      reversalDate: header.reversalDate,
      reversalReason: header.reversalReason,
      reversedBy: header.reversedBy,
      status: header.status,
      summary: allocations.summary,
      traderName: header.traderName,
    };
  }

  /**
   * Server-authoritative Trader Payment Receipt report-data (§10). No PDF is
   * generated here — this is data only, for a future PDF step.
   */
  public async reportData(collectionId: string): Promise<TraderCollectionReportData> {
    this.assertAnyPermission(["trader_receivables.create", "reports.export"]);
    const { companyId } = this.tenants.current();
    const header = await this.collectionHeader(companyId, collectionId);
    const allocations = await this.collectionAllocations(companyId, collectionId);
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
        collectionNumber: header.collectionNumber,
        company: {
          hasLogo: branding.hasLogo,
          nameAr: branding.nameAr,
          nameEn: branding.nameEn,
          subtitleAr: branding.subtitleAr,
          subtitleEn: branding.subtitleEn,
          telephone: branding.telephone,
        },
        companyBankAccount: header.companyBankAccount,
        generatedAt: `${generatedAt} (UAE)`,
        paymentDate: header.paymentDate,
        paymentMethod: header.paymentMethod,
        paymentReference: header.paymentReference,
        receivedBy: header.receivedBy,
        reversalDate: header.reversalDate,
        reversalReason: header.reversalReason,
        reversedBy: header.reversedBy,
        status: header.status,
        traderName: header.traderName,
      },
      lines: allocations.lines,
      summary: { ...allocations.summary, notes: header.notes },
    };
  }

  // ---------------------------------------------------------------------
  // Shared internals
  // ---------------------------------------------------------------------

  private async lockActiveTrader(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    traderId: string,
  ): Promise<{ readonly id: string; readonly nameEn: string }> {
    const trader = (
      await sql<{ accountStatus: string; id: string; nameEn: string }>`
        select id, name_en as "nameEn", account_status as "accountStatus"
          from traders
         where id = ${traderId}::uuid and company_id = ${companyId}::uuid
         for update
      `.execute(database)
    ).rows[0];
    if (trader === undefined) {
      throw new ApplicationException("trader_not_found", "Trader not found", HttpStatus.NOT_FOUND);
    }
    if (trader.accountStatus !== "active") {
      throw new ApplicationException(
        "trader_not_active",
        "The Trader must be active",
        HttpStatus.BAD_REQUEST,
      );
    }
    return trader;
  }

  private async resolveEligibleReceivablesForTrader(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    traderId: string,
    lock: boolean,
  ): Promise<readonly LockedReceivableRow[]> {
    const result = await sql<LockedReceivableRow>`
      select r.id, r.receivable_number as "receivableNumber", r.trader_id as "traderId",
             r.source_type as "sourceType", r.source_reference as "sourceReference",
             r.business_date::text as "businessDate",
             r.original_amount_due::text as "originalAmountDue",
             r.amount_collected::text as "amountCollected", r.status, r.reason
        from trader_receivables r
       where r.company_id = ${companyId}::uuid
         and r.trader_id = ${traderId}::uuid
         and r.status in ('outstanding', 'partially_collected')
       order by r.business_date asc, r.receivable_number asc, r.id asc
       ${sql.raw(lock ? "for update of r" : "")}
    `.execute(database);
    return result.rows;
  }

  private async lockReceivables(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    receivableIds: readonly string[],
  ): Promise<readonly LockedReceivableRow[]> {
    if (receivableIds.length === 0) return [];
    const result = await sql<LockedReceivableRow>`
      select r.id, r.receivable_number as "receivableNumber", r.trader_id as "traderId",
             r.source_type as "sourceType", r.source_reference as "sourceReference",
             r.business_date::text as "businessDate",
             r.original_amount_due::text as "originalAmountDue",
             r.amount_collected::text as "amountCollected", r.status, r.reason
        from trader_receivables r
       where r.company_id = ${companyId}::uuid
         and r.id in (${sql.join(receivableIds.map((id) => sql`${id}::uuid`))})
       order by r.id
       for update
    `.execute(database);
    return result.rows;
  }

  private assertReceivablesCollectable(
    receivables: readonly LockedReceivableRow[],
    traderId: string,
  ): void {
    if (receivables.length === 0) {
      throw new ApplicationException(
        "trader_collection_allocation_empty",
        "Allocate the collection to at least one receivable",
        HttpStatus.BAD_REQUEST,
      );
    }
    const wrongTrader = receivables.filter((receivable) => receivable.traderId !== traderId);
    if (wrongTrader.length > 0) {
      throw new ApplicationException(
        "trader_collection_trader_mismatch",
        "All selected receivables must belong to the same Trader as the Collection",
        HttpStatus.CONFLICT,
      );
    }
    const ineligible = receivables.filter(
      (receivable) => !eligibleReceivableStatuses.includes(receivable.status as "outstanding"),
    );
    if (ineligible.length > 0) {
      throw new ApplicationException(
        "trader_collection_receivable_ineligible",
        "Every selected receivable must be outstanding or partially collected",
        HttpStatus.CONFLICT,
        ineligible.map((receivable) => receivable.receivableNumber),
      );
    }
  }

  private async resolveCollectionPayment(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    input: { bankAccountId?: string; paymentMethod?: "bank_transfer" | "cash"; paymentReference?: string },
  ): Promise<{
    readonly bankAccountId: string | null;
    readonly method: "bank_transfer" | "cash";
    readonly paymentReference: string | null;
  }> {
    const method = input.paymentMethod ?? "cash";
    const bankAccountId = input.bankAccountId?.trim() || null;
    const paymentReference = input.paymentReference?.trim() || null;
    if (method === "cash") {
      if (bankAccountId !== null || paymentReference !== null) {
        throw new ApplicationException(
          "cash_collection_bank_details_not_allowed",
          "Cash collections cannot include a Company bank account or payment reference",
          HttpStatus.BAD_REQUEST,
        );
      }
      return { bankAccountId: null, method, paymentReference: null };
    }
    if (bankAccountId === null || paymentReference === null) {
      throw new ApplicationException(
        "bank_collection_incomplete",
        "A Company bank account and a payment reference are required for bank transfer collections",
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
        "The selected Company bank account is not active in this Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    return { bankAccountId, method, paymentReference };
  }

  private async receivableResult(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    receivableId: string,
  ): Promise<CreateTraderReceivableResult> {
    const result = await sql<CreateTraderReceivableResult>`
      select r.id as "receivableId", r.receivable_number as "receivableNumber",
             r.trader_id as "traderId", t.name_en as "traderName",
             r.source_type as "sourceType", r.business_date::text as "businessDate",
             r.original_amount_due::text as "amountDue", r.status
        from trader_receivables r
        join traders t on t.id = r.trader_id and t.company_id = r.company_id
       where r.id = ${receivableId}::uuid and r.company_id = ${companyId}::uuid
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "trader_receivable_not_found",
        "Trader receivable not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private async collectionResult(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    collectionId: string,
  ): Promise<CreateTraderCollectionResult> {
    const result = await sql<CreateTraderCollectionResult & { total: number }>`
      select c.id as "collectionId", c.collection_number as "collectionNumber",
             c.trader_id as "traderId", t.name_en as "traderName",
             c.amount_received::text as "amountReceived", c.payment_date::text as "paymentDate",
             c.payment_method as "paymentMethod",
             coalesce(lines.total, 0)::int as "receivableCount",
             coalesce(lines."remainingDue", 0)::text as "remainingDue"
        from trader_collections c
        join traders t on t.id = c.trader_id and t.company_id = c.company_id
        left join lateral (
          select count(*)::int as total,
                 coalesce(sum(r.outstanding_amount), 0) as "remainingDue"
            from trader_collection_allocations alloc
            join trader_receivables r on r.id = alloc.receivable_id and r.company_id = alloc.company_id
           where alloc.collection_id = c.id and alloc.company_id = c.company_id
        ) lines on true
       where c.id = ${collectionId}::uuid and c.company_id = ${companyId}::uuid
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "trader_collection_not_found",
        "Trader collection not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private async collectionHeader(
    companyId: string,
    collectionId: string,
  ): Promise<{
    readonly collectionNumber: string;
    readonly companyBankAccount: MaskedBankSnapshot | null;
    readonly createdAt: string;
    readonly notes: string | null;
    readonly paymentDate: string;
    readonly paymentMethod: "bank_transfer" | "cash";
    readonly paymentReference: string | null;
    readonly receivedBy: string;
    readonly reversalDate: string | null;
    readonly reversalReason: string | null;
    readonly reversedBy: string | null;
    readonly status: "confirmed" | "reversed";
    readonly traderName: string;
  }> {
    const row = (
      await sql<{
        accountName: string | null;
        accountNumberMasked: string | null;
        bankName: string | null;
        collectionNumber: string;
        createdAt: string;
        ibanMasked: string | null;
        notes: string | null;
        paymentDate: string;
        paymentMethod: "bank_transfer" | "cash";
        paymentReference: string | null;
        receivedBy: string;
        reversalReason: string | null;
        reversedAt: string | null;
        reversedBy: string | null;
        status: "confirmed" | "reversed";
        swiftCode: string | null;
        traderName: string;
      }>`
        select c.collection_number as "collectionNumber", c.status,
               c.payment_date::text as "paymentDate", c.payment_method as "paymentMethod",
               c.payment_reference as "paymentReference", c.notes, c.created_at::text as "createdAt",
               t.name_en as "traderName",
               coalesce(receiver.username, 'Legacy/Unknown') as "receivedBy",
               coalesce(reverser.username, 'Legacy/Unknown') as "reversedBy",
               c.reversed_at::text as "reversedAt", c.reversal_reason as "reversalReason",
               cb.bank_name as "bankName", cb.account_name as "accountName",
               cb.account_number_masked as "accountNumberMasked", cb.iban as "ibanMasked",
               cb.swift_code as "swiftCode"
          from trader_collections c
          join traders t on t.id = c.trader_id and t.company_id = c.company_id
          left join accounts receiver
            on receiver.id = c.received_by_account_id and receiver.company_id = c.company_id
          left join accounts reverser
            on reverser.id = c.reversed_by_account_id and reverser.company_id = c.company_id
          left join company_bank_accounts cb
            on cb.id = c.company_bank_account_id and cb.company_id = c.company_id
         where c.id = ${collectionId}::uuid and c.company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "trader_collection_not_found",
        "Trader collection not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return {
      collectionNumber: row.collectionNumber,
      companyBankAccount:
        row.bankName === null || row.accountName === null
          ? null
          : {
              // `company_bank_accounts.account_number_masked` is entered
              // already masked at the source (see CompanyConfigurationService)
              // — passed through as-is, never re-masked.
              accountName: row.accountName,
              accountNumberMasked: row.accountNumberMasked ?? "",
              bankName: row.bankName,
              ibanMasked: this.maskIban(row.ibanMasked ?? ""),
              swiftCode: row.swiftCode,
            },
      createdAt: row.createdAt,
      notes: row.notes,
      paymentDate: row.paymentDate,
      paymentMethod: row.paymentMethod,
      paymentReference: row.paymentReference,
      receivedBy: row.receivedBy,
      reversalDate: row.reversedAt,
      reversalReason: row.reversalReason,
      reversedBy: row.status === "reversed" ? row.reversedBy : null,
      status: row.status,
      traderName: row.traderName,
    };
  }

  private async collectionAllocations(
    companyId: string,
    collectionId: string,
  ): Promise<{
    readonly lines: readonly TraderCollectionAllocationDetail[];
    readonly summary: TraderCollectionSummaryTotals;
  }> {
    const rows = (
      await sql<{
        amountAllocated: string;
        businessDate: string;
        originalAmountDue: string;
        outstandingAmount: string;
        receivableNumber: string;
        receivableStatus: string;
        reason: string;
        sourceReference: string | null;
        sourceType: string;
      }>`
        select r.receivable_number as "receivableNumber", r.source_type as "sourceType",
               r.source_reference as "sourceReference", r.business_date::text as "businessDate",
               r.reason, r.original_amount_due::text as "originalAmountDue",
               r.outstanding_amount::text as "outstandingAmount", r.status as "receivableStatus",
               alloc.amount_allocated as "amountAllocated"
          from trader_collection_allocations alloc
          join trader_receivables r on r.id = alloc.receivable_id and r.company_id = alloc.company_id
         where alloc.collection_id = ${collectionId}::uuid and alloc.company_id = ${companyId}::uuid
         order by r.receivable_number
      `.execute(this.database)
    ).rows;
    const lines: TraderCollectionAllocationDetail[] = rows.map((row) => ({
      amountCollectedNow: new Decimal(row.amountAllocated).toFixed(2),
      businessDate: row.businessDate,
      originalAmountDue: new Decimal(row.originalAmountDue).toFixed(2),
      previouslyCollected: new Decimal(row.originalAmountDue)
        .minus(row.outstandingAmount)
        .minus(row.amountAllocated)
        .toFixed(2),
      reason: row.reason,
      receivableNumber: row.receivableNumber,
      receivableStatus: row.receivableStatus,
      remainingDue: new Decimal(row.outstandingAmount).toFixed(2),
      sourceReference: row.sourceReference,
      sourceType: row.sourceType,
    }));
    const totals = lines.reduce(
      (acc, line) => ({
        amountReceivedNow: acc.amountReceivedNow.plus(line.amountCollectedNow),
        previouslyCollected: acc.previouslyCollected.plus(line.previouslyCollected),
        remainingDue: acc.remainingDue.plus(line.remainingDue),
        totalOriginalAmountDue: acc.totalOriginalAmountDue.plus(line.originalAmountDue),
      }),
      {
        amountReceivedNow: new Decimal(0),
        previouslyCollected: new Decimal(0),
        remainingDue: new Decimal(0),
        totalOriginalAmountDue: new Decimal(0),
      },
    );
    return {
      lines,
      summary: {
        amountReceivedNow: totals.amountReceivedNow.toFixed(2),
        previouslyCollected: totals.previouslyCollected.toFixed(2),
        receivableCount: lines.length,
        remainingDue: totals.remainingDue.toFixed(2),
        totalOriginalAmountDue: totals.totalOriginalAmountDue.toFixed(2),
      },
    };
  }

  /**
   * Shared filter predicate for the Trader Collection list and summary
   * endpoints, so the summary cards always describe the same slice the list
   * shows.
   */
  private collectionFilters(
    companyId: string,
    query: TraderCollectionFilterDto,
  ): ReturnType<typeof sql> {
    return sql`
      c.company_id = ${companyId}::uuid
        and (${query.traderId ?? null}::uuid is null or c.trader_id = ${query.traderId ?? null}::uuid)
        and (${query.collectionNumber ?? null}::text is null
             or c.collection_number ilike '%' || ${query.collectionNumber ?? null} || '%')
        and (${query.paymentDateFrom ?? null}::date is null
             or c.payment_date >= ${query.paymentDateFrom ?? null}::date)
        and (${query.paymentDateTo ?? null}::date is null
             or c.payment_date <= ${query.paymentDateTo ?? null}::date)
        and (${query.paymentMethod ?? null}::text is null or c.payment_method = ${query.paymentMethod ?? null}::text)
        and (${query.paymentReference ?? null}::text is null
             or c.payment_reference ilike '%' || ${query.paymentReference ?? null} || '%')
        and (${query.status ?? null}::text is null or ${query.status ?? null}::text = 'all'
             or c.status = ${query.status ?? null}::text)
        and (${query.receivableNumber ?? null}::text is null or exists (
             select 1
               from trader_collection_allocations alloc
               join trader_receivables r on r.id = alloc.receivable_id and r.company_id = alloc.company_id
              where alloc.collection_id = c.id and alloc.company_id = c.company_id
                and r.receivable_number ilike '%' || ${query.receivableNumber ?? null} || '%'
        ))
    `;
  }

  private collectionFingerprint(input: CreateTraderCollectionDto): string {
    const material = {
      allocations: input.allocations
        .map((line: TraderCollectionAllocationLineDto) =>
          [line.receivableId, new Decimal(line.amount).toFixed(2)].join("|"),
        )
        .sort(),
      amountReceived: new Decimal(input.amountReceived).toFixed(2),
      bankAccountId: input.bankAccountId ?? "",
      notes: input.notes?.trim() ?? "",
      paymentDate: input.paymentDate ?? "",
      paymentMethod: input.paymentMethod ?? "cash",
      paymentReference: input.paymentReference?.trim() ?? "",
      traderId: input.traderId,
    };
    return createHash("sha256").update(JSON.stringify(material)).digest("hex");
  }

  private maskIban(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length <= 8) return "*".repeat(trimmed.length);
    return `${trimmed.slice(0, 4)}${"*".repeat(trimmed.length - 8)}${trimmed.slice(-4)}`;
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
    const pageSize = traderReceivablePageSizes.includes(
      requested as (typeof traderReceivablePageSizes)[number],
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
