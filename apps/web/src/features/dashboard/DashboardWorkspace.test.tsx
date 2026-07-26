import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { DashboardWorkspace } from "./DashboardWorkspace.js";

const overview = {
  counts: {
    activeDrivers: 2,
    activeTraders: 3,
    orders: 4,
    pendingCashOrders: 1,
    unsettledTraderOrders: 2,
  },
  deliveryStatuses: [{ count: 4, status: "new" }],
  financials: {
    codAmount: "700.00",
    companyRevenue: "615.00",
    customerAmountDue: "710.00",
    orderProfit: "515.00",
    traderNetPayable: "600.00",
    vatAmount: "30.75",
  },
};

describe("DashboardWorkspace", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
  });

  it("loads a selected period, formats AED values, and supports drill-down", async () => {
    const api = { get: vi.fn().mockResolvedValue(overview) };
    const drillDown = vi.fn();
    render(<DashboardWorkspace api={api as unknown as ApiClient} onDrillDown={drillDown} />);
    expect(await screen.findByText(/AED.*615\.00/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "This month" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /Orders: 4/ }));
    expect(drillDown).toHaveBeenCalledWith("orders");
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(String(api.get.mock.calls[1]?.[0])).toContain("dateFrom=");
  });
});
