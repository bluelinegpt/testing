import "reflect-metadata";

import { describe, expect, it } from "vitest";

import {
  REQUIRED_ANY_PERMISSIONS,
  REQUIRED_PERMISSIONS,
} from "../authentication/authentication.decorators.js";
import { ORDER_VIEWS_READ_PERMISSIONS, OrderViewsController } from "./order-views.controller.js";
import {
  type OrderView,
  STANDARD_ACTIVE_STATUSES,
  standardOrderViews,
  validateOrderViews,
} from "./order-views.js";

const standard = (): OrderView[] => standardOrderViews();

const custom = (overrides: Record<string, unknown> = {}) => ({
  definition: { dateField: "order_date", dateWindow: "today", statuses: [] },
  isDefault: false,
  isVisible: true,
  key: "custom_today",
  kind: "custom",
  labelAr: "طلبات اليوم",
  labelEn: "Today orders",
  showCount: true,
  ...overrides,
});

const errorsOf = (views: unknown): string[] => {
  const result = validateOrderViews(views);
  return result.ok ? [] : result.errors;
};

describe("standard Orders menu", () => {
  it("is today's 7 tabs, in today's order, Active first and Hold counted", () => {
    const views = standard();
    expect(views.map((view) => view.key)).toEqual([
      "active",
      "hold",
      "all",
      "closed",
      "cancelled",
      "delivery",
      "accountant",
    ]);
    expect(views.map((view) => view.labelEn)).toEqual([
      "Active Orders",
      "Hold",
      "All Orders",
      "Closed",
      "Cancelled",
      "Operation Activity",
      "Accountant",
    ]);
    expect(views.filter((view) => view.isDefault).map((view) => view.key)).toEqual(["active"]);
    expect(views.filter((view) => view.showCount).map((view) => view.key)).toEqual(["hold"]);
    expect(views[0]!.definition).toEqual({ statuses: STANDARD_ACTIVE_STATUSES });
  });

  it("passes its own validation unchanged", () => {
    const result = validateOrderViews(standard());
    expect(result).toEqual({ ok: true, views: standard() });
  });
});

describe("validateOrderViews", () => {
  it("accepts a custom view and keeps array order as display order", () => {
    const [active, ...rest] = standard();
    const result = validateOrderViews([active, custom(), ...rest]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.views.map((view) => view.key).slice(0, 3)).toEqual(["active", "custom_today", "hold"]);
      expect(result.views[1]!.definition).toEqual({
        dateField: "order_date",
        dateWindow: "today",
        statuses: [],
      });
    }
  });

  it("allows renaming, hiding and reordering standard views", () => {
    const views = standard().reverse().map((view) =>
      view.key === "closed" ? { ...view, isVisible: false, labelEn: "  Done   orders " } : view,
    );
    const result = validateOrderViews(views);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const closed = result.views.find((view) => view.key === "closed")!;
      expect(closed.labelEn).toBe("Done orders");
      expect(closed.isVisible).toBe(false);
    }
  });

  it("never lets a standard view be removed", () => {
    expect(errorsOf(standard().filter((view) => view.key !== "accountant"))).toContain(
      'The standard view "accountant" is missing; it can be hidden but not removed',
    );
  });

  it("never lets All Orders be hidden", () => {
    const views = standard().map((view) => (view.key === "all" ? { ...view, isVisible: false } : view));
    expect(errorsOf(views)).toContain("View 3: All Orders cannot be hidden");
  });

  it("ignores any rule sent for fixed-rule views", () => {
    const views = standard().map((view) =>
      view.key === "accountant" ? { ...view, definition: { statuses: ["new"] } } : view,
    );
    const result = validateOrderViews(views);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.views.find((view) => view.key === "accountant")!.definition).toBeNull();
  });

  it("lets Active Orders be narrowed, but never emptied or given Closed/Cancelled", () => {
    const withStatuses = (statuses: unknown) =>
      standard().map((view) => (view.key === "active" ? { ...view, definition: { statuses } } : view));
    const narrowed = validateOrderViews(withStatuses(["hold", "new", "new"]));
    expect(narrowed.ok).toBe(true);
    if (narrowed.ok) expect(narrowed.views[0]!.definition).toEqual({ statuses: ["new", "hold"] });
    expect(errorsOf(withStatuses([]))).toContain("View 1: Active Orders needs at least one status");
    expect(errorsOf(withStatuses(["closed"]))).toContain('View 1: "closed" is not an allowed status');
    expect(errorsOf(withStatuses(["cancelled"]))).toContain('View 1: "cancelled" is not an allowed status');
  });

  it("requires exactly one visible view to open first", () => {
    const none = standard().map((view) => ({ ...view, isDefault: false }));
    expect(errorsOf(none)).toContain("Exactly one view must open first");
    const two = standard().map((view) => ({ ...view, isDefault: view.key === "active" || view.key === "all" }));
    expect(errorsOf(two)).toContain("Exactly one view must open first");
    const hidden = standard().map((view) =>
      view.key === "active" ? { ...view, isVisible: false } : view,
    );
    expect(errorsOf(hidden)).toContain("The view that opens first must be visible");
  });

  it("checks names", () => {
    expect(errorsOf([...standard(), custom({ labelEn: "   " })])).toContain(
      "View 8: an English name is required",
    );
    expect(errorsOf([...standard(), custom({ labelEn: "x".repeat(41) })])).toContain(
      "View 8: the English name is longer than 40 characters",
    );
    const result = validateOrderViews([...standard(), custom({ labelAr: "  " })]);
    expect(result.ok && result.views[7]!.labelAr).toBeNull();
  });

  it("rejects bad and duplicate keys", () => {
    expect(errorsOf([...standard(), custom({ key: "today" })])).toContain(
      'View 8: key "today" is not a standard view or a valid custom key',
    );
    expect(errorsOf([...standard(), custom(), custom()])).toContain(
      'View 9: key "custom_today" appears more than once',
    );
    expect(errorsOf([...standard(), custom({ key: "active", kind: "custom" })])).toContain(
      'View 8: key "active" appears more than once',
    );
  });

  it("checks custom date windows, fields and statuses", () => {
    const withDefinition = (definition: Record<string, unknown>) => [
      ...standard(),
      custom({ definition }),
    ];
    expect(errorsOf(withDefinition({ dateWindow: "next_week" }))).toContain(
      'View 8: "next_week" is not a date window',
    );
    expect(errorsOf(withDefinition({ dateField: "updated_at", dateWindow: "today" }))).toContain(
      'View 8: "updated_at" is not a date field',
    );
    expect(errorsOf(withDefinition({ dateWindow: "last_n_days", lastNDays: 0 }))).toContain(
      "View 8: Last N days must be a whole number from 1 to 365",
    );
    expect(errorsOf(withDefinition({ dateWindow: "range", dateFrom: "2026-10-09", dateTo: "2026-10-01" }))).toContain(
      "View 8: the From date is after the To date",
    );
    expect(errorsOf(withDefinition({ dateWindow: "range", dateFrom: "2026-02-30", dateTo: "2026-03-01" }))).toContain(
      "View 8: a custom range needs valid From and To dates",
    );
    expect(errorsOf(withDefinition({ statuses: ["lost"] }))).toContain('View 8: "lost" is not an allowed status');
    const ok = validateOrderViews(withDefinition({ dateWindow: "last_n_days", lastNDays: 7, statuses: ["closed", "new"] }));
    expect(ok.ok && ok.views[7]!.definition).toEqual({
      dateField: "order_date",
      dateWindow: "last_n_days",
      lastNDays: 7,
      statuses: ["new", "closed"],
    });
  });

  it("caps custom views at 20", () => {
    const many = Array.from({ length: 21 }, (_, index) => custom({ key: `custom_v${index}` }));
    expect(errorsOf([...standard(), ...many])).toContain("At most 20 custom views are allowed");
  });

  it("rejects input that is not a list of objects", () => {
    expect(errorsOf("nope")).toEqual(["views must be a list"]);
    expect(errorsOf([...standard(), 5])).toContain("View 8: must be an object");
  });
});

describe("OrderViewsController permissions", () => {
  it("lets anyone who can see Orders read the menu", () => {
    const handler = OrderViewsController.prototype.menu;
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual([]);
    expect(Reflect.getMetadata(REQUIRED_ANY_PERMISSIONS, handler)).toEqual([
      ...ORDER_VIEWS_READ_PERMISSIONS,
    ]);
  });

  it("lets only menu managers and administrators change it", () => {
    const handler = OrderViewsController.prototype.save;
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual([]);
    expect(Reflect.getMetadata(REQUIRED_ANY_PERMISSIONS, handler)).toEqual([
      "order_views.manage",
      "users_roles.manage",
    ]);
  });
});
