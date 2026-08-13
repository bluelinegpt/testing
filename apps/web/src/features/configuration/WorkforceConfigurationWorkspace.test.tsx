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

  it("shows Driver Variable Earnings for an Employee Driver and reloads current rates", async () => {
    const employee = {
      basicSalary: "3000.00",
      code: "EMP-000004",
      documentStatus: "valid",
      id: "10000000-0000-4000-8000-000000000004",
      mobileNumber: "971501234567",
      name: "Ahmad",
      status: "active",
    };
    const api = {
      get: vi.fn(async (path: string) => {
        if (path === "configuration/employee-roles")
          return [{ id: "driver-role", isDriverRole: true, name: "Driver" }];
        if (path === "configuration/allowance-types") return [];
        if (path.includes("variable-earnings"))
          return {
            delivery: [
              {
                amount: "2.00",
                effectiveFrom: "2026-08-08",
                effectiveTo: null,
                id: "d1",
                isCurrent: true,
              },
            ],
            collection: [
              {
                amount: "1.00",
                effectiveFrom: "2026-08-08",
                effectiveTo: null,
                id: "c1",
                isCurrent: true,
                paymentType: "per_collected_order",
              },
            ],
          };
        if (path === "configuration/employees/EMP-000004")
          return {
            ...employee,
            employee_role_id: "driver-role",
            driver_type: "employee",
            id: employee.id,
            name_en: "Ahmad",
          };
        return { items: [employee], page: 1, pageSize: 25, total: 1 };
      }),
      patch: vi.fn(),
      post: vi.fn(),
    };
    render(
      <WorkforceConfigurationWorkspace
        api={api as unknown as ApiClient}
        kind="employees"
        onNavigate={vi.fn()}
      />,
    );
    await screen.findByText("EMP-000004");
    fireEvent.click(screen.getByLabelText("Edit"));
    expect(await screen.findByText("Driver Variable Earnings")).toBeInTheDocument();
    expect(await screen.findByDisplayValue("2.00")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1.00")).toBeInTheDocument();
    expect(screen.getByText("Eligible for Delivery Earnings")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Per Collected Order" })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Flat Per Confirmed Collection" }),
    ).not.toBeInTheDocument();
  });

  it("does not show Driver Variable Earnings for a non-Driver Employee", async () => {
    const employee = {
      basicSalary: "3000.00",
      code: "EMP-1",
      documentStatus: "valid",
      id: "10000000-0000-4000-8000-000000000001",
      mobileNumber: "971501234567",
      name: "Aisha",
      status: "active",
    };
    const api = {
      get: vi.fn(async (path: string) => {
        if (path === "configuration/employee-roles")
          return [{ id: "staff-role", isDriverRole: false, name: "Staff" }];
        if (path === "configuration/allowance-types") return [];
        if (path === "configuration/employees/EMP-1")
          return { ...employee, employee_role_id: "staff-role", name_en: "Aisha" };
        return { items: [employee], page: 1, pageSize: 25, total: 1 };
      }),
      patch: vi.fn(),
      post: vi.fn(),
    };
    render(
      <WorkforceConfigurationWorkspace
        api={api as unknown as ApiClient}
        kind="employees"
        onNavigate={vi.fn()}
      />,
    );
    await screen.findByText("EMP-1");
    fireEvent.click(screen.getByLabelText("Edit"));
    await screen.findByDisplayValue("Aisha");
    expect(screen.queryByText("Driver Variable Earnings")).not.toBeInTheDocument();
  });
});
