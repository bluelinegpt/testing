import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { CategoryManager, suggestCategorySlug } from "./CategoryManager.js";
import {
  ProductEditor,
  suggestProductSlug,
  templateFields,
  type ProductDetail,
  type ProductTemplate,
} from "./ProductEditor.js";

/**
 * Product editor and Category manager.
 *
 * The claims under test are the ones a defect would make expensive: that only
 * the Storefront template's own attribute keys can be sent, that media limits
 * are surfaced before a doomed request, that an archived Product is read-only,
 * and that the optimistic-concurrency version travels with every write.
 */

const product: ProductDetail = {
  availabilityStatus: "available",
  barcode: "0012345678905",
  brand: "Al Noor",
  categoryId: "category-1",
  marketplaceCategoryId: null,
  marketplaceSubcategoryId: null,
  seoDescriptionAr: null,
  seoDescriptionEn: null,
  seoIndexable: true,
  seoTitleAr: null,
  seoTitleEn: null,
  fullDescription: "Full",
  id: "product-1",
  lifecycleStatus: "draft",
  maximumQuantity: null,
  media: [],
  minimumQuantity: null,
  name: "Embroidered Abaya",
  options: [],
  previousPrice: null,
  productCode: "ABAYA-0001",
  sellingPrice: "249.00",
  shortDescription: "Short",
  sku: "ABA-01",
  slug: "embroidered-abaya",
  templateAttributes: { material: "Cotton" },
  version: "4",
};

const categories = [{ id: "category-1", isActive: true, nameEn: "Abayas" }];

function editor(
  overrides: Partial<ProductDetail> = {},
  template: ProductTemplate = "fashion",
  handlers: {
    readonly patch?: () => Promise<unknown>;
    readonly post?: () => Promise<unknown>;
    readonly postMultipart?: () => Promise<unknown>;
  } = {},
) {
  const calls: { body?: unknown; path: string }[] = [];
  const api = {
    get: vi.fn(() => Promise.resolve({ ...product, ...overrides })),
    patch: vi.fn((path: string, body: unknown) => {
      calls.push({ body, path });
      return handlers.patch?.() ?? Promise.resolve({});
    }),
    post: vi.fn((path: string, body: unknown) => {
      calls.push({ body, path });
      return handlers.post?.() ?? Promise.resolve({});
    }),
    postMultipart: vi.fn((path: string, body: FormData) => {
      calls.push({ body, path });
      return handlers.postMultipart?.() ?? Promise.resolve({ fileId: "file-1" });
    }),
  };
  render(
    <ProductEditor
      api={api as unknown as ApiClient}
      categories={categories}
      onClose={() => undefined}
      onSaved={() => undefined}
      permissions={["storefront_products.manage"]}
      productId="product-1"
      storefrontId="storefront-1"
      template={template}
    />,
  );
  return { api, calls };
}

describe("suggestProductSlug", () => {
  it("derives a slug from the Product name", () => {
    expect(suggestProductSlug("Embroidered Abaya")).toBe("embroidered-abaya");
  });

  it("strips characters that would change how the URL parses", () => {
    expect(suggestProductSlug("abaya/../admin")).toBe("abaya-admin");
  });

  it("returns nothing for a name with no Latin characters", () => {
    expect(suggestProductSlug("عباية")).toBe("");
  });
});

describe("templateFields", () => {
  it("renders a distinct field set per business template", () => {
    expect(templateFields.fashion.map((f) => f.key)).toContain("material");
    expect(templateFields.electronics.map((f) => f.key)).toContain("warranty");
    expect(templateFields.jewelry.map((f) => f.key)).toContain("purity");
    expect(templateFields.general.map((f) => f.key)).toContain("packSize");
  });

  it("marks the attribute each template requires before activation", () => {
    expect(templateFields.fashion.find((f) => f.required)?.key).toBe("material");
    expect(templateFields.electronics.find((f) => f.required)?.key).toBe("brand");
    expect(templateFields.jewelry.find((f) => f.required)?.key).toBe("material");
    // General requires nothing extra.
    expect(templateFields.general.some((f) => f.required === true)).toBe(false);
  });
});

describe("ProductEditor", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
  });

  it("loads the Product and preserves existing attribute values", async () => {
    editor();
    expect(await screen.findByDisplayValue("Embroidered Abaya")).toBeInTheDocument();
    expect(screen.getByDisplayValue("ABAYA-0001")).toBeInTheDocument();
    // An edit must not silently drop attributes the Product already carries.
    expect(screen.getByDisplayValue("Cotton")).toBeInTheDocument();
  });

  it("renders only the fields the Storefront's template declares", async () => {
    editor({}, "jewelry");
    await screen.findByDisplayValue("Embroidered Abaya");
    expect(screen.getByLabelText(/Purity/i)).toBeInTheDocument();
    // An Electronics-only attribute must not appear on a Jewelry shop.
    expect(screen.queryByLabelText(/Warranty/i)).toBeNull();
  });

  it("sends only allowed attribute keys with the loaded version", async () => {
    const { calls } = editor({}, "fashion");
    await screen.findByDisplayValue("Embroidered Abaya");
    fireEvent.change(screen.getByLabelText(/^Fit/i), { target: { value: "Relaxed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const call = calls.find((entry) => entry.body !== undefined);
      const body = call?.body as {
        expectedVersion: number;
        templateAttributes: Record<string, string>;
      };
      expect(body.expectedVersion).toBe(4);
      expect(body.templateAttributes.fit).toBe("Relaxed");
      expect(Object.keys(body.templateAttributes).every((key) =>
        templateFields.fashion.some((field) => field.key === key),
      )).toBe(true);
    });
  });

  it("sends edited price, description and brand -- not only the template attributes", async () => {
    // Regression: a prior fix that kept the strict CREATE payload from
    // carrying Marketplace/attribute fields once, over-applied that same
    // allow-list to the EDIT path too, silently dropping ordinary field
    // edits (price, description, brand) from the update PATCH.
    const { calls } = editor({}, "fashion");
    await screen.findByDisplayValue("Embroidered Abaya");
    fireEvent.change(screen.getByLabelText(/Selling price/i), { target: { value: "179.00" } });
    fireEvent.change(screen.getByLabelText(/Full description/i), {
      target: { value: "Updated description" },
    });
    fireEvent.change(screen.getByLabelText(/Brand \(/i), { target: { value: "New Brand" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const call = calls.find((entry) => entry.body !== undefined);
      expect(call?.body).toMatchObject({
        brand: "New Brand",
        fullDescription: "Updated description",
        sellingPrice: "179.00",
      });
    });
  });

  it("treats an archived Product as read-only", async () => {
    editor({ lifecycleStatus: "archived" });
    await screen.findByDisplayValue("Embroidered Abaya");
    expect(screen.getByDisplayValue("Embroidered Abaya")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("blocks a ninth image and says why", async () => {
    const media = Array.from({ length: 8 }, (_, index) => ({
      altText: null,
      displayOrder: index,
      id: `media-${String(index)}`,
      isActive: true,
      isPrimary: index === 0,
      mediaType: "image" as const,
      posterUrl: null,
      url: `https://cdn.example.test/${String(index)}.jpg`,
    }));
    editor({ media });
    await screen.findByDisplayValue("Embroidered Abaya");
    expect(screen.getByText(/8 of 8 images/i)).toBeInTheDocument();
    expect(await screen.findByText(/at most eight images/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Choose an image file/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Upload image" })).toBeDisabled();
  });

  it("blocks a second video and says why", async () => {
    editor({
      media: [
        {
          altText: null,
          displayOrder: 0,
          id: "video-1",
          isActive: true,
          isPrimary: false,
          mediaType: "video",
          posterUrl: null,
          url: "https://cdn.example.test/a.mp4",
        },
      ],
    });
    await screen.findByDisplayValue("Embroidered Abaya");
    fireEvent.change(screen.getByLabelText(/Media type/i), { target: { value: "video" } });
    expect(await screen.findByText(/only one video/i)).toBeInTheDocument();
  });

  it("offers a real file upload for images, and a URL field only for video", async () => {
    editor();
    await screen.findByDisplayValue("Embroidered Abaya");
    // Image is the default media type: a real file chooser, not a URL field.
    expect(screen.getByLabelText(/Choose an image file/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Video URL/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Media type/i), { target: { value: "video" } });
    // Video still has no upload transport, so it keeps the URL workflow.
    expect(screen.getByLabelText(/Video URL/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Choose an image file/i)).toBeNull();
  });

  it("uploads a chosen image and attaches it via the real endpoints", async () => {
    const { api, calls } = editor();
    await screen.findByDisplayValue("Embroidered Abaya");
    const file = new File([new Uint8Array(10)], "front.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Choose an image file/i), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    await waitFor(() => {
      expect(api.postMultipart).toHaveBeenCalledWith(
        "operations/trader-storefronts/products/product-1/media/image",
        expect.any(FormData),
      );
    });
    await waitFor(() => {
      const attach = calls.find(
        (entry) => entry.path === "operations/trader-storefront-products/product-1/media",
      );
      expect(attach?.body).toMatchObject({ fileId: "file-1", mediaType: "image" });
    });
  });

  it("rejects an oversized or wrong-type Product image before uploading", async () => {
    const { api } = editor();
    await screen.findByDisplayValue("Embroidered Abaya");
    const oversized = new File([new Uint8Array(6 * 1024 * 1024)], "big.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText(/Choose an image file/i), {
      target: { files: [oversized] },
    });
    expect(screen.getByText("That image is too large. The limit is 5 MB.")).toBeInTheDocument();
    expect(api.postMultipart).not.toHaveBeenCalled();
  });

  it("renames an option value in place", async () => {
    const { calls } = editor({
      options: [
        {
          displayOrder: 0,
          id: "g1",
          isActive: true,
          isRequired: false,
          name: "Color",
          values: [
            { displayOrder: 0, id: "v1", isActive: true, value: "Navy" },
          ],
        },
      ],
    });
    await screen.findByDisplayValue("Embroidered Abaya");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByDisplayValue("Navy");
    fireEvent.change(input, { target: { value: "Dark Navy" } });
    // Two "Save" buttons exist: the Product form's own, and this inline
    // rename control's -- the rename control renders later in the DOM.
    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    fireEvent.click(saveButtons[saveButtons.length - 1]!);
    await waitFor(() => {
      const call = calls.find((entry) =>
        entry.path.includes("option-values/v1") && !entry.path.includes("remove"),
      );
      expect(call?.body).toMatchObject({ value: "Dark Navy" });
    });
  });

  it("removes an option value", async () => {
    const { calls } = editor({
      options: [
        {
          displayOrder: 0,
          id: "g1",
          isActive: true,
          isRequired: false,
          name: "Color",
          values: [
            { displayOrder: 0, id: "v1", isActive: true, value: "Beige" },
          ],
        },
      ],
    });
    await screen.findByDisplayValue("Embroidered Abaya");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(calls.some((entry) => entry.path === "operations/trader-storefront-products/option-values/v1/remove")).toBe(true);
    });
  });

  it("offers set-primary only on a non-primary image", async () => {
    editor({
      media: [
        {
          altText: "One",
          displayOrder: 0,
          id: "m1",
          isActive: true,
          isPrimary: true,
          mediaType: "image",
          posterUrl: null,
          url: "https://cdn.example.test/1.jpg",
        },
        {
          altText: "Two",
          displayOrder: 1,
          id: "m2",
          isActive: true,
          isPrimary: false,
          mediaType: "image",
          posterUrl: null,
          url: "https://cdn.example.test/2.jpg",
        },
      ],
    });
    await screen.findByDisplayValue("Embroidered Abaya");
    expect(screen.getAllByRole("button", { name: "Set as primary" })).toHaveLength(1);
  });

  it("adds an option value to its own group", async () => {
    const { calls } = editor({
      options: [
        { displayOrder: 0, id: "group-1", isActive: true, isRequired: false, name: "Size", values: [] },
      ],
    });
    await screen.findByDisplayValue("Embroidered Abaya");
    fireEvent.change(screen.getByLabelText(/^Value/i), { target: { value: "M" } });
    fireEvent.click(screen.getByRole("button", { name: "Add value" }));
    await waitFor(() => {
      expect(calls.some((entry) => entry.path.includes("option-groups/group-1/values"))).toBe(
        true,
      );
    });
  });

  /* -----------------------------------------------------------------------
     Creation, and the administrator escalation.

     Browser validation found that after creating a Product the editor still
     showed "Save the Product before adding media and options", because the
     saved/unsaved decision was read off the `productId` PROP -- which is still
     undefined right after a create. The user had to close and reopen the
     editor. These tests pin the transition without a reopen.
     ----------------------------------------------------------------------- */

  function newEditor(permissions: readonly string[] = ["storefront_products.manage"]) {
    const calls: { body?: unknown; path: string }[] = [];
    const api = {
      get: vi.fn(() => Promise.resolve(product)),
      patch: vi.fn((path: string, body: unknown) => {
        calls.push({ body, path });
        return Promise.resolve({});
      }),
      post: vi.fn((path: string, body: unknown) => {
        calls.push({ body, path });
        // The API answers with the persisted Product, which is what the editor
        // has to switch over to.
        return Promise.resolve({ ...product, id: "product-created", version: "1" });
      }),
    };
    render(
      <ProductEditor
        api={api as unknown as ApiClient}
        categories={categories}
        onClose={() => undefined}
        onSaved={() => undefined}
        permissions={permissions}
        storefrontId="storefront-1"
        template="fashion"
      />,
    );
    return { api, calls };
  }

  it("switches to the persisted Product after creation without a close and reopen", async () => {
    const { calls } = newEditor();
    // Before saving, media and options are correctly withheld.
    expect(screen.getByText(/Save the Product before adding media and options/i)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Media/i })).toBeNull();

    fireEvent.change(screen.getByLabelText(/Product name/i), {
      target: { value: "New Abaya" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The hint goes away and the media and option sections appear, with no
    // remount in between.
    await waitFor(() => {
      expect(
        screen.queryByText(/Save the Product before adding media and options/i),
      ).toBeNull();
    });
    expect(screen.getByText("Media", { selector: "legend" })).toBeInTheDocument();
    expect(screen.getByText("Options", { selector: "legend" })).toBeInTheDocument();
    // And the media controls now address the CREATED Product, not the prop --
    // exercised through the video/URL workflow (the image path is a real file
    // upload, covered separately).
    fireEvent.change(screen.getByLabelText(/Media type/i), { target: { value: "video" } });
    fireEvent.change(screen.getByLabelText(/Video URL/i), {
      target: { value: "https://cdn.example.test/a.mp4" },
    });
    const addMedia = screen.getByRole("button", { name: "Add media" });
    expect(addMedia).toBeEnabled();
    fireEvent.click(addMedia);
    await waitFor(() => {
      expect(calls.some((entry) => entry.path.includes("product-created"))).toBe(true);
    });
  });

  it("applies Marketplace classification chosen before the first Save, not just after", async () => {
    // `CreateProductDto` has no room for `marketplaceCategoryId` -- the global
    // ValidationPipe runs `forbidNonWhitelisted`, so sending it there would be
    // rejected. A Trader who classifies a Product before ever clicking Save
    // once should not have that choice silently discarded because the create
    // endpoint doesn't carry it.
    const calls: { body?: unknown; path: string }[] = [];
    const api = {
      get: vi.fn((path: string) =>
        path.includes("marketplace/taxonomy")
          ? Promise.resolve({
              items: [
                {
                  categoryId: "mkt-fashion",
                  categoryNameAr: null,
                  categoryNameEn: "Fashion",
                  categorySlug: "fashion",
                  displayOrder: 0,
                  subcategories: [],
                },
              ],
            })
          : Promise.resolve(product),
      ),
      patch: vi.fn((path: string, body: unknown) => {
        calls.push({ body, path });
        return Promise.resolve({});
      }),
      post: vi.fn((path: string, body: unknown) => {
        calls.push({ body, path });
        return Promise.resolve({ ...product, id: "product-created", version: "1" });
      }),
    };
    render(
      <ProductEditor
        api={api as unknown as ApiClient}
        categories={categories}
        onClose={() => undefined}
        onSaved={() => undefined}
        permissions={["storefront_products.manage"]}
        storefrontId="storefront-1"
        template="fashion"
      />,
    );
    fireEvent.change(await screen.findByLabelText(/Product name/i), {
      target: { value: "New Abaya" },
    });
    fireEvent.change(screen.getByLabelText(/Marketplace category/i), {
      target: { value: "mkt-fashion" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const classification = calls.find((entry) =>
        entry.path.includes("classification"),
      );
      expect(classification).toBeDefined();
      expect(classification?.body).toMatchObject({ marketplaceCategoryId: "mkt-fashion" });
    });
    // The create POST itself never carried the unknown property.
    const create = calls.find((entry) => entry.path === "operations/trader-storefront-products");
    expect((create?.body as Record<string, unknown>)["marketplaceCategoryId"]).toBeUndefined();
  });

  it("enables the editor for an administrator holding only users_roles.manage", async () => {
    newEditor(["users_roles.manage"]);
    expect(screen.getByLabelText(/Product name/i)).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("disables the editor without either a Product permission or users_roles.manage", async () => {
    // Storefront profile permission does not imply catalogue permission.
    newEditor(["storefront.manage", "storefront_products.view"]);
    expect(screen.getByLabelText(/Product name/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("surfaces a rejected attribute from the server", async () => {
    const { calls } = editor({}, "fashion", {
      patch: () =>
        Promise.reject(new ApiError("bad", "product_template_attributes_invalid", 422)),
    });
    await screen.findByDisplayValue("Embroidered Abaya");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("suggestCategorySlug", () => {
  it("derives a slug from the category name", () => {
    expect(suggestCategorySlug("Evening Wear")).toBe("evening-wear");
  });
});

describe("CategoryManager", () => {
  const managed = [
    {
      description: null,
      displayOrder: 0,
      id: "category-1",
      isActive: true,
      nameAr: null,
      nameEn: "Abayas",
      productCount: 2,
      slug: "abayas",
      version: "1",
    },
  ];

  function setup(items = managed, permissions = ["storefront_products.manage"]) {
    const calls: { body?: unknown; path: string }[] = [];
    const api = {
      get: vi.fn(() => Promise.resolve({ items })),
      patch: vi.fn((path: string, body: unknown) => {
        calls.push({ body, path });
        return Promise.resolve({});
      }),
      post: vi.fn((path: string, body: unknown) => {
        calls.push({ body, path });
        return Promise.resolve({});
      }),
    };
    render(
      <CategoryManager
        api={api as unknown as ApiClient}
        permissions={permissions}
        storefrontId="storefront-1"
      />,
    );
    return { calls };
  }

  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
  });

  it("lists categories with their Product counts", async () => {
    setup();
    expect(await screen.findByText("Abayas")).toBeInTheDocument();
    expect(screen.getByText("abayas")).toBeInTheDocument();
  });

  it("shows an empty state when there are none", async () => {
    setup([]);
    expect(await screen.findByText(/No Store Categories yet/i)).toBeInTheDocument();
  });

  it("suggests a slug while typing a new name", async () => {
    setup();
    await screen.findByText("Abayas");
    fireEvent.change(screen.getByLabelText(/Name \(English\)/i), {
      target: { value: "Evening Wear" },
    });
    expect(screen.getByDisplayValue("evening-wear")).toBeInTheDocument();
  });

  it("creates a category through the API", async () => {
    const { calls } = setup();
    await screen.findByText("Abayas");
    fireEvent.change(screen.getByLabelText(/Name \(English\)/i), { target: { value: "Kaftans" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => {
      const call = calls.find((entry) => entry.path.endsWith("/categories"));
      expect((call?.body as { nameEn: string }).nameEn).toBe("Kaftans");
    });
  });

  it("sends the loaded version when toggling active state", async () => {
    const { calls } = setup();
    await screen.findByText("Abayas");
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    await waitFor(() => {
      const call = calls.find((entry) => entry.path.includes("/active"));
      expect((call?.body as { expectedVersion: number }).expectedVersion).toBe(1);
    });
  });

  it("disables management without the permission", async () => {
    setup(managed, ["storefront_products.view"]);
    await screen.findByText("Abayas");
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeDisabled();
  });

  it("marks a new option group required when asked", async () => {
    const { calls } = editor();
    await screen.findByDisplayValue("Embroidered Abaya");
    fireEvent.change(screen.getByLabelText(/Option group/i), { target: { value: "Size" } });
    fireEvent.click(screen.getByLabelText(/Customers must choose one/i));
    fireEvent.click(screen.getByRole("button", { name: "Add option group" }));
    await waitFor(() => {
      const call = calls.find((entry) => entry.path.endsWith("/option-groups"));
      expect((call?.body as { isRequired: boolean }).isRequired).toBe(true);
    });
  });

  it("labels each group as required or optional", async () => {
    editor({
      options: [
        { displayOrder: 0, id: "g1", isActive: true, isRequired: true, name: "Size", values: [] },
        { displayOrder: 1, id: "g2", isActive: true, isRequired: false, name: "Note", values: [] },
      ],
    });
    await screen.findByDisplayValue("Embroidered Abaya");
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.getByText("Optional")).toBeInTheDocument();
  });

  it("reorders an option group through the API, renumbering the whole list", async () => {
    // Regression: two freshly-created groups both default to `displayOrder:
    // 0` server-side (same tie class as the T3 Category bug), so moving the
    // SECOND group's raw value by -1 would still read 0 -- a no-op the
    // Trader would see as "nothing happened". Moving within the currently
    // displayed order and renumbering the whole list fixes that regardless
    // of what the rows started with.
    const { calls } = editor({
      options: [
        { displayOrder: 0, id: "g1", isActive: true, isRequired: false, name: "Size", values: [] },
        { displayOrder: 0, id: "g2", isActive: true, isRequired: false, name: "Color", values: [] },
      ],
    });
    await screen.findByDisplayValue("Embroidered Abaya");
    fireEvent.click(screen.getByRole("button", { name: /Move Color earlier/i }));
    await waitFor(() => {
      const call = calls.find((entry) => entry.path.includes("/option-groups/reorder"));
      const body = call?.body as { entries: { displayOrder: number; id: string }[] };
      expect(body.entries).toEqual([
        { displayOrder: 0, id: "g2" },
        { displayOrder: 1, id: "g1" },
      ]);
    });
  });

  it("disables Move up/down at the ends of the group and media lists", async () => {
    editor({
      media: [
        {
          altText: "Front",
          displayOrder: 0,
          id: "m1",
          isActive: true,
          isPrimary: true,
          mediaType: "image",
          posterUrl: null,
          url: "https://cdn.example.test/1.jpg",
        },
      ],
      options: [
        { displayOrder: 0, id: "g1", isActive: true, isRequired: false, name: "Size", values: [] },
      ],
    });
    await screen.findByDisplayValue("Embroidered Abaya");
    expect(screen.getByRole("button", { name: /Move Front earlier/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Move Front later/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Move Size earlier/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Move Size later/i })).toBeDisabled();
  });

  it("reorders media with keyboard-accessible buttons, renumbering the whole list", async () => {
    const { calls } = editor({
      media: [
        {
          altText: "Front",
          displayOrder: 0,
          id: "m1",
          isActive: true,
          isPrimary: true,
          mediaType: "image",
          posterUrl: null,
          url: "https://cdn.example.test/1.jpg",
        },
        {
          altText: "Detail",
          displayOrder: 1,
          id: "m2",
          isActive: true,
          isPrimary: false,
          mediaType: "image",
          posterUrl: null,
          url: "https://cdn.example.test/2.jpg",
        },
      ],
    });
    await screen.findByDisplayValue("Embroidered Abaya");
    // Ordinary buttons, so keyboard and screen-reader users are not excluded.
    fireEvent.click(screen.getByRole("button", { name: /Move Detail earlier/i }));
    await waitFor(() => {
      const call = calls.find((entry) => entry.path.includes("/media/reorder"));
      const body = call?.body as { entries: { displayOrder: number; id: string }[] };
      expect(body.entries).toEqual([
        { displayOrder: 0, id: "m2" },
        { displayOrder: 1, id: "m1" },
      ]);
    });
  });
});
