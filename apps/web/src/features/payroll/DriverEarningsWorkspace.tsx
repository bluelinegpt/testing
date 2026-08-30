import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import { formatCurrency, formatDate, formatNumber } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import { useIdempotencyKey } from "../operations/useIdempotencyKey.js";

interface Driver {
  driverCode: string;
  driverId: string;
  driverName: string;
  driverType: "employee" | "outsourced";
  employeeId: string | null;
}
interface DeliverySource {
  customer: string | null;
  deliveryDate: string;
  driver: string;
  earned: string;
  id: string;
  orderId: string;
  orderNumber: string;
  rate: string;
  referenceNumber: string | null;
  serialDate: string;
  serialNumber: string | null;
  trader: string | null;
}
interface CollectionSource {
  area: string;
  closeDate: string;
  customer: string;
  earned: string;
  id: string;
  orderId: string;
  orderNumber: string;
  rate: string;
  referenceNumber: string | null;
  serialDate: string;
  serialNumber: string | null;
}
interface EarningPeriod {
  id: string;
  dateFrom: string;
  dateTo: string;
  deliveredOrders: number;
  collectedOrders: number;
  deliveryEarnings: string;
  collectionEarnings: string;
  collectionRate: string;
  totalEarnings: string;
  interimPaid: string;
  payrollPaid: string;
  outstanding: string;
  status: "unpaid" | "partially_paid" | "paid";
  deliverySources: readonly DeliverySource[];
  collectionSources: readonly CollectionSource[];
}
interface EarningsSource {
  id: string;
  sourceType: "collection" | "delivery";
  date: string;
  gross: string;
  interimPaid: string;
  payrollAllocated: string;
  outstanding: string;
  paymentStatus: string;
  rate: string;
  collectedOrderCount: number;
  orderNumber: string | null;
  orderId: string | null;
  serialNumber: string | null;
  serialDate: string | null;
  referenceNumber: string | null;
  trader: string | null;
  customer: string | null;
}
interface EarningsSummary {
  driverCode: string;
  driverName: string;
  driverType: "employee" | "outsourced";
  setup: { delivery: string | null; collection: string | null };
  deliveredOrders: number;
  deliveryTransactions: number;
  collectedOrders: number;
  collectionTransactions: number;
  paymentTransactions: number;
  delivery: string;
  collection: string;
  earned: string;
  interimPaid: string;
  payrollPaid: string;
  paid: string;
  outstanding: string;
  sources: readonly EarningsSource[];
  payments: readonly Record<string, unknown>[];
}

interface DailyEarningAvailability {
  amount: string;
  collectedOrders: number;
  date: string;
  deliveredOrders: number;
  status: "available" | "in_progress" | "no_earnings";
}

interface MonthlyPaymentItem {
  advanceOutstanding: string;
  advancePaid: string;
  advanceRecovery: string;
  allowances: string;
  basicSalary: string;
  collectionEarnings: string;
  deductions: readonly Record<string, unknown>[];
  deliveryEarnings: string;
  driverCode: string;
  driverEarningPayments: readonly Record<string, unknown>[];
  driverEarnings: string;
  driverEarningsOutstanding: string;
  driverEarningsPaid: string;
  driverId: string;
  driverName: string;
  employeeId: string;
  grossEarned: string;
  netSalary: string;
  otherDeductions: string;
  otherEarnings: string;
  salaryAdvances: readonly Record<string, unknown>[];
  salaryOutstanding: string;
  salaryPaid: string;
  salaryPayments: readonly Record<string, unknown>[];
  totalCashPaid: string;
  totalDeductions: string;
}

interface MonthlyPayments {
  items: readonly MonthlyPaymentItem[];
  month: string;
  totals: {
    advancePaid: string;
    driverEarningsPaid: string;
    salaryPaid: string;
    totalCashPaid: string;
  };
}

export function DriverEarningsWorkspace({ api, canPay }: { api: ApiClient; canPay: boolean }) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const money = (value: string) => formatCurrency(value, "AED", locale);
  const count = (value: number) => formatNumber(Math.trunc(value), locale);
  const dateLabel = (value: string) => formatDate(`${value}T12:00:00Z`, locale);
  const idem = useIdempotencyKey();
  const [view, setView] = useState<"monthly" | "manage" | "report">("monthly");
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [monthlyDriverId, setMonthlyDriverId] = useState("");
  const [monthly, setMonthly] = useState<MonthlyPayments>();
  const [expandedDriverId, setExpandedDriverId] = useState<string>();
  const [drivers, setDrivers] = useState<readonly Driver[]>([]);
  const [driverId, setDriverId] = useState("");
  const monthStart = new Date();
  monthStart.setDate(1);
  const [dateFrom, setDateFrom] = useState(monthStart.toISOString().slice(0, 10));
  const [dateTo, setDateTo] = useState(new Date().toISOString().slice(0, 10));
  const [periodPreview, setPeriodPreview] = useState<{
    collectedOrders: number;
    collectionSources: readonly (Omit<CollectionSource, "earned"> & { amount: string })[];
    collectionEarnings: string;
    collectionRate: string;
    deliveredOrders: number;
    deliveryEarnings: string;
    deliverySources: readonly (Omit<DeliverySource, "earned"> & { amount: string })[];
    totalEarnings: string;
  }>();
  const [dailyAvailability, setDailyAvailability] = useState<readonly DailyEarningAvailability[]>([]);
  const previewSources: readonly DeliverySource[] = (periodPreview?.deliverySources ?? []).map(
    ({ amount, ...source }) => ({ ...source, earned: amount }),
  );
  const previewSourcesTotal = previewSources.reduce(
    (sum, source) => sum + Number(source.earned),
    0,
  );
  const previewReconciles = periodPreview
    ? previewSources.length === periodPreview.deliveredOrders &&
      previewSourcesTotal.toFixed(2) === Number(periodPreview.deliveryEarnings).toFixed(2)
    : true;
  const [periods, setPeriods] = useState<readonly EarningPeriod[]>([]);
  const [selectedPeriodId, setSelectedPeriodId] = useState<string>();
  const selectedPeriod = periods.find((period) => period.id === selectedPeriodId) ?? periods[0];
  const [accounts, setAccounts] = useState<readonly { id: string; name: string }[]>([]);
  const [loadingDrivers, setLoadingDrivers] = useState(true);
  const [accountWarning, setAccountWarning] = useState(false);
  const [form, setForm] = useState({
    accountId: "",
    amount: "",
    date: new Date().toISOString().slice(0, 10),
    method: "cash",
    notes: "",
    reference: "",
  });
  const [advanceForm, setAdvanceForm] = useState({
    accountId: "",
    amount: "",
    date: new Date().toISOString().slice(0, 10),
    method: "cash",
    notes: "",
    reference: "",
  });
  const [advanceAvailability, setAdvanceAvailability] = useState<{
    available: string;
    basicSalary: string;
    existingOutstanding: string;
  }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<string>();
  const calculate = async () => {
    if (!driverId) return;
    const today = new Date().toISOString().slice(0, 10);
    let calculationDateTo = dateTo;
    if (dateTo >= today) {
      calculationDateTo = previousIsoDate(today);
      if (dateFrom > calculationDateTo) {
        setPeriodPreview(undefined);
        return setError(t("driverEarnings.todayStillInProgress"));
      }
      setDateTo(calculationDateTo);
      setSuccess(t("driverEarnings.todayExcluded", { dateTo: calculationDateTo }));
    }
    const overlappingPeriod = periods.find(
      (period) => dateFrom <= period.dateTo && calculationDateTo >= period.dateFrom,
    );
    if (overlappingPeriod) {
      setPeriodPreview(undefined);
      return setError(
        t("driverEarnings.periodAlreadyConfirmed", {
          dateFrom: overlappingPeriod.dateFrom,
          dateTo: overlappingPeriod.dateTo,
        }),
      );
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.post<{
        collectedOrders: number;
        collectionSources: readonly (Omit<CollectionSource, "earned"> & { amount: string })[];
        collectionEarnings: string;
        collectionRate: string;
        deliveredOrders: number;
        deliveryEarnings: string;
        deliverySources: readonly (Omit<DeliverySource, "earned"> & { amount: string })[];
        totalEarnings: string;
      }>("operations/payroll/driver-earnings/periods/preview", {
        dateFrom,
        dateTo: calculationDateTo,
        driverId,
      });
      if (Number(result.totalEarnings) <= 0) {
        setPeriodPreview(undefined);
        setError(t("driverEarnings.noPayableEarnings"));
        return;
      }
      setPeriodPreview(result);
    } catch {
      setError(t("driverEarnings.calculateFailed"));
    } finally {
      setBusy(false);
    }
  };
  const loadPeriods = async (id = driverId) => {
    if (!id) return setPeriods([]);
    const result = await api.get<{
      items: readonly EarningPeriod[];
      nextAvailableStart: string | null;
    }>(`operations/payroll/driver-earnings/periods?driverId=${id}`);
    const items = Array.isArray(result.items) ? result.items : [];
    setPeriods(items);
    setSelectedPeriodId((current) =>
      current && items.some((period) => period.id === current) ? current : items[0]?.id,
    );
    if (result.nextAvailableStart) {
      setDateFrom(result.nextAvailableStart);
      setDateTo((current) =>
        current < result.nextAvailableStart! ? result.nextAvailableStart! : current,
      );
    }
  };
  const confirmPeriod = async () => {
    if (
      !periodPreview ||
      !window.confirm(t("driverEarnings.confirmPeriodMessage", { dateFrom, dateTo }))
    )
      return;
    setBusy(true);
    try {
      await api.post("operations/payroll/driver-earnings/periods", {
        dateFrom,
        dateTo,
        driverId,
      });
      setPeriodPreview(undefined);
      setSuccess(t("driverEarnings.earningPeriodConfirmed"));
      await loadPeriods();
    } catch {
      setError(t("driverEarnings.confirmEarningsFailed"));
    } finally {
      setBusy(false);
    }
  };
  const reconcile = async () => {
    if (!driverId) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.post<{
        ambiguousCollections: number;
        collectionCreated: number;
        deliveryCreated: number;
      }>("operations/payroll/driver-earnings/reconcile", {
        dateFrom,
        dateTo,
        driverId,
      });
      setSuccess(t("driverEarnings.reconcileResult", {
        ambiguousCollections: result.ambiguousCollections,
        collectionCreated: result.collectionCreated,
        deliveryCreated: result.deliveryCreated,
      }));
    } catch {
      setError(t("driverEarnings.reconcileFailed"));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void api
      .get<{ items: readonly Driver[] }>("operations/payroll/driver-earnings?pageSize=200")
      .then((result) => {
        setDrivers(result.items);
        // Keep the restored earnings workflow visible on entry. Previously the
        // empty placeholder hid Calculate, source transactions, and period history
        // even when an eligible Employee Driver was available.
        setDriverId((current) => current || result.items[0]?.driverId || "");
      })
      .catch(() => setError(t("driverEarnings.loadFailed")))
      .finally(() => setLoadingDrivers(false));
    void api
      .get<readonly { id: string; name: string }[]>(
        "operations/accounting/cash-bank/cash-accounts?activeOnly=true",
      )
      .then(setAccounts)
      .catch(() => setAccountWarning(true));
  }, [api, t]);
  useEffect(() => {
    const parameters = new URLSearchParams({ month });
    if (monthlyDriverId) parameters.set("driverId", monthlyDriverId);
    void api
      .get<MonthlyPayments>(`operations/payroll/driver-earnings/monthly-payments?${parameters}`)
      .then((result) => {
        if (Array.isArray(result.items) && result.totals && typeof result.totals.salaryPaid === "string")
          setMonthly(result);
        else setView("manage");
      })
      .catch(() => setError(t("driverEarnings.monthlyLoadFailed")));
  }, [api, month, monthlyDriverId, t]);
  useEffect(() => {
    if (!driverId) {
      setPeriods([]);
      return;
    }
    void loadPeriods().catch(() => setError(t("driverEarnings.loadFailed")));
  }, [api, dateFrom, dateTo, driverId, t]);
  useEffect(() => {
    if (!driverId || !dateFrom || !dateTo || dateTo < dateFrom) {
      setDailyAvailability([]);
      return;
    }
    const parameters = new URLSearchParams({ dateFrom, dateTo, driverId });
    void api
      .get<EarningsSummary>(`operations/payroll/driver-earnings?${parameters.toString()}`)
      .then((result) => {
        const sources = Array.isArray(result.sources) ? result.sources : [];
        const byDate = new Map<
          string,
          { amount: number; collectedOrders: number; deliveredOrders: number }
        >();
        for (const source of sources) {
          const current = byDate.get(source.date) ?? {
            amount: 0,
            collectedOrders: 0,
            deliveredOrders: 0,
          };
          current.amount += Number(source.gross || 0);
          if (source.sourceType === "collection")
            current.collectedOrders += source.collectedOrderCount;
          else current.deliveredOrders += 1;
          byDate.set(source.date, current);
        }
        const today = new Date().toISOString().slice(0, 10);
        setDailyAvailability(
          enumerateIsoDates(dateFrom, dateTo).map((date) => {
            const value = byDate.get(date) ?? {
              amount: 0,
              collectedOrders: 0,
              deliveredOrders: 0,
            };
            return {
              amount: value.amount.toFixed(2),
              collectedOrders: value.collectedOrders,
              date,
              deliveredOrders: value.deliveredOrders,
              status:
                date >= today
                  ? "in_progress"
                  : value.amount > 0
                    ? "available"
                    : "no_earnings",
            };
          }),
        );
      })
      .catch(() => setDailyAvailability([]));
  }, [api, dateFrom, dateTo, driverId]);
  useEffect(() => {
    const employeeId = drivers.find((driver) => driver.driverId === driverId)?.employeeId;
    if (!employeeId) return setAdvanceAvailability(undefined);
    const parameters = new URLSearchParams({ employeeId, paymentDate: advanceForm.date });
    void api
      .get<{ available: string; basicSalary: string; existingOutstanding: string }>(
        `operations/payroll/salary-advances/availability?${parameters.toString()}`,
      )
      .then((result) => {
        if (
          typeof result.available === "string" &&
          typeof result.basicSalary === "string" &&
          typeof result.existingOutstanding === "string"
        )
          setAdvanceAvailability(result);
      })
      .catch(() => setAdvanceAvailability(undefined));
  }, [advanceForm.date, api, driverId, drivers]);

  const pay = async () => {
    const driver = drivers.find((item) => item.driverId === driverId);
    if (!driver?.employeeId || !form.accountId || Number(form.amount) <= 0)
      return setError(t("driverEarnings.completePayment"));
    if (!selectedPeriod || Number(form.amount) > Number(selectedPeriod.outstanding))
      return setError(t("driverEarnings.paymentExceedsOutstanding"));
    const body = {
      accountId: form.accountId,
      amount: Number(form.amount),
      employeeId: driver.employeeId,
      earningPeriodId: selectedPeriod.id,
      notes: form.notes,
      paymentDate: form.date,
      paymentMethod: form.method,
      reference: form.reference,
    };
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const path = "driver-earnings/employee/payments";
      const result = await api.post<{ paymentNumber?: string; advanceNumber?: string }>(
        `operations/payroll/${path}`,
        body,
        { "x-idempotency-key": idem.keyFor(`${path}:${JSON.stringify(body)}`) },
      );
      idem.reset();
      setSuccess(result.paymentNumber ?? result.advanceNumber ?? t("common.saved"));
      setForm((current) => ({ ...current, amount: "", notes: "", reference: "" }));
      await loadPeriods();
    } catch {
      setError(t("driverEarnings.paymentFailed"));
    } finally {
      setBusy(false);
    }
  };
  const payAdvance = async () => {
    const driver = drivers.find((item) => item.driverId === driverId);
    if (!driver?.employeeId || !advanceForm.accountId || Number(advanceForm.amount) <= 0)
      return setError(t("driverEarnings.completeAdvance"));
    const body = {
      accountId: advanceForm.accountId,
      amount: Number(advanceForm.amount),
      employeeId: driver.employeeId,
      notes: advanceForm.notes,
      paymentDate: advanceForm.date,
      paymentMethod: advanceForm.method,
      reference: advanceForm.reference,
    };
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const result = await api.post<{ advanceNumber: string }>(
        "operations/payroll/salary-advances",
        body,
        { "x-idempotency-key": idem.keyFor(`salary-advance:${JSON.stringify(body)}`) },
      );
      idem.reset();
      setSuccess(`${t("driverEarnings.advanceConfirmed")} ${result.advanceNumber}`);
      setAdvanceForm((current) => ({ ...current, amount: "", notes: "", reference: "" }));
    } catch {
      setError(t("driverEarnings.advanceFailed"));
    } finally {
      setBusy(false);
    }
  };

  const paymentBlocked = accountWarning || accounts.length === 0;
  return (
    <section className="stack">
      <div className="card driver-monthly-shell">
        <div className="driver-monthly-heading">
          <div>
            <h2>{t("driverEarnings.title")}</h2>
            <p>{t("driverEarnings.monthlyDescription")}</p>
          </div>
          <div className="button-row driver-monthly-tabs" role="tablist">
            {(["monthly", "manage", "report"] as const).map((item) => (
              <button className={`button ${view === item ? "button-primary" : "button-secondary"}`}
                key={item} onClick={() => setView(item)} role="tab" type="button">
                {t(`driverEarnings.views.${item}`)}
              </button>
            ))}
          </div>
        </div>
        {view === "manage" ? null : <div className="form-grid driver-monthly-filters">
          <label className="field"><span>{t("driverEarnings.month")}</span>
            <input onChange={(event) => setMonth(event.target.value)} type="month" value={month} />
          </label>
          <label className="field"><span>{t("driverEarnings.filterByDriver")}</span>
            <select value={monthlyDriverId} onChange={(event) => setMonthlyDriverId(event.target.value)}>
              <option value="">{t("driverEarnings.allDrivers")}</option>
              {(monthly?.items ?? drivers).map((driver) => <option key={driver.driverId} value={driver.driverId}>
                {driver.driverCode} — {driver.driverName}
              </option>)}
            </select>
          </label>
        </div>}
      </div>
      {view === "monthly" ? (
        <MonthlyDriverOverview data={monthly} expandedDriverId={expandedDriverId}
          money={money} onToggle={setExpandedDriverId} />
      ) : null}
      {view === "report" ? <MonthlyDriverReport data={monthly} money={money} /> : null}
      {view === "manage" ? <>
      <div className="card">
        <h2>{t("driverEarnings.title")}</h2>
        <p>{t("driverEarnings.description")}</p>
        <label className="field">
          <span>{t("driverEarnings.driver")}</span>
          <select
            value={driverId}
            onChange={(event) => {
              setDriverId(event.target.value);
              setPeriodPreview(undefined);
            }}
          >
            <option value="">{t("driverEarnings.selectDriver")}</option>
            {drivers.map((driver) => (
              <option key={driver.driverId} value={driver.driverId}>
                {driver.driverCode} — {driver.driverName} (
                {t(`driverEarnings.${driver.driverType}`)})
              </option>
            ))}
          </select>
        </label>
        <div className="driver-earnings-dates-grid">
          <label className="field">
            <span>{t("driverEarnings.dateFrom")}</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => {
                setDateFrom(event.target.value);
                setPeriodPreview(undefined);
              }}
            />
          </label>
          <label className="field">
            <span>{t("driverEarnings.dateTo")}</span>
            <input
              type="date"
              value={dateTo}
              onChange={(event) => {
                setDateTo(event.target.value);
                setPeriodPreview(undefined);
              }}
            />
          </label>
        </div>
        <p className="muted">{t("driverEarnings.completedCalendarDaysOnly")}</p>
        {dailyAvailability.length > 0 ? (
          <div className="table-shell">
            <h3>{t("driverEarnings.dailyAvailability")}</h3>
            <table>
              <thead><tr>
                <th>{t("driverEarnings.date")}</th>
                <th>{t("driverEarnings.deliveredOrders")}</th>
                <th>{t("driverEarnings.collectedOrders")}</th>
                <th>{t("driverEarnings.availableEarnings")}</th>
                <th>{t("driverEarnings.periodStatus")}</th>
              </tr></thead>
              <tbody>{dailyAvailability.map((day) => (
                <tr key={day.date}>
                  <td>{dateLabel(day.date)}</td>
                  <td>{count(day.deliveredOrders)}</td>
                  <td>{count(day.collectedOrders)}</td>
                  <td>{money(day.amount)}</td>
                  <td>{t(`driverEarnings.availability.${day.status}`)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : null}
        {canPay ? (
          <div className="button-row">
            <button
              className="button button-secondary"
              disabled={busy || !driverId}
              onClick={() => void calculate()}
              type="button"
            >
              {t("driverEarnings.calculateNow")}
            </button>
            <button
              className="button button-secondary"
              disabled={busy || !driverId}
              onClick={() => void reconcile()}
              type="button"
            >
              {t("driverEarnings.reconcile")}
            </button>
          </div>
        ) : null}
        {periodPreview ? (
          <div className="card stack driver-earnings-preview" aria-label={t("driverEarnings.earningPeriod")}>
            <div>
              <strong>{t("driverEarnings.earningPeriod")}</strong>
              <br />
              {dateLabel(dateFrom)} – {dateLabel(dateTo)}
            </div>
            <div>
              <strong>{t("driverEarnings.delivery")}</strong>
              <br />
              {count(periodPreview.deliveredOrders)} {t("driverEarnings.orders")} ×{" "}
              {money(
                periodPreview.deliveredOrders > 0
                  ? (
                      Number(periodPreview.deliveryEarnings) / periodPreview.deliveredOrders
                    ).toFixed(2)
                  : "0.00",
              )}{" "}
              = {money(periodPreview.deliveryEarnings)}
            </div>
            <div>
              <strong>{t("driverEarnings.collection")}</strong>
              <br />
              {count(periodPreview.collectedOrders)} {t("driverEarnings.orders")} ×{" "}
              {money(periodPreview.collectionRate)} = {money(periodPreview.collectionEarnings)}
            </div>
            <div>
              <strong>{t("driverEarnings.totalEarnings")}</strong>
              <br />
              {money(periodPreview.totalEarnings)}
            </div>
            {!previewReconciles ? (
              <div className="alert alert-error">{t("driverEarnings.deliveryIntegrityError")}</div>
            ) : null}
            <p className="driver-earnings-help">{t("driverEarnings.confirmEarningsHelp")}</p>
            <button
              className="button button-primary"
              data-action="confirm-earnings"
              disabled={busy || !previewReconciles}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void confirmPeriod();
              }}
              type="button"
            >
              {t("driverEarnings.confirmAndLockEarnings")}
            </button>
          </div>
        ) : null}
        {periodPreview ? (
          <>
            <DeliveryTransactions
              sources={previewSources}
              title={t("driverEarnings.deliveryTransactionsToInclude")}
            />
            <CollectionDetail
              amount={periodPreview.collectionEarnings}
              count={periodPreview.collectedOrders}
              rate={periodPreview.collectionRate}
              title={t("driverEarnings.collectionEarningDetail")}
            />
            <CollectionTransactions
              sources={periodPreview.collectionSources.map(({ amount, ...source }) => ({ ...source, earned: amount }))}
            />
          </>
        ) : null}
        {!loadingDrivers && drivers.length === 0 ? (
          <p className="empty-state">{t("driverEarnings.noEarnings")}</p>
        ) : null}
      </div>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {success ? <div className="alert alert-success">{success}</div> : null}
      {periods.length > 0 ? (
        <>
          {paymentBlocked ? (
            <div className="alert alert-warning">{t("driverEarnings.mappingWarning")}</div>
          ) : null}
          {periods.length > 0 ? (
            <div className="card table-shell">
              <h3>{t("driverEarnings.periodHistory")}</h3>
              <p>
                {t("driverEarnings.lastEarningPeriod")}: {periods[0]!.dateFrom} –{" "}
                {periods[0]!.dateTo}
              </p>
              <p>
                {t("driverEarnings.nextAvailableStartDate")}: {dateFrom}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>{t("driverEarnings.period")}</th>
                    <th>{t("driverEarnings.deliveredOrders")}</th>
                    <th>{t("driverEarnings.collectedOrders")}</th>
                    <th>{t("driverEarnings.totalEarnings")}</th>
                    <th>{t("driverEarnings.interimPaid")}</th>
                    <th>{t("driverEarnings.payrollPaid")}</th>
                    <th>{t("driverEarnings.outstanding")}</th>
                    <th>{t("driverEarnings.periodStatus")}</th>
                    <th>{t("driverEarnings.action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((period) => (
                    <tr key={period.id}>
                      <td>
                        {period.dateFrom} – {period.dateTo}
                      </td>
                      <td>{period.deliveredOrders}</td>
                      <td>{period.collectedOrders}</td>
                      <td>{money(period.totalEarnings)}</td>
                      <td>{money(period.interimPaid)}</td>
                      <td>{money(period.payrollPaid)}</td>
                      <td>{money(period.outstanding)}</td>
                      <td>{t(`driverEarnings.${period.status}`)}</td>
                      <td>
                        <button
                          className="button button-secondary"
                          onClick={() => setSelectedPeriodId(period.id)}
                          type="button"
                        >
                          {t("driverEarnings.viewDetails")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {selectedPeriod ? <PeriodSourceDetails period={selectedPeriod} /> : null}
          {canPay ? (
            <div className="card driver-payment-card">
              <span className="driver-payment-step">{t("driverEarnings.paymentStep")}</span>
              <h3>{t("driverEarnings.payDriverEarnings")}</h3>
              <p>
                {t("driverEarnings.periodOutstanding")}: {money(selectedPeriod!.outstanding)}
              </p>
              <div className="form-grid">
                <label className="field">
                  <span>{t("driverEarnings.amount")}</span>
                  <input
                    max={selectedPeriod?.outstanding}
                    min="0.01"
                    step="0.01"
                    type="number"
                    value={form.amount}
                    onChange={(event) => setForm({ ...form, amount: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{t("driverEarnings.date")}</span>
                  <input
                    type="date"
                    value={form.date}
                    onChange={(event) => setForm({ ...form, date: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{t("driverEarnings.account")}</span>
                  <select
                    value={form.accountId}
                    onChange={(event) => setForm({ ...form, accountId: event.target.value })}
                  >
                    <option value="">{t("driverEarnings.selectAccount")}</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p>{t("driverEarnings.variableHelp")}</p>
              <button
                className="button button-primary"
                data-action="confirm-payment"
                disabled={busy || Number(selectedPeriod!.outstanding) <= 0 || paymentBlocked}
                onClick={() => void pay()}
                type="button"
              >
                {t("driverEarnings.confirm")}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {canPay && driverId ? (
        <div className="card driver-payment-card driver-advance-card">
          <span className="driver-payment-step">{t("driverEarnings.separatePayment")}</span>
          <h3>{t("driverEarnings.salaryAdvance")}</h3>
          <p>{t("driverEarnings.advanceHelp")}</p>
          {advanceAvailability ? (
            <div className="driver-advance-limit">
              <span>{t("driverEarnings.basicSalaryLimit")}: <strong>{money(advanceAvailability.basicSalary)}</strong></span>
              <span>{t("driverEarnings.existingAdvanceOutstanding")}: <strong>{money(advanceAvailability.existingOutstanding)}</strong></span>
              <span>{t("driverEarnings.availableAdvance")}: <strong>{money(advanceAvailability.available)}</strong></span>
            </div>
          ) : null}
          <div className="form-grid">
            <label className="field">
              <span>{t("driverEarnings.advanceAmount")}</span>
              <input max={advanceAvailability?.available} min="0.01" step="0.01" type="number" value={advanceForm.amount}
                onChange={(event) => setAdvanceForm({ ...advanceForm, amount: event.target.value })} />
            </label>
            <label className="field">
              <span>{t("driverEarnings.date")}</span>
              <input type="date" value={advanceForm.date}
                onChange={(event) => setAdvanceForm({ ...advanceForm, date: event.target.value })} />
            </label>
            <label className="field">
              <span>{t("driverEarnings.account")}</span>
              <select value={advanceForm.accountId}
                onChange={(event) => setAdvanceForm({ ...advanceForm, accountId: event.target.value })}>
                <option value="">{t("driverEarnings.selectAccount")}</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </label>
          </div>
          <button className="button button-primary" data-action="confirm-salary-advance"
            disabled={busy || Number(advanceForm.amount) <= 0 || Number(advanceForm.amount) > Number(advanceAvailability?.available ?? 0) || paymentBlocked}
            onClick={() => void payAdvance()} type="button">
            {t("driverEarnings.confirmSalaryAdvance")}
          </button>
        </div>
      ) : null}
      {canPay && driverId ? (
        <div className="card driver-payment-total">
          <h3>{t("driverEarnings.paymentTotal")}</h3>
          <div><span>{t("driverEarnings.earningsPaymentAmount")}</span><strong>{money(form.amount || "0")}</strong></div>
          <div><span>{t("driverEarnings.advanceAmount")}</span><strong>{money(advanceForm.amount || "0")}</strong></div>
          <div className="driver-payment-grand-total"><span>{t("driverEarnings.totalCashRequired")}</span>
            <strong>{money((Number(form.amount || 0) + Number(advanceForm.amount || 0)).toFixed(2))}</strong></div>
          <p>{t("driverEarnings.paymentsRemainSeparate")}</p>
        </div>
      ) : null}
      </> : null}
    </section>
  );
}

function enumerateIsoDates(dateFrom: string, dateTo: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${dateFrom}T12:00:00Z`);
  const end = new Date(`${dateTo}T12:00:00Z`);
  while (cursor <= end && dates.length < 370) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function previousIsoDate(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function MonthlyDriverOverview({ data, expandedDriverId, money, onToggle }: {
  data: MonthlyPayments | undefined;
  expandedDriverId: string | undefined;
  money: (value: string) => string;
  onToggle: (value: string | undefined) => void;
}) {
  const { t } = useTranslation();
  if (!data) return <div className="card empty-state">{t("common.loading")}</div>;
  return <>
    <div className="driver-monthly-totals">
      <MonthlyStat label={t("driverEarnings.salaryPaid")} value={money(data.totals.salaryPaid)} />
      <MonthlyStat label={t("driverEarnings.driverEarningsPaid")} value={money(data.totals.driverEarningsPaid)} />
      <MonthlyStat label={t("driverEarnings.advancesPaid")} value={money(data.totals.advancePaid)} />
      <MonthlyStat label={t("driverEarnings.totalCashPaid")} value={money(data.totals.totalCashPaid)} />
    </div>
    {data.items.length === 0 ? <div className="card empty-state">{t("driverEarnings.noMonthlyPayments")}</div> : null}
    <div className="driver-monthly-list">
      {data.items.map((item) => {
        const open = expandedDriverId === item.driverId;
        const outstanding = (Number(item.salaryOutstanding) + Number(item.driverEarningsOutstanding)).toFixed(2);
        return <article className={`card driver-monthly-row ${open ? "is-open" : ""}`} key={item.driverId}>
          <button aria-expanded={open} className="driver-monthly-row-button" onClick={() => onToggle(open ? undefined : item.driverId)} type="button">
            <span className="driver-monthly-name"><strong>{item.driverCode} — {item.driverName}</strong><small>{t("driverEarnings.employee")}</small></span>
            <MonthlyMetric label={t("driverEarnings.netSalary")} value={money(item.netSalary)} />
            <MonthlyMetric label={t("driverEarnings.driverEarnings")} value={money(item.driverEarnings)} />
            <MonthlyMetric label={t("driverEarnings.advancePaid")} value={money(item.advancePaid)} />
            <MonthlyMetric label={t("driverEarnings.outstanding")} value={money(outstanding)} />
            <span aria-hidden="true">{open ? "▲" : "▼"}</span>
          </button>
          {open ? <MonthlyDriverDetail item={item} money={money} /> : null}
        </article>;
      })}
    </div>
  </>;
}

function MonthlyDriverDetail({ item, money }: { item: MonthlyPaymentItem; money: (value: string) => string }) {
  const { t } = useTranslation();
  return <div className="driver-monthly-detail">
    <MonthlyDetailSection title={t("driverEarnings.earnedThisMonth")} rows={[
      [t("driverEarnings.basicSalary"), item.basicSalary], [t("driverEarnings.allowances"), item.allowances],
      [t("driverEarnings.delivery"), item.deliveryEarnings], [t("driverEarnings.collection"), item.collectionEarnings],
      [t("driverEarnings.otherEarnings"), item.otherEarnings], [t("driverEarnings.grossEarned"), item.grossEarned],
    ]} money={money} />
    <MonthlyDetailSection title={t("driverEarnings.deductionsTitle")} rows={[
      [t("driverEarnings.otherDeductions"), item.otherDeductions], [t("driverEarnings.advanceRecovery"), item.advanceRecovery],
      [t("driverEarnings.totalDeductions"), item.totalDeductions], [t("driverEarnings.netSalary"), item.netSalary],
    ]} money={money} />
    <MonthlyDetailSection title={t("driverEarnings.paymentsThisMonth")} rows={[
      [t("driverEarnings.salaryPaid"), item.salaryPaid], [t("driverEarnings.driverEarningsPaid"), item.driverEarningsPaid],
      [t("driverEarnings.advancesPaid"), item.advancePaid], [t("driverEarnings.totalCashPaid"), item.totalCashPaid],
    ]} money={money} />
    <MonthlyDetailSection title={t("driverEarnings.balancesAfterMonth")} rows={[
      [t("driverEarnings.salaryOutstanding"), item.salaryOutstanding], [t("driverEarnings.driverEarningsOutstanding"), item.driverEarningsOutstanding],
      [t("driverEarnings.advanceOutstanding"), item.advanceOutstanding],
    ]} money={money} />
    <p className="driver-monthly-note">{t("driverEarnings.advanceSeparationNote")}</p>
  </div>;
}

function MonthlyDetailSection({ money, rows, title }: { money: (value: string) => string; rows: readonly (readonly [string, string])[]; title: string }) {
  return <section><h3>{title}</h3>{rows.map(([label, value]) =>
    <div className="driver-monthly-detail-line" key={label}><span>{label}</span><strong>{money(value)}</strong></div>)}</section>;
}
function MonthlyStat({ label, value }: { label: string; value: string }) { return <div className="card"><span>{label}</span><strong>{value}</strong></div>; }
function MonthlyMetric({ label, value }: { label: string; value: string }) { return <span className="driver-monthly-metric"><small>{label}</small>{value}</span>; }

function MonthlyDriverReport({ data, money }: { data: MonthlyPayments | undefined; money: (value: string) => string }) {
  const { t } = useTranslation();
  if (!data) return <div className="card empty-state">{t("common.loading")}</div>;
  return <div className="card table-shell driver-monthly-report">
    <div className="driver-monthly-report-heading"><h3>{t("driverEarnings.monthlyPaymentReport")}</h3>
      <button className="button button-secondary" onClick={() => window.print()} type="button">
        {t("driverEarnings.printSavePdf")}
      </button>
    </div>
    <table><thead><tr><th>{t("driverEarnings.driver")}</th><th>{t("driverEarnings.grossEarned")}</th>
      <th>{t("driverEarnings.totalDeductions")}</th><th>{t("driverEarnings.netSalary")}</th>
      <th>{t("driverEarnings.salaryPaid")}</th><th>{t("driverEarnings.driverEarningsPaid")}</th>
      <th>{t("driverEarnings.advancesPaid")}</th><th>{t("driverEarnings.totalCashPaid")}</th><th>{t("driverEarnings.outstanding")}</th></tr></thead>
      <tbody>{data.items.map((item) => <tr key={item.driverId}><td>{item.driverCode} — {item.driverName}</td>
        <td>{money(item.grossEarned)}</td><td>{money(item.totalDeductions)}</td><td>{money(item.netSalary)}</td>
        <td>{money(item.salaryPaid)}</td><td>{money(item.driverEarningsPaid)}</td><td>{money(item.advancePaid)}</td>
        <td>{money(item.totalCashPaid)}</td><td>{money((Number(item.salaryOutstanding) + Number(item.driverEarningsOutstanding)).toFixed(2))}</td></tr>)}</tbody>
    </table></div>;
}

// Kept as the shared detail renderer for report/history reuse; the live period
// flow intentionally renders its single summary through PeriodSourceDetails.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function CurrentEarningsSummary({ summary }: { summary: EarningsSummary }) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const money = (value: string | null | undefined) =>
    value == null ? t("driverEarnings.notConfigured") : formatCurrency(value, "AED", locale);
  const sourceRows = Array.isArray(summary.sources) ? summary.sources : [];
  const deliverySources = sourceRows.filter((source) => source.sourceType === "delivery");
  const collectionSources = sourceRows.filter((source) => source.sourceType === "collection");
  return (
    <section className="stack" aria-label={t("driverEarnings.currentEarnings") }>
      <div className="card summary-grid">
        <div><strong>{t("driverEarnings.driver")}</strong><br />{summary.driverCode} — {summary.driverName}</div>
        <div><strong>{t("driverEarnings.deliveryRate")}</strong><br />{money(summary.setup?.delivery)}</div>
        <div><strong>{t("driverEarnings.collectionRate")}</strong><br />{money(summary.setup?.collection)}</div>
        <div><strong>{t("driverEarnings.deliveredOrders")}</strong><br />{summary.deliveredOrders}</div>
        <div><strong>{t("driverEarnings.delivery")}</strong><br />{money(summary.delivery)}</div>
        <div><strong>{t("driverEarnings.collectedOrders")}</strong><br />{summary.collectedOrders}</div>
        <div><strong>{t("driverEarnings.collection")}</strong><br />{money(summary.collection)}</div>
        <div><strong>{t("driverEarnings.totalEarnings")}</strong><br />{money(summary.earned)}</div>
        <div><strong>{t("driverEarnings.interimPaid")}</strong><br />{money(summary.interimPaid)}</div>
        <div><strong>{t("driverEarnings.payrollPaid")}</strong><br />{money(summary.payrollPaid)}</div>
        <div><strong>{t("driverEarnings.outstanding")}</strong><br />{money(summary.outstanding)}</div>
      </div>
      <div className="card summary-grid">
        <div><strong>{t("driverEarnings.deliveryTransactions")}</strong><br />{summary.deliveryTransactions}</div>
        <div><strong>{t("driverEarnings.collectionTransactions")}</strong><br />{summary.collectionTransactions}</div>
        <div><strong>{t("driverEarnings.paymentTransactions")}</strong><br />{summary.paymentTransactions}</div>
      </div>
      <SourceTransactions sources={deliverySources} title={t("driverEarnings.deliveryTransactions")} />
      <SourceTransactions sources={collectionSources} title={t("driverEarnings.collectionTransactions")} />
      <PaymentHistory payments={Array.isArray(summary.payments) ? summary.payments : []} />
    </section>
  );
}

function SourceTransactions({ sources, title }: { sources: readonly EarningsSource[]; title: string }) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const money = (value: string) => formatCurrency(value, "AED", locale);
  return (
    <div className="card table-shell">
      <h3>{title}</h3>
      {sources.length === 0 ? <p className="empty-state">{t("driverEarnings.noEarnings")}</p> : (
        <table><thead><tr>
          <th>{t("driverEarnings.serialNumber")}</th><th>{t("driverEarnings.serialDate")}</th>
          <th>{t("driverEarnings.orderNumber")}</th><th>{t("driverEarnings.referenceNumber")}</th>
          <th>{t("driverEarnings.date")}</th><th>{t("driverEarnings.trader")}</th>
          <th>{t("driverEarnings.customer")}</th><th>{t("driverEarnings.rate")}</th>
          <th>{t("driverEarnings.earned")}</th><th>{t("driverEarnings.interimPaid")}</th>
          <th>{t("driverEarnings.payrollPaid")}</th><th>{t("driverEarnings.outstanding")}</th>
          <th>{t("driverEarnings.status")}</th><th>{t("driverEarnings.action")}</th>
        </tr></thead><tbody>{sources.map((source) => <tr key={`${source.sourceType}-${source.id}`}>
          <td>{source.serialNumber ?? "—"}</td><td>{source.serialDate ?? source.date}</td>
          <td>{source.orderNumber ? <a href={`/orders/${encodeURIComponent(source.orderNumber)}`}>{source.orderNumber}</a> : "—"}</td>
          <td>{source.referenceNumber ?? "—"}</td><td>{source.date}</td><td>{source.trader ?? "—"}</td>
          <td>{source.customer ?? "—"}</td><td>{money(source.rate)}</td><td>{money(source.gross)}</td>
          <td>{money(source.interimPaid)}</td><td>{money(source.payrollAllocated)}</td><td>{money(source.outstanding)}</td>
          <td>{t(`driverEarnings.${source.paymentStatus}`)}</td>
          <td>{source.orderNumber ? <a href={`/orders/${encodeURIComponent(source.orderNumber)}`}>{t("driverEarnings.viewOrder")}</a> : "—"}</td>
        </tr>)}</tbody></table>
      )}
    </div>
  );
}

function PaymentHistory({ payments }: { payments: readonly Record<string, unknown>[] }) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  return <div className="card table-shell"><h3>{t("driverEarnings.paymentHistory")}</h3>
    {payments.length === 0 ? <p className="empty-state">{t("driverEarnings.noPayments")}</p> :
      <table><thead><tr><th>{t("driverEarnings.reference")}</th><th>{t("driverEarnings.date")}</th>
      <th>{t("driverEarnings.transactionType")}</th><th>{t("driverEarnings.amount")}</th>
      <th>{t("driverEarnings.account")}</th><th>{t("driverEarnings.status")}</th></tr></thead>
      <tbody>{payments.map((payment, index) => <tr key={String(payment.id ?? index)}>
        <td>{String(payment.paymentNumber ?? payment.reference ?? "—")}</td><td>{String(payment.paymentDate ?? "—")}</td>
        <td>{String(payment.transactionType ?? "—")}</td><td>{formatCurrency(String(payment.amount ?? "0"), "AED", locale)}</td>
        <td>{String(payment.account ?? payment.method ?? "—")}</td><td>{String(payment.status ?? "—")}</td>
      </tr>)}</tbody></table>}
  </div>;
}

function DeliveryTransactions({
  sources,
  title,
}: {
  sources: readonly DeliverySource[];
  title: string;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const money = (value: string) => formatCurrency(value, "AED", locale);
  if (sources.length === 0)
    return <div className="empty-state">{t("driverEarnings.noEligibleDeliveryTransactions")}</div>;
  return (
    <div className="card table-shell">
      <h3>{title}</h3>
      <p>{t("driverEarnings.sourceAllocationPeriodLevel")}</p>
      <table>
        <thead>
          <tr>
            <th>{t("driverEarnings.serialNumber")}</th>
            <th>{t("driverEarnings.serialDate")}</th>
            <th>{t("driverEarnings.orderNumber")}</th>
            <th>{t("driverEarnings.referenceNumber")}</th>
            <th>{t("driverEarnings.deliveryDate")}</th>
            <th>{t("driverEarnings.trader")}</th>
            <th>{t("driverEarnings.customer")}</th>
            <th>{t("driverEarnings.driver")}</th>
            <th>{t("driverEarnings.rate")}</th>
            <th>{t("driverEarnings.earned")}</th>
            <th>{t("driverEarnings.interimPaid")}</th>
            <th>{t("driverEarnings.payrollPaid")}</th>
            <th>{t("driverEarnings.outstanding")}</th>
            <th>{t("driverEarnings.status")}</th>
            <th>{t("driverEarnings.action")}</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={source.id}>
              <td>{source.serialNumber ?? "—"}</td>
              <td>{source.serialDate}</td>
              <td>
                <a href={`/orders/${encodeURIComponent(source.orderNumber)}`}>
                  {source.orderNumber}
                </a>
              </td>
              <td>{source.referenceNumber ?? "—"}</td>
              <td>{source.deliveryDate}</td>
              <td>{source.trader ?? "—"}</td>
              <td>{source.customer ?? "—"}</td>
              <td>{source.driver}</td>
              <td>{money(source.rate)}</td>
              <td>{money(source.earned)}</td>
              <td>—</td>
              <td>—</td>
              <td>—</td>
              <td>—</td>
              <td>
                <a href={`/orders/${encodeURIComponent(source.orderNumber)}`}>
                  {t("driverEarnings.viewOrder")}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={9}>{t("driverEarnings.detailTotal")}</th>
            <th>
              {money(sources.reduce((sum, source) => sum + Number(source.earned), 0).toFixed(2))}
            </th>
            <th colSpan={5} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function PeriodSourceDetails({ period }: { period: EarningPeriod }) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const sourceTotal = (period.deliverySources ?? []).reduce(
    (sum, source) => sum + Number(source.earned),
    0,
  );
  const reconciles =
    (period.deliverySources ?? []).length === period.deliveredOrders &&
    sourceTotal.toFixed(2) === Number(period.deliveryEarnings).toFixed(2);
  return (
    <section className="stack" aria-label={t("driverEarnings.periodDetails")}>
      <div className="card summary-grid">
        <div>
          <strong>{t("driverEarnings.period")}</strong>
          <br />
          {formatDate(`${period.dateFrom}T12:00:00Z`, locale)} –{" "}
          {formatDate(`${period.dateTo}T12:00:00Z`, locale)}
        </div>
        <div>
          <strong>{t("driverEarnings.totalEarnings")}</strong>
          <br />
          {formatCurrency(period.totalEarnings, "AED", locale)}
        </div>
        <div>
          <strong>{t("driverEarnings.interimPaid")}</strong>
          <br />
          {formatCurrency(period.interimPaid, "AED", locale)}
        </div>
        <div>
          <strong>{t("driverEarnings.payrollPaid")}</strong>
          <br />
          {formatCurrency(period.payrollPaid, "AED", locale)}
        </div>
        <div>
          <strong>{t("driverEarnings.outstanding")}</strong>
          <br />
          {formatCurrency(period.outstanding, "AED", locale)}
        </div>
      </div>
      {!reconciles ? (
        <div className="alert alert-error">{t("driverEarnings.lockedDeliveryIntegrityError")}</div>
      ) : null}
      <DeliveryTransactions
        sources={period.deliverySources ?? []}
        title={t("driverEarnings.deliveryTransactions")}
      />
      <CollectionDetail
        amount={period.collectionEarnings}
        count={period.collectedOrders}
        rate={period.collectionRate}
        title={t("driverEarnings.collectionEarningDetail")}
      />
      <CollectionTransactions sources={period.collectionSources ?? []} />
    </section>
  );
}

function CollectionTransactions({ sources }: { sources: readonly CollectionSource[] }) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  if (sources.length === 0) return null;
  return (
    <div className="card table-shell">
      <h3>{t("driverEarnings.collectionTransactions")}</h3>
      <table><thead><tr>
        <th>{t("driverEarnings.serialNumber")}</th><th>{t("driverEarnings.serialDate")}</th>
        <th>{t("driverEarnings.orderNumber")}</th><th>{t("driverEarnings.referenceNumber")}</th>
        <th>{t("driverEarnings.customer")}</th><th>{t("driverEarnings.area")}</th>
        <th>{t("driverEarnings.closeDate")}</th><th>{t("driverEarnings.rate")}</th>
        <th>{t("driverEarnings.earned")}</th><th>{t("driverEarnings.action")}</th>
      </tr></thead><tbody>{sources.map((source) => <tr key={source.id}>
        <td>{source.serialNumber ?? "—"}</td><td>{source.serialDate}</td>
        <td>{source.orderNumber}</td><td>{source.referenceNumber ?? "—"}</td>
        <td>{source.customer}</td><td>{source.area}</td><td>{source.closeDate}</td>
        <td>{formatCurrency(source.rate, "AED", locale)}</td>
        <td>{formatCurrency(source.earned, "AED", locale)}</td>
        <td><a href={`/orders/${encodeURIComponent(source.orderNumber)}`}>{t("driverEarnings.viewOrder")}</a></td>
      </tr>)}</tbody></table>
    </div>
  );
}

function CollectionDetail({
  amount,
  count,
  rate,
  title,
}: {
  amount: string;
  count: number;
  rate: string;
  title: string;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  return (
    <div className="card">
      <h3>{title}</h3>
      <p>
        {t("driverEarnings.collectedOrderCount")}: {formatNumber(count, locale)}
      </p>
      <p>
        {t("driverEarnings.collectionRate")}: {formatCurrency(rate, "AED", locale)}
      </p>
      <p>
        {t("driverEarnings.collection")}: {formatCurrency(amount, "AED", locale)}
      </p>
    </div>
  );
}
