import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import { AccountingRelatedPanel } from "../accounting/AccountingRelatedPanel.js";
import { PageHeader } from "../../components/PageHeader.js";
import { parseMoneyInput, safeMoneyValue } from "../../utils/numeric-input.js";
import { type PdfAction, useReconciliationPdfActions } from "../operations/reconciliation-pdf.js";
import { useIdempotencyKey } from "../operations/useIdempotencyKey.js";
import { recordRoute } from "../accounting/accounting-routes.js";
import { useSessionAccess } from "../../app/SessionAccessContext.js";

import { OperationalReference, partyDisplayLabel } from "../operations/OperationalReference.js";
import {
  DriverFeeReports,
  OutsourcedDriverFeesWorkspace,
} from "./OutsourcedDriverFeesWorkspace.js";

type PayrollTab = "driverFees" | "employees" | "payments" | "reports";
type PeriodStatus =
  "approved" | "calculated" | "closed" | "draft" | "paid" | "partially_paid" | "reversed";

interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

interface PeriodRow {
  readonly approvedAt: string | null;
  readonly calculatedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly heldEmployees: number;
  readonly id: string;
  readonly netPayroll: string;
  readonly payrollMonth: string;
  readonly periodEnd: string;
  readonly periodReference: string;
  readonly periodStart: string;
  readonly reversedAt: string | null;
  readonly status: PeriodStatus;
  readonly totalEmployees: number;
  readonly totalOutstanding: string;
  readonly totalPaid: string;
}

interface PeriodDetail extends PeriodRow {
  readonly approvedBy: string | null;
  readonly calculatedBy: string | null;
  readonly closedBy: string | null;
  readonly createdBy: string | null;
  readonly exceptionSummary: {
    readonly active: number;
    readonly blocking: number;
    readonly warnings: number;
  };
  readonly heldCount: number;
  readonly notes: string | null;
  readonly reversalReason: string | null;
  readonly reversedBy: string | null;
  readonly totalAllowances: string;
  readonly totalBasicSalary: string;
  readonly totalDeductions: string;
  readonly totalDriverCommission: string;
  readonly totalEarningAdjustments: string;
  readonly totalGrossEarnings: string;
  readonly totalNetSalary: string;
}

interface PeriodSummary {
  readonly approvedCount: number;
  readonly allowanceTotal: string;
  readonly basicSalaryTotal: string;
  readonly calculatedCount: number;
  readonly deductionTotal: string;
  readonly driverCommissionTotal: string;
  readonly earningAdjustmentTotal: string;
  readonly employeeCount: number;
  readonly heldCount: number;
  readonly netSalaryTotal: string;
  readonly outstandingCount: number;
  readonly outstandingTotal: string;
  readonly paidCount: number;
  readonly paidTotal: string;
  readonly partiallyPaidCount: number;
}

interface PayrollLine {
  readonly allowances: string;
  readonly basicSalary: string;
  readonly deductions: string;
  readonly department: string | null;
  readonly driverCommission: string;
  readonly driverCommissionSources: readonly {
    readonly amount: string;
    readonly calculationId: string;
    readonly sourceMarker: string;
  }[];
  readonly earningAdjustments: string;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly employeeNumber: string;
  readonly employmentType: string | null;
  readonly grossEarnings: string;
  readonly id: string;
  readonly monthlyBasicSalary: string | null;
  readonly netSalary: string;
  readonly outstanding: string;
  readonly paid: string;
  readonly payrollLineReference: string;
  readonly status: string;
}

interface PayrollException {
  readonly category: string;
  readonly code: string;
  readonly employeeId: string | null;
  readonly employeeName: string | null;
  readonly employeeNumber: string | null;
  readonly id: string;
  readonly message: string;
  readonly severity: "blocking" | "warning";
  readonly status: "active" | "resolved";
}

interface CalculationResult {
  readonly blockingExceptionCount: number;
  readonly calculatedEmployees: number;
  readonly consideredEmployees: number;
  readonly exceptions: readonly PayrollException[];
  readonly heldEmployees: number;
  readonly recalculationChanges?: {
    readonly employeesAdded: readonly string[];
    readonly employeesMovedToHeld: readonly string[];
    readonly employeesReleasedFromHold: readonly string[];
    readonly employeesRemoved: readonly string[];
    readonly newExceptions: readonly string[];
    readonly newTotals: CalculationResult["totals"];
    readonly previousTotals: CalculationResult["totals"];
    readonly resolvedExceptions: readonly string[];
  };
  readonly skippedEmployees: number;
  readonly status: "calculated" | "draft";
  readonly totals: {
    readonly basicSalary: string;
    readonly deductions: string;
    readonly driverCommission: string;
    readonly earningAdjustments: string;
    readonly grossEarnings: string;
    readonly netSalary: string;
    readonly totalAllowances: string;
  };
  readonly warningCount: number;
}

interface PaymentRow {
  readonly acknowledgementType: string;
  readonly employeeCount: number;
  readonly id: string;
  readonly paidBy: string;
  readonly paymentDate: string;
  readonly paymentNumber: string;
  readonly payrollMonth: string;
  readonly payrollPeriod: string;
  readonly periodId: string;
  readonly reversed: boolean;
  readonly status: string;
  readonly totalAmount: string;
  readonly voucherReference: string;
}

interface PaymentResult {
  readonly paymentId: string;
  readonly paymentNumber: string;
  readonly periodId: string;
  readonly status: string;
  readonly totalAmount: string;
}

interface PaymentProposal {
  readonly allocations: readonly {
    readonly amount: string;
    readonly employeeId: string;
    readonly employeeName: string;
    readonly employeeNumber: string;
    readonly lineId: string;
    readonly outstandingBefore: string;
    readonly remainingOutstanding: string;
  }[];
  readonly periodId: string;
  readonly totalAmount: string;
}

interface PayrollLineDetail {
  readonly adjustments: readonly {
    readonly adjustment_type: string;
    readonly amount: string;
    readonly direction: string;
    readonly id: string;
    readonly reason: string;
    readonly reversal_reason: string | null;
    readonly status: string;
  }[];
  readonly allowanceTotal: string;
  readonly allowances: readonly {
    readonly amount: string;
    readonly code: string;
    readonly name: string;
    readonly nameAr: string | null;
    readonly sourceEmployeeAllowanceId: string | null;
  }[];
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
  readonly basicSalary: string;
  readonly calculatedAt: string | null;
  readonly calculatedBy: string | null;
  readonly deductions: string;
  // Immutable earning snapshots allocated to this Payroll line. Every field is
  // the value recorded at delivery time; nothing here is derived from the Order
  // or the earning rule as they stand today.
  readonly deliveredOrderEarningSources: readonly {
    readonly allocatedAt: string | null;
    readonly appliedAmount: string;
    readonly deliveredAt: string;
    readonly earningId: string;
    readonly orderId: string;
    readonly orderNumber: string;
    readonly ruleId: string;
  }[];
  readonly deliveredOrderEarnings: string;
  readonly department: string | null;
  readonly driverCommission: string;
  readonly driverCommissionSources: readonly {
    readonly amount: string;
    readonly calculationId: string;
    readonly sourceMarker: string;
  }[];
  readonly earningAdjustments: string;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly employeeNameAr: string | null;
  readonly employeeNumber: string;
  readonly employmentType: string | null;
  readonly grossEarnings: string;
  readonly id: string;
  readonly monthlyBasicSalary: string | null;
  readonly netSalary: string;
  readonly outstanding: string;
  readonly paid: string;
  readonly paymentHistory: readonly {
    readonly allocationReversedAt: string | null;
    readonly amount: string;
    readonly paymentDate: string;
    readonly paymentId: string;
    readonly paymentNumber: string;
    readonly status: string;
  }[];
  readonly periodId: string;
  readonly periodDays: number;
  readonly periodEnd: string;
  readonly periodReference: string;
  readonly periodStart: string;
  readonly payableDays: number;
  readonly payableFrom: string;
  readonly payableTo: string;
  readonly payrollLineReference: string;
  readonly reversalReason: string | null;
  readonly reversedAt: string | null;
  readonly salaryHold: boolean;
  readonly salaryHoldFrom: string | null;
  readonly salaryHoldReason: string | null;
  readonly salaryHoldTo: string | null;
  readonly salaryVersionId: string | null;
  readonly sourceMarker: string;
  readonly status: string;
  readonly totalAllowances: string;
}

interface PaymentDetail {
  readonly acknowledgementType: string;
  readonly acknowledgementValue: string | null;
  readonly allocations: readonly {
    readonly allocationId: string;
    readonly amountPaidNow: string;
    readonly employee: string;
    readonly employeeId: string;
    readonly employeeNameAr?: string | null;
    readonly employeeNumber: string;
    readonly lineStatus: string;
    readonly netSalary: string;
    readonly payrollLineReference: string;
    readonly previouslyPaid: string;
    readonly remainingOutstanding: string;
    readonly reversedAt: string | null;
  }[];
  readonly cashVoucherReference: string;
  readonly employeeCount?: number;
  readonly remainingPayrollOutstanding?: string;
  readonly totalApplied?: string;
  readonly unappliedAmount?: string;
  readonly companyName: string;
  readonly createdAt: string;
  readonly externalReference: string | null;
  readonly id: string;
  readonly notes: string | null;
  readonly paidBy: string;
  readonly paymentDate: string;
  readonly paymentNumber: string;
  readonly payrollPeriod: string;
  readonly periodId: string;
  readonly reversalOfPaymentId?: string | null;
  readonly reversalOfPaymentNumber?: string | null;
  readonly reversalReason: string | null;
  readonly reversedByPaymentId?: string | null;
  readonly reversedByPaymentNumber?: string | null;
  readonly reversedAt: string | null;
  readonly reversedBy: string | null;
  readonly status: string;
  readonly totalAmount: string;
}

const pageSize = 25;

export function PayrollWorkspace({
  api,
  feeAccrualDetailId,
  feePaymentDetailId,
  onDetailClose,
  paymentDetailId,
  periodDetailId,
  permissions,
}: {
  api: ApiClient;
  /** Fee accrual opened by `/payroll/driver-fees/accruals/:id`. */
  feeAccrualDetailId?: string | undefined;
  /** Fee Payment opened by `/payroll/driver-fees/payments/:id`. */
  feePaymentDetailId?: string | undefined;
  onDetailClose?: (() => void) | undefined;
  /** Payment opened by `/payroll/payments/:id`. */
  paymentDetailId?: string | undefined;
  /** Period opened by `/payroll/periods/:id`. */
  periodDetailId?: string | undefined;
  permissions: readonly string[];
}) {
  const { i18n, t } = useTranslation();
  const [tab, setTab] = useState<PayrollTab>("employees");
  const [periods, setPeriods] = useState<Page<PeriodRow>>();
  const [periodPage, setPeriodPage] = useState(1);
  const [periodFilters, setPeriodFilters] = useState({
    dateFrom: "",
    dateTo: "",
    month: "",
    outstandingOnly: false,
    search: "",
    status: "",
  });
  const [selectedPeriodId, setSelectedPeriodId] = useState<string>();
  const [period, setPeriod] = useState<PeriodDetail>();
  const [summary, setSummary] = useState<PeriodSummary>();
  const [lines, setLines] = useState<Page<PayrollLine>>();
  const [linePage, setLinePage] = useState(1);
  const [lineFilters, setLineFilters] = useState({
    department: "",
    employee: "",
    employeeType: "",
    heldOnly: false,
    outstandingOnly: false,
    status: "",
  });
  const [exceptions, setExceptions] = useState<readonly PayrollException[]>([]);
  const [payments, setPayments] = useState<Page<PaymentRow>>();
  const [paymentPage, setPaymentPage] = useState(1);
  const [paymentFilters, setPaymentFilters] = useState({
    dateFrom: "",
    dateTo: "",
    employee: "",
    month: "",
    number: "",
    status: "",
    voucher: "",
  });
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const payrollActionsRef = useRef<HTMLElement>(null);
  const [dialog, setDialog] = useState<
    | { kind: "adjustment"; line: PayrollLine }
    | { kind: "calculate"; recalculate: boolean }
    | { kind: "close" }
    | { kind: "create" }
    | { kind: "line"; lineId: string }
    | { kind: "payment"; lineId?: string }
    | { kind: "payment-detail"; paymentId: string }
    | { kind: "reverse-payment"; payment: PaymentRow }
    | { kind: "reverse-period" }
    | { kind: "approve" }
    | undefined
  >();

  // `/payroll/periods/:id` selects that Period; `/payroll/payments/:id` opens
  // the existing Payment dialog. Both drive the state the workspace already
  // owns, so there is no second implementation of either screen.
  useEffect(() => {
    if (periodDetailId !== undefined) {
      setSelectedPeriodId(periodDetailId);
      setTab("employees");
    }
  }, [periodDetailId]);
  useEffect(() => {
    if (paymentDetailId !== undefined) {
      setDialog({ kind: "payment-detail", paymentId: paymentDetailId });
      setTab("payments");
    }
  }, [paymentDetailId]);
  // Outsourced Driver Fees live in a tab of this workspace, so their routes
  // select the tab and hand the record down.
  useEffect(() => {
    if (feeAccrualDetailId !== undefined || feePaymentDetailId !== undefined) {
      setTab("driverFees");
    }
  }, [feeAccrualDetailId, feePaymentDetailId]);
  const session = useSessionAccess();
  const closeDialog = useCallback(() => {
    setDialog(undefined);
    // A route-opened dialog closes by navigating back to the list underneath,
    // which still holds its filters, sorting and page.
    if (paymentDetailId !== undefined) onDetailClose?.();
  }, [onDetailClose, paymentDetailId]);

  const can = useCallback(
    (permission: string) =>
      permissions.includes(permission) || permissions.includes("users_roles.manage"),
    [permissions],
  );
  const reportLanguage = i18n.resolvedLanguage?.startsWith("ar") ? "ar" : "en";
  // Selecting a Period or opening a Payment navigates to that record's
  // canonical route, so both are addressable, refresh-safe and linkable from
  // Accounting. Routes come from the central map, never written inline.
  const openPeriod = useCallback(
    (periodId: string) => {
      const path = recordRoute("payroll_period", periodId);
      if (session !== undefined && path !== undefined) {
        session.navigate(path);
        return;
      }
      setSelectedPeriodId(periodId);
      window.requestAnimationFrame(() => {
        payrollActionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },
    [session],
  );
  const openPayment = useCallback(
    (paymentId: string) => {
      const path = recordRoute("payroll_payment", paymentId);
      if (session !== undefined && path !== undefined) {
        session.navigate(path);
        return;
      }
      setDialog({ kind: "payment-detail", paymentId });
    },
    [session],
  );
  const money = useCallback(
    (value: string | number) =>
      new Intl.NumberFormat(reportLanguage === "ar" ? "ar-AE" : "en-AE", {
        currency: "AED",
        style: "currency",
      }).format(Number(value)),
    [reportLanguage],
  );

  const loadPeriods = useCallback(async () => {
    const query = queryString({
      outstandingOnly: periodFilters.outstandingOnly || undefined,
      dateFrom: periodFilters.dateFrom || undefined,
      dateTo: periodFilters.dateTo || undefined,
      page: periodPage,
      pageSize,
      payrollMonth: periodFilters.month || undefined,
      search: periodFilters.search || undefined,
      status: periodFilters.status || undefined,
    });
    const result = await api.get<Page<PeriodRow>>(`operations/payroll/periods?${query}`);
    setPeriods(result);
    setSelectedPeriodId((current) => current ?? result.items[0]?.id);
  }, [api, periodFilters, periodPage]);

  const loadSelected = useCallback(async () => {
    if (selectedPeriodId === undefined) {
      setPeriod(undefined);
      setSummary(undefined);
      setLines(undefined);
      setExceptions([]);
      return;
    }
    const lineQuery = queryString({
      department: lineFilters.department || undefined,
      employee: lineFilters.employee || undefined,
      employeeType: lineFilters.employeeType || undefined,
      heldOnly: lineFilters.heldOnly || undefined,
      outstandingOnly: lineFilters.outstandingOnly || undefined,
      page: linePage,
      pageSize,
      status: lineFilters.status || undefined,
    });
    const [detail, totals, linePageResult, exceptionRows] = await Promise.all([
      api.get<PeriodDetail>(`operations/payroll/periods/${selectedPeriodId}`),
      api.get<PeriodSummary>(`operations/payroll/periods/${selectedPeriodId}/summary`),
      api.get<Page<PayrollLine>>(
        `operations/payroll/periods/${selectedPeriodId}/lines?${lineQuery}`,
      ),
      api.get<readonly PayrollException[]>(
        `operations/payroll/periods/${selectedPeriodId}/exceptions`,
      ),
    ]);
    setPeriod(detail);
    setSummary(totals);
    setLines(linePageResult);
    setExceptions(exceptionRows);
  }, [api, lineFilters, linePage, selectedPeriodId]);

  const loadPayments = useCallback(async () => {
    const query = queryString({
      employee: paymentFilters.employee || undefined,
      paymentDateFrom: paymentFilters.dateFrom || undefined,
      paymentDateTo: paymentFilters.dateTo || undefined,
      page: paymentPage,
      pageSize,
      paymentNumber: paymentFilters.number || undefined,
      payrollMonth: paymentFilters.month || undefined,
      status: paymentFilters.status || undefined,
      voucherReference: paymentFilters.voucher || undefined,
    });
    setPayments(await api.get<Page<PaymentRow>>(`operations/payroll/payments?${query}`));
  }, [api, paymentFilters, paymentPage]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      await Promise.all([
        loadPeriods(),
        loadSelected(),
        tab === "payments" || tab === "reports" ? loadPayments() : Promise.resolve(),
      ]);
    } catch (loadError) {
      setError(errorMessage(loadError, t("payroll.errors.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [loadPayments, loadPeriods, loadSelected, t, tab]);

  useEffect(() => {
    void loadPeriods().catch((loadError) =>
      setError(errorMessage(loadError, t("payroll.errors.loadFailed"))),
    );
  }, [loadPeriods, t]);
  useEffect(() => {
    void loadSelected().catch((loadError) =>
      setError(errorMessage(loadError, t("payroll.errors.loadFailed"))),
    );
  }, [loadSelected, t]);
  useEffect(() => {
    if (tab === "payments" || tab === "reports") {
      void loadPayments().catch((loadError) =>
        setError(errorMessage(loadError, t("payroll.errors.loadFailed"))),
      );
    }
  }, [loadPayments, t, tab]);

  const actionDisabled = (action: string): string | undefined => {
    if (period === undefined) return t("payroll.disabled.selectPeriod");
    switch (action) {
      case "calculate":
      case "recalculate":
        return ["draft", "calculated"].includes(period.status)
          ? undefined
          : t("payroll.disabled.beforeApproval");
      case "approve":
        if (period.status !== "calculated") return t("payroll.disabled.mustBeCalculated");
        return period.exceptionSummary.blocking > 0
          ? t("payroll.disabled.blockingExceptions")
          : undefined;
      case "pay":
        if (!["approved", "partially_paid", "paid"].includes(period.status)) {
          return t("payroll.disabled.mustBeApproved");
        }
        return Number(period.totalOutstanding) > 0
          ? undefined
          : t("payroll.empty.payableEmployees");
      case "close":
        return Number(period.totalOutstanding) === 0 &&
          ["approved", "partially_paid", "paid"].includes(period.status)
          ? undefined
          : t("payroll.disabled.outstandingBalance");
      case "reverse":
        return period.status === "reversed" ? t("payroll.disabled.alreadyReversed") : undefined;
      default:
        return undefined;
    }
  };

  return (
    <section className="payroll-workspace">
      <PageHeader
        actions={
          <>
            {tab !== "driverFees" && can("payroll.manage") ? (
              <button
                className="button button-primary"
                onClick={() => setDialog({ kind: "create" })}
                type="button"
              >
                {t("payroll.actions.newPeriod")}
              </button>
            ) : null}
            <button
              className="button button-secondary"
              disabled={loading}
              onClick={() => void refresh()}
              type="button"
            >
              {t("common.refresh")}
            </button>
          </>
        }
        description={t("payroll.description")}
        eyebrow={t("payroll.eyebrow")}
        title={t("payroll.title")}
      />
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}

      <div className="workspace-tabs payroll-main-tabs" role="tablist">
        {(
          [
            "employees",
            ...(can("outsourced_driver_fees.view") ? (["driverFees"] as const) : []),
            "payments",
            "reports",
          ] as PayrollTab[]
        ).map((item) => (
          <button
            aria-selected={tab === item}
            key={item}
            onClick={() => setTab(item)}
            role="tab"
            type="button"
          >
            {t(`payroll.tabs.${item}`)}
          </button>
        ))}
      </div>

      {tab === "driverFees" ? null : (
        <section
          ref={payrollActionsRef}
          className="payroll-toolbar"
          aria-label={t("payroll.actions.title")}
        >
          <label className="field">
            <span>{t("payroll.fields.activePeriod")}</span>
            <select
              onChange={(event) => setSelectedPeriodId(event.target.value || undefined)}
              value={selectedPeriodId ?? ""}
            >
              <option value="">{t("payroll.placeholders.selectPeriod")}</option>
              {periods?.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.periodReference} - {item.payrollMonth}
                </option>
              ))}
            </select>
          </label>
          <div className="heading-actions payroll-primary-actions">
            {can("payroll.manage") ? (
              <>
                <ActionButton
                  disabledReason={actionDisabled("calculate")}
                  label={t("payroll.actions.calculate")}
                  onClick={() => setDialog({ kind: "calculate", recalculate: false })}
                />
                <ActionButton
                  disabledReason={actionDisabled("recalculate")}
                  label={t("payroll.actions.recalculate")}
                  onClick={() => setDialog({ kind: "calculate", recalculate: true })}
                />
              </>
            ) : null}
            {can("payroll.approve") ? (
              <>
                <ActionButton
                  disabledReason={actionDisabled("approve")}
                  label={t("payroll.actions.approve")}
                  onClick={() => setDialog({ kind: "approve" })}
                />
                <ActionButton
                  disabledReason={actionDisabled("close")}
                  label={t("payroll.actions.closePeriod")}
                  onClick={() => setDialog({ kind: "close" })}
                />
              </>
            ) : null}
            {can("payroll.pay") ? (
              <ActionButton
                disabledReason={actionDisabled("pay")}
                label={t("payroll.actions.payEmployees")}
                onClick={() => setDialog({ kind: "payment" })}
              />
            ) : null}
            {can("payroll.reverse") ? (
              <ActionButton
                disabledReason={actionDisabled("reverse")}
                label={t("payroll.actions.reversePeriod")}
                onClick={() => setDialog({ kind: "reverse-period" })}
              />
            ) : null}
          </div>
        </section>
      )}

      {tab === "driverFees" ? null : (
        <SummaryCards money={money} period={period} summary={summary} />
      )}

      {tab === "employees" && selectedPeriodId !== undefined && selectedPeriodId !== "" ? (
        // Accounting for the selected Payroll Period. Additive: renders
        // nothing for a User without Accounting access.
        <AccountingRelatedPanel api={api} sourceId={selectedPeriodId} sourceType="payroll_period" />
      ) : null}

      {tab === "driverFees" ? (
        <OutsourcedDriverFeesWorkspace
          accrualDetailId={feeAccrualDetailId}
          api={api}
          onDetailClose={onDetailClose}
          paymentDetailId={feePaymentDetailId}
          permissions={permissions}
        />
      ) : tab === "employees" ? (
        <>
          <PeriodList
            filters={periodFilters}
            money={money}
            onFilters={setPeriodFilters}
            onOpen={openPeriod}
            onPage={setPeriodPage}
            page={periods}
            selectedPeriodId={selectedPeriodId}
          />
          <ExceptionPanel exceptions={exceptions.filter((item) => item.status === "active")} />
          <LineTable
            canAdjust={can("payroll.manage")}
            canPay={can("payroll.pay")}
            canReport={can("reports.export")}
            filters={lineFilters}
            lines={lines}
            money={money}
            onAdjust={(line) => setDialog({ kind: "adjustment", line })}
            onFilters={setLineFilters}
            onPage={setLinePage}
            onPay={(lineId) => setDialog({ kind: "payment", lineId })}
            onView={(lineId) => setDialog({ kind: "line", lineId })}
            periodStatus={period?.status}
            reportLanguage={reportLanguage}
            api={api}
          />
        </>
      ) : tab === "payments" ? (
        <PaymentTable
          canReport={can("reports.export")}
          canReverse={can("payroll.reverse")}
          filters={paymentFilters}
          money={money}
          onFilters={setPaymentFilters}
          onPage={setPaymentPage}
          onReverse={(payment) => setDialog({ kind: "reverse-payment", payment })}
          onView={openPayment}
          page={payments}
          reportLanguage={reportLanguage}
          api={api}
        />
      ) : (
        <>
          <ReportsTab
            api={api}
            canExport={can("reports.export")}
            lines={lines?.items ?? []}
            payments={payments?.items ?? []}
            periods={periods?.items ?? []}
            reportLanguage={reportLanguage}
            selectedPeriodId={selectedPeriodId}
          />
          {can("outsourced_driver_fees.view") ? (
            <DriverFeeReports
              api={api}
              canExport={can("reports.export")}
              language={reportLanguage}
            />
          ) : null}
        </>
      )}

      {dialog?.kind === "create" ? (
        <CreatePeriodDialog api={api} onClose={() => setDialog(undefined)} onSuccess={refresh} />
      ) : null}
      {dialog?.kind === "calculate" && period !== undefined ? (
        <CalculationDialog
          api={api}
          onClose={() => setDialog(undefined)}
          onSuccess={refresh}
          period={period}
          recalculate={dialog.recalculate}
          money={money}
        />
      ) : null}
      {dialog?.kind === "approve" && period !== undefined ? (
        <PeriodActionDialog
          action="approve"
          api={api}
          onClose={() => setDialog(undefined)}
          onSuccess={refresh}
          period={period}
          summary={summary}
          money={money}
        />
      ) : null}
      {dialog?.kind === "close" && period !== undefined ? (
        <PeriodActionDialog
          action="close"
          api={api}
          onClose={() => setDialog(undefined)}
          onSuccess={refresh}
          period={period}
          summary={summary}
          money={money}
        />
      ) : null}
      {dialog?.kind === "reverse-period" && period !== undefined ? (
        <PeriodActionDialog
          action="reverse"
          api={api}
          onClose={() => setDialog(undefined)}
          onSuccess={refresh}
          period={period}
          summary={summary}
          money={money}
        />
      ) : null}
      {dialog?.kind === "adjustment" ? (
        <AdjustmentDialog
          api={api}
          line={dialog.line}
          onClose={() => setDialog(undefined)}
          onSuccess={refresh}
          money={money}
        />
      ) : null}
      {dialog?.kind === "payment" && period !== undefined ? (
        <PaymentDialog
          api={api}
          canReport={can("reports.export")}
          initialLineId={dialog.lineId}
          onClose={() => setDialog(undefined)}
          onSuccess={refresh}
          onView={openPayment}
          period={period}
          money={money}
          reportLanguage={reportLanguage}
        />
      ) : null}
      {dialog?.kind === "line" ? (
        <LineDetailDialog
          api={api}
          canAdjust={can("payroll.manage")}
          canPay={can("payroll.pay")}
          canReport={can("reports.export")}
          canReverse={can("payroll.reverse")}
          lineId={dialog.lineId}
          money={money}
          onAdjust={(line) => setDialog({ kind: "adjustment", line })}
          onClose={() => setDialog(undefined)}
          onPay={() => setDialog({ kind: "payment", lineId: dialog.lineId })}
          onRefresh={refresh}
          reportLanguage={reportLanguage}
        />
      ) : null}
      {dialog?.kind === "payment-detail" ? (
        <PaymentDetailDialog
          api={api}
          canReport={can("reports.export")}
          canReverse={can("payroll.reverse")}
          money={money}
          onClose={closeDialog}
          onRefresh={refresh}
          paymentId={dialog.paymentId}
          reportLanguage={reportLanguage}
        />
      ) : null}
      {dialog?.kind === "reverse-payment" ? (
        <ReversePaymentDialog
          api={api}
          money={money}
          onClose={() => setDialog(undefined)}
          onSuccess={refresh}
          payment={dialog.payment}
        />
      ) : null}
    </section>
  );
}

function ActionButton({
  disabledReason,
  label,
  onClick,
}: {
  disabledReason: string | undefined;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabledReason !== undefined}
      onClick={onClick}
      title={disabledReason}
      type="button"
    >
      {label}
    </button>
  );
}

function SummaryCards({
  money,
  period,
  summary,
}: {
  money: (value: string | number) => string;
  period: PeriodDetail | undefined;
  summary: PeriodSummary | undefined;
}) {
  const { t } = useTranslation();
  // Every figure is a stored Period aggregate. Nothing is summed in the
  // browser: the backend owns Payroll arithmetic, and re-adding formatted
  // strings here would be a second, divergent source of truth.
  const cards = [
    [t("payroll.summary.totalEmployees"), String(summary?.employeeCount ?? 0)],
    [t("payroll.summary.basicSalary"), money(period?.totalBasicSalary ?? "0")],
    [t("payroll.summary.allowances"), money(period?.totalAllowances ?? "0")],
    [t("payroll.summary.commissions"), money(period?.totalDriverCommission ?? "0")],
    [t("payroll.summary.adjustments"), money(period?.totalEarningAdjustments ?? "0")],
    [t("payroll.summary.grossPayroll"), money(period?.totalGrossEarnings ?? "0")],
    [t("payroll.summary.totalDeductions"), money(period?.totalDeductions ?? "0")],
    [t("payroll.summary.netPayroll"), money(period?.totalNetSalary ?? "0")],
    [t("payroll.summary.paid"), money(period?.totalPaid ?? "0")],
    [t("payroll.summary.outstanding"), money(period?.totalOutstanding ?? "0")],
  ];
  return (
    <>
      <div className="metric-grid">
        {cards.map(([label, value]) => (
          <article className="metric-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </div>
      <div className="summary-secondary">
        <MetricChip label={t("payroll.summary.held")} value={summary?.heldCount ?? 0} />
        <MetricChip
          label={t("payroll.summary.exceptions")}
          value={period?.exceptionSummary.active ?? 0}
        />
        <MetricChip
          label={t("payroll.summary.partiallyPaid")}
          value={summary?.partiallyPaidCount ?? 0}
        />
        <MetricChip label={t("payroll.summary.fullyPaid")} value={summary?.paidCount ?? 0} />
      </div>
    </>
  );
}

function MetricChip({ label, value }: { label: string; value: number }) {
  return (
    <span className="metric-chip">
      {label} <strong>{value}</strong>
    </span>
  );
}

function PeriodList({
  filters,
  money,
  onFilters,
  onOpen,
  onPage,
  page,
  selectedPeriodId,
}: {
  filters: {
    dateFrom: string;
    dateTo: string;
    month: string;
    outstandingOnly: boolean;
    search: string;
    status: string;
  };
  money: (value: string | number) => string;
  onFilters: (value: typeof filters) => void;
  onOpen: (id: string) => void;
  onPage: (page: number) => void;
  page: Page<PeriodRow> | undefined;
  selectedPeriodId: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <section className="workspace-step">
      <h2>{t("payroll.periods.title")}</h2>
      <div className="compact-filters">
        <Field label={t("payroll.fields.periodReference")}>
          <input
            value={filters.search}
            onChange={(e) => onFilters({ ...filters, search: e.target.value })}
          />
        </Field>
        <Field label={t("payroll.fields.payrollMonth")}>
          <input
            type="month"
            value={filters.month}
            onChange={(e) => onFilters({ ...filters, month: e.target.value })}
          />
        </Field>
        <Field label={t("common.status")}>
          <StatusSelect
            value={filters.status}
            onChange={(status) => onFilters({ ...filters, status })}
            kind="period"
          />
        </Field>
        <Field label={t("payroll.fields.dateFrom")}>
          <input
            type="date"
            value={filters.dateFrom}
            onChange={(e) => onFilters({ ...filters, dateFrom: e.target.value })}
          />
        </Field>
        <Field label={t("payroll.fields.dateTo")}>
          <input
            type="date"
            value={filters.dateTo}
            onChange={(e) => onFilters({ ...filters, dateTo: e.target.value })}
          />
        </Field>
        <label className="checkbox-field">
          <input
            checked={filters.outstandingOnly}
            onChange={(e) => onFilters({ ...filters, outstandingOnly: e.target.checked })}
            type="checkbox"
          />
          <span>{t("payroll.filters.outstandingOnly")}</span>
        </label>
        <button
          className="button button-secondary"
          onClick={() =>
            onFilters({
              dateFrom: "",
              dateTo: "",
              month: "",
              outstandingOnly: false,
              search: "",
              status: "",
            })
          }
          type="button"
        >
          {t("payroll.filters.clear")}
        </button>
      </div>
      <div className="table-scroll-x">
        <table>
          <thead>
            <tr>
              {[
                "period",
                "month",
                "dates",
                "status",
                "employees",
                "net",
                "paid",
                "outstanding",
                "created",
                "approved",
                "closed",
                "actions",
              ].map((key) => (
                <th key={key}>{t(`payroll.columns.${key}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page?.items.length === 0 ? (
              <EmptyRow colSpan={12} text={t("payroll.empty.periods")} />
            ) : (
              page?.items.map((row) => (
                <tr className={row.id === selectedPeriodId ? "row-selected" : ""} key={row.id}>
                  <td className="mono">{row.periodReference}</td>
                  <td>{row.payrollMonth}</td>
                  <td>
                    {row.periodStart} - {row.periodEnd}
                  </td>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td>{row.totalEmployees}</td>
                  <td>{money(row.netPayroll)}</td>
                  <td>{money(row.totalPaid)}</td>
                  <td>{money(row.totalOutstanding)}</td>
                  <td>{dateTime(row.createdAt)}</td>
                  <td>{dateTime(row.approvedAt)}</td>
                  <td>{dateTime(row.closedAt)}</td>
                  <td>
                    <button onClick={() => onOpen(row.id)} type="button">
                      {t("common.view")}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pagination onPage={onPage} page={page} />
    </section>
  );
}

function ExceptionPanel({ exceptions }: { exceptions: readonly PayrollException[] }) {
  const { t } = useTranslation();
  return (
    <section className="workspace-step">
      <h2>{t("payroll.exceptions.title")}</h2>
      {exceptions.length === 0 ? (
        <p className="empty-panel">{t("payroll.empty.exceptions")}</p>
      ) : (
        <div className="payroll-exceptions">
          {exceptions.map((item) => (
            <article
              className={`payroll-exception payroll-exception-${item.severity}`}
              key={item.id}
            >
              <strong>{item.employeeName ?? t("payroll.exceptions.period")}</strong>
              <span>{item.employeeNumber ?? "-"}</span>
              <span>{item.category}</span>
              <p>{item.message}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function LineTable({
  api,
  canAdjust,
  canPay,
  canReport,
  filters,
  lines,
  money,
  onAdjust,
  onFilters,
  onPage,
  onPay,
  onView,
  periodStatus,
  reportLanguage,
}: {
  api: ApiClient;
  canAdjust: boolean;
  canPay: boolean;
  canReport: boolean;
  filters: {
    department: string;
    employee: string;
    employeeType: string;
    heldOnly: boolean;
    outstandingOnly: boolean;
    status: string;
  };
  lines: Page<PayrollLine> | undefined;
  money: (value: string | number) => string;
  onAdjust: (line: PayrollLine) => void;
  onFilters: (value: typeof filters) => void;
  onPage: (page: number) => void;
  onPay: (lineId: string) => void;
  onView: (id: string) => void;
  periodStatus: PeriodStatus | undefined;
  reportLanguage: string;
}) {
  const { t } = useTranslation();
  const pdf = useReconciliationPdfActions(api);
  const [pdfError, setPdfError] = useState<string>();
  const runPdf = async (line: PayrollLine, action: PdfAction) => {
    const error = await pdf.run(
      `operations/payroll/lines/${line.id}/payslip/pdf?language=${reportLanguage}`,
      `Payslip-${line.payrollLineReference}.pdf`,
      action,
    );
    if (error !== undefined) setPdfError(errorMessage(error, t("payroll.errors.pdfFailed")));
  };
  const reportAvailable = !["draft", "calculated"].includes(periodStatus ?? "draft");
  return (
    <section className="workspace-step">
      <h2>{t("payroll.lines.title")}</h2>
      {pdfError === undefined ? null : <div className="alert alert-error">{pdfError}</div>}
      <div className="compact-filters">
        <Field label={t("payroll.fields.employee")}>
          <input
            value={filters.employee}
            onChange={(e) => onFilters({ ...filters, employee: e.target.value })}
          />
        </Field>
        <Field label={t("payroll.fields.department")}>
          <input
            value={filters.department}
            onChange={(e) => onFilters({ ...filters, department: e.target.value })}
          />
        </Field>
        <Field label={t("payroll.fields.employmentType")}>
          <input
            value={filters.employeeType}
            onChange={(e) => onFilters({ ...filters, employeeType: e.target.value })}
          />
        </Field>
        <Field label={t("common.status")}>
          <StatusSelect
            kind="line"
            value={filters.status}
            onChange={(status) => onFilters({ ...filters, status })}
          />
        </Field>
        <label className="checkbox-field">
          <input
            checked={filters.outstandingOnly}
            onChange={(e) => onFilters({ ...filters, outstandingOnly: e.target.checked })}
            type="checkbox"
          />
          <span>{t("payroll.filters.outstandingOnly")}</span>
        </label>
        <label className="checkbox-field">
          <input
            checked={filters.heldOnly}
            onChange={(e) => onFilters({ ...filters, heldOnly: e.target.checked })}
            type="checkbox"
          />
          <span>{t("payroll.filters.heldOnly")}</span>
        </label>
        <button
          className="button button-secondary"
          onClick={() =>
            onFilters({
              department: "",
              employee: "",
              employeeType: "",
              heldOnly: false,
              outstandingOnly: false,
              status: "",
            })
          }
          type="button"
        >
          {t("payroll.filters.clear")}
        </button>
      </div>
      <div className="table-scroll-x">
        <table>
          <thead>
            <tr>
              {[
                "employee",
                "employeeNumber",
                "employmentType",
                "basic",
                "allowances",
                "commission",
                "earningAdjustments",
                "deductions",
                "net",
                "paid",
                "outstanding",
                "status",
                "actions",
              ].map((key) => (
                <th key={key}>{t(`payroll.columns.${key}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines?.items.length === 0 ? (
              <EmptyRow colSpan={13} text={t("payroll.empty.lines")} />
            ) : (
              lines?.items.map((line) => (
                <tr key={line.id}>
                  <td>{line.employeeName}</td>
                  <td>{line.employeeNumber}</td>
                  <td>{line.employmentType ?? "-"}</td>
                  <td>{money(line.basicSalary)}</td>
                  <td>{money(line.allowances)}</td>
                  <td>{money(line.driverCommission)}</td>
                  <td>{money(line.earningAdjustments)}</td>
                  <td>{money(line.deductions)}</td>
                  <td>{money(line.netSalary)}</td>
                  <td>{money(line.paid)}</td>
                  <td>{money(line.outstanding)}</td>
                  <td>
                    <StatusBadge status={line.status} />
                  </td>
                  <td>
                    <div className="table-actions">
                      <button onClick={() => onView(line.id)} type="button">
                        {t("common.view")}
                      </button>
                      {canAdjust && ["draft", "calculated"].includes(line.status) ? (
                        <button onClick={() => onAdjust(line)} type="button">
                          {t("payroll.actions.addAdjustment")}
                        </button>
                      ) : null}
                      {canPay &&
                      ["approved", "partially_paid"].includes(line.status) &&
                      Number(line.outstanding) > 0 ? (
                        <button onClick={() => onPay(line.id)} type="button">
                          {t("payroll.actions.pay")}
                        </button>
                      ) : null}
                      {canReport && reportAvailable ? (
                        <>
                          <button
                            disabled={pdf.busy !== undefined}
                            onClick={() => void runPdf(line, "preview")}
                            type="button"
                          >
                            {t("payroll.actions.previewPayslip")}
                          </button>
                          <button
                            disabled={pdf.busy !== undefined}
                            onClick={() => void runPdf(line, "print")}
                            type="button"
                          >
                            {t("common.print")}
                          </button>
                          <button
                            disabled={pdf.busy !== undefined}
                            onClick={() => void runPdf(line, "download")}
                            type="button"
                          >
                            {t("payroll.actions.downloadPdf")}
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
      <Pagination onPage={onPage} page={lines} />
    </section>
  );
}

function PaymentTable({
  api,
  canReport,
  canReverse,
  filters,
  money,
  onFilters,
  onPage,
  onReverse,
  onView,
  page,
  reportLanguage,
}: {
  api: ApiClient;
  canReport: boolean;
  canReverse: boolean;
  filters: {
    dateFrom: string;
    dateTo: string;
    employee: string;
    month: string;
    number: string;
    status: string;
    voucher: string;
  };
  money: (value: string | number) => string;
  onFilters: (value: typeof filters) => void;
  onPage: (page: number) => void;
  onReverse: (payment: PaymentRow) => void;
  onView: (id: string) => void;
  page: Page<PaymentRow> | undefined;
  reportLanguage: string;
}) {
  const { t } = useTranslation();
  const pdf = useReconciliationPdfActions(api);
  const [error, setError] = useState<string>();
  const run = async (payment: PaymentRow, action: PdfAction) => {
    const issue = await pdf.run(
      `operations/payroll/payments/${payment.id}/pdf?language=${reportLanguage}`,
      `Payroll-Payment-${payment.paymentNumber}.pdf`,
      action,
    );
    if (issue !== undefined) setError(errorMessage(issue, t("payroll.errors.pdfFailed")));
  };
  return (
    <section className="workspace-step">
      <h2>{t("payroll.payments.title")}</h2>
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      <div className="compact-filters">
        <Field label={t("payroll.fields.paymentNumber")}>
          <input
            value={filters.number}
            onChange={(e) => onFilters({ ...filters, number: e.target.value })}
          />
        </Field>
        <Field label={t("payroll.fields.payrollMonth")}>
          <input
            type="month"
            value={filters.month}
            onChange={(e) => onFilters({ ...filters, month: e.target.value })}
          />
        </Field>
        <Field label={t("payroll.fields.employee")}>
          <input
            value={filters.employee}
            onChange={(e) => onFilters({ ...filters, employee: e.target.value })}
          />
        </Field>
        <Field label={t("payroll.fields.dateFrom")}>
          <input
            type="date"
            value={filters.dateFrom}
            onChange={(e) => onFilters({ ...filters, dateFrom: e.target.value })}
          />
        </Field>
        <Field label={t("payroll.fields.dateTo")}>
          <input
            type="date"
            value={filters.dateTo}
            onChange={(e) => onFilters({ ...filters, dateTo: e.target.value })}
          />
        </Field>
        <Field label={t("payroll.fields.voucher")}>
          <input
            value={filters.voucher}
            onChange={(e) => onFilters({ ...filters, voucher: e.target.value })}
          />
        </Field>
        <Field label={t("common.status")}>
          <StatusSelect
            kind="payment"
            value={filters.status}
            onChange={(status) => onFilters({ ...filters, status })}
          />
        </Field>
        <button
          className="button button-secondary"
          onClick={() =>
            onFilters({
              dateFrom: "",
              dateTo: "",
              employee: "",
              month: "",
              number: "",
              status: "",
              voucher: "",
            })
          }
          type="button"
        >
          {t("payroll.filters.clear")}
        </button>
      </div>
      <div className="table-scroll-x">
        <table>
          <thead>
            <tr>
              {[
                "paymentNumber",
                "period",
                "paymentDate",
                "employees",
                "totalAmount",
                "voucher",
                "acknowledgement",
                "status",
                "paidBy",
                "reversed",
                "actions",
              ].map((key) => (
                <th key={key}>{t(`payroll.columns.${key}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page?.items.length === 0 ? (
              <EmptyRow colSpan={11} text={t("payroll.empty.payments")} />
            ) : (
              page?.items.map((payment) => (
                <tr key={payment.id}>
                  <td>{payment.paymentNumber}</td>
                  <td>{payment.payrollPeriod}</td>
                  <td>{payment.paymentDate}</td>
                  <td>{payment.employeeCount}</td>
                  <td>{money(payment.totalAmount)}</td>
                  <td>{payment.voucherReference}</td>
                  <td>{t(`payroll.acknowledgement.${payment.acknowledgementType}`)}</td>
                  <td>
                    <StatusBadge status={payment.status} />
                  </td>
                  <td>{payment.paidBy}</td>
                  <td>{t(payment.reversed ? "payroll.values.yes" : "payroll.values.no")}</td>
                  <td>
                    <div className="table-actions">
                      <button onClick={() => onView(payment.id)} type="button">
                        {t("common.view")}
                      </button>
                      {canReverse && !payment.reversed ? (
                        <button onClick={() => onReverse(payment)} type="button">
                          {t("payroll.actions.reverse")}
                        </button>
                      ) : null}
                      {canReport ? (
                        <>
                          <button
                            disabled={pdf.busy !== undefined}
                            onClick={() => void run(payment, "preview")}
                            type="button"
                          >
                            {t("payroll.actions.previewReport")}
                          </button>
                          <button
                            disabled={pdf.busy !== undefined}
                            onClick={() => void run(payment, "print")}
                            type="button"
                          >
                            {t("common.print")}
                          </button>
                          <button
                            disabled={pdf.busy !== undefined}
                            onClick={() => void run(payment, "download")}
                            type="button"
                          >
                            {t("payroll.actions.downloadPdf")}
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
      <Pagination onPage={onPage} page={page} />
    </section>
  );
}

function ReportsTab({
  api,
  canExport,
  lines,
  payments,
  periods,
  reportLanguage,
  selectedPeriodId,
}: {
  api: ApiClient;
  canExport: boolean;
  lines: readonly PayrollLine[];
  payments: readonly PaymentRow[];
  periods: readonly PeriodRow[];
  reportLanguage: string;
  selectedPeriodId: string | undefined;
}) {
  const { t } = useTranslation();
  const pdf = useReconciliationPdfActions(api);
  const [periodId, setPeriodId] = useState(selectedPeriodId ?? "");
  const [lineId, setLineId] = useState("");
  const [reportLines, setReportLines] = useState<readonly PayrollLine[]>(lines);
  const [paymentId, setPaymentId] = useState("");
  const [month, setMonth] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => setPeriodId(selectedPeriodId ?? ""), [selectedPeriodId]);
  useEffect(() => {
    setLineId("");
    if (periodId === "") {
      setReportLines([]);
      return;
    }
    void api
      .get<Page<PayrollLine>>(`operations/payroll/periods/${periodId}/lines?page=1&pageSize=500`)
      .then((page) => setReportLines(page.items))
      .catch((issue) => setError(errorMessage(issue, t("payroll.errors.loadFailed"))));
  }, [api, periodId, t]);
  const run = async (path: string, filename: string, action: PdfAction) => {
    const issue = await pdf.run(`${path}?language=${reportLanguage}`, filename, action);
    if (issue !== undefined) setError(errorMessage(issue, t("payroll.errors.pdfFailed")));
  };
  if (!canExport) return <p className="empty-panel">{t("payroll.empty.reportPermission")}</p>;
  const reportPeriods = periods.filter(
    (period) =>
      !["draft", "calculated"].includes(period.status) &&
      (month === "" || period.payrollMonth === month) &&
      (statusFilter === "" || period.status === statusFilter),
  );
  const reportPayments = payments.filter(
    (payment) =>
      (paymentDate === "" || payment.paymentDate === paymentDate) &&
      (statusFilter === "" || payment.status === statusFilter),
  );
  return (
    <section className="payroll-report-grid">
      {error === undefined ? null : (
        <div className="alert alert-error payroll-report-error">{error}</div>
      )}
      <div className="compact-filters payroll-report-filters">
        <Field label={t("payroll.fields.payrollMonth")}>
          <input onChange={(e) => setMonth(e.target.value)} type="month" value={month} />
        </Field>
        <Field label={t("payroll.fields.paymentDate")}>
          <input onChange={(e) => setPaymentDate(e.target.value)} type="date" value={paymentDate} />
        </Field>
        <Field label={t("common.status")}>
          <StatusSelect kind="period" onChange={setStatusFilter} value={statusFilter} />
        </Field>
        <button
          className="button button-secondary"
          onClick={() => {
            setMonth("");
            setPaymentDate("");
            setStatusFilter("");
            setPeriodId("");
            setLineId("");
            setPaymentId("");
          }}
          type="button"
        >
          {t("payroll.filters.clear")}
        </button>
      </div>
      <ReportCard
        title={t("payroll.reports.register")}
        field={
          <select value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
            <option value="">{t("payroll.placeholders.selectPeriod")}</option>
            {reportPeriods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.periodReference}
              </option>
            ))}
          </select>
        }
        disabled={periodId === ""}
        busy={pdf.busy}
        onAction={(action) =>
          void run(
            `operations/payroll/periods/${periodId}/register/pdf`,
            "Payroll-Register.pdf",
            action,
          )
        }
      />
      <ReportCard
        title={t("payroll.reports.payslip")}
        field={
          <>
            <select value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
              <option value="">{t("payroll.placeholders.selectPeriod")}</option>
              {reportPeriods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.periodReference}
                </option>
              ))}
            </select>
            <select value={lineId} onChange={(e) => setLineId(e.target.value)}>
              <option value="">
                {reportLines.length === 0 && periodId !== ""
                  ? t("payroll.empty.noPayslips")
                  : t("payroll.placeholders.selectEmployee")}
              </option>
              {reportLines.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.employeeNumber} - {line.employeeName}
                </option>
              ))}
            </select>
          </>
        }
        disabled={lineId === ""}
        busy={pdf.busy}
        onAction={(action) =>
          void run(`operations/payroll/lines/${lineId}/payslip/pdf`, "Payslip.pdf", action)
        }
      />
      <ReportCard
        title={t("payroll.reports.payment")}
        field={
          <select value={paymentId} onChange={(e) => setPaymentId(e.target.value)}>
            <option value="">{t("payroll.placeholders.selectPayment")}</option>
            {reportPayments.map((payment) => (
              <option key={payment.id} value={payment.id}>
                {payment.paymentNumber}
              </option>
            ))}
          </select>
        }
        disabled={paymentId === ""}
        busy={pdf.busy}
        onAction={(action) =>
          void run(`operations/payroll/payments/${paymentId}/pdf`, "Payroll-Payment.pdf", action)
        }
      />
    </section>
  );
}

function ReportCard({
  busy,
  disabled,
  field,
  onAction,
  title,
}: {
  busy: PdfAction | undefined;
  disabled: boolean;
  field: ReactNode;
  onAction: (action: PdfAction) => void;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <article className="summary-panel">
      <h2>{title}</h2>
      <label className="field">{field}</label>
      <div className="modal-actions">
        <button
          disabled={disabled || busy !== undefined}
          onClick={() => onAction("preview")}
          type="button"
        >
          {t("payroll.actions.preview")}
        </button>
        <button
          disabled={disabled || busy !== undefined}
          onClick={() => onAction("print")}
          type="button"
        >
          {t("common.print")}
        </button>
        <button
          disabled={disabled || busy !== undefined}
          onClick={() => onAction("download")}
          type="button"
        >
          {t("payroll.actions.downloadPdf")}
        </button>
      </div>
    </article>
  );
}

function CreatePeriodDialog({
  api,
  onClose,
  onSuccess,
}: {
  api: ApiClient;
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const idempotency = useIdempotencyKey();
  const [month, setMonth] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{
    periodId: string;
    periodReference: string;
    status: string;
  }>();
  const submit = async () => {
    if (month === "") return setError(t("payroll.validation.monthRequired"));
    setSaving(true);
    setError(undefined);
    const body = { payrollMonth: month, ...(notes.trim() === "" ? {} : { notes: notes.trim() }) };
    try {
      const created = await api.post<{
        periodId: string;
        periodReference: string;
        status: string;
      }>("operations/payroll/periods", body, {
        "x-idempotency-key": idempotency.keyFor(JSON.stringify(body)),
      });
      setResult(created);
      idempotency.reset();
      await onSuccess();
    } catch (issue) {
      setError(errorMessage(issue, t("payroll.errors.createFailed")));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("payroll.create.title")}
      titleId="payroll-create-title"
    >
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      {result === undefined ? (
        <form onSubmit={(e) => void (e.preventDefault(), submit())}>
          <Field label={t("payroll.fields.payrollMonth")} required>
            <input onChange={(e) => setMonth(e.target.value)} type="month" value={month} />
          </Field>
          <Field label={t("payroll.fields.notes")}>
            <textarea onChange={(e) => setNotes(e.target.value)} value={notes} />
          </Field>
          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button className="button button-primary" disabled={saving} type="submit">
              {saving ? t("common.saving") : t("payroll.actions.createPeriod")}
            </button>
          </div>
        </form>
      ) : (
        <div className="reconciliation-success">
          <h3>{t("payroll.create.success")}</h3>
          <dl className="reconciliation-summary">
            <Detail label={t("payroll.fields.periodReference")} value={result.periodReference} />
            <Detail label={t("payroll.fields.payrollMonth")} value={month} />
            <Detail label={t("common.status")} value={t(`payroll.status.${result.status}`)} />
          </dl>
          <div className="modal-actions">
            <button className="button button-primary" onClick={onClose} type="button">
              {t("payroll.actions.openPeriod")}
            </button>
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CalculationDialog({
  api,
  money,
  onClose,
  onSuccess,
  period,
  recalculate,
}: {
  api: ApiClient;
  money: (value: string | number) => string;
  onClose: () => void;
  onSuccess: () => Promise<void>;
  period: PeriodDetail;
  recalculate: boolean;
}) {
  const { t } = useTranslation();
  const idempotency = useIdempotencyKey();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<CalculationResult>();
  const submit = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const operation = recalculate ? "recalculate" : "calculate";
      const calculated = await api.post<CalculationResult>(
        `operations/payroll/periods/${period.id}/${operation}`,
        undefined,
        { "x-idempotency-key": idempotency.keyFor(`${operation}:${period.id}`) },
      );
      setResult(calculated);
      idempotency.reset();
      await onSuccess();
    } catch (issue) {
      setError(errorMessage(issue, t("payroll.errors.calculationFailed")));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      className="modal-wide"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t(recalculate ? "payroll.calculation.recalculateTitle" : "payroll.calculation.title")}
      titleId="payroll-calculation-title"
    >
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      {result === undefined ? (
        <>
          <dl className="reconciliation-summary">
            <Detail label={t("payroll.fields.periodReference")} value={period.periodReference} />
            <Detail label={t("payroll.fields.payrollMonth")} value={period.payrollMonth} />
          </dl>
          <div className="alert alert-info">
            {t(
              recalculate
                ? "payroll.calculation.recalculateWarning"
                : "payroll.calculation.warning",
            )}
          </div>
          <p>{t("payroll.calculation.noProration")}</p>
          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button
              className="button button-primary"
              disabled={saving}
              onClick={() => void submit()}
              type="button"
            >
              {saving
                ? t("common.working")
                : t(recalculate ? "payroll.actions.recalculate" : "payroll.actions.calculate")}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="metric-grid">
            {[
              [t("payroll.calculation.considered"), result.consideredEmployees],
              [t("payroll.calculation.calculated"), result.calculatedEmployees],
              [t("payroll.summary.held"), result.heldEmployees],
              [t("payroll.calculation.skipped"), result.skippedEmployees],
              [
                t("payroll.summary.exceptions"),
                result.blockingExceptionCount + result.warningCount,
              ],
              [t("payroll.summary.netPayroll"), money(result.totals.netSalary)],
            ].map(([label, value]) => (
              <article className="metric-card" key={String(label)}>
                <span>{label}</span>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
          <dl className="reconciliation-summary">
            <Detail label={t("payroll.columns.basic")} value={money(result.totals.basicSalary)} />
            <Detail
              label={t("payroll.columns.allowances")}
              value={money(result.totals.totalAllowances)}
            />
            <Detail
              label={t("payroll.columns.commission")}
              value={money(result.totals.driverCommission)}
            />
            <Detail
              label={t("payroll.columns.earningAdjustments")}
              value={money(result.totals.earningAdjustments)}
            />
            <Detail
              label={t("payroll.columns.deductions")}
              value={money(result.totals.deductions)}
            />
          </dl>
          {result.recalculationChanges === undefined ? null : (
            <div className="alert alert-info">
              {t("payroll.calculation.changeSummary", {
                added: result.recalculationChanges.employeesAdded.length,
                removed: result.recalculationChanges.employeesRemoved.length,
                held: result.recalculationChanges.employeesMovedToHeld.length,
                released: result.recalculationChanges.employeesReleasedFromHold.length,
              })}
            </div>
          )}
          <ExceptionPanel exceptions={result.exceptions} />
          <div className="modal-actions">
            <button className="button button-primary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function PeriodActionDialog({
  action,
  api,
  money,
  onClose,
  onSuccess,
  period,
  summary,
}: {
  action: "approve" | "close" | "reverse";
  api: ApiClient;
  money: (value: string | number) => string;
  onClose: () => void;
  onSuccess: () => Promise<void>;
  period: PeriodDetail;
  summary: PeriodSummary | undefined;
}) {
  const { t } = useTranslation();
  const idempotency = useIdempotencyKey();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const [completion, setCompletion] = useState<PeriodDetail>();
  const submit = async () => {
    if (action === "reverse" && reason.trim() === "")
      return setError(t("payroll.validation.reasonRequired"));
    const body = action === "reverse" ? { reason: reason.trim() } : undefined;
    setSaving(true);
    setError(undefined);
    try {
      await api.post(`operations/payroll/periods/${period.id}/${action}`, body, {
        "x-idempotency-key": idempotency.keyFor(`${action}:${period.id}:${reason.trim()}`),
      });
      idempotency.reset();
      await onSuccess();
      try {
        setCompletion(await api.get<PeriodDetail>(`operations/payroll/periods/${period.id}`));
      } catch {
        setCompletion(undefined);
      }
      setDone(true);
    } catch (issue) {
      setError(errorMessage(issue, t(`payroll.errors.${action}Failed`)));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t(`payroll.${action}.title`)}
      titleId={`payroll-${action}-title`}
    >
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      {done ? (
        <div className="reconciliation-success">
          <p>{t(`payroll.${action}.success`)}</p>
          {action !== "approve" || completion === undefined ? null : (
            <dl className="reconciliation-summary">
              <Detail label={t("payroll.fields.approvedBy")} value={completion.approvedBy ?? "-"} />
              <Detail
                label={t("payroll.fields.approvedAt")}
                value={dateTime(completion.approvedAt)}
              />
            </dl>
          )}
          <div className="modal-actions">
            <button className="button button-primary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <dl className="reconciliation-summary">
            <Detail label={t("payroll.fields.periodReference")} value={period.periodReference} />
            <Detail label={t("common.status")} value={t(`payroll.status.${period.status}`)} />
            <Detail
              label={t("payroll.summary.totalEmployees")}
              value={String(summary?.employeeCount ?? 0)}
            />
            <Detail label={t("payroll.summary.held")} value={String(summary?.heldCount ?? 0)} />
            <Detail
              label={t("payroll.summary.exceptions")}
              value={String(period.exceptionSummary.active)}
            />
            <Detail label={t("payroll.columns.basic")} value={money(period.totalBasicSalary)} />
            <Detail label={t("payroll.columns.allowances")} value={money(period.totalAllowances)} />
            <Detail
              label={t("payroll.columns.commission")}
              value={money(period.totalDriverCommission)}
            />
            <Detail
              label={t("payroll.columns.earningAdjustments")}
              value={money(period.totalEarningAdjustments)}
            />
            <Detail label={t("payroll.columns.deductions")} value={money(period.totalDeductions)} />
            <Detail label={t("payroll.summary.netPayroll")} value={money(period.totalNetSalary)} />
            <Detail label={t("payroll.summary.paid")} value={money(period.totalPaid)} />
            <Detail
              label={t("payroll.summary.outstanding")}
              value={money(period.totalOutstanding)}
            />
          </dl>
          <div className="alert alert-warning">{t(`payroll.${action}.warning`)}</div>
          {action === "reverse" ? (
            <Field label={t("common.reason")} required>
              <textarea onChange={(e) => setReason(e.target.value)} value={reason} />
            </Field>
          ) : null}
          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button
              className="button button-primary"
              disabled={saving}
              onClick={() => void submit()}
              type="button"
            >
              {saving ? t("common.working") : t(`payroll.actions.${action}`)}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function AdjustmentDialog({
  api,
  line,
  money,
  onClose,
  onSuccess,
}: {
  api: ApiClient;
  line: PayrollLine;
  money: (value: string | number) => string;
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const idempotency = useIdempotencyKey();
  const [form, setForm] = useState({
    adjustmentType: "bonus",
    amount: "",
    direction: "earning",
    notes: "",
    reason: "",
    sourceReference: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const submit = async () => {
    const parsedAmount = parseMoneyInput(form.amount, { allowZero: false });
    if (!parsedAmount.ok) return setError(t("payroll.validation.amountPositive"));
    if (form.reason.trim() === "") return setError(t("payroll.validation.reasonRequired"));
    const body = {
      adjustmentType: form.adjustmentType,
      amount: parsedAmount.value,
      direction: form.direction,
      employeeId: line.employeeId,
      reason: form.reason.trim(),
      ...(form.notes.trim() === "" ? {} : { notes: form.notes.trim() }),
      ...(form.sourceReference.trim() === ""
        ? {}
        : { sourceReference: form.sourceReference.trim() }),
    };
    setSaving(true);
    setError(undefined);
    try {
      await api.post(`operations/payroll/lines/${line.id}/adjustments`, body, {
        "x-idempotency-key": idempotency.keyFor(JSON.stringify(body)),
      });
      idempotency.reset();
      setDone(true);
      await onSuccess();
    } catch (issue) {
      setError(errorMessage(issue, t("payroll.errors.adjustmentFailed")));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("payroll.adjustment.title")}
      titleId="payroll-adjustment-title"
    >
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      {done ? (
        <div className="reconciliation-success">
          <p>{t("payroll.adjustment.success")}</p>
          <button className="button button-primary" onClick={onClose} type="button">
            {t("common.close")}
          </button>
        </div>
      ) : (
        <form onSubmit={(e) => void (e.preventDefault(), submit())}>
          <dl className="reconciliation-summary">
            <Detail
              label={t("payroll.fields.employee")}
              value={`${line.employeeNumber} - ${line.employeeName}`}
            />
            <Detail label={t("payroll.summary.netPayroll")} value={money(line.netSalary)} />
          </dl>
          <div className="form-grid">
            <Field label={t("payroll.fields.adjustmentType")} required>
              <select
                value={form.adjustmentType}
                onChange={(e) => setForm({ ...form, adjustmentType: e.target.value })}
              >
                {[
                  "bonus",
                  "penalty",
                  "unpaid_leave",
                  "advance_recovery",
                  "correction",
                  "other",
                ].map((value) => (
                  <option key={value} value={value}>
                    {t(`payroll.adjustment.types.${value}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("payroll.fields.direction")} required>
              <select
                value={form.direction}
                onChange={(e) => setForm({ ...form, direction: e.target.value })}
              >
                <option value="earning">{t("payroll.adjustment.directions.earning")}</option>
                <option value="deduction">{t("payroll.adjustment.directions.deduction")}</option>
              </select>
            </Field>
            <Field label={t("payroll.fields.amount")} required>
              <input
                min="0.01"
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                step="0.01"
                type="number"
                value={form.amount}
              />
            </Field>
            <Field label={t("payroll.fields.sourceReference")}>
              <input
                onChange={(e) => setForm({ ...form, sourceReference: e.target.value })}
                value={form.sourceReference}
              />
            </Field>
          </div>
          <Field label={t("common.reason")} required>
            <textarea
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              value={form.reason}
            />
          </Field>
          <Field label={t("payroll.fields.notes")}>
            <textarea
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              value={form.notes}
            />
          </Field>
          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button className="button button-primary" disabled={saving} type="submit">
              {saving ? t("common.saving") : t("payroll.actions.addAdjustment")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function PaymentDialog({
  api,
  canReport,
  initialLineId,
  money,
  onClose,
  onSuccess,
  onView,
  period,
  reportLanguage,
}: {
  api: ApiClient;
  canReport: boolean;
  money: (value: string | number) => string;
  onClose: () => void;
  initialLineId: string | undefined;
  onSuccess: () => Promise<void>;
  onView: (paymentId: string) => void;
  period: PeriodDetail;
  reportLanguage: string;
}) {
  const { t } = useTranslation();
  const idempotency = useIdempotencyKey();
  const pdf = useReconciliationPdfActions(api);
  const [lines, setLines] = useState<readonly PayrollLine[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    acknowledgementType: "checkbox",
    acknowledgementValue: "",
    accountId: "",
    cashVoucherReference: "",
    externalReference: "",
    notes: "",
    paymentDate: new Date().toISOString().slice(0, 10),
  });
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<PaymentResult>();
  // Active Company Cash accounts, from the existing Cash/Bank endpoint. Reusing
  // it keeps one account master; the inactive filter here is convenience only,
  // since the backend rejects an inactive account regardless.
  const [cashAccounts, setCashAccounts] = useState<
    readonly { readonly id: string; readonly name: string }[]
  >([]);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<readonly { id: string; name: string }[]>(
        // activeOnly is the endpoint's own filter, so an inactive account never
        // reaches the browser. Filtering here as well would only duplicate a
        // decision the server already makes -- and the backend rejects an
        // inactive account at confirmation regardless.
        "operations/accounting/cash-bank/cash-accounts?activeOnly=true",
        controller.signal,
      )
      .then((accounts) => setCashAccounts(accounts))
      .catch(() => {
        // A failed load must not block the dialog: the field stays empty, the
        // required check fails with a clear message, and the backend refuses
        // the payment anyway.
        if (!controller.signal.aborted) setCashAccounts([]);
      });
    return () => controller.abort();
  }, [api]);
  const runReport = async (action: PdfAction) => {
    if (result === undefined) return;
    const issue = await pdf.run(
      `operations/payroll/payments/${result.paymentId}/pdf?language=${reportLanguage}`,
      `Payroll-Payment-${result.paymentNumber}.pdf`,
      action,
    );
    if (issue !== undefined) setError(errorMessage(issue, t("payroll.errors.pdfFailed")));
  };
  useEffect(() => {
    void api
      .get<Page<PayrollLine>>(
        `operations/payroll/periods/${period.id}/lines?page=1&pageSize=500&outstandingOnly=true`,
      )
      .then((page) => {
        const payable = page.items.filter((line) =>
          ["approved", "partially_paid"].includes(line.status),
        );
        setLines(payable);
        const initial = payable.find((line) => line.id === initialLineId);
        if (initial !== undefined) setSelected({ [initial.id]: initial.outstanding });
      })
      .catch((issue) => setError(errorMessage(issue, t("payroll.errors.payableLoadFailed"))));
  }, [api, initialLineId, period.id, t]);
  const allocations = Object.entries(selected).flatMap(([lineId, amount]) => {
    const parsed = parseMoneyInput(amount, { allowZero: false });
    const line = lines.find((item) => item.id === lineId);
    return parsed.ok && line !== undefined
      ? [{ amount: parsed.value, employeeId: line.employeeId, lineId }]
      : [];
  });
  const total = allocations.reduce((sum, item) => sum + item.amount, 0);
  const submit = async () => {
    const hasInvalidAmount = Object.values(selected).some(
      (amount) => !parseMoneyInput(amount, { allowZero: false }).ok,
    );
    if (hasInvalidAmount) return setError(t("payroll.validation.amountPositive"));
    if (allocations.length === 0) return setError(t("payroll.validation.selectEmployees"));
    // The backend rejects a missing account with payment_funding_account_required.
    // Checking here too is only for a faster message; the server decides.
    if (form.accountId === "") return setError(t("payroll.validation.cashAccountRequired"));
    if (form.cashVoucherReference.trim() === "")
      return setError(t("payroll.validation.voucherRequired"));
    if (form.acknowledgementType === "typed_name" && form.acknowledgementValue.trim() === "")
      return setError(t("payroll.validation.acknowledgementRequired"));
    const invalid = allocations.some(
      (a) => a.amount > safeMoneyValue(lines.find((line) => line.id === a.lineId)?.outstanding),
    );
    if (invalid) return setError(t("payroll.validation.exceedsOutstanding"));
    setSaving(true);
    setError(undefined);
    try {
      const proposal = await api.post<PaymentProposal>("operations/payroll/payments/proposal", {
        allocations,
        lineIds: allocations.map((allocation) => allocation.lineId),
        periodId: period.id,
      });
      const body = {
        acknowledgementType: form.acknowledgementType,
        allocations: proposal.allocations.map((allocation) => ({
          amount: safeMoneyValue(allocation.amount),
          employeeId: allocation.employeeId,
          lineId: allocation.lineId,
        })),
        accountId: form.accountId,
        cashVoucherReference: form.cashVoucherReference.trim(),
        paymentDate: form.paymentDate,
        periodId: period.id,
        ...(form.acknowledgementValue.trim() === ""
          ? {}
          : { acknowledgementValue: form.acknowledgementValue.trim() }),
        ...(form.externalReference.trim() === ""
          ? {}
          : { externalReference: form.externalReference.trim() }),
        ...(form.notes.trim() === "" ? {} : { notes: form.notes.trim() }),
      };
      const confirmed = await api.post<PaymentResult>("operations/payroll/payments", body, {
        "x-idempotency-key": idempotency.keyFor(JSON.stringify(body)),
      });
      setResult(confirmed);
      idempotency.reset();
      await onSuccess();
    } catch (issue) {
      setError(errorMessage(issue, t("payroll.errors.paymentFailed")));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      className="modal-wide"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("payroll.payment.title")}
      titleId="payroll-payment-title"
    >
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      {result !== undefined ? (
        <div className="reconciliation-success">
          <h3>{t("payroll.payment.success")}</h3>
          <dl className="reconciliation-summary">
            <Detail label={t("payroll.fields.paymentNumber")} value={result.paymentNumber} />
            <Detail label={t("payroll.fields.periodReference")} value={period.periodReference} />
            <Detail label={t("payroll.columns.employees")} value={String(allocations.length)} />
            <Detail label={t("payroll.columns.totalAmount")} value={money(result.totalAmount)} />
            <Detail label={t("payroll.fields.paymentDate")} value={form.paymentDate} />
            <Detail label={t("payroll.fields.voucher")} value={form.cashVoucherReference} />
          </dl>
          <div className="modal-actions">
            <button onClick={() => onView(result.paymentId)} type="button">
              {t("payroll.actions.viewPayment")}
            </button>
            {canReport ? (
              <>
                <button
                  disabled={pdf.busy !== undefined}
                  onClick={() => void runReport("preview")}
                  type="button"
                >
                  {t("payroll.actions.previewReport")}
                </button>
                <button
                  disabled={pdf.busy !== undefined}
                  onClick={() => void runReport("print")}
                  type="button"
                >
                  {t("common.print")}
                </button>
                <button
                  disabled={pdf.busy !== undefined}
                  onClick={() => void runReport("download")}
                  type="button"
                >
                  {t("payroll.actions.downloadPdf")}
                </button>
              </>
            ) : null}
            <button className="button button-primary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <section className="workspace-step">
            <h3>{t("payroll.payment.selectEmployees")}</h3>
            <div className="table-scroll-x">
              <table>
                <thead>
                  <tr>
                    {[
                      "select",
                      "employee",
                      "employeeNumber",
                      "net",
                      "paid",
                      "outstanding",
                      "status",
                      "amountToPay",
                      "remainingAfter",
                    ].map((key) => (
                      <th key={key}>{t(`payroll.columns.${key}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 ? (
                    <EmptyRow colSpan={9} text={t("payroll.empty.payableEmployees")} />
                  ) : (
                    lines.map((line) => {
                      const amount = selected[line.id] ?? "";
                      const remaining = Number(line.outstanding) - Number(amount || 0);
                      return (
                        <tr key={line.id}>
                          <td>
                            <input
                              checked={selected[line.id] !== undefined}
                              onChange={(e) =>
                                setSelected((current) => {
                                  const next = { ...current };
                                  if (e.target.checked) next[line.id] = line.outstanding;
                                  else delete next[line.id];
                                  return next;
                                })
                              }
                              type="checkbox"
                            />
                          </td>
                          <td>{line.employeeName}</td>
                          <td>{line.employeeNumber}</td>
                          <td>{money(line.netSalary)}</td>
                          <td>{money(line.paid)}</td>
                          <td>{money(line.outstanding)}</td>
                          <td>
                            <StatusBadge status={line.status} />
                          </td>
                          <td>
                            <input
                              disabled={selected[line.id] === undefined}
                              max={line.outstanding}
                              min="0.01"
                              onChange={(e) =>
                                setSelected({ ...selected, [line.id]: e.target.value })
                              }
                              step="0.01"
                              type="number"
                              value={amount}
                            />
                          </td>
                          <td>{money(Math.max(0, remaining))}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <section className="workspace-step">
            <h3>{t("payroll.payment.details")}</h3>
            <div className="form-grid">
              <Field label={t("payroll.fields.paymentDate")} required>
                <input
                  onChange={(e) => setForm({ ...form, paymentDate: e.target.value })}
                  type="date"
                  value={form.paymentDate}
                />
              </Field>
              {/* Cash accounts only. Payroll is cash-only, so this field says
                  WHICH drawer the money leaves, never whether it is cash. */}
              <Field label={t("payroll.fields.cashAccount")} required>
                <select
                  onChange={(e) => setForm({ ...form, accountId: e.target.value })}
                  value={form.accountId}
                >
                  <option value="">{t("payroll.fields.selectCashAccount")}</option>
                  {cashAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("payroll.fields.voucher")} required>
                <input
                  onChange={(e) => setForm({ ...form, cashVoucherReference: e.target.value })}
                  value={form.cashVoucherReference}
                />
              </Field>
              <Field label={t("payroll.fields.externalReference")}>
                <input
                  onChange={(e) => setForm({ ...form, externalReference: e.target.value })}
                  value={form.externalReference}
                />
              </Field>
              <Field label={t("payroll.fields.acknowledgement")} required>
                <select
                  onChange={(e) => setForm({ ...form, acknowledgementType: e.target.value })}
                  value={form.acknowledgementType}
                >
                  {["checkbox", "typed_name", "physical_signature"].map((value) => (
                    <option key={value} value={value}>
                      {t(`payroll.acknowledgement.${value}`)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {form.acknowledgementType === "typed_name" ? (
              <Field label={t("payroll.fields.acknowledgementValue")} required>
                <input
                  onChange={(e) => setForm({ ...form, acknowledgementValue: e.target.value })}
                  value={form.acknowledgementValue}
                />
              </Field>
            ) : form.acknowledgementType === "physical_signature" ? (
              <p className="field-hint">{t("payroll.payment.physicalSignatureHint")}</p>
            ) : null}
            <Field label={t("payroll.fields.notes")}>
              <textarea
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                value={form.notes}
              />
            </Field>
          </section>
          <section className="workspace-step">
            <h3>{t("payroll.payment.review")}</h3>
            <dl className="reconciliation-summary">
              <Detail label={t("payroll.fields.periodReference")} value={period.periodReference} />
              <Detail label={t("payroll.columns.employees")} value={String(allocations.length)} />
              <Detail
                label={t("payroll.payment.totalOutstanding")}
                value={money(
                  allocations.reduce(
                    (sum, allocation) =>
                      sum +
                      Number(lines.find((line) => line.id === allocation.lineId)?.outstanding ?? 0),
                    0,
                  ),
                )}
              />
              <Detail label={t("payroll.payment.totalPayment")} value={money(total)} />
              <Detail
                label={t("payroll.payment.remainingOutstanding")}
                value={money(
                  allocations.reduce(
                    (sum, allocation) =>
                      sum +
                      Number(
                        lines.find((line) => line.id === allocation.lineId)?.outstanding ?? 0,
                      ) -
                      allocation.amount,
                    0,
                  ),
                )}
              />
            </dl>
          </section>
          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button
              className="button button-primary"
              disabled={saving}
              onClick={() => void submit()}
              type="button"
            >
              {saving ? t("common.working") : t("payroll.actions.confirmCashPayment")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function LineDetailDialog({
  api,
  canAdjust,
  canPay,
  canReport,
  canReverse,
  lineId,
  money,
  onAdjust,
  onClose,
  onPay,
  onRefresh,
  reportLanguage,
}: {
  api: ApiClient;
  canAdjust: boolean;
  canPay: boolean;
  canReport: boolean;
  canReverse: boolean;
  lineId: string;
  money: (value: string | number) => string;
  onClose: () => void;
  onAdjust: (line: PayrollLine) => void;
  onPay: () => void;
  onRefresh: () => Promise<void>;
  reportLanguage: string;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<PayrollLineDetail>();
  const [error, setError] = useState<string>();
  const [reverseAdjustment, setReverseAdjustment] =
    useState<PayrollLineDetail["adjustments"][number]>();
  const pdf = useReconciliationPdfActions(api);
  const load = useCallback(
    () =>
      api
        .get<PayrollLineDetail>(`operations/payroll/lines/${lineId}`)
        .then(setDetail)
        .catch((issue) => setError(errorMessage(issue, t("payroll.errors.lineNotFound")))),
    [api, lineId, t],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const runPdf = async (action: PdfAction) => {
    const issue = await pdf.run(
      `operations/payroll/lines/${lineId}/payslip/pdf?language=${reportLanguage}`,
      `Payslip-${detail?.payrollLineReference ?? "Payroll"}.pdf`,
      action,
    );
    if (issue !== undefined) setError(errorMessage(issue, t("payroll.errors.pdfFailed")));
  };
  return (
    <Modal
      className="modal-wide"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("payroll.lineDetail.title")}
      titleId="payroll-line-detail-title"
    >
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      {detail === undefined ? (
        <div className="loading-row">{t("common.loading")}</div>
      ) : (
        <>
          <dl className="reconciliation-summary">
            {[
              [t("payroll.fields.employee"), `${detail.employeeNumber} - ${detail.employeeName}`],
              [t("payroll.fields.employeeNameAr"), detail.employeeNameAr ?? "-"],
              [t("payroll.fields.employmentType"), detail.employmentType ?? "-"],
              [t("payroll.fields.department"), detail.department ?? "-"],
              [t("payroll.fields.periodReference"), detail.periodReference],
              [t("payroll.fields.periodDates"), `${detail.periodStart} - ${detail.periodEnd}`],
              [t("payroll.fields.salaryVersion"), detail.salaryVersionId ?? "-"],
              [
                t("payroll.fields.monthlyBasicSalary"),
                detail.monthlyBasicSalary === null ? "-" : money(detail.monthlyBasicSalary),
              ],
              [t("payroll.fields.payableDates"), `${detail.payableFrom} - ${detail.payableTo}`],
              [
                t("payroll.fields.payableDays"),
                t("payroll.lineDetail.payableDaysValue", {
                  payable: detail.payableDays,
                  period: detail.periodDays,
                }),
              ],
              [t("payroll.columns.basic"), money(detail.basicSalary)],
              [t("payroll.columns.commission"), money(detail.driverCommission)],
              [t("payroll.columns.deliveredOrderEarnings"), money(detail.deliveredOrderEarnings)],
              [
                t("payroll.fields.deliveredOrderCount"),
                // The count of qualifying Orders is the number of allocated
                // snapshots -- read, not recomputed.
                String(detail.deliveredOrderEarningSources.length),
              ],
              [
                t("payroll.fields.deliveredOrderAllocation"),
                detail.deliveredOrderEarningSources.length === 0
                  ? t("payroll.deliveredOrderEarnings.notAllocated")
                  : t("payroll.deliveredOrderEarnings.allocated", {
                      period: detail.periodReference,
                    }),
              ],
              [t("payroll.columns.net"), money(detail.netSalary)],
              [t("payroll.columns.paid"), money(detail.paid)],
              [t("payroll.columns.outstanding"), money(detail.outstanding)],
              [t("common.status"), t(`payroll.status.${detail.status}`)],
              [t("payroll.fields.calculatedBy"), detail.calculatedBy ?? "-"],
              [t("payroll.fields.calculatedAt"), dateTime(detail.calculatedAt)],
              [t("payroll.fields.approvedBy"), detail.approvedBy ?? "-"],
              [t("payroll.fields.approvedAt"), dateTime(detail.approvedAt)],
            ].map(([label, value]) => (
              <Detail key={String(label)} label={String(label)} value={String(value)} />
            ))}
          </dl>
          {detail.monthlyBasicSalary === null ? null : (
            <div className="alert alert-info">
              {t("payroll.lineDetail.prorationFormula", {
                monthly: money(detail.monthlyBasicSalary),
                payable: detail.payableDays,
                period: detail.periodDays,
                result: money(detail.basicSalary),
              })}
            </div>
          )}
          {detail.salaryHold ? (
            <div className="alert alert-warning">
              {t("payroll.lineDetail.salaryHold", {
                from: detail.salaryHoldFrom,
                reason: detail.salaryHoldReason,
                to: detail.salaryHoldTo ?? t("payroll.lineDetail.openEnded"),
              })}
            </div>
          ) : null}
          {/*
            Collapsed by default: a busy Employee can have hundreds of
            deliveries in a month, and the total plus the count above already
            answer the usual question. Native details/summary so it stays
            keyboard accessible and printable without extra state.
          */}
          <details className="payroll-earning-sources">
            <summary>
              {t("payroll.lineDetail.deliveredOrderEarningSources", {
                count: detail.deliveredOrderEarningSources.length,
                total: money(detail.deliveredOrderEarnings),
              })}
            </summary>
            {detail.deliveredOrderEarningSources.length === 0 ? (
              <p className="empty-state">{t("payroll.empty.deliveredOrderEarnings")}</p>
            ) : (
              <div className="table-scroll-x">
                <table>
                  <thead>
                    <tr>
                      <th>{t("payroll.fields.orderNumber")}</th>
                      <th>{t("payroll.fields.deliveredAt")}</th>
                      <th>{t("payroll.fields.amount")}</th>
                      <th>{t("payroll.fields.earningRule")}</th>
                      <th>{t("payroll.fields.earningReference")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.deliveredOrderEarningSources.map((source) => (
                      <tr key={source.earningId}>
                        <td>{source.orderNumber}</td>
                        <td>{dateTime(source.deliveredAt)}</td>
                        <td>{money(source.appliedAmount)}</td>
                        <td>{source.ruleId}</td>
                        <td>{source.earningId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
          <h3>{t("payroll.lineDetail.driverCommissionSources")}</h3>
          <div className="table-scroll-x">
            <table>
              <thead>
                <tr>
                  <th>{t("payroll.fields.sourceReference")}</th>
                  <th>{t("payroll.fields.sourceMarker")}</th>
                  <th>{t("payroll.fields.amount")}</th>
                </tr>
              </thead>
              <tbody>
                {detail.driverCommissionSources.length === 0 ? (
                  <EmptyRow colSpan={3} text={t("payroll.empty.driverCommissionSources")} />
                ) : (
                  detail.driverCommissionSources.map((source) => (
                    <tr key={source.calculationId}>
                      <td>{source.calculationId}</td>
                      <td>{source.sourceMarker}</td>
                      <td>{money(source.amount)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <h3>{t("payroll.lineDetail.allowanceSnapshots")}</h3>
          <div className="table-scroll-x">
            <table>
              <thead>
                <tr>
                  <th>{t("payroll.fields.code")}</th>
                  <th>{t("common.name")}</th>
                  <th>{t("payroll.fields.amount")}</th>
                </tr>
              </thead>
              <tbody>
                {detail.allowances.length === 0 ? (
                  <EmptyRow colSpan={3} text={t("payroll.empty.allowances")} />
                ) : (
                  detail.allowances.map((a) => (
                    <tr key={`${a.code}:${a.amount}`}>
                      <td>{a.code}</td>
                      <td>{a.name}</td>
                      <td>{money(a.amount)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <h3>{t("payroll.lineDetail.adjustments")}</h3>
          <div className="table-scroll-x">
            <table>
              <thead>
                <tr>
                  <th>{t("payroll.fields.adjustmentType")}</th>
                  <th>{t("payroll.fields.direction")}</th>
                  <th>{t("payroll.fields.amount")}</th>
                  <th>{t("common.reason")}</th>
                  <th>{t("common.status")}</th>
                  <th>{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {detail.adjustments.length === 0 ? (
                  <EmptyRow colSpan={6} text={t("payroll.empty.adjustments")} />
                ) : (
                  detail.adjustments.map((a) => (
                    <tr key={a.id}>
                      <td>{t(`payroll.adjustment.types.${a.adjustment_type}`)}</td>
                      <td>{t(`payroll.adjustment.directions.${a.direction}`)}</td>
                      <td>{money(a.amount)}</td>
                      <td>{a.reason}</td>
                      <td>{t(`payroll.status.${a.status}`)}</td>
                      <td>
                        {canReverse &&
                        a.status === "active" &&
                        ["draft", "calculated"].includes(detail.status) ? (
                          <button onClick={() => setReverseAdjustment(a)} type="button">
                            {t("payroll.actions.reverse")}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <h3>{t("payroll.lineDetail.paymentHistory")}</h3>
          <div className="table-scroll-x">
            <table>
              <thead>
                <tr>
                  <th>{t("payroll.fields.paymentNumber")}</th>
                  <th>{t("payroll.fields.paymentDate")}</th>
                  <th>{t("payroll.fields.amount")}</th>
                  <th>{t("common.status")}</th>
                </tr>
              </thead>
              <tbody>
                {detail.paymentHistory.length === 0 ? (
                  <EmptyRow colSpan={4} text={t("payroll.empty.paymentHistory")} />
                ) : (
                  detail.paymentHistory.map((p) => (
                    <tr key={p.paymentId}>
                      <td>{p.paymentNumber}</td>
                      <td>{p.paymentDate}</td>
                      <td>{money(p.amount)}</td>
                      <td>{t(`payroll.status.${p.status}`)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {detail.reversalReason === null ? null : (
            <div className="alert alert-warning">
              {t("payroll.lineDetail.reversal", {
                date: dateTime(detail.reversedAt),
                reason: detail.reversalReason,
              })}
            </div>
          )}
          <div className="modal-actions">
            {canAdjust && ["draft", "calculated"].includes(detail.status) ? (
              <button
                onClick={() =>
                  onAdjust({
                    allowances: detail.allowanceTotal,
                    basicSalary: detail.basicSalary,
                    deductions: detail.deductions,
                    department: detail.department,
                    driverCommission: detail.driverCommission,
                    earningAdjustments: detail.earningAdjustments,
                    employeeId: detail.employeeId,
                    employeeName: detail.employeeName,
                    employeeNumber: detail.employeeNumber,
                    employmentType: detail.employmentType,
                    grossEarnings: detail.grossEarnings,
                    id: detail.id,
                    driverCommissionSources: detail.driverCommissionSources,
                    monthlyBasicSalary: detail.monthlyBasicSalary,
                    netSalary: detail.netSalary,
                    outstanding: detail.outstanding,
                    paid: detail.paid,
                    payrollLineReference: detail.payrollLineReference,
                    status: detail.status,
                  })
                }
                type="button"
              >
                {t("payroll.actions.addAdjustment")}
              </button>
            ) : null}
            {canPay && ["approved", "partially_paid"].includes(detail.status) ? (
              <button onClick={onPay} type="button">
                {t("payroll.actions.pay")}
              </button>
            ) : null}
            {canReport && !["draft", "calculated"].includes(detail.status) ? (
              <>
                <button
                  disabled={pdf.busy !== undefined}
                  onClick={() => void runPdf("preview")}
                  type="button"
                >
                  {t("payroll.actions.previewPayslip")}
                </button>
                <button
                  disabled={pdf.busy !== undefined}
                  onClick={() => void runPdf("print")}
                  type="button"
                >
                  {t("common.print")}
                </button>
                <button
                  disabled={pdf.busy !== undefined}
                  onClick={() => void runPdf("download")}
                  type="button"
                >
                  {t("payroll.actions.downloadPdf")}
                </button>
              </>
            ) : null}
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </>
      )}
      {reverseAdjustment === undefined ? null : (
        <ReasonDialog
          title={t("payroll.adjustment.reverseTitle")}
          warning={t("payroll.adjustment.reverseWarning")}
          onClose={() => setReverseAdjustment(undefined)}
          onSubmit={async (reason, key) => {
            await api.post(
              `operations/payroll/adjustments/${reverseAdjustment.id}/reverse`,
              { reason },
              { "x-idempotency-key": key },
            );
            setReverseAdjustment(undefined);
            load();
            await onRefresh();
          }}
        />
      )}
    </Modal>
  );
}

function PaymentDetailDialog({
  api,
  canReport,
  canReverse,
  money,
  onClose,
  onRefresh,
  paymentId,
  reportLanguage,
}: {
  api: ApiClient;
  canReport: boolean;
  canReverse: boolean;
  money: (value: string | number) => string;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  paymentId: string;
  reportLanguage: string;
}) {
  const { i18n, t } = useTranslation();
  const language = i18n.resolvedLanguage ?? "en";
  const [detail, setDetail] = useState<PaymentDetail>();
  const [error, setError] = useState<string>();
  const [reverse, setReverse] = useState(false);
  const pdf = useReconciliationPdfActions(api);
  const load = useCallback(
    () =>
      api
        .get<PaymentDetail>(`operations/payroll/payments/${paymentId}`)
        .then(setDetail)
        .catch((issue) => setError(errorMessage(issue, t("payroll.errors.paymentNotFound")))),
    [api, paymentId, t],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (action: PdfAction) => {
    const issue = await pdf.run(
      `operations/payroll/payments/${paymentId}/pdf?language=${reportLanguage}`,
      `Payroll-Payment-${detail?.paymentNumber ?? "Payroll"}.pdf`,
      action,
    );
    if (issue !== undefined) setError(errorMessage(issue, t("payroll.errors.pdfFailed")));
  };
  return (
    <Modal
      className="modal-wide"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("payroll.paymentDetail.title")}
      titleId="payroll-payment-detail-title"
    >
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      {detail === undefined ? (
        <div className="loading-row">{t("common.loading")}</div>
      ) : (
        <>
          <dl className="reconciliation-summary">
            {[
              [t("payroll.fields.paymentNumber"), detail.paymentNumber],
              [t("payroll.fields.paymentDate"), detail.paymentDate],
              [t("payroll.columns.totalAmount"), money(detail.totalAmount)],
              [t("payroll.fields.voucher"), detail.cashVoucherReference],
              [t("payroll.fields.externalReference"), detail.externalReference ?? "-"],
              [
                t("payroll.fields.acknowledgement"),
                t(`payroll.acknowledgement.${detail.acknowledgementType}`),
              ],
              [t("payroll.fields.notes"), detail.notes ?? "-"],
              [t("common.status"), t(`payroll.status.${detail.status}`)],
              [t("payroll.columns.paidBy"), detail.paidBy],
              [t("payroll.fields.createdAt"), dateTime(detail.createdAt)],
              // Backend aggregates. Total Applied is what this Payment
              // allocated; Unapplied is the remainder, clamped at zero
              // server-side. Nothing here is summed in the browser.
              ...(detail.totalApplied === undefined
                ? []
                : [[t("payroll.summary.totalApplied"), money(detail.totalApplied)]]),
              ...(detail.unappliedAmount === undefined
                ? []
                : [[t("payroll.summary.unappliedAmount"), money(detail.unappliedAmount)]]),
              ...(detail.employeeCount === undefined
                ? []
                : [[t("payroll.summary.employeesPaid"), String(detail.employeeCount)]]),
              ...(detail.remainingPayrollOutstanding === undefined
                ? []
                : [
                    [
                      t("payroll.summary.remainingPayrollOutstanding"),
                      money(detail.remainingPayrollOutstanding),
                    ],
                  ]),
            ].map(([label, value]) => (
              <Detail key={String(label)} label={String(label)} value={String(value)} />
            ))}
            {/* Business references that navigate. These sit outside the map
                above because Detail renders a string and a link is a node.
                Journal and Accounting Event links are deliberately NOT
                repeated here - the Related Records panel below owns them. */}
            <div className="detail-line">
              <dt>{t("payroll.fields.periodReference")}</dt>
              <dd>
                <OperationalReference
                  identifier={detail.periodId}
                  reference={detail.payrollPeriod}
                  type="payroll_period"
                />
              </dd>
            </div>
            {/* Payroll DOES store a separate reversal Payment record
                (reversal_of_payment_id), so this relationship is real. Each
                row renders only when its reference exists, so no empty card
                is ever shown. */}
            {detail.reversalOfPaymentNumber == null ? null : (
              <div className="detail-line">
                <dt>{t("payroll.fields.originalPayment")}</dt>
                <dd>
                  <OperationalReference
                    identifier={detail.reversalOfPaymentId}
                    reference={detail.reversalOfPaymentNumber}
                    type="payroll_payment"
                  />
                </dd>
              </div>
            )}
            {detail.reversedByPaymentNumber == null ? null : (
              <div className="detail-line">
                <dt>{t("payroll.fields.reversalPayment")}</dt>
                <dd>
                  <OperationalReference
                    identifier={detail.reversedByPaymentId}
                    reference={detail.reversedByPaymentNumber}
                    type="payroll_payment"
                  />
                </dd>
              </div>
            )}
          </dl>
          {detail.reversedAt === null ? null : (
            <div className="alert alert-warning">
              {t("payroll.paymentDetail.reversal", {
                date: dateTime(detail.reversedAt),
                reason: detail.reversalReason,
                user: detail.reversedBy,
              })}
            </div>
          )}
          <div className="table-scroll-x">
            <table>
              <thead>
                <tr>
                  {[
                    "employee",
                    "employeeNumber",
                    "payrollLine",
                    "net",
                    "previouslyPaid",
                    "paidNow",
                    "remainingAfter",
                    "status",
                  ].map((key) => (
                    <th key={key}>{t(`payroll.columns.${key}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.allocations.map((line) => (
                  <tr key={line.allocationId}>
                    <td>
                      {/* Number — Name in one cell, opening the Employee
                          record through the verified /configuration route. */}
                      <OperationalReference
                        identifier={line.employeeNumber}
                        reference={partyDisplayLabel(
                          line.employeeNumber,
                          line.employee,
                          line.employeeNameAr ?? null,
                          language,
                        )}
                        type="employee"
                      />
                    </td>
                    <td>{line.payrollLineReference}</td>
                    <td>{money(line.netSalary)}</td>
                    <td>{money(line.previouslyPaid)}</td>
                    <td>{money(line.amountPaidNow)}</td>
                    <td>{money(line.remainingOutstanding)}</td>
                    <td>
                      <StatusBadge status={line.lineStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Additive Accounting link-through; renders nothing for a User
              without Accounting access. */}
          <AccountingRelatedPanel api={api} sourceId={paymentId} sourceType="payroll_payment" />
          <div className="modal-actions">
            {canReverse && detail.status !== "reversed" ? (
              <button onClick={() => setReverse(true)} type="button">
                {t("payroll.actions.reverse")}
              </button>
            ) : null}
            {canReport ? (
              <>
                <button
                  disabled={pdf.busy !== undefined}
                  onClick={() => void run("preview")}
                  type="button"
                >
                  {t("payroll.actions.previewReport")}
                </button>
                <button
                  disabled={pdf.busy !== undefined}
                  onClick={() => void run("print")}
                  type="button"
                >
                  {t("common.print")}
                </button>
                <button
                  disabled={pdf.busy !== undefined}
                  onClick={() => void run("download")}
                  type="button"
                >
                  {t("payroll.actions.downloadPdf")}
                </button>
              </>
            ) : null}
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </>
      )}
      {!reverse || detail === undefined ? null : (
        <ReasonDialog
          title={t("payroll.payment.reverseTitle")}
          warning={t("payroll.payment.reverseWarning")}
          onClose={() => setReverse(false)}
          onSubmit={async (reason, key) => {
            await api.post(
              `operations/payroll/payments/${paymentId}/reverse`,
              { reason },
              { "x-idempotency-key": key },
            );
            setReverse(false);
            load();
            await onRefresh();
          }}
        />
      )}
    </Modal>
  );
}

function ReversePaymentDialog({
  api,
  money,
  onClose,
  onSuccess,
  payment,
}: {
  api: ApiClient;
  money: (value: string | number) => string;
  onClose: () => void;
  onSuccess: () => Promise<void>;
  payment: PaymentRow;
}) {
  const { t } = useTranslation();
  return (
    <ReasonDialog
      details={
        <dl className="reconciliation-summary">
          <Detail label={t("payroll.fields.paymentNumber")} value={payment.paymentNumber} />
          <Detail label={t("payroll.fields.periodReference")} value={payment.payrollPeriod} />
          <Detail label={t("payroll.columns.totalAmount")} value={money(payment.totalAmount)} />
          <Detail label={t("payroll.columns.employees")} value={String(payment.employeeCount)} />
          <Detail label={t("common.status")} value={t(`payroll.status.${payment.status}`)} />
        </dl>
      }
      title={t("payroll.payment.reverseTitle")}
      warning={t("payroll.payment.reverseWarning")}
      onClose={onClose}
      onSubmit={async (reason, key) => {
        await api.post(
          `operations/payroll/payments/${payment.id}/reverse`,
          { reason },
          { "x-idempotency-key": key },
        );
        await onSuccess();
        onClose();
      }}
    />
  );
}

function ReasonDialog({
  details,
  onClose,
  onSubmit,
  title,
  warning,
}: {
  details?: ReactNode;
  onClose: () => void;
  onSubmit: (reason: string, key: string) => Promise<void>;
  title: string;
  warning: string;
}) {
  const { t } = useTranslation();
  const idempotency = useIdempotencyKey();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (reason.trim() === "") return setError(t("payroll.validation.reasonRequired"));
    setSaving(true);
    setError(undefined);
    try {
      await onSubmit(reason.trim(), idempotency.keyFor(`${title}:${reason.trim()}`));
      idempotency.reset();
    } catch (issue) {
      setError(errorMessage(issue, t("payroll.errors.reverseFailed")));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={title}
      titleId="payroll-reason-dialog-title"
    >
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      {details}
      <div className="alert alert-warning">{warning}</div>
      <Field label={t("common.reason")} required>
        <textarea onChange={(e) => setReason(e.target.value)} value={reason} />
      </Field>
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={saving}
          onClick={() => void submit()}
          type="button"
        >
          {saving ? t("common.working") : t("payroll.actions.reverse")}
        </button>
      </div>
    </Modal>
  );
}

function Field({
  children,
  label,
  required = false,
}: {
  children: ReactNode;
  label: string;
  required?: boolean;
}) {
  return (
    <label className={`field${required ? " required-field" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-line">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  return (
    <span className={`status-badge status-${status}`}>
      {t(`payroll.status.${status}`, { defaultValue: status.replaceAll("_", " ") })}
    </span>
  );
}

function StatusSelect({
  kind,
  onChange,
  value,
}: {
  kind: "line" | "payment" | "period";
  onChange: (value: string) => void;
  value: string;
}) {
  const { t } = useTranslation();
  const options =
    kind === "payment"
      ? ["confirmed", "reversed"]
      : kind === "line"
        ? ["draft", "calculated", "approved", "partially_paid", "paid", "held", "reversed"]
        : ["draft", "calculated", "approved", "partially_paid", "paid", "closed", "reversed"];
  return (
    <select onChange={(e) => onChange(e.target.value)} value={value}>
      <option value="">{t("common.all")}</option>
      {options.map((status) => (
        <option key={status} value={status}>
          {t(`payroll.status.${status}`)}
        </option>
      ))}
    </select>
  );
}

function Pagination<T>({
  onPage,
  page,
}: {
  onPage: (page: number) => void;
  page: Page<T> | undefined;
}) {
  const { t } = useTranslation();
  if (page === undefined) return null;
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  return (
    <div className="pagination">
      <button disabled={page.page <= 1} onClick={() => onPage(page.page - 1)} type="button">
        {t("common.previous")}
      </button>
      <span>{t("common.pageOf", { page: page.page, pageCount: pages })}</span>
      <button disabled={page.page >= pages} onClick={() => onPage(page.page + 1)} type="button">
        {t("common.next")}
      </button>
    </div>
  );
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <tr>
      <td className="empty-state" colSpan={colSpan}>
        {text}
      </td>
    </tr>
  );
}

function queryString(values: Record<string, boolean | number | string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) params.set(key, String(value));
  return params.toString();
}

function dateTime(value: string | null): string {
  return value === null ? "-" : value.slice(0, 16).replace("T", " ");
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message || fallback;
  return fallback;
}
