import {
  managementStorefrontView,
  publicStorefrontView,
  type StorefrontRow,
} from "./storefront.service.js";

/**
 * What may leave the API, and to whom.
 *
 * The public projection is the boundary between a Trader's private
 * configuration and the open web, so it is asserted as an allow-list: the test
 * enumerates the permitted keys and fails when an unexpected one appears. That
 * is deliberately stricter than checking a handful of forbidden fields — a
 * column added to the table later must break this test rather than quietly
 * reach the public.
 */

const row: StorefrontRow = {
  brandAccentColor: "#b08d57",
  brandPrimaryColor: "#1f2937",
  businessHours: [{ days: "Sat – Thu", time: "10:00 – 22:00" }],
  businessTemplate: "fashion",
  companyId: "company-1",
  coverFileId: "cover-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  customerSupport: "support@example.test",
  deliveryInformation: "Next-day delivery across the UAE",
  displayName: "Al Noor Fashion",
  id: "storefront-1",
  logoFileId: "logo-1",
  publicEmail: "hello@example.test",
  publicMobile: "+971 50 000 0000",
  publicWhatsapp: "+971 50 000 0000",
  publishedAt: new Date("2026-01-02T00:00:00.000Z"),
  returnPolicy: "Returns accepted within 7 days",
  // SEO overrides left unset on purpose: the default fixture is a Store whose
  // Trader never opened the SEO section, which is the case the fallback rules
  // exist for.
  seoDescriptionAr: null,
  seoDescriptionEn: null,
  seoIndexable: true,
  seoSocialFileId: null,
  seoTitleAr: null,
  seoTitleEn: null,
  slug: "al-noor-fashion",
  status: "published",
  storeDescription: "Contemporary modest fashion",
  suspendedAt: null,
  suspensionReason: null,
  terms: "Terms apply",
  theme: "luxury_minimal",
  traderCommerceId: "commerce-1",
  traderId: "trader-1",
  updatedAt: new Date("2026-01-03T00:00:00.000Z"),
  version: "4",
};

describe("publicStorefrontView", () => {
  it("returns exactly the allow-listed public fields", () => {
    expect(Object.keys(publicStorefrontView(row)).sort()).toEqual([
      "brandAccentColor",
      "brandPrimaryColor",
      "businessHours",
      "businessTemplate",
      "coverUrl",
      "customerSupport",
      "deliveryInformation",
      "displayName",
      "logoUrl",
      "publicEmail",
      "publicMobile",
      "publicWhatsapp",
      "returnPolicy",
      "seoDescriptionAr",
      "seoDescriptionEn",
      "seoIndexable",
      "seoTitleAr",
      "seoTitleEn",
      "slug",
      "socialImageUrl",
      "status",
      "storeDescription",
      "terms",
      "theme",
    ]);
  });

  it("never exposes Company, Trader or actor identifiers", () => {
    const view = publicStorefrontView(row) as Record<string, unknown>;
    for (const forbidden of [
      "companyId",
      "traderId",
      // The Commerce identity is the real owner, which makes leaking it worse
      // than leaking the Company it replaced.
      "traderCommerceId",
      "id",
      "version",
      "createdAt",
      "updatedAt",
      "publishedAt",
      "suspendedAt",
      "suspensionReason",
    ]) {
      expect(view[forbidden]).toBeUndefined();
    }
  });

  it("reports a temporarily closed shop as closed", () => {
    expect(publicStorefrontView({ ...row, status: "temporarily_closed" }).status).toBe(
      "temporarily_closed",
    );
  });

  it("never leaks internal status vocabulary", () => {
    // A public caller may only ever see the two open states. Reaching this
    // function with anything else would already be a routing bug, but the
    // projection must not describe a shop as draft or suspended regardless.
    for (const status of ["draft", "unpublished", "suspended"]) {
      expect(publicStorefrontView({ ...row, status }).status).toBe("published");
    }
  });

  it("defaults malformed business hours to an empty list", () => {
    expect(publicStorefrontView({ ...row, businessHours: null }).businessHours).toEqual([]);
  });
});

describe("managementStorefrontView", () => {
  it("carries the ownership and concurrency fields an authenticated caller needs", () => {
    const view = managementStorefrontView(row);
    expect(view.traderId).toBe("trader-1");
    expect(view.version).toBe(4);
    expect(view.id).toBe("storefront-1");
  });

  it("derives the public URL from the slug rather than storing a second copy", () => {
    expect(managementStorefrontView(row).publicUrl).toBe("/store/al-noor-fashion");
  });

  it("surfaces suspension detail to the Company", () => {
    const suspended = managementStorefrontView({
      ...row,
      status: "suspended",
      suspendedAt: new Date("2026-02-01T00:00:00.000Z"),
      suspensionReason: "Policy review",
    });
    expect(suspended.suspensionReason).toBe("Policy review");
    expect(suspended.status).toBe("suspended");
  });
});
