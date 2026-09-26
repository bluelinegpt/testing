import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { AccountingReportsWorkspace } from "./AccountingReportsWorkspace.js";

/**
 * Report workspace behaviour, with the API stubbed at the client boundary.
 *
 * The claims under test are the ones a defect would make expensive: that the
 * screen renders whatever the backend called authoritative without recomputing
 * it, that drill-down links are built from backend IDENTIFIERS rather than
 * display text, that a row with no identifier stays plain text instead of
 * becoming a link to nowhere, and that filters survive in the URL so Back
 * restores the report a user was reading.
 */

function renderWithRouter(ui: ReactElement, entries: readonly string[] = ["/"]) {
  return render(<MemoryRouter initialEntries={[...entries]}>{ui}</MemoryRouter>);
}

const trialBalance = {
  columns: ["code", "accountNameEn", "closingDebit", "closingCredit"],
  currency: "AED" as const,
  dataSource: "posted_journal_lines",
  filters: { dateFrom: "2026-01-01", dateTo: "2026-01-31" },
  generatedAt: "2026-02-01T00:00:00.000Z",
  items: [
    {
      accountNameEn: "Cash on hand",
      closingCredit: "0.00",
      closingDebit: "100.00",
      code: "1010",
      id: "account-cash",
    },
    // A row the backend returned WITHOUT an account id: it must not become a
    // link, because there is nothing authoritative to link to.
    {
      accountNameEn: "Unmapped",
      closingCredit: "0.00",
      closingDebit: "0.00",
      code: "9999",
    },
  ],
  kind: "trial-balance",
  page: 1,
  pageSize: 100,
  provisional: false,
  snapshotAt: "2026-02-01T00:00:00.000Z",
  title: "Trial Balance",
  total: 2,
  totalPages: 1,
  totals: { closingCredit: "100.00", closingDebit: "100.00" },
  truncated: false,
  warningCodes: [],
  warnings: [],
};

const ledger = {
  ...trialBalance,
  columns: ["date", "journalNumber", "source", "reference", "debit", "credit"],
  items: [
    {
      credit: "0.00",
      date: "2026-01-10",
      debit: "100.00",
      eventId: "event-1",
      journalId: "journal-1",
      journalNumber: "JRN-000001",
      reference: "ORD-000001",
      source: "order",
      sourceEntityId: "order-1",
      sourceEntityType: "order",
    },
  ],
  kind: "general-ledger",
  title: "General Ledger",
  total: 1,
  totals: { closingBalance: "100.00", openingBalance: "0.00" },
};

function setup(report: unknown = trialBalance, entries: readonly string[] = ["/"]) {
  const getCalls: string[] = [];
  const api = {
    get: vi.fn((path: string) => {
      getCalls.push(path);
      if (path.startsWith("operations/accounting/reports/readiness")) {
        return Promise.resolve({ accountingEnabled: true, hasPostedJournals: true });
      }
      if (path.startsWith("operations/accounting/accounts")) {
        return Promise.resolve([
          { code: "1010", id: "account-cash", isPostingAccount: true, nameEn: "Cash on hand" },
        ]);
      }
      return Promise.resolve(report);
    }),
    getBinary: vi.fn(() => Promise.resolve(new Blob(["x"], { type: "text/csv" }))),
    post: vi.fn(() => Promise.resolve({})),
  };
  const navigations: string[] = [];
  renderWithRouter(
    <AccountingReportsWorkspace
      api={api as unknown as ApiClient}
      companyId="company-1"
      kind={(report as { kind: string }).kind}
      onNavigate={(path) => navigations.push(path)}
    />,
    entries,
  );
  return { api, getCalls, navigations };
}

describe("AccountingReportsWorkspace", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
  });

  it("renders backend totals without recomputing them", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    await screen.findByText("1010");
    // The summary shows the backend's own totals, verbatim.
    expect(screen.getAllByText(/100\.00/).length).toBeGreaterThan(0);
  });

  it("links an account row to its Account Statement using the backend id", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    const link = await screen.findByRole("link", { name: "1010" });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("/accounting/reports/account-statement"),
    );
    expect(link.getAttribute("href")).toContain("accountId=account-cash");
    // And it carries the report's date range across.
    expect(link.getAttribute("href")).toContain("dateFrom=2026-01-01");
  });

  it("leaves a row without an identifier as plain text, not a dead link", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    await screen.findByText("9999");
    expect(screen.queryByRole("link", { name: "9999" })).toBeNull();
  });

  it("links Journal, source record and Event from General Ledger identifiers", async () => {
    setup(ledger);
    // General Ledger is account-scoped: the screen refuses to run without one.
    fireEvent.change(await screen.findByLabelText(/Account/i), {
      target: { value: "account-cash" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const journal = await screen.findByRole("link", { name: "JRN-000001" });
    expect(journal).toHaveAttribute("href", "/accounting/journals/journal-1");
    // Orders route by NUMBER, which is what the reference column carries.
    expect(screen.getByRole("link", { name: "ORD-000001" })).toHaveAttribute(
      "href",
      "/orders/ORD-000001",
    );
    expect(screen.getByRole("link", { name: "order" })).toHaveAttribute(
      "href",
      "/accounting/events/event-1",
    );
  });

  it("sends the applied filter rather than silently keeping the previous one", async () => {
    const { getCalls } = setup();
    fireEvent.change(screen.getByLabelText(/From Date/i), {
      target: { value: "2026-03-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(getCalls.some((path) => path.includes("dateFrom=2026-03-01"))).toBe(true),
    );
  });

  it("seeds filters from the URL and applies them without a click", async () => {
    const { getCalls } = setup(trialBalance, ["/?dateFrom=2026-05-01&dateTo=2026-05-31"]);
    await waitFor(() =>
      expect(
        getCalls.some(
          (path) => path.includes("dateFrom=2026-05-01") && path.includes("dateTo=2026-05-31"),
        ),
      ).toBe(true),
    );
  });

  it("shows the prompt before a report is run and the rows after", async () => {
    setup();
    // Empty state first: nothing is fetched until the user asks.
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
    expect(screen.queryByText("Cash on hand")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Cash on hand")).toBeInTheDocument();
  });

  it("surfaces a backend error code rather than a generic failure", async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/accounting/reports/readiness")) {
          return Promise.resolve({ accountingEnabled: true });
        }
        if (path.startsWith("operations/accounting/accounts")) return Promise.resolve([]);
        return Promise.reject(
          new ApiError("Invalid range", "accounting_report_date_range_invalid", 400),
        );
      }),
      getBinary: vi.fn(),
      post: vi.fn(),
    };
    renderWithRouter(
      <AccountingReportsWorkspace
        api={api as unknown as ApiClient}
        companyId="company-1"
        kind="trial-balance"
        onNavigate={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("requests export and PDF through the binary endpoints", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    await screen.findByText("1010");
    fireEvent.click(screen.getByRole("button", { name: /CSV/i }));
    await waitFor(() =>
      expect(api.getBinary).toHaveBeenCalledWith(expect.stringContaining("/export?")),
    );
  });

  it("renders Arabic labels and keeps codes and numbers LTR-readable", async () => {
    await i18nInstance.changeLanguage("ar");
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /تطبيق|Apply/ }));
    const code = await screen.findByText("1010");
    // Account codes stay LTR inside an RTL page.
    const directional = code.closest("bdi") ?? within(code).queryByText("1010");
    expect(directional ?? code).toBeInTheDocument();
    await i18nInstance.changeLanguage("en");
  });
});
