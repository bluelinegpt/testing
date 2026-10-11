import { describe, expect, it } from "vitest";

import {
  CORE_DELIVERY_ACCOUNTING_AREAS,
  disableBlockers,
  disableConfirmationFor,
  enableConfirmationFor,
  type UnresolvedAccountingWork,
} from "./company-accounting-mode.service.js";

const clean: UnresolvedAccountingWork = {
  eventsByStatus: [],
  failed: 0,
  otherUnresolved: 0,
  pending: 0,
  runningBatches: [],
  sampleEventIds: [],
  unfinishedJournals: [],
};

describe("Company Accounting Mode rules", () => {
  it("allows disable only when there is no unresolved accounting work", () => {
    expect(disableBlockers(clean)).toEqual([]);
  });

  it("reports pending, failed and in-flight events separately, with counts", () => {
    expect(disableBlockers({ ...clean, failed: 2, otherUnresolved: 1, pending: 3 })).toEqual([
      { code: "pending_accounting_events", detail: "3" },
      { code: "failed_accounting_events", detail: "2" },
      { code: "in_flight_accounting_events", detail: "1" },
    ]);
  });

  it("treats unfinished journals and running batches as work that would be stranded", () => {
    expect(
      disableBlockers({
        ...clean,
        runningBatches: [{ count: 1, status: "processing" }],
        unfinishedJournals: [{ count: 4, status: "draft" }],
      }),
    ).toEqual([
      { code: "unfinished_journal_entries", detail: "draft:4" },
      { code: "running_accounting_batches", detail: "processing:1" },
    ]);
  });

  it("binds the typed confirmation to the Company's own code", () => {
    expect(enableConfirmationFor("ACME")).toBe("ENABLE ACCOUNTING ACME");
    expect(disableConfirmationFor("ACME")).toBe("DISABLE ACCOUNTING ACME");
    expect(enableConfirmationFor("A")).not.toBe(enableConfirmationFor("B"));
  });

  it("blocks enable on the delivery areas every Company produces from day one", () => {
    expect([...CORE_DELIVERY_ACCOUNTING_AREAS].sort()).toEqual([
      "driver_collections",
      "orders",
      "trader_receivables",
      "trader_settlements",
    ]);
  });
});
