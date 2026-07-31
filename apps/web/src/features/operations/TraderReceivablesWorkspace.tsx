import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import type { CompanyBankAccount, OperationsTrader, PagedResponse } from "../../api/contracts.js";
import { CompanyBrandingContext } from "../../app/CompanyBrandingContext.js";
import { Modal } from "../../components/Modal.js";
import { PageHeader } from "../../components/PageHeader.js";
import {
  formatMoneyValue,
  parseMoneyInput,
  safeMoneyValue,
} from "../../utils/numeric-input.js";

import { type PdfAction, useReconciliationPdfActions } from "./reconciliation-pdf.js";
import { useIdempotencyKey } from "./useIdempotencyKey.js";

// ---- Server response shapes (mirror trader-receivable.service.ts). ----

interface TraderReceivableSummary {
  readonly collectedThisPeriod: string;
  readonly outstandingReceivablesCount: number;
  readonly partiallyCollectedAmount: string;
  readonly reversedCollections: number;
  readonly totalOutstandingReceivables: string;
  readonly totalRemainingDue: string;
  readonly tradersWithOutstandingReceivables: number;
}

interface TraderWithBalance {
  readonly outstandingAmount: string;
  readonly traderId: string;
  readonly traderName: string;
}

interface TraderReceivableEligibleRow {
  readonly businessDate: string;
  readonly id: string;
  readonly originalAmountDue: string;
  readonly outstandingAmount: string;
  readonly previouslyCollected: string;
  readonly reason: string;
  readonly receivableNumber: string;
  readonly sourceReference: string | null;
  readonly sourceType: string;
  readonly status: string;
  readonly traderId: string;
  readonly traderName: string;
}

interface TraderCollectionListRow {
  readonly amountReceived: string;
  readonly collectionId: string;
  readonly collectionNumber: string;
  readonly createdAt: string;
  readonly isReversed: boolean;
  readonly paymentDate: string;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly paymentReference: string | null;
  readonly receivableCount: number;
  readonly receivedBy: string;
  readonly status: "confirmed" | "reversed";
  readonly traderName: string;
}

interface TraderAllocationProposalLine {
  readonly businessDate: string;
  readonly outstandingAfter: string;
  readonly outstandingBefore: string;
  readonly proposedAmount: string;
  readonly receivableId: string;
  readonly receivableNumber: string;
}

interface TraderAllocationProposal {
  readonly allocations: readonly TraderAllocationProposalLine[];
  readonly requestedAmount: string;
  readonly totalAllocated: string;
  readonly traderId: string;
}

interface CreateTraderReceivableResult {
  readonly amountDue: string;
  readonly businessDate: string;
  readonly receivableId: string;
  readonly receivableNumber: string;
  readonly sourceType: string;
  readonly status: string;
  readonly traderId: string;
  readonly traderName: string;
}

interface CreateTraderCollectionResult {
  readonly amountReceived: string;
  readonly collectionId: string;
  readonly collectionNumber: string;
  readonly paymentDate: string;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly receivableCount: number;
  readonly remainingDue: string;
  readonly traderId: string;
  readonly traderName: string;
}

interface TraderReceivableCollectionHistoryLine {
  readonly amountCollected: string;
  readonly collectionDate: string;
  readonly collectionId: string;
  readonly collectionNumber: string;
  readonly status: "confirmed" | "reversed";
}

interface TraderReceivableDetail {
  readonly amountCollected: string;
  readonly businessDate: string;
  readonly cancelledAt: string | null;
  readonly cancelledReason: string | null;
  readonly collections: readonly TraderReceivableCollectionHistoryLine[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly notes: string | null;
  readonly originalAmountDue: string;
  readonly outstandingAmount: string;
  readonly reason: string;
  readonly receivableId: string;
  readonly receivableNumber: string;
  readonly sourceReference: string | null;
  readonly sourceType: string;
  readonly status: string;
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

interface TraderCollectionAllocationDetail {
  readonly amountCollectedNow: string;
  readonly businessDate: string;
  readonly originalAmountDue: string;
  readonly previouslyCollected: string;
  readonly reason: string;
  readonly receivableNumber: string;
  readonly receivableStatus: string;
  readonly remainingDue: string;
  readonly sourceReference: string | null;
  readonly sourceType: string;
}

interface TraderCollectionSummaryTotals {
  readonly amountReceivedNow: string;
  readonly previouslyCollected: string;
  readonly receivableCount: number;
  readonly remainingDue: string;
  readonly totalOriginalAmountDue: string;
}

interface TraderCollectionDetail {
  readonly allocations: readonly TraderCollectionAllocationDetail[];
  readonly collectionId: string;
  readonly collectionNumber: string;
  readonly companyBankAccount: MaskedBankSnapshot | null;
  readonly createdAt: string;
  readonly notes: string | null;
  readonly paymentDate: string;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly paymentReference: string | null;
  readonly receivedBy: string;
  readonly reversalDate: string | null;
  readonly reversalReason: string | null;
  readonly reversedBy: string | null;
  readonly status: "confirmed" | "reversed";
  readonly summary: TraderCollectionSummaryTotals;
  readonly traderName: string;
}

// ---------------------------------------------------------------------------

const sourceTypes = [
  "manual_adjustment",
  "trader_penalty",
  "overpayment_recovery",
  "refund_due",
  "service_charge",
  "damaged_or_lost_shipment_recovery",
  "other",
] as const;

const receivableStatuses = ["outstanding", "partially_collected", "collected", "cancelled", "reversed"] as const;

const emptyReceivableFilters = {
  businessDateFrom: "",
  businessDateTo: "",
  outstandingOnly: false,
  receivableNumber: "",
  sourceReference: "",
  sourceType: "",
  status: "",
  traderId: "",
};

type ReceivableFilters = typeof emptyReceivableFilters;

const emptyCollectionFilters = {
  collectionNumber: "",
  paymentDateFrom: "",
  paymentDateTo: "",
  paymentMethod: "",
  paymentReference: "",
  receivableNumber: "",
  status: "",
  traderId: "",
};

type CollectionFilters = typeof emptyCollectionFilters;

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

function pascalKey(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function sourceTypeLabel(t: (key: string) => string, sourceType: string): string {
  return t(`traderReceivables.sourceType${pascalKey(sourceType)}`);
}

function receivableStatusLabel(t: (key: string) => string, status: string): string {
  return t(`traderReceivables.status${pascalKey(status)}`);
}

/**
 * Trader Receivable operational workspace: Trader -> pays Company. The single
 * authoritative screen for receivables owed by Traders, oldest-first
 * allocation, partial/full collection, cancellation, reversal, and the
 * Trader Payment Receipt PDF. Deliberately separate from
 * TraderSettlementsWorkspace (Company -> pays Trader) — no shared balances,
 * routes, or dialogs.
 */
export function TraderReceivablesWorkspace({
  api,
  permissions,
}: {
  api: ApiClient;
  permissions: readonly string[];
}) {
  const { t } = useTranslation();
  const branding = useContext(CompanyBrandingContext);
  const reportLanguage = branding?.textLanguage === "ar" ? "ar" : "en";
  const isAdministrator = permissions.includes("users_roles.manage");
  const canManage = isAdministrator || permissions.includes("trader_receivables.create");
  const canReverse = isAdministrator || permissions.includes("trader_receivables.reverse");
  const canViewReport = canManage || permissions.includes("reports.export");

  const [tab, setTab] = useState<"collections" | "receivables">("receivables");
  const [summary, setSummary] = useState<TraderReceivableSummary>();
  const [summaryError, setSummaryError] = useState<string>();

  const [receivableFilters, setReceivableFilters] = useState<ReceivableFilters>(emptyReceivableFilters);
  const [receivablePage, setReceivablePage] = useState(1);
  const [receivablePageSize, setReceivablePageSize] = useState<25 | 50 | 100>(25);
  const [receivableListPage, setReceivableListPage] = useState<PagedResponse<TraderReceivableEligibleRow>>();
  const [receivableListError, setReceivableListError] = useState<string>();

  const [collectionFilters, setCollectionFilters] = useState<CollectionFilters>(emptyCollectionFilters);
  const [collectionPage, setCollectionPage] = useState(1);
  const [collectionPageSize, setCollectionPageSize] = useState<25 | 50 | 100>(25);
  const [collectionListPage, setCollectionListPage] = useState<PagedResponse<TraderCollectionListRow>>();
  const [collectionListError, setCollectionListError] = useState<string>();

  const [newReceivableOpen, setNewReceivableOpen] = useState(false);
  const [collectMoneyOpen, setCollectMoneyOpen] = useState(false);
  const [collectMoneyPresetTraderId, setCollectMoneyPresetTraderId] = useState<string>();
  const [receivableDetailId, setReceivableDetailId] = useState<string>();
  const [collectionDetailId, setCollectionDetailId] = useState<string>();
  const [cancelTarget, setCancelTarget] = useState<TraderReceivableEligibleRow>();
  const [reverseTarget, setReverseTarget] = useState<TraderCollectionListRow>();

  const pdf = useReconciliationPdfActions(api);
  const [pdfError, setPdfError] = useState<string>();
  const [pdfBusyId, setPdfBusyId] = useState<string>();

  const refreshSummary = useCallback(() => {
    if (!canManage) return;
    setSummaryError(undefined);
    void api
      .get<TraderReceivableSummary>("operations/trader-receivables/summary")
      .then(setSummary)
      .catch(() => setSummaryError(t("traderReceivables.detailLoadFailed")));
  }, [api, canManage, t]);

  useEffect(() => refreshSummary(), [refreshSummary]);

  const refreshReceivables = useCallback(() => {
    if (!canManage) return;
    setReceivableListError(undefined);
    const params = filterQuery(receivableFilters);
    params.set("page", String(receivablePage));
    params.set("pageSize", String(receivablePageSize));
    void api
      .get<PagedResponse<TraderReceivableEligibleRow>>(
        `operations/trader-receivables/eligible?${params.toString()}`,
      )
      .then(setReceivableListPage)
      .catch(() => setReceivableListError(t("traderReceivables.detailLoadFailed")));
  }, [api, canManage, receivableFilters, receivablePage, receivablePageSize, t]);

  useEffect(() => {
    if (tab === "receivables") refreshReceivables();
  }, [tab, refreshReceivables]);

  const refreshCollections = useCallback(() => {
    if (!canManage) return;
    setCollectionListError(undefined);
    const params = filterQuery(collectionFilters);
    params.set("page", String(collectionPage));
    params.set("pageSize", String(collectionPageSize));
    void api
      .get<PagedResponse<TraderCollectionListRow>>(
        `operations/trader-receivables/collections?${params.toString()}`,
      )
      .then(setCollectionListPage)
      .catch(() => setCollectionListError(t("traderReceivables.detailLoadFailed")));
  }, [api, canManage, collectionFilters, collectionPage, collectionPageSize, t]);

  useEffect(() => {
    if (tab === "collections") refreshCollections();
  }, [tab, refreshCollections]);

  const refreshAll = useCallback(() => {
    refreshSummary();
    refreshReceivables();
    refreshCollections();
  }, [refreshSummary, refreshReceivables, refreshCollections]);

  const applyReceivableFilter = (change: Partial<ReceivableFilters>) => {
    setReceivablePage(1);
    setReceivableFilters((current) => ({ ...current, ...change }));
  };
  const clearReceivableFilters = () => {
    setReceivablePage(1);
    setReceivablePageSize(25);
    setReceivableFilters(emptyReceivableFilters);
  };

  const applyCollectionFilter = (change: Partial<CollectionFilters>) => {
    setCollectionPage(1);
    setCollectionFilters((current) => ({ ...current, ...change }));
  };
  const clearCollectionFilters = () => {
    setCollectionPage(1);
    setCollectionPageSize(25);
    setCollectionFilters(emptyCollectionFilters);
  };

  const receivableRows = receivableListPage?.items ?? [];
  const receivableTotal = receivableListPage?.total ?? 0;
  const receivablePageCount = receivableTotal === 0 ? 1 : Math.ceil(receivableTotal / receivablePageSize);

  const collectionRows = collectionListPage?.items ?? [];
  const collectionTotal = collectionListPage?.total ?? 0;
  const collectionPageCount = collectionTotal === 0 ? 1 : Math.ceil(collectionTotal / collectionPageSize);

  const openCollectionPdf = async (row: TraderCollectionListRow, mode: PdfAction) => {
    setPdfError(undefined);
    setPdfBusyId(row.collectionId);
    const requestError = await pdf.run(
      `operations/trader-receivables/collections/${row.collectionId}/pdf?language=${reportLanguage}`,
      `Trader-Receipt-${row.collectionNumber}.pdf`,
      mode,
    );
    setPdfBusyId(undefined);
    if (requestError !== undefined) {
      setPdfError(message(requestError, t("traderReceivables.pdfGenerationFailed")));
    }
  };

  const openCollectMoney = (traderId?: string) => {
    setCollectMoneyPresetTraderId(traderId);
    setCollectMoneyOpen(true);
  };

  if (!canManage) {
    return (
      <>
        <PageHeader eyebrow={t("nav.traderReceivables")} title={t("traderReceivables.pageTitle")} />
        <div className="alert alert-error" role="alert">
          {t("traderReceivables.permissionDenied")}
        </div>
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
              onClick={() => setNewReceivableOpen(true)}
              type="button"
            >
              {t("traderReceivables.newReceivable")}
            </button>
            <button className="button button-primary" onClick={() => openCollectMoney()} type="button">
              {t("traderReceivables.collectMoney")}
            </button>
            <button className="button button-secondary" onClick={refreshAll} type="button">
              {t("common.refresh")}
            </button>
          </>
        }
        description={t("traderReceivables.pageSubtitle")}
        eyebrow={t("nav.traderReceivables")}
        title={t("traderReceivables.pageTitle")}
      />

      {summaryError === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {summaryError}
        </div>
      )}
      {pdfError === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {pdfError}
        </div>
      )}

      {summary === undefined ? null : <SummaryCards summary={summary} />}

      <div className="segmented-control" role="group">
        <button aria-pressed={tab === "receivables"} onClick={() => setTab("receivables")} type="button">
          {t("traderReceivables.tabOutstandingReceivables")}
        </button>
        <button aria-pressed={tab === "collections"} onClick={() => setTab("collections")} type="button">
          {t("traderReceivables.tabCollections")}
        </button>
      </div>

      {tab === "receivables" ? (
        <>
          {receivableListError === undefined ? null : (
            <div className="alert alert-error" role="alert">
              {receivableListError}
            </div>
          )}
          <ReceivableFilterBar
            api={api}
            filters={receivableFilters}
            onChange={applyReceivableFilter}
            onClear={clearReceivableFilters}
          />
          <section aria-labelledby="trader-receivables-list-heading">
            <h2 id="trader-receivables-list-heading">{t("traderReceivables.pageTitle")}</h2>
            <div className="table-scroll-x">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t("traderReceivables.columnReceivableNumber")}</th>
                    <th scope="col">{t("traderReceivables.columnTrader")}</th>
                    <th scope="col">{t("traderReceivables.columnBusinessDate")}</th>
                    <th scope="col">{t("traderReceivables.columnSourceType")}</th>
                    <th scope="col">{t("traderReceivables.columnSourceReference")}</th>
                    <th scope="col">{t("traderReceivables.columnReason")}</th>
                    <th scope="col">{t("traderReceivables.columnOriginalAmountDue")}</th>
                    <th scope="col">{t("traderReceivables.columnPreviouslyCollected")}</th>
                    <th scope="col">{t("traderReceivables.columnOutstandingAmount")}</th>
                    <th scope="col">{t("traderReceivables.columnStatus")}</th>
                    <th scope="col">
                      <span className="sr-only">{t("common.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {receivableRows.map((row) => (
                    <tr key={row.id}>
                      <td className="mono">
                        <button
                          className="link-button"
                          onClick={() => setReceivableDetailId(row.id)}
                          type="button"
                        >
                          {row.receivableNumber}
                        </button>
                      </td>
                      <td>{row.traderName}</td>
                      <td>{row.businessDate.slice(0, 10)}</td>
                      <td>{sourceTypeLabel(t, row.sourceType)}</td>
                      <td className="mono">{row.sourceReference ?? "-"}</td>
                      <td>{row.reason}</td>
                      <td>{money(row.originalAmountDue)}</td>
                      <td>{money(row.previouslyCollected)}</td>
                      <td>{money(row.outstandingAmount)}</td>
                      <td>{receivableStatusLabel(t, row.status)}</td>
                      <td className="row-actions">
                        <button onClick={() => setReceivableDetailId(row.id)} type="button">
                          {t("traderReceivables.actionView")}
                        </button>
                        <button onClick={() => openCollectMoney(row.traderId)} type="button">
                          {t("traderReceivables.actionCollectMoney")}
                        </button>
                        {row.status !== "outstanding" ? null : (
                          <button onClick={() => setCancelTarget(row)} type="button">
                            {t("traderReceivables.actionCancel")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {receivableRows.length === 0 ? (
                    <tr>
                      <td className="empty-state" colSpan={11}>
                        {t("traderReceivables.noReceivables")}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <nav aria-label={t("common.pagination")} className="pagination">
              <button
                disabled={receivablePage <= 1}
                onClick={() => setReceivablePage(receivablePage - 1)}
                type="button"
              >
                {t("common.previous")}
              </button>
              <span>{t("common.pageOf", { page: receivablePage, pageCount: receivablePageCount })}</span>
              <button
                disabled={receivablePage >= receivablePageCount}
                onClick={() => setReceivablePage(receivablePage + 1)}
                type="button"
              >
                {t("common.next")}
              </button>
            </nav>
          </section>
        </>
      ) : (
        <>
          {collectionListError === undefined ? null : (
            <div className="alert alert-error" role="alert">
              {collectionListError}
            </div>
          )}
          <CollectionFilterBar
            api={api}
            filters={collectionFilters}
            onChange={applyCollectionFilter}
            onClear={clearCollectionFilters}
          />
          <section aria-labelledby="trader-collections-list-heading">
            <h2 id="trader-collections-list-heading">{t("traderReceivables.tabCollections")}</h2>
            <div className="table-scroll-x">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t("traderReceivables.columnCollectionNumber")}</th>
                    <th scope="col">{t("traderReceivables.columnTrader")}</th>
                    <th scope="col">{t("traderReceivables.columnPaymentDate")}</th>
                    <th scope="col">{t("traderReceivables.columnPaymentMethod")}</th>
                    <th scope="col">{t("traderReceivables.columnPaymentReference")}</th>
                    <th scope="col">{t("traderReceivables.columnReceivables")}</th>
                    <th scope="col">{t("traderReceivables.columnAmountReceived")}</th>
                    <th scope="col">{t("traderReceivables.columnStatus")}</th>
                    <th scope="col">{t("traderReceivables.columnReceivedBy")}</th>
                    <th scope="col">{t("traderReceivables.columnReversed")}</th>
                    <th scope="col">
                      <span className="sr-only">{t("common.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {collectionRows.map((row) => (
                    <tr key={row.collectionId}>
                      <td className="mono">
                        <button
                          className="link-button"
                          onClick={() => setCollectionDetailId(row.collectionId)}
                          type="button"
                        >
                          {row.collectionNumber}
                        </button>
                      </td>
                      <td>{row.traderName}</td>
                      <td>{row.paymentDate.slice(0, 10)}</td>
                      <td>
                        {t(
                          row.paymentMethod === "cash"
                            ? "traderReceivables.paymentMethodCash"
                            : "traderReceivables.paymentMethodBankTransfer",
                        )}
                      </td>
                      <td className="mono">{row.paymentReference ?? "-"}</td>
                      <td>{row.receivableCount}</td>
                      <td>{money(row.amountReceived)}</td>
                      <td>
                        {t(
                          row.status === "reversed"
                            ? "traderReceivables.statusReversed"
                            : "traderReceivables.statusConfirmed",
                        )}
                      </td>
                      <td>{row.receivedBy}</td>
                      <td>
                        {row.isReversed ? (
                          <span className="badge badge-warning">{t("traderReceivables.columnReversed")}</span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="row-actions">
                        <button onClick={() => setCollectionDetailId(row.collectionId)} type="button">
                          {t("traderReceivables.actionView")}
                        </button>
                        {!canViewReport ? null : (
                          <>
                            <button
                              disabled={pdfBusyId === row.collectionId}
                              onClick={() => void openCollectionPdf(row, "preview")}
                              type="button"
                            >
                              {pdfBusyId === row.collectionId && pdf.busy === "preview"
                                ? t("common.loading")
                                : t("traderReceivables.actionPreviewReceipt")}
                            </button>
                            <button
                              disabled={pdfBusyId === row.collectionId}
                              onClick={() => void openCollectionPdf(row, "print")}
                              type="button"
                            >
                              {pdfBusyId === row.collectionId && pdf.busy === "print"
                                ? t("common.loading")
                                : t("traderReceivables.actionPrint")}
                            </button>
                            <button
                              disabled={pdfBusyId === row.collectionId}
                              onClick={() => void openCollectionPdf(row, "download")}
                              type="button"
                            >
                              {pdfBusyId === row.collectionId && pdf.busy === "download"
                                ? t("common.loading")
                                : t("traderReceivables.actionDownloadPdf")}
                            </button>
                          </>
                        )}
                        {!canReverse || row.status === "reversed" ? null : (
                          <button onClick={() => setReverseTarget(row)} type="button">
                            {t("traderReceivables.actionReverse")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {collectionRows.length === 0 ? (
                    <tr>
                      <td className="empty-state" colSpan={11}>
                        {t("traderReceivables.noCollections")}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <nav aria-label={t("common.pagination")} className="pagination">
              <button
                disabled={collectionPage <= 1}
                onClick={() => setCollectionPage(collectionPage - 1)}
                type="button"
              >
                {t("common.previous")}
              </button>
              <span>{t("common.pageOf", { page: collectionPage, pageCount: collectionPageCount })}</span>
              <button
                disabled={collectionPage >= collectionPageCount}
                onClick={() => setCollectionPage(collectionPage + 1)}
                type="button"
              >
                {t("common.next")}
              </button>
            </nav>
          </section>
        </>
      )}

      {!newReceivableOpen ? null : (
        <NewReceivableDialog
          api={api}
          onClose={() => setNewReceivableOpen(false)}
          onCreated={(receivableId) => {
            setNewReceivableOpen(false);
            refreshAll();
            setReceivableDetailId(receivableId);
          }}
        />
      )}

      {!collectMoneyOpen ? null : (
        <CollectMoneyDialog
          api={api}
          {...(collectMoneyPresetTraderId === undefined ? {} : { initialTraderId: collectMoneyPresetTraderId })}
          onClose={() => setCollectMoneyOpen(false)}
          onCollected={(collectionId) => {
            setCollectMoneyOpen(false);
            refreshAll();
            setCollectionDetailId(collectionId);
          }}
          reportLanguage={reportLanguage}
        />
      )}

      {receivableDetailId === undefined ? null : (
        <ReceivableDetailDialog
          api={api}
          onClose={() => setReceivableDetailId(undefined)}
          onCollectMoney={(traderId) => {
            setReceivableDetailId(undefined);
            openCollectMoney(traderId);
          }}
          receivableId={receivableDetailId}
        />
      )}

      {collectionDetailId === undefined ? null : (
        <CollectionDetailDialog
          api={api}
          canReverse={canReverse}
          canViewReport={canViewReport}
          collectionId={collectionDetailId}
          onClose={() => setCollectionDetailId(undefined)}
          onReversed={() => {
            setCollectionDetailId(undefined);
            refreshAll();
          }}
          reportLanguage={reportLanguage}
        />
      )}

      {cancelTarget === undefined ? null : (
        <CancelReceivableDialog
          api={api}
          onCancelled={refreshAll}
          onClose={() => setCancelTarget(undefined)}
          receivable={cancelTarget}
        />
      )}

      {reverseTarget === undefined ? null : (
        <ReverseCollectionDialog
          api={api}
          collection={reverseTarget}
          onClose={() => setReverseTarget(undefined)}
          onReversed={refreshAll}
        />
      )}
    </>
  );
}

function SummaryCards({ summary }: { summary: TraderReceivableSummary }) {
  const { t } = useTranslation();
  const primaryCards: readonly { label: string; value: string }[] = [
    { label: t("traderReceivables.summaryTotalOutstanding"), value: money(summary.totalOutstandingReceivables) },
    { label: t("traderReceivables.summaryPartiallyCollected"), value: money(summary.partiallyCollectedAmount) },
    { label: t("traderReceivables.summaryCollectedThisPeriod"), value: money(summary.collectedThisPeriod) },
    { label: t("traderReceivables.summaryTotalRemainingDue"), value: money(summary.totalRemainingDue) },
  ];
  const secondaryCards: readonly { label: string; value: string }[] = [
    { label: t("traderReceivables.summaryOutstandingCount"), value: String(summary.outstandingReceivablesCount) },
    {
      label: t("traderReceivables.summaryTradersOutstanding"),
      value: String(summary.tradersWithOutstandingReceivables),
    },
    { label: t("traderReceivables.summaryReversedCollections"), value: String(summary.reversedCollections) },
  ];
  return (
    <>
      <div className="summary-primary" data-testid="trader-receivables-summary">
        {primaryCards.map((card) => (
          <article className="kpi-card" key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </article>
        ))}
      </div>
      <div className="summary-secondary" data-testid="trader-receivables-summary-secondary">
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

function ReceivableFilterBar({
  api,
  filters,
  onChange,
  onClear,
}: {
  api: ApiClient;
  filters: ReceivableFilters;
  onChange: (change: Partial<ReceivableFilters>) => void;
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
    <section aria-label={t("traderReceivables.pageTitle")}>
      <div className="compact-filters">
        <label className="field">
          <span>{t("traderReceivables.filterTrader")}</span>
          <select onChange={(event) => onChange({ traderId: event.target.value })} value={filters.traderId}>
            <option value="">{t("common.all")}</option>
            {traders.map((trader) => (
              <option key={trader.id} value={trader.id}>
                {trader.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("traderReceivables.filterReceivableNumber")}</span>
          <input
            onChange={(event) => onChange({ receivableNumber: event.target.value })}
            type="search"
            value={filters.receivableNumber}
          />
        </label>
        <label className="field">
          <span>{t("traderReceivables.filterSourceType")}</span>
          <select onChange={(event) => onChange({ sourceType: event.target.value })} value={filters.sourceType}>
            <option value="">{t("common.all")}</option>
            {sourceTypes.map((type) => (
              <option key={type} value={type}>
                {sourceTypeLabel(t, type)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("traderReceivables.filterSourceReference")}</span>
          <input
            onChange={(event) => onChange({ sourceReference: event.target.value })}
            type="search"
            value={filters.sourceReference}
          />
        </label>
        <label className="field">
          <span>{t("traderReceivables.filterStatus")}</span>
          <select onChange={(event) => onChange({ status: event.target.value })} value={filters.status}>
            <option value="">{t("traderReceivables.statusAll")}</option>
            {receivableStatuses.map((status) => (
              <option key={status} value={status}>
                {receivableStatusLabel(t, status)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("traderReceivables.filterBusinessDateFrom")}</span>
          <input
            onChange={(event) => onChange({ businessDateFrom: event.target.value })}
            type="date"
            value={filters.businessDateFrom}
          />
        </label>
        <label className="field">
          <span>{t("traderReceivables.filterBusinessDateTo")}</span>
          <input
            onChange={(event) => onChange({ businessDateTo: event.target.value })}
            type="date"
            value={filters.businessDateTo}
          />
        </label>
        <label className="field field-checkbox">
          <input
            checked={filters.outstandingOnly}
            onChange={(event) => onChange({ outstandingOnly: event.target.checked })}
            type="checkbox"
          />
          <span>{t("traderReceivables.filterOutstandingOnly")}</span>
        </label>
        <div className="filter-actions">
          <button className="button button-secondary" onClick={onClear} type="button">
            {t("traderReceivables.clearFilters")}
          </button>
        </div>
      </div>
    </section>
  );
}

function CollectionFilterBar({
  api,
  filters,
  onChange,
  onClear,
}: {
  api: ApiClient;
  filters: CollectionFilters;
  onChange: (change: Partial<CollectionFilters>) => void;
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
    <section aria-label={t("traderReceivables.tabCollections")}>
      <div className="compact-filters">
        <label className="field">
          <span>{t("traderReceivables.filterTrader")}</span>
          <select onChange={(event) => onChange({ traderId: event.target.value })} value={filters.traderId}>
            <option value="">{t("common.all")}</option>
            {traders.map((trader) => (
              <option key={trader.id} value={trader.id}>
                {trader.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("traderReceivables.filterCollectionNumber")}</span>
          <input
            onChange={(event) => onChange({ collectionNumber: event.target.value })}
            type="search"
            value={filters.collectionNumber}
          />
        </label>
        <label className="field">
          <span>{t("traderReceivables.filterPaymentMethod")}</span>
          <select
            onChange={(event) => onChange({ paymentMethod: event.target.value })}
            value={filters.paymentMethod}
          >
            <option value="">{t("common.all")}</option>
            <option value="cash">{t("traderReceivables.paymentMethodCash")}</option>
            <option value="bank_transfer">{t("traderReceivables.paymentMethodBankTransfer")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("traderReceivables.filterCollectionStatus")}</span>
          <select onChange={(event) => onChange({ status: event.target.value })} value={filters.status}>
            <option value="">{t("traderReceivables.statusAll")}</option>
            <option value="confirmed">{t("traderReceivables.statusConfirmed")}</option>
            <option value="reversed">{t("traderReceivables.statusReversed")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("traderReceivables.filterPaymentDateFrom")}</span>
          <input
            onChange={(event) => onChange({ paymentDateFrom: event.target.value })}
            type="date"
            value={filters.paymentDateFrom}
          />
        </label>
        <label className="field">
          <span>{t("traderReceivables.filterPaymentDateTo")}</span>
          <input
            onChange={(event) => onChange({ paymentDateTo: event.target.value })}
            type="date"
            value={filters.paymentDateTo}
          />
        </label>
        <label className="field">
          <span>{t("traderReceivables.filterPaymentReference")}</span>
          <input
            onChange={(event) => onChange({ paymentReference: event.target.value })}
            type="search"
            value={filters.paymentReference}
          />
        </label>
        <label className="field">
          <span>{t("traderReceivables.filterReceivableNumber")}</span>
          <input
            onChange={(event) => onChange({ receivableNumber: event.target.value })}
            type="search"
            value={filters.receivableNumber}
          />
        </label>
        <div className="filter-actions">
          <button className="button button-secondary" onClick={onClear} type="button">
            {t("traderReceivables.clearFilters")}
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// New Receivable
// ---------------------------------------------------------------------------

function NewReceivableDialog({
  api,
  onClose,
  onCreated,
}: {
  api: ApiClient;
  onClose: () => void;
  onCreated: (receivableId: string) => void;
}) {
  const { t } = useTranslation();
  const [traders, setTraders] = useState<readonly OperationsTrader[]>([]);
  const [traderId, setTraderId] = useState("");
  const [sourceType, setSourceType] = useState<(typeof sourceTypes)[number] | "">("");
  const [sourceReference, setSourceReference] = useState("");
  const [businessDate, setBusinessDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amountDue, setAmountDue] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<CreateTraderReceivableResult>();
  const idempotency = useIdempotencyKey();

  useEffect(() => {
    void api
      .get<readonly OperationsTrader[]>("operations/traders")
      .then((rows) => setTraders(rows.filter((row) => row.status === "active")))
      .catch(() => setTraders([]));
  }, [api]);

  const parsedAmountDue = parseMoneyInput(amountDue, { allowZero: false });
  const canSubmit =
    traderId !== "" &&
    sourceType !== "" &&
    businessDate.trim() !== "" &&
    parsedAmountDue.ok &&
    reason.trim() !== "" &&
    !saving;

  const fingerprint = JSON.stringify({
    amountDue: money(amountDue),
    businessDate,
    notes: notes.trim(),
    reason: reason.trim(),
    sourceReference: sourceReference.trim(),
    sourceType,
    traderId,
  });

  const confirm = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await api.post<CreateTraderReceivableResult>(
        "operations/trader-receivables/receivables",
        {
          amountDue: parsedAmountDue.ok ? parsedAmountDue.value : 0,
          businessDate,
          notes: notes.trim() === "" ? undefined : notes.trim(),
          reason: reason.trim(),
          sourceReference: sourceReference.trim() === "" ? undefined : sourceReference.trim(),
          sourceType,
          traderId,
        },
        { "X-Idempotency-Key": idempotency.keyFor(fingerprint) },
      );
      setCreated(result);
      idempotency.reset();
    } catch (submitError) {
      setError(message(submitError, t("traderReceivables.receivableFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("traderReceivables.newReceivable")}
      titleId="new-receivable-title"
    >
      {created !== undefined ? (
        <div className="reconciliation-success" role="status">
          <p>{t("traderReceivables.receivableCreated", { number: created.receivableNumber })}</p>
          <dl className="reconciliation-summary">
            <div className="detail-line">
              <dt>{t("traderReceivables.columnReceivableNumber")}</dt>
              <dd>{created.receivableNumber}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.fieldTrader")}</dt>
              <dd>{created.traderName}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.fieldSourceType")}</dt>
              <dd>{sourceTypeLabel(t, created.sourceType)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.fieldAmountDue")}</dt>
              <dd>{money(created.amountDue)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.fieldBusinessDate")}</dt>
              <dd>{created.businessDate}</dd>
            </div>
          </dl>
          <div className="modal-actions">
            <button
              className="button button-secondary"
              onClick={() => onCreated(created.receivableId)}
              type="button"
            >
              {t("traderReceivables.viewReceivable")}
            </button>
            <button className="button button-primary" onClick={() => onCreated(created.receivableId)} type="button">
              {t("common.close")}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={(event) => void (event.preventDefault(), confirm())}>
          {error === undefined ? null : (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}
          <label className="field required-field">
            <span>{t("traderReceivables.fieldTrader")}</span>
            <select onChange={(event) => setTraderId(event.target.value)} value={traderId}>
              <option value="">{t("common.select")}</option>
              {traders.map((trader) => (
                <option key={trader.id} value={trader.id}>
                  {trader.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field required-field">
            <span>{t("traderReceivables.fieldSourceType")}</span>
            <select
              onChange={(event) => setSourceType(event.target.value as (typeof sourceTypes)[number])}
              value={sourceType}
            >
              <option value="">{t("traderReceivables.selectSourceType")}</option>
              {sourceTypes.map((type) => (
                <option key={type} value={type}>
                  {sourceTypeLabel(t, type)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("traderReceivables.fieldSourceReference")}</span>
            <input
              onChange={(event) => setSourceReference(event.target.value)}
              type="text"
              value={sourceReference}
            />
          </label>
          <label className="field required-field">
            <span>{t("traderReceivables.fieldBusinessDate")}</span>
            <input onChange={(event) => setBusinessDate(event.target.value)} type="date" value={businessDate} />
          </label>
          <label className="field required-field">
            <span>{t("traderReceivables.fieldAmountDue")}</span>
            <input
              inputMode="decimal"
              min="0.01"
              onChange={(event) => setAmountDue(event.target.value)}
              step="0.01"
              type="number"
              value={amountDue}
            />
          </label>
          <label className="field required-field">
            <span>{t("traderReceivables.fieldReason")}</span>
            <textarea onChange={(event) => setReason(event.target.value)} value={reason} />
          </label>
          <label className="field">
            <span>{t("traderReceivables.fieldNotes")}</span>
            <textarea onChange={(event) => setNotes(event.target.value)} value={notes} />
          </label>
          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button className="button button-primary" disabled={!canSubmit} type="submit">
              {saving ? t("common.saving") : t("traderReceivables.confirmCreateReceivable")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Cancel receivable
// ---------------------------------------------------------------------------

function CancelReceivableDialog({
  api,
  onCancelled,
  onClose,
  receivable,
}: {
  api: ApiClient;
  onCancelled: () => void;
  onClose: () => void;
  receivable: Pick<TraderReceivableEligibleRow, "id" | "originalAmountDue" | "receivableNumber" | "status" | "traderName">;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [cancelled, setCancelled] = useState(false);

  const submit = async () => {
    if (reason.trim() === "" || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await api.post(`operations/trader-receivables/receivables/${receivable.id}/cancel`, {
        reason: reason.trim(),
      });
      onCancelled();
      setCancelled(true);
    } catch (submitError) {
      setError(message(submitError, t("traderReceivables.receivableFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("traderReceivables.cancelReceivableTitle")}
      titleId="cancel-receivable-title"
    >
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <dl className="reconciliation-summary">
        <div className="detail-line">
          <dt>{t("traderReceivables.columnReceivableNumber")}</dt>
          <dd>{receivable.receivableNumber}</dd>
        </div>
        <div className="detail-line">
          <dt>{t("traderReceivables.fieldTrader")}</dt>
          <dd>{receivable.traderName}</dd>
        </div>
        <div className="detail-line">
          <dt>{t("traderReceivables.fieldAmountDue")}</dt>
          <dd>{money(receivable.originalAmountDue)}</dd>
        </div>
        <div className="detail-line">
          <dt>{t("common.status")}</dt>
          <dd>{receivableStatusLabel(t, receivable.status)}</dd>
        </div>
      </dl>
      {cancelled ? (
        <div className="reconciliation-success" role="status">
          <p>{t("traderReceivables.receivableCancelled", { number: receivable.receivableNumber })}</p>
          <div className="modal-actions">
            <button className="button button-primary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="field-hint">{t("traderReceivables.cancelWarning")}</p>
          <form onSubmit={(event) => void (event.preventDefault(), submit())}>
            <label className="field required-field">
              <span>{t("common.reason")}</span>
              <textarea onChange={(event) => setReason(event.target.value)} value={reason} />
            </label>
            <div className="modal-actions">
              <button className="button button-secondary" onClick={onClose} type="button">
                {t("common.cancel")}
              </button>
              <button className="button button-primary" disabled={saving || reason.trim() === ""} type="submit">
                {saving ? t("common.saving") : t("traderReceivables.confirmCancel")}
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Receivable detail
// ---------------------------------------------------------------------------

function ReceivableDetailDialog({
  api,
  onClose,
  onCollectMoney,
  receivableId,
}: {
  api: ApiClient;
  onClose: () => void;
  onCollectMoney: (traderId: string) => void;
  receivableId: string;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<TraderReceivableDetail>();
  const [error, setError] = useState<string>();
  const [cancelOpen, setCancelOpen] = useState(false);

  const load = useCallback(() => {
    setError(undefined);
    void api
      .get<TraderReceivableDetail>(`operations/trader-receivables/receivables/${receivableId}`)
      .then(setDetail)
      .catch(() => setError(t("traderReceivables.detailLoadFailed")));
  }, [api, receivableId, t]);

  useEffect(() => load(), [load]);

  const collectible = detail?.status === "outstanding" || detail?.status === "partially_collected";

  return (
    <Modal
      className="modal-wide"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("traderReceivables.receivableDetailTitle")}
      titleId="receivable-detail-title"
    >
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {detail === undefined ? (
        error === undefined ? <div className="loading-row">{t("common.loading")}</div> : null
      ) : (
        <>
          <dl className="reconciliation-summary">
            <div className="detail-line">
              <dt>{t("traderReceivables.columnReceivableNumber")}</dt>
              <dd>{detail.receivableNumber}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.fieldTrader")}</dt>
              <dd>{detail.traderName}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.columnSourceType")}</dt>
              <dd>{sourceTypeLabel(t, detail.sourceType)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.columnSourceReference")}</dt>
              <dd>{detail.sourceReference ?? "-"}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.columnBusinessDate")}</dt>
              <dd>{detail.businessDate.slice(0, 10)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.columnOriginalAmountDue")}</dt>
              <dd>{money(detail.originalAmountDue)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.columnPreviouslyCollected")}</dt>
              <dd>{money(detail.amountCollected)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.columnOutstandingAmount")}</dt>
              <dd>{money(detail.outstandingAmount)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("common.status")}</dt>
              <dd>{receivableStatusLabel(t, detail.status)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.columnReason")}</dt>
              <dd>{detail.reason}</dd>
            </div>
            {detail.notes === null ? null : (
              <div className="detail-line">
                <dt>{t("traderReceivables.fieldNotes")}</dt>
                <dd>{detail.notes}</dd>
              </div>
            )}
            <div className="detail-line">
              <dt>{t("traderReceivables.createdBy")}</dt>
              <dd>{detail.createdBy}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.createdDate")}</dt>
              <dd>{detail.createdAt.slice(0, 16).replace("T", " ")}</dd>
            </div>
            {detail.cancelledAt === null ? null : (
              <div className="detail-line">
                <dt>{t("traderReceivables.cancelledDate")}</dt>
                <dd>{detail.cancelledAt.slice(0, 16).replace("T", " ")}</dd>
              </div>
            )}
            {detail.cancelledReason === null ? null : (
              <div className="detail-line">
                <dt>{t("traderReceivables.cancelledReason")}</dt>
                <dd>{detail.cancelledReason}</dd>
              </div>
            )}
          </dl>

          <section aria-labelledby="receivable-collection-history-heading">
            <h3 id="receivable-collection-history-heading">{t("traderReceivables.collectionHistory")}</h3>
            {detail.collections.length === 0 ? (
              <p className="empty-state">{t("traderReceivables.noCollectionHistory")}</p>
            ) : (
              <div className="table-scroll-x">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t("traderReceivables.columnCollectionNumber")}</th>
                      <th scope="col">{t("traderReceivables.columnPaymentDate")}</th>
                      <th scope="col">{t("traderReceivables.amountCollectedNow")}</th>
                      <th scope="col">{t("common.status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.collections.map((line) => (
                      <tr key={line.collectionId}>
                        <td className="mono">{line.collectionNumber}</td>
                        <td>{line.collectionDate.slice(0, 10)}</td>
                        <td>{money(line.amountCollected)}</td>
                        <td>
                          {t(
                            line.status === "reversed"
                              ? "traderReceivables.statusReversed"
                              : "traderReceivables.statusConfirmed",
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="modal-actions">
            {!collectible ? null : (
              <button onClick={() => onCollectMoney(detail.traderId)} type="button">
                {t("traderReceivables.actionCollectMoney")}
              </button>
            )}
            {detail.status !== "outstanding" ? null : (
              <button onClick={() => setCancelOpen(true)} type="button">
                {t("traderReceivables.actionCancel")}
              </button>
            )}
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </>
      )}

      {!cancelOpen || detail === undefined ? null : (
        <CancelReceivableDialog
          api={api}
          onCancelled={() => {
            setCancelOpen(false);
            load();
          }}
          onClose={() => setCancelOpen(false)}
          receivable={{
            id: detail.receivableId,
            originalAmountDue: detail.originalAmountDue,
            receivableNumber: detail.receivableNumber,
            status: detail.status,
            traderName: detail.traderName,
          }}
        />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Collect Money from Trader guided workflow: Select Trader -> Outstanding
// Receivables -> Amount and Allocation -> Payment Details -> Review -> Confirm
// -> Success.
// ---------------------------------------------------------------------------

const emptyOutstandingFilters = {
  businessDateFrom: "",
  businessDateTo: "",
  outstandingOnly: false,
  receivableNumber: "",
  sourceReference: "",
  sourceType: "",
  status: "",
};

type OutstandingFilters = typeof emptyOutstandingFilters;

function CollectMoneyDialog({
  api,
  initialTraderId,
  onClose,
  onCollected,
  reportLanguage,
}: {
  api: ApiClient;
  initialTraderId?: string;
  onClose: () => void;
  onCollected: (collectionId: string) => void;
  reportLanguage: "ar" | "en";
}) {
  const { t } = useTranslation();

  // Step 1 — Trader.
  const [traderSearch, setTraderSearch] = useState("");
  const [tradersWithBalance, setTradersWithBalance] = useState<readonly TraderWithBalance[]>();
  const [trader, setTrader] = useState<TraderWithBalance>();

  // Step 2 — Outstanding receivables (server-paginated, filterable).
  const [outstandingPage, setOutstandingPage] = useState<PagedResponse<TraderReceivableEligibleRow>>();
  const [outstandingError, setOutstandingError] = useState<string>();
  const [outstandingFilters, setOutstandingFilters] = useState<OutstandingFilters>(emptyOutstandingFilters);
  const [outstandingPageIndex, setOutstandingPageIndex] = useState(1);
  const outstandingRows = outstandingPage?.items ?? [];
  const outstandingTotal = outstandingPage?.total ?? 0;
  const outstandingPageCount = outstandingTotal === 0 ? 1 : Math.ceil(outstandingTotal / 50);

  // Step 3 — Amount and allocation proposal.
  const [amount, setAmount] = useState("");
  const [proposal, setProposal] = useState<TraderAllocationProposal>();
  const [proposalError, setProposalError] = useState<string>();
  const [allocations, setAllocations] = useState<readonly { amount: string; receivableId: string }[]>([]);

  // Step 4 — Payment details.
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [paymentMethod, setPaymentMethod] = useState<"bank_transfer" | "cash">("cash");
  const [companyBanks, setCompanyBanks] = useState<readonly CompanyBankAccount[]>([]);
  const [bankAccountId, setBankAccountId] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [notes, setNotes] = useState("");

  const [saving, setSaving] = useState(false);
  const [confirmError, setConfirmError] = useState<string>();
  const [confirmed, setConfirmed] = useState<CreateTraderCollectionResult>();
  const idempotency = useIdempotencyKey();
  const pdf = useReconciliationPdfActions(api);
  const [pdfError, setPdfError] = useState<string>();

  useEffect(() => {
    void api
      .get<readonly TraderWithBalance[]>("operations/trader-receivables/traders-with-balance")
      .then(setTradersWithBalance)
      .catch(() => setTradersWithBalance([]));
  }, [api]);

  useEffect(() => {
    if (initialTraderId === undefined || tradersWithBalance === undefined) return;
    const preset = tradersWithBalance.find((row) => row.traderId === initialTraderId);
    if (preset !== undefined) setTrader(preset);
    // Only ever auto-select once, when the preset Trader first appears.
  }, [tradersWithBalance, initialTraderId]);

  const loadOutstanding = useCallback(() => {
    if (trader === undefined) return;
    setOutstandingError(undefined);
    const params = filterQuery(outstandingFilters);
    params.set("traderId", trader.traderId);
    params.set("page", String(outstandingPageIndex));
    params.set("pageSize", "50");
    void api
      .get<PagedResponse<TraderReceivableEligibleRow>>(
        `operations/trader-receivables/eligible?${params.toString()}`,
      )
      .then(setOutstandingPage)
      .catch(() => setOutstandingError(t("common.loadFailed")));
  }, [api, trader, outstandingFilters, outstandingPageIndex, t]);

  useEffect(() => loadOutstanding(), [loadOutstanding]);

  const applyOutstandingFilter = (change: Partial<OutstandingFilters>) => {
    setOutstandingPageIndex(1);
    setOutstandingFilters((current) => ({ ...current, ...change }));
  };
  const clearOutstandingFilters = () => {
    setOutstandingPageIndex(1);
    setOutstandingFilters(emptyOutstandingFilters);
  };

  useEffect(() => {
    if (trader === undefined) {
      setCompanyBanks([]);
      return;
    }
    void api
      .get<readonly CompanyBankAccount[]>("configuration/bank-accounts")
      .then((accounts) => {
        const active = accounts.filter((account) => account.isActive);
        setCompanyBanks(active);
        setBankAccountId((current) =>
          current !== "" && active.some((account) => account.id === current)
            ? current
            : (active[0]?.id ?? ""),
        );
      })
      .catch(() => setCompanyBanks([]));
  }, [api, trader]);

  const chooseTrader = (next: TraderWithBalance) => {
    if (allocations.length > 0 && trader !== undefined && trader.traderId !== next.traderId) {
      if (!window.confirm(t("traderReceivables.changeTraderWarning"))) return;
    }
    setTrader(next);
    setAmount("");
    setProposal(undefined);
    setAllocations([]);
    setPaymentReference("");
    setOutstandingFilters(emptyOutstandingFilters);
    setOutstandingPageIndex(1);
    idempotency.reset();
  };

  // Debounced oldest-first allocation proposal: fires whenever Amount
  // Received (a valid positive number) changes — the backend is always the
  // source of truth for allocation, never a client-side computation.
  useEffect(() => {
    const parsed = parseMoneyInput(amount, { allowZero: false });
    if (trader === undefined || !parsed.ok) {
      setProposal(undefined);
      setAllocations([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void api
        .post<TraderAllocationProposal>("operations/trader-receivables/allocation-proposal", {
          amount: parsed.value,
          traderId: trader.traderId,
        })
        .then((result) => {
          if (!active) return;
          setProposal(result);
          setProposalError(undefined);
          setAllocations(
            result.allocations
              .filter((line) => safeMoneyValue(line.proposedAmount) > 0)
              .map((line) => ({ amount: line.proposedAmount, receivableId: line.receivableId })),
          );
        })
        .catch((error: unknown) => {
          if (!active) return;
          setProposal(undefined);
          setAllocations([]);
          setProposalError(message(error, t("traderReceivables.collectionFailed")));
        });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, amount, trader, t]);

  const proposalLineById = useMemo(
    () => new Map((proposal?.allocations ?? []).map((line) => [line.receivableId, line])),
    [proposal],
  );

  const setLineAmount = (receivableId: string, value: string) => {
    setAllocations((current) => {
      const existing = current.find((line) => line.receivableId === receivableId);
      if (existing === undefined) return [...current, { amount: value, receivableId }];
      return current.map((line) =>
        line.receivableId === receivableId ? { ...line, amount: value } : line,
      );
    });
  };

  const parsedRequestedAmount = parseMoneyInput(amount, { allowZero: false });
  const allocatedTotal = allocations.reduce((sum, line) => {
    const parsed = parseMoneyInput(line.amount);
    return sum + (parsed.ok ? parsed.value : 0);
  }, 0);
  const requestedAmount = parsedRequestedAmount.ok ? parsedRequestedAmount.value : 0;
  const unallocated = money(requestedAmount - allocatedTotal);
  const allocationErrors: string[] = [];
  const seenReceivables = new Set<string>();
  for (const line of allocations) {
    if (seenReceivables.has(line.receivableId)) {
      allocationErrors.push(t("traderReceivables.allocationDuplicateReceivable"));
    }
    seenReceivables.add(line.receivableId);
    const parsedLineAmount = parseMoneyInput(line.amount);
    const lineAmount = parsedLineAmount.ok ? parsedLineAmount.value : 0;
    if (!parsedLineAmount.ok) allocationErrors.push(t("traderReceivables.invalidAmount"));
    if (lineAmount < 0) allocationErrors.push(t("traderReceivables.allocationNegative"));
    const proposedLine = proposalLineById.get(line.receivableId);
    if (proposedLine !== undefined && lineAmount > safeMoneyValue(proposedLine.outstandingBefore) + 0.001) {
      allocationErrors.push(t("traderReceivables.allocationExceedsOutstanding"));
    }
  }
  if (!parsedRequestedAmount.ok && amount.trim() !== "") {
    allocationErrors.push(t("traderReceivables.invalidAmount"));
  } else if (amount.trim() !== "" && Math.abs(safeMoneyValue(unallocated)) > 0.005) {
    allocationErrors.push(t("traderReceivables.allocationTotalMismatch"));
  }

  const activeAllocations = allocations.filter((line) => {
    const parsed = parseMoneyInput(line.amount, { allowZero: false });
    return parsed.ok;
  });
  const remainingDueAfter = (proposal?.allocations ?? []).reduce((sum, line) => {
    const current = allocations.find((row) => row.receivableId === line.receivableId)?.amount;
    const paidNow = current === undefined ? safeMoneyValue(line.proposedAmount) : safeMoneyValue(current);
    return sum + Math.max(0, safeMoneyValue(line.outstandingBefore) - paidNow);
  }, 0);

  const canProceedToReview =
    trader !== undefined &&
    requestedAmount > 0 &&
    activeAllocations.length > 0 &&
    allocationErrors.length === 0 &&
    (paymentMethod === "cash" || (bankAccountId !== "" && paymentReference.trim() !== ""));

  const fingerprint = JSON.stringify({
    allocations: [...activeAllocations].sort((left, right) =>
      left.receivableId.localeCompare(right.receivableId),
    ),
    amountReceived: money(requestedAmount),
    bankAccountId,
    notes: notes.trim(),
    paymentDate,
    paymentMethod,
    paymentReference: paymentReference.trim(),
    traderId: trader?.traderId,
  });

  const confirm = async () => {
    if (!canProceedToReview || saving || trader === undefined) return;
    setSaving(true);
    setConfirmError(undefined);
    try {
      const result = await api.post<CreateTraderCollectionResult>(
        "operations/trader-receivables/collections",
        {
          allocations: activeAllocations.map((line) => ({
            amount: safeMoneyValue(line.amount),
            receivableId: line.receivableId,
          })),
          amountReceived: requestedAmount,
          ...(paymentMethod === "bank_transfer"
            ? { bankAccountId, paymentReference: paymentReference.trim() }
            : {}),
          notes: notes.trim() === "" ? undefined : notes.trim(),
          paymentDate,
          paymentMethod,
          traderId: trader.traderId,
        },
        { "X-Idempotency-Key": idempotency.keyFor(fingerprint) },
      );
      setConfirmed(result);
      idempotency.reset();
    } catch (error) {
      setConfirmError(message(error, t("traderReceivables.collectionFailed")));
    } finally {
      setSaving(false);
    }
  };

  const openConfirmedPdf = async (mode: PdfAction) => {
    if (confirmed === undefined) return;
    setPdfError(undefined);
    const requestError = await pdf.run(
      `operations/trader-receivables/collections/${confirmed.collectionId}/pdf?language=${reportLanguage}`,
      `Trader-Receipt-${confirmed.collectionNumber}.pdf`,
      mode,
    );
    if (requestError !== undefined) setPdfError(message(requestError, t("traderReceivables.pdfGenerationFailed")));
  };

  const filteredTraders = (tradersWithBalance ?? []).filter((row) =>
    traderSearch.trim() === "" ? true : row.traderName.toLowerCase().includes(traderSearch.trim().toLowerCase()),
  );

  return (
    <Modal
      className="modal-wide"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("traderReceivables.collectMoneyTitle")}
      titleId="collect-money-title"
    >
      {confirmed !== undefined ? (
        <div className="reconciliation-success" role="status">
          <p>{t("traderReceivables.collectionConfirmed", { number: confirmed.collectionNumber })}</p>
          <dl className="reconciliation-summary">
            <div className="detail-line">
              <dt>{t("traderReceivables.columnCollectionNumber")}</dt>
              <dd>{confirmed.collectionNumber}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.fieldTrader")}</dt>
              <dd>{confirmed.traderName}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.reviewPaymentDate")}</dt>
              <dd>{confirmed.paymentDate}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.reviewPaymentMethod")}</dt>
              <dd>
                {t(
                  confirmed.paymentMethod === "cash"
                    ? "traderReceivables.paymentMethodCash"
                    : "traderReceivables.paymentMethodBankTransfer",
                )}
              </dd>
            </div>
            {confirmed.paymentMethod !== "bank_transfer" ? null : (
              <div className="detail-line">
                <dt>{t("traderReceivables.reviewPaymentReference")}</dt>
                <dd>{paymentReference}</dd>
              </div>
            )}
            <div className="detail-line">
              <dt>{t("traderReceivables.columnAmountReceived")}</dt>
              <dd>{money(confirmed.amountReceived)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.reviewReceivableCount")}</dt>
              <dd>{confirmed.receivableCount}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.reviewTotalRemainingDue")}</dt>
              <dd>{money(confirmed.remainingDue)}</dd>
            </div>
          </dl>
          {pdfError === undefined ? null : (
            <div className="alert alert-error" role="alert">
              {pdfError}
            </div>
          )}
          <div className="modal-actions">
            <button disabled={pdf.busy !== undefined} onClick={() => void openConfirmedPdf("preview")} type="button">
              {pdf.busy === "preview" ? t("common.loading") : t("traderReceivables.actionPreviewReceipt")}
            </button>
            <button disabled={pdf.busy !== undefined} onClick={() => void openConfirmedPdf("print")} type="button">
              {pdf.busy === "print" ? t("common.loading") : t("traderReceivables.actionPrint")}
            </button>
            <button disabled={pdf.busy !== undefined} onClick={() => void openConfirmedPdf("download")} type="button">
              {pdf.busy === "download" ? t("common.loading") : t("traderReceivables.actionDownloadPdf")}
            </button>
            <button
              className="button button-secondary"
              onClick={() => onCollected(confirmed.collectionId)}
              type="button"
            >
              {t("traderReceivables.viewCollection")}
            </button>
            <button className="button button-primary" onClick={() => onCollected(confirmed.collectionId)} type="button">
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
            <h3>{t("traderReceivables.stepSelectTrader")}</h3>
            {trader === undefined ? (
              <>
                <label className="field">
                  <span>{t("traderReceivables.searchTraders")}</span>
                  <input
                    onChange={(event) => setTraderSearch(event.target.value)}
                    placeholder={t("traderReceivables.searchTraders")}
                    type="search"
                    value={traderSearch}
                  />
                </label>
                <ul className="option-list">
                  {filteredTraders.map((option) => (
                    <li key={option.traderId}>
                      <button onClick={() => chooseTrader(option)} type="button">
                        {option.traderName} —{" "}
                        {t("traderReceivables.traderBalanceDue", { amount: money(option.outstandingAmount) })}
                      </button>
                    </li>
                  ))}
                  {filteredTraders.length === 0 ? (
                    <li className="empty-state">{t("traderReceivables.noTradersWithBalance")}</li>
                  ) : null}
                </ul>
              </>
            ) : (
              <div className="detail-line">
                <span>{trader.traderName}</span>
                <button onClick={() => setTrader(undefined)} type="button">
                  {t("common.change")}
                </button>
              </div>
            )}
          </section>

          {trader === undefined ? null : (
            <>
              {/* Step 2 — Outstanding Receivables */}
              <section className="workspace-step">
                <h3>{t("traderReceivables.stepOutstandingReceivables")}</h3>
                {outstandingError === undefined ? null : <div className="alert alert-error">{outstandingError}</div>}
                <div className="compact-filters">
                  <label className="field">
                    <span>{t("traderReceivables.filterReceivableNumber")}</span>
                    <input
                      onChange={(event) => applyOutstandingFilter({ receivableNumber: event.target.value })}
                      type="search"
                      value={outstandingFilters.receivableNumber}
                    />
                  </label>
                  <label className="field">
                    <span>{t("traderReceivables.filterSourceType")}</span>
                    <select
                      onChange={(event) => applyOutstandingFilter({ sourceType: event.target.value })}
                      value={outstandingFilters.sourceType}
                    >
                      <option value="">{t("common.all")}</option>
                      {sourceTypes.map((type) => (
                        <option key={type} value={type}>
                          {sourceTypeLabel(t, type)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{t("traderReceivables.filterSourceReference")}</span>
                    <input
                      onChange={(event) => applyOutstandingFilter({ sourceReference: event.target.value })}
                      type="search"
                      value={outstandingFilters.sourceReference}
                    />
                  </label>
                  <label className="field">
                    <span>{t("traderReceivables.filterBusinessDateFrom")}</span>
                    <input
                      onChange={(event) => applyOutstandingFilter({ businessDateFrom: event.target.value })}
                      type="date"
                      value={outstandingFilters.businessDateFrom}
                    />
                  </label>
                  <label className="field">
                    <span>{t("traderReceivables.filterBusinessDateTo")}</span>
                    <input
                      onChange={(event) => applyOutstandingFilter({ businessDateTo: event.target.value })}
                      type="date"
                      value={outstandingFilters.businessDateTo}
                    />
                  </label>
                  <label className="field field-checkbox">
                    <input
                      checked={outstandingFilters.outstandingOnly}
                      onChange={(event) => applyOutstandingFilter({ outstandingOnly: event.target.checked })}
                      type="checkbox"
                    />
                    <span>{t("traderReceivables.filterOutstandingOnly")}</span>
                  </label>
                  <div className="filter-actions">
                    <button className="button button-secondary" onClick={clearOutstandingFilters} type="button">
                      {t("traderReceivables.clearFilters")}
                    </button>
                  </div>
                </div>
                <div className="table-scroll-x">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{t("traderReceivables.columnReceivableNumber")}</th>
                        <th scope="col">{t("traderReceivables.columnBusinessDate")}</th>
                        <th scope="col">{t("traderReceivables.columnSourceType")}</th>
                        <th scope="col">{t("traderReceivables.columnSourceReference")}</th>
                        <th scope="col">{t("traderReceivables.columnReason")}</th>
                        <th scope="col">{t("traderReceivables.columnOriginalAmountDue")}</th>
                        <th scope="col">{t("traderReceivables.columnPreviouslyCollected")}</th>
                        <th scope="col">{t("traderReceivables.columnOutstandingAmount")}</th>
                        <th scope="col">{t("traderReceivables.columnStatus")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outstandingRows.map((row) => (
                        <tr key={row.id}>
                          <td className="mono">{row.receivableNumber}</td>
                          <td>{row.businessDate.slice(0, 10)}</td>
                          <td>{sourceTypeLabel(t, row.sourceType)}</td>
                          <td className="mono">{row.sourceReference ?? "-"}</td>
                          <td>{row.reason}</td>
                          <td>{money(row.originalAmountDue)}</td>
                          <td>{money(row.previouslyCollected)}</td>
                          <td>{money(row.outstandingAmount)}</td>
                          <td>{receivableStatusLabel(t, row.status)}</td>
                        </tr>
                      ))}
                      {outstandingRows.length === 0 && outstandingError === undefined ? (
                        <tr>
                          <td className="empty-state" colSpan={9}>
                            {t("traderReceivables.noEligibleReceivables")}
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
                {outstandingTotal <= 50 ? null : (
                  <nav aria-label={t("common.pagination")} className="pagination">
                    <button
                      disabled={outstandingPageIndex <= 1}
                      onClick={() => setOutstandingPageIndex(outstandingPageIndex - 1)}
                      type="button"
                    >
                      {t("common.previous")}
                    </button>
                    <span>
                      {t("common.pageOf", { page: outstandingPageIndex, pageCount: outstandingPageCount })}
                    </span>
                    <button
                      disabled={outstandingPageIndex >= outstandingPageCount}
                      onClick={() => setOutstandingPageIndex(outstandingPageIndex + 1)}
                      type="button"
                    >
                      {t("common.next")}
                    </button>
                  </nav>
                )}
              </section>

              {/* Step 3 — Amount and allocation */}
              <section className="workspace-step">
                <h3>{t("traderReceivables.stepAmountAllocation")}</h3>
                <label className="field required-field">
                  <span>{t("traderReceivables.fieldAmountReceived")}</span>
                  <input
                    inputMode="decimal"
                    min="0.01"
                    onChange={(event) => setAmount(event.target.value)}
                    step="0.01"
                    type="number"
                    value={amount}
                  />
                </label>
                {amount.trim() === "" ? null : (
                  <>
                    {proposalError === undefined ? null : <div className="alert alert-error">{proposalError}</div>}
                    {allocationErrors.length === 0 ? null : (
                      <div className="alert alert-error" role="alert">
                        {[...new Set(allocationErrors)].map((line) => (
                          <p key={line}>{line}</p>
                        ))}
                      </div>
                    )}
                    <div className="table-scroll-x">
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">{t("traderReceivables.columnReceivableNumber")}</th>
                            <th scope="col">{t("traderReceivables.columnBusinessDate")}</th>
                            <th scope="col">{t("traderReceivables.columnOutstandingBefore")}</th>
                            <th scope="col">{t("traderReceivables.columnProposedAmount")}</th>
                            <th scope="col">{t("traderReceivables.columnRemainingAfter")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(proposal?.allocations ?? []).map((line) => {
                            const current =
                              allocations.find((row) => row.receivableId === line.receivableId)?.amount ??
                              line.proposedAmount;
                            const after = money(Number(line.outstandingBefore) - Number(current || 0));
                            return (
                              <tr key={line.receivableId}>
                                <td className="mono">{line.receivableNumber}</td>
                                <td>{line.businessDate.slice(0, 10)}</td>
                                <td>{money(line.outstandingBefore)}</td>
                                <td>
                                  <input
                                    inputMode="decimal"
                                    min="0"
                                    onChange={(event) => setLineAmount(line.receivableId, event.target.value)}
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
                        <dt>{t("traderReceivables.allocationAmountReceived")}</dt>
                        <dd>{money(requestedAmount)}</dd>
                      </div>
                      <div className="detail-line">
                        <dt>{t("traderReceivables.allocationAllocatedAmount")}</dt>
                        <dd>{money(allocatedTotal)}</dd>
                      </div>
                      <div className="detail-line">
                        <dt>{t("traderReceivables.allocationUnallocatedAmount")}</dt>
                        <dd>{unallocated}</dd>
                      </div>
                      <div className="detail-line">
                        <dt>{t("traderReceivables.allocationReceivableCount")}</dt>
                        <dd>{activeAllocations.length}</dd>
                      </div>
                      <div className="detail-line">
                        <dt>{t("traderReceivables.allocationRemainingDue")}</dt>
                        <dd>{money(remainingDueAfter)}</dd>
                      </div>
                    </dl>
                  </>
                )}
              </section>

              {/* Step 4 — Payment Details */}
              <section className="workspace-step">
                <h3>{t("traderReceivables.stepPaymentDetails")}</h3>
                <label className="field required-field">
                  <span>{t("traderReceivables.fieldPaymentDate")}</span>
                  <input onChange={(event) => setPaymentDate(event.target.value)} type="date" value={paymentDate} />
                </label>
                <label className="field required-field">
                  <span>{t("traderReceivables.fieldPaymentMethod")}</span>
                  <select
                    onChange={(event) => setPaymentMethod(event.target.value as "bank_transfer" | "cash")}
                    value={paymentMethod}
                  >
                    <option value="cash">{t("traderReceivables.paymentMethodCash")}</option>
                    <option value="bank_transfer">{t("traderReceivables.paymentMethodBankTransfer")}</option>
                  </select>
                </label>
                {paymentMethod !== "bank_transfer" ? null : (
                  <>
                    <label className="field required-field">
                      <span>{t("traderReceivables.fieldCompanyBankAccount")}</span>
                      <select onChange={(event) => setBankAccountId(event.target.value)} value={bankAccountId}>
                        <option value="">{t("traderReceivables.selectBankAccount")}</option>
                        {companyBanks.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.bankName} — {account.accountName}
                            {account.accountNumberMasked === null ? "" : ` (${account.accountNumberMasked})`}
                          </option>
                        ))}
                      </select>
                      {companyBanks.length === 0 ? (
                        <span className="field-hint">{t("traderReceivables.noActiveBankAccounts")}</span>
                      ) : null}
                    </label>
                    <label className="field required-field">
                      <span>{t("traderReceivables.fieldPaymentReference")}</span>
                      <input
                        onChange={(event) => setPaymentReference(event.target.value)}
                        type="text"
                        value={paymentReference}
                      />
                    </label>
                  </>
                )}
                <label className="field">
                  <span>{t("traderReceivables.fieldNotes")}</span>
                  <textarea onChange={(event) => setNotes(event.target.value)} value={notes} />
                </label>
              </section>

              {/* Step 5 — Review + Confirm */}
              {!canProceedToReview ? null : (
                <section className="workspace-step">
                  <h3>{t("traderReceivables.stepReview")}</h3>
                  <dl className="reconciliation-summary">
                    <div className="detail-line">
                      <dt>{t("traderReceivables.reviewTrader")}</dt>
                      <dd>{trader.traderName}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("traderReceivables.reviewAmountReceived")}</dt>
                      <dd>{money(requestedAmount)}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("traderReceivables.reviewPaymentDate")}</dt>
                      <dd>{paymentDate}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("traderReceivables.reviewPaymentMethod")}</dt>
                      <dd>
                        {t(
                          paymentMethod === "cash"
                            ? "traderReceivables.paymentMethodCash"
                            : "traderReceivables.paymentMethodBankTransfer",
                        )}
                      </dd>
                    </div>
                    {paymentMethod !== "bank_transfer" ? null : (
                      <>
                        <div className="detail-line">
                          <dt>{t("traderReceivables.reviewCompanyBankAccount")}</dt>
                          <dd>{companyBanks.find((account) => account.id === bankAccountId)?.bankName}</dd>
                        </div>
                        <div className="detail-line">
                          <dt>{t("traderReceivables.reviewPaymentReference")}</dt>
                          <dd>{paymentReference}</dd>
                        </div>
                      </>
                    )}
                    {notes.trim() === "" ? null : (
                      <div className="detail-line">
                        <dt>{t("traderReceivables.reviewNotes")}</dt>
                        <dd>{notes}</dd>
                      </div>
                    )}
                    <div className="detail-line">
                      <dt>{t("traderReceivables.reviewReceivableCount")}</dt>
                      <dd>{activeAllocations.length}</dd>
                    </div>
                    <div className="detail-line">
                      <dt>{t("traderReceivables.reviewTotalRemainingDue")}</dt>
                      <dd>{money(remainingDueAfter)}</dd>
                    </div>
                  </dl>
                  <div className="modal-actions">
                    <button className="button button-secondary" onClick={onClose} type="button">
                      {t("common.cancel")}
                    </button>
                    <button className="button button-primary" disabled={saving} type="submit">
                      {saving ? t("common.saving") : t("traderReceivables.confirmMoneyReceived")}
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

// ---------------------------------------------------------------------------
// Collection detail
// ---------------------------------------------------------------------------

function CollectionDetailDialog({
  api,
  canReverse,
  canViewReport,
  collectionId,
  onClose,
  onReversed,
  reportLanguage,
}: {
  api: ApiClient;
  canReverse: boolean;
  canViewReport: boolean;
  collectionId: string;
  onClose: () => void;
  onReversed: () => void;
  reportLanguage: "ar" | "en";
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<TraderCollectionDetail>();
  const [error, setError] = useState<string>();
  const [reverseOpen, setReverseOpen] = useState(false);
  const pdf = useReconciliationPdfActions(api);
  const [pdfError, setPdfError] = useState<string>();

  const load = useCallback(() => {
    setError(undefined);
    void api
      .get<TraderCollectionDetail>(`operations/trader-receivables/collections/${collectionId}`)
      .then(setDetail)
      .catch(() => setError(t("traderReceivables.detailLoadFailed")));
  }, [api, collectionId, t]);

  useEffect(() => load(), [load]);

  const openPdf = async (mode: PdfAction) => {
    setPdfError(undefined);
    const requestError = await pdf.run(
      `operations/trader-receivables/collections/${collectionId}/pdf?language=${reportLanguage}`,
      `Trader-Receipt-${detail?.collectionNumber ?? collectionId}.pdf`,
      mode,
    );
    if (requestError !== undefined) setPdfError(message(requestError, t("traderReceivables.pdfGenerationFailed")));
  };

  return (
    <Modal
      className="modal-wide"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("traderReceivables.collectionDetailTitle")}
      titleId="collection-detail-title"
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
        error === undefined ? <div className="loading-row">{t("common.loading")}</div> : null
      ) : (
        <>
          <dl className="reconciliation-summary">
            <div className="detail-line">
              <dt>{t("traderReceivables.columnCollectionNumber")}</dt>
              <dd>{detail.collectionNumber}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.fieldTrader")}</dt>
              <dd>{detail.traderName}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("common.status")}</dt>
              <dd>
                {t(
                  detail.status === "reversed"
                    ? "traderReceivables.statusReversed"
                    : "traderReceivables.statusConfirmed",
                )}
              </dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.columnPaymentDate")}</dt>
              <dd>{detail.paymentDate}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.columnPaymentMethod")}</dt>
              <dd>
                {t(
                  detail.paymentMethod === "cash"
                    ? "traderReceivables.paymentMethodCash"
                    : "traderReceivables.paymentMethodBankTransfer",
                )}
              </dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.columnPaymentReference")}</dt>
              <dd>{detail.paymentReference ?? "-"}</dd>
            </div>
            {detail.companyBankAccount === null ? null : (
              <div className="detail-line">
                <dt>{t("traderReceivables.fieldCompanyBankAccount")}</dt>
                <dd>
                  {detail.companyBankAccount.bankName} — {detail.companyBankAccount.accountName} (
                  {detail.companyBankAccount.ibanMasked || detail.companyBankAccount.accountNumberMasked})
                </dd>
              </div>
            )}
            <div className="detail-line">
              <dt>{t("traderReceivables.columnReceivedBy")}</dt>
              <dd>{detail.receivedBy}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.createdDate")}</dt>
              <dd>{detail.createdAt.slice(0, 16).replace("T", " ")}</dd>
            </div>
            {detail.notes === null ? null : (
              <div className="detail-line">
                <dt>{t("traderReceivables.notes")}</dt>
                <dd>{detail.notes}</dd>
              </div>
            )}
            {detail.reversalDate === null ? null : (
              <div className="detail-line">
                <dt>{t("traderReceivables.reversalDate")}</dt>
                <dd>{detail.reversalDate.slice(0, 16).replace("T", " ")}</dd>
              </div>
            )}
            {detail.reversedBy === null ? null : (
              <div className="detail-line">
                <dt>{t("traderReceivables.reversedByUser")}</dt>
                <dd>{detail.reversedBy}</dd>
              </div>
            )}
            {detail.reversalReason === null ? null : (
              <div className="detail-line">
                <dt>{t("traderReceivables.reversalReason")}</dt>
                <dd>{detail.reversalReason}</dd>
              </div>
            )}
          </dl>

          <div className="table-scroll-x">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("traderReceivables.columnReceivableNumber")}</th>
                  <th scope="col">{t("traderReceivables.columnSourceType")}</th>
                  <th scope="col">{t("traderReceivables.columnSourceReference")}</th>
                  <th scope="col">{t("traderReceivables.columnBusinessDate")}</th>
                  <th scope="col">{t("traderReceivables.columnReason")}</th>
                  <th scope="col">{t("traderReceivables.columnOriginalAmountDue")}</th>
                  <th scope="col">{t("traderReceivables.columnPreviouslyCollected")}</th>
                  <th scope="col">{t("traderReceivables.amountCollectedNow")}</th>
                  <th scope="col">{t("traderReceivables.columnOutstandingAmount")}</th>
                  <th scope="col">{t("traderReceivables.receivableStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {detail.allocations.map((line) => (
                  <tr key={line.receivableNumber}>
                    <td className="mono">{line.receivableNumber}</td>
                    <td>{sourceTypeLabel(t, line.sourceType)}</td>
                    <td className="mono">{line.sourceReference ?? "-"}</td>
                    <td>{line.businessDate.slice(0, 10)}</td>
                    <td>{line.reason}</td>
                    <td>{money(line.originalAmountDue)}</td>
                    <td>{money(line.previouslyCollected)}</td>
                    <td>{money(line.amountCollectedNow)}</td>
                    <td>{money(line.remainingDue)}</td>
                    <td>{receivableStatusLabel(t, line.receivableStatus)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="reconciliation-summary">
            <div className="detail-line">
              <dt>{t("traderReceivables.numberOfReceivables")}</dt>
              <dd>{detail.summary.receivableCount}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.totalOriginalAmountDue")}</dt>
              <dd>{money(detail.summary.totalOriginalAmountDue)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.columnPreviouslyCollected")}</dt>
              <dd>{money(detail.summary.previouslyCollected)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.amountCollectedNow")}</dt>
              <dd>{money(detail.summary.amountReceivedNow)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("traderReceivables.reviewTotalRemainingDue")}</dt>
              <dd>{money(detail.summary.remainingDue)}</dd>
            </div>
          </dl>

          <div className="modal-actions">
            {!canViewReport ? null : (
              <>
                <button disabled={pdf.busy !== undefined} onClick={() => void openPdf("preview")} type="button">
                  {pdf.busy === "preview" ? t("common.loading") : t("traderReceivables.actionPreviewReceipt")}
                </button>
                <button disabled={pdf.busy !== undefined} onClick={() => void openPdf("print")} type="button">
                  {pdf.busy === "print" ? t("common.loading") : t("traderReceivables.actionPrint")}
                </button>
                <button disabled={pdf.busy !== undefined} onClick={() => void openPdf("download")} type="button">
                  {pdf.busy === "download" ? t("common.loading") : t("traderReceivables.actionDownloadPdf")}
                </button>
              </>
            )}
            {!canReverse || detail.status === "reversed" ? null : (
              <button onClick={() => setReverseOpen(true)} type="button">
                {t("traderReceivables.actionReverse")}
              </button>
            )}
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </>
      )}

      {!reverseOpen || detail === undefined ? null : (
        <ReverseCollectionDialog
          api={api}
          collection={{
            amountReceived: detail.summary.amountReceivedNow,
            collectionId: detail.collectionId,
            collectionNumber: detail.collectionNumber,
            createdAt: detail.createdAt,
            isReversed: detail.status === "reversed",
            paymentDate: detail.paymentDate,
            paymentMethod: detail.paymentMethod,
            paymentReference: detail.paymentReference,
            receivableCount: detail.summary.receivableCount,
            receivedBy: detail.receivedBy,
            status: detail.status,
            traderName: detail.traderName,
          }}
          onClose={() => setReverseOpen(false)}
          onReversed={() => {
            setReverseOpen(false);
            onReversed();
          }}
        />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

function ReverseCollectionDialog({
  api,
  collection,
  onClose,
  onReversed,
}: {
  api: ApiClient;
  collection: TraderCollectionListRow;
  onClose: () => void;
  onReversed: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [reversed, setReversed] = useState(false);

  const reverse = async () => {
    if (reason.trim() === "") {
      setError(t("traderReceivables.reverseReasonRequired"));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await api.post(`operations/trader-receivables/collections/${collection.collectionId}/reverse`, {
        reason: reason.trim(),
      });
      onReversed();
      setReversed(true);
    } catch (submitError) {
      setError(message(submitError, t("traderReceivables.collectionFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("traderReceivables.reverseCollectionTitle")}
      titleId="reverse-collection-title"
    >
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <dl className="reconciliation-summary">
        <div className="detail-line">
          <dt>{t("traderReceivables.columnCollectionNumber")}</dt>
          <dd>{collection.collectionNumber}</dd>
        </div>
        <div className="detail-line">
          <dt>{t("traderReceivables.fieldTrader")}</dt>
          <dd>{collection.traderName}</dd>
        </div>
        <div className="detail-line">
          <dt>{t("traderReceivables.columnAmountReceived")}</dt>
          <dd>{money(collection.amountReceived)}</dd>
        </div>
        <div className="detail-line">
          <dt>{t("common.status")}</dt>
          <dd>
            {t(
              collection.status === "reversed"
                ? "traderReceivables.statusReversed"
                : "traderReceivables.statusConfirmed",
            )}
          </dd>
        </div>
      </dl>
      {reversed ? (
        <div className="reconciliation-success" role="status">
          <p>{t("traderReceivables.collectionReversed")}</p>
          <div className="modal-actions">
            <button className="button button-primary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="field-hint">{t("traderReceivables.reverseWarning")}</p>
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
                {saving ? t("common.saving") : t("traderReceivables.actionReverse")}
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}
