import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { TraderReceivablesWorkspace } from "./TraderReceivablesWorkspace.js";

/**
 * Trader Receivables mount behaviour.
 *
 * ---------------------------------------------------------------------------
 * WHY A TEST THAT MOSTLY JUST RENDERS IS WORTH KEEPING
 * ---------------------------------------------------------------------------
 *
 * The workspace stopped mounting entirely: its initial-tab `useState`
 * initializer read `collectionDetailId`, a `const` declared fifty lines further
 * down by `useRouteDetail`, so every render threw
 *
 *     ReferenceError: Cannot access 'collectionDetailId' before initialization
 *
 * and the error boundary swallowed the whole screen. Nothing was wrong with the
 * data, the API, or the permissions — which is exactly why nothing else caught
 * it. There was no test that simply asserted this screen appears.
 *
 * A temporal-dead-zone fault is invisible to the type checker (the binding
 * exists and has the right type; only its ORDER is wrong) and invisible to a
 * production build. It shows up at runtime or not at all. So the first case
 * below is the important one, and it is deliberately unglamorous: mount the
 * workspace and assert it rendered rather than threw.
 *
 * The rest pin the behaviour the fix had to preserve — the initial tab is still
 * derived from the initial route input, and mounting still writes nothing.
 */

function renderWithRouter(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

const summary = {
  collectedThisPeriod: "150.00",
  outstandingReceivablesCount: 2,
  partiallyCollectedAmount: "25.00",
  reversedCollections: 0,
  totalOutstandingReceivables: "450.00",
  totalRemainingDue: "300.00",
  tradersWithOutstandingReceivables: 1,
};

const receivableRow = {
  amountDue: "300.00",
  businessDate: "2026-08-04",
  receivableId: "receivable-1",
  receivableNumber: "RCV-000001",
  remainingDue: "300.00",
  sourceType: "manual",
  status: "outstanding",
  traderCode: "TRD-000004",
  traderId: "trader-1",
  traderName: "Test Trader",
};

function setup(
  overrides: {
    readonly collectionDetailId?: string;
    readonly permissions?: readonly string[];
  } = {},
) {
  const getCalls: string[] = [];
  const writeCalls: string[] = [];
  const api = {
    get: vi.fn((path: string) => {
      getCalls.push(path);
      if (path === "operations/trader-receivables/summary") {
        return Promise.resolve(summary);
      }
      if (path.startsWith("operations/trader-receivables/eligible")) {
        return Promise.resolve({ items: [receivableRow], page: 1, pageSize: 25, total: 1 });
      }
      // The Collection detail dialog opens on its own when a Collection route is
      // supplied. Its full shape is not what these cases are about, and the
      // component already handles a failed load, so this stays a rejection
      // rather than a second fixture that would have to track that dialog.
      if (/^operations\/trader-receivables\/collections\/[^/?]+$/.test(path)) {
        return Promise.reject(new Error("detail not stubbed"));
      }
      // These two answer with a plain ARRAY, not a paged envelope. The generic
      // fallback below returns `{ items: [] }`, which the filter bar's
      // `traders.map` rightly throws on.
      if (path === "operations/traders") {
        return Promise.resolve([{ code: "TRD-000004", id: "trader-1", name: "Test Trader" }]);
      }
      if (path === "operations/trader-receivables/traders-with-balance") {
        return Promise.resolve([]);
      }
      return Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0 });
    }),
    getBinary: vi.fn(() => Promise.resolve(new Blob(["%PDF-fake"], { type: "application/pdf" }))),
    patch: vi.fn((path: string) => {
      writeCalls.push(path);
      return Promise.resolve({});
    }),
    post: vi.fn((path: string) => {
      writeCalls.push(path);
      return Promise.resolve({});
    }),
  };
  renderWithRouter(
    <TraderReceivablesWorkspace
      api={api as unknown as ApiClient}
      permissions={overrides.permissions ?? ["trader_receivables.create"]}
      {...(overrides.collectionDetailId === undefined
        ? {}
        : { collectionDetailId: overrides.collectionDetailId })}
    />,
  );
  return { api, getCalls, writeCalls };
}

function tab(name: string) {
  return screen.getByRole("button", { name });
}

describe("TraderReceivablesWorkspace", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
    // The tab initializer reads `window.location.search` directly, not the
    // Router, so the query has to be set on jsdom's own location.
    window.history.replaceState({}, "", "/trader-receivables");
  });

  it("mounts without throwing when no Collection detail is supplied", async () => {
    setup();
    // Reaching this assertion at all is the point: before the fix the component
    // threw during render and nothing below the error boundary existed.
    expect(
      await screen.findByRole("heading", { level: 1, name: "Trader Receivables" }),
    ).toBeInTheDocument();
    expect(tab("Outstanding Receivables")).toBeInTheDocument();
    expect(tab("Collections")).toBeInTheDocument();
  });

  it("shows current receivables data once loaded", async () => {
    setup();
    expect(await screen.findByText("RCV-000001")).toBeInTheDocument();
  });

  it("defaults to the Outstanding Receivables tab with no route input", async () => {
    setup();
    await screen.findByRole("heading", { level: 1, name: "Trader Receivables" });
    expect(tab("Outstanding Receivables")).toHaveAttribute("aria-pressed", "true");
    expect(tab("Collections")).toHaveAttribute("aria-pressed", "false");
  });

  it("opens on the Collections tab when a Collection detail route is supplied", async () => {
    // This is the branch that used to read the not-yet-initialized binding. It
    // must still resolve from the route prop, not from post-mount state.
    setup({ collectionDetailId: "collection-1" });
    await screen.findByRole("heading", { level: 1, name: "Trader Receivables" });
    expect(tab("Collections")).toHaveAttribute("aria-pressed", "true");
    expect(tab("Outstanding Receivables")).toHaveAttribute("aria-pressed", "false");
  });

  it("opens on the Collections tab when the initial query carries a Collection filter", async () => {
    window.history.replaceState({}, "", "/trader-receivables?traderId=trader-1");
    setup();
    await screen.findByRole("heading", { level: 1, name: "Trader Receivables" });
    expect(tab("Collections")).toHaveAttribute("aria-pressed", "true");
  });

  it("writes nothing merely by rendering", async () => {
    const { writeCalls } = setup();
    await screen.findByText("RCV-000001");
    await waitFor(() => {
      expect(writeCalls).toStrictEqual([]);
    });
  });
});
