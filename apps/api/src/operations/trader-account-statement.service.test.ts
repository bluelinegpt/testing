import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { buildTraderAccountStatementHtml } from "./trader-account-statement-html.js";
import { TraderAccountStatementService } from "./trader-account-statement.service.js";

describe("TraderAccountStatementService", () => {
  it("shows zero-COD Trader fees as receivables and restores reversed allocations", async () => {
    const executedSql: string[] = [];
    const sourceRows = [
      statementRow({
        amount: "282.00",
        balanceImpact: "282.00",
        date: "2026-09-24",
        id: "order-2",
        reference: "2",
        type: "order",
      }),
      statementRow({
        amount: "482.00",
        balanceImpact: "482.00",
        date: "2026-09-24",
        id: "order-3",
        reference: "3",
        type: "order",
      }),
      statementRow({
        amount: "482.00",
        balanceImpact: "-482.00",
        date: "2026-09-24",
        id: "set-63",
        reference: "SET-00063",
        settlementNumber: "SET-00063",
        type: "payment",
      }),
      statementRow({
        amount: "482.00",
        balanceImpact: "482.00",
        date: "2026-09-24",
        id: "set-64",
        reference: "SET-00064",
        settlementNumber: "SET-00064",
        type: "reversal",
      }),
      statementRow({
        amount: "0.00",
        balanceImpact: "0.00",
        date: "2026-09-25",
        id: "order-126",
        orderNumber: "ORD-000126",
        reference: "1",
        serialNumber: "1",
        type: "order",
      }),
      statementRow({
        amount: "18.00",
        balanceImpact: "-18.00",
        date: "2026-09-25",
        description: "Service fee receivable · Order 1 (ORD-000126)",
        id: "receivable-19",
        isOutstanding: true,
        orderNumber: "ORD-000126",
        reference: "RCV-000019",
        serialNumber: "1",
        sourceStatus: "outstanding",
        type: "receivable",
      }),
    ];
    const responses = [
      [{ id: "trader-id", nameAr: null, nameEn: "Ajman Store", number: "TRD-1" }],
      [{ opening: "0.00" }],
      sourceRows,
      [
        {
          additionalFees: "0.00",
          codCollected: "800.00",
          deliveredOrderCount: 3,
          outstandingAmount: "764.00",
          outstandingOrderCount: 2,
          partiallySettledOrderCount: 0,
          serviceFees: "54.00",
          settledOrderCount: 1,
        },
      ],
      [
        {
          amount: "482.00",
          date: "2026-09-24",
          isReversed: true,
          linkedOrderCount: 1,
          paymentMethod: "cash",
          paymentReference: null,
          settlementId: "set-63-id",
          settlementNumber: "SET-00063",
          status: "confirmed",
        },
      ],
      [
        {
          allocatedAmount: "482.00",
          deliveryDate: "2026-09-02",
          orderNumber: "ORD-000124",
          originalTraderPayable: "482.00",
          previouslySettled: "0.00",
          remainingAfterSettlement: "0.00",
          serialNumber: "3",
          status: "unsettled",
        },
      ],
      [{ opening: "746.00" }],
    ];
    let queryIndex = 0;
    const executor = {
      compileQuery: (node: unknown) => {
        queryIndex += 1;
        executedSql.push(JSON.stringify(node));
        return { parameters: [], sql: `statement-query-${queryIndex}` };
      },
      executeQuery: vi.fn(async (query: { readonly sql: string }) => {
        return { rows: responses[Number(query.sql.at(-1)) - 1] ?? [] };
      }),
      transformQuery: (node: unknown) => node,
      withPlugins: () => executor,
    };
    const database = { getExecutor: () => executor } as unknown as Kysely<DatabaseSchema>;
    const service = new TraderAccountStatementService(
      database,
      { current: () => ({ companyId: "company-id" }) } as never,
      {
        current: () => ({ identityId: "account-id", permissions: new Set(["reports.export"]) }),
      } as never,
      {
        branding: async () => ({ hasLogo: false, nameAr: null, nameEn: "Dana Delivery Services" }),
      } as never,
      {} as never,
      {} as never,
    );

    const statement = await service.statement("trader-id", { month: "2026-09" });

    expect(statement.transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          credit: "18.00",
          debit: "0.00",
          orderNumber: "ORD-000126",
          reference: "RCV-000019",
          runningBalance: "746.00",
          type: "receivable",
        }),
      ]),
    );
    expect(statement.summary.totalPayable).toBe("764.00");
    expect(statement.summary.netPayments).toBe("0.00");
    expect(statement.summary.openingBalance).toBe("0.00");
    expect(statement.summary.closingBalance).toBe("746.00");
    expect(statement.summary.outstandingAmount).toBe("746.00");
    expect(statement.settlements[0]?.allocations[0]).toMatchObject({
      allocatedAmount: "0.00",
      remainingAfterSettlement: "482.00",
    });
    const report = buildTraderAccountStatementHtml(statement, "en");
    expect(report).toContain("RCV-000019");
    expect(report).toContain("Service fee receivable · Order 1 (ORD-000126)");
    expect(report).toContain("Service Fees on Collection-Confirmed Orders");
    expect(report).toContain("AED 746.00");
    expect(executedSql.some((query) => query.includes("trader_receivables"))).toBe(true);
    expect(executedSql.some((query) => query.includes("trader_collection_allocations"))).toBe(true);
  });
});

function statementRow(overrides: Record<string, unknown>) {
  return {
    additionalFee: "0.00",
    amount: "0.00",
    balanceImpact: "0.00",
    codAmount: "0.00",
    createdAt: "2026-09-25T08:00:00.000Z",
    date: "2026-09-25",
    description: "Statement row",
    id: "row-id",
    isOutstanding: false,
    notes: null,
    orderNumber: null,
    paymentReference: null,
    reference: "REF",
    reversalAmount: "0.00",
    sequence: 1,
    serialNumber: null,
    serviceFee: "0.00",
    settlementAmount: "0.00",
    settlementNumber: null,
    sourceStatus: "unsettled",
    traderPayable: "0.00",
    type: "order",
    ...overrides,
  };
}
