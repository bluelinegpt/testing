import type { WhatsAppMessageLanguage } from "./whatsapp.dto.js";

/**
 * Eligibility + rendering for automatic Trader Order-status WhatsApp
 * notifications (Prompt 4).
 *
 * ELIGIBILITY — exactly the customer-visible delivery lifecycle statuses
 * from the current canonical set (`is_valid_order_status_value`, last
 * widened by `20260902011000_restore_partially_settled_status_validation`):
 * a Trader is told about assignment, dispatch, delivery, returns and
 * cancellation. Deliberately EXCLUDED: creation/internal stages (`new`,
 * `processing`, legacy `assigned`, `in_branch`, `hold`, `closed`,
 * `collect_order`) and every non-delivery status dimension
 * (reconciliation / settlement / return / accounting) — those are internal
 * or financial states, never Trader push material.
 *
 * TRANSLATIONS — the labels mirror the web UI's canonical `statuses` i18n
 * group (`apps/web/src/localization/resources/en.ts` / `ar.ts`), which is
 * the terminology Traders already see in their portal. The other backend
 * status source (`../operations/public-tracking-status.ts`) is deliberately
 * NOT reused: its vocabulary is customer-softened by design ("Delivery
 * Unsuccessful / Returned"), which is the wrong voice for a
 * business-to-Trader status line. If the web copy changes, this table is
 * the one place to update.
 *
 * WORDING is the interim Prompt 4 format — the final template is a later
 * product decision. No customer address, no financial data, no
 * customer-identifying data beyond what the Trader already owns.
 */
export const TRADER_NOTIFIABLE_DELIVERY_STATUSES = [
  "assigned_to_driver",
  "out_for_delivery",
  "delivered",
  "returned_to_branch",
  "returned_to_trader",
  "cancelled",
] as const;

const notifiable = new Set<string>(TRADER_NOTIFIABLE_DELIVERY_STATUSES);

export function isTraderNotifiableDeliveryStatus(status: string): boolean {
  return notifiable.has(status);
}

const STATUS_LABELS: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  assigned_to_driver: { ar: "معين للمندوب", en: "Assigned to driver" },
  cancelled: { ar: "ملغى", en: "Cancelled" },
  delivered: { ar: "تم التسليم", en: "Delivered" },
  out_for_delivery: { ar: "خرج للتوصيل", en: "Out for delivery" },
  returned_to_branch: { ar: "مرتجع إلى الفرع", en: "Returned to branch" },
  returned_to_trader: { ar: "مرتجع إلى التاجر", en: "Returned to trader" },
};

export function traderStatusLabel(status: string, language: "en" | "ar"): string {
  const labels = STATUS_LABELS[status];
  // A status outside the eligible set never reaches rendering; falling back
  // to the raw code is still safe (it is an internal enum, not secret data).
  return labels === undefined ? status : labels[language];
}

function formatTimestamp(occurredAt: Date, language: "en" | "ar"): string {
  return new Intl.DateTimeFormat(language === "ar" ? "ar-AE" : "en-AE", {
    day: "2-digit",
    hour: "2-digit",
    hour12: true,
    minute: "2-digit",
    month: "short",
    timeZone: "Asia/Dubai",
    year: "numeric",
  }).format(occurredAt);
}

export interface OrderStatusMessageInput {
  readonly language: WhatsAppMessageLanguage;
  readonly orderNumber: string;
  /** The shipment Airway Bill / serial the Trader references — omitted from
   *  the message entirely when the Order has none (never a blank row). */
  readonly referenceNumber: string | null;
  readonly status: string;
  readonly occurredAt: Date;
  readonly companyName: string;
}

/** A Platform-authored per-Company override of one status's message wording
 *  (`company_whatsapp_message_templates`). Both language bodies always exist
 *  together so `both` can assemble a bilingual message. */
export interface OrderStatusTemplateOverride {
  readonly bodyAr: string;
  readonly bodyEn: string;
}

/** The placeholder names a template override may use. Documented on the
 *  Platform's template editor; anything else stays literal text. */
export const TEMPLATE_PLACEHOLDERS = [
  "orderNumber",
  "referenceNumber",
  "status",
  "date",
  "companyName",
] as const;

/** The built-in wording expressed as placeholder templates — what the
 *  Platform's template editor shows as the starting point for a Company that
 *  has no override yet. The actual default RENDER path stays
 *  `renderOrderStatusMessage` below (it additionally omits the reference line
 *  when the Order has none); these strings exist for editing, not sending. */
export const DEFAULT_TEMPLATE_BODY_AR = [
  "تحديث حالة الطلب",
  "",
  "رقم الطلب: {{orderNumber}}",
  "الرقم المرجعي: {{referenceNumber}}",
  "الحالة: {{status}}",
  "وقت التحديث: {{date}}",
  "",
  "{{companyName}}",
].join("\n");

export const DEFAULT_TEMPLATE_BODY_EN = [
  "Order Status Update",
  "",
  "Order: {{orderNumber}}",
  "Reference: {{referenceNumber}}",
  "Status: {{status}}",
  "Updated: {{date}}",
  "",
  "{{companyName}}",
].join("\n");

function substitutePlaceholders(
  template: string,
  input: OrderStatusMessageInput,
  language: "en" | "ar",
): string {
  const values: Record<string, string> = {
    companyName: input.companyName,
    date: formatTimestamp(input.occurredAt, language),
    orderNumber: input.orderNumber,
    referenceNumber: input.referenceNumber ?? "",
    status: traderStatusLabel(input.status, language),
  };
  return template.replaceAll(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => {
    const value = values[name];
    // An unknown placeholder stays literal so a typo is visible in the
    // Platform's preview instead of silently vanishing from messages.
    return value === undefined ? whole : value;
  });
}

/** Renders a Platform-authored override for the Trader's language setting.
 *  `both` is ONE bilingual message — Arabic body, blank line, English body —
 *  mirroring the default template's single-send rule. */
export function renderOrderStatusMessageFromTemplate(
  template: OrderStatusTemplateOverride,
  input: OrderStatusMessageInput,
): string {
  if (input.language === "ar") return substitutePlaceholders(template.bodyAr, input, "ar");
  if (input.language === "en") return substitutePlaceholders(template.bodyEn, input, "en");
  return [
    substitutePlaceholders(template.bodyAr, input, "ar"),
    "",
    substitutePlaceholders(template.bodyEn, input, "en"),
  ].join("\n");
}

export function renderOrderStatusMessage(input: OrderStatusMessageInput): string {
  const arabicLines = [
    "تحديث حالة الطلب",
    "",
    `رقم الطلب: ${input.orderNumber}`,
    ...(input.referenceNumber === null ? [] : [`الرقم المرجعي: ${input.referenceNumber}`]),
    `الحالة: ${traderStatusLabel(input.status, "ar")}`,
    `وقت التحديث: ${formatTimestamp(input.occurredAt, "ar")}`,
    "",
    input.companyName,
  ];
  const englishLines = [
    "Order Status Update",
    "",
    `Order: ${input.orderNumber}`,
    ...(input.referenceNumber === null ? [] : [`Reference: ${input.referenceNumber}`]),
    `Status: ${traderStatusLabel(input.status, "en")}`,
    `Updated: ${formatTimestamp(input.occurredAt, "en")}`,
    "",
    input.companyName,
  ];
  if (input.language === "ar") return arabicLines.join("\n");
  if (input.language === "en") return englishLines.join("\n");
  // `both` is ONE bilingual message — never two provider sends.
  const bilingual = [
    "تحديث حالة الطلب | Order Status Update",
    "",
    `رقم الطلب | Order: ${input.orderNumber}`,
    ...(input.referenceNumber === null
      ? []
      : [`الرقم المرجعي | Reference: ${input.referenceNumber}`]),
    `الحالة | Status: ${traderStatusLabel(input.status, "ar")} | ${traderStatusLabel(input.status, "en")}`,
    `وقت التحديث | Updated: ${formatTimestamp(input.occurredAt, "en")}`,
    "",
    input.companyName,
  ];
  return bilingual.join("\n");
}
