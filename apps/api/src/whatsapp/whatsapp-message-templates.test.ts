import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEMPLATE_BODY_AR,
  DEFAULT_TEMPLATE_BODY_EN,
  isTraderNotifiableDeliveryStatus,
  renderOrderStatusMessage,
  renderOrderStatusMessageFromTemplate,
  TEMPLATE_PLACEHOLDERS,
  TRADER_NOTIFIABLE_DELIVERY_STATUSES,
  traderStatusLabel,
} from "./whatsapp-message-templates.js";

const occurredAt = new Date("2026-08-31T18:30:00Z"); // 22:30 in Asia/Dubai

describe("Trader notification eligibility", () => {
  it.each([...TRADER_NOTIFIABLE_DELIVERY_STATUSES])("notifies for %s", (status) => {
    expect(isTraderNotifiableDeliveryStatus(status)).toBe(true);
  });

  it.each(["new", "processing", "assigned", "in_branch", "hold", "closed", "collect_order"])(
    "never notifies for the internal status %s",
    (status) => {
      expect(isTraderNotifiableDeliveryStatus(status)).toBe(false);
    },
  );

  it("never notifies for non-delivery dimension values", () => {
    for (const status of ["pending", "reconciled", "unsettled", "money_sent_to_trader", "posted"]) {
      expect(isTraderNotifiableDeliveryStatus(status)).toBe(false);
    }
  });
});

describe("status labels", () => {
  it.each([
    ["assigned_to_driver", "Assigned to driver", "معين للمندوب"],
    ["out_for_delivery", "Out for delivery", "خرج للتوصيل"],
    ["delivered", "Delivered", "تم التسليم"],
    ["returned_to_branch", "Returned to branch", "مرتجع إلى الفرع"],
    ["returned_to_trader", "Returned to trader", "مرتجع إلى التاجر"],
    ["cancelled", "Cancelled", "ملغى"],
  ])("translates %s using the UI terminology", (status, en, ar) => {
    expect(traderStatusLabel(status, "en")).toBe(en);
    expect(traderStatusLabel(status, "ar")).toBe(ar);
  });
});

describe("renderOrderStatusMessage", () => {
  const base = {
    companyName: "Dana Delivery",
    occurredAt,
    orderNumber: "DAN-000123",
    referenceNumber: "NS-45882",
    status: "out_for_delivery",
  } as const;

  it("renders the English variant with order, reference, status, time and sender", () => {
    const body = renderOrderStatusMessage({ ...base, language: "en" });
    expect(body).toContain("Order Status Update");
    expect(body).toContain("Order: DAN-000123");
    expect(body).toContain("Reference: NS-45882");
    expect(body).toContain("Status: Out for delivery");
    expect(body).toContain("Dana Delivery");
    expect(body).not.toContain("تحديث");
  });

  it("renders the Arabic variant with Arabic status wording", () => {
    const body = renderOrderStatusMessage({ ...base, language: "ar" });
    expect(body).toContain("تحديث حالة الطلب");
    expect(body).toContain("رقم الطلب: DAN-000123");
    expect(body).toContain("الحالة: خرج للتوصيل");
    expect(body).toContain("Dana Delivery");
    expect(body).not.toContain("Order Status Update");
  });

  it("renders `both` as ONE bilingual body", () => {
    const body = renderOrderStatusMessage({ ...base, language: "both" });
    expect(body).toContain("تحديث حالة الطلب | Order Status Update");
    expect(body).toContain("خرج للتوصيل | Out for delivery");
    expect(body).toContain("DAN-000123");
  });

  it("omits the reference row entirely when the Order has no reference", () => {
    for (const language of ["both", "ar", "en"] as const) {
      const body = renderOrderStatusMessage({ ...base, language, referenceNumber: null });
      expect(body).not.toContain("Reference");
      expect(body).not.toContain("الرقم المرجعي");
    }
  });

  it("renders the update time in the UAE timezone", () => {
    const body = renderOrderStatusMessage({ ...base, language: "en" });
    expect(body).toMatch(/Updated: 31 Aug 2026/);
    expect(body).toMatch(/10:30/);
  });

  it("renders every eligible status in both languages without leaking raw codes", () => {
    for (const status of TRADER_NOTIFIABLE_DELIVERY_STATUSES) {
      const body = renderOrderStatusMessage({ ...base, language: "both", status });
      expect(body).not.toContain(status);
    }
  });
});

describe("per-Company template overrides", () => {
  const input = {
    companyName: "Dana Delivery",
    language: "en" as const,
    occurredAt,
    orderNumber: "LAH0000021",
    referenceNumber: "AWB-77",
    status: "delivered",
  };
  const template = {
    bodyAr: "تم تسليم {{orderNumber}} ({{status}}) — {{companyName}}",
    bodyEn: "Delivered: {{orderNumber}} ref {{referenceNumber}} at {{date}} — {{companyName}}",
  };

  it("substitutes every placeholder per language", () => {
    const english = renderOrderStatusMessageFromTemplate(template, input);
    expect(english).toContain("Delivered: LAH0000021 ref AWB-77 at ");
    expect(english).toContain("Dana Delivery");
    expect(english).not.toContain("{{");

    const arabic = renderOrderStatusMessageFromTemplate(template, { ...input, language: "ar" });
    expect(arabic).toContain("LAH0000021");
    expect(arabic).toContain("تم التسليم"); // {{status}} localizes per body language
    expect(arabic).not.toContain("{{");
  });

  it("assembles `both` as ONE bilingual message, Arabic first", () => {
    const bilingual = renderOrderStatusMessageFromTemplate(template, {
      ...input,
      language: "both",
    });
    const arabicIndex = bilingual.indexOf("تم تسليم");
    const englishIndex = bilingual.indexOf("Delivered:");
    expect(arabicIndex).toBeGreaterThanOrEqual(0);
    expect(englishIndex).toBeGreaterThan(arabicIndex);
  });

  it("renders a missing reference as empty and leaves unknown placeholders literal", () => {
    const body = renderOrderStatusMessageFromTemplate(
      { ...template, bodyEn: "Ref [{{referenceNumber}}] {{surprise}}" },
      { ...input, referenceNumber: null },
    );
    expect(body).toContain("Ref []");
    // A typo'd placeholder stays visible instead of silently vanishing.
    expect(body).toContain("{{surprise}}");
  });

  it("the published default template bodies use only documented placeholders", () => {
    for (const body of [DEFAULT_TEMPLATE_BODY_AR, DEFAULT_TEMPLATE_BODY_EN]) {
      const used = [...body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]);
      expect(used.length).toBeGreaterThan(0);
      for (const name of used) {
        expect(TEMPLATE_PLACEHOLDERS).toContain(name);
      }
    }
  });
});
