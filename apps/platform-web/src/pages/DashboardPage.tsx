import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  platformApi,
  type CompanyOverviewPage,
  type CompanyOverviewRow,
  type CompanyPage,
  type CompanyRankingItem,
  type DashboardChange,
  type DashboardSummary,
  type Distribution,
  type NeedsAttention,
  type OrdersTrend,
  PlatformApiError,
} from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";

// ---------------------------------------------------------------------------
// Date range presets
// ---------------------------------------------------------------------------

type Preset = "today" | "yesterday" | "last7" | "last30" | "thisMonth" | "lastMonth" | "thisYear" | "custom";

const presetOptions: readonly { value: Preset; label: string }[] = [
  { label: "Today", value: "today" },
  { label: "Yesterday", value: "yesterday" },
  { label: "Last 7 Days", value: "last7" },
  { label: "Last 30 Days", value: "last30" },
  { label: "This Month", value: "thisMonth" },
  { label: "Last Month", value: "lastMonth" },
  { label: "This Year", value: "thisYear" },
  { label: "Custom", value: "custom" },
];

/** Matches the API's own `Asia/Dubai` calendar rule — see `platform-dashboard.service.ts`. */
function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Dubai",
    year: "numeric",
  }).format(new Date());
}

function addDaysIso(iso: string, delta: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year as number, (month as number) - 1, day as number));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function presetRange(preset: Preset, customFrom: string, customTo: string): { from: string; to: string } {
  const today = todayIso();
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const yesterday = addDaysIso(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case "last7":
      return { from: addDaysIso(today, -6), to: today };
    case "last30":
      return { from: addDaysIso(today, -29), to: today };
    case "thisMonth":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "lastMonth": {
      const [year, month] = today.split("-").map(Number);
      const lastMonthEnd = new Date(Date.UTC(year as number, (month as number) - 1, 0));
      const lastMonthStart = new Date(Date.UTC(lastMonthEnd.getUTCFullYear(), lastMonthEnd.getUTCMonth(), 1));
      return { from: lastMonthStart.toISOString().slice(0, 10), to: lastMonthEnd.toISOString().slice(0, 10) };
    }
    case "thisYear":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "custom":
      return { from: customFrom || addDaysIso(today, -29), to: customTo || today };
  }
}

// ---------------------------------------------------------------------------
// Small display helpers
// ---------------------------------------------------------------------------

function money(value: number): string {
  return `AED ${value.toLocaleString("en-AE", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function ChangeBadge({ change }: { change: DashboardChange }): ReactElement {
  const direction = change.percent === null ? "" : change.percent >= 0 ? "up" : "down";
  return (
    <span className={`platform-kpi-card__meta${direction === "" ? "" : ` platform-kpi-card__meta--${direction}`}`}>
      {change.label} vs previous period
    </span>
  );
}

function KpiCard({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta?: ReactElement | string;
}): ReactElement {
  return (
    <div className="platform-kpi-card">
      <span className="platform-kpi-card__label">{label}</span>
      <span className="platform-kpi-card__value">{value}</span>
      {meta === undefined ? null : typeof meta === "string" ? (
        <span className="platform-kpi-card__meta">{meta}</span>
      ) : (
        meta
      )}
    </div>
  );
}

const donutPalette = [
  "var(--platform-accent)",
  "var(--platform-ok-text)",
  "var(--platform-warn-text)",
  "var(--platform-bad-text)",
  "var(--platform-accent-secondary)",
  "var(--platform-muted)",
];

function Donut({ items, valueKey }: { items: Distribution["items"]; valueKey: "value" | "status" | "emirate" }): ReactElement {
  const data = items.map((item) => ({ label: String(item[valueKey] ?? "—"), count: item.count, percent: item.percent }));
  return (
    <>
      <ResponsiveContainer height={220} width="100%">
        <PieChart>
          <Pie data={data} dataKey="count" innerRadius={50} nameKey="label" outerRadius={80} paddingAngle={2}>
            {data.map((entry, index) => (
              <Cell fill={donutPalette[index % donutPalette.length] ?? "var(--platform-accent)"} key={entry.label} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
      <div className="platform-legend">
        {data.map((entry, index) => (
          <span key={entry.label}>
            <span
              className="platform-legend__swatch"
              style={{ background: donutPalette[index % donutPalette.length] }}
            />
            {entry.label}: {entry.count} ({entry.percent}%)
          </span>
        ))}
      </div>
    </>
  );
}

/** Loading / empty / error, uniform across every chart section. */
function SectionState({
  loading,
  error,
  empty,
  emptyMessage,
  onRetry,
}: {
  loading: boolean;
  error: string | undefined;
  empty: boolean;
  emptyMessage: string;
  onRetry: () => void;
}): ReactElement | null {
  if (loading) return <p>Loading…</p>;
  if (error !== undefined) {
    return (
      <div role="alert">
        <p className="platform-warning">{error}</p>
        <button className="platform-button platform-button--quiet" onClick={onRetry} type="button">
          Retry
        </button>
      </div>
    );
  }
  if (empty) return <p className="platform-muted">{emptyMessage}</p>;
  return null;
}

// ---------------------------------------------------------------------------
// Section data hook
// ---------------------------------------------------------------------------

function useSection<T>(loader: () => Promise<T>, deps: readonly unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const retry = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    loader()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setError(failure instanceof PlatformApiError ? failure.message : "This section could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `deps` intentionally drives this effect; `loader` is a fresh closure
    // every render by design (it captures the latest filters) and is not
    // itself a dependency.
  }, [...deps, tick]);

  return { data, error, loading, retry };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function DashboardPage(): ReactElement {
  const session = usePlatformSession();
  const canRead = session.can("platform.companies.read");

  const [preset, setPreset] = useState<Preset>("last30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [groupBy, setGroupBy] = useState<"auto" | "daily" | "weekly" | "monthly">("auto");
  const [rankingMetric, setRankingMetric] = useState("orders");
  const [companies, setCompanies] = useState<CompanyPage | undefined>(undefined);
  const [overviewSearch, setOverviewSearch] = useState("");
  const [overviewPage, setOverviewPage] = useState(1);
  const [overviewSort, setOverviewSort] = useState("orders");
  const [overviewDirection, setOverviewDirection] = useState<"asc" | "desc">("desc");
  const [generatedAt, setGeneratedAt] = useState<string | undefined>(undefined);

  const { from, to } = useMemo(() => presetRange(preset, customFrom, customTo), [preset, customFrom, customTo]);
  const invalidCustomRange = preset === "custom" && customFrom !== "" && customTo !== "" && customFrom > customTo;
  const scopedCompanyId = companyId === "" ? undefined : companyId;
  const showComparisons = companyId === "";

  useEffect(() => {
    if (!canRead) return undefined;
    let cancelled = false;
    // Best-effort: a failure here only means the Company filter dropdown
    // stays at "All Companies" — it must never blank the rest of the
    // Dashboard, which is why this is not wired through `useSection`.
    platformApi
      .companies({ direction: "asc", pageSize: 100, sort: "name" })
      .then((result) => {
        if (!cancelled) setCompanies(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canRead]);

  const filters = { companyId: scopedCompanyId, from, to };
  const trendFilters = { ...filters, groupBy: groupBy === "auto" ? undefined : groupBy };

  const summary = useSection<DashboardSummary>(
    () => platformApi.dashboardSummary(filters),
    [scopedCompanyId, from, to],
  );
  const trend = useSection<OrdersTrend>(
    () => platformApi.dashboardOrdersTrend(trendFilters),
    [scopedCompanyId, from, to, groupBy],
  );
  const orderStatus = useSection<Distribution>(
    () => platformApi.dashboardOrderStatus(filters),
    [scopedCompanyId, from, to],
  );
  const ranking = useSection<{ items: readonly CompanyRankingItem[] }>(
    () => platformApi.dashboardCompanyRanking({ ...filters, limit: 10, metric: rankingMetric }),
    [scopedCompanyId, from, to, rankingMetric],
  );
  const byStatus = useSection<Distribution>(() => platformApi.dashboardCompaniesByStatus({}), []);
  const byEnvironment = useSection<Distribution>(() => platformApi.dashboardCompaniesByEnvironment({}), []);
  const byEmirate = useSection<Distribution>(
    () => platformApi.dashboardOrdersByEmirate(filters),
    [scopedCompanyId, from, to],
  );
  const overview = useSection<CompanyOverviewPage>(
    () =>
      platformApi.dashboardCompanyOverview({
        ...filters,
        direction: overviewDirection,
        page: overviewPage,
        pageSize: 10,
        search: overviewSearch,
        sort: overviewSort,
      }),
    [scopedCompanyId, from, to, overviewSearch, overviewPage, overviewSort, overviewDirection],
  );
  const attention = useSection<NeedsAttention>(() => platformApi.dashboardNeedsAttention(), []);

  useEffect(() => {
    if (summary.data !== undefined) setGeneratedAt(new Date().toISOString());
  }, [summary.data]);

  function refreshAll(): void {
    summary.retry();
    trend.retry();
    orderStatus.retry();
    ranking.retry();
    byStatus.retry();
    byEnvironment.retry();
    byEmirate.retry();
    overview.retry();
    attention.retry();
  }

  function sortOverviewBy(column: string): void {
    setOverviewPage(1);
    if (overviewSort === column) {
      setOverviewDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setOverviewSort(column);
    setOverviewDirection("desc");
  }

  if (!canRead) {
    return (
      <section className="platform-panel">
        <h2>Platform Dashboard</h2>
        <p role="alert">You do not have permission to view Platform metrics.</p>
      </section>
    );
  }

  const overviewPageCount =
    overview.data === undefined ? 1 : Math.max(1, Math.ceil(overview.data.total / overview.data.pageSize));

  return (
    <section className="platform-panel">
      <div className="platform-dashboard__header">
        <div>
          <h2>Platform Dashboard</h2>
          <p className="platform-muted">Overview of all Companies and Platform activity</p>
        </div>
        <div className="platform-dashboard__filters">
          <label className="platform-field" htmlFor="dashboard-range">
            <span>Date Range</span>
            <select
              id="dashboard-range"
              onChange={(event) => setPreset(event.target.value as Preset)}
              value={preset}
            >
              {presetOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {preset === "custom" ? (
            <>
              <label className="platform-field" htmlFor="dashboard-from">
                <span>From Date</span>
                <input
                  id="dashboard-from"
                  onChange={(event) => setCustomFrom(event.target.value)}
                  type="date"
                  value={customFrom}
                />
              </label>
              <label className="platform-field" htmlFor="dashboard-to">
                <span>To Date</span>
                <input
                  id="dashboard-to"
                  onChange={(event) => setCustomTo(event.target.value)}
                  type="date"
                  value={customTo}
                />
              </label>
            </>
          ) : null}
          <label className="platform-field" htmlFor="dashboard-company">
            <span>Company</span>
            <select
              id="dashboard-company"
              onChange={(event) => setCompanyId(event.target.value)}
              value={companyId}
            >
              <option value="">All Companies</option>
              {(companies?.items ?? []).map((company) => (
                <option key={company.id} value={company.id}>
                  {company.nameEn}
                </option>
              ))}
            </select>
          </label>
          <label className="platform-field" htmlFor="dashboard-groupby">
            <span>Grouping</span>
            <select
              id="dashboard-groupby"
              onChange={(event) => setGroupBy(event.target.value as typeof groupBy)}
              value={groupBy}
            >
              <option value="auto">Auto</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <button className="platform-button platform-button--quiet" onClick={refreshAll} type="button">
            Refresh
          </button>
        </div>
      </div>

      {invalidCustomRange ? <p role="alert">The start date must not be after the end date.</p> : null}
      {generatedAt !== undefined ? (
        <p className="platform-dashboard__asof">Data as of {new Date(generatedAt).toLocaleString()}</p>
      ) : null}

      {/* --------------------------------------------------------------- */}
      {/* KPI cards                                                       */}
      {/* --------------------------------------------------------------- */}
      <SectionState
        empty={false}
        emptyMessage=""
        error={
          summary.error ??
          (summary.data !== undefined && summary.data.companies === undefined
            ? "The Dashboard summary response was not in the expected shape."
            : undefined)
        }
        loading={summary.loading}
        onRetry={summary.retry}
      />
      {/* Defensive against a malformed/partial response: a shape mismatch
          becomes the error state above rather than a crash. */}
      {summary.data === undefined || summary.data.companies === undefined ? null : (
        <div className="platform-kpi-grid">
          <KpiCard
            label="Total Companies"
            meta={`+${summary.data.companies.newThisMonth} this month · current state`}
            value={String(summary.data.companies.total)}
          />
          <KpiCard
            label="Active Companies"
            meta={`${summary.data.companies.activePercent}% of total`}
            value={String(summary.data.companies.active)}
          />
          <KpiCard
            label="Suspended Companies"
            meta={`${summary.data.companies.suspendedPercent}% of total`}
            value={String(summary.data.companies.suspended)}
          />
          <KpiCard
            label="Closed Companies"
            meta={`${summary.data.companies.closedPercent}% of total`}
            value={String(summary.data.companies.closed)}
          />
          <KpiCard
            label="Total Orders"
            meta={<ChangeBadge change={summary.data.orders.totalChange} />}
            value={summary.data.orders.total.toLocaleString()}
          />
          <KpiCard
            label="Delivered Orders"
            meta={
              summary.data.orders.deliveryRate === null
                ? "Delivered / Created (no Orders created in range)"
                : `${summary.data.orders.deliveryRate}% of Orders created in range`
            }
            value={summary.data.orders.delivered.toLocaleString()}
          />
          <KpiCard
            label="Delivered COD (AED)"
            meta={<ChangeBadge change={summary.data.orders.codChange} />}
            value={money(summary.data.orders.cod)}
          />
          <KpiCard
            label="Service Fees (AED)"
            meta={<ChangeBadge change={summary.data.orders.serviceFeesChange} />}
            value={money(summary.data.orders.serviceFees)}
          />
          <KpiCard
            label="Total Traders"
            meta={`${summary.data.traders.active} active · +${summary.data.traders.new} in range`}
            value={String(summary.data.traders.total)}
          />
          <KpiCard
            label="Total Customers"
            meta={`+${summary.data.customers.new} in range · one record per Company, not deduplicated`}
            value={String(summary.data.customers.total)}
          />
          <KpiCard
            label="Total Drivers"
            meta={`+${summary.data.drivers.new} in range · current state`}
            value={String(summary.data.drivers.total)}
          />
          <KpiCard
            label="Total Employees"
            meta={`+${summary.data.employees.new} in range · current state`}
            value={String(summary.data.employees.total)}
          />
        </div>
      )}

      {/* --------------------------------------------------------------- */}
      {/* Orders Trend                                                    */}
      {/* --------------------------------------------------------------- */}
      <div className="platform-chart-grid platform-chart-grid--wide">
        <div className="platform-chart-card">
          <h3>Orders Trend</h3>
          <SectionState
            empty={(trend.data?.series?.length ?? 0) === 0}
            emptyMessage="No Orders in this period."
            error={trend.error}
            loading={trend.loading}
            onRetry={trend.retry}
          />
          {trend.data?.series === undefined || trend.data.series.length === 0 ? null : (
            <div className="platform-chart-card__scroll">
              <ResponsiveContainer height={280} width="100%">
                <LineChart data={[...trend.data.series]}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="bucket" fontSize={11} />
                  <YAxis fontSize={11} />
                  <Tooltip />
                  <Legend />
                  <Line dataKey="created" name="Created" stroke="var(--platform-accent)" strokeWidth={2} type="monotone" />
                  <Line dataKey="delivered" name="Delivered" stroke="var(--platform-ok-text)" strokeWidth={2} type="monotone" />
                  <Line dataKey="cancelled" name="Cancelled" stroke="var(--platform-bad-text)" strokeWidth={2} type="monotone" />
                  <Line dataKey="returned" name="Returned" stroke="var(--platform-warn-text)" strokeWidth={2} type="monotone" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      <div className="platform-chart-grid">
        <div className="platform-chart-card">
          <h3>Order Status Distribution</h3>
          <SectionState
            empty={(orderStatus.data?.items.length ?? 0) === 0}
            emptyMessage="No Orders in this period."
            error={orderStatus.error}
            loading={orderStatus.loading}
            onRetry={orderStatus.retry}
          />
          {orderStatus.data === undefined || orderStatus.data.items.length === 0 ? null : (
            <Donut items={orderStatus.data.items} valueKey="status" />
          )}
        </div>

        {showComparisons ? (
          <div className="platform-chart-card">
            <div className="platform-panel__header">
              <h3>Top Companies by Orders</h3>
              <select onChange={(event) => setRankingMetric(event.target.value)} value={rankingMetric}>
                <option value="orders">By Orders</option>
                <option value="delivered">By Delivered</option>
                <option value="cod">By COD</option>
                <option value="serviceFees">By Service Fees</option>
                <option value="traders">By Traders</option>
                <option value="customers">By Customers</option>
              </select>
            </div>
            <SectionState
              empty={(ranking.data?.items.length ?? 0) === 0}
              emptyMessage="No Company activity in this period."
              error={ranking.error}
              loading={ranking.loading}
              onRetry={ranking.retry}
            />
            {ranking.data === undefined || ranking.data.items.length === 0 ? null : (
              <div className="platform-chart-card__scroll">
                <ResponsiveContainer height={Math.max(180, ranking.data.items.length * 34)} width="100%">
                  <BarChart data={[...ranking.data.items]} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" />
                    <YAxis dataKey="name" fontSize={11} type="category" width={140} />
                    <Tooltip />
                    <Bar dataKey={rankingMetric} fill="var(--platform-accent)" name="Value" />
                  </BarChart>
                </ResponsiveContainer>
                <ul className="platform-attention-card__list">
                  {ranking.data.items.map((row) => (
                    <li key={row.id}>
                      <Link to={`/companies/${row.id}`}>{row.name}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : null}

        {showComparisons ? (
          <div className="platform-chart-card">
            <h3>Companies by Status</h3>
            <SectionState
              empty={(byStatus.data?.items.length ?? 0) === 0}
              emptyMessage="No Companies found."
              error={byStatus.error}
              loading={byStatus.loading}
              onRetry={byStatus.retry}
            />
            {byStatus.data === undefined || byStatus.data.items.length === 0 ? null : (
              <Donut items={byStatus.data.items} valueKey="value" />
            )}
          </div>
        ) : null}

        {showComparisons ? (
          <div className="platform-chart-card">
            <h3>Companies by Environment</h3>
            <SectionState
              empty={(byEnvironment.data?.items.length ?? 0) === 0}
              emptyMessage="No Companies found."
              error={byEnvironment.error}
              loading={byEnvironment.loading}
              onRetry={byEnvironment.retry}
            />
            {byEnvironment.data === undefined || byEnvironment.data.items.length === 0 ? null : (
              <Donut items={byEnvironment.data.items} valueKey="value" />
            )}
          </div>
        ) : null}

        <div className="platform-chart-card">
          <h3>Orders by Emirate</h3>
          <SectionState
            empty={(byEmirate.data?.items.length ?? 0) === 0}
            emptyMessage="No Orders in this period."
            error={byEmirate.error}
            loading={byEmirate.loading}
            onRetry={byEmirate.retry}
          />
          {byEmirate.data === undefined || byEmirate.data.items.length === 0 ? null : (
            <Donut items={byEmirate.data.items} valueKey="emirate" />
          )}
        </div>
      </div>

      {/* --------------------------------------------------------------- */}
      {/* Needs Attention                                                 */}
      {/* --------------------------------------------------------------- */}
      <h3>Needs Attention</h3>
      <SectionState
        empty={(attention.data?.categories?.length ?? 0) === 0}
        emptyMessage="Nothing needs attention right now."
        error={attention.error}
        loading={attention.loading}
        onRetry={attention.retry}
      />
      {attention.data?.categories === undefined ? null : (
        <div className="platform-attention-grid">
          {attention.data.categories.map((category) => (
            <div className={`platform-attention-card platform-attention-card--${category.severity}`} key={category.key}>
              <div className="platform-attention-card__count">{category.count}</div>
              <div className="platform-attention-card__label">{category.label}</div>
              {category.companies.length === 0 ? null : (
                <ul className="platform-attention-card__list">
                  {category.companies.slice(0, 5).map((company) => (
                    <li key={company.id}>
                      <Link to={`/companies/${company.id}`}>{company.name}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="platform-muted">
        Module Adoption, Billing and Integrity Center metrics are deferred to a future phase — nothing here is
        invented ahead of real data existing for them.
      </p>

      {/* --------------------------------------------------------------- */}
      {/* Company Overview                                                */}
      {/* --------------------------------------------------------------- */}
      <div className="platform-panel__header">
        <h3>Company Overview</h3>
        <label className="platform-field" htmlFor="dashboard-overview-search">
          <span>Search</span>
          <input
            id="dashboard-overview-search"
            onChange={(event) => {
              setOverviewPage(1);
              setOverviewSearch(event.target.value);
            }}
            placeholder="Name or code"
            type="search"
            value={overviewSearch}
          />
        </label>
      </div>
      <SectionState
        empty={(overview.data?.items.length ?? 0) === 0}
        emptyMessage="No Companies match these filters."
        error={overview.error}
        loading={overview.loading}
        onRetry={overview.retry}
      />
      {overview.data === undefined || overview.data.items.length === 0 ? null : (
        <>
          <div className="platform-chart-card__scroll">
            <table className="platform-table">
              <thead>
                <tr>
                  <OverviewSortHeader column="name" label="Company" onSort={sortOverviewBy} sort={overviewSort} direction={overviewDirection} />
                  <th scope="col">Status</th>
                  <th scope="col">Environment</th>
                  <OverviewSortHeader column="orders" label="Orders" onSort={sortOverviewBy} sort={overviewSort} direction={overviewDirection} />
                  <OverviewSortHeader column="delivered" label="Delivered" onSort={sortOverviewBy} sort={overviewSort} direction={overviewDirection} />
                  <OverviewSortHeader column="traders" label="Traders" onSort={sortOverviewBy} sort={overviewSort} direction={overviewDirection} />
                  <OverviewSortHeader column="customers" label="Customers" onSort={sortOverviewBy} sort={overviewSort} direction={overviewDirection} />
                  <OverviewSortHeader column="drivers" label="Drivers" onSort={sortOverviewBy} sort={overviewSort} direction={overviewDirection} />
                  <OverviewSortHeader column="cod" label="COD (AED)" onSort={sortOverviewBy} sort={overviewSort} direction={overviewDirection} />
                  <OverviewSortHeader column="lastOrder" label="Last Order" onSort={sortOverviewBy} sort={overviewSort} direction={overviewDirection} />
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {overview.data.items.map((row: CompanyOverviewRow) => (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td>
                      <span className={`platform-badge platform-badge--${row.status}`}>{row.status}</span>
                    </td>
                    <td>{row.environment}</td>
                    <td>{row.orders.toLocaleString()}</td>
                    <td>{row.delivered.toLocaleString()}</td>
                    <td>{row.traders.toLocaleString()}</td>
                    <td>{row.customers.toLocaleString()}</td>
                    <td>{row.drivers.toLocaleString()}</td>
                    <td>{money(row.cod)}</td>
                    <td>{row.lastOrderAt === null ? "—" : new Date(row.lastOrderAt).toISOString().slice(0, 10)}</td>
                    <td>
                      <Link to={`/companies/${row.id}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="platform-pager">
            <button
              className="platform-button platform-button--quiet"
              disabled={overviewPage <= 1}
              onClick={() => setOverviewPage((current) => current - 1)}
              type="button"
            >
              Previous
            </button>
            <span className="platform-muted">
              Page {overview.data.page} of {overviewPageCount} · {overview.data.total} Compan
              {overview.data.total === 1 ? "y" : "ies"}
            </span>
            <button
              className="platform-button platform-button--quiet"
              disabled={overviewPage >= overviewPageCount}
              onClick={() => setOverviewPage((current) => current + 1)}
              type="button"
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function OverviewSortHeader({
  column,
  label,
  sort,
  direction,
  onSort,
}: {
  column: string;
  label: string;
  sort: string;
  direction: "asc" | "desc";
  onSort: (column: string) => void;
}): ReactElement {
  const active = sort === column;
  return (
    <th aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"} scope="col">
      <button className="platform-sort" onClick={() => onSort(column)} type="button">
        {label}
        {active ? <span aria-hidden="true">{direction === "asc" ? " ▲" : " ▼"}</span> : null}
      </button>
    </th>
  );
}
