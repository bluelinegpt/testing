import {
  canonicalUrl,
  localeAlternates,
  categoryIndexSeoDocument,
  marketplaceSeoDocument,
  normaliseOrigin,
  notFoundSeoDocument,
  productSeoDocument,
  storeSeoDocument,
  taxonomySeoDocument,
} from "./seo-document.js";
import { escapeHtml, escapeJsonLd, injectMetadata, renderMetadata } from "./render-metadata.js";

/**
 * Metadata generation.
 *
 * The escaping cases at the bottom are the ones that matter most. Store and
 * Product text is written by Traders and lands inside `<title>`, inside
 * attribute values, and inside a `<script>` block — three different contexts
 * with three different rules. An escaper that looks correct but replaces `<`
 * with `<` passes every test that only checks the happy path, so these assert
 * the absence of raw markup rather than the presence of nice output.
 */

const origin = "https://store.bluelinegpt.com";
const siteName = "TawseelHub Store";

const store = {
  displayName: "Dev Commerce Store",
  logoUrl: "/api/v1/public/commerce-media/logo-1",
  publicMobile: "+971500000000",
  seoDescriptionAr: null,
  seoDescriptionEn: null,
  seoIndexable: true,
  seoTitleAr: null,
  seoTitleEn: null,
  slug: "dev-commerce-store",
  socialImageUrl: null,
  storeDescription: "Development Commerce store.",
};

const product = {
  availabilityStatus: "available",
  brand: "Dev Brand",
  currency: "AED",
  fullDescription: "Long copy.",
  lifecycleStatus: "active",
  media: [{ altText: null, url: "/api/v1/public/commerce-media/img-1" }],
  name: "Dev Embroidered Abaya",
  productCode: "DEV-ABAYA-0001",
  sellingPrice: "249.00",
  seoDescriptionAr: null,
  seoDescriptionEn: null,
  seoIndexable: true,
  seoTitleAr: null,
  seoTitleEn: null,
  shortDescription: "Hand-finished development sample.",
  slug: "dev-embroidered-abaya",
};

const fashion = {
  descriptionEn: "Clothing and abayas.",
  nameAr: "أزياء",
  nameEn: "Fashion",
  seoIndexable: true,
  slug: "fashion",
};

describe("origin and canonical", () => {
  it("strips any path, query or fragment from the configured origin", () => {
    expect(normaliseOrigin("https://store.bluelinegpt.com/some/path?a=1#x")).toBe(origin);
  });

  it("refuses an origin that is not a usable http(s) URL", () => {
    // Failing at startup beats emitting somebody else's hostname in every
    // canonical tag on the site.
    expect(() => normaliseOrigin("not a url")).toThrow();
    expect(() => normaliseOrigin("ftp://example.test")).toThrow();
  });

  it("drops query strings from canonical URLs", () => {
    // Tracking parameters and filter state do not create new documents.
    expect(canonicalUrl(origin, "en", "shop?utm_source=whatsapp&sort=price")).toBe(
      `${origin}/en/shop`,
    );
  });

  it("emits en, ar and x-default alternates", () => {
    expect(localeAlternates(origin, "shop")).toStrictEqual([
      { href: `${origin}/en/shop`, hrefLang: "en" },
      { href: `${origin}/ar/shop`, hrefLang: "ar" },
      { href: `${origin}/en/shop`, hrefLang: "x-default" },
    ]);
  });
});

describe("Store metadata", () => {
  it("falls back to the Store name and description when no override exists", () => {
    const document = storeSeoDocument({ locale: "en", origin, siteName, store });
    expect(document.title).toBe("Dev Commerce Store");
    expect(document.description).toBe("Development Commerce store.");
    expect(document.canonical).toBe(`${origin}/en/dev-commerce-store`);
    expect(document.robots).toBe("index,follow");
  });

  it("prefers an explicit override", () => {
    const document = storeSeoDocument({
      locale: "en",
      origin,
      siteName,
      store: { ...store, seoTitleEn: "Best abayas in Dubai" },
    });
    expect(document.title).toBe("Best abayas in Dubai");
  });

  it("uses the Arabic override in Arabic and falls back to English otherwise", () => {
    expect(
      storeSeoDocument({
        locale: "ar",
        origin,
        siteName,
        store: { ...store, seoTitleAr: "أفضل العبايات" },
      }).title,
    ).toBe("أفضل العبايات");
    // No Arabic override and no Arabic display name: English, not a translation
    // nobody wrote.
    expect(storeSeoDocument({ locale: "ar", origin, siteName, store }).title).toBe(
      "Dev Commerce Store",
    );
  });

  it("omits the description rather than inventing one", () => {
    const document = storeSeoDocument({
      locale: "en",
      origin,
      siteName,
      store: { ...store, storeDescription: null },
    });
    expect(document.description).toBeNull();
    expect(renderMetadata(document)).not.toContain('name="description"');
  });

  it("marks a Store noindex when its owner opted out", () => {
    expect(
      storeSeoDocument({ locale: "en", origin, siteName, store: { ...store, seoIndexable: false } })
        .robots,
    ).toBe("noindex,follow");
  });

  it("makes the social image absolute", () => {
    const document = storeSeoDocument({ locale: "en", origin, siteName, store });
    expect(document.imageUrl).toBe(`${origin}/api/v1/public/commerce-media/logo-1`);
  });
});

describe("Product metadata", () => {
  it("titles a Product with its own name and the Store", () => {
    const document = productSeoDocument({ locale: "en", origin, product, siteName, store });
    expect(document.title).toBe("Dev Embroidered Abaya — Dev Commerce Store");
    expect(document.description).toBe("Hand-finished development sample.");
    expect(document.canonical).toBe(
      `${origin}/en/dev-commerce-store/products/dev-embroidered-abaya`,
    );
  });

  it("uses the Product's own first image for the share card", () => {
    const document = productSeoDocument({ locale: "en", origin, product, siteName, store });
    expect(document.imageUrl).toBe(`${origin}/api/v1/public/commerce-media/img-1`);
  });

  it("falls back to the Store image when the Product has none", () => {
    const document = productSeoDocument({
      locale: "en",
      origin,
      product: { ...product, media: [] },
      siteName,
      store,
    });
    expect(document.imageUrl).toBe(`${origin}/api/v1/public/commerce-media/logo-1`);
  });

  it("emits AED price, availability and seller — and no rating", () => {
    const [entry] = productSeoDocument({ locale: "en", origin, product, siteName, store }).jsonLd;
    const offers = (entry as { offers: Record<string, unknown> }).offers;
    expect(offers.priceCurrency).toBe("AED");
    expect(offers.price).toBe("249.00");
    expect(offers.availability).toBe("https://schema.org/InStock");
    // There is no rating data in this system; inventing one to earn a rich
    // result would be a lie told at scale.
    expect(entry).not.toHaveProperty("aggregateRating");
    expect(entry).not.toHaveProperty("review");
  });

  it("marks an unavailable Product OutOfStock but keeps it indexable", () => {
    const document = productSeoDocument({
      locale: "en",
      origin,
      product: { ...product, availabilityStatus: "unavailable" },
      siteName,
      store,
    });
    const offers = (document.jsonLd[0] as { offers: Record<string, unknown> }).offers;
    expect(offers.availability).toBe("https://schema.org/OutOfStock");
    // The public Store shows it and labels it, so the page is still a real page.
    expect(document.robots).toBe("index,follow");
  });

  it("never indexes a draft Product", () => {
    expect(
      productSeoDocument({
        locale: "en",
        origin,
        product: { ...product, lifecycleStatus: "draft" },
        siteName,
        store,
      }).robots,
    ).toBe("noindex,follow");
  });
});

describe("Taxonomy metadata", () => {
  it("uses the Category name and a breadcrumb trail", () => {
    const document = taxonomySeoDocument({ category: fashion, locale: "en", origin, siteName });
    expect(document.title).toBe("Fashion");
    expect(document.canonical).toBe(`${origin}/en/categories/fashion`);
    expect((document.jsonLd[0] as { "@type": string })["@type"]).toBe("BreadcrumbList");
  });

  it("uses the Arabic name when browsing in Arabic", () => {
    expect(
      taxonomySeoDocument({ category: fashion, locale: "ar", origin, siteName }).title,
    ).toBe("أزياء");
  });

  it("canonicalises a Subcategory under its parent", () => {
    const document = taxonomySeoDocument({
      category: fashion,
      locale: "en",
      origin,
      siteName,
      subcategory: { nameEn: "Abayas", seoIndexable: true, slug: "abayas" },
    });
    expect(document.canonical).toBe(`${origin}/en/categories/fashion/abayas`);
    expect(document.title).toBe("Abayas");
    // No ItemList of Products: the page is paged, so listing "the" Products
    // would describe only whichever page happened to render.
    expect(document.jsonLd.some((entry) => entry["@type"] === "ItemList")).toBe(false);
  });
});

describe("Marketplace and not-found", () => {
  it("describes the marketplace root", () => {
    const document = marketplaceSeoDocument({ locale: "en", origin, siteName });
    expect(document.canonical).toBe(`${origin}/en`);
    expect(document.robots).toBe("index,follow");
  });

  it("makes the Category index indexable, not a not-found page", () => {
    // It is listed in the sitemap. Publishing it as noindex would ask a crawler
    // to fetch a page and then throw it away.
    const document = categoryIndexSeoDocument({ locale: "en", origin, siteName });
    expect(document.robots).toBe("index,follow");
    expect(document.canonical).toBe(`${origin}/en/categories`);
    expect(document.title).toBe("Categories");
  });

  it("titles the Category index in Arabic", () => {
    expect(categoryIndexSeoDocument({ locale: "ar", origin, siteName }).canonical).toBe(
      `${origin}/ar/categories`,
    );
  });

  it("never indexes a missing page", () => {
    expect(notFoundSeoDocument({ locale: "en", origin, path: "ghost", siteName }).robots).toBe(
      "noindex,nofollow",
    );
  });
});

describe("Escaping hostile Trader text", () => {
  const hostile = 'Mo"s </script><script>alert(1)</script> & <Boutique>';

  it("escapes HTML text and attribute values", () => {
    const escaped = escapeHtml(hostile);
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
    expect(escaped).not.toContain('"');
  });

  it("leaves no character the HTML tokeniser can act on inside JSON-LD", () => {
    const output = escapeJsonLd({ name: hostile });
    // The failure this guards against: an escaper that replaces "<" with "<".
    expect(output).not.toContain("</script>");
    expect(output).not.toContain("<");
    expect(output).not.toContain(">");
    expect(output).not.toContain("&");
  });

  it("keeps the JSON semantically identical after escaping", () => {
    const output = escapeJsonLd({ name: hostile });
    const decoded = output
      .replace(/\\u003c/g, "<")
      .replace(/\\u003e/g, ">")
      .replace(/\\u0026/g, "&");
    expect((JSON.parse(decoded) as { name: string }).name).toBe(hostile);
  });

  it("cannot break out of the title or the script block in a rendered document", () => {
    const document = storeSeoDocument({
      locale: "en",
      origin,
      siteName,
      store: { ...store, displayName: hostile, storeDescription: hostile },
    });
    const html = renderMetadata(document);
    expect(html).not.toContain("<script>alert(1)</script>");
    // Exactly the JSON-LD scripts this document declares, and no more.
    expect(html.match(/<script/g)).toHaveLength(document.jsonLd.length);
  });
});

describe("Shell injection", () => {
  const shell =
    '<!doctype html><html lang="en" dir="ltr"><head><meta charset="UTF-8" /><title>TawseelHub Store</title></head><body></body></html>';

  it("replaces the shell title rather than adding a second one", () => {
    const document = storeSeoDocument({ locale: "en", origin, siteName, store });
    const html = injectMetadata(shell, document);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain("<title>Dev Commerce Store</title>");
  });

  it("sets lang and dir for Arabic before any script runs", () => {
    const document = storeSeoDocument({ locale: "ar", origin, siteName, store });
    const html = injectMetadata(shell, document);
    expect(html).toContain('<html lang="ar" dir="rtl">');
  });
});
