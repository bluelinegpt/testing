import { DummyDriver, Kysely, PostgresDialect } from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OrderDeliveryReopenService } from "./order-delivery-reopen.service.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const orderId = "20000000-0000-4000-8000-000000000002";
const reconciliationId = "30000000-0000-4000-8000-000000000003";

function fixture(
  options: {
    readonly reconciliationOrderCount?: number;
    readonly collectionAlreadyReversed?: boolean;
    readonly settlementStatus?: string;
  } = {},
) {
  const statements: string[] = [];
  const transactionHandles: unknown[] = [];
  const driver = new DummyDriver();
  const commitTransaction = vi.spyOn(driver, "commitTransaction");
  const rollbackTransaction = vi.spyOn(driver, "rollbackTransaction");
  vi.spyOn(driver, "acquireConnection").mockResolvedValue({
    executeQuery: async (query: { sql: string }) => {
      statements.push(query.sql);
      const rows = query.sql.includes('as "reconciliationId"')
        ? [
            {
              deliveryStatus: "delivered",
              reconciliationId: options.collectionAlreadyReversed ? null : reconciliationId,
              reconciliationOrderCount: options.collectionAlreadyReversed
                ? 0
                : (options.reconciliationOrderCount ?? 1),
              traderSettlementStatus: options.settlementStatus ?? "unsettled",
            },
          ]
        : [];
      return { rows };
    },
    async *streamQuery() {
      yield { rows: [] };
    },
  } as never);
  const dialect = new PostgresDialect({ pool: {} as never });
  vi.spyOn(dialect, "createDriver").mockReturnValue(driver);
  const database = new Kysely<DatabaseSchema>({ dialect });
  const reconciliations = {
    reverse: vi.fn(async (...args: unknown[]) => {
      transactionHandles.push(args[4]);
      return { reconciliationId };
    }),
  };
  const operations = {
    reopenDeliveredOrder: vi.fn(async (...args: unknown[]) => {
      transactionHandles.push(args[3]);
      return { id: orderId, deliveryStatus: "out_for_delivery" };
    }),
  };
  const service = new OrderDeliveryReopenService(
    new KyselyTransactionManager(database),
    { current: () => ({ companyId }) } as never,
    {
      current: () => ({
        identityId: companyId,
        permissions: new Set(["users_roles.manage"]),
      }),
    } as never,
    reconciliations as never,
    operations as never,
  );
  return {
    commitTransaction,
    operations,
    reconciliations,
    rollbackTransaction,
    service,
    statements,
    transactionHandles,
  };
}

describe("OrderDeliveryReopenService", () => {
  it("reverses the active Driver collection but leaves Driver fee payments untouched", async () => {
    const test = fixture();

    await test.service.reopen(orderId, "Customer requested another delivery", "corr-1");

    expect(test.reconciliations.reverse).toHaveBeenCalledOnce();
    expect(test.operations.reopenDeliveredOrder).toHaveBeenCalledOnce();
    expect(test.statements.some((statement) => statement.includes("outsourced_driver_fee"))).toBe(
      false,
    );
    expect(test.transactionHandles).toHaveLength(2);
    expect(new Set(test.transactionHandles).size).toBe(1);
    expect(test.commitTransaction).toHaveBeenCalledOnce();
  });

  it("blocks Trader-settled Orders before reversing any Driver money", async () => {
    const test = fixture({ settlementStatus: "money_received_by_trader" });

    await expect(test.service.reopen(orderId, "Correction", "corr-2")).rejects.toThrow(
      "Reverse the Trader settlement before reopening this Order",
    );

    expect(test.reconciliations.reverse).not.toHaveBeenCalled();
    expect(test.operations.reopenDeliveredOrder).not.toHaveBeenCalled();
    expect(test.rollbackTransaction).toHaveBeenCalledOnce();
  });

  it("reopens after the collection was already reversed without querying fee payments", async () => {
    const test = fixture({ collectionAlreadyReversed: true });

    await test.service.reopen(orderId, "Correction", "corr-3");

    expect(test.reconciliations.reverse).not.toHaveBeenCalled();
    expect(test.operations.reopenDeliveredOrder).toHaveBeenCalledOnce();
    expect(test.statements.some((statement) => statement.includes("outsourced_driver_fee"))).toBe(
      false,
    );
    expect(test.commitTransaction).toHaveBeenCalledOnce();
  });

  it("blocks a Driver collection shared with other Orders before any reversal", async () => {
    const test = fixture({ reconciliationOrderCount: 2 });

    await expect(test.service.reopen(orderId, "Correction", "corr-4")).rejects.toThrow(
      "The Driver collection also contains other Orders",
    );

    expect(test.reconciliations.reverse).not.toHaveBeenCalled();
  });
});
