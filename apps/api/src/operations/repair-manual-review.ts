import { Decimal } from "decimal.js";

import { ORDER_HEALTH_REASONS, type OrderHealthEvaluation, type OrderHealthReasonCode } from "./company-order-health.service.js";
import type { RepairCapability, RepairPlan } from "./repair-capability.registry.js";
import type { OrderDependencyGraph } from "./repair-dependency-graph.js";

/**
 * MANUAL REVIEW EXPLANATION (Repair Center Phase 3, Prompt 3).
 *
 * When a Trader-financial finding is MANUAL_REVIEW, the Platform administrator
 * must be able to understand the problem without querying SQL: what is
 * inconsistent, the financial comparison (what the Trader owes against the
 * effective collections and offsets, per receivable), every affected
 * collection / settlement / credit with whether it is current or history, and
 * WHY no automatic repair is offered.
 *
 * Built only from the already-loaded dependency graph and evaluation (no
 * query, no write). Shown after opening ONE finding -- never on the Company
 * Health list.
 */

export interface ManualReviewReceivable {
  readonly receivableNumber: string;
  readonly status: string;
  readonly current: boolean;
  readonly amountDue: string;
  readonly recordedCollected: string;
  readonly effectivePhysicalCollections: string;
  readonly effectiveSettlementOffsets: string;
  readonly effectiveSettled: string;
  /** recordedCollected - effectiveSettled (0.00 when they agree). */
  readonly unexplainedDifference: string;
}

export interface ManualReviewCollection {
  readonly collectionNumber: string;
  readonly receivableNumber: string;
  readonly collectionStatus: string;
  /** Counts toward the receivable today (confirmed Collection, current receivable). */
  readonly current: boolean;
  readonly sameTraderAsReceivable: boolean;
  readonly allocatedToReceivable: string;
  readonly collectionAmountReceived: string;
  readonly collectionAllocatedTotal: string;
}

export interface ManualReviewSettlement {
  readonly settlementNumber: string;
  readonly receivableNumber: string;
  readonly settlementStatus: string;
  readonly effective: boolean;
  readonly reversedBySettlementNumber: string | null;
  readonly sameTraderAsReceivable: boolean;
  readonly offsetAmount: string;
}

export interface ManualReviewCredit {
  readonly creditNumber: string;
  readonly receivableNumber: string | null;
  readonly status: string;
  readonly amount: string;
}

export interface ManualReviewExplanation {
  readonly headline: "Manual review required";
  readonly reason: string;
  readonly whyAutomaticRepairIsUnavailable: readonly string[];
  readonly financialComparison: {
    readonly traderOwes: string;
    readonly currentReceivables: number;
    readonly historicalReceivables: number;
    readonly effectivePhysicalCollections: string;
    readonly effectiveSettlementOffsets: string;
    readonly receivables: readonly ManualReviewReceivable[];
  };
  readonly affectedRecords: {
    readonly collections: readonly ManualReviewCollection[];
    readonly settlements: readonly ManualReviewSettlement[];
    readonly credits: readonly ManualReviewCredit[];
  };
}

/**
 * The audited reason, per finding, why no certified operation can be applied
 * automatically (Phase 3 Prompt 3 decision table). A capability's own
 * `manualReviewReasons` come first when it has a plan.
 */
export const WHY_NOT_AUTOMATIC: Readonly<Partial<Record<OrderHealthReasonCode, readonly string[]>>> = {
  COLLECTION_ALLOCATION_MISMATCH: [
    "The Collection is real money received. Which Trader, receivable and amount it was meant for is not in the records.",
    "The only certified correction reverses the WHOLE Collection, removing that receipt from every receivable it paid; no certified operation re-allocates a Collection.",
  ],
  MULTIPLE_EFFECTIVE_SETTLEMENTS: [
    "Each Settlement is a separate payment to the Trader. Nothing in the records proves one is an accidental duplicate rather than a real second payment.",
    "Reversing a Settlement reverses its Trader payment and every Order and offset it carries; it is never chosen by age.",
  ],
  MULTIPLE_ACTIVE_RECEIVABLES: [
    "Automatic cancellation is only offered when exactly one of two current receivables has never been touched by money, an offset or a credit; the records here do not prove which one is canonical.",
  ],
  ORPHAN_COLLECTION_ALLOCATION: [
    "A confirmed Collection is still allocated to a cancelled or reversed receivable. Whether that money belongs to a replacement receivable, another Order or a refund is not in the records.",
    "The certified Collection reversal does not guard closed receivables (it would re-derive their status) and would remove a real receipt.",
  ],
  RECEIVABLE_AMOUNT_NOT_PROVABLE: [
    "This older order has no VAT snapshot of the rules it was priced under, so what it required cannot be proven; today's Company VAT settings are never used to re-price it.",
    "No receivable is re-amounted, cancelled or replaced without a provable amount.",
  ],
  RECEIVABLE_AMOUNT_MISMATCH: [
    "Re-amounting a receivable in place is never done. A replacement is only offered for a receivable nothing has touched (no collection, offset, credit, money or GL recognition), with a provable expected amount.",
  ],
  RECEIVABLE_COLLECTED_AMOUNT_MISMATCH: [
    "The recorded collected amount and the effective collections / offsets disagree; which one is right is not in the records. Amounts are never overwritten.",
  ],
  RECEIVABLE_NOT_REQUIRED_BUT_ACTIVE: [
    "Reset is a financial reversal (receivable reversed, compensating Trader Credit) that a person must decide applies; it is shown as a candidate only.",
  ],
  RECEIVABLE_OVER_COLLECTED: [
    "Effective collections and offsets exceed the amount due. Which collection or offset is the excess is not in the records, and money is never removed by inference.",
  ],
  RECEIVABLE_STATE_INCONSISTENT: ["The receivable and its clearing records do not match any certified correctable state."],
  SETTLEMENT_OFFSET_MISMATCH: [
    "Settlement offsets are never edited directly. The only certified correction reverses the WHOLE Settlement (its Trader payment and every other Order and offset).",
    "Which Settlement, receivable, Trader or amount was intended is not in the records.",
  ],
};

const money = (value: Decimal.Value) => new Decimal(value).toFixed(2);

export function manualReviewExplanation(
  reasonCode: OrderHealthReasonCode,
  evaluation: OrderHealthEvaluation,
  graph: OrderDependencyGraph,
  capability: RepairCapability | undefined,
  plan: RepairPlan | undefined,
): ManualReviewExplanation {
  const receivableById = new Map(graph.receivables.map((row) => [row.id, row]));
  const numberOf = (id: string | null) => (id === null ? null : (receivableById.get(id)?.receivableNumber ?? null));
  const receivables: ManualReviewReceivable[] = graph.receivables.map((row) => {
    const physical = graph.allocations
      .filter((item) => item.receivableId === row.id && item.collectionStatus === "confirmed")
      .reduce((sum, item) => sum.plus(item.amount), new Decimal(0));
    const offsets = graph.offsets
      .filter((item) => item.receivableId === row.id && item.effective)
      .reduce((sum, item) => sum.plus(item.amount), new Decimal(0));
    const settled = physical.plus(offsets);
    return {
      amountDue: money(row.amountDue),
      current: row.current,
      effectivePhysicalCollections: money(physical),
      effectiveSettled: money(settled),
      effectiveSettlementOffsets: money(offsets),
      receivableNumber: row.receivableNumber,
      recordedCollected: money(row.amountCollected),
      status: row.status,
      unexplainedDifference: money(new Decimal(row.amountCollected).minus(settled)),
    };
  });
  const why = [
    ...(plan?.manualReviewReasons ?? []).map((item) => item.message),
    ...(WHY_NOT_AUTOMATIC[reasonCode] ?? []),
  ];
  if (capability === undefined) why.push("No certified repair operation exists for this finding.");
  return {
    affectedRecords: {
      collections: graph.allocations.map((row) => ({
        allocatedToReceivable: money(row.amount),
        collectionAllocatedTotal: money(row.collectionAllocatedTotal),
        collectionAmountReceived: money(row.collectionAmountReceived),
        collectionNumber: row.collectionNumber,
        collectionStatus: row.collectionStatus,
        current: row.current,
        receivableNumber: numberOf(row.receivableId) ?? "",
        sameTraderAsReceivable: row.collectionTraderId === receivableById.get(row.receivableId)?.traderId,
      })),
      credits: graph.credits.map((row) => ({
        amount: money(row.amount),
        creditNumber: row.creditNumber,
        receivableNumber: numberOf(row.sourceReceivableId),
        status: row.status,
      })),
      settlements: graph.offsets.map((row) => ({
        effective: row.effective,
        offsetAmount: money(row.amount),
        receivableNumber: numberOf(row.receivableId) ?? "",
        reversedBySettlementNumber: row.reversedBySettlementNumber,
        sameTraderAsReceivable: row.settlementTraderId === receivableById.get(row.receivableId)?.traderId,
        settlementNumber: row.settlementNumber,
        settlementStatus: row.settlementStatus,
      })),
    },
    financialComparison: {
      currentReceivables: evaluation.activeReceivableCount,
      effectivePhysicalCollections: money(evaluation.activePhysical),
      effectiveSettlementOffsets: money(evaluation.activeOffset),
      historicalReceivables: graph.receivables.length - evaluation.activeReceivableCount,
      receivables,
      traderOwes: money(evaluation.traderDue),
    },
    headline: "Manual review required",
    reason: ORDER_HEALTH_REASONS[reasonCode].reason,
    whyAutomaticRepairIsUnavailable: [...new Set(why)],
  };
}
