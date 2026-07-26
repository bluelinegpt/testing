import { describe, expect, it } from "vitest";

import { canAccessCompanyPath, firstAuthorizedCompanyPath } from "./company-access.js";

describe("Company permission routing", () => {
  it("sends an administrator to Dashboard", () => {
    expect(firstAuthorizedCompanyPath(["users_roles.manage"])).toBe("/dashboard");
  });

  it("sends an orders.create-only User to Create Order", () => {
    const permissions = ["orders.create"];
    expect(firstAuthorizedCompanyPath(permissions)).toBe("/orders/create");
    expect(canAccessCompanyPath("/orders/create", permissions)).toBe(true);
    expect(canAccessCompanyPath("/orders", permissions)).toBe(false);
    expect(canAccessCompanyPath("/configuration/users", permissions)).toBe(false);
  });

  it("uses the controlled no-access page when no workspace is authorized", () => {
    expect(firstAuthorizedCompanyPath([])).toBe("/no-access");
    expect(canAccessCompanyPath("/no-access", [])).toBe(true);
  });

  it("protects User and Role detail routes with the administration permission", () => {
    expect(
      canAccessCompanyPath("/configuration/users/10000000-0000-4000-8000-000000000001", [
        "orders.create",
      ]),
    ).toBe(false);
    expect(
      canAccessCompanyPath("/configuration/roles/10000000-0000-4000-8000-000000000001", [
        "users_roles.manage",
      ]),
    ).toBe(true);
  });
});
