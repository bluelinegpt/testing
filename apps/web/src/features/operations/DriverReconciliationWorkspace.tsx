import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import {
  type CompanyBankAccount,
  type PagedResponse,
  reconciliationPageSizes,
  type ReconciliationPageSize,
} from "../../api/contracts.js";
import { Modal } from "../../components/Modal.js";
import { PageHeader } from "../../components/PageHeader.js";

import { DriverCashStatusLabel } from "./DriverCashStatus.js";
import { materialFingerprint, useIdempotencyKey } from "./useIdempotencyKey.js";

interface ReconciliationDriver {
  readonly accountStatus: string;
  readonly code: string;
  readonly driverType: string;
  readonly id: string;
  readonly mobileNumber: string;
  readonly name: string;
  readonly pendingCollectionTotal: string;
  readonly pendingOrderCount: number;
}

interface EligibleOrder {
  readonly amountCollected: string;
  readonly areaName: string;
  readonly cashStatus: string;
  readonly cashStatusLabel: string;
  readonly customerName: string;
  readonly deliveredAt: string | null;
  readonly id: string;
  readonly orderNumber: string;
  readonly traderName: string;
}

interface EligibleOrdersPage extends PagedResponse<EligibleOrder> {
  readonly filteredTotals: { readonly collectionTotal: string; readonly orderCount: number };
}

interface ExpenseTypeOption {
  readonly code: string;
  readonly id: string;
  readonly name: string;
  readonly requiresDescription: boolean;
}

interface PreviewResult {
  readonly difference: string;
  readonly driverId: string;
  readonly driverPayableDeduction: string;
  readonly expenseTotal: string;
  readonly grossCollections: string;
  readonly netAmountExpected: string;
  readonly orderCount: number;
  readonly paymentTotal: string;
  readonly warnings: readonly string[];
}

interface ConfirmResult {
  readonly netAmountExpected: string;
  readonly reconciliationId: string;
  readonly reconciliationNumber: string;
}

interface ExpenseRow {
  amount: string;
  expenseTypeId: string;
  notes: string;
  reference: string;
}

interface PaymentRow {
  amount: string;
  bankAccountId: string;
  bankReference: string;
  paymentDate: string;
  paymentMethod: "bank_transfer" | "cash";
}

const emptyOrderFilters = {
  areaId: "",
  deliveredFrom: "",
  deliveredTo: "",
  search: "",
  traderId: "",
};

function money(value: string | number): string {
  return (Math.round(Number(value || 0) * 100) / 100).toFixed(2);
}

export function DriverReconciliationWorkspace({
  api,
  onNavigate,
}: {
  api: ApiClient;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();

  // Step 1 — Driver
  const [driverSearch, setDriverSearch] = useState("");
  const [drivers, setDrivers] = useState<readonly ReconciliationDriver[]>([]);
  const [driver, setDriver] = useState<ReconciliationDriver>();
  const [pendingDriver, setPendingDriver] = useState<ReconciliationDriver>();

  // Step 2 — Orders
  const [orderFilters, setOrderFilters] = useState(emptyOrderFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<ReconciliationPageSize>(25);
  const [ordersPage, setOrdersPage] = useState<EligibleOrdersPage>();
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [excludedIds, setExcludedIds] = useState<ReadonlySet<string>>(new Set());

  // Steps 3 and 4 — expenses and payments
  const [expenses, setExpenses] = useState<readonly ExpenseRow[]>([]);
  const [payments, setPayments] = useState<readonly PaymentRow[]>([
    { amount: "", bankAccountId: "", bankReference: "", paymentDate: "", paymentMethod: "cash" },
  ]);
  const [expenseTypes, setExpenseTypes] = useState<readonly ExpenseTypeOption[]>([]);
  const [banks, setBanks] = useState<readonly CompanyBankAccount[]>([]);

  // Step 5 — preview and confirmation
  const [preview, setPreview] = useState<PreviewResult>();
  const [previewStale, setPreviewStale] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<ConfirmResult>();
  const [error, setError] = useState<string>();
  const idempotency = useIdempotencyKey();
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parameters = new URLSearchParams({ pageSize: "25" });
    if (driverSearch.trim() !== "") parameters.set("search", driverSearch.trim());
    let active = true;
    api
      .get<PagedResponse<ReconciliationDriver>>(`operations/cash/drivers?${parameters.toString()}`)
      .then((result) => active && setDrivers(result.items))
      .catch(() => active && setDrivers([]));
    return () => {
      active = false;
    };
  }, [api, driverSearch]);

  useEffect(() => {
    Promise.all([
      api.get<readonly ExpenseTypeOption[]>("operations/cash/expense-types"),
      api.get<readonly CompanyBankAccount[]>("configuration/bank-accounts"),
    ])
      .then(([types, accounts]) => {
        setExpenseTypes(types);
        setBanks(accounts.filter((account) => account.isActive));
      })
      .catch(() => setError(t("common.loadFailed")));
  }, [api, t]);

  const loadOrders = useCallback(() => {
    if (driver === undefined) return;
    const parameters = new URLSearchParams({
      driverId: driver.id,
      page: String(page),
      pageSize: String(pageSize),
    });
    for (const [key, value] of Object.entries(orderFilters)) {
      if (value.trim() !== "") parameters.set(key, value.trim());
    }
    api
      .get<EligibleOrdersPage>(`operations/cash/eligible-orders?${parameters.toString()}`)
      .then(setOrdersPage)
      .catch(() => setError(t("common.loadFailed")));
  }, [api, driver, orderFilters, page, pageSize, t]);

  useEffect(() => loadOrders(), [loadOrders]);

  const selection = useMemo(
    () =>
      allMatching
        ? {
            ...orderFilters,
            driverId: driver?.id ?? "",
            excludedOrderIds: [...excludedIds],
            selectionMode: "filter" as const,
          }
        : { excludedOrderIds: [], orderIds: [...selectedIds], selectionMode: "ids" as const },
    [allMatching, driver, excludedIds, orderFilters, selectedIds],
  );

  const selectedCount = allMatching
    ? Math.max(0, (ordersPage?.filteredTotals.orderCount ?? 0) - excludedIds.size)
    : selectedIds.size;

  const payload = useMemo(
    () => ({
      ...selection,
      expenses: expenses
        .filter((row) => row.expenseTypeId !== "" && row.amount !== "")
        .map((row) => ({
          amount: Number(money(row.amount)),
          expenseTypeId: row.expenseTypeId,
          ...(row.notes.trim() === "" ? {} : { notes: row.notes.trim() }),
          ...(row.reference.trim() === "" ? {} : { reference: row.reference.trim() }),
        })),
      payments: payments
        .filter((row) => row.amount !== "")
        .map((row) => ({
          amount: Number(money(row.amount)),
          paymentMethod: row.paymentMethod,
          ...(row.paymentMethod === "bank_transfer"
            ? {
                bankAccountId: row.bankAccountId,
                bankReference: row.bankReference.trim(),
                ...(row.paymentDate === "" ? {} : { paymentDate: row.paymentDate }),
              }
            : {}),
        })),
    }),
    [expenses, payments, selection],
  );

  const fingerprint = useMemo(
    () =>
      materialFingerprint({
        excludedOrderIds: payload.excludedOrderIds,
        expenses: payload.expenses.map((row) => ({ ...row, amount: String(row.amount) })),
        orderIds: "orderIds" in payload ? payload.orderIds : [],
        payments: payload.payments.map((row) => ({ ...row, amount: String(row.amount) })),
        selectionMode: payload.selectionMode,
      }),
    [payload],
  );

  // A material change invalidates the preview until the backend recalculates.
  useEffect(() => {
    setPreviewStale(true);
  }, [fingerprint]);

  const runPreview = useCallback(async () => {
    if (selectedCount === 0) {
      setPreview(undefined);
      return;
    }
    setError(undefined);
    try {
      const result = await api.post<PreviewResult>(
        "operations/cash/reconciliations/preview",
        payload,
      );
      setPreview(result);
      setPreviewStale(false);
    } catch (requestError) {
      setPreview(undefined);
      setError(
        requestError instanceof ApiError
          ? requestError.message
          : t("operations.reconciliationInvalid"),
      );
    }
  }, [api, payload, selectedCount, t]);

  const changeDriver = (next: ReconciliationDriver) => {
    const hasEnteredData =
      selectedIds.size > 0 || allMatching || expenses.length > 0 || payments.some((p) => p.amount);
    if (driver !== undefined && driver.id !== next.id && hasEnteredData) {
      setPendingDriver(next);
      return;
    }
    applyDriver(next);
  };

  const applyDriver = (next: ReconciliationDriver) => {
    setDriver(next);
    setPendingDriver(undefined);
    setPage(1);
    setOrderFilters(emptyOrderFilters);
    setSelectedIds(new Set());
    setExcludedIds(new Set());
    setAllMatching(false);
    setExpenses([]);
    setPayments([
      { amount: "", bankAccountId: "", bankReference: "", paymentDate: "", paymentMethod: "cash" },
    ]);
    setPreview(undefined);
    setSuccess(undefined);
    idempotency.reset();
  };

  const pageIds = ordersPage?.items.map((order) => order.id) ?? [];
  const pageSelected =
    pageIds.length > 0 &&
    pageIds.every((id) => (allMatching ? !excludedIds.has(id) : selectedIds.has(id)));

  const toggleOrder = (id: string) => {
    const update = (current: ReadonlySet<string>) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    };
    if (allMatching) setExcludedIds(update);
    else setSelectedIds(update);
  };

  const toggleCurrentPage = () => {
    const update = (current: ReadonlySet<string>) => {
      const next = new Set(current);
      for (const id of pageIds) {
        if (allMatching === pageSelected) next.add(id);
        else next.delete(id);
      }
      return next;
    };
    if (allMatching) setExcludedIds(update);
    else
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of pageIds) {
          if (pageSelected) next.delete(id);
          else next.add(id);
        }
        return next;
      });
  };

  const clearSelection = () => {
    setAllMatching(false);
    setSelectedIds(new Set());
    setExcludedIds(new Set());
  };

  const difference = preview === undefined ? null : Number(preview.difference);
  const netExpected = preview === undefined ? null : Number(preview.netAmountExpected);
  const paymentAmountInvalid = payload.payments.some((row) => row.amount <= 0);
  // Immediate client-side echo of the same formula the backend applies.
  const runningCollections = money(
    allMatching
      ? (ordersPage?.filteredTotals.collectionTotal ?? 0)
      : (ordersPage?.items ?? [])
          .filter((order) => selectedIds.has(order.id))
          .reduce((total, order) => total + Number(order.amountCollected), 0),
  );
  const runningExpenses = money(
    payload.expenses.reduce((total, row) => total + Number(row.amount), 0),
  );
  const runningNet = money(Number(runningCollections) - Number(runningExpenses));
  const runningPaid = money(payload.payments.reduce((total, row) => total + Number(row.amount), 0));
  const runningDifference = money(Number(runningPaid) - Number(runningNet));

  const zeroNetRuleSatisfied = netExpected !== 0 || payload.payments.length === 0;
  // A row-level expense problem the operator can fix before submitting.
  const expenseNeedingDescription = expenses.find((row) => {
    const type = expenseTypes.find((option) => option.id === row.expenseTypeId);
    return type?.requiresDescription === true && row.notes.trim() === "";
  });
  const bankRowMissingReference = payments.find(
    (row) =>
      row.paymentMethod === "bank_transfer" &&
      row.amount !== "" &&
      (row.bankAccountId === "" || row.bankReference.trim() === ""),
  );

  /**
   * The single reason confirmation is blocked, in the order the operator would
   * naturally resolve them. Returned as a translation key so the reason is shown
   * next to the button and announced through aria-describedby, rather than
   * relying on a disabled-button tooltip.
   */
  // `driver === undefined` is deliberately absent: this surface does not render
  // until a Driver is selected, so that state is unreachable here. The guard
  // remains in canConfirm via selectedCount, which cannot be positive without one.
  const blockedReasonKey =
    selectedCount === 0
      ? "operations.blockedNoOrders"
      : expenseNeedingDescription !== undefined
        ? "operations.blockedExpenseDescription"
        : bankRowMissingReference !== undefined
          ? "operations.blockedBankReference"
          : paymentAmountInvalid
            ? "operations.blockedPaymentAmount"
            : saving
              ? "operations.blockedInProgress"
              : preview === undefined
                ? "operations.blockedNoPreview"
                : previewStale
                  ? "operations.blockedStalePreview"
                  : netExpected !== null && netExpected < 0
                    ? "operations.blockedNegativeNet"
                    : !zeroNetRuleSatisfied
                      ? "operations.blockedZeroNetPayments"
                      : difference !== 0
                        ? "operations.blockedDifference"
                        : undefined;

  const canConfirm = blockedReasonKey === undefined;

  const confirm = async () => {
    if (!canConfirm || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await api.post<ConfirmResult>(
        "operations/cash/reconciliations/selected",
        payload,
        { "X-Idempotency-Key": idempotency.keyFor(fingerprint) },
      );
      setSuccess(result);
      setReviewOpen(false);
      idempotency.reset();
      clearSelection();
      setExpenses([]);
      setPayments([
        {
          amount: "",
          bankAccountId: "",
          bankReference: "",
          paymentDate: "",
          paymentMethod: "cash",
        },
      ]);
      setPreview(undefined);
      loadOrders();
      statusRef.current?.focus();
    } catch (requestError) {
      setError(
        requestError instanceof ApiError
          ? requestError.message
          : t("operations.reconciliationFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  const total = ordersPage?.total ?? 0;
  const pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);

  return (
    <>
      <PageHeader
        eyebrow={t("nav.driverCashReconciliation")}
        title={t("operations.newReconciliation")}
      />

      <div aria-live="polite" className="sr-live" ref={statusRef} tabIndex={-1}>
        {success === undefined
          ? ""
          : t("operations.reconciliationCreated", {
              reference: success.reconciliationNumber,
            })}
      </div>

      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {success === undefined ? null : (
        <div className="alert alert-success" role="status">
          <strong>{success.reconciliationNumber}</strong>{" "}
          {t("operations.reconciliationCreatedShort")}{" "}
          <button onClick={() => onNavigate("/driver-cash-reconciliation")} type="button">
            {t("operations.viewDetails")}
          </button>
        </div>
      )}

      {/* Step 1 — Driver */}
      <section aria-labelledby="step-driver" className="workspace-step">
        <h2 id="step-driver">{t("operations.stepSelectDriver")}</h2>
        <label className="field">
          <span>{t("operations.searchDrivers")}</span>
          <input
            onChange={(event) => setDriverSearch(event.target.value)}
            placeholder={t("operations.searchDrivers")}
            type="search"
            value={driverSearch}
          />
        </label>
        <table>
          <caption className="sr-only">{t("operations.driverResults")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("operations.driverCode")}</th>
              <th scope="col">{t("operations.driver")}</th>
              <th scope="col">{t("operations.mobile")}</th>
              <th scope="col">{t("operations.driverType")}</th>
              <th scope="col">{t("operations.status")}</th>
              <th scope="col">{t("operations.pendingOrders")}</th>
              <th scope="col">{t("operations.pendingCollectionTotal")}</th>
              <th scope="col">
                <span className="sr-only">{t("common.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {drivers.map((row) => (
              <tr aria-selected={driver?.id === row.id} key={row.id}>
                <td>{row.code}</td>
                <td>{row.name}</td>
                <td>{row.mobileNumber}</td>
                <td>{row.driverType}</td>
                <td>{row.accountStatus}</td>
                <td>{row.pendingOrderCount}</td>
                <td>{money(row.pendingCollectionTotal)}</td>
                <td>
                  <button onClick={() => changeDriver(row)} type="button">
                    {driver?.id === row.id ? t("common.selected") : t("common.select")}
                  </button>
                </td>
              </tr>
            ))}
            {drivers.length === 0 ? (
              <tr>
                <td className="empty-state" colSpan={8}>
                  {t("operations.noDrivers")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {driver === undefined ? null : (
        <>
          {/* Running summary: client arithmetic for immediate feedback only.
              The backend preview remains the financial authority, so these
              figures are labelled as an estimate until Calculate is pressed. */}
          <aside aria-label={t("operations.runningSummary")} className="running-summary no-print">
            <span>
              {t("operations.selectedCollections")}{" "}
              <strong data-running="collections">{runningCollections}</strong>
            </span>
            <span>
              {t("operations.driverPayableDeduction")}{" "}
              <strong data-running="deduction">0.00</strong>
            </span>
            <span>
              {t("operations.expenses")} <strong data-running="expenses">{runningExpenses}</strong>
            </span>
            <span>
              {t("operations.netExpected")} <strong data-running="net">{runningNet}</strong>
            </span>
            <span>
              {t("operations.paymentTotal")} <strong data-running="paid">{runningPaid}</strong>
            </span>
            <span data-running-difference={runningDifference}>
              {t("operations.difference")}{" "}
              <strong data-running="difference">{runningDifference}</strong>
            </span>
            <span className="running-summary-state">
              {preview === undefined || previewStale
                ? t("operations.summaryEstimate")
                : t("operations.summaryConfirmedPreview")}
            </span>
          </aside>
          {/* Step 2 — Orders */}
          <section aria-labelledby="step-orders" className="workspace-step">
            <h2 id="step-orders">{t("operations.stepSelectOrders")}</h2>
            <div className="table-toolbar no-print">
              <label>
                <span className="sr-only">{t("operations.searchOrders")}</span>
                <input
                  onChange={(event) => {
                    setPage(1);
                    setOrderFilters({ ...orderFilters, search: event.target.value });
                  }}
                  placeholder={t("operations.searchOrders")}
                  type="search"
                  value={orderFilters.search}
                />
              </label>
              <label>
                {t("operations.dateFrom")}
                <input
                  onChange={(event) => {
                    setPage(1);
                    setOrderFilters({ ...orderFilters, deliveredFrom: event.target.value });
                  }}
                  type="date"
                  value={orderFilters.deliveredFrom}
                />
              </label>
              <label>
                {t("operations.dateTo")}
                <input
                  onChange={(event) => {
                    setPage(1);
                    setOrderFilters({ ...orderFilters, deliveredTo: event.target.value });
                  }}
                  type="date"
                  value={orderFilters.deliveredTo}
                />
              </label>
              <label>
                {t("operations.pageSize")}
                <select
                  onChange={(event) => {
                    setPage(1);
                    setPageSize(Number(event.target.value) as ReconciliationPageSize);
                  }}
                  value={pageSize}
                >
                  {reconciliationPageSizes.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="selection-bar">
              <button onClick={toggleCurrentPage} type="button">
                {t("operations.selectCurrentPage")}
              </button>
              <button
                onClick={() => {
                  setAllMatching(true);
                  setSelectedIds(new Set());
                  setExcludedIds(new Set());
                }}
                type="button"
              >
                {t("operations.selectAllMatching", {
                  count: ordersPage?.filteredTotals.orderCount ?? 0,
                })}
              </button>
              <button onClick={clearSelection} type="button">
                {t("operations.clearSelection")}
              </button>
              <span>
                {t("operations.selectedCount", { count: selectedCount })}{" "}
                {allMatching ? t("operations.allMatchingMode") : t("operations.currentPageMode")}
              </span>
            </div>
            <table>
              <caption className="sr-only">{t("operations.eligibleOrders")}</caption>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">{t("common.select")}</span>
                  </th>
                  <th scope="col">{t("operations.order")}</th>
                  <th scope="col">{t("operations.deliveryDate")}</th>
                  <th scope="col">{t("operations.trader")}</th>
                  <th scope="col">{t("operations.customer")}</th>
                  <th scope="col">{t("operations.areaField")}</th>
                  <th scope="col">{t("operations.amount")}</th>
                  <th scope="col">{t("operations.cashStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {(ordersPage?.items ?? []).map((order) => {
                  const checked = allMatching
                    ? !excludedIds.has(order.id)
                    : selectedIds.has(order.id);
                  return (
                    <tr key={order.id}>
                      <td>
                        <input
                          aria-label={t("operations.selectOrder", { order: order.orderNumber })}
                          checked={checked}
                          onChange={() => toggleOrder(order.id)}
                          type="checkbox"
                        />
                      </td>
                      <td>{order.orderNumber}</td>
                      <td>{order.deliveredAt ?? ""}</td>
                      <td>{order.traderName}</td>
                      <td>{order.customerName}</td>
                      <td>{order.areaName}</td>
                      <td>{money(order.amountCollected)}</td>
                      <td>
                        <DriverCashStatusLabel value={order.cashStatus} />
                      </td>
                    </tr>
                  );
                })}
                {(ordersPage?.items.length ?? 0) === 0 ? (
                  <tr>
                    <td className="empty-state" colSpan={8}>
                      {t("operations.noEligibleOrders")}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <nav aria-label={t("common.pagination")} className="pagination no-print">
              <button disabled={page <= 1} onClick={() => setPage(page - 1)} type="button">
                {t("common.previous")}
              </button>
              <span>{t("common.pageOf", { page, pageCount })}</span>
              <button disabled={page >= pageCount} onClick={() => setPage(page + 1)} type="button">
                {t("common.next")}
              </button>
            </nav>
          </section>

          {/* Step 3 — Expenses */}
          <section aria-labelledby="step-expenses" className="workspace-step">
            <h2 id="step-expenses">{t("operations.stepExpenses")}</h2>
            {expenses.map((row, index) => {
              const type = expenseTypes.find((option) => option.id === row.expenseTypeId);
              return (
                <div className="reconciliation-row" key={index}>
                  <label>
                    {t("operations.expenseType")}
                    <select
                      onChange={(event) =>
                        setExpenses(
                          expenses.map((current, position) =>
                            position === index
                              ? { ...current, expenseTypeId: event.target.value }
                              : current,
                          ),
                        )
                      }
                      value={row.expenseTypeId}
                    >
                      <option value="">{t("common.select")}</option>
                      {expenseTypes.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t("operations.amount")}
                    <input
                      min="0.01"
                      onChange={(event) =>
                        setExpenses(
                          expenses.map((current, position) =>
                            position === index
                              ? { ...current, amount: event.target.value }
                              : current,
                          ),
                        )
                      }
                      step="0.01"
                      type="number"
                      value={row.amount}
                    />
                  </label>
                  <label>
                    {t("operations.description")}
                    {type?.requiresDescription === true ? " *" : ""}
                    <input
                      onChange={(event) =>
                        setExpenses(
                          expenses.map((current, position) =>
                            position === index
                              ? { ...current, notes: event.target.value }
                              : current,
                          ),
                        )
                      }
                      required={type?.requiresDescription === true}
                      type="text"
                      value={row.notes}
                    />
                  </label>
                  <label>
                    {t("operations.reference")}
                    <input
                      onChange={(event) =>
                        setExpenses(
                          expenses.map((current, position) =>
                            position === index
                              ? { ...current, reference: event.target.value }
                              : current,
                          ),
                        )
                      }
                      type="text"
                      value={row.reference}
                    />
                  </label>
                  <button
                    onClick={() =>
                      setExpenses(expenses.filter((_, position) => position !== index))
                    }
                    type="button"
                  >
                    {t("common.remove")}
                  </button>
                </div>
              );
            })}
            <button
              onClick={() =>
                setExpenses([
                  ...expenses,
                  { amount: "", expenseTypeId: "", notes: "", reference: "" },
                ])
              }
              type="button"
            >
              {t("operations.addExpense")}
            </button>
          </section>

          {/* Step 4 — Payments */}
          <section aria-labelledby="step-payments" className="workspace-step">
            <h2 id="step-payments">{t("operations.stepPayments")}</h2>
            {payments.map((row, index) => (
              <div className="reconciliation-row" key={index}>
                <label>
                  {t("operations.paymentMethod")}
                  <select
                    onChange={(event) =>
                      setPayments(
                        payments.map((current, position) =>
                          position === index
                            ? {
                                ...current,
                                bankAccountId: "",
                                bankReference: "",
                                paymentMethod: event.target.value as "bank_transfer" | "cash",
                              }
                            : current,
                        ),
                      )
                    }
                    value={row.paymentMethod}
                  >
                    <option value="cash">{t("operations.cash")}</option>
                    <option value="bank_transfer">{t("operations.bankTransfer")}</option>
                  </select>
                </label>
                <label>
                  {t("operations.amount")}
                  <input
                    min="0.01"
                    onChange={(event) =>
                      setPayments(
                        payments.map((current, position) =>
                          position === index ? { ...current, amount: event.target.value } : current,
                        ),
                      )
                    }
                    step="0.01"
                    type="number"
                    value={row.amount}
                  />
                </label>
                {row.paymentMethod === "bank_transfer" ? (
                  <>
                    <label>
                      {t("operations.bankAccount")}
                      <select
                        onChange={(event) =>
                          setPayments(
                            payments.map((current, position) =>
                              position === index
                                ? { ...current, bankAccountId: event.target.value }
                                : current,
                            ),
                          )
                        }
                        value={row.bankAccountId}
                      >
                        <option value="">{t("common.select")}</option>
                        {banks.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.bankName} — {account.accountName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t("operations.bankReference")}
                      <input
                        onChange={(event) =>
                          setPayments(
                            payments.map((current, position) =>
                              position === index
                                ? { ...current, bankReference: event.target.value }
                                : current,
                            ),
                          )
                        }
                        type="text"
                        value={row.bankReference}
                      />
                    </label>
                    <label>
                      {t("operations.paymentDate")}
                      <input
                        onChange={(event) =>
                          setPayments(
                            payments.map((current, position) =>
                              position === index
                                ? { ...current, paymentDate: event.target.value }
                                : current,
                            ),
                          )
                        }
                        type="date"
                        value={row.paymentDate}
                      />
                    </label>
                  </>
                ) : null}
                <button
                  onClick={() => setPayments(payments.filter((_, position) => position !== index))}
                  type="button"
                >
                  {t("common.remove")}
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                setPayments([
                  ...payments,
                  {
                    amount: "",
                    bankAccountId: "",
                    bankReference: "",
                    paymentDate: "",
                    paymentMethod: "cash",
                  },
                ])
              }
              type="button"
            >
              {t("operations.addPayment")}
            </button>
          </section>

          {/* Step 5 — Review */}
          <section aria-labelledby="step-review" className="workspace-step">
            <h2 id="step-review">{t("operations.stepReview")}</h2>
            <button onClick={() => void runPreview()} type="button">
              {t("operations.calculatePreview")}
            </button>
            {/* The stale and not-yet-calculated explanations live only in the
                blocked-reason area beside Confirm, so each blocked state has a
                single authoritative message. */}
            {preview === undefined ? (
              <p className="empty-state">{t("operations.previewPlaceholder")}</p>
            ) : (
              <div className="reconciliation-summary" data-testid="preview-summary">
                {preview.warnings.map((warning) => (
                  <p className="alert alert-warning" key={warning} role="status">
                    {warning}
                  </p>
                ))}
                <div className="detail-line">
                  <span>{t("operations.selectedCollections")}</span>
                  <span data-summary="collections">{preview.grossCollections}</span>
                </div>
                <div className="detail-line">
                  <span>{t("operations.driverPayableDeduction")}</span>
                  <span data-summary="deduction">{preview.driverPayableDeduction}</span>
                </div>
                <div className="detail-line">
                  <span>{t("operations.expenses")}</span>
                  <span data-summary="expenses">{preview.expenseTotal}</span>
                </div>
                <div className="detail-line detail-line-total">
                  <span>{t("operations.netExpected")}</span>
                  <strong data-summary="net">{preview.netAmountExpected}</strong>
                </div>
                <div className="detail-line">
                  <span>{t("operations.paymentTotal")}</span>
                  <span data-summary="paid">{preview.paymentTotal}</span>
                </div>
                <div className="detail-line">
                  <span>{t("operations.difference")}</span>
                  <strong data-difference={preview.difference}>{preview.difference}</strong>
                </div>
              </div>
            )}
            <button
              aria-describedby={
                blockedReasonKey === undefined ? undefined : "confirm-blocked-reason"
              }
              disabled={!canConfirm}
              onClick={() => setReviewOpen(true)}
              type="button"
            >
              {t("operations.reviewAndConfirm")}
            </button>
            {blockedReasonKey === undefined ? null : (
              <p className="blocked-reason" id="confirm-blocked-reason" role="status">
                {t(blockedReasonKey)}
              </p>
            )}
          </section>
        </>
      )}

      {pendingDriver === undefined ? null : (
        <Modal
          className="confirm-modal"
          closeLabel={t("common.close")}
          onRequestClose={() => setPendingDriver(undefined)}
          title={t("operations.changeDriverTitle")}
          titleId="change-driver-title"
        >
          <p>{t("operations.changeDriverWarning")}</p>
          <div className="row-actions">
            <button onClick={() => setPendingDriver(undefined)} type="button">
              {t("common.cancel")}
            </button>
            <button onClick={() => applyDriver(pendingDriver)} type="button">
              {t("common.continue")}
            </button>
          </div>
        </Modal>
      )}

      {!reviewOpen || preview === undefined || driver === undefined ? null : (
        <Modal
          className="confirm-modal"
          closeLabel={t("common.close")}
          onRequestClose={() => setReviewOpen(false)}
          title={t("operations.confirmReconciliation")}
          titleId="confirm-reconciliation-title"
        >
          <div className="detail-line">
            <span>{t("operations.driver")}</span>
            <strong>
              {driver.code} — {driver.name}
            </strong>
          </div>
          <div className="detail-line">
            <span>{t("operations.orders")}</span>
            <span>{preview.orderCount}</span>
          </div>
          <div className="detail-line">
            <span>{t("operations.selectedCollections")}</span>
            <span>{preview.grossCollections}</span>
          </div>
          <div className="detail-line">
            <span>{t("operations.expenses")}</span>
            <span>{preview.expenseTotal}</span>
          </div>
          <div className="detail-line detail-line-total">
            <span>{t("operations.netExpected")}</span>
            <strong>{preview.netAmountExpected}</strong>
          </div>
          {payload.payments.map((row, index) => (
            <div className="detail-line" key={index}>
              <span>
                {row.paymentMethod === "cash" ? t("operations.cash") : t("operations.bankTransfer")}
              </span>
              <span>{money(row.amount)}</span>
            </div>
          ))}
          <div className="detail-line">
            <span>{t("operations.difference")}</span>
            <strong>{preview.difference}</strong>
          </div>
          <div className="row-actions">
            <button onClick={() => setReviewOpen(false)} type="button">
              {t("common.cancel")}
            </button>
            <button disabled={saving || !canConfirm} onClick={() => void confirm()} type="button">
              {saving ? t("common.saving") : t("operations.confirmReconciliation")}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
