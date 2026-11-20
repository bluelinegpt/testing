import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { TraderReceivablesWorkspace } from "./TraderReceivablesWorkspace.js";

/**
 * Trader Collection "Un-post & adjust" and "Post again" (Aiman, 20 Nov 2026):
 * both open a draft on Trader Settlements, so the fees can be changed and the
 * collection posted again under a new number.
 */

const summary = {
  collectedThisPeriod: "0.00",
  outstandingReceivablesCount: 0,
  partiallyCollectedAmount: "0.00",
  reversedCollections: 1,
  totalOutstandingReceivables: "0.00",
  totalRemainingDue: "0.00",
  tradersWithOutstandingReceivables: 0,
};

function collection(overrides: Record<string, unknown>) {
  return {
    allocations: [],
    collectionId: "collection-22",
    collectionNumber: "COL-000022",
    companyBankAccount: null,
    createdAt: "2026-10-27T02:22:00Z",
    notes: null,
    paymentDate: "2026-10-27",
    paymentMethod: "cash",
    paymentReference: null,
    receivedBy: "ahmed",
    replacedBy: [],
    replaces: null,
    reversalDate: null,
    reversalReason: null,
    reversedBy: null,
    status: "confirmed",
    summary: {
      amountReceivedNow: "120.00",
      previouslyCollected: "0.00",
      receivableCount: 4,
      remainingDue: "0.00",
      totalOriginalAmountDue: "120.00",
    },
    traderName: "مزاد ابو ظبي",
    ...overrides,
  };
}

function setup(
  detail: Record<string, unknown>,
  permissions: readonly string[] = ["users_roles.manage"],
) {
  const writes: { body: unknown; path: string }[] = [];
  const onNavigate = vi.fn();
  const write = (path: string, body: unknown) => {
    writes.push({ body, path });
    if (path.endsWith("/repost")) {
      return Promise.resolve({
        collectionNumber: "COL-000022",
        draftId: "draft-9",
        skippedReceivables: [],
      });
    }
    if (path.endsWith("/unpost")) {
      return Promise.resolve({
        draftId: "draft-8",
        reversalSettlementNumber: "—",
        settlementNumber: "COL-000022",
        skippedReceivables: [],
      });
    }
    return Promise.resolve({});
  };
  const api = {
    get: vi.fn((path: string) => {
      if (path === "operations/settlements/payments/settings")
        return Promise.resolve({ oneScreen: true });
      if (path === "operations/trader-receivables/summary") return Promise.resolve(summary);
      if (path === "operations/trader-receivables/collections/collection-22")
        return Promise.resolve(detail);
      if (
        path === "operations/traders" ||
        path === "operations/trader-receivables/traders-with-balance"
      ) {
        return Promise.resolve([]);
      }
      return Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0 });
    }),
    getBinary: vi.fn(() => Promise.resolve(new Blob())),
    patch: vi.fn(write),
    post: vi.fn(write),
    postLong: vi.fn(write),
  };
  render(
    <MemoryRouter>
      <TraderReceivablesWorkspace
        api={api as unknown as ApiClient}
        collectionDetailId="collection-22"
        onNavigate={onNavigate}
        permissions={permissions}
      />
    </MemoryRouter>,
  );
  return { onNavigate, writes };
}

async function detailDialog() {
  return within(await screen.findByRole("dialog", { name: "Trader Collection Detail" }));
}

describe("Trader Collection Un-post & adjust / Post again", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
    window.history.replaceState({}, "", "/trader-receivables");
  });

  it("Un-post & adjust asks for a reason, un-posts the collection and opens the draft", async () => {
    const { onNavigate, writes } = setup(collection({}));
    const dialog = await detailDialog();
    fireEvent.click(await dialog.findByRole("button", { name: "Un-post & adjust" }));
    const unpost = within(await screen.findByRole("dialog", { name: "Un-post COL-000022" }));
    fireEvent.change(unpost.getByLabelText("Reason"), {
      target: { value: "تصحيح رسوم ORD-001659" },
    });
    fireEvent.click(unpost.getByRole("button", { name: "Un-post & adjust" }));
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith("/trader-settlements?openDraftId=draft-8"),
    );
    expect(writes).toEqual([
      {
        body: { reason: "تصحيح رسوم ORD-001659" },
        path: "operations/settlements/collections/collection-22/unpost",
      },
    ]);
    expect(dialog.queryByRole("button", { name: "Post again" })).toBeNull();
  });

  it("a reversed collection offers Post again, which opens its fees as a draft", async () => {
    const { onNavigate, writes } = setup(
      collection({
        reversalDate: "2026-11-20T14:46:00Z",
        reversalReason: "تصحيح رسوم ORD-001659",
        reversedBy: "admin",
        status: "reversed",
      }),
    );
    const dialog = await detailDialog();
    expect(dialog.queryByRole("button", { name: "Un-post & adjust" })).toBeNull();
    fireEvent.click(await dialog.findByRole("button", { name: "Post again" }));
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith("/trader-settlements?openDraftId=draft-9"),
    );
    expect(writes.map((call) => call.path)).toEqual([
      "operations/settlements/collections/collection-22/repost",
    ]);
  });

  it("a reversed collection already posted again shows its replacement and no Post again", async () => {
    setup(
      collection({
        replacedBy: [
          { collectionId: "collection-31", collectionNumber: "COL-000031", status: "confirmed" },
        ],
        reversalDate: "2026-11-20T14:46:00Z",
        reversalReason: "fee",
        reversedBy: "admin",
        status: "reversed",
      }),
    );
    const dialog = await detailDialog();
    expect(await dialog.findByRole("button", { name: "COL-000031" })).toBeInTheDocument();
    expect(dialog.getByText("Replaced by")).toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Post again" })).toBeNull();
  });

  it("is not offered without the settlement permissions", async () => {
    setup(
      collection({
        status: "reversed",
        reversalDate: "2026-11-20T14:46:00Z",
        reversalReason: "x",
        reversedBy: "admin",
      }),
      ["trader_receivables.create", "trader_receivables.reverse"],
    );
    const dialog = await detailDialog();
    await dialog.findByText("COL-000022");
    expect(dialog.queryByRole("button", { name: "Post again" })).toBeNull();
  });
});
