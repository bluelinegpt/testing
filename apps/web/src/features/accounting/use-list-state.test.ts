import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { useListState } from "./use-list-state.js";

/**
 * List filter state, which lives in the URL.
 *
 * This exists because of a bug that was invisible from the search code: every
 * filter value was trimmed on the way INTO the URL and again on the way OUT.
 * A filter input is controlled by the value that comes back, so typing
 * "Customer " round-tripped to "Customer" and the trailing space disappeared
 * as it was typed. The operator could never reach the second word, and it
 * looked for all the world like the search box refusing the space key.
 *
 * The distinction the fix rests on, and what these pin: trimming decides
 * WHETHER a filter is stored, never WHAT is stored.
 */

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(MemoryRouter, { initialEntries: ["/"] }, children);

const listState = () =>
  renderHook(() => useListState({ companyId: "c1", defaultSortBy: "orderDate", filterKeys: ["search"] }), {
    wrapper,
  });

describe("useListState filter values", () => {
  it("keeps a trailing space so a two-word term can be typed", () => {
    const { result } = listState();
    // Exactly what happens between the "r" of Customer and the "A".
    act(() => result.current.setFilters({ search: "Customer " }));
    expect(result.current.filters.search).toBe("Customer ");

    act(() => result.current.setFilters({ search: "Customer A" }));
    expect(result.current.filters.search).toBe("Customer A");
  });

  it("keeps interior spacing exactly as typed", () => {
    const { result } = listState();
    act(() => result.current.setFilters({ search: "Customer  A" }));
    expect(result.current.filters.search).toBe("Customer  A");
  });

  it("still treats a whitespace-only filter as absent", () => {
    const { result } = listState();
    act(() => result.current.setFilters({ search: "   " }));
    // Trim remains the emptiness test, so a blank filter is never sent and the
    // backend never has to tell "" apart from "not supplied".
    expect(result.current.filters.search).toBeUndefined();
  });

  it("drops a filter that is cleared", () => {
    const { result } = listState();
    act(() => result.current.setFilters({ search: "Customer A" }));
    act(() => result.current.setFilters({ search: "" }));
    expect(result.current.filters.search).toBeUndefined();
  });
});
