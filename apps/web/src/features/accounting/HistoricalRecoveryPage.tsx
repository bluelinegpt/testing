import { type FormEvent, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import { PageHeader } from "../../components/PageHeader.js";
import {
  DirectionalText,
  LoadPanel,
  formatAccountingDate,
  hasPermission,
} from "./AccountingComponents.js";
import { AccountingPagination, SortableHeader } from "./AccountingListControls.js";
import { accountingQueryKey } from "./accounting-api.js";
import { recordRoute } from "./accounting-routes.js";
import type { AccountingRecord } from "./accounting-types.js";
import { useAccountingResource } from "./use-accounting-resource.js";
import { useListState } from "./use-list-state.js";
import { AccountingRecoveryNavigation } from "./BatchOperationsPage.js";

/**
 * Historical Accounting Recovery — read-only preview.
 *
 * ===========================================================================
 * THIS SCREEN STILL RECOVERS NOTHING
 * ===========================================================================
 *
 * Eligible rows can be SELECTED and enrolled into a Historical Recovery batch
 * -- a plan, created through the dedicated recovery endpoint, which the server
 * revalidates row by row before accepting anything. There is no Execute
 * Recovery action anywhere: recovery execution does not exist yet, the created
 * batch cannot be run, and a visible note says so. Only rows the SERVER
 * classified eligible are selectable; the checkbox simply does not render for
 * anything else, and the server rechecks every selection regardless.
 *
 * ===========================================================================
 * EVERY VERDICT IS THE BACKEND'S
 * ===========================================================================
 *
 * Classification, blocking reason, recommended action, classification totals
 * and eligibility all come from the preview endpoint and are rendered as
 * given. Nothing here re-derives an amount, adds up the current page into a
 * "total", or promotes a row the server called blocked. The summary counts
 * are the server's whole-surface totals — a page total computed client-side
 * would silently lie the moment there is a second page.
 */

const sourceTypes = ["order", "outsourced_driver_fee_accrual"] as const;

const classifications = [
  "eligible",
  "already_posted",
  "duplicate",
  "blocked",
  "closed_period",
  "invalid_source_data",
  "no_accounting_required",
] as const;

const filterKeys = ["sourceType", "dateFrom", "dateTo", "sourceReference", "classification"];

interface PreviewResponse {
  readonly items: readonly AccountingRecord[];
  readonly metadata: {
    readonly executionAvailable: boolean;
    readonly note: string;
    readonly supportedSources: readonly string[];
  };
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totals: readonly {
    readonly classification: string;
    readonly count: number;
    readonly sourceType: string;
  }[];
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Badge tone per classification, from the stylesheet's existing status
 * variants. Eligible reads as actionable-healthy; the two "nothing to do"
 * classes read neutral because they are facts, not faults; the rest grade by
 * how wrong they are.
 */
function classificationBadge(value: string): string {
  if (value === "eligible") return "status-active";
  if (value === "duplicate" || value === "invalid_source_data") return "status-disabled";
  if (value === "blocked" || value === "closed_period") return "status-warning";
  return "status-neutral";
}

export function HistoricalRecoveryPage({
  api,
  companyId,
  onNavigate,
  permissions,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly onNavigate: (path: string) => void;
  readonly permissions: readonly string[];
}) {
  const { i18n, t } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const state = useListState({
    companyId,
    defaultSortBy: "accountingDate",
    filterKeys,
  });
  const canCreate =
    hasPermission(permissions, "manage") || hasPermission(permissions, "post");
  // Selected ELIGIBLE rows, keyed by identity, holding the full row so the
  // creation payload can carry the classification snapshot the user saw.
  const [selectedRows, setSelectedRows] = useState<
    ReadonlyMap<string, AccountingRecord>
  >(new Map());
  const [creating, setCreating] = useState(false);

  // The date-range mistake is caught before the request: the backend would
  // simply return an empty page for an inverted range, which reads as "no
  // gaps" — a wrong answer, not just an unhelpful one.
  const dateFrom = state.filters.dateFrom ?? "";
  const dateTo = state.filters.dateTo ?? "";
  const invalidRange = dateFrom !== "" && dateTo !== "" && dateFrom > dateTo;

  const query = useMemo(
    () => ({
      ...state.filters,
      page: String(state.page),
      pageSize: String(state.pageSize),
      sortBy: state.sortBy,
      sortDirection: state.sortDirection,
    }),
    [state.filters, state.page, state.pageSize, state.sortBy, state.sortDirection],
  );

  const preview = useAccountingResource<PreviewResponse>(
    accountingQueryKey(companyId, "historical-recovery", { ...query, invalidRange }),
    (signal) =>
      invalidRange
        ? Promise.reject(new Error("invalid_range_local"))
        : api.get<PreviewResponse>(
            `operations/accounting/recovery/preview?${new URLSearchParams(query).toString()}`,
            signal,
          ),
  );

  const data = preview.data;
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));

  /** Whole-surface totals by classification, summed across source types by
   *  the reduce below — a merge of server rows, not a recount of the page. */
  const summaryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of data?.totals ?? []) {
      counts.set(row.classification, (counts.get(row.classification) ?? 0) + row.count);
    }
    return counts;
  }, [data]);
  const surfaceTotal = [...summaryCounts.values()].reduce((sum, value) => sum + value, 0);

  const money = (value: unknown) =>
    text(value) === "" ? (
      "—"
    ) : (
      <bdi className="accounting-amount" dir="ltr">
        {text(value)}
      </bdi>
    );

  return (
    <section className="accounting-page">
      <PageHeader
        description={t("historicalRecovery.subtitle")}
        title={t("historicalRecovery.title")}
      />
      <AccountingRecoveryNavigation active="historical" />

      {/* The three facts a user needs before asking where the run button is. */}
      <div className="alert alert-info" role="status">
        {t("historicalRecovery.executionNote")}
      </div>

      <form className="accounting-filters" onSubmit={(event) => event.preventDefault()}>
        <label>
          {t("historicalRecovery.filters.sourceType")}
          <select
            onChange={(event) => state.setFilter("sourceType", event.currentTarget.value)}
            value={state.filters.sourceType ?? ""}
          >
            <option value="">{t("common.all")}</option>
            {sourceTypes.map((value) => (
              <option key={value} value={value}>
                {t(`historicalRecovery.sourceTypes.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("historicalRecovery.filters.dateFrom")}
          <input
            dir="ltr"
            onChange={(event) => state.setFilter("dateFrom", event.currentTarget.value)}
            type="date"
            value={dateFrom}
          />
        </label>
        <label>
          {t("historicalRecovery.filters.dateTo")}
          <input
            dir="ltr"
            onChange={(event) => state.setFilter("dateTo", event.currentTarget.value)}
            type="date"
            value={dateTo}
          />
        </label>
        <label>
          {t("historicalRecovery.filters.sourceReference")}
          <input
            dir="ltr"
            onChange={(event) => state.setFilter("sourceReference", event.currentTarget.value)}
            type="search"
            value={state.filters.sourceReference ?? ""}
          />
        </label>
        <label>
          {t("historicalRecovery.filters.classification")}
          <select
            onChange={(event) => state.setFilter("classification", event.currentTarget.value)}
            value={state.filters.classification ?? ""}
          >
            <option value="">{t("common.all")}</option>
            {classifications.map((value) => (
              <option key={value} value={value}>
                {t(`historicalRecovery.classifications.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="accounting-filter-actions">
          <button className="button button-secondary" onClick={state.clearFilters} type="button">
            {t("common.clear")}
          </button>
          {canCreate ? (
            <button
              className="button"
              disabled={selectedRows.size === 0}
              onClick={() => setCreating(true)}
              type="button"
            >
              {t("historicalRecovery.actionsBar.createBatch", { count: selectedRows.size })}
            </button>
          ) : null}
        </div>
      </form>

      {invalidRange ? (
        <div className="alert alert-error" role="alert">
          {t("historicalRecovery.errors.invalidRange")}
        </div>
      ) : (
        <LoadPanel error={preview.error} loading={preview.loading} onRefresh={preview.refresh}>
          {data === undefined ? null : (
            <>
              {/* Whole-surface classification totals from the server; never a
                  page recount. */}
              <div className="accounting-summary-cards">
                {classifications.map((value) => (
                  <div className="accounting-summary-card" key={value}>
                    <span>{t(`historicalRecovery.classifications.${value}`)}</span>
                    <strong>
                      <span className={`status-badge ${classificationBadge(value)}`}>
                        <bdi dir="ltr">{summaryCounts.get(value) ?? 0}</bdi>
                      </span>
                    </strong>
                  </div>
                ))}
              </div>

              <div className="table-scroll-x">
                <table className="data-table accounting-table">
                  <thead>
                    <tr>
                      {canCreate ? (
                        <th>
                          {/* Selects the ELIGIBLE rows of the current page.
                              Non-eligible rows have no checkbox to select. */}
                          <input
                            aria-label={t("historicalRecovery.actionsBar.selectPage")}
                            checked={
                              data.items.length > 0 &&
                              data.items
                                .filter((row) => text(row.classification) === "eligible")
                                .every((row) =>
                                  selectedRows.has(
                                    `${text(row.sourceType)}:${text(row.sourceId)}`,
                                  ),
                                ) &&
                              data.items.some(
                                (row) => text(row.classification) === "eligible",
                              )
                            }
                            onChange={(event) => {
                              const next = new Map(selectedRows);
                              for (const row of data.items) {
                                if (text(row.classification) !== "eligible") continue;
                                const key = `${text(row.sourceType)}:${text(row.sourceId)}`;
                                if (event.currentTarget.checked) next.set(key, row);
                                else next.delete(key);
                              }
                              setSelectedRows(next);
                            }}
                            type="checkbox"
                          />
                        </th>
                      ) : null}
                      <th>{t("historicalRecovery.columns.sourceType")}</th>
                      <th>
                        <SortableHeader
                          label={t("historicalRecovery.columns.sourceReference")}
                          sortKey="sourceReference"
                          state={state}
                        />
                      </th>
                      <th>
                        <SortableHeader
                          label={t("historicalRecovery.columns.sourceDate")}
                          sortKey="sourceDate"
                          state={state}
                        />
                      </th>
                      <th>
                        <SortableHeader
                          label={t("historicalRecovery.columns.accountingDate")}
                          sortKey="accountingDate"
                          state={state}
                        />
                      </th>
                      <th>
                        <SortableHeader
                          label={t("historicalRecovery.columns.amount")}
                          sortKey="amount"
                          state={state}
                        />
                      </th>
                      <th>{t("historicalRecovery.columns.expectedPostingType")}</th>
                      <th>
                        <SortableHeader
                          label={t("historicalRecovery.columns.classification")}
                          sortKey="classification"
                          state={state}
                        />
                      </th>
                      <th>{t("historicalRecovery.columns.accountingEvent")}</th>
                      <th>{t("historicalRecovery.columns.journal")}</th>
                      <th>{t("historicalRecovery.columns.fiscalPeriod")}</th>
                      <th>{t("historicalRecovery.columns.periodStatus")}</th>
                      <th>{t("historicalRecovery.columns.blockingReason")}</th>
                      <th>{t("historicalRecovery.columns.recommendedAction")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.length === 0 ? (
                      <tr>
                        <td className="accounting-empty" colSpan={canCreate ? 14 : 13}>
                          {surfaceTotal === 0 && state.activeFilterCount === 0
                            ? t("historicalRecovery.empty.noGaps")
                            : t("historicalRecovery.empty.noMatches")}
                        </td>
                      </tr>
                    ) : (
                      data.items.map((row) => {
                        const sourceKind = text(row.sourceType);
                        // Order detail routes by ORDER NUMBER; the accrual
                        // detail routes by id. Both facts come from the
                        // verified route map, not guessed here.
                        const sourceHref =
                          sourceKind === "order"
                            ? recordRoute("order", text(row.sourceReference) || null)
                            : sourceKind === "outsourced_driver_fee_accrual"
                              ? recordRoute(
                                  "outsourced_driver_fee_accrual",
                                  text(row.sourceId) || null,
                                )
                              : undefined;
                        const eventHref = recordRoute(
                          "accounting_event",
                          text(row.accountingEventId) || null,
                        );
                        const journalHref = recordRoute("journal", text(row.journalId) || null);
                        const periodId = text(row.fiscalPeriodId);
                        const classificationValue = text(row.classification);
                        const noRecovery = classificationValue === "no_accounting_required";
                        const rowKey = `${sourceKind}:${text(row.sourceId)}`;
                        return (
                          <tr key={rowKey}>
                            {canCreate ? (
                              <td>
                                {classificationValue === "eligible" ? (
                                  <input
                                    aria-label={t("historicalRecovery.actionsBar.selectRow", {
                                      reference: text(row.sourceReference),
                                    })}
                                    checked={selectedRows.has(rowKey)}
                                    onChange={(event) => {
                                      const next = new Map(selectedRows);
                                      if (event.currentTarget.checked) next.set(rowKey, row);
                                      else next.delete(rowKey);
                                      setSelectedRows(next);
                                    }}
                                    type="checkbox"
                                  />
                                ) : null}
                              </td>
                            ) : null}
                            <td>
                              {t(`historicalRecovery.sourceTypes.${sourceKind}`, {
                                defaultValue: sourceKind,
                              })}
                            </td>
                            <td>
                              {sourceHref === undefined ? (
                                <DirectionalText>
                                  {text(row.sourceReference) || "—"}
                                </DirectionalText>
                              ) : (
                                <Link to={sourceHref}>
                                  <DirectionalText>
                                    {text(row.sourceReference) || text(row.sourceId)}
                                  </DirectionalText>
                                </Link>
                              )}
                            </td>
                            <td>
                              <bdi dir="ltr">{formatAccountingDate(row.sourceDate, locale)}</bdi>
                            </td>
                            <td>
                              <bdi dir="ltr">
                                {formatAccountingDate(row.accountingDate, locale)}
                              </bdi>
                            </td>
                            <td>{money(row.amount)}</td>
                            <td>
                              <DirectionalText>{text(row.expectedPostingType)}</DirectionalText>
                            </td>
                            <td>
                              <span
                                className={`status-badge ${classificationBadge(
                                  classificationValue,
                                )}`}
                              >
                                {t(`historicalRecovery.classifications.${classificationValue}`, {
                                  defaultValue: classificationValue,
                                })}
                              </span>
                            </td>
                            <td>
                              {eventHref === undefined ? (
                                "—"
                              ) : (
                                <Link to={eventHref}>
                                  <DirectionalText>
                                    {text(row.accountingEventReference) ||
                                      t("historicalRecovery.links.event")}
                                  </DirectionalText>
                                </Link>
                              )}
                            </td>
                            <td>
                              {journalHref === undefined ? (
                                "—"
                              ) : (
                                <Link to={journalHref}>
                                  <DirectionalText>
                                    {text(row.journalNumber) ||
                                      t("historicalRecovery.links.journal")}
                                  </DirectionalText>
                                </Link>
                              )}
                            </td>
                            <td>
                              {periodId === "" ? (
                                "—"
                              ) : (
                                <Link to={`/accounting/fiscal-periods/${periodId}`}>
                                  {t("historicalRecovery.links.period")}
                                </Link>
                              )}
                            </td>
                            <td>
                              {text(row.fiscalPeriodStatus) === ""
                                ? "—"
                                : t(`accounting.status.${text(row.fiscalPeriodStatus)}`, {
                                    defaultValue: text(row.fiscalPeriodStatus),
                                  })}
                            </td>
                            <td>
                              {text(row.blockingCode) === ""
                                ? "—"
                                : t(`historicalRecovery.blocking.${text(row.blockingCode)}`, {
                                    defaultValue: text(row.blockingCode),
                                  })}
                            </td>
                            <td>
                              {noRecovery
                                ? t("historicalRecovery.noRecoveryRequired")
                                : t(
                                    `historicalRecovery.actions.${text(row.recommendedAction)}`,
                                    { defaultValue: text(row.recommendedAction) || "—" },
                                  )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <AccountingPagination state={state} total={total} totalPages={totalPages} />
            </>
          )}
        </LoadPanel>
      )}
      {creating ? (
        <CreateRecoveryBatchDialog
          api={api}
          onClose={() => setCreating(false)}
          onCreated={(batchId) => {
            setCreating(false);
            setSelectedRows(new Map());
            onNavigate(`/accounting/batch-operations/${batchId}`);
          }}
          rows={[...selectedRows.values()]}
        />
      ) : null}
    </section>
  );
}

interface CreationResult {
  readonly accepted: readonly AccountingRecord[];
  readonly batchId: string;
  readonly batchReference: string;
  readonly rejected: readonly {
    readonly reason: string;
    readonly sourceReference: string;
    readonly sourceType: string;
  }[];
}

/**
 * Create-batch confirmation and result.
 *
 * Submits the selected rows -- classification snapshot included -- to the
 * dedicated recovery endpoint with a fresh idempotency key. The server
 * revalidates everything and may reject rows that changed since the preview;
 * the result stays ON SCREEN with accepted/rejected counts and per-row
 * reasons, and only the user's explicit "Open Batch" navigates away, so a
 * partial acceptance is never silently skipped past. A fully-accepted batch
 * navigates directly -- there is nothing left to read.
 */
function CreateRecoveryBatchDialog({
  api,
  onClose,
  onCreated,
  rows,
}: {
  readonly api: ApiClient;
  readonly onClose: () => void;
  readonly onCreated: (batchId: string) => void;
  readonly rows: readonly AccountingRecord[];
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<CreationResult>();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    const items = rows.map((row) => ({
      accountingDate: (typeof row.accountingDate === "string"
        ? row.accountingDate
        : String(row.accountingDate ?? "")
      ).slice(0, 10),
      amount: typeof row.amount === "string" ? row.amount : "0.00",
      classification: String(row.classification ?? "eligible"),
      expectedPostingType: String(row.expectedPostingType ?? ""),
      sourceId: String(row.sourceId ?? ""),
      sourceReference: String(row.sourceReference ?? ""),
      sourceType: String(row.sourceType ?? ""),
    }));
    api
      .post<{
        readonly creation: { readonly accepted: readonly AccountingRecord[]; readonly rejected: CreationResult["rejected"] };
        readonly batchReference: string;
        readonly id: string;
      }>(
        "operations/accounting/recovery/batches",
        { ...(reason.trim() === "" ? {} : { reason: reason.trim() }), items },
        { "x-idempotency-key": globalThis.crypto.randomUUID() },
      )
      .then((response) => {
        const outcome: CreationResult = {
          accepted: response.creation.accepted,
          batchId: String(response.id),
          batchReference: String(response.batchReference),
          rejected: response.creation.rejected,
        };
        if (outcome.rejected.length === 0) {
          onCreated(outcome.batchId);
          return;
        }
        setResult(outcome);
        setSaving(false);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.code : "request_failed");
        setSaving(false);
      });
  };

  return (
    <Modal
      className="accounting-action-dialog"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("historicalRecovery.create.heading")}
      titleId={titleId}
    >
      <div className="modal-body">
        {result === undefined ? (
          <form onSubmit={submit}>
            {error === undefined ? null : (
              <div className="alert alert-error" role="alert">
                {t(`historicalRecovery.errors.${error}`, {
                  defaultValue: t("historicalRecovery.errors.create"),
                })}
              </div>
            )}
            <p>{t("historicalRecovery.create.explanation", { count: rows.length })}</p>
            {/* Still no execution: enrolment is a plan, and the dialog says so
                where the decision is being made. */}
            <div className="alert alert-info" role="status">
              {t("historicalRecovery.create.noExecutionReminder")}
            </div>
            <label>
              {t("historicalRecovery.create.reason")}
              <textarea
                maxLength={500}
                onChange={(event) => setReason(event.currentTarget.value)}
                rows={3}
                value={reason}
              />
            </label>
            <div className="accounting-form-actions">
              <button className="button button-secondary" onClick={onClose} type="button">
                {t("common.cancel")}
              </button>
              <button
                className="button"
                disabled={saving || rows.length === 0}
                type="submit"
              >
                {saving ? t("common.loading") : t("historicalRecovery.create.confirm")}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="alert alert-warning" role="status">
              {t("historicalRecovery.create.partialResult", {
                accepted: result.accepted.length,
                reference: result.batchReference,
                rejected: result.rejected.length,
              })}
            </div>
            <div className="table-scroll-x">
              <table className="data-table accounting-table">
                <thead>
                  <tr>
                    <th>{t("historicalRecovery.columns.sourceReference")}</th>
                    <th>{t("historicalRecovery.create.rejectionReason")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rejected.map((row) => (
                    <tr key={`${row.sourceType}:${row.sourceReference}`}>
                      <td>
                        <DirectionalText>{row.sourceReference || "—"}</DirectionalText>
                      </td>
                      <td>
                        {t(`historicalRecovery.rejections.${row.reason}`, {
                          defaultValue: t(
                            `historicalRecovery.classifications.${row.reason}`,
                            { defaultValue: row.reason },
                          ),
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="accounting-form-actions">
              <button className="button button-secondary" onClick={onClose} type="button">
                {t("common.close")}
              </button>
              <button
                className="button"
                onClick={() => onCreated(result.batchId)}
                type="button"
              >
                {t("historicalRecovery.create.openBatch")}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
