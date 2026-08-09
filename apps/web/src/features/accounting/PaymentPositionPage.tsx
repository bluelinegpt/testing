import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams, Link } from "react-router-dom";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DirectionalText, LoadPanel } from "./AccountingComponents.js";
import { recordRoute } from "./accounting-routes.js";

/**
 * Unified Payment Position — read-only view.
 *
 * ===========================================================================
 * THIS PAGE DOES NO ARITHMETIC
 * ===========================================================================
 *
 * Every amount is a string the backend computed and this file only formats.
 * There is no addition, no subtraction, no netting, and no running balance
 * recomputed here — the backend already returns `runningBalance` per row,
 * precisely so the client never has to accumulate one.
 *
 * A client-side running total would be wrong the moment the page changed:
 * page 2 would restart from zero, or worse, silently continue from a figure
 * the server never produced. The window function that computes it runs over
 * the whole filtered set, not the visible slice.
 *
 * The only numbers this file produces are the page index and page count, which
 * are UI facts and not money.
 *
 * ===========================================================================
 * DIRECTION IS A LABEL, NOT A SIGN
 * ===========================================================================
 *
 * The backend returns positive magnitudes with a `direction` of `payable` or
 * `receivable`. This page renders that direction as a word and never negates an
 * amount to express it: a Company owed 10,000 and owing 10,000 is not in a zero
 * position, and any UI that lets those cancel is lying about the position.
 */

type Direction = "payable" | "receivable";
type PartyType = "driver" | "employee" | "supplier" | "trader";

const partyTypes: readonly PartyType[] = ["trader", "driver", "employee", "supplier"];
const directions: readonly Direction[] = ["receivable", "payable"];
// Sortable party columns. A TYPE rather than a value: the header buttons
// name their key inline, and the backend resolves it through its own
// allow-list, so a runtime copy here would be a second list to keep in step.
type PartySortKey =
  "originalAmount" | "outstandingAmount" | "overdueAmount" | "partyName" | "transactionCount";
const pageSizes = [25, 50, 100] as const;

interface PartySummary {
  readonly direction: Direction;
  readonly lastMovementDate: string | null;
  readonly originalAmount: string;
  readonly outstandingAmount: string;
  readonly overdueAmount: string;
  readonly partyId: string | null;
  readonly partyName: string | null;
  readonly partyReference: string | null;
  readonly partyType: PartyType;
  readonly runningBalance: string;
  readonly settledAmount: string;
  readonly transactionCount: number;
}

interface PositionTransaction {
  readonly accountingEventId: string | null;
  readonly direction: Direction;
  readonly dueDate: string | null;
  readonly isOverdue: boolean;
  readonly journalEntryId: string | null;
  readonly journalNumber: string | null;
  readonly originalAmount: string;
  readonly outstandingAmount: string;
  readonly partyId: string | null;
  readonly partyName: string | null;
  readonly partyType: PartyType;
  readonly runningBalance: string;
  readonly settledAmount: string;
  readonly sourceId: string;
  readonly sourceReference: string;
  readonly status: string;
  readonly transactionDate: string;
  readonly transactionType: string;
}

interface PositionMetadata {
  readonly dueDateBasis: string;
  readonly dueDateNote: string;
  readonly overdueAfterDays: number;
}

interface SummaryResponse {
  readonly items: readonly PartySummary[];
  readonly metadata: PositionMetadata;
  readonly total: number;
  readonly totals: {
    readonly originalAmount: string;
    readonly outstandingAmount: string;
    readonly overdueAmount: string;
    readonly settledAmount: string;
    readonly transactionCount: number;
  };
}

interface TransactionsResponse {
  readonly items: readonly PositionTransaction[];
  readonly metadata: PositionMetadata;
  readonly total: number;
}

/** Which source type each transaction row links back to. */
const routableSource: Readonly<Record<string, Parameters<typeof recordRoute>[0]>> = {
  general_expense: "general_expense",
  outsourced_driver_fee: "outsourced_driver_fee_accrual",
  trader_receivable: "trader_receivable",
};

export function PaymentPositionPage({ api }: { readonly api: ApiClient }) {
  const { i18n, t } = useTranslation();
  // The URL is the single source of truth for filters, paging and sort, so a
  // position a user is looking at can be shared, bookmarked and reloaded. Local
  // state would make the back button lie.
  const [parameters, setParameters] = useSearchParams();
  const [draft, setDraft] = useState(() => Object.fromEntries(parameters));
  const [summary, setSummary] = useState<SummaryResponse>();
  const [rows, setRows] = useState<readonly PositionTransaction[]>([]);
  const [rowTotal, setRowTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);

  const read = useCallback((key: string) => parameters.get(key) ?? "", [parameters]);
  const page = Math.max(Number(read("page") || "1") - 1, 0);
  const pageSize = pageSizes.includes(Number(read("pageSize")) as (typeof pageSizes)[number])
    ? Number(read("pageSize"))
    : 50;
  const sortBy = read("sortBy") || "outstandingAmount";
  const sortDirection = read("sortDirection") === "asc" ? "asc" : "desc";

  const queryString = useMemo(() => {
    const next = new URLSearchParams();
    for (const key of [
      "partyType",
      "partyId",
      "direction",
      "dateFrom",
      "dateTo",
      "outstandingOnly",
      "overdueOnly",
      "overdueAfterDays",
    ]) {
      const value = read(key);
      if (value !== "") next.set(key, value);
    }
    next.set("sortBy", sortBy);
    next.set("sortDirection", sortDirection);
    next.set("limit", String(pageSize));
    next.set("offset", String(page * pageSize));
    return next.toString();
  }, [page, pageSize, read, sortBy, sortDirection]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    Promise.all([
      api.get<SummaryResponse>(
        `operations/reports/payment-position?${queryString}`,
        controller.signal,
      ),
      api.get<TransactionsResponse>(
        `operations/reports/payment-position/transactions?${queryString}`,
        controller.signal,
      ),
    ])
      .then(([position, transactions]) => {
        setSummary(position);
        setRows(transactions.items);
        setRowTotal(transactions.total);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiError ? cause.code : "unknown");
        setLoading(false);
      });
    return () => controller.abort();
  }, [api, queryString, reloadToken]);

  const locale = i18n.resolvedLanguage === "ar" ? "ar-AE" : "en-AE";
  // Amounts, dates and references stay LTR even on an RTL page: a digit group
  // read right-to-left is a different number.
  const money = (value: string) => (
    <bdi className="accounting-amount" dir="ltr">
      {value}
    </bdi>
  );
  const day = (value: string | null) =>
    value === null ? "—" : <bdi dir="ltr">{new Date(value).toLocaleDateString(locale)}</bdi>;

  /**
   * Party options from the current summary.
   *
   * There is no party-lookup endpoint shared across all four party types, and
   * adding one would be a backend change this prompt excludes. Taking them from
   * the summary keeps the page to two requests and guarantees every option
   * resolves to a party that actually has a position.
   */
  const partyOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const item of summary?.items ?? []) {
      if (item.partyId !== null) options.set(item.partyId, item.partyName ?? item.partyId);
    }
    return [...options].sort((left, right) => left[1].localeCompare(right[1]));
  }, [summary]);

  const [exporting, setExporting] = useState(false);

  /**
   * Download the CSV the server built.
   *
   * `getBinary` rather than a plain link because the endpoint needs the bearer
   * token. Sends the SAME query string the screen is showing, so filters, sort
   * and totals match by construction; the browser receives a finished file and
   * never the row set.
   */
  const exportCsv = useCallback(() => {
    setExporting(true);
    api
      .getBinary(
        `operations/reports/payment-position/export?${queryString}&language=${
          i18n.resolvedLanguage === "ar" ? "ar" : "en"
        }`,
      )
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "payment-position.csv";
        link.click();
        // Deferred revoke: revoking immediately cancels the download in some
        // browsers. Matches AccountingReportsWorkspace.
        globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000);
        setExporting(false);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.code : "unknown");
        setExporting(false);
      });
  }, [api, i18n.resolvedLanguage, queryString]);

  const commit = (next: Readonly<Record<string, string>>, resetPage = true) => {
    const updated = new URLSearchParams(parameters);
    for (const [key, value] of Object.entries(next)) {
      if (value === "") updated.delete(key);
      else updated.set(key, value);
    }
    if (resetPage) updated.set("page", "1");
    setParameters(updated, { replace: true });
  };

  const apply = () => commit(draft);
  const clear = () => {
    setDraft({});
    setParameters(new URLSearchParams(), { replace: true });
  };
  const sortLink = (key: PartySortKey) =>
    commit(
      {
        sortBy: key,
        sortDirection: sortBy === key && sortDirection === "desc" ? "asc" : "desc",
      },
      false,
    );

  const lastPage = Math.max(Math.ceil(rowTotal / pageSize) - 1, 0);
  const field = (key: string) => draft[key] ?? read(key);

  return (
    <div className="accounting-page payment-position">
      <PageHeader description={t("paymentPosition.subtitle")} title={t("paymentPosition.title")} />

      <form
        className="accounting-filters"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label>
          {t("paymentPosition.filters.partyType")}
          <select
            onChange={(event) => setDraft({ ...draft, partyType: event.target.value })}
            value={field("partyType")}
          >
            <option value="">{t("common.all")}</option>
            {partyTypes.map((type) => (
              <option key={type} value={type}>
                {t(`paymentPosition.partyTypes.${type}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("paymentPosition.filters.party")}
          <select
            onChange={(event) => setDraft({ ...draft, partyId: event.target.value })}
            value={field("partyId")}
          >
            <option value="">{t("common.all")}</option>
            {partyOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("paymentPosition.filters.direction")}
          <select
            onChange={(event) => setDraft({ ...draft, direction: event.target.value })}
            value={field("direction")}
          >
            <option value="">{t("common.all")}</option>
            {directions.map((value) => (
              <option key={value} value={value}>
                {t(`paymentPosition.directions.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("paymentPosition.filters.dateFrom")}
          <input
            dir="ltr"
            onChange={(event) => setDraft({ ...draft, dateFrom: event.target.value })}
            type="date"
            value={field("dateFrom")}
          />
        </label>
        <label>
          {t("paymentPosition.filters.dateTo")}
          <input
            dir="ltr"
            onChange={(event) => setDraft({ ...draft, dateTo: event.target.value })}
            type="date"
            value={field("dateTo")}
          />
        </label>
        <label className="accounting-filter-check">
          <input
            checked={field("outstandingOnly") === "true"}
            onChange={(event) =>
              setDraft({ ...draft, outstandingOnly: event.target.checked ? "true" : "" })
            }
            type="checkbox"
          />
          {t("paymentPosition.filters.outstandingOnly")}
        </label>
        <label className="accounting-filter-check">
          <input
            checked={field("overdueOnly") === "true"}
            onChange={(event) =>
              setDraft({ ...draft, overdueOnly: event.target.checked ? "true" : "" })
            }
            type="checkbox"
          />
          {t("paymentPosition.filters.overdueOnly")}
        </label>
        <div className="accounting-filter-actions">
          <button className="button" type="submit">
            {t("common.apply")}
          </button>
          <button className="button button-secondary" onClick={clear} type="button">
            {t("common.clear")}
          </button>
          <button
            className="button button-secondary"
            disabled={exporting || loading}
            onClick={exportCsv}
            type="button"
          >
            {exporting ? t("common.loading") : t("paymentPosition.exportCsv")}
          </button>
        </div>
      </form>

      <LoadPanel
        error={error}
        loading={loading}
        onRefresh={() => setReloadToken((current) => current + 1)}
      >
        {summary === undefined ? null : (
          <>
            {/* The backend defines "overdue" as an ageing threshold because no
                source stores a due date. Saying so on screen stops the column
                being read as an agreed payment term. */}
            <div className="alert alert-info" role="status">
              {t("paymentPosition.overdueBasis", { days: summary.metadata.overdueAfterDays })}
            </div>

            <div className="accounting-summary-cards">
              {(
                [
                  ["originalAmount", summary.totals.originalAmount],
                  ["settledAmount", summary.totals.settledAmount],
                  ["outstandingAmount", summary.totals.outstandingAmount],
                  ["overdueAmount", summary.totals.overdueAmount],
                ] as const
              ).map(([key, value]) => (
                <div className="accounting-summary-card" key={key}>
                  <span>{t(`paymentPosition.columns.${key}`)}</span>
                  <strong>{money(value)}</strong>
                </div>
              ))}
              <div className="accounting-summary-card">
                <span>{t("paymentPosition.columns.transactionCount")}</span>
                <strong>{summary.totals.transactionCount}</strong>
              </div>
            </div>

            <h3>{t("paymentPosition.sections.parties")}</h3>
            <div className="table-scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>{t("paymentPosition.columns.partyType")}</th>
                    {(["partyName"] as const).map((key) => (
                      <th key={key}>
                        <button className="link-button" onClick={() => sortLink(key)} type="button">
                          {t(`paymentPosition.columns.${key}`)}
                          {sortBy === key ? (sortDirection === "asc" ? " ▲" : " ▼") : ""}
                        </button>
                      </th>
                    ))}
                    <th>{t("paymentPosition.columns.direction")}</th>
                    {(
                      [
                        "originalAmount",
                        "settledAmount",
                        "outstandingAmount",
                        "overdueAmount",
                      ] as const
                    ).map((key) => (
                      <th key={key}>
                        {key === "settledAmount" ? (
                          t("paymentPosition.columns.settledAmount")
                        ) : (
                          <button
                            className="link-button"
                            onClick={() => sortLink(key as PartySortKey)}
                            type="button"
                          >
                            {t(`paymentPosition.columns.${key}`)}
                            {sortBy === key ? (sortDirection === "asc" ? " ▲" : " ▼") : ""}
                          </button>
                        )}
                      </th>
                    ))}
                    <th>
                      <button
                        className="link-button"
                        onClick={() => sortLink("transactionCount")}
                        type="button"
                      >
                        {t("paymentPosition.columns.transactionCount")}
                        {sortBy === "transactionCount"
                          ? sortDirection === "asc"
                            ? " ▲"
                            : " ▼"
                          : ""}
                      </button>
                    </th>
                    <th>{t("paymentPosition.columns.lastMovementDate")}</th>
                    <th>{t("paymentPosition.columns.runningBalance")}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.items.length === 0 ? (
                    <tr>
                      <td className="empty-state" colSpan={10}>
                        {t("paymentPosition.empty.parties")}
                      </td>
                    </tr>
                  ) : (
                    summary.items.map((item) => (
                      <tr key={`${item.partyType}:${item.partyId ?? "none"}:${item.direction}`}>
                        <td>{t(`paymentPosition.partyTypes.${item.partyType}`)}</td>
                        <td>
                          {item.partyName ?? t("paymentPosition.unnamedParty")}
                          {item.partyReference === null ? null : (
                            <>
                              {" "}
                              <DirectionalText>{item.partyReference}</DirectionalText>
                            </>
                          )}
                        </td>
                        <td>{t(`paymentPosition.directions.${item.direction}`)}</td>
                        <td>{money(item.originalAmount)}</td>
                        <td>{money(item.settledAmount)}</td>
                        <td>{money(item.outstandingAmount)}</td>
                        <td>{money(item.overdueAmount)}</td>
                        <td>{item.transactionCount}</td>
                        <td>{day(item.lastMovementDate)}</td>
                        <td>{money(item.runningBalance)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <h3>{t("paymentPosition.sections.transactions")}</h3>
            <div className="table-scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>{t("paymentPosition.columns.partyName")}</th>
                    <th>{t("paymentPosition.columns.transactionType")}</th>
                    <th>{t("paymentPosition.columns.sourceReference")}</th>
                    <th>{t("paymentPosition.columns.transactionDate")}</th>
                    <th>{t("paymentPosition.columns.dueDate")}</th>
                    <th>{t("paymentPosition.columns.originalAmount")}</th>
                    <th>{t("paymentPosition.columns.settledAmount")}</th>
                    <th>{t("paymentPosition.columns.outstandingAmount")}</th>
                    <th>{t("common.status")}</th>
                    <th>{t("paymentPosition.columns.accountingEvent")}</th>
                    <th>{t("paymentPosition.columns.journal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td className="empty-state" colSpan={11}>
                        {t("paymentPosition.empty.transactions")}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => {
                      const type = routableSource[row.transactionType];
                      const sourceHref =
                        type === undefined ? undefined : recordRoute(type, row.sourceId);
                      const eventHref = recordRoute("accounting_event", row.accountingEventId);
                      const journalHref = recordRoute("journal", row.journalEntryId);
                      return (
                        <tr
                          className={row.isOverdue ? "row-overdue" : undefined}
                          key={`${row.transactionType}:${row.sourceId}`}
                        >
                          <td>{row.partyName ?? t("paymentPosition.unnamedParty")}</td>
                          <td>{t(`paymentPosition.transactionTypes.${row.transactionType}`)}</td>
                          <td>
                            {sourceHref === undefined ? (
                              <DirectionalText>{row.sourceReference}</DirectionalText>
                            ) : (
                              <Link to={sourceHref}>
                                <DirectionalText>{row.sourceReference}</DirectionalText>
                              </Link>
                            )}
                          </td>
                          <td>{day(row.transactionDate)}</td>
                          <td>{day(row.dueDate)}</td>
                          <td>{money(row.originalAmount)}</td>
                          <td>{money(row.settledAmount)}</td>
                          <td>{money(row.outstandingAmount)}</td>
                          <td>{row.status}</td>
                          <td>
                            {eventHref === undefined ? (
                              "—"
                            ) : (
                              <Link to={eventHref}>{t("paymentPosition.links.event")}</Link>
                            )}
                          </td>
                          <td>
                            {journalHref === undefined ? (
                              "—"
                            ) : (
                              <Link to={journalHref}>
                                <DirectionalText>
                                  {row.journalNumber ?? t("paymentPosition.links.journal")}
                                </DirectionalText>
                              </Link>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="accounting-pagination">
              <label>
                {t("paymentPosition.pageSize")}
                <select
                  onChange={(event) => commit({ pageSize: event.target.value })}
                  value={String(pageSize)}
                >
                  {pageSizes.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button button-secondary"
                disabled={page === 0}
                onClick={() => commit({ page: String(page) }, false)}
                type="button"
              >
                {t("common.previous")}
              </button>
              <span>
                {t("paymentPosition.pagination", {
                  page: page + 1,
                  pages: lastPage + 1,
                  total: rowTotal,
                })}
              </span>
              <button
                className="button button-secondary"
                disabled={page >= lastPage}
                onClick={() => commit({ page: String(page + 2) }, false)}
                type="button"
              >
                {t("common.next")}
              </button>
            </div>
          </>
        )}
      </LoadPanel>
    </div>
  );
}
