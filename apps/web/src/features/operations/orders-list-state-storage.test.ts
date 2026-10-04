import { describe, expect, it } from "vitest";

import {
  hasOrdersListState,
  ordersListStateStorageKey,
  readOrdersListSnapshot,
  removeOrdersListSearch,
  restoreOrdersListSearch,
  writeOrdersListSnapshot,
} from "./orders-list-state-storage.js";

describe("Orders list state persistence", () => {
  it("isolates saved state by both company and user", () => {
    expect(ordersListStateStorageKey("company-a", "user-a")).not.toBe(
      ordersListStateStorageKey("company-a", "user-b"),
    );
    expect(ordersListStateStorageKey("company-a", "user-a")).not.toBe(
      ordersListStateStorageKey("company-b", "user-a"),
    );
  });

  it("persists Orders filters, tab, sorting and pagination but ignores workflow instructions", () => {
    const key = ordersListStateStorageKey("company-a", "user-a");
    writeOrdersListSnapshot(
      localStorage,
      key,
      "?quickView=delivery&search=7555&page=3&pageSize=50&sort=orderDate&direction=asc&openDialog=change_status&orderId=order-1",
      ["area", "trader"],
    );

    const saved = readOrdersListSnapshot(localStorage, key);
    expect(saved).toEqual({
      grouping: ["area", "trader"],
      search: "quickView=delivery&search=7555&page=3&pageSize=50&sort=orderDate&direction=asc",
    });
    expect(hasOrdersListState(new URLSearchParams(saved?.search ?? ""))).toBe(true);
  });

  it("restores list state while preserving navigation instructions and can remove stale user state", () => {
    expect(
      restoreOrdersListSearch("?openDialog=change_status&orderId=order-1", "search=7555&page=3"),
    ).toBe("?openDialog=change_status&orderId=order-1&search=7555&page=3");
    expect(removeOrdersListSearch("?quickView=all&search=7555&openDialog=change_status")).toBe(
      "?openDialog=change_status",
    );
    expect(hasOrdersListState(new URLSearchParams("?openDialog=change_status"))).toBe(false);
  });

  it("fills missing Orders state on a partial return URL without overriding its explicit tab", () => {
    expect(
      restoreOrdersListSearch("?quickView=delivery&openDialog=change_status", "quickView=all&search=7555&page=3"),
    ).toBe("?quickView=delivery&openDialog=change_status&search=7555&page=3");
  });
});
