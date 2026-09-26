import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * URL-backed list state for the Accounting lists.
 *
 * The URL is the single source of truth: page, page size, sort and every
 * filter live in the query string. That is what makes the browser do the work
 * for us — Back and Forward restore a list exactly, a refresh keeps it, and the
 * address bar is a shareable description of what is on screen. No parallel
 * `sessionStorage` copy exists to drift out of step with it.
 *
 * Nothing sensitive goes in the URL: only page numbers, a sort key, and the
 * filter values the User themselves typed or chose.
 *
 * Every value is validated on read, so a hand-edited or stale URL degrades to
 * the screen default rather than throwing or sending a rejected request.
 */

export const listPageSizes = [25, 50, 100] as const;
export type ListPageSize = (typeof listPageSizes)[number];

export interface ListState {
  readonly filters: Readonly<Record<string, string>>;
  readonly page: number;
  readonly pageSize: ListPageSize;
  readonly sortBy: string;
  readonly sortDirection: "asc" | "desc";
}

export interface ListStateControls extends ListState {
  /** How many filters the User has actually applied. */
  readonly activeFilterCount: number;
  readonly clearFilters: () => void;
  readonly setFilter: (key: string, value: string) => void;
  /**
   * Several filters in one write.
   *
   * Calling `setFilter` twice in a tick would make the second write from the
   * first one's stale state and lose it. Screens that change more than one
   * filter together — switching Date Mode clears the other mode's dates — need
   * a single write.
   *
   * An empty value removes the filter, which is what "cleared" means here.
   */
  readonly setFilters: (patch: Readonly<Record<string, string>>) => void;
  readonly setPage: (page: number) => void;
  readonly setPageSize: (pageSize: ListPageSize) => void;
  /** Cycles unsorted → preferred → opposite → back to the screen default. */
  readonly toggleSort: (key: string, preferred?: "asc" | "desc") => void;
}

/** Reserved keys the query string uses for state that is not a filter. */
const reserved = new Set(["direction", "page", "pageSize", "sort"]);

export function useListState({
  companyId,
  defaultSortBy,
  defaultSortDirection = "desc",
  filterKeys,
}: {
  /** Switching Company clears list state that cannot apply to the new one. */
  readonly companyId?: string | undefined;
  readonly defaultSortBy: string;
  readonly defaultSortDirection?: "asc" | "desc";
  /** Filter names this screen supports. Anything else in the URL is ignored. */
  readonly filterKeys: readonly string[];
}): ListStateControls {
  const [params, setParams] = useSearchParams();

  // A filter chosen for one Company (a Fiscal Year, a page deep into its
  // Journals) is meaningless for another, so a Company change resets the query
  // rather than carrying it across. Replace, not push: the previous Company's
  // filtered URL must not sit in history for Back to return to.
  const seenCompany = useRef(companyId);
  useEffect(() => {
    if (companyId === undefined || seenCompany.current === companyId) return;
    seenCompany.current = companyId;
    setParams(new URLSearchParams(), { replace: true });
  }, [companyId, setParams]);

  const state = useMemo<ListState>(() => {
    const rawPage = Number.parseInt(params.get("page") ?? "", 10);
    const rawSize = Number.parseInt(params.get("pageSize") ?? "", 10);
    const filters: Record<string, string> = {};
    for (const key of filterKeys) {
      if (reserved.has(key)) continue;
      /* Read the value EXACTLY as stored. Trimming here used to destroy a
         trailing space: a filter box is controlled by this value, so typing
         "Customer " round-tripped to "Customer" and the space vanished as it
         was typed -- making a two-word search impossible to enter at all.
         Emptiness is still judged on the trimmed form; only the stored value
         keeps its spacing. */
      const value = params.get(key) ?? "";
      // An empty filter is an absent filter: it is never sent, so the backend
      // never has to distinguish "" from "not supplied".
      if (value.trim() !== "") filters[key] = value;
    }
    return {
      filters,
      page: Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1,
      pageSize: (listPageSizes as readonly number[]).includes(rawSize)
        ? (rawSize as ListPageSize)
        : 25,
      sortBy: params.get("sort")?.trim() || defaultSortBy,
      sortDirection: params.get("direction") === "asc" ? "asc" : defaultSortDirection,
    };
  }, [defaultSortBy, defaultSortDirection, filterKeys, params]);

  /** Writes the next state, dropping anything that equals its default. */
  const write = useCallback(
    (next: Partial<ListState>) => {
      const merged = { ...state, ...next };
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(merged.filters)) {
        // Trim decides whether to store, never what to store — see the read.
        if (value.trim() !== "") query.set(key, value);
      }
      if (merged.page > 1) query.set("page", String(merged.page));
      if (merged.pageSize !== 25) query.set("pageSize", String(merged.pageSize));
      if (merged.sortBy !== defaultSortBy) query.set("sort", merged.sortBy);
      if (merged.sortDirection !== defaultSortDirection) {
        query.set("direction", merged.sortDirection);
      }
      // A push, not a replace, so Back returns to the previous list view
      // rather than skipping past it to whatever came before the screen.
      setParams(query);
    },
    [defaultSortBy, defaultSortDirection, setParams, state],
  );

  const setFilter = useCallback(
    (key: string, value: string) => {
      // Any filter change resets to page 1: staying on page 7 of a result set
      // that just shrank to two pages shows an empty screen.
      write({ filters: { ...state.filters, [key]: value }, page: 1 });
    },
    [state.filters, write],
  );

  const setFilters = useCallback(
    (patch: Readonly<Record<string, string>>) => {
      const merged = { ...state.filters, ...patch };
      for (const [key, value] of Object.entries(patch)) {
        if (value.trim() === "") delete merged[key];
      }
      write({ filters: merged, page: 1 });
    },
    [state.filters, write],
  );

  const clearFilters = useCallback(() => {
    // Filters and page reset; the sort the User chose is deliberately kept.
    write({ filters: {}, page: 1 });
  }, [write]);

  const toggleSort = useCallback(
    (key: string, preferred: "asc" | "desc" = "desc") => {
      if (state.sortBy !== key) {
        write({ page: 1, sortBy: key, sortDirection: preferred });
        return;
      }
      if (state.sortDirection === preferred) {
        write({ page: 1, sortDirection: preferred === "asc" ? "desc" : "asc" });
        return;
      }
      // Third click returns to the screen default rather than leaving the list
      // in a third, unlabelled state.
      write({ page: 1, sortBy: defaultSortBy, sortDirection: defaultSortDirection });
    },
    [defaultSortBy, defaultSortDirection, state.sortBy, state.sortDirection, write],
  );

  return {
    ...state,
    activeFilterCount: Object.keys(state.filters).length,
    clearFilters,
    setFilter,
    setFilters,
    setPage: useCallback((page: number) => write({ page: Math.max(1, page) }), [write]),
    setPageSize: useCallback(
      // Changing page size changes which records page 1 holds, so the page
      // resets rather than landing somewhere arbitrary.
      (pageSize: ListPageSize) => write({ page: 1, pageSize }),
      [write],
    ),
    toggleSort,
  };
}
