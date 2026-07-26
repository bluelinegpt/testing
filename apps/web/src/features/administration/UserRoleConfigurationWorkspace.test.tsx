import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import {
  RolesConfigurationWorkspace,
  UsersConfigurationWorkspace,
} from "./UserRoleConfigurationWorkspace.js";

const role = {
  id: "10000000-0000-4000-8000-000000000001",
  code: "company_administrator",
  name: "Company Administrator",
  description: "Manages the Company",
  isActive: true,
  isSystem: false,
  permissions: ["users_roles.manage"],
  permissionCount: 1,
  assignedUserCount: 1,
  scope: "company" as const,
};

describe("User and Role Configuration", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));
  it("searches the server-paginated User list and opens User Details", async () => {
    const navigate = vi.fn();
    const api = {
      get: vi.fn((path: string) =>
        Promise.resolve(
          path.startsWith("users?")
            ? {
                items: [
                  {
                    accountId: "20000000-0000-4000-8000-000000000001",
                    username: "aisha.admin",
                    displayName: "Development Administrator",
                    email: "aisha@example.test",
                    mobileNumber: "971501234567",
                    employeeCode: null,
                    employeeName: null,
                    failedLoginAttempts: 0,
                    forcePasswordChange: false,
                    lastLoginAt: null,
                    lockedUntil: null,
                    roleIds: [role.id],
                    roleNames: [role.name],
                    status: "active",
                  },
                ],
                page: 1,
                pageSize: 25,
                total: 1,
              }
            : { items: [role], page: 1, pageSize: 100, total: 1 },
        ),
      ),
    };
    render(<UsersConfigurationWorkspace api={api as unknown as ApiClient} onNavigate={navigate} />);
    await screen.findByText("aisha.admin");
    fireEvent.change(screen.getByPlaceholderText("Search username, name, email, or mobile"), {
      target: { value: "aisha" },
    });
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(expect.stringContaining("search=aisha")),
    );
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(navigate).toHaveBeenCalledWith(
      "/configuration/users/20000000-0000-4000-8000-000000000001",
    );
  });
  it("creates Roles without exposing internal codes and groups existing Permissions", async () => {
    const api = {
      get: vi.fn((path: string) =>
        Promise.resolve(
          path === "roles/permissions"
            ? [
                { code: "orders.create", description: "Create Orders" },
                { code: "users_roles.manage", description: "Manage users and roles" },
              ]
            : { items: [], page: 1, pageSize: 25, total: 0 },
        ),
      ),
      post: vi.fn().mockResolvedValue({}),
    };
    render(<RolesConfigurationWorkspace api={api as unknown as ApiClient} onNavigate={vi.fn()} />);
    await screen.findByText("No roles found");
    fireEvent.click(screen.getByRole("button", { name: "Create Role" }));
    expect(screen.getByLabelText("Role Name")).toBeInTheDocument();
    expect(screen.queryByLabelText(/code/i)).not.toBeInTheDocument();
    expect(screen.getByText("Orders")).toBeInTheDocument();
    expect(screen.getByText("Users Roles")).toBeInTheDocument();
  });
});
