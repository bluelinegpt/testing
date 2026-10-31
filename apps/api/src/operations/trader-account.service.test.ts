import {
  type CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { describe, expect, it } from "vitest";

import { TraderAccountService } from "./trader-account.service.js";

const COMPANY = "4d9095cb-3da6-4b8b-9d8e-ff01f8192bdb";

function serviceReturning(rows: readonly Record<string, unknown>[], permissions = ["settlements.create"]) {
  const queries: CompiledQuery[] = [];
  const connection = {
    executeQuery: (query: CompiledQuery) => {
      queries.push(query);
      return Promise.resolve({ rows });
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    streamQuery: async function* () {},
  };
  const driver = {
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
    init: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
  };
  const database = new Kysely<never>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver as never,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const service = new TraderAccountService(
    database as never,
    { current: () => ({ companyId: COMPANY }) } as never,
    { current: () => ({ permissions: new Set(permissions) }) } as never,
  );
  return { queries, service };
}

const trader = (overrides: Record<string, unknown>) => ({
  awaitingDriverCash: 0,
  code: "TRD-1",
  collected: "0",
  isActive: true,
  lastPaymentAmount: null,
  lastPaymentDate: null,
  lastPaymentNumber: null,
  nameAr: null,
  nameEn: "Shop",
  openReceivables: "0",
  ordersWaiting: 0,
  paid: "0",
  payable: "0",
  receivables: "0",
  traderId: "t",
  ...overrides,
});

describe("Trader Account list", () => {
  it("nets payable, payments, fees and collections into one signed balance", async () => {
    const { queries, service } = serviceReturning([
      trader({ code: "TRD-1", payable: "500", paid: "330", traderId: "a" }),
      trader({ code: "TRD-2", receivables: "125", collected: "100", openReceivables: "25", traderId: "b" }),
      trader({ code: "TRD-3", payable: "100", paid: "100", traderId: "c", ordersWaiting: 4 }),
      trader({ code: "TRD-4", isActive: false, traderId: "d" }),
    ]);
    const result = await service.accounts({});
    expect(result.items.map((row) => [row.code, row.balance])).toEqual([
      ["TRD-1", "170.00"],
      ["TRD-2", "-25.00"],
      ["TRD-3", "0.00"],
    ]);
    expect(result.totals).toEqual({ owedByTraders: "25.00", owedToTraders: "170.00" });
    // Every query is scoped to the Company.
    expect(queries[0]?.parameters).toContain(COMPANY);
    expect(queries[0]?.sql).toContain("where t.company_id = $1::uuid");
  });

  it("lists only open balances when asked", async () => {
    const { service } = serviceReturning([
      trader({ code: "TRD-1", payable: "10", traderId: "a" }),
      trader({ code: "TRD-3", traderId: "c", ordersWaiting: 2 }),
    ]);
    const result = await service.accounts({ openOnly: true });
    expect(result.items.map((row) => row.code)).toEqual(["TRD-1"]);
  });

  it("refuses a user without any Trader money permission", async () => {
    const { service } = serviceReturning([], ["orders.create"]);
    await expect(service.accounts({})).rejects.toMatchObject({ errorCode: "permission_denied" });
  });
});
