import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type RawBuilder,
} from "kysely";
import { describe, expect, it } from "vitest";

import {
  deliveryStatusFilterPredicate,
  parseDeliveryStatusFilter,
} from "./delivery-status-filter.js";

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

describe("parseDeliveryStatusFilter", () => {
  it("reads nothing from an empty or missing value", () => {
    expect(parseDeliveryStatusFilter(undefined)).toEqual([]);
    expect(parseDeliveryStatusFilter(null)).toEqual([]);
    expect(parseDeliveryStatusFilter("")).toEqual([]);
    expect(parseDeliveryStatusFilter(" , ,")).toEqual([]);
  });

  it("keeps a single status exactly as before", () => {
    expect(parseDeliveryStatusFilter("hold")).toEqual(["hold"]);
    expect(parseDeliveryStatusFilter("  hold ")).toEqual(["hold"]);
  });

  it("splits several statuses, trimming blanks and duplicates", () => {
    expect(parseDeliveryStatusFilter("new, hold,,new ,delivered")).toEqual([
      "new",
      "hold",
      "delivered",
    ]);
  });

  it("caps how many statuses one request may carry", () => {
    const many = Array.from({ length: 30 }, (_, index) => `s${index}`).join(",");
    expect(parseDeliveryStatusFilter(many)).toHaveLength(20);
  });
});

describe("deliveryStatusFilterPredicate", () => {
  it("filters nothing when no status is chosen", () => {
    expect(compile(deliveryStatusFilterPredicate("")).sql).toBe("true");
  });

  it("binds one status as a parameter", () => {
    const { parameters, sql } = compile(deliveryStatusFilterPredicate("hold"));
    expect(sql).toBe("(o.delivery_status in ($1))");
    expect(parameters).toEqual(["hold"]);
  });

  it("binds several statuses as parameters, never concatenated", () => {
    const { parameters, sql } = compile(
      deliveryStatusFilterPredicate("assigned_to_driver,out_for_delivery,x'); drop table orders;--"),
    );
    expect(sql).toBe("(o.delivery_status in ($1, $2, $3))");
    expect(parameters).toEqual([
      "assigned_to_driver",
      "out_for_delivery",
      "x'); drop table orders;--",
    ]);
  });
});
