import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql, type Transaction } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import {
  planCompensationPosting,
  planReversal,
  type ReceivableOffsetState,
  refuseReversal,
  traderNetPositionChange,
  untouchedOffsetCount,
} from "./receivable-offset-reversal-plan.js";

/**
 * Reversing ONE Trader Receivable that a Settlement offset cleared, without
 * touching the Settlement.
 *
 * The case: RCV-000047, AED 18, ORD-000108, cleared by one of SIX offsets
 * inside the confirmed SET-000007 (AED 108 in total). The existing
 * settlement-scoped reversal unwinds all six and the payment to the Trader,
 * so it is not an option here.
 *
 * What this operation does, in one transaction:
 *
 *   1. locks the Receivable and its Order, and reads the single offset, the
 *      Settlement, and the physical-collection count;
 *   2. refuses anything the plan module says is not reversible;
 *   3. marks the Receivable `reversed` -- `amount_collected` deliberately
 *      UNCHANGED, because it WAS collected and the GENERATED
 *      `outstanding_amount` must stay at zero so a reversed Receivable never
 *      re-enters an outstanding sum;
 *   4. writes the compensating Trader Credit for the offset amount;
 *   5. enqueues the Credit's own `trader_credit_issued` Accounting Event (the
 *      recognition reversal is enqueued by the Receivable's own capture
 *      trigger on the status change in step 3);
 *   6. audits with the mandatory reason, the actor and the correlation id.
 *
 * The Order is NOT touched: `delivery_status` and `trader_settlement_status`
 * stay exactly as they were (see the note in `execute`).
 *
 * What it never does: write `trader_settlements`, write or delete any row in
 * `trader_settlement_receivable_offsets`, create a `trader_collections` row,
 * or move cash.
 *
 * Why the offset row is left in place. `validate_trader_settlement_confirmation()`
 * fires only on the transition INTO `confirmed`, so a confirmed Settlement is
 * no longer policed by it. Deleting the offset would leave `other_deductions`
 * and `net_payable` disagreeing with the offsets that remain, and NOTHING
 * would raise. A silent inconsistency is worse than a loud one.
 *
 * Idempotency has three independent layers, which matters because this moves
 * money:
 *   - the Receivable's own status check refuses a second reversal;
 *   - `trader_credits_one_live_per_receivable`, a partial unique index, makes
 *     a second live Credit impossible in the database;
 *   - `accounting_events` is unique on
 *     (company_id, event_type, source_entity_type, source_entity_id,
 *     event_version) with `on conflict do nothing`.
 * A retry therefore cannot double-reverse, double-credit or double-post even
 * if two requests race.
 */

export interface ReceivableOffsetReversalPreview {
  readonly receivableId: string;
  readonly receivableNumber: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly orderStatus: string;
  readonly amount: string;
  readonly settlementId: string;
  readonly settlementNumber: string;
  readonly settlementStatus: string;
  /** Offsets on the clearing Settlement, this one included. */
  readonly settlementOffsetCount: number;
  /** Offsets this operation will NOT touch. */
  readonly otherOffsetsAffected: number;
  readonly physicalCollectionCount: number;
  /** AED the Trader will be credited. */
  readonly traderCompensation: string;
  /** Always "0.00". */
  readonly physicalCashMovement: string;
  /** Always "0.00" -- the Trader ends square. */
  readonly traderNetPositionChange: string;
  readonly recognitionJournalWillBeReversed: boolean;
  readonly settlementWillRemainConfirmed: boolean;
  readonly executionAvailable: boolean;
  /** Human-readable refusal, or null when the reversal may run. */
  readonly blockedReason: string | null;
  /** Machine-readable refusal code, or null when the reversal may run. */
  readonly blockedReasonCode: string | null;
  /** The single offset being reversed (same value as `amount`). */
  readonly offsetAmount: string;
  /** `orders.trader_settlement_status` -- reported, never written. */
  readonly orderSettlementStatus: string;
  /** Other offsets on the clearing Settlement, which stay untouched. */
  readonly untouchedOffsetCount: number;
}

export interface ReceivableOffsetReversalResult {
  readonly receivableId: string;
  readonly receivableNumber: string;
  readonly receivableStatus: string;
  readonly creditId: string;
  readonly creditNumber: string;
  readonly creditAmount: string;
  readonly settlementNumber: string;
  readonly settlementStatus: string;
  readonly otherOffsetsAffected: number;
  readonly orderNumber: string;
  readonly orderSettlementStatusChanged: boolean;
  readonly alreadyReversed: boolean;
}

interface OffsetRow extends ReceivableOffsetState {
  readonly receivableId: string;
  readonly receivableNumber: string;
  readonly traderId: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly orderStatus: string;
  readonly orderSettlementStatus: string;
  readonly settlementId: string;
  readonly settlementNumber: string;
}

@Injectable()
export class ReceivableOffsetReversalService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
  ) {}

  /**
   * Everything the operation will do, before it does any of it. Read-only:
   * one SELECT, no lock, no write.
   */
  public async preview(receivableId: string): Promise<ReceivableOffsetReversalPreview> {
    this.assertPermission(false);
    const { companyId } = this.tenants.current();
    const row = await this.load(this.database, companyId, receivableId, false);
    const refusal = refuseReversal(row);
    const plan = planReversal(row);
    return {
      amount: new Decimal(row.offsetAmount).toFixed(2),
      blockedReason: refusal === null ? null : this.describe(refusal),
      blockedReasonCode: refusal,
      executionAvailable: refusal === null,
      offsetAmount: new Decimal(row.offsetAmount).toFixed(2),
      orderId: row.orderId,
      orderSettlementStatus: row.orderSettlementStatus,
      orderNumber: row.orderNumber,
      orderStatus: row.orderStatus,
      otherOffsetsAffected: 0,
      physicalCashMovement: "0.00",
      physicalCollectionCount: row.physicalCollectionCount,
      receivableId: row.receivableId,
      receivableNumber: row.receivableNumber,
      recognitionJournalWillBeReversed: true,
      settlementId: row.settlementId,
      settlementNumber: row.settlementNumber,
      settlementOffsetCount: row.settlementOffsetCount,
      settlementStatus: row.settlementStatus,
      settlementWillRemainConfirmed: true,
      traderCompensation: plan.creditAmount,
      untouchedOffsetCount: untouchedOffsetCount(row),
      traderNetPositionChange: traderNetPositionChange(row),
    };
  }

  /** Executes the reversal. Atomic: any failure leaves nothing behind. */
  public async execute(
    receivableId: string,
    reason: string,
    correlationId: string,
  ): Promise<ReceivableOffsetReversalResult> {
    this.assertPermission(true);
    const trimmedReason = reason.trim();
    if (trimmedReason === "") {
      throw new ApplicationException(
        "trader_receivable_reversal_reason_required",
        "A reason is required to reverse a Trader Receivable",
        HttpStatus.BAD_REQUEST,
      );
    }
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    return this.transactions.execute(async (transaction) => {
      const row = await this.load(transaction, companyId, receivableId, true);

      // A retry on an already-reversed Receivable is a no-op, not an error:
      // the caller asked for a state that already holds. The live Credit is
      // returned so the response is identical to the first call's.
      if (["reversed", "cancelled"].includes(row.receivableStatus)) {
        const existing = await this.liveCredit(transaction, companyId, row.receivableId);
        if (existing !== undefined) {
          return {
            alreadyReversed: true,
            creditAmount: existing.amount,
            creditId: existing.id,
            creditNumber: existing.creditNumber,
            orderNumber: row.orderNumber,
            orderSettlementStatusChanged: false,
            otherOffsetsAffected: 0,
            receivableId: row.receivableId,
            receivableNumber: row.receivableNumber,
            receivableStatus: row.receivableStatus,
            settlementNumber: row.settlementNumber,
            settlementStatus: row.settlementStatus,
          };
        }
      }

      const refusal = refuseReversal(row);
      if (refusal !== null) {
        throw new ApplicationException(refusal, this.describe(refusal), HttpStatus.CONFLICT);
      }

      const plan = planReversal(row);
      const posting = planCompensationPosting(row);

      // The Receivable goes terminal. `amount_collected` is NOT reset: it was
      // collected, and leaving it keeps outstanding_amount at zero.
      await sql`
        update trader_receivables
           set status = ${plan.receivableStatus}, updated_at = now()
         where company_id = ${companyId}::uuid and id = ${row.receivableId}::uuid
      `.execute(transaction);

      const creditNumber = await this.history.nextReferenceNumber(
        transaction,
        companyId,
        "trader_credit",
        "TCR",
      );
      const credit = await sql<{ id: string }>`
        insert into trader_credits (
          company_id, credit_number, trader_id, business_date, amount, reason,
          source_type, source_receivable_id, source_order_id, source_settlement_id,
          correlation_id, created_by_account_id
        ) values (
          ${companyId}::uuid, ${creditNumber}, ${row.traderId}::uuid,
          (now() at time zone 'Asia/Dubai')::date,
          ${posting.amount}::numeric, ${trimmedReason},
          'receivable_offset_reversal', ${row.receivableId}::uuid, ${row.orderId}::uuid,
          ${row.settlementId}::uuid, ${correlationId}, ${identity.identityId}::uuid
        )
        returning id
      `.execute(transaction);
      const creditId = credit.rows[0]?.id;
      if (creditId === undefined) {
        // Unreachable unless trader_credits_one_live_per_receivable fired,
        // which is itself the guarantee we want -- surface it rather than
        // continuing with a half-built reversal.
        throw new ApplicationException(
          "trader_credit_not_created",
          "The compensating Trader Credit could not be created",
          HttpStatus.CONFLICT,
        );
      }

      // NOTE: the Receivable's recognition reversal is NOT enqueued here, and
      // must not be. `trader_receivables_accounting_event_capture` fires
      // `after insert or update of status on trader_receivables` and, on
      // exactly this transition, already does it:
      //
      //   elsif tg_op='UPDATE' and old.status not in ('cancelled','reversed')
      //      and new.status in ('cancelled','reversed') then
      //     perform enqueue_operational_accounting_event(
      //       new.company_id,'trader_receivables','trader_receivable_reversed',
      //       'trader_receivable',new.id, ... ,
      //       'trader-receivable-reversal:'||new.id::text,'trader_receivable',new.id);
      //
      // `enqueue_operational_accounting_event` resolves the original event for
      // us, so the reversal Journal is created and linked by the Accounting
      // domain, the original stays Posted, and the stable idempotency key plus
      // `on conflict do nothing` mean a retry cannot post it twice.
      //
      // A draft of this service hand-inserted an `order_recognition_reversed`
      // event here as well. That was wrong twice over: it duplicated work the
      // database already does, and it attributed the reversal to the Order
      // rather than the Receivable, so the two events would have reversed
      // different Journals.
      await this.enqueueCreditPosting(transaction, companyId, creditId, creditNumber);

      // `orders.trader_settlement_status` is deliberately NOT written here.
      // It is a pure function of the Order's payable TO the Trader
      // (`noPaymentDue = Number(traderNetPayable) <= 0 ? 'not_eligible' :
      // 'unsettled'`, computed the same way at delivery and at reopen), not a
      // record of the Receivable. ORD-000108 is Trader-pays-fee with COD
      // 0.00, so it is correctly `not_eligible` and must stay so: forcing
      // `unsettled` would assert a payable that does not exist and would
      // surface the Order in payable-settlement eligibility, which filters
      // `not in ('not_eligible','reversed')`.
      //
      // An earlier draft of this service did exactly that, purely to make a
      // later Order reopen possible. Reopening is its own audited operation
      // and stays separate.
      await this.history.audit(transaction, {
        action: "trader_receivable.reverse_offset",
        actorId: identity.identityId,
        after: {
          cashMovement: "0.00",
          creditAmount: plan.creditAmount,
          creditNumber,
          offsetAmount: row.offsetAmount,
          orderNumber: row.orderNumber,
          otherOffsetsOnSettlement: untouchedOffsetCount(row),
          receivableNumber: row.receivableNumber,
          settlementNumber: row.settlementNumber,
          settlementWritten: false,
          traderNetPositionChange: traderNetPositionChange(row),
        },
        companyId,
        correlationId,
        subjectId: row.receivableId,
        subjectType: "trader_receivable",
      });

      return {
        alreadyReversed: false,
        creditAmount: plan.creditAmount,
        creditId,
        creditNumber,
        orderNumber: row.orderNumber,
        orderSettlementStatusChanged: false,
        otherOffsetsAffected: 0,
        receivableId: row.receivableId,
        receivableNumber: row.receivableNumber,
        receivableStatus: plan.receivableStatus,
        settlementNumber: row.settlementNumber,
        settlementStatus: row.settlementStatus,
      };
    });
  }

  /**
   * The compensating Credit's own balanced Journal.
   *
   * DEBIT `order_cod_receivable`, CREDIT `trader_payable`, both of which
   * ALREADY EXIST as mapping keys and are configured for every Company, and
   * both of which carry a control-account requirement in
   * `AccountMappingResolver`. No new mapping key is introduced here, by
   * design: on 1 Oct 2026 an invented one (`cod_receivable`) resolved to
   * nothing and kept six Settlement Journals out of the General Ledger for
   * seven weeks without surfacing a single error.
   *
   * Recognition debited AR to raise the fee and the offset credited AR to
   * clear it, so reversing the recognition leaves the offset's credit as a
   * residual in AR. This Journal's AR debit clears that residual and its
   * `trader_payable` credit records what the Company now owes. Cash is
   * untouched on both legs.
   */
  private async enqueueCreditPosting(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
    creditId: string,
    creditNumber: string,
  ): Promise<void> {
    const identity = this.identities.current();
    // Through the SAME helper every operational capture trigger uses, so this
    // Event gets the same gate (`accounting_enabled`), the same stable
    // idempotency key and hash, the same `on conflict do nothing`, and an
    // immediate `next_attempt_at` -- rather than a hand-written insert that
    // can drift from it. Area `trader_receivables` is the area the ownership
    // matrix assigns `trader_credit_issued` to.
    await sql`
      select enqueue_operational_accounting_event(
        ${companyId}::uuid, 'trader_receivables', 'trader_credit_issued',
        'trader_credit', ${creditId}::uuid, ${creditNumber},
        (now() at time zone 'Asia/Dubai')::date, ${identity.identityId}::uuid,
        ${`trader-credit:${creditId}`}
      )
    `.execute(transaction);
  }

  private async liveCredit(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
    receivableId: string,
  ): Promise<{ amount: string; creditNumber: string; id: string } | undefined> {
    const result = await sql<{ amount: string; creditNumber: string; id: string }>`
      select id, credit_number as "creditNumber", amount::text
        from trader_credits
       where company_id = ${companyId}::uuid
         and source_receivable_id = ${receivableId}::uuid
         and source_type = 'receivable_offset_reversal'
         and status <> 'cancelled'
       limit 1
    `.execute(transaction);
    return result.rows[0];
  }

  /**
   * The Receivable, its single offset, the clearing Settlement and the Order.
   *
   * `forUpdate` locks the Receivable and the Order when executing. The
   * Settlement and the offset are deliberately NOT locked for update -- this
   * operation never writes them, and taking a write lock on a confirmed
   * Settlement would block unrelated work on its other five Orders.
   */
  private async load(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    companyId: string,
    receivableId: string,
    forUpdate: boolean,
  ): Promise<OffsetRow> {
    const result = await sql<OffsetRow>`
      select r.id as "receivableId", r.receivable_number as "receivableNumber",
             r.trader_id as "traderId", r.status as "receivableStatus",
             r.original_amount_due::text as "originalAmountDue",
             r.amount_collected::text as "amountCollected",
             o.id as "orderId", o.order_number as "orderNumber",
             o.delivery_status as "orderStatus",
             o.trader_settlement_status as "orderSettlementStatus",
             s.id as "settlementId", s.settlement_number as "settlementNumber",
             s.status as "settlementStatus",
             x.amount_allocated::text as "offsetAmount",
             (select count(*)::int from trader_settlement_receivable_offsets sibling
               where sibling.company_id = s.company_id and sibling.settlement_id = s.id)
               as "settlementOffsetCount",
             (select count(*)::int from trader_collection_allocations ca
               where ca.company_id = r.company_id and ca.receivable_id = r.id)
               as "physicalCollectionCount",
             exists(select 1 from trader_settlements reversal
                     where reversal.company_id = s.company_id and reversal.reversal_of_id = s.id)
               as "settlementAlreadyReversed",
             exists(select 1 from accounting_events posted
                     where posted.company_id = s.company_id
                       and posted.source_entity_type = 'trader_settlement'
                       and posted.source_entity_id = s.id
                       and posted.event_type = 'trader_settlement_confirmed'
                       and posted.processing_status = 'posted')
               as "settlementAccountingPosted"
        from trader_receivables r
        join trader_settlement_receivable_offsets x
          on x.company_id = r.company_id and x.receivable_id = r.id
        join trader_settlements s
          on s.company_id = x.company_id and s.id = x.settlement_id
        join orders o
          on o.company_id = r.company_id and o.order_number = r.source_reference
       where r.company_id = ${companyId}::uuid
         and r.id = ${receivableId}::uuid
         and r.source_type = 'service_charge'
       order by x.created_at desc
       limit 1
       ${forUpdate ? sql`for update of r, o` : sql``}
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "trader_receivable_offset_not_reversible",
        "No settlement offset is available for this Receivable",
        HttpStatus.CONFLICT,
      );
    }
    return row;
  }

  /**
   * Executing is a financial reversal and requires `trader_receivables.reverse`
   * itself -- `users_roles.manage` alone does NOT authorize it. Previewing is
   * read-only and is also open to `users_roles.manage`.
   */
  private assertPermission(executing: boolean): void {
    const permissions = this.identities.current().permissions;
    const allowed = permissions.has("trader_receivables.reverse") ||
      (!executing && permissions.has("users_roles.manage"));
    if (!allowed) {
      throw new ApplicationException(
        "permission_denied",
        "The authenticated account does not have permission for this operation",
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private describe(code: string): string {
    const messages: Readonly<Record<string, string>> = {
      trader_receivable_already_reversed: "This Receivable has already been reversed",
      trader_receivable_has_physical_collection:
        "This Receivable was cleared by a physical Trader Collection and must be reversed through the Collection reversal",
      trader_receivable_offset_not_reversible:
        "No settlement offset is available for this Receivable",
      trader_receivable_offset_partial:
        "This Receivable was only partly cleared by the offset, so there is no single amount to compensate",
      trader_settlement_already_reversed:
        "The clearing Settlement has already been reversed in full",
      trader_settlement_accounting_not_posted:
        "The clearing Settlement's Accounting Event has not posted yet, so there is no receivable balance for the compensating Credit to clear. Reprocess that Event first.",
      trader_settlement_not_confirmed: "The clearing Settlement is not confirmed",
    };
    return messages[code] ?? "This Receivable cannot be reversed";
  }
}
