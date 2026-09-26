import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (name: string) =>
  readFileSync(resolve(process.cwd(), `src/operations/${name}`), "utf8");

const method = (contents: string, name: string) => {
  const start = contents.indexOf(`private async ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = contents.indexOf("\n  private ", start + 1);
  return contents.slice(start, end < 0 ? undefined : end);
};

const expectOwnershipContract = (
  body: string,
  expected: {
    readonly sourceEntityType: string;
    readonly eventType: string;
    readonly failureCode: string;
  },
): void => {
  // The owning Event is resolved by its full deterministic identity — never
  // by "newest event" ordering or a bare source-id match.
  expect(body).toContain(`e.source_entity_type = '${expected.sourceEntityType}'`);
  expect(body).toContain(`e.event_type = '${expected.eventType}'`);
  expect(body).toContain("e.company_id =");
  expect(body).toContain("e.source_entity_id =");
  expect(body).not.toContain("order by");

  // The Movement never enqueues its own Accounting Event — the parent Event
  // captured by the confirmation trigger is the only owner.
  expect(body).not.toContain("insert into accounting_events");
  expect(body).toContain("accounting_event_id");

  // Fail-closed: when the Company has Accounting enabled, a missing owner
  // Event aborts the confirmation instead of silently writing an unlinked
  // Movement. Disabled Companies record no Accounting facts by design, so
  // for them the link legitimately stays null.
  expect(body).toContain("accounting_configurations");
  expect(body).toContain("accounting_enabled");
  expect(body).toContain(expected.failureCode);
};

describe("generated Cash/Bank Movement accounting ownership", () => {
  it("links Trader Settlement Movements to the parent Event without enqueueing a duplicate", () => {
    const body = method(source("trader-settlement.service.ts"), "createSettlementMovement");
    expectOwnershipContract(body, {
      eventType: "trader_settlement_confirmed",
      failureCode: "trader_settlement_cash_movement_not_created",
      sourceEntityType: "trader_settlement",
    });
  });

  it("links Driver Collection Movements to the parent Event without enqueueing a duplicate", () => {
    const body = method(
      source("driver-cash-reconciliation.service.ts"),
      "createCollectionMovements",
    );
    expectOwnershipContract(body, {
      eventType: "driver_collection_confirmed",
      failureCode: "driver_collection_cash_movement_not_created",
      sourceEntityType: "driver_reconciliation",
    });
  });
});
