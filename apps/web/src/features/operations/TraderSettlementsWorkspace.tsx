import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useSessionAccess } from "../../app/SessionAccessContext.js";
import { useListState } from "../accounting/use-list-state.js";
import { formatDate } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";

import {
  businessDateFilterDefaults,
  BusinessDateFilterControls,
} from "./BusinessDateFilterControls.js";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import type { CompanyBankAccount, OperationsTrader, PagedResponse } from "../../api/contracts.js";
import { useRouteDetail } from "../../app/use-route-detail.js";
import { OperationalReference } from "./OperationalReference.js";
import { AccountingRelatedPanel } from "../accounting/AccountingRelatedPanel.js";
import { Modal } from "../../components/Modal.js";
import { PageHeader } from "../../components/PageHeader.js";
import { formatMoneyValue, parseMoneyInput, safeMoneyValue } from "../../utils/numeric-input.js";
import { AreaSelector } from "../configuration/AreaSelector.js";

import { type PdfAction, useReconciliationPdfActions } from "./reconciliation-pdf.js";
import { useWorkflowDeepLink, type WorkflowDialog } from "./use-workflow-deep-link.js";
import { useIdempotencyKey } from "./useIdempotencyKey.js";

// ---- Server response shapes (mirror trader-settlement.service.ts). ----

interface TraderSettlementSummary {
  readonly eligibleOrders: number;
  readonly eligibleTraderPayable: string;
  readonly moneyReceivedAmount: string;
  readonly moneySentAmount: string;
  readonly partiallySettledAmount: string;
  readonly remainingOutstanding: string;
  readonly reversedPayments: number;
  readonly tradersWithOutstandingBalance: number;
  readonly unsettledAmount: string;
}

interface TraderSettlementListRow {
  /** Company Business Date from the backend, derived from the confirmation instant. */
  readonly confirmationBusinessDate?: string | null;
  readonly confirmedBy: string;
  readonly createdBy: string;
  readonly isReversed: boolean;
  readonly moneyReceivedAt: string | null;
  readonly moneyReceivedConfirmed: boolean;
  readonly moneySentAt: string | null;
  readonly orderCount: number;
  readonly paymentAmount: string;
  readonly paymentDate: string;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly paymentReference: string | null;
  readonly previouslyPaid: string;
  readonly remainingOutstanding: string;
  readonly settlementId: string;
  readonly settlementNumber: string;
  readonly status: "confirmed" | "reversed";
  readonly traderName: string;
}

interface TraderEligibleOrderRow {
  readonly additionalFees: string;
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerName: string;
  readonly deliveryDate: string | null;
  readonly orderNumber: string;
  readonly emirateName: string | null;
  readonly id: string;
  readonly originalAmountDueToTrader: string;
  readonly outstandingBalance: string;
  readonly previouslyPaid: string;
  readonly referenceNumber: string | null;
  readonly serialNumber: string;
  readonly settlementStatus: string;
  readonly totalDeductions: string;
  readonly vatAmount: string;
}

interface TraderAllocationProposalLine {
  readonly allocatedAmount: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly outstandingAfter: string;
  readonly outstandingBefore: string;
  readonly serialNumber: string;
}

interface TraderAllocationProposal {
  readonly allocations: readonly TraderAllocationProposalLine[];
  readonly requestedAmount: string;
  readonly totalAllocated: string;
  readonly traderId: string;
  readonly unallocatedAmount: string;
}

interface CreateTraderSettlementResult {
  readonly amount: string;
  readonly orderCount: number;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly settlementId: string;
  readonly settlementNumber: string;
  readonly traderId: string;
  readonly traderName: string;
}

interface MaskedBankSnapshot {
  readonly accountName: string;
  readonly accountNumberMasked: string;
  readonly bankName: string;
  readonly ibanMasked: string;
  readonly swiftCode: string | null;
}

interface TraderSettlementDetailOrder {
  readonly additionalFees: string;
  readonly amountPaidNow: string;
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerName: string;
  readonly deliveryDate: string | null;
  readonly emirateName: string | null;
  /** System Order Number. Required on the backend contract (line 177). */
  readonly orderNumber: string;
  readonly orderSettlementStatus: string;
  readonly originalTraderPayable: string;
  readonly previouslyPaid: string;
  readonly referenceNumber: string | null;
  readonly remainingOutstanding: string;
  readonly serialNumber: string;
  readonly serviceFee: string;
  readonly totalDeductions: string;
  readonly vatAmount: string;
}

interface TraderSettlementSummaryTotals {
  readonly amountPaidNow: string;
  readonly orderCount: number;
  readonly previouslyPaid: string;
  readonly remainingOutstanding: string;
  readonly totalAdditionalFees: string;
  readonly totalCod: string;
  readonly totalDeductions: string;
  readonly totalOriginalTraderPayable: string;
  readonly totalServiceFees: string;
  readonly totalVat: string;
}

interface TraderSettlementDetail {
  readonly beneficiaryBank: MaskedBankSnapshot | null;
  readonly confirmedBy: string;
  readonly createdBy: string;
  readonly moneyReceivedBy: string | null;
  readonly moneyReceivedDate: string | null;
  readonly moneyReceivedNotes: string | null;
  readonly moneyReceivedReference: string | null;
  readonly moneySentAt: string | null;
  readonly notes: string | null;
  readonly orders: readonly TraderSettlementDetailOrder[];
  readonly paymentDate: string;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly paymentReference: string | null;
  readonly reversalDate: string | null;
  readonly reversalOfSettlementNumber: string | null;
  readonly reversalReason: string | null;
  readonly reversedBy: string | null;
  readonly reversedBySettlementNumber: string | null;
  readonly settlementId: string;
  readonly settlementNumber: string;
  readonly sourceBank: { readonly accountName: string; readonly bankName: string } | null;
  readonly status: "confirmed" | "reversed";
  readonly summary: TraderSettlementSummaryTotals;
  readonly traderName: string;
  readonly traderId: string;
}

interface TraderBankAccountOption {
  readonly accountName: string;
  readonly accountNumber?: string;
  readonly bankName: string;
  readonly iban?: string | null;
  readonly id: string;
  readonly isActive: boolean;
  readonly isDefault: boolean;
}

interface TraderAccountStatement {
  readonly generatedAt: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly summary: {
    readonly codCollected: string;
    readonly serviceFeesDeducted: string;
    readonly outstandingAmount: string;
    readonly deliveredOrderCount: number;
    readonly settledOrderCount: number;
    readonly partiallySettledOrderCount: number;
    readonly outstandingOrderCount: number;
    readonly closingBalance: string;
    readonly netPayments: string;
    readonly openingBalance: string;
    readonly totalPayments: string;
    readonly totalPayable: string;
    readonly totalReversals: string;
  };
  readonly trader: { readonly id: string; readonly nameEn: string; readonly number: string };
  readonly transactions: readonly {
    readonly credit: string;
    readonly date: string;
    readonly debit: string;
    readonly description: string;
    readonly id: string;
    readonly lineNumber: number;
    readonly reference: string;
    readonly runningBalance: string;
    readonly type: "order" | "payment" | "reversal";
  }[];
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------

/** Stable module-level identity: an inline array would re-run the effect. */
const settlementDialogs: readonly WorkflowDialog[] = ["new_settlement", "confirm_receipt"];

const emptyFilters = {
  ...businessDateFilterDefaults,
  deliveredFrom: "",
  deliveredTo: "",
  moneyReceivedStatus: "",
  orderSerialNumber: "",
  outstandingOnly: false,
  paymentDateFrom: "",
  paymentDateTo: "",
  paymentMethod: "",
  paymentReference: "",
  referenceNumber: "",
  settlementNumber: "",
  settlementStatus: "",
  traderId: "",
};

type Filters = typeof emptyFilters;

/**
 * Filter names this screen puts in the URL. Module-level and built once:
 * `useListState` memoizes on this array, so a literal created during render
 * would produce new state every render and re-fire the request effect forever.
 */
const filterKeys = Object.keys(emptyFilters);

/** Sort keys the Trader Settlements endpoint accepts. */
const sortKeys = new Set(["businessDate", "settlementNumber"]);

function money(value: string | number | undefined): string {
  return formatMoneyValue(value);
}

function message(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.details === undefined || error.details.length === 0
      ? error.message
      : `${error.message}\n${error.details.join("\n")}`;
  }
  return error instanceof Error ? error.message : fallback;
}

function filterQuery(filters: Readonly<Record<string, boolean | string>>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "boolean") {
      if (value) params.set(key, "true");
      continue;
    }
    if (value.trim() !== "") params.set(key, value.trim());
  }
  return params;
}

const emptyEligibleOrderFilters = {
  areaId: "",
  deliveredFrom: "",
  deliveredTo: "",
  emirateId: "",
  outstandingOnly: true,
  referenceNumber: "",
  serialNumber: "",
  settlementStatus: "",
};

type EligibleOrderFilters = typeof emptyEligibleOrderFilters;

// The per-Order settlement-status domain a User can filter Eligible Orders by.
// "not_eligible" is intentionally excluded — the eligible-orders endpoint
// never returns such an Order, so offering it as a filter would only ever
// produce an empty result.
const orderSettlementStatuses = [
  "unsettled",
  "partially_settled",
  "settled",
  "money_sent_to_trader",
  "money_received_by_trader",
  "reversed",
] as const;

function maskAccountNumber(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "";
  const digits = value.trim();
  return digits.length <= 4 ? digits : `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * Trader Settlement operational workspace (Phase 4 Checkpoint 5). The single
 * authoritative screen for money-out payments to Traders: full/partial
 * payment, oldest-first allocation, Money Sent, Money Received, reversal, and
 * the Trader Settlement Statement PDF. Replaces the legacy pending/recent
 * settlement UI previously split across the Orders table's bulk "Settle"
 * dialog and the old OperationsWorkspace settlements view.
 */
export function TraderSettlementsWorkspace({
  api,
  detailId: routeDetailId,
  initialStatementOpen = false,
  permissions,
  presetTraderId,
}: {
  api: ApiClient;
  /** Settlement opened by the canonical route `/trader-settlements/:id`. */
  detailId?: string | undefined;
  initialStatementOpen?: boolean;
  permissions: readonly string[];
  presetTraderId?: string | undefined;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.language);
  const reportLanguage = locale;
  const isAdministrator = permissions.includes("users_roles.manage");
  const canManage = isAdministrator || permissions.includes("settlements.create");
  const canReverse = isAdministrator || permissions.includes("settlements.reverse");
  const canViewReport = canManage || permissions.includes("reports.export");

  const [summary, setSummary] = useState<TraderSettlementSummary>();
  // The URL is the authoritative list state. No parallel local or session copy
  // of these fields remains to drift out of step with it.
  const session = useSessionAccess();
  const list = useListState({
    companyId: session?.companyId,
    defaultSortBy: "businessDate",
    filterKeys,
  });
  const { page } = list;
  const pageSize = list.pageSize;
  const setPage = list.setPage;
  // `useListState` omits empty filters and stores everything as text; the panel
  // and `filterQuery` expect every key present and `outstandingOnly` boolean.
  //
  // `presetTraderId` is applied only as a fallback, never written to the URL:
  // writing it during render would be a normalization effect that fires on every
  // mount, and the User's own choice must still be able to clear it.
  const filters = useMemo<Filters>(
    () => ({
      ...emptyFilters,
      traderId: presetTraderId ?? "",
      ...list.filters,
      outstandingOnly: list.filters.outstandingOnly === "true",
    }),
    [list.filters, presetTraderId],
  );
  const [listPage, setListPage] = useState<PagedResponse<TraderSettlementListRow>>();
  /* Opened only for a request this screen owns, and only when a Trader was
     actually supplied: a New Settlement dialog with no Trader is worse than no
     dialog, because it looks like the context was lost rather than absent. The
     Trader itself is re-validated by the backend on every request the dialog
     makes, so a Trader from another Company simply returns nothing here. */
  const [listError, setListError] = useState<string>();
  const [newSettlementOpen, setNewSettlementOpen] = useState(false);
  /* A smart next action from the Orders list can ask this screen to open New
     Settlement with the Trader and the originating Order already carried in.
     The hook reads that request ONCE and strips it from the URL, so a refresh
     after completing the settlement cannot reopen the dialog. It performs no
     write: everything below is prefill, and the existing dialog still owns
     eligibility, oldest-first allocation and confirmation. */
  const deepLink = useWorkflowDeepLink(settlementDialogs);
  const returnToOrigin = () => {
    if (deepLink.returnTo === null) return false;
    session?.navigate(deepLink.returnTo);
    return session !== undefined;
  };
  const [deepLinkTraderId, setDeepLinkTraderId] = useState<string>();
  const [deepLinkOrderId, setDeepLinkOrderId] = useState<string>();
  /* Shown when a receipt deep link cannot lawfully open the dialog: the target
     is ambiguous, gone, already confirmed, or not visible to this Company. */
  const [receiptNotice, setReceiptNotice] = useState<string>();
  const [statementOpen, setStatementOpen] = useState(initialStatementOpen);
  const [statementTraderId, setStatementTraderId] = useState(presetTraderId);

  useEffect(() => {
    const link = deepLink.link;
    if (link === null || link.dialog !== "confirm_receipt") return;

    /* Ambiguous: the backend found more than one confirmable settlement and
       deliberately emitted no id. Guessing one would confirm receipt of a
       payment the user never chose. */
    if (link.settlementId === null) {
      setReceiptNotice(t("traderSettlements.receiptAmbiguous"));
      return;
    }
    if (!canManage) {
      setReceiptNotice(t("traderSettlements.receiptNoPermission"));
      return;
    }
    // Wait for the page; the row is the resolution, not the URL.
    if (listPage === undefined) return;

    /* Resolved through the Company-scoped list API. A settlement belonging to
       another Company is simply not in these rows, so it can never be opened
       and its existence is never revealed. */
    const target = listPage.items.find((row) => row.settlementId === link.settlementId);
    if (target === undefined) {
      setReceiptNotice(t("traderSettlements.receiptUnavailable"));
      return;
    }
    if (target.moneyReceivedConfirmed) {
      // A stale link for work already done.
      setReceiptNotice(t("traderSettlements.receiptAlreadyConfirmed"));
      return;
    }
    setReceiptNotice(undefined);
    // Opens the EXISTING dialog. Nothing is written by opening it.
    setReceiptTarget(target);
  }, [canManage, deepLink, listPage, t]);

  useEffect(() => {
    const link = deepLink.link;
    if (link === null || link.dialog !== "new_settlement") return;
    if (link.traderId === null) return;
    // Frontend gating only hides a control the backend would refuse anyway.
    if (!canManage) return;
    setDeepLinkTraderId(link.traderId);
    if (link.orderId !== null) setDeepLinkOrderId(link.orderId);
    /* The originating Order is NOT passed on: `NewSettlementDialog` has no
       prop for preselecting one, and inventing a contract for it belongs to
       the dialog, not to this deep link. The Trader is preselected and the
       dialog lists that Trader's eligible Orders under the existing
       oldest-first rules. */
    setNewSettlementOpen(true);
  }, [canManage, deepLink]);
  const {
    close: closeDetail,
    detailId,
    open: openDetail,
  } = useRouteDetail("trader_settlement", routeDetailId);
  const [receiptTarget, setReceiptTarget] = useState<TraderSettlementListRow>();
  const [reverseTarget, setReverseTarget] = useState<TraderSettlementListRow>();
  const pdf = useReconciliationPdfActions(api);
  const [pdfError, setPdfError] = useState<string>();
  const [pdfBusyId, setPdfBusyId] = useState<string>();

  // One write, not one per key: switching Date Mode changes several filters
  // together, and separate writes would each start from stale state. The hook
  // resets the page to 1 itself.
  const applyFilter = (change: Partial<Filters>) => {
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(change)) {
      patch[key] = typeof value === "boolean" ? (value ? "true" : "") : (value ?? "");
    }
    list.setFilters(patch);
  };
  const clearFilters = () => list.clearFilters();

  const refresh = useCallback(() => {
    if (!canManage) return;
    setListError(undefined);
    void api
      .get<TraderSettlementSummary>(
        `operations/settlements/payments/summary?${filterQuery(filters)}`,
      )
      .then(setSummary)
      .catch(() => setListError(t("traderSettlements.detailLoadFailed")));
    const params = filterQuery(filters);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    // Allowlisted before it leaves the browser, so a hand-edited URL cannot
    // send the API a sort key it does not support.
    if (sortKeys.has(list.sortBy) && list.sortBy !== "businessDate") {
      params.set("sortBy", list.sortBy);
      params.set("sortDirection", list.sortDirection);
    }
    void api
      .get<PagedResponse<TraderSettlementListRow>>(
        `operations/settlements/payments/list?${params.toString()}`,
      )
      .then(setListPage)
      .catch(() => setListError(t("traderSettlements.detailLoadFailed")));
  }, [api, canManage, filters, list.sortBy, list.sortDirection, page, pageSize, t]);

  useEffect(() => refresh(), [refresh]);

  const rows = listPage?.items ?? [];
  const total = listPage?.total ?? 0;
  const pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);

  const openRowPdf = async (row: TraderSettlementListRow, mode: PdfAction) => {
    setPdfError(undefined);
    setPdfBusyId(row.settlementId);
    const requestError = await pdf.run(
      `operations/settlements/payments/${row.settlementId}/pdf?language=${reportLanguage}`,
      `Trader-Settlement-${row.settlementNumber}.pdf`,
      mode,
    );
    setPdfBusyId(undefined);
    if (requestError !== undefined) {
      setPdfError(message(requestError, t("traderSettlements.pdfGenerationFailed")));
    }
  };

  if (!canManage) {
    return (
      <>
        <PageHeader
          actions={
            !canViewReport ? null : (
              <button onClick={() => setStatementOpen(true)} type="button">
                {t("traderSettlements.accountStatement")}
              </button>
            )
          }
          eyebrow={t("nav.traderSettlements")}
          title={t("traderSettlements.pageTitle")}
        />
        {!canViewReport ? (
          <div className="alert alert-error" role="alert">
            {t("traderSettlements.permissionDenied")}
          </div>
        ) : null}
        {!statementOpen ? null : (
          <TraderAccountStatementDialog
            api={api}
            initialTraderId={statementTraderId || presetTraderId}
            onClose={() => setStatementOpen(false)}
            reportLanguage={reportLanguage}
          />
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader
        actions={
          <>
            <button
              className="button button-primary"
              onClick={() => setNewSettlementOpen(true)}
              type="button"
            >
              {t("traderSettlements.newSettlement")}
            </button>
            <button
              className="button button-secondary"
              onClick={() => setStatementOpen(true)}
              type="button"
            >
              {t("traderSettlements.accountStatement")}
            </button>
            <button className="button button-secondary" onClick={refresh} type="button">
              {t("common.refresh")}
            </button>
          </>
        }
        description={t("traderSettlements.pageSubtitle")}
        eyebrow={t("nav.traderSettlements")}
        title={t("traderSettlements.pageTitle")}
      />

      {listError === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {listError}
        </div>
      )}
      {pdfError === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {pdfError}
        </div>
      )}

      {summary === undefined ? null : <SummaryCards summary={summary} />}

      <FilterBar api={api} filters={filters} onChange={applyFilter} onClear={clearFilters} />
      {/* Date Mode sits beside the list rather than inside the filter bar:
          the summary it renders describes the response, so it belongs where
          the response is. All three screens share this one component. */}
      <BusinessDateFilterControls
        applied={listPage?.appliedDateMode}
        businessDateFrom={filters.businessDateFrom}
        businessDateTo={filters.businessDateTo}
        dateMode={filters.dateMode}
        onChange={(patch) => applyFilter(patch)}
      />

      <section aria-labelledby="trader-settlements-list-heading">
        <h2 id="trader-settlements-list-heading">{t("traderSettlements.pageTitle")}</h2>
        <div className="table-scroll-x">
          <table>
            <thead>
              <tr>
                <th scope="col">{t("traderSettlements.columnSettlementNumber")}</th>
                <th scope="col">{t("traderSettlements.columnTrader")}</th>
                <th scope="col">{t("traderSettlements.columnPaymentDate")}</th>
                <th scope="col">{t("configuration.businessDay.businessDate")}</th>
                <th scope="col">{t("traderSettlements.columnPaymentMethod")}</th>
                <th scope="col">{t("traderSettlements.columnPaymentReference")}</th>
                <th scope="col">{t("traderSettlements.columnOrders")}</th>
                <th scope="col">{t("traderSettlements.columnPaymentAmount")}</th>
                <th scope="col">{t("traderSettlements.columnRemainingOutstanding")}</th>
                <th scope="col">{t("traderSettlements.columnMoneySent")}</th>
                <th scope="col">{t("traderSettlements.columnMoneyReceived")}</th>
                <th scope="col">{t("traderSettlements.columnStatus")}</th>
                <th scope="col">
                  <span className="sr-only">{t("common.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.settlementId}>
                  <td className="mono">
                    <button
                      className="link-button"
                      onClick={() => openDetail(row.settlementId)}
                      type="button"
                    >
                      {row.settlementNumber}
                    </button>
                  </td>
                  <td>{row.traderName}</td>
                  <td>{row.paymentDate}</td>
                  <td dir="ltr">
                    {row.confirmationBusinessDate == null
                      ? t("configuration.businessDay.historicalTimestampUnavailable")
                      : formatDate(row.confirmationBusinessDate, locale)}
                  </td>
                  <td>
                    {t(
                      row.paymentMethod === "cash"
                        ? "traderSettlements.paymentMethodCash"
                        : "traderSettlements.paymentMethodBankTransfer",
                    )}
                  </td>
                  <td className="mono">{row.paymentReference ?? "-"}</td>
                  <td>{row.orderCount}</td>
                  <td>{money(row.paymentAmount)}</td>
                  <td>{money(row.remainingOutstanding)}</td>
                  <td>{row.moneySentAt === null ? "-" : row.moneySentAt.slice(0, 10)}</td>
                  <td>
                    {row.moneyReceivedAt === null
                      ? row.moneyReceivedConfirmed
                        ? t("common.yes")
                        : "-"
                      : row.moneyReceivedAt.slice(0, 10)}
                  </td>
                  <td>
                    {t(
                      row.status === "reversed"
                        ? "traderSettlements.statusReversed"
                        : "traderSettlements.statusConfirmed",
                    )}
                    {row.isReversed && row.status !== "reversed" ? (
                      <span className="badge badge-warning">
                        {t("traderSettlements.reversedIndicator")}
                      </span>
                    ) : null}
                  </td>
                  <td className="row-actions">
                    <button onClick={() => openDetail(row.settlementId)} type="button">
                      {t("traderSettlements.actionView")}
                    </button>
                    {!canViewReport ? null : (
                      <>
                        <button
                          disabled={pdfBusyId === row.settlementId}
                          onClick={() => void openRowPdf(row, "preview")}
                          type="button"
                        >
                          {pdfBusyId === row.settlementId && pdf.busy === "preview"
                            ? t("common.loading")
                            : t("traderSettlements.actionPreviewStatement")}
                        </button>
                        <button
                          disabled={pdfBusyId === row.settlementId}
                          onClick={() => void openRowPdf(row, "print")}
                          type="button"
                        >
                          {pdfBusyId === row.settlementId && pdf.busy === "print"
                            ? t("common.loading")
                            : t("traderSettlements.actionPrint")}
                        </button>
                        <button
                          disabled={pdfBusyId === row.settlementId}
                          onClick={() => void openRowPdf(row, "download")}
                          type="button"
                        >
                          {pdfBusyId === row.settlementId && pdf.busy === "download"
                            ? t("common.loading")
                            : t("traderSettlements.actionDownloadPdf")}
                        </button>
                      </>
                    )}
                    {row.status === "reversed" || row.moneyReceivedConfirmed ? null : (
                      <button onClick={() => setReceiptTarget(row)} type="button">
                        {t("traderSettlements.actionConfirmMoneyReceived")}
                      </button>
                    )}
                    {!canReverse ||
                    row.status === "reversed" ||
                    row.moneyReceivedConfirmed ? null : (
                      <button onClick={() => setReverseTarget(row)} type="button">
                        {t("traderSettlements.actionReverse")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td className="empty-state" colSpan={12}>
                    {t("traderSettlements.noSettlements")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <nav aria-label={t("common.pagination")} className="pagination">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} type="button">
            {t("common.previous")}
          </button>
          <span>{t("common.pageOf", { page, pageCount })}</span>
          <button disabled={page >= pageCount} onClick={() => setPage(page + 1)} type="button">
            {t("common.next")}
          </button>
        </nav>
      </section>

      {!newSettlementOpen ? null : (
        <NewSettlementDialog
          api={api}
          {...((deepLinkTraderId ?? presetTraderId) === undefined
            ? {}
            : { initialTraderId: deepLinkTraderId ?? presetTraderId })}
          {...(deepLinkOrderId === undefined ? {} : { initialOrderId: deepLinkOrderId })}
          onOriginatingOrderIneligible={() =>
            setReceiptNotice(t("traderSettlements.originatingOrderIneligible"))
          }

          onClose={() => {
            setNewSettlementOpen(false);
            returnToOrigin();
          }}
          onCreated={(settlementId) => {
            setNewSettlementOpen(false);
            if (returnToOrigin()) return;
            refresh();
            openDetail(settlementId);
          }}
          onOpenAccountStatement={(traderId) => {
            setNewSettlementOpen(false);
            setStatementTraderId(traderId);
            setStatementOpen(true);
          }}
          reportLanguage={reportLanguage}
        />
      )}

      {!statementOpen ? null : (
        <TraderAccountStatementDialog
          api={api}
          initialTraderId={statementTraderId || filters.traderId || presetTraderId}
          onClose={() => setStatementOpen(false)}
          reportLanguage={reportLanguage}
        />
      )}

      {detailId === undefined ? null : (
        <SettlementDetailDialog
          api={api}
          canReverse={canReverse}
          canViewReport={canViewReport}
          onClose={() => closeDetail()}
          onOpenAccountStatement={(traderId) => {
            closeDetail();
            setStatementTraderId(traderId);
            setStatementOpen(true);
          }}
          onReversed={() => {
            closeDetail();
            refresh();
          }}
          reportLanguage={reportLanguage}
          settlementId={detailId}
        />
      )}

      {receiptNotice === undefined ? null : (
        <div className="alert alert-info" role="status">
          {receiptNotice}
        </div>
      )}

      {receiptTarget === undefined ? null : (
        <MoneyReceivedDialog
          api={api}
          onClose={() => {
            setReceiptTarget(undefined);
            returnToOrigin();
          }}
          onConfirmed={() => {
            // Keep the success acknowledgement visible. Its Close action then
            // returns to Order Search through the originating deep link.
            refresh();
          }}
          settlement={receiptTarget}
        />
      )}

      {reverseTarget === undefined ? null : (
        <ReverseSettlementDialog
          api={api}
          onClose={() => setReverseTarget(undefined)}
          onReversed={refresh}
          settlement={reverseTarget}
        />
      )}
    </>
  );
}

function TraderAccountStatementDialog({
  api,
  initialTraderId,
  onClose,
  reportLanguage,
}: {
  api: ApiClient;
  initialTraderId?: string | undefined;
  onClose: () => void;
  reportLanguage: "ar" | "en";
}) {
  const { t } = useTranslation();
  const now = new Date();
  const [traders, setTraders] = useState<readonly OperationsTrader[]>([]);
  const [traderId, setTraderId] = useState(initialTraderId ?? "");
  const [month, setMonth] = useState(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
  );
  const [periodType, setPeriodType] = useState<"custom" | "month">("month");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [transactionType, setTransactionType] = useState("all");
  const [settlementStatus, setSettlementStatus] = useState("all");
  const [paidOnly, setPaidOnly] = useState(false);
  const [outstandingOnly, setOutstandingOnly] = useState(false);
  const [reversedOnly, setReversedOnly] = useState(false);
  const [statement, setStatement] = useState<TraderAccountStatement>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const pdf = useReconciliationPdfActions(api);

  useEffect(() => {
    void api
      .get<readonly OperationsTrader[]>("operations/traders")
      .then(setTraders)
      .catch(() => setTraders([]));
  }, [api]);

  const params = () => {
    const query = new URLSearchParams({
      language: reportLanguage,
      settlementStatus,
      transactionType,
    });
    if (periodType === "month") query.set("month", month);
    else {
      query.set("from", from);
      query.set("to", to);
    }
    if (paidOnly) query.set("paidOnly", "true");
    if (outstandingOnly) query.set("outstandingOnly", "true");
    if (reversedOnly) query.set("reversedOnly", "true");
    return query.toString();
  };
  const load = async () => {
    if (
      traderId === "" ||
      (periodType === "month" ? month === "" : from === "" || to === "" || to < from)
    ) {
      setError(t("traderSettlements.statementSelectionRequired"));
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      setStatement(
        await api.get<TraderAccountStatement>(
          `operations/settlements/payments/traders/${traderId}/account-statement?${params()}`,
        ),
      );
    } catch (requestError) {
      setError(message(requestError, t("traderSettlements.statementLoadFailed")));
    } finally {
      setLoading(false);
    }
  };
  /* Re-generate when a row filter changes, once a statement is on screen.
     Paid only / Outstanding only / Reversed only, and the two dropdowns beside
     them, are applied by the SERVER -- so toggling one changed nothing until
     Generate Statement was pressed again. The controls looked live and were not,
     which reads as a broken filter rather than a pending one.
     Only after a first Generate: before that there is nothing to refresh, and
     the Trader and period are chosen deliberately, not reactively. */
  const statementLoaded = statement !== undefined;
  useEffect(() => {
    if (!statementLoaded) return;
    void load();
    // `load` is redefined every render; depending on it would loop. The filters
    // below are the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outstandingOnly, paidOnly, reversedOnly, settlementStatus, statementLoaded, transactionType]);

  const runPdf = async (action: PdfAction) => {
    if (
      traderId === "" ||
      (periodType === "month" ? month === "" : from === "" || to === "" || to < from)
    ) {
      setError(t("traderSettlements.statementSelectionRequired"));
      return;
    }
    const requestError = await pdf.run(
      `operations/settlements/payments/traders/${traderId}/account-statement/pdf?${params()}`,
      `Trader-Account-Statement-${periodType === "month" ? month : `${from}-${to}`}.pdf`,
      action,
    );
    if (requestError !== undefined) {
      setError(message(requestError, t("traderSettlements.pdfGenerationFailed")));
    }
  };

  return (
    <Modal
      className="modal-extra-wide"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("traderSettlements.accountStatement")}
      titleId="trader-account-statement-title"
    >
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      <div className="compact-filters">
        <label className="field">
          <span>{t("traderSettlements.filterTrader")}</span>
          <select onChange={(event) => setTraderId(event.target.value)} value={traderId}>
            <option value="">{t("traderSettlements.selectTrader")}</option>
            {traders.map((trader) => (
              <option key={trader.id} value={trader.id}>
                {trader.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("traderSettlements.statementPeriodType")}</span>
          <select
            onChange={(event) => setPeriodType(event.target.value as "custom" | "month")}
            value={periodType}
          >
            <option value="month">{t("traderSettlements.statementFullMonth")}</option>
            <option value="custom">{t("traderSettlements.statementCustomRange")}</option>
          </select>
        </label>
        {periodType === "month" ? (
          <label className="field">
            <span>{t("traderSettlements.statementMonth")}</span>
            <input onChange={(event) => setMonth(event.target.value)} type="month" value={month} />
          </label>
        ) : (
          <>
            <label className="field">
              <span>{t("traderSettlements.filterPaymentDateFrom")}</span>
              <input onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
            </label>
            <label className="field">
              <span>{t("traderSettlements.filterPaymentDateTo")}</span>
              <input onChange={(event) => setTo(event.target.value)} type="date" value={to} />
            </label>
          </>
        )}
        <label className="field">
          <span>{t("traderSettlements.statementTransactionType")}</span>
          <select
            onChange={(event) => setTransactionType(event.target.value)}
            value={transactionType}
          >
            <option value="all">{t("common.all")}</option>
            <option value="order">{t("traderSettlements.statementOrders")}</option>
            <option value="payment">{t("traderSettlements.statementPayments")}</option>
            <option value="reversal">{t("traderSettlements.statementReversals")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("traderSettlements.filterSettlementStatus")}</span>
          <select
            onChange={(event) => setSettlementStatus(event.target.value)}
            value={settlementStatus}
          >
            <option value="all">{t("common.all")}</option>
            <option value="confirmed">{t("traderSettlements.statusConfirmed")}</option>
            <option value="reversed">{t("traderSettlements.statusReversed")}</option>
          </select>
        </label>
        <label className="checkbox-field">
          <input
            checked={paidOnly}
            onChange={(event) => setPaidOnly(event.target.checked)}
            type="checkbox"
          />
          <span>{t("traderSettlements.statementPaidOnly")}</span>
        </label>
        <label className="checkbox-field">
          <input
            checked={outstandingOnly}
            onChange={(event) => setOutstandingOnly(event.target.checked)}
            type="checkbox"
          />
          <span>{t("traderSettlements.filterOutstandingOnly")}</span>
        </label>
        <label className="checkbox-field">
          <input
            checked={reversedOnly}
            onChange={(event) => setReversedOnly(event.target.checked)}
            type="checkbox"
          />
          <span>{t("traderSettlements.statementReversedOnly")}</span>
        </label>
      </div>
      <div className="modal-actions">
        <button disabled={loading} onClick={() => void load()} type="button">
          {loading ? t("common.loading") : t("traderSettlements.generateStatement")}
        </button>
        <button
          onClick={() => {
            setTraderId(initialTraderId ?? "");
            setPeriodType("month");
            setFrom("");
            setTo("");
            setTransactionType("all");
            setSettlementStatus("all");
            setPaidOnly(false);
            setOutstandingOnly(false);
            setReversedOnly(false);
            setStatement(undefined);
            setError(undefined);
          }}
          type="button"
        >
          {t("traderSettlements.clearFilters")}
        </button>
        <button
          disabled={pdf.busy !== undefined}
          onClick={() => void runPdf("preview")}
          type="button"
        >
          {t("traderSettlements.actionPreviewStatement")}
        </button>
        <button
          disabled={pdf.busy !== undefined}
          onClick={() => void runPdf("print")}
          type="button"
        >
          {t("traderSettlements.actionPrint")}
        </button>
        <button
          disabled={pdf.busy !== undefined}
          onClick={() => void runPdf("download")}
          type="button"
        >
          {t("traderSettlements.actionDownloadPdf")}
        </button>
      </div>
      {statement === undefined ? null : (
        <>
          <div className="summary-primary">
            <article className="kpi-card">
              <span>{t("traderSettlements.statementOpeningBalance")}</span>
              <strong>{money(statement.summary.openingBalance)}</strong>
            </article>
            <article className="kpi-card">
              <span>{t("traderSettlements.statementTotalPayable")}</span>
              <strong>{money(statement.summary.totalPayable)}</strong>
            </article>
            <article className="kpi-card">
              <span>{t("traderSettlements.statementNetPayments")}</span>
              <strong>{money(statement.summary.netPayments)}</strong>
            </article>
            <article className="kpi-card">
              <span>{t("traderSettlements.statementClosingBalance")}</span>
              <strong>{money(statement.summary.closingBalance)}</strong>
            </article>
            <article className="kpi-card">
              <span>{t("traderSettlements.statementCodCollected")}</span>
              <strong>{money(statement.summary.codCollected)}</strong>
            </article>
            <article className="kpi-card">
              <span>{t("traderSettlements.statementServiceFees")}</span>
              <strong>{money(statement.summary.serviceFeesDeducted)}</strong>
            </article>
            <article className="kpi-card">
              <span>{t("traderSettlements.statementOutstanding")}</span>
              <strong>{money(statement.summary.outstandingAmount)}</strong>
            </article>
            <article className="kpi-card">
              <span>{t("traderSettlements.statementDeliveredOrders")}</span>
              <strong>{statement.summary.deliveredOrderCount}</strong>
            </article>
          </div>
          {statement.warnings.map((warning) => (
            <div className="alert alert-warning" key={warning}>
              {warning}
            </div>
          ))}
          <div className="table-scroll-x">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t("common.date")}</th>
                  <th>{t("common.reference")}</th>
                  <th>{t("traderSettlements.statementDescription")}</th>
                  <th>{t("traderSettlements.statementDebit")}</th>
                  <th>{t("traderSettlements.statementCredit")}</th>
                  <th>{t("traderSettlements.statementBalance")}</th>
                </tr>
              </thead>
              <tbody>
                {statement.transactions.map((line) => (
                  <tr key={`${line.type}-${line.id}`}>
                    <td>{line.lineNumber}</td>
                    <td>{line.date}</td>
                    <td className="mono">{line.reference}</td>
                    <td>{line.description}</td>
                    <td>{money(line.debit)}</td>
                    <td>{money(line.credit)}</td>
                    <td>{money(line.runningBalance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

function SummaryCards({ summary }: { summary: TraderSettlementSummary }) {
  const { t } = useTranslation();
  const primaryCards: readonly { label: string; value: string }[] = [
    {
      label: t("traderSettlements.summaryEligiblePayable"),
      value: money(summary.eligibleTraderPayable),
    },
    { label: t("traderSettlements.summaryUnsettled"), value: money(summary.unsettledAmount) },
    {
      label: t("traderSettlements.summaryPartiallySettled"),
      value: money(summary.partiallySettledAmount),
    },
    { label: t("traderSettlements.summaryMoneySent"), value: money(summary.moneySentAmount) },
    {
      label: t("traderSettlements.summaryMoneyReceived"),
      value: money(summary.moneyReceivedAmount),
    },
    {
      label: t("traderSettlements.summaryRemainingOutstanding"),
      value: money(summary.remainingOutstanding),
    },
  ];
  const secondaryCards: readonly { label: string; value: string }[] = [
    { label: t("traderSettlements.summaryEligibleOrders"), value: String(summary.eligibleOrders) },
    {
      label: t("traderSettlements.summaryTradersOutstanding"),
      value: String(summary.tradersWithOutstandingBalance),
    },
    {
      label: t("traderSettlements.summaryReversedPayments"),
      value: String(summary.reversedPayments),
    },
  ];
  return (
    <>
      <div className="summary-primary" data-testid="trader-settlements-summary">
        {primaryCards.map((card) => (
          <article className="kpi-card" key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </article>
        ))}
      </div>
      <div className="summary-secondary" data-testid="trader-settlements-summary-secondary">
        {secondaryCards.map((card) => (
          <div className="metric-chip" key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </div>
        ))}
      </div>
    </>
  );
}

function FilterBar({
  api,
  filters,
  onChange,
  onClear,
}: {
  api: ApiClient;
  filters: Filters;
  onChange: (change: Partial<Filters>) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [traders, setTraders] = useState<readonly OperationsTrader[]>([]);
  useEffect(() => {
    void api
      .get<readonly OperationsTrader[]>("operations/traders")
      .then(setTraders)
      .catch(() => setTraders([]));
  }, [api]);

  return (
    <section aria-label={t("traderSettlements.pageTitle")}>
      <div className="compact-filters">
        <label className="field">
          <span>{t("traderSettlements.filterTrader")}</span>
          <select
            onChange={(event) => onChange({ traderId: event.target.value })}
            value={filters.traderId}
          >
            <option value="">{t("common.all")}</option>
            {traders.map((trader) => (
              <option key={trader.id} value={trader.id}>
                {trader.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("traderSettlements.filterSettlementNumber")}</span>
          <input
            onChange={(event) => onChange({ settlementNumber: event.target.value })}
            type="search"
            value={filters.settlementNumber}
          />
        </label>
        <label className="field">
          <span>{t("traderSettlements.filterPaymentMethod")}</span>
          <select
            onChange={(event) => onChange({ paymentMethod: event.target.value })}
            value={filters.paymentMethod}
          >
            <option value="">{t("common.all")}</option>
            <option value="cash">{t("traderSettlements.paymentMethodCash")}</option>
            <option value="bank_transfer">
              {t("traderSettlements.paymentMethodBankTransfer")}
            </option>
          </select>
        </label>
        <label className="field">
          <span>{t("traderSettlements.filterSettlementStatus")}</span>
          <select
            onChange={(event) => onChange({ settlementStatus: event.target.value })}
            value={filters.settlementStatus}
          >
            <option value="">{t("traderSettlements.statusAll")}</option>
            <option value="confirmed">{t("traderSettlements.statusConfirmed")}</option>
            <option value="reversed">{t("traderSettlements.statusReversed")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("traderSettlements.filterPaymentDateFrom")}</span>
          <input
            onChange={(event) => onChange({ paymentDateFrom: event.target.value })}
            type="date"
            value={filters.paymentDateFrom}
          />
        </label>
        <label className="field">
          <span>{t("traderSettlements.filterPaymentDateTo")}</span>
          <input
            onChange={(event) => onChange({ paymentDateTo: event.target.value })}
            type="date"
            value={filters.paymentDateTo}
          />
        </label>
        <label className="field">
          <span>{t("traderSettlements.filterPaymentReference")}</span>
          <input
            onChange={(event) => onChange({ paymentReference: event.target.value })}
            type="search"
            value={filters.paymentReference}
          />
        </label>
        <div className="filter-actions">
          <button className="button button-secondary" onClick={onClear} type="button">
            {t("traderSettlements.clearFilters")}
          </button>
        </div>
      </div>

      <details className="filter-drawer">
        <summary>{t("traderSettlements.moreFilters")}</summary>
        <div className="compact-filters">
          <label className="field">
            <span>{t("traderSettlements.filterOrderSerialNumber")}</span>
            <input
              onChange={(event) => onChange({ orderSerialNumber: event.target.value })}
              type="search"
              value={filters.orderSerialNumber}
            />
          </label>
          <label className="field">
            <span>{t("traderSettlements.filterExternalReference")}</span>
            <input
              onChange={(event) => onChange({ referenceNumber: event.target.value })}
              type="search"
              value={filters.referenceNumber}
            />
          </label>
          <label className="field">
            <span>{t("traderSettlements.filterDeliveryDateFrom")}</span>
            <input
              onChange={(event) => onChange({ deliveredFrom: event.target.value })}
              type="date"
              value={filters.deliveredFrom}
            />
          </label>
          <label className="field">
            <span>{t("traderSettlements.filterDeliveryDateTo")}</span>
            <input
              onChange={(event) => onChange({ deliveredTo: event.target.value })}
              type="date"
              value={filters.deliveredTo}
            />
          </label>
          <label className="field">
            <span>{t("traderSettlements.filterMoneyReceivedStatus")}</span>
            <select
              onChange={(event) => onChange({ moneyReceivedStatus: event.target.value })}
              value={filters.moneyReceivedStatus}
            >
              <option value="">{t("traderSettlements.moneyReceivedAll")}</option>
              <option value="received">{t("traderSettlements.moneyReceivedReceived")}</option>
              <option value="not_received">
                {t("traderSettlements.moneyReceivedNotReceived")}
              </option>
            </select>
          </label>
          <label className="field field-checkbox">
            <input
              checked={filters.outstandingOnly}
              onChange={(event) => onChange({ outstandingOnly: event.target.checked })}
              type="checkbox"
            />
            <span>{t("traderSettlements.filterOutstandingOnly")}</span>
          </label>
        </div>
      </details>
    </section>
  );
}

// ---------------------------------------------------------------------------
// New Settlement guided workflow: Select Trader -> Eligible Orders -> Payment
// Details (incl. bank accounts) -> Oldest-First Allocation Proposal -> Manual
// Allocation Editing -> Review -> Confirm Money Sent -> Success.
// ---------------------------------------------------------------------------

function NewSettlementDialog({
  api,
  initialTraderId,
  initialOrderId,
  onOriginatingOrderIneligible,
  onClose,
  onCreated,
  onOpenAccountStatement,
  reportLanguage,
}: {
  api: ApiClient;
  /** Originating Order from a smart next action, selected once it loads. */
  initialOrderId?: string | undefined;
  initialTraderId?: string | undefined;
  /** Called when the originating Order is not among the eligible Orders. */
  onOriginatingOrderIneligible?: (() => void) | undefined;
  onClose: () => void;
  onCreated: (settlementId: string) => void;
  onOpenAccountStatement: (traderId: string) => void;
  reportLanguage: "ar" | "en";
}) {
  const { t } = useTranslation();

  // Step 1 — Trader.
  const [traderSearch, setTraderSearch] = useState("");
  const [traders, setTraders] = useState<readonly OperationsTrader[]>([]);
  const [trader, setTrader] = useState<OperationsTrader>();

  // Step 2 — Eligible Orders (loaded once a Trader is selected).
  const [eligibleOrdersPage, setEligibleOrdersPage] =
    useState<PagedResponse<TraderEligibleOrderRow>>();
  const [ordersError, setOrdersError] = useState<string>();
  const [orderFilters, setOrderFilters] = useState<EligibleOrderFilters>(emptyEligibleOrderFilters);
  const [eligibleFiltersOpen, setEligibleFiltersOpen] = useState(() => initialOrderId === undefined);
  const [ordersPage, setOrdersPage] = useState(1);
  const eligibleOrders = eligibleOrdersPage?.items ?? [];
  const ordersTotal = eligibleOrdersPage?.total ?? 0;
  const ordersPageCount = ordersTotal === 0 ? 1 : Math.ceil(ordersTotal / 50);

  // Step 3 — Payment Details.
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [paymentMethod, setPaymentMethod] = useState<"bank_transfer" | "cash">("cash");
  const [companyBanks, setCompanyBanks] = useState<readonly CompanyBankAccount[]>([]);
  const [traderBanks, setTraderBanks] = useState<readonly TraderBankAccountOption[]>([]);
  const [sourceBankId, setSourceBankId] = useState("");
  const [beneficiaryBankId, setBeneficiaryBankId] = useState("");
  const [bankReference, setBankReference] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");
  const [cashAccounts, setCashAccounts] = useState<
    readonly { readonly id: string; readonly name: string }[]
  >([]);
  const [cashAccountsFailed, setCashAccountsFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setCashAccountsFailed(false);
    api
      .get<readonly { id: string; name: string }[]>(
        "operations/accounting/cash-bank/cash-accounts?activeOnly=true",
        controller.signal,
      )
      .then((accounts) => {
        setCashAccounts(accounts);
        /* One account means there is nothing to choose. Selecting it removes a
           required field that could only ever be answered one way, and with it
           the "Cash Account is required" block that followed forgetting it.
           With several, the operator still picks: auto-choosing which cash box
           the money leaves is not a decision to make on their behalf. */
        if (accounts.length === 1) setCashAccountId((current) => current || accounts[0]!.id);
      })
      .catch(() => {
        // A failed load must not wedge the dialog: the selector stays empty,
        // the required check blocks Review, and the backend refuses a cash
        // settlement without an account regardless.
        if (!controller.signal.aborted) {
          setCashAccounts([]);
          setCashAccountsFailed(true);
        }
      });
    return () => controller.abort();
  }, [api]);
  const [notes, setNotes] = useState("");

  // Step 4/5 — Allocation proposal + manual editing.
  const [proposal, setProposal] = useState<TraderAllocationProposal>();
  const [proposalError, setProposalError] = useState<string>();
  const [allocations, setAllocations] = useState<readonly { amount: string; orderId: string }[]>(
    [],
  );
  const [selectedOrderRows, setSelectedOrderRows] = useState<
    Readonly<Record<string, TraderEligibleOrderRow>>
  >({});
  const [overrideConfirmed, setOverrideConfirmed] = useState(false);
  const [originatingOrderDefaultActive, setOriginatingOrderDefaultActive] = useState(
    () => initialOrderId !== undefined,
  );
  const [originatingOrderRow, setOriginatingOrderRow] = useState<TraderEligibleOrderRow>();

  /* Totals for the eligible-Orders list.
     Computed over the rows actually LISTED, which is one page. Select-all works
     on the same rows, so the figure beside it always describes exactly what the
     checkbox would tick -- a total spanning unseen pages would not. */
  const selectedOrderIds = new Set(allocations.map((line) => line.orderId));
  const selectedEligibleOrders = eligibleOrders.filter((order) => selectedOrderIds.has(order.id));
  const sumOutstanding = (rows: readonly TraderEligibleOrderRow[]) =>
    rows.reduce((total, order) => total + safeMoneyValue(order.outstandingBalance), 0);
  const listedOutstandingTotal = sumOutstanding(eligibleOrders);
  const selectedOutstandingTotal = sumOutstanding(selectedEligibleOrders);
  const allListedSelected =
    eligibleOrders.length > 0 && selectedEligibleOrders.length === eligibleOrders.length;

  /** Ticks or clears every listed Order at once, one state change per list. */
  const toggleAllListedOrders = (checked: boolean) => {
    setOriginatingOrderDefaultActive(false);
    setOverrideConfirmed(false);
    const listedIds = new Set(eligibleOrders.map((order) => order.id));
    if (checked) {
      setSelectedOrderRows((current) => {
        const next = { ...current };
        for (const order of eligibleOrders) next[order.id] = order;
        return next;
      });
      setAllocations((current) => [
        ...current,
        // Only the ones not already carrying an allocation, so a hand-edited
        // amount is never reset by ticking the header.
        ...eligibleOrders
          .filter((order) => !current.some((line) => line.orderId === order.id))
          .map((order) => ({ amount: "0.00", orderId: order.id })),
      ]);
      return;
    }
    setAllocations((current) => current.filter((line) => !listedIds.has(line.orderId)));
    setSelectedOrderRows((current) => {
      const next = { ...current };
      for (const id of listedIds) delete next[id];
      return next;
    });
  };

  const [saving, setSaving] = useState(false);
  const [confirmError, setConfirmError] = useState<string>();
  const [confirmed, setConfirmed] = useState<CreateTraderSettlementResult>();
  const idempotency = useIdempotencyKey();
  const pdf = useReconciliationPdfActions(api);
  const [pdfError, setPdfError] = useState<string>();

  useEffect(() => {
    void api
      .get<readonly OperationsTrader[]>("operations/traders")
      .then((rows) => setTraders(rows.filter((row) => row.status === "active")))
      .catch(() => setTraders([]));
  }, [api]);

  useEffect(() => {
    if (initialTraderId === undefined || traders.length === 0) return;
    const preset = traders.find((row) => row.id === initialTraderId);
    if (preset !== undefined) setTrader(preset);
    // Only ever auto-select once, when the preset Trader first appears.
  }, [traders, initialTraderId]);

  const loadOrders = useCallback(() => {
    if (trader === undefined) return;
    setOrdersError(undefined);
    const params = filterQuery(orderFilters);
    params.set("traderId", trader.id);
    params.set("page", String(ordersPage));
    params.set("pageSize", "50");
    void api
      .get<PagedResponse<TraderEligibleOrderRow>>(
        `operations/settlements/payments/eligible-orders?${params.toString()}`,
      )
      .then(setEligibleOrdersPage)
      .catch(() => setOrdersError(t("common.loadFailed")));
  }, [api, trader, orderFilters, ordersPage, t]);

  useEffect(() => loadOrders(), [loadOrders]);
  /* Select the originating Order once, from the eligible list the backend just
     returned.

     Opening New Settlement from an Order is an explicit operator intent to pay
     that Order. Default to that Order only instead of immediately asking the
     server for oldest-first allocation, which would pull older outstanding
     Orders into a simple one-Order payment and require an override checkbox. */
  const originatingApplied = useRef(false);
  useEffect(() => {
    if (initialOrderId === undefined || originatingApplied.current) return;
    if (eligibleOrdersPage === undefined) return;
    originatingApplied.current = true;
    const row = eligibleOrders.find((candidate) => candidate.id === initialOrderId);
    if (row === undefined) {
      // Collected, settled or reassigned since the link was built. Reported
      // rather than forced, so no stale allocation state is created.
      onOriginatingOrderIneligible?.();
      return;
    }
    setOriginatingOrderRow(row);
    setOriginatingOrderDefaultActive(true);
    setSelectedOrderRows({ [row.id]: row });
    setAllocations([{ amount: "0.00", orderId: row.id }]);
    setAmount("");
    setProposal(undefined);
    setProposalError(undefined);
    setOverrideConfirmed(false);
  }, [eligibleOrders, eligibleOrdersPage, initialOrderId, onOriginatingOrderIneligible]);

  const applyOrderFilter = (change: Partial<EligibleOrderFilters>) => {
    setOrdersPage(1);
    setOrderFilters((current) => ({ ...current, ...change }));
  };
  const clearOrderFilters = () => {
    setOrdersPage(1);
    setOrderFilters(emptyEligibleOrderFilters);
  };

  useEffect(() => {
    if (trader === undefined) {
      setCompanyBanks([]);
      setTraderBanks([]);
      return;
    }
    void api
      .get<readonly CompanyBankAccount[]>("configuration/bank-accounts")
      .then((accounts) => {
        const active = accounts.filter((account) => account.isActive);
        setCompanyBanks(active);
        setSourceBankId((current) =>
          current !== "" && active.some((account) => account.id === current)
            ? current
            : (active[0]?.id ?? ""),
        );
      })
      .catch(() => setCompanyBanks([]));
    void api
      .get<readonly TraderBankAccountOption[]>(`configuration/traders/${trader.id}/bank-accounts`)
      .then((accounts) => {
        const active = accounts.filter((account) => account.isActive);
        setTraderBanks(active);
        const preferred = active.find((account) => account.isDefault) ?? active[0];
        setBeneficiaryBankId(preferred?.id ?? "");
      })
      .catch(() => setTraderBanks([]));
  }, [api, trader]);

  const chooseTrader = (next: OperationsTrader) => {
    if (allocations.length > 0 && trader !== undefined && trader.id !== next.id) {
      if (!window.confirm(t("traderSettlements.changeTraderWarning"))) return;
    }
    setTrader(next);
    setAmount("");
    setProposal(undefined);
    setAllocations([]);
    setSelectedOrderRows({});
    setOverrideConfirmed(false);
    setOriginatingOrderDefaultActive(false);
    setOriginatingOrderRow(undefined);
    setBankReference("");
    setOrderFilters(emptyEligibleOrderFilters);
    setOrdersPage(1);
    idempotency.reset();
  };
  // Debounced oldest-first allocation proposal: the normal New Settlement path
  // still uses the server allocator. When opened from one Order, the default is
  // the clicked Order only; the operator can still switch back by changing the
  // selection or pressing Apply Oldest-First.
  useEffect(() => {
    const parsed = parseMoneyInput(amount, { required: true });
    const originatingOrder = initialOrderId === undefined ? undefined : originatingOrderRow;
    if (originatingOrderDefaultActive && originatingOrder !== undefined) {
      setProposal(undefined);
      setProposalError(undefined);
      if (amount.trim() === "" || !parsed.ok || !(parsed.value > 0)) return;
      const outstanding = safeMoneyValue(originatingOrder.outstandingBalance);
      setAllocations([
        { amount: money(Math.min(parsed.value, outstanding)), orderId: originatingOrder.id },
      ]);
      setOverrideConfirmed(false);
      return;
    }
    if (trader === undefined || amount.trim() === "" || !parsed.ok || !(parsed.value > 0)) {
      setProposal(undefined);
      setAllocations([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void api
        .post<TraderAllocationProposal>("operations/settlements/payments/propose-allocation", {
          amount: parsed.value,
          traderId: trader.id,
        })
        .then((result) => {
          if (!active) return;
          setProposal(result);
          setProposalError(undefined);
          setAllocations(
            result.allocations
              .filter((line) => safeMoneyValue(line.allocatedAmount) > 0)
              .map((line) => ({ amount: line.allocatedAmount, orderId: line.orderId })),
          );
          setOverrideConfirmed(false);
        })
        .catch((error: unknown) => {
          if (!active) return;
          setProposal(undefined);
          setAllocations([]);
          setProposalError(message(error, t("traderSettlements.settlementFailed")));
        });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, amount, initialOrderId, originatingOrderDefaultActive, originatingOrderRow, trader, t]);

  // Delivery date is display-only, for the allocation table's Delivery Date
  // column — the proposal/allocation endpoints don't return it. Looked up
  // from whichever page of Eligible Orders happens to be loaded; a row that
  // isn't on the current page falls back to "-" rather than blocking review,
  // since delivery date is never load-bearing for any total or validation.
  const orderById = useMemo(
    () => new Map(eligibleOrders.map((row) => [row.id, row])),
    [eligibleOrders],
  );
  // Source of truth for the allocation table and every total/validation
  // below: the server's own proposal lines, never the (possibly paginated,
  // possibly filtered) Eligible Orders list.
  const proposalLineById = useMemo(
    () => new Map((proposal?.allocations ?? []).map((line) => [line.orderId, line])),
    [proposal],
  );

  const setLineAmount = (orderId: string, value: string) => {
    setOverrideConfirmed(false);
    setAllocations((current) => {
      const existing = current.find((line) => line.orderId === orderId);
      if (existing === undefined) return [...current, { amount: value, orderId }];
      return current.map((line) => (line.orderId === orderId ? { ...line, amount: value } : line));
    });
  };

  const allocationDisplayLines = useMemo(() => {
    const lines = new Map(
      (proposal?.allocations ?? []).map((line) => [line.orderId, line] as const),
    );
    for (const [orderId, order] of Object.entries(selectedOrderRows)) {
      if (lines.has(orderId)) continue;
      const allocatedAmount =
        allocations.find((line) => line.orderId === orderId)?.amount ?? "0.00";
      lines.set(orderId, {
        allocatedAmount,
        orderId,
        orderNumber: order.serialNumber,
        outstandingAfter: money(
          safeMoneyValue(order.outstandingBalance) - safeMoneyValue(allocatedAmount),
        ),
        outstandingBefore: order.outstandingBalance,
        serialNumber: order.serialNumber,
      });
    }
    return [...lines.values()];
  }, [allocations, proposal, selectedOrderRows]);

  const amountInput = parseMoneyInput(amount, { required: true });
  const allocatedTotal = allocations.reduce((sum, line) => {
    const parsed = parseMoneyInput(line.amount, { required: true });
    return sum + (parsed.ok ? parsed.value : 0);
  }, 0);
  const requestedAmount = amountInput.ok ? amountInput.value : 0;
  const unallocated = money(requestedAmount - allocatedTotal);
  const allocationErrors: string[] = [];
  const seenOrders = new Set<string>();
  for (const line of allocations) {
    if (seenOrders.has(line.orderId))
      allocationErrors.push(t("traderSettlements.allocationDuplicateOrder"));
    seenOrders.add(line.orderId);
    const parsedLine = parseMoneyInput(line.amount, { required: true });
    const lineAmount = parsedLine.ok ? parsedLine.value : 0;
    if (!parsedLine.ok) allocationErrors.push(t("traderSettlements.invalidAmount"));
    const proposedLine = proposalLineById.get(line.orderId);
    const outstandingBefore =
      proposedLine?.outstandingBefore ?? selectedOrderRows[line.orderId]?.outstandingBalance;
    if (outstandingBefore !== undefined && lineAmount > safeMoneyValue(outstandingBefore) + 0.001) {
      allocationErrors.push(t("traderSettlements.allocationExceedsOutstanding"));
    }
  }
  if (amount.trim() !== "" && Math.abs(safeMoneyValue(unallocated)) > 0.005) {
    allocationErrors.push(t("traderSettlements.allocationTotalMismatch"));
  }

  if (amount.trim() !== "" && !amountInput.ok) {
    allocationErrors.push(t("traderSettlements.invalidAmount"));
  }
  const activeAllocations = allocations.filter((line) => {
    const parsed = parseMoneyInput(line.amount, { required: true });
    return parsed.ok && parsed.value > 0;
  });
  const manualOverride =
    proposal !== undefined &&
    (activeAllocations.length !== proposal.allocations.length ||
      proposal.allocations.some((line) => {
        const selected = activeAllocations.find((item) => item.orderId === line.orderId);
        return (
          selected === undefined ||
          Math.abs(safeMoneyValue(selected.amount) - safeMoneyValue(line.allocatedAmount)) > 0.001
        );
      }));
  /* Over every line SHOWN, not only the ones the server proposed.
     Iterating `proposal.allocations` omitted any selected Order the proposal did
     not reach -- pay 50 against two Orders and the server proposes one line, so
     the second Order's balance vanished from the figure. It read 130.00 when
     260.00 was still outstanding: an understatement, on the number an operator
     uses to decide whether the Trader is square. */
  const remainingAfter = allocationDisplayLines.reduce((sum, line) => {
    const current = allocations.find((row) => row.orderId === line.orderId)?.amount;
    const paidNow =
      current === undefined ? safeMoneyValue(line.allocatedAmount) : safeMoneyValue(current);
    return sum + Math.max(0, safeMoneyValue(line.outstandingBefore) - paidNow);
  }, 0);

  const canProceedToReview =
    trader !== undefined &&
    requestedAmount > 0 &&
    activeAllocations.length > 0 &&
    allocationErrors.length === 0 &&
    (!manualOverride || overrideConfirmed) &&
    (paymentMethod === "cash"
      ? cashAccountId !== ""
      : sourceBankId !== "" && beneficiaryBankId !== "" && bankReference.trim() !== "");

  const fingerprint = JSON.stringify({
    allocations: [...activeAllocations].sort((left, right) =>
      left.orderId.localeCompare(right.orderId),
    ),
    amount: money(requestedAmount),
    bankReference: bankReference.trim(),
    beneficiaryBankId,
    cashAccountId,
    notes: notes.trim(),
    paymentDate,
    paymentMethod,
    sourceBankId,
    traderId: trader?.id,
  });

  const confirm = async () => {
    if (!canProceedToReview || saving || trader === undefined) return;
    setSaving(true);
    setConfirmError(undefined);
    try {
      const result = await api.post<CreateTraderSettlementResult>(
        "operations/settlements/payments",
        {
          allocations: activeAllocations.map((line) => ({
            amount: safeMoneyValue(line.amount),
            orderId: line.orderId,
          })),
          amount: safeMoneyValue(requestedAmount),
          ...(paymentMethod === "bank_transfer"
            ? {
                bankAccountId: sourceBankId,
                bankReference: bankReference.trim(),
                traderBankAccountId: beneficiaryBankId,
              }
            : { cashAccountId }),
          notes: notes.trim() === "" ? undefined : notes.trim(),
          paymentDate,
          paymentMethod,
          traderId: trader.id,
        },
        { "X-Idempotency-Key": idempotency.keyFor(fingerprint) },
      );
      setConfirmed(result);
      idempotency.reset();
    } catch (error) {
      setConfirmError(message(error, t("traderSettlements.settlementFailed")));
    } finally {
      setSaving(false);
    }
  };

  const openConfirmedPdf = async (mode: PdfAction) => {
    if (confirmed === undefined) return;
    setPdfError(undefined);
    const requestError = await pdf.run(
      `operations/settlements/payments/${confirmed.settlementId}/pdf?language=${reportLanguage}`,
      `Trader-Settlement-${confirmed.settlementNumber}.pdf`,
      mode,
    );
    if (requestError !== undefined)
      setPdfError(message(requestError, t("traderSettlements.pdfGenerationFailed")));
  };

  // Money Sent to Trader only ever pays down a positive balance (the Company
  // owes the Trader) — a zero balance has nothing to settle, and a negative
  // balance means the Trader owes the Company, which is a different workflow
  // (Trader receivable / Collect Money from Trader, not yet built) and must
  // never appear here as something payable.
  const filteredTraders = traders
    .filter((row) => safeMoneyValue(row.unsettledNetPayable) > 0)
    .filter((row) =>
      traderSearch.trim() === ""
        ? true
        : `${row.name} ${row.code}`.toLowerCase().includes(traderSearch.trim().toLowerCase()),
    )
    .sort(
      (left, right) =>
        safeMoneyValue(right.unsettledNetPayable) - safeMoneyValue(left.unsettledNetPayable),
    );

  return (
    <Modal
      className="modal-wide"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("traderSettlements.newSettlement")}
      titleId="new-settlement-title"
    >
      {confirmed !== undefined ? (
        <div className="reconciliation-success" role="status">
          <p>
            {t("traderSettlements.settlementConfirmed", { number: confirmed.settlementNumber })}
          </p>
          <dl className="reconciliation-summary">
            <div className="detail-line">
              <dt>{t("traderSettlements.columnSettlementNumber")}</dt>
              <dd>{confirmed.settlementNumber}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.filterTrader")}</dt>
              <dd>{confirmed.traderName}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.paymentDate")}</dt>
              <dd>{paymentDate}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.filterPaymentMethod")}</dt>
              <dd>
                {t(
                  confirmed.paymentMethod === "cash"
                    ? "traderSettlements.paymentMethodCash"
                    : "traderSettlements.paymentMethodBankTransfer",
                )}
              </dd>
            </div>
            {confirmed.paymentMethod !== "bank_transfer" ? null : (
              <div className="detail-line">
                <dt>{t("traderSettlements.columnPaymentReference")}</dt>
                <dd>{bankReference}</dd>
              </div>
            )}
            <div className="detail-line">
              <dt>{t("traderSettlements.paymentAmount")}</dt>
              <dd>{money(confirmed.amount)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.columnOrders")}</dt>
              <dd>{confirmed.orderCount}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.columnRemainingOutstanding")}</dt>
              <dd>{money(remainingAfter)}</dd>
            </div>
          </dl>
          {pdfError === undefined ? null : (
            <div className="alert alert-error" role="alert">
              {pdfError}
            </div>
          )}
          <div className="modal-actions">
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void openConfirmedPdf("preview")}
              type="button"
            >
              {pdf.busy === "preview"
                ? t("common.loading")
                : t("traderSettlements.actionPreviewStatement")}
            </button>
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void openConfirmedPdf("print")}
              type="button"
            >
              {pdf.busy === "print" ? t("common.loading") : t("traderSettlements.actionPrint")}
            </button>
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void openConfirmedPdf("download")}
              type="button"
            >
              {pdf.busy === "download"
                ? t("common.loading")
                : t("traderSettlements.actionDownloadPdf")}
            </button>
            <button
              className="button button-secondary"
              onClick={() => onCreated(confirmed.settlementId)}
              type="button"
            >
              {t("traderSettlements.viewSettlement")}
            </button>
            <button
              className="button button-secondary"
              onClick={() => onOpenAccountStatement(confirmed.traderId)}
              type="button"
            >
              {t("traderSettlements.accountStatement")}
            </button>
            <button
              className="button button-primary"
              onClick={() => onCreated(confirmed.settlementId)}
              type="button"
            >
              {t("common.done")}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={(event) => void (event.preventDefault(), confirm())}>
          {confirmError === undefined ? null : (
            <div className="alert alert-error" role="alert">
              {confirmError}
            </div>
          )}

          {/* Step 1 — Select Trader */}
          <section className="workspace-step">
            <h3>{t("traderSettlements.stepSelectTrader")}</h3>
            {trader === undefined ? (
              <>
                <label className="field">
                  <span>{t("traderSettlements.searchTraders")}</span>
                  <input
                    onChange={(event) => setTraderSearch(event.target.value)}
                    placeholder={t("traderSettlements.searchTraders")}
                    type="search"
                    value={traderSearch}
                  />
                </label>
                <ul className="option-list">
                  {filteredTraders.map((option) => (
                    <li key={option.id}>
                      <button onClick={() => chooseTrader(option)} type="button">
                        {option.name} —{" "}
                        {t("traderSettlements.traderBalanceDue", {
                          amount: money(option.unsettledNetPayable),
                        })}
                      </button>
                    </li>
                  ))}
                  {filteredTraders.length === 0 ? (
                    <li className="empty-state">{t("traderSettlements.noTradersWithBalance")}</li>
                  ) : null}
                </ul>
              </>
            ) : (
              <div className="detail-line">
                <span>{trader.name}</span>
                <button onClick={() => setTrader(undefined)} type="button">
                  {t("common.change")}
                </button>
              </div>
            )}
          </section>

          {trader === undefined ? null : (
            <>
              {/* Step 2 — Eligible Orders */}
              <section className="workspace-step">
                <h3>{t("traderSettlements.stepEligibleOrders")}</h3>
                {ordersError === undefined ? null : (
                  <div className="alert alert-error">{ordersError}</div>
                )}
                <details
                  className="filter-drawer"
                  onToggle={(event) => setEligibleFiltersOpen(event.currentTarget.open)}
                  open={eligibleFiltersOpen}
                >
                  <summary>{t("common.filter")}</summary>
                  <div className="compact-filters">
                  <label className="field">
                    <span>{t("traderSettlements.filterOrderSerialNumber")}</span>
                    <input
                      onChange={(event) => applyOrderFilter({ serialNumber: event.target.value })}
                      type="search"
                      value={orderFilters.serialNumber}
                    />
                  </label>
                  <label className="field">
                    <span>{t("traderSettlements.filterExternalReference")}</span>
                    <input
                      onChange={(event) =>
                        applyOrderFilter({ referenceNumber: event.target.value })
                      }
                      type="search"
                      value={orderFilters.referenceNumber}
                    />
                  </label>
                  <label className="field">
                    <span>{t("traderSettlements.filterDeliveryDateFrom")}</span>
                    <input
                      onChange={(event) => applyOrderFilter({ deliveredFrom: event.target.value })}
                      type="date"
                      value={orderFilters.deliveredFrom}
                    />
                  </label>
                  <label className="field">
                    <span>{t("traderSettlements.filterDeliveryDateTo")}</span>
                    <input
                      onChange={(event) => applyOrderFilter({ deliveredTo: event.target.value })}
                      type="date"
                      value={orderFilters.deliveredTo}
                    />
                  </label>
                  <div className="field" data-field="area">
                    <span>{t("areas.emirate")}</span>
                    <AreaSelector
                      allowCreate={false}
                      api={api}
                      onChange={(area) =>
                        applyOrderFilter({
                          areaId: area?.id ?? "",
                          emirateId: area?.emirateId ?? "",
                        })
                      }
                      value={undefined}
                    />
                  </div>
                  <label className="field">
                    <span>{t("traderSettlements.filterSettlementStatus")}</span>
                    <select
                      onChange={(event) =>
                        applyOrderFilter({ settlementStatus: event.target.value })
                      }
                      value={orderFilters.settlementStatus}
                    >
                      <option value="">{t("common.all")}</option>
                      {orderSettlementStatuses.map((status) => (
                        <option key={status} value={status}>
                          {t(`traderSettlements.orderStatus${statusKey(status)}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field field-checkbox">
                    <input
                      checked={orderFilters.outstandingOnly}
                      onChange={(event) =>
                        applyOrderFilter({ outstandingOnly: event.target.checked })
                      }
                      type="checkbox"
                    />
                    <span>{t("traderSettlements.filterOutstandingOnly")}</span>
                  </label>
                  <div className="filter-actions">
                    <button
                      className="button button-secondary"
                      onClick={clearOrderFilters}
                      type="button"
                    >
                      {t("traderSettlements.clearFilters")}
                    </button>
                  </div>
                </div>
                </details>
                <div className="table-scroll-x">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">
                          {/* Ticks every Order listed below. Disabled with an
                              empty list so it cannot read as "all selected"
                              when there is nothing to select. */}
                          <input
                            aria-label={t("traderSettlements.selectAllEligibleOrders")}
                            checked={allListedSelected}
                            disabled={eligibleOrders.length === 0}
                            onChange={(event) => toggleAllListedOrders(event.target.checked)}
                            type="checkbox"
                          />
                        </th>
                        <th scope="col">{t("traderSettlements.filterOrderSerialNumber")}</th>
                        <th scope="col">{t("traderSettlements.filterExternalReference")}</th>
                        <th scope="col">{t("traderSettlements.filterDeliveryDateFrom")}</th>
                        <th scope="col">{t("common.name")}</th>
                        <th scope="col">{t("traderSettlements.columnOriginalAmountDue")}</th>
                        <th scope="col">{t("traderSettlements.columnPreviouslyPaid")}</th>
                        <th scope="col">{t("traderSettlements.columnOutstandingBalance")}</th>
                        <th scope="col">{t("traderSettlements.orderSettlementStatus")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {eligibleOrders.map((order) => (
                        <tr key={order.id}>
                          <td>
                            <input
                              checked={allocations.some(
                                (allocation) => allocation.orderId === order.id,
                              )}
                              onChange={(event) => {
                                setOriginatingOrderDefaultActive(false);
                                setOverrideConfirmed(false);
                                if (event.target.checked) {
                                  setSelectedOrderRows((current) => ({
                                    ...current,
                                    [order.id]: order,
                                  }));
                                  setAllocations((current) =>
                                    current.some((line) => line.orderId === order.id)
                                      ? current
                                      : [...current, { amount: "0.00", orderId: order.id }],
                                  );
                                } else {
                                  setAllocations((current) =>
                                    current.filter((line) => line.orderId !== order.id),
                                  );
                                  setSelectedOrderRows((current) => {
                                    const next = { ...current };
                                    delete next[order.id];
                                    return next;
                                  });
                                }
                              }}
                              type="checkbox"
                            />
                          </td>
                          <td className="mono">{order.serialNumber}</td>
                          <td className="mono">{order.referenceNumber ?? "-"}</td>
                          <td>
                            {order.deliveryDate === null ? "-" : order.deliveryDate.slice(0, 10)}
                          </td>
                          <td>{order.customerName}</td>
                          <td>{money(order.originalAmountDueToTrader)}</td>
                          <td>{money(order.previouslyPaid)}</td>
                          <td>{money(order.outstandingBalance)}</td>
                          <td>
                            {t(`traderSettlements.orderStatus${statusKey(order.settlementStatus)}`)}
                          </td>
                        </tr>
                      ))}
                      {eligibleOrders.length === 0 && ordersError === undefined ? (
                        <tr>
                          <td className="empty-state" colSpan={9}>
                            {t("traderSettlements.noEligibleOrders")}
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
                {/* What is listed, and what is ticked. The selected line appears
                    only once something is ticked, so an untouched form is not
                    already reporting a selection of zero. `role="status"` so the
                    running total is announced as it changes rather than being
                    silent to anyone not watching it. */}
                {eligibleOrders.length === 0 ? null : (
                  <div className="eligible-orders-totals" role="status">
                    <span>
                      {t("traderSettlements.listedOrdersTotal", {
                        count: eligibleOrders.length,
                      })}
                      <strong>{money(listedOutstandingTotal.toFixed(2))}</strong>
                    </span>
                    {selectedEligibleOrders.length === 0 ? null : (
                      <span className="eligible-orders-selected">
                        {t("traderSettlements.selectedOrdersTotal", {
                          count: selectedEligibleOrders.length,
                        })}
                        <strong>{money(selectedOutstandingTotal.toFixed(2))}</strong>
                      </span>
                    )}
                  </div>
                )}
                {ordersTotal <= 50 ? null : (
                  <nav aria-label={t("common.pagination")} className="pagination">
                    <button
                      disabled={ordersPage <= 1}
                      onClick={() => setOrdersPage(ordersPage - 1)}
                      type="button"
                    >
                      {t("common.previous")}
                    </button>
                    <span>
                      {t("common.pageOf", { page: ordersPage, pageCount: ordersPageCount })}
                    </span>
                    <button
                      disabled={ordersPage >= ordersPageCount}
                      onClick={() => setOrdersPage(ordersPage + 1)}
                      type="button"
                    >
                      {t("common.next")}
                    </button>
                  </nav>
                )}
              </section>

              {/* Step 3 — Payment Details.
                  `form-grid` is the same two-column layout every other modal
                  form in the application uses (Create Order, Edit Order); this
                  screen was the one place still using bare full-width fields,
                  which is why Payment Amount stretched edge to edge instead of
                  sitting beside Payment Date. */}
              <section className="workspace-step">
                <h3>{t("traderSettlements.stepPaymentDetails")}</h3>
                <div className="form-grid">
                  <label className="field required-field">
                    <span>{t("traderSettlements.paymentAmount")}</span>
                    {/* `no-spinner` and min="0" to match every other money field
                      in the application; the spinner arrows are one more way to
                      nudge an amount by a cent nobody meant to enter. The
                      required/positive check is enforced by `parseMoneyInput`,
                      not by the min attribute. */}
                    <input
                      className="no-spinner"
                      inputMode="decimal"
                      min="0"
                      onChange={(event) => setAmount(event.target.value)}
                      step="0.01"
                      type="number"
                      value={amount}
                    />
                  </label>
                  <label className="field required-field">
                    <span>{t("traderSettlements.paymentDate")}</span>
                    <input
                      onChange={(event) => setPaymentDate(event.target.value)}
                      type="date"
                      value={paymentDate}
                    />
                  </label>
                  <label className="field required-field">
                    <span>{t("traderSettlements.filterPaymentMethod")}</span>
                    <select
                      onChange={(event) => {
                        const next = event.target.value as "bank_transfer" | "cash";
                        setPaymentMethod(next);
                        // Clear the branch we are leaving. A hidden stale account
                        // would ride along in the fingerprint even when it is not
                        // submitted, and could replay the wrong idempotent result.
                        if (next === "cash") {
                          setSourceBankId("");
                          setBeneficiaryBankId("");
                          setBankReference("");
                        } else {
                          setCashAccountId("");
                        }
                      }}
                      value={paymentMethod}
                    >
                      <option value="cash">{t("traderSettlements.paymentMethodCash")}</option>
                      <option value="bank_transfer">
                        {t("traderSettlements.paymentMethodBankTransfer")}
                      </option>
                    </select>
                  </label>
                  {/* Cash accounts only. A cash settlement leaves a drawer;
                    the field says WHICH one, never whether it is cash. */}
                  {paymentMethod !== "cash" ? null : (
                    <label className="field required-field">
                      <span>{t("traderSettlements.cashAccount")}</span>
                      <select
                        onChange={(event) => setCashAccountId(event.target.value)}
                        value={cashAccountId}
                      >
                        <option value="">{t("traderSettlements.selectCashAccount")}</option>
                        {cashAccounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.name}
                          </option>
                        ))}
                      </select>
                      {cashAccountsFailed ? (
                        <small className="form-status-error">
                          {t("traderSettlements.cashAccountsLoadFailed")}
                        </small>
                      ) : null}
                    </label>
                  )}
                  {paymentMethod !== "bank_transfer" ? null : (
                    <>
                      <label className="field required-field">
                        <span>{t("traderSettlements.sourceBankAccount")}</span>
                        <select
                          onChange={(event) => setSourceBankId(event.target.value)}
                          value={sourceBankId}
                        >
                          <option value="">{t("traderSettlements.selectBankAccount")}</option>
                          {companyBanks.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.bankName} — {account.accountName}
                              {account.accountNumberMasked === null
                                ? ""
                                : ` (${account.accountNumberMasked})`}
                            </option>
                          ))}
                        </select>
                        {companyBanks.length === 0 ? (
                          <span className="field-hint">
                            {t("traderSettlements.noActiveBankAccounts")}
                          </span>
                        ) : null}
                      </label>
                      <label className="field required-field">
                        <span>{t("traderSettlements.beneficiaryBankAccount")}</span>
                        <select
                          onChange={(event) => setBeneficiaryBankId(event.target.value)}
                          value={beneficiaryBankId}
                        >
                          <option value="">{t("traderSettlements.selectBankAccount")}</option>
                          {traderBanks.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.bankName} — {account.accountName} (
                              {maskAccountNumber(account.accountNumber)})
                            </option>
                          ))}
                        </select>
                        {traderBanks.length === 0 ? (
                          <span className="field-hint">
                            {t("traderSettlements.noActiveBankAccounts")}
                          </span>
                        ) : null}
                      </label>
                      <label className="field required-field">
                        <span>{t("traderSettlements.bankReference")}</span>
                        <input
                          onChange={(event) => setBankReference(event.target.value)}
                          type="text"
                          value={bankReference}
                        />
                      </label>
                    </>
                  )}
                  <label className="field field-wide">
                    <span>{t("traderSettlements.notes")}</span>
                    <textarea onChange={(event) => setNotes(event.target.value)} value={notes} />
                  </label>
                </div>
              </section>

              {/* Step 4/5 — Oldest-first allocation proposal + manual editing */}
              {amount.trim() === "" ? null : (
                <section className="workspace-step">
                  <h3>{t("traderSettlements.stepAllocation")}</h3>
                  <div className="heading-actions">
                    <button
                      onClick={() => {
                        setOriginatingOrderDefaultActive(false);
                        setAllocations(
                          (proposal?.allocations ?? []).map((line) => ({
                            amount: line.allocatedAmount,
                            orderId: line.orderId,
                          })),
                        );
                        setSelectedOrderRows({});
                        setOverrideConfirmed(false);
                      }}
                      type="button"
                    >
                      {t("traderSettlements.applyOldestFirst")}
                    </button>
                    <button
                      onClick={() => {
                        setOriginatingOrderDefaultActive(false);
                        setSelectedOrderRows((current) => ({
                          ...current,
                          ...Object.fromEntries(eligibleOrders.map((order) => [order.id, order])),
                        }));
                        setAllocations((current) => [
                          ...current,
                          ...eligibleOrders
                            .filter((order) => !current.some((line) => line.orderId === order.id))
                            .map((order) => ({ amount: "0.00", orderId: order.id })),
                        ]);
                        setOverrideConfirmed(false);
                      }}
                      type="button"
                    >
                      {t("traderSettlements.selectAllOrders")}
                    </button>
                    <button
                      onClick={() => {
                        setOriginatingOrderDefaultActive(false);
                        setAllocations([]);
                        setSelectedOrderRows({});
                        setOverrideConfirmed(false);
                      }}
                      type="button"
                    >
                      {t("traderSettlements.clearSelection")}
                    </button>
                  </div>
                  {proposalError === undefined ? null : (
                    <div className="alert alert-error">{proposalError}</div>
                  )}
                  {allocationErrors.length === 0 ? null : (
                    <div className="alert alert-error" role="alert">
                      {[...new Set(allocationErrors)].map((line) => (
                        <p key={line}>{line}</p>
                      ))}
                    </div>
                  )}
                  {!manualOverride ? null : (
                    <label className="alert alert-warning field-checkbox">
                      <input
                        checked={overrideConfirmed}
                        onChange={(event) => setOverrideConfirmed(event.target.checked)}
                        type="checkbox"
                      />
                      <span>
                        {t("traderSettlements.oldestFirstOverrideWarning")}
                        {/* The consequence, stated. The warning explained WHAT
                            the override is but not that nothing proceeds until
                            it is ticked, so a blocked settlement looked like a
                            rejected one -- the button was simply disabled with
                            no reason given. */}
                        {overrideConfirmed ? null : (
                          <strong className="override-required">
                            {t("traderSettlements.oldestFirstOverrideRequired")}
                          </strong>
                        )}
                      </span>
                    </label>
                  )}
                  <div className="table-scroll-x">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">{t("traderSettlements.filterOrderSerialNumber")}</th>
                          <th scope="col">{t("traderSettlements.filterDeliveryDateFrom")}</th>
                          <th scope="col">{t("traderSettlements.columnOutstandingBefore")}</th>
                          <th scope="col">{t("traderSettlements.columnProposedAmount")}</th>
                          <th scope="col">{t("traderSettlements.columnOutstandingAfter")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allocationDisplayLines.map((line) => {
                          const deliveryDate =
                            orderById.get(line.orderId)?.deliveryDate ??
                            selectedOrderRows[line.orderId]?.deliveryDate;
                          const current =
                            allocations.find((row) => row.orderId === line.orderId)?.amount ??
                            line.allocatedAmount;
                          const after = money(
                            safeMoneyValue(line.outstandingBefore) - safeMoneyValue(current),
                          );
                          return (
                            <tr key={line.orderId}>
                              <td className="mono">{line.serialNumber}</td>
                              <td>
                                {deliveryDate === undefined || deliveryDate === null
                                  ? "-"
                                  : deliveryDate.slice(0, 10)}
                              </td>
                              <td>{money(line.outstandingBefore)}</td>
                              <td>
                                <input
                                  inputMode="decimal"
                                  min="0"
                                  onChange={(event) =>
                                    setLineAmount(line.orderId, event.target.value)
                                  }
                                  step="0.01"
                                  type="number"
                                  value={current}
                                />
                              </td>
                              <td>{after}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <dl className="reconciliation-summary">
                    <div className="detail-line">
                      <dt>{t("traderSettlements.allocationPaymentAmount")}</dt>
                      <dd>{money(requestedAmount)}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("traderSettlements.allocationAllocatedAmount")}</dt>
                      <dd>{money(allocatedTotal)}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("traderSettlements.allocationUnallocatedAmount")}</dt>
                      <dd>{unallocated}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("traderSettlements.allocationOrderCount")}</dt>
                      <dd>{activeAllocations.length}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("traderSettlements.allocationRemainingAfter")}</dt>
                      <dd>{money(remainingAfter)}</dd>
                    </div>
                  </dl>
                </section>
              )}

              {/* Step 6/7 — Review + Confirm */}
              {!canProceedToReview ? null : (
                <section className="workspace-step">
                  <h3>{t("traderSettlements.stepReview")}</h3>
                  <dl className="reconciliation-summary">
                    <div className="detail-line">
                      <dt>{t("traderSettlements.filterTrader")}</dt>
                      <dd>{trader.name}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("traderSettlements.paymentAmount")}</dt>
                      <dd>{money(requestedAmount)}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("traderSettlements.paymentDate")}</dt>
                      <dd>{paymentDate}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("traderSettlements.filterPaymentMethod")}</dt>
                      <dd>
                        {t(
                          paymentMethod === "cash"
                            ? "traderSettlements.paymentMethodCash"
                            : "traderSettlements.paymentMethodBankTransfer",
                        )}
                      </dd>
                    </div>
                    {paymentMethod !== "bank_transfer" ? null : (
                      <>
                        <div className="detail-line">
                          <dt>{t("traderSettlements.sourceBankAccount")}</dt>
                          <dd>
                            {companyBanks.find((account) => account.id === sourceBankId)?.bankName}
                          </dd>
                        </div>
                        <div className="detail-line">
                          <dt>{t("traderSettlements.beneficiaryBankAccount")}</dt>
                          <dd>
                            {
                              traderBanks.find((account) => account.id === beneficiaryBankId)
                                ?.bankName
                            }
                          </dd>
                        </div>
                        <div className="detail-line">
                          <dt>{t("traderSettlements.bankReference")}</dt>
                          <dd>{bankReference}</dd>
                        </div>
                      </>
                    )}
                    <div className="detail-line">
                      <dt>{t("traderSettlements.columnOrders")}</dt>
                      <dd>{activeAllocations.length}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("traderSettlements.reviewTotalPaidNow")}</dt>
                      <dd>{money(allocatedTotal)}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("traderSettlements.reviewTotalRemaining")}</dt>
                      <dd>{money(remainingAfter)}</dd>
                    </div>
                  </dl>
                  <div className="modal-actions">
                    <button className="button button-secondary" onClick={onClose} type="button">
                      {t("common.cancel")}
                    </button>
                    <button className="button button-primary" disabled={saving} type="submit">
                      {saving ? t("common.saving") : t("traderSettlements.confirmMoneySent")}
                    </button>
                  </div>
                </section>
              )}
            </>
          )}
        </form>
      )}
    </Modal>
  );
}

function statusKey(status: string): string {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

// ---------------------------------------------------------------------------
// Money Received confirmation
// ---------------------------------------------------------------------------

function MoneyReceivedDialog({
  api,
  onClose,
  onConfirmed,
  settlement,
}: {
  api: ApiClient;
  onClose: () => void;
  onConfirmed: () => void;
  settlement: TraderSettlementListRow;
}) {
  const { t } = useTranslation();
  const [receivedDate, setReceivedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);
  const idempotency = useIdempotencyKey();

  const confirm = async () => {
    setSaving(true);
    setError(undefined);
    const fingerprint = JSON.stringify({
      notes: notes.trim(),
      receivedDate,
      reference: reference.trim(),
    });
    try {
      await api.post(
        `operations/settlements/payments/${settlement.settlementId}/confirm-receipt`,
        {
          notes: notes.trim() === "" ? undefined : notes.trim(),
          receivedDate,
          reference: reference.trim() === "" ? undefined : reference.trim(),
        },
        { "X-Idempotency-Key": idempotency.keyFor(fingerprint) },
      );
      idempotency.reset();
      // Refreshes the list/detail behind this dialog immediately; the dialog
      // itself stays open on a success message until the User dismisses it,
      // rather than vanishing the instant the request resolves.
      onConfirmed();
      setConfirmed(true);
    } catch (submitError) {
      setError(message(submitError, t("traderSettlements.settlementFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("traderSettlements.confirmMoneyReceivedTitle")}
      titleId="money-received-title"
    >
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <dl className="reconciliation-summary">
        <div className="detail-line">
          <dt>{t("traderSettlements.columnSettlementNumber")}</dt>
          <dd>{settlement.settlementNumber}</dd>
        </div>
        <div className="detail-line">
          <dt>{t("traderSettlements.filterTrader")}</dt>
          <dd>{settlement.traderName}</dd>
        </div>
        <div className="detail-line">
          <dt>{t("traderSettlements.paymentAmount")}</dt>
          <dd>{money(settlement.paymentAmount)}</dd>
        </div>
        <div className="detail-line">
          <dt>{t("traderSettlements.paymentDate")}</dt>
          <dd>{settlement.paymentDate}</dd>
        </div>
      </dl>
      {confirmed ? (
        <div className="reconciliation-success" role="status">
          <p>{t("traderSettlements.moneyReceivedConfirmed")}</p>
          <div className="modal-actions">
            <button className="button button-primary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={(event) => void (event.preventDefault(), confirm())}>
          <label className="field">
            <span>{t("traderSettlements.receivedDate")}</span>
            <input
              onChange={(event) => setReceivedDate(event.target.value)}
              type="date"
              value={receivedDate}
            />
          </label>
          <label className="field">
            <span>{t("traderSettlements.receivedReference")}</span>
            <input
              onChange={(event) => setReference(event.target.value)}
              type="text"
              value={reference}
            />
          </label>
          <label className="field">
            <span>{t("traderSettlements.receivedNotes")}</span>
            <textarea onChange={(event) => setNotes(event.target.value)} value={notes} />
          </label>
          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button className="button button-primary" disabled={saving} type="submit">
              {saving ? t("common.saving") : t("traderSettlements.actionConfirmMoneyReceived")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

function ReverseSettlementDialog({
  api,
  onClose,
  onReversed,
  settlement,
}: {
  api: ApiClient;
  onClose: () => void;
  onReversed: () => void;
  settlement: TraderSettlementListRow;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [reversed, setReversed] = useState(false);

  const reverse = async () => {
    if (reason.trim() === "") {
      setError(t("traderSettlements.reverseReasonRequired"));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await api.post(`operations/settlements/payments/${settlement.settlementId}/reverse`, {
        reason: reason.trim(),
      });
      // Refreshes the list/detail behind this dialog immediately; the dialog
      // itself stays open on a success message until the User dismisses it.
      onReversed();
      setReversed(true);
    } catch (submitError) {
      setError(message(submitError, t("traderSettlements.settlementFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("traderSettlements.reverseSettlementTitle")}
      titleId="reverse-settlement-title"
    >
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <dl className="reconciliation-summary">
        <div className="detail-line">
          <dt>{t("traderSettlements.columnSettlementNumber")}</dt>
          <dd>{settlement.settlementNumber}</dd>
        </div>
        <div className="detail-line">
          <dt>{t("traderSettlements.filterTrader")}</dt>
          <dd>{settlement.traderName}</dd>
        </div>
        <div className="detail-line">
          <dt>{t("traderSettlements.paymentAmount")}</dt>
          <dd>{money(settlement.paymentAmount)}</dd>
        </div>
        <div className="detail-line">
          <dt>{t("common.status")}</dt>
          <dd>
            {t(
              settlement.status === "reversed"
                ? "traderSettlements.statusReversed"
                : "traderSettlements.statusConfirmed",
            )}
          </dd>
        </div>
      </dl>
      {reversed ? (
        <div className="reconciliation-success" role="status">
          <p>
            {t("traderSettlements.settlementReversed", { number: settlement.settlementNumber })}
          </p>
          <div className="modal-actions">
            <button className="button button-primary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="field-hint">{t("traderSettlements.reverseWarning")}</p>
          <form onSubmit={(event) => void (event.preventDefault(), reverse())}>
            <label className="field required-field">
              <span>{t("common.reason")}</span>
              <textarea onChange={(event) => setReason(event.target.value)} value={reason} />
            </label>
            <div className="modal-actions">
              <button className="button button-secondary" onClick={onClose} type="button">
                {t("common.cancel")}
              </button>
              <button className="button button-primary" disabled={saving} type="submit">
                {saving ? t("common.saving") : t("traderSettlements.actionReverse")}
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Settlement detail
// ---------------------------------------------------------------------------

export function SettlementDetailDialog({
  api,
  canReverse,
  canViewReport,
  onClose,
  onOpenAccountStatement,
  onReversed,
  reportLanguage,
  settlementId,
}: {
  api: ApiClient;
  canReverse: boolean;
  canViewReport: boolean;
  onClose: () => void;
  onOpenAccountStatement: (traderId: string) => void;
  onReversed: () => void;
  reportLanguage: "ar" | "en";
  settlementId: string;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<TraderSettlementDetail>();
  const [error, setError] = useState<string>();
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [reverseOpen, setReverseOpen] = useState(false);
  const pdf = useReconciliationPdfActions(api);
  const [pdfError, setPdfError] = useState<string>();

  const load = useCallback(() => {
    setError(undefined);
    void api
      .get<TraderSettlementDetail>(`operations/settlements/payments/${settlementId}`)
      .then(setDetail)
      .catch(() => setError(t("traderSettlements.detailLoadFailed")));
  }, [api, settlementId, t]);

  useEffect(() => load(), [load]);

  const openPdf = async (mode: PdfAction) => {
    setPdfError(undefined);
    const requestError = await pdf.run(
      `operations/settlements/payments/${settlementId}/pdf?language=${reportLanguage}`,
      `Trader-Settlement-${detail?.settlementNumber ?? settlementId}.pdf`,
      mode,
    );
    if (requestError !== undefined)
      setPdfError(message(requestError, t("traderSettlements.pdfGenerationFailed")));
  };

  const moneyReceivedConfirmed =
    detail?.moneyReceivedDate !== null && detail?.moneyReceivedDate !== undefined;

  return (
    <Modal
      className="modal-wide"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("traderSettlements.detailTitle")}
      titleId="settlement-detail-title"
    >
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {pdfError === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {pdfError}
        </div>
      )}
      {detail === undefined ? (
        error === undefined ? (
          <div className="loading-row">{t("common.loading")}</div>
        ) : null
      ) : (
        <>
          <dl className="reconciliation-summary">
            <div className="detail-line">
              <dt>{t("traderSettlements.columnSettlementNumber")}</dt>
              <dd>{detail.settlementNumber}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.filterTrader")}</dt>
              <dd>{detail.traderName}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("common.status")}</dt>
              <dd>
                {t(
                  detail.status === "reversed"
                    ? "traderSettlements.statusReversed"
                    : "traderSettlements.statusConfirmed",
                )}
              </dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.paymentDate")}</dt>
              <dd>{detail.paymentDate}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.filterPaymentMethod")}</dt>
              <dd>
                {t(
                  detail.paymentMethod === "cash"
                    ? "traderSettlements.paymentMethodCash"
                    : "traderSettlements.paymentMethodBankTransfer",
                )}
              </dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.columnPaymentReference")}</dt>
              <dd>{detail.paymentReference ?? "-"}</dd>
            </div>
            {detail.sourceBank === null ? null : (
              <div className="detail-line">
                <dt>{t("traderSettlements.sourceBankAccount")}</dt>
                <dd>
                  {detail.sourceBank.bankName} — {detail.sourceBank.accountName}
                </dd>
              </div>
            )}
            {detail.beneficiaryBank === null ? null : (
              <div className="detail-line">
                <dt>{t("traderSettlements.beneficiaryBankAccount")}</dt>
                <dd>
                  {detail.beneficiaryBank.bankName} — {detail.beneficiaryBank.accountName} (
                  {detail.beneficiaryBank.ibanMasked || detail.beneficiaryBank.accountNumberMasked})
                </dd>
              </div>
            )}
            <div className="detail-line">
              <dt>{t("traderSettlements.createdBy")}</dt>
              <dd>{detail.createdBy}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.confirmedBy")}</dt>
              <dd>{detail.confirmedBy}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.moneySentDate")}</dt>
              <dd>{detail.moneySentAt === null ? "-" : detail.moneySentAt.slice(0, 10)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.moneyReceivedDate")}</dt>
              <dd>
                {detail.moneyReceivedDate === null ? "-" : detail.moneyReceivedDate.slice(0, 10)}
              </dd>
            </div>
            {detail.moneyReceivedBy === null ? null : (
              <div className="detail-line">
                <dt>{t("traderSettlements.moneyReceivedBy")}</dt>
                <dd>{detail.moneyReceivedBy}</dd>
              </div>
            )}
            {detail.moneyReceivedReference === null ? null : (
              <div className="detail-line">
                <dt>{t("traderSettlements.moneyReceivedReference")}</dt>
                <dd>{detail.moneyReceivedReference}</dd>
              </div>
            )}
            {detail.moneyReceivedNotes === null ? null : (
              <div className="detail-line">
                <dt>{t("traderSettlements.moneyReceivedNotes")}</dt>
                <dd>{detail.moneyReceivedNotes}</dd>
              </div>
            )}
            {detail.notes === null ? null : (
              <div className="detail-line">
                <dt>{t("traderSettlements.notes")}</dt>
                <dd>{detail.notes}</dd>
              </div>
            )}
            {detail.reversalDate == null ? null : (
              <div className="detail-line">
                <dt>{t("traderSettlements.reversalDate")}</dt>
                <dd>{detail.reversalDate.slice(0, 16).replace("T", " ")}</dd>
              </div>
            )}
            {detail.reversedBy == null ? null : (
              <div className="detail-line">
                <dt>{t("traderSettlements.reversedByUser")}</dt>
                <dd>{detail.reversedBy}</dd>
              </div>
            )}
            {detail.reversalReason === null ? null : (
              <div className="detail-line">
                <dt>{t("traderSettlements.reversalReason")}</dt>
                <dd>{detail.reversalReason}</dd>
              </div>
            )}
            {detail.reversalOfSettlementNumber === null ? null : (
              <div className="detail-line">
                <dt>{t("traderSettlements.reversalOf")}</dt>
                <dd>{detail.reversalOfSettlementNumber}</dd>
              </div>
            )}
            {detail.reversedBySettlementNumber === null ? null : (
              <div className="detail-line">
                <dt>{t("traderSettlements.reversedBy")}</dt>
                <dd>{detail.reversedBySettlementNumber}</dd>
              </div>
            )}
          </dl>

          <div className="table-scroll-x">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("traderSettlements.filterOrderSerialNumber")}</th>
                  <th scope="col">{t("traderSettlements.filterExternalReference")}</th>
                  <th scope="col">{t("traderSettlements.filterDeliveryDateFrom")}</th>
                  <th scope="col">{t("common.name")}</th>
                  <th scope="col">{t("traderSettlements.columnCod")}</th>
                  <th scope="col">{t("traderSettlements.totalServiceFees")}</th>
                  <th scope="col">{t("traderSettlements.totalAdditionalFees")}</th>
                  <th scope="col">{t("traderSettlements.totalVat")}</th>
                  <th scope="col">{t("traderSettlements.columnTotalDeductions")}</th>
                  <th scope="col">{t("traderSettlements.originalTraderPayable")}</th>
                  <th scope="col">{t("traderSettlements.columnPreviouslyPaid")}</th>
                  <th scope="col">{t("traderSettlements.amountPaidNow")}</th>
                  <th scope="col">{t("traderSettlements.columnOutstandingBalance")}</th>
                  <th scope="col">{t("traderSettlements.orderSettlementStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {detail.orders.map((order) => (
                  <tr key={order.serialNumber}>
                    <td className="mono">
                      {/* The Order route takes the Order NUMBER; the Serial
                          Number stays the value the User reads. */}
                      <OperationalReference
                        identifier={order.orderNumber}
                        reference={order.serialNumber}
                        type="order"
                      />
                    </td>
                    <td className="mono">{order.referenceNumber ?? "-"}</td>
                    <td>{order.deliveryDate === null ? "-" : order.deliveryDate.slice(0, 10)}</td>
                    <td>{order.customerName}</td>
                    <td>{money(order.codAmount)}</td>
                    <td>{money(order.serviceFee)}</td>
                    <td>{money(order.additionalFees)}</td>
                    <td>{money(order.vatAmount)}</td>
                    <td>{money(order.totalDeductions)}</td>
                    <td>{money(order.originalTraderPayable)}</td>
                    <td>{money(order.previouslyPaid)}</td>
                    <td>{money(order.amountPaidNow)}</td>
                    <td>{money(order.remainingOutstanding)}</td>
                    <td>
                      {t(`traderSettlements.orderStatus${statusKey(order.orderSettlementStatus)}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="reconciliation-summary">
            <div className="detail-line">
              <dt>{t("traderSettlements.numberOfOrders")}</dt>
              <dd>{detail.summary.orderCount}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.totalCod")}</dt>
              <dd>{money(detail.summary.totalCod)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.totalServiceFees")}</dt>
              <dd>{money(detail.summary.totalServiceFees)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.totalAdditionalFees")}</dt>
              <dd>{money(detail.summary.totalAdditionalFees)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.totalVat")}</dt>
              <dd>{money(detail.summary.totalVat)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.totalDeductions")}</dt>
              <dd>{money(detail.summary.totalDeductions)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.originalTraderPayable")}</dt>
              <dd>{money(detail.summary.totalOriginalTraderPayable)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.columnPreviouslyPaid")}</dt>
              <dd>{money(detail.summary.previouslyPaid)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.amountPaidNow")}</dt>
              <dd>{money(detail.summary.amountPaidNow)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderSettlements.columnRemainingOutstanding")}</dt>
              <dd>{money(detail.summary.remainingOutstanding)}</dd>
            </div>
          </dl>

          {/* Additive Accounting link-through; renders nothing for a User
              without Accounting access. */}
          <AccountingRelatedPanel
            api={api}
            sourceId={settlementId}
            sourceType="trader_settlement"
          />

          <div className="modal-actions">
            <button
              className="button button-secondary"
              onClick={() => onOpenAccountStatement(detail.traderId)}
              type="button"
            >
              {t("traderSettlements.accountStatement")}
            </button>
            {!canViewReport ? null : (
              <>
                <button
                  disabled={pdf.busy !== undefined}
                  onClick={() => void openPdf("preview")}
                  type="button"
                >
                  {pdf.busy === "preview"
                    ? t("common.loading")
                    : t("traderSettlements.actionPreviewStatement")}
                </button>
                <button
                  disabled={pdf.busy !== undefined}
                  onClick={() => void openPdf("print")}
                  type="button"
                >
                  {pdf.busy === "print" ? t("common.loading") : t("traderSettlements.actionPrint")}
                </button>
                <button
                  disabled={pdf.busy !== undefined}
                  onClick={() => void openPdf("download")}
                  type="button"
                >
                  {pdf.busy === "download"
                    ? t("common.loading")
                    : t("traderSettlements.actionDownloadPdf")}
                </button>
              </>
            )}
            {detail.status === "reversed" || moneyReceivedConfirmed ? null : (
              <button onClick={() => setReceiptOpen(true)} type="button">
                {t("traderSettlements.actionConfirmMoneyReceived")}
              </button>
            )}
            {!canReverse || detail.status === "reversed" || moneyReceivedConfirmed ? null : (
              <button onClick={() => setReverseOpen(true)} type="button">
                {t("traderSettlements.actionReverse")}
              </button>
            )}
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </>
      )}

      {!receiptOpen || detail === undefined ? null : (
        <MoneyReceivedDialog
          api={api}
          onClose={() => setReceiptOpen(false)}
          onConfirmed={() => {
            setReceiptOpen(false);
            load();
          }}
          settlement={{
            confirmedBy: detail.confirmedBy,
            createdBy: detail.createdBy,
            isReversed: detail.status === "reversed",
            moneyReceivedAt: detail.moneyReceivedDate,
            moneyReceivedConfirmed,
            moneySentAt: detail.moneySentAt,
            orderCount: detail.summary.orderCount,
            paymentAmount: detail.summary.amountPaidNow,
            paymentDate: detail.paymentDate,
            paymentMethod: detail.paymentMethod,
            paymentReference: detail.paymentReference,
            previouslyPaid: detail.summary.previouslyPaid,
            remainingOutstanding: detail.summary.remainingOutstanding,
            settlementId: detail.settlementId,
            settlementNumber: detail.settlementNumber,
            status: detail.status,
            traderName: detail.traderName,
          }}
        />
      )}

      {!reverseOpen || detail === undefined ? null : (
        <ReverseSettlementDialog
          api={api}
          onClose={() => setReverseOpen(false)}
          onReversed={() => {
            setReverseOpen(false);
            onReversed();
          }}
          settlement={{
            confirmedBy: detail.confirmedBy,
            createdBy: detail.createdBy,
            isReversed: detail.status === "reversed",
            moneyReceivedAt: detail.moneyReceivedDate,
            moneyReceivedConfirmed,
            moneySentAt: detail.moneySentAt,
            orderCount: detail.summary.orderCount,
            paymentAmount: detail.summary.amountPaidNow,
            paymentDate: detail.paymentDate,
            paymentMethod: detail.paymentMethod,
            paymentReference: detail.paymentReference,
            previouslyPaid: detail.summary.previouslyPaid,
            remainingOutstanding: detail.summary.remainingOutstanding,
            settlementId: detail.settlementId,
            settlementNumber: detail.settlementNumber,
            status: detail.status,
            traderName: detail.traderName,
          }}
        />
      )}
    </Modal>
  );
}
