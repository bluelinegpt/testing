import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { formatCurrency, formatDate } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";

/**
 * Daily Operations Summary — read-only management report (§16).
 *
 * Deliberately NOT the Cashbook, the Trial Balance, a P&L, or Payment
 * Position: it answers "how many Orders did each Driver deliver, how much
 * delivery/service income did the Company earn, what operating expenses
 * were paid, and what is the net operational result" for one or more dates.
 * COD is never income; a Trader settlement is never an expense — both are
 * excluded server-side (see `daily-operations-summary.service.ts`).
 *
 * ---------------------------------------------------------------------------
 * DATE MODE
 * ---------------------------------------------------------------------------
 *
 * Every date in this report is read through one of two lenses, chosen by the
 * Date Mode selector -- Business Day (default) or Calendar Day. The SAME
 * `dateFrom`/`dateTo` fields serve both; only their meaning changes, exactly
 * as the backend interprets them (`resolveWindow()` in the service). The
 * active mode travels with every request this screen makes -- the report
 * run, the quick-filter anchor, the drill-down, and every export -- so the
 * screen, the drill-down and the exported PDF/Excel can never disagree about
 * which lens produced a number.
 *
 * Business Day, everywhere the mode is "business_day": the Today/Yesterday/
 * This Week/This Month quick filters resolve against the Company Business
 * Date fetched from the server (`GET .../today`), never the viewer's own
 * local calendar date -- the two disagree for as long as the Business Day
 * cutoff has not yet passed. Calendar Day mode fetches that same endpoint
 * with `dateMode=calendar_day` and gets the viewer's plain Company-local
 * calendar date instead. Either way, once resolved, every quick filter does
 * plain calendar-date-STRING arithmetic on that anchor; it never re-derives
 * a date client-side.
 */

type DateMode = "business_day" | "calendar_day";

interface DriverRow {
  readonly deliveredOrders: number;
  readonly deliveryIncome: string;
  readonly driverCode: string;
  readonly driverId: string;
  readonly driverName: string;
  readonly driverType: "employee" | "outsourced";
}
interface ExpenseRow {
  readonly amount: string;
  readonly businessDate: string;
  readonly calendarDate: string;
  readonly description: string;
  readonly payee: string | null;
  readonly reference: string;
  readonly sourceId: string;
  readonly type: string;
}

interface TraderPaymentRow {
  readonly amount: string;
  readonly businessDate: string;
  readonly calendarDate: string;
  readonly customerName: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly orderSerialNumber: string | null;
  readonly originalAmountDue: string;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly previouslyPaid: string;
  readonly reference: string;
  readonly referenceNumber: string | null;
  readonly settlementId: string;
  readonly settlementNumber: string;
  readonly traderName: string;
}

interface TraderCollectionRow {
  readonly amount: string;
  readonly businessDate: string;
  readonly calendarDate: string;
  readonly collectionId: string;
  readonly collectionNumber: string;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly reference: string;
  readonly traderName: string;
}

interface TraderReceivableDueRow {
  readonly amountCollected: string;
  readonly businessDate: string;
  readonly calendarDate: string;
  readonly orderSerialNumber: string | null;
  readonly originalAmountDue: string;
  readonly outstandingAmount: string;
  readonly reason: string;
  readonly receivableId: string;
  readonly receivableNumber: string;
  readonly sourceReference: string | null;
  readonly traderName: string;
}

interface TraderPayableDueRow {
  readonly businessDate: string;
  readonly calendarDate: string;
  readonly customerName: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly orderSerialNumber: string | null;
  readonly originalAmountDue: string;
  readonly outstandingAmount: string;
  readonly previouslyPaid: string;
  readonly referenceNumber: string | null;
  readonly settlementStatus: string;
  readonly traderName: string;
}

interface DriverOrderRow {
  readonly customerName: string;
  readonly deliveredAt: string;
  readonly deliveryBusinessDate: string | null;
  readonly deliveryCalendarDate: string | null;
  readonly deliveryIncome: string;
  readonly driverName: string;
  readonly id: string;
  readonly orderDate: string;
  readonly orderNumber: string;
  readonly referenceNumber: string | null;
  readonly serialNumber: string | null;
  readonly traderName: string;
}

interface ReportData {
  readonly dateMode: DateMode;
  readonly driverSummary: readonly DriverRow[];
  readonly expenses: readonly ExpenseRow[];
  readonly netResult: string;
  readonly netStatus: "break_even" | "negative" | "positive";
  readonly totalDeliveryIncome: string;
  readonly totalExpenses: string;
  readonly totalOrders: number;
  readonly totalTraderPayments?: string;
  readonly totalTraderCollections?: string;
  readonly totalTraderPayables?: string;
  readonly totalTraderReceivables?: string;
  readonly traderPayables?: readonly TraderPayableDueRow[];
  readonly traderPayments?: readonly TraderPaymentRow[];
  readonly traderCollections?: readonly TraderCollectionRow[];
  readonly traderReceivables?: readonly TraderReceivableDueRow[];
}

/** Where a Reference Number's exact source record lives, reusing the
 *  existing detail screens -- never a duplicate viewer (§6). Returns
 *  `undefined` for a type this report does not yet know how to open. */
export function expenseSourcePath(type: string, sourceId: string): string | undefined {
  switch (type) {
    case "general_expense":
      return `/accounting/general-expenses/${sourceId}`;
    case "driver_collection_expense":
      return `/drivers/collections/${sourceId}`;
    case "outsourced_driver_fee":
      return `/payroll/driver-fees/payments/${sourceId}`;
    case "payroll":
      return `/payroll/payments/${sourceId}`;
    default:
      return undefined;
  }
}

/** The existing Order detail route, keyed by Order Number -- never a
 *  duplicate Order viewer (§5). */
export function orderDetailPath(orderNumber: string): string {
  return `/orders/${encodeURIComponent(orderNumber)}`;
}

/**
 * "1 / 09 Aug 2026 / ORD-0000XX" -- Serial Number, Serial/Order Date, and the
 * permanent Order Number together (§4). A daily Serial Number alone is not
 * globally unique, so it is never shown by itself; an Order never migrated
 * to the prospective financial model has no Serial Number at all, and the
 * identifier falls back to just the date and Order Number.
 */
export function formatOrderIdentifier(
  row: Pick<DriverOrderRow, "orderDate" | "orderNumber" | "serialNumber">,
  locale: "ar" | "en",
): string {
  const date = formatDate(row.orderDate, locale);
  return row.serialNumber === null
    ? `${date} / ${row.orderNumber}`
    : `${row.serialNumber} / ${date} / ${row.orderNumber}`;
}

function parseDateString(date: string): { readonly day: number; readonly month: number; readonly year: number } {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  return { day, month, year };
}

export function normalizeReportDateInput(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (slash === null) return trimmed;
  const month = slash[1]!;
  const day = slash[2]!;
  const year = slash[3]!;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function addDaysToDateString(date: string, offset: number): string {
  const { day, month, year } = parseDateString(date);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + offset);
  return utc.toISOString().slice(0, 10);
}

function startOfWeekFrom(date: string): string {
  const { day, month, year } = parseDateString(date);
  const utc = new Date(Date.UTC(year, month - 1, day));
  // Sunday-start week, matching this app's other weekly quick filters. Same
  // convention in both Date Modes (§7) -- only the anchor date differs.
  utc.setUTCDate(utc.getUTCDate() - utc.getUTCDay());
  return utc.toISOString().slice(0, 10);
}

function startOfMonthFrom(date: string): string {
  const { month, year } = parseDateString(date);
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function previewBlob(blob: Blob, print = false): void {
  const url = URL.createObjectURL(blob);
  const opened = globalThis.open(url, "_blank", "noopener,noreferrer");
  if (print && opened !== null) opened.addEventListener("load", () => opened.print(), { once: true });
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function DailyOperationsSummaryReport({
  api,
  onNavigate,
}: {
  readonly api: ApiClient;
  readonly onNavigate: (path: string) => void;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.language);
  const [dateMode, setDateMode] = useState<DateMode>("business_day");
  const [todayDate, setTodayDate] = useState<string>();
  const [businessDateError, setBusinessDateError] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [report, setReport] = useState<ReportData>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"pdf" | "print" | "xlsx">();
  const [showTraderPayments, setShowTraderPayments] = useState(false);
  const [showTraderCollections, setShowTraderCollections] = useState(false);
  const [showTraderPayables, setShowTraderPayables] = useState(false);
  const [showTraderReceivables, setShowTraderReceivables] = useState(false);
  const [expandedDriverId, setExpandedDriverId] = useState<string>();
  const [driverOrders, setDriverOrders] = useState<readonly DriverOrderRow[]>();
  const [driverOrdersLoading, setDriverOrdersLoading] = useState(false);
  const [driverOrdersError, setDriverOrdersError] = useState<string>();

  // Re-resolved whenever Date Mode changes, so the quick-filter anchor and
  // the Date From/To default always match the active lens (§6).
  useEffect(() => {
    let cancelled = false;
    setTodayDate(undefined);
    api
      .get<{ date: string }>(
        `operations/reports/daily-operations-summary/today?dateMode=${dateMode}`,
      )
      .then((result) => {
        if (cancelled) return;
        setTodayDate(result.date);
        setDateFrom((current) => (current === "" ? result.date : current));
        setDateTo((current) => (current === "" ? result.date : current));
      })
      .catch(() => {
        if (!cancelled) setBusinessDateError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, dateMode]);

  const query = () => {
    const params = new URLSearchParams({
      dateFrom: normalizeReportDateInput(dateFrom),
      dateTo: normalizeReportDateInput(dateTo),
      dateMode,
    });
    if (showTraderPayments) params.set("includeTraderPayments", "true");
    if (showTraderCollections) params.set("includeTraderCollections", "true");
    if (showTraderPayables) params.set("includeTraderPayables", "true");
    if (showTraderReceivables) params.set("includeTraderReceivables", "true");
    return params.toString();
  };

  const changeDateMode = (next: DateMode) => {
    setDateMode(next);
    // A displayed report reflects the mode it was run in; switching modes
    // without re-running must not leave a Business Day report on screen
    // captioned as Calendar Day, or vice versa (§15 -- never mix modes).
    setReport(undefined);
    setExpandedDriverId(undefined);
    setError(undefined);
  };

  const run = async () => {
    setLoading(true);
    setError(undefined);
    setExpandedDriverId(undefined);
    try {
      const result = await api.get<ReportData>(
        `operations/reports/daily-operations-summary?${query()}`,
      );
      setReport(result);
    } catch (cause) {
      setReport(undefined);
      setError(cause instanceof ApiError ? cause.message : t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  const exportReport = async (format: "pdf" | "print" | "xlsx") => {
    setBusy(format);
    setError(undefined);
    try {
      const language = i18n.resolvedLanguage === "ar" ? "ar" : "en";
      const path =
        format === "xlsx"
          ? `operations/reports/daily-operations-summary/excel?${query()}&language=${language}`
          : `operations/reports/daily-operations-summary/pdf?${query()}&language=${language}`;
      const blob = await api.getBinary(path);
      if (format === "xlsx") saveBlob(blob, `Daily-Operations-Summary-${dateFrom}-to-${dateTo}.xlsx`);
      else previewBlob(blob, format === "print");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t("common.loadFailed"));
    } finally {
      setBusy(undefined);
    }
  };

  const setRange = (from: string, to: string) => {
    setDateFrom(from);
    setDateTo(to);
  };

  const toggleDriverOrders = async (driverId: string) => {
    if (expandedDriverId === driverId) {
      setExpandedDriverId(undefined);
      return;
    }
    setExpandedDriverId(driverId);
    setDriverOrders(undefined);
    setDriverOrdersError(undefined);
    setDriverOrdersLoading(true);
    try {
      const rows = await api.get<readonly DriverOrderRow[]>(
        `operations/reports/daily-operations-summary/orders?${query()}&driverId=${driverId}`,
      );
      setDriverOrders(rows);
    } catch (cause) {
      setDriverOrdersError(cause instanceof ApiError ? cause.message : t("common.loadFailed"));
    } finally {
      setDriverOrdersLoading(false);
    }
  };

  // Defensive: a row's money field can arrive null/undefined if a backend
  // column is unexpectedly empty for a given record (observed for a Trader
  // Payment row whose source Order predates the current financial model).
  // Falling back to "0.00" keeps the report on screen instead of crashing
  // the whole page over one row's missing amount.
  const money = (value: string | null | undefined) => formatCurrency(value ?? "0.00", "AED", locale);
  const traderPayments = report?.traderPayments ?? [];
  const totalTraderPayments = report?.totalTraderPayments ?? "0.00";
  const traderCollections = report?.traderCollections ?? [];
  const totalTraderCollections = report?.totalTraderCollections ?? "0.00";
  const traderPayables = report?.traderPayables ?? [];
  const totalTraderPayables = report?.totalTraderPayables ?? "0.00";
  const traderReceivables = report?.traderReceivables ?? [];
  const totalTraderReceivables = report?.totalTraderReceivables ?? "0.00";
const netLabel =
    report === undefined
      ? ""
      : report.netStatus === "positive"
        ? t("reports.dailyOperationsSummary.positive")
        : report.netStatus === "negative"
          ? t("reports.dailyOperationsSummary.negative")
          : t("reports.dailyOperationsSummary.breakEven");
  const dateModeLabel = (mode: DateMode) =>
    mode === "calendar_day"
      ? t("reports.dailyOperationsSummary.calendarDayMode")
      : t("reports.dailyOperationsSummary.businessDayMode");

  return (
    <section className="configuration-surface">
      <header className="page-header">
        <h1>{t("reports.dailyOperationsSummary.title")}</h1>
        {/* Which lens is active must be unmissable, on screen and in every
            export (§13, §16) -- never a raw date left to imply it. */}
        {report === undefined ? null : (
          <p className="page-header-subtitle">
            {t("configuration.businessDay.dateMode")}: {dateModeLabel(report.dateMode)}
          </p>
        )}
      </header>

      {businessDateError ? (
        <div className="alert alert-error" role="alert">
          {t("reports.dailyOperationsSummary.businessDateUnavailable")}
        </div>
      ) : null}

      <div className="report-filter-bar">
        <div className="report-filter-bar__range">
          <label className="field">
            <span>{t("configuration.businessDay.dateMode")}</span>
            <select
              onChange={(event) => changeDateMode(event.target.value as DateMode)}
              value={dateMode}
            >
              <option value="business_day">{t("reports.dailyOperationsSummary.businessDayMode")}</option>
              <option value="calendar_day">{t("reports.dailyOperationsSummary.calendarDayMode")}</option>
            </select>
          </label>
        </div>
        <div className="report-filter-bar__quick">
          <button
            disabled={todayDate === undefined}
            onClick={() => setRange(todayDate!, todayDate!)}
            type="button"
          >
            {t("reports.dailyOperationsSummary.today")}
          </button>
          <button
            disabled={todayDate === undefined}
            onClick={() => {
              const yesterday = addDaysToDateString(todayDate!, -1);
              setRange(yesterday, yesterday);
            }}
            type="button"
          >
            {t("reports.dailyOperationsSummary.yesterday")}
          </button>
          <button
            disabled={todayDate === undefined}
            onClick={() => setRange(startOfWeekFrom(todayDate!), todayDate!)}
            type="button"
          >
            {t("reports.dailyOperationsSummary.thisWeek")}
          </button>
          <button
            disabled={todayDate === undefined}
            onClick={() => setRange(startOfMonthFrom(todayDate!), todayDate!)}
            type="button"
          >
            {t("reports.dailyOperationsSummary.thisMonth")}
          </button>
        </div>
        <div className="report-filter-bar__range">
          <label className="field">
            <span>{t("reports.dailyOperationsSummary.dateFrom")}</span>
            <input
              onChange={(event) => setDateFrom(event.target.value)}
              required
              type="date"
              value={dateFrom}
            />
          </label>
          <label className="field">
            <span>{t("reports.dailyOperationsSummary.dateTo")}</span>
            <input
              onChange={(event) => setDateTo(event.target.value)}
              required
              type="date"
              value={dateTo}
            />
          </label>
          <label className="field field-checkbox">
            <input
              checked={showTraderPayments}
              onChange={(event) => setShowTraderPayments(event.target.checked)}
              type="checkbox"
            />
            <span>{t("reports.dailyOperationsSummary.showTraderPayments")}</span>
          </label>
          <label className="field field-checkbox">
            <input
              checked={showTraderCollections}
              onChange={(event) => setShowTraderCollections(event.target.checked)}
              type="checkbox"
            />
            <span>{t("reports.dailyOperationsSummary.showTraderCollections")}</span>
          </label>
          <label className="field field-checkbox">
            <input
              checked={showTraderReceivables}
              onChange={(event) => setShowTraderReceivables(event.target.checked)}
              type="checkbox"
            />
            <span>{t("reports.dailyOperationsSummary.showMoneyToCollectFromTraders")}</span>
          </label>
          <label className="field field-checkbox">
            <input
              checked={showTraderPayables}
              onChange={(event) => setShowTraderPayables(event.target.checked)}
              type="checkbox"
            />
            <span>{t("reports.dailyOperationsSummary.showMoneyToPayToTraders")}</span>
          </label>
          <button
            className="button button-primary"
            disabled={loading || dateFrom === "" || dateTo === "" || dateTo < dateFrom}
            onClick={() => void run()}
            type="button"
          >
            {loading ? t("common.loading") : t("reports.dailyOperationsSummary.runReport")}
          </button>
        </div>
      </div>

      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {report === undefined ? null : (
        <>
          <div className="heading-actions">
            <button disabled={busy !== undefined} onClick={() => void exportReport("pdf")} type="button">
              {busy === "pdf" ? t("common.loading") : t("reports.dailyOperationsSummary.previewPdf")}
            </button>
            <button
              disabled={busy !== undefined}
              onClick={() => void exportReport("print")}
              type="button"
            >
              {busy === "print" ? t("common.loading") : t("common.print")}
            </button>
            <button
              disabled={busy !== undefined}
              onClick={() => void exportReport("xlsx")}
              type="button"
            >
              {busy === "xlsx" ? t("common.loading") : t("reports.dailyOperationsSummary.downloadExcel")}
            </button>
          </div>

          <section className="detail-section">
            <h2>{t("reports.dailyOperationsSummary.driverSummary")}</h2>
            <div className="table-frame">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("operations.driver")}</th>
                    <th>{t("operations.driverCode")}</th>
                    <th>{t("reports.dailyOperationsSummary.deliveredOrders")}</th>
                    <th>{t("reports.dailyOperationsSummary.deliveryIncome")}</th>
                    <th aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  {report.driverSummary.length === 0 ? (
                    <tr>
                      <td colSpan={5}>{t("reports.dailyOperationsSummary.noData")}</td>
                    </tr>
                  ) : (
                    report.driverSummary.map((row) => (
                      <Fragment key={row.driverId}>
                        <tr>
                          <td>{row.driverName}</td>
                          <td>{row.driverCode}</td>
                          <td>{row.deliveredOrders}</td>
                          <td>{money(row.deliveryIncome)}</td>
                          <td>
                            <button onClick={() => void toggleDriverOrders(row.driverId)} type="button">
                              {expandedDriverId === row.driverId
                                ? t("reports.dailyOperationsSummary.hideOrders")
                                : t("reports.dailyOperationsSummary.viewOrders")}
                            </button>
                          </td>
                        </tr>
                        {expandedDriverId === row.driverId ? (
                          <tr>
                            <td colSpan={5}>
                              <DriverOrdersDrillDown
                                error={driverOrdersError}
                                loading={driverOrdersLoading}
                                locale={locale}
                                money={money}
                                onNavigate={onNavigate}
                                orders={driverOrders}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    ))
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>
                      <strong>{t("reports.dailyOperationsSummary.grandTotal")}</strong>
                    </td>
                    <td>
                      <strong>{report.totalOrders}</strong>
                    </td>
                    <td>
                      <strong>{money(report.totalDeliveryIncome)}</strong>
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <section className="detail-section">
            <h2>{t("reports.dailyOperationsSummary.expensesAndPayments")}</h2>
            <div className="table-frame">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("configuration.businessDay.businessDate")}</th>
                    <th>{t("configuration.businessDay.calendarDate")}</th>
                    <th>{t("reports.dailyOperationsSummary.expenseType")}</th>
                    <th>{t("operations.description")}</th>
                    <th>{t("reports.dailyOperationsSummary.payee")}</th>
                    <th>{t("operations.referenceNumber")}</th>
                    <th>{t("operations.amount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.expenses.length === 0 ? (
                    <tr>
                      <td colSpan={7}>{t("reports.dailyOperationsSummary.noData")}</td>
                    </tr>
                  ) : (
                    report.expenses.map((row, index) => {
                      const path = expenseSourcePath(row.type, row.sourceId);
                      return (
                        <tr key={`${row.reference}-${index}`}>
                          <td>{row.businessDate}</td>
                          <td>{row.calendarDate}</td>
                          <td>{row.type}</td>
                          <td>{row.description}</td>
                          <td>{row.payee ?? "—"}</td>
                          <td>
                            {path === undefined ? (
                              row.reference
                            ) : (
                              <button
                                className="link-button"
                                onClick={() => onNavigate(path)}
                                type="button"
                              >
                                {row.reference}
                              </button>
                            )}
                          </td>
                          <td>{money(row.amount)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={6}>
                      <strong>{t("reports.dailyOperationsSummary.totalExpenses")}</strong>
                    </td>
                    <td>
                      <strong>{money(report.totalExpenses)}</strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {showTraderReceivables ? (
            <section className="detail-section">
              <h2>{t("reports.dailyOperationsSummary.moneyToCollectFromTraders")}</h2>
              <p className="muted-text">{t("reports.dailyOperationsSummary.moneyToCollectFromTradersHelp")}</p>
              <div className="table-frame">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t("configuration.businessDay.businessDate")}</th>
                      <th>{t("configuration.businessDay.calendarDate")}</th>
                      <th>{t("operations.trader")}</th>
                      <th>{t("traderReceivables.columnReceivableNumber")}</th>
                      <th>{t("orders.serialNumber")}</th>
                      <th>{t("traderReceivables.columnSourceReference")}</th>
                      <th>{t("traderReceivables.columnOriginalAmountDue")}</th>
                      <th>{t("traderReceivables.columnPreviouslyCollected")}</th>
                      <th>{t("traderReceivables.columnOutstandingAmount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traderReceivables.length === 0 ? (
                      <tr>
                        <td colSpan={9}>{t("reports.dailyOperationsSummary.noData")}</td>
                      </tr>
                    ) : (
                      traderReceivables.map((row) => (
                        <tr key={row.receivableId}>
                          <td>{row.businessDate}</td>
                          <td>{row.calendarDate}</td>
                          <td>{row.traderName}</td>
                          <td>
                            <button
                              className="link-button"
                              onClick={() => onNavigate(`/trader-receivables/${row.receivableId}`)}
                              type="button"
                            >
                              {row.receivableNumber}
                            </button>
                          </td>
                          <td>{row.orderSerialNumber ?? "—"}</td>
                          <td>{row.sourceReference ?? "—"}</td>
                          <td>{money(row.originalAmountDue)}</td>
                          <td>{money(row.amountCollected)}</td>
                          <td>{money(row.outstandingAmount)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={8}>
                        <strong>{t("reports.dailyOperationsSummary.totalMoneyToCollectFromTraders")}</strong>
                      </td>
                      <td>
                        <strong>{money(totalTraderReceivables)}</strong>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          ) : null}
          {showTraderPayables ? (
            <section className="detail-section">
              <h2>{t("reports.dailyOperationsSummary.moneyToPayToTraders")}</h2>
              <p className="muted-text">{t("reports.dailyOperationsSummary.moneyToPayToTradersHelp")}</p>
              <div className="table-frame">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t("configuration.businessDay.businessDate")}</th>
                      <th>{t("configuration.businessDay.calendarDate")}</th>
                      <th>{t("operations.trader")}</th>
                      <th>{t("orders.serialNumber")}</th>
                      <th>{t("operations.referenceNumber")}</th>
                      <th>{t("operations.customer")}</th>
                      <th>{t("traderReceivables.columnOriginalAmountDue")}</th>
                      <th>{t("reports.dailyOperationsSummary.previouslyPaid")}</th>
                      <th>{t("reports.dailyOperationsSummary.amountToPay")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traderPayables.length === 0 ? (
                      <tr>
                        <td colSpan={9}>{t("reports.dailyOperationsSummary.noData")}</td>
                      </tr>
                    ) : (
                      traderPayables.map((row) => (
                        <tr key={row.orderId}>
                          <td>{row.businessDate}</td>
                          <td>{row.calendarDate}</td>
                          <td>{row.traderName}</td>
                          <td>
                            <button
                              className="link-button"
                              onClick={() => onNavigate(orderDetailPath(row.orderNumber))}
                              type="button"
                            >
                              {row.orderSerialNumber ?? row.orderNumber}
                            </button>
                          </td>
                          <td>{row.referenceNumber ?? "—"}</td>
                          <td>{row.customerName}</td>
                          <td>{money(row.originalAmountDue)}</td>
                          <td>{money(row.previouslyPaid)}</td>
                          <td>{money(row.outstandingAmount)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={8}>
                        <strong>{t("reports.dailyOperationsSummary.totalMoneyToPayToTraders")}</strong>
                      </td>
                      <td>
                        <strong>{money(totalTraderPayables)}</strong>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          ) : null}
          {showTraderPayments ? (
            <section className="detail-section">
              <h2>{t("reports.dailyOperationsSummary.traderPayments")}</h2>
              <p className="muted-text">{t("reports.dailyOperationsSummary.traderPaymentsHelp")}</p>
              <div className="table-frame">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t("configuration.businessDay.businessDate")}</th>
                      <th>{t("configuration.businessDay.calendarDate")}</th>
                      <th>{t("operations.trader")}</th>
                      <th>{t("orders.serialNumber")}</th>
                      <th>{t("operations.referenceNumber")}</th>
                      <th>{t("operations.customer")}</th>
                      <th>{t("traderReceivables.columnOriginalAmountDue")}</th>
                      <th>{t("reports.dailyOperationsSummary.previouslyPaid")}</th>
                      <th>{t("operations.amount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traderPayments.length === 0 ? (
                      <tr>
                        <td colSpan={9}>{t("reports.dailyOperationsSummary.noData")}</td>
                      </tr>
                    ) : (
                      traderPayments.map((row) => (
                        <tr key={`${row.settlementId}-${row.orderId}`}>
                          <td>{row.businessDate}</td>
                          <td>{row.calendarDate}</td>
                          <td>{row.traderName}</td>
                          <td>
                            <button
                              className="link-button"
                              onClick={() => onNavigate(orderDetailPath(row.orderNumber))}
                              type="button"
                            >
                              {row.orderSerialNumber ?? row.orderNumber}
                            </button>
                          </td>
                          <td>
                            {row.referenceNumber ? (
                              <button
                                className="link-button"
                                onClick={() => onNavigate(`/trader-settlements/${row.settlementId}`)}
                                type="button"
                              >
                                {row.referenceNumber}
                              </button>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>{row.customerName}</td>
                          <td>{money(row.originalAmountDue)}</td>
                          <td>{money(row.previouslyPaid)}</td>
                          <td>{money(row.amount)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={8}>
                        <strong>{t("reports.dailyOperationsSummary.totalTraderPayments")}</strong>
                      </td>
                      <td>
                        <strong>{money(totalTraderPayments)}</strong>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          ) : null}
          {showTraderCollections ? (
            <section className="detail-section">
              <h2>{t("reports.dailyOperationsSummary.traderCollections")}</h2>
              <p className="muted-text">{t("reports.dailyOperationsSummary.traderCollectionsHelp")}</p>
              <div className="table-frame">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t("configuration.businessDay.businessDate")}</th>
                      <th>{t("configuration.businessDay.calendarDate")}</th>
                      <th>{t("operations.trader")}</th>
                      <th>{t("traderSettlements.columnPaymentReference")}</th>
                      <th>{t("traderSettlements.filterPaymentMethod")}</th>
                      <th>{t("operations.amount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traderCollections.length === 0 ? (
                      <tr>
                        <td colSpan={6}>{t("reports.dailyOperationsSummary.noData")}</td>
                      </tr>
                    ) : (
                      traderCollections.map((row) => (
                        <tr key={row.collectionId}>
                          <td>{row.businessDate}</td>
                          <td>{row.calendarDate}</td>
                          <td>{row.traderName}</td>
                          <td>
                            <button
                              className="link-button"
                              onClick={() => onNavigate(`/trader-receivables/collections/${row.collectionId}`)}
                              type="button"
                            >
                              {row.collectionNumber}
                            </button>
                          </td>
                          <td>
                            {row.paymentMethod === "cash"
                              ? t("traderSettlements.paymentMethodCash")
                              : t("traderSettlements.paymentMethodBankTransfer")}
                          </td>
                          <td>{money(row.amount)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={5}>
                        <strong>{t("reports.dailyOperationsSummary.totalTraderCollections")}</strong>
                      </td>
                      <td>
                        <strong>{money(totalTraderCollections)}</strong>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          ) : null}

          <section className="detail-section">
            <h2>{t("reports.dailyOperationsSummary.summary")}</h2>
            <dl className="detail-grid">
              <div className="detail-line">
                <dt>{t("reports.dailyOperationsSummary.totalDeliveredOrders")}</dt>
                <dd>{report.totalOrders}</dd>
              </div>
              <div className="detail-line">
                <dt>{t("reports.dailyOperationsSummary.deliveryIncome")}</dt>
                <dd>{money(report.totalDeliveryIncome)}</dd>
              </div>
              <div className="detail-line">
                <dt>{t("reports.dailyOperationsSummary.totalExpenses")}</dt>
                <dd>{money(report.totalExpenses)}</dd>
              </div>
              {showTraderReceivables ? (
                <div className="detail-line">
                  <dt>{t("reports.dailyOperationsSummary.totalMoneyToCollectFromTraders")}</dt>
                  <dd>{money(totalTraderReceivables)}</dd>
                </div>
              ) : null}
              {showTraderPayables ? (
                <div className="detail-line">
                  <dt>{t("reports.dailyOperationsSummary.totalMoneyToPayToTraders")}</dt>
                  <dd>{money(totalTraderPayables)}</dd>
                </div>
              ) : null}
              <div className="detail-line">
                <dt>{t("reports.dailyOperationsSummary.netResult")}</dt>
                <dd
                  className={
                    report.netStatus === "positive"
                      ? "summary-positive"
                      : report.netStatus === "negative"
                        ? "summary-negative"
                        : undefined
                  }
                >
                  {Number(report.netResult) > 0 ? "+" : ""}
                  {money(report.netResult)}
                </dd>
              </div>
              <div className="detail-line">
                <dt>{t("common.status")}</dt>
                <dd>{netLabel}</dd>
              </div>
            </dl>
          </section>
        </>
      )}
    </section>
  );
}

function DriverOrdersDrillDown({
  error,
  loading,
  locale,
  money,
  onNavigate,
  orders,
}: {
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly locale: "ar" | "en";
  readonly money: (value: string) => string;
  readonly onNavigate: (path: string) => void;
  readonly orders: readonly DriverOrderRow[] | undefined;
}) {
  const { t } = useTranslation();
  if (loading) return <p>{t("common.loading")}</p>;
  if (error !== undefined)
    return (
      <div className="alert alert-error" role="alert">
        {error}
      </div>
    );
  if (orders === undefined || orders.length === 0)
    return <p>{t("reports.dailyOperationsSummary.noData")}</p>;

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>{t("reports.dailyOperationsSummary.orderIdentifier")}</th>
          <th>{t("operations.referenceNumber")}</th>
          <th>{t("operations.driver")}</th>
          <th>{t("operations.trader")}</th>
          <th>{t("operations.customer")}</th>
          <th>{t("reports.dailyOperationsSummary.deliveryIncome")}</th>
          <th>{t("configuration.businessDay.businessDate")}</th>
          <th>{t("configuration.businessDay.calendarDate")}</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((row) => (
          <tr key={row.id}>
            <td>
              <button
                className="link-button"
                onClick={() => onNavigate(orderDetailPath(row.orderNumber))}
                type="button"
              >
                {formatOrderIdentifier(row, locale)}
              </button>
            </td>
            <td>{row.referenceNumber ?? "—"}</td>
            <td>{row.driverName}</td>
            <td>{row.traderName}</td>
            <td>{row.customerName}</td>
            <td>{money(row.deliveryIncome)}</td>
            <td>{row.deliveryBusinessDate ?? "—"}</td>
            <td>{row.deliveryCalendarDate ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
