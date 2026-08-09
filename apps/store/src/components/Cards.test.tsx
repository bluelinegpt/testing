import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";

import { storeI18n } from "../localization/i18n.js";

import { ProductCard, StoreCard } from "./Cards.js";

/**
 * Card presentation.
 *
 * The load-bearing assertion here is that REAL media wins. An uploaded Product
 * photo rendering as a flat placeholder tile is the defect that made the whole
 * marketplace read as broken, and it is invisible to any test that only checks
 * the name and price are present.
 */

const store = {
  displayName: "Dev Commerce Store",
  logoUrl: "/api/v1/public/commerce-media/logo-1",
  slug: "dev-commerce-store",
  status: "published" as const,
  storeDescription: "Development Commerce store.",
};

const product = {
  availabilityStatus: "available" as const,
  brand: "Dev Brand",
  categoryName: null,
  categorySlug: null,
  currency: "AED",
  name: "Dev Embroidered Abaya",
  previousPrice: "299.00",
  primaryImage: { altText: null, url: "/api/v1/public/commerce-media/img-1" },
  productCode: "DEV-ABAYA-0001",
  sellingPrice: "249.00",
  slug: "dev-embroidered-abaya",
};

function renderCard(node: React.ReactNode) {
  return render(
    <I18nextProvider i18n={storeI18n}>
      <MemoryRouter>{node}</MemoryRouter>
    </I18nextProvider>,
  );
}

afterEach(async () => {
  await storeI18n.changeLanguage("en");
});

describe("StoreCard", () => {
  it("renders the real logo rather than a fallback tile", () => {
    renderCard(<StoreCard store={store} />);
    const logo = screen.getByAltText("Dev Commerce Store");
    expect(logo).toHaveAttribute("src", "/api/v1/public/commerce-media/logo-1");
  });

  it("falls back only when there is genuinely no logo", () => {
    renderCard(<StoreCard store={{ ...store, logoUrl: null }} />);
    expect(screen.queryByAltText("Dev Commerce Store")).not.toBeInTheDocument();
  });

  it("says New store rather than showing a fabricated rating", () => {
    renderCard(<StoreCard store={store} />);
    expect(screen.getByText("New store")).toBeInTheDocument();
    // No rating data exists. A 0.0 would read as a bad shop, not an unrated one.
    expect(screen.queryByText(/0\.0/)).not.toBeInTheDocument();
  });

  it("labels its single stretched link with the heading, not duplicate text", () => {
    renderCard(<StoreCard store={store} />);
    expect(screen.getByRole("link", { name: "Dev Commerce Store" })).toBeInTheDocument();
    // Exactly one node carries the name; a hidden copy would make screen
    // readers announce the shop twice.
    expect(screen.getAllByText("Dev Commerce Store")).toHaveLength(1);
  });

  it("shows a Marketplace Category only when the caller supplied one", () => {
    renderCard(<StoreCard categoryName="Fashion" store={store} />);
    expect(screen.getByText("Fashion")).toBeInTheDocument();
  });
});

describe("ProductCard", () => {
  it("renders the real Product image", () => {
    renderCard(<ProductCard product={product} storeSlug="dev-commerce-store" />);
    expect(screen.getByAltText("Dev Embroidered Abaya")).toHaveAttribute(
      "src",
      "/api/v1/public/commerce-media/img-1",
    );
  });

  it("keeps price and previous price isolated and left-to-right", () => {
    renderCard(<ProductCard product={product} storeSlug="dev-commerce-store" />);
    const price = screen.getByText("AED 249.00");
    const was = screen.getByText("AED 299.00");
    expect(price.tagName).toBe("BDI");
    expect(price).toHaveAttribute("dir", "ltr");
    expect(was).toHaveAttribute("dir", "ltr");
  });

  it("survives an Arabic interface without reordering the price", async () => {
    await storeI18n.changeLanguage("ar");
    renderCard(<ProductCard product={product} storeSlug="dev-commerce-store" />);
    // Trader content is untranslated; the price stays one readable unit.
    expect(screen.getByText("Dev Embroidered Abaya")).toBeInTheDocument();
    expect(screen.getByText("AED 249.00")).toHaveAttribute("dir", "ltr");
  });

  it("badges an unavailable Product with a localized label", async () => {
    await storeI18n.changeLanguage("ar");
    renderCard(
      <ProductCard
        product={{ ...product, availabilityStatus: "unavailable" }}
        storeSlug="dev-commerce-store"
      />,
    );
    expect(screen.getByText("غير متوفر حاليًا")).toBeInTheDocument();
  });

  it("omits the previous price when there is no discount", () => {
    renderCard(
      <ProductCard product={{ ...product, previousPrice: null }} storeSlug="dev-commerce-store" />,
    );
    expect(screen.queryByText("AED 299.00")).not.toBeInTheDocument();
  });
});
