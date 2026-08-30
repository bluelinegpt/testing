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
import type { PagedResponse, ReconciliationPageSize } from "../../api/contracts.js";
import { Modal } from "../../components/Modal.js";
import { useRouteDetail } from "../../app/use-route-detail.js";
import { OperationalReference, partyDisplayLabel } from "./OperationalReference.js";
import { AccountingRelatedPanel } from "../accounting/AccountingRelatedPanel.js";
import { PageHeader } from "../../components/PageHeader.js";
import { AreaSelector } from "../configuration/AreaSelector.js";

import { DriverCashStatusLabel } from "./DriverCashStatus.js";
import { type PdfAction, useReconciliationPdfActions } from "./reconciliation-pdf.js";
import { useWorkflowDeepLink, type WorkflowDialog } from "./use-workflow-deep-link.js";
import { materialFingerprint, useIdempotencyKey } from "./useIdempotencyKey.js";

// ---- Server response shapes (mirrors the Checkpoint 2 backend contracts). ----

interface CollectionsSummary {
  readonly actualAmountReceived: string;
  readonly cashTotal: string;
  readonly collectionsWithDifferenceCount: number;
  readonly driverExpenses: string;
  readonly netExpectedFromDrivers: string;
  readonly outstandingFromDrivers: string;
  readonly pendingAmountToCollect: string;
  readonly pendingOrderCount: number;
  readonly reconciledCollectionsCount: number;
  readonly visaTotal: string;
}

interface CollectionRow {
  /** The reconciliation's own date-only field. NOT the Company Business Date. */
  readonly businessDate: string;
  /** Company Business Date from the backend, derived from confirmedAt. */
  readonly confirmationBusinessDate?: string | null;
  readonly collectionPaymentMethod: "cash" | "visa" | null;
  readonly confirmedAt: string | null;
  readonly confirmedBy: string;
  readonly driverName: string;
  readonly driverType: string;
  readonly expenseTotal: string;
  readonly grossCollections: string;
  readonly id: string;
  readonly isReversed: boolean;
  readonly linkedDriverFeePaymentNumber: string | null;
  readonly netAmountReceived: string;
  readonly orderCount: number;
  readonly paymentTotal: string;
  readonly reconciliationNumber: string;
  readonly status: string;
  readonly statusLabel: string;
}

interface ReportDataOrder {
  readonly additionalFees: string;
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerAmountToCollect: string;
  readonly customerName: string;
  readonly deliveryDate: string | null;
  readonly driverReconciliationStatus: string;
  readonly driverReconciliationStatusLabel: string;
  readonly emirateName: string | null;
  readonly orderNumber: string;
  readonly paymentMethod: "cash" | "visa" | null;
  readonly referenceNumber: string | null;
  readonly serialNumber: string;
  readonly serviceFee: string;
  readonly totalDeductions: string;
  readonly traderCode: string | null;
  readonly traderName: string;
  readonly traderPayable: string;
  readonly vatAmount: string;
}

interface ReportData {
  readonly expenses: readonly {
    readonly amount: string;
    readonly description: string | null;
    readonly enteredBy: string;
    readonly expenseType: string;
    readonly reason: string | null;
    readonly recordedAt: string;
    readonly reference: string | null;
  }[];
  readonly header: {
    readonly businessDate: string;
    readonly collectionPaymentMethod: "cash" | "visa" | null;
    readonly confirmedAt: string | null;
    readonly confirmedBy: string;
    readonly createdAt: string;
    readonly createdBy: string;
    readonly driverCode: string | null;
    readonly driverName: string;
    readonly driverNameAr: string | null;
    readonly driverType: string;
    readonly isReversal: boolean;
    readonly linkedDriverFeePaymentId: string | null;
    readonly linkedDriverFeePaymentNumber: string | null;
    readonly linkedDriverFeePaymentStatus: "confirmed" | "reversed" | null;
    readonly notes: string | null;
    readonly reconciliationNumber: string;
    readonly reversedByReconciliationNumber: string | null;
    readonly reversesReconciliationNumber: string | null;
    readonly status: string;
    readonly statusLabel: string;
  };
  readonly orders: readonly ReportDataOrder[];
  readonly summary: {
    readonly actualReceived: string;
    readonly cashTotal: string;
    readonly difference: string;
    readonly driverFeeOffset: string;
    readonly driverExpenses: string;
    readonly grossCollections: string;
    readonly netExpected: string;
    readonly orderCount: number;
    readonly visaTotal: string;
  };
}

interface EligibleOrderRow {
  readonly amountCollected: string;
  readonly areaName: string;
  readonly cashStatus: string;
  readonly cashStatusLabel: string;
  readonly customerName: string;
  readonly deliveredAt: string | null;
  readonly id: string;
  readonly orderNumber: string;
  readonly referenceNumber: string | null;
  readonly serialNumber: string;
  readonly traderName: string;
}

interface ExpenseTypeOption {
  readonly code: string;
  readonly id: string;
  readonly name: string;
  readonly requiresDescription: boolean;
}

interface DriverOption {
  readonly driverType: string;
  readonly id: string;
  readonly name: string;
  readonly pendingCollectionTotal: string;
  readonly pendingOrderCount: number;
}

interface PreviewResult {
  readonly difference: string;
  readonly driverId: string;
  readonly driverFeeAllocations: readonly {
    readonly accrualId: string;
    readonly amount: string;
    readonly orderNumber: string;
    readonly outstandingBefore: string;
    readonly remainingOutstanding: string;
  }[];
  readonly driverPayableDeduction: string;
  readonly eligibleDriverFeeAccrualCount: number;
  readonly expenseTotal: string;
  readonly grossCollections: string;
  readonly netAmountExpected: string;
  readonly oldestFirstDriverFeeProposal: readonly {
    readonly accrualId: string;
    readonly amount: string;
    readonly orderNumber: string;
    readonly outstandingBefore: string;
    readonly remainingOutstanding: string;
  }[];
  readonly orderCount: number;
  readonly remainingDriverFeeOutstanding: string;
  readonly requestedDriverFeeOffset: string;
  readonly safeMaximumDriverFeeOffset: string;
  readonly totalOutstandingDriverFees: string;
  readonly warnings: readonly string[];
}

/** Stable identity: an inline array would re-run the consuming effect. */
const collectionDialogs: readonly WorkflowDialog[] = ["collect_money"];

const emptyFilters = {
  ...businessDateFilterDefaults,
  areaId: "",
  collectionPaymentMethod: "",
  customerName: "",
  deliveredFrom: "",
  deliveredTo: "",
  dateFrom: "",
  dateTo: "",
  driverId: "",
  driverFeeStatus: "",
  driverType: "",
  emirateId: "",
  orderSerialNumber: "",
  orderStatus: "",
  reconciliationStatus: "",
  referenceNumber: "",
  traderId: "",
};

type Filters = typeof emptyFilters;

/**
 * Filter names this screen puts in the URL. Module-level and frozen on purpose:
 * `useListState` memoizes on this array, so a fresh literal built during render
 * would produce new state every render and re-fire the request effect forever.
 */
const filterKeys = Object.keys(emptyFilters);

/** Sort keys the Driver Collections endpoint actually accepts. */
const sortKeys = new Set(["businessDate", "reconciliationNumber", "netAmountReceived"]);

function money(value: string | number | undefined): string {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return "0.00";
  return (Math.round(numeric * 100) / 100).toFixed(2);
}

function message(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.details === undefined || error.details.length === 0
      ? error.message
      : `${error.message}\n${error.details.join("\n")}`;
  }
  return error instanceof Error ? error.message : fallback;
}

function filterQuery(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value.trim() !== "") params.set(key, value.trim());
  }
  return params;
}

/**
 * Driver Collections operational workspace (Phase 4 §1–§11).
 *
 * Replaces the former Drivers screen at the same `/drivers` route so existing
 * bookmarks keep working; Driver master-data administration remains a
 * separate, untouched screen at `/configuration/drivers`.
 */
export function DriverCollectionsWorkspace({
  api,
  detailId: routeDetailId,
}: {
  api: ApiClient;
  /** Collection opened by `/drivers/collections/:id`. */
  detailId?: string | undefined;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.language);
  const [summary, setSummary] = useState<CollectionsSummary>();
  // The URL is the authoritative list state. No parallel local or session copy
  // of these fields exists to drift out of step with it.
  const session = useSessionAccess();
  const list = useListState({
    companyId: session?.companyId,
    defaultSortBy: "businessDate",
    filterKeys,
  });
  const { page } = list;
  const pageSize = list.pageSize as ReconciliationPageSize;
  const setPage = list.setPage;
  // `useListState` omits empty filters entirely; the panel and `filterQuery`
  // both expect every key present, so the defaults are merged back in.
  const filters = useMemo<Filters>(() => ({ ...emptyFilters, ...list.filters }), [list.filters]);
  const [collectionsPage, setCollectionsPage] = useState<PagedResponse<CollectionRow>>();
  const [listError, setListError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  /* A smart next action from the Orders list can ask this screen to open New
     Collection with the Driver and originating Order already carried in. The
     shared primitive reads it once and strips `openDialog`, so a refresh after
     completing the collection cannot reopen the dialog. Nothing is written by
     opening it. */
  const collectDeepLink = useWorkflowDeepLink(collectionDialogs);
  const returnToOrigin = () => {
    if (collectDeepLink.returnTo === null) return false;
    session?.navigate(collectDeepLink.returnTo);
    return session !== undefined;
  };
  const [deepLinkDriverId, setDeepLinkDriverId] = useState<string>();
  const [deepLinkOrderIds, setDeepLinkOrderIds] = useState<readonly string[]>();
  const [collectNotice, setCollectNotice] = useState<string>();

  useEffect(() => {
    const link = collectDeepLink.link;
    if (link === null || link.dialog !== "collect_money") return;
    // Nothing to preselect: a New Collection with no Driver reads as lost
    // context rather than as absent context.
    if (link.driverId === null) return;
    setDeepLinkDriverId(link.driverId);
    // A row action carries `orderId` alone; a bulk action carries `orderIds`
    // (possibly several). Either, both or neither may be present.
    const orderIds = [...(link.orderId === null ? [] : [link.orderId]), ...link.orderIds];
    if (orderIds.length > 0) setDeepLinkOrderIds(orderIds);
    setCreateOpen(true);
  }, [collectDeepLink]);
  const {
    close: closeDetail,
    detailId,
    open: openDetail,
  } = useRouteDetail("driver_collection", routeDetailId);
  const [reverseTarget, setReverseTarget] = useState<CollectionRow>();
  const [outstandingOpen, setOutstandingOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState<{ id: string; mode: "download" | "preview" }>();
  const [pdfError, setPdfError] = useState<string>();

  // Legacy `?reconciliationId=` links now redirect once to the canonical
  // `/drivers/collections/:id` route, which drops the query string — so this
  // cannot loop even though `openDetail` navigates.
  useEffect(() => {
    const linkedId = new URLSearchParams(window.location.search).get("reconciliationId");
    if (linkedId !== null && /^[0-9a-f-]{36}$/i.test(linkedId)) openDetail(linkedId);
  }, [openDetail]);

  // One write, not one per key: switching Date Mode changes several filters
  // together, and separate writes would each start from stale state. The hook
  // resets the page to 1 itself.
  const applyFilter = (change: Partial<Filters>) => {
    list.setFilters(change as Record<string, string>);
  };
  const clearFilters = () => list.clearFilters();

  const refresh = useCallback(() => {
    setListError(undefined);
    void api
      .get<CollectionsSummary>(`operations/cash/reconciliations/summary?${filterQuery(filters)}`)
      .then(setSummary)
      .catch(() => setListError(t("operations.detailLoadFailed")));
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
      .get<PagedResponse<CollectionRow>>(`operations/cash/reconciliations?${params.toString()}`)
      .then(setCollectionsPage)
      .catch(() => setListError(t("operations.detailLoadFailed")));
  }, [api, filters, list.sortBy, list.sortDirection, page, pageSize, t]);

  useEffect(() => refresh(), [refresh]);

  const rows = collectionsPage?.items ?? [];
  const total = collectionsPage?.total ?? 0;
  const pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);

  // Quick row-level Preview/Download actions follow the active interface.
  // The Detail view still offers an explicit language picker.
  const openRowPdf = async (row: CollectionRow, mode: "download" | "preview") => {
    setPdfBusy({ id: row.id, mode });
    setPdfError(undefined);
    const language = locale;
    try {
      const blob = await api.getBinary(
        `operations/cash/reconciliations/${row.id}/pdf?language=${language}`,
      );
      const url = URL.createObjectURL(blob);
      if (mode === "download") {
        const link = document.createElement("a");
        link.href = url;
        link.download = `Driver-Collection-${row.reconciliationNumber}.pdf`;
        link.click();
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      setPdfError(message(error, t("operations.pdfGenerationFailed")));
    } finally {
      setPdfBusy(undefined);
    }
  };

  return (
    <>
      <PageHeader
        actions={
          <>
            <button
              className="button button-primary"
              onClick={() => setCreateOpen(true)}
              type="button"
            >
              {t("operations.newCollection")}
            </button>
            <button className="button button-secondary" onClick={refresh} type="button">
              {t("common.refresh")}
            </button>
          </>
        }
        eyebrow={t("nav.driversList")}
        title={t("nav.driversList")}
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

      {summary === undefined ? null : (
        <SummaryCards onOutstandingClick={() => setOutstandingOpen(true)} summary={summary} />
      )}

      <FilterBar api={api} filters={filters} onChange={applyFilter} onClear={clearFilters} />
      {/* Date Mode sits beside the list rather than inside the filter bar:
          the summary it renders describes the response, so it belongs where
          the response is. All three screens share this one component. */}
      <BusinessDateFilterControls
        applied={collectionsPage?.appliedDateMode}
        businessDateFrom={filters.businessDateFrom}
        businessDateTo={filters.businessDateTo}
        dateMode={filters.dateMode}
        onChange={(patch) => applyFilter(patch)}
      />

      <section aria-labelledby="collections-list-heading">
        <h2 id="collections-list-heading">{t("operations.recentReconciliations")}</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">{t("operations.reconciliationNumber")}</th>
              <th scope="col">{t("operations.driver")}</th>
              <th scope="col">{t("operations.paymentMethod")}</th>
              <th scope="col">{t("operations.collectionDateColumn")}</th>
              {/* Company Business Date. Distinct from the reconciliation's own
                  date-only businessDate rendered in the column before it. */}
              <th scope="col">{t("configuration.businessDay.businessDate")}</th>
              <th scope="col">{t("operations.orders")}</th>
              <th scope="col">{t("operations.selectedCollections")}</th>
              <th scope="col">{t("operations.expenses")}</th>
              <th scope="col">{t("operations.netExpected")}</th>
              <th scope="col">{t("operations.actualReceived")}</th>
              <th scope="col">{t("operations.difference")}</th>
              <th scope="col">{t("operations.status")}</th>
              <th scope="col">
                <span className="sr-only">{t("common.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="mono">
                  <button className="link-button" onClick={() => openDetail(row.id)} type="button">
                    {row.reconciliationNumber}
                  </button>
                </td>
                <td>{row.driverName}</td>
                <td>
                  {row.collectionPaymentMethod === null
                    ? t("operations.paymentMethodNotAssigned")
                    : t(
                        `operations.paymentMethod${row.collectionPaymentMethod === "cash" ? "Cash" : "Visa"}`,
                      )}
                </td>
                <td>{row.businessDate}</td>
                <td dir="ltr">
                  {row.confirmationBusinessDate == null
                    ? t("configuration.businessDay.historicalTimestampUnavailable")
                    : formatDate(row.confirmationBusinessDate, locale)}
                </td>
                <td>{row.orderCount}</td>
                <td>{money(row.grossCollections)}</td>
                <td>{money(row.expenseTotal)}</td>
                <td>{money(row.netAmountReceived)}</td>
                <td>{money(row.paymentTotal)}</td>
                <td>{money(Number(row.paymentTotal) - Number(row.netAmountReceived))}</td>
                <td>
                  {row.statusLabel}
                  {row.isReversed ? (
                    <span className="badge badge-warning">{t("operations.reversedIndicator")}</span>
                  ) : null}
                </td>
                <td className="row-actions">
                  <button onClick={() => openDetail(row.id)} type="button">
                    {t("common.view")}
                  </button>
                  <button
                    disabled={pdfBusy?.id === row.id}
                    onClick={() => void openRowPdf(row, "preview")}
                    type="button"
                  >
                    {pdfBusy?.id === row.id && pdfBusy.mode === "preview"
                      ? t("common.loading")
                      : t("operations.previewReport")}
                  </button>
                  <button
                    disabled={pdfBusy?.id === row.id}
                    onClick={() => void openRowPdf(row, "download")}
                    type="button"
                  >
                    {pdfBusy?.id === row.id && pdfBusy.mode === "download"
                      ? t("common.loading")
                      : t("operations.downloadPdf")}
                  </button>
                  {row.isReversed || row.status !== "confirmed" ? null : (
                    <button onClick={() => setReverseTarget(row)} type="button">
                      {t("operations.reverseCollection")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className="empty-state" colSpan={12}>
                  {t("operations.noReconciliations")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
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

      {collectNotice === undefined ? null : (
        <div className="alert alert-info" role="status">
          {collectNotice}
        </div>
      )}
      {createOpen ? (
        <CreateDriverCollectionDialog
          api={api}
          {...(deepLinkDriverId === undefined ? {} : { initialDriverId: deepLinkDriverId })}
          {...(deepLinkOrderIds === undefined ? {} : { initialOrderIds: deepLinkOrderIds })}
          onClose={() => {
            setCreateOpen(false);
            setCollectNotice(undefined);
            returnToOrigin();
          }}
          onOrdersSkipped={(count) =>
            setCollectNotice(t("operations.collectSkippedOrders", { count }))
          }
          onCreated={() => {
            setCreateOpen(false);
            if (returnToOrigin()) return;
            refresh();
          }}
        />
      ) : null}

      {detailId === undefined ? null : (
        <DriverCollectionDetailDialog
          api={api}
          onClose={() => closeDetail()}
          onReversed={() => {
            closeDetail();
            refresh();
          }}
          reconciliationId={detailId}
        />
      )}

      {reverseTarget === undefined ? null : (
        <ReverseCollectionDialog
          api={api}
          collection={reverseTarget}
          onClose={() => setReverseTarget(undefined)}
          onReversed={() => {
            setReverseTarget(undefined);
            refresh();
          }}
        />
      )}

      {!outstandingOpen ? null : (
        <OutstandingByDriverDialog api={api} onClose={() => setOutstandingOpen(false)} />
      )}
    </>
  );
}

function SummaryCards({
  onOutstandingClick,
  summary,
}: {
  onOutstandingClick: () => void;
  summary: CollectionsSummary;
}) {
  const { t } = useTranslation();
  // The six figures an operator needs at a glance (§3) — not a ten-card wall.
  const primaryCards: readonly { label: string; value: string }[] = [
    { label: t("operations.summaryPendingAmount"), value: money(summary.pendingAmountToCollect) },
    { label: t("operations.summaryCashTotal"), value: money(summary.cashTotal) },
    { label: t("operations.summaryVisaTotal"), value: money(summary.visaTotal) },
    { label: t("operations.summaryDriverExpenses"), value: money(summary.driverExpenses) },
    { label: t("operations.summaryNetExpected"), value: money(summary.netExpectedFromDrivers) },
  ];
  const secondaryCards: readonly { label: string; value: string }[] = [
    { label: t("operations.summaryPendingOrders"), value: String(summary.pendingOrderCount) },
    {
      label: t("operations.summaryReconciledCount"),
      value: String(summary.reconciledCollectionsCount),
    },
    {
      label: t("operations.summaryWithDifference"),
      value: String(summary.collectionsWithDifferenceCount),
    },
  ];
  return (
    <>
      <div className="summary-primary" data-testid="collections-summary">
        {primaryCards.map((card) => (
          <article className="kpi-card" key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </article>
        ))}
        {/* Outstanding from Drivers drills down to a per-Driver breakdown: the
            reconciliation list only ever holds completed (confirmed/reversed)
            events, so it cannot itself represent a pending-Orders balance. */}
        <button
          aria-label={`${t("operations.summaryOutstanding")}: ${money(summary.outstandingFromDrivers)}`}
          className="kpi-card kpi-button"
          onClick={onOutstandingClick}
          type="button"
        >
          <span>{t("operations.summaryOutstanding")}</span>
          <strong>{money(summary.outstandingFromDrivers)}</strong>
        </button>
      </div>
      <div className="summary-secondary" data-testid="collections-summary-secondary">
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

// ---------------------------------------------------------------------------
// Outstanding from Drivers drill-down (§ Outstanding Only correction): the
// reconciliation list only ever holds completed (confirmed/reversed) events,
// so "outstanding" cannot be a row-level filter on it. The authoritative
// figure is per-Driver: Customer Amount to Collect for every delivered Order
// still at driver_reconciliation_status = 'pending' — which already reflects
// Orders restored to pending by a valid reversal, since `reverse()` resets
// that same column. There is no partial-reconciliation state in this schema
// (`confirm()` requires the full Net Expected to be received at once), so
// there is nothing further to include. This reuses the exact same per-Driver
// pending totals already served to the Driver picker (operations/cash/drivers).
// ---------------------------------------------------------------------------

function OutstandingByDriverDialog({ api, onClose }: { api: ApiClient; onClose: () => void }) {
  const { t } = useTranslation();
  const [drivers, setDrivers] = useState<readonly DriverOption[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api
      .get<PagedResponse<DriverOption>>("operations/cash/drivers?pageSize=100")
      .then((page) => setDrivers(page.items))
      .catch(() => setError(t("operations.detailLoadFailed")));
  }, [api, t]);

  const outstanding = (drivers ?? [])
    .filter((driver) => driver.pendingOrderCount > 0)
    .sort(
      (left, right) => Number(right.pendingCollectionTotal) - Number(left.pendingCollectionTotal),
    );

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.summaryOutstanding")}
      titleId="outstanding-by-driver-title"
    >
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {drivers === undefined ? (
        error === undefined ? (
          <div className="loading-row">{t("common.loading")}</div>
        ) : null
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{t("operations.driver")}</th>
              <th scope="col">{t("operations.summaryPendingOrders")}</th>
              <th scope="col">{t("operations.outstandingAmount")}</th>
            </tr>
          </thead>
          <tbody>
            {outstanding.map((driver) => (
              <tr key={driver.id}>
                <td>
                  {driver.name} — {t(`statuses.${driver.driverType}`)}
                </td>
                <td>{driver.pendingOrderCount}</td>
                <td>{money(driver.pendingCollectionTotal)}</td>
              </tr>
            ))}
            {outstanding.length === 0 ? (
              <tr>
                <td className="empty-state" colSpan={3}>
                  {t("operations.noOutstandingDrivers")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
      <div className="modal-actions">
        <button className="button button-primary" onClick={onClose} type="button">
          {t("common.close")}
        </button>
      </div>
    </Modal>
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
  const [drivers, setDrivers] = useState<readonly DriverOption[]>([]);
  const [traders, setTraders] = useState<readonly { id: string; name: string }[]>([]);
  useEffect(() => {
    void api
      .get<PagedResponse<DriverOption>>("operations/cash/drivers?pageSize=100")
      .then((page) => setDrivers(page.items))
      .catch(() => setDrivers([]));
    void api
      .get<{ items: readonly { id: string; nameEn: string }[] }>(
        "operations/traders/search?limit=100&offset=0",
      )
      .then((page) => setTraders(page.items.map((item) => ({ id: item.id, name: item.nameEn }))))
      .catch(() => setTraders([]));
  }, [api]);

  return (
    <section aria-label={t("operations.collectionFilters")}>
      <div className="compact-filters">
        <label className="field">
          <span>{t("operations.driver")}</span>
          <select
            onChange={(event) => onChange({ driverId: event.target.value })}
            value={filters.driverId}
          >
            <option value="">{t("operations.all")}</option>
            {drivers.map((driver) => (
              <option key={driver.id} value={driver.id}>
                {driver.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("operations.paymentMethod")}</span>
          <select
            onChange={(event) => onChange({ collectionPaymentMethod: event.target.value })}
            value={filters.collectionPaymentMethod}
          >
            <option value="">{t("operations.all")}</option>
            <option value="cash">{t("operations.paymentMethodCash")}</option>
            <option value="visa">{t("operations.paymentMethodVisa")}</option>
            <option value="not_assigned">{t("operations.paymentMethodNotAssigned")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("operations.reconciliationStatus")}</span>
          <select
            onChange={(event) => onChange({ reconciliationStatus: event.target.value })}
            value={filters.reconciliationStatus}
          >
            <option value="all">{t("operations.all")}</option>
            <option value="pending">{t("operations.reconciliationStatusPending")}</option>
            <option value="reconciled">{t("operations.reconciliationStatusReconciled")}</option>
            <option value="reversed">{t("operations.reconciliationStatusReversed")}</option>
          </select>
        </label>
        {/* Outsourced Driver Fee payment state. Employee drivers accrue no
            fee, so selecting Paid or Unpaid excludes their Collections. */}
        <label className="field">
          <span>{t("operations.driverFeeStatus")}</span>
          <select
            onChange={(event) => onChange({ driverFeeStatus: event.target.value })}
            value={filters.driverFeeStatus}
          >
            <option value="all">{t("operations.all")}</option>
            <option value="paid">{t("operations.driverFeeStatusPaid")}</option>
            <option value="unpaid">{t("operations.driverFeeStatusUnpaid")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("operations.collectionDateFrom")}</span>
          <input
            onChange={(event) => onChange({ dateFrom: event.target.value })}
            type="date"
            value={filters.dateFrom}
          />
        </label>
        <label className="field">
          <span>{t("operations.collectionDateTo")}</span>
          <input
            onChange={(event) => onChange({ dateTo: event.target.value })}
            type="date"
            value={filters.dateTo}
          />
        </label>
        <label className="field">
          <span>{t("operations.orderSerialNumber")}</span>
          <input
            onChange={(event) => onChange({ orderSerialNumber: event.target.value })}
            type="search"
            value={filters.orderSerialNumber}
          />
        </label>
        <label className="field">
          <span>{t("operations.externalReferenceNumber")}</span>
          <input
            onChange={(event) => onChange({ referenceNumber: event.target.value })}
            type="search"
            value={filters.referenceNumber}
          />
        </label>
        <label className="field">
          <span>{t("operations.trader")}</span>
          <select
            onChange={(event) => onChange({ traderId: event.target.value })}
            value={filters.traderId}
          >
            <option value="">{t("operations.all")}</option>
            {traders.map((trader) => (
              <option key={trader.id} value={trader.id}>
                {trader.name}
              </option>
            ))}
          </select>
        </label>
        <div className="filter-actions">
          <button className="button button-secondary" onClick={onClear} type="button">
            {t("operations.clearFilters")}
          </button>
        </div>
      </div>

      <details className="filter-drawer">
        <summary>{t("operations.moreFilters")}</summary>
        <div className="compact-filters">
          <label className="field">
            <span>{t("operations.driverType")}</span>
            <select
              onChange={(event) => onChange({ driverType: event.target.value })}
              value={filters.driverType}
            >
              <option value="">{t("operations.all")}</option>
              <option value="employee">{t("statuses.employee")}</option>
              <option value="outsourced">{t("statuses.outsourced")}</option>
            </select>
          </label>
          <label className="field">
            <span>{t("operations.customer")}</span>
            <input
              onChange={(event) => onChange({ customerName: event.target.value })}
              type="search"
              value={filters.customerName}
            />
          </label>
          <div className="field" data-field="area">
            <span>{t("areas.emirate")}</span>
            <AreaSelector
              allowCreate={false}
              api={api}
              onChange={(area) =>
                onChange({ areaId: area?.id ?? "", emirateId: area?.emirateId ?? "" })
              }
              value={undefined}
            />
          </div>
          <label className="field">
            <span>{t("operations.deliveryDateFrom")}</span>
            <input
              onChange={(event) => onChange({ deliveredFrom: event.target.value })}
              type="date"
              value={filters.deliveredFrom}
            />
          </label>
          <label className="field">
            <span>{t("operations.deliveryDateTo")}</span>
            <input
              onChange={(event) => onChange({ deliveredTo: event.target.value })}
              type="date"
              value={filters.deliveredTo}
            />
          </label>
          <label className="field">
            <span>{t("operations.collectionOrderStatus")}</span>
            <select
              onChange={(event) => onChange({ orderStatus: event.target.value })}
              value={filters.orderStatus}
            >
              <option value="">{t("operations.all")}</option>
              {[
                "new",
                "assigned_to_driver",
                "out_for_delivery",
                "delivered",
                "returned_to_branch",
                "returned_to_trader",
                "cancelled",
                "closed",
              ].map((status) => (
                <option key={status} value={status}>
                  {t(`statuses.${status}`, status)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Create Driver Collection dialog (§2/§6/§7/§8/§9): the workflow order is
// fixed — Driver, then Payment Method, then eligible Orders, then Expenses,
// then Totals, then Confirmation. Payment Method must stay before Expenses.
// ---------------------------------------------------------------------------

function CreateDriverCollectionDialog({
  api,
  onClose,
  onCreated,
  initialDriverId,
  initialOrderIds,
  onOrdersSkipped,
}: {
  api: ApiClient;
  /** Driver from a smart next action or Orders bulk action, preselected once
   *  the list resolves it. */
  initialDriverId?: string | undefined;
  /** Originating Order(s) -- from a single row action or a bulk selection on
   *  the Orders list -- checked once they appear among the eligible Orders. */
  initialOrderIds?: readonly string[] | undefined;
  onClose: () => void;
  onCreated: () => void;
  /** Called with the count of originating Orders that are NOT in the eligible
   *  list (already collected by someone else, reassigned, etc. since the
   *  operator selected them) -- never blocks the remaining eligible ones. */
  onOrdersSkipped?: ((count: number) => void) | undefined;
}) {
  const { i18n, t } = useTranslation();

  // Step 1 — Driver.
  const [driverSearch, setDriverSearch] = useState("");
  const [drivers, setDrivers] = useState<readonly DriverOption[]>([]);
  const [driver, setDriver] = useState<DriverOption>();

  // Step 2 — Payment Method (Cash/Visa), immediately after Driver.
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "visa">("cash");
  const [bankAccounts, setBankAccounts] = useState<readonly { id: string; name: string }[]>([]);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState("");
  const [bankReference, setBankReference] = useState("");

  // Step 3 — Eligible Orders.
  const [ordersPage, setOrdersPage] = useState<PagedResponse<EligibleOrderRow>>();
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  /* Applied once. Without this the effect would re-check the Order every time
     the eligible list refreshes, silently undoing a user who unchecked it. */
  const originatingApplied = useRef(false);

  /* The Driver is taken from the list this dialog already loads, not from the
     URL: a Driver outside this Company is simply not in it, so the id can
     never select something the user may not see. */
  useEffect(() => {
    if (initialDriverId === undefined || driver !== undefined) return;
    const match = drivers.find((candidate) => candidate.id === initialDriverId);
    if (match !== undefined) setDriver(match);
  }, [driver, drivers, initialDriverId]);

  /* Each originating Order is checked only when the backend actually
     returned it as eligible -- never trusting the caller's selection as
     authoritative (§4). One already collected, reversed or reassigned since
     the operator selected it simply is not in `ordersPage`; it is reported
     via `onOrdersSkipped`, and every OTHER originating Order that IS eligible
     is still preselected -- a stale Order never blocks the rest. */
  useEffect(() => {
    if (initialOrderIds === undefined || initialOrderIds.length === 0) return;
    if (originatingApplied.current) return;
    if (ordersPage === undefined) return;
    originatingApplied.current = true;
    const eligibleIds = initialOrderIds.filter((id) =>
      ordersPage.items.some((row) => row.id === id),
    );
    const skippedCount = initialOrderIds.length - eligibleIds.length;
    if (skippedCount > 0) onOrdersSkipped?.(skippedCount);
    if (eligibleIds.length > 0) {
      setSelectedIds((current) => new Set([...current, ...eligibleIds]));
    }
  }, [initialOrderIds, onOrdersSkipped, ordersPage]);
  const [ordersError, setOrdersError] = useState<string>();

  // Step 4 — Driver Expenses.
  const [expenseTypes, setExpenseTypes] = useState<readonly ExpenseTypeOption[]>([]);
  const [expenses, setExpenses] = useState<
    readonly { amount: string; expenseTypeId: string; reason: string }[]
  >([]);

  // Step 5/6 — Totals and Confirmation. Actual Amount Received is never pre-filled
  // from Net Expected: the operator must enter what the Driver actually handed
  // over, so the Difference correctly reads negative until they do (§8).
  const [actualReceived, setActualReceived] = useState("");
  const [driverFeeOffset, setDriverFeeOffset] = useState("0.00");
  const [manualDriverFeeAllocations, setManualDriverFeeAllocations] = useState<
    readonly { accrualId: string; amount: number }[] | undefined
  >();
  const [preview, setPreview] = useState<PreviewResult>();
  const [previewError, setPreviewError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirmError, setConfirmError] = useState<string>();
  const [confirmed, setConfirmed] = useState<{
    driverFeeOffset: string;
    driverFeePaymentId: string | null;
    driverFeePaymentNumber: string | null;
    grossCollections: string;
    id: string;
    number: string;
    orderCount: number;
    remainingDriverFeeOutstanding: string;
  }>();
  const idempotency = useIdempotencyKey();
  const reportLanguage = normalizeLocale(i18n.resolvedLanguage);
  const pdf = useReconciliationPdfActions(api);
  const [pdfError, setPdfError] = useState<string>();

  useEffect(() => {
    const parameters = new URLSearchParams({ pageSize: "25" });
    if (driverSearch.trim() !== "") parameters.set("search", driverSearch.trim());
    void api
      .get<PagedResponse<DriverOption>>(`operations/cash/drivers?${parameters.toString()}`)
      .then((page) => setDrivers(page.items))
      .catch(() => setDrivers([]));
  }, [api, driverSearch]);

  useEffect(() => {
    void api
      .get<readonly ExpenseTypeOption[]>("operations/cash/expense-types")
      .then(setExpenseTypes)
      .catch(() => undefined);
  }, [api]);

  // Load bank accounts for Visa/Bank Transfer payments
  useEffect(() => {
    void api
      .get<readonly { id: string; accountName: string; bankName: string }[]>(
        "operations/accounting/cash-bank/bank-accounts?activeOnly=true",
      )
      .then((items) => setBankAccounts(items.map((item) => ({
        id: item.id,
        name: `${item.accountName} (${item.bankName})`
      }))))
      .catch(() => setBankAccounts([]));
  }, [api]);

  const loadOrders = useCallback(() => {
    if (driver === undefined) return;
    void api
      .get<PagedResponse<EligibleOrderRow>>(
        `operations/cash/eligible-orders?driverId=${driver.id}&pageSize=100`,
      )
      .then(setOrdersPage)
      .catch(() => setOrdersError(t("common.loadFailed")));
  }, [api, driver, t]);

  useEffect(() => loadOrders(), [loadOrders]);

  const chooseDriver = (next: DriverOption) => {
    setDriver(next);
    setSelectedIds(new Set());
    setPreview(undefined);
    setActualReceived("");
    setDriverFeeOffset("0.00");
    setManualDriverFeeAllocations(undefined);
    idempotency.reset();
  };

  // Changing Payment Method resets the Order selection so a change can never
  // silently leave Cash-context Orders selected under a Visa collection (§6):
  // one collection carries exactly one method for every linked Order.
  const changePaymentMethod = (next: "cash" | "visa") => {
    setPaymentMethod(next);
    setSelectedIds(new Set());
    setPreview(undefined);
    setManualDriverFeeAllocations(undefined);
    setSelectedBankAccountId("");
    setBankReference("");
    loadOrders();
  };

  const toggleOrder = (id: string) =>
    setSelectedIds((current) => {
      setManualDriverFeeAllocations(undefined);
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const filledExpenses = expenses.filter((row) => row.expenseTypeId !== "" && row.amount !== "");
  const cleanExpenses = useMemo(
    () =>
      filledExpenses.map((row) => ({
        amount: Number(money(row.amount)),
        expenseTypeId: row.expenseTypeId,
        reason: row.reason.trim(),
      })),
    // filledExpenses is rebuilt every render; key on its serialised content.
    [JSON.stringify(filledExpenses)],
  );
  const expenseNeedingDescription = filledExpenses.find((row) => {
    const type = expenseTypes.find((option) => option.id === row.expenseTypeId);
    return type?.requiresDescription === true;
  });

  const selection = useMemo(
    () => ({ excludedOrderIds: [], orderIds: [...selectedIds], selectionMode: "ids" as const }),
    [selectedIds],
  );

  useEffect(() => {
    if (selectedIds.size === 0) {
      setPreview(undefined);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void api
        .post<PreviewResult>("operations/cash/reconciliations/preview", {
          ...selection,
          driverFeeAllocations: manualDriverFeeAllocations,
          driverFeeOffsetAmount: Number(money(driverFeeOffset)),
          expenses: cleanExpenses,
          payments: [],
        })
        .then((result) => {
          if (!active) return;
          setPreview(result);
          setPreviewError(undefined);
        })
        .catch((error: unknown) => {
          if (!active) return;
          setPreview(undefined);
          setPreviewError(message(error, t("operations.reconciliationInvalid")));
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
    // cleanExpenses is a derived array recomputed every render; JSON-stringify
    // it in the dependency list so the effect only reruns on real content change.
  }, [
    api,
    JSON.stringify(cleanExpenses),
    JSON.stringify(manualDriverFeeAllocations),
    selection,
    t,
    driverFeeOffset,
  ]);

  const netExpected = preview === undefined ? 0 : Number(preview.netAmountExpected);
  const difference = money(Number(money(actualReceived || 0)) - netExpected);

  const paymentRow: any = {
    amount: Number(money(actualReceived)),
    paymentMethod: paymentMethod === "visa" ? "bank_transfer" : "cash",
  };
  if (paymentMethod === "visa" && selectedBankAccountId) {
    paymentRow.bankAccountId = selectedBankAccountId;
    const trimmedRef = (bankReference ?? "").trim();
    if (trimmedRef) {
      paymentRow.bankReference = trimmedRef;
    } else {
      const today = new Date().toISOString().split("T")[0] as string;
      const dateOnly = today.replace(/-/g, "");
      const random = Math.random().toString(16).substring(2, 8).toUpperCase();
      paymentRow.bankReference = "REF-" + dateOnly + "-" + random;
    }
  }

  const confirmPayload = {
    ...selection,
    collectionPaymentMethod: paymentMethod,
    driverFeeAllocations: manualDriverFeeAllocations,
    driverFeeOffsetAmount: Number(money(driverFeeOffset)),
    expenses: cleanExpenses,
    payments: actualReceived.trim() === "" ? [] : [paymentRow],
  };
  const fingerprint = `${paymentMethod}|${materialFingerprint({
    excludedOrderIds: [],
    expenses: cleanExpenses.map((row) => ({ ...row, amount: String(row.amount) })),
    orderIds: [...selectedIds],
    payments: confirmPayload.payments.map((row) => ({
      amount: String(row.amount),
      paymentMethod: row.paymentMethod,
      bankAccountId: (row as any).bankAccountId,
      bankReference: (row as any).bankReference || undefined
    })),
    driverFeeOffsetAmount: driverFeeOffset,
    driverFeeAllocations: manualDriverFeeAllocations,
    selectionMode: "ids",
  })}`;

  const canConfirm =
    driver !== undefined &&
    selectedIds.size > 0 &&
    preview !== undefined &&
    preview.warnings.length === 0 &&
    expenseNeedingDescription === undefined &&
    actualReceived.trim() !== "" &&
    Number(difference) === 0 &&
    (paymentMethod === "cash" || selectedBankAccountId !== "") &&
    !saving;

  const confirm = async () => {
    if (!canConfirm || saving) return;
    setSaving(true);
    setConfirmError(undefined);
    try {
      const result = await api.post<{
        driverFeePaymentId: string | null;
        driverFeePaymentNumber: string | null;
        driverPayableDeduction: string;
        reconciliationId: string;
        reconciliationNumber: string;
        remainingDriverFeeOutstanding: string;
      }>("operations/cash/reconciliations/selected", confirmPayload, {
        "X-Idempotency-Key": idempotency.keyFor(fingerprint),
      });
      setConfirmed({
        grossCollections: preview?.grossCollections ?? "0.00",
        id: result.reconciliationId,
        number: result.reconciliationNumber,
        orderCount: preview?.orderCount ?? selectedIds.size,
        driverFeeOffset: result.driverPayableDeduction,
        driverFeePaymentId: result.driverFeePaymentId,
        driverFeePaymentNumber: result.driverFeePaymentNumber,
        remainingDriverFeeOutstanding: result.remainingDriverFeeOutstanding,
      });
      idempotency.reset();
    } catch (error) {
      let errorMessage = t("operations.reconciliationFailed");

      // Provide better error messages for common issues
      if (error instanceof ApiError) {
        if (error.code === "database_integrity_conflict" &&
            error.message?.includes("bank_reference")) {
          errorMessage = "Bank Reference must be unique. Please use a different reference number.";
        } else if (error.code === "bank_payment_details_required") {
          errorMessage = "Bank Account is required for Visa (card / bank) payments.";
        } else if (error.details && error.details.length > 0 && error.details[0]) {
          errorMessage = error.details[0];
        } else if (error.message) {
          errorMessage = error.message;
        }
      }

      setConfirmError(errorMessage);
    } finally {
      setSaving(false);
    }
  };

  const openConfirmedPdf = async (mode: PdfAction) => {
    if (confirmed === undefined) return;
    setPdfError(undefined);
    const requestError = await pdf.run(
      `operations/cash/reconciliations/${confirmed.id}/pdf?language=${reportLanguage}`,
      `Driver-Collection-${confirmed.number}.pdf`,
      mode,
    );
    if (requestError !== undefined) {
      setPdfError(message(requestError, t("operations.pdfGenerationFailed")));
    }
  };

  return (
    <Modal
      className="order-modal"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.newCollection")}
      titleId="create-collection-title"
    >
      {confirmed !== undefined ? (
        <div className="reconciliation-success" role="status">
          <p>{t("operations.collectionConfirmed", { number: confirmed.number })}</p>
          <dl className="reconciliation-summary">
            <div className="detail-line">
              <dt>{t("operations.reconciliationNumber")}</dt>
              <dd>{confirmed.number}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.driver")}</dt>
              <dd>{driver?.name}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.orders")}</dt>
              <dd>{confirmed.orderCount}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.selectedCollections")}</dt>
              <dd>{money(confirmed.grossCollections)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.driverFeeOffset.title")}</dt>
              <dd>{money(confirmed.driverFeeOffset)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.driverFeeOffset.linkedPayment")}</dt>
              <dd>{confirmed.driverFeePaymentNumber ?? t("operations.driverFeeOffset.none")}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.driverFeeOffset.remaining")}</dt>
              <dd>{money(confirmed.remainingDriverFeeOutstanding)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.paymentMethod")}</dt>
              <dd>{t(`operations.paymentMethod${paymentMethod === "cash" ? "Cash" : "Visa"}`)}</dd>
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
              {pdf.busy === "preview" ? t("common.loading") : t("operations.previewReport")}
            </button>
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void openConfirmedPdf("print")}
              type="button"
            >
              {pdf.busy === "print" ? t("common.loading") : t("common.print")}
            </button>
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void openConfirmedPdf("download")}
              type="button"
            >
              {pdf.busy === "download" ? t("common.loading") : t("operations.downloadPdf")}
            </button>
            <button className="button button-primary" onClick={onCreated} type="button">
              {t("common.done")}
            </button>
          </div>
        </div>
      ) : (
        <form className="order-form" onSubmit={(event) => void (event.preventDefault(), confirm())}>
          {/* `.order-modal` is a fixed-height flex column with overflow hidden,
              so the form must own the scroll region — otherwise the later steps
              (Driver Expenses, Review and Confirm) are clipped with no way to
              reach them. Same structure the Create Order modal already uses. */}
          <div className="order-modal-scroll">
            {confirmError === undefined ? null : (
              <div className="alert alert-error" role="alert">
                {confirmError}
              </div>
            )}

            {/* Step 1 — Driver */}
            <section className="workspace-step">
              <h3>{t("operations.collectionStepDriver")}</h3>
              {driver === undefined ? (
                <>
                  <label className="field">
                    <span>{t("operations.searchDrivers")}</span>
                    <input
                      onChange={(event) => setDriverSearch(event.target.value)}
                      placeholder={t("operations.searchDrivers")}
                      type="search"
                      value={driverSearch}
                    />
                  </label>
                  <ul className="option-list">
                    {drivers.map((option) => (
                      <li key={option.id}>
                        <button onClick={() => chooseDriver(option)} type="button">
                          {/* Driver Name and Type only — no internal Driver code (§6). */}
                          {option.name} — {t(`statuses.${option.driverType}`)}
                        </button>
                      </li>
                    ))}
                    {drivers.length === 0 ? (
                      <li className="empty-state">{t("operations.noDrivers")}</li>
                    ) : null}
                  </ul>
                </>
              ) : (
                <div className="detail-line">
                  <span>
                    {driver.name} — {t(`statuses.${driver.driverType}`)}
                  </span>
                  <button onClick={() => setDriver(undefined)} type="button">
                    {t("common.change")}
                  </button>
                </div>
              )}
            </section>

            {driver === undefined ? null : (
              <>
                {/* Step 2 — Payment Method: Cash or Visa, immediately after Driver
                  and before Expenses (§2). */}
                <section className="workspace-step">
                  <h3>{t("operations.paymentMethod")}</h3>
                  <label className="field required-field">
                    <span>{t("operations.paymentMethod")}</span>
                    <select
                      onChange={(event) =>
                        changePaymentMethod(event.target.value as "cash" | "visa")
                      }
                      value={paymentMethod}
                    >
                      <option value="cash">{t("operations.paymentMethodCash")}</option>
                      <option value="visa">{t("operations.paymentMethodVisa")}</option>
                    </select>
                  </label>
                  {paymentMethod === "visa" ? (
                    <>
                      <label className="field required-field">
                        <span>Bank Account</span>
                        <select
                          onChange={(event) => setSelectedBankAccountId(event.target.value)}
                          value={selectedBankAccountId}
                        >
                          <option value="">{t("common.select")}</option>
                          {bankAccounts.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>Bank Reference (optional)</span>
                        <input
                          onChange={(event) => setBankReference(event.target.value)}
                          placeholder="e.g., TRX123456, REF-2026-08-25-001"
                          type="text"
                          value={bankReference}
                          maxLength={80}
                        />
                        <small className="field-hint">Optional: Transaction reference or ID. If provided, must be unique.</small>
                      </label>
                    </>
                  ) : null}
                </section>

                {/* Step 3 — Eligible Orders */}
                <section className="workspace-step">
                  <h3>{t("operations.collectionStepOrders")}</h3>
                  {ordersError === undefined ? null : (
                    <div className="alert alert-error">{ordersError}</div>
                  )}
                  {/* Ten columns overflow the modal width; scroll instead of clipping. */}
                  <div className="table-scroll-x">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">
                            <span className="sr-only">{t("common.select")}</span>
                          </th>
                          <th scope="col">{t("operations.serialNumber")}</th>
                          <th scope="col">{t("operations.orderNumber")}</th>
                          <th scope="col">{t("operations.externalReferenceNumber")}</th>
                          <th scope="col">{t("operations.deliveryDate")}</th>
                          <th scope="col">{t("operations.trader")}</th>
                          <th scope="col">{t("operations.customer")}</th>
                          <th scope="col">{t("operations.areaField")}</th>
                          <th scope="col">{t("operations.customerAmountToCollect")}</th>
                          <th scope="col">{t("operations.paymentMethod")}</th>
                          <th scope="col">{t("operations.cashStatus")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(ordersPage?.items ?? []).map((order) => (
                          <tr key={order.id}>
                            <td>
                              <input
                                aria-label={t("operations.selectOrder", {
                                  order: order.orderNumber,
                                })}
                                checked={selectedIds.has(order.id)}
                                onChange={() => toggleOrder(order.id)}
                                type="checkbox"
                              />
                            </td>
                            {/* The Serial Number is what the operator reads elsewhere
                            (the Orders list, the Driver Collection report); the
                            Order Number stays available alongside it, never
                            relabelled as the Serial Number. */}
                            <td>{order.serialNumber}</td>
                            <td>{order.orderNumber}</td>
                            <td>{order.referenceNumber ?? "—"}</td>
                            <td>{order.deliveredAt ?? ""}</td>
                            <td>{order.traderName}</td>
                            <td>{order.customerName}</td>
                            <td>{order.areaName}</td>
                            <td>{money(order.amountCollected)}</td>
                            <td>
                              {t(
                                `operations.paymentMethod${paymentMethod === "cash" ? "Cash" : "Visa"}`,
                              )}
                            </td>
                            <td>
                              <DriverCashStatusLabel value={order.cashStatus} />
                            </td>
                          </tr>
                        ))}
                        {(ordersPage?.items.length ?? 0) === 0 ? (
                          <tr>
                            <td className="empty-state" colSpan={10}>
                              {t("operations.noEligibleOrders")}
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </section>

                {/* Step 4 — Driver Expenses */}
                <section className="workspace-step">
                  <h3>{t("operations.collectionStepExpenses")}</h3>
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
                          {t("operations.reason")}
                          <input
                            onChange={(event) =>
                              setExpenses(
                                expenses.map((current, position) =>
                                  position === index
                                    ? { ...current, reason: event.target.value }
                                    : current,
                                ),
                              )
                            }
                            placeholder={t("operations.expenseReasonPlaceholder")}
                            type="text"
                            value={row.reason}
                          />
                        </label>
                        {type?.requiresDescription === true ? (
                          <small className="field-hint">{t("operations.otherExpenseHint")}</small>
                        ) : null}
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
                      setExpenses([...expenses, { amount: "", expenseTypeId: "", reason: "" }])
                    }
                    type="button"
                  >
                    {t("operations.addExpense")}
                  </button>
                </section>

                {driver.driverType === "outsourced" ? (
                  <section className="workspace-step driver-fee-offset">
                    <h3>{t("operations.driverFeeOffset.title")}</h3>
                    <p className="field-hint">{t("operations.driverFeeOffset.help")}</p>
                    <dl className="reconciliation-summary">
                      <div className="detail-line">
                        <dt>{t("operations.driverFeeOffset.totalOutstanding")}</dt>
                        <dd>{money(preview?.totalOutstandingDriverFees)}</dd>
                      </div>
                      <div className="detail-line">
                        <dt>{t("operations.driverFeeOffset.eligibleAccruals")}</dt>
                        <dd>{preview?.eligibleDriverFeeAccrualCount ?? 0}</dd>
                      </div>
                      <div className="detail-line">
                        <dt>{t("operations.driverFeeOffset.safeMaximum")}</dt>
                        <dd>{money(preview?.safeMaximumDriverFeeOffset)}</dd>
                      </div>
                      <div className="detail-line">
                        <dt>
                          <label htmlFor="driver-fee-offset">
                            {t("operations.driverFeeOffset.selected")}
                          </label>
                        </dt>
                        <dd>
                          <input
                            id="driver-fee-offset"
                            inputMode="decimal"
                            min="0"
                            onChange={(event) => {
                              setDriverFeeOffset(event.target.value);
                              setManualDriverFeeAllocations(undefined);
                            }}
                            step="0.01"
                            type="number"
                            value={driverFeeOffset}
                          />
                        </dd>
                      </div>
                      <div className="detail-line">
                        <dt>{t("operations.driverFeeOffset.remaining")}</dt>
                        <dd>{money(preview?.remainingDriverFeeOutstanding)}</dd>
                      </div>
                    </dl>
                    <div className="heading-actions">
                      <button
                        onClick={() => {
                          setDriverFeeOffset(preview?.safeMaximumDriverFeeOffset ?? "0.00");
                          setManualDriverFeeAllocations(undefined);
                        }}
                        type="button"
                      >
                        {t("operations.driverFeeOffset.applyAll")}
                      </button>
                      <button
                        onClick={() => {
                          setDriverFeeOffset("0.00");
                          setManualDriverFeeAllocations(undefined);
                        }}
                        type="button"
                      >
                        {t("operations.driverFeeOffset.applyNone")}
                      </button>
                      {manualDriverFeeAllocations === undefined ? null : (
                        <button
                          onClick={() => setManualDriverFeeAllocations(undefined)}
                          type="button"
                        >
                          {t("payroll.driverFees.actions.oldestFirst")}
                        </button>
                      )}
                    </div>
                    {manualDriverFeeAllocations === undefined ? null : (
                      <div className="alert alert-warning">
                        {t("payroll.driverFees.pay.overrideWarning")}
                      </div>
                    )}
                    {(preview?.driverFeeAllocations.length ?? 0) === 0 ? null : (
                      <div className="table-scroll-x">
                        <table>
                          <thead>
                            <tr>
                              <th>{t("operations.order")}</th>
                              <th>{t("operations.driverFeeOffset.outstandingBefore")}</th>
                              <th>{t("operations.driverFeeOffset.proposed")}</th>
                              <th>{t("operations.driverFeeOffset.remainingAfter")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {preview?.driverFeeAllocations.map((line) => (
                              <tr key={line.accrualId}>
                                <td>{line.orderNumber}</td>
                                <td>{money(line.outstandingBefore)}</td>
                                <td>
                                  <input
                                    inputMode="decimal"
                                    min="0"
                                    onChange={(event) => {
                                      const nextAmount = Number(money(event.target.value));
                                      const current =
                                        manualDriverFeeAllocations ??
                                        preview.driverFeeAllocations.map((item) => ({
                                          accrualId: item.accrualId,
                                          amount: Number(money(item.amount)),
                                        }));
                                      setManualDriverFeeAllocations(
                                        current.map((item) =>
                                          item.accrualId === line.accrualId
                                            ? { ...item, amount: nextAmount }
                                            : item,
                                        ),
                                      );
                                    }}
                                    step="0.01"
                                    type="number"
                                    value={
                                      manualDriverFeeAllocations?.find(
                                        (item) => item.accrualId === line.accrualId,
                                      )?.amount ?? line.amount
                                    }
                                  />
                                </td>
                                <td>{money(line.remainingOutstanding)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                ) : null}

                {/* Step 5 — Totals */}
                <section className="workspace-step">
                  <h3>{t("operations.collectionStepReview")}</h3>
                  {previewError === undefined ? null : (
                    <div className="alert alert-error">{previewError}</div>
                  )}
                  {(preview?.warnings.length ?? 0) === 0 ? null : (
                    <div className="alert alert-error" role="alert">
                      <p>{t("operations.mixedEligibilityWarning")}</p>
                      <ul>
                        {preview?.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <dl className="reconciliation-summary">
                    <div className="detail-line">
                      <dt>{t("operations.selectedCollections")}</dt>
                      <dd>{money(preview?.grossCollections)}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("operations.expenses")}</dt>
                      <dd>{money(preview?.expenseTotal)}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("operations.driverFeeOffset.title")}</dt>
                      <dd>{money(preview?.driverPayableDeduction)}</dd>
                    </div>
                    <div className="detail-line detail-line-total">
                      <dt>{t("operations.netExpected")}</dt>
                      <dd>
                        <strong>{money(preview?.netAmountExpected)}</strong>
                      </dd>
                    </div>
                    <div className="detail-line">
                      <dt>
                        <label htmlFor="actual-received">{t("operations.actualReceived")}</label>
                      </dt>
                      <dd>
                        <input
                          id="actual-received"
                          inputMode="decimal"
                          onChange={(event) => setActualReceived(event.target.value)}
                          required
                          step="0.01"
                          type="number"
                          value={actualReceived}
                        />
                      </dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("operations.difference")}</dt>
                      <dd className={Number(difference) === 0 ? undefined : "summary-invalid"}>
                        <strong>{difference}</strong>
                      </dd>
                    </div>
                  </dl>
                  {Number(difference) === 0 ? null : (
                    <p className="field-error" role="alert">
                      {t("operations.blockedDifference")}
                    </p>
                  )}
                </section>
              </>
            )}

            {/* Step 6 — Confirmation */}
          </div>
          {/* Outside the scroll region so Cancel/Confirm stay reachable. */}
          <div className="modal-actions order-modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button className="button button-primary" disabled={!canConfirm} type="submit">
              {saving ? t("operations.creatingOrder") : t("operations.confirmReconciliation")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Detail view + PDF actions + reversal entry point (§10/§11/§14).
// ---------------------------------------------------------------------------

export function DriverCollectionDetailDialog({
  api,
  highlightOrderSerialNumber,
  onClose,
  onReversed,
  reconciliationId,
}: {
  api: ApiClient;
  highlightOrderSerialNumber?: string;
  onClose: () => void;
  onReversed: () => void;
  reconciliationId: string;
}) {
  const { i18n, t } = useTranslation();
  const [data, setData] = useState<ReportData>();
  const [error, setError] = useState<string>();
  const [reverseOpen, setReverseOpen] = useState(false);
  const [linkedPayment, setLinkedPayment] = useState<Record<string, unknown>>();
  const [linkedPaymentOpen, setLinkedPaymentOpen] = useState(false);
  // Explicit report-language selection (§15), defaulted from the active UI
  // language but always changeable by the User.
  const [reportLanguage, setReportLanguage] = useState<"ar" | "en">(
    normalizeLocale(i18n.resolvedLanguage),
  );
  const pdf = useReconciliationPdfActions(api);

  useEffect(() => {
    void api
      .get<ReportData>(`operations/cash/reconciliations/${reconciliationId}/report-data`)
      .then(setData)
      .catch((requestError: unknown) =>
        setError(message(requestError, t("operations.detailLoadFailed"))),
      );
  }, [api, reconciliationId, t]);

  const openPdf = async (mode: PdfAction) => {
    setError(undefined);
    const filename = `Driver-Collection-${data?.header.reconciliationNumber ?? reconciliationId}.pdf`;
    const requestError = await pdf.run(
      `operations/cash/reconciliations/${reconciliationId}/pdf?language=${reportLanguage}`,
      filename,
      mode,
    );
    if (requestError !== undefined) {
      setError(message(requestError, t("operations.pdfGenerationFailed")));
    }
  };

  const openLinkedPayment = async () => {
    const paymentId = data?.header.linkedDriverFeePaymentId;
    if (paymentId === null || paymentId === undefined) return;
    setError(undefined);
    try {
      setLinkedPayment(
        await api.get<Record<string, unknown>>(
          `operations/payroll/outsourced-driver-fees/payments/${paymentId}`,
        ),
      );
      setLinkedPaymentOpen(true);
    } catch (requestError) {
      setError(message(requestError, t("payroll.driverFees.errors.load")));
    }
  };

  return (
    <Modal
      className="order-modal"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.collectionDetail")}
      titleId="collection-detail-title"
    >
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {data === undefined ? (
        error === undefined ? (
          <div className="loading-row">{t("common.loading")}</div>
        ) : null
      ) : (
        <>
          <dl className="reconciliation-summary">
            <div className="detail-line">
              <dt>{t("operations.reconciliationNumber")}</dt>
              <dd>{data.header.reconciliationNumber}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.status")}</dt>
              <dd>
                {data.header.statusLabel}
                {data.header.reversedByReconciliationNumber === null ? null : (
                  <span className="badge badge-warning">
                    {t("operations.reversedIndicator")}:{" "}
                    {data.header.reversedByReconciliationNumber}
                  </span>
                )}
                {!data.header.isReversal ? null : (
                  <span className="badge">
                    {t("operations.reversalOf")}: {data.header.reversesReconciliationNumber}
                  </span>
                )}
              </dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.driver")}</dt>
              <dd>
                <OperationalReference
                  identifier={data.header.driverCode}
                  reference={partyDisplayLabel(
                    data.header.driverCode,
                    data.header.driverName,
                    data.header.driverNameAr,
                    reportLanguage,
                  )}
                  type="driver"
                />
              </dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.driverType")}</dt>
              <dd>{t(`statuses.${data.header.driverType}`)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.paymentMethod")}</dt>
              <dd>
                {data.header.collectionPaymentMethod === null
                  ? t("operations.paymentMethodNotAssigned")
                  : t(
                      `operations.paymentMethod${data.header.collectionPaymentMethod === "cash" ? "Cash" : "Visa"}`,
                    )}
              </dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.businessDate")}</dt>
              <dd>{data.header.businessDate}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.createdDate")}</dt>
              <dd>{data.header.createdAt}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.confirmedDate")}</dt>
              <dd>{data.header.confirmedAt ?? ""}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.createdBy")}</dt>
              <dd>{data.header.createdBy}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.confirmedBy")}</dt>
              <dd>{data.header.confirmedBy}</dd>
            </div>
            {data.header.notes === null ? null : (
              <div className="detail-line">
                <dt>{t("operations.notes")}</dt>
                <dd>{data.header.notes}</dd>
              </div>
            )}
            <div className="detail-line">
              <dt>{t("operations.selectedCollections")}</dt>
              <dd>{money(data.summary.grossCollections)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.expenses")}</dt>
              <dd>{money(data.summary.driverExpenses)}</dd>
            </div>
            {Number(data.summary.driverFeeOffset) === 0 ? null : (
              <>
                <div className="detail-line">
                  <dt>{t("operations.driverFeeOffset.title")}</dt>
                  <dd>{money(data.summary.driverFeeOffset)}</dd>
                </div>
                <div className="detail-line">
                  <dt>{t("operations.driverFeeOffset.linkedPayment")}</dt>
                  <dd>
                    {data.header.linkedDriverFeePaymentNumber ??
                      t("operations.driverFeeOffset.none")}
                    {data.header.linkedDriverFeePaymentStatus === null ? null : (
                      <span
                        className={`badge fee-status-${data.header.linkedDriverFeePaymentStatus}`}
                      >
                        {t(`payroll.driverFees.status.${data.header.linkedDriverFeePaymentStatus}`)}
                      </span>
                    )}
                  </dd>
                </div>
              </>
            )}
            <div className="detail-line">
              <dt>{t("operations.grossCollections")}</dt>
              <dd>{money(data.summary.grossCollections)}</dd>
            </div>
            <div className="detail-line detail-line-total">
              <dt>{t("operations.netExpected")}</dt>
              <dd>
                <strong>{money(data.summary.netExpected)}</strong>
              </dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.actualReceived")}</dt>
              <dd>{money(data.summary.actualReceived)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.difference")}</dt>
              <dd>{money(data.summary.difference)}</dd>
            </div>
          </dl>

          <h3>{t("operations.orders")}</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">{t("operations.serialNumber")}</th>
                <th scope="col">{t("operations.trader")}</th>
                <th scope="col">{t("operations.customer")}</th>
                <th scope="col">{t("operations.customerAmountToCollect")}</th>
                <th scope="col">{t("operations.amountDueToTrader")}</th>
              </tr>
            </thead>
            <tbody>
              {data.orders.map((order) => (
                <tr
                  className={
                    order.serialNumber === highlightOrderSerialNumber
                      ? "row-highlighted"
                      : undefined
                  }
                  key={order.serialNumber}
                >
                  <td>
                    {/* The verified Order route, which takes the Order NUMBER.
                        The Serial Number stays the value the User reads. */}
                    <OperationalReference
                      identifier={order.orderNumber}
                      reference={order.serialNumber}
                      type="order"
                    />
                  </td>
                  <td>
                    <OperationalReference
                      identifier={order.traderCode}
                      reference={partyDisplayLabel(
                        order.traderCode,
                        order.traderName,
                        null,
                        reportLanguage,
                      )}
                      type="trader"
                    />
                  </td>
                  <td>{order.customerName}</td>
                  <td>{money(order.customerAmountToCollect)}</td>
                  <td>{money(order.traderPayable)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.expenses.length === 0 ? null : (
            <>
              <h3>{t("operations.collectionStepExpenses")}</h3>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t("operations.expenseType")}</th>
                    <th scope="col">{t("operations.amount")}</th>
                    <th scope="col">{t("operations.reason")}</th>
                    <th scope="col">{t("operations.enteredBy")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.expenses.map((expense, index) => (
                    <tr key={index}>
                      <td>{expense.expenseType}</td>
                      <td>{money(expense.amount)}</td>
                      <td>{expense.reason ?? ""}</td>
                      <td>{expense.enteredBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* Additive Accounting link-through; renders nothing for a User
              without Accounting access. */}
          <AccountingRelatedPanel
            api={api}
            sourceId={reconciliationId}
            sourceType="driver_reconciliation"
          />

          <div className="modal-actions">
            <label className="field" htmlFor="report-language">
              <span>{t("operations.reportLanguage")}</span>
              <select
                id="report-language"
                onChange={(event) => setReportLanguage(event.target.value as "ar" | "en")}
                value={reportLanguage}
              >
                <option value="en">{t("operations.reportLanguageEnglish")}</option>
                <option value="ar">{t("operations.reportLanguageArabic")}</option>
              </select>
            </label>
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void openPdf("preview")}
              type="button"
            >
              {pdf.busy === "preview" ? t("common.loading") : t("operations.previewReport")}
            </button>
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void openPdf("print")}
              type="button"
            >
              {pdf.busy === "print" ? t("common.loading") : t("common.print")}
            </button>
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void openPdf("download")}
              type="button"
            >
              {pdf.busy === "download" ? t("common.loading") : t("operations.downloadPdf")}
            </button>
            {data.header.linkedDriverFeePaymentId === null ? null : (
              <>
                <button onClick={() => void openLinkedPayment()} type="button">
                  {t("operations.driverFeeOffset.openPayment")}
                </button>
                <button
                  disabled={pdf.busy !== undefined}
                  onClick={() =>
                    void pdf.run(
                      `operations/payroll/outsourced-driver-fees/payments/${data.header.linkedDriverFeePaymentId}/receipt/pdf?language=${reportLanguage}`,
                      `Driver-Fee-Payment-${data.header.linkedDriverFeePaymentNumber ?? reconciliationId}.pdf`,
                      "preview",
                    )
                  }
                  type="button"
                >
                  {t("operations.driverFeeOffset.receipt")}
                </button>
                <button
                  disabled={pdf.busy !== undefined}
                  onClick={() =>
                    void pdf.run(
                      `operations/payroll/outsourced-driver-fees/payments/${data.header.linkedDriverFeePaymentId}/receipt/pdf?language=${reportLanguage}`,
                      `Driver-Fee-Payment-${data.header.linkedDriverFeePaymentNumber ?? reconciliationId}.pdf`,
                      "download",
                    )
                  }
                  type="button"
                >
                  {t("operations.driverFeeOffset.downloadReceipt")}
                </button>
              </>
            )}
            {data.header.status !== "confirmed" ||
            data.header.isReversal ||
            data.header.reversedByReconciliationNumber !== null ? null : (
              <button
                className="button button-secondary"
                onClick={() => setReverseOpen(true)}
                type="button"
              >
                {t("operations.reverseCollection")}
              </button>
            )}
            <button className="button button-primary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </>
      )}

      {!reverseOpen || data === undefined ? null : (
        <ReverseCollectionDialog
          api={api}
          collection={{
            driverName: data.header.driverName,
            id: reconciliationId,
            linkedDriverFeePaymentNumber: data.header.linkedDriverFeePaymentNumber,
            reconciliationNumber: data.header.reconciliationNumber,
          }}
          onClose={() => setReverseOpen(false)}
          onReversed={onReversed}
        />
      )}
      {!linkedPaymentOpen || linkedPayment === undefined ? null : (
        <Modal
          closeLabel={t("common.close")}
          onRequestClose={() => setLinkedPaymentOpen(false)}
          title={t("payroll.driverFees.payments.detail")}
          titleId="linked-driver-fee-payment"
        >
          <dl className="reconciliation-summary">
            {Object.entries(linkedPayment)
              .filter(([key]) => key !== "allocations")
              .map(([key, value]) => (
                <div className="detail-line" key={key}>
                  <dt>{t(`payroll.driverFees.columns.${key}`)}</dt>
                  <dd>{String(value ?? "-")}</dd>
                </div>
              ))}
          </dl>
          <div className="modal-actions">
            <button onClick={() => setLinkedPaymentOpen(false)} type="button">
              {t("common.close")}
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

function ReverseCollectionDialog({
  api,
  collection,
  onClose,
  onReversed,
}: {
  api: ApiClient;
  collection: {
    readonly driverName: string;
    readonly id: string;
    readonly linkedDriverFeePaymentNumber: string | null;
    readonly reconciliationNumber: string;
  };
  onClose: () => void;
  onReversed: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    if (reason.trim() === "" || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await api.post(`operations/cash/reconciliations/${collection.id}/reverse`, {
        reason: reason.trim(),
      });
      onReversed();
    } catch (requestError) {
      setError(
        requestError instanceof ApiError &&
          requestError.code === "outsourced_driver_fee_recovery_workflow_required"
          ? t("payroll.driverFees.errors.recoveryWorkflow")
          : message(requestError, t("operations.reversalFailed")),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.reverseCollection")}
      titleId="reverse-collection-title"
    >
      <p className="alert alert-warning" role="alert">
        {t("operations.reverseWarning", {
          driver: collection.driverName,
          number: collection.reconciliationNumber,
        })}
        {collection.linkedDriverFeePaymentNumber === null
          ? ""
          : ` ${t("operations.driverFeeOffset.reverseLinkedWarning", {
              payment: collection.linkedDriverFeePaymentNumber,
            })}`}
      </p>
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      <label className="field required-field">
        <span>{t("operations.reversalReason")}</span>
        <textarea
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          required
          rows={3}
          value={reason}
        />
      </label>
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={reason.trim() === "" || saving}
          onClick={() => void submit()}
          type="button"
        >
          {saving ? t("common.saving") : t("operations.confirmReversal")}
        </button>
      </div>
    </Modal>
  );
}
