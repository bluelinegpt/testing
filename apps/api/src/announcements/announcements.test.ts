import { describe, expect, it } from "vitest";

import {
  type AnnouncementInput,
  announcementDisplayStatus,
  surfaceAllowedFor,
  validateAnnouncement,
} from "./announcements.js";

const base: AnnouncementInput = {
  audience: "all_companies",
  bodyAr: "سنقوم بترقية البنية التحتية يوم 14 أكتوبر من 5:00 إلى 6:00 صباحاً.",
  bodyEn: "We will be upgrading critical infrastructure on 14 October, 05:00-06:00 (UAE).",
  showFrom: "2026-10-12T00:00:00.000Z",
  showUntil: "2026-10-14T02:00:00.000Z",
  surfaces: ["office_web", "trader_portal"],
  titleAr: "صيانة مجدولة",
  titleEn: "Upcoming maintenance",
  type: "warning",
};

const errorsOf = (input: Partial<AnnouncementInput>) => {
  const result = validateAnnouncement({ ...base, ...input });
  return result.ok ? [] : result.errors;
};

describe("validateAnnouncement", () => {
  it("accepts a complete bilingual announcement and trims it", () => {
    const result = validateAnnouncement({ ...base, titleEn: "  Upcoming maintenance  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.titleEn).toBe("Upcoming maintenance");
    expect(result.value.companyIds).toEqual([]);
    expect(result.value.showFrom.toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("accepts one language on its own", () => {
    expect(errorsOf({ bodyAr: "", titleAr: "" })).toEqual([]);
    expect(errorsOf({ bodyEn: null, titleEn: null })).toEqual([]);
  });

  it("needs a title and a body together, and at least one language", () => {
    expect(errorsOf({ bodyEn: "" })).toEqual(["english_incomplete"]);
    expect(errorsOf({ titleAr: "" })).toEqual(["arabic_incomplete"]);
    expect(errorsOf({ bodyAr: "", bodyEn: "", titleAr: "", titleEn: "" })).toEqual([
      "language_required",
    ]);
  });

  it("keeps titles and bodies short enough for a banner", () => {
    expect(errorsOf({ titleEn: "x".repeat(121) })).toEqual(["title_too_long"]);
    expect(errorsOf({ bodyAr: "x".repeat(601) })).toEqual(["body_too_long"]);
  });

  it("needs real instants with an offset, in order", () => {
    expect(errorsOf({ showFrom: "2026-10-12T00:00:00" })).toEqual(["dates_invalid"]);
    expect(errorsOf({ showFrom: "not a date" })).toEqual(["dates_invalid"]);
    expect(errorsOf({ showUntil: base.showFrom })).toEqual(["dates_out_of_order"]);
    expect(errorsOf({ showFrom: "2026-10-12T04:00:00+04:00" })).toEqual([]);
  });

  it("needs at least one known surface", () => {
    expect(errorsOf({ surfaces: [] })).toEqual(["surfaces_required"]);
    expect(errorsOf({ surfaces: ["office_web", "billboard"] })).toEqual(["surface_invalid"]);
  });

  it("needs a target list for selected Companies, and drops it for all Companies", () => {
    expect(errorsOf({ audience: "selected_companies" })).toEqual(["companies_required"]);
    expect(errorsOf({ audience: "selected_companies", companyIds: ["nope"] })).toEqual([
      "company_invalid",
    ]);
    const id = "4D9095CB-3DA6-4B8B-9D8E-FF01F8192BDB";
    const selected = validateAnnouncement({
      ...base,
      audience: "selected_companies",
      companyIds: [id, id],
    });
    expect(selected.ok && selected.value.companyIds).toEqual([id.toLowerCase()]);
    const all = validateAnnouncement({ ...base, companyIds: [id] });
    expect(all.ok && all.value.companyIds).toEqual([]);
  });

  it("refuses an unknown type or audience", () => {
    expect(errorsOf({ type: "urgent" })).toEqual(["type_invalid"]);
    expect(errorsOf({ audience: "everyone" })).toEqual(["audience_invalid"]);
  });
});

describe("announcementDisplayStatus", () => {
  const window = {
    showFrom: new Date("2026-10-12T00:00:00Z"),
    showUntil: new Date("2026-10-14T02:00:00Z"),
    status: "active",
  };

  it("is scheduled, live, then ended", () => {
    expect(announcementDisplayStatus(window, new Date("2026-10-11T23:59:59Z"))).toBe("scheduled");
    expect(announcementDisplayStatus(window, new Date("2026-10-12T00:00:00Z"))).toBe("live");
    expect(announcementDisplayStatus(window, new Date("2026-10-14T02:00:00Z"))).toBe("ended");
  });

  it("is cancelled whatever the dates", () => {
    expect(
      announcementDisplayStatus({ ...window, status: "cancelled" }, new Date("2026-10-13T00:00:00Z")),
    ).toBe("cancelled");
  });
});

describe("surfaceAllowedFor", () => {
  it("lets each account type read only its own screens", () => {
    expect(surfaceAllowedFor("company_user", "office_web")).toBe(true);
    expect(surfaceAllowedFor("company_user", "trader_portal")).toBe(false);
    expect(surfaceAllowedFor("trader", "trader_portal")).toBe(true);
    expect(surfaceAllowedFor("trader", "office_web")).toBe(false);
    expect(surfaceAllowedFor("driver", "mobile_app")).toBe(true);
    expect(surfaceAllowedFor("driver", "office_web")).toBe(false);
    expect(surfaceAllowedFor("customer", "office_web")).toBe(false);
    expect(surfaceAllowedFor("platform_administrator", "office_web")).toBe(false);
  });
});
