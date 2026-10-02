import { describe, expect, it } from "vitest";

import { companyAccountSetupUrl } from "./platform-company-user.service.js";

describe("Company account setup URL", () => {
  it("uses the tenant-specific local Company Portal host and port", () => {
    expect(
      companyAccountSetupUrl({
        subdomain: "lahza",
        tenantHostSuffix: "localhost",
        token: "token with reserved?characters",
      }),
    ).toBe(
      "http://lahzaapp.localhost:5177/account-setup?token=token%20with%20reserved%3Fcharacters",
    );
  });

  it("uses the tenant Company Portal hostname in production", () => {
    expect(
      companyAccountSetupUrl({
        subdomain: "lahza",
        tenantHostSuffix: "tawseelhub.com",
        token: "safe-token",
      }),
    ).toBe("https://lahzaapp.tawseelhub.com/account-setup?token=safe-token");
  });
});
