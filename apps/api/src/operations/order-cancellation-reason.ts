/**
 * Order cancellation reasons (Aiman, 9 Oct 2026): a fixed list of exactly
 * three, internal only, a label with no money effect. The database enforces
 * the same list (`orders_cancellation_reason_code_check`).
 */
export const ORDER_CANCELLATION_REASONS = [
  "cancel_by_customer",
  "cancel_by_trader",
  "cancel_normal",
] as const;

export type OrderCancellationReason = (typeof ORDER_CANCELLATION_REASONS)[number];

export const DEFAULT_ORDER_CANCELLATION_REASON: OrderCancellationReason = "cancel_normal";

/**
 * The reason stored when an Order is cancelled.
 *
 * A Trader cancelling is always "Cancel by Trader" and a Driver cancelling is
 * always "Cancel Normal", whatever the request says. Today neither can cancel
 * (the transition tables refuse it); this keeps the rule true if that changes.
 * Office users pick one; when none is sent, "Cancel Normal".
 */
export function resolveOrderCancellationReason(
  actorKind: string,
  requested: OrderCancellationReason | undefined,
): OrderCancellationReason {
  if (actorKind === "trader") return "cancel_by_trader";
  if (actorKind === "driver") return "cancel_normal";
  return requested ?? DEFAULT_ORDER_CANCELLATION_REASON;
}
