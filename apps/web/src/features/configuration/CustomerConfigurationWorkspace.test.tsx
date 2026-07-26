import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { CustomerConfigurationWorkspace } from "./CustomerConfigurationWorkspace.js";

describe("CustomerConfigurationWorkspace", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("uses server paging and filters, and opens Customer details", async () => {
    const navigate = vi.fn();
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [
          {
            area: "Dubai",
            code: "CUS-000001",
            id: "40000000-0000-4000-8000-000000000001",
            lastOrderDate: null,
            mobileNumber: "971501234567",
            name: "Aisha",
            orderCount: 0,
            primaryAddress: "Building 4",
            status: "active",
          },
        ],
        page: 1,
        pageSize: 25,
        total: 1,
      }),
    };
    render(
      <CustomerConfigurationWorkspace api={api as unknown as ApiClient} onNavigate={navigate} />,
    );
    await screen.findByText("CUS-000001");
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "971501" } });
    await waitFor(() =>
      expect(api.get).toHaveBeenLastCalledWith(
        expect.stringContaining("search=971501"),
        expect.any(AbortSignal),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(navigate).toHaveBeenCalledWith("/configuration/customers/CUS-000001");
  });

  it("generates code on the backend and requires a reason before disabling", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [
          {
            area: "Dubai",
            code: "CUS-000001",
            id: "40000000-0000-4000-8000-000000000001",
            lastOrderDate: null,
            mobileNumber: "971501234567",
            name: "Aisha",
            orderCount: 0,
            primaryAddress: "Building 4",
            status: "active",
          },
        ],
        page: 1,
        pageSize: 25,
        total: 1,
      }),
    };
    render(
      <CustomerConfigurationWorkspace api={api as unknown as ApiClient} onNavigate={vi.fn()} />,
    );
    await screen.findByText("CUS-000001");
    fireEvent.click(screen.getByRole("button", { name: "Create Customer" }));
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.queryByLabelText("Customer code")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Disable" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Duplicate profile" } });
    expect(dialog.getByRole("button", { name: "Disable" })).toBeEnabled();
  });
});
