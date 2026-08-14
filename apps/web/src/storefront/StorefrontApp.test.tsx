import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { StorefrontApp } from "./StorefrontApp.js";
import type {
  PublicProduct,
  PublicProductDetail,
  PublicStorefront,
  PublicStorefrontResult,
} from "./lib/public-storefront.js";

/**
 * The public Storefront, driven through its real routes with the public API
 * stubbed at the fetch boundary of `lib/public-storefront`.
 *
 * Every case here is a browser-only finding from Prompt 4C, where the screens
 * looked correct in isolation and were wrong once wired to a real Storefront:
 * a home page that rendered nothing because it was still reading a prototype
 * catalogue, a Product page that never called the detail endpoint, and a
 * detail effect that reset its own result on every render because it depended
 * on a route OBJECT rebuilt each time.
 *
 * The not-found cases matter for a different reason: draft, unpublished,
 * suspended and unknown addresses must be indistinguishable, or the page
 * confirms which slugs exist.
 */

const resolveMock = vi.fn<(slug: string, signal?: AbortSignal) => Promise<PublicStorefrontResult>>();
const productsMock =
  vi.fn<(slug: string, signal?: AbortSignal) => Promise<{ items: PublicProduct[] } | null>>();
const productMock =
  vi.fn<
    (store: string, slug: string, signal?: AbortSignal) => Promise<PublicProductDetail | null>
  >();

vi.mock("./lib/public-storefront.js", async () => {
  const actual =
    await vi.importActual<typeof import("./lib/public-storefront.js")>(
      "./lib/public-storefront.js",
    );
  return {
    ...actual,
    fetchPublicProduct: (store: string, slug: string, signal?: AbortSignal) =>
      productMock(store, slug, signal),
    fetchPublicProducts: (slug: string, signal?: AbortSignal) => productsMock(slug, signal),
    resolvePublicStorefront: (slug: string, signal?: AbortSignal) => resolveMock(slug, signal),
  };
});

const storefront: PublicStorefront = {
  brandAccentColor: null,
  brandPrimaryColor: null,
  businessHours: [],
  businessTemplate: "fashion",
  customerSupport: null,
  deliveryInformation: "Next-day delivery across the UAE",
  displayName: "Dev Validation Store",
  publicEmail: null,
  publicMobile: "+971500000010",
  publicWhatsapp: null,
  returnPolicy: "Returns accepted within 7 days",
  slug: "dev-validation-store",
  status: "published",
  storeDescription: "Contemporary modest fashion",
  terms: null,
  theme: "luxury_minimal",
};

const abaya: PublicProduct = {
  availabilityStatus: "available",
  categoryName: "Dev Abayas",
  categorySlug: "dev-abayas",
  currency: "AED",
  name: "Embroidered Abaya",
  previousPrice: null,
  primaryImage: { altText: "Front", url: "https://cdn.example.test/abaya.jpg" },
  productCode: "ABAYA-0001",
  sellingPrice: "249.00",
  shortDescription: "Hand-finished",
  slug: "embroidered-abaya",
  templateAttributes: { fabricWeight: "Medium", material: "Cotton" },
};

const kaftan: PublicProduct = {
  ...abaya,
  categoryName: "Dev Kaftans",
  categorySlug: "dev-kaftans",
  name: "Summer Kaftan",
  productCode: "KAFTAN-0001",
  sellingPrice: "199.00",
  slug: "summer-kaftan",
};

const abayaDetail: PublicProductDetail = {
  ...abaya,
  fullDescription: "A full description held only by the detail endpoint.",
  maximumQuantity: 5,
  media: [
    { altText: "Front", mediaType: "image", posterUrl: null, url: "https://cdn.example.test/abaya.jpg" },
    { altText: "Back", mediaType: "image", posterUrl: null, url: "https://cdn.example.test/abaya-2.jpg" },
    {
      altText: null,
      mediaType: "video",
      posterUrl: "https://cdn.example.test/poster.jpg",
      url: "https://cdn.example.test/abaya.mp4",
    },
  ],
  minimumQuantity: 1,
  options: [
    { isRequired: true, name: "Size", values: [{ value: "S" }, { value: "M" }] },
    { isRequired: false, name: "Colour", values: [{ value: "Black" }] },
  ],
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <StorefrontApp />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resolveMock.mockReset();
  productsMock.mockReset();
  productMock.mockReset();
  resolveMock.mockResolvedValue({ kind: "found", storefront });
  productsMock.mockResolvedValue({ items: [abaya, kaftan] });
  productMock.mockResolvedValue(abayaDetail);
});

describe("public Storefront home page", () => {
  it("renders the persisted Products rather than a prototype catalogue", async () => {
    renderAt("/store/dev-validation-store");
    expect(await screen.findByText("Embroidered Abaya")).toBeInTheDocument();
    expect(screen.getByText("Summer Kaftan")).toBeInTheDocument();
    // The real Storefront's own identity, not a sample Trader's.
    expect(screen.getAllByText(/Dev Validation Store/).length).toBeGreaterThan(0);
  });

  it("does not call a real Trader's shop a prototype showing sample data", async () => {
    renderAt("/store/dev-validation-store");
    await screen.findByText("Embroidered Abaya");
    // This shop is persisted and published. Telling its customers it is a
    // design prototype with sample data is untrue and damaging to the Trader.
    expect(screen.queryByText(/design prototype/i)).toBeNull();
    expect(screen.queryByText(/sample data only/i)).toBeNull();
    // The attribution itself stays.
    expect(screen.getByText(/Powered by Tawseelhub\.com/i)).toBeInTheDocument();
  });

  it("shows a genuinely empty catalogue as empty rather than as sample goods", async () => {
    productsMock.mockResolvedValue({ items: [] });
    renderAt("/store/dev-validation-store");
    await waitFor(() => {
      expect(screen.queryByText(/Loading store/i)).toBeNull();
    });
    expect(screen.queryByText("Embroidered Abaya")).toBeNull();
  });

  it("labels categories by name rather than by slug", async () => {
    renderAt("/store/dev-validation-store");
    await screen.findByText("Embroidered Abaya");
    expect(screen.getAllByText("Dev Abayas").length).toBeGreaterThan(0);
    // The slug form must never reach a customer.
    expect(screen.queryByText("dev-abayas")).toBeNull();
  });
});

describe("public Storefront Product detail", () => {
  it("fetches the detail endpoint and renders what only it carries", async () => {
    renderAt("/store/dev-validation-store/products/embroidered-abaya");
    await waitFor(() => {
      expect(productMock).toHaveBeenCalledWith(
        "dev-validation-store",
        "embroidered-abaya",
        expect.anything(),
      );
    });
    // The full description, the extra gallery image, the video and the option
    // groups exist ONLY on the detail record: the list item carries a single
    // primary image and no options at all.
    expect(
      await screen.findByText(/A full description held only by the detail endpoint/i),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll('img[src*="abaya-2.jpg"]').length).toBeGreaterThan(0);
    });
    expect(document.querySelectorAll('video, [src*="abaya.mp4"]').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Size/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Colour/).length).toBeGreaterThan(0);
  });

  it("marks a required option group and leaves an optional one unmarked", async () => {
    renderAt("/store/dev-validation-store/products/embroidered-abaya");
    const required = await screen.findByText(/Size\s*\*/);
    expect(required).toBeInTheDocument();
    expect(screen.queryByText(/Colour\s*\*/)).toBeNull();
  });

  it("renders template attributes with human-readable labels", async () => {
    renderAt("/store/dev-validation-store/products/embroidered-abaya");
    await screen.findByText(/A full description held only by the detail endpoint/i);
    // `fabricWeight` must reach the customer as words, not as a camel-case key.
    expect(screen.getByText(/Fabric weight/i)).toBeInTheDocument();
    expect(screen.queryByText("fabricWeight")).toBeNull();
  });

  it("fetches the detail exactly once and does not refetch on re-render", async () => {
    const { rerender } = renderAt("/store/dev-validation-store/products/embroidered-abaya");
    await screen.findByText(/A full description held only by the detail endpoint/i);
    const afterFirstPaint = productMock.mock.calls.length;
    expect(afterFirstPaint).toBe(1);

    // Re-rendering rebuilds the parsed route OBJECT. An effect depending on
    // that object re-ran every time and cleared the fetched detail before it
    // could be used, so the page flickered back to a bare list item forever.
    for (let index = 0; index < 3; index += 1) {
      rerender(
        <MemoryRouter initialEntries={["/store/dev-validation-store/products/embroidered-abaya"]}>
          <StorefrontApp />
        </MemoryRouter>,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(productMock.mock.calls.length).toBe(afterFirstPaint);
    expect(
      screen.getAllByText(/A full description held only by the detail endpoint/i).length,
    ).toBeGreaterThan(0);
  });
});

describe("public Storefront availability", () => {
  it("keeps a temporarily closed shop readable and says it is closed", async () => {
    resolveMock.mockResolvedValue({
      kind: "found",
      storefront: { ...storefront, status: "temporarily_closed" },
    });
    renderAt("/store/dev-validation-store");
    expect(await screen.findByText(/temporarily closed/i)).toBeInTheDocument();
    // Closed is not gone: the catalogue still renders.
    expect(screen.getByText("Embroidered Abaya")).toBeInTheDocument();
  });

  it("reports an unknown address as not found", async () => {
    resolveMock.mockResolvedValue({ kind: "not-found" });
    renderAt("/store/no-such-store");
    expect(await screen.findByText(/Store not found/i)).toBeInTheDocument();
  });

  it("gives draft, unpublished and suspended the SAME wording as unknown", async () => {
    // The API reports all four identically, so the page cannot tell them apart
    // even if it wanted to. This test pins that it does not try.
    const wordings: string[] = [];
    for (const slug of ["draft-shop", "unpublished-shop", "suspended-shop", "never-existed"]) {
      resolveMock.mockResolvedValue({ kind: "not-found" });
      const view = renderAt(`/store/${slug}`);
      const heading = await screen.findByText(/Store not found/i);
      wordings.push(heading.parentElement?.textContent ?? "");
      view.unmount();
    }
    expect(new Set(wordings).size).toBe(1);
  });

  it("distinguishes a transport failure from a missing shop", async () => {
    // "Unavailable" rather than "not found": the shop may be perfectly fine and
    // the network was not, and telling a customer it does not exist is wrong.
    resolveMock.mockResolvedValue({ kind: "error" });
    renderAt("/store/dev-validation-store");
    expect(await screen.findByText(/Store unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/Store not found/i)).toBeNull();
  });
});
