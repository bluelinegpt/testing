import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import {
  StorefrontConfigurationWorkspace,
  suggestSlug,
  type StorefrontConfiguration,
} from "./StorefrontConfigurationWorkspace.js";

/**
 * Storefront configuration behaviour, with the API stubbed at the client
 * boundary.
 *
 * The claims under test are the ones a defect would make expensive: that the
 * screen never authorises an action the backend would refuse, that a
 * suspension cannot be edited around, that a lost slug race is reported as a
 * field problem rather than a crash, and that the optimistic-concurrency
 * version travels with every write.
 */

const storefront: StorefrontConfiguration = {
  brandAccentColor: "#b08d57",
  brandPrimaryColor: "#1f2937",
  businessHours: [],
  businessTemplate: "fashion",
  customerSupport: null,
  deliveryInformation: "Next day",
  displayName: "Al Noor Fashion",
  id: "storefront-1",
  publicEmail: null,
  publicMobile: "+971 50 000 0000",
  seoDescriptionAr: null,
  seoDescriptionEn: null,
  seoIndexable: true,
  seoTitleAr: null,
  seoTitleEn: null,
  publicUrl: "/store/al-noor-fashion",
  publicWhatsapp: null,
  publishedAt: null,
  returnPolicy: "7 days",
  slug: "al-noor-fashion",
  status: "draft",
  storeDescription: "Modest fashion",
  suspendedAt: null,
  suspensionReason: null,
  terms: null,
  theme: "luxury_minimal",
  traderId: "trader-1",
  version: 3,
};

function setup(
  overrides: Partial<StorefrontConfiguration> = {},
  permissions: readonly string[] = ["storefront.manage", "storefront.publish"],
  handlers: {
    readonly patch?: (path: string, body: unknown) => Promise<unknown>;
    readonly post?: (path: string, body: unknown) => Promise<unknown>;
    readonly slug?: () => Promise<unknown>;
  } = {},
) {
  const calls: { body?: unknown; path: string }[] = [];
  const api = {
    get: vi.fn((path: string) => {
      calls.push({ path });
      if (path.includes("slug-availability")) {
        return (
          handlers.slug?.() ??
          Promise.resolve({ available: true, normalised: "al-noor-fashion", reason: null })
        );
      }
      return Promise.resolve({ ...storefront, ...overrides });
    }),
    patch: vi.fn((path: string, body: unknown) => {
      calls.push({ body, path });
      return handlers.patch?.(path, body) ?? Promise.resolve({ ...storefront, ...overrides });
    }),
    post: vi.fn((path: string, body: unknown) => {
      calls.push({ body, path });
      return (
        handlers.post?.(path, body) ??
        Promise.resolve({ ...storefront, ...overrides, status: "published" })
      );
    }),
  };
  render(
    <StorefrontConfigurationWorkspace
      api={api as unknown as ApiClient}
      permissions={permissions}
    />,
  );
  return { api, calls };
}

describe("suggestSlug", () => {
  it("matches the server's normalisation for a plain name", () => {
    expect(suggestSlug("Al Noor Fashion")).toBe("al-noor-fashion");
  });

  it("strips characters that would change how the URL parses", () => {
    expect(suggestSlug("Shop/../Admin")).toBe("shop-admin");
  });

  it("returns nothing for a name with no Latin characters", () => {
    expect(suggestSlug("متجر النور")).toBe("");
  });
});

describe("StorefrontConfigurationWorkspace", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
  });

  it("shows the configuration and its public address", async () => {
    setup();
    expect(await screen.findByDisplayValue("Al Noor Fashion")).toBeInTheDocument();
    expect(screen.getByText("/store/al-noor-fashion")).toBeInTheDocument();
  });

  it("offers only the actions the current status permits", async () => {
    setup();
    await screen.findByDisplayValue("Al Noor Fashion");
    // A draft may publish; it may not be closed or unpublished.
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Temporarily close" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
  });

  it("offers close and unpublish once published", async () => {
    setup({ status: "published" });
    await screen.findByDisplayValue("Al Noor Fashion");
    expect(screen.getByRole("button", { name: "Temporarily close" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpublish" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });

  it("sends the loaded version with every write", async () => {
    const { calls } = setup();
    await screen.findByDisplayValue("Al Noor Fashion");
    fireEvent.change(screen.getByLabelText(/Store display name/i), {
      target: { value: "Al Noor Boutique" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const patch = calls.find((call) => call.body !== undefined);
      expect((patch?.body as { expectedVersion: number }).expectedVersion).toBe(3);
    });
  });

  it("reports a lost slug race as a field problem, not a crash", async () => {
    setup({}, ["storefront.manage"], {
      patch: () =>
        Promise.reject(new ApiError("taken", "storefront_slug_taken", 409)),
    });
    await screen.findByDisplayValue("Al Noor Fashion");
    fireEvent.change(screen.getByLabelText(/Store URL/i), { target: { value: "taken-slug" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
  });

  it("locks editing while the Storefront is suspended", async () => {
    setup({ status: "suspended", suspensionReason: "Policy review" });
    await screen.findByDisplayValue("Al Noor Fashion");
    expect(screen.getByRole("alert").textContent).toMatch(/suspended/i);
    // The whole information fieldset is disabled, so no field can be edited
    // around an administrative suspension.
    expect(screen.getByLabelText(/Store display name/i)).toBeDisabled();
  });

  it("offers no publication action while suspended", async () => {
    setup({ status: "suspended" });
    await screen.findByDisplayValue("Al Noor Fashion");
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.getByText(/No publication action is available/i)).toBeInTheDocument();
  });

  it("shows remove-suspension only to an account holding the permission", async () => {
    setup({ status: "suspended" }, ["storefront.manage", "storefront.suspend"]);
    await screen.findByDisplayValue("Al Noor Fashion");
    expect(screen.getByRole("button", { name: "Remove suspension" })).toBeInTheDocument();
  });

  it("hides suspension controls from an account without the permission", async () => {
    setup({ status: "suspended" }, ["storefront.manage"]);
    await screen.findByDisplayValue("Al Noor Fashion");
    expect(screen.queryByRole("button", { name: "Remove suspension" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Suspend" })).toBeNull();
  });

  it("reports an unavailable slug using the server's reason", async () => {
    setup({}, ["storefront.manage"], {
      slug: () =>
        Promise.resolve({
          available: false,
          normalised: "admin",
          reason: "storefront_slug_reserved",
        }),
    });
    await screen.findByDisplayValue("Al Noor Fashion");
    fireEvent.change(screen.getByLabelText(/Store URL/i), { target: { value: "admin" } });
    expect(await screen.findByText(/reserved/i)).toBeInTheDocument();
  });

  it("requires saving before a publication action runs", async () => {
    setup();
    await screen.findByDisplayValue("Al Noor Fashion");
    fireEvent.change(screen.getByLabelText(/Store display name/i), {
      target: { value: "Changed" },
    });
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("shows the empty state when the Trader has no Storefront", async () => {
    const api = {
      get: vi.fn(() => Promise.resolve(null)),
      patch: vi.fn(),
      post: vi.fn(),
    };
    render(
      <StorefrontConfigurationWorkspace
        api={api as unknown as ApiClient}
        permissions={["storefront.manage"]}
      />,
    );
    expect(await screen.findByText(/does not have a Storefront yet/i)).toBeInTheDocument();
  });

  /* -----------------------------------------------------------------------
     The administrator escalation, and Company mode.

     Both were browser-only findings. An administrator holding
     `users_roles.manage` reached the screen and then met a form whose every
     field was disabled, with nothing on screen explaining why. Separately, a
     Company user has no Storefront of their own, so `mine` refuses -- and the
     screen has to read that refusal as "you are a Company user" rather than as
     an error, or there is no way to create the first Storefront at all.
     ----------------------------------------------------------------------- */

  it("enables the form for an administrator holding only users_roles.manage", async () => {
    setup({}, ["users_roles.manage"]);
    await screen.findByDisplayValue("Al Noor Fashion");
    const name = screen.getByLabelText(/Store display name/i);
    expect(name).toBeEnabled();
    // The publication authority follows from the same escalation. Checked
    // before editing, because Publish is deliberately gated on a clean form.
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    // Save is gated on the form being dirty, so an edit has to come first --
    // the point is that the permission does not gate it as well.
    fireEvent.change(name, { target: { value: "Changed" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("disables the form without either a storefront permission or users_roles.manage", async () => {
    // A real permission set from another module: present, but not this one.
    setup({}, ["orders.create", "storefront.view"]);
    await screen.findByDisplayValue("Al Noor Fashion");
    expect(screen.getByLabelText(/Store display name/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("switches to the Company list and create flow when the caller is not a Trader", async () => {
    const posts: { body: unknown; path: string }[] = [];
    const api = {
      get: vi.fn((path: string) => {
        if (path.endsWith("/mine")) {
          return Promise.reject(
            new ApiError("trader only", "storefront_trader_context_required", 403),
          );
        }
        if (path === "operations/trader-storefronts") {
          return Promise.resolve({
            items: [
              {
                displayName: "Zahra Boutique",
                id: "sf-1",
                slug: "zahra-boutique",
                status: "published",
              },
            ],
          });
        }
        if (path === "operations/traders") {
          return Promise.resolve([{ code: "T-1", id: "trader-9", nameEn: "Zahra Trading" }]);
        }
        return Promise.resolve(null);
      }),
      patch: vi.fn(),
      post: vi.fn((path: string, body: unknown) => {
        posts.push({ body, path });
        return Promise.resolve({ id: "sf-2" });
      }),
    };
    render(
      <StorefrontConfigurationWorkspace
        api={api as unknown as ApiClient}
        permissions={["storefront.manage"]}
      />,
    );

    // The refusal is a mode switch, not an error.
    expect(await screen.findByText("Zahra Boutique")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();

    // And the Company can create the first Storefront from here, which is the
    // only path to one that exists.
    fireEvent.change(screen.getByLabelText(/Trader/i), { target: { value: "trader-9" } });
    fireEvent.change(screen.getByLabelText(/Store display name/i), {
      target: { value: "Amber Goods" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0]!.path).toBe("operations/trader-storefronts");
    expect(posts[0]!.body).toMatchObject({
      displayName: "Amber Goods",
      // The slug is derived when the user does not supply one.
      slug: "amber-goods",
      traderId: "trader-9",
    });
  });

  it("renders Arabic labels and keeps the public address LTR-readable", async () => {
    await i18nInstance.changeLanguage("ar");
    setup();
    const url = await screen.findByText("/store/al-noor-fashion");
    expect(url.closest("bdi")).not.toBeNull();
    await i18nInstance.changeLanguage("en");
  });

  it("edits business hours and sends them with the profile", async () => {
    const { calls } = setup({ businessHours: [{ days: "Sat – Thu", time: "10:00 – 22:00" }] });
    await screen.findByDisplayValue("Al Noor Fashion");
    fireEvent.change(screen.getByDisplayValue("10:00 – 22:00"), {
      target: { value: "09:00 – 21:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const patch = calls.find((call) => call.body !== undefined);
      const body = patch?.body as { businessHours: { time: string }[] };
      expect(body.businessHours[0]!.time).toBe("09:00 – 21:00");
    });
  });

  it("adds and removes a business-hours row", async () => {
    setup({ businessHours: [] });
    await screen.findByDisplayValue("Al Noor Fashion");
    fireEvent.click(screen.getByRole("button", { name: "Add hours" }));
    expect(screen.getByDisplayValue("Saturday – Thursday")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByDisplayValue("Saturday – Thursday")).toBeNull();
  });

  it("blocks saving an incomplete business-hours row", async () => {
    setup({ businessHours: [] });
    await screen.findByDisplayValue("Al Noor Fashion");
    // A new row starts with no hours, which the API contract rejects.
    fireEvent.click(screen.getByRole("button", { name: "Add hours" }));
    expect(await screen.findByText(/needs both days and hours/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
