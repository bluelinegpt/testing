/**
 * Shared Commerce Foundation Prompt 3B: the Store Order lifecycle.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE STATE SET FROM DELIVERY `delivery_status`
 * ---------------------------------------------------------------------------
 *
 * A Store Order's lifecycle answers "has the shop/Trader agreed to fulfil
 * this", not "where is it physically" -- that second question belongs to
 * the Delivery Order it may later convert into (`assigned_to_driver`,
 * `out_for_delivery`, `delivered`, ...), which stays exactly as it is.
 * Reusing Delivery's status vocabulary here would blur two genuinely
 * different questions into one column.
 *
 * `awaiting_trader_confirmation` has deliberately NO automatic expiry (§12):
 * the approved no-Delivery-Company workflow is Trader/Platform follow-up,
 * not a timeout that silently cancels a shopper's Order.
 */
export const storeOrderStatuses = [
  "draft",
  "submitted",
  "awaiting_trader_confirmation",
  "confirmed",
  "cancelled",
  "converted_to_delivery",
  "completed_external",
] as const;

export type StoreOrderStatus = (typeof storeOrderStatuses)[number];

export const storeOrderSources = ["store_web", "store_app", "trader_manual_future"] as const;

export type StoreOrderSource = (typeof storeOrderSources)[number];

/**
 * The explicit transition graph (§13). Deliberately narrow -- only the
 * transitions this foundation actually needs are legal; Checkout-specific
 * transitions (payment states, cart abandonment, etc.) are not invented
 * ahead of the prompt that defines them.
 */
const storeOrderTransitions: Readonly<Record<StoreOrderStatus, readonly StoreOrderStatus[]>> = {
  draft: ["submitted"],
  submitted: ["awaiting_trader_confirmation", "confirmed"],
  awaiting_trader_confirmation: ["confirmed", "cancelled"],
  confirmed: ["converted_to_delivery", "completed_external"],
  cancelled: [],
  converted_to_delivery: [],
  completed_external: [],
};

export function isValidStoreOrderTransition(
  from: StoreOrderStatus,
  to: StoreOrderStatus,
): boolean {
  return storeOrderTransitions[from].includes(to);
}
