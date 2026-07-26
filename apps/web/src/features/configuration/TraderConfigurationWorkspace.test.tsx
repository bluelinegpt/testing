import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { TraderConfigurationWorkspace } from "./TraderConfigurationWorkspace.js";

describe("TraderConfigurationWorkspace", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("loads a paginated Trader list and exposes the preserved legacy-mobile warning", async () => {
    const navigate = vi.fn();
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [
          {
            code: "TR001",
            contactPerson: "Aisha",
            currentServiceFee: null,
            id: "10000000-0000-4000-8000-000000000001",
            mobileNumber: "+971500000001",
            mobileWarning: true,
            name: "Demo Store",
            outstandingAmount: "135.00",
            pickupArea: "Dubai",
            pricingType: null,
            status: "active",
          },
        ],
        page: 1,
        pageSize: 25,
        total: 1,
      }),
    };
    render(
      <TraderConfigurationWorkspace api={api as unknown as ApiClient} onNavigate={navigate} />,
    );
    await screen.findByText("TR001");
    expect(screen.getByLabelText(/legacy format/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "Demo" } });
    await waitFor(() =>
      expect(api.get).toHaveBeenLastCalledWith(expect.stringContaining("search=Demo")),
    );
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(navigate).toHaveBeenCalledWith("/configuration/traders/TR001");
  });

  it("uses one Name field and no manual Trader code in the create form", async () => {
    const api = { get: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0 }) };
    render(<TraderConfigurationWorkspace api={api as unknown as ApiClient} onNavigate={vi.fn()} />);
    await screen.findByText("No Traders match the selected filters.");
    fireEvent.click(screen.getByRole("button", { name: "Create Trader" }));
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.queryByLabelText("Trader code")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("English Name")).not.toBeInTheDocument();
  });
});
