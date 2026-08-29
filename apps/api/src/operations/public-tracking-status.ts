/**
 * The single, canonical mapping from internal delivery status to the public
 * vocabulary shown to a customer tracking a shipment. Shared by every public
 * tracking surface -- the central cross-company `/track` lookup
 * (`PublicTrackingService`), the legacy per-order tracking-link endpoint
 * (`OperationsService.publicTracking`), and the Yousef agent -- so there is
 * exactly one place that decides what a customer is told, never a
 * per-endpoint duplicate that could drift out of sync or leak a raw enum.
 *
 * Covers every value the live `orders_delivery_status_check` constraint
 * actually allows today -- confirmed directly against the database
 * (`new`, `in_branch`, `assigned_to_driver`, `out_for_delivery`, `hold`,
 * `delivered`, `returned_to_branch`, `returned_to_trader`, `cancelled`,
 * `closed`, `collect_order`), not an earlier migration snapshot, since this
 * constraint has been altered more than once since it was first created.
 * Financial/reconciliation/settlement/accounting status dimensions are a
 * different axis entirely and never reach this mapping or any public
 * response.
 *
 * Bilingual: the label itself is returned in the requested language (not
 * just the surrounding page/message chrome), since a customer reading
 * Yousef or /track in Arabic should never see an English status word
 * embedded mid-sentence.
 */
export type PublicTrackingLanguage = "en" | "ar";

const PUBLIC_STATUS_LABELS: Readonly<
  Record<string, Readonly<Record<PublicTrackingLanguage, string>>>
> = {
  new: { en: "Shipment Received", ar: "تم استلام الشحنة" },
  in_branch: { en: "At Delivery Branch", ar: "في فرع التوصيل" },
  assigned_to_driver: { en: "Assigned for Delivery", ar: "تم إسنادها للتوصيل" },
  out_for_delivery: { en: "Out for Delivery", ar: "خرجت للتوصيل" },
  hold: { en: "On Hold", ar: "معلّقة مؤقتاً" },
  delivered: { en: "Delivered", ar: "تم التسليم" },
  returned_to_branch: {
    en: "Delivery Unsuccessful / Returned",
    ar: "تعذر التسليم / أُعيدت الشحنة",
  },
  returned_to_trader: { en: "Returned to Trader", ar: "أُعيدت إلى التاجر" },
  cancelled: { en: "Cancelled", ar: "ملغاة" },
  closed: { en: "Completed", ar: "مكتملة" },
  // Collect-type Orders (orderType "collect_order") sit at this status for
  // most of their life rather than progressing through the normal
  // new -> assigned -> out_for_delivery -> delivered sequence -- "In
  // Progress" is deliberately generic rather than overclaiming a specific
  // delivery-lifecycle stage that may not apply to this order type.
  collect_order: { en: "In Progress", ar: "قيد التنفيذ" },
};

export interface PublicTrackingStatus {
  readonly status: string;
  readonly statusLabel: string;
}

/**
 * Maps a raw internal `delivery_status` (or `order_status_history.to_status`
 * for the 'delivery' dimension) value to its public status code + label, in
 * the requested language (default English). An unrecognised value maps to a
 * safe, honest "unavailable" state rather than ever passing the raw
 * internal string through.
 */
export function mapPublicTrackingStatus(
  internalStatus: string,
  language: PublicTrackingLanguage = "en",
): PublicTrackingStatus {
  const labels = PUBLIC_STATUS_LABELS[internalStatus];
  return labels === undefined
    ? {
        status: "unavailable",
        statusLabel: language === "ar" ? "الحالة غير متاحة" : "Status Unavailable",
      }
    : { status: internalStatus, statusLabel: labels[language] };
}
