import { type FormEvent, type ReactElement, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  type CompanyOrderHealthPage,
  type CompanyOrderHealthSummary,
  type ManualReviewExplanation,
  type OrderHealth,
  type OrderHealthDateScope,
  type OrderHealthFilter,
  type OrderHealthRow,
  type OrderRepairFindings,
  type OrderVerification,
  type RepairDependencyNode,
  type RepairExecutionResult,
  type RepairFinding,
  type RepairIssue,
  type RepairPlanPreview,
  type Repairability,
  platformApi,
  platformApiErrorMessage,
  PlatformApiError,
} from "../api/platform-client.js";
import { AccountingHealthPanel } from "./AccountingHealthPanel.js";
import { PayrollHealthPanel } from "./PayrollHealthPanel.js";
import { RepairCenterOverviewPanel } from "./RepairCenterOverviewPanel.js";
import { type RepairHistoryFocus, RepairHistoryPanel } from "./RepairHistoryPanel.js";

/**
 * Platform Administration -> Companies -> Company -> Repair Center.
 *
 * READ-ONLY foundation. Answers one question for ONE selected Company:
 * "does this Company currently have any problematic orders?"
 *
 * Everything shown is computed live by the server for the Company named in
 * the URL (summary, filtering and pagination all happen in PostgreSQL);
 * nothing is stored and nothing here can change data. There is deliberately
 * no repair, reset, reverse or reprocess control on this page.
 *
 * The list is high level: Order number, date, delivery status, health and a
 * plain-language reason. Settlement, Receivable and Journal numbers appear
 * only in View Details: Finding Details (what is wrong, why, what correct
 * looks like, whether a certified repair exists) above the existing Verify
 * First. For a READY finding, "Preview Repair" shows what the certified
 * repair WOULD change and what it would leave untouched.
 *
 * Execution (Prompt 3): ONLY a READY preview of an executable certified
 * capability offers "Execute Repair", behind a confirmation that restates
 * the Order, finding, repair, changes, preserved history and warnings and
 * requires a reason. One idempotency key per attempt (reused by Retry); a
 * stale preview is never retried automatically -- the page re-diagnoses and
 * asks for a fresh review. After success it refreshes Health and verifies
 * again. BLOCKED / MANUAL_REVIEW / NOT_REQUIRED never offer execution, and
 * there is no reset, reverse, reprocess, force-status or bulk control.
 */

const PAGE_SIZE = 25;

const healthFilters: readonly { value: OrderHealthFilter; label: string }[] = [
  { label: "Issues & Reviews", value: "attention" },
  { label: "Issues", value: "issue" },
  { label: "Reviews", value: "review" },
  { label: "Healthy", value: "healthy" },
  { label: "All", value: "all" },
];

const dateScopes: readonly { value: OrderHealthDateScope; label: string }[] = [
  { label: "Today", value: "today" },
  { label: "Last 7 days", value: "last7" },
  { label: "Last 30 days", value: "last30" },
  { label: "Custom", value: "custom" },
  { label: "All", value: "all" },
];

const deliveryStatuses: readonly { value: string; label: string }[] = [
  { label: "New", value: "new" },
  { label: "In branch", value: "in_branch" },
  { label: "Assigned to driver", value: "assigned_to_driver" },
  { label: "Out for delivery", value: "out_for_delivery" },
  { label: "Hold", value: "hold" },
  { label: "Delivered", value: "delivered" },
  { label: "Returned to branch", value: "returned_to_branch" },
  { label: "Returned to trader", value: "returned_to_trader" },
  { label: "Cancelled", value: "cancelled" },
  { label: "Closed", value: "closed" },
  { label: "Collect order", value: "collect_order" },
];

const healthLabel: Record<OrderHealth, string> = {
  HEALTHY: "Healthy",
  ISSUE: "Issue",
  REVIEW: "Review",
};

const healthBadge: Record<OrderHealth, string> = {
  HEALTHY: "platform-badge platform-badge--active",
  ISSUE: "platform-badge platform-badge--severity-high",
  REVIEW: "platform-badge platform-badge--severity-medium",
};

const repairabilityLabel: Record<Repairability, string> = {
  BLOCKED: "Blocked",
  MANUAL_REVIEW: "Manual review",
  NOT_REQUIRED: "Not required",
  READY: "Ready",
};

const repairabilityBadge: Record<Repairability, string> = {
  BLOCKED: "platform-badge platform-badge--severity-high",
  MANUAL_REVIEW: "platform-badge platform-badge--severity-medium",
  NOT_REQUIRED: "platform-badge platform-badge--active",
  READY: "platform-badge platform-badge--ready",
};

function RepairabilityBadge({ value }: { readonly value: Repairability }): ReactElement {
  return (
    <span className={repairabilityBadge[value]} data-testid="repairability">
      {repairabilityLabel[value]}
    </span>
  );
}

/** Server refusals that mean "what you reviewed is no longer the state". */
const STALE_CODES = new Set([
  "repair_preview_stale",
  "repair_finding_not_current",
  "repair_not_ready",
  "repair_capability_not_applicable",
]);

interface ExecutionState {
  /** One key per execution attempt; kept for Retry, dropped after stale/success. */
  readonly attemptKey?: string | undefined;
  readonly reason: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly running: boolean;
  readonly result?: RepairExecutionResult | undefined;
  readonly error?: string | undefined;
  readonly stale?: boolean | undefined;
  /** Network / timeout / server error: the outcome is unknown, Retry is safe. */
  readonly retryable?: boolean | undefined;
}

const emptyExecution: ExecutionState = { inputs: {}, reason: "", running: false };

function newAttemptKey(): string {
  return `rc-ui-${globalThis.crypto.randomUUID()}`;
}

function statusLabel(value: string): string {
  return deliveryStatuses.find((status) => status.value === value)?.label ?? value;
}

function errorText(failure: unknown): string {
  return failure instanceof PlatformApiError
    ? failure.message
    : platformApiErrorMessage(0, undefined, undefined);
}

function HealthBadge({ health }: { readonly health: OrderHealth }): ReactElement {
  return <span className={healthBadge[health]}>{healthLabel[health]}</span>;
}

interface Filters {
  readonly health: OrderHealthFilter;
  readonly scope: OrderHealthDateScope;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly search: string;
  readonly deliveryStatus: string;
  readonly reasonCode: string;
}

const defaultFilters: Filters = {
  dateFrom: "",
  dateTo: "",
  deliveryStatus: "",
  health: "attention",
  reasonCode: "",
  scope: "last30",
  search: "",
};

export function RepairCenterPage(): ReactElement {
  const { companyId = "" } = useParams();
  const [draft, setDraft] = useState<Filters>(defaultFilters);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [page, setPage] = useState(1);
  const [refreshToken, setRefreshToken] = useState(0);
  const [summary, setSummary] = useState<CompanyOrderHealthSummary>();
  const [list, setList] = useState<CompanyOrderHealthPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [details, setDetails] = useState<{
    row: OrderHealthRow;
    verification?: OrderVerification;
    error?: string;
  }>();
  const [findings, setFindings] = useState<{
    orderId: string;
    result?: OrderRepairFindings;
    error?: string;
  }>();
  const [preview, setPreview] = useState<{
    reasonCode: string;
    result?: RepairPlanPreview;
    error?: string;
  }>();
  const [execution, setExecution] = useState<ExecutionState>(emptyExecution);
  /** Bumped after every repair attempt: refreshes the landing and History. */
  const [historyToken, setHistoryToken] = useState(0);
  const [historyFocus, setHistoryFocus] = useState<RepairHistoryFocus>();
  const viewRepairRecord = (repairExecutionId: string): void =>
    setHistoryFocus((current) => ({ id: repairExecutionId, kind: "execution", nonce: (current?.nonce ?? 0) + 1 }));
  const repairAttempted = (): void => setHistoryToken((value) => value + 1);

  const scopeQuery = useCallback(
    (value: Filters) =>
      value.scope === "custom"
        ? { dateFrom: value.dateFrom, dateTo: value.dateTo, scope: value.scope }
        : { scope: value.scope },
    [],
  );

  useEffect(() => {
    if (filters.scope === "custom" && (filters.dateFrom === "" || filters.dateTo === "")) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void Promise.all([
      platformApi.orderHealthSummary(companyId, scopeQuery(filters)),
      platformApi.orderHealthList(companyId, {
        ...scopeQuery(filters),
        deliveryStatus: filters.deliveryStatus,
        health: filters.health,
        page,
        pageSize: PAGE_SIZE,
        reasonCode: filters.reasonCode,
        search: filters.search.trim(),
      }),
    ])
      .then(([nextSummary, nextList]) => {
        if (cancelled) return;
        setSummary(nextSummary);
        setList(nextList);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(errorText(failure));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, filters, page, refreshToken, scopeQuery]);

  const apply = (event: FormEvent): void => {
    event.preventDefault();
    if (draft.scope === "custom" && (draft.dateFrom === "" || draft.dateTo === "")) {
      setError("Choose both a start and an end date for a custom range.");
      return;
    }
    setPage(1);
    setFilters(draft);
  };

  const openDetails = (row: OrderHealthRow): void => {
    setDetails({ row });
    setFindings({ orderId: row.orderId });
    setPreview(undefined);
    setExecution(emptyExecution);
    void platformApi
      .verifyOrder(companyId, row.orderId)
      .then((verification) => setDetails({ row, verification }))
      .catch((failure: unknown) => setDetails({ error: errorText(failure), row }));
    void platformApi
      .orderFindings(companyId, row.orderId)
      .then((result) => setFindings({ orderId: row.orderId, result }))
      .catch((failure: unknown) => setFindings({ error: errorText(failure), orderId: row.orderId }));
  };

  const closeDetails = (): void => {
    setDetails(undefined);
    setFindings(undefined);
    setPreview(undefined);
    setExecution(emptyExecution);
  };

  /** Verify Again: re-read Verify First and the findings, live. */
  const reloadDetails = (row: OrderHealthRow): Promise<OrderRepairFindings | undefined> => {
    void platformApi
      .verifyOrder(companyId, row.orderId)
      .then((verification) => setDetails({ row, verification }))
      .catch((failure: unknown) => setDetails({ error: errorText(failure), row }));
    return platformApi
      .orderFindings(companyId, row.orderId)
      .then((result) => {
        setFindings({ orderId: row.orderId, result });
        return result;
      })
      .catch((failure: unknown) => {
        setFindings({ error: errorText(failure), orderId: row.orderId });
        return undefined;
      });
  };

  const executeRepair = (row: OrderHealthRow, plan: RepairPlanPreview): void => {
    if (execution.running || plan.proposedRepair === null) return;
    const attemptKey = execution.attemptKey ?? newAttemptKey();
    const inputs = Object.fromEntries(
      Object.entries(execution.inputs).filter(([, value]) => value.trim() !== ""),
    );
    setExecution({
      ...execution,
      attemptKey,
      error: undefined,
      result: undefined,
      retryable: false,
      running: true,
      stale: false,
    });
    void platformApi
      .executeRepair(companyId, row.orderId, {
        capabilityCode: plan.proposedRepair.capabilityCode,
        findingId: plan.finding.findingId,
        idempotencyKey: attemptKey,
        ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
        previewVersion: plan.previewVersion,
        reason: execution.reason.trim(),
      })
      .then((result) => {
        setExecution({ ...emptyExecution, result });
        setPreview(undefined);
        setRefreshToken((value) => value + 1); // Refresh Health
        repairAttempted();
        void reloadDetails(row); // Verify Again
      })
      .catch((failure: unknown) => {
        repairAttempted(); // a refused / failed attempt is now in Repair History
        if (failure instanceof PlatformApiError && STALE_CODES.has(failure.code)) {
          // Never retried automatically: re-diagnose, re-preview, review again.
          setExecution({ ...emptyExecution, error: failure.message, stale: true });
          setPreview(undefined);
          void reloadDetails(row).then((fresh) => {
            const same = fresh?.findings.find((item) => item.reasonCode === plan.finding.reasonCode);
            if (same?.repairability === "READY") openPreview(row.orderId, same);
          });
          return;
        }
        const unknownOutcome =
          !(failure instanceof PlatformApiError) || failure.status === 0 || failure.status >= 500;
        setExecution((current) => ({
          ...current,
          // A validation refusal starts a new attempt; an unknown outcome
          // keeps the SAME key so Retry can only ever replay, never repeat.
          attemptKey: unknownOutcome ? attemptKey : undefined,
          error: unknownOutcome
            ? `${errorText(failure)} The repair may or may not have completed. Retry is safe: it reuses the same request and can never repair twice.`
            : `Repair not applied — no data was changed. ${errorText(failure)}`,
          retryable: unknownOutcome,
          running: false,
        }));
      });
  };

  // Read-only: the server recomputes the finding and the plan; nothing runs.
  function openPreview(orderId: string, finding: RepairFinding): void {
    setPreview({ reasonCode: finding.reasonCode });
    void platformApi
      .repairPreview(companyId, orderId, finding.reasonCode)
      .then((result) => setPreview({ reasonCode: finding.reasonCode, result }))
      .catch((failure: unknown) =>
        setPreview({ error: errorText(failure), reasonCode: finding.reasonCode }),
      );
  }

  const pageCount = list === undefined ? 1 : Math.max(1, Math.ceil(list.total / list.pageSize));

  return (
    <section className="platform-panel" aria-labelledby="repair-center-title">
      <div className="platform-panel__header">
        <div>
          <p className="platform-page__eyebrow">Repair Center · Company Health Check</p>
          <h2 id="repair-center-title">
            {summary === undefined ? "Order Health" : `${summary.company.nameEn} — Order Health`}
          </h2>
          {summary === undefined ? null : (
            <p className="platform-muted">
              {summary.company.code} ·{" "}
              <span className={`platform-badge platform-badge--${summary.company.status}`}>
                {summary.company.status}
              </span>{" "}
              · GL Accounting{" "}
              <strong data-testid="accounting-mode">
                {summary.accountingMode.enabled ? "ON" : "OFF"}
              </strong>{" "}
              · Company Health <HealthBadge health={summary.companyHealth} />
            </p>
          )}
          <p className="platform-muted">
            Read-only. Nothing on this page changes any data.
            {summary === undefined
              ? null
              : ` Last refreshed ${new Date(summary.generatedAt).toLocaleString()}.`}
          </p>
        </div>
        <div className="platform-actions">
          <button
            className="platform-button"
            disabled={loading}
            onClick={() => setRefreshToken((value) => value + 1)}
            type="button"
          >
            {loading ? "Checking…" : "Run Health Check"}
          </button>
          <Link className="platform-button platform-button--quiet" to={`/companies/${companyId}`}>
            Back to Company
          </Link>
        </div>
      </div>

      {error === undefined ? null : (
        <p className="platform-login__error" role="alert">
          {error}
        </p>
      )}

      <RepairCenterOverviewPanel companyId={companyId} refreshToken={historyToken + refreshToken} />

      {summary === undefined ? null : (
        <>
          <div className="platform-summary-strip" aria-label="Order Health summary">
            <div className="platform-summary-card platform-summary-card--info">
              <span className="platform-summary-card__label">Orders checked</span>
              <span className="platform-summary-card__value" data-testid="total-orders">
                {summary.totalOrders}
              </span>
            </div>
            <div className="platform-summary-card platform-summary-card--ok">
              <span className="platform-summary-card__label">Healthy</span>
              <span className="platform-summary-card__value" data-testid="healthy-orders">
                {summary.healthyOrders}
              </span>
            </div>
            <div className="platform-summary-card platform-summary-card--warn">
              <span className="platform-summary-card__label">Issues</span>
              <span className="platform-summary-card__value" data-testid="issue-orders">
                {summary.issueOrders}
              </span>
            </div>
            <div className="platform-summary-card platform-summary-card--warn">
              <span className="platform-summary-card__label">Reviews</span>
              <span className="platform-summary-card__value" data-testid="review-orders">
                {summary.reviewOrders}
              </span>
            </div>
          </div>
          <p className="platform-muted">
            {summary.scope.dateFrom === null
              ? "All Orders"
              : `Orders dated ${summary.scope.dateFrom} to ${summary.scope.dateTo}`}{" "}
            (Order date, {summary.scope.timezone}).
          </p>
          {summary.byReason.some((reason) => reason.health !== "HEALTHY") ? (
            <ul className="platform-list" aria-label="Problems by reason">
              {summary.byReason
                .filter((reason) => reason.health !== "HEALTHY")
                .map((reason) => (
                  <li key={reason.reasonCode}>
                    <HealthBadge health={reason.health} /> {reason.reason} —{" "}
                    <strong>{reason.orders}</strong>
                  </li>
                ))}
            </ul>
          ) : null}
        </>
      )}

      <form className="platform-filters" onSubmit={apply} aria-label="Order Health filters">
        <label className="platform-field" htmlFor="health-filter">
          <span>Health</span>
          <select
            id="health-filter"
            onChange={(event) =>
              setDraft({ ...draft, health: event.target.value as OrderHealthFilter })
            }
            value={draft.health}
          >
            {healthFilters.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="platform-field" htmlFor="health-scope">
          <span>Period</span>
          <select
            id="health-scope"
            onChange={(event) =>
              setDraft({ ...draft, scope: event.target.value as OrderHealthDateScope })
            }
            value={draft.scope}
          >
            {dateScopes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {draft.scope === "custom" ? (
          <>
            <label className="platform-field" htmlFor="health-from">
              <span>From</span>
              <input
                id="health-from"
                onChange={(event) => setDraft({ ...draft, dateFrom: event.target.value })}
                type="date"
                value={draft.dateFrom}
              />
            </label>
            <label className="platform-field" htmlFor="health-to">
              <span>To</span>
              <input
                id="health-to"
                onChange={(event) => setDraft({ ...draft, dateTo: event.target.value })}
                type="date"
                value={draft.dateTo}
              />
            </label>
          </>
        ) : null}
        <label className="platform-field" htmlFor="health-search">
          <span>Order number</span>
          <input
            id="health-search"
            maxLength={60}
            onChange={(event) => setDraft({ ...draft, search: event.target.value })}
            placeholder="Search order number"
            type="search"
            value={draft.search}
          />
        </label>
        <label className="platform-field" htmlFor="health-delivery">
          <span>Delivery status</span>
          <select
            id="health-delivery"
            onChange={(event) => setDraft({ ...draft, deliveryStatus: event.target.value })}
            value={draft.deliveryStatus}
          >
            <option value="">Any</option>
            {deliveryStatuses.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="platform-field" htmlFor="health-reason">
          <span>Reason</span>
          <select
            id="health-reason"
            onChange={(event) => setDraft({ ...draft, reasonCode: event.target.value })}
            value={draft.reasonCode}
          >
            <option value="">Any</option>
            {(summary?.byReason ?? []).map((reason) => (
              <option key={reason.reasonCode} value={reason.reasonCode}>
                {reason.reason}
              </option>
            ))}
          </select>
        </label>
        <button className="platform-button" type="submit">
          Apply
        </button>
      </form>

      {list === undefined ? (
        error === undefined ? (
          <p>Running the Company Health Check…</p>
        ) : null
      ) : list.items.length === 0 ? (
        <p className="platform-success" role="status">
          {filters.health === "attention"
            ? "No problematic orders in this period."
            : "No orders match these filters."}
        </p>
      ) : (
        <>
          <div className="platform-table-scroll">
            <table className="platform-table" aria-label="Orders">
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Order date</th>
                  <th scope="col">Delivery status</th>
                  <th scope="col">Health</th>
                  <th scope="col">Reason</th>
                  <th scope="col">
                    <span className="platform-muted">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((row) => (
                  <tr key={row.orderId}>
                    <td>{row.orderNumber}</td>
                    <td>{row.orderDate}</td>
                    <td>{statusLabel(row.deliveryStatus)}</td>
                    <td>
                      <HealthBadge health={row.health} />
                    </td>
                    <td>
                      {row.reason}
                      {row.additionalReasonCodes.length > 0 ? (
                        <div className="platform-muted">
                          +{row.additionalReasonCodes.length} more finding
                          {row.additionalReasonCodes.length === 1 ? "" : "s"}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <button
                        className="platform-button platform-button--quiet"
                        onClick={() => openDetails(row)}
                        type="button"
                      >
                        View Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="platform-pager">
            <button
              className="platform-button platform-button--quiet"
              disabled={page <= 1 || loading}
              onClick={() => setPage((value) => value - 1)}
              type="button"
            >
              Previous
            </button>
            <span className="platform-muted">
              Page {list.page} of {pageCount} · {list.total} order{list.total === 1 ? "" : "s"}
            </span>
            <button
              className="platform-button platform-button--quiet"
              disabled={page >= pageCount || loading}
              onClick={() => setPage((value) => value + 1)}
              type="button"
            >
              Next
            </button>
          </div>
        </>
      )}

      {details === undefined ? null : (
        <section aria-label="Finding details" className="platform-card">
          <div className="platform-panel__header">
            <h3>Finding Details — {details.row.orderNumber}</h3>
            <button
              className="platform-button platform-button--quiet"
              onClick={closeDetails}
              type="button"
            >
              Close
            </button>
          </div>
          {findings?.error !== undefined ? (
            <p role="alert">{findings.error}</p>
          ) : findings?.result === undefined ? (
            <p>Diagnosing…</p>
          ) : (
            <>
              {findings.result.findings.map((finding) => (
                <FindingCard
                  finding={finding}
                  key={finding.findingId}
                  onPreview={() => openPreview(details.row.orderId, finding)}
                  previewOpen={preview?.reasonCode === finding.reasonCode}
                />
              ))}
              <p className="platform-muted" data-testid="preview-version">
                State fingerprint {findings.result.previewVersion} · GL Accounting{" "}
                {findings.result.accountingMode.enabled ? "ON" : "OFF"}
              </p>
            </>
          )}
          {execution.stale === true ? (
            <p className="platform-login__error" data-testid="stale-warning" role="alert">
              {execution.error} The order details were refreshed; review the new state before
              repairing.
            </p>
          ) : null}
          {execution.result === undefined ? null : (
            <RepairResult
              onViewRecord={() => viewRepairRecord(execution.result!.repairExecutionId)}
              result={execution.result}
              verifiedHealth={
                findings?.result?.orderId === execution.result.orderId &&
                findings.result.generatedAt > execution.result.executedAt
                  ? findings.result.health
                  : undefined
              }
              verifiedResolved={
                findings?.result?.orderId === execution.result.orderId &&
                findings.result.generatedAt > execution.result.executedAt
                  ? !findings.result.findings.some(
                      (item) => item.reasonCode === execution.result!.reasonCode && item.health !== "HEALTHY",
                    )
                  : undefined
              }
            />
          )}
          {preview === undefined ? null : preview.error !== undefined ? (
            <p role="alert">{preview.error}</p>
          ) : preview.result === undefined ? (
            <p>Preparing repair preview…</p>
          ) : (
            <>
              <RepairPreviewDetails preview={preview.result} />
              {preview.result.execution.available &&
              preview.result.repairability === "READY" &&
              preview.result.proposedRepair !== null ? (
                <ExecuteRepairPanel
                  execution={execution}
                  onChange={(next) => setExecution((current) => ({ ...current, ...next }))}
                  onExecute={() => executeRepair(details.row, preview.result!)}
                  orderNumber={details.row.orderNumber}
                  preview={preview.result}
                />
              ) : null}
            </>
          )}
        </section>
      )}

      {details === undefined ? null : (
        <section aria-label="Order details (Verify First)" className="platform-card">
          <div className="platform-panel__header">
            <h3>Verify First — {details.row.orderNumber}</h3>
          </div>
          <p>
            <HealthBadge health={details.row.health} /> {details.row.reason}
          </p>
          {details.error !== undefined ? (
            <p role="alert">{details.error}</p>
          ) : details.verification === undefined ? (
            <p>Verifying…</p>
          ) : (
            <VerificationDetails verification={details.verification} />
          )}
        </section>
      )}

      <AccountingHealthPanel
        companyId={companyId}
        onRepairAttempted={repairAttempted}
        onViewRepairRecord={viewRepairRecord}
      />

      <PayrollHealthPanel
        companyId={companyId}
        onRepairAttempted={repairAttempted}
        onViewRepairRecord={viewRepairRecord}
      />

      <RepairHistoryPanel companyId={companyId} focus={historyFocus} refreshToken={historyToken + refreshToken} />
    </section>
  );
}

function VerificationDetails({
  verification,
}: {
  readonly verification: OrderVerification;
}): ReactElement {
  return (
    <>
      <dl className="platform-detail-list">
        <dt>Trader receivable check</dt>
        <dd>
          <HealthBadge health={verification.health} /> {verification.reason}
        </dd>
        <dt>Trader owes</dt>
        <dd>AED {verification.traderOwes}</dd>
        <dt>Physical collections</dt>
        <dd>AED {verification.physicalCollectionAmount}</dd>
        <dt>Effective settlement offsets</dt>
        <dd>
          AED {verification.settlementOffsetAmount}
          {verification.settlementNumbers.length > 0
            ? ` (${verification.settlementNumbers.join(", ")})`
            : ""}
        </dd>
        <dt>Historical offsets (reversed settlements)</dt>
        <dd>
          AED {verification.historicalSettlementOffsetAmount}
          {verification.historicalSettlementNumbers.length > 0
            ? ` (${verification.historicalSettlementNumbers.join(", ")})`
            : ""}
        </dd>
      </dl>
      {verification.receivables.length === 0 ? null : (
        <table className="platform-table" aria-label="Trader receivables">
          <thead>
            <tr>
              <th scope="col">Receivable</th>
              <th scope="col">Status</th>
              <th scope="col">Amount due</th>
              <th scope="col">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {verification.receivables.map((receivable) => (
              <tr key={receivable.id ?? receivable.receivableNumber}>
                <td>{receivable.receivableNumber}</td>
                <td>{receivable.status}</td>
                <td>{receivable.amount}</td>
                <td>{receivable.outstanding}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {verification.settlementOffsets.length === 0 ? null : (
        <table className="platform-table" aria-label="Settlement offsets">
          <thead>
            <tr>
              <th scope="col">Settlement</th>
              <th scope="col">Receivable</th>
              <th scope="col">Amount</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {verification.settlementOffsets.map((offset) => (
              <tr key={`${offset.settlementNumber}:${offset.receivableNumber}`}>
                <td>{offset.settlementNumber}</td>
                <td>{offset.receivableNumber}</td>
                <td>{offset.amount}</td>
                <td>{offset.effective ? "Effective" : "Historical — Settlement Reversed"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function IssueList({
  issues,
  label,
}: {
  readonly issues: readonly RepairIssue[];
  readonly label: string;
}): ReactElement | null {
  if (issues.length === 0) return null;
  return (
    <ul aria-label={label} className="platform-list">
      {issues.map((issue) => (
        <li key={issue.code}>
          <code>{issue.code}</code> — {issue.message}
        </li>
      ))}
    </ul>
  );
}

function FindingCard({
  finding,
  onPreview,
  previewOpen,
}: {
  readonly finding: RepairFinding;
  readonly onPreview: () => void;
  readonly previewOpen: boolean;
}): ReactElement {
  return (
    <article aria-label={`Finding ${finding.reasonCode}`} className="platform-card">
      <dl className="platform-detail-list">
        <dt>Finding</dt>
        <dd>
          <HealthBadge health={finding.health} /> <strong>{finding.title}</strong> · {finding.domain}
          <div className="platform-muted">{finding.summary}</div>
        </dd>
        <dt>Current state</dt>
        <dd>{finding.detectedState}</dd>
        <dt>Expected state</dt>
        <dd>{finding.expectedState}</dd>
        <dt>Recommended action</dt>
        <dd>{finding.recommendedAction}</dd>
        <dt>Repairability</dt>
        <dd>
          <RepairabilityBadge value={finding.repairability} />
          {finding.repairCapability === null ? null : (
            <span className="platform-muted"> · {finding.repairCapability}</span>
          )}
        </dd>
      </dl>
      <IssueList issues={finding.blockers} label="Blockers" />
      <IssueList issues={finding.warnings} label="Warnings" />
      {finding.repairability === "MANUAL_REVIEW" ? (
        finding.manualReview ? (
          <ManualReviewPanel review={finding.manualReview} />
        ) : (
          <p className="platform-muted">Manual review required — this cannot be repaired from here.</p>
        )
      ) : finding.repairability === "BLOCKED" ? (
        <p className="platform-muted">Blocked — the repair cannot run until the blockers are resolved.</p>
      ) : null}
      {finding.repairability === "READY" ? (
        <button
          className="platform-button"
          disabled={previewOpen}
          onClick={onPreview}
          type="button"
        >
          Preview Repair
        </button>
      ) : null}
    </article>
  );
}

/**
 * Phase 3 Prompt 3: everything a Platform administrator needs to judge a
 * MANUAL_REVIEW finding without querying SQL. Read-only: no Execute Repair
 * and no destructive action is ever offered here.
 */
function ManualReviewPanel({ review }: { readonly review: ManualReviewExplanation }): ReactElement {
  const comparison = review.financialComparison;
  const records = review.affectedRecords;
  const yesNo = (value: boolean) => (value ? "yes" : "no");
  return (
    <section aria-label="Manual review" className="platform-card" data-testid="manual-review">
      <h4>{review.headline}</h4>
      <p>
        <strong>Reason:</strong> {review.reason}
      </p>
      <p>
        <strong>Why automatic repair is unavailable</strong>
      </p>
      <ul data-testid="manual-review-why">
        {review.whyAutomaticRepairIsUnavailable.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p>
        <strong>Financial comparison</strong> — Trader owes AED {comparison.traderOwes}; effective collections AED{" "}
        {comparison.effectivePhysicalCollections}; effective settlement offsets AED {comparison.effectiveSettlementOffsets};{" "}
        {comparison.currentReceivables} current / {comparison.historicalReceivables} historical receivable(s).
      </p>
      <table className="platform-table" data-testid="manual-review-receivables">
        <thead>
          <tr>
            <th>Receivable</th>
            <th>Status</th>
            <th>Due</th>
            <th>Recorded collected</th>
            <th>Collections</th>
            <th>Offsets</th>
            <th>Unexplained</th>
          </tr>
        </thead>
        <tbody>
          {comparison.receivables.map((row) => (
            <tr key={row.receivableNumber}>
              <td>{row.receivableNumber}</td>
              <td>
                {row.status}
                {row.current ? "" : " (history)"}
              </td>
              <td>{row.amountDue}</td>
              <td>{row.recordedCollected}</td>
              <td>{row.effectivePhysicalCollections}</td>
              <td>{row.effectiveSettlementOffsets}</td>
              <td>{row.unexplainedDifference}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {records.collections.length + records.settlements.length + records.credits.length === 0 ? null : (
        <>
          <p>
            <strong>Affected records</strong>
          </p>
          <ul data-testid="manual-review-records">
            {records.collections.map((row) => (
              <li key={`c-${row.collectionNumber}-${row.receivableNumber}`}>
                Collection {row.collectionNumber} ({row.collectionStatus}{row.current ? "" : ", not counted"}) — AED{" "}
                {row.allocatedToReceivable} to {row.receivableNumber}; received AED {row.collectionAmountReceived}, allocated
                in total AED {row.collectionAllocatedTotal}; same Trader: {yesNo(row.sameTraderAsReceivable)}
              </li>
            ))}
            {records.settlements.map((row) => (
              <li key={`s-${row.settlementNumber}-${row.receivableNumber}`}>
                Settlement {row.settlementNumber} ({row.effective ? "effective" : "history"}
                {row.reversedBySettlementNumber === null ? "" : `, reversed by ${row.reversedBySettlementNumber}`}) — offset AED{" "}
                {row.offsetAmount} on {row.receivableNumber}; same Trader: {yesNo(row.sameTraderAsReceivable)}
              </li>
            ))}
            {records.credits.map((row) => (
              <li key={`t-${row.creditNumber}`}>
                Trader Credit {row.creditNumber} ({row.status}) — AED {row.amount}
                {row.receivableNumber === null ? "" : ` for ${row.receivableNumber}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function DependencyTable({
  label,
  nodes,
}: {
  readonly label: string;
  readonly nodes: readonly RepairDependencyNode[];
}): ReactElement {
  return nodes.length === 0 ? (
    <p className="platform-muted">{label}: none.</p>
  ) : (
    <table aria-label={label} className="platform-table">
      <thead>
        <tr>
          <th scope="col">Record</th>
          <th scope="col">Number</th>
          <th scope="col">Status</th>
          <th scope="col">Amount</th>
          <th scope="col">Relation</th>
        </tr>
      </thead>
      <tbody>
        {nodes.map((node) => (
          <tr key={`${node.entityType}:${node.entityId}:${node.relation}`}>
            <td>{node.entityType}</td>
            <td>{node.entityNumber ?? "—"}</td>
            <td>{node.status}</td>
            <td>{node.amount ?? "—"}</td>
            <td>{node.relation}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RepairPreviewDetails({ preview }: { readonly preview: RepairPlanPreview }): ReactElement {
  return (
    <section aria-label="Repair plan preview" className="platform-card">
      <h4>Repair Plan Preview — {preview.proposedRepair?.title ?? "No certified repair"}</h4>
      <p className="platform-muted">
        Preview only. Nothing has been changed, and repairs cannot be executed from the Repair
        Center.
      </p>
      {preview.proposedRepair === null ? null : <p>{preview.proposedRepair.explanation}</p>}
      <p>
        <RepairabilityBadge value={preview.repairability} />
      </p>
      <h5>What would change</h5>
      <ul aria-label="Proposed changes" className="platform-list">
        {preview.proposedChanges.map((change, index) => (
          <li key={`${change.entityType}:${change.action}:${index}`}>
            <strong>{change.action}</strong> {change.entityType}
            {change.entityNumber === null ? "" : ` ${change.entityNumber}`} — {change.description}
          </li>
        ))}
      </ul>
      <h5>What would remain untouched</h5>
      <ul aria-label="Preserved history" className="platform-list">
        {preview.preservedHistory.map((record, index) => (
          <li key={`${record.entityType}:${record.entityNumber ?? index}`}>
            {record.entityType}
            {record.entityNumber === null ? "" : ` ${record.entityNumber}`} — {record.description}
          </li>
        ))}
      </ul>
      <h5>Dependencies</h5>
      <DependencyTable label="Current dependencies" nodes={preview.dependencies.current} />
      <DependencyTable label="Historical dependencies" nodes={preview.dependencies.historical} />
      <IssueList issues={preview.blockers} label="Preview blockers" />
      <h5>Warnings</h5>
      {preview.warnings.length === 0 ? (
        <p className="platform-muted">None.</p>
      ) : (
        <IssueList issues={preview.warnings} label="Preview warnings" />
      )}
      <dl className="platform-detail-list">
        <dt>Required inputs</dt>
        <dd data-testid="required-inputs">
          {preview.requiredInputs.length === 0
            ? "None"
            : preview.requiredInputs
                .map((input) => `${input.name}${input.required ? " (required)" : " (optional)"}`)
                .join(", ")}
        </dd>
        <dt>Required permission</dt>
        <dd data-testid="required-permission">{preview.requiredPermission ?? "—"}</dd>
        <dt>GL Accounting</dt>
        <dd>{preview.accountingMode.enabled ? "ON" : "OFF"}</dd>
        <dt>Preview version</dt>
        <dd>
          <code>{preview.previewVersion}</code>
        </dd>
        <dt>Execution</dt>
        <dd>
          {preview.execution.available ? "Available" : "Not available"} — {preview.execution.reason}
        </dd>
      </dl>
    </section>
  );
}

function ExecuteRepairPanel({
  execution,
  onChange,
  onExecute,
  orderNumber,
  preview,
}: {
  readonly execution: ExecutionState;
  readonly onChange: (next: Partial<ExecutionState>) => void;
  readonly onExecute: () => void;
  readonly orderNumber: string;
  readonly preview: RepairPlanPreview;
}): ReactElement {
  const inputs = preview.requiredInputs.filter((input) => input.name !== "reason");
  const ready =
    execution.reason.trim().length >= 3 &&
    inputs.every((input) => !input.required || (execution.inputs[input.name] ?? "").trim() !== "");
  const changes = preview.proposedChanges.filter((change) => change.action !== "none");
  const unchanged = preview.proposedChanges.filter((change) => change.action === "none");
  return (
    <section aria-label="Confirm repair" className="platform-card">
      <h4>Confirm repair</h4>
      <dl className="platform-detail-list">
        <dt>Order</dt>
        <dd>{orderNumber}</dd>
        <dt>Finding</dt>
        <dd>
          {preview.finding.title} ({preview.finding.reasonCode})
        </dd>
        <dt>Proposed repair</dt>
        <dd>{preview.proposedRepair?.title}</dd>
        <dt>What will change</dt>
        <dd>
          <ul aria-label="Confirm changes" className="platform-list">
            {changes.map((change, index) => (
              <li key={`${change.entityType}:${index}`}>{change.description}</li>
            ))}
          </ul>
        </dd>
        <dt>What will remain</dt>
        <dd>
          <ul aria-label="Confirm unchanged" className="platform-list">
            {unchanged.map((change, index) => (
              <li key={`${change.entityType}:${index}`}>{change.description}</li>
            ))}
            {preview.preservedHistory.map((record, index) => (
              <li key={`preserved:${index}`}>
                {record.entityNumber ?? record.entityType} — {record.description}
              </li>
            ))}
          </ul>
        </dd>
        <dt>Warnings</dt>
        <dd>{preview.warnings.length === 0 ? "None" : preview.warnings.map((w) => w.code).join(", ")}</dd>
      </dl>
      <label className="platform-field" htmlFor="repair-reason">
        <span>Reason for this repair (required)</span>
        <textarea
          disabled={execution.running}
          id="repair-reason"
          maxLength={500}
          onChange={(event) => onChange({ reason: event.target.value })}
          value={execution.reason}
        />
      </label>
      {inputs.map((input) => (
        <label className="platform-field" htmlFor={`repair-input-${input.name}`} key={input.name}>
          <span>
            {input.description}
            {input.required ? " (required)" : " (optional)"}
          </span>
          <input
            disabled={execution.running}
            id={`repair-input-${input.name}`}
            onChange={(event) =>
              onChange({ inputs: { ...execution.inputs, [input.name]: event.target.value } })
            }
            value={execution.inputs[input.name] ?? ""}
          />
        </label>
      ))}
      {execution.error !== undefined && execution.stale !== true ? (
        <p className="platform-login__error" role="alert">
          {execution.error}
        </p>
      ) : null}
      <button
        className="platform-button"
        disabled={!ready || execution.running}
        onClick={onExecute}
        type="button"
      >
        {execution.running ? "Executing repair…" : execution.retryable === true ? "Retry Repair" : "Execute Repair"}
      </button>
    </section>
  );
}

function RepairResult({
  onViewRecord,
  result,
  verifiedHealth,
  verifiedResolved,
}: {
  readonly onViewRecord: () => void;
  readonly result: RepairExecutionResult;
  readonly verifiedHealth: OrderHealth | undefined;
  /** Phase 3: the repaired finding is gone on the fresh verification. */
  readonly verifiedResolved?: boolean | undefined;
}): ReactElement {
  return (
    <section aria-label="Repair result" className="platform-card" role="status">
      <h4>Repair completed</h4>
      <p>
        {result.orderNumber}: <HealthBadge health={result.beforeHealth} /> {result.beforeClassification} →{" "}
        <HealthBadge health={result.afterHealth} /> {result.afterClassification}
      </p>
      <p className="platform-muted">
        Audit reference {result.auditId} · {new Date(result.executedAt).toLocaleString()}
        {result.replayed ? " · this repair had already been completed; nothing was repeated" : ""}
      </p>
      <p data-testid="verified-health">
        Verify again:{" "}
        {verifiedHealth === undefined ? "checking…" : <HealthBadge health={verifiedHealth} />}
        {verifiedResolved === undefined ? null : verifiedResolved ? (
          <>
            {" "}
            <span className="platform-badge platform-badge--active" data-testid="finding-resolved">
              Resolved
            </span>
          </>
        ) : (
          <>
            {" "}
            <span className="platform-badge platform-badge--severity-high" data-testid="finding-resolved">
              Still present — review the order
            </span>
          </>
        )}
      </p>
      <button className="platform-button platform-button--quiet" onClick={onViewRecord} type="button">
        View Repair Record
      </button>
    </section>
  );
}
