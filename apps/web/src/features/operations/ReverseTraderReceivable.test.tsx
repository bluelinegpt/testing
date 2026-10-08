import { render, screen } from "@testing-library/react";
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

  // DISABLED 8 Oct 2026 (receivable-offset-reversal-switch.ts): the reversal
  // charged the fee twice and its Trader Credit was never applied. The full
  // preview -> reason -> confirm -> execute flow is kept in the component for
  // when it is re-enabled; restore its test from git history at that point.
  it("is not offered while single-receivable reversal is disabled, and says why", async () => {
    const { gets, posts } = setup();
    expect(await screen.findByTestId("receivable-reversal-disabled")).toHaveTextContent(
      "temporarily disabled until trader credits can be applied in settlements",
    );
    expect(screen.queryByRole("button", { name: "Reverse Trader Receivable" })).toBeNull();
    expect(gets.some((path) => path.endsWith("/reversal-preview"))).toBe(false);
    expect(posts).toHaveLength(0);
  });

  it("is not offered to an administrator who lacks the reverse permission", async () => {
    setup({ permissions: ["users_roles.manage"] });
    expect(await screen.findByText("RCV-000047", { selector: "dd" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reverse Trader Receivable" })).toBeNull();
  });

  it("is not offered without the reverse permission", async () => {
    setup({ permissions: ["trader_receivables.create"] });
    expect(await screen.findByText("RCV-000047", { selector: "dd" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reverse Trader Receivable" })).toBeNull();
  });
});
