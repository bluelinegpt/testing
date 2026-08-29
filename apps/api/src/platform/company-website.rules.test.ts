import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertCompanyWebsiteExpectedVersion,
  isCompanyWebsiteTransitionAllowed,
  isValidCompanyWebsiteSlug,
} from "./company-website.service.js";
import {
  COMPANY_WEBSITE_TEMPLATE_KEYS,
  hasUnpublishedTemplateChanges,
  isCompanyWebsiteTemplateKey,
  templateForWebsiteAudience,
} from "./company-website-templates.js";

describe("Company website foundation rules", () => {
  it("registers twenty stable templates and rejects unknown keys", () => {
    expect(COMPANY_WEBSITE_TEMPLATE_KEYS).toEqual([
      "corporate",
      "modern",
      "express",
      "local",
      "premium",
      "skyline",
      "minimal",
      "bold",
      "elegant",
      "urban",
      "swift",
      "horizon",
      "nexus",
      "oasis",
      "fleet",
      "commerce",
      "courier",
      "executive",
      "vibrant",
      "classic",
    ]);
    expect(isCompanyWebsiteTemplateKey("premium")).toBe(true);
    expect(isCompanyWebsiteTemplateKey("default")).toBe(false);
  });
  it("accepts the loaded version and rejects a stale version with a safe 409", () => {
    expect(() => assertCompanyWebsiteExpectedVersion(1, 1)).not.toThrow();
    expect(() => assertCompanyWebsiteExpectedVersion(undefined, 0)).not.toThrow();
    let conflict: unknown;
    try {
      assertCompanyWebsiteExpectedVersion(2, 1);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ errorCode: "website_version_conflict", status: 409 });
  });
  it("keeps the published template live while a different draft is previewed or selected", () => {
    expect(hasUnpublishedTemplateChanges("modern", "corporate")).toBe(true);
    expect(templateForWebsiteAudience({ draft: "modern", published: "corporate" })).toBe(
      "corporate",
    );
    expect(
      templateForWebsiteAudience({
        draft: "modern",
        published: "corporate",
        previewTemplate: "premium",
      }),
    ).toBe("premium");
    expect(hasUnpublishedTemplateChanges("modern", "modern")).toBe(false);
  });
  it.each(["dana", "aiman", "fast-line", "company7"])("accepts valid website slug %s", (slug) =>
    expect(isValidCompanyWebsiteSlug(slug)).toBe(true),
  );
  it.each(["Dana", "-dana", "dana-", "dana site", "www", "api", "platform", "help", "store"])(
    "rejects invalid or reserved website slug %s",
    (slug) => expect(isValidCompanyWebsiteSlug(slug)).toBe(false),
  );
  it("allows only the reviewed lifecycle", () => {
    expect(isCompanyWebsiteTransitionAllowed("draft", "publish")).toBe(true);
    expect(isCompanyWebsiteTransitionAllowed("published", "publish")).toBe(true);
    expect(isCompanyWebsiteTransitionAllowed("published", "disable")).toBe(true);
    expect(isCompanyWebsiteTransitionAllowed("disabled", "enable")).toBe(true);
    expect(isCompanyWebsiteTransitionAllowed("draft", "disable")).toBe(false);
    expect(isCompanyWebsiteTransitionAllowed("published", "enable")).toBe(false);
    expect(isCompanyWebsiteTransitionAllowed("disabled", "publish")).toBe(false);
  });
  it("enforces uniqueness and app-host collision protection in the migration", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "../../database/migrations/20260938000000_company_website_foundation.ts",
      ),
      "utf8",
    );
    expect(migration).toContain("company_websites_slug_unique");
    expect(migration).toContain("lower(slug)");
    expect(migration).toContain("company_website_slug_collides_with_application");
    expect(migration).toContain("validate_company_app_slug_collision");
    expect(migration).toContain("published_template_key");
    expect(migration).toContain("draft_settings jsonb");
    expect(migration).toContain("published_settings jsonb");
    expect(migration).not.toContain("company_name");
    const service = readFileSync(
      resolve(process.cwd(), "src/platform/company-website.service.ts"),
      "utf8",
    );
    expect(service).toContain("company_id=${companyId}::uuid and version=${input.expectedVersion}");
    expect(service).toContain("company_id=${companyId}::uuid and version=${expectedVersion}");
    expect(service).toContain(
      'published_template_key=${target === "published" ? sql`template_key`',
    );
    expect(service).toContain('published_settings=${target === "published" ? sql`draft_settings`');
  });
  it("keeps public functions hostname-scoped and stores requests in the Company workflow", () => {
    const service = readFileSync(
      resolve(process.cwd(), "src/platform/company-website.service.ts"),
      "utf8",
    );
    const controller = readFileSync(
      resolve(process.cwd(), "src/platform/company-website.controller.ts"),
      "utf8",
    );
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "../../database/migrations/20260939000000_company_website_public_functions.ts",
      ),
      "utf8",
    );
    expect(service).toContain("requirePublishedHost(host)");
    expect(service).toContain("tt.company_id=${row.companyId}::uuid");
    expect(service).toContain(
      "o.company_id=${row.companyId}::uuid and upper(o.order_number)=upper(${normalizedReference})",
    );
    expect(service).not.toContain("o.customer_mobile_number as");
    expect(service).not.toContain("customerName:");
    expect(service).not.toContain("assignedDriverName");
    expect(service).toContain('sourceChannel: "company_public_website"');
    expect(controller).toContain("@Throttle({ default: { limit: 15");
    expect(controller).toContain("@Throttle({ default: { limit: 6");
    expect(migration).toContain("company_website_delivery_requests_idempotency");
    expect(migration).toContain("company_id uuid not null");
  });
});
