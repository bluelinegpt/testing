/**
 * Orders menu ("order views") -- web-side types and helpers.
 *
 * The API (`apps/api/src/company-configuration/order-views.ts`) is the source
 * of truth and re-validates every save; these constants only drive the
 * settings screen and must stay in step with it.
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

export const FIXED_RULE_VIEW_KEYS: ReadonlySet<string> = new Set(["delivery", "accountant"]);
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

/** Statuses Active Orders may be narrowed to (Closed and Cancelled are not offered). */
export const ACTIVE_ALLOWED_STATUSES: readonly OrderViewDeliveryStatus[] = [
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

export const ORDER_VIEW_DATE_FIELDS = ["order_date", "created_at", "delivered_at"] as const;
export type OrderViewDateField = (typeof ORDER_VIEW_DATE_FIELDS)[number];

export const MAX_CUSTOM_ORDER_VIEWS = 20;
export const MAX_ORDER_VIEW_LABEL_LENGTH = 40;

export interface OrderViewDefinition {
  readonly statuses: readonly OrderViewDeliveryStatus[];
  readonly dateWindow?: OrderViewDateWindow;
  readonly dateField?: OrderViewDateField;
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
  readonly definition: OrderViewDefinition | null;
}

export interface OrderViewsMenu {
  readonly enabled: boolean;
  readonly isStandard: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly version: number;
  readonly views: readonly OrderView[];
}

/** Today's menu, exactly -- the same list the API returns when nothing is saved. */
export function standardOrderViews(): OrderView[] {
  const system = (
    key: (typeof SYSTEM_VIEW_KEYS)[number],
    labelEn: string,
    labelAr: string,
    extra: Partial<Pick<OrderView, "definition" | "isDefault" | "showCount">> = {},
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
      definition: { statuses: [...ACTIVE_ALLOWED_STATUSES] },
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

export type OrderViewKind = "system" | "fixed" | "always" | "custom";

export function orderViewKind(view: OrderView): OrderViewKind {
  if (view.kind === "custom") return "custom";
  if (FIXED_RULE_VIEW_KEYS.has(view.key)) return "fixed";
  if (ALWAYS_VISIBLE_VIEW_KEYS.has(view.key)) return "always";
  return "system";
}

/** A view's name in the reader's language, falling back to English. */
export function orderViewLabel(view: OrderView, language: string): string {
  return language.startsWith("ar") && view.labelAr !== null && view.labelAr.trim() !== ""
    ? view.labelAr
    : view.labelEn;
}

/** A new custom view's key: unique within the menu, matching the API's pattern. */
export function newCustomViewKey(existing: readonly OrderView[], random = Math.random): string {
  for (;;) {
    const key = `custom_${random().toString(36).slice(2, 10).replace(/[^a-z0-9]/gu, "")}`;
    if (key.length > "custom_".length && !existing.some((view) => view.key === key)) return key;
  }
}

export function newCustomView(existing: readonly OrderView[]): OrderView {
  return {
    definition: { dateField: "order_date", dateWindow: "today", statuses: [] },
    isDefault: false,
    isVisible: true,
    key: newCustomViewKey(existing),
    kind: "custom",
    labelAr: null,
    labelEn: "",
    showCount: true,
  };
}

export function moveOrderView(
  views: readonly OrderView[],
  index: number,
  offset: -1 | 1,
): OrderView[] {
  const target = index + offset;
  if (target < 0 || target >= views.length) return [...views];
  const next = [...views];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

/** Makes one view the one that opens first, and makes sure it is visible. */
export function makeDefaultOrderView(views: readonly OrderView[], key: string): OrderView[] {
  return views.map((view) => ({
    ...view,
    isDefault: view.key === key,
    isVisible: view.key === key ? true : view.isVisible,
  }));
}

/**
 * The same checks the API runs, so the screen can explain a problem before
 * the save round-trip. The API remains the authority.
 */
export function orderViewsProblems(views: readonly OrderView[]): string[] {
  const problems: string[] = [];
  const defaults = views.filter((view) => view.isDefault);
  if (defaults.length !== 1) problems.push("defaultCount");
  else if (!defaults[0]!.isVisible) problems.push("defaultHidden");
  if (views.some((view) => view.labelEn.trim() === "")) problems.push("nameRequired");
  if (
    views.some(
      (view) =>
        view.labelEn.trim().length > MAX_ORDER_VIEW_LABEL_LENGTH ||
        (view.labelAr ?? "").trim().length > MAX_ORDER_VIEW_LABEL_LENGTH,
    )
  )
    problems.push("nameTooLong");
  const active = views.find((view) => view.key === "active");
  if (active !== undefined && (active.definition?.statuses.length ?? 0) === 0)
    problems.push("activeNeedsStatus");
  if (views.filter((view) => view.kind === "custom").length > MAX_CUSTOM_ORDER_VIEWS)
    problems.push("tooManyCustom");
  for (const view of views) {
    const definition = view.definition;
    if (view.kind !== "custom" || definition === null) continue;
    if (
      definition.dateWindow === "last_n_days" &&
      (definition.lastNDays === undefined ||
        !Number.isInteger(definition.lastNDays) ||
        definition.lastNDays < 1 ||
        definition.lastNDays > 365)
    )
      problems.push("lastNDaysInvalid");
    if (
      definition.dateWindow === "range" &&
      (definition.dateFrom === undefined ||
        definition.dateTo === undefined ||
        definition.dateFrom > definition.dateTo)
    )
      problems.push("rangeInvalid");
  }
  return [...new Set(problems)];
}
