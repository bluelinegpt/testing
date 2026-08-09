import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Info,
  Landmark,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams, Link } from "react-router-dom";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DirectionalText, LoadPanel } from "./AccountingComponents.js";
import { recordRoute } from "./accounting-routes.js";

/**
 * Accounting Dashboard — read-only.
 *
 * ===========================================================================
 * THIS PAGE DOES NO ARITHMETIC
 * ===========================================================================
 *
 * Every figure is a string the backend computed, and this file only formats and
 * places it. Nothing is added, subtracted, netted or converted here. Cash and
 * Bank are never summed into one "liquidity" number, Revenue is never derived
 * from collections, and a period movement is never subtracted from a balance.
 *
 * The only numbers this file produces are counts of rendered elements, which
 * are UI facts and not money.
 *
 * ===========================================================================
 * MOVEMENT ACTIVITY IS NOT A BALANCE CHANGE
 * ===========================================================================
 *
 * The backend's period figure covers Cash/Bank Movements ONLY. The balance
 * beside it also includes Payroll, Driver fee, Settlement and Expense payments,
 * so the two do not reconcile and were never meant to.
 *
 * That is why these fields are labelled "Movement Activity" everywhere and
 * never "Balance Change", and why the backend's own limitation note is printed
 * next to them rather than summarised away. A user who reads the period figure
 * as the change in the balance would conclude money is missing.
 *
 * ===========================================================================
 * SEPARATE FROM OVERVIEW
 * ===========================================================================
 *
 * This is a new screen at `/accounting/dashboard`. The existing Overview is
 * untouched and still reachable at `/accounting` — this page neither replaces
 * nor renames it.
 */

type PartyType = "driver" | "employee" | "supplier" | "trader";

const partyTypes: readonly PartyType[] = ["trader", "driver", "employee", "supplier"];
/** Filter keys this screen owns, in the order they are read from the URL. */
const filterKeys = ["dateFrom", "dateTo", "accountId", "partyType", "partyId"] as const;

interface DashboardResponse {
  readonly filters: {
    readonly accountId: string | null;
    readonly dateFrom: string | null;
    readonly dateTo: string | null;
    readonly partyId: string | null;
    readonly partyType: string | null;
  };
  readonly generatedAt: string;
  readonly metadata: {
    readonly balanceBasis: string;
    readonly coverage: Readonly<Record<string, number>> | null;
    readonly coverageIncomplete: boolean;
    readonly coverageNote: string | null;
    readonly incomeBasis: string;
    readonly movementScope: string;
    readonly movementScopeNote: string;
  };
  readonly sections: {
    readonly accountingHealth: {
      readonly activeClosingWorkflows: number;
      readonly failedEvents: number;
      readonly openPeriods: number;
      readonly unpostedJournals: number;
      readonly unreconciledMovements: number;
      readonly waitingEvents: number;
    };
    readonly cashAndBank: {
      readonly bankAccountCount: number;
      readonly cashAccountCount: number;
      readonly currentBankBalance: string;
      readonly currentCashBalance: string;
      readonly netBankMovement: string;
      readonly netCashMovement: string;
    };
    readonly incomeAndExpense: {
      readonly expenses: string;
      readonly netIncome: string;
      readonly revenue: string;
    };
    readonly moneyPosition: {
      readonly outstandingToCollect: string;
      readonly outstandingToPay: string;
      readonly overduePayables: string;
      readonly overdueReceivables: string;
      readonly payableTransactionCount: number;
      readonly receivableTransactionCount: number;
    };
    readonly recentActivity: readonly ActivityRow[];
  };
  readonly timezone: string;
}

interface ActivityRow {
  readonly accountingEventId: string | null;
  readonly activityAt: string | null;
  readonly activityDate: string | null;
  readonly amount: string | null;
  readonly journalId: string | null;
  readonly partyName: string | null;
  readonly partyType: string | null;
  readonly route: string | null;
  readonly sourceReference: string | null;
  readonly sourceType: string;
  readonly status: string | null;
}

/** Cash and Bank accounts, used only to name the Account filter's options. */
interface AccountOption {
  readonly code: string | null;
  readonly id: string;
  readonly kind: "bank" | "cash";
  readonly name: string | null;
}

/** Health counts and where each one is actually resolved. */
const healthChecks = [
  { key: "failedEvents", route: "/accounting/events" },
  { key: "waitingEvents", route: "/accounting/events" },
  { key: "unpostedJournals", route: "/accounting/journals" },
  { key: "unreconciledMovements", route: "/accounting/reconciliation" },
  { key: "openPeriods", route: "/accounting/fiscal-periods" },
  { key: "activeClosingWorkflows", route: "/accounting/closing-workflows" },
] as const;

/**
 * Presents a server-computed decimal string as an AED amount.
 *
 * ===========================================================================
 * THIS IS TEXT FORMATTING, NOT ARITHMETIC
 * ===========================================================================
 *
 * The digits are regrouped AS TEXT. There is deliberately no `Number()`,
 * `parseFloat` or `Intl.NumberFormat` anywhere in here: a float round-trip can
 * change a money value in the last place, and this file is forbidden from
 * altering one. Every digit the server sent is the digit rendered, in the same
 * order, with the same number of decimal places.
 *
 *   "30000.00" -> "AED 30,000.00"
 *   "-325.00"  -> "AED -325.00"
 *   "0.00"     -> "AED 0.00"
 */
export function formatAed(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return trimmed;
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = "", fraction] = unsigned.split(".");
  // Reject anything that is not a plain decimal rather than mangling it: an
  // unexpected shape is shown exactly as the server sent it.
  if (!/^\d+$/.test(whole)) return trimmed;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimals = fraction === undefined ? "" : `.${fraction}`;
  return `AED ${negative ? "-" : ""}${grouped}${decimals}`;
}

/** A negative amount is coloured, so it is recognised without reading it. */
export function isNegativeAmount(value: string): boolean {
  return value.trim().startsWith("-");
}

/**
 * The banner and the metadata line must never disagree about how many records
 * were left out, so both read the same total off `metadata.coverage` rather
 * than one of them trusting the sentence the API composed.
 */
function excludedRecordCount(coverage: Readonly<Record<string, number>> | null): number {
  return Object.values(coverage ?? {}).reduce((sum, value) => sum + value, 0);
}

/**
 * Which counts are a problem when non-zero, and which are merely a fact.
 *
 * Open Accounting Periods is normal during a live month; a Failed Event is not.
 * Badging every count the same colour would train users to ignore the ones that
 * matter.
 */
const informationalHealthKeys = new Set<string>(["openPeriods", "waitingEvents"]);

export function AccountingDashboardPage({ api }: { readonly api: ApiClient }) {
  const { i18n, t } = useTranslation();
  // The URL is the single source of truth for filters, so a filtered dashboard
  // can be shared, bookmarked and reloaded, and Back restores it exactly.
  const [parameters, setParameters] = useSearchParams();
  const [draft, setDraft] = useState(() => Object.fromEntries(parameters));
  const [data, setData] = useState<DashboardResponse>();
  const [accounts, setAccounts] = useState<readonly AccountOption[]>([]);
  const [parties, setParties] = useState<readonly (readonly [string, string])[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);

  const read = useCallback((key: string) => parameters.get(key) ?? "", [parameters]);

  const queryString = useMemo(() => {
    const next = new URLSearchParams();
    for (const key of filterKeys) {
      const value = read(key);
      if (value !== "") next.set(key, value);
    }
    return next.toString();
  }, [read]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    api
      .get<DashboardResponse>(
        `operations/reports/accounting-dashboard${queryString === "" ? "" : `?${queryString}`}`,
        controller.signal,
      )
      .then((response) => {
        setData(response);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiError ? cause.code : "unknown");
        setLoading(false);
      });
    return () => controller.abort();
  }, [api, queryString, reloadToken]);

  /**
   * Filter options.
   *
   * Both lists come from endpoints that already exist. Accounts come from the
   * authoritative Cash/Bank balances read, which returns exactly the accounts
   * the dashboard can be filtered by; parties come from the Payment Position
   * summary, which guarantees every option resolves to a party that actually
   * has a position. Neither response's amounts are read here.
   *
   * A failure to load OPTIONS never fails the screen: the dashboard itself is
   * the deliverable, and a missing dropdown is a lesser fault than an error
   * page over data that loaded fine.
   */
  useEffect(() => {
    const controller = new AbortController();
    api
      .get<readonly AccountOption[]>(
        "operations/accounting/cash-bank/balances",
        controller.signal,
      )
      .then(setAccounts)
      .catch(() => undefined);
    return () => controller.abort();
  }, [api]);

  const partyTypeFilter = read("partyType");
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ limit: "100" });
    if (partyTypeFilter !== "") query.set("partyType", partyTypeFilter);
    api
      .get<{ readonly items: readonly { partyId: string | null; partyName: string | null }[] }>(
        `operations/reports/payment-position?${query.toString()}`,
        controller.signal,
      )
      .then((response) => {
        const options = new Map<string, string>();
        for (const item of response.items) {
          if (item.partyId !== null) options.set(item.partyId, item.partyName ?? item.partyId);
        }
        setParties([...options].sort((left, right) => left[1].localeCompare(right[1])));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [api, partyTypeFilter]);

  const locale = i18n.resolvedLanguage === "ar" ? "ar-AE" : "en-AE";
  // Amounts, dates, references and ids stay LTR even on an RTL page: a digit
  // group read right-to-left is a different number.
  const money = (value: string | null) =>
    value === null ? (
      "—"
    ) : (
      <bdi
        className={`accounting-amount${isNegativeAmount(value) ? " accounting-amount-negative" : ""}`}
        dir="ltr"
      >
        {formatAed(value)}
      </bdi>
    );
  const day = (value: string | null) =>
    value === null || value === "" ? (
      "—"
    ) : (
      <bdi dir="ltr">{new Date(value).toLocaleDateString(locale)}</bdi>
    );
  const moment = (value: string | null) =>
    value === null || value === "" ? (
      "—"
    ) : (
      <bdi dir="ltr">{new Date(value).toLocaleString(locale)}</bdi>
    );

  /* The API answers with stable enum keys (`cash_bank_movements_only`) and
     English prose. Both were rendered raw, so an Arabic reader met a snake_case
     identifier and an English sentence. The keys are unchanged — other services
     match on them — and only the presentation is localised, with the API's own
     value kept as the i18next fallback so an unrecognised key still reads as
     something rather than as a missing translation. */
  const basisLabel = (key: string) =>
    t(`accountingDashboard.metadata.basis.${key}`, { defaultValue: key });
  const scopeNote = (key: string, fallback: string) =>
    t(`accountingDashboard.metadata.scopeNotes.${key}`, { defaultValue: fallback });

  const commit = (next: Readonly<Record<string, string>>) => {
    const updated = new URLSearchParams(parameters);
    for (const [key, value] of Object.entries(next)) {
      if (value === "") updated.delete(key);
      else updated.set(key, value);
    }
    setParameters(updated, { replace: true });
  };
  const apply = () => commit(Object.fromEntries(filterKeys.map((key) => [key, draft[key] ?? ""])));
  const clear = () => {
    setDraft({});
    setParameters(new URLSearchParams(), { replace: true });
  };
  const field = (key: string) => draft[key] ?? read(key);

  /**
   * A Payment Position link carrying the filters this dashboard is showing.
   *
   * Only filters that screen actually supports are forwarded; `accountId` is
   * not one of them and is deliberately dropped rather than sent to be ignored.
   */
  const positionHref = (direction: "payable" | "receivable", overdueOnly: boolean) => {
    const query = new URLSearchParams({ direction });
    for (const key of ["dateFrom", "dateTo", "partyType", "partyId"] as const) {
      const value = read(key);
      if (value !== "") query.set(key, value);
    }
    if (overdueOnly) query.set("overdueOnly", "true");
    return `/accounting/payment-position?${query.toString()}`;
  };

  const profitAndLossHref = () => {
    const query = new URLSearchParams();
    for (const key of ["dateFrom", "dateTo"] as const) {
      const value = read(key);
      if (value !== "") query.set(key, value);
    }
    const encoded = query.toString();
    return `/accounting/reports/profit-and-loss${encoded === "" ? "" : `?${encoded}`}`;
  };

  const appliedFilters = useMemo(() => {
    if (data === undefined) return [];
    const accountName = (id: string) => {
      const match = accounts.find((account) => account.id === id);
      return match === undefined ? id : (match.name ?? match.code ?? id);
    };
    const partyName = (id: string) => parties.find(([value]) => value === id)?.[1] ?? id;
    const entries: (readonly [string, string])[] = [];
    if (data.filters.dateFrom !== null) entries.push(["dateFrom", data.filters.dateFrom]);
    if (data.filters.dateTo !== null) entries.push(["dateTo", data.filters.dateTo]);
    if (data.filters.accountId !== null) {
      entries.push(["accountId", accountName(data.filters.accountId)]);
    }
    if (data.filters.partyType !== null) {
      entries.push(["partyType", t(`paymentPosition.partyTypes.${data.filters.partyType}`)]);
    }
    if (data.filters.partyId !== null) entries.push(["partyId", partyName(data.filters.partyId)]);
    return entries;
  }, [accounts, data, parties, t]);

  return (
    <div className="accounting-page accounting-dashboard">
      <PageHeader
        actions={
          <button
            className="button button-secondary"
            onClick={() => setReloadToken((current) => current + 1)}
            type="button"
          >
            {t("common.refresh")}
          </button>
        }
        description={t("accountingDashboard.subtitle")}
        eyebrow={t("accounting.title")}
        title={t("accountingDashboard.title")}
      />
      {data === undefined ? null : (
        <p className="accounting-dashboard-asof">
          {t("accountingDashboard.generatedAt")}{" "}
          <bdi dir="ltr">{new Date(data.generatedAt).toLocaleString()}</bdi>
        </p>
      )}

      <form
        className="accounting-filters"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label>
          {t("accountingDashboard.filters.dateFrom")}
          <input
            dir="ltr"
            onChange={(event) => setDraft({ ...draft, dateFrom: event.target.value })}
            type="date"
            value={field("dateFrom")}
          />
        </label>
        <label>
          {t("accountingDashboard.filters.dateTo")}
          <input
            dir="ltr"
            onChange={(event) => setDraft({ ...draft, dateTo: event.target.value })}
            type="date"
            value={field("dateTo")}
          />
        </label>
        <label>
          {t("accountingDashboard.filters.account")}
          <select
            onChange={(event) => setDraft({ ...draft, accountId: event.target.value })}
            value={field("accountId")}
          >
            <option value="">{t("common.all")}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {`${t(`accountingDashboard.accountKinds.${account.kind}`)} — ${
                  account.name ?? account.code ?? account.id
                }`}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("accountingDashboard.filters.partyType")}
          <select
            onChange={(event) => setDraft({ ...draft, partyId: "", partyType: event.target.value })}
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
          {t("accountingDashboard.filters.party")}
          <select
            onChange={(event) => setDraft({ ...draft, partyId: event.target.value })}
            value={field("partyId")}
          >
            <option value="">{t("common.all")}</option>
            {parties.map(([id, name]) => (
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
        </div>
      </form>

      <LoadPanel
        error={error}
        loading={loading}
        onRefresh={() => setReloadToken((current) => current + 1)}
      >
        {data === undefined ? null : (
          <>
            {/* ---------------------------------------------------------------
                Cash and Bank. The limitation note is the backend's own words:
                the period figure is Movement Activity, not a balance change.
                --------------------------------------------------------------- */}
            <h3>{t("accountingDashboard.sections.cashAndBank")}</h3>
            <div className="alert alert-info" role="status">
              {t("accountingDashboard.movementLimitation")}
              {data.metadata.movementScopeNote === "" ? null : (
                <>
                  {" "}
                  {scopeNote(data.metadata.movementScope, data.metadata.movementScopeNote)}
                </>
              )}
            </div>
            {data.metadata.coverageIncomplete && data.metadata.coverageNote !== null ? (
              /* The excluded records are NOT part of the balances above, and the
                 banner says so rather than implying a rounding difference. No
                 dismiss control: no dismissal persistence exists, so a dismissed
                 warning would silently return on the next load. */
              <div className="accounting-dashboard-warning" role="status">
                <span aria-hidden="true" className="accounting-dashboard-warning-icon">
                  !
                </span>
                <div>
                  <strong>{t("accountingDashboard.coverageHeading")}</strong>
                  <p>{t("accountingDashboard.coverageWarning")}</p>
                  <p className="accounting-dashboard-warning-count">
                    {t("accountingDashboard.coverageExcluded", {
                      count: excludedRecordCount(data.metadata.coverage),
                    })}
                  </p>
                </div>
              </div>
            ) : null}
            <div className="accounting-summary-cards accounting-kpi-grid">
              {/* The icon is decorative and marked aria-hidden: the label
                  beside it already names the figure, so a screen reader must
                  not hear it twice. */}
              <div className="accounting-summary-card accounting-kpi-card acc-tone-blue">
                <span className="accounting-kpi-icon" aria-hidden="true">
                  <Wallet size={18} />
                </span>
                <span>{t("accountingDashboard.cashAndBank.currentCashBalance")}</span>
                <strong>{money(data.sections.cashAndBank.currentCashBalance)}</strong>
                <small>
                  {t("accountingDashboard.cashAndBank.accountCount", {
                    count: data.sections.cashAndBank.cashAccountCount,
                  })}
                </small>
              </div>
              <div className="accounting-summary-card accounting-kpi-card acc-tone-indigo">
                <span className="accounting-kpi-icon" aria-hidden="true">
                  <Landmark size={18} />
                </span>
                <span>{t("accountingDashboard.cashAndBank.currentBankBalance")}</span>
                <strong>{money(data.sections.cashAndBank.currentBankBalance)}</strong>
                <small>
                  {t("accountingDashboard.cashAndBank.accountCount", {
                    count: data.sections.cashAndBank.bankAccountCount,
                  })}
                </small>
              </div>
              <div className="accounting-summary-card accounting-kpi-card acc-tone-purple">
                <span className="accounting-kpi-icon" aria-hidden="true">
                  <ArrowLeftRight size={18} />
                </span>
                <span>{t("accountingDashboard.cashAndBank.netCashMovement")}</span>
                <strong>{money(data.sections.cashAndBank.netCashMovement)}</strong>
                <small>{t("accountingDashboard.cashAndBank.movementScope")}</small>
              </div>
              <div className="accounting-summary-card accounting-kpi-card acc-tone-slate">
                <span className="accounting-kpi-icon" aria-hidden="true">
                  <ArrowLeftRight size={18} />
                </span>
                <span>{t("accountingDashboard.cashAndBank.netBankMovement")}</span>
                <strong>{money(data.sections.cashAndBank.netBankMovement)}</strong>
                <small>{t("accountingDashboard.cashAndBank.movementScope")}</small>
              </div>
            </div>
            {data.metadata.coverage === null ? null : (
              <section className="accounting-dashboard-card">
                <header>
                  <h4>{t("accountingDashboard.coverage.title")}</h4>
                  <p>{t("accountingDashboard.coverage.subtitle")}</p>
                </header>
                <div className="table-scroll-x">
                  <table className="data-table accounting-table">
                    <thead>
                      <tr>
                        <th>{t("accountingDashboard.coverage.source")}</th>
                        <th className="accounting-numeric-column">
                          {t("accountingDashboard.coverage.count")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(data.metadata.coverage).map(([source, count]) => (
                        <tr key={source}>
                          {/* The backend key stays the backend's; only the
                              PRESENTATION is translated, so a raw identifier
                              such as `payrollPaymentsWithoutCashAccount` never
                              reaches a Finance user. An unmapped key falls back
                              to itself rather than rendering blank. */}
                          <td>{t(`accountingDashboard.coverage.sources.${source}`, source)}</td>
                          <td className="accounting-numeric-column">
                            <bdi dir="ltr">{count}</bdi>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* ---------------------------------------------------------------
                Money Position. Collect and Pay are shown as separate positive
                amounts and are never netted: a Company owed 10,000 and owing
                10,000 is not in a zero position.
                --------------------------------------------------------------- */}
            <h3>{t("accountingDashboard.sections.moneyPosition")}</h3>
            <div className="accounting-summary-cards accounting-position-grid">
              <div className="accounting-summary-card accounting-kpi-card acc-tone-blue">
                <span className="accounting-kpi-icon" aria-hidden="true">
                  <TrendingUp size={18} />
                </span>
                <span>{t("accountingDashboard.moneyPosition.outstandingToCollect")}</span>
                <strong>{money(data.sections.moneyPosition.outstandingToCollect)}</strong>
                <Link to={positionHref("receivable", false)}>
                  {t("accountingDashboard.links.paymentPosition")}
                </Link>
              </div>
              <div className="accounting-summary-card accounting-kpi-card acc-tone-slate">
                <span className="accounting-kpi-icon" aria-hidden="true">
                  <TrendingDown size={18} />
                </span>
                <span>{t("accountingDashboard.moneyPosition.outstandingToPay")}</span>
                <strong>{money(data.sections.moneyPosition.outstandingToPay)}</strong>
                <Link to={positionHref("payable", false)}>
                  {t("accountingDashboard.links.paymentPosition")}
                </Link>
              </div>
              {/* Overdue is a problem state, so it carries the danger tone. It
                  also says so in words, never by colour alone. */}
              <div className="accounting-summary-card accounting-kpi-card acc-tone-danger">
                <span className="accounting-kpi-icon" aria-hidden="true">
                  <AlertTriangle size={18} />
                </span>
                <span>{t("accountingDashboard.moneyPosition.overdueReceivables")}</span>
                <strong>{money(data.sections.moneyPosition.overdueReceivables)}</strong>
                <Link to={positionHref("receivable", true)}>
                  {t("accountingDashboard.links.paymentPosition")}
                </Link>
              </div>
              <div className="accounting-summary-card accounting-kpi-card acc-tone-danger">
                <span className="accounting-kpi-icon" aria-hidden="true">
                  <AlertTriangle size={18} />
                </span>
                <span>{t("accountingDashboard.moneyPosition.overduePayables")}</span>
                <strong>{money(data.sections.moneyPosition.overduePayables)}</strong>
                <Link to={positionHref("payable", true)}>
                  {t("accountingDashboard.links.paymentPosition")}
                </Link>
              </div>
            </div>

            {/* ---------------------------------------------------------------
                Income and Expense. These are recognised Revenue and Expenses
                from posted Journals -- NOT collections and payments. The two
                are never merged, here or on the backend.
                --------------------------------------------------------------- */}
            <h3>{t("accountingDashboard.sections.incomeAndExpense")}</h3>
            <div className="alert alert-info" role="status">
              {t("accountingDashboard.incomeBasis")}
            </div>
            <div className="accounting-summary-cards accounting-income-grid">
              <div className="accounting-summary-card accounting-kpi-card acc-tone-success">
                <span className="accounting-kpi-icon" aria-hidden="true">
                  <TrendingUp size={18} />
                </span>
                <span>{t("accountingDashboard.incomeAndExpense.revenue")}</span>
                <strong>{money(data.sections.incomeAndExpense.revenue)}</strong>
                <Link to={profitAndLossHref()}>
                  {t("accountingDashboard.links.profitAndLoss")}
                </Link>
              </div>
              <div className="accounting-summary-card accounting-kpi-card acc-tone-warning">
                <span className="accounting-kpi-icon" aria-hidden="true">
                  <TrendingDown size={18} />
                </span>
                <span>{t("accountingDashboard.incomeAndExpense.expenses")}</span>
                <strong>{money(data.sections.incomeAndExpense.expenses)}</strong>
                <Link to={profitAndLossHref()}>
                  {t("accountingDashboard.links.profitAndLoss")}
                </Link>
              </div>
              {/* Net Income takes its tone from its own SIGN: a loss must not
                  be painted in the same colour as a profit. */}
              <div
                className={`accounting-summary-card accounting-kpi-card ${
                  isNegativeAmount(data.sections.incomeAndExpense.netIncome)
                    ? "acc-tone-danger"
                    : "acc-tone-blue"
                }`}
              >
                <span className="accounting-kpi-icon" aria-hidden="true">
                  <Wallet size={18} />
                </span>
                <span>{t("accountingDashboard.incomeAndExpense.netIncome")}</span>
                <strong>{money(data.sections.incomeAndExpense.netIncome)}</strong>
                <Link to={profitAndLossHref()}>
                  {t("accountingDashboard.links.profitAndLoss")}
                </Link>
              </div>
            </div>

            {/* ---------------------------------------------------------------
                Accounting Health. Each count links to the screen that resolves
                it -- a number nobody can act on is not a control.
                --------------------------------------------------------------- */}
            <h3>{t("accountingDashboard.sections.accountingHealth")}</h3>
            <div className="accounting-summary-cards accounting-health-grid">
              {healthChecks.map((check) => {
                const count = data.sections.accountingHealth[check.key];
                /* Three states, not two.

                   Open Periods and Closing Workflows are INFORMATIONAL: an
                   open period is the normal condition of the current month,
                   and the previous design painted a green success bar over it
                   as though zero were the healthy answer. Green is now used
                   only where zero genuinely is the healthy answer. */
                const informational = informationalHealthKeys.has(check.key);
                const tone =
                  count === 0 ? "success" : informational ? "info" : "warning";
                const badge =
                  count === 0
                    ? "status-active"
                    : informational
                      ? "status-neutral"
                      : "status-warning";
                /* The state is named in words as well as coloured, so it is
                   never communicated by colour alone. */
                const stateLabel = t(
                  count === 0
                    ? "accountingDashboard.healthState.healthy"
                    : informational
                      ? "accountingDashboard.healthState.information"
                      : "accountingDashboard.healthState.attention",
                );
                const StateIcon =
                  count === 0 ? CheckCircle2 : informational ? Info : AlertTriangle;
                return (
                  <div
                    className={`accounting-summary-card accounting-status-card acc-tone-${tone}`}
                    key={check.key}
                  >
                    <span className="accounting-kpi-icon" aria-hidden="true">
                      <StateIcon size={18} />
                    </span>
                    <span>{t(`accountingDashboard.health.${check.key}`)}</span>
                    <strong>
                      <bdi dir="ltr">{count}</bdi>
                    </strong>
                    <span className={`status-badge ${badge}`}>{stateLabel}</span>
                    <Link to={check.route}>{t("accountingDashboard.links.open")}</Link>
                  </div>
                );
              })}
            </div>

            {/* ---------------------------------------------------------------
                Recent Activity. Links are used only where the backend supplied
                one; a missing source, Event or Journal shows a dash rather than
                a fabricated URL.
                --------------------------------------------------------------- */}
            <h3>{t("accountingDashboard.sections.recentActivity")}</h3>
            <div className="table-scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>{t("accountingDashboard.activity.sourceType")}</th>
                    <th>{t("accountingDashboard.activity.sourceReference")}</th>
                    <th>{t("accountingDashboard.activity.party")}</th>
                    <th>{t("accountingDashboard.activity.amount")}</th>
                    <th>{t("common.status")}</th>
                    <th>{t("accountingDashboard.activity.date")}</th>
                    <th>{t("accountingDashboard.activity.recordedAt")}</th>
                    <th>{t("accountingDashboard.activity.accountingEvent")}</th>
                    <th>{t("accountingDashboard.activity.journal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sections.recentActivity.length === 0 ? (
                    <tr>
                      <td className="empty-state" colSpan={9}>
                        {t("accountingDashboard.empty.activity")}
                      </td>
                    </tr>
                  ) : (
                    data.sections.recentActivity.map((row, index) => {
                      const eventHref = recordRoute("accounting_event", row.accountingEventId);
                      const journalHref = recordRoute("journal", row.journalId);
                      const reference = row.sourceReference ?? "—";
                      return (
                        <tr key={`${row.sourceType}:${row.sourceReference ?? index}`}>
                          <td>
                            {t(`accountingDashboard.sourceTypes.${row.sourceType}`, {
                              defaultValue: row.sourceType,
                            })}
                          </td>
                          <td>
                            {row.route === null || row.sourceReference === null ? (
                              <DirectionalText>{reference}</DirectionalText>
                            ) : (
                              <Link to={row.route}>
                                <DirectionalText>{reference}</DirectionalText>
                              </Link>
                            )}
                          </td>
                          <td>
                            {row.partyName ??
                              (row.partyType === null
                                ? "—"
                                : t(`accountingDashboard.partyTypes.${row.partyType}`, {
                                    defaultValue: row.partyType,
                                  }))}
                          </td>
                          <td>{money(row.amount)}</td>
                          <td>
                            {row.status === null ? (
                              "—"
                            ) : (
                              <span className="status-badge status-neutral">
                                {t(`statuses.${row.status}`, { defaultValue: row.status })}
                              </span>
                            )}
                          </td>
                          <td>{day(row.activityDate)}</td>
                          <td>{moment(row.activityAt)}</td>
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
                              <Link to={journalHref}>{t("paymentPosition.links.journal")}</Link>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* ---------------------------------------------------------------
                Metadata. Everything below is the backend's own answer about
                what it produced and what it could not cover.
                --------------------------------------------------------------- */}
            <h3>{t("accountingDashboard.sections.metadata")}</h3>
            <dl className="accounting-detail-grid">
              <dt>{t("accountingDashboard.metadata.appliedFilters")}</dt>
              <dd>
                {appliedFilters.length === 0
                  ? t("accountingDashboard.metadata.noFilters")
                  : appliedFilters
                      .map(([key, value]) => `${t(`accountingDashboard.filters.${key}`)}: ${value}`)
                      .join(" · ")}
              </dd>
              <dt>{t("accountingDashboard.metadata.timezone")}</dt>
              <dd>
                <DirectionalText>{data.timezone}</DirectionalText>
              </dd>
              <dt>{t("accountingDashboard.metadata.generatedAt")}</dt>
              <dd>{moment(data.generatedAt)}</dd>
              <dt>{t("accountingDashboard.metadata.balanceBasis")}</dt>
              <dd>{basisLabel(data.metadata.balanceBasis)}</dd>
              <dt>{t("accountingDashboard.metadata.movementScope")}</dt>
              <dd>
                {basisLabel(data.metadata.movementScope)} —{" "}
                {scopeNote(data.metadata.movementScope, data.metadata.movementScopeNote)}
              </dd>
              <dt>{t("accountingDashboard.metadata.coverage")}</dt>
              <dd>
                {data.metadata.coverageNote === null
                  ? t("accountingDashboard.metadata.coverageComplete")
                  : t("accountingDashboard.metadata.coverageNote", {
                      count: excludedRecordCount(data.metadata.coverage),
                      defaultValue: data.metadata.coverageNote,
                    })}
              </dd>
            </dl>
          </>
        )}
      </LoadPanel>
    </div>
  );
}
