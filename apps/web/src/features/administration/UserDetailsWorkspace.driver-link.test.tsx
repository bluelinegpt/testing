import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { UserDetailsWorkspace } from "./UserRoleConfigurationWorkspace.js";

/**
 * User Details surfaces the Driver identity an account actually operates as
 * (`driverCode`, derived server-side from either the account's own linked
 * Driver or its linked Employee's backing Driver record) -- read-only,
 * administration-facing evidence of the User <-> Employee/Driver chain. This
 * does not change how any Driver-scoped API resolves a caller's identity.
 */

function userFixture(driverCode: string | null) {
  return {
    accountId: "user-1",
    accountKind: "company_user" as const,
    audit: [],
    createdAt: "2026-01-01T00:00:00Z",
    displayName: "Ahmed",
    driverCode,
    driverId: driverCode === null ? null : "driver-1",
    effectivePermissions: [],
    email: "ahmed@example.test",
    employeeCode: "EMP-001",
    employeeId: "emp-1",
    employeeJobTitle: "Delivery Driver",
    employeeName: "Ahmed",
    employeeStatus: "active",
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
    roleIds: [],
    roleNames: [],
    roles: [],
    sessions: [],
    status: "active",
    temporaryPasswordExpiresAt: null,
    updatedAt: "2026-01-01T00:00:00Z",
    username: "ahmed",
  };
}

function buildApi(driverCode: string | null) {
  const get = vi.fn((path: string) =>
    path === "users/user-1"
      ? Promise.resolve(userFixture(driverCode))
      : Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 }),
  );
  return { get } as unknown as ApiClient;
}

describe("User Details — linked Driver identity", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("shows the Driver code when the linked Employee has a backing Driver record", async () => {
    render(
      <UserDetailsWorkspace
        api={buildApi("DRV-000123")}
        accountId="user-1"
        onBack={() => undefined}
        onNavigate={() => undefined}
      />,
    );
    expect(await screen.findByText("DRV-000123")).toBeInTheDocument();
  });

  it("shows no-linked-Driver text when there is none", async () => {
    render(
      <UserDetailsWorkspace
        api={buildApi(null)}
        accountId="user-1"
        onBack={() => undefined}
        onNavigate={() => undefined}
      />,
    );
    expect(await screen.findByText("No linked Driver identity")).toBeInTheDocument();
  });
});
