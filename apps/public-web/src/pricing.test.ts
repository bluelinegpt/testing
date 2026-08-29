import { describe, expect, it } from "vitest";
import * as pricingModule from "./pricing";
import {
  pricingGapNote,
  pricingPlans,
  pricingProductAreas,
  pricingWebsiteAddOnNote,
} from "./pricing";

describe("pricing plan data", () => {
  it("keeps the approved plan values unchanged (price, period, order volume)", () => {
    expect(pricingPlans.map((plan) => [plan.name, plan.price, plan.volume])).toEqual([
      ["Free", "AED 0", "Up to 100 orders / month"],
      ["Starter", "AED 500", "100–2,000 orders / month"],
      ["Growth", "AED 1000", "2,001–5,000 orders / month"],
      ["Business", "AED 2000", "5,001–10,000 orders / month"],
    ]);
    expect(pricingGapNote).toContain("10,000");
  });

  it("Free plan includes exactly the approved core capabilities, plus Arabic/English", () => {
    const free = pricingPlans.find((plan) => plan.name === "Free")!;
    expect(free.highlights).toEqual([
      "Core Orders & Driver Management",
      "COD & Collection Visibility",
      "Basic Reports",
      "Mobile App Access",
      "Arabic / English",
    ]);
  });

  it("every plan mentions Arabic / English support", () => {
    for (const plan of pricingPlans) expect(plan.highlights).toContain("Arabic / English");
  });

  it("Free plan does not list Trader Portal or Company Website as included", () => {
    const free = pricingPlans.find((plan) => plan.name === "Free")!;
    for (const item of free.highlights) {
      expect(item).not.toMatch(/Trader Portal/i);
      expect(item).not.toMatch(/Company Website/i);
    }
  });

  it("Free plan copy makes no claim (included or excluded) beyond the two approved rules", () => {
    // Only Trader Portal and Company Website are approved Free exclusions.
    // Nothing else — Driver Reconciliation, Trader Management, Trader
    // Settlements, Accounting, Payroll, WhatsApp, Commerce Integrations —
    // is confirmed either way, so the Free plan's own copy (highlights + its
    // supporting note) must not mention any of it.
    const free = pricingPlans.find((plan) => plan.name === "Free")!;
    const freeText = [...free.highlights, free.note].join(" ");
    const unconfirmedForFree = [
      "Driver Reconciliation",
      "Trader Management",
      "Trader Settlements",
      "Accounting",
      "Payroll",
      "WhatsApp",
      "Commerce Integrations",
    ];
    for (const capability of unconfirmedForFree)
      expect(freeText).not.toMatch(new RegExp(capability, "i"));
  });

  it("Free CTA is truthful (routes to the real request flow, not a self-service claim)", () => {
    const free = pricingPlans.find((plan) => plan.name === "Free")!;
    expect(free.href).toBe("/request-demo");
    expect(free.cta.toLowerCase()).not.toContain("no credit card");
    expect(free.cta.toLowerCase()).not.toContain("instant");
  });

  it("every plan has a matching number of EN/AR highlight bullets", () => {
    for (const plan of pricingPlans) expect(plan.highlightsAr.length).toBe(plan.highlights.length);
  });

  it("mentions AI Agent only under Growth and Business, tied to Company Website", () => {
    // Per explicit product-owner instruction, AI Agent is shown without an
    // "in development" qualifier — an accepted, deliberate choice (see the
    // comment above pricingPlans). This only guards where it appears.
    for (const plan of pricingPlans) {
      const mentionsAiAgent = plan.highlights.some((item) => /AI Agent/i.test(item));
      expect(mentionsAiAgent).toBe(["Growth", "Business"].includes(plan.name));
    }
  });

  it("does not export a per-capability Starter/Growth/Business comparison matrix", () => {
    // There is no technical plan-entitlement system in the product, so a
    // ✓/— grid across paid tiers would imply feature locks that do not
    // exist. This guards against that data structure quietly coming back.
    expect((pricingModule as Record<string, unknown>).pricingComparisonRows).toBeUndefined();
  });

  it("Starter/Growth/Business bullets never state a capability is unavailable, only additive emphasis", () => {
    for (const plan of pricingPlans.filter((item) => item.name !== "Free")) {
      for (const item of plan.highlights) {
        expect(item.toLowerCase()).not.toMatch(/not included|excluded|unavailable/);
      }
    }
  });

  it('marks every Company Website mention with a "*" from Starter onward, and exposes a matching general footnote', () => {
    for (const plan of pricingPlans.filter((item) => item.name !== "Free")) {
      const websiteBullet = plan.highlights.find((item) => /Company Website/i.test(item));
      expect(websiteBullet).toMatch(/\*$/);
      const websiteBulletAr = plan.highlightsAr.find((item) => item.includes("موقع"));
      expect(websiteBulletAr).toMatch(/\*$/);
    }
    // General on purpose -- no specific add-on price is approved yet.
    expect(pricingWebsiteAddOnNote).not.toMatch(/AED|\d/);
    expect(pricingWebsiteAddOnNote).toMatch(/^\*/);
  });
});

describe("pricing product capability areas", () => {
  it("exposes the four required product areas, in order", () => {
    expect(pricingProductAreas.map((area) => area.name)).toEqual([
      "Delivery Operating System",
      "Trader Portal",
      "Mobile App",
      "Company Website",
    ]);
  });

  it("does not expose Platform Admin anywhere in the capability areas", () => {
    const rendered = JSON.stringify(pricingProductAreas);
    expect(rendered).not.toMatch(/Platform Admin/i);
  });

  it("does not claim Mobile App offline mode or white-label", () => {
    const mobile = pricingProductAreas.find((area) => area.key === "mobile_app")!;
    const rendered = JSON.stringify(mobile.items);
    expect(rendered).not.toMatch(/offline/i);
    expect(rendered).not.toMatch(/white-label/i);
  });

  it("Company Website area includes only approved capabilities, including AI Agent", () => {
    const website = pricingProductAreas.find((area) => area.key === "company_website")!;
    expect(website.items).toContain("Company Website");
    expect(website.items).toContain("Company Logo / Branding");
    expect(website.items).toContain("WhatsApp");
    expect(website.items).toContain("AI Agent");
  });
});
