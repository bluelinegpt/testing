import {
  canTransitionStorefront,
  normaliseStorefrontSlug,
  publiclyResolvableStatuses,
  rejectStorefrontSlug,
  reservedStorefrontSlugs,
  storefrontStatuses,
} from "./storefront.constants.js";

/**
 * Storefront slug and lifecycle rules.
 *
 * These are the rules a public URL and an administrative suspension depend on,
 * and they are pure functions, so they are tested directly rather than through
 * the database. The database CHECKs mirror them; these cases exist so a bad
 * value is refused with a field error long before it reaches a constraint.
 */

describe("normaliseStorefrontSlug", () => {
  it("lowercases and hyphenates a display name", () => {
    expect(normaliseStorefrontSlug("Al Noor Fashion")).toBe("al-noor-fashion");
  });

  it("collapses repeated separators and trims the edges", () => {
    expect(normaliseStorefrontSlug("  --Al   Noor--  ")).toBe("al-noor");
  });

  it("strips accents rather than percent-encoding them into the URL", () => {
    expect(normaliseStorefrontSlug("Café Étoile")).toBe("cafe-etoile");
  });

  it("drops characters that would change how a URL parses", () => {
    expect(normaliseStorefrontSlug("shop/../admin?x=1#y")).toBe("shop-admin-x-1-y");
  });

  it("yields an empty slug for a name with no Latin characters", () => {
    // Arabic display names are legitimate; a machine transliteration would be a
    // guess in a permanent public address, so the caller must choose a slug.
    expect(normaliseStorefrontSlug("متجر النور")).toBe("");
  });

  it("never ends on a hyphen after truncation", () => {
    const slug = normaliseStorefrontSlug(`${"a".repeat(62)} b`);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("rejectStorefrontSlug", () => {
  it("accepts a well-formed slug", () => {
    expect(rejectStorefrontSlug("al-noor-fashion")).toBeNull();
  });

  it("rejects an empty slug", () => {
    expect(rejectStorefrontSlug("")).toBe("storefront_slug_required");
  });

  it("rejects a slug below the minimum length", () => {
    expect(rejectStorefrontSlug("ab")).toBe("storefront_slug_too_short");
  });

  it("rejects a slug beyond the maximum length", () => {
    expect(rejectStorefrontSlug("a".repeat(64))).toBe("storefront_slug_too_long");
  });

  it.each(["-leading", "trailing-", "double--hyphen", "Upper", "under_score", "sp ace"])(
    "rejects the malformed slug %s",
    (slug) => {
      expect(rejectStorefrontSlug(slug)).toBe("storefront_slug_invalid");
    },
  );

  it.each(["admin", "api", "store", "checkout", "bluelinegpt", "storefront-preview"])(
    "blocks the reserved word %s",
    (slug) => {
      expect(rejectStorefrontSlug(slug)).toBe("storefront_slug_reserved");
    },
  );

  it("keeps every reserved word itself in valid slug shape", () => {
    // A reserved word that could never be typed anyway would be dead weight and
    // would hide a real gap in the list.
    for (const reserved of reservedStorefrontSlugs) {
      expect(reserved).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});

describe("canTransitionStorefront", () => {
  it("allows a draft Storefront to be published", () => {
    expect(canTransitionStorefront("draft", "published")).toBe(true);
  });

  it("allows closing and reopening a published Storefront", () => {
    expect(canTransitionStorefront("published", "temporarily_closed")).toBe(true);
    expect(canTransitionStorefront("temporarily_closed", "published")).toBe(true);
  });

  it("allows an unpublished Storefront to be published again", () => {
    expect(canTransitionStorefront("unpublished", "published")).toBe(true);
  });

  it("never lets a Trader steer into or out of suspension", () => {
    // Suspension is administrative. If any edge existed, a Trader could clear
    // an administrator's decision by walking the status graph.
    for (const status of storefrontStatuses) {
      expect(canTransitionStorefront(status, "suspended")).toBe(false);
    }
    for (const status of storefrontStatuses) {
      expect(canTransitionStorefront("suspended", status)).toBe(false);
    }
  });

  it("refuses to move straight from draft to temporarily closed", () => {
    expect(canTransitionStorefront("draft", "temporarily_closed")).toBe(false);
  });
});

describe("publiclyResolvableStatuses", () => {
  it("exposes published and temporarily closed Storefronts only", () => {
    expect([...publiclyResolvableStatuses].sort()).toEqual(["published", "temporarily_closed"]);
  });

  it("excludes every status that must read as not-found", () => {
    for (const status of ["draft", "unpublished", "suspended"] as const) {
      expect(publiclyResolvableStatuses).not.toContain(status);
    }
  });
});
