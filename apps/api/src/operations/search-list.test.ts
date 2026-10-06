import { describe, expect, it } from "vitest";

import { isSearchList, orderNumberCandidates, SEARCH_LIST_LIMIT, splitSearchList } from "./search-list.js";

describe("multi-value search lists", () => {
  it("a term is a list only when it contains a separator", () => {
    expect(isSearchList("2383")).toBe(false);
    expect(isSearchList("ORD-000110")).toBe(false);
    expect(isSearchList("2383,1523")).toBe(true);
    expect(isSearchList("2383، 1523")).toBe(true);
    expect(isSearchList("2383;1523")).toBe(false);
    expect(isSearchList("2383\n1523")).toBe(true);
    expect(isSearchList(undefined)).toBe(false);
  });

  it("splits, trims, drops empties and duplicates (case-insensitive), keeps order", () => {
    expect(splitSearchList(" 2383 ,1523,,2447 , 2383\r\nREF-A\nref-a ")).toEqual(["2383", "1523", "2447", "REF-A"]);
    expect(splitSearchList(",,")).toEqual([]);
  });

  it(`accepts ${SEARCH_LIST_LIMIT} values and refuses more`, () => {
    const values = (count: number) => Array.from({ length: count }, (_, index) => `V${index}`).join(",");
    expect(splitSearchList(values(SEARCH_LIST_LIMIT))).toHaveLength(SEARCH_LIST_LIMIT);
    expect(() => splitSearchList(values(SEARCH_LIST_LIMIT + 1))).toThrow(/up to 200 values/u);
  });

  it("an Order Number value yields only EXACT candidates", () => {
    expect(orderNumberCandidates("110")).toEqual(expect.arrayContaining(["ORD-110", "ORD-000110"]));
    expect(orderNumberCandidates("ord-000110")).toEqual(expect.arrayContaining(["ORD-000110", "ORD-110"]));
    expect(orderNumberCandidates("110")).not.toContain("ORD-001100");
    expect(orderNumberCandidates("REF-1")).toEqual(["REF-1"]);
  });
});
