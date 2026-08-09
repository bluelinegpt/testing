import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import {
  ProductCatalogueWorkspace,
  type CatalogueProduct,
} from "./ProductCatalogueWorkspace.js";

/**
 * Product Catalogue workspace behaviour, with the API stubbed at the client
 * boundary.
 *
 * The claims under test are the ones a defect would make expensive: that the
 * screen never offers an action the backend would refuse, that an archived
 * Product is treated as read-only, that server-side validation is surfaced as
 * a field problem rather than a crash, and that the optimistic-concurrency
 * version travels with every write.
 */

const product: CatalogueProduct = {
  availabilityStatus: "available",
  categoryId: "category-1",
  categoryName: "Abayas",
  displayOrder: 0,
  id: "product-1",
  imageCount: 2,
  lifecycleStatus: "draft",
  name: "Embroidered Abaya",
  previousPrice: null,
  productCode: "ABAYA-0001",
  sellingPrice: "249.00",
  slug: "embroidered-abaya",
  templateAttributes: { material: "Cotton" },
  version: "3",
};

function setup(
  overrides: Partial<CatalogueProduct> = {},
  permissions: readonly string[] = [
    "storefront_products.manage",
    "storefront_products.publish",
  ],
  handlers: { readonly post?: (path: string, body: unknown) => Promise<unknown> } = {},
  items?: readonly CatalogueProduct[],
) {
  const calls: { body?: unknown; path: string }[] = [];
  const rows = items ?? [{ ...product, ...overrides }];
  const api = {
    get: vi.fn((path: string) => {
      calls.push({ path });
      if (path.includes("/categories")) {
        return Promise.resolve({
          items: [
            { id: "category-1", isActive: true, nameEn: "Abayas", productCount: 1, slug: "abayas", version: "1" },
          ],
        });
      }
      return Promise.resolve({ items: rows, total: rows.length });
    }),
    post: vi.fn((path: string, body: unknown) => {
      calls.push({ body, path });
      return handlers.post?.(path, body) ?? Promise.resolve({});
    }),
  };
  render(
    <ProductCatalogueWorkspace
      api={api as unknown as ApiClient}
      permissions={permissions}
      storefrontId="storefront-1"
    />,
  );
  return { api, calls };
}

describe("ProductCatalogueWorkspace", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
  });

  it("lists Products with code, price and status", async () => {
    setup();
    expect(await screen.findByText("Embroidered Abaya")).toBeInTheDocument();
    expect(screen.getByText("ABAYA-0001")).toBeInTheDocument();
    expect(screen.getByText("AED 249.00")).toBeInTheDocument();
    // "Draft" also appears in the status filter, so assert on the row's badge.
    const row = screen.getByText("Embroidered Abaya").closest("tr")!;
    expect(within(row).getByText("Draft")).toBeInTheDocument();
    expect(within(row).getByText("Available")).toBeInTheDocument();
  });

  it("offers only the lifecycle actions the current status permits", async () => {
    setup();
    await screen.findByText("Embroidered Abaya");
    // A draft may be activated or archived; it cannot be deactivated.
    expect(screen.getByRole("button", { name: "Activate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
  });

  it("offers deactivate once active", async () => {
    setup({ lifecycleStatus: "active" });
    await screen.findByText("Embroidered Abaya");
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
  });

  it("offers no action at all on an archived Product", async () => {
    setup({ lifecycleStatus: "archived" });
    await screen.findByText("Embroidered Abaya");
    // Archived is terminal and read-only, including availability.
    for (const label of ["Activate", "Deactivate", "Archive", "Mark unavailable"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("sends the loaded version with a lifecycle action", async () => {
    const { calls } = setup();
    await screen.findByText("Embroidered Abaya");
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() => {
      const call = calls.find((entry) => entry.path.endsWith("/activate"));
      expect((call?.body as { expectedVersion: number }).expectedVersion).toBe(3);
    });
  });

  it("toggles availability through the API rather than locally", async () => {
    const { calls } = setup();
    await screen.findByText("Embroidered Abaya");
    fireEvent.click(screen.getByRole("button", { name: "Mark unavailable" }));
    await waitFor(() => {
      const call = calls.find((entry) => entry.path.endsWith("/availability"));
      expect((call?.body as { availabilityStatus: string }).availabilityStatus).toBe(
        "unavailable",
      );
    });
  });

  it("surfaces an activation-readiness refusal as a field problem", async () => {
    setup({}, ["storefront_products.manage", "storefront_products.publish"], {
      post: () =>
        Promise.reject(
          new ApiError("incomplete", "product_incomplete_for_activation", 422),
        ),
    });
    await screen.findByText("Embroidered Abaya");
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    expect(await screen.findByText(/Complete the required details/i)).toBeInTheDocument();
  });

  it("reports a suspended Storefront in the Trader's own words", async () => {
    setup({}, ["storefront_products.manage", "storefront_products.publish"], {
      post: () =>
        Promise.reject(new ApiError("suspended", "product_storefront_suspended", 409)),
    });
    await screen.findByText("Embroidered Abaya");
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    expect(await screen.findByText(/suspended Storefront cannot activate/i)).toBeInTheDocument();
  });

  it("disables lifecycle actions without the publish permission", async () => {
    setup({}, ["storefront_products.manage"]);
    await screen.findByText("Embroidered Abaya");
    expect(screen.getByRole("button", { name: "Activate" })).toBeDisabled();
    // Availability is a manage action, so it stays enabled.
    expect(screen.getByRole("button", { name: "Mark unavailable" })).toBeEnabled();
  });

  it("disables availability without the manage permission", async () => {
    setup({}, ["storefront_products.view"]);
    await screen.findByText("Embroidered Abaya");
    expect(screen.getByRole("button", { name: "Mark unavailable" })).toBeDisabled();
  });

  it("enables catalogue actions for an administrator holding only users_roles.manage", async () => {
    // The Company administrator super-permission, which every other module
    // honours. Without it here, an administrator reached the catalogue and
    // found every control dead, with nothing explaining why.
    setup({}, ["users_roles.manage"]);
    await screen.findByText("Embroidered Abaya");
    expect(screen.getByRole("button", { name: "Activate" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Mark unavailable" })).toBeEnabled();
  });

  it("filters by search through the API, not in the browser", async () => {
    const { calls } = setup();
    await screen.findByText("Embroidered Abaya");
    fireEvent.change(screen.getByLabelText(/Search/i), { target: { value: "abaya" } });
    await waitFor(() => {
      expect(calls.some((entry) => entry.path.includes("search=abaya"))).toBe(true);
    });
  });

  it("filters by lifecycle status through the API", async () => {
    const { calls } = setup();
    await screen.findByText("Embroidered Abaya");
    fireEvent.change(screen.getByLabelText(/Status/i), { target: { value: "active" } });
    await waitFor(() => {
      expect(calls.some((entry) => entry.path.includes("lifecycleStatus=active"))).toBe(true);
    });
  });

  it("shows the empty state for a catalogue with no Products", async () => {
    setup({}, undefined, {}, []);
    expect(await screen.findByText(/No Product matches these filters/i)).toBeInTheDocument();
  });

  it("renders Arabic labels and keeps code and price LTR-readable", async () => {
    await i18nInstance.changeLanguage("ar");
    setup();
    const code = await screen.findByText("ABAYA-0001");
    expect(code.closest("bdi")).not.toBeNull();
    await i18nInstance.changeLanguage("en");
  });
});
