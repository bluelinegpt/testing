import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import { OperationalReference, partyDisplayLabel } from "../operations/OperationalReference.js";
import { AccountingRelatedPanel } from "../accounting/AccountingRelatedPanel.js";
import { type PdfAction, useReconciliationPdfActions } from "../operations/reconciliation-pdf.js";
import { useIdempotencyKey } from "../operations/useIdempotencyKey.js";
import { recordRoute } from "../accounting/accounting-routes.js";
import { useSessionAccess } from "../../app/SessionAccessContext.js";

type FeeTab = "accruals" | "payments" | "reports";
interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}
interface Driver {
  readonly code?: string;
  readonly driverType: string;
  readonly id: string;
  readonly name: string;
}
interface AccrualSummary {
  readonly accruedCount: string;
  readonly accrualCount: string;
  readonly currentPeriodAccrualCount: string;
  readonly currentPeriodEarnedAmount: string;
  readonly driversWithOutstandingBalances: string;
  readonly paidCount: string;
  readonly partiallyPaidCount: string;
  readonly recoveryRequiredCount: string;
  readonly reversedCount: string;
  readonly totalEarned: string;
  readonly totalOutstanding: string;
  readonly totalPaid: string;
  readonly totalRecoveryRequired: string;
}
interface Accrual {
  readonly accrualBusinessDate: string;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly deliveryDate: string;
  readonly driverCode: string;
  readonly driverId: string;
  readonly driverName: string;
  readonly earnedAmount: string;
  readonly feeRate: string;
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly outstandingAmount: string;
  readonly paidAmount: string;
  readonly recoveryAmount: string;
  readonly serialNumber: string;
  readonly source: string;
  readonly status: string;
}
interface AccrualDetail extends Accrual {
  readonly allocations: readonly Record<string, unknown>[];
  readonly fee_rate_version_id?: string;
  readonly rateEffectiveFrom?: string;
  readonly rateEffectiveTo?: string;
  readonly reversal_reason?: string | null;
  readonly reversed_at?: string | null;
}
interface PaymentSummary {
  readonly collectionOffsetCount: string;
  readonly currentPeriodPaidAmount: string;
  readonly currentPeriodPaymentCount: string;
  readonly driversPaid: string;
  readonly paymentCount: string;
  readonly separatePaymentCount: string;
  readonly totalActivePaid: string;
  readonly totalCollectionOffsets: string;
  readonly totalReversed: string;
  readonly totalSeparateCashPayments: string;
}
interface FeePayment {
  readonly activeAllocationCount: number;
  readonly amount: string;
  readonly createdAt: string;
  readonly driverCode: string;
  readonly driverId: string;
  readonly driverName: string;
  readonly externalReference: string | null;
  readonly id: string;
  readonly linkedReconciliationId: string | null;
  readonly linkedReconciliationNumber: string | null;
  readonly paidBy: string;
  readonly paymentDate: string;
  readonly paymentMethod: string;
  readonly paymentNumber: string;
  readonly paymentSource: string;
  readonly reversedAt: string | null;
  readonly status: string;
  readonly voucherReference: string | null;
}
interface FeePaymentAllocation {
  readonly id?: string;
  readonly accrualBusinessDate?: string;
  readonly accrualId: string;
  readonly accrualStatus?: string;
  readonly allocationOrder?: number;
  readonly allocationStatus?: string;
  readonly amount: string;
  readonly deliveryDate?: string;
  readonly earnedAmount?: string;
  readonly orderId?: string;
  readonly orderNumber?: string;
  readonly paidBefore?: string;
  readonly remainingOutstanding?: string;
  readonly reversedAt?: string | null;
  readonly serialNumber?: string;
}
interface FeePaymentDetail extends FeePayment {
  readonly allocations: readonly FeePaymentAllocation[];
  readonly notes: string | null;
  readonly reversal_reason?: string | null;
  readonly reversedBy?: string | null;
}
interface ProposalAllocation {
  readonly accrualId: string;
  readonly amount: string;
  readonly orderNumber: string;
  readonly outstandingBefore: string;
  readonly remainingOutstanding: string;
}
interface Proposal {
  readonly allocations: readonly ProposalAllocation[];
  readonly driverId: string;
  readonly remainingOutstanding: string;
  readonly totalAmount: string;
}
interface ReconcileResult {
  readonly accrualsCreated: number;
  readonly alreadyAccrued: number;
  readonly ambiguousFeeRates: number;
  readonly eligibleOrders: number;
  readonly employeeDriverOrders: number;
  readonly estimatedAccrualCount: number;
  readonly legacyRepresentedOrders: number;
  readonly missingAssignedDrivers: number;
  readonly missingFeeRates: number;
  readonly ordersExamined: number;
  readonly outcomes: readonly {
    readonly orderId?: string;
    readonly orderNumber?: string;
    readonly outcome: string;
  }[];
  readonly preview: boolean;
  readonly reversedHistoricalAccruals: number;
  readonly totalEarnedAmount: string;
}

const blankAccrualFilters = {
  accrualDateFrom: "",
  accrualDateTo: "",
  deliveryDateFrom: "",
  deliveryDateTo: "",
  driver: "",
  driverCode: "",
  orderNumber: "",
  outstandingOnly: false,
  recoveryRequiredOnly: false,
  serialNumber: "",
  source: "",
  status: "",
};
const blankPaymentFilters = {
  dateFrom: "",
  dateTo: "",
  driver: "",
  driverCode: "",
  externalReference: "",
  method: "",
  number: "",
  reconciliation: "",
  source: "",
  status: "",
  voucher: "",
};

function qs(input: Record<string, string | number | boolean | undefined>) {
  const value = new URLSearchParams();
  Object.entries(input).forEach(([key, item]) => {
    if (item !== undefined && item !== "" && item !== false) value.set(key, String(item));
  });
  return value.toString();
}
function errorText(error: unknown, fallback: string) {
  if (error instanceof ApiError)
    return error.details?.length ? `${error.message}\n${error.details.join("\n")}` : error.message;
  return error instanceof Error ? error.message : fallback;
}
function parseMoney(value: string): number | undefined {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER
    ? number
    : undefined;
}
function dubaiToday() {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Dubai",
    year: "numeric",
  }).format(new Date());
}
function pageItems<T>(page: Page<T> | undefined): readonly T[] {
  return Array.isArray(page?.items) ? page.items : [];
}
function proposalRows(
  value: Proposal | readonly ProposalAllocation[] | undefined,
): readonly ProposalAllocation[] {
  if (Array.isArray(value)) return value;
  return value !== undefined && "allocations" in value && Array.isArray(value.allocations)
    ? value.allocations
    : [];
}
function stableFingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableFingerprint(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableFingerprint(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function OutsourcedDriverFeesWorkspace({
  accrualDetailId,
  api,
  onDetailClose,
  paymentDetailId,
  permissions,
}: {
  /** Accrual opened by `/payroll/driver-fees/accruals/:id`. */
  accrualDetailId?: string | undefined;
  api: ApiClient;
  onDetailClose?: (() => void) | undefined;
  /** Fee Payment opened by `/payroll/driver-fees/payments/:id`. */
  paymentDetailId?: string | undefined;
  permissions: readonly string[];
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage?.startsWith("ar") ? "ar" : "en";
  const can = (permission: string) =>
    permissions.includes(permission) || permissions.includes("users_roles.manage");
  const money = (value: string | number | undefined) =>
    new Intl.NumberFormat(language === "ar" ? "ar-AE" : "en-AE", {
      currency: "AED",
      style: "currency",
    }).format(Number(value ?? 0));
  const [tab, setTab] = useState<FeeTab>("accruals");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [summary, setSummary] = useState<AccrualSummary>();
  const [paymentSummary, setPaymentSummary] = useState<PaymentSummary>();
  const [accruals, setAccruals] = useState<Page<Accrual>>();
  const [payments, setPayments] = useState<Page<FeePayment>>();
  const [accrualPage, setAccrualPage] = useState(1);
  const [paymentPage, setPaymentPage] = useState(1);
  const [af, setAf] = useState(blankAccrualFilters);
  const [pf, setPf] = useState(blankPaymentFilters);
  const [reportDriverId, setReportDriverId] = useState("");
  const [dialog, setDialog] = useState<{
    kind: string;
    id?: string;
    driverId?: string;
    payment?: FeePayment;
  }>();
  // The canonical routes drive the SAME dialogs the list already opens, so a
  // Fee accrual or Fee Payment has an address without a second detail screen
  // existing anywhere.
  useEffect(() => {
    if (accrualDetailId !== undefined) {
      setDialog({ id: accrualDetailId, kind: "accrual" });
      setTab("accruals");
    }
  }, [accrualDetailId]);
  useEffect(() => {
    if (paymentDetailId !== undefined) {
      setDialog({ id: paymentDetailId, kind: "payment" });
      setTab("payments");
    }
  }, [paymentDetailId]);
  const closeDialog = useCallback(() => {
    setDialog(undefined);
    // Route-opened dialogs close by returning to the list underneath, which
    // still holds its filters and page.
    if (accrualDetailId !== undefined || paymentDetailId !== undefined) onDetailClose?.();
  }, [accrualDetailId, onDetailClose, paymentDetailId]);

  // Opening a Fee accrual or Fee Payment navigates to its canonical route, so
  // both are addressable and linkable from Accounting. Routes come from the
  // central map.
  const session = useSessionAccess();
  const openRecord = useCallback(
    (kind: "outsourced_driver_fee_accrual" | "outsourced_driver_fee_payment", id: string) => {
      const path = recordRoute(kind, id);
      if (session !== undefined && path !== undefined) {
        session.navigate(path);
        return;
      }
      setDialog({ id, kind: kind === "outsourced_driver_fee_accrual" ? "accrual" : "payment" });
    },
    [session],
  );

  const openReports = (driverId: string) => {
    setReportDriverId(driverId);
    setDialog(undefined);
    setTab("reports");
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [totals, payTotals, accrualPageResult, paymentPageResult] = await Promise.all([
        api.get<AccrualSummary>("operations/payroll/outsourced-driver-fees/summary"),
        api.get<PaymentSummary>("operations/payroll/outsourced-driver-fees/payments/summary"),
        api.get<Page<Accrual>>(
          `operations/payroll/outsourced-driver-fees/accruals?${qs({ ...af, page: accrualPage, pageSize: 25 })}`,
        ),
        api.get<Page<FeePayment>>(
          `operations/payroll/outsourced-driver-fees/payments?${qs({ driver: pf.driver, driverCode: pf.driverCode, externalReference: pf.externalReference, page: paymentPage, pageSize: 25, paymentDateFrom: pf.dateFrom, paymentDateTo: pf.dateTo, paymentMethod: pf.method, paymentNumber: pf.number, paymentSource: pf.source, reconciliation: pf.reconciliation, status: pf.status, voucherReference: pf.voucher })}`,
        ),
      ]);
      setSummary(totals);
      setPaymentSummary(payTotals);
      setAccruals(accrualPageResult);
      setPayments(paymentPageResult);
    } catch (issue) {
      setError(errorText(issue, t("payroll.driverFees.errors.load")));
    } finally {
      setLoading(false);
    }
  }, [api, accrualPage, paymentPage, af, pf, t]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cards = [
    ["earned", money(summary?.totalEarned)],
    ["paid", money(summary?.totalPaid)],
    ["outstanding", money(summary?.totalOutstanding)],
    ["recovery", money(summary?.totalRecoveryRequired)],
    ["drivers", summary?.driversWithOutstandingBalances ?? "0"],
    ["periodAccruals", summary?.currentPeriodAccrualCount ?? "0"],
  ];
  return (
    <section className="driver-fees-workspace">
      <div className="heading-actions driver-fee-actions">
        {can("outsourced_driver_fees.manage") ? (
          <>
            <button onClick={() => setDialog({ kind: "reconcile" })} type="button">
              {t("payroll.driverFees.actions.reconcile")}
            </button>
            <button onClick={() => setDialog({ kind: "backfill" })} type="button">
              {t("payroll.driverFees.actions.backfill")}
            </button>
          </>
        ) : null}
        {can("outsourced_driver_fees.pay") ? (
          <button
            className="button button-primary"
            onClick={() => setDialog({ kind: "pay" })}
            type="button"
          >
            {t("payroll.driverFees.actions.payDriver")}
          </button>
        ) : null}
        <button disabled={loading} onClick={() => void refresh()} type="button">
          {t("common.refresh")}
        </button>
      </div>
      {error ? <div className="alert alert-error">{error}</div> : null}
      <div className="metric-grid">
        {cards.map(([key, value]) => (
          <article
            className={`metric-card ${key === "recovery" ? "metric-card-warning" : ""}`}
            key={key}
          >
            <span>{t(`payroll.driverFees.summary.${key}`)}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </div>
      <div className="summary-secondary">
        {[
          "accrualCount",
          "accruedCount",
          "partiallyPaidCount",
          "paidCount",
          "reversedCount",
          "recoveryRequiredCount",
        ].map((key) => (
          <span className="metric-chip" key={key}>
            {t(`payroll.driverFees.summary.${key}`)}{" "}
            <strong>{String(summary?.[key as keyof AccrualSummary] ?? 0)}</strong>
          </span>
        ))}
        <span className="metric-chip">
          {t("payroll.driverFees.summary.periodPayments")}{" "}
          <strong>{paymentSummary?.currentPeriodPaymentCount ?? 0}</strong>
        </span>
        <span className="metric-chip">
          {t("payroll.driverFees.summary.offsets")}{" "}
          <strong>{paymentSummary?.collectionOffsetCount ?? 0}</strong>
        </span>
      </div>
      <div className="workspace-tabs" role="tablist">
        {(["accruals", "payments", "reports"] as const).map((item) => (
          <button
            aria-selected={tab === item}
            key={item}
            onClick={() => setTab(item)}
            role="tab"
            type="button"
          >
            {t(`payroll.driverFees.tabs.${item}`)}
          </button>
        ))}
      </div>
      {tab === "accruals" ? (
        <AccrualTable
          canPay={can("outsourced_driver_fees.pay")}
          canReverse={can("outsourced_driver_fees.reverse")}
          filters={af}
          money={money}
          onFilters={(value) => {
            setAccrualPage(1);
            setAf(value);
          }}
          onOpen={(id) => openRecord("outsourced_driver_fee_accrual", id)}
          onPay={(driverId) => setDialog({ kind: "pay", driverId })}
          onReports={openReports}
          onReverse={(id) => setDialog({ kind: "reverse-accrual", id })}
          onPage={setAccrualPage}
          page={accruals}
        />
      ) : tab === "payments" ? (
        <FeePaymentTable
          api={api}
          canExport={can("reports.export")}
          canReverse={can("outsourced_driver_fees.reverse")}
          filters={pf}
          language={language}
          money={money}
          onFilters={(value) => {
            setPaymentPage(1);
            setPf(value);
          }}
          onOpen={(id) => openRecord("outsourced_driver_fee_payment", id)}
          onPage={setPaymentPage}
          onReports={openReports}
          onReverse={(payment) => setDialog({ kind: "reverse-payment", payment })}
          page={payments}
        />
      ) : (
        <DriverFeeReports
          api={api}
          canExport={can("reports.export")}
          initialDriverId={reportDriverId}
          language={language}
        />
      )}
      {dialog?.kind === "reconcile" || dialog?.kind === "backfill" ? (
        <ReconcileDialog
          api={api}
          backfill={dialog.kind === "backfill"}
          onClose={() => setDialog(undefined)}
          onSuccess={refresh}
        />
      ) : null}
      {dialog?.kind === "accrual" && dialog.id ? (
        <AccrualDetailDialog
          api={api}
          canPay={can("outsourced_driver_fees.pay")}
          canReverse={can("outsourced_driver_fees.reverse")}
          id={dialog.id}
          money={money}
          onClose={closeDialog}
          onPay={(driverId) => setDialog({ kind: "pay", driverId })}
          onReports={openReports}
          onReverse={(id) => setDialog({ kind: "reverse-accrual", id })}
        />
      ) : null}
      {dialog?.kind === "reverse-accrual" && dialog.id ? (
        <ReasonDialog
          api={api}
          endpoint={`operations/payroll/outsourced-driver-fees/accruals/${dialog.id}/reverse`}
          kind="accrual"
          onClose={() => setDialog(undefined)}
          onSuccess={refresh}
        />
      ) : null}
      {dialog?.kind === "pay" ? (
        <PayDriverDialog
          api={api}
          canExport={can("reports.export")}
          initialDriverId={dialog.driverId}
          language={language}
          money={money}
          onClose={() => setDialog(undefined)}
          onReports={openReports}
          onSuccess={refresh}
          onViewPayment={(id) => openRecord("outsourced_driver_fee_payment", id)}
        />
      ) : null}
      {dialog?.kind === "payment" && dialog.id ? (
        <PaymentDetailDialog
          api={api}
          canExport={can("reports.export")}
          canReverse={can("outsourced_driver_fees.reverse")}
          id={dialog.id}
          language={language}
          money={money}
          onClose={closeDialog}
          onReports={openReports}
          onReverse={(payment) => setDialog({ kind: "reverse-payment", payment })}
        />
      ) : null}
      {dialog?.kind === "reverse-payment" && dialog.payment ? (
        <ReasonDialog
          api={api}
          endpoint={`operations/payroll/outsourced-driver-fees/payments/${dialog.payment.id}/reverse`}
          kind="payment"
          onClose={() => setDialog(undefined)}
          onSuccess={refresh}
        />
      ) : null}
    </section>
  );
}

function AccrualTable({
  canPay,
  canReverse,
  filters,
  money,
  onFilters,
  onOpen,
  onPage,
  onPay,
  onReports,
  onReverse,
  page,
}: {
  canPay: boolean;
  canReverse: boolean;
  filters: typeof blankAccrualFilters;
  money: (v: string | number) => string;
  onFilters: (v: typeof filters) => void;
  onOpen: (id: string) => void;
  onPage: (p: number) => void;
  onPay: (id: string) => void;
  onReports: (id: string) => void;
  onReverse: (id: string) => void;
  page: Page<Accrual> | undefined;
}) {
  const { t } = useTranslation();
  return (
    <section className="workspace-step">
      <h2>{t("payroll.driverFees.accruals.title")}</h2>
      <div className="compact-filters">
        <input
          placeholder={t("payroll.driverFees.fields.driver")}
          value={filters.driver}
          onChange={(e) => onFilters({ ...filters, driver: e.target.value })}
        />
        <input
          placeholder={t("payroll.driverFees.fields.driverCode")}
          value={filters.driverCode}
          onChange={(e) => onFilters({ ...filters, driverCode: e.target.value })}
        />
        <input
          placeholder={t("payroll.driverFees.fields.order")}
          value={filters.orderNumber}
          onChange={(e) => onFilters({ ...filters, orderNumber: e.target.value })}
        />
        <input
          placeholder={t("payroll.driverFees.fields.serial")}
          value={filters.serialNumber}
          onChange={(e) => onFilters({ ...filters, serialNumber: e.target.value })}
        />
        <input
          type="date"
          value={filters.accrualDateFrom}
          onChange={(e) => onFilters({ ...filters, accrualDateFrom: e.target.value })}
        />
        <input
          type="date"
          value={filters.accrualDateTo}
          onChange={(e) => onFilters({ ...filters, accrualDateTo: e.target.value })}
        />
        <select
          value={filters.status}
          onChange={(e) => onFilters({ ...filters, status: e.target.value })}
        >
          <option value="">{t("common.status")}</option>
          {["accrued", "partially_paid", "paid", "reversed", "recovery_required"].map((v) => (
            <option key={v} value={v}>
              {t(`payroll.driverFees.status.${v}`)}
            </option>
          ))}
        </select>
        <select
          value={filters.source}
          onChange={(e) => onFilters({ ...filters, source: e.target.value })}
        >
          <option value="">{t("payroll.driverFees.fields.source")}</option>
          {["delivery", "daily_reconciliation", "authorized_backfill"].map((v) => (
            <option key={v} value={v}>
              {t(`payroll.driverFees.source.${v}`)}
            </option>
          ))}
        </select>
        <label>
          <input
            checked={filters.outstandingOnly}
            onChange={(e) => onFilters({ ...filters, outstandingOnly: e.target.checked })}
            type="checkbox"
          />
          {t("payroll.driverFees.filters.outstandingOnly")}
        </label>
        <label>
          <input
            checked={filters.recoveryRequiredOnly}
            onChange={(e) => onFilters({ ...filters, recoveryRequiredOnly: e.target.checked })}
            type="checkbox"
          />
          {t("payroll.driverFees.filters.recoveryOnly")}
        </label>
        <button onClick={() => onFilters(blankAccrualFilters)} type="button">
          {t("common.clear")}
        </button>
      </div>
      <div className="table-scroll-x">
        <table>
          <thead>
            <tr>
              {[
                "driver",
                "driverCode",
                "order",
                "serial",
                "deliveryDate",
                "accrualDate",
                "feeRate",
                "earned",
                "paid",
                "outstanding",
                "recovery",
                "status",
                "source",
                "created",
                "actions",
              ].map((key) => (
                <th key={key}>{t(`payroll.driverFees.columns.${key}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page?.items.length === 0 ? (
              <tr>
                <td colSpan={15}>{t("payroll.driverFees.empty.accruals")}</td>
              </tr>
            ) : (
              page?.items.map((row) => (
                <tr key={row.id}>
                  <td>{row.driverName}</td>
                  <td className="mono">{row.driverCode}</td>
                  <td className="mono">{row.orderNumber}</td>
                  <td className="mono">{row.serialNumber}</td>
                  <td>{row.deliveryDate}</td>
                  <td>{row.accrualBusinessDate}</td>
                  <td>{money(row.feeRate)}</td>
                  <td>{money(row.earnedAmount)}</td>
                  <td>{money(row.paidAmount)}</td>
                  <td>{money(row.outstandingAmount)}</td>
                  <td className={row.status === "recovery_required" ? "recovery-value" : ""}>
                    {money(row.recoveryAmount)}
                  </td>
                  <td>
                    <span className={`badge fee-status-${row.status}`}>
                      {t(`payroll.driverFees.status.${row.status}`)}
                    </span>
                  </td>
                  <td>{t(`payroll.driverFees.source.${row.source}`)}</td>
                  <td>{row.createdAt}</td>
                  <td>
                    <div className="table-actions">
                      <button onClick={() => onOpen(row.id)} type="button">
                        {t("common.view")}
                      </button>
                      <button onClick={() => onReports(row.driverId)} type="button">
                        {t("payroll.driverFees.actions.openReports")}
                      </button>
                      {canPay &&
                      Number(row.outstandingAmount) > 0 &&
                      ["accrued", "partially_paid"].includes(row.status) ? (
                        <button onClick={() => onPay(row.driverId)} type="button">
                          {t("payroll.driverFees.actions.payDriver")}
                        </button>
                      ) : null}
                      {canReverse && !["reversed", "recovery_required"].includes(row.status) ? (
                        <button onClick={() => onReverse(row.id)} type="button">
                          {t("common.reverse")}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager onPage={onPage} page={page} />
    </section>
  );
}

function FeePaymentTable({
  api,
  canExport,
  canReverse,
  filters,
  language,
  money,
  onFilters,
  onOpen,
  onPage,
  onReports,
  onReverse,
  page,
}: {
  api: ApiClient;
  canExport: boolean;
  canReverse: boolean;
  filters: typeof blankPaymentFilters;
  language: string;
  money: (v: string | number) => string;
  onFilters: (v: typeof filters) => void;
  onOpen: (id: string) => void;
  onPage: (p: number) => void;
  onReports: (id: string) => void;
  onReverse: (p: FeePayment) => void;
  page: Page<FeePayment> | undefined;
}) {
  const { t } = useTranslation();
  const pdf = useReconciliationPdfActions(api);
  const run = (p: FeePayment, a: PdfAction) =>
    pdf.run(
      `operations/payroll/outsourced-driver-fees/payments/${p.id}/receipt/pdf?language=${language}`,
      `Driver-Fee-Payment-${p.paymentNumber}.pdf`,
      a,
    );
  return (
    <section className="workspace-step">
      <h2>{t("payroll.driverFees.payments.title")}</h2>
      <div className="compact-filters">
        <input
          placeholder={t("payroll.driverFees.fields.paymentNumber")}
          value={filters.number}
          onChange={(e) => onFilters({ ...filters, number: e.target.value })}
        />
        <input
          placeholder={t("payroll.driverFees.fields.driver")}
          value={filters.driver}
          onChange={(e) => onFilters({ ...filters, driver: e.target.value })}
        />
        <input
          placeholder={t("payroll.driverFees.fields.voucher")}
          value={filters.voucher}
          onChange={(e) => onFilters({ ...filters, voucher: e.target.value })}
        />
        <input
          type="date"
          value={filters.dateFrom}
          onChange={(e) => onFilters({ ...filters, dateFrom: e.target.value })}
        />
        <input
          type="date"
          value={filters.dateTo}
          onChange={(e) => onFilters({ ...filters, dateTo: e.target.value })}
        />
        <select
          value={filters.source}
          onChange={(e) => onFilters({ ...filters, source: e.target.value })}
        >
          <option value="">{t("payroll.driverFees.fields.paymentSource")}</option>
          <option value="separate_payment">
            {t("payroll.driverFees.paymentSource.separate_payment")}
          </option>
          <option value="driver_collection">
            {t("payroll.driverFees.paymentSource.driver_collection")}
          </option>
        </select>
        <select
          value={filters.status}
          onChange={(e) => onFilters({ ...filters, status: e.target.value })}
        >
          <option value="">{t("common.status")}</option>
          <option value="confirmed">{t("payroll.driverFees.status.confirmed")}</option>
          <option value="reversed">{t("payroll.driverFees.status.reversed")}</option>
        </select>
        <button onClick={() => onFilters(blankPaymentFilters)} type="button">
          {t("common.clear")}
        </button>
      </div>
      <div className="table-scroll-x">
        <table>
          <thead>
            <tr>
              {[
                "paymentNumber",
                "driver",
                "driverCode",
                "paymentDate",
                "method",
                "source",
                "amount",
                "allocations",
                "voucher",
                "collection",
                "status",
                "paidBy",
                "created",
                "actions",
              ].map((key) => (
                <th key={key}>{t(`payroll.driverFees.columns.${key}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page?.items.length === 0 ? (
              <tr>
                <td colSpan={14}>{t("payroll.driverFees.empty.payments")}</td>
              </tr>
            ) : (
              page?.items.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.paymentNumber}</td>
                  <td>{row.driverName}</td>
                  <td>{row.driverCode}</td>
                  <td>{row.paymentDate}</td>
                  <td>{t(`payroll.driverFees.paymentMethod.${row.paymentMethod}`)}</td>
                  <td>{t(`payroll.driverFees.paymentSource.${row.paymentSource}`)}</td>
                  <td>{money(row.amount)}</td>
                  <td>{row.activeAllocationCount}</td>
                  <td>{row.voucherReference ?? "-"}</td>
                  <td>{row.linkedReconciliationNumber ?? "-"}</td>
                  <td>{t(`payroll.driverFees.status.${row.status}`)}</td>
                  <td>{row.paidBy}</td>
                  <td>{row.createdAt}</td>
                  <td>
                    <div className="table-actions">
                      <button onClick={() => onOpen(row.id)} type="button">
                        {t("common.view")}
                      </button>
                      <button onClick={() => onReports(row.driverId)} type="button">
                        {t("payroll.driverFees.actions.openReports")}
                      </button>
                      {canReverse &&
                      row.paymentSource === "separate_payment" &&
                      row.status === "confirmed" ? (
                        <button onClick={() => onReverse(row)} type="button">
                          {t("common.reverse")}
                        </button>
                      ) : null}
                      {canExport ? (
                        <>
                          <button onClick={() => void run(row, "preview")} type="button">
                            {t("common.preview")}
                          </button>
                          <button onClick={() => void run(row, "print")} type="button">
                            {t("common.print")}
                          </button>
                          <button onClick={() => void run(row, "download")} type="button">
                            {t("common.download")}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager onPage={onPage} page={page} />
    </section>
  );
}

function ReconcileDialog({
  api,
  backfill,
  onClose,
  onSuccess,
}: {
  api: ApiClient;
  backfill: boolean;
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [from, setFrom] = useState(dubaiToday());
  const [to, setTo] = useState(dubaiToday());
  const [preview, setPreview] = useState(backfill);
  const [notes, setNotes] = useState("");
  const [result, setResult] = useState<ReconcileResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const idempotency = useIdempotencyKey();
  const submit = async () => {
    if (busy) return;
    if (backfill && from > to) {
      setError(t("payroll.driverFees.validation.dateRange"));
      return;
    }
    setBusy(true);
    setError(undefined);
    const payload = backfill
      ? { fromDate: from, toDate: to, preview, notes: notes || undefined }
      : { businessDate: from };
    try {
      const value = await api.post<ReconcileResult>(
        `operations/payroll/outsourced-driver-fees/${backfill ? "backfill" : "reconcile"}`,
        payload,
        { "X-Idempotency-Key": idempotency.keyFor(stableFingerprint(payload)) },
      );
      setResult(value);
      await onSuccess();
    } catch (issue) {
      setError(errorText(issue, t("payroll.driverFees.errors.operation")));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t(
        backfill ? "payroll.driverFees.backfill.title" : "payroll.driverFees.reconcile.title",
      )}
      titleId="driver-fee-reconcile"
    >
      {error ? <div className="alert alert-error">{error}</div> : null}
      {result ? (
        <ResultView result={result} />
      ) : (
        <>
          <label className="field">
            <span>
              {t(
                backfill
                  ? "payroll.driverFees.fields.from"
                  : "payroll.driverFees.fields.businessDate",
              )}
            </span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          {backfill ? (
            <>
              <label className="field">
                <span>{t("payroll.driverFees.fields.to")}</span>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
              <label>
                <input
                  checked={preview}
                  onChange={(e) => setPreview(e.target.checked)}
                  type="checkbox"
                />
                {t("payroll.driverFees.actions.previewOnly")}
              </label>
              <label className="field">
                <span>{t("common.notes")}</span>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
            </>
          ) : null}
          <div className="modal-actions">
            <button onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button
              disabled={busy || !from || (backfill && !to)}
              onClick={() => void submit()}
              type="button"
            >
              {busy ? t("common.loading") : t("common.confirm")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
function ResultView({ result }: { result: ReconcileResult }) {
  const { t } = useTranslation();
  const values = [
    "ordersExamined",
    "eligibleOrders",
    "accrualsCreated",
    "alreadyAccrued",
    "reversedHistoricalAccruals",
    "employeeDriverOrders",
    "missingAssignedDrivers",
    "missingFeeRates",
    "ambiguousFeeRates",
    "legacyRepresentedOrders",
    "totalEarnedAmount",
  ];
  return (
    <div>
      <div className="metric-grid">
        {values.map((key) => (
          <article className="metric-card" key={key}>
            <span>{t(`payroll.driverFees.results.${key}`)}</span>
            <strong>{String(result[key as keyof ReconcileResult])}</strong>
          </article>
        ))}
      </div>
      {result.outcomes.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("payroll.driverFees.fields.order")}</th>
              <th>{t("payroll.driverFees.fields.outcome")}</th>
            </tr>
          </thead>
          <tbody>
            {result.outcomes.map((row, index) => (
              <tr key={`${row.orderId}-${index}`}>
                <td>{row.orderNumber ?? row.orderId}</td>
                <td>{t(`payroll.driverFees.outcome.${row.outcome}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>{t("payroll.driverFees.empty.missing")}</p>
      )}
    </div>
  );
}

function PayDriverDialog({
  api,
  canExport,
  initialDriverId,
  language,
  money,
  onClose,
  onReports,
  onSuccess,
  onViewPayment,
}: {
  api: ApiClient;
  canExport: boolean;
  initialDriverId?: string | undefined;
  language: string;
  money: (v: string | number | undefined) => string;
  onClose: () => void;
  onReports: (id: string) => void;
  onSuccess: () => Promise<void>;
  onViewPayment: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [drivers, setDrivers] = useState<readonly Driver[]>([]);
  const [driverId, setDriverId] = useState(initialDriverId ?? "");
  const [amount, setAmount] = useState("");
  const [amountEdited, setAmountEdited] = useState(false);
  const [outstanding, setOutstanding] = useState<{ amount: string; count: number }>();
  const [outstandingLoading, setOutstandingLoading] = useState(false);
  const [proposal, setProposal] = useState<Proposal>();
  const [manual, setManual] = useState<Record<string, string>>({});
  const [date, setDate] = useState(dubaiToday());
  const [voucher, setVoucher] = useState("");
  const [accountId, setAccountId] = useState("");
  // Active Company Cash accounts. The endpoint returns a plain ARRAY whose
  // name field is `name`, and filters server-side via activeOnly -- verified
  // against cash-bank.controller.ts rather than assumed.
  const [cashAccounts, setCashAccounts] = useState<
    readonly { readonly id: string; readonly name: string }[]
  >([]);
  const [accountsFailed, setAccountsFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setAccountsFailed(false);
    api
      .get<readonly { id: string; name: string }[]>(
        "operations/accounting/cash-bank/cash-accounts?activeOnly=true",
        controller.signal,
      )
      .then(setCashAccounts)
      .catch(() => {
        // A failed load must not wedge the dialog: the selector stays empty,
        // the required check explains why, and the backend refuses a payment
        // without an account regardless.
        if (!controller.signal.aborted) {
          setCashAccounts([]);
          setAccountsFailed(true);
        }
      });
    return () => controller.abort();
  }, [api]);
  const [external, setExternal] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<{
    paymentId: string;
    paymentNumber: string;
    remainingDriverOutstanding: string;
    amount: string;
  }>();
  const idem = useIdempotencyKey();
  const pdf = useReconciliationPdfActions(api);

  useEffect(() => {
    void api
      .get<Page<Accrual>>(
        `operations/payroll/outsourced-driver-fees/accruals?${qs({ outstandingOnly: true, page: 1, pageSize: 500 })}`,
      )
      .then((page) => {
        const byId = new Map<string, Driver>();
        pageItems(page).forEach((row) => {
          if (!byId.has(row.driverId)) {
            byId.set(row.driverId, {
              code: row.driverCode,
              driverType: "outsourced",
              id: row.driverId,
              name: row.driverName,
            });
          }
        });
        setDrivers([...byId.values()].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => setDrivers([]));
  }, [api]);

  const loadOutstanding = useCallback(async () => {
    if (!driverId) {
      setOutstanding(undefined);
      setOutstandingLoading(false);
      setAmount("");
      return;
    }
    setOutstandingLoading(true);
    try {
      const page = await api.get<Page<Accrual>>(
        `operations/payroll/outsourced-driver-fees/accruals?${qs({ driverId, outstandingOnly: true, page: 1, pageSize: 500 })}`,
      );
      const items = pageItems(page);
      const total = items.reduce((sum, row) => sum + (parseMoney(row.outstandingAmount) ?? 0), 0);
      const nextAmount = total.toFixed(2);
      setOutstanding({ amount: nextAmount, count: page.total ?? items.length });
      if (!amountEdited) {
        setAmount(nextAmount);
        setProposal(undefined);
      }
    } catch {
      setOutstanding(undefined);
    } finally {
      setOutstandingLoading(false);
    }
  }, [api, amountEdited, driverId]);

  useEffect(() => {
    void loadOutstanding();
  }, [loadOutstanding]);

  const numeric = parseMoney(amount);
  const proposalAllocations = proposalRows(proposal);
  const allocations =
    proposalAllocations.map((row) => ({
      accrualId: row.accrualId,
      amount: parseMoney(manual[row.accrualId] ?? row.amount) ?? 0,
    })) ?? [];
  const allocated = allocations.reduce((sum, row) => sum + row.amount, 0);
  const manualOverride =
    proposal !== undefined &&
    proposalAllocations.some(
      (row) =>
        Math.abs((parseMoney(manual[row.accrualId] ?? row.amount) ?? -1) - Number(row.amount)) >
        0.001,
    );
  const canConfirm =
    proposal !== undefined &&
    proposalAllocations.length > 0 &&
    numeric !== undefined &&
    numeric > 0 &&
    allocated > 0 &&
    Math.abs(allocated - numeric) <= 0.001 &&
    !busy;

  const generate = async () => {
    if (!driverId || numeric === undefined || numeric <= 0) {
      setError(t("payroll.driverFees.validation.amount"));
      return;
    }
    setError(undefined);
    setProposal(undefined);
    setManual({});
    try {
      const result = await api.post<Proposal>(
        "operations/payroll/outsourced-driver-fees/payments/proposal",
        { driverId, amount: numeric },
      );
      const normalizedAllocations = proposalRows(result);
      setProposal({
        allocations: normalizedAllocations,
        driverId: result.driverId ?? driverId,
        remainingOutstanding: result.remainingOutstanding ?? "0.00",
        totalAmount: result.totalAmount ?? numeric.toFixed(2),
      });
      setManual(
        Object.fromEntries(normalizedAllocations.map((row) => [row.accrualId, row.amount])),
      );
    } catch (issue) {
      setError(errorText(issue, t("payroll.driverFees.errors.operation")));
    }
  };

  const confirm = async () => {
    if (!canConfirm || numeric === undefined) return;
    if (accountId === "") {
      setError(t("payroll.driverFees.validation.cashAccountRequired"));
      return;
    }
    setBusy(true);
    setError(undefined);
    const payload = {
      ...(manualOverride ? { allocations: allocations.filter((row) => row.amount > 0) } : {}),
      accountId,
      amount: numeric,
      cashVoucherReference: voucher.trim() || undefined,
      driverId,
      externalReference: external.trim() || undefined,
      notes: notes.trim() || undefined,
      paymentDate: date,
    };
    try {
      const result = await api.post<{
        paymentId: string;
        paymentNumber: string;
        remainingDriverOutstanding: string;
        amount: string;
      }>("operations/payroll/outsourced-driver-fees/payments", payload, {
        "X-Idempotency-Key": idem.keyFor(stableFingerprint(payload)),
      });
      setSuccess(result);
      await onSuccess();
    } catch (issue) {
      setError(errorText(issue, t("payroll.driverFees.errors.operation")));
    } finally {
      setBusy(false);
    }
  };

  const run = (action: PdfAction) =>
    success &&
    pdf.run(
      `operations/payroll/outsourced-driver-fees/payments/${success.paymentId}/receipt/pdf?language=${language}`,
      `Driver-Fee-Payment-${success.paymentNumber}.pdf`,
      action,
    );

  return (
    <Modal
      className="order-modal driver-fee-payment-modal"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("payroll.driverFees.pay.title")}
      titleId="pay-driver-fee"
    >
      {error ? <div className="alert alert-error">{error}</div> : null}
      {success ? (
        <div className="reconciliation-success">
          <h3>{t("payroll.driverFees.pay.success")}</h3>
          <dl className="detail-grid">
            <div>
              <dt>{t("payroll.driverFees.fields.paymentNumber")}</dt>
              <dd>{success.paymentNumber}</dd>
            </div>
            <div>
              <dt>{t("payroll.driverFees.columns.amount")}</dt>
              <dd>{money(success.amount)}</dd>
            </div>
            <div>
              <dt>{t("payroll.driverFees.columns.outstanding")}</dt>
              <dd>{money(success.remainingDriverOutstanding)}</dd>
            </div>
          </dl>
          <div className="modal-actions">
            <button onClick={() => onViewPayment(success.paymentId)} type="button">
              {t("payroll.driverFees.actions.viewPayment")}
            </button>
            <button onClick={() => onReports(driverId)} type="button">
              {t("payroll.driverFees.actions.openReports")}
            </button>
            {canExport ? (
              <>
                <button onClick={() => void run("preview")} type="button">
                  {t("common.preview")}
                </button>
                <button onClick={() => void run("print")} type="button">
                  {t("common.print")}
                </button>
                <button onClick={() => void run("download")} type="button">
                  {t("common.download")}
                </button>
              </>
            ) : null}
            <button onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="alert alert-info">{t("payroll.driverFees.pay.instructions")}</div>
          <div className="driver-fee-payment-grid">
            <label className="field">
              <span>{t("payroll.driverFees.fields.driver")}</span>
              <select
                value={driverId}
                onChange={(e) => {
                  setDriverId(e.target.value);
                  setAmountEdited(false);
                  setAmount("");
                  setOutstanding(undefined);
                  setProposal(undefined);
                }}
              >
                <option value="">{t("common.select")}</option>
                {(Array.isArray(drivers) ? drivers : []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              {drivers.length === 0 ? (
                <small>{t("payroll.driverFees.pay.noPayableDrivers")}</small>
              ) : null}
            </label>
            <label className="field">
              <span>{t("payroll.driverFees.fields.amount")}</span>
              <input
                disabled={!driverId}
                inputMode="decimal"
                placeholder={driverId ? "0.00" : t("payroll.driverFees.pay.selectDriverFirst")}
                value={amount}
                onChange={(e) => {
                  setAmountEdited(true);
                  setAmount(e.target.value);
                  setProposal(undefined);
                }}
              />
              {outstandingLoading ? (
                <small>{t("common.loading")}</small>
              ) : outstanding ? (
                <small>
                  {t("payroll.driverFees.pay.outstandingHint", {
                    amount: money(outstanding.amount),
                    count: outstanding.count,
                  })}
                </small>
              ) : driverId ? (
                <small>{t("payroll.driverFees.pay.noOutstandingForDriver")}</small>
              ) : (
                <small>{t("payroll.driverFees.pay.selectDriverFirst")}</small>
              )}
            </label>
            <button
              className="button button-secondary driver-fee-oldest-first"
              onClick={() => void generate()}
              type="button"
            >
              {t("payroll.driverFees.actions.oldestFirst")}
            </button>
          </div>
          {proposal ? (
            <>
              {proposalAllocations.length === 0 ? (
                <div className="alert alert-warning">{t("payroll.driverFees.pay.noAccruals")}</div>
              ) : (
                <div className="table-scroll-x">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("payroll.driverFees.fields.order")}</th>
                        <th>{t("payroll.driverFees.columns.outstanding")}</th>
                        <th>{t("payroll.driverFees.columns.amount")}</th>
                        <th>{t("payroll.driverFees.columns.remaining")}</th>
                        <th>{t("common.actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {proposalAllocations.map((row) => (
                        <tr key={row.accrualId}>
                          <td>{row.orderNumber}</td>
                          <td>{money(row.outstandingBefore)}</td>
                          <td>
                            <input
                              inputMode="decimal"
                              value={manual[row.accrualId] ?? row.amount}
                              onChange={(e) =>
                                setManual({ ...manual, [row.accrualId]: e.target.value })
                              }
                            />
                          </td>
                          <td>
                            {money(
                              Math.max(
                                0,
                                Number(row.outstandingBefore) -
                                  Number(manual[row.accrualId] ?? row.amount),
                              ),
                            )}
                          </td>
                          <td>
                            <button
                              className="button button-secondary"
                              onClick={() => {
                                const next = { ...manual, [row.accrualId]: "0.00" };
                                const nextAmount = proposalAllocations.reduce(
                                  (sum, line) =>
                                    sum +
                                    (parseMoney(
                                      line.accrualId === row.accrualId
                                        ? "0.00"
                                        : (next[line.accrualId] ?? line.amount),
                                    ) ?? 0),
                                  0,
                                );
                                setManual(next);
                                setAmount(nextAmount.toFixed(2));
                                setAmountEdited(true);
                              }}
                              type="button"
                            >
                              {t("common.remove")}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {manualOverride ? (
                <div className="alert alert-warning">
                  {t("payroll.driverFees.pay.overrideWarning")}
                </div>
              ) : null}
              <p>
                {t("payroll.driverFees.pay.remainingPayment")}:{" "}
                {money(Math.max(0, (numeric ?? 0) - allocated))}
              </p>
              <div className="driver-fee-payment-grid">
                <label className="field">
                  <span>{t("payroll.driverFees.fields.paymentDate")}</span>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </label>
                {/* Cash accounts only. This dialog pays outsourced Driver fees
                    in cash; there is no Visa option to offer, so the field says
                    WHICH drawer, never whether it is cash. */}
                <label className="field">
                  <span>{t("payroll.driverFees.fields.cashAccount")}</span>
                  <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                    <option value="">
                      {t("payroll.driverFees.fields.selectCashAccount")}
                    </option>
                    {cashAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                  {accountsFailed ? (
                    <small className="form-status-error">
                      {t("payroll.driverFees.validation.cashAccountsLoadFailed")}
                    </small>
                  ) : null}
                </label>
                <label className="field">
                  <span>{t("payroll.driverFees.fields.voucher")}</span>
                  <input value={voucher} onChange={(e) => setVoucher(e.target.value)} />
                </label>
                <label className="field">
                  <span>{t("payroll.driverFees.fields.externalReference")}</span>
                  <input value={external} onChange={(e) => setExternal(e.target.value)} />
                </label>
                <label className="field field-span">
                  <span>{t("common.notes")}</span>
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
                </label>
              </div>
            </>
          ) : null}
          <div className="modal-actions">
            <button onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button disabled={!canConfirm} onClick={() => void confirm()} type="button">
              {busy ? t("common.working") : t("payroll.driverFees.actions.confirmPayment")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function AccrualDetailDialog({
  api,
  canPay,
  canReverse,
  id,
  money,
  onClose,
  onPay,
  onReports,
  onReverse,
}: {
  api: ApiClient;
  canPay: boolean;
  canReverse: boolean;
  id: string;
  money: (v: string | number) => string;
  onClose: () => void;
  onPay: (id: string) => void;
  onReports: (id: string) => void;
  onReverse: (id: string) => void;
}) {
  const { i18n, t } = useTranslation();
  const language = i18n.resolvedLanguage?.startsWith("ar") ? "ar" : "en";
  const [data, setData] = useState<AccrualDetail>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void api
      .get<AccrualDetail>(`operations/payroll/outsourced-driver-fees/accruals/${id}`)
      .then(setData)
      .catch((e) => setError(errorText(e, t("payroll.driverFees.errors.load"))));
  }, [api, id, t]);
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("payroll.driverFees.accruals.detail")}
      titleId="accrual-detail"
    >
      {error ? <div className="alert alert-error">{error}</div> : null}
      {data ? (
        <>
          <dl className="detail-grid">
            {Object.entries<ReactNode>({
              // Driver and Order open their own records through the verified
              // routes; every other value stays plain text.
              driver: (
                <OperationalReference
                  identifier={data.driverCode}
                  reference={partyDisplayLabel(data.driverCode, data.driverName, null, language)}
                  type="driver"
                />
              ),
              order: <OperationalReference reference={data.orderNumber} type="order" />,
              serial: data.serialNumber,
              deliveryDate: data.deliveryDate,
              accrualDate: data.accrualBusinessDate,
              feeRate: money(data.feeRate),
              earned: money(data.earnedAmount),
              paid: money(data.paidAmount),
              outstanding: money(data.outstandingAmount),
              recovery: money(data.recoveryAmount),
              status: t(`payroll.driverFees.status.${data.status}`),
              source: t(`payroll.driverFees.source.${data.source}`),
              createdBy: data.createdBy,
              created: data.createdAt,
            }).map(([key, value]) => (
              <div key={key}>
                <dt>{t(`payroll.driverFees.columns.${key}`)}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {data.status === "recovery_required" ? (
            <div className="alert alert-warning">
              {t("payroll.driverFees.recovery.explanation")}
            </div>
          ) : null}
          <h3>{t("payroll.driverFees.allocations.title")}</h3>
          <pre className="data-preview">{JSON.stringify(data.allocations, null, 2)}</pre>
          {/* Additive Accounting link-through; renders nothing for a User
              without Accounting access. */}
          <AccountingRelatedPanel
            api={api}
            sourceId={data.id}
            sourceType="outsourced_driver_fee_accrual"
          />
          <div className="modal-actions">
            <button onClick={() => onReports(data.driverId)} type="button">
              {t("payroll.driverFees.actions.openReports")}
            </button>
            {canPay &&
            Number(data.outstandingAmount) > 0 &&
            ["accrued", "partially_paid"].includes(data.status) ? (
              <button onClick={() => onPay(data.driverId)} type="button">
                {t("payroll.driverFees.actions.payDriver")}
              </button>
            ) : null}
            {canReverse && !["reversed", "recovery_required"].includes(data.status) ? (
              <button onClick={() => onReverse(data.id)} type="button">
                {t("common.reverse")}
              </button>
            ) : null}
            <button onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </>
      ) : (
        <p>{t("common.loading")}</p>
      )}
    </Modal>
  );
}
function PaymentDetailDialog({
  api,
  canExport,
  canReverse,
  id,
  language,
  money,
  onClose,
  onReports,
  onReverse,
}: {
  api: ApiClient;
  canExport: boolean;
  canReverse: boolean;
  id: string;
  language: string;
  money: (v: string | number) => string;
  onClose: () => void;
  onReports: (id: string) => void;
  onReverse: (p: FeePayment) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<FeePaymentDetail>();
  const [error, setError] = useState<string>();
  const pdf = useReconciliationPdfActions(api);
  useEffect(() => {
    void api
      .get<FeePaymentDetail>(`operations/payroll/outsourced-driver-fees/payments/${id}`)
      .then(setData)
      .catch((e) => setError(errorText(e, t("payroll.driverFees.errors.load"))));
  }, [api, id, t]);
  const run = (a: PdfAction) =>
    data &&
    pdf.run(
      `operations/payroll/outsourced-driver-fees/payments/${id}/receipt/pdf?language=${language}`,
      `Driver-Fee-Payment-${data.paymentNumber}.pdf`,
      a,
    );
  const method = data?.paymentMethod
    ? t(`payroll.driverFees.paymentMethod.${data.paymentMethod}`)
    : "-";
  const source = data?.paymentSource
    ? t(`payroll.driverFees.paymentSource.${data.paymentSource}`)
    : "-";
  const status = data?.status ? t(`payroll.driverFees.status.${data.status}`) : "-";
  return (
    <Modal
      className="order-modal driver-fee-detail-modal"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("payroll.driverFees.payments.detail")}
      titleId="fee-payment-detail"
    >
      {error ? <div className="alert alert-error">{error}</div> : null}
      {data ? (
        <>
          <dl className="detail-grid">
            {Object.entries({
              paymentNumber: data.paymentNumber ?? "-",
              driver: data.driverName ?? "-",
              driverCode: data.driverCode ?? "-",
              paymentDate: data.paymentDate ?? "-",
              method,
              source,
              amount: money(data.amount),
              voucher: data.voucherReference ?? "-",
              collection: data.linkedReconciliationNumber ?? "-",
              status,
              paidBy: data.paidBy ?? "-",
              created: data.createdAt ?? "-",
            }).map(([key, value]) => (
              <div key={key}>
                <dt>{t(`payroll.driverFees.columns.${key}`)}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {data.paymentSource === "driver_collection" ? (
            <div className="alert alert-info">
              {t("payroll.driverFees.payments.collectionReversal")}
            </div>
          ) : null}
          <h3>{t("payroll.driverFees.allocations.title")}</h3>
          <div className="table-scroll-x">
            <table>
              <thead>
                <tr>
                  <th>{t("payroll.driverFees.fields.order")}</th>
                  <th>{t("payroll.driverFees.columns.serial")}</th>
                  <th>{t("payroll.driverFees.columns.deliveryDate")}</th>
                  <th>{t("payroll.driverFees.columns.earned")}</th>
                  <th>{t("payroll.driverFees.columns.amount")}</th>
                  <th>{t("payroll.driverFees.columns.remaining")}</th>
                  <th>{t("payroll.driverFees.columns.status")}</th>
                </tr>
              </thead>
              <tbody>
                {data.allocations.length === 0 ? (
                  <tr>
                    <td colSpan={7}>{t("common.noRecords")}</td>
                  </tr>
                ) : (
                  data.allocations.map((line) => (
                    <tr key={line.id ?? line.accrualId}>
                      <td className="mono">{line.orderNumber ?? "-"}</td>
                      <td className="mono">{line.serialNumber ?? "-"}</td>
                      <td>{line.deliveryDate ?? line.accrualBusinessDate ?? "-"}</td>
                      <td>{money(line.earnedAmount ?? 0)}</td>
                      <td>{money(line.amount)}</td>
                      <td>{money(line.remainingOutstanding ?? 0)}</td>
                      <td>{line.allocationStatus ?? "-"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {/* Additive Accounting link-through; renders nothing for a User
              without Accounting access. */}
          <AccountingRelatedPanel
            api={api}
            sourceId={data.id}
            sourceType="outsourced_driver_fee_payment"
          />
          <div className="modal-actions">
            <button onClick={() => onReports(data.driverId)} type="button">
              {t("payroll.driverFees.actions.openReports")}
            </button>
            {data.linkedReconciliationId ? (
              <a
                className="button button-secondary"
                href={`/drivers?reconciliationId=${encodeURIComponent(data.linkedReconciliationId)}`}
              >
                {t("payroll.driverFees.actions.openCollection")}
              </a>
            ) : null}
            {canReverse &&
            data.paymentSource === "separate_payment" &&
            data.status === "confirmed" ? (
              <button onClick={() => onReverse(data)} type="button">
                {t("common.reverse")}
              </button>
            ) : null}
            {canExport ? (
              <>
                <button onClick={() => void run("preview")} type="button">
                  {t("common.preview")}
                </button>
                <button onClick={() => void run("print")} type="button">
                  {t("common.print")}
                </button>
                <button onClick={() => void run("download")} type="button">
                  {t("common.download")}
                </button>
              </>
            ) : null}
            <button onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </>
      ) : (
        <p>{t("common.loading")}</p>
      )}
    </Modal>
  );
}
function ReasonDialog({
  api,
  endpoint,
  kind,
  onClose,
  onSuccess,
}: {
  api: ApiClient;
  endpoint: string;
  kind: "accrual" | "payment";
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const idem = useIdempotencyKey();
  const submit = async () => {
    if (!reason.trim() || busy) return;
    setBusy(true);
    try {
      await api.post(
        endpoint,
        { reason: reason.trim() },
        { "X-Idempotency-Key": idem.keyFor(`${endpoint}|${reason.trim()}`) },
      );
      await onSuccess();
      onClose();
    } catch (issue) {
      setError(
        issue instanceof ApiError &&
          issue.code === "outsourced_driver_fee_recovery_workflow_required"
          ? t("payroll.driverFees.errors.recoveryWorkflow")
          : errorText(issue, t("payroll.driverFees.errors.operation")),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t(`payroll.driverFees.reversal.${kind}`)}
      titleId="fee-reversal"
    >
      {error ? <div className="alert alert-error">{error}</div> : null}
      <div className="alert alert-warning">{t(`payroll.driverFees.reversal.${kind}Warning`)}</div>
      <label className="field">
        <span>{t("payroll.driverFees.fields.reason")}</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="modal-actions">
        <button onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button disabled={!reason.trim() || busy} onClick={() => void submit()} type="button">
          {t("common.reverse")}
        </button>
      </div>
    </Modal>
  );
}

export function DriverFeeReports({
  api,
  canExport,
  initialDriverId = "",
  language,
}: {
  api: ApiClient;
  canExport: boolean;
  initialDriverId?: string;
  language: string;
}) {
  const { t } = useTranslation();
  const pdf = useReconciliationPdfActions(api);
  const [drivers, setDrivers] = useState<readonly Driver[]>([]);
  const [driverId, setDriverId] = useState(initialDriverId);
  const [month, setMonth] = useState(dubaiToday().slice(0, 7));
  const [from, setFrom] = useState(dubaiToday());
  const [to, setTo] = useState(dubaiToday());
  const [asOf, setAsOf] = useState(dubaiToday());
  const [minimum, setMinimum] = useState("");
  const [oldestUnpaidDate, setOldestUnpaidDate] = useState("");
  const [outstandingStatus, setOutstandingStatus] = useState("");
  const [accrualSource, setAccrualSource] = useState("");
  const [accrualStatus, setAccrualStatus] = useState("");
  const [paymentId, setPaymentId] = useState("");
  const [payments, setPayments] = useState<readonly FeePayment[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => setDriverId(initialDriverId), [initialDriverId]);
  useEffect(() => {
    void Promise.all([
      api.get<{ items: readonly Driver[] }>("operations/cash/drivers?pageSize=100"),
      api.get<Page<FeePayment>>("operations/payroll/outsourced-driver-fees/payments?pageSize=100"),
    ])
      .then(([d, p]) => {
        setDrivers(d.items.filter((x) => x.driverType === "outsourced"));
        setPayments(p.items);
      })
      .catch(() => undefined);
  }, [api]);
  const run = async (path: string, name: string, action: PdfAction) => {
    setError(undefined);
    const issue = await pdf.run(path, name, action);
    if (issue) setError(errorText(issue, t("payroll.driverFees.errors.pdf")));
  };
  const actions = (path: string, name: string, disabled: boolean) => (
    <div className="table-actions">
      {(["preview", "print", "download"] as PdfAction[]).map((action) => (
        <button
          disabled={!canExport || disabled || pdf.busy !== undefined}
          key={action}
          onClick={() => void run(path, name, action)}
          type="button"
        >
          {t(`common.${action}`)}
        </button>
      ))}
    </div>
  );
  return (
    <section className="workspace-step">
      <h2>{t("payroll.driverFees.reports.title")}</h2>
      {error ? <div className="alert alert-error">{error}</div> : null}
      <div className="payroll-report-grid">
        <article className="report-card">
          <h3>{t("payroll.driverFees.reports.earnings")}</h3>
          <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">{t("common.select")}</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          {actions(
            `operations/payroll/outsourced-driver-fees/drivers/${driverId}/statement/pdf?${qs({ month, language })}`,
            "Driver-Earnings.pdf",
            !driverId || !month,
          )}
        </article>
        <article className="report-card">
          <h3>{t("payroll.driverFees.reports.outstanding")}</h3>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          <input
            inputMode="decimal"
            placeholder={t("payroll.driverFees.fields.minimumOutstanding")}
            value={minimum}
            onChange={(e) => setMinimum(e.target.value)}
          />
          <label>
            {t("payroll.driverFees.fields.oldestUnpaidDate")}
            <input
              type="date"
              value={oldestUnpaidDate}
              onChange={(e) => setOldestUnpaidDate(e.target.value)}
            />
          </label>
          <select value={outstandingStatus} onChange={(e) => setOutstandingStatus(e.target.value)}>
            <option value="">{t("common.status")}</option>
            <option value="accrued">{t("payroll.driverFees.status.accrued")}</option>
            <option value="partially_paid">{t("payroll.driverFees.status.partially_paid")}</option>
          </select>
          {actions(
            `operations/payroll/outsourced-driver-fees/reports/outstanding/pdf?${qs({ asOf, driverId: driverId || undefined, language, minimumOutstanding: minimum || undefined, oldestUnpaidDate: oldestUnpaidDate || undefined, status: outstandingStatus || undefined })}`,
            "Outstanding-Driver-Fees.pdf",
            !asOf || (minimum !== "" && parseMoney(minimum) === undefined),
          )}
        </article>
        <article className="report-card">
          <h3>{t("payroll.driverFees.reports.daily")}</h3>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <select value={accrualSource} onChange={(e) => setAccrualSource(e.target.value)}>
            <option value="">{t("payroll.driverFees.fields.source")}</option>
            {["delivery", "daily_reconciliation", "authorized_backfill"].map((value) => (
              <option key={value} value={value}>
                {t(`payroll.driverFees.source.${value}`)}
              </option>
            ))}
          </select>
          <select value={accrualStatus} onChange={(e) => setAccrualStatus(e.target.value)}>
            <option value="">{t("common.status")}</option>
            {["accrued", "partially_paid", "paid", "reversed", "recovery_required"].map((value) => (
              <option key={value} value={value}>
                {t(`payroll.driverFees.status.${value}`)}
              </option>
            ))}
          </select>
          {actions(
            `operations/payroll/outsourced-driver-fees/reports/accruals/pdf?${qs({ from, to, driverId: driverId || undefined, language, source: accrualSource || undefined, status: accrualStatus || undefined })}`,
            "Daily-Driver-Fee-Accrual.pdf",
            !from || !to || from > to,
          )}
        </article>
        <article className="report-card">
          <h3>{t("payroll.driverFees.reports.receipt")}</h3>
          <select value={paymentId} onChange={(e) => setPaymentId(e.target.value)}>
            <option value="">{t("common.select")}</option>
            {payments.map((p) => (
              <option key={p.id} value={p.id}>
                {p.paymentNumber}
              </option>
            ))}
          </select>
          {actions(
            `operations/payroll/outsourced-driver-fees/payments/${paymentId}/receipt/pdf?language=${language}`,
            "Driver-Fee-Payment.pdf",
            !paymentId,
          )}
        </article>
      </div>
    </section>
  );
}
function Pager<T>({ onPage, page }: { onPage: (p: number) => void; page: Page<T> | undefined }) {
  if (!page) return null;
  const count = Math.max(1, Math.ceil(page.total / page.pageSize));
  return (
    <div className="pagination">
      <button disabled={page.page <= 1} onClick={() => onPage(page.page - 1)} type="button">
        ‹
      </button>
      <span>
        {page.page} / {count}
      </span>
      <button disabled={page.page >= count} onClick={() => onPage(page.page + 1)} type="button">
        ›
      </button>
    </div>
  );
}
