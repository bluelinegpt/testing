import {
  toStoreConfig,
  toStorefrontProduct,
  type PublicProduct,
  type PublicStorefront,
} from "./public-storefront.js";
import type { StorefrontProduct } from "../types.js";

const sampleProduct: StorefrontProduct = {
  available: true,
  badges: [],
  category: "rings",
  code: "SKU-1",
  colors: [],
  description: "",
  media: [],
  name: "Ring",
  price: "100.00",
  sizes: [],
  slug: "ring",
};

const apiProduct: PublicProduct = {
  availabilityStatus: "available",
  categoryName: "Rings",
  categorySlug: "rings",
  currency: "AED",
  name: "Gold Ring",
  previousPrice: "1200.00",
  primaryImage: { altText: "A gold ring", url: "/files/abc" },
  productCode: "RING-0001",
  sellingPrice: "999.00",
  shortDescription: "A gold ring",
  slug: "gold-ring",
  templateAttributes: { material: "18k gold" },
};

/**
 * Mapping a persisted Storefront onto the shared prototype components.
 *
 * The claim that matters is provenance: every identity, contact and policy
 * field must come from the API, and only the catalogue may still come from the
 * sample data. A regression here would put one Trader's sample details on
 * another Trader's public page.
 */

const storefront: PublicStorefront = {
  brandAccentColor: "#b08d57",
  brandPrimaryColor: "#1f2937",
  businessHours: [{ days: "Sat – Thu", time: "10:00 – 22:00" }],
  businessTemplate: "jewelry",
  customerSupport: "support@example.test",
  deliveryInformation: "Next-day delivery",
  displayName: "Real Persisted Shop",
  publicEmail: "hello@example.test",
  publicMobile: "+971500000000",
  publicWhatsapp: "+971500000001",
  returnPolicy: "7-day returns",
  slug: "real-persisted-shop",
  status: "published",
  storeDescription: "A real description",
  terms: "Terms apply",
  theme: "clean_light",
};

describe("toStoreConfig", () => {
  it("takes every profile field from the persisted Storefront", () => {
    const config = toStoreConfig(storefront);
    expect(config.profile.name).toBe("Real Persisted Shop");
    expect(config.profile.slug).toBe("real-persisted-shop");
    expect(config.profile.description).toBe("A real description");
    expect(config.profile.mobile).toBe("+971500000000");
    expect(config.profile.whatsapp).toBe("+971500000001");
    expect(config.profile.policies.delivery).toBe("Next-day delivery");
    expect(config.profile.policies.returns).toBe("7-day returns");
    expect(config.profile.hours).toEqual([{ days: "Sat – Thu", time: "10:00 – 22:00" }]);
  });

  it("maps the API's theme and template keys onto the prototype's", () => {
    const config = toStoreConfig(storefront);
    expect(config.themeKey).toBe("clean-light");
    expect(config.templateKey).toBe("jewelry");
  });

  it("shows an EMPTY catalogue rather than sample Products", () => {
    // Prompt 4 replaced the sample catalogue with the real one. A configured
    // shop with no Products must look empty, never stocked with goods the
    // Trader does not sell.
    expect(toStoreConfig(storefront).products).toEqual([]);
    expect(toStoreConfig(storefront).categories).toEqual([]);
  });

  it("derives categories from the real catalogue", () => {
    const config = toStoreConfig(storefront, [
      { ...sampleProduct, category: "rings" },
      { ...sampleProduct, category: "rings", slug: "second" },
      { ...sampleProduct, category: "necklaces", slug: "third" },
    ]);
    // A shop never advertises a section it has nothing in.
    expect(config.categories.map((c) => c.key).sort()).toEqual(["necklaces", "rings"]);
    expect(config.products).toHaveLength(3);
  });

  it("never carries a sample Trader's identity onto a real Storefront", () => {
    const config = toStoreConfig(storefront);
    expect(config.profile.name).not.toMatch(/Al Noor|Tech Horizon/i);
    expect(config.profile.mobile).toBe(storefront.publicMobile);
  });

  it("derives the logo initial locally rather than fetching a binary", () => {
    expect(toStoreConfig(storefront).profile.logoInitial).toBe("R");
    expect(toStoreConfig({ ...storefront, displayName: "  " }).profile.logoInitial).toBe("S");
  });

  it("falls back to safe defaults for an unrecognised theme or template", () => {
    const odd = toStoreConfig({ ...storefront, businessTemplate: "unknown", theme: "unknown" });
    expect(odd.templateKey).toBe("general");
    expect(odd.themeKey).toBe("clean-light");
  });

  it("renders empty strings rather than 'null' for absent optional copy", () => {
    const sparse = toStoreConfig({
      ...storefront,
      deliveryInformation: null,
      publicMobile: null,
      returnPolicy: null,
      storeDescription: null,
    });
    expect(sparse.profile.description).toBe("");
    expect(sparse.profile.mobile).toBe("");
    expect(sparse.profile.policies.delivery).toBe("");
    expect(sparse.profile.policies.returns).toBe("");
  });
});

/**
 * Mapping an API Product onto the shared prototype components.
 */
describe("toStorefrontProduct", () => {
  it("carries price, availability and the real image", () => {
    const product = toStorefrontProduct(apiProduct);
    expect(product.price).toBe("999.00");
    expect(product.previousPrice).toBe("1200.00");
    expect(product.available).toBe(true);
    expect(product.media[0]!.url).toBe("/files/abc");
    expect(product.media[0]!.label).toBe("A gold ring");
  });

  it("marks an unavailable Product without hiding it", () => {
    // Unavailable Products stay visible and are labelled; visibility is a
    // lifecycle decision, not an availability one.
    const product = toStorefrontProduct({ ...apiProduct, availabilityStatus: "unavailable" });
    expect(product.available).toBe(false);
    expect(product.name).toBe("Gold Ring");
  });

  it("renders template attributes with human-readable labels", () => {
    // A customer should read "Material", not the storage key.
    expect(toStorefrontProduct(apiProduct).attributes).toEqual([
      { label: "Material", value: "18k gold" },
    ]);
  });

  it("humanises a camel-case attribute key", () => {
    const product = toStorefrontProduct({
      ...apiProduct,
      templateAttributes: { careInstructions: "Dry clean only" },
    });
    expect(product.attributes).toEqual([
      { label: "Care instructions", value: "Dry clean only" },
    ]);
  });

  it("marks a required option group on the public page", () => {
    // Checkout will later enforce the choice, so the customer must see which
    // groups are compulsory before they get there.
    const withOptions = toStorefrontProduct(apiProduct, {
      ...apiProduct,
      fullDescription: null,
      maximumQuantity: null,
      media: [],
      minimumQuantity: null,
      options: [{ isRequired: true, name: "Size", values: [{ value: "M" }] }],
    });
    expect(withOptions.optionLabel).toBe("Size *");
  });

  it("leaves an optional group unmarked", () => {
    const withOptions = toStorefrontProduct(apiProduct, {
      ...apiProduct,
      fullDescription: null,
      maximumQuantity: null,
      media: [],
      minimumQuantity: null,
      options: [{ isRequired: false, name: "Size", values: [{ value: "M" }] }],
    });
    expect(withOptions.optionLabel).toBe("Size");
  });

  it("uses the category NAME as the pill label, not the slug", () => {
    // Customers were shown "dev-kaftans" where the Trader wrote "Dev Kaftans".
    const config = toStoreConfig(storefront, [toStorefrontProduct(apiProduct)]);
    expect(config.categories[0]!.label).toBe("Rings");
  });

  it("takes sizes and colours from the Product's option groups", () => {
    const product = toStorefrontProduct(apiProduct, {
      ...apiProduct,
      fullDescription: "Full",
      maximumQuantity: null,
      media: [],
      minimumQuantity: null,
      options: [
        { isRequired: false, name: "Size", values: [{ value: "6" }, { value: "7" }] },
        { isRequired: false, name: "Colour", values: [{ value: "Yellow" }] },
      ],
    });
    expect(product.sizes).toEqual(["6", "7"]);
    expect(product.colors).toEqual(["Yellow"]);
    expect(product.description).toBe("Full");
  });

  it("omits previousPrice entirely when there is no comparison price", () => {
    expect(toStorefrontProduct({ ...apiProduct, previousPrice: null }).previousPrice).toBeUndefined();
  });

  it("falls back to the slug when no Product code is published", () => {
    expect(toStorefrontProduct({ ...apiProduct, productCode: null }).code).toBe("gold-ring");
  });
});
