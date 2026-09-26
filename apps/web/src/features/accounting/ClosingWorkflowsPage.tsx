import { type FormEvent, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

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
import type { AccountingRecord } from "./accounting-types.js";
import { useAccountingResource } from "./use-accounting-resource.js";
import { useListState } from "./use-list-state.js";

/**
 * Accounting Period Closing — workflow list and detail.
 *
 * ===========================================================================
 * THIS SCREEN CLOSES NOTHING
 * ===========================================================================
 *
 * It records and displays the human process that PRECEDES a close. No action
 * here closes or reopens a period, writes a Journal, or moves a balance. The
 * two transitions that would coincide with that -- Close and Reopen -- are
 * deliberately absent from the action list: the backend refuses them until the
 * execution exists, and offering a button that always fails is worse than
 * offering none.
 *
 * ===========================================================================
 * THE BACKEND DECIDES; THIS SCREEN ANTICIPATES
 * ===========================================================================
 *
 * The API does not return an allowed-actions list, so the transition map below
 * is a conservative local copy used ONLY to decide which buttons to render and
 * which to disable. It is never the authority: every action is sent and the
 * server's answer is what happens. Where the two could disagree the screen
 * shows fewer options, never more, and a refusal is rendered from the API's own
 * error code rather than guessed at.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY NOT SHOWN
 * ===========================================================================
 *
 * A checklist task has a status, an assignee and notes. It has no due date, no
 * priority and no completion evidence, because `closing_workflow_tasks` has no
 * columns for them -- due date and priority live on the workflow. Rendering
 * empty fields for the three missing ones would imply data that cannot exist.
 */

type WorkflowStatus =
  | "approved"
  | "blocked"
  | "cancelled"
  | "changes_requested"
  | "closed"
  | "draft"
  | "in_progress"
  | "ready_for_approval"
  | "ready_for_review"
  | "reopened"
  | "under_review";

type TaskStatus = "blocked" | "completed" | "in_progress" | "not_applicable" | "pending";

const priorities = ["low", "normal", "high", "critical"] as const;
const workflowTypes = ["monthly", "year_end"] as const;
const taskStatuses: readonly TaskStatus[] = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "not_applicable",
];

/**
 * Mirrors `closingStatusTransitions` on the server, minus the two execution
 * moves. Used for rendering only -- see the file header.
 */
const allowedTransitions: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
  approved: ["changes_requested", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  cancelled: [],
  changes_requested: ["in_progress", "cancelled"],
  // `closed -> reopened` exists on the server but is refused; nothing is
  // offered here so the screen never presents a certain failure.
  closed: [],
  draft: ["in_progress", "cancelled"],
  in_progress: ["blocked", "ready_for_review", "cancelled"],
  ready_for_approval: ["approved", "changes_requested", "cancelled"],
  ready_for_review: ["under_review", "cancelled"],
  reopened: ["in_progress", "cancelled"],
  under_review: ["ready_for_approval", "changes_requested", "cancelled"],
};

/** Which permission each destination needs, mirroring the service. */
const transitionPermission: Readonly<Record<WorkflowStatus, "approve" | "manage">> = {
  approved: "approve",
  blocked: "manage",
  cancelled: "manage",
  changes_requested: "approve",
  closed: "approve",
  draft: "manage",
  in_progress: "manage",
  ready_for_approval: "approve",
  ready_for_review: "manage",
  reopened: "approve",
  under_review: "approve",
};

/** Destinations the server refuses without a reason. */
const reasonRequired: readonly WorkflowStatus[] = ["cancelled", "changes_requested"];

/** Destinations the server gates on readiness. */
const readinessGated: readonly WorkflowStatus[] = ["approved", "ready_for_approval"];

type ExecutionMode = "close" | "reopen" | "yearEnd";

/** Each execution mode's own endpoint. None of them is a status transition. */
const executionEndpoint: Readonly<Record<ExecutionMode, string>> = {
  close: "close",
  reopen: "reopen",
  yearEnd: "year-end-execute",
};

/** What the Year-End endpoint reports having written. Displayed, never derived. */
interface YearEndResult {
  readonly carryForwardJournalId?: string;
  readonly carryForwardJournalNumber?: string;
  readonly closingJournalId?: string;
  readonly closingJournalNumber?: string;
  readonly firstPeriodId?: string;
  readonly netResult?: string;
  readonly nextFiscalYearId?: string;
  readonly periodCount?: number;
  readonly status?: string;
}

type ReadinessStatus = "failed" | "not_applicable" | "passed" | "warning";

interface ReadinessCheckResult {
  readonly amount?: string;
  readonly checkVersion?: number;
  readonly checkedAt?: string;
  readonly checkedByAccountId?: string;
  readonly count?: number;
  readonly message?: string;
  readonly reference?: string;
  readonly status?: ReadinessStatus;
  readonly taskKey?: string;
}

interface ReadinessState {
  readonly checkVersion: number;
  readonly checkedAt: string | null;
  readonly checks: readonly ReadinessCheckResult[];
  readonly readyForApproval: boolean;
  readonly summary: {
    readonly failed: number;
    readonly notApplicable: number;
    readonly passed: number;
    readonly warning: number;
  };
}

/**
 * A source reference is only followed when it is an in-application path.
 *
 * The value arrives from the API, and a link built from server data that turned
 * out to be absolute would navigate a user off the product. Anything not
 * starting with a single `/` is rendered as plain text instead of a link.
 */
const internalRoute = (value: unknown): string | undefined => {
  const route = typeof value === "string" ? value.trim() : "";
  return route.startsWith("/") && !route.startsWith("//") ? route : undefined;
};

const filterKeys = [
  "workflowType",
  "status",
  "priority",
  "fiscalYearId",
  "accountingPeriodId",
  "dueFrom",
  "dueTo",
  "workflowNumber",
  "lifecycle",
];

interface WorkflowListRow extends AccountingRecord {
  readonly id: string;
}

interface WorkflowPage {
  readonly items: readonly WorkflowListRow[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalCount: number;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): readonly AccountingRecord[] =>
  Array.isArray(value) ? (value as readonly AccountingRecord[]) : [];

/**
 * Active Company users, for the assignee pickers.
 *
 * The Users list is paginated and returns an envelope; `pageSize` accepts only
 * 25, 50 or 100, so 100 is the largest page this can ask for. Shared by the
 * create dialog and the checklist so the two cannot offer different people.
 */
function useCompanyUsers(api: ApiClient, companyId: string) {
  const users = useAccountingResource<{ readonly items: readonly AccountingRecord[] }>(
    accountingQueryKey(companyId, "closing:users"),
    (signal) =>
      api.get<{ readonly items: readonly AccountingRecord[] }>("users?pageSize=100", signal),
  );
  const options = (users.data?.items ?? []).filter(
    (user) => typeof user.id === "string" && typeof user.username === "string",
  );
  return { error: users.error, options };
}

export function ClosingWorkflowsPage({
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
    <ClosingWorkflowList
      api={api}
      companyId={companyId}
      onNavigate={onNavigate}
      permissions={permissions}
    />
  ) : (
    <ClosingWorkflowDetail
      api={api}
      companyId={companyId}
      onNavigate={onNavigate}
      permissions={permissions}
      workflowId={id}
    />
  );
}

function ClosingWorkflowList({
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
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const canManage = hasPermission(permissions, "manage");
  const state = useListState({ companyId, defaultSortBy: "dueDate", filterKeys });
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

  const workflows = useAccountingResource<WorkflowPage>(
    accountingQueryKey(companyId, "closing-workflows", query),
    (signal) =>
      api.get<WorkflowPage>(
        `accounting/closing-workflows?${new URLSearchParams(query).toString()}`,
        signal,
      ),
  );

  const total = workflows.data?.totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));

  return (
    <section className="accounting-page">
      <PageHeader
        actions={
          canManage ? (
            <button className="button" onClick={() => setCreating(true)} type="button">
              {t("closing.actions.create")}
            </button>
          ) : undefined
        }
        description={t("closing.intro")}
        title={t("closing.heading")}
      />

      <div className="accounting-filters">
        <label className="field">
          <span>{t("closing.fields.workflowType")}</span>
          <select
            onChange={(event) => state.setFilter("workflowType", event.target.value)}
            value={state.filters.workflowType ?? ""}
          >
            <option value="">{t("common.all")}</option>
            {workflowTypes.map((option) => (
              <option key={option} value={option}>
                {t(`closing.types.${option}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("closing.fields.status")}</span>
          <select
            onChange={(event) => state.setFilter("status", event.target.value)}
            value={state.filters.status ?? ""}
          >
            <option value="">{t("common.all")}</option>
            {Object.keys(allowedTransitions).map((option) => (
              <option key={option} value={option}>
                {t(`closing.statuses.${option}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("closing.fields.priority")}</span>
          <select
            onChange={(event) => state.setFilter("priority", event.target.value)}
            value={state.filters.priority ?? ""}
          >
            <option value="">{t("common.all")}</option>
            {priorities.map((option) => (
              <option key={option} value={option}>
                {t(`closing.priorities.${option}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("closing.fields.lifecycle")}</span>
          <select
            onChange={(event) => state.setFilter("lifecycle", event.target.value)}
            value={state.filters.lifecycle ?? ""}
          >
            <option value="">{t("common.all")}</option>
            <option value="active">{t("closing.lifecycle.active")}</option>
            <option value="finished">{t("closing.lifecycle.finished")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("closing.fields.workflowNumber")}</span>
          <input
            dir="ltr"
            onChange={(event) => state.setFilter("workflowNumber", event.target.value)}
            value={state.filters.workflowNumber ?? ""}
          />
        </label>
        <label className="field">
          <span>{t("closing.fields.dueFrom")}</span>
          <input
            dir="ltr"
            onChange={(event) => state.setFilter("dueFrom", event.target.value)}
            type="date"
            value={state.filters.dueFrom ?? ""}
          />
        </label>
        <label className="field">
          <span>{t("closing.fields.dueTo")}</span>
          <input
            dir="ltr"
            onChange={(event) => state.setFilter("dueTo", event.target.value)}
            type="date"
            value={state.filters.dueTo ?? ""}
          />
        </label>
        {state.activeFilterCount === 0 ? null : (
          <button className="button button-secondary" onClick={state.clearFilters} type="button">
            {t("accounting.list.clearFilters")}
          </button>
        )}
      </div>

      <LoadPanel
        error={workflows.error}
        loading={workflows.loading}
        onRefresh={workflows.refresh}
      >
        {(workflows.data?.items.length ?? 0) === 0 ? (
          <p className="accounting-empty">{t("closing.empty.list")}</p>
        ) : (
          <div className="table-shell accounting-table-shell">
            <table className="data-table accounting-table">
              <thead>
                <tr>
                  <th scope="col">
                    <SortableHeader
                      label={t("closing.fields.workflowNumber")}
                      sortKey="workflowNumber"
                      state={state}
                    />
                  </th>
                  <th scope="col">{t("closing.fields.workflowType")}</th>
                  <th scope="col">{t("closing.fields.fiscalYear")}</th>
                  <th scope="col">{t("closing.fields.period")}</th>
                  <th scope="col">
                    <SortableHeader
                      label={t("closing.fields.status")}
                      sortKey="status"
                      state={state}
                    />
                  </th>
                  <th scope="col">
                    <SortableHeader
                      label={t("closing.fields.priority")}
                      sortKey="priority"
                      state={state}
                    />
                  </th>
                  <th scope="col">
                    <SortableHeader
                      label={t("closing.fields.dueDate")}
                      preferred="asc"
                      sortKey="dueDate"
                      state={state}
                    />
                  </th>
                  <th scope="col">{t("closing.fields.assignedTo")}</th>
                  <th scope="col">{t("closing.fields.progress")}</th>
                  <th scope="col">
                    <SortableHeader
                      label={t("closing.fields.createdAt")}
                      sortKey="createdAt"
                      state={state}
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {(workflows.data?.items ?? []).map((row) => (
                  <tr key={String(row.id)}>
                    <td>
                      <button
                        className="link-button"
                        onClick={() =>
                          onNavigate(
                            `/accounting/closing-workflows/${encodeURIComponent(String(row.id))}`,
                          )
                        }
                        type="button"
                      >
                        <bdi dir="ltr">{text(row.workflowNumber)}</bdi>
                      </button>
                    </td>
                    <td>{t(`closing.types.${text(row.workflowType)}`)}</td>
                    <td>
                      <bdi dir="ltr">{text(row.fiscalYearCode) || "—"}</bdi>
                    </td>
                    <td>
                      <DirectionalText>
                        {text(row.periodName) || text(row.periodCode) || "—"}
                      </DirectionalText>
                    </td>
                    <td>
                      <StatusBadge value={row.status} />
                    </td>
                    <td>{t(`closing.priorities.${text(row.priority)}`)}</td>
                    <td>
                      <bdi dir="ltr">{formatAccountingDate(row.dueDate, locale)}</bdi>
                    </td>
                    <td>
                      <DirectionalText>{text(row.assignedToUsername) || "—"}</DirectionalText>
                    </td>
                    {/* Counted by the server, not here: a list that computed
                        its own progress would eventually disagree with the
                        detail page. */}
                    <td>
                      <bdi dir="ltr">
                        {typeof row.taskCount === "number"
                          ? `${String(row.completedTaskCount ?? 0)}/${String(row.taskCount)}`
                          : "—"}
                      </bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatAccountingDate(row.createdAt, locale)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <AccountingPagination state={state} total={total} totalPages={totalPages} />
      </LoadPanel>

      {creating ? (
        <CreateWorkflowDialog
          api={api}
          companyId={companyId}
          onClose={() => setCreating(false)}
          onCreated={(workflowId) => {
            setCreating(false);
            onNavigate(`/accounting/closing-workflows/${encodeURIComponent(workflowId)}`);
          }}
        />
      ) : null}
    </section>
  );
}

function CreateWorkflowDialog({
  api,
  companyId,
  onClose,
  onCreated,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly onClose: () => void;
  readonly onCreated: (workflowId: string) => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const [workflowType, setWorkflowType] = useState<"monthly" | "year_end">("monthly");
  const [fiscalYearId, setFiscalYearId] = useState("");
  const [accountingPeriodId, setAccountingPeriodId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState<(typeof priorities)[number]>("normal");
  const [assignedToAccountId, setAssignedToAccountId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ details?: readonly string[]; message: string }>();

  const years = useAccountingResource<readonly AccountingRecord[]>(
    accountingQueryKey(companyId, "closing:fiscal-years"),
    (signal) => api.get<readonly AccountingRecord[]>("operations/accounting/fiscal-years", signal),
  );
  const periods = useAccountingResource<readonly AccountingRecord[]>(
    accountingQueryKey(companyId, "closing:fiscal-periods", { fiscalYearId }),
    (signal) =>
      fiscalYearId === ""
        ? Promise.resolve([])
        : api.get<readonly AccountingRecord[]>(
            `operations/accounting/fiscal-periods?fiscalYearId=${encodeURIComponent(fiscalYearId)}`,
            signal,
          ),
  );
  const users = useCompanyUsers(api, companyId);

  // Year-End belongs to the whole fiscal year and to no single period, so the
  // field is HIDDEN rather than disabled: a greyed control still reads as a
  // setting that exists.
  const periodApplies = workflowType === "monthly";
  const complete =
    fiscalYearId !== "" &&
    dueDate !== "" &&
    assignedToAccountId !== "" &&
    (!periodApplies || accountingPeriodId !== "");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    api
      .post<{ id: string }>(
        "accounting/closing-workflows",
        {
          ...(periodApplies ? { accountingPeriodId } : {}),
          assignedToAccountId,
          dueDate,
          fiscalYearId,
          ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
          priority,
          workflowType,
        },
        { "x-idempotency-key": globalThis.crypto.randomUUID() },
      )
      .then((created) => onCreated(created.id))
      .catch((cause: unknown) => {
        setSaving(false);
        setError({
          ...(cause instanceof ApiError && cause.details !== undefined
            ? { details: cause.details }
            : {}),
          message: t(
            `closing.errors.${cause instanceof ApiError ? cause.code : "unknown"}`,
            { defaultValue: t("closing.errors.save") },
          ),
        });
      });
  };

  const userOptions = users.options;

  return (
    // The shared Modal, not hand-rolled markup: it owns focus trapping, the
    // Escape key and body scroll locking, which a bespoke overlay would have to
    // reimplement and would get subtly wrong.
    <Modal
      className="accounting-action-dialog"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("closing.create.heading")}
      titleId={titleId}
    >
      <div className="modal-body">
        <form onSubmit={submit}>
          <div className="cp-fields">
            <label className="field">
              <span>{t("closing.fields.workflowType")}</span>
              <select
                onChange={(event) => {
                  setWorkflowType(event.target.value as "monthly" | "year_end");
                  setAccountingPeriodId("");
                }}
                value={workflowType}
              >
                {workflowTypes.map((option) => (
                  <option key={option} value={option}>
                    {t(`closing.types.${option}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>
                {t("closing.fields.fiscalYear")}
                <span className="accounting-field-required">*</span>
              </span>
              <select
                onChange={(event) => {
                  setFiscalYearId(event.target.value);
                  setAccountingPeriodId("");
                }}
                value={fiscalYearId}
              >
                <option value="">{t("common.select")}</option>
                {(years.data ?? []).map((year) => (
                  <option key={String(year.id)} value={String(year.id)}>
                    {String(year.fiscalYearCode ?? year.name ?? year.id)}
                  </option>
                ))}
              </select>
              {years.error === undefined ? null : (
                <small className="accounting-account-status">{t("closing.errors.options")}</small>
              )}
            </label>
            {periodApplies ? (
              <label className="field">
                <span>
                  {t("closing.fields.period")}
                  <span className="accounting-field-required">*</span>
                </span>
                <select
                  disabled={fiscalYearId === ""}
                  onChange={(event) => setAccountingPeriodId(event.target.value)}
                  value={accountingPeriodId}
                >
                  <option value="">{t("common.select")}</option>
                  {(periods.data ?? []).map((period) => (
                    <option key={String(period.id)} value={String(period.id)}>
                      {String(period.name ?? period.periodCode ?? period.id)}
                    </option>
                  ))}
                </select>
                {fiscalYearId === "" ? (
                  <small className="accounting-account-status">
                    {t("closing.create.selectYearFirst")}
                  </small>
                ) : null}
              </label>
            ) : null}
            <label className="field">
              <span>
                {t("closing.fields.dueDate")}
                <span className="accounting-field-required">*</span>
              </span>
              <input
                dir="ltr"
                onChange={(event) => setDueDate(event.target.value)}
                required
                type="date"
                value={dueDate}
              />
            </label>
            <label className="field">
              <span>{t("closing.fields.priority")}</span>
              <select
                onChange={(event) =>
                  setPriority(event.target.value as (typeof priorities)[number])
                }
                value={priority}
              >
                {priorities.map((option) => (
                  <option key={option} value={option}>
                    {t(`closing.priorities.${option}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>
                {t("closing.fields.assignedTo")}
                <span className="accounting-field-required">*</span>
              </span>
              <select
                onChange={(event) => setAssignedToAccountId(event.target.value)}
                value={assignedToAccountId}
              >
                <option value="">{t("common.select")}</option>
                {userOptions.map((user) => (
                  <option key={String(user.id)} value={String(user.id)}>
                    {String(user.username)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field-wide">
              <span>{t("closing.fields.notes")}</span>
              <textarea
                maxLength={2000}
                onChange={(event) => setNotes(event.target.value)}
                value={notes}
              />
            </label>
          </div>

          {error === undefined ? null : (
            <div className="alert alert-error" role="alert">
              <p>{error.message}</p>
              {error.details === undefined ? null : (
                <ul>
                  {error.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="accounting-filter-actions">
            <button className="button" disabled={!complete || saving} type="submit">
              {t("closing.actions.create")}
            </button>
            <button
              className="button button-secondary"
              onClick={onClose}
              type="button"
            >
              {t("common.cancel")}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

function ClosingWorkflowDetail({
  api,
  companyId,
  onNavigate,
  permissions,
  workflowId,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly onNavigate: (path: string) => void;
  readonly permissions: readonly string[];
  readonly workflowId: string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const canManage = hasPermission(permissions, "manage");
  const canApprove = hasPermission(permissions, "approve");
  const [status, setStatus] = useState<{ kind: "error" | "success"; message: string }>();
  const [pending, setPending] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const [commentTaskId, setCommentTaskId] = useState("");
  const [transitionTarget, setTransitionTarget] = useState<WorkflowStatus>();
  const [transitionReason, setTransitionReason] = useState("");
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  // Close, Reopen and Year-End are EXECUTION, not transitions, and are held in
  // their own state so they can never be routed through the transition
  // confirmation.
  const [executionMode, setExecutionMode] = useState<ExecutionMode>();
  const [executionReason, setExecutionReason] = useState("");
  // The server's own report of what it wrote. Rendered verbatim; nothing about
  // the outcome is recomputed here.
  const [executionResult, setExecutionResult] = useState<YearEndResult>();
  const users = useCompanyUsers(api, companyId);

  const workflow = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "closing-workflow", { workflowId }),
    (signal) =>
      api.get<AccountingRecord>(
        `accounting/closing-workflows/${encodeURIComponent(workflowId)}`,
        signal,
      ),
  );

  // The stored readiness summary. Separate from the workflow so running a
  // check refreshes both without conflating "what the checklist says" with
  // "what the automated evidence says".
  const readiness = useAccountingResource<ReadinessState>(
    accountingQueryKey(companyId, "closing-readiness", { workflowId }),
    (signal) =>
      api.get<ReadinessState>(
        `accounting/closing-workflows/${encodeURIComponent(workflowId)}/readiness`,
        signal,
      ),
  );

  const data = workflow.data;
  const currentStatus = text(data?.status) as WorkflowStatus;
  const version = typeof data?.version === "number" ? data.version : 0;
  const tasks = list(data?.tasks);
  const comments = list(data?.comments);
  const attachments = list(data?.attachments);
  const reviews = list(data?.reviews);
  const transitions = list(data?.transitions);
  const completedTasks = tasks.filter(
    (task) => task.status === "completed" || task.status === "not_applicable",
  ).length;

  // Mandatory tasks the server has never evaluated. The readiness endpoint
  // returns only tasks that HAVE a stored result, so an unevaluated one is
  // invisible there -- and the approval gate treats it as not passed. Counted
  // from the per-task data the detail already returns, so nothing is guessed.
  const notEvaluated = tasks.filter(
    (task) => task.isMandatory === true && (task.checkResult ?? null) === null,
  ).length;
  /**
   * Resolve a stored actor id to a name.
   *
   * The check payload records `checkedByAccountId` because the task table has
   * no actor column, and a raw uuid is not an identity a person can read. It is
   * resolved against the Company user list already loaded for the assignee
   * pickers, and falls back to an em dash rather than printing the id.
   */
  const usernameFor = (accountId: unknown): string => {
    const id = text(accountId);
    if (id === "") return "—";
    const match = users.options.find((user) => String(user.id) === id);
    return match === undefined ? "—" : String(match.username);
  };

  const failedChecks = readiness.data?.summary.failed ?? 0;
  const blockingChecks = failedChecks + notEvaluated;
  const hasStoredReadiness = (readiness.data?.checks.length ?? 0) > 0;
  const readyForApproval = (readiness.data?.readyForApproval ?? false) && notEvaluated === 0;

  const report = (cause: unknown) =>
    setStatus({
      kind: "error",
      message: t(`closing.errors.${cause instanceof ApiError ? cause.code : "unknown"}`, {
        defaultValue: t("closing.errors.action"),
      }),
    });

  const run = (work: Promise<unknown>, successKey: string) => {
    setPending(true);
    setStatus(undefined);
    work
      .then(() => {
        setStatus({ kind: "success", message: t(successKey) });
        workflow.refresh();
        readiness.refresh();
      })
      .catch(report)
      .finally(() => setPending(false));
  };

  /**
   * Run the automated checks.
   *
   * Advances nothing: the endpoint stores results and the screen re-reads them.
   * The workflow status is never changed here, by this call or by this screen.
   */
  const runReadinessCheck = () =>
    run(
      api.post(`accounting/closing-workflows/${encodeURIComponent(workflowId)}/readiness-check`),
      "closing.status.readinessChecked",
    );

  /**
   * Execute the Monthly close or reopen.
   *
   * Calls ONLY the dedicated endpoints. These are deliberately not reachable
   * through the transition action map: the generic endpoint moves a workflow
   * status and nothing else, while these move the accounting period with it.
   *
   * The route is preserved on success -- the reader stays on the record whose
   * state just changed, with the timeline and readiness refreshed beneath them.
   */
  const submitExecution = () => {
    if (executionMode === undefined) return;
    const mode = executionMode;
    const reason = executionReason.trim();
    setPending(true);
    setStatus(undefined);
    api
      .post<YearEndResult>(
        `accounting/closing-workflows/${encodeURIComponent(workflowId)}/${executionEndpoint[mode]}`,
        mode === "reopen"
          ? { reason, version }
          : { ...(reason === "" ? {} : { reason }), version },
        { "x-idempotency-key": globalThis.crypto.randomUUID() },
      )
      .then((result) => {
        setStatus({
          kind: "success",
          message: t(
            mode === "close"
              ? "closing.status.periodClosed"
              : mode === "reopen"
                ? "closing.status.periodReopened"
                : "closing.status.yearEndExecuted",
          ),
        });
        // Only Year-End reports what it wrote; the other two have nothing to
        // show beyond the refreshed record itself.
        if (mode === "yearEnd") setExecutionResult(result);
        // The route is preserved: the reader stays on the record whose state
        // just changed, with the timeline and checklist refreshed beneath them.
        workflow.refresh();
        readiness.refresh();
      })
      .catch(report)
      .finally(() => setPending(false));
    setExecutionMode(undefined);
    setExecutionReason("");
  };

  const workflowType = text(data?.workflowType);
  const isMonthly = workflowType === "monthly";
  // Every condition the backend also enforces. The screen shows fewer options
  // than the server allows, never more.
  const canClose = isMonthly && currentStatus === "approved" && canApprove && readyForApproval;
  const canReopen = isMonthly && currentStatus === "closed" && canApprove;
  const canExecuteYearEnd =
    workflowType === "year_end" && currentStatus === "approved" && canApprove && readyForApproval;

  const submitTransition = () => {
    if (transitionTarget === undefined) return;
    run(
      api.post(
        `accounting/closing-workflows/${encodeURIComponent(workflowId)}/transitions`,
        {
          ...(transitionReason.trim() === "" ? {} : { reason: transitionReason.trim() }),
          toStatus: transitionTarget,
          // Sent with EVERY transition: the server refuses a stale one rather
          // than applying a decision made against a workflow that has moved.
          version,
        },
        { "x-idempotency-key": globalThis.crypto.randomUUID() },
      ),
      "closing.status.transitioned",
    );
    setTransitionTarget(undefined);
    setTransitionReason("");
  };

  const availableTransitions = allowedTransitions[currentStatus] ?? [];

  return (
    <section className="accounting-page">
      <PageHeader
        actions={
          <button
            className="button button-secondary"
            onClick={() => onNavigate("/accounting/closing-workflows")}
            type="button"
          >
            {t("common.back")}
          </button>
        }
        description={t("closing.detail.subtitle")}
        title={`${t("closing.detail.heading")} ${text(data?.workflowNumber)}`}
      />

      {status === undefined ? null : (
        <p
          className={`alert ${status.kind === "error" ? "alert-error" : ""}`}
          role={status.kind === "error" ? "alert" : "status"}
        >
          {status.message}
        </p>
      )}

      <LoadPanel error={workflow.error} loading={workflow.loading} onRefresh={workflow.refresh}>
        <dl className="reconciliation-summary">
          <div>
            <dt>{t("closing.fields.status")}</dt>
            <dd>
              <StatusBadge value={currentStatus} />
            </dd>
          </div>
          <div>
            <dt>{t("closing.fields.workflowType")}</dt>
            <dd>{t(`closing.types.${text(data?.workflowType)}`)}</dd>
          </div>
          <div>
            <dt>{t("closing.fields.fiscalYear")}</dt>
            <dd>
              {typeof data?.fiscalYearId === "string" ? (
                <button
                  className="link-button"
                  onClick={() =>
                    onNavigate(
                      `/accounting/fiscal-years/${encodeURIComponent(String(data.fiscalYearId))}`,
                    )
                  }
                  type="button"
                >
                  <bdi dir="ltr">{text(data.fiscalYearCode) || t("closing.detail.openYear")}</bdi>
                </button>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>{t("closing.fields.period")}</dt>
            <dd>
              {typeof data?.accountingPeriodId === "string" ? (
                <button
                  className="link-button"
                  onClick={() =>
                    onNavigate(
                      `/accounting/fiscal-periods/${encodeURIComponent(
                        String(data.accountingPeriodId),
                      )}`,
                    )
                  }
                  type="button"
                >
                  <DirectionalText>
                    {text(data.periodName) || text(data.periodCode) || t("closing.detail.openPeriod")}
                  </DirectionalText>
                </button>
              ) : (
                t("closing.detail.wholeYear")
              )}
            </dd>
          </div>
          <div>
            <dt>{t("closing.fields.priority")}</dt>
            <dd>{t(`closing.priorities.${text(data?.priority)}`)}</dd>
          </div>
          <div>
            <dt>{t("closing.fields.dueDate")}</dt>
            <dd>
              <bdi dir="ltr">{formatAccountingDate(data?.dueDate, locale)}</bdi>
            </dd>
          </div>
          <div>
            <dt>{t("closing.fields.assignedTo")}</dt>
            <dd>
              <DirectionalText>{text(data?.assignedToUsername) || "—"}</DirectionalText>
            </dd>
          </div>
          <div>
            <dt>{t("closing.fields.progress")}</dt>
            <dd>
              <bdi dir="ltr">
                {completedTasks}/{tasks.length}
              </bdi>
            </dd>
          </div>
          {/* The three maker-checker identities, always visible: who prepared,
              who reviewed and who approved is the point of the control. */}
          <div>
            <dt>{t("closing.fields.submittedBy")}</dt>
            <dd>
              <DirectionalText>{text(data?.submittedByUsername) || "—"}</DirectionalText>
              {data?.submittedAt === null || data?.submittedAt === undefined ? null : (
                <>
                  {" "}
                  <bdi dir="ltr">{formatAccountingDate(data.submittedAt, locale)}</bdi>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>{t("closing.fields.reviewedBy")}</dt>
            <dd>
              <DirectionalText>{text(data?.reviewedByUsername) || "—"}</DirectionalText>
              {data?.reviewedAt === null || data?.reviewedAt === undefined ? null : (
                <>
                  {" "}
                  <bdi dir="ltr">{formatAccountingDate(data.reviewedAt, locale)}</bdi>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>{t("closing.fields.approvedBy")}</dt>
            <dd>
              <DirectionalText>{text(data?.approvedByUsername) || "—"}</DirectionalText>
              {data?.approvedAt === null || data?.approvedAt === undefined ? null : (
                <>
                  {" "}
                  <bdi dir="ltr">{formatAccountingDate(data.approvedAt, locale)}</bdi>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>{t("closing.fields.version")}</dt>
            <dd>
              <bdi dir="ltr">{version}</bdi>
            </dd>
          </div>
        </dl>

        <h3>{t("closing.readiness.heading")}</h3>
        {canManage ? (
          <div className="accounting-filter-actions">
            <button
              className="button button-secondary"
              disabled={pending}
              onClick={runReadinessCheck}
              type="button"
            >
              {t("closing.actions.runReadiness")}
            </button>
          </div>
        ) : null}
        <LoadPanel
          error={readiness.error}
          loading={readiness.loading}
          onRefresh={readiness.refresh}
        >
          {!hasStoredReadiness ? (
            <p className="accounting-empty">{t("closing.readiness.neverRun")}</p>
          ) : (
            <dl className="reconciliation-summary">
              <div>
                <dt>{t("closing.readiness.readyLabel")}</dt>
                <dd>
                  <strong>
                    {readyForApproval ? t("closing.readiness.ready") : t("closing.readiness.notReady")}
                  </strong>
                </dd>
              </div>
              <div>
                {/* The timestamp is stated and nothing is claimed beyond it:
                    the backend exposes no freshness rule, so the screen does
                    not invent one. */}
                <dt>{t("closing.readiness.lastChecked")}</dt>
                <dd>
                  <bdi dir="ltr">
                    {readiness.data?.checkedAt == null
                      ? "—"
                      : new Date(readiness.data.checkedAt).toLocaleString(locale)}
                  </bdi>
                </dd>
              </div>
              <div>
                <dt>{t("closing.readiness.checkedBy")}</dt>
                <dd>
                  <DirectionalText>
                    {usernameFor(readiness.data?.checks[0]?.checkedByAccountId)}
                  </DirectionalText>
                </dd>
              </div>
              <div>
                <dt>{t("closing.readiness.passed")}</dt>
                <dd>
                  <bdi dir="ltr">{readiness.data?.summary.passed ?? 0}</bdi>
                </dd>
              </div>
              <div>
                <dt>{t("closing.readiness.failed")}</dt>
                <dd>
                  <bdi dir="ltr">{failedChecks}</bdi>
                </dd>
              </div>
              <div>
                <dt>{t("closing.readiness.warning")}</dt>
                <dd>
                  <bdi dir="ltr">{readiness.data?.summary.warning ?? 0}</bdi>
                </dd>
              </div>
              <div>
                <dt>{t("closing.readiness.notApplicable")}</dt>
                <dd>
                  <bdi dir="ltr">{readiness.data?.summary.notApplicable ?? 0}</bdi>
                </dd>
              </div>
              <div>
                <dt>{t("closing.readiness.blocking")}</dt>
                <dd>
                  <bdi dir="ltr">{blockingChecks}</bdi>
                </dd>
              </div>
              {notEvaluated === 0 ? null : (
                <div>
                  <dt>{t("closing.readiness.notEvaluated")}</dt>
                  <dd>
                    <bdi dir="ltr">{notEvaluated}</bdi>
                  </dd>
                </div>
              )}
            </dl>
          )}
        </LoadPanel>

        <h3>{t("closing.detail.actionsHeading")}</h3>
        {availableTransitions.length === 0 ? (
          <p className="accounting-hint">{t("closing.detail.noActions")}</p>
        ) : (
          <div className="accounting-filter-actions">
            {availableTransitions.map((target) => {
              const needsApprove = transitionPermission[target] === "approve";
              const permitted = needsApprove ? canApprove : canManage;
              // Readiness blocks ONLY the two gated moves. Every other valid
              // action stays available: a workflow that fails its checks still
              // needs to be sent back for changes or cancelled.
              const gated = readinessGated.includes(target) && !readyForApproval;
              return (
                <button
                  className="button button-secondary"
                  disabled={!permitted || gated || pending}
                  key={target}
                  onClick={() => {
                    setTransitionTarget(target);
                    setTransitionReason("");
                  }}
                  title={
                    gated
                      ? t("closing.readiness.blockedAction", { count: blockingChecks })
                      : permitted
                        ? undefined
                        : t(
                            needsApprove
                              ? "closing.detail.needsApprovePermission"
                              : "closing.detail.needsManagePermission",
                          )
                  }
                  type="button"
                >
                  {t(`closing.transitions.${target}`)}
                </button>
              );
            })}
          </div>
        )}
        {/* Named, not just counted: "two checks are blocking" is not actionable
            without knowing which two. */}
        {readyForApproval || !hasStoredReadiness ? null : (
          <div className="alert alert-error" role="alert">
            <p>{t("closing.readiness.blockedExplanation")}</p>
            <ul>
              {(readiness.data?.checks ?? [])
                .filter((check) => check.status === "failed")
                .map((check) => (
                  <li key={String(check.taskKey)}>
                    <DirectionalText>{check.message ?? String(check.taskKey)}</DirectionalText>
                  </li>
                ))}
              {tasks
                .filter(
                  (task) => task.isMandatory === true && (task.checkResult ?? null) === null,
                )
                .map((task) => (
                  <li key={`unevaluated-${String(task.id)}`}>
                    <DirectionalText>{text(task.taskLabel)}</DirectionalText>
                    {" — "}
                    {t("closing.readiness.notEvaluated")}
                  </li>
                ))}
            </ul>
          </div>
        )}
        {/* Maker-checker cannot be decided here: whether this actor submitted
            the workflow is the server's judgement, and it refuses with an
            explaining code. The note sets the expectation before the click. */}
        <p className="accounting-hint">{t("closing.detail.makerCheckerNote")}</p>

        {/* Execution, kept visibly apart from the transition actions above:
            these two are the only actions on this screen that change what may
            still be posted to an accounting period. */}
        {canClose || canReopen || canExecuteYearEnd ? (
          <div className="accounting-filter-actions">
            {canExecuteYearEnd ? (
              <button
                className="button"
                disabled={pending}
                onClick={() => {
                  setExecutionMode("yearEnd");
                  setExecutionReason("");
                }}
                type="button"
              >
                {t("closing.execution.yearEnd")}
              </button>
            ) : null}
            {canClose ? (
              <button
                className="button"
                disabled={pending}
                onClick={() => {
                  setExecutionMode("close");
                  setExecutionReason("");
                }}
                type="button"
              >
                {t("closing.execution.close")}
              </button>
            ) : null}
            {canReopen ? (
              <button
                className="button button-secondary"
                disabled={pending}
                onClick={() => {
                  setExecutionMode("reopen");
                  setExecutionReason("");
                }}
                type="button"
              >
                {t("closing.execution.reopen")}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* What the Year-End execution reported writing. Rendered from the
            server's response only -- no figure here is derived, and the
            Journal links use the ids it returned. */}
        {executionResult === undefined ? null : (
          <div className="alert" role="status">
            <strong>{t("closing.execution.resultHeading")}</strong>
            <dl className="reconciliation-summary">
              <div>
                <dt>{t("closing.execution.closingJournal")}</dt>
                <dd>
                  {executionResult.closingJournalId === undefined ||
                  executionResult.closingJournalId === "" ? (
                    "—"
                  ) : (
                    <button
                      className="link-button"
                      onClick={() =>
                        onNavigate(
                          `/accounting/journals/${encodeURIComponent(
                            String(executionResult.closingJournalId),
                          )}`,
                        )
                      }
                      type="button"
                    >
                      <bdi dir="ltr">{executionResult.closingJournalNumber ?? "—"}</bdi>
                    </button>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("closing.execution.carryForwardJournal")}</dt>
                <dd>
                  {executionResult.carryForwardJournalId === undefined ||
                  executionResult.carryForwardJournalId === "" ? (
                    "—"
                  ) : (
                    <button
                      className="link-button"
                      onClick={() =>
                        onNavigate(
                          `/accounting/journals/${encodeURIComponent(
                            String(executionResult.carryForwardJournalId),
                          )}`,
                        )
                      }
                      type="button"
                    >
                      <bdi dir="ltr">{executionResult.carryForwardJournalNumber ?? "—"}</bdi>
                    </button>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("closing.execution.nextFiscalYear")}</dt>
                <dd>
                  {executionResult.nextFiscalYearId === undefined ? (
                    "—"
                  ) : (
                    <button
                      className="link-button"
                      onClick={() =>
                        onNavigate(
                          `/accounting/fiscal-years/${encodeURIComponent(
                            String(executionResult.nextFiscalYearId),
                          )}`,
                        )
                      }
                      type="button"
                    >
                      {t("closing.execution.openNextYear")}
                    </button>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("closing.execution.periodsCreated")}</dt>
                <dd>
                  <bdi dir="ltr">{executionResult.periodCount ?? "—"}</bdi>
                </dd>
              </div>
              <div>
                <dt>{t("closing.execution.firstPeriodOpened")}</dt>
                <dd>
                  {executionResult.firstPeriodId === undefined ? (
                    "—"
                  ) : (
                    <button
                      className="link-button"
                      onClick={() =>
                        onNavigate(
                          `/accounting/fiscal-periods/${encodeURIComponent(
                            String(executionResult.firstPeriodId),
                          )}`,
                        )
                      }
                      type="button"
                    >
                      {t("closing.detail.openPeriod")}
                    </button>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("closing.fields.status")}</dt>
                <dd>
                  <StatusBadge value={executionResult.status} />
                </dd>
              </div>
            </dl>
          </div>
        )}

        {transitionTarget === undefined ? null : (
          <div className="alert" role="status">
            <p>{t("closing.detail.confirmTransition", { status: t(`closing.statuses.${transitionTarget}`) })}</p>
            {reasonRequired.includes(transitionTarget) ? (
              <label className="field field-wide">
                <span>
                  {t("closing.fields.reason")}
                  <span className="accounting-field-required">*</span>
                </span>
                <input
                  maxLength={1000}
                  onChange={(event) => setTransitionReason(event.target.value)}
                  value={transitionReason}
                />
              </label>
            ) : null}
            <div className="accounting-filter-actions">
              <button
                className="button"
                disabled={
                  pending ||
                  (reasonRequired.includes(transitionTarget) && transitionReason.trim() === "")
                }
                onClick={submitTransition}
                type="button"
              >
                {t("common.confirm")}
              </button>
              <button
                className="button button-secondary"
                onClick={() => setTransitionTarget(undefined)}
                type="button"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}

        <h3>{t("closing.detail.checklistHeading")}</h3>
        {tasks.length === 0 ? (
          <p className="accounting-empty">{t("closing.empty.tasks")}</p>
        ) : (
          <div className="table-shell accounting-table-shell">
            <table className="data-table accounting-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">{t("closing.fields.task")}</th>
                  <th scope="col">{t("closing.fields.status")}</th>
                  <th scope="col">{t("closing.fields.assignedTo")}</th>
                  <th scope="col">{t("closing.fields.completedBy")}</th>
                  <th scope="col">{t("closing.fields.notes")}</th>
                  {/* A separate column, deliberately: the automated evidence and
                      the person's checklist status are different claims and must
                      not be read as one. Nothing here writes to the manual
                      status, notes, assignee, comments or attachments. */}
                  <th scope="col">{t("closing.readiness.columnHeading")}</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={String(task.id)}>
                    <td>
                      <bdi dir="ltr">{String(task.sequence ?? "")}</bdi>
                    </td>
                    <td>
                      <DirectionalText>{text(task.taskLabel)}</DirectionalText>
                      {task.isMandatory === true ? (
                        <span className="accounting-field-required" title={t("closing.fields.mandatory")}>
                          *
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {canManage ? (
                        <select
                          disabled={pending}
                          onChange={(event) =>
                            run(
                              api.patch(
                                `accounting/closing-workflows/${encodeURIComponent(
                                  workflowId,
                                )}/tasks/${encodeURIComponent(String(task.id))}`,
                                { status: event.target.value },
                              ),
                              "closing.status.taskUpdated",
                            )
                          }
                          value={text(task.status)}
                        >
                          {taskStatuses.map((option) => (
                            <option key={option} value={option}>
                              {t(`closing.taskStatuses.${option}`)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <StatusBadge value={task.status} />
                      )}
                    </td>
                    <td>
                      {canManage ? (
                        // The empty option CLEARS the assignment: the endpoint
                        // treats an absent assignee as "unassign", and the
                        // service clears assignee, assigner and instant
                        // together so a cleared task cannot keep claiming who
                        // assigned it.
                        <select
                          aria-label={t("closing.fields.assignedTo")}
                          disabled={pending}
                          onChange={(event) =>
                            run(
                              api.post(
                                `accounting/closing-workflows/${encodeURIComponent(
                                  workflowId,
                                )}/tasks/${encodeURIComponent(String(task.id))}/assign`,
                                event.target.value === ""
                                  ? {}
                                  : { assignedToAccountId: event.target.value },
                              ),
                              "closing.status.taskAssigned",
                            )
                          }
                          value={text(task.assignedToAccountId)}
                        >
                          <option value="">{t("closing.detail.unassigned")}</option>
                          {users.options.map((user) => (
                            <option key={String(user.id)} value={String(user.id)}>
                              {String(user.username)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <DirectionalText>{text(task.assignedToUsername) || "—"}</DirectionalText>
                      )}
                    </td>
                    <td>
                      <DirectionalText>
                        {text(task.completedByUsername) || "—"}
                      </DirectionalText>
                      {task.completedAt === null || task.completedAt === undefined ? null : (
                        <>
                          {" "}
                          <bdi dir="ltr">{formatAccountingDate(task.completedAt, locale)}</bdi>
                        </>
                      )}
                    </td>
                    <td>
                      <DirectionalText>{text(task.notes) || "—"}</DirectionalText>
                    </td>
                    <td>
                      <ReadinessCell
                        locale={locale}
                        onNavigate={onNavigate}
                        result={(task.checkResult ?? null) as ReadinessCheckResult | null}
                        usernameFor={usernameFor}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3>{t("closing.detail.commentsHeading")}</h3>
        {comments.length === 0 ? (
          <p className="accounting-empty">{t("closing.empty.comments")}</p>
        ) : (
          <ul className="balance-controls-schedule">
            {comments.map((comment) => (
              <li key={String(comment.id)}>
                <DirectionalText>{text(comment.authorUsername)}</DirectionalText>{" "}
                <bdi dir="ltr">{formatAccountingDate(comment.createdAt, locale)}</bdi>
                {" — "}
                <DirectionalText>{text(comment.body)}</DirectionalText>
              </li>
            ))}
          </ul>
        )}
        {/* Append-only: there is no edit and no delete affordance anywhere. */}
        <div className="cp-fields">
          <label className="field">
            <span>{t("closing.fields.commentTask")}</span>
            <select onChange={(event) => setCommentTaskId(event.target.value)} value={commentTaskId}>
              <option value="">{t("closing.detail.wholeWorkflow")}</option>
              {tasks.map((task) => (
                <option key={String(task.id)} value={String(task.id)}>
                  {text(task.taskLabel)}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-wide">
            <span>{t("closing.fields.comment")}</span>
            <textarea
              maxLength={4000}
              onChange={(event) => setCommentBody(event.target.value)}
              value={commentBody}
            />
          </label>
        </div>
        <div className="accounting-filter-actions">
          <button
            className="button button-secondary"
            disabled={pending || commentBody.trim() === ""}
            onClick={() => {
              run(
                api.post(
                  `accounting/closing-workflows/${encodeURIComponent(workflowId)}/comments`,
                  {
                    body: commentBody.trim(),
                    ...(commentTaskId === "" ? {} : { taskId: commentTaskId }),
                  },
                ),
                "closing.status.commentAdded",
              );
              setCommentBody("");
            }}
            type="button"
          >
            {t("closing.actions.addComment")}
          </button>
        </div>

        <h3>{t("closing.detail.attachmentsHeading")}</h3>
        <p className="accounting-hint">{t("closing.detail.attachmentsNote")}</p>
        {canManage ? (
          <div className="accounting-filter-actions">
            <button
              className="button button-secondary"
              disabled={pending}
              onClick={() => setAttachmentOpen(true)}
              type="button"
            >
              {t("closing.actions.addAttachment")}
            </button>
          </div>
        ) : null}
        {attachments.length === 0 ? (
          <p className="accounting-empty">{t("closing.empty.attachments")}</p>
        ) : (
          <div className="table-shell accounting-table-shell">
            <table className="data-table accounting-table">
              <thead>
                <tr>
                  <th scope="col">{t("closing.fields.fileName")}</th>
                  <th scope="col">{t("closing.fields.contentType")}</th>
                  <th scope="col">{t("closing.fields.byteSize")}</th>
                  <th scope="col">{t("closing.fields.storageKey")}</th>
                  <th scope="col">{t("closing.fields.uploadedBy")}</th>
                </tr>
              </thead>
              <tbody>
                {attachments.map((attachment) => (
                  <tr key={String(attachment.id)}>
                    <td>
                      <DirectionalText>{text(attachment.fileName)}</DirectionalText>
                    </td>
                    <td>
                      <bdi dir="ltr">{text(attachment.contentType) || "—"}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{text(attachment.byteSize) || "—"}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{text(attachment.storageKey)}</bdi>
                    </td>
                    <td>
                      <DirectionalText>{text(attachment.uploadedByUsername) || "—"}</DirectionalText>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3>{t("closing.detail.reviewsHeading")}</h3>
        {reviews.length === 0 ? (
          <p className="accounting-empty">{t("closing.empty.reviews")}</p>
        ) : (
          <ul className="balance-controls-schedule">
            {reviews.map((review) => (
              <li key={String(review.id)}>
                {t(`closing.reviewStages.${text(review.reviewStage)}`)} —{" "}
                {t(`closing.decisions.${text(review.decision)}`)} —{" "}
                <DirectionalText>{text(review.decidedByUsername)}</DirectionalText>{" "}
                <bdi dir="ltr">{formatAccountingDate(review.decidedAt, locale)}</bdi>
                {text(review.comments) === "" ? null : (
                  <>
                    {" — "}
                    <DirectionalText>{text(review.comments)}</DirectionalText>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        <h3>{t("closing.detail.timelineHeading")}</h3>
        <p className="accounting-hint">{t("closing.detail.timelineNote")}</p>
        {transitions.length === 0 ? (
          <p className="accounting-empty">{t("closing.empty.timeline")}</p>
        ) : (
          <ul className="balance-controls-schedule">
            {transitions.map((entry) => (
              <li key={String(entry.id)}>
                <bdi dir="ltr">{formatAccountingDate(entry.createdAt, locale)}</bdi>
                {" — "}
                {text(entry.fromStatus) === ""
                  ? t("closing.timeline.created")
                  : t("closing.timeline.moved", {
                      from: t(`closing.statuses.${text(entry.fromStatus)}`),
                      to: t(`closing.statuses.${text(entry.toStatus)}`),
                    })}
                {" — "}
                <DirectionalText>{text(entry.actorUsername)}</DirectionalText>
                {text(entry.reason) === "" ? null : (
                  <>
                    {" — "}
                    <DirectionalText>{text(entry.reason)}</DirectionalText>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </LoadPanel>

      {executionMode === undefined ? null : (
        <ExecutionConfirmDialog
          fiscalYear={text(data?.fiscalYearCode)}
          mode={executionMode}
          onCancel={() => {
            setExecutionMode(undefined);
            setExecutionReason("");
          }}
          onConfirm={submitExecution}
          onReasonChange={setExecutionReason}
          pending={pending}
          period={text(data?.periodName) || text(data?.periodCode)}
          // The one backend-sourced statement about period state available on
          // this screen. Not recomputed here.
          periodReadiness={
            (readiness.data?.checks ?? []).find(
              (check) => check.taskKey === "all_monthly_periods_closed",
            )?.message
          }
          reason={executionReason}
          status={currentStatus}
          summary={
            readiness.data === undefined
              ? undefined
              : {
                  failed: failedChecks,
                  notApplicable: readiness.data.summary.notApplicable,
                  passed: readiness.data.summary.passed,
                  warning: readiness.data.summary.warning,
                }
          }
          workflowNumber={text(data?.workflowNumber)}
        />
      )}

      {attachmentOpen ? (
        <AttachmentMetadataDialog
          api={api}
          onClose={() => setAttachmentOpen(false)}
          onSaved={() => {
            setAttachmentOpen(false);
            setStatus({ kind: "success", message: t("closing.status.attachmentAdded") });
            workflow.refresh();
          }}
          tasks={tasks}
          workflowId={workflowId}
        />
      ) : null}
    </section>
  );
}

/**
 * Confirmation for the two actions that change an accounting period.
 *
 * It restates what is about to happen against WHICH record -- workflow number,
 * fiscal year, period and current status -- because both actions are easy to
 * fire from the wrong tab, and neither is a status change a person can simply
 * click back.
 *
 * The consequence is stated before the reason field, not after: a reader
 * should learn that the period stops accepting new accounting activity before
 * they start composing a justification for doing it.
 */
function ExecutionConfirmDialog({
  fiscalYear,
  mode,
  onCancel,
  onConfirm,
  onReasonChange,
  pending,
  period,
  periodReadiness,
  reason,
  status,
  summary,
  workflowNumber,
}: {
  readonly fiscalYear: string;
  readonly mode: ExecutionMode;
  readonly periodReadiness?: string | undefined;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onReasonChange: (value: string) => void;
  readonly pending: boolean;
  readonly period: string;
  readonly reason: string;
  readonly status: string;
  readonly summary?:
    | {
        readonly failed: number;
        readonly notApplicable: number;
        readonly passed: number;
        readonly warning: number;
      }
    | undefined;
  readonly workflowNumber: string;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  // Reopen must say why; the database itself refuses a reopened period without
  // a reason, so requiring it here avoids a round trip that could only fail.
  const reasonRequiredHere = mode === "reopen";
  const ready = !reasonRequiredHere || reason.trim().length >= 3;

  return (
    <Modal
      className="accounting-action-dialog"
      closeLabel={t("common.close")}
      onRequestClose={onCancel}
      title={t(`closing.execution.${mode}Heading`)}
      titleId={titleId}
    >
      <div className="modal-body">
        <dl className="reconciliation-summary">
          <div>
            <dt>{t("closing.fields.workflowNumber")}</dt>
            <dd>
              <bdi dir="ltr">{workflowNumber || "—"}</bdi>
            </dd>
          </div>
          <div>
            <dt>{t("closing.fields.fiscalYear")}</dt>
            <dd>
              <bdi dir="ltr">{fiscalYear || "—"}</bdi>
            </dd>
          </div>
          <div>
            <dt>{t("closing.fields.period")}</dt>
            <dd>
              <DirectionalText>{period || "—"}</DirectionalText>
            </dd>
          </div>
          <div>
            <dt>{t("closing.fields.status")}</dt>
            <dd>
              <StatusBadge value={status} />
            </dd>
          </div>
          {mode !== "reopen" && summary !== undefined ? (
            <div>
              <dt>{t("closing.readiness.heading")}</dt>
              <dd>
                <bdi dir="ltr">
                  {t("closing.execution.readinessLine", {
                    failed: summary.failed,
                    notApplicable: summary.notApplicable,
                    passed: summary.passed,
                    warning: summary.warning,
                  })}
                </bdi>
              </dd>
            </div>
          ) : null}
          {mode === "yearEnd" && periodReadiness !== undefined ? (
            <div>
              <dt>{t("closing.execution.periodStatus")}</dt>
              <dd>
                <DirectionalText>{periodReadiness}</DirectionalText>
              </dd>
            </div>
          ) : null}
        </dl>

        <p className="alert alert-error" role="alert">
          {t(`closing.execution.${mode}Warning`)}
        </p>

        {/* Enumerated, not summarised: this single confirmation authorises
            seven distinct financial actions, and a reader is entitled to see
            each one before agreeing to all of them. */}
        {mode === "yearEnd" ? (
          <ul className="balance-controls-schedule">
            {[
              "closingJournal",
              "transferResult",
              "carryForward",
              "nextYear",
              "nextPeriods",
              "openFirst",
              "lockYear",
            ].map((step) => (
              <li key={step}>{t(`closing.execution.steps.${step}`)}</li>
            ))}
          </ul>
        ) : null}

        <label className="field field-wide">
          <span>
            {t("closing.fields.reason")}
            {reasonRequiredHere ? <span className="accounting-field-required">*</span> : null}
          </span>
          <input
            maxLength={1000}
            minLength={reasonRequiredHere ? 3 : 0}
            onChange={(event) => onReasonChange(event.target.value)}
            required={reasonRequiredHere}
            value={reason}
          />
          {reasonRequiredHere ? (
            <small className="accounting-account-status">
              {t("closing.execution.reasonHint")}
            </small>
          ) : null}
        </label>

        <div className="accounting-filter-actions">
          <button className="button" disabled={!ready || pending} onClick={onConfirm} type="button">
            {t(`closing.execution.${mode}Confirm`)}
          </button>
          <button className="button button-secondary" onClick={onCancel} type="button">
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * One task's automated readiness result.
 *
 * Read-only by construction: it renders what the server stored and offers no
 * control that could change it. The manual checklist status lives in its own
 * column and is untouched by anything here -- a task can be marked Completed by
 * a person while its automated check reads Failed, and both statements stay
 * visible because they are different claims.
 *
 * A task with no stored result renders "Not Evaluated", which is deliberately
 * distinct from a check that ran and passed.
 */
function ReadinessCell({
  locale,
  onNavigate,
  result,
  usernameFor,
}: {
  readonly locale: string;
  readonly onNavigate: (path: string) => void;
  readonly result: ReadinessCheckResult | null;
  readonly usernameFor: (accountId: unknown) => string;
}) {
  const { t } = useTranslation();
  if (result === null || typeof result !== "object" || result.status === undefined) {
    return <span className="accounting-hint">{t("closing.readiness.notEvaluated")}</span>;
  }
  const route = internalRoute(result.reference);
  return (
    <div>
      {/* The badge markup of StatusBadge, but with the readiness label: that
          component Title-Cases an unknown key, which would render "Not
          Applicable" as something the glossary never defined. */}
      <span
        className={`status-badge accounting-status status-${result.status.replaceAll("_", "-")}`}
      >
        {t(
          `closing.readiness.${result.status === "not_applicable" ? "notApplicable" : result.status}`,
        )}
      </span>
      <div>
        <DirectionalText>{result.message ?? ""}</DirectionalText>
      </div>
      {result.count === undefined ? null : (
        <div>
          {t("closing.readiness.count")}: <bdi dir="ltr">{result.count}</bdi>
        </div>
      )}
      {result.amount === undefined ? null : (
        <div>
          {t("closing.readiness.amount")}: <bdi dir="ltr">{result.amount}</bdi>
        </div>
      )}
      <div className="accounting-hint">
        {result.checkedAt === undefined ? null : (
          <bdi dir="ltr">{new Date(result.checkedAt).toLocaleString(locale)}</bdi>
        )}{" "}
        <DirectionalText>{usernameFor(result.checkedByAccountId)}</DirectionalText>
        {result.checkVersion === undefined ? null : (
          <>
            {" "}
            <bdi dir="ltr">v{result.checkVersion}</bdi>
          </>
        )}
      </div>
      {/* Only for a check that actually carries a route. Nothing is fabricated
          for a check without one. */}
      {route === undefined ? null : (
        <button className="link-button" onClick={() => onNavigate(route)} type="button">
          {t("closing.readiness.openSource")}
        </button>
      )}
    </div>
  );
}

/**
 * Attachment METADATA, and nothing else.
 *
 * There is no file input, no FormData, no upload and no download anywhere in
 * this dialog. It records where a file already lives -- its name, type, size
 * and storage reference -- because the closing evidence and the bytes are kept
 * apart on purpose: an attachment can be re-hosted without rewriting what a
 * completed checklist said.
 *
 * A file picker here would be a lie about a capability that does not exist.
 */
function AttachmentMetadataDialog({
  api,
  onClose,
  onSaved,
  tasks,
  workflowId,
}: {
  readonly api: ApiClient;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly tasks: readonly AccountingRecord[];
  readonly workflowId: string;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const [taskId, setTaskId] = useState("");
  const [fileName, setFileName] = useState("");
  const [contentType, setContentType] = useState("");
  const [byteSize, setByteSize] = useState("");
  const [storageKey, setStorageKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const size = Number.parseInt(byteSize, 10);
  const sizeValid = byteSize.trim() === "" || (Number.isInteger(size) && size >= 0);
  const complete = fileName.trim() !== "" && storageKey.trim() !== "" && sizeValid;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    api
      .post(`accounting/closing-workflows/${encodeURIComponent(workflowId)}/attachments`, {
        ...(byteSize.trim() === "" ? {} : { byteSize: size }),
        ...(contentType.trim() === "" ? {} : { contentType: contentType.trim() }),
        fileName: fileName.trim(),
        storageKey: storageKey.trim(),
        ...(taskId === "" ? {} : { taskId }),
      })
      .then(onSaved)
      .catch((cause: unknown) => {
        setSaving(false);
        setError(
          t(`closing.errors.${cause instanceof ApiError ? cause.code : "unknown"}`, {
            defaultValue: t("closing.errors.attachment"),
          }),
        );
      });
  };

  return (
    <Modal
      className="accounting-action-dialog"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("closing.attachment.heading")}
      titleId={titleId}
    >
      <div className="modal-body">
        {/* Stated before the fields, not after: a reader must learn this
            records a reference rather than uploading a file BEFORE they fill
            it in expecting a picker. */}
        <p className="accounting-hint">{t("closing.attachment.externalNote")}</p>
        <form onSubmit={submit}>
          <div className="cp-fields">
            <label className="field">
              <span>{t("closing.fields.commentTask")}</span>
              <select onChange={(event) => setTaskId(event.target.value)} value={taskId}>
                <option value="">{t("closing.detail.wholeWorkflow")}</option>
                {tasks.map((task) => (
                  <option key={String(task.id)} value={String(task.id)}>
                    {text(task.taskLabel)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>
                {t("closing.fields.fileName")}
                <span className="accounting-field-required">*</span>
              </span>
              <input
                maxLength={300}
                onChange={(event) => setFileName(event.target.value)}
                required
                value={fileName}
              />
            </label>
            <label className="field">
              <span>{t("closing.fields.contentType")}</span>
              <input
                dir="ltr"
                maxLength={150}
                onChange={(event) => setContentType(event.target.value)}
                placeholder="application/pdf"
                value={contentType}
              />
            </label>
            <label className="field">
              <span>{t("closing.fields.byteSize")}</span>
              <input
                dir="ltr"
                inputMode="numeric"
                min="0"
                onChange={(event) => setByteSize(event.target.value)}
                step="1"
                type="number"
                value={byteSize}
              />
            </label>
            <label className="field field-wide">
              <span>
                {t("closing.fields.storageKey")}
                <span className="accounting-field-required">*</span>
              </span>
              <input
                dir="ltr"
                maxLength={500}
                onChange={(event) => setStorageKey(event.target.value)}
                required
                value={storageKey}
              />
            </label>
          </div>

          {error === undefined ? null : (
            <p className="alert alert-error" role="alert">
              {error}
            </p>
          )}

          <div className="accounting-filter-actions">
            <button className="button" disabled={!complete || saving} type="submit">
              {t("closing.actions.addAttachment")}
            </button>
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
