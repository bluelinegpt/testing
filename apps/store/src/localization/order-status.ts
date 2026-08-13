import type { TFunction } from "i18next";

import type { StoreOrderStatus } from "../api/customer-orders-client.js";

/**
 * §11: translates the real Store Order lifecycle enum into Customer-facing
 * copy -- the raw database string (`awaiting_trader_confirmation`) never
 * reaches the UI directly. §13: `awaiting_trader_confirmation` reads as an
 * open-ended wait, not an expiry, because that lifecycle genuinely has none
 * (no `confirmation_expired` state exists in the API).
 */
export function orderStatusLabel(t: TFunction, status: StoreOrderStatus): string {
  return t(`orders.statusLabels.${status}`);
}

/** A soft/neutral/success/muted tone for the status badge -- purely visual,
 * derived from the same enum, never a second source of truth. */
export function orderStatusTone(
  status: StoreOrderStatus,
): "muted" | "soft" | "success" {
  switch (status) {
    case "cancelled":
      return "muted";
    case "confirmed":
    case "converted_to_delivery":
    case "completed_external":
      return "success";
    default:
      return "soft";
  }
}
