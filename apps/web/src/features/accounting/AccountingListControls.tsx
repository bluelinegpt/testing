import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { listPageSizes, type ListPageSize, type ListStateControls } from "./use-list-state.js";

/**
 * Shared list controls for the Accounting lists: pagination footer, sortable
 * column headers, and the filter bar's active-count / Clear Filters pair.
 *
 * All three read and write the same URL-backed state, so what the User sees
 * always matches the address bar and every change results in exactly one
 * server request. Nothing here sorts, filters or counts in the browser — the
 * total comes from the backend, never from the loaded page.
 */

/**
 * Pagination footer.
 *
 * The displayed range is derived from the server's own total, so it stays
 * honest when the last page is short. `Previous`/`Next` disable at the ends
 * rather than silently doing nothing.
 */
export function AccountingPagination({
  state,
  total,
  totalPages,
}: {
  readonly state: ListStateControls;
  readonly total: number;
  readonly totalPages: number;
}) {
  const { t } = useTranslation();
  const pages = Math.max(1, totalPages);
  // A stale URL can ask for a page past the end; the footer reports the page
  // actually in effect rather than the one that was requested.
  const page = Math.min(Math.max(1, state.page), pages);
  const first = total === 0 ? 0 : (page - 1) * state.pageSize + 1;
  const last = Math.min(page * state.pageSize, total);
  return (
    <nav aria-label={t("accounting.list.pagination")} className="accounting-pagination">
      <span className="accounting-pagination-range">
        {total === 0
          ? t("accounting.list.noRecords")
          : t("accounting.list.showingRange", { first, last, total })}
      </span>
      <label className="accounting-pagination-size">
        <span>{t("accounting.list.pageSize")}</span>
        <select
          onChange={(event) =>
            state.setPageSize(Number(event.currentTarget.value) as ListPageSize)
          }
          value={state.pageSize}
        >
          {listPageSizes.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <div className="accounting-pagination-buttons">
        <button
          className="button button-secondary"
          disabled={page <= 1}
          onClick={() => state.setPage(page - 1)}
          type="button"
        >
          {t("accounting.list.previous")}
        </button>
        <span>{t("accounting.list.pageOf", { page, pages })}</span>
        <button
          className="button button-secondary"
          disabled={page >= pages}
          onClick={() => state.setPage(page + 1)}
          type="button"
        >
          {t("accounting.list.next")}
        </button>
      </div>
    </nav>
  );
}

/**
 * A sortable column header.
 *
 * `sortKey` is the backend's allowlisted business key — never a column name.
 * A column with no `sortKey` renders as a plain header, so a screen can only
 * offer sorting the backend actually accepts.
 */
export function SortableHeader({
  label,
  preferred = "desc",
  sortKey,
  state,
}: {
  readonly label: ReactNode;
  readonly preferred?: "asc" | "desc";
  readonly sortKey?: string | undefined;
  readonly state: ListStateControls;
}) {
  const { t } = useTranslation();
  if (sortKey === undefined) return <>{label}</>;
  const active = state.sortBy === sortKey;
  const direction = active ? state.sortDirection : undefined;
  // Only a string label can be interpolated into the accessible name; a node
  // label would stringify to "[object Object]", so it falls back to the key.
  const column = typeof label === "string" ? label : sortKey;
  return (
    <button
      aria-label={
        direction === "asc"
          ? t("accounting.list.sortAscending", { column })
          : direction === "desc"
            ? t("accounting.list.sortDescending", { column })
            : t("accounting.list.sortBy", { column })
      }
      // A real button, so the header is reachable and operable by keyboard
      // with no extra key handling.
      className={`accounting-sort-header${active ? " active" : ""}`}
      onClick={() => state.toggleSort(sortKey, preferred)}
      type="button"
    >
      <span>{label}</span>
      <span aria-hidden="true" className="accounting-sort-indicator">
        {direction === "asc" ? "↑" : direction === "desc" ? "↓" : "↕"}
      </span>
    </button>
  );
}

/**
 * Filter-bar summary: how many filters are applied, and one control to drop
 * them. Rendering the count means the User can always tell why a list looks
 * emptier than they expected.
 */
export function AccountingFilterSummary({ state }: { readonly state: ListStateControls }) {
  const { t } = useTranslation();
  if (state.activeFilterCount === 0) return null;
  return (
    <div className="accounting-filter-summary">
      <span>{t("accounting.list.activeFilters", { count: state.activeFilterCount })}</span>
      <button className="button button-secondary" onClick={state.clearFilters} type="button">
        {t("accounting.list.clearFilters")}
      </button>
    </div>
  );
}
