/**
 * Orders menu ("order views") rules, agreed with Aiman on 9 Oct 2026 and shown
 * in the "Order Views Menu Setup" design.
 *
 * - Standard views keep their existing server rules. They can be renamed
 *   (English / Arabic), reordered, hidden and have their count switched on or
 *   off. Active Orders also lets the Company pick which delivery statuses
 *   count as active; its "closed Orders still awaiting settlement" rule stays
 *   on and cannot be removed. Operation Activity and Accountant follow
 *   reconciliation and settlement logic, so their rules are fixed. All Orders
 *   can never be hidden.
 * - Custom views filter by delivery status and a date window on one date
 *   field. A view only filters the list; it never changes any Order or money.
 *
 * This module is pure (no database) so the same rules are unit-tested here and
 * applied by both the settings save (this prompt) and the Orders list query
 * (next prompt).
 */

export const SYSTEM_VIEW_KEYS = [
  "active",
  "hold",
  "all",
  "closed",
  "cancelled",
  "delivery",
  "accountant",
] as const;
export type SystemViewKey = (typeof SYSTEM_VIEW_KEYS)[number];

/** Rules that follow financial logic: name, order, visibility and count only. */
export const FIXED_RULE_VIEW_KEYS: ReadonlySet<string> = new Set(["delivery", "accountant"]);
/** Always shown. */
export const ALWAYS_VISIBLE_VIEW_KEYS: ReadonlySet<string> = new Set(["all"]);

export const ORDER_VIEW_DELIVERY_STATUSES = [
  "new",
  "in_branch",
  "assigned_to_driver",
  "out_for_delivery",
  "hold",
  "delivered",
  "returned_to_branch",
  "returned_to_trader",
  "collect_order",
  "closed",
  "cancelled",
] as const;
export type OrderViewDeliveryStatus = (typeof ORDER_VIEW_DELIVERY_STATUSES)[number];

/** Today's Active Orders statuses -- the standard rule, unchanged. */
export const STANDARD_ACTIVE_STATUSES: readonly OrderViewDeliveryStatus[] = [
  "new",
  "in_branch",
  "assigned_to_driver",
  "out_for_delivery",
  "hold",
  "delivered",
  "returned_to_branch",
  "returned_to_trader",
  "collect_order",
];
/**
 * Statuses Active Orders may be narrowed to. Closed and Cancelled are not
 * offered: closed Orders still owing money are always included by the locked
 * rule, and a cancelled Order is never active work.
 */
export const ACTIVE_ALLOWED_STATUSES: ReadonlySet<string> = new Set(STANDARD_ACTIVE_STATUSES);

export const ORDER_VIEW_DATE_WINDOWS = [
  "any",
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "last_n_days",
  "range",
] as const;
export type OrderViewDateWindow = (typeof ORDER_VIEW_DATE_WINDOWS)[number];

/**
 * `order_date` is the Order's Business Date (there is no separate column);
 * `created_at` and `delivered_at` are instants.
 */
export const ORDER_VIEW_DATE_FIELDS = ["order_date", "created_at", "delivered_at"] as const;
export type OrderViewDateField = (typeof ORDER_VIEW_DATE_FIELDS)[number];

export const MAX_CUSTOM_ORDER_VIEWS = 20;
export const MAX_ORDER_VIEW_LABEL_LENGTH = 40;
export const MAX_LAST_N_DAYS = 365;

export interface ActiveViewDefinition {
  readonly statuses: readonly OrderViewDeliveryStatus[];
}

export interface CustomViewDefinition {
  /** Empty means every status. */
  readonly statuses: readonly OrderViewDeliveryStatus[];
  readonly dateWindow: OrderViewDateWindow;
  readonly dateField: OrderViewDateField;
  readonly lastNDays?: number;
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

export interface OrderView {
  readonly key: string;
  readonly kind: "system" | "custom";
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly isVisible: boolean;
  readonly showCount: boolean;
  readonly isDefault: boolean;
  /** Active: `ActiveViewDefinition`; custom: `CustomViewDefinition`; other standard views: null. */
  readonly definition: ActiveViewDefinition | CustomViewDefinition | null;
}

/** Today's menu, exactly: names, order and the Hold count. */
export function standardOrderViews(): OrderView[] {
  const system = (
    key: SystemViewKey,
    labelEn: string,
    labelAr: string,
    extra: Partial<Pick<OrderView, "showCount" | "isDefault" | "definition">> = {},
  ): OrderView => ({
    definition: null,
    isDefault: false,
    isVisible: true,
    key,
    kind: "system",
    labelAr,
    labelEn,
    showCount: false,
    ...extra,
  });
  return [
    system("active", "Active Orders", "الطلبات النشطة", {
      definition: { statuses: [...STANDARD_ACTIVE_STATUSES] },
      isDefault: true,
    }),
    system("hold", "Hold", "معلّق", { showCount: true }),
    system("all", "All Orders", "كل الطلبات"),
    system("closed", "Closed", "مغلقة"),
    system("cancelled", "Cancelled", "ملغاة"),
    system("delivery", "Operation Activity", "نشاط العمليات"),
    system("accountant", "Accountant", "المحاسب"),
  ];
}

export type OrderViewsValidation =
  | { readonly ok: true; readonly views: OrderView[] }
  | { readonly ok: false; readonly errors: string[] };

const customKeyPattern = /^custom_[a-z0-9_]{1,32}$/u;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !isoDatePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function label(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed === "" ? null : trimmed;
}

function statusList(
  value: unknown,
  allowed: ReadonlySet<string>,
  where: string,
  errors: string[],
): OrderViewDeliveryStatus[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${where}: statuses must be a list`);
    return [];
  }
  const out: OrderViewDeliveryStatus[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) {
      errors.push(`${where}: "${String(item)}" is not an allowed status`);
      continue;
    }
    if (!out.includes(item as OrderViewDeliveryStatus)) out.push(item as OrderViewDeliveryStatus);
  }
  // Canonical order, so the stored menu does not change with tick order.
  return ORDER_VIEW_DELIVERY_STATUSES.filter((status) => out.includes(status));
}

/**
 * Validates and normalizes a whole menu as submitted by the settings screen.
 * Array order is the display order. Every standard view must be present once
 * (they can be hidden, never deleted); custom views can be added or removed.
 */
export function validateOrderViews(input: unknown): OrderViewsValidation {
  const errors: string[] = [];
  if (!Array.isArray(input)) return { errors: ["views must be a list"], ok: false };
  const allStatuses: ReadonlySet<string> = new Set(ORDER_VIEW_DELIVERY_STATUSES);
  const seen = new Set<string>();
  const views: OrderView[] = [];
  let customCount = 0;

  input.forEach((raw, index) => {
    const where = `View ${index + 1}`;
    if (!isRecord(raw)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    const isSystem = (SYSTEM_VIEW_KEYS as readonly string[]).includes(key);
    if (!isSystem && !customKeyPattern.test(key)) {
      errors.push(`${where}: key "${key}" is not a standard view or a valid custom key`);
      return;
    }
    if (seen.has(key)) {
      errors.push(`${where}: key "${key}" appears more than once`);
      return;
    }
    seen.add(key);
    const kind = isSystem ? "system" : "custom";
    if (raw.kind !== undefined && raw.kind !== kind) {
      errors.push(`${where}: "${key}" must be a ${kind} view`);
    }
    const labelEn = label(raw.labelEn);
    if (labelEn === null) errors.push(`${where}: an English name is required`);
    else if (labelEn.length > MAX_ORDER_VIEW_LABEL_LENGTH)
      errors.push(`${where}: the English name is longer than ${MAX_ORDER_VIEW_LABEL_LENGTH} characters`);
    const labelAr = label(raw.labelAr);
    if (labelAr !== null && labelAr.length > MAX_ORDER_VIEW_LABEL_LENGTH)
      errors.push(`${where}: the Arabic name is longer than ${MAX_ORDER_VIEW_LABEL_LENGTH} characters`);
    const isVisible = raw.isVisible !== false;
    const showCount = raw.showCount === true;
    const isDefault = raw.isDefault === true;
    if (ALWAYS_VISIBLE_VIEW_KEYS.has(key) && !isVisible) {
      errors.push(`${where}: All Orders cannot be hidden`);
    }

    let definition: OrderView["definition"] = null;
    if (key === "active") {
      const source = isRecord(raw.definition) ? raw.definition : {};
      const statuses = statusList(source.statuses, ACTIVE_ALLOWED_STATUSES, where, errors);
      if (statuses.length === 0) errors.push(`${where}: Active Orders needs at least one status`);
      definition = { statuses };
    } else if (kind === "custom") {
      customCount += 1;
      const source = isRecord(raw.definition) ? raw.definition : {};
      const statuses = statusList(source.statuses, allStatuses, where, errors);
      const dateWindow = source.dateWindow ?? "any";
      const dateField = source.dateField ?? "order_date";
      if (!(ORDER_VIEW_DATE_WINDOWS as readonly unknown[]).includes(dateWindow)) {
        errors.push(`${where}: "${String(dateWindow)}" is not a date window`);
      }
      if (!(ORDER_VIEW_DATE_FIELDS as readonly unknown[]).includes(dateField)) {
        errors.push(`${where}: "${String(dateField)}" is not a date field`);
      }
      let extra: Pick<CustomViewDefinition, "dateFrom" | "dateTo" | "lastNDays"> = {};
      if (dateWindow === "last_n_days") {
        const days = source.lastNDays;
        if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_LAST_N_DAYS) {
          errors.push(`${where}: Last N days must be a whole number from 1 to ${MAX_LAST_N_DAYS}`);
        } else {
          extra = { lastNDays: days };
        }
      }
      if (dateWindow === "range") {
        if (!validIsoDate(source.dateFrom) || !validIsoDate(source.dateTo)) {
          errors.push(`${where}: a custom range needs valid From and To dates`);
        } else if (source.dateFrom > source.dateTo) {
          errors.push(`${where}: the From date is after the To date`);
        } else {
          extra = { dateFrom: source.dateFrom, dateTo: source.dateTo };
        }
      }
      definition = {
        dateField: dateField as OrderViewDateField,
        dateWindow: dateWindow as OrderViewDateWindow,
        statuses,
        ...extra,
      };
    }
    views.push({
      definition,
      isDefault,
      isVisible,
      key,
      kind,
      labelAr,
      labelEn: labelEn ?? "",
      showCount,
    });
  });

  for (const key of SYSTEM_VIEW_KEYS) {
    if (!seen.has(key)) errors.push(`The standard view "${key}" is missing; it can be hidden but not removed`);
  }
  if (customCount > MAX_CUSTOM_ORDER_VIEWS) {
    errors.push(`At most ${MAX_CUSTOM_ORDER_VIEWS} custom views are allowed`);
  }
  const defaults = views.filter((view) => view.isDefault);
  if (defaults.length !== 1) {
    errors.push("Exactly one view must open first");
  } else if (!defaults[0]!.isVisible) {
    errors.push("The view that opens first must be visible");
  }
  return errors.length > 0 ? { errors, ok: false } : { ok: true, views };
}
