import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import {
  makeDefaultOrderView,
  moveOrderView,
  type OrderViewsMenu,
  orderViewsProblems,
  standardOrderViews,
} from "./order-views.js";
import { OrderViewsWorkspace } from "./OrderViewsWorkspace.js";

const standardMenu = (): OrderViewsMenu => ({
  enabled: false,
  isStandard: true,
  updatedAt: null,
  updatedBy: null,
  version: 0,
  views: standardOrderViews(),
});

function setup(options: { menu?: OrderViewsMenu; permissions?: readonly string[] } = {}) {
  const menu = options.menu ?? standardMenu();
  const api = {
    get: vi.fn().mockResolvedValue(menu),
    put: vi.fn((_path: string, body: { enabled: boolean; expectedVersion: number; views: unknown[] }) =>
      Promise.resolve({
        ...menu,
        enabled: body.enabled,
        isStandard: false,
        updatedAt: "2026-10-09T18:00:00Z",
        updatedBy: "aiman",
        version: menu.version + 1,
        views: body.views,
      }),
    ),
  };
  render(
    <OrderViewsWorkspace
      api={api as unknown as ApiClient}
      permissions={options.permissions ?? ["users_roles.manage"]}
    />,
  );
  return { api };
}

describe("Orders menu helpers", () => {
  it("starts from today's 7 tabs with Active first and Hold counted", () => {
    const views = standardOrderViews();
    expect(views.map((view) => view.key)).toEqual([
      "active",
      "hold",
      "all",
      "closed",
      "cancelled",
      "delivery",
      "accountant",
    ]);
    expect(orderViewsProblems(views)).toEqual([]);
  });

  it("moves a tab and keeps the ends in place", () => {
    const views = standardOrderViews();
    expect(moveOrderView(views, 1, -1).map((view) => view.key).slice(0, 2)).toEqual(["hold", "active"]);
    expect(moveOrderView(views, 0, -1).map((view) => view.key)).toEqual(views.map((view) => view.key));
  });

  it("making a tab open first also shows it", () => {
    const hidden = standardOrderViews().map((view) =>
      view.key === "closed" ? { ...view, isVisible: false } : view,
    );
    const next = makeDefaultOrderView(hidden, "closed");
    expect(next.filter((view) => view.isDefault).map((view) => view.key)).toEqual(["closed"]);
    expect(next.find((view) => view.key === "closed")?.isVisible).toBe(true);
  });

  it("flags an Active Orders tab with no status", () => {
    const views = standardOrderViews().map((view) =>
      view.key === "active" ? { ...view, definition: { statuses: [] } } : view,
    );
    expect(orderViewsProblems(views)).toEqual(["activeNeedsStatus"]);
  });
});

describe("OrderViewsWorkspace", () => {
  it("shows the standard menu with the switch OFF and nothing to save", async () => {
    setup();
    expect(
      await screen.findByText("Custom menu is OFF — the standard menu is in use"),
    ).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(8);
    expect(screen.getByRole("switch", { name: /Use a custom Orders menu|Custom menu is OFF/ })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save menu" })).toBeDisabled();
    // All Orders can never be hidden.
    expect(screen.queryByRole("switch", { name: "Show All Orders in the menu" })).not.toBeInTheDocument();
  });

  it("adds a Today tab, switches the menu on and saves the whole menu", async () => {
    const { api } = setup();
    await screen.findByText("Custom menu is OFF — the standard menu is in use");
    fireEvent.click(screen.getByRole("button", { name: "Add view" }));
    const dialog = await screen.findByRole("dialog", { name: /Add view/ });
    fireEvent.change(within(dialog).getByLabelText("English name"), {
      target: { value: "Today orders" },
    });
    fireEvent.change(within(dialog).getByLabelText("Arabic name"), {
      target: { value: "طلبات اليوم" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(await within(screen.getByRole("table")).findByText("Today orders")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: /Custom menu is OFF/ }));
    expect(screen.getByText("Custom menu is ON for this company")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save menu" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [path, body] = api.put.mock.calls[0]!;
    expect(path).toBe("configuration/order-views");
    expect(body.enabled).toBe(true);
    expect(body.expectedVersion).toBe(0);
    const added = (body.views as { key: string; labelEn: string; definition: unknown }[]).at(-1)!;
    expect(added.key).toMatch(/^custom_[a-z0-9]+$/);
    expect(added.labelEn).toBe("Today orders");
    expect(added.definition).toEqual({ dateField: "order_date", dateWindow: "today", statuses: [] });
    expect(await screen.findByText("Orders menu saved.")).toBeInTheDocument();
  });

  it("reorders tabs with the arrow buttons", async () => {
    setup();
    await screen.findByText("Custom menu is OFF — the standard menu is in use");
    fireEvent.click(screen.getByRole("button", { name: "Move Hold up" }));
    const firstCells = within(screen.getByRole("table"))
      .getAllByRole("row")
      .slice(1, 3)
      .map((row) => within(row).getAllByRole("cell")[1]!.textContent);
    expect(firstCells[0]).toContain("Hold");
    expect(firstCells[1]).toContain("Active Orders");
    expect(screen.getByRole("button", { name: "Save menu" })).toBeEnabled();
  });

  it("only offers Active Orders statuses and warns when Delivered is removed", async () => {
    setup();
    await screen.findByText("Custom menu is OFF — the standard menu is in use");
    fireEvent.click(screen.getByRole("button", { name: "Edit Active Orders" }));
    const dialog = await screen.findByRole("dialog", { name: /Edit view: Active Orders/ });
    expect(within(dialog).queryByLabelText("Closed")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Cancelled")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText("Delivered"));
    expect(within(dialog).getByText(/Delivered is not ticked/)).toBeInTheDocument();
  });

  it("explains a fixed-rule tab instead of offering its rule", async () => {
    setup();
    await screen.findByText("Custom menu is OFF — the standard menu is in use");
    fireEvent.click(screen.getByRole("button", { name: "Edit Accountant" }));
    const dialog = await screen.findByRole("dialog", { name: /Edit view: Accountant/ });
    expect(within(dialog).getByText(/its rule can't be changed here/)).toBeInTheDocument();
    expect(within(dialog).queryByText("Which statuses")).not.toBeInTheDocument();
  });

  it("tells the user when someone else saved first", async () => {
    const { api } = setup();
    api.put.mockRejectedValueOnce(
      new ApiError("conflict", "order_views_version_conflict", 409),
    );
    await screen.findByText("Custom menu is OFF — the standard menu is in use");
    fireEvent.click(screen.getByRole("switch", { name: /Custom menu is OFF/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save menu" }));
    expect(
      await screen.findByText(/Someone else changed the Orders menu/),
    ).toBeInTheDocument();
  });

  it("is read-only without the menu permission", async () => {
    setup({ permissions: ["orders.assign_driver"] });
    await screen.findByText("Custom menu is OFF — the standard menu is in use");
    expect(screen.queryByRole("button", { name: "Save menu" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add view" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Custom menu is OFF/ })).toBeDisabled();
  });
});

void i18nInstance;
