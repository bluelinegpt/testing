import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { TraderReceivablesWorkspace } from "./TraderReceivablesWorkspace.js";

/**
 * The Receivable detail shows each Settlement offset as Effective or as
 * Historical (its Settlement was reversed). SET-000008 -> SET-000010 reversal
 * -> SET-000011: the Receivable was settled ONCE; the SET-000008 row stays
 * visible as history and is never presented as a current settlement.
 */

const receivableId = "22222222-2222-4222-8222-222222222222";

function detail(offsets: readonly object[], status = "collected") {
  return {
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
    receivableNumber: "RCV-000060",
    settlementOffsetAmount: "18.00",
    settlementOffsets: offsets,
    sourceOrderId: "order-1",
    sourceReference: "ORD-000120",
    sourceType: "service_charge",
    status,
    totalSettledAmount: "18.00",
    traderCode: "TRD-000001",
    traderId: "trader-1",
    traderName: "Test Trader",
  };
}

function setup(body: object) {
  const api = {
    get: vi.fn((path: string) => {
      if (path === `operations/trader-receivables/receivables/${receivableId}`) {
        return Promise.resolve(body);
      }
      if (path === "operations/trader-receivables/summary") return Promise.resolve({});
      if (path === "operations/traders") return Promise.resolve([]);
      if (path === "operations/trader-receivables/traders-with-balance") return Promise.resolve([]);
      return Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0 });
    }),
    getBinary: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
  };
  render(
    <MemoryRouter>
      <TraderReceivablesWorkspace
        api={api as unknown as ApiClient}
        permissions={["trader_receivables.create", "trader_receivables.reverse"]}
        receivableDetailId={receivableId}
      />
    </MemoryRouter>,
  );
}

const historyTable = async () => {
  const heading = await screen.findByRole("heading", { name: "Settlement Offset History" });
  return within(heading.closest("section")!).getByRole("table");
};

describe("Receivable detail: effective vs historical settlement offsets", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
    window.history.replaceState({}, "", "/trader-receivables");
  });

  it("labels the reversed Settlement's offset Historical and the re-settlement Effective", async () => {
    setup(
      detail([
        {
          amountOffset: "18.00",
          effective: false,
          offsetDate: "2026-09-20",
          settlementId: "set-8",
          settlementNumber: "SET-000008",
        },
        {
          amountOffset: "18.00",
          effective: true,
          offsetDate: "2026-09-25",
          settlementId: "set-11",
          settlementNumber: "SET-000011",
        },
      ]),
    );
    const table = await historyTable();
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("SET-000008")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Historical — Settlement Reversed")).toBeInTheDocument();
    expect(within(rows[0]!).queryByText("Effective")).toBeNull();
    expect(within(rows[1]!).getByText("SET-000011")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Effective")).toBeInTheDocument();
    // History is kept, never removed.
    expect(within(table).getAllByText("Historical — Settlement Reversed")).toHaveLength(1);
  });

  it("treats an offset without the flag (older API) as effective", async () => {
    setup(
      detail([
        {
          amountOffset: "18.00",
          offsetDate: "2026-09-25",
          settlementId: "set-11",
          settlementNumber: "SET-000011",
        },
      ]),
    );
    const table = await historyTable();
    expect(within(table).getByText("Effective")).toBeInTheDocument();
    expect(within(table).queryByText("Historical — Settlement Reversed")).toBeNull();
  });

  it("does not offer the receivable reversal when only historical offsets remain", async () => {
    setup(
      detail(
        [
          {
            amountOffset: "18.00",
            effective: false,
            offsetDate: "2026-09-20",
            settlementId: "set-8",
            settlementNumber: "SET-000008",
          },
        ],
        "partially_collected",
      ),
    );
    await historyTable();
    expect(screen.queryByRole("button", { name: "Reverse Trader Receivable" })).toBeNull();
  });
});
