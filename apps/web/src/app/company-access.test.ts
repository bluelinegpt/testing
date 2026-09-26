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

  /* -----------------------------------------------------------------------
     Storefront routes.

     Both paths were absent from the access table, and an unlisted path is
     denied outright, so every Storefront screen answered "Access denied" even
     though it was wired into the workspace and the navigation. Nothing in the
     screens themselves was wrong, which is exactly why it survived review.
     ----------------------------------------------------------------------- */

  it("authorizes the Storefront configuration route", () => {
    expect(canAccessCompanyPath("/configuration/storefront", ["storefront.view"])).toBe(true);
    expect(canAccessCompanyPath("/configuration/storefront", ["storefront.manage"])).toBe(true);
    // The Company administrator reaches it without a storefront.* permission.
    expect(canAccessCompanyPath("/configuration/storefront", ["users_roles.manage"])).toBe(true);
    // And an unrelated permission still does not.
    expect(canAccessCompanyPath("/configuration/storefront", ["orders.create"])).toBe(false);
    expect(canAccessCompanyPath("/configuration/storefront", [])).toBe(false);
  });

  it("authorizes the Product catalogue route, including its Storefront id segment", () => {
    const storefrontId = "10000000-0000-4000-8000-000000000009";
    for (const permissions of [
      ["storefront_products.view"],
      ["storefront_products.manage"],
      ["users_roles.manage"],
    ]) {
      expect(canAccessCompanyPath("/configuration/storefront-products", permissions)).toBe(true);
      // The catalogue is always opened for one Storefront, so the parameterised
      // form has to resolve to the same rule as the bare path.
      expect(
        canAccessCompanyPath(`/configuration/storefront-products/${storefrontId}`, permissions),
      ).toBe(true);
    }
    expect(
      canAccessCompanyPath(`/configuration/storefront-products/${storefrontId}`, ["orders.create"]),
    ).toBe(false);
    // Storefront profile permission does not imply catalogue permission.
    expect(
      canAccessCompanyPath(`/configuration/storefront-products/${storefrontId}`, [
        "storefront.view",
      ]),
    ).toBe(false);
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
