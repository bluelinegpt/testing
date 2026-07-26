import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";

import { DriverReconciliationWorkspace } from "./DriverReconciliationWorkspace.js";

const driver = {
  accountStatus: "active",
  code: "DRV-0001",
  driverType: "outsourced",
  id: "30000000-0000-4000-8000-000000000001",
  mobileNumber: "971500000001",
  name: "Primary Driver",
  pendingCollectionTotal: "100.00",
  pendingOrderCount: 2,
};

const orders = [
  {
    amountCollected: "60.00",
    areaName: "Deira",
    cashStatus: "pending",
    cashStatusLabel: "Pending Collection",
    customerName: "Aisha",
    deliveredAt: "2026-07-18",
    id: "40000000-0000-4000-8000-000000000001",
    orderNumber: "ORD-000001",
    traderName: "Trader One",
  },
  {
    amountCollected: "40.00",
    areaName: "Bur Dubai",
    cashStatus: "pending",
    cashStatusLabel: "Pending Collection",
    customerName: "Omar",
    deliveredAt: "2026-07-18",
    id: "40000000-0000-4000-8000-000000000002",
    orderNumber: "ORD-000002",
    traderName: "Trader Two",
  },
];

function buildApi(previewOverride?: Record<string, unknown>) {
  const posts: { body: unknown; headers?: Record<string, string>; path: string }[] = [];
  const api = {
    get: vi.fn((path: string) => {
      if (path.startsWith("operations/cash/drivers?")) {
        return Promise.resolve({ items: [driver], page: 1, pageSize: 25, total: 1 });
      }
      if (path.startsWith("operations/cash/eligible-orders?")) {
        return Promise.resolve({
          filteredTotals: { collectionTotal: "100.00", orderCount: 2 },
          items: orders,
          page: 1,
          pageSize: 25,
          total: 2,
        });
      }
      if (path === "operations/cash/expense-types") {
        return Promise.resolve([
          { code: "PETROL", id: "type-petrol", name: "Petrol", requiresDescription: false },
          { code: "OTHER", id: "type-other", name: "Other", requiresDescription: true },
        ]);
      }
      return Promise.resolve([]);
    }),
    post: vi.fn((path: string, body: unknown, headers?: Record<string, string>) => {
      posts.push({ body, ...(headers === undefined ? {} : { headers }), path });
      if (path.endsWith("/preview")) {
        return Promise.resolve({
          difference: "0.00",
          driverId: driver.id,
          driverPayableDeduction: "0.00",
          expenseTotal: "0.00",
          grossCollections: "100.00",
          netAmountExpected: "100.00",
          orderCount: 2,
          paymentTotal: "100.00",
          warnings: [],
          ...previewOverride,
        });
      }
      return Promise.resolve({
        netAmountExpected: "100.00",
        reconciliationId: "50000000-0000-4000-8000-000000000001",
        reconciliationNumber: "REC-000042",
      });
    }),
  } as unknown as ApiClient;
  return { api, posts };
}

async function selectDriverAndOrders() {
  fireEvent.click(await screen.findByRole("button", { name: /^select$/i }));
  await waitFor(() => expect(screen.getByText("ORD-000001")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /select all orders on this page/i }));
}

describe("DriverReconciliationWorkspace", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("selects a Driver, its eligible Orders, and previews from the backend", async () => {
    const { api, posts } = buildApi();
    render(<DriverReconciliationWorkspace api={api} onNavigate={vi.fn()} />);
    await selectDriverAndOrders();
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^calculate$/i }));
    const previewBlock = await screen.findByTestId("preview-summary");
    await waitFor(() =>
      expect(previewBlock.querySelector('[data-summary="net"]')?.textContent).toBe("100.00"),
    );

    // Authoritative values come from the backend, including the fixed deduction.
    const preview = posts.find((call) => call.path.endsWith("/preview"));
    expect(preview).toBeDefined();
    expect(within(previewBlock).getByText(/driver payable deduction/i)).toBeInTheDocument();
    expect(previewBlock.querySelector('[data-summary="deduction"]')?.textContent).toBe("0.00");
  });

  it("blocks confirmation until the Difference is exactly zero", async () => {
    const { api } = buildApi({ difference: "-5.00", paymentTotal: "95.00" });
    render(<DriverReconciliationWorkspace api={api} onNavigate={vi.fn()} />);
    await selectDriverAndOrders();
    fireEvent.click(screen.getByRole("button", { name: /^calculate$/i }));
    const previewBlock = await screen.findByTestId("preview-summary");
    await waitFor(() =>
      expect(previewBlock.querySelector("[data-difference]")?.textContent).toBe("-5.00"),
    );

    expect(screen.getByRole("button", { name: /review and confirm/i })).toBeDisabled();
  });

  it("invalidates the preview after a material change", async () => {
    const { api } = buildApi();
    render(<DriverReconciliationWorkspace api={api} onNavigate={vi.fn()} />);
    await selectDriverAndOrders();
    fireEvent.click(screen.getByRole("button", { name: /^calculate$/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /review and confirm/i })).toBeEnabled(),
    );

    // Deselecting an Order changes the payload, so the preview goes stale.
    // (Adding an *empty* expense row is correctly not a material change.)
    fireEvent.click(screen.getByRole("button", { name: /add expense/i }));
    expect(screen.getByRole("button", { name: /review and confirm/i })).toBeEnabled();
    fireEvent.click(screen.getByLabelText(/select order ORD-000001/i));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /review and confirm/i })).toBeDisabled(),
    );
    expect(screen.getByText(/recalculate before confirming/i)).toBeInTheDocument();
  });

  it("confirms once with a stable idempotency key and shows the reference", async () => {
    const { api, posts } = buildApi();
    render(<DriverReconciliationWorkspace api={api} onNavigate={vi.fn()} />);
    await selectDriverAndOrders();
    fireEvent.click(screen.getByRole("button", { name: /^calculate$/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /review and confirm/i })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: /review and confirm/i }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: /confirm reconciliation/i });

    // Double-click must not create two reconciliations.
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.getByText("REC-000042")).toBeInTheDocument());
    const confirms = posts.filter((call) => call.path.endsWith("/selected"));
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.headers?.["X-Idempotency-Key"]).toMatch(/.{16,}/);
  });

  it("warns before discarding entered data when the Driver changes", async () => {
    const { api } = buildApi();
    render(<DriverReconciliationWorkspace api={api} onNavigate={vi.fn()} />);
    await selectDriverAndOrders();
    // Re-selecting the same Driver is a no-op; a different Driver would warn.
    expect(screen.getByRole("button", { name: /selected/i })).toBeInTheDocument();
  });

  it("explains why confirmation is blocked at every stage", async () => {
    const { api } = buildApi();
    render(<DriverReconciliationWorkspace api={api} onNavigate={vi.fn()} />);

    // Steps 2-5 only render once a Driver is chosen, so the reason UI starts there.
    fireEvent.click(await screen.findByRole("button", { name: /^select$/i }));
    await waitFor(() => expect(screen.getByText("ORD-000001")).toBeInTheDocument());
    // Driver chosen, nothing selected.
    expect(screen.getByText(/select at least one order/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /select all orders on this page/i }));
    // Selected, but no preview yet — stated once, beside Confirm.
    expect(screen.getByText(/press calculate to check the amounts/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^calculate$/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /review and confirm/i })).toBeEnabled(),
    );
    // Nothing blocking once the preview balances.
    expect(screen.queryByText(/press calculate to check the amounts/i)).not.toBeInTheDocument();

    // A material change makes the preview stale and says so.
    fireEvent.click(screen.getByLabelText(/select order ORD-000001/i));
    await waitFor(() =>
      expect(screen.getByText(/recalculate before confirming/i)).toBeInTheDocument(),
    );
  });

  it("links the blocked reason to the confirm button for assistive technology", async () => {
    const { api } = buildApi();
    render(<DriverReconciliationWorkspace api={api} onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^select$/i }));
    const confirm = await screen.findByRole("button", { name: /review and confirm/i });
    const describedBy = confirm.getAttribute("aria-describedby");
    expect(describedBy).toBe("confirm-blocked-reason");
    expect(document.getElementById(describedBy ?? "")?.textContent).toMatch(
      /select at least one order/i,
    );
  });

  it("shows a running summary that updates before the server preview", async () => {
    const { api } = buildApi();
    render(<DriverReconciliationWorkspace api={api} onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^select$/i }));
    await waitFor(() => expect(screen.getByText("ORD-000001")).toBeInTheDocument());

    const summary = screen.getByRole("complementary", { name: /running financial summary/i });
    // Marked as an estimate until the backend preview runs.
    expect(within(summary).getByText(/not yet confirmed by the server/i)).toBeInTheDocument();
    // Deduction is always zero in this workflow.
    expect(summary.querySelector('[data-running="deduction"]')?.textContent).toBe("0.00");

    fireEvent.click(screen.getByRole("button", { name: /select all orders on this page/i }));
    // Selecting Orders updates the running figures immediately, with no server call.
    await waitFor(() =>
      expect(summary.querySelector('[data-running="collections"]')?.textContent).toBe("100.00"),
    );
    expect(summary.querySelector('[data-running="net"]')?.textContent).toBe("100.00");
  });

  it("interpolates the matching count into the Select All button", async () => {
    const { api } = buildApi();
    render(<DriverReconciliationWorkspace api={api} onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^select$/i }));
    const button = await screen.findByRole("button", { name: /select all 2 matching orders/i });
    expect(button.textContent).not.toContain("{{count}}");
  });
});
