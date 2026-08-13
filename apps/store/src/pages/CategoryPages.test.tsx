import { render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";

import { App } from "../App.js";
import { CustomerSessionProvider } from "../auth/customer-session-context.js";
import { storeI18n } from "../localization/i18n.js";

import { taxonomyLabel } from "./CategoryPages.js";

/**
 * Marketplace Category browsing.
 *
 * The two rules most likely to be broken later, and therefore the two asserted
 * hardest, are: a Subcategory page shows only ITS OWN Products (never a
 * sibling's), and nothing on any of these pages is invented when the API
 * returns nothing.
 */

function renderAt(path: string) {
  return render(
    <I18nextProvider i18n={storeI18n}>
      <MemoryRouter initialEntries={[path]}>
        <CustomerSessionProvider>
          <App />
        </CustomerSessionProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

const fashion = {
  descriptionAr: null,
  descriptionEn: "Clothing, abayas and accessories.",
  displayOrder: 1,
  nameAr: "أزياء",
  nameEn: "Fashion",
  slug: "fashion",
  subcategoryCount: 2,
};

/** No Arabic name on purpose — the English-fallback case. */
const electronics = {
  descriptionAr: null,
  descriptionEn: "Phones, computers and audio.",
  displayOrder: 2,
  nameAr: null,
  nameEn: "Electronics",
  slug: "electronics",
  subcategoryCount: 1,
};

const fashionDetail = {
  descriptionAr: null,
  descriptionEn: "Clothing, abayas and accessories.",
  nameAr: "أزياء",
  nameEn: "Fashion",
  slug: "fashion",
  subcategories: [
    { displayOrder: 1, nameAr: "عبايات", nameEn: "Abayas", slug: "abayas" },
    { displayOrder: 2, nameAr: "نساء", nameEn: "Women", slug: "women" },
  ],
};

const abaya = {
  availabilityStatus: "available" as const,
  brand: "Dev Brand",
  currency: "AED",
  name: "Dev Embroidered Abaya",
  previousPrice: "299.00",
  primaryImage: null,
  sellingPrice: "249.00",
  slug: "dev-embroidered-abaya",
  storeName: "Dev Commerce Store",
  storeSlug: "dev-commerce-store",
};

function mockApi(routes: Record<string, { body?: unknown; status?: number }>) {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      const url = String(input);
      seen.push(url);
      // Suffix matching on the PATH, not substring matching.
      // `…/categories/fashion/subcategories/women/products` contains
      // `…/categories/fashion`, so a substring match would have answered the
      // Subcategory's product request with the Category document — which is
      // exactly the confusion these tests exist to catch.
      const path = url.split("?")[0] ?? url;
      const key = Object.keys(routes)
        .sort((a, b) => b.length - a.length)
        .find((candidate) => path.endsWith(candidate));
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

const emptyPage = { items: [], page: 1, pageSize: 24, total: 0 };

describe("taxonomyLabel", () => {
  it("prefers Arabic when the interface is Arabic and a name exists", () => {
    expect(taxonomyLabel(fashion, "ar")).toBe("أزياء");
  });

  it("falls back to English when no Arabic name was supplied", () => {
    // Never machine-translated — the English word is shown as-is.
    expect(taxonomyLabel(electronics, "ar")).toBe("Electronics");
    expect(taxonomyLabel({ nameAr: "   ", nameEn: "Gifts" }, "ar")).toBe("Gifts");
  });

  it("uses English for the English interface even when Arabic exists", () => {
    expect(taxonomyLabel(fashion, "en")).toBe("Fashion");
  });
});

describe("/categories", () => {
  beforeEach(async () => {
    await storeI18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists exactly the Categories the API returned", async () => {
    mockApi({ "public/marketplace/categories": { body: { items: [fashion, electronics] } } });
    renderAt("/categories");
    expect(await screen.findByText("Fashion")).toBeInTheDocument();
    expect(screen.getByText("Electronics")).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("shows one Category as one Category", async () => {
    mockApi({ "public/marketplace/categories": { body: { items: [fashion] } } });
    renderAt("/categories");
    await screen.findByText("Fashion");
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("shows an honest empty state and invents nothing when there are none", async () => {
    mockApi({ "public/marketplace/categories": { body: { items: [] } } });
    renderAt("/categories");
    expect(await screen.findByText(/No categories yet/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
  });

  it("never renders an inactive Category, because the API never sends one", async () => {
    // Inactivity is enforced server-side; the client's job is simply to render
    // what it was given, so the assertion is that nothing extra appears.
    mockApi({ "public/marketplace/categories": { body: { items: [fashion] } } });
    renderAt("/categories");
    await screen.findByText("Fashion");
    expect(screen.queryByText("Electronics")).not.toBeInTheDocument();
  });
});

describe("/categories/{category}", () => {
  beforeEach(async () => {
    await storeI18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders Subcategories, mapped Stores and mapped Products", async () => {
    mockApi({
      "marketplace/categories/fashion/stores": {
        body: {
          items: [
            {
              displayName: "Dev Commerce Store",
              logoUrl: null,
              slug: "dev-commerce-store",
              status: "published",
              storeDescription: "Development Commerce store.",
            },
          ],
        },
      },
      "marketplace/categories/fashion/products": {
        body: { items: [abaya], page: 1, pageSize: 24, total: 1 },
      },
      "marketplace/categories/fashion": { body: fashionDetail },
    });
    renderAt("/categories/fashion");
    expect(await screen.findByRole("heading", { name: "Fashion" })).toBeInTheDocument();
    expect(await screen.findByTestId("subcategories")).toBeInTheDocument();
    expect(screen.getByText("Abayas")).toBeInTheDocument();
    expect(screen.getByText("Women")).toBeInTheDocument();
    // Scoped by section: the shop's name legitimately appears twice — once as
    // the Store card, once as the Product card's marketplace context — so an
    // unscoped query is ambiguous rather than wrong.
    const stores = await screen.findByTestId("category-stores");
    expect(stores).toHaveTextContent("Dev Commerce Store");
    const products = await screen.findByTestId("category-products");
    expect(products).toHaveTextContent("Dev Embroidered Abaya");
    expect(products).toHaveTextContent("Dev Commerce Store");
  });

  it("shows separate empty states for Stores and Products", async () => {
    mockApi({
      "marketplace/categories/fashion/stores": { body: { items: [] } },
      "marketplace/categories/fashion/products": { body: emptyPage },
      "marketplace/categories/fashion": { body: { ...fashionDetail, subcategories: [] } },
    });
    renderAt("/categories/fashion");
    expect(await screen.findByText(/No stores yet/i)).toBeInTheDocument();
    expect(await screen.findByText(/No products yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("subcategories")).not.toBeInTheDocument();
  });

  it("shows a safe not-found state for an unknown Category", async () => {
    mockApi({ "marketplace/categories/ghost": { status: 404 } });
    renderAt("/categories/ghost");
    expect(await screen.findByText(/Category not found/i)).toBeInTheDocument();
  });

  it("renders breadcrumbs back to the marketplace root", async () => {
    mockApi({
      "marketplace/categories/fashion/stores": { body: { items: [] } },
      "marketplace/categories/fashion/products": { body: emptyPage },
      "marketplace/categories/fashion": { body: fashionDetail },
    });
    renderAt("/categories/fashion");
    const crumbs = await screen.findByRole("navigation", { name: /breadcrumb/i });
    expect(crumbs).toHaveTextContent("Home");
    expect(crumbs).toHaveTextContent("Categories");
    expect(crumbs).toHaveTextContent("Fashion");
  });
});

describe("/categories/{category}/{subcategory}", () => {
  beforeEach(async () => {
    await storeI18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the API for that Subcategory specifically", async () => {
    const seen = mockApi({
      "subcategories/abayas/products": {
        body: { items: [abaya], page: 1, pageSize: 24, total: 1 },
      },
      "marketplace/categories/fashion": { body: fashionDetail },
    });
    renderAt("/categories/fashion/abayas");
    expect(await screen.findByText("Dev Embroidered Abaya")).toBeInTheDocument();
    // Server-side filtering, not a client-side filter over the whole Category.
    await waitFor(() => {
      expect(seen.some((url) => url.includes("subcategories/abayas/products"))).toBe(true);
    });
  });

  it("shows no Products for a sibling Subcategory that has none", async () => {
    mockApi({
      "subcategories/women/products": { body: emptyPage },
      "marketplace/categories/fashion": { body: fashionDetail },
    });
    renderAt("/categories/fashion/women");
    expect(await screen.findByText(/No products yet/i)).toBeInTheDocument();
    expect(screen.queryByText("Dev Embroidered Abaya")).not.toBeInTheDocument();
  });

  it("reports a Subcategory that does not belong to the Category as not found", async () => {
    mockApi({ "marketplace/categories/fashion": { body: fashionDetail } });
    renderAt("/categories/fashion/mobile-phones");
    expect(await screen.findByText(/Category not found/i)).toBeInTheDocument();
  });
});

describe("Quick Categories on the marketplace root", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await storeI18n.changeLanguage("en");
  });

  it("uses real Platform taxonomy", async () => {
    mockApi({
      "public/marketplace/categories": { body: { items: [fashion, electronics] } },
      "public/storefronts": { body: { items: [] } },
    });
    renderAt("/");
    const section = await screen.findByTestId("section-quick_categories");
    expect(section).toHaveTextContent("Fashion");
    expect(section).toHaveTextContent("Electronics");
  });

  it("hides the section entirely when the Platform has no Categories", async () => {
    mockApi({
      "public/marketplace/categories": { body: { items: [] } },
      "public/storefronts": { body: { items: [] } },
    });
    renderAt("/");
    await screen.findByText(/Nothing to show yet/i);
    expect(screen.queryByTestId("section-quick_categories")).not.toBeInTheDocument();
  });

  it("shows Arabic labels with English fallback", async () => {
    mockApi({
      "public/marketplace/categories": { body: { items: [fashion, electronics] } },
      "public/storefronts": { body: { items: [] } },
    });
    renderAt("/");
    await screen.findByTestId("section-quick_categories");
    await storeI18n.changeLanguage("ar");
    await waitFor(() => {
      expect(screen.getByTestId("section-quick_categories")).toHaveTextContent("أزياء");
    });
    // No Arabic name exists for Electronics, so the English word stands.
    expect(screen.getByTestId("section-quick_categories")).toHaveTextContent("Electronics");
  });
});
