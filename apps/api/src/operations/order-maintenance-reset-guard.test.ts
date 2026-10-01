import { describe, expect, it } from "vitest";

import {
  hasNoFinancialDependencies,
  type TraderReceivableDependencies,
} from "./order-maintenance.service.js";

/**
 * The zero-dependency guard that decides whether Delete / Reset may PHYSICALLY
 * delete a Trader Receivable. Every single dependency, alone, must block it.
 */
const none: TraderReceivableDependencies = {
  accountingEventCount: 0,
  amountCollected: "0.00",
  collectionCount: 0,
  journalCount: 0,
  offsetCount: 0,
  traderCreditCount: 0,
};

describe("Delete / Reset zero-dependency guard", () => {
  it("allows a physical delete only when there is no financial dependency at all", () => {
    expect(hasNoFinancialDependencies(none)).toBe(true);
  });

  it.each([
    ["an accounting event", { accountingEventCount: 1 }],
    ["a journal", { journalCount: 1 }],
    ["a settlement offset", { offsetCount: 1 }],
    ["a collection allocation", { collectionCount: 1 }],
    ["a Trader Credit", { traderCreditCount: 1 }],
    ["money applied (payment)", { amountCollected: "0.01" }],
  ] as const)("blocks the delete when the receivable has %s", (_label, dependency) => {
    expect(hasNoFinancialDependencies({ ...none, ...dependency })).toBe(false);
  });
});
