import { type FormEvent, Fragment, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import { PageHeader } from "../../components/PageHeader.js";
import {
  DirectionalText,
  LoadPanel,
  StatusBadge,
  formatAccountingDate,
  hasPermission,
} from "./AccountingComponents.js";
import { AccountingPagination, SortableHeader } from "./AccountingListControls.js";
import { accountingQueryKey } from "./accounting-api.js";
import { recordRoute } from "./accounting-routes.js";
import type { AccountingRecord } from "./accounting-types.js";
import { useAccountingResource } from "./use-accounting-resource.js";
import { useListState } from "./use-list-state.js";

/**
 * Accounting Batch Operations — list and detail.
 *
 * ===========================================================================
 * EXECUTION IS THE BACKEND'S; THIS SCREEN ONLY ASKS FOR IT
 * ===========================================================================
 *
 * Execute posts to the one existing execute endpoint with the batch version
 * the user is LOOKING AT and a fresh idempotency key, then re-reads the batch.
 * Every item is executed server-side by the single-item reprocess service;
 * nothing here computes an outcome, a counter or a classification. A batch is
 * not one all-or-nothing financial transaction — items that succeed remain
 * committed even if a later item fails, and the screen says so before asking
 * for confirmation. Validate remains read-only, and Cancel changes only the
 * batch.
 *
 * ===========================================================================
 * CLASSIFICATIONS ARE DISPLAYED, NEVER REINTERPRETED
 * ===========================================================================
 *
 * `validationStatus` and its reasons come from the authoritative single-item
 * readiness service by way of the backend. This file renders them and does not
 * recompute, merge, soften or re-derive any of them — an item the backend calls
 * `blocked` is shown as blocked, with the backend's own reason codes.
 *
 * The same rule covers counts: nothing here adds up amounts or infers a
 * classification total the server did not send.
 */

type BatchType = "accounting_event_reprocess" | "operational_posting_retry";

export function AccountingRecoveryNavigation({
  active,
}: {
  readonly active: "batches" | "events" | "historical";
}) {
  const { t } = useTranslation();
  const links = [
    { id: "events", path: "/accounting/events" },
    { id: "historical", path: "/accounting/historical-recovery" },
    { id: "batches", path: "/accounting/batch-operations" },
  ] as const;
  return (
    <nav aria-label={t("batches.recoveryNavigation.label")} className="accounting-filter-actions">
      {links.map((link) =>
        link.id === active ? (
          <span className="button" key={link.id}>
            {t(`batches.recoveryNavigation.${link.id}`)}
          </span>
        ) : (
          <Link className="button button-secondary" key={link.id} to={link.path}>
            {t(`batches.recoveryNavigation.${link.id}`)}
          </Link>
        ),
      )}
    </nav>
  );
}

/** Types the GENERIC create dialog offers. Historical Recovery batches are
 *  created from the Historical Recovery preview with full per-item facts, so
 *  the type is deliberately absent here — the backend refuses it anyway. */
const batchTypes: readonly BatchType[] = [
  "accounting_event_reprocess",
  "operational_posting_retry",
];

/** All types that can EXIST, for the list filter and display. */
const allBatchTypes = [
  "accounting_event_reprocess",
  "operational_posting_retry",
  "historical_accounting_recovery",
] as const;

const batchStatuses = [
  "draft",
  "validating",
  "ready",
  "processing",
  "partially_completed",
  "completed",
  "failed",
  "cancelled",
] as const;

const validationStatuses = [
  "eligible",
  "blocked",
  "duplicate",
  "invalid",
  "already_processed",
  "closed_period",
  "invalid_source_data",
  "no_accounting_required",
] as const;

const listFilterKeys = ["status", "batchType", "reference", "dateFrom", "dateTo"];
const itemFilterKeys = ["validationStatus"];

interface BatchPage {
  readonly items: readonly AccountingRecord[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

interface BatchDetail extends AccountingRecord {
  readonly items: {
    readonly items: readonly AccountingRecord[];
    readonly page: number;
    readonly pageSize: number;
    readonly total: number;
  };
  readonly metadata: {
    readonly executionImplemented: boolean;
    readonly maxItems: number;
    readonly processingStaleMinutes: number;
    readonly singleItemService: {
      readonly execution: string;
      readonly sourceType: string;
      readonly validation: string;
    };
  };
  readonly sourceTypeCounts: Readonly<Record<string, number>>;
  readonly transitions: readonly AccountingRecord[];
  readonly validationCounts: Readonly<Record<string, number>>;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number => (typeof value === "number" ? value : 0);

/**
 * Splits a pasted block of identifiers.
 *
 * Accepts newlines, commas, semicolons and whitespace, because the realistic
 * input is a column copied out of a spreadsheet or a query result. Duplicates
 * are dropped here as a courtesy; the database's unique index is what actually
 * guarantees a source cannot be enrolled twice.
 */
function parseSourceIds(raw: string): readonly string[] {
  return [...new Set(raw.split(/[\s,;]+/).map((value) => value.trim()).filter((v) => v !== ""))];
}

/**
 * Badge tone per classification, using the stylesheet's existing status
 * variants rather than new ones. Eligible reads as healthy, invalid as a
 * failure, blocked as a warning, and the two "nothing to do here" outcomes as
 * neutral -- an item already processed is not an error.
 */
function classificationBadge(value: string): string {
  if (value === "eligible") return "status-active";
  if (value === "invalid" || value === "invalid_source_data") return "status-disabled";
  if (value === "blocked" || value === "closed_period") return "status-warning";
  return "status-neutral";
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CountMap = Readonly<Record<string, number>>;

/**
 * The ONE mapping from persisted item states to the list's compact summary.
 * Validation verdicts and execution outcomes are different facts about an
 * item, and the mapping keeps them apart: Pending/Succeeded/Failed/Other come
 * from EXECUTION statuses; Blocked is a VALIDATION-verdict rollup of the
 * retryable blockers; the tooltip breaks the settled verdicts out by name.
 * Nothing here is computed from visible rows -- every number is the server's
 * aggregate over the batch's item rows.
 */
function listSummary(validation: CountMap | undefined, execution: CountMap | undefined) {
  const v = validation ?? {};
  const e = execution ?? {};
  return {
    blocked:
      (v["blocked"] ?? 0) + (v["closed_period"] ?? 0) + (v["invalid_source_data"] ?? 0) +
      (v["invalid"] ?? 0),
    failed: e["failed"] ?? 0,
    other: (e["skipped"] ?? 0) + (e["cancelled"] ?? 0),
    pending: e["pending"] ?? 0,
    succeeded: e["succeeded"] ?? 0,
  };
}

export function BatchOperationsPage({
  api,
  companyId,
  id,
  onNavigate,
  permissions,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly id?: string | undefined;
  readonly onNavigate: (path: string) => void;
  readonly permissions: readonly string[];
}) {
  return id === undefined ? (
    <BatchList api={api} companyId={companyId} onNavigate={onNavigate} permissions={permissions} />
  ) : (
    <BatchDetailView
      api={api}
      batchId={id}
      companyId={companyId}
      onNavigate={onNavigate}
      permissions={permissions}
    />
  );
}

/** Whoever may run the single-item action may plan a batch of it. */
const canOperate = (permissions: readonly string[]): boolean =>
  hasPermission(permissions, "manage") || hasPermission(permissions, "post");

function BatchList({
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
  const allowed = canOperate(permissions);
  const state = useListState({ companyId, defaultSortBy: "createdAt", filterKeys: listFilterKeys });
  const [creating, setCreating] = useState(false);

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

  const batches = useAccountingResource<BatchPage>(
    accountingQueryKey(companyId, "accounting-batches", query),
    (signal) =>
      api.get<BatchPage>(
        `operations/accounting/batches?${new URLSearchParams(query).toString()}`,
        signal,
      ),
  );

  const total = batches.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));

  return (
    <section className="accounting-page">
      <PageHeader description={t("batches.intro")} title={t("batches.heading")} />
      <AccountingRecoveryNavigation active="batches" />

      {/* Execution reuses the single-item service; worth saying where users
          plan the work. */}
      <div className="alert alert-info" role="status">
        {t("batches.executionDelegation")}
      </div>
      {/* Recorded rather than hidden: Journal Review is absent for a stated
          reason, not because it was forgotten. */}
      <div className="alert alert-info" role="status">
        {t("batches.journalReviewUnavailable")}
      </div>

      <form className="accounting-filters" onSubmit={(event) => event.preventDefault()}>
        <label>
          {t("batches.filters.status")}
          <select
            onChange={(event) => state.setFilter("status", event.currentTarget.value)}
            value={state.filters.status ?? ""}
          >
            <option value="">{t("common.all")}</option>
            {batchStatuses.map((value) => (
              <option key={value} value={value}>
                {t(`accounting.status.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("batches.filters.batchType")}
          <select
            onChange={(event) => state.setFilter("batchType", event.currentTarget.value)}
            value={state.filters.batchType ?? ""}
          >
            <option value="">{t("common.all")}</option>
            {allBatchTypes.map((value) => (
              <option key={value} value={value}>
                {t(`batches.types.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("batches.filters.reference")}
          <input
            dir="ltr"
            onChange={(event) => state.setFilter("reference", event.currentTarget.value)}
            type="search"
            value={state.filters.reference ?? ""}
          />
        </label>
        <label>
          {t("batches.filters.dateFrom")}
          <input
            dir="ltr"
            onChange={(event) => state.setFilter("dateFrom", event.currentTarget.value)}
            type="date"
            value={state.filters.dateFrom ?? ""}
          />
        </label>
        <label>
          {t("batches.filters.dateTo")}
          <input
            dir="ltr"
            onChange={(event) => state.setFilter("dateTo", event.currentTarget.value)}
            type="date"
            value={state.filters.dateTo ?? ""}
          />
        </label>
        <div className="accounting-filter-actions">
          <button className="button button-secondary" onClick={state.clearFilters} type="button">
            {t("common.clear")}
          </button>
          {allowed ? (
            <button className="button" onClick={() => setCreating(true)} type="button">
              {t("batches.actions.create")}
            </button>
          ) : null}
        </div>
      </form>
      {allowed ? null : (
        <div className="alert alert-info" role="status">
          {t("batches.readOnlyNotice")}
        </div>
      )}

      <LoadPanel error={batches.error} loading={batches.loading} onRefresh={batches.refresh}>
        <div className="table-scroll-x">
          <table className="data-table accounting-table">
            <thead>
              <tr>
                <th>
                  <SortableHeader
                    label={t("batches.columns.batchReference")}
                    sortKey="batchReference"
                    state={state}
                  />
                </th>
                <th>{t("batches.columns.batchType")}</th>
                <th>
                  <SortableHeader
                    label={t("batches.columns.status")}
                    sortKey="status"
                    state={state}
                  />
                </th>
                <th>{t("batches.columns.requestedBy")}</th>
                <th>
                  <SortableHeader
                    label={t("batches.columns.createdAt")}
                    sortKey="createdAt"
                    state={state}
                  />
                </th>
                <th>
                  <SortableHeader
                    label={t("batches.columns.totalItems")}
                    sortKey="totalItems"
                    state={state}
                  />
                </th>
                <th>{t("batches.listSummary.pending")}</th>
                <th>{t("batches.listSummary.succeeded")}</th>
                <th>{t("batches.listSummary.blocked")}</th>
                <th>{t("batches.listSummary.failed")}</th>
                <th>{t("batches.listSummary.other")}</th>
                <th>{t("batches.columns.completedAt")}</th>
              </tr>
            </thead>
            <tbody>
              {(batches.data?.items ?? []).length === 0 ? (
                <tr>
                  <td className="accounting-empty" colSpan={12}>
                    {t("batches.empty.list")}
                  </td>
                </tr>
              ) : (
                (batches.data?.items ?? []).map((batch) => (
                  <tr key={text(batch.id)}>
                    <td>
                      <button
                        className="link-button"
                        onClick={() =>
                          onNavigate(`/accounting/batch-operations/${text(batch.id)}`)
                        }
                        type="button"
                      >
                        <DirectionalText>{text(batch.batchReference)}</DirectionalText>
                      </button>
                    </td>
                    <td>{t(`batches.types.${text(batch.batchType)}`)}</td>
                    <td>
                      <StatusBadge value={batch.status} />
                    </td>
                    <td>
                      <DirectionalText>{text(batch.requestedByAccountId)}</DirectionalText>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatAccountingDate(batch.createdAt, locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{count(batch.itemTotal)}</bdi>
                    </td>
                    {(() => {
                      const validation = batch.validationCounts as CountMap | undefined;
                      const execution = batch.executionCounts as CountMap | undefined;
                      const summary = listSummary(validation, execution);
                      /* The detailed verdicts ride a native tooltip rather
                         than five more columns: the breakdown is one hover
                         away, and the row stays scannable. */
                      const detail = [
                        "duplicate",
                        "already_processed",
                        "no_accounting_required",
                        "closed_period",
                        "invalid_source_data",
                        "invalid",
                        "blocked",
                        "eligible",
                      ]
                        .map((key) =>
                          (validation?.[key] ?? 0) === 0
                            ? undefined
                            : `${t(`batches.classifications.${key}`)}: ${validation?.[key] ?? 0}`,
                        )
                        .filter((entry): entry is string => entry !== undefined)
                        .join(" · ");
                      const cell = (value: number) => (
                        <td title={detail === "" ? undefined : detail}>
                          <bdi dir="ltr">{value}</bdi>
                        </td>
                      );
                      return (
                        <>
                          {cell(summary.pending)}
                          {cell(summary.succeeded)}
                          {cell(summary.blocked)}
                          {cell(summary.failed)}
                          {cell(summary.other)}
                        </>
                      );
                    })()}
                    <td>
                      <bdi dir="ltr">{formatAccountingDate(batch.completedAt, locale)}</bdi>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <AccountingPagination state={state} total={total} totalPages={totalPages} />
      </LoadPanel>

      {creating ? (
        <CreateBatchDialog
          api={api}
          onClose={() => setCreating(false)}
          onCreated={(batchId) => {
            setCreating(false);
            onNavigate(`/accounting/batch-operations/${batchId}`);
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Create.
 *
 * The initial items go in the SAME request as the batch, because the create
 * endpoint accepts them and one idempotent call cannot leave an empty batch
 * behind if the second half fails. The add-items endpoint is used afterwards,
 * from the detail screen, for what it is actually for: adding to a batch that
 * already exists.
 */
function CreateBatchDialog({
  api,
  onClose,
  onCreated,
}: {
  readonly api: ApiClient;
  readonly onClose: () => void;
  readonly onCreated: (batchId: string) => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [batchType, setBatchType] = useState<BatchType>("accounting_event_reprocess");
  const [reason, setReason] = useState("");
  const [rawIds, setRawIds] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const ids = parseSourceIds(rawIds);
  const malformed = ids.filter((value) => !uuidPattern.test(value));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    api
      .post<{ readonly id: string }>(
        "operations/accounting/batches",
        { batchType, reason: reason.trim(), ...(ids.length === 0 ? {} : { sourceIds: ids }) },
        { "x-idempotency-key": globalThis.crypto.randomUUID() },
      )
      .then((created) => onCreated(created.id))
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
      title={t("batches.actions.create")}
      titleId={formId}
    >
      <div className="modal-body">
      <form onSubmit={submit}>
        {error === undefined ? null : (
          <div className="alert alert-error" role="alert">
            {t(`batches.errors.${error}`, { defaultValue: t("batches.errors.save") })}
          </div>
        )}
        <label>
          {t("batches.fields.batchType")}
          <select
            onChange={(event) => setBatchType(event.currentTarget.value as BatchType)}
            value={batchType}
          >
            {batchTypes.map((value) => (
              <option key={value} value={value}>
                {t(`batches.types.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <p className="accounting-hint">{t(`batches.typeHints.${batchType}`)}</p>
        <label>
          {t("batches.fields.reason")}
          <textarea
            maxLength={500}
            minLength={5}
            onChange={(event) => setReason(event.currentTarget.value)}
            required
            rows={3}
            value={reason}
          />
        </label>
        <label>
          {t("batches.fields.sourceIds")}
          <textarea
            dir="ltr"
            onChange={(event) => setRawIds(event.currentTarget.value)}
            rows={6}
            value={rawIds}
          />
        </label>
        <p className="accounting-hint">
          {t("batches.fields.sourceIdsHint", { count: ids.length })}
        </p>
        {malformed.length === 0 ? null : (
          <div className="alert alert-error" role="alert">
            {t("batches.errors.malformedIds", { count: malformed.length })}
          </div>
        )}
        <div className="accounting-form-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button
            className="button"
            disabled={saving || reason.trim().length < 5 || malformed.length > 0}
            type="submit"
          >
            {saving ? t("common.loading") : t("batches.actions.create")}
          </button>
        </div>
      </form>
      </div>
    </Modal>
  );
}

function BatchDetailView({
  api,
  batchId,
  companyId,
  onNavigate,
  permissions,
}: {
  readonly api: ApiClient;
  readonly batchId: string;
  readonly companyId: string;
  readonly onNavigate: (path: string) => void;
  readonly permissions: readonly string[];
}) {
  const { i18n, t } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const allowed = canOperate(permissions);
  const state = useListState({ companyId, defaultSortBy: "createdAt", filterKeys: itemFilterKeys });
  const [busy, setBusy] = useState<"validate" | undefined>();
  const [dialog, setDialog] = useState<
    "addItems" | "cancel" | "execute" | "recover" | undefined
  >();
  const [actionError, setActionError] = useState<string>();
  // Set after an execute round-trip so the refreshed detail is presented as a
  // RESULT -- final status and counters -- rather than as a page that merely
  // changed under the user.
  const [executed, setExecuted] = useState(false);

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

  const batch = useAccountingResource<BatchDetail>(
    accountingQueryKey(companyId, "accounting-batch", { batchId, ...query }),
    (signal) =>
      api.get<BatchDetail>(
        `operations/accounting/batches/${batchId}?${new URLSearchParams(query).toString()}`,
        signal,
      ),
  );

  const data = batch.data;
  const status = text(data?.status);
  // Whether an action is offered is the BACKEND's rule, mirrored here only to
  // avoid presenting a button that will certainly be refused. The backend
  // refuses it again regardless.
  const canValidate = allowed && (status === "draft" || status === "ready");
  const canAddItems = allowed && (status === "draft" || status === "ready");
  const canCancel =
    allowed && !["cancelled", "completed", "processing"].includes(status) && status !== "";
  // Best client-side estimate of unfinished executable items: every retryable
  // verdict (eligible, blocked, closed-period, invalid) minus what already
  // succeeded -- blocked items are retryable because execution revalidates
  // each one. Settled verdicts never count. The backend re-checks all of this
  // and is authoritative.
  const retryableCounts =
    (data?.validationCounts["eligible"] ?? 0) +
    (data?.validationCounts["blocked"] ?? 0) +
    (data?.validationCounts["closed_period"] ?? 0) +
    (data?.validationCounts["invalid_source_data"] ?? 0) +
    (data?.validationCounts["invalid"] ?? 0);
  const unfinishedEligible = Math.max(0, retryableCounts - count(data?.succeededCount));
  const retry = status === "partially_completed" || status === "failed";
  // Interrupted-processing detection, mirroring the backend's staleness fence:
  // the newest persisted activity across the job row and its items, silent for
  // longer than the server's documented threshold. The backend re-checks both
  // fences (staleness AND live item locks) and stays authoritative.
  const lastActivityMs = Math.max(
    Date.parse(text(data?.updatedAt) || "") || 0,
    Date.parse(text(data?.lastItemActivityAt) || "") || 0,
  );
  const minutesSilent =
    lastActivityMs === 0 ? 0 : Math.floor((Date.now() - lastActivityMs) / 60_000);
  const staleThreshold = data?.metadata.processingStaleMinutes ?? 15;
  const appearsInterrupted = status === "processing" && minutesSilent >= staleThreshold;
  const canRecover = appearsInterrupted && hasPermission(permissions, "manage");
  const canExecute =
    allowed &&
    (status === "ready" || retry) &&
    data?.metadata.executionImplemented === true &&
    unfinishedEligible > 0;

  const validate = () => {
    setBusy("validate");
    setActionError(undefined);
    api
      .post(`operations/accounting/batches/${batchId}/validate`, undefined, {
        "x-idempotency-key": globalThis.crypto.randomUUID(),
      })
      .then(() => {
        setBusy(undefined);
        batch.refresh();
      })
      .catch((cause: unknown) => {
        setActionError(cause instanceof ApiError ? cause.code : "request_failed");
        setBusy(undefined);
      });
  };

  const itemTotal = data?.items.total ?? 0;
  const itemPages = Math.max(1, Math.ceil(itemTotal / state.pageSize));

  return (
    <section className="accounting-page">
      <PageHeader description={t("batches.intro")} title={t("batches.detailHeading")} />
      <AccountingRecoveryNavigation active="batches" />
      <button
        className="link-button"
        onClick={() => onNavigate("/accounting/batch-operations")}
        type="button"
      >
        {t("batches.actions.backToList")}
      </button>

      <LoadPanel error={batch.error} loading={batch.loading} onRefresh={batch.refresh}>
        {data === undefined ? null : (
          <>
            {actionError === undefined ? null : (
              <div className="alert alert-error" role="alert">
                {t(`batches.errors.${actionError}`, {
                  defaultValue: t("batches.errors.action"),
                })}
              </div>
            )}

            <div className="accounting-summary-cards">
              <div className="accounting-summary-card">
                <span>{t("batches.columns.batchReference")}</span>
                <strong>
                  <DirectionalText>{text(data.batchReference)}</DirectionalText>
                </strong>
              </div>
              <div className="accounting-summary-card">
                <span>{t("batches.columns.batchType")}</span>
                <strong>{t(`batches.types.${text(data.batchType)}`)}</strong>
              </div>
              <div className="accounting-summary-card">
                <span>{t("batches.columns.status")}</span>
                <strong>
                  <StatusBadge value={data.status} />
                </strong>
              </div>
              <div className="accounting-summary-card">
                <span>{t("batches.columns.totalItems")}</span>
                <strong>
                  <bdi dir="ltr">{count(data.totalItems)}</bdi>
                </strong>
              </div>
              <div className="accounting-summary-card">
                <span>{t("batches.columns.version")}</span>
                <strong>
                  <bdi dir="ltr">{text(data.version) || count(data.version)}</bdi>
                </strong>
              </div>
            </div>

            <div className="accounting-form-actions">
              {canValidate ? (
                <button
                  className="button"
                  disabled={busy === "validate"}
                  onClick={validate}
                  type="button"
                >
                  {busy === "validate" ? t("common.loading") : t("batches.actions.validate")}
                </button>
              ) : null}
              {canAddItems ? (
                <button
                  className="button button-secondary"
                  onClick={() => setDialog("addItems")}
                  type="button"
                >
                  {t("batches.actions.addItems")}
                </button>
              ) : null}
              {canExecute ? (
                <button className="button" onClick={() => setDialog("execute")} type="button">
                  {retry
                    ? t("batches.actions.retry")
                    : text(data.batchType) === "historical_accounting_recovery"
                      ? t("batches.actions.executeRecovery")
                      : t("batches.actions.execute")}
                </button>
              ) : null}
              {canCancel ? (
                <button
                  className="button button-secondary"
                  onClick={() => setDialog("cancel")}
                  type="button"
                >
                  {t("batches.actions.cancel")}
                </button>
              ) : null}
            </div>
            {status === "processing" ? (
              appearsInterrupted ? (
                <div className="alert alert-warning" role="status">
                  {t("batches.recover.interrupted", { minutes: minutesSilent })}{" "}
                  {canRecover ? (
                    <button
                      className="link-button"
                      onClick={() => setDialog("recover")}
                      type="button"
                    >
                      {t("batches.recover.action")}
                    </button>
                  ) : null}
                </div>
              ) : (
                /* A run is underway server-side. No automatic polling exists on
                   this page, so the honest offer is a manual refresh. */
                <div className="alert alert-info" role="status">
                  {t("batches.processingNotice")}{" "}
                  <button className="link-button" onClick={batch.refresh} type="button">
                    {t("batches.actions.refresh")}
                  </button>
                </div>
              )
            ) : null}
            {executed && !["processing", "validating"].includes(status) ? (
              <div
                className={`alert ${status === "completed" ? "alert-info" : "alert-warning"}`}
                role="status"
              >
                {t(`batches.executionResult.${status}`, {
                  defaultValue: t("batches.executionResult.generic"),
                })}{" "}
                {t("batches.executionResult.counters", {
                  duplicate: count(data.duplicateCount),
                  failed: count(data.failedCount),
                  skipped: count(data.skippedCount),
                  succeeded: count(data.succeededCount),
                })}
              </div>
            ) : null}
            <div className="alert alert-info" role="status">
              {t("batches.validateIsReadOnly")}
            </div>

            <h3>{t("batches.sections.summary")}</h3>
            <dl className="accounting-detail-grid">
              <dt>{t("batches.fields.reason")}</dt>
              <dd>{text(data.reason) || "—"}</dd>
              <dt>{t("batches.columns.requestedBy")}</dt>
              <dd>
                <DirectionalText>{text(data.requestedByAccountId)}</DirectionalText>
              </dd>
              <dt>{t("batches.columns.createdAt")}</dt>
              <dd>
                <bdi dir="ltr">{formatAccountingDate(data.createdAt, locale)}</bdi>
              </dd>
              <dt>{t("batches.columns.lastValidatedAt")}</dt>
              <dd>
                <bdi dir="ltr">{formatAccountingDate(data.lastValidatedAt, locale)}</bdi>
              </dd>
              <dt>{t("batches.columns.startedAt")}</dt>
              <dd>
                <bdi dir="ltr">{formatAccountingDate(data.startedAt, locale)}</bdi>
              </dd>
              <dt>{t("batches.columns.completedAt")}</dt>
              <dd>
                <bdi dir="ltr">{formatAccountingDate(data.completedAt, locale)}</bdi>
              </dd>
              <dt>{t("batches.columns.cancelledAt")}</dt>
              <dd>
                <bdi dir="ltr">{formatAccountingDate(data.cancelledAt, locale)}</bdi>
              </dd>
              <dt>{t("batches.fields.cancellationReason")}</dt>
              <dd>{text(data.cancellationReason) || "—"}</dd>
              <dt>{t("batches.columns.succeededCount")}</dt>
              <dd>
                <bdi dir="ltr">{count(data.succeededCount)}</bdi>
              </dd>
              <dt>{t("batches.columns.failedCount")}</dt>
              <dd>
                <bdi dir="ltr">{count(data.failedCount)}</bdi>
              </dd>
              <dt>{t("batches.columns.skippedCount")}</dt>
              <dd>
                <bdi dir="ltr">{count(data.skippedCount)}</bdi>
              </dd>
              <dt>{t("batches.columns.duplicateCount")}</dt>
              <dd>
                <bdi dir="ltr">{count(data.duplicateCount)}</bdi>
              </dd>
            </dl>

            {/* The rule made visible: which single-item service owns the
                verdicts and performs the execution. */}
            <h3>{t("batches.sections.service")}</h3>
            <dl className="accounting-detail-grid">
              <dt>{t("batches.metadata.validationService")}</dt>
              <dd>
                <DirectionalText>{data.metadata.singleItemService.validation}</DirectionalText>
              </dd>
              <dt>{t("batches.metadata.executionService")}</dt>
              <dd>
                <DirectionalText>{data.metadata.singleItemService.execution}</DirectionalText>
              </dd>
              <dt>{t("batches.metadata.sourceType")}</dt>
              <dd>
                <DirectionalText>{data.metadata.singleItemService.sourceType}</DirectionalText>
              </dd>
              <dt>{t("batches.metadata.executionImplemented")}</dt>
              <dd>{data.metadata.executionImplemented ? t("common.yes") : t("common.no")}</dd>
              <dt>{t("batches.metadata.maxItems")}</dt>
              <dd>
                <bdi dir="ltr">{data.metadata.maxItems}</bdi>
              </dd>
            </dl>

            <h3>{t("batches.sections.classification")}</h3>
            <div className="accounting-summary-cards">
              {validationStatuses.map((value) => (
                <div className="accounting-summary-card" key={value}>
                  <span>{t(`batches.classifications.${value}`)}</span>
                  <strong>
                    <span className={`status-badge ${classificationBadge(value)}`}>
                      <bdi dir="ltr">{data.validationCounts[value] ?? 0}</bdi>
                    </span>
                  </strong>
                </div>
              ))}
            </div>

            <h3>{t("batches.sections.timeline")}</h3>
            <div className="table-scroll-x">
              <table className="data-table accounting-table">
                <thead>
                  <tr>
                    <th>{t("batches.columns.fromStatus")}</th>
                    <th>{t("batches.columns.toStatus")}</th>
                    <th>{t("batches.columns.note")}</th>
                    <th>{t("batches.columns.actor")}</th>
                    <th>{t("batches.columns.occurredAt")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.transitions.length === 0 ? (
                    <tr>
                      <td className="accounting-empty" colSpan={5}>
                        {t("batches.empty.timeline")}
                      </td>
                    </tr>
                  ) : (
                    data.transitions.map((row, index) => (
                      <tr key={`${text(row.toStatus)}:${text(row.occurredAt)}:${index}`}>
                        <td>
                          {text(row.fromStatus) === "" ? (
                            "—"
                          ) : (
                            <StatusBadge value={row.fromStatus} />
                          )}
                        </td>
                        <td>
                          <StatusBadge value={row.toStatus} />
                        </td>
                        <td>{text(row.note) || "—"}</td>
                        <td>
                          <DirectionalText>{text(row.actorAccountId)}</DirectionalText>
                        </td>
                        <td>
                          <bdi dir="ltr">{formatAccountingDate(row.occurredAt, locale)}</bdi>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <h3>{t("batches.sections.items")}</h3>
            <label className="accounting-filter-field">
              {t("batches.filters.validationStatus")}
              <select
                onChange={(event) => state.setFilter("validationStatus", event.currentTarget.value)}
                value={state.filters.validationStatus ?? ""}
              >
                <option value="">{t("common.all")}</option>
                <option value="pending">{t("batches.classifications.pending")}</option>
                {validationStatuses.map((value) => (
                  <option key={value} value={value}>
                    {t(`batches.classifications.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            <div className="table-scroll-x">
              <table className="data-table accounting-table">
                <thead>
                  <tr>
                    <th>{t("batches.columns.sourceType")}</th>
                    <th>
                      <SortableHeader
                        label={t("batches.columns.sourceReference")}
                        sortKey="sourceReference"
                        state={state}
                      />
                    </th>
                    <th>{t("batches.columns.sourceId")}</th>
                    <th>
                      <SortableHeader
                        label={t("batches.columns.validationStatus")}
                        sortKey="validationStatus"
                        state={state}
                      />
                    </th>
                    <th>{t("batches.columns.executionStatus")}</th>
                    <th>{t("batches.columns.validationReasons")}</th>
                    <th>{t("batches.columns.errorCode")}</th>
                    <th>{t("batches.columns.errorMessage")}</th>
                    <th>{t("batches.columns.resultingEvent")}</th>
                    <th>{t("batches.columns.resultingJournal")}</th>
                    <th>{t("batches.columns.validatedAt")}</th>
                    <th>{t("batches.columns.executedAt")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.items.length === 0 ? (
                    <tr>
                      <td className="accounting-empty" colSpan={12}>
                        {t("batches.empty.items")}
                      </td>
                    </tr>
                  ) : (
                    data.items.items.map((item) => {
                      const eventHref = recordRoute(
                        "accounting_event",
                        text(item.resultingAccountingEventId) || null,
                      );
                      const journalHref = recordRoute(
                        "journal",
                        text(item.resultingJournalId) || null,
                      );
                      // The item's own source is an Accounting Event, so it has
                      // a detail route whenever its id is present.
                      const sourceHref =
                        text(item.sourceType) === "accounting_event"
                          ? recordRoute("accounting_event", text(item.sourceId) || null)
                          : text(item.sourceType) === "order"
                            ? recordRoute("order", text(item.sourceReference) || null)
                            : text(item.sourceType) === "outsourced_driver_fee_accrual"
                              ? recordRoute(
                                  "outsourced_driver_fee_accrual",
                                  text(item.sourceId) || null,
                                )
                              : undefined;
                      const reasons = Array.isArray(item.validationReasons)
                        ? (item.validationReasons as readonly unknown[])
                        : [];
                      return (
                        <tr key={text(item.id)}>
                          <td>{t(`batches.sourceTypes.${text(item.sourceType)}`)}</td>
                          <td>
                            {sourceHref === undefined ? (
                              <DirectionalText>{text(item.sourceReference) || "—"}</DirectionalText>
                            ) : (
                              <Link to={sourceHref}>
                                <DirectionalText>
                                  {text(item.sourceReference) || text(item.sourceId)}
                                </DirectionalText>
                              </Link>
                            )}
                          </td>
                          <td>
                            <DirectionalText>{text(item.sourceId)}</DirectionalText>
                          </td>
                          <td>
                            <span
                              className={`status-badge ${classificationBadge(
                                text(item.validationStatus),
                              )}`}
                            >
                              {t(`batches.classifications.${text(item.validationStatus)}`, {
                                defaultValue: text(item.validationStatus),
                              })}
                            </span>
                          </td>
                          <td>
                            <StatusBadge value={item.executionStatus} />
                          </td>
                          <td>
                            {reasons.length === 0 ? (
                              "—"
                            ) : (
                              <ul className="accounting-hint">
                                {reasons.map((reason, index) => (
                                  <li key={`${String(reason)}:${index}`}>
                                    {t(`batches.reasons.${String(reason)}`, {
                                      defaultValue: String(reason),
                                    })}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                          <td>
                            <DirectionalText>{text(item.errorCode) || "—"}</DirectionalText>
                          </td>
                          <td>{text(item.errorMessage) || "—"}</td>
                          <td>
                            {eventHref === undefined ? (
                              "—"
                            ) : (
                              <Link to={eventHref}>{t("batches.links.event")}</Link>
                            )}
                          </td>
                          <td>
                            {journalHref === undefined ? (
                              "—"
                            ) : (
                              <Link to={journalHref}>{t("batches.links.journal")}</Link>
                            )}
                          </td>
                          <td>
                            <bdi dir="ltr">{formatAccountingDate(item.validatedAt, locale)}</bdi>
                          </td>
                          <td>
                            <bdi dir="ltr">{formatAccountingDate(item.executedAt, locale)}</bdi>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <AccountingPagination state={state} total={itemTotal} totalPages={itemPages} />
          </>
        )}
      </LoadPanel>

      {dialog === "addItems" ? (
        <AddItemsDialog
          api={api}
          batchId={batchId}
          onClose={() => setDialog(undefined)}
          onDone={() => {
            setDialog(undefined);
            batch.refresh();
          }}
        />
      ) : null}
      {dialog === "execute" && data !== undefined ? (
        <ExecuteBatchDialog
          api={api}
          batch={data}
          batchId={batchId}
          onClose={() => setDialog(undefined)}
          onDone={() => {
            setDialog(undefined);
            setExecuted(true);
            batch.refresh();
          }}
          retry={retry}
          unfinishedEligible={unfinishedEligible}
        />
      ) : null}
      {dialog === "recover" && data !== undefined ? (
        <RecoverBatchDialog
          api={api}
          batch={data}
          batchId={batchId}
          minutesSilent={minutesSilent}
          onClose={() => setDialog(undefined)}
          onDone={() => {
            setDialog(undefined);
            batch.refresh();
          }}
        />
      ) : null}
      {dialog === "cancel" ? (
        <CancelBatchDialog
          api={api}
          batchId={batchId}
          onClose={() => setDialog(undefined)}
          onDone={() => {
            setDialog(undefined);
            batch.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Execute confirmation.
 *
 * States plainly what the user is agreeing to: every item is revalidated by
 * the single-item readiness service immediately before execution, and a batch
 * is NOT one all-or-nothing transaction -- items that succeed stay committed
 * even if a later item fails. Submits the version being looked at as
 * `expectedVersion`, so a batch that changed since review is refused rather
 * than run.
 */
function ExecuteBatchDialog({
  api,
  batch,
  batchId,
  onClose,
  onDone,
  retry,
  unfinishedEligible,
}: {
  readonly api: ApiClient;
  readonly batch: BatchDetail;
  readonly batchId: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly retry: boolean;
  readonly unfinishedEligible: number;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setRunning(true);
    setError(undefined);
    api
      .post(
        `operations/accounting/batches/${batchId}/execute`,
        { expectedVersion: Number(text(batch.version) || count(batch.version)) },
        { "x-idempotency-key": globalThis.crypto.randomUUID() },
      )
      .then(onDone)
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.code : "request_failed");
        setRunning(false);
      });
  };

  return (
    <Modal
      className="accounting-action-dialog"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={
        retry
          ? t("batches.actions.retry")
          : text(batch.batchType) === "historical_accounting_recovery"
            ? t("batches.actions.executeRecovery")
            : t("batches.actions.execute")
      }
      titleId={titleId}
    >
      <div className="modal-body">
      <form onSubmit={submit}>
        {error === undefined ? null : (
          <div className="alert alert-error" role="alert">
            {t(`batches.errors.${error}`, { defaultValue: t("batches.errors.action") })}
          </div>
        )}
        <dl className="accounting-detail-grid">
          <dt>{t("batches.columns.batchReference")}</dt>
          <dd>
            <DirectionalText>{text(batch.batchReference)}</DirectionalText>
          </dd>
          <dt>{t("batches.columns.batchType")}</dt>
          <dd>{t(`batches.types.${text(batch.batchType)}`)}</dd>
          <dt>{t("batches.columns.status")}</dt>
          <dd>
            <StatusBadge value={batch.status} />
          </dd>
          <dt>{t("batches.columns.totalItems")}</dt>
          <dd>
            <bdi dir="ltr">{count(batch.totalItems)}</bdi>
          </dd>
          {validationStatuses.map((value) => (
            <Fragment key={value}>
              <dt>{t(`batches.classifications.${value}`)}</dt>
              <dd>
                <bdi dir="ltr">{batch.validationCounts[value] ?? 0}</bdi>
              </dd>
            </Fragment>
          ))}
          <dt>{t("batches.executeDialog.unfinished")}</dt>
          <dd>
            <bdi dir="ltr">{unfinishedEligible}</bdi>
          </dd>
          {Object.entries(batch.sourceTypeCounts ?? {}).map(([sourceType, count]) => (
            <Fragment key={sourceType}>
              <dt>
                {t(`batches.sourceTypes.${sourceType}`, { defaultValue: sourceType })}
              </dt>
              <dd>
                <bdi dir="ltr">{count}</bdi>
              </dd>
            </Fragment>
          ))}
          <dt>{t("batches.metadata.executionService")}</dt>
          <dd>
            <DirectionalText>{batch.metadata.singleItemService.execution}</DirectionalText>
          </dd>
        </dl>
        <div className="alert alert-warning" role="status">
          {t("batches.executeDialog.revalidationWarning")}
        </div>
        <div className="alert alert-warning" role="status">
          {t("batches.executeDialog.commitWarning")}
        </div>
        {text(batch.batchType) === "historical_accounting_recovery" ? (
          <>
            {/* Recovery-specific contracts, stated where the decision is made:
                nothing is forced past a closed period or an invalid source,
                and the Journal appears later through the normal processor. */}
            <div className="alert alert-warning" role="status">
              {t("batches.executeDialog.recoveryNotForced")}
            </div>
            <div className="alert alert-info" role="status">
              {t("batches.executeDialog.recoveryAsyncJournal")}
            </div>
          </>
        ) : null}
        {retry ? (
          <div className="alert alert-info" role="status">
            {t("batches.executeDialog.retryNote")}
          </div>
        ) : null}
        <div className="accounting-form-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className="button" disabled={running} type="submit">
            {running
              ? t("common.loading")
              : retry
                ? t("batches.actions.retry")
                : text(batch.batchType) === "historical_accounting_recovery"
                  ? t("batches.actions.executeRecovery")
                  : t("batches.actions.execute")}
          </button>
        </div>
      </form>
      </div>
    </Modal>
  );
}

function AddItemsDialog({
  api,
  batchId,
  onClose,
  onDone,
}: {
  readonly api: ApiClient;
  readonly batchId: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const [rawIds, setRawIds] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const ids = parseSourceIds(rawIds);
  const malformed = ids.filter((value) => !uuidPattern.test(value));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    api
      .post(
        `operations/accounting/batches/${batchId}/items`,
        { sourceIds: ids },
        { "x-idempotency-key": globalThis.crypto.randomUUID() },
      )
      .then(onDone)
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
      title={t("batches.actions.addItems")}
      titleId={titleId}
    >
      <div className="modal-body">
      <form onSubmit={submit}>
        {error === undefined ? null : (
          <div className="alert alert-error" role="alert">
            {t(`batches.errors.${error}`, { defaultValue: t("batches.errors.action") })}
          </div>
        )}
        <label>
          {t("batches.fields.sourceIds")}
          <textarea
            dir="ltr"
            onChange={(event) => setRawIds(event.currentTarget.value)}
            rows={8}
            value={rawIds}
          />
        </label>
        <p className="accounting-hint">
          {t("batches.fields.sourceIdsHint", { count: ids.length })}
        </p>
        {/* Duplicates are dropped before sending as a courtesy; the database's
            unique index is what actually guarantees it. */}
        <p className="accounting-hint">{t("batches.fields.duplicateNote")}</p>
        {malformed.length === 0 ? null : (
          <div className="alert alert-error" role="alert">
            {t("batches.errors.malformedIds", { count: malformed.length })}
          </div>
        )}
        <div className="accounting-form-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button
            className="button"
            disabled={saving || ids.length === 0 || malformed.length > 0}
            type="submit"
          >
            {saving ? t("common.loading") : t("batches.actions.addItems")}
          </button>
        </div>
      </form>
      </div>
    </Modal>
  );
}

/**
 * Recover-interrupted-processing confirmation.
 *
 * States what the action actually does: reconciles the batch with what its
 * item rows already durably say and leaves it RETRYABLE -- it executes no
 * accounting entries, reverses nothing, and clears only claims proven
 * abandoned (the backend refuses if a live worker still holds any item).
 * Requires a mandatory reason; sends the reviewed version and a fresh
 * idempotency key.
 */
function RecoverBatchDialog({
  api,
  batch,
  batchId,
  minutesSilent,
  onClose,
  onDone,
}: {
  readonly api: ApiClient;
  readonly batch: BatchDetail;
  readonly batchId: string;
  readonly minutesSilent: number;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const { i18n, t } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const titleId = useId();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  // Unfinished = everything not durably settled, from the server's counters.
  const unfinished =
    count(batch.totalItems) - count(batch.succeededCount) - count(batch.skippedCount);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    api
      .post(
        `operations/accounting/batches/${batchId}/recover-processing`,
        {
          expectedVersion: Number(text(batch.version) || count(batch.version)),
          reason: reason.trim(),
        },
        { "x-idempotency-key": globalThis.crypto.randomUUID() },
      )
      .then(onDone)
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
      title={t("batches.recover.action")}
      titleId={titleId}
    >
      <div className="modal-body">
      <form onSubmit={submit}>
        {error === undefined ? null : (
          <div className="alert alert-error" role="alert">
            {t(`batches.errors.${error}`, { defaultValue: t("batches.recover.refused") })}
          </div>
        )}
        <dl className="accounting-detail-grid">
          <dt>{t("batches.columns.batchReference")}</dt>
          <dd>
            <DirectionalText>{text(batch.batchReference)}</DirectionalText>
          </dd>
          <dt>{t("batches.columns.batchType")}</dt>
          <dd>{t(`batches.types.${text(batch.batchType)}`)}</dd>
          <dt>{t("batches.columns.version")}</dt>
          <dd>
            <bdi dir="ltr">{text(batch.version) || count(batch.version)}</bdi>
          </dd>
          <dt>{t("batches.columns.startedAt")}</dt>
          <dd>
            <bdi dir="ltr">{formatAccountingDate(batch.startedAt, locale)}</bdi>
          </dd>
          <dt>{t("batches.recover.lastActivity")}</dt>
          <dd>
            <bdi dir="ltr">
              {text(batch.lastItemActivityAt) || text(batch.updatedAt) || "—"}
            </bdi>
          </dd>
          <dt>{t("batches.recover.silentFor")}</dt>
          <dd>
            <bdi dir="ltr">{minutesSilent}</bdi> {t("batches.recover.minutes")}
          </dd>
          <dt>{t("batches.columns.succeededCount")}</dt>
          <dd>
            <bdi dir="ltr">{count(batch.succeededCount)}</bdi>
          </dd>
          <dt>{t("batches.columns.failedCount")}</dt>
          <dd>
            <bdi dir="ltr">{count(batch.failedCount)}</bdi>
          </dd>
          <dt>{t("batches.executeDialog.unfinished")}</dt>
          <dd>
            <bdi dir="ltr">{Math.max(0, unfinished)}</bdi>
          </dd>
        </dl>
        <div className="alert alert-warning" role="status">
          {t("batches.recover.warnActive")}
        </div>
        <div className="alert alert-info" role="status">
          {t("batches.recover.warnNoExecution")} {t("batches.recover.warnRetryable")}
        </div>
        <label>
          {t("batches.recover.reason")}
          <textarea
            maxLength={500}
            minLength={5}
            onChange={(event) => setReason(event.currentTarget.value)}
            required
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
            disabled={saving || reason.trim().length < 5}
            type="submit"
          >
            {saving ? t("common.loading") : t("batches.recover.confirm")}
          </button>
        </div>
      </form>
      </div>
    </Modal>
  );
}

/** Cancel changes the batch and nothing else. No batch or item is deleted. */
function CancelBatchDialog({
  api,
  batchId,
  onClose,
  onDone,
}: {
  readonly api: ApiClient;
  readonly batchId: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    api
      .post(
        `operations/accounting/batches/${batchId}/cancel`,
        { reason: reason.trim() },
        { "x-idempotency-key": globalThis.crypto.randomUUID() },
      )
      .then(onDone)
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
      title={t("batches.actions.cancel")}
      titleId={titleId}
    >
      <div className="modal-body">
      <form onSubmit={submit}>
        {error === undefined ? null : (
          <div className="alert alert-error" role="alert">
            {t(`batches.errors.${error}`, { defaultValue: t("batches.errors.action") })}
          </div>
        )}
        <p>{t("batches.cancelExplanation")}</p>
        <label>
          {t("batches.fields.cancellationReason")}
          <textarea
            maxLength={500}
            minLength={5}
            onChange={(event) => setReason(event.currentTarget.value)}
            required
            rows={3}
            value={reason}
          />
        </label>
        <div className="accounting-form-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.close")}
          </button>
          <button className="button" disabled={saving || reason.trim().length < 5} type="submit">
            {saving ? t("common.loading") : t("batches.actions.cancel")}
          </button>
        </div>
      </form>
      </div>
    </Modal>
  );
}
