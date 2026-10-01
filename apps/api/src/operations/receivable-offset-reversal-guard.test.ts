import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assessOffsetReversal,
  collateralOffsetCount,
  isSettlementReversalValidForSingleReceivable,
} from "./receivable-offset-reversal-guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const webFeatures = join(here, "..", "..", "..", "web", "src", "features");

/** The real shape of SET-000007, which cleared RCV-000047 (ORD-000108). */
const SET_000007 = { physicalCollectionCount: 0, settlementOffsetCount: 6 } as const;

describe("settlement offset is a valid settlement, not a missing collection", () => {
  it("does not report an offset-settled receivable as a physical collection", () => {
    const verdict = assessOffsetReversal(SET_000007);
    expect(SET_000007.physicalCollectionCount).toBe(0);
    expect(verdict.blockedReason).not.toMatch(/collection/i);
  });

  it("routes a physically collected receivable to the collection reversal instead", () => {
    const verdict = assessOffsetReversal({
      physicalCollectionCount: 1,
      settlementOffsetCount: 1,
    });
    expect(verdict.blockedReason).toMatch(/physical Trader Collection/);
    expect(verdict.blockedReason).toMatch(/Reverse the Collection itself/);
  });

  it("never suggests creating a collection for an offset-settled receivable", () => {
    // ORD-000108 took no cash: the fee was collected by short-paying the
    // Trader. Advising a Collection here would settle AED 18 twice and record
    // cash that was never received.
    for (const offsets of [1, 2, 6, 17]) {
      const verdict = assessOffsetReversal({
        physicalCollectionCount: 0,
        settlementOffsetCount: offsets,
      });
      expect(verdict.blockedReason).not.toMatch(/create a (physical )?collection/i);
    }
  });
});

describe("a receivable-scoped action can never reverse unrelated offsets", () => {
  it("counts the other offsets a settlement-scoped reversal would unwind", () => {
    expect(collateralOffsetCount(SET_000007.settlementOffsetCount)).toBe(5);
  });

  it("blocks execution whenever the settlement carries other offsets", () => {
    const verdict = assessOffsetReversal(SET_000007);
    expect(verdict.executionAvailable).toBe(false);
    expect(verdict.collateralOffsetCount).toBe(5);
    expect(verdict.blockedReason).toMatch(/5 other/);
    expect(verdict.blockedReason).toMatch(/whole Settlement/);
  });

  it("blocks execution even on a single-offset settlement", () => {
    // The economic case, and the reason a collateral-only guard is not enough:
    // restoring the Receivable alone leaves the Trader owing the fee while he
    // has already been short-paid it.
    const verdict = assessOffsetReversal({
      physicalCollectionCount: 0,
      settlementOffsetCount: 1,
    });
    expect(verdict.executionAvailable).toBe(false);
    expect(verdict.collateralOffsetCount).toBe(0);
    expect(verdict.blockedReason).toMatch(/short-pay/);
    expect(verdict.blockedReason).toMatch(/Trader credit/);
  });

  it("holds the invariant for every offset count", () => {
    for (const offsets of [0, 1, 2, 6, 17, 100]) {
      expect(
        assessOffsetReversal({ physicalCollectionCount: 0, settlementOffsetCount: offsets })
          .executionAvailable,
      ).toBe(false);
    }
    expect(isSettlementReversalValidForSingleReceivable()).toBe(false);
  });

  it("never returns a negative collateral count", () => {
    expect(collateralOffsetCount(0)).toBe(0);
    expect(collateralOffsetCount(-3)).toBe(0);
    expect(collateralOffsetCount(Number.NaN)).toBe(0);
  });

  it("is pure, so repeated assessment gives the same verdict", () => {
    expect(assessOffsetReversal(SET_000007)).toStrictEqual(assessOffsetReversal(SET_000007));
  });
});

describe("no receivable-scoped screen may call the settlement-scoped reversal", () => {
  // A source-level regression test, because the defect was never in the
  // endpoint -- reversing a whole Settlement is a real operation. It was that
  // two Receivable-scoped screens called it. Nothing stops a future edit from
  // wiring it back except this test.
  const receivableScopedScreens = [
    join(webFeatures, "operations", "TraderReceivablesWorkspace.tsx"),
    join(webFeatures, "configuration", "OrderMaintenanceWorkspace.tsx"),
  ];

  for (const path of receivableScopedScreens) {
    it(`${path.split(/[\\/]/).pop()} does not post to the settlement payment reversal`, () => {
      const source = readFileSync(path, "utf8");
      // Matches the call regardless of how the id is interpolated, and only
      // outside a comment line.
      const offending = source
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => !/^\s*(\*|\/\/)/.test(line))
        .filter(({ line }) => /settlements\/payments\/[^`'"]*\/reverse/.test(line));
      expect(offending.map((entry) => `${entry.number}: ${entry.line.trim()}`)).toStrictEqual([]);
    });

    it(`${path.split(/[\\/]/).pop()} reads the server's executionAvailable verdict`, () => {
      const source = readFileSync(path, "utf8");
      expect(source).toMatch(/executionAvailable/);
      expect(source).toMatch(/blockedReason/);
    });
  }

  it("the order maintenance screen no longer flips delivery and payment condition together", () => {
    const source = readFileSync(
      join(webFeatures, "configuration", "OrderMaintenanceWorkspace.tsx"),
      "utf8",
    );
    const mutating = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .filter((line) => /api\.(patch|put)\s*</.test(line) || /api\.(patch|put)\s*\(/.test(line));
    expect(mutating).toStrictEqual([]);
  });
});
