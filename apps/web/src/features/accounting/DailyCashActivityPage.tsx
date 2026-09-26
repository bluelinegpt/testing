import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DirectionalText, LoadPanel } from "./AccountingComponents.js";
import { recordRoute } from "./accounting-routes.js";

/**
 * Daily Cash and Financial Activity — read-only view.
 *
 * ===========================================================================
 * THIS PAGE DOES NO ARITHMETIC
 * ===========================================================================
 *
 * Every amount rendered here is a string the backend computed and this file
 * only formats. There is no addition, no subtraction, no netting, and no
 * derived total anywhere below — not even the "obvious" ones like closing =
 * opening + net, which the service already returns.
 *
 * That is deliberate and worth stating, because a helpful-looking client-side
 * sum is how a report starts disagreeing with itself: the card would say one
 * thing, the drill-down another, and neither would be wrong in isolation. The
 * server is the only place these numbers are decided.
 *
 * The one number this file produces is the count of drill-down rows on screen,
 * which is a UI fact and not money.
 *
 * ===========================================================================
 * CASH AND INCOME ARE RENDERED APART
 * ===========================================================================
 *
 * Cash Activity answers "what money moved last night" on the 08:00-08:00
 * Business Day window. Income Statement Activity answers "what did we earn and
 * spend" on the Accounting Date, which is date-only.
 *
 * They are two separate sections with two separate headings and no shared
 * total, and the Income Statement carries a visible note saying its dates mean
 * something different. Collections are never labelled revenue and payments are
 * never labelled expense.
 */

type PaymentMethod = "bank" | "cash";

const partyTypes = ["driver", "employee", "expense", "internal", "trader"] as const;
const paymentMethods: readonly PaymentMethod[] = ["cash", "bank"];

interface CashActivity {
  readonly bankCollected: string;
  readonly bankPaid: string;
  readonly cashCollected: string;
  readonly cashPaid: string;
  readonly closingBankBalance: string;
  readonly closingCashBalance: string;
  readonly netBankMovement: string;
  readonly netCashMovement: string;
  readonly openingBankBalance: string;
  readonly openingCashBalance: string;
  readonly outstandingToCollect: string;
  readonly outstandingToPay: string;
}

interface IncomeStatementActivity {
  readonly expensesRecognized: string;
  readonly netIncomeActivity: string;
  readonly revenueRecognized: string;
}

interface ReportMetadata {
  readonly accountingDateBasis: string;
  readonly authoritativeTimestamps: readonly {
    readonly column: string;
    readonly historicalNulls: boolean;
    readonly sourceType: string;
    readonly table: string;
  }[];
  readonly businessDate: string;
  readonly dateBasis: "business" | "calendar";
  readonly businessDayStart: string;
  readonly displayEnd: string;
  readonly endUtc: string;
  readonly excludedRowsWithoutTimestamp: number;
  readonly segments: readonly {
    readonly businessDateFrom: string;
    readonly businessDateTo: string;
    readonly businessDayStart: string;
    readonly configurationId: string;
    readonly displayEnd: string;
    readonly endUtc: string;
    readonly startUtc: string;
    readonly timezone: string;
  }[];
  readonly spansRuleChange: boolean;
  readonly startUtc: string;
  readonly timezone: string;
}

interface DailyCashReport {
  readonly cashActivity: CashActivity;
  readonly incomeStatementActivity: IncomeStatementActivity;
  readonly metadata: ReportMetadata;
}

interface DrillDownRow {
  readonly accountingEventId: string | null;
  readonly amount: string;
  readonly bankAccountId: string | null;
  readonly bankAccountName: string | null;
  readonly businessDate: string | null;
  readonly cashAccountId: string | null;
  readonly cashAccountName: string | null;
  readonly confirmedAt: string;
  readonly direction: "in" | "out";
  readonly journalEntryId: string | null;
  readonly journalNumber: string | null;
  readonly partyId: string | null;
  readonly partyName: string | null;
  readonly partyType: string;
  readonly paymentMethod: PaymentMethod;
  readonly sourceId: string;
  readonly sourceReference: string;
  readonly sourceType: string;
}

interface Filters {
  readonly accountId: string;
  readonly businessDate: string;
  readonly dateBasis: "business" | "calendar";
  readonly partyId: string;
  readonly partyType: string;
  readonly paymentMethod: string;
}

const pageSize = 50;

/** Today in the browser's calendar, as the initial Business Date only. */
function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function query(filters: Filters, extra: Readonly<Record<string, string>> = {}): string {
  const parameters = new URLSearchParams({
    businessDate: filters.businessDate,
    dateBasis: filters.dateBasis,
  });
  if (filters.accountId !== "") parameters.set("accountId", filters.accountId);
  if (filters.paymentMethod !== "") parameters.set("paymentMethod", filters.paymentMethod);
  if (filters.partyType !== "") parameters.set("partyType", filters.partyType);
  if (filters.partyId !== "") parameters.set("partyId", filters.partyId);
  for (const [key, value] of Object.entries(extra)) parameters.set(key, value);
  return parameters.toString();
}

export function DailyCashActivityPage({ api }: { readonly api: ApiClient }) {
  const { i18n, t } = useTranslation();
  const [draft, setDraft] = useState<Filters>(() => ({
    accountId: "",
    businessDate: todayIso(),
    dateBasis: "calendar",
    partyId: "",
    partyType: "",
    paymentMethod: "",
  }));
  const [applied, setApplied] = useState<Filters>(draft);
  const [page, setPage] = useState(0);
  const [report, setReport] = useState<DailyCashReport>();
  const [rows, setRows] = useState<readonly DrillDownRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setErrorMessage(undefined);
    // Both reads are issued together rather than in sequence: the summary and
    // the rows describe the same window and neither depends on the other.
    Promise.all([
      api.get<DailyCashReport>(
        `operations/reports/daily-cash-activity?${query(applied)}`,
        controller.signal,
      ),
      api.get<{ items: readonly DrillDownRow[]; total: number }>(
        `operations/reports/daily-cash-activity/rows?${query(applied, {
          limit: String(pageSize),
          offset: String(page * pageSize),
        })}`,
        controller.signal,
      ),
    ])
      .then(([summary, drillDown]) => {
        setReport(summary);
        setRows(drillDown.items);
        setTotal(drillDown.total);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiError ? cause.code : "unknown");
        setErrorMessage(cause instanceof ApiError ? cause.message : undefined);
        setLoading(false);
      });
    return () => controller.abort();
  }, [api, applied, page, reloadToken]);

  const locale = i18n.resolvedLanguage === "ar" ? "ar-AE" : "en-AE";
  // Money and timestamps stay LTR even in an RTL page: a digit group read
  // right-to-left is a different number, and this is a financial report.
  const money = useCallback(
    (value: string) => (
      <bdi className="accounting-amount" dir="ltr">
        {value}
      </bdi>
    ),
    [],
  );
  const dateTime = useCallback(
    (value: string | null) =>
      value === null ? (
        "—"
      ) : (
        <bdi dir="ltr">{new Date(value).toLocaleString(locale, { hour12: false })}</bdi>
      ),
    [locale],
  );

  /**
   * Account and Party options, taken from the rows currently on screen.
   *
   * There is no lookup endpoint for "accounts and parties that had activity on
   * this day", and inventing one would be a backend change this prompt excludes.
   * Deriving them from the returned rows keeps the page to two requests and
   * guarantees every option actually resolves to something.
   */
  const accountOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const row of rows) {
      if (row.cashAccountId !== null)
        options.set(row.cashAccountId, row.cashAccountName ?? row.cashAccountId);
      if (row.bankAccountId !== null)
        options.set(row.bankAccountId, row.bankAccountName ?? row.bankAccountId);
    }
    return [...options].sort((left, right) => left[1].localeCompare(right[1]));
  }, [rows]);

  const partyOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const row of rows) {
      if (row.partyId !== null) options.set(row.partyId, row.partyName ?? row.partyId);
    }
    return [...options].sort((left, right) => left[1].localeCompare(right[1]));
  }, [rows]);

  const [exporting, setExporting] = useState(false);

  /**
   * Download the CSV the server built.
   *
   * `getBinary` rather than a plain link because the endpoint needs the bearer
   * token. The browser receives a finished file and never the row set: nothing
   * is assembled, summed or reformatted here, so the export cannot disagree
   * with the screen.
   */
  const exportCsv = useCallback(() => {
    setExporting(true);
    api
      .getBinary(
        `operations/reports/daily-cash-activity/export?${query(applied, {
          language: i18n.resolvedLanguage === "ar" ? "ar" : "en",
        })}`,
      )
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `daily-cash-activity-${applied.businessDate}.csv`;
        link.click();
        // Deferred revoke, matching AccountingReportsWorkspace: revoking
        // immediately cancels the download in some browsers.
        globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000);
        setExporting(false);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.code : "unknown");
        setExporting(false);
      });
  }, [api, applied, i18n.resolvedLanguage]);

  const apply = () => {
    setPage(0);
    setApplied(draft);
  };
  const clear = () => {
    const reset: Filters = {
      accountId: "",
      businessDate: draft.businessDate,
      dateBasis: "calendar",
      partyId: "",
      partyType: "",
      paymentMethod: "",
    };
    setDraft(reset);
    setPage(0);
    setApplied(reset);
  };

  const lastPage = Math.max(Math.ceil(total / pageSize) - 1, 0);

  return (
    <div className="accounting-page daily-cash-activity">
      <PageHeader
        description={t("dailyCashActivity.subtitle")}
        title={t("dailyCashActivity.title")}
      />

      <form
        className="accounting-filters"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label>
          {t("dailyCashActivity.filters.businessDate")}
          <input
            dir="ltr"
            onChange={(event) => setDraft({ ...draft, businessDate: event.target.value })}
            required
            type="date"
            value={draft.businessDate}
          />
        </label>
        <label>
          {t("dailyCashActivity.filters.dateBasis")}
          <select
            onChange={(event) =>
              setDraft({
                ...draft,
                dateBasis: event.target.value as "business" | "calendar",
              })
            }
            value={draft.dateBasis}
          >
            <option value="calendar">{t("dailyCashActivity.dateBasis.calendar")}</option>
            <option value="business">{t("dailyCashActivity.dateBasis.business")}</option>
          </select>
        </label>
        <label>
          {t("dailyCashActivity.filters.account")}
          <select
            onChange={(event) => setDraft({ ...draft, accountId: event.target.value })}
            value={draft.accountId}
          >
            <option value="">{t("common.all")}</option>
            {accountOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("dailyCashActivity.filters.paymentMethod")}
          <select
            onChange={(event) => setDraft({ ...draft, paymentMethod: event.target.value })}
            value={draft.paymentMethod}
          >
            <option value="">{t("common.all")}</option>
            {paymentMethods.map((method) => (
              <option key={method} value={method}>
                {t(`dailyCashActivity.methods.${method}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("dailyCashActivity.filters.partyType")}
          <select
            onChange={(event) => setDraft({ ...draft, partyType: event.target.value })}
            value={draft.partyType}
          >
            <option value="">{t("common.all")}</option>
            {partyTypes.map((type) => (
              <option key={type} value={type}>
                {t(`dailyCashActivity.partyTypes.${type}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("dailyCashActivity.filters.party")}
          <select
            onChange={(event) => setDraft({ ...draft, partyId: event.target.value })}
            value={draft.partyId}
          >
            <option value="">{t("common.all")}</option>
            {partyOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
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
            {exporting ? t("common.loading") : t("dailyCashActivity.exportCsv")}
          </button>
        </div>
      </form>

      <LoadPanel
        error={error}
        errorMessage={errorMessage}
        loading={loading}
        onRefresh={() => setReloadToken((current) => current + 1)}
      >
        {report === undefined ? null : (
          <>
            {report.metadata.excludedRowsWithoutTimestamp > 0 ? (
              <div className="alert alert-warning" role="status">
                {t("dailyCashActivity.warnings.missingTimestamps", {
                  count: report.metadata.excludedRowsWithoutTimestamp,
                })}
              </div>
            ) : null}

            <h3>{t("dailyCashActivity.sections.cashActivity")}</h3>
            <div className="accounting-summary-cards">
              {(
                [
                  ["openingCash", report.cashActivity.openingCashBalance],
                  ["openingBank", report.cashActivity.openingBankBalance],
                  ["cashCollected", report.cashActivity.cashCollected],
                  ["bankCollected", report.cashActivity.bankCollected],
                  ["cashPaid", report.cashActivity.cashPaid],
                  ["bankPaid", report.cashActivity.bankPaid],
                  ["netCash", report.cashActivity.netCashMovement],
                  ["netBank", report.cashActivity.netBankMovement],
                  ["closingCash", report.cashActivity.closingCashBalance],
                  ["closingBank", report.cashActivity.closingBankBalance],
                  ["outstandingToCollect", report.cashActivity.outstandingToCollect],
                  ["outstandingToPay", report.cashActivity.outstandingToPay],
                ] as const
              ).map(([key, value]) => (
                <div className="accounting-summary-card" key={key}>
                  <span>{t(`dailyCashActivity.cash.${key}`)}</span>
                  <strong>{money(value)}</strong>
                </div>
              ))}
            </div>

            {/*
              A separate heading and a separate note, because this section is on
              a different calendar and answers a different question. Nothing
              here is described as cash, and nothing above is described as
              revenue or expense.
            */}
            <h3>{t("dailyCashActivity.sections.incomeStatement")}</h3>
            <p className="accounting-hint">{t("dailyCashActivity.incomeStatementNote")}</p>
            <div className="accounting-summary-cards">
              {(
                [
                  ["revenueRecognized", report.incomeStatementActivity.revenueRecognized],
                  ["expensesRecognized", report.incomeStatementActivity.expensesRecognized],
                  ["netIncomeActivity", report.incomeStatementActivity.netIncomeActivity],
                ] as const
              ).map(([key, value]) => (
                <div className="accounting-summary-card" key={key}>
                  <span>{t(`dailyCashActivity.income.${key}`)}</span>
                  <strong>{money(value)}</strong>
                </div>
              ))}
            </div>

            <h3>{t("dailyCashActivity.sections.window")}</h3>
            <dl className="reconciliation-summary">
              {(
                [
                  ["businessDate", report.metadata.businessDate],
                  ["dateBasis", t(`dailyCashActivity.dateBasis.${report.metadata.dateBasis}`)],
                  ["windowStart", report.metadata.startUtc],
                  ["windowEnd", report.metadata.displayEnd],
                  ["timezone", report.metadata.timezone],
                  ["businessDayStart", report.metadata.businessDayStart],
                ] as const
              ).map(([key, value]) => (
                <div key={key}>
                  <dt>{t(`dailyCashActivity.metadata.${key}`)}</dt>
                  <dd>
                    <DirectionalText>{value}</DirectionalText>
                  </dd>
                </div>
              ))}
            </dl>

            <h4>{t("dailyCashActivity.metadata.segments")}</h4>
            <div className="table-scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>{t("dailyCashActivity.metadata.segmentDates")}</th>
                    <th>{t("dailyCashActivity.metadata.businessDayStart")}</th>
                    <th>{t("dailyCashActivity.metadata.timezone")}</th>
                    <th>{t("dailyCashActivity.metadata.windowStart")}</th>
                    <th>{t("dailyCashActivity.metadata.windowEnd")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.metadata.segments.map((segment) => (
                    <tr key={segment.configurationId}>
                      <td>
                        <DirectionalText>
                          {`${segment.businessDateFrom} → ${segment.businessDateTo}`}
                        </DirectionalText>
                      </td>
                      <td>
                        <DirectionalText>{segment.businessDayStart}</DirectionalText>
                      </td>
                      <td>
                        <DirectionalText>{segment.timezone}</DirectionalText>
                      </td>
                      <td>{dateTime(segment.startUtc)}</td>
                      <td>{dateTime(segment.displayEnd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h4>{t("dailyCashActivity.metadata.authoritativeTimestamps")}</h4>
            <div className="table-scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>{t("dailyCashActivity.columns.sourceType")}</th>
                    <th>{t("dailyCashActivity.metadata.table")}</th>
                    <th>{t("dailyCashActivity.metadata.column")}</th>
                    <th>{t("dailyCashActivity.metadata.historicalNulls")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.metadata.authoritativeTimestamps.map((source) => (
                    <tr key={source.sourceType}>
                      <td>{t(`dailyCashActivity.sourceTypes.${source.sourceType}`)}</td>
                      <td>
                        <DirectionalText>{source.table}</DirectionalText>
                      </td>
                      <td>
                        <DirectionalText>{source.column}</DirectionalText>
                      </td>
                      <td>
                        {source.historicalNulls
                          ? t("dailyCashActivity.metadata.prospective")
                          : t("dailyCashActivity.metadata.complete")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3>{t("dailyCashActivity.sections.drillDown")}</h3>
            <div className="table-scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>{t("dailyCashActivity.columns.sourceType")}</th>
                    <th>{t("dailyCashActivity.columns.sourceReference")}</th>
                    <th>{t("dailyCashActivity.columns.party")}</th>
                    <th>{t("dailyCashActivity.columns.paymentMethod")}</th>
                    <th>{t("dailyCashActivity.columns.account")}</th>
                    <th>{t("dailyCashActivity.columns.amount")}</th>
                    <th>{t("dailyCashActivity.columns.confirmedAt")}</th>
                    <th>{t("dailyCashActivity.columns.businessDate")}</th>
                    <th>{t("dailyCashActivity.columns.accountingEvent")}</th>
                    <th>{t("dailyCashActivity.columns.journal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td className="empty-state" colSpan={10}>
                        {t("dailyCashActivity.empty.rows")}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => {
                      const sourceHref = recordRoute(
                        row.sourceType as Parameters<typeof recordRoute>[0],
                        row.sourceId,
                      );
                      const eventHref = recordRoute("accounting_event", row.accountingEventId);
                      const journalHref = recordRoute("journal", row.journalEntryId);
                      return (
                        <tr key={`${row.sourceType}:${row.sourceId}:${row.paymentMethod}`}>
                          <td>{t(`dailyCashActivity.sourceTypes.${row.sourceType}`)}</td>
                          <td>
                            {sourceHref === undefined ? (
                              <DirectionalText>{row.sourceReference}</DirectionalText>
                            ) : (
                              <Link to={sourceHref}>
                                <DirectionalText>{row.sourceReference}</DirectionalText>
                              </Link>
                            )}
                          </td>
                          <td>
                            {row.partyName ?? t(`dailyCashActivity.partyTypes.${row.partyType}`)}
                          </td>
                          <td>{t(`dailyCashActivity.methods.${row.paymentMethod}`)}</td>
                          <td>{row.cashAccountName ?? row.bankAccountName ?? "—"}</td>
                          <td>
                            {/* Direction is a label, not a sign: the backend
                                returns magnitudes and netting them here would
                                be a calculation. */}
                            {money(row.amount)}{" "}
                            <span className="accounting-hint">
                              {t(`dailyCashActivity.directions.${row.direction}`)}
                            </span>
                          </td>
                          <td>{dateTime(row.confirmedAt)}</td>
                          <td>
                            <DirectionalText>{row.businessDate ?? "—"}</DirectionalText>
                          </td>
                          <td>
                            {eventHref === undefined ? (
                              "—"
                            ) : (
                              <Link to={eventHref}>{t("dailyCashActivity.links.event")}</Link>
                            )}
                          </td>
                          <td>
                            {journalHref === undefined ? (
                              "—"
                            ) : (
                              <Link to={journalHref}>
                                <DirectionalText>
                                  {row.journalNumber ?? t("dailyCashActivity.links.journal")}
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
              <button
                className="button button-secondary"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
                type="button"
              >
                {t("common.previous")}
              </button>
              <span>
                {t("dailyCashActivity.pagination", {
                  page: page + 1,
                  pages: lastPage + 1,
                  total,
                })}
              </span>
              <button
                className="button button-secondary"
                disabled={page >= lastPage}
                onClick={() => setPage(page + 1)}
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
