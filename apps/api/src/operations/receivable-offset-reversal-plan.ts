import { Decimal } from "decimal.js";

/**
 * The economics of reversing ONE Trader Receivable that a Settlement offset
 * cleared, worked out as pure arithmetic so it can be tested without a
 * database and read without tracing SQL.
 *
 * The case this exists for: `RCV-000047`, AED 18, ORD-000108, cleared by an
 * offset inside `SET-000007` -- a Settlement carrying six offsets totalling
 * AED 108. Reversing that one Receivable must leave the other five, the
 * Settlement header and its payment untouched.
 *
 * Three facts drive every number below.
 *
 * 1. An offset collected the fee by paying the Trader that much LESS. No cash
 *    moved on its own account, so no cash moves back: the compensation is an
 *    obligation, never a payment.
 *
 * 2. `validate_trader_settlement_confirmation()` fires only on the transition
 *    INTO `confirmed` (`if new.status <> 'confirmed' or old.status =
 *    'confirmed' then return new`). A confirmed Settlement is therefore no
 *    longer policed by it -- which is exactly why nothing here may touch
 *    `SET-000007`. Removing the offset row would leave `other_deductions` and
 *    `net_payable` silently disagreeing with the offsets that remain, and no
 *    constraint would complain. Silence, not an error.
 *
 * 3. The Receivable keeps `amount_collected` at its settled value for ever.
 *    It WAS collected; that is historical fact. Zeroing it would make a
 *    reversed Receivable report `outstanding_amount = 18.00` through the
 *    GENERATED column and reappear in outstanding sums. The redo creates a
 *    NEW Receivable; this one goes terminal.
 */

/** What the Receivable looked like before the reversal. */
export interface ReceivableOffsetState {
  readonly originalAmountDue: string;
  readonly amountCollected: string;
  /** The single offset that cleared it. */
  readonly offsetAmount: string;
  /** Offsets on the clearing Settlement, this one included. */
  readonly settlementOffsetCount: number;
  /** Physical Collection allocations against this Receivable. */
  readonly physicalCollectionCount: number;
  readonly receivableStatus: string;
  readonly settlementStatus: string;
  /** True when a reversal Settlement already points at the clearing one. */
  readonly settlementAlreadyReversed: boolean;
  /**
   * Whether the clearing Settlement's `trader_settlement_confirmed` Accounting
   * Event has actually POSTED.
   *
   * This is a precondition, not bookkeeping, and working the General Ledger
   * arithmetic through is the only way to see it. For this Receivable, AR
   * moves in four steps:
   *
   *   recognition               DR order_cod_receivable  +18
   *   settlement offset         CR order_cod_receivable  -18
   *   recognition reversal      CR order_cod_receivable  -18
   *   compensating Credit       DR order_cod_receivable  +18
   *                                                      ----
   *                                                        0
   *
   * Remove the second line and the total is +18: an AR balance standing
   * against a fully reversed Receivable. SET-000007's settlement Event was
   * `failed` on `accounting_event_mapping_missing` until `b592fea`, so on
   * ORD-000108 that second line does NOT exist yet. Reversing before it posts
   * would leave AR overstated by exactly the amount being reversed, silently.
   */
  readonly settlementAccountingPosted: boolean;
}

export type ReversalRefusal =
  | "trader_receivable_offset_not_reversible"
  | "trader_receivable_already_reversed"
  | "trader_receivable_has_physical_collection"
  | "trader_receivable_offset_partial"
  | "trader_settlement_not_confirmed"
  | "trader_settlement_already_reversed"
  | "trader_settlement_accounting_not_posted";

export interface ReversalPlan {
  /** Receivable status after the reversal. Terminal. */
  readonly receivableStatus: "reversed";
  /**
   * `amount_collected` after the reversal: UNCHANGED. Historical fact, and it
   * keeps the GENERATED `outstanding_amount` at zero so a reversed Receivable
   * never re-enters an outstanding sum.
   */
  readonly amountCollected: string;
  /** The compensating Credit the Trader is owed. */
  readonly creditAmount: string;
  /** Cash moved by this operation. Always zero. */
  readonly cashMovement: "0.00";
  /** Offsets this operation writes to. Always zero. */
  readonly offsetRowsWritten: 0;
  /** Other Receivables on the same Settlement that this operation changes. */
  readonly otherOffsetsAffected: 0;
  /** Whether the Settlement header is written. Always false. */
  readonly settlementWritten: false;
  /**
   * Whether this operation writes `orders.trader_settlement_status`. Always
   * false, and the reasoning matters because an earlier draft set it to
   * `unsettled`.
   *
   * That flag is not the Receivable's state. It is a pure function of the
   * Order's payable TO the Trader, computed identically in three places:
   *
   *   const noPaymentDue = Number(order.traderNetPayable) <= 0;
   *   const settlementStatus = noPaymentDue ? "not_eligible" : "unsettled";
   *
   * ORD-000108 is Trader-pays-fee with COD 0.00, so its `trader_net_payable`
   * is <= 0 and the Order has been `not_eligible` since delivery -- correctly,
   * because the Company owes the Trader nothing on it. Forcing `unsettled`
   * would assert a payable that does not exist, and eligibility queries filter
   * `not in ('not_eligible','reversed')`, so it would surface the Order in
   * payable-settlement lists it has no business being in.
   *
   * Reversing a Receivable changes what the TRADER owes the Company. It does
   * not change what the Company owes the Trader, so it leaves this flag alone.
   * Reopening an Order is a separate, explicitly audited operation.
   */
  readonly orderSettlementStatusWritten: false;
}

/**
 * The compensating accounting pair.
 *
 * Deliberately built from mapping keys that ALREADY EXIST and are already
 * configured for every Company -- `order_cod_receivable` and `trader_payable`,
 * both of which also carry a control-account requirement in
 * `AccountMappingResolver`. No new mapping key is introduced, because on
 * 1 Oct 2026 an invented one (`cod_receivable`) resolved to nothing and kept
 * six Settlement journals out of the General Ledger for seven weeks without a
 * single error surfacing.
 *
 * Why this is the right pair. Recognition debited AR to raise the fee; the
 * offset credited AR to clear it. Reversing the recognition removes the debit,
 * leaving the offset's credit as a residual -18 in AR. The Credit's AR debit
 * clears that residual, and its `trader_payable` credit records what the
 * Company now owes. Cash is untouched on both legs.
 */
export interface CompensationPosting {
  readonly debitMappingKey: "order_cod_receivable";
  readonly creditMappingKey: "trader_payable";
  readonly amount: string;
}

function money(value: Decimal | string): string {
  return new Decimal(value).toDecimalPlaces(2).toFixed(2);
}

/**
 * Whether this Receivable may be reversed, and why not when it may not.
 * Returns null when the reversal is allowed.
 */
export function refuseReversal(state: ReceivableOffsetState): ReversalRefusal | null {
  if (["cancelled", "reversed"].includes(state.receivableStatus)) {
    return "trader_receivable_already_reversed";
  }
  if (!["collected", "partially_collected"].includes(state.receivableStatus)) {
    return "trader_receivable_offset_not_reversible";
  }
  if (state.physicalCollectionCount > 0) {
    // Cash really moved, so this is the Collection reversal's business, not
    // ours. Compensating a physical Collection with a Credit would leave the
    // cash unaccounted for.
    return "trader_receivable_has_physical_collection";
  }
  if (state.settlementStatus !== "confirmed") {
    return "trader_settlement_not_confirmed";
  }
  if (!state.settlementAccountingPosted) {
    // The compensating Credit debits AR to clear the residual the offset's AR
    // credit left behind. If that credit has not posted there is no residual,
    // and the debit would CREATE an AR balance against a reversed Receivable.
    // Reprocess the Settlement's Accounting Event first.
    return "trader_settlement_accounting_not_posted";
  }
  if (state.settlementAlreadyReversed) {
    // The whole Settlement has been unwound already; the Receivable is no
    // longer settled by it and a Credit would double-compensate.
    return "trader_settlement_already_reversed";
  }
  // The offset must be the WHOLE of what was collected. A Receivable part-paid
  // by an offset and part by something else has no single amount to
  // compensate, and this operation will not guess which part to unwind.
  if (!new Decimal(state.offsetAmount).equals(state.amountCollected)) {
    return "trader_receivable_offset_partial";
  }
  if (!new Decimal(state.offsetAmount).greaterThan(0)) {
    return "trader_receivable_offset_not_reversible";
  }
  return null;
}

/** The plan, for a state that `refuseReversal` has already allowed. */
export function planReversal(state: ReceivableOffsetState): ReversalPlan {
  return {
    amountCollected: money(state.amountCollected),
    cashMovement: "0.00",
    creditAmount: money(state.offsetAmount),
    offsetRowsWritten: 0,
    orderSettlementStatusWritten: false,
    otherOffsetsAffected: 0,
    receivableStatus: "reversed",
    settlementWritten: false,
  };
}

/** The compensating Credit's balanced accounting pair. */
export function planCompensationPosting(state: ReceivableOffsetState): CompensationPosting {
  return {
    amount: money(state.offsetAmount),
    creditMappingKey: "trader_payable",
    debitMappingKey: "order_cod_receivable",
  };
}

/**
 * Offsets on the clearing Settlement that this operation must NOT touch.
 * Reported in the preview so the number is visible before execution rather
 * than inferred afterwards.
 */
export function untouchedOffsetCount(state: ReceivableOffsetState): number {
  if (!Number.isFinite(state.settlementOffsetCount)) return 0;
  return Math.max(Math.trunc(state.settlementOffsetCount) - 1, 0);
}

/**
 * The Trader's net position change across the whole operation, which MUST be
 * zero: he stops owing the fee (+18 to him) and the Company's obligation to
 * him rises by the same 18 it short-paid. Any other result means the Trader
 * has been charged or credited twice, which is the single assertion that
 * catches a half-built reversal -- a test that only checks "the Receivable
 * went back to Outstanding" passes while he is 18 down.
 */
export function traderNetPositionChange(state: ReceivableOffsetState): string {
  const feeNoLongerOwed = new Decimal(state.offsetAmount);
  const compensation = new Decimal(planCompensationPosting(state).amount);
  return money(compensation.minus(feeNoLongerOwed));
}
