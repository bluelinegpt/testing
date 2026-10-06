/**
 * The Trader-settlement half of the Order close gate, in one place because two
 * operations have to agree about it and for a while they did not.
 *
 * An Order reaches `closed` only when Driver cash, Trader settlement and
 * Return processing are all complete (`OperationsService.changeDeliveryStatus`).
 * Reversing a Trader Settlement destroys the settlement leg of that condition:
 * `reverseInTransaction` writes `trader_settlement_status = 'unsettled'` and
 * `trader_paid_amount = 0`. Until Oct 2026 it left `delivery_status = 'closed'`
 * standing anyway, so the Order sat in a state it could never legally have
 * entered -- and every settlement path requires `delivered` (five query sites
 * in `trader-settlement.service.ts` plus
 * `validate_trader_settlement_confirmation()`), so it could never be settled
 * again either.
 *
 * SET-000017 is the case: 31 Orders, AED 8,676, settled 05 Oct 01:13:24, closed
 * 01:15:17, reversed 01:30:57 by SET-000018 ("بالحطاء" -- by mistake). The
 * Trader could not be paid, and the Orders were invisible in the payable list,
 * the Trader Payable Due report and the settlement drafts, all three of which
 * filter `delivery_status = 'delivered'`.
 *
 * Three earlier reversals did NOT strand anything, which is what hid the bug:
 * in all of them the reversal ran BEFORE anyone closed the Orders, so they were
 * still `delivered` and re-settled normally. The damage depends purely on
 * sequence:
 *
 *   settle -> reverse -> close     harmless (10 Orders, Sep-Oct 2026)
 *   settle -> close   -> reverse   stranded (31 Orders, SET-000017)
 *
 * Hence this module rather than a second inline copy of the list: the close
 * gate and the reversal now read the SAME predicate, so a status added to one
 * cannot silently fail to reach the other.
 */

/**
 * Settlement statuses that satisfy the close gate on their own.
 *
 * Deliberately NOT including `settled`. `reverseInTransaction` can compute
 * `settled` on a partial reversal, and `settled` has never been accepted here,
 * so such an Order cannot close. That mismatch predates this module and is
 * recorded rather than quietly changed -- widening the gate is a policy
 * decision about when an Order may close, not a refactor.
 */
export const CLOSE_ELIGIBLE_SETTLEMENT_STATUSES: readonly string[] = [
  "money_sent_to_trader",
  "money_received_by_trader",
  "not_eligible",
];

export interface CloseSettlementState {
  readonly settlementStatus: string;
  /** `orders.trader_net_payable`, as text or number. */
  readonly traderNetPayable: number | string;
}

/**
 * Whether the Trader-settlement leg of the close gate is satisfied.
 *
 * The second clause carries real weight: an Order the Company owes the Trader
 * nothing on (Trader-pays-fee, COD 0.00) closes on its own account whatever its
 * settlement status says, and must therefore NOT be reopened when a Settlement
 * it appeared in is reversed. Nothing was invalidated for it.
 */
export function closeSettlementComplete(order: CloseSettlementState): boolean {
  if (CLOSE_ELIGIBLE_SETTLEMENT_STATUSES.includes(order.settlementStatus)) return true;
  const payable = parsePayable(order.traderNetPayable);
  // A payable that will not parse is treated as "money is owed", the
  // conservative reading: it keeps the gate closed rather than letting an Order
  // through on a parse failure.
  return payable !== null && payable <= 0;
}

/**
 * `null` when the value is not a number.
 *
 * `Number("")` is 0, not NaN, and 0 passes `<= 0` -- so a blank payable would
 * otherwise satisfy the close gate as though the Company owed the Trader
 * nothing. The column is `numeric not null`, so this cannot arise from the
 * database; it guards the boundary where a value arrives as text.
 */
function parsePayable(value: number | string): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether reversing a Settlement has invalidated an Order's close, i.e. whether
 * the reversal must put the Order back.
 *
 * `settlementStatusAfterReversal` is the status the reversal has just written,
 * not the one the Order had before it.
 */
export function reversalInvalidatesClose(input: {
  readonly deliveryStatus: string;
  readonly settlementStatusAfterReversal: string;
  readonly traderNetPayable: number | string;
}): boolean {
  if (input.deliveryStatus !== "closed") return false;
  return !closeSettlementComplete({
    settlementStatus: input.settlementStatusAfterReversal,
    traderNetPayable: input.traderNetPayable,
  });
}

/**
 * The delivery statuses the close gate accepts as predecessors, used only to
 * validate what is read back out of `order_status_history` before it is written
 * to `orders.delivery_status`.
 *
 * An unclose restores the status the Order actually came from rather than
 * assuming `delivered`: all 31 SET-000017 Orders came from `delivered`, so a
 * hardcoded value would look correct today and silently mis-restore the first
 * `returned_to_trader` Order anyone reverses.
 */
export const CLOSE_PREDECESSOR_STATUSES: readonly string[] = [
  "delivered",
  "returned_to_trader",
  "collect_order",
];

/**
 * The status to restore when unclosing, given whatever
 * `order_status_history` holds for the close transition.
 *
 * Falls back to `delivered` for a null (legacy rows predate the delivery
 * dimension) or unrecognised value, because `delivered` is the only predecessor
 * from which an Order can be settled at all -- and an unclose exists precisely
 * to make settlement possible again.
 */
export function restoredDeliveryStatus(priorStatus: string | null | undefined): string {
  if (priorStatus === null || priorStatus === undefined) return "delivered";
  return CLOSE_PREDECESSOR_STATUSES.includes(priorStatus) ? priorStatus : "delivered";
}
