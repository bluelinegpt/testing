import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from "kysely";
import { describe, expect, it } from "vitest";

import {
  CLOSE_ELIGIBLE_SETTLEMENT_STATUSES,
  CLOSE_PREDECESSOR_STATUSES,
} from "./order-close-eligibility.js";
import {
  isOrderQuestionKey,
  ORDER_QUESTION_GROUPING,
  ORDER_QUESTION_KEYS,
  orderQuestionPredicate,
} from "./order-questions.js";

const compiler = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (database) => new PostgresIntrospector(database),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});
const sqlOf = (key: (typeof ORDER_QUESTION_KEYS)[number]) =>
  sql`select 1 from orders o where ${orderQuestionPredicate(key)}`
    .compile(compiler)
    .sql.replace(/\s+/g, " ");

describe("Orders ready questions", () => {
  it("knows exactly its own keys and gives every one a grouping", () => {
    expect(isOrderQuestionKey("ready_to_close")).toBe(true);
    expect(isOrderQuestionKey("drop table orders")).toBe(false);
    expect(isOrderQuestionKey(undefined)).toBe(false);
    expect(Object.keys(ORDER_QUESTION_GROUPING).sort()).toEqual([...ORDER_QUESTION_KEYS].sort());
    expect(ORDER_QUESTION_GROUPING.collect_from_driver).toBe("driver");
    expect(ORDER_QUESTION_GROUPING.pay_trader).toBe("trader");
  });

  it("compiles every question to SQL on the Order row only, with no bound user input", () => {
    for (const key of ORDER_QUESTION_KEYS) {
      const compiled = sql`select 1 from orders o where ${orderQuestionPredicate(key)}`.compile(compiler);
      expect(compiled.parameters).toEqual([]);
      expect(compiled.sql).toContain("o.");
    }
  });

  it("ready to close is the Order close gate: same predecessor and settlement statuses", () => {
    const text = sqlOf("ready_to_close");
    for (const status of CLOSE_PREDECESSOR_STATUSES) expect(text).toContain(`'${status}'`);
    for (const status of CLOSE_ELIGIBLE_SETTLEMENT_STATUSES) expect(text).toContain(`'${status}'`);
    expect(text).toContain("o.driver_reconciliation_status in ('reconciled', 'not_applicable')");
    expect(text).toContain("o.trader_net_payable <= 0");
    expect(text).toContain("o.return_status = 'returned_to_trader'");
    // An open Trader fee receivable keeps the Order out of this answer.
    expect(text).toContain("not exists");
    // A Collect Order still waiting for a Driver is not finished work.
    expect(text).toContain("not (o.delivery_status = 'collect_order' and o.assigned_driver_id is null)");
  });

  it("collect from Driver matches New Driver Collection, including Orders with nothing to collect", () => {
    const text = sqlOf("collect_from_driver");
    expect(text).toContain("o.delivery_status = 'delivered'");
    expect(text).toContain("o.driver_reconciliation_status = 'pending'");
    expect(text).not.toContain("customer_amount_due");
  });

  it("traders owe fees lists only fees that can be collected now (delivered Orders)", () => {
    const text = sqlOf("trader_owes_fees");
    expect(text).toContain("o.delivered_at is not null");
    expect(text).toContain("question_receivable.status in ('outstanding', 'partially_collected')");
  });

  it("pay Trader waits for the Driver's cash and only for unpaid Traders", () => {
    const text = sqlOf("pay_trader");
    expect(text).toContain("o.driver_reconciliation_status in ('reconciled', 'not_applicable')");
    expect(text).toContain("o.trader_settlement_status in ('unsettled', 'partially_settled')");
  });
});
