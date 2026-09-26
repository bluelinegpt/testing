import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { App } from "../App.js";
import { PlatformSessionProvider } from "./PlatformSession.js";

interface StubResponse {
  readonly body?: unknown;
  readonly status: number;
}
type Route = StubResponse | ((body: unknown) => StubResponse);

const companyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const accountId = "11111111-2222-4333-8444-555555555555";

const readOnly = [
  "platform.access",
  "platform.companies.read",
  "platform.users.read",
  "platform.audit.read",
];
const fullAccess = [...readOnly, "platform.companies.manage", "platform.users.manage"];

function identity(permissions: readonly string[] = fullAccess): object {
  return {
    accountId: "6f1d0d5e-1c1b-4a2f-9f4e-2f9b7a5c1d33",
    username: "platform.admin",
    displayName: "platform.admin",
    kind: "platform_administrator",
    companyId: null,
    permissions,
    roles: ["platform_super_admin"],
  };
}

function user(overrides: Record<string, unknown> = {}): object {
  return {
    accountId,
    displayName: "علي المدير",
    username: "admin.acme",
    email: "admin@acme.example",
    mobileNumber: "97150000000",
    status: "active",
    state: "invitation_pending",
    roles: ["company_admin"],
    lockedUntil: null,
    failedLoginAttempts: 0,
    lastLoginAt: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    activeSetupLinkExpiresAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

const detail = {
  id: companyId,
  code: "TST-0001",
  nameEn: "Test Delivery",
  nameAr: null,
  subdomain: "tst0001",
  status: "draft",
  environment: "sandbox",
  countryCode: "AE",
  contactName: null,
  telephone: null,
  email: null,
  addressEn: null,
  tradeLicenseNumber: null,
  taxRegistrationNumber: null,
  timezone: "Asia/Dubai",
  baseCurrency: "AED",
  defaultLanguage: "en",
  accountingSetupStatus: "ready",
  accountingTemplateCode: "UAE_DELIVERY_STANDARD",
  accountingTemplateVersion: 1,
  accountingTemplateSha256: "2d66f8ee57cc17ce732a2ee3158f8e40131b8e815dfa9355ff13551070e06581",
  accountingSetupAppliedAt: "2026-08-10T00:00:00.000Z",
  accountingSetupAppliedBy: "platform.admin",
  createdAt: "2026-08-10T00:00:00.000Z",
  statusChangeReason: null,
};

const accountingSetup = {
  status: "ready",
  templateCode: "UAE_DELIVERY_STANDARD",
  templateVersion: 1,
  templateSha256: "2d66f8ee57cc17ce732a2ee3158f8e40131b8e815dfa9355ff13551070e06581",
  appliedAt: "2026-08-10T00:00:00.000Z",
  appliedBy: "platform.admin",
  businessDay: { timezone: "Asia/Dubai", startTime: "08:00" },
  counts: {
    accounts: 27,
    mappings: 31,
    openingBalanceBatches: 0,
    journals: 0,
    accountingEvents: 0,
  },
};

function readiness(overrides: Record<string, unknown> = {}): object {
  return {
    status: "draft",
    canActivate: false,
    blockedBy: ["companyAdmin"],
    nextStep: "Create Company Administrator",
    warnings: ["Accounting period not yet open - financial posting remains unavailable."],
    items: [
      {
        key: "accountingSetup",
        label: "Accounting setup",
        required: true,
        state: "complete",
        note: null,
      },
      {
        key: "companyAdmin",
        label: "Company Administrator",
        required: true,
        state: "incomplete",
        note: "Pending",
      },
      {
        key: "openingBalance",
        label: "Opening balance",
        required: false,
        state: "optional",
        note: "Not entered",
      },
    ],
    ...overrides,
  };
}

function stubFetch(routes: Record<string, Route>): typeof fetch {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace(/^.*\/api\/v1\//, "").split("?")[0] ?? "";
    const key = `${init?.method ?? "GET"} ${path}`;
    const entry = routes[key];
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const resolved = typeof entry === "function" ? entry(body) : entry;
    if (resolved === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: "not_stubbed", message: key } }), {
          headers: { "content-type": "application/json" },
          status: 404,
        }),
      );
    }
    return Promise.resolve(
      resolved.status === 204
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(resolved.body ?? {}), {
            headers: { "content-type": "application/json" },
            status: resolved.status,
          }),
    );
  }) as unknown as typeof fetch;
}

function baseRoutes(
  permissions: readonly string[] = fullAccess,
  users: object[] = [],
  readinessBody: object = readiness(),
): Record<string, Route> {
  return {
    "GET platform/auth/me": { body: identity(permissions), status: 200 },
    [`GET platform/companies/${companyId}`]: { body: detail, status: 200 },
    [`GET platform/companies/${companyId}/accounting-setup`]: {
      body: accountingSetup,
      status: 200,
    },
    [`GET platform/companies/${companyId}/readiness`]: { body: readinessBody, status: 200 },
    [`GET platform/companies/${companyId}/audit`]: { body: { items: [] }, status: 200 },
    [`GET platform/companies/${companyId}/users`]: { body: { items: users }, status: 200 },
  };
}

function renderDetail(): void {
  const observer = new MutationObserver(() => {
    const administratorsTab = screen.queryByRole("tab", {
      name: "Administrators & Passwords",
    });
    if (administratorsTab !== null) {
      fireEvent.click(administratorsTab);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  render(
    <MemoryRouter initialEntries={[`/companies/${companyId}`]}>
      <PlatformSessionProvider>
        <App />
      </PlatformSessionProvider>
    </MemoryRouter>,
  );
}

describe("Company Administrators section", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows the empty state when no administrator exists", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderDetail();

    expect(await screen.findByRole("heading", { name: "Administrators" })).toBeInTheDocument();
    // The list arrives after the heading, so await it rather than assuming.
    expect(await screen.findByText("No Company Administrator configured")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create Company Administrator" }),
    ).toBeInTheDocument();
  });

  it("hides management actions from a read-only Platform account", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes(readOnly, [user()])));
    renderDetail();

    // Reading still works; wait for the row before asserting on the actions.
    expect(await screen.findByText("admin.acme")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Company Administrator" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Password reset" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
  });

  it("explains the missing list when the read permission is absent", async () => {
    const permissions = fullAccess.filter((code) => code !== "platform.users.read");
    vi.stubGlobal("fetch", stubFetch(baseRoutes(permissions)));
    renderDetail();

    await screen.findByRole("heading", { name: "Administrators" });
    expect(screen.getByText(/platform\.users\.read/)).toBeInTheDocument();
  });

  it("creates an administrator and shows the one-time link once", async () => {
    const routes = baseRoutes();
    let sent: Record<string, unknown> = {};
    routes[`POST platform/companies/${companyId}/users/administrators`] = (body) => {
      sent = body as Record<string, unknown>;
      return {
        body: {
          accountId,
          setupUrl: "https://tst0001.example.com/account-setup?token=SECRET-TOKEN",
          expiresAt: "2026-08-12T00:00:00.000Z",
        },
        status: 201,
      };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Create Company Administrator" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "علي المدير" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin.acme" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@acme.example" } });
    fireEvent.change(screen.getByLabelText("Mobile"), { target: { value: "0506468442" } });
    fireEvent.click(screen.getByRole("button", { name: "Create administrator" }));

    expect(await screen.findByText(/SECRET-TOKEN/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();

    // Only business fields are sent — no role, no permissions, no password.
    expect(Object.keys(sent).sort()).toEqual([
      "displayName",
      "email",
      "mobileNumber",
      "preferredLanguage",
      "username",
    ]);
    for (const forbidden of ["roleIds", "permissions", "password", "companyId", "status"]) {
      expect(sent).not.toHaveProperty(forbidden);
    }

    // The link is never persisted anywhere in the browser.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("offers only the actions that suit the account's state", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes(fullAccess, [user({ state: "locked" })])));
    renderDetail();

    const row = (await screen.findByText("admin.acme")).closest("tr") as HTMLElement;
    expect(within(row).getByRole("button", { name: "Unlock" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
    // A locked account is not awaiting an invitation.
    expect(within(row).queryByRole("button", { name: "Activation link" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Reactivate" })).toBeNull();
  });

  it("offers reactivate — and nothing else destructive — for a disabled account", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes(fullAccess, [user({ state: "disabled" })])));
    renderDetail();

    const row = (await screen.findByText("admin.acme")).closest("tr") as HTMLElement;
    expect(within(row).getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Deactivate" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Password reset" })).toBeNull();
  });

  it("confirms before unlocking", async () => {
    const routes = baseRoutes(fullAccess, [user({ state: "locked" })]);
    let unlocked = false;
    routes[`POST platform/companies/${companyId}/users/${accountId}/unlock`] = () => {
      unlocked = true;
      return { status: 204 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(globalThis.confirm).toHaveBeenCalled());
    expect(unlocked).toBe(false);
  });

  it("requires a reason before deactivating", async () => {
    const routes = baseRoutes(fullAccess, [user({ state: "active" })]);
    let sentReason: unknown;
    routes[`POST platform/companies/${companyId}/users/${accountId}/deactivate`] = (body) => {
      sentReason = (body as { reason?: string }).reason;
      return { status: 204 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "left the company"),
    );
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(sentReason).toBe("left the company"));
  });

  it("issues a password-reset link and shows it once", async () => {
    const routes = baseRoutes(fullAccess, [user({ state: "active" })]);
    routes[`POST platform/companies/${companyId}/users/${accountId}/password-reset`] = {
      body: {
        setupUrl: "https://tst0001.example.com/account-setup?token=RESET-TOKEN",
        expiresAt: "2026-08-10T02:00:00.000Z",
      },
      status: 200,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Password reset" }));
    expect(await screen.findByText(/RESET-TOKEN/)).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("lists sessions without any token material and revokes one", async () => {
    const routes = baseRoutes(fullAccess, [user({ state: "active" })]);
    routes[`GET platform/companies/${companyId}/users/${accountId}/sessions`] = {
      body: {
        items: [
          {
            id: "99999999-8888-4777-8666-555544443333",
            createdAt: "2026-08-10T09:00:00.000Z",
            lastSeenAt: "2026-08-10T09:30:00.000Z",
            expiresAt: "2026-08-10T21:00:00.000Z",
            revokedAt: null,
            userAgent: "Mozilla/5.0",
            createdIp: "127.0.0.1",
          },
        ],
      },
      status: 200,
    };
    let revoked = false;
    routes[
      `POST platform/companies/${companyId}/users/${accountId}/sessions/99999999-8888-4777-8666-555544443333/revoke`
    ] = () => {
      revoked = true;
      return { status: 204 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
    expect(await screen.findByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByText("Mozilla/5.0")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/tokenHash|token_hash/);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revoked).toBe(true));
  });

  it("shows loading and then the empty sessions state without rendering blank", async () => {
    const routes = baseRoutes(fullAccess, [user({ state: "active" })]);
    routes[`GET platform/companies/${companyId}/users/${accountId}/sessions`] = {
      body: { items: [] },
      status: 200,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
    expect(screen.getByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByText("Loading sessions...")).toBeInTheDocument();
    expect(await screen.findByText("No sessions found for this user.")).toBeInTheDocument();
  });

  it.each([403, 404, 500])("shows a retryable sessions error for HTTP %s", async (status) => {
    const routes = baseRoutes(fullAccess, [user({ state: "active" })]);
    routes[`GET platform/companies/${companyId}/users/${accountId}/sessions`] = {
      body: { error: { code: "sessions_unavailable", message: "Not available" } },
      status,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load sessions.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sessions" })).toBeInTheDocument();
  });

  it("renders revoked sessions and nullable or malformed metadata safely", async () => {
    const routes = baseRoutes(fullAccess, [user({ state: "active" })]);
    routes[`GET platform/companies/${companyId}/users/${accountId}/sessions`] = {
      body: {
        items: [
          {
            id: "99999999-8888-4777-8666-555544443333",
            createdAt: "not-a-date",
            lastSeenAt: null,
            expiresAt: "",
            revokedAt: "2026-08-10T10:00:00.000Z",
            userAgent: null,
            createdIp: null,
          },
        ],
      },
      status: 200,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
    expect(await screen.findByText("revoked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("confirms before revoking every session", async () => {
    const routes = baseRoutes(fullAccess, [user({ state: "active" })]);
    routes[`GET platform/companies/${companyId}/users/${accountId}/sessions`] = {
      body: { items: [] },
      status: 200,
    };
    let revokedAll = false;
    routes[`POST platform/companies/${companyId}/users/${accountId}/sessions/revoke-all`] = () => {
      revokedAll = true;
      return { body: { revoked: 3 }, status: 200 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke all sessions" }));
    await waitFor(() => expect(globalThis.confirm).toHaveBeenCalled());
    expect(revokedAll).toBe(false);
  });

  /**
   * Delete User feedback.
   *
   * The reported defect was not the eligibility contract -- the API already
   * returns a complete, well-formed response for every case. It was that the
   * panel showing that response rendered in a fixed spot at the end of the
   * component regardless of which row's Delete button was clicked, so on a
   * table of any real size the result appeared a screen-height or more below
   * the click with nothing drawing the eye there. These tests exercise the
   * panel through every state a click can reach, and specifically assert
   * that SOMETHING targeting the clicked user is visible immediately, before
   * the network call resolves -- the property a scrolled-out-of-view panel
   * would still technically satisfy in the DOM while failing for a real
   * person looking at the screen.
   */
  describe("Delete user", () => {
    const eligibility = (overrides: Record<string, unknown> = {}): object => ({
      eligible: true,
      accountId,
      username: "admin.acme",
      displayName: "Admin",
      companyId,
      companyName: "Test Delivery",
      activeSessions: 0,
      isLastAdministrator: false,
      blockingRows: 0,
      blockingCategories: [],
      recommendedAction: "delete",
      reason: null,
      confirmationChallenge: "DELETE admin.acme",
      ...overrides,
    });

    /** 1. Click Delete -> loading eligibility, visible immediately. */
    it("shows a loading state for the clicked user the instant Delete is pressed", async () => {
      const routes = baseRoutes(fullAccess, [user({ state: "disabled" })]);
      // Never resolves within the test: proves the loading state renders on
      // the click itself, not once the network call happens to finish.
      routes[`GET platform/companies/${companyId}/users/${accountId}/deletion-eligibility`] = () =>
        new Promise<never>(() => undefined) as never;
      vi.stubGlobal("fetch", stubFetch(routes));
      renderDetail();

      fireEvent.click(await screen.findByRole("button", { name: "Delete user" }));
      // Another `role="status"` already exists on the page (the readiness
      // warning banner), so the check is on the specific text plus its role,
      // not on being the only status region present.
      const checking = await screen.findByText(/checking whether admin\.acme can be deleted/i);
      expect(checking).toHaveAttribute("role", "status");
      // The heading names the row, not just "Delete user" -- confirming
      // which of several rows the panel is currently about.
      expect(screen.getByRole("heading", { name: /Delete user: علي المدير/ })).toBeInTheDocument();
    });

    /** 2. Eligible -> confirmation appears, with the required fields. */
    it("shows the full confirmation dialog for an eligible user", async () => {
      const routes = baseRoutes(fullAccess, [user({ state: "disabled" })]);
      routes[`GET platform/companies/${companyId}/users/${accountId}/deletion-eligibility`] = {
        body: eligibility(),
        status: 200,
      };
      vi.stubGlobal("fetch", stubFetch(routes));
      renderDetail();

      fireEvent.click(await screen.findByRole("button", { name: "Delete user" }));
      await screen.findByText("This permanently deletes the user account.");
      // Scoped to the panel: "admin.acme" and "company_admin" also appear in
      // the table row behind it.
      const panel = within(
        screen.getByRole("heading", { name: /^Delete user:/ }).closest("section")!,
      );
      expect(panel.getByText("admin.acme")).toBeInTheDocument();
      expect(panel.getByText("Test Delivery")).toBeInTheDocument();
      expect(panel.getByText("company_admin")).toBeInTheDocument();
      expect(panel.getByText(/DELETE admin\.acme/)).toBeInTheDocument();
    });

    /** 3. Blocked -> blocker message appears, with categories, no raw table names. */
    it("blocks permanent user deletion when the server reports history", async () => {
      const routes = baseRoutes(fullAccess, [user({ state: "disabled" })]);
      routes[`GET platform/companies/${companyId}/users/${accountId}/deletion-eligibility`] = {
        body: eligibility({
          eligible: false,
          blockingRows: 2,
          blockingCategories: [{ category: "Orders", rows: 2 }],
          recommendedAction: "deactivate",
          reason: "This user has historical activity. Deactivate instead.",
        }),
        status: 200,
      };
      vi.stubGlobal("fetch", stubFetch(routes));
      renderDetail();

      fireEvent.click(await screen.findByRole("button", { name: "Delete user" }));
      expect(await screen.findByText(/historical activity/)).toBeInTheDocument();
      expect(screen.getByText("Orders: 2")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Permanently Delete User" })).toBeNull();
      // Never a raw SQL identifier -- "Orders" is a category, not a table.
      expect(screen.queryByText(/order_expenses|orders_/)).toBeNull();
    });

    /** 4. Last Admin -> specific message. */
    it("shows the specific last-administrator message, not a generic failure", async () => {
      const routes = baseRoutes(fullAccess, [user({ state: "disabled" })]);
      routes[`GET platform/companies/${companyId}/users/${accountId}/deletion-eligibility`] = {
        body: eligibility({
          eligible: false,
          isLastAdministrator: true,
          recommendedAction: "deactivate",
          reason:
            "This user is the last Company Administrator. Create another administrator before deleting this user.",
        }),
        status: 200,
      };
      vi.stubGlobal("fetch", stubFetch(routes));
      renderDetail();

      fireEvent.click(await screen.findByRole("button", { name: "Delete user" }));
      expect(
        await screen.findByText(
          "This user is the last Company Administrator. Create another administrator before deleting this user.",
        ),
      ).toBeInTheDocument();
    });

    /** 5. Historical dependency -> Deactivate recommendation shown. */
    it("recommends Deactivate for a user with historical dependencies", async () => {
      const routes = baseRoutes(fullAccess, [user({ state: "disabled" })]);
      routes[`GET platform/companies/${companyId}/users/${accountId}/deletion-eligibility`] = {
        body: eligibility({
          eligible: false,
          blockingRows: 3,
          blockingCategories: [
            { category: "Audit history", rows: 2 },
            { category: "Other records", rows: 1 },
          ],
          recommendedAction: "deactivate",
          reason: "This user has historical activity. Deactivate instead.",
        }),
        status: 200,
      };
      vi.stubGlobal("fetch", stubFetch(routes));
      renderDetail();

      fireEvent.click(await screen.findByRole("button", { name: "Delete user" }));
      expect(await screen.findByText(/Recommended action: Deactivate/)).toBeInTheDocument();
      expect(screen.getByText("Audit history: 2")).toBeInTheDocument();
      expect(screen.getByText("Other records: 1")).toBeInTheDocument();
    });

    /** 6. Eligibility API error -> visible error, with Retry, near the action. */
    it("shows a visible, retryable error when the eligibility check itself fails", async () => {
      const routes = baseRoutes(fullAccess, [user({ state: "disabled" })]);
      let attempts = 0;
      routes[`GET platform/companies/${companyId}/users/${accountId}/deletion-eligibility`] =
        () => {
          attempts += 1;
          return attempts === 1
            ? { body: { error: { code: "internal", message: "boom" } }, status: 500 }
            : { body: eligibility(), status: 200 };
        };
      vi.stubGlobal("fetch", stubFetch(routes));
      renderDetail();

      fireEvent.click(await screen.findByRole("button", { name: "Delete user" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Unable to check whether this user can be deleted.",
      );
      // Distinct from the page's general error banner: it must not require
      // scrolling to the top of a long Administrators table to find it.
      expect(screen.getByRole("heading", { name: /Delete user: علي المدير/ })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText("This permanently deletes the user account.");
      expect(attempts).toBe(2);
    });

    /** 7. Confirmation mismatch -> delete disabled. */
    it("keeps the delete button disabled until the exact confirmation is typed", async () => {
      const routes = baseRoutes(fullAccess, [user({ state: "disabled" })]);
      routes[`GET platform/companies/${companyId}/users/${accountId}/deletion-eligibility`] = {
        body: eligibility(),
        status: 200,
      };
      vi.stubGlobal("fetch", stubFetch(routes));
      renderDetail();

      fireEvent.click(await screen.findByRole("button", { name: "Delete user" }));
      const remove = await screen.findByRole("button", { name: "Permanently Delete User" });
      expect(remove).toBeDisabled();

      const input = screen.getByLabelText("Confirmation");
      fireEvent.change(input, { target: { value: "delete admin.acme" } });
      expect(remove).toBeDisabled();
      fireEvent.change(input, { target: { value: "DELETE admin.acme " } });
      expect(remove).toBeDisabled();
    });

    /** Explicit rejection of the exact wrong answers a confused administrator
     * is likely to type, plus the visible mismatch helper text. */
    it("rejects YES, confirm, and a partial challenge, and shows the mismatch helper", async () => {
      const routes = baseRoutes(fullAccess, [user({ state: "disabled" })]);
      routes[`GET platform/companies/${companyId}/users/${accountId}/deletion-eligibility`] = {
        body: eligibility(),
        status: 200,
      };
      vi.stubGlobal("fetch", stubFetch(routes));
      renderDetail();

      fireEvent.click(await screen.findByRole("button", { name: "Delete user" }));
      const remove = await screen.findByRole("button", { name: "Permanently Delete User" });
      const input = screen.getByLabelText("Confirmation");

      for (const wrong of ["YES", "confirm", "DELETE admin"]) {
        fireEvent.change(input, { target: { value: wrong } });
        expect(remove).toBeDisabled();
        expect(screen.getByText(/Confirmation does not match/)).toBeInTheDocument();
      }

      fireEvent.change(input, { target: { value: "DELETE admin.acme" } });
      expect(screen.queryByText(/Confirmation does not match/)).toBeNull();
      expect(remove).not.toBeDisabled();
    });

    /** 8 & 9. Confirmation correct -> delete executes; success removes the row. */
    it("executes deletion on exact confirmation, shows success, and removes the row without a refresh", async () => {
      const routes = baseRoutes(fullAccess, [user({ state: "disabled" })]);
      routes[`GET platform/companies/${companyId}/users/${accountId}/deletion-eligibility`] = {
        body: eligibility(),
        status: 200,
      };
      let confirmationSent: unknown;
      let secondUsersFetch = false;
      routes[`POST platform/companies/${companyId}/users/${accountId}/delete`] = (body) => {
        confirmationSent = (body as { confirmation?: string }).confirmation;
        return { body: { deleted: true, username: "admin.acme" }, status: 200 };
      };
      const originalUsersRoute = routes[`GET platform/companies/${companyId}/users`];
      routes[`GET platform/companies/${companyId}/users`] = () => {
        const already = secondUsersFetch;
        secondUsersFetch = true;
        // The row is gone from the SERVER'S next answer -- this is what
        // "remove the row" actually depends on: the client re-fetches after
        // a successful delete rather than editing local state by guesswork.
        return already
          ? { body: { items: [] }, status: 200 }
          : (originalUsersRoute as StubResponse);
      };
      vi.stubGlobal("fetch", stubFetch(routes));
      renderDetail();

      fireEvent.click(await screen.findByRole("button", { name: "Delete user" }));
      const remove = await screen.findByRole("button", { name: "Permanently Delete User" });
      fireEvent.change(screen.getByLabelText("Confirmation"), {
        target: { value: "DELETE admin.acme" },
      });
      expect(remove).not.toBeDisabled();
      fireEvent.click(remove);

      await waitFor(() => expect(confirmationSent).toBe("DELETE admin.acme"));
      expect(await screen.findByText("User deleted successfully.")).toBeInTheDocument();
      // The confirmation panel closes; the row is gone from the next fetch.
      await waitFor(() =>
        expect(screen.queryByRole("heading", { name: /Delete user: علي المدير/ })).toBeNull(),
      );
      await waitFor(() => expect(screen.queryByText("admin.acme")).toBeNull());
    });

    /** 10. Execute-time dependency change -> visible failure, not a silent no-op. */
    it("shows a visible failure when eligibility changes between preview and execute", async () => {
      const routes = baseRoutes(fullAccess, [user({ state: "disabled" })]);
      routes[`GET platform/companies/${companyId}/users/${accountId}/deletion-eligibility`] = {
        body: eligibility(),
        status: 200,
      };
      routes[`POST platform/companies/${companyId}/users/${accountId}/delete`] = {
        body: {
          error: {
            code: "user_deletion_not_eligible",
            message: "This user has historical activity. Deactivate instead.",
          },
        },
        status: 409,
      };
      vi.stubGlobal("fetch", stubFetch(routes));
      renderDetail();

      fireEvent.click(await screen.findByRole("button", { name: "Delete user" }));
      const remove = await screen.findByRole("button", { name: "Permanently Delete User" });
      fireEvent.change(screen.getByLabelText("Confirmation"), {
        target: { value: "DELETE admin.acme" },
      });
      fireEvent.click(remove);

      // `findByRole` alone would resolve against the eligible view's OWN
      // "This permanently deletes..." alert, which is already on screen the
      // moment the button is clicked -- it does not wait for content to
      // CHANGE, only for a match to exist, and one already does. Asserting
      // on the text and letting `waitFor` retry is what actually waits for
      // the failed request to resolve and replace it.
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(/historical activity/),
      );
      // The row must still be there -- the delete did NOT silently succeed.
      expect(screen.getByText("admin.acme")).toBeInTheDocument();
    });

    /** 11. No silent/no-op path: every one of the four states is reachable and visible. */
    it("never leaves a click with no visible reaction", async () => {
      const routes = baseRoutes(fullAccess, [user({ state: "disabled" })]);
      routes[`GET platform/companies/${companyId}/users/${accountId}/deletion-eligibility`] = {
        body: eligibility({
          eligible: false,
          reason: "This account is not eligible for permanent deletion.",
        }),
        status: 200,
      };
      vi.stubGlobal("fetch", stubFetch(routes));
      renderDetail();

      expect(screen.queryByRole("heading", { name: /^Delete user:/ })).toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: "Delete user" }));
      // Something is on screen for this user before AND after the request
      // resolves -- never a click that produces nothing at all.
      expect(screen.getByRole("heading", { name: /^Delete user:/ })).toBeInTheDocument();
      await screen.findByText("This account is not eligible for permanent deletion.");
      expect(screen.getByRole("heading", { name: /^Delete user:/ })).toBeInTheDocument();
    });
  });
});

describe("Readiness and activation with administrators", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps Activate disabled while the administrator is only invited", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes(fullAccess, [user()])));
    renderDetail();

    fireEvent.click(await screen.findByRole("tab", { name: "Lifecycle" }));

    const activate = await screen.findByRole("button", { name: "Activate" });
    expect(activate).toBeDisabled();
    expect(activate).toHaveAttribute("title", "Blocked by: companyAdmin");
  });

  it("enables Activate once the server reports the administrator complete", async () => {
    const ready = readiness({
      canActivate: true,
      blockedBy: [],
      nextStep: "Activate Company",
      items: [
        {
          key: "accountingSetup",
          label: "Accounting setup",
          required: true,
          state: "complete",
          note: null,
        },
        {
          key: "companyAdmin",
          label: "Company Administrator",
          required: true,
          state: "complete",
          note: null,
        },
        {
          key: "openingBalance",
          label: "Opening balance",
          required: false,
          state: "optional",
          note: "Not entered",
        },
      ],
    });
    vi.stubGlobal("fetch", stubFetch(baseRoutes(fullAccess, [user({ state: "active" })], ready)));
    renderDetail();

    fireEvent.click(await screen.findByRole("tab", { name: "Lifecycle" }));

    expect(await screen.findByRole("button", { name: "Activate" })).toBeEnabled();
    expect(screen.getByText("Next step: Activate Company")).toBeInTheDocument();
  });

  /** An unopened accounting period is an operational note, never a blocker. */
  it("shows the fiscal-period warning without blocking readiness", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes(fullAccess, [user()])));
    renderDetail();

    expect(await screen.findByText(/Accounting period not yet open/)).toBeInTheDocument();
    const balanceRow = screen.getByText("Opening balance").closest("tr") as HTMLElement;
    expect(within(balanceRow).getByText("Optional")).toBeInTheDocument();
  });
});
