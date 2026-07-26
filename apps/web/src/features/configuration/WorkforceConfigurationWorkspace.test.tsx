import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { WorkforceConfigurationWorkspace } from "./WorkforceConfigurationWorkspace.js";

describe("WorkforceConfigurationWorkspace", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("loads Employees through server pagination and opens the single-Name create form", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [
          {
            basicSalary: "5000.00",
            code: "EMP-1",
            commissionEnabled: false,
            documentStatus: "expired",
            employeeType: "staff",
            id: "10000000-0000-4000-8000-000000000001",
            jobTitle: "Cashier",
            mobileNumber: "971501234567",
            name: "Aisha عائشة",
            status: "active",
          },
        ],
        page: 1,
        pageSize: 25,
        total: 1,
      }),
      post: vi.fn(),
      patch: vi.fn(),
    };
    render(
      <WorkforceConfigurationWorkspace
        api={api as unknown as ApiClient}
        kind="employees"
        onNavigate={vi.fn()}
      />,
    );
    await screen.findByText("EMP-1");
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining("configuration/employees?"));
    expect(screen.getAllByText("Expired")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Create employee" }));
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.queryByLabelText("English Name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Arabic Name")).not.toBeInTheDocument();
  });

  it("requests filtered Drivers from the server", async () => {
    const api = { get: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0 }) };
    render(
      <WorkforceConfigurationWorkspace
        api={api as unknown as ApiClient}
        kind="drivers"
        onNavigate={vi.fn()}
      />,
    );
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Driver type"), { target: { value: "outsourced" } });
    await waitFor(() =>
      expect(api.get).toHaveBeenLastCalledWith(expect.stringContaining("driverType=outsourced")),
    );
  });
});
