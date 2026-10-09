import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type RawBuilder,
} from "kysely";
import { describe, expect, it } from "vitest";

import type { CustomViewDefinition } from "../company-configuration/order-views.js";
import { activeStatusPredicate, customOrderViewPredicate } from "./order-view-predicate.js";

const database = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

function compile(predicate: RawBuilder<unknown>) {
  const compiled = predicate.compile(database);
  return { parameters: compiled.parameters, sql: compiled.sql.replace(/\s+/gu, " ").trim() };
}

const view = (definition: Partial<CustomViewDefinition>): CustomViewDefinition => ({
  dateField: "order_date",
  dateWindow: "any",
  statuses: [],
  ...definition,
});

describe("customOrderViewPredicate", () => {
  it("filters nothing for every status and any date", () => {
    expect(compile(customOrderViewPredicate(view({}), "Asia/Dubai")).sql).toBe("true");
  });

  it("binds the chosen statuses as parameters", () => {
    const { parameters, sql } = compile(
      customOrderViewPredicate(view({ statuses: ["new", "hold"] }), "Asia/Dubai"),
    );
    expect(sql).toBe("(o.delivery_status in ($1, $2))");
    expect(parameters).toEqual(["new", "hold"]);
  });

  it("Today on Order date compares against today in the Company timezone", () => {
    const { parameters, sql } = compile(
      customOrderViewPredicate(view({ dateWindow: "today" }), "Asia/Dubai"),
    );
    expect(sql).toBe("(o.order_date = (now() at time zone $1)::date)");
    expect(parameters).toEqual(["Asia/Dubai"]);
  });

  it("Yesterday on Created date reads the creation instant in the Company timezone", () => {
    const { sql } = compile(
      customOrderViewPredicate(view({ dateField: "created_at", dateWindow: "yesterday" }), "Asia/Dubai"),
    );
    expect(sql).toBe("((o.created_at at time zone $1)::date = (now() at time zone $2)::date - 1)");
  });

  it("a Delivery date window leaves out Orders never delivered", () => {
    const { sql } = compile(
      customOrderViewPredicate(
        view({ dateField: "delivered_at", dateWindow: "this_week", statuses: ["delivered"] }),
        "Asia/Dubai",
      ),
    );
    expect(sql).toContain("o.delivery_status in ($1)");
    expect(sql).toContain("o.delivered_at is not null");
    expect(sql).toContain("date_trunc('week', (now() at time zone $");
    expect(sql).toContain("+ 7");
  });

  it("covers the month windows with half-open bounds", () => {
    expect(compile(customOrderViewPredicate(view({ dateWindow: "this_month" }), "UTC")).sql).toContain(
      "interval '1 month'",
    );
    const last = compile(customOrderViewPredicate(view({ dateWindow: "last_month" }), "UTC")).sql;
    expect(last).toContain("- interval '1 month'");
    expect(last).toContain("o.order_date < date_trunc('month'");
  });

  it("Last N days includes today", () => {
    const { parameters, sql } = compile(
      customOrderViewPredicate(view({ dateWindow: "last_n_days", lastNDays: 7 }), "UTC"),
    );
    expect(sql).toContain("- $2::int");
    expect(parameters).toContain(6);
    expect(sql).toContain("o.order_date <= (now() at time zone");
  });

  it("a custom range is inclusive at both ends", () => {
    const { parameters, sql } = compile(
      customOrderViewPredicate(
        view({ dateFrom: "2026-10-01", dateTo: "2026-10-09", dateWindow: "range" }),
        "UTC",
      ),
    );
    expect(sql).toBe("(o.order_date >= $1::date and o.order_date <= $2::date)");
    expect(parameters).toEqual(["2026-10-01", "2026-10-09"]);
  });
});

describe("activeStatusPredicate", () => {
  it("keeps today's literal list when no custom menu applies", () => {
    const { parameters, sql } = compile(activeStatusPredicate(null));
    expect(sql).toBe(
      "o.delivery_status in ('new','in_branch','assigned_to_driver','out_for_delivery','hold','delivered','returned_to_branch','returned_to_trader','collect_order')",
    );
    expect(parameters).toEqual([]);
  });

  it("uses the menu's statuses as parameters", () => {
    const { parameters, sql } = compile(activeStatusPredicate(["new", "out_for_delivery"]));
    expect(sql).toBe("o.delivery_status in ($1, $2)");
    expect(parameters).toEqual(["new", "out_for_delivery"]);
  });
});
