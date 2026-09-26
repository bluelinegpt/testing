import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

import { ApiError } from "../../api/api-client.js";
import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { UserDetailsWorkspace } from "./UserRoleConfigurationWorkspace.js";

/**
 * Removing an assigned Role from a User.
 *
 * There is no dedicated remove-role endpoint: `RoleAssignment` (the existing
 * "Assign Roles" checklist) already adds/removes Roles by PUTting the full
 * desired `roleIds` set to `users/:accountId/roles`, which is what the
 * backend's `assignRoles` service already enforces (Company scope,
 * `users_roles.manage`, last-active-Company-Administrator, self-lockout,
 * transactional, audited) for. This suite covers the NEW one-Role-at-a-time
 * UI built on that same endpoint, not a second role-management system.
 */

const ordersRole = { id: "role-orders", code: "orders", isActive: true, name: "Orders" };
const accountingRole = {
  id: "role-accounting",
  code: "accounting_admin",
  isActive: true,
  name: "AccountingAdmin",
};
const adminRole = {
  id: "role-admin",
  code: "company_admin",
  isActive: true,
  name: "Company Administrator",
};

function userFixture(
  roles: readonly { id: string; code: string; isActive: boolean; name: string }[],
) {
  return {
    accountId: "user-123",
    accountKind: "company_user" as const,
    audit: [],
    createdAt: "2026-01-01T00:00:00Z",
    displayName: "123",
    effectivePermissions: [],
    email: "user123@example.test",
    employeeCode: null,
    employeeId: null,
    employeeJobTitle: null,
    employeeName: null,
    employeeStatus: null,
    failedLoginAttempts: 0,
    forcePasswordChange: false,
    lastFailedLoginAt: null,
    lastLoginAt: null,
    linkedProfiles: [],
    lockedUntil: null,
    lockReason: null,
    mobileNumber: null,
    nameAr: null,
    nameEn: null,
    passwordChangedAt: null,
    preferredLanguage: "en" as const,
    roleIds: roles.map((r) => r.id),
    roleNames: roles.map((r) => r.name),
    roles,
    sessions: [],
    status: "active",
    temporaryPasswordExpiresAt: null,
    updatedAt: "2026-01-01T00:00:00Z",
    username: "user123",
  };
}

function buildApi(initialRoles: readonly (typeof ordersRole)[]) {
  let current = initialRoles;
  const put = vi.fn((path: string, body: { roleIds: readonly string[] }) => {
    if (path === "users/user-123/roles") {
      current = [ordersRole, accountingRole, adminRole].filter((role) =>
        body.roleIds.includes(role.id),
      );
      return Promise.resolve(undefined);
    }
    return Promise.resolve(undefined);
  });
  const get = vi.fn((path: string) => {
    if (path === "users/user-123") return Promise.resolve(userFixture(current));
    if (path.startsWith("roles?"))
      return Promise.resolve({
        items: [ordersRole, accountingRole, adminRole].map((role) => ({
          ...role,
          assignedUserCount: 1,
          description: "",
          isSystem: false,
          permissionCount: 0,
          permissions: [],
          scope: "company" as const,
        })),
        page: 1,
        pageSize: 100,
        total: 3,
      });
    return Promise.resolve({});
  });
  return { api: { get, put } as unknown as ApiClient, get, put };
}

const renderWorkspace = (api: ApiClient) =>
  render(
    <UserDetailsWorkspace api={api} accountId="user-123" onBack={vi.fn()} onNavigate={vi.fn()} />,
  );

const openAccessTab = async () => {
  fireEvent.click(await screen.findByRole("tab", { name: "Roles and Permissions" }));
};

describe("Removing an assigned Role", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("shows a Remove control on every assigned role", async () => {
    const { api } = buildApi([ordersRole, accountingRole, adminRole]);
    renderWorkspace(api);
    await openAccessTab();

    expect(screen.getAllByTitle("Remove")).toHaveLength(3);
  });

  it("asks for confirmation before removing, naming the role and the user", async () => {
    const { api } = buildApi([ordersRole, accountingRole, adminRole]);
    renderWorkspace(api);
    await openAccessTab();

    fireEvent.click(within(screen.getByText("Orders").closest("span")!).getByTitle("Remove"));

    expect(await screen.findByText('Remove role "Orders" from user "123"?')).toBeInTheDocument();
    expect(
      screen.getByText("This will immediately remove the permissions granted only by this role."),
    ).toBeInTheDocument();
  });

  it("removes the role and refreshes the list without a full reload, keeping other roles", async () => {
    const { api, put } = buildApi([ordersRole, accountingRole, adminRole]);
    renderWorkspace(api);
    await openAccessTab();

    fireEvent.click(within(screen.getByText("Orders").closest("span")!).getByTitle("Remove"));
    await screen.findByText('Remove role "Orders" from user "123"?');
    fireEvent.click(screen.getByRole("button", { name: "Remove Role" }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("users/user-123/roles", {
        roleIds: [accountingRole.id, adminRole.id],
      }),
    );
    await waitFor(() => expect(screen.queryByText("Orders")).toBeNull());
    expect(screen.getByText("AccountingAdmin")).toBeInTheDocument();
    expect(screen.getByText("Company Administrator")).toBeInTheDocument();
  });

  it("Cancel closes the dialog without calling the API", async () => {
    const { api, put } = buildApi([ordersRole, accountingRole, adminRole]);
    renderWorkspace(api);
    await openAccessTab();

    fireEvent.click(within(screen.getByText("Orders").closest("span")!).getByTitle("Remove"));
    await screen.findByText('Remove role "Orders" from user "123"?');
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText('Remove role "Orders" from user "123"?')).toBeNull();
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText("Orders")).toBeInTheDocument();
  });

  it("shows the backend's block message and keeps the role assigned when removal is rejected", async () => {
    // Two roles so the client-side "only remaining active role" guard does not
    // itself disable Remove -- this specifically exercises the BACKEND's
    // last-active-Company-Administrator rule, a company-wide check
    // independent of how many roles this one User happens to hold.
    const { api, put } = buildApi([adminRole, ordersRole]);
    (put as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(
        "The last active Company administrator cannot lose access",
        "last_company_administrator",
        409,
      ),
    );
    renderWorkspace(api);
    await openAccessTab();

    fireEvent.click(
      within(screen.getByText("Company Administrator").closest("span")!).getByTitle("Remove"),
    );
    await screen.findByText('Remove role "Company Administrator" from user "123"?');
    fireEvent.click(screen.getByRole("button", { name: "Remove Role" }));

    expect(
      await screen.findByText("The last active Company administrator cannot lose access"),
    ).toBeInTheDocument();
    // Still assigned: the dialog stayed open and no reload happened.
    expect(screen.getByText("Company Administrator")).toBeInTheDocument();
  });

  it("disables Remove on an active user's only remaining role, matching Assign Roles' own guard", async () => {
    const { api } = buildApi([ordersRole]);
    renderWorkspace(api);
    await openAccessTab();

    expect(within(screen.getByText("Orders").closest("span")!).getByTitle("Remove")).toBeDisabled();
  });

  it("renders the confirmation in Arabic", async () => {
    await i18nInstance.changeLanguage("ar");
    const { api } = buildApi([ordersRole, accountingRole, adminRole]);
    renderWorkspace(api);
    fireEvent.click(await screen.findByRole("tab", { name: "الأدوار والصلاحيات" }));

    fireEvent.click(within(screen.getByText("Orders").closest("span")!).getByTitle("إزالة"));

    expect(
      await screen.findByText('هل تريد إزالة الدور "Orders" من المستخدم "123"؟'),
    ).toBeInTheDocument();
    await i18nInstance.changeLanguage("en");
  });

  it("existing Assign Roles flow still works unaffected", async () => {
    const { api, put } = buildApi([ordersRole]);
    renderWorkspace(api);
    await openAccessTab();

    fireEvent.click(screen.getByRole("button", { name: "Assign roles" }));
    await screen.findByText("Select Roles");
    fireEvent.click(screen.getByLabelText(/AccountingAdmin/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("users/user-123/roles", {
        roleIds: [ordersRole.id, accountingRole.id],
      }),
    );
  });
});
