import { render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";

import { App } from "../App.js";
import { CustomerSessionProvider } from "../auth/customer-session-context.js";
import { storeI18n } from "../localization/i18n.js";

import { pathWithLocale } from "./locale-routing.js";

/**
 * Locale-prefixed routing.
 *
 * The compatibility case is the one worth guarding: unprefixed URLs already
 * exist in the wild, and a change that only proves `/en/shop` works while
 * quietly 404-ing `/shop` breaks every link a Trader has already shared.
 */

const store = {
  brandAccentColor: "#b08d57",
  brandPrimaryColor: "#1f2937",
  businessHours: [],
  businessTemplate: "fashion",
  coverUrl: null,
  customerSupport: null,
  deliveryInformation: null,
  displayName: "Dev Commerce Store",
  logoUrl: null,
  products: { items: [], page: 1, pageSize: 24, total: 0 },
  publicEmail: null,
  publicMobile: null,
  publicWhatsapp: null,
  returnPolicy: null,
  seoIndexable: true,
  slug: "dev-commerce-store",
  status: "published",
  storeDescription: "Development Commerce store.",
  terms: null,
  theme: "luxury_minimal",
};

/** Suffix-matched so a longer path is never swallowed by a shorter prefix. */
function mockApi(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      const url = String(input).split("?")[0] ?? "";
      const key = Object.keys(routes).find((candidate) => url.endsWith(candidate));
      return Promise.resolve({
        json: () => Promise.resolve(key === undefined ? {} : routes[key]),
        ok: key !== undefined,
        status: key === undefined ? 404 : 200,
      } as Response);
    }),
  );
}

const emptyPage = { items: [], page: 1, pageSize: 24, total: 0 };

beforeEach(async () => {
  await storeI18n.changeLanguage("en");
  mockApi({
    "public/marketplace/categories": { items: [] },
    "public/storefronts": { items: [] },
    "public/storefronts/dev-commerce-store": store,
    "public/storefronts/dev-commerce-store/categories": { items: [] },
    "public/storefronts/dev-commerce-store/products": emptyPage,
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await storeI18n.changeLanguage("en");
});

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

describe("locale-prefixed routes", () => {
  it("resolves an unprefixed Store URL", async () => {
    // Links shared before prefixes existed must keep working.
    renderAt("/dev-commerce-store");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Dev Commerce Store" })).toBeInTheDocument();
    });
  });

  it("resolves the same Store under /en", async () => {
    renderAt("/en/dev-commerce-store");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Dev Commerce Store" })).toBeInTheDocument();
    });
  });

  it("resolves the same Store under /ar and switches the interface to Arabic", async () => {
    renderAt("/ar/dev-commerce-store");
    await waitFor(() => {
      expect(storeI18n.language).toBe("ar");
    });
    // Trader content is never machine translated — the shop name is unchanged.
    expect(screen.getByRole("heading", { name: "Dev Commerce Store" })).toBeInTheDocument();
  });

  it("keeps the prefix on in-app links", async () => {
    renderAt("/ar/categories");
    // The brand link, not the skip link that precedes it in the DOM.
    const brand = await screen.findByRole("link", { name: /BluelineGPT/i });
    expect(brand).toHaveAttribute("href", "/ar");
  });

  it("leaves links unprefixed when the URL had no prefix", async () => {
    // Otherwise the first click silently moves the shopper onto a different
    // URL space from the one they arrived on.
    renderAt("/categories");
    const brand = await screen.findByRole("link", { name: /BluelineGPT/i });
    expect(brand).toHaveAttribute("href", "/");
  });

  it("resolves a locale-prefixed marketplace root", async () => {
    renderAt("/ar");
    await waitFor(() => {
      expect(storeI18n.language).toBe("ar");
    });
  });
});

describe("pathWithLocale", () => {
  it("adds a prefix to an unprefixed path", () => {
    expect(pathWithLocale("/dev-commerce-store", "ar")).toBe("/ar/dev-commerce-store");
  });

  it("replaces an existing prefix rather than stacking one", () => {
    expect(pathWithLocale("/ar/dev-commerce-store", "en")).toBe("/en/dev-commerce-store");
  });

  it("keeps the shopper on the page they were reading", () => {
    expect(pathWithLocale("/en/dev-commerce-store/products/abaya", "ar")).toBe(
      "/ar/dev-commerce-store/products/abaya",
    );
  });

  it("handles the root", () => {
    expect(pathWithLocale("/", "ar")).toBe("/ar");
    expect(pathWithLocale("/en", "ar")).toBe("/ar");
  });
});
