import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";

import { DeliveryCompaniesSection, type DeliveryRelationship } from "./DeliveryCompaniesSection.js";

/**
 * The Delivery Companies section of Store settings.
 *
 * The behaviour worth pinning is what the screen does NOT do: it never lists a
 * Company the Store has no relationship with, it never offers to create one,
 * and it never hides the Store when none are connected. The last point is the
 * whole reason 0B-1 exists — a shop with no Delivery Company is a valid shop,
 * and a settings screen that treated that as an error state would quietly
 * reintroduce the dependency the migration removed.
 */

const dana: DeliveryRelationship = {
  companyId: "company-dana",
  companyName: "Dana Delivery",
  enabledForStoreOrders: true,
  id: "rel-dana",
  isDefaultForStoreOrders: true,
  status: "active",
};

const ali: DeliveryRelationship = {
  companyId: "company-ali",
  companyName: "Ali Delivery",
  enabledForStoreOrders: true,
  id: "rel-ali",
  isDefaultForStoreOrders: false,
  status: "active",
};

function setup(items: readonly DeliveryRelationship[], canManage = true) {
  const patchCalls: { body: unknown; path: string }[] = [];
  let current = [...items];
  const api = {
    get: vi.fn(() => Promise.resolve({ items: current })),
    patch: vi.fn((path: string, body?: unknown) => {
      patchCalls.push({ body, path });
      const change = body as Record<string, boolean>;
      const id = path.split("/").pop();
      current = current.map((row) =>
        row.id === id
          ? {
              ...row,
              enabledForStoreOrders: change.enabledForStoreOrders ?? row.enabledForStoreOrders,
              // Mirrors the server rule: disabling clears the default.
              isDefaultForStoreOrders:
                change.enabledForStoreOrders === false
                  ? false
                  : (change.isDefaultForStoreOrders ?? row.isDefaultForStoreOrders),
            }
          : { ...row, isDefaultForStoreOrders: change.isDefaultForStoreOrders === true ? false : row.isDefaultForStoreOrders },
      );
      return Promise.resolve({ items: current });
    }),
  };
  render(
    <DeliveryCompaniesSection
      api={api as unknown as ApiClient}
      canManage={canManage}
      storefrontId="storefront-1"
    />,
  );
  return { api, patchCalls };
}

describe("DeliveryCompaniesSection", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
  });

  it("shows a clean empty state when no Delivery Company is connected", async () => {
    setup([]);
    expect(await screen.findByTestId("storefront-delivery-empty")).toHaveTextContent(
      "No delivery companies are connected yet. Your Store and Products remain available, but Store checkout cannot assign a delivery company.",
    );
    // No Company picker, no create control — this is not a discovery surface.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("lists one connected Company and marks the default", async () => {
    setup([dana]);
    expect(await screen.findByText("Dana Delivery")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("lists several connected Companies and offers the default only on the others", async () => {
    setup([dana, ali]);
    expect(await screen.findByText("Dana Delivery")).toBeInTheDocument();
    expect(screen.getByText("Ali Delivery")).toBeInTheDocument();
    expect(screen.getAllByText("Default")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Set as default" })).toHaveLength(1);
  });

  it("sets the default on another Company", async () => {
    const { patchCalls } = setup([dana, ali]);
    fireEvent.click(await screen.findByRole("button", { name: "Set as default" }));
    await waitFor(() => {
      expect(patchCalls).toStrictEqual([
        {
          body: { isDefaultForStoreOrders: true },
          path: "operations/trader-storefronts/storefront-1/delivery-companies/rel-ali",
        },
      ]);
    });
  });

  it("disables one of several without asking for confirmation", async () => {
    const { patchCalls } = setup([dana, ali]);
    await screen.findByText("Ali Delivery");
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]!);
    await waitFor(() => {
      expect(patchCalls).toHaveLength(1);
    });
    expect(patchCalls[0]?.body).toStrictEqual({ enabledForStoreOrders: false });
  });

  it("confirms before disabling the last enabled Company, and says the Store stays available", async () => {
    const { patchCalls } = setup([dana]);
    fireEvent.click(await screen.findByRole("checkbox"));
    expect(
      screen.getByText(
        "Are you sure you want to remove all Delivery Companies from Store ordering? Your Store will remain available.",
      ),
    ).toBeInTheDocument();
    // Nothing is sent until the confirmation is accepted.
    expect(patchCalls).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(patchCalls).toHaveLength(1);
    });
    expect(patchCalls[0]?.body).toStrictEqual({ enabledForStoreOrders: false });
  });

  it("abandons the disable when the confirmation is cancelled", async () => {
    const { patchCalls } = setup([dana]);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
    expect(patchCalls).toHaveLength(0);
  });

  it("keeps the section usable and reports none enabled after the last is disabled", async () => {
    setup([dana]);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByTestId("storefront-delivery-none-enabled")).toBeInTheDocument();
    // The relationship is still listed; only its enablement changed.
    expect(screen.getByText("Dana Delivery")).toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
  });

  it("blocks enabling an inactive relationship, with a clear explanation, but still allows disabling it", async () => {
    const suspended: DeliveryRelationship = {
      companyId: "company-suspended",
      companyName: "Suspended Co",
      enabledForStoreOrders: false,
      id: "rel-suspended",
      isDefaultForStoreOrders: false,
      status: "suspended",
    };
    setup([dana, suspended]);
    await screen.findByText("Suspended Co");
    expect(
      screen.getByText("This relationship is not active and cannot be enabled for Store orders."),
    ).toBeInTheDocument();
    expect(screen.getByText("Suspended")).toBeInTheDocument();
    const checkboxes = screen.getAllByRole("checkbox");
    // dana (active, enabled) stays clickable; the suspended one is blocked --
    // the `disabled` attribute itself is what a real browser enforces; a
    // disabled checkbox never fires `change` there regardless of what jsdom's
    // synthetic `fireEvent.click` does on its own DOM node.
    expect(checkboxes[0]).toBeEnabled();
    expect(checkboxes[1]).toBeDisabled();
  });

  it("shows a status badge for every relationship, muted for anything not active", async () => {
    setup([dana]);
    expect(await screen.findByText("Active")).toBeInTheDocument();
  });

  it("does not offer any control to a read-only viewer", async () => {
    setup([dana, ali], false);
    await screen.findByText("Dana Delivery");
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Set as default" })).toBeDisabled();
  });
});
