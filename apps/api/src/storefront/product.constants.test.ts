import {
  canTransitionProduct,
  maximumProductImages,
  missingRequiredAttributes,
  normaliseProductCode,
  normaliseProductSlug,
  productLifecycleStatuses,
  productSortColumns,
  publicProductSortColumns,
  rejectMediaUrl,
  rejectProductCode,
  rejectProductSlug,
  reservedProductSlugs,
  templateAttributeSchema,
  validateTemplateAttributes,
} from "./product.constants.js";

/**
 * Product Catalogue rules.
 *
 * Database tests are not authorised for this prompt, so these cover the pure
 * decisions the schema cannot make on its own: what a public URL may contain,
 * which media references may reach an `src` attribute, which template
 * attributes may be stored, and which lifecycle moves exist. Everything here
 * would otherwise only be discovered by a customer.
 */

describe("normaliseProductSlug", () => {
  it("derives a slug from a Product name", () => {
    expect(normaliseProductSlug("Embroidered Abaya")).toBe("embroidered-abaya");
  });

  it("strips characters that would change how the URL parses", () => {
    expect(normaliseProductSlug("abaya/../admin?x=1")).toBe("abaya-admin-x-1");
  });

  it("returns nothing for a name with no Latin characters", () => {
    // The Trader chooses a slug rather than receiving a machine
    // transliteration inside a permanent public URL.
    expect(normaliseProductSlug("عباية مطرزة")).toBe("");
  });
});

describe("rejectProductSlug", () => {
  it("accepts a well-formed slug", () => {
    expect(rejectProductSlug("embroidered-abaya")).toBeNull();
  });

  it.each(["-leading", "trailing-", "double--hyphen", "Upper", "under_score", "a"])(
    "rejects the malformed slug %s",
    (slug) => {
      expect(rejectProductSlug(slug)).toBe("product_slug_invalid");
    },
  );

  it.each(["products", "cart", "checkout", "review", "admin"])(
    "blocks the reserved word %s",
    (slug) => {
      // These are the sibling segments of /store/<shop>/products/<product>.
      expect(rejectProductSlug(slug)).toBe("product_slug_reserved");
    },
  );

  it("keeps every reserved word in valid slug shape", () => {
    for (const reserved of reservedProductSlugs) {
      expect(reserved).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});

describe("product code", () => {
  it("preserves case and leading zeros", () => {
    // The code is printed on labels; normalising it would change identity.
    expect(normaliseProductCode("  ABAYA-0001  ")).toBe("ABAYA-0001");
    expect(normaliseProductCode("0009")).toBe("0009");
  });

  it("accepts the documented safe characters", () => {
    for (const code of ["ABAYA-0001", "SKU_12/3", "a1"]) {
      expect(rejectProductCode(code)).toBeNull();
    }
  });

  it("rejects an empty or unsafe code", () => {
    expect(rejectProductCode("")).toBe("product_code_required");
    expect(rejectProductCode("-leading")).toBe("product_code_invalid");
    expect(rejectProductCode("has space")).toBe("product_code_invalid");
    expect(rejectProductCode("a".repeat(49))).toBe("product_code_invalid");
  });
});

describe("rejectMediaUrl", () => {
  it("accepts https and storage-relative references", () => {
    expect(rejectMediaUrl("https://cdn.example.test/a.jpg")).toBeNull();
    expect(rejectMediaUrl("/files/abc-123")).toBeNull();
  });

  it.each(["javascript:alert(1)", "data:text/html;base64,PHN2Zz4=", "blob:https://x/y", "file:///etc/passwd"])(
    "refuses the dangerous scheme in %s",
    (value) => {
      // These end up in an <img>/<video> src on a public page.
      expect(rejectMediaUrl(value)).not.toBeNull();
    },
  );

  it("refuses plain http", () => {
    expect(rejectMediaUrl("http://cdn.example.test/a.jpg")).toBe(
      "product_media_url_scheme_denied",
    );
  });

  it.each([
    "https://localhost/a.jpg",
    "https://127.0.0.1/a.jpg",
    "https://10.0.0.5/a.jpg",
    "https://192.168.1.9/a.jpg",
    "https://169.254.169.254/latest/meta-data",
    "https://172.16.0.4/a.jpg",
  ])("refuses the private-network host in %s", (value) => {
    expect(rejectMediaUrl(value)).toBe("product_media_url_private_host");
  });

  it("refuses an unparseable reference", () => {
    expect(rejectMediaUrl("not a url")).toBe("product_media_url_invalid");
    expect(rejectMediaUrl("   ")).toBe("product_media_url_invalid");
  });
});

describe("validateTemplateAttributes", () => {
  it("accepts the attributes a template declares", () => {
    expect(
      validateTemplateAttributes("fashion", { fit: "Relaxed", material: "Cotton" }),
    ).toEqual([]);
  });

  it("rejects a key the template does not declare", () => {
    // This is the allow-list: arbitrary JSON is never stored.
    expect(validateTemplateAttributes("fashion", { warranty: "2 years" })).toEqual([
      { key: "warranty", reason: "unknown_key" },
    ]);
  });

  it("rejects a key belonging to a different template", () => {
    expect(validateTemplateAttributes("jewelry", { storage: "256GB" })).toEqual([
      { key: "storage", reason: "unknown_key" },
    ]);
  });

  it("rejects a non-string value", () => {
    expect(validateTemplateAttributes("electronics", { brand: { evil: true } })).toEqual([
      { key: "brand", reason: "not_a_string" },
    ]);
  });

  it("rejects a value beyond its declared length", () => {
    expect(validateTemplateAttributes("general", { brand: "b".repeat(81) })).toEqual([
      { key: "brand", reason: "too_long" },
    ]);
  });

  it("reports every problem at once rather than only the first", () => {
    const problems = validateTemplateAttributes("fashion", {
      material: 42,
      unknownOne: "x",
      unknownTwo: "y",
    });
    expect(problems).toHaveLength(3);
  });

  it("declares attributes for all four business templates", () => {
    for (const template of ["fashion", "electronics", "jewelry", "general"] as const) {
      expect(templateAttributeSchema[template].length).toBeGreaterThan(0);
    }
  });
});

describe("missingRequiredAttributes", () => {
  it("names the attributes a Product needs before activation", () => {
    expect(missingRequiredAttributes("fashion", {})).toEqual(["material"]);
    expect(missingRequiredAttributes("electronics", {})).toEqual(["brand"]);
    expect(missingRequiredAttributes("jewelry", {})).toEqual(["material"]);
  });

  it("treats a blank value as missing", () => {
    expect(missingRequiredAttributes("fashion", { material: "   " })).toEqual(["material"]);
  });

  it("is satisfied by a real value", () => {
    expect(missingRequiredAttributes("fashion", { material: "Cotton" })).toEqual([]);
  });

  it("requires nothing extra for the general template", () => {
    expect(missingRequiredAttributes("general", {})).toEqual([]);
  });
});

describe("canTransitionProduct", () => {
  it("allows a draft Product to be activated", () => {
    expect(canTransitionProduct("draft", "active")).toBe(true);
  });

  it("allows deactivating and reactivating", () => {
    expect(canTransitionProduct("active", "inactive")).toBe(true);
    expect(canTransitionProduct("inactive", "active")).toBe(true);
  });

  it("treats archived as terminal", () => {
    // A future Sales Order will reference a Product; nothing may leave archive
    // and nothing deletes.
    for (const status of productLifecycleStatuses) {
      expect(canTransitionProduct("archived", status)).toBe(false);
    }
  });

  it("allows archiving from every live state", () => {
    for (const status of ["draft", "active", "inactive"] as const) {
      expect(canTransitionProduct(status, "archived")).toBe(true);
    }
  });

  it("refuses a move from draft straight to inactive", () => {
    expect(canTransitionProduct("draft", "inactive")).toBe(false);
  });
});

describe("sort allow-lists", () => {
  it("maps only known keys to SQL", () => {
    // No caller-supplied text ever reaches an ORDER BY.
    expect(Object.keys(productSortColumns).sort()).toEqual([
      "createdAt",
      "displayOrder",
      "name",
      "price",
      "updatedAt",
    ]);
    expect(productSortColumns.injected).toBeUndefined();
  });

  it("offers the public listing a narrower set", () => {
    expect(Object.keys(publicProductSortColumns).sort()).toEqual([
      "displayOrder",
      "name",
      "price",
    ]);
    // Internal timestamps are not a public sort dimension.
    expect(publicProductSortColumns.createdAt).toBeUndefined();
  });
});

describe("media limits", () => {
  it("caps images at eight", () => {
    expect(maximumProductImages).toBe(8);
  });
});
