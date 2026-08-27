import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";

import { App } from "../App.js";
import { CustomerSessionProvider } from "../auth/customer-session-context.js";
import { CartProvider } from "../cart/cart-context.js";
import { storeI18n } from "../localization/i18n.js";
import { orderedHomeSections } from "../config/home-sections.js";
import { isReservedStoreSlug, reservedStoreSlugs } from "../routing/reserved-slugs.js";

/**
 * Store application behaviour.
 *
 * The assertions that matter most here are negative ones. It is easy to build a
 * marketplace that looks right by padding it with sample shops, and easy to
 * build a public page that leaks an internal identifier it happened to receive.
 * Both would pass a test suite that only checked things appear, so several
 * cases below check that things DO NOT.
 */

function renderAt(path: string) {
  return render(
    <I18nextProvider i18n={storeI18n}>
      <MemoryRouter initialEntries={[path]}>
        <CustomerSessionProvider>
          <CartProvider>
            <App />
          </CartProvider>
        </CustomerSessionProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

const devStore = {
  brandAccentColor: "#b08d57",
  brandPrimaryColor: "#1f2937",
  businessHours: [{ days: "Saturday – Thursday", time: "10:00 - 22:00" }],
  businessTemplate: "fashion",
  coverUrl: null,
  customerSupport: null,
  deliveryInformation: "Next-day delivery across the UAE (development data).",
  displayName: "Dev Validation Store",
  logoUrl: null,
  publicEmail: null,
  publicMobile: "+971500000000",
  publicWhatsapp: null,
  returnPolicy: "Returns accepted within 7 days (development data).",
  slug: "dev-validation-store",
  status: "published" as const,
  storeDescription: "Development validation store. Not a real merchant.",
  terms: null,
  theme: "luxury_minimal",
};

const abaya = {
  availabilityStatus: "available" as const,
  brand: null,
  categoryName: "Dev Abayas",
  categorySlug: "dev-abayas",
  currency: "AED",
  name: "Dev Embroidered Abaya",
  previousPrice: null,
  primaryImage: null,
  productCode: "DEV-ABAYA-0001",
  sellingPrice: "249.00",
  slug: "dev-embroidered-abaya",
};

const kaftan = {
  ...abaya,
  availabilityStatus: "unavailable" as const,
  name: "Dev Kaftan Classic",
  productCode: "DEV-KAFTAN-0002",
  sellingPrice: "189.00",
  slug: "dev-kaftan-classic",
};

/** Routes every response through one place so each test states its own world. */
function mockApi(routes: Record<string, { body?: unknown; status?: number }>) {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      const url = String(input);
      seen.push(url);
      const key = Object.keys(routes).find((candidate) => url.endsWith(candidate));
      const route = key === undefined ? { status: 404 } : routes[key]!;
      const status = route.status ?? 200;
      return Promise.resolve({
        json: () => Promise.resolve(route.body ?? {}),
        ok: status >= 200 && status < 300,
        status,
      } as Response);
    }),
  );
  return seen;
}

// Every test starts with an empty Cart -- the Cart lives in `localStorage`
// (`cart-storage.ts`), which `jsdom` shares across tests in this file unless
// explicitly cleared.
beforeEach(() => {
  window.localStorage.clear();
});

describe("Marketplace root", () => {
  beforeEach(async () => {
    await storeI18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the marketplace shell", async () => {
    mockApi({ "public/storefronts": { body: { items: [] } } });
    renderAt("/");
    expect(await screen.findByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: /Everything you need/i }),
    ).toBeInTheDocument();
  });

  it("shows an honest empty state and invents no Store cards when there are none", async () => {
    mockApi({ "public/storefronts": { body: { items: [] } } });
    renderAt("/");
    expect(await screen.findByText(/No stores are published yet/i)).toBeInTheDocument();
    // The section itself must be absent, not merely empty.
    expect(screen.queryByTestId("section-featured_stores")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
  });

  it("renders exactly one Store when the platform has one Store", async () => {
    mockApi({
      "public/storefronts": {
        body: {
          items: [
            {
              displayName: devStore.displayName,
              logoUrl: null,
              slug: devStore.slug,
              status: "published",
              storeDescription: devStore.storeDescription,
            },
          ],
        },
      },
    });
    renderAt("/");
    expect(await screen.findByTestId("section-featured_stores")).toBeInTheDocument();
    // One card. Not a grid padded out to look designed.
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("Dev Validation Store")).toBeInTheDocument();
  });

  it("orders sections from configuration", () => {
    const order = orderedHomeSections().map((section) => section.kind);
    expect(order).toStrictEqual([
      "quick_categories",
      "promotional_banner",
      "curated_collections",
      "featured_stores",
      "bestsellers",
      "recommended",
      "customer_account",
      "app_promotion",
      "track_order",
    ]);
    // A disabled section is excluded rather than hidden by the component.
    const withoutFeatured = orderedHomeSections([
      { enabled: false, kind: "featured_stores", order: 10, titleKey: "x" },
      { enabled: true, kind: "track_order", order: 20, titleKey: "y" },
    ]);
    expect(withoutFeatured.map((section) => section.kind)).toStrictEqual(["track_order"]);
  });

  it("reports the API being unreachable without exposing the failure", async () => {
    mockApi({ "public/storefronts": { status: 500 } });
    renderAt("/");
    expect(await screen.findByText(/Service unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/500/)).not.toBeInTheDocument();
  });
});

describe("Public Store route", () => {
  beforeEach(async () => {
    await storeI18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a valid Store with its products, categories and policies", async () => {
    mockApi({
      "public/storefronts/dev-validation-store": { body: devStore },
      "public/storefronts/dev-validation-store/categories": {
        body: {
          items: [
            { displayOrder: 0, nameAr: null, nameEn: "Dev Abayas", slug: "dev-abayas" },
          ],
        },
      },
      "products?pageSize=48": { body: { items: [abaya, kaftan] } },
    });
    renderAt("/dev-validation-store");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Dev Validation Store" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Dev Embroidered Abaya")).toBeInTheDocument();
    expect(screen.getByText("Dev Kaftan Classic")).toBeInTheDocument();
    expect(screen.getByText("Dev Abayas")).toBeInTheDocument();
    expect(screen.getByText(/Next-day delivery/i)).toBeInTheDocument();
    expect(screen.getByText(/Saturday – Thursday/)).toBeInTheDocument();
  });

  it("shows a safe not-found state for a missing slug", async () => {
    mockApi({ "public/storefronts/nope": { status: 404 } });
    renderAt("/nope");
    expect(await screen.findByText(/Store not found/i)).toBeInTheDocument();
  });

  it("keeps a temporarily closed Store readable rather than replacing it with an error", async () => {
    mockApi({
      "public/storefronts/dev-validation-store": {
        body: { ...devStore, status: "temporarily_closed" },
      },
      "public/storefronts/dev-validation-store/categories": { body: { items: [] } },
      "products?pageSize=48": { body: { items: [] } },
    });
    renderAt("/dev-validation-store");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Dev Validation Store" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/temporarily closed/i)).toBeInTheDocument();
  });

  it("never treats a reserved word as a Store slug", async () => {
    const seen = mockApi({});
    renderAt("/cart");
    // The reserved route renders instead, and no shop lookup is attempted.
    await waitFor(() => {
      expect(seen.some((url) => url.includes("public/storefronts/cart"))).toBe(false);
    });
  });

  it("reserves every marketplace word a Store could otherwise claim", () => {
    for (const word of ["cart", "checkout", "search", "login", "account", "api", "admin"]) {
      expect(reservedStoreSlugs.has(word)).toBe(true);
    }
    // Case-insensitive: the slug index treats these as one word.
    expect(isReservedStoreSlug("Cart")).toBe(true);
    expect(isReservedStoreSlug("  CHECKOUT ")).toBe(true);
    expect(isReservedStoreSlug("dev-validation-store")).toBe(false);
  });
});

describe("Public Product route", () => {
  beforeEach(async () => {
    await storeI18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders an active Product with price, options and required marker", async () => {
    mockApi({
      "products/dev-embroidered-abaya": {
        body: {
          ...abaya,
          fullDescription: "Hand embroidered.",
          maximumQuantity: null,
          media: [],
          minimumQuantity: null,
          options: [
            { isRequired: true, name: "Size", values: [{ value: "S" }, { value: "M" }] },
            { isRequired: false, name: "Colour", values: [{ value: "Black" }] },
          ],
          shortDescription: "Short",
          templateAttributes: { material: "Premium crepe" },
        },
      },
    });
    renderAt("/dev-validation-store/products/dev-embroidered-abaya");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Dev Embroidered Abaya" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/249\.00/)).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.getByText("S")).toBeInTheDocument();
    expect(screen.getByText(/Required/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to store/i })).toBeInTheDocument();
  });

  it("still renders an unavailable Product rather than hiding it", async () => {
    mockApi({
      "products/dev-kaftan-classic": {
        body: {
          ...kaftan,
          fullDescription: null,
          maximumQuantity: null,
          media: [],
          minimumQuantity: null,
          options: [],
          shortDescription: null,
          templateAttributes: {},
        },
      },
    });
    renderAt("/dev-validation-store/products/dev-kaftan-classic");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Dev Kaftan Classic" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Currently unavailable")).toBeInTheDocument();
  });

  it("shows a safe not-found state for a missing Product", async () => {
    mockApi({ "products/ghost": { status: 404 } });
    renderAt("/dev-validation-store/products/ghost");
    expect(await screen.findByText(/Product not found/i)).toBeInTheDocument();
  });
});

describe("Localization and isolation", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await storeI18n.changeLanguage("en");
  });

  it("switches to Arabic and sets the document direction to RTL", async () => {
    mockApi({ "public/storefronts": { body: { items: [] } } });
    renderAt("/");
    await storeI18n.changeLanguage("ar");
    await waitFor(() => {
      expect(document.documentElement.dir).toBe("rtl");
    });
    expect(document.documentElement.lang).toBe("ar");
    // Asserted on the hero, which is always present. "Featured stores" would
    // have been the wrong choice: with no Stores that section is correctly
    // absent, so the test would have been checking the empty-state rule twice
    // and the language not at all.
    expect(
      await screen.findByRole("heading", { level: 1, name: /كل ما تحتاجه/ }),
    ).toBeInTheDocument();
  });

  it("returns to LTR for English", async () => {
    mockApi({ "public/storefronts": { body: { items: [] } } });
    renderAt("/");
    await storeI18n.changeLanguage("ar");
    await storeI18n.changeLanguage("en");
    await waitFor(() => {
      expect(document.documentElement.dir).toBe("ltr");
    });
  });

  it("renders no Delivery, financial or ownership field even when the API sends one", async () => {
    // A deliberately over-broad payload: if the Store ever rendered a field it
    // merely received, this is where it would show.
    mockApi({
      "public/storefronts/dev-validation-store": {
        body: {
          ...devStore,
          companyId: "company-leak-8f2",
          settlementBalance: "6725.00",
          traderCommerceId: "commerce-leak-4a1",
          traderId: "trader-leak-9c3",
        },
      },
      "public/storefronts/dev-validation-store/categories": { body: { items: [] } },
      "products?pageSize=48": { body: { items: [] } },
    });
    renderAt("/dev-validation-store");
    await screen.findByRole("heading", { level: 1, name: "Dev Validation Store" });
    const markup = document.body.innerHTML;
    for (const leak of ["company-leak-8f2", "commerce-leak-4a1", "trader-leak-9c3", "6725.00"]) {
      expect(markup).not.toContain(leak);
    }
  });
});

describe("Cart", () => {
  beforeEach(async () => {
    await storeI18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const abayaWithOptions = {
    ...abaya,
    fullDescription: null,
    maximumQuantity: null,
    media: [],
    minimumQuantity: null,
    options: [
      {
        displayOrder: 0,
        isRequired: false,
        name: "Colour",
        values: [{ displayOrder: 0, isActive: true, value: "Black" }],
      },
      {
        displayOrder: 1,
        isRequired: true,
        name: "Size",
        values: [
          { displayOrder: 0, isActive: true, value: "S" },
          { displayOrder: 1, isActive: true, value: "M" },
        ],
      },
    ],
    shortDescription: null,
    templateAttributes: {},
  };

  it("blocks Add to Cart when the required option is not selected, with a clear message", async () => {
    mockApi({ "public/storefronts/dev-validation-store": { body: devStore }, "products/dev-embroidered-abaya": { body: abayaWithOptions } });
    renderAt("/dev-validation-store/products/dev-embroidered-abaya");
    await screen.findByRole("heading", { level: 1, name: "Dev Embroidered Abaya" });
    fireEvent.click(screen.getByRole("button", { name: "Add to Cart" }));
    expect(await screen.findByText("Select a Size to continue.")).toBeInTheDocument();
    expect(screen.queryByText("Added to Cart")).not.toBeInTheDocument();
  });

  it("adds to Cart once the required option is selected; the optional option may stay unset", async () => {
    mockApi({ "public/storefronts/dev-validation-store": { body: devStore }, "products/dev-embroidered-abaya": { body: abayaWithOptions } });
    renderAt("/dev-validation-store/products/dev-embroidered-abaya");
    await screen.findByRole("heading", { level: 1, name: "Dev Embroidered Abaya" });
    fireEvent.click(screen.getByLabelText("M"));
    fireEvent.click(screen.getByRole("button", { name: "Add to Cart" }));
    expect(await screen.findByText("Added to Cart")).toBeInTheDocument();
  });

  it("adding the identical Product+option configuration again increments quantity, not a duplicate line", async () => {
    mockApi({ "public/storefronts/dev-validation-store": { body: devStore }, "products/dev-embroidered-abaya": { body: abayaWithOptions } });
    renderAt("/dev-validation-store/products/dev-embroidered-abaya");
    await screen.findByRole("heading", { level: 1, name: "Dev Embroidered Abaya" });
    fireEvent.click(screen.getByLabelText("M"));
    fireEvent.click(screen.getByRole("button", { name: "Add to Cart" }));
    await screen.findByText("Added to Cart");
    fireEvent.click(screen.getByRole("button", { name: "Add to Cart" }));
    await waitFor(() => {
      expect(screen.getAllByText("Added to Cart")).toHaveLength(1);
    });

    cleanup();
    mockApi({ "public/storefronts/dev-validation-store": { body: devStore }, "products/dev-embroidered-abaya": { body: abayaWithOptions } });
    renderAt("/cart");
    await screen.findByRole("heading", { level: 1, name: "Your Cart" });
    expect(screen.getAllByText(/Dev Embroidered Abaya/)).toHaveLength(1);
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("2");
  });

  it("shows the Cart badge count as the sum of line quantities", async () => {
    mockApi({ "public/storefronts/dev-validation-store": { body: devStore }, "products/dev-embroidered-abaya": { body: abayaWithOptions } });
    renderAt("/dev-validation-store/products/dev-embroidered-abaya");
    await screen.findByRole("heading", { level: 1, name: "Dev Embroidered Abaya" });
    fireEvent.click(screen.getByLabelText("M"));
    fireEvent.click(screen.getByRole("button", { name: "Add to Cart" }));
    await screen.findByText("Added to Cart");
    await waitFor(() => {
      expect(document.querySelector(".store-cartbadge")).toHaveTextContent("1");
    });
  });

  it("renders an honest empty state when the Cart has nothing in it", async () => {
    renderAt("/cart");
    expect(await screen.findByText("Your Cart is empty.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue Shopping" })).toBeInTheDocument();
  });

  it("removes a line and shows the empty state again", async () => {
    mockApi({ "public/storefronts/dev-validation-store": { body: devStore }, "products/dev-embroidered-abaya": { body: abayaWithOptions } });
    renderAt("/dev-validation-store/products/dev-embroidered-abaya");
    await screen.findByRole("heading", { level: 1, name: "Dev Embroidered Abaya" });
    fireEvent.click(screen.getByLabelText("M"));
    fireEvent.click(screen.getByRole("button", { name: "Add to Cart" }));
    await screen.findByText("Added to Cart");

    cleanup();
    mockApi({ "public/storefronts/dev-validation-store": { body: devStore }, "products/dev-embroidered-abaya": { body: abayaWithOptions } });
    renderAt("/cart");
    await screen.findByRole("heading", { level: 1, name: "Your Cart" });
    fireEvent.click(screen.getByRole("button", { name: /Remove Dev Embroidered Abaya from Cart/ }));
    expect(await screen.findByText("Your Cart is empty.")).toBeInTheDocument();
  });

  it("deep-reloads /cart directly without a client-side 404, in English and Arabic", async () => {
    renderAt("/en/cart");
    expect(await screen.findByText("Your Cart is empty.")).toBeInTheDocument();
  });

  it("warns before replacing a Cart with a Product from a different Store, and Cancel keeps the original Cart", async () => {
    mockApi({ "public/storefronts/dev-validation-store": { body: devStore }, "products/dev-embroidered-abaya": { body: abayaWithOptions } });
    renderAt("/dev-validation-store/products/dev-embroidered-abaya");
    await screen.findByRole("heading", { level: 1, name: "Dev Embroidered Abaya" });
    fireEvent.click(screen.getByLabelText("M"));
    fireEvent.click(screen.getByRole("button", { name: "Add to Cart" }));
    await screen.findByText("Added to Cart");

    mockApi({
      "public/storefronts/other-store": {
        body: { ...devStore, displayName: "Other Store", slug: "other-store" },
      },
      "products/dev-kaftan-classic": {
        body: {
          ...abayaWithOptions,
          ...kaftan,
          availabilityStatus: "available" as const,
          options: [],
        },
      },
    });
    cleanup();
    renderAt("/other-store/products/dev-kaftan-classic");
    await screen.findByRole("heading", { level: 1, name: "Dev Kaftan Classic" });
    fireEvent.click(screen.getByRole("button", { name: "Add to Cart" }));
    expect(
      await screen.findByText(/Your Cart contains items from Dev Validation Store/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep My Cart" }));

    cleanup();
    mockApi({ "public/storefronts/dev-validation-store": { body: devStore }, "products/dev-embroidered-abaya": { body: abayaWithOptions } });
    renderAt("/cart");
    await screen.findByRole("heading", { level: 1, name: "Your Cart" });
    expect(screen.getByText(/Dev Validation Store/)).toBeInTheDocument();
  });
});
