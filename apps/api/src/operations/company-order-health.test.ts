import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  ORDER_HEALTH_REASON_CODES,
  ORDER_HEALTH_REASONS,
  resolveOrderHealthScope,
} from "./company-order-health.service.js";
import { ORDER_FINANCIAL_HEALTH } from "./order-financial-classification.js";

describe("Company Order Health -- reason catalogue", () => {
  it("maps OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION to HEALTHY with no action", () => {
    expect(ORDER_HEALTH_REASONS.OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION).toMatchObject({
      health: "HEALTHY",
      recommendedAction: "none",
    });
  });

  it("takes every Trader receivable classification's health from the shared Verify First table", () => {
    for (const [classification, health] of Object.entries(ORDER_FINANCIAL_HEALTH)) {
      // Classifications that are not themselves reason codes: the reason codes
      // below carry the exact finding.
      if (classification === "NEEDS_REVIEW" || classification === "RECEIVABLE_INCONSISTENT") continue;
      expect(ORDER_HEALTH_REASONS[classification as keyof typeof ORDER_HEALTH_REASONS].health).toBe(
        health,
      );
    }
    for (const code of [
      "MULTIPLE_EFFECTIVE_SETTLEMENTS",
      "RECEIVABLE_OVER_COLLECTED",
      "RECEIVABLE_COLLECTED_AMOUNT_MISMATCH",
      "MULTIPLE_ACTIVE_RECEIVABLES",
      "RECEIVABLE_NOT_REQUIRED_BUT_ACTIVE",
      "RECEIVABLE_STATE_INCONSISTENT",
    ] as const) {
      expect(ORDER_HEALTH_REASONS[code].health).toBe(ORDER_FINANCIAL_HEALTH.NEEDS_REVIEW);
    }
    // Phase 3: actionable reconciliation inconsistencies -- the decision
    // classifies them RECEIVABLE_INCONSISTENT, whose health is ISSUE.
    for (const code of [
      "RECEIVABLE_AMOUNT_MISMATCH",
      "COLLECTION_ALLOCATION_MISMATCH",
      "ORPHAN_COLLECTION_ALLOCATION",
      "SETTLEMENT_OFFSET_MISMATCH",
      "RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT",
      "FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN",
      "RECEIVABLE_PARTIAL_STATE_MISMATCH",
    ] as const) {
      expect(ORDER_HEALTH_REASONS[code].health).toBe(ORDER_FINANCIAL_HEALTH.RECEIVABLE_INCONSISTENT);
      expect(ORDER_HEALTH_REASONS[code].health).toBe("ISSUE");
    }
  });

  it("raises ISSUE only for actionable gaps; Driver Cash is never more than REVIEW", () => {
    const issues = ORDER_HEALTH_REASON_CODES.filter(
      (code) => ORDER_HEALTH_REASONS[code].health === "ISSUE",
    ).sort();
    expect(issues).toEqual([
      "ACCOUNTING_EVENT_FAILED",
      "COLLECTION_ALLOCATION_MISMATCH",
      "FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN",
      "MISSING_RECEIVABLE",
      "ORDER_MISSING_ACCOUNTING_EVENT",
      "ORPHAN_COLLECTION_ALLOCATION",
      "RECEIVABLE_AMOUNT_MISMATCH",
      "RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT",
      "RECEIVABLE_PARTIAL_STATE_MISMATCH",
      "REVERSED_NEEDS_REPAIR",
      "SETTLEMENT_OFFSET_MISMATCH",
    ]);
    for (const code of ORDER_HEALTH_REASON_CODES.filter((value) => value.startsWith("DRIVER_CASH"))) {
      expect(ORDER_HEALTH_REASONS[code].health).toBe("REVIEW");
    }
  });

  it("keeps reasons free of document numbers and identifiers", () => {
    for (const code of ORDER_HEALTH_REASON_CODES) {
      expect(ORDER_HEALTH_REASONS[code].reason).not.toMatch(/SET-|RCV-|JRN-|\$\{|[0-9a-f]{8}-/u);
    }
  });
});

describe("Company Order Health -- date scope", () => {
  const today = "2026-10-02";
  it("defaults to the last 30 days, inclusive of today", () => {
    expect(resolveOrderHealthScope({}, today, "Asia/Dubai")).toMatchObject({
      dateBasis: "order_date",
      dateFrom: "2026-09-03",
      dateTo: today,
      scope: "last30",
    });
  });

  it("resolves today, last 7 days and all", () => {
    expect(resolveOrderHealthScope({ scope: "today" }, today, "Asia/Dubai")).toMatchObject({
      dateFrom: today,
      dateTo: today,
    });
    expect(resolveOrderHealthScope({ scope: "last7" }, today, "Asia/Dubai")).toMatchObject({
      dateFrom: "2026-09-26",
      dateTo: today,
    });
    expect(resolveOrderHealthScope({ scope: "all" }, today, "Asia/Dubai")).toMatchObject({
      dateFrom: null,
      dateTo: null,
    });
  });

  it("validates a custom range", () => {
    expect(
      resolveOrderHealthScope(
        { dateFrom: "2026-01-01", dateTo: "2026-01-31", scope: "custom" },
        today,
        "Asia/Dubai",
      ),
    ).toMatchObject({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    for (const input of [
      { scope: "custom" as const },
      { dateFrom: "2026-02-01", dateTo: "2026-01-01", scope: "custom" as const },
      { dateFrom: "2026-02-30x", dateTo: "2026-03-01", scope: "custom" as const },
    ]) {
      expect(() => resolveOrderHealthScope(input, today, "Asia/Dubai")).toThrow(ApplicationException);
    }
  });
});

describe("Company Order Health -- read-only by construction", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/operations/company-order-health.service.ts"),
    "utf8",
  );

  it("runs every statement inside a PostgreSQL read-only transaction", () => {
    expect(source).toContain("set transaction read only");
  });

  it("contains no data-modifying SQL and selects no customer PII", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");
    for (const verb of [/\binsert\s+into\b/iu, /\bupdate\s+\w+\s+set\b/iu, /\bdelete\s+from\b/iu]) {
      expect(code).not.toMatch(verb);
    }
    for (const column of ["customer_name", "customer_mobile", "customer_address"]) {
      expect(code).not.toContain(column);
    }
  });
});
