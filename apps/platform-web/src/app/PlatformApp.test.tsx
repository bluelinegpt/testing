import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { App } from "../App.js";
import { PlatformSessionProvider } from "./PlatformSession.js";

interface StubResponse {
  readonly body?: unknown;
  readonly status: number;
}

const fullPermissions = [
  "platform.access",
  "platform.audit.read",
  "platform.companies.manage",
  "platform.companies.read",
  "platform.users.manage",
  "platform.users.read",
];

function identity(permissions: readonly string[] = fullPermissions): object {
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

/**
 * Every test drives the Portal through `fetch`, because that is the only way it
 * can learn anything. There is no token to seed and no storage to prime — which
 * is itself the property `does not persist any session material` asserts.
 */
function stubFetch(routes: Record<string, StubResponse | (() => StubResponse)>): typeof fetch {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const key = `${init?.method ?? "GET"} ${url.replace(/^.*\/api\/v1\//, "")}`;
    const entry = routes[key];
    const resolved = typeof entry === "function" ? entry() : entry;
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

function renderApp(): void {
  render(
    <MemoryRouter>
      <PlatformSessionProvider>
        <App />
      </PlatformSessionProvider>
    </MemoryRouter>,
  );
}

const unauthenticated: StubResponse = {
  body: { error: { code: "invalid_session", message: "no session" } },
  status: 401,
};

describe("Platform Portal shell", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the sign-in page when no Platform session exists", async () => {
    vi.stubGlobal("fetch", stubFetch({ "GET platform/auth/me": unauthenticated }));
    renderApp();

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("offers no Company selector at sign-in", async () => {
    vi.stubGlobal("fetch", stubFetch({ "GET platform/auth/me": unauthenticated }));
    renderApp();
    await screen.findByRole("button", { name: "Sign in" });

    expect(screen.queryByLabelText(/company/i)).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByLabelText(/subdomain/i)).toBeNull();
  });

  it("never renders the authenticated shell to an unauthenticated caller", async () => {
    vi.stubGlobal("fetch", stubFetch({ "GET platform/auth/me": unauthenticated }));
    renderApp();
    await screen.findByRole("button", { name: "Sign in" });

    expect(screen.queryByRole("navigation", { name: "Platform sections" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("rejects a Company user session and shows sign-in", async () => {
    // A Company user holds a valid cookie, so `me` is reached — and refused by
    // the Platform identity-kind check with 403, not 401.
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "GET platform/auth/me": {
          body: { error: { code: "identity_kind_denied", message: "denied" } },
          status: 403,
        },
      }),
    );
    renderApp();

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("signs in and shows the Platform shell", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "GET platform/auth/me": unauthenticated,
        "POST platform/auth/login": {
          body: { expiresAt: new Date(Date.now() + 3_600_000).toISOString(), identity: identity() },
          status: 200,
        },
      }),
    );
    renderApp();

    fireEvent.change(await screen.findByLabelText("Username"), {
      target: { value: "platform.admin" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a-long-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Platform sections" })).toBeInTheDocument();
  });

  it("shows one safe message for invalid sign-in details", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "GET platform/auth/me": unauthenticated,
        "POST platform/auth/login": {
          body: { error: { code: "invalid_credentials", message: "The login identifier…" } },
          status: 401,
        },
      }),
    );
    renderApp();

    fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "nobody" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("not valid for Platform Administration");
    // Nothing in the message distinguishes an unknown account from a wrong
    // password, and no Company name is named.
    expect(alert.textContent).not.toMatch(/password|account|company/i);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("restores the session after a reload without any client-side storage", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({ "GET platform/auth/me": { body: identity(), status: 200 } }),
    );
    renderApp();

    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("signs out and returns to the sign-in page", async () => {
    let signedIn = true;
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "GET platform/auth/me": () =>
          signedIn ? { body: identity(), status: 200 } : unauthenticated,
        "POST platform/auth/logout": () => {
          signedIn = false;
          return { status: 204 };
        },
      }),
    );
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("shows only the navigation the Platform permissions allow", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "GET platform/auth/me": { body: identity(["platform.access"]), status: 200 },
      }),
    );
    renderApp();

    await screen.findByRole("button", { name: "Sign out" });
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Companies" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Audit" })).toBeNull();
  });

  it("shows the Company sections when the permissions are held", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "GET platform/auth/me": { body: identity(), status: 200 },
        "GET platform/companies": { body: [], status: 200 },
      }),
    );
    renderApp();

    await screen.findByRole("button", { name: "Sign out" });
    expect(screen.getByRole("link", { name: "Companies" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Audit" })).toBeInTheDocument();
  });

  it("sends the session cookie and the CSRF header, and never a bearer token", async () => {
    const fetchStub = stubFetch({ "GET platform/auth/me": { body: identity(), status: 200 } });
    vi.stubGlobal("fetch", fetchStub);
    renderApp();
    await screen.findByRole("button", { name: "Sign out" });

    const calls = (fetchStub as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, init] of calls) {
      const headers = init.headers as Record<string, string>;
      expect(init.credentials).toBe("include");
      expect(headers["X-Blueline-Session"]).toBe("cookie");
      expect(headers.Authorization).toBeUndefined();
    }
  });

  it("persists no session material in browser storage at any point", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "GET platform/auth/me": unauthenticated,
        "POST platform/auth/login": {
          body: { expiresAt: new Date(Date.now() + 3_600_000).toISOString(), identity: identity() },
          status: 200,
        },
      }),
    );
    renderApp();

    fireEvent.change(await screen.findByLabelText("Username"), {
      target: { value: "platform.admin" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a-long-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("button", { name: "Sign out" });

    await waitFor(() => {
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });
    expect(localStorage.getItem("accessToken")).toBeNull();
    expect(sessionStorage.getItem("accessToken")).toBeNull();
  });
});
