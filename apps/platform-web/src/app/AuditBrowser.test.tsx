import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { App } from "../App.js";
import { PlatformSessionProvider } from "./PlatformSession.js";

/**
 * The Platform audit browser.
 *
 * The assertions that matter are about where the work happens: filtering and
 * paging must reach the SERVER, because the trail is append-only and unbounded
 * and a client-side filter would describe one page as if it were the whole
 * history. So the requested URLs are captured and asserted, not just the
 * rendered rows.
 */
const permissions = ["platform.access", "platform.companies.read", "platform.audit.read"];

const identity = (codes: readonly string[] = permissions): object => ({
  accountId: "6f1d0d5e-1c1b-4a2f-9f4e-2f9b7a5c1d33",
  username: "platform.admin",
  displayName: "platform.admin",
  kind: "platform_administrator",
  companyId: null,
  permissions: codes,
  roles: ["platform_super_admin"],
});

const entry = (overrides: Record<string, unknown> = {}): object => ({
  id: "11111111-2222-4333-8444-555555555555",
  action: "platform.company.created",
  subjectType: "company",
  subjectId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  reason: null,
  before: null,
  after: { code: "TST-0001" },
  occurredAt: "2026-08-09T09:00:00.000Z",
  correlationId: "corr-1234abcd",
  source: "platform_portal",
  companyId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  companyName: "Test Delivery",
  actorUsername: "platform.admin",
  actor: "platform.admin",
  ...overrides,
});

interface Stub {
  readonly urls: string[];
  readonly fetch: typeof fetch;
}

function stubFetch(options: {
  codes?: readonly string[];
  total?: number;
  items?: object[];
  auditStatus?: number;
}): Stub {
  const urls: string[] = [];
  const fetchStub = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    const path = url.replace(/^.*\/api\/v1\//, "");
    const json = (body: unknown, status = 200): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
          status,
        }),
      );

    if (path.startsWith("platform/auth/me")) return json(identity(options.codes ?? permissions));
    if (path.startsWith("platform/audit/actions"))
      return json({ items: ["platform.company.created", "platform.company.suspended"] });
    if (path.startsWith("platform/audit")) {
      if (options.auditStatus !== undefined && options.auditStatus !== 200) {
        return json(
          { error: { code: "permission_denied", message: "You may not read the audit history." } },
          options.auditStatus,
        );
      }
      return json({
        items: options.items ?? [entry()],
        total: options.total ?? 1,
        page: 1,
        pageSize: 25,
      });
    }
    return json({ error: { code: "not_stubbed", message: path } }, 404);
  }) as unknown as typeof fetch;
  return { urls, fetch: fetchStub };
}

function renderAudit(stub: Stub): void {
  vi.stubGlobal("fetch", stub.fetch);
  render(
    <MemoryRouter initialEntries={["/audit"]}>
      <PlatformSessionProvider>
        <App />
      </PlatformSessionProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Platform audit browser", () => {
  it("lists entries with the Company and the administrator who acted", async () => {
    const stub = stubFetch({});
    renderAudit(stub);

    expect(
      await screen.findByRole("cell", { name: "platform.company.created" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Test Delivery")).toBeInTheDocument();
    expect(screen.getAllByText("platform.admin").length).toBeGreaterThan(0);
  });

  /**
   * A Platform-only action has no Company. That is a fact about the action, not
   * missing data, so it renders as an explicit dash rather than a blank cell
   * somebody would read as a loading failure.
   */
  it("shows a Platform-only action as having no Company", async () => {
    const stub = stubFetch({
      items: [
        entry({
          action: "platform.authentication.succeeded",
          companyId: null,
          companyName: null,
        }),
      ],
    });
    renderAudit(stub);

    expect(
      await screen.findByRole("cell", { name: "platform.authentication.succeeded" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("sends every filter to the server rather than filtering in the browser", async () => {
    const stub = stubFetch({});
    renderAudit(stub);
    await screen.findByRole("cell", { name: "platform.company.created" });

    fireEvent.change(await screen.findByLabelText("Action"), {
      target: { value: "platform.company.suspended" },
    });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-08-09" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() => {
      const last = stub.urls.filter((url) => url.includes("platform/audit?")).at(-1) ?? "";
      expect(last).toContain("action=platform.company.suspended");
      expect(last).toContain("from=2026-08-01");
      expect(last).toContain("to=2026-08-09");
    });
  });

  /**
   * A day filter must include the day. An upper bound of midnight would drop
   * everything that happened on the date the reader selected.
   */
  it("treats the To date as the whole day", async () => {
    const stub = stubFetch({});
    renderAudit(stub);
    await screen.findByRole("cell", { name: "platform.company.created" });

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-08-09" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() => {
      const last = stub.urls.filter((url) => url.includes("platform/audit?")).at(-1) ?? "";
      expect(decodeURIComponent(last)).toContain("to=2026-08-09T23:59:59Z");
    });
  });

  it("pages on the server", async () => {
    const stub = stubFetch({ total: 60 });
    renderAudit(stub);
    await screen.findByRole("cell", { name: "platform.company.created" });

    expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      const last = stub.urls.filter((url) => url.includes("platform/audit?")).at(-1) ?? "";
      expect(last).toContain("page=2");
    });
  });

  it("collapses structured detail until it is asked for", async () => {
    const stub = stubFetch({});
    renderAudit(stub);
    await screen.findByRole("cell", { name: "platform.company.created" });

    expect(screen.queryByText(/TST-0001/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show detail" }));
    expect(screen.getByText(/TST-0001/)).toBeInTheDocument();
    expect(screen.getByText("corr-1234abcd")).toBeInTheDocument();
  });

  it("reports a refusal instead of rendering an empty history", async () => {
    const stub = stubFetch({ auditStatus: 403 });
    renderAudit(stub);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You may not read the audit history.",
    );
    // An error must never be indistinguishable from "there is nothing here".
    expect(screen.queryByText("No audit entries match these filters.")).not.toBeInTheDocument();
  });

  /**
   * The navigation link and the route are both gated, but neither is the
   * boundary — the API is. This asserts the Portal does not offer a screen it
   * knows the server will refuse.
   */
  it("offers no audit screen to an account without the permission", async () => {
    const stub = stubFetch({ codes: ["platform.access", "platform.companies.read"] });
    renderAudit(stub);

    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "Audit" })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: "Audit" })).not.toBeInTheDocument();
  });
});
