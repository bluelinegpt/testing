import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";

import { OperationsWorkspace } from "./OperationsWorkspace.js";

const reconciliation = (index: number) => ({
  businessDate: "2026-07-18",
  confirmedAt: "2026-07-18T10:00:00.000Z",
  confirmedBy: "aisha.admin",
  driverName: "Primary Driver",
  driverType: "outsourced",
  expenseTotal: "5.00",
  grossCollections: "100.00",
  id: `20000000-0000-4000-8000-00000000000${index}`,
  netAmountReceived: "95.00",
  orderCount: 2,
  paymentTotal: "95.00",
  reconciliationNumber: `REC-00000${index}`,
  status: "confirmed",
  statusLabel: "Confirmed",
});

function buildApi(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const api = {
    get: vi.fn((path: string) => {
      calls.push(path);
      if (path.startsWith("operations/cash/reconciliations?")) {
        return Promise.resolve(
          overrides.list ?? {
            items: [reconciliation(1), reconciliation(2)],
            page: 1,
            pageSize: 25,
            total: 30,
          },
        );
      }
      if (path.startsWith("operations/cash/reconciliations/")) {
        return Promise.resolve(overrides.detail ?? {});
      }
      if (path.startsWith("operations/cash/drivers?")) {
        return Promise.resolve({
          items: [
            {
              code: "DRV-0001",
              id: "30000000-0000-4000-8000-000000000001",
              name: "Primary Driver",
            },
          ],
          page: 1,
          pageSize: 25,
          total: 1,
        });
      }
      if (path.startsWith("operations/orders?")) {
        return Promise.resolve({ filteredCount: 0, items: [], page: 1, pageSize: 25, total: 0 });
      }
      return Promise.resolve([]);
    }),
    post: vi.fn(() => Promise.resolve({})),
  } as unknown as ApiClient;
  return { api, calls };
}

describe("Driver cash reconciliation list", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("renders the paginated response instead of silently emptying the table", async () => {
    const { api, calls } = buildApi();
    render(<OperationsWorkspace api={api} initialView="cash" />);

    // Items from the paginated envelope must reach the table.
    await waitFor(() => expect(screen.getByText("REC-000001")).toBeInTheDocument());
    expect(screen.getByText("REC-000002")).toBeInTheDocument();
    // The approved default page size is requested.
    expect(calls.some((path) => path.includes("pageSize=25"))).toBe(true);
    // The empty-state must not be shown for a valid non-empty response.
    expect(screen.queryByText(/no driver cash reconciliations/i)).not.toBeInTheDocument();
  });

  it("pages through results and only offers approved page sizes", async () => {
    const { api, calls } = buildApi();
    render(<OperationsWorkspace api={api} initialView="cash" />);
    await waitFor(() => expect(screen.getByText("REC-000001")).toBeInTheDocument());

    const sizeSelect = screen.getByLabelText(/rows/i);
    const options = Array.from(sizeSelect.querySelectorAll("option")).map(
      (option) => option.textContent,
    );
    expect(options).toEqual(["25", "50", "100"]);

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(calls.some((path) => path.includes("page=2"))).toBe(true));

    fireEvent.change(sizeSelect, { target: { value: "50" } });
    await waitFor(() => expect(calls.some((path) => path.includes("pageSize=50"))).toBe(true));
    // Changing the page size returns to the first page.
    expect(calls.at(-1)).toContain("page=1");
  });

  it("searches by reference on the server", async () => {
    const { api, calls } = buildApi();
    render(<OperationsWorkspace api={api} initialView="cash" />);
    await waitFor(() => expect(screen.getByText("REC-000001")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/search reconciliations/i), {
      target: { value: "REC-000002" },
    });
    await waitFor(() =>
      expect(calls.some((path) => path.includes("search=REC-000002"))).toBe(true),
    );
  });

  it("shows an empty state only when the response is genuinely empty", async () => {
    const { api } = buildApi({ list: { items: [], page: 1, pageSize: 25, total: 0 } });
    render(<OperationsWorkspace api={api} initialView="cash" />);
    await waitFor(() =>
      expect(screen.getByText(/no driver cash reconciliations/i)).toBeInTheDocument(),
    );
  });

  it("sends each filter to the server and resets to page 1", async () => {
    const { api, calls } = buildApi();
    render(<OperationsWorkspace api={api} initialView="cash" />);
    await waitFor(() => expect(screen.getByText("REC-000001")).toBeInTheDocument());

    // Move off page 1 so the reset is observable.
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(calls.some((path) => path.includes("page=2"))).toBe(true));

    fireEvent.change(screen.getByLabelText(/date from/i), { target: { value: "2026-07-01" } });
    await waitFor(() => expect(calls.at(-1)).toContain("dateFrom=2026-07-01"));
    expect(calls.at(-1)).toContain("page=1");

    fireEvent.change(screen.getByLabelText(/date to/i), { target: { value: "2026-07-31" } });
    await waitFor(() => expect(calls.at(-1)).toContain("dateTo=2026-07-31"));

    fireEvent.change(screen.getByLabelText(/^status$/i), { target: { value: "confirmed" } });
    await waitFor(() => expect(calls.at(-1)).toContain("status=confirmed"));

    fireEvent.change(screen.getByLabelText(/payment method/i), {
      target: { value: "bank_transfer" },
    });
    await waitFor(() => expect(calls.at(-1)).toContain("paymentMethod=bank_transfer"));

    // Filters combine rather than replace one another.
    const combined = calls.at(-1) ?? "";
    expect(combined).toContain("dateFrom=2026-07-01");
    expect(combined).toContain("dateTo=2026-07-31");
    expect(combined).toContain("status=confirmed");
    expect(combined).toContain("paymentMethod=bank_transfer");
  });

  it("filters by Driver using the server-side Driver search", async () => {
    const { api, calls } = buildApi();
    render(<OperationsWorkspace api={api} initialView="cash" />);
    await waitFor(() => expect(screen.getByText("REC-000001")).toBeInTheDocument());
    // The Driver list is fetched a page at a time, never in full.
    await waitFor(() =>
      expect(calls.some((path) => path.startsWith("operations/cash/drivers?"))).toBe(true),
    );
    expect(calls.some((path) => path.includes("operations/cash/drivers?pageSize=25"))).toBe(true);

    fireEvent.change(screen.getByLabelText(/^driver$/i), {
      target: { value: "30000000-0000-4000-8000-000000000001" },
    });
    await waitFor(() =>
      expect(calls.at(-1)).toContain("driverId=30000000-0000-4000-8000-000000000001"),
    );
  });

  it("clears all filters back to the default list", async () => {
    const { api, calls } = buildApi();
    render(<OperationsWorkspace api={api} initialView="cash" />);
    await waitFor(() => expect(screen.getByText("REC-000001")).toBeInTheDocument());

    const clear = screen.getByRole("button", { name: /clear filters/i });
    expect(clear).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^status$/i), { target: { value: "confirmed" } });
    await waitFor(() => expect(calls.at(-1)).toContain("status=confirmed"));
    expect(clear).toBeEnabled();

    fireEvent.click(clear);
    await waitFor(() => expect(calls.at(-1)).not.toContain("status=confirmed"));
    expect(calls.at(-1)).toContain("page=1");
    expect(calls.at(-1)).toContain("pageSize=25");
  });

  it("distinguishes an empty dataset from an empty filtered result", async () => {
    const { api } = buildApi({ list: { items: [], page: 1, pageSize: 25, total: 0 } });
    render(<OperationsWorkspace api={api} initialView="cash" />);
    await waitFor(() =>
      expect(screen.getByText(/no driver cash reconciliations/i)).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText(/^status$/i), { target: { value: "draft" } });
    await waitFor(() =>
      expect(screen.getByText(/no reconciliations match the current filters/i)).toBeInTheDocument(),
    );
  });
});
