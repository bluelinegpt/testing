/**
 * The single, canonical mapping from internal delivery status to the public
 * vocabulary shown to a customer tracking a shipment. Shared by every public
 * tracking surface -- the central cross-company `/track` lookup
 * (`PublicTrackingService`), the legacy per-order tracking-link endpoint
 * (`OperationsService.publicTracking`), and the Yousef agent -- so there is
 * exactly one place that decides what a customer is told, never a
 * per-endpoint duplicate that could drift out of sync or leak a raw enum.
 *
 * Deliberately narrower than `orders_delivery_status_check`
 * (new|processing|assigned|out_for_delivery|delivered|returned|cancelled):
 * financial/reconciliation/settlement/accounting status dimensions are a
 * different axis entirely and never reach this mapping or any public
 * response.
 */
const PUBLIC_STATUS_LABELS: Readonly<Record<string, string>> = {
  new: "Shipment Received",
  processing: "Shipment Received",
  assigned: "Assigned for Delivery",
  out_for_delivery: "Out for Delivery",
  delivered: "Delivered",
  returned: "Delivery Unsuccessful / Returned",
  cancelled: "Cancelled",
};

export interface PublicTrackingStatus {
  readonly status: string;
  readonly statusLabel: string;
}

/**
 * Maps a raw internal `delivery_status` (or `order_status_history.to_status`
 * for the 'delivery' dimension) value to its public status code + label. An
 * unrecognised value maps to a safe, honest "unavailable" state rather than
 * ever passing the raw internal string through.
 */
export function mapPublicTrackingStatus(internalStatus: string): PublicTrackingStatus {
  const label = PUBLIC_STATUS_LABELS[internalStatus];
  return label === undefined
    ? { status: "unavailable", statusLabel: "Status Unavailable" }
    : { status: internalStatus, statusLabel: label };
}
