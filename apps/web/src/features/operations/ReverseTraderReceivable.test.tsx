import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { TraderReceivablesWorkspace } from "./TraderReceivablesWorkspace.js";

/**
 * Reverse Trader Receivable: preview -> reason -> confirmation -> execute ->
 * refresh, scoped to ONE Receivable from end to end.
 *
 * The thing this exists to prevent: a dialog naming one Receivable and one
 * amount that POSTs to `operations/settlements/payments/:settlementId/reverse`
 * and unwinds the whole Settlement (on SET-000007, six offsets and the payment
 * to the Trader). So every case asserts the exact write that was issued, and
 * that the settlement-scoped route was never touched.
 */

const receivableId = "11111111-1111-4111-8111-111111111111";

const detail = {
  amountCollected: "18.00",
  businessDate: "2026-10-01",
  cancelledAt: null,
  cancelledBy: null,
  cancelledReason: null,
  collections: [],
  createdAt: "2026-10-01T10:51:00Z",
  createdBy: "Operator",
  notes: null,
  originalAmountDue: "18.00",
  outstandingAmount: "0.00",
  physicalCollectionAmount: "0.00",
  reason: "Trader-paid delivery fee",
  receivableId,
  receivableNumber: "RCV-000047",
  settlementOffsetAmount: "18.00",
  settlementOffsets: [
    {
      amountOffset: "18.00",
      offsetDate: "2026-10-01",
      settlementId: "set-7",
      settlementNumber: "SET-000007",
    },
  ],
  sourceOrderId: "order-108",
  sourceReference: "ORD-000108",
  sourceType: "service_charge",
  status: "collected",
  totalSettledAmount: "18.00",
  traderCode: "TRD-000001",
  traderId: "trader-1",
  traderName: "Test Trader",
};

const preview = {
  amount: "18.00",
  blockedReason: null,
  blockedReasonCode: null,
  executionAvailable: true,
  offsetAmount: "18.00",
  orderId: "order-108",
  orderNumber: "ORD-000108",
  orderSettlementStatus: "not_eligible",
  orderStatus: "delivered",
  physicalCashMovement: "0.00",
  physicalCollectionCount: 0,
  receivableId,
  receivableNumber: "RCV-000047",
  settlementId: "set-7",
  settlementNumber: "SET-000007",
  settlementOffsetCount: 6,
  settlementStatus: "confirmed",
  settlementWillRemainConfirmed: true,
  traderCompensation: "18.00",
  traderNetPositionChange: "0.00",
  untouchedOffsetCount: 5,
};

function setup(
  options: { readonly permissions?: readonly string[]; readonly preview?: object } = {},
) {
  const gets: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const api = {
    get: vi.fn((path: string) => {
      gets.push(path);
      if (path === `operations/trader-receivables/receivables/${receivableId}`) {
        return Promise.resolve(detail);
      }
      if (path === `operations/trader-receivables/${receivableId}/reversal-preview`) {
        return Promise.resolve(options.preview ?? preview);
      }
      if (path === "operations/trader-receivables/summary") return Promise.resolve({});
      if (path === "operations/traders") return Promise.resolve([]);
      if (path === "operations/trader-receivables/traders-with-balance") return Promise.resolve([]);
      return Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0 });
    }),
    getBinary: vi.fn(),
    patch: vi.fn(),
    post: vi.fn((path: string, body: unknown) => {
      posts.push({ body, path });
      return Promise.resolve({
        alreadyReversed: false,
        creditAmount: "18.00",
        creditId: "credit-1",
        creditNumber: "TCR-000001",
        orderNumber: "ORD-000108",
        orderSettlementStatusChanged: false,
        otherOffsetsAffected: 0,
        receivableId,
        receivableNumber: "RCV-000047",
        receivableStatus: "reversed",
        settlementNumber: "SET-000007",
        settlementStatus: "confirmed",
      });
    }),
  };
  render(
    <MemoryRouter>
      <TraderReceivablesWorkspace
        api={api as unknown as ApiClient}
        permissions={
          options.permissions ?? ["trader_receivables.create", "trader_receivables.reverse"]
        }
        receivableDetailId={receivableId}
      />
    </MemoryRouter>,
  );
  return { api, gets, posts };
}

describe("Reverse Trader Receivable", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
    window.history.replaceState({}, "", "/trader-receivables");
  });

  it("previews, asks for a reason, confirms, executes ONE receivable-scoped reversal and refreshes", async () => {
    const { gets, posts } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Reverse Trader Receivable" }));

    // Preview: read-only, receivable-scoped, and states what stays unchanged.
    const dialog = await screen.findByRole("dialog", { name: "Reverse Trader Receivable" });
    expect(
      await within(dialog).findByText("SET-000007 (confirmed) — remains unchanged"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("5 — untouched")).toBeInTheDocument();
    expect(within(dialog).getByText("not_eligible — unchanged")).toBeInTheDocument();
    expect(gets).toContain(`operations/trader-receivables/${receivableId}/reversal-preview`);
    expect(posts).toHaveLength(0);

    // Reason: required before the confirmation step is reachable.
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    const reasonContinue = within(dialog).getByRole("button", { name: "Continue" });
    expect(reasonContinue).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Reversal reason"), {
      target: { value: "  Fee taken before delivery  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));

    // Confirmation: nothing written until it is explicitly confirmed.
    expect(
      within(dialog).getByText(
        "Reverse RCV-000047 for AED 18.00 and issue a Trader Credit of AED 18.00?",
      ),
    ).toBeInTheDocument();
    expect(posts).toHaveLength(0);
    const detailLoadsBefore = gets.filter(
      (path) => path === `operations/trader-receivables/receivables/${receivableId}`,
    ).length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm reversal" }));

    // Execute: exactly one write, to the receivable-scoped route, with the
    // trimmed reason -- never the settlement-scoped reversal.
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      body: { reason: "Fee taken before delivery" },
      path: `operations/trader-receivables/${receivableId}/reverse`,
    });
    expect(posts.some(({ path }) => path.includes("settlements/payments"))).toBe(false);

    // Refresh: the Receivable detail is reloaded after success.
    await waitFor(() =>
      expect(
        gets.filter((path) => path === `operations/trader-receivables/receivables/${receivableId}`)
          .length,
      ).toBeGreaterThan(detailLoadsBefore),
    );
    expect(
      await within(dialog).findByText(
        "RCV-000047 reversed. Trader Credit TCR-000001 for AED 18.00 issued; settlement SET-000007 and the order are unchanged.",
      ),
    ).toBeInTheDocument();
  });

  it("reports the server's refusal and offers no way to execute", async () => {
    const { posts } = setup({
      preview: {
        ...preview,
        blockedReason: "The clearing Settlement is not confirmed",
        blockedReasonCode: "trader_settlement_not_confirmed",
        executionAvailable: false,
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Reverse Trader Receivable" }));
    const dialog = await screen.findByRole("dialog", { name: "Reverse Trader Receivable" });
    expect(
      await within(dialog).findByText(
        "This receivable cannot be reversed: The clearing Settlement is not confirmed",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Continue" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Confirm reversal" })).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it("is not offered without the reverse permission", async () => {
    setup({ permissions: ["trader_receivables.create"] });
    expect(await screen.findByText("RCV-000047", { selector: "dd" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reverse Trader Receivable" })).toBeNull();
  });
});
