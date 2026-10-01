/**
 * The invariant that keeps a Receivable-scoped intention from firing the
 * Settlement-scoped reversal.
 *
 * Background, because this is not obvious from the endpoint names. A Trader
 * Receivable can be settled two ways, and BOTH are valid:
 *
 *   - a physical Trader Collection, which writes a `trader_collection_allocations`
 *     row and represents cash actually received;
 *   - a Settlement receivable offset, which writes a
 *     `trader_settlement_receivable_offsets` row, adds the amount to the
 *     Receivable's `amount_collected` and marks it `collected` -- the Trader
 *     paid by being short-paid that much in his Settlement.
 *
 * An offset is therefore a complete settlement of the Receivable. It is NOT a
 * missing Collection, and nothing should offer to "fix" it by inventing one:
 * that would settle the same Receivable twice and record cash that was never
 * received.
 *
 * The only reversal operation that exists is settlement-scoped
 * (`POST operations/settlements/payments/:settlementId/reverse`). It takes no
 * Receivable id and both of its inner queries are scoped to the Settlement, so
 * it unwinds EVERY offset on that Settlement and the payment to the Trader.
 * Calling it to act on one Receivable is wrong in two separate ways:
 *
 *   1. COLLATERAL -- every other Receivable cleared by the same Settlement is
 *      restored to Outstanding too. On `SET-000007` that is AED 108.00 across
 *      six offsets when the intention was AED 18.00 on one.
 *
 *   2. ECONOMICS -- even on a Settlement carrying exactly ONE offset it is
 *      still wrong. The offset collected the fee by reducing the Company's
 *      payment to the Trader. Restoring the Receivable alone makes him owe it
 *      again while he has already been short-paid, leaving him down twice the
 *      amount. A correct single-offset reversal has to restore the Receivable
 *      AND create an obligation from the Company to the Trader for the same
 *      amount -- and no Trader credit mechanism exists yet, which is why there
 *      is no receivable-scoped reversal to call.
 *
 * So `executionAvailable` is false for every Receivable, not merely for the
 * multi-offset case. A guard that only blocked multi-offset Settlements would
 * silently permit the economically broken single-offset case.
 */

export interface OffsetReversalScope {
  /** Offsets carried by the clearing Settlement, the target one included. */
  readonly settlementOffsetCount: number;
  /** Physical Collection allocations against the target Receivable. */
  readonly physicalCollectionCount: number;
}

export interface OffsetReversalVerdict {
  /** Always false -- no receivable-scoped reversal operation exists. */
  readonly executionAvailable: false;
  /** Display text naming what blocks execution. */
  readonly blockedReason: string;
  /** Other Receivables a settlement-scoped reversal would also restore. */
  readonly collateralOffsetCount: number;
}

/**
 * Receivables, other than the target, that the settlement-scoped reversal
 * would also unwind. Never negative: a Settlement that reports no offsets at
 * all still has no collateral rather than -1.
 */
export function collateralOffsetCount(settlementOffsetCount: number): number {
  if (!Number.isFinite(settlementOffsetCount)) return 0;
  return Math.max(Math.trunc(settlementOffsetCount) - 1, 0);
}

/**
 * Whether the settlement-scoped reversal may be invoked to act on ONE
 * Receivable. Always false, for the economic reason above. Kept as a named
 * function so the rule is testable and has one place to change if a
 * receivable-scoped operation is ever built.
 */
export function isSettlementReversalValidForSingleReceivable(): false {
  return false;
}

/** The preview's execution verdict for one Receivable. */
export function assessOffsetReversal(scope: OffsetReversalScope): OffsetReversalVerdict {
  const collateral = collateralOffsetCount(scope.settlementOffsetCount);
  if (scope.physicalCollectionCount > 0) {
    return {
      executionAvailable: false,
      blockedReason:
        "This Receivable has a physical Trader Collection. Reverse the Collection itself rather than the Settlement offset.",
      collateralOffsetCount: collateral,
    };
  }
  if (collateral > 0) {
    return {
      executionAvailable: false,
      blockedReason:
        `Reversing this offset is not supported. The clearing Settlement carries ${collateral} other ` +
        "Receivable offset(s), and the only reversal operation available unwinds the whole Settlement " +
        "and its payment to the Trader.",
      collateralOffsetCount: collateral,
    };
  }
  return {
    executionAvailable: false,
    blockedReason:
      "Reversing this offset is not supported. The offset collected the fee by short-paying the Trader, " +
      "so restoring the Receivable on its own would leave him owing it while already paid short. This " +
      "needs a Trader credit, which does not exist yet.",
    collateralOffsetCount: collateral,
  };
}
