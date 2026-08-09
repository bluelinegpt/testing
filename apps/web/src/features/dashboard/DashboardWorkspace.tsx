import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import type { OperationsOverview } from "../../api/contracts.js";
import { formatCurrency, formatNumber } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";

export type DashboardDrillDown = "cash" | "drivers" | "orders" | "settlements" | "traders";
type Period = "today" | "yesterday" | "week" | "month" | "custom";

export function DashboardWorkspace({
  api,
  onDrillDown,
}: {
  api: ApiClient;
  onDrillDown: (target: DashboardDrillDown) => void;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const [period, setPeriod] = useState<Period>("month");
  const [customFrom, setCustomFrom] = useState(todayIso());
  const [customTo, setCustomTo] = useState(todayIso());
  const [overview, setOverview] = useState<OperationsOverview>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const range = useMemo(
    () => periodRange(period, customFrom, customTo),
    [customFrom, customTo, period],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const query = new URLSearchParams({ dateFrom: range.from, dateTo: range.to });
      setOverview(await api.get<OperationsOverview>(`operations/overview?${query}`));
    } catch {
      setError(t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [api, range.from, range.to, t]);

  useEffect(() => void load(), [load]);

  const money = (value: string | undefined) => formatCurrency(value ?? "0", "AED", locale);
  const count = (value: number | undefined) => formatNumber(value ?? 0, locale);
  const periodLabel = t(`dashboard.periods.${period}`);
  const currentBalance = t("dashboard.currentBalance");
  const maxStatus = Math.max(1, ...(overview?.deliveryStatuses.map((item) => item.count) ?? [1]));

  return (
    <div className="dashboard-workspace">
      <div className="page-heading dashboard-heading">
        <div>
          <p className="eyebrow">{t("dashboard.area")}</p>
          <h1>{t("dashboard.title")}</h1>
        </div>
        <button
          className="button button-secondary dashboard-refresh"
          onClick={() => void load()}
          type="button"
        >
          {t("common.refresh")}
        </button>
      </div>
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <section aria-label={t("dashboard.periodSelector")} className="period-panel">
        <div className="segmented-control" role="group">
          {(["today", "yesterday", "week", "month", "custom"] as const).map((item) => (
            <button
              aria-pressed={period === item}
              key={item}
              onClick={() => setPeriod(item)}
              type="button"
            >
              {t(`dashboard.periods.${item}`)}
            </button>
          ))}
        </div>
        {period === "custom" ? (
          <div className="custom-range">
            <label className="field compact-field">
              <span>{t("dashboard.from")}</span>
              <input
                max={customTo}
                onChange={(event) => setCustomFrom(event.target.value)}
                type="date"
                value={customFrom}
              />
            </label>
            <label className="field compact-field">
              <span>{t("dashboard.to")}</span>
              <input
                min={customFrom}
                onChange={(event) => setCustomTo(event.target.value)}
                type="date"
                value={customTo}
              />
            </label>
          </div>
        ) : null}
      </section>

      <section aria-label={t("dashboard.metrics")} className="dashboard-metrics">
        <Kpi
          label={t("dashboard.orders")}
          context={periodLabel}
          value={count(overview?.counts.orders)}
          onClick={() => onDrillDown("orders")}
        />
        <Kpi
          label={t("dashboard.activeTraders")}
          context={currentBalance}
          value={count(overview?.counts.activeTraders)}
          onClick={() => onDrillDown("traders")}
        />
        <Kpi
          label={t("dashboard.activeDrivers")}
          context={currentBalance}
          value={count(overview?.counts.activeDrivers)}
          onClick={() => onDrillDown("drivers")}
        />
        <Kpi
          label={t("dashboard.pendingCash")}
          context={currentBalance}
          value={count(overview?.counts.pendingCashOrders)}
          onClick={() => onDrillDown("cash")}
        />
        <Kpi
          label={t("dashboard.unsettled")}
          context={currentBalance}
          value={count(overview?.counts.unsettledTraderOrders)}
          onClick={() => onDrillDown("settlements")}
        />
        <Kpi
          label={t("dashboard.customerDue")}
          context={periodLabel}
          value={money(overview?.financials.customerAmountDue)}
          onClick={() => onDrillDown("orders")}
        />
        <Kpi
          label={t("dashboard.vatAmount")}
          context={periodLabel}
          value={money(overview?.financials.vatAmount)}
        />
        <Kpi
          label={t("dashboard.companyRevenue")}
          context={periodLabel}
          value={money(overview?.financials.companyRevenue)}
        />
        <Kpi
          label={t("dashboard.profit")}
          context={periodLabel}
          value={money(overview?.financials.orderProfit)}
        />
      </section>

      <section className="dashboard-summary-grid">
        <article className="summary-panel summary-panel-wide">
          <div className="summary-heading">
            <h2>{t("dashboard.orderStatus")}</h2>
            <span>{periodLabel}</span>
          </div>
          <div className="status-bars">
            {(overview?.deliveryStatuses ?? []).map((item) => (
              <button
                className="status-bar-row"
                key={item.status}
                onClick={() => onDrillDown("orders")}
                type="button"
              >
                <span>{t(`statuses.${item.status}`)}</span>
                <span className="status-bar-track">
                  <span style={{ width: `${Math.max(6, (item.count / maxStatus) * 100)}%` }} />
                </span>
                <strong>{count(item.count)}</strong>
              </button>
            ))}
            {!loading && (overview?.deliveryStatuses.length ?? 0) === 0 ? (
              <p className="muted">{t("operations.noOrders")}</p>
            ) : null}
          </div>
        </article>
        <Summary
          label={t("dashboard.cashSummary")}
          primary={count(overview?.counts.pendingCashOrders)}
          secondary={t("dashboard.pendingDriverCash")}
          onClick={() => onDrillDown("cash")}
        />
        <Summary
          label={t("dashboard.settlementSummary")}
          primary={money(overview?.financials.traderNetPayable)}
          secondary={t("dashboard.unsettledTraderBalance")}
          onClick={() => onDrillDown("settlements")}
        />
        <Summary
          label={t("dashboard.traderSummary")}
          primary={count(overview?.counts.activeTraders)}
          secondary={t("dashboard.activeTraders")}
          onClick={() => onDrillDown("traders")}
        />
        <Summary
          label={t("dashboard.driverSummary")}
          primary={count(overview?.counts.activeDrivers)}
          secondary={t("dashboard.activeDrivers")}
          onClick={() => onDrillDown("drivers")}
        />
      </section>
      {loading ? (
        <div className="dashboard-loading" aria-live="polite">
          {t("common.loading")}
        </div>
      ) : null}
    </div>
  );
}

function Kpi({
  label,
  context,
  value,
  onClick,
}: {
  label: string;
  context: string;
  value: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{context}</small>
    </>
  );
  return onClick === undefined ? (
    <article className="kpi-card">{content}</article>
  ) : (
    <button
      aria-label={`${label}: ${value}`}
      className="kpi-card kpi-button"
      onClick={onClick}
      type="button"
    >
      {content}
    </button>
  );
}

function Summary({
  label,
  onClick,
  primary,
  secondary,
}: {
  label: string;
  onClick: () => void;
  primary: string;
  secondary: string;
}) {
  return (
    <button className="summary-panel summary-button" onClick={onClick} type="button">
      <span>{label}</span>
      <strong>{primary}</strong>
      <small>{secondary}</small>
    </button>
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function periodRange(
  period: Period,
  customFrom: string,
  customTo: string,
): { from: string; to: string } {
  if (period === "custom") return { from: customFrom, to: customTo };
  const now = new Date();
  const to = isoLocal(now);
  const from = new Date(now);
  if (period === "yesterday") {
    from.setDate(from.getDate() - 1);
    return { from: isoLocal(from), to: isoLocal(from) };
  }
  if (period === "week") from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
  if (period === "month") from.setDate(1);
  return { from: isoLocal(from), to };
}
function isoLocal(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}
