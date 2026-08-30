import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_COMPANY_WEBSITE_SETTINGS } from "./company-website-settings.js";

describe("public Company homepage tracking security", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/platform/company-website.service.ts"),
    "utf8",
  );
  const tracking = source.slice(
    source.indexOf("public async trackPublic"),
    source.indexOf("public async publicSitemap"),
  );
  it("is enabled by default for newly configured websites", () =>
    expect(EMPTY_COMPANY_WEBSITE_SETTINGS.functions.trackingEnabled).toBe(true));
  it("requires the hostname-resolved Company and opaque token hash", () => {
    expect(tracking).toContain("requirePublishedHost(host)");
    expect(tracking).toContain("tt.company_id=${row.companyId}::uuid");
    expect(tracking).toContain("tt.token_hash=${tokenHash}");
    expect(tracking).not.toMatch(/companyId:\s*input|order_number\s*=\s*\$\{/u);
  });
  it("returns only the approved DTO and excludes all identity/operational fields", () => {
    expect(tracking).toContain("reference: resolvedTracking.orderNumber");
    expect(tracking).toContain("timeline,");
    expect(tracking).not.toMatch(
      /customerName|customerMobile|customerEmail|customerAddress|deliveryAddress|driverName|driverMobile|settlement|accounting|codReconciliation|payroll/iu,
    );
  });
  it("publishes only approved delivery history states", () => {
    expect(tracking).toContain("status_dimension='delivery'");
    expect(tracking).toContain(
      "to_status in ('new','preparing','assigned','out_for_delivery','delivered','returned','cancelled')",
    );
    expect(tracking).not.toContain("reason:");
  });
});
