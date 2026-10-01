import { Decimal } from "decimal.js";
import { DummyDriver, Kysely, PostgresDialect } from "kysely";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { accountingPostingOwnershipMatrix } from "./accounting-ownership.matrix.js";
import { accountingSetupMappingsByArea } from "./accounting-setup.constants.js";
import { accountingComponentTypes, accountingEventTypes } from "./accounting.constants.js";
import {
  type OperationalAccountingEventRecord,
  OperationalSourceLoader,
} from "./operational-source.loader.js";

/**
 * `trader_credit_issued` -- the compensating Trader Credit written when ONE
 * settlement-offset Receivable is reversed (RCV-000047 / AED 18 / SET-000007).
 *
 * What must hold, every one of which has failed silently in this codebase
 * before:
 *   - the Event type is declared, owned, and loadable;
 *   - the Journal is balanced and uses ONLY existing mapping keys
 *     (`order_cod_receivable` DR, `trader_payable` CR) -- never an invented
 *     `cod_receivable` mapping key, which kept Settlement journals out of the
 *     ledger for seven weeks;
 *   - the `trader_payable` leg carries the Trader, because
 *     `validate_accounting_journal_line()` rejects a trader_payable control
 *     line without `trader_id`, which would fail the Event on every attempt;
 *   - no cash moves.
 */

const companyId = "11111111-1111-4111-8111-111111111111";
const creditId = "22222222-2222-4222-8222-222222222222";
const traderId = "33333333-3333-4333-8333-333333333333";
const receivableId = "44444444-4444-4444-8444-444444444444";
const orderId = "55555555-5555-4555-8555-555555555555";
const settlementId = "66666666-6666-4666-8666-666666666666";

function databaseReturning(row: Record<string, unknown> | undefined) {
  const statements: string[] = [];
  const driver = new DummyDriver();
  vi.spyOn(driver, "acquireConnection").mockResolvedValue({
    executeQuery: async (query: { sql: string }) => {
      statements.push(query.sql);
      return { rows: row === undefined ? [] : [row] };
    },
    async *streamQuery() {
      yield { rows: [] };
    },
  } as never);
  const dialect = new PostgresDialect({ pool: {} as never });
  vi.spyOn(dialect, "createDriver").mockReturnValue(driver);
  return { database: new Kysely<DatabaseSchema>({ dialect }), statements };
}

function event(): OperationalAccountingEventRecord {
  return {
    actorId: null,
    companyId,
    correlationId: "test",
    effectiveAccountingDate: "2026-10-02",
    eventHash: "hash",
    eventType: "trader_credit_issued",
    eventVersion: 1,
    id: "77777777-7777-4777-8777-777777777777",
    operationalArea: "trader_receivables",
    reversalOfEventId: null,
    sourceEntityId: creditId,
    sourceEntityType: "trader_credit",
    sourceReference: "TCR-000001",
  };
}

const openCredit = {
  amount: "18.00",
  businessDate: "2026-10-02",
  creditNumber: "TCR-000001",
  reason: "Fee taken before delivery; offset reversed",
  sourceOrderId: orderId,
  sourceReceivableId: receivableId,
  sourceSettlementId: settlementId,
  status: "open",
  traderId,
};

describe("trader_credit_issued accounting integration", () => {
  it("is a declared Accounting Event type", () => {
    expect(accountingEventTypes).toContain("trader_credit_issued");
  });

  it("has exactly one owner: the Trader Receivables area, not a reversal", () => {
    const owners = accountingPostingOwnershipMatrix.filter(
      (entry) => entry.eventType === "trader_credit_issued",
    );
    expect(owners).toEqual([
      {
        area: "trader_receivables",
        eventType: "trader_credit_issued",
        journalSource: "trader_receivable",
        movementOwner: "trader_receivables",
        reversal: false,
      },
    ]);
  });

  it("is checked by Automatic Posting readiness for every mapping key it resolves", () => {
    expect(accountingSetupMappingsByArea.trader_receivables).toEqual(
      expect.arrayContaining(["order_cod_receivable", "trader_payable"]),
    );
  });

  it("loads a balanced DR order_cod_receivable / CR trader_payable Journal", async () => {
    const { database, statements } = databaseReturning(openCredit);
    const facts = await new OperationalSourceLoader().load(database, event());

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("from trader_credits");
    expect(statements[0]).toMatch(/^\s*select/u);

    expect(facts.accountingDate).toBe("2026-10-02");
    expect(facts.journalSource).toBe("trader_receivable");
    expect(facts.sourceReference).toBe("TCR-000001");
    expect(
      facts.components.map(({ amount, componentType, entryIntent, mappingKey }) => ({
        amount,
        componentType,
        entryIntent,
        mappingKey,
      })),
    ).toEqual([
      {
        amount: "18.00",
        componentType: "cod_receivable",
        entryIntent: "debit",
        mappingKey: "order_cod_receivable",
      },
      {
        amount: "18.00",
        componentType: "trader_payable",
        entryIntent: "credit",
        mappingKey: "trader_payable",
      },
    ]);

    const total = (intent: "credit" | "debit") =>
      facts.components
        .filter((line) => line.entryIntent === intent)
        .reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
    expect(total("debit").toFixed(2)).toBe("18.00");
    expect(total("debit").equals(total("credit"))).toBe(true);
  });

  it("never resolves a `cod_receivable` mapping key and never touches cash", async () => {
    const { database } = databaseReturning(openCredit);
    const facts = await new OperationalSourceLoader().load(database, event());
    const keys = facts.components.map((line) => line.mappingKey);
    expect(keys).not.toContain("cod_receivable");
    expect(keys.every((key) => ["order_cod_receivable", "trader_payable"].includes(key))).toBe(
      true,
    );
    expect(keys.some((key) => /cash|bank/u.test(key))).toBe(false);
    // Every component type is one the database's component check accepts.
    for (const line of facts.components) {
      expect(accountingComponentTypes).toContain(line.componentType);
    }
  });

  it("carries the Trader on both legs so the trader_payable control line is accepted", async () => {
    const { database } = databaseReturning(openCredit);
    const facts = await new OperationalSourceLoader().load(database, event());
    for (const line of facts.components) {
      expect(line.metadata?.traderId).toBe(traderId);
      expect(line.subledgerType).toBe("trader");
      expect(line.subledgerId).toBe(traderId);
      expect(line.metadata?.traderReceivableId).toBe(receivableId);
      // `orderId` would be written to journal_lines.order_id; the Credit is
      // not an Order posting, so it must not claim one.
      expect(line.metadata?.orderId).toBeUndefined();
    }
  });

  it("refuses a cancelled Credit", async () => {
    const { database } = databaseReturning({ ...openCredit, status: "cancelled" });
    await expect(new OperationalSourceLoader().load(database, event())).rejects.toMatchObject({
      errorCode: "accounting_trader_credit_not_recognizable",
    });
  });

  it("refuses a Credit that does not exist for this Company", async () => {
    const { database } = databaseReturning(undefined);
    await expect(new OperationalSourceLoader().load(database, event())).rejects.toMatchObject({
      errorCode: "accounting_trader_credit_not_recognizable",
    });
  });
});
