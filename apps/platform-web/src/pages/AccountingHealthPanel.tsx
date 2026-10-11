import { type FormEvent, type ReactElement, useCallback, useEffect, useState } from "react";

import {
  type AccountingEventDetails,
  type AccountingHealthPage,
  type AccountingHealthQuery,
  type AccountingHealthRow,
  type AccountingHealthStatusFilter,
  type AccountingHealthSummary,
  type AccountingIntegrityPage,
  type AccountingIntegrityRow,
  type AccountingRecoveryContext,
  type AccountingRecoveryPreview,
  type AccountingRecoveryResult,
  type AccountingTriage,
  platformApi,
  platformApiErrorMessage,
  PlatformApiError,
} from "../api/platform-client.js";

/**
 * Repair Center -> Accounting Health (Phase 2, Prompt 4).
 *
 * Mode-aware: with GL Accounting OFF the panel says GL recovery is not needed
 * for new activity and shows historical events without calling the Company
 * unhealthy. The list is triaged server-side in one statement; it never
 * claims READY -- an event passing every stored-state check is a "Ready
 * candidate", and only Preview Recovery (the full certified precheck) can say
 * READY. "Execute Recovery" appears only for a READY preview, behind a
 * confirmation with a reason; one idempotency key per attempt (Retry reuses
 * it); a stale preview is never retried automatically. No raw payload is shown.
 *
 * Phase 4 Prompt 1: the summary shows only simple headlines ("ISSUE --
 * Accounting event failed.", "ISSUE -- Required accounting event is
 * missing.", "REVIEW -- Accounting history requires manual review."). Journal
 * integrity and missing-event findings are listed separately, loaded only
 * when the summary reports some; each opens a manual-review explanation (why
 * recovery is unsafe, journal / period / actor state, what to investigate)
 * with NO execute, delete or reset control.
 */

const PAGE_SIZE = 25;

const statusFilters: readonly { value: AccountingHealthStatusFilter; label: string }[] = [
  { label: "Needs attention", value: "attention" },
  { label: "Failed", value: "failed" },
  { label: "Blocked configuration", value: "blocked_configuration" },
  { label: "Queued", value: "received" },
  { label: "Retry pending", value: "retry_pending" },
  { label: "Processing", value: "processing" },
  { label: "Posted", value: "posted" },
  { label: "All", value: "all" },
];

const triageLabel: Record<AccountingTriage, string> = {
  BLOCKED: "Blocked",
  MANUAL_REVIEW: "Manual review",
  NOT_REQUIRED: "Not required",
  READY_CANDIDATE: "Ready candidate · preview required",
};

const triageBadge: Record<AccountingTriage, string> = {
  BLOCKED: "platform-badge platform-badge--severity-high",
  MANUAL_REVIEW: "platform-badge platform-badge--severity-medium",
  NOT_REQUIRED: "platform-badge platform-badge--active",
  READY_CANDIDATE: "platform-badge platform-badge--ready",
};

const STALE_CODES = new Set([
  "repair_preview_stale",
  "repair_finding_not_current",
  "repair_not_ready",
  "repair_capability_not_applicable",
]);

function errorText(failure: unknown): string {
  return failure instanceof PlatformApiError ? failure.message : platformApiErrorMessage(0, undefined, undefined);
}

interface Filters {
  readonly status: AccountingHealthStatusFilter;
  readonly eventType: string;
  readonly repairability: string;
  readonly reference: string;
  readonly dateFrom: string;
  readonly dateTo: string;
}

const defaultFilters: Filters = {
  dateFrom: "",
  dateTo: "",
  eventType: "",
  reference: "",
  repairability: "",
  status: "attention",
};

function toQuery(filters: Filters, page: number): AccountingHealthQuery {
  return {
    page,
    pageSize: PAGE_SIZE,
    status: filters.status,
    ...(filters.eventType === "" ? {} : { eventType: filters.eventType }),
    ...(filters.repairability === "" ? {} : { repairability: filters.repairability as AccountingTriage }),
    ...(filters.reference.trim() === "" ? {} : { reference: filters.reference.trim() }),
    ...(filters.dateFrom === "" ? {} : { dateFrom: filters.dateFrom }),
    ...(filters.dateTo === "" ? {} : { dateTo: filters.dateTo }),
  };
}

interface Execution {
  readonly attemptKey?: string | undefined;
  readonly reason: string;
  readonly running: boolean;
  readonly result?: AccountingRecoveryResult | undefined;
  readonly error?: string | undefined;
  readonly stale?: boolean | undefined;
  readonly retryable?: boolean | undefined;
}

const emptyExecution: Execution = { reason: "", running: false };

export function AccountingHealthPanel({
  companyId,
  onRepairAttempted,
  onViewRepairRecord,
}: {
  readonly companyId: string;
  /** Called after every recovery attempt (refreshes the landing and History). */
  readonly onRepairAttempted?: () => void;
  /** Opens the authoritative Repair History record of a successful recovery. */
  readonly onViewRepairRecord?: (repairExecutionId: string) => void;
}): ReactElement {
  const [summary, setSummary] = useState<AccountingHealthSummary>();
  const [list, setList] = useState<AccountingHealthPage>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<Filters>(defaultFilters);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<{ row: AccountingHealthRow; details?: AccountingEventDetails; error?: string }>();
  const [preview, setPreview] = useState<{ result?: AccountingRecoveryPreview; error?: string }>();
  const [execution, setExecution] = useState<Execution>(emptyExecution);
  const [integrity, setIntegrity] = useState<AccountingIntegrityPage>();
  const [openFinding, setOpenFinding] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    void Promise.all([
      platformApi.accountingHealthSummary(companyId),
      platformApi.accountingHealthEvents(companyId, toQuery(filters, page)),
    ])
      .then(([nextSummary, nextList]) => {
        if (cancelled) return;
        setSummary(nextSummary);
        setList(nextList);
        const findings = (nextSummary.integrity?.total ?? 0) + (nextSummary.missingRequiredEvents?.total ?? 0);
        if (findings === 0) {
          setIntegrity(undefined);
          return;
        }
        void platformApi
          .accountingHealthIntegrity(companyId, { pageSize: PAGE_SIZE })
          .then((next) => {
            if (!cancelled) setIntegrity(next);
          })
          .catch((failure: unknown) => {
            if (!cancelled) setError(errorText(failure));
          });
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(errorText(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, filters, page, refresh]);

  const loadDetails = useCallback(
    (row: AccountingHealthRow): Promise<AccountingEventDetails | undefined> =>
      platformApi
        .accountingEventDetails(companyId, row.eventId)
        .then((details) => {
          setSelected({ details, row });
          return details;
        })
        .catch((failure: unknown) => {
          setSelected({ error: errorText(failure), row });
          return undefined;
        }),
    [companyId],
  );

  const openPreview = useCallback(
    (row: AccountingHealthRow) => {
      setPreview({});
      void platformApi
        .accountingRecoveryPreview(companyId, row.eventId)
        .then((result) => setPreview({ result }))
        .catch((failure: unknown) => setPreview({ error: errorText(failure) }));
    },
    [companyId],
  );

  const view = (row: AccountingHealthRow, withPreview: boolean): void => {
    setSelected({ row });
    setPreview(undefined);
    setExecution(emptyExecution);
    void loadDetails(row);
    if (withPreview) openPreview(row);
  };

  const execute = (row: AccountingHealthRow, plan: AccountingRecoveryPreview): void => {
    if (execution.running || plan.proposedRepair === null) return;
    const attemptKey = execution.attemptKey ?? `rc-ui-${globalThis.crypto.randomUUID()}`;
    setExecution({ ...execution, attemptKey, error: undefined, result: undefined, retryable: false, running: true, stale: false });
    void platformApi
      .executeAccountingRecovery(companyId, row.eventId, {
        capabilityCode: plan.proposedRepair.capabilityCode,
        findingId: plan.finding.findingId,
        idempotencyKey: attemptKey,
        previewVersion: plan.previewVersion,
        reason: execution.reason.trim(),
      })
      .then((result) => {
        setExecution({ ...emptyExecution, result });
        setPreview(undefined);
        setRefresh((value) => value + 1); // Refresh Accounting Health
        onRepairAttempted?.();
        void loadDetails(row); // Verify again
      })
      .catch((failure: unknown) => {
        onRepairAttempted?.();
        if (failure instanceof PlatformApiError && STALE_CODES.has(failure.code)) {
          setExecution({ ...emptyExecution, error: failure.message, stale: true });
          setPreview(undefined);
          void loadDetails(row).then((fresh) => {
            if (fresh?.finding.current === true) openPreview(row);
          });
          return;
        }
        const unknownOutcome = !(failure instanceof PlatformApiError) || failure.status === 0 || failure.status >= 500;
        setExecution((current) => ({
          ...current,
          attemptKey: unknownOutcome ? attemptKey : undefined,
          error: unknownOutcome
            ? `${errorText(failure)} The recovery may or may not have completed. Retry is safe: it reuses the same request and can never post twice.`
            : `Recovery not applied — nothing was posted or changed. ${errorText(failure)}`,
          retryable: unknownOutcome,
          running: false,
        }));
      });
  };

  const apply = (event: FormEvent): void => {
    event.preventDefault();
    setPage(1);
    setFilters(draft);
  };

  const pageCount = list === undefined ? 1 : Math.max(1, Math.ceil(list.total / list.pageSize));

  return (
    <section aria-labelledby="accounting-health-title" className="platform-panel">
      <h2 id="accounting-health-title">Accounting Health</h2>
      {error === undefined ? null : (
        <p className="platform-login__error" role="alert">
          {error}
        </p>
      )}
      {summary === undefined ? null : (
        <>
          <p className="platform-muted" data-testid="accounting-note">
            GL Accounting <strong>{summary.accountingMode.enabled ? "ON" : "OFF"}</strong> · {summary.note}
          </p>
          {(summary.headlines ?? []).length === 0 ? null : (
            <ul aria-label="Accounting Health headlines" className="platform-list" data-testid="acc-headlines">
              {(summary.headlines ?? []).map((headline) => (
                <li key={headline}>
                  <strong>{headline}</strong>
                </li>
              ))}
            </ul>
          )}
          {summary.readyCandidateNote === undefined ? null : (
            <p className="platform-muted" data-testid="acc-ready-note">
              {summary.readyCandidateNote}
            </p>
          )}
          <div aria-label="Accounting Health summary" className="platform-summary-strip">
            {(
              [
                ["Failed", summary.failed, "acc-failed"],
                ["Queued", summary.pending, "acc-pending"],
                ["Processing / stuck", `${summary.processing} / ${summary.stuck}`, "acc-processing"],
                ["Blocked", summary.blocked, "acc-blocked"],
                ["Ready candidates (preview required)", summary.readyCandidates, "acc-ready"],
                ["Manual review", summary.manualReview, "acc-manual"],
                ...(summary.accountingMode.enabled ? [] : [["Historical (Accounting OFF)", summary.historicalWhileOff, "acc-historical"]]),
                ...(summary.missingRequiredEvents === undefined
                  ? []
                  : [["Missing required events", summary.missingRequiredEvents.total, "acc-missing"]]),
                ...(summary.integrity === undefined ? [] : [["Journal integrity", summary.integrity.total, "acc-integrity"]]),
              ] as const
            ).map(([label, value, testId]) => (
              <div className="platform-summary-card platform-summary-card--info" key={testId}>
                <span className="platform-summary-card__label">{label}</span>
                <span className="platform-summary-card__value" data-testid={testId}>
                  {value}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {integrity === undefined || integrity.items.length === 0 ? null : (
        <section aria-label="Journal integrity and missing events" data-testid="acc-integrity-list">
          <h3>Journal integrity and missing events — manual review</h3>
          <p className="platform-muted">
            These are never repaired automatically: no Journal is created blindly, no balancing line is inserted and no
            history is deleted. Open a finding for what to investigate.
          </p>
          <table className="platform-table">
            <thead>
              <tr>
                <th>Finding</th>
                <th>Event type</th>
                <th>Reference</th>
                <th>Date</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {integrity.items.map((item) => {
                const id = `${item.kind}:${item.eventId ?? item.sourceId}:${item.code}`;
                return (
                  <tr key={id}>
                    <td>{item.headline}</td>
                    <td>{item.eventType}</td>
                    <td>{item.businessReference ?? "—"}</td>
                    <td>{item.occurredOn ?? "—"}</td>
                    <td>
                      <button className="platform-button" onClick={() => setOpenFinding(openFinding === id ? undefined : id)} type="button">
                        {openFinding === id ? "Close" : "Open"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {integrity.items
            .filter((item) => `${item.kind}:${item.eventId ?? item.sourceId}:${item.code}` === openFinding)
            .map((item) => (
              <IntegrityExplanation item={item} key={openFinding} />
            ))}
        </section>
      )}

      <form aria-label="Accounting Health filters" className="platform-filters" onSubmit={apply}>
        <label className="platform-field" htmlFor="acc-status">
          <span>Status</span>
          <select
            id="acc-status"
            onChange={(event) => setDraft({ ...draft, status: event.target.value as AccountingHealthStatusFilter })}
            value={draft.status}
          >
            {statusFilters.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="platform-field" htmlFor="acc-type">
          <span>Event type</span>
          <select id="acc-type" onChange={(event) => setDraft({ ...draft, eventType: event.target.value })} value={draft.eventType}>
            <option value="">Any</option>
            {(summary?.byEventType ?? []).map((row) => (
              <option key={row.eventType} value={row.eventType}>
                {row.eventType}
              </option>
            ))}
          </select>
        </label>
        <label className="platform-field" htmlFor="acc-repairability">
          <span>Repairability</span>
          <select
            id="acc-repairability"
            onChange={(event) => setDraft({ ...draft, repairability: event.target.value })}
            value={draft.repairability}
          >
            <option value="">Any</option>
            {(Object.keys(triageLabel) as AccountingTriage[]).map((value) => (
              <option key={value} value={value}>
                {triageLabel[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="platform-field" htmlFor="acc-reference">
          <span>Business reference</span>
          <input
            id="acc-reference"
            maxLength={60}
            onChange={(event) => setDraft({ ...draft, reference: event.target.value })}
            type="search"
            value={draft.reference}
          />
        </label>
        <label className="platform-field" htmlFor="acc-from">
          <span>Accounting date from</span>
          <input id="acc-from" onChange={(event) => setDraft({ ...draft, dateFrom: event.target.value })} type="date" value={draft.dateFrom} />
        </label>
        <label className="platform-field" htmlFor="acc-to">
          <span>Accounting date to</span>
          <input id="acc-to" onChange={(event) => setDraft({ ...draft, dateTo: event.target.value })} type="date" value={draft.dateTo} />
        </label>
        <button className="platform-button" type="submit">
          Apply filters
        </button>
      </form>

      {list === undefined ? null : list.items.length === 0 ? (
        <p className="platform-success" role="status">
          No accounting events match these filters.
        </p>
      ) : (
        <>
          <div className="platform-table-scroll">
            <table aria-label="Accounting events" className="platform-table">
              <thead>
                <tr>
                  <th scope="col">Business reference</th>
                  <th scope="col">Event type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Finding</th>
                  <th scope="col">Repairability</th>
                  <th scope="col">Last failure</th>
                  <th scope="col">
                    <span className="platform-muted">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((row) => (
                  <tr key={row.eventId}>
                    <td>{row.businessReference ?? "—"}</td>
                    <td>{row.eventType}</td>
                    <td>{row.status}</td>
                    <td>{row.finding}</td>
                    <td>
                      <span className={triageBadge[row.triage]}>{triageLabel[row.triage]}</span>
                    </td>
                    <td>{row.lastFailure ?? row.failureCode ?? "—"}</td>
                    <td>
                      <button className="platform-button platform-button--quiet" onClick={() => view(row, false)} type="button">
                        View Details
                      </button>
                      {row.triage === "READY_CANDIDATE" || row.triage === "BLOCKED" ? (
                        <button className="platform-button platform-button--quiet" onClick={() => view(row, true)} type="button">
                          Preview Recovery
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="platform-pager">
            <button className="platform-button platform-button--quiet" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} type="button">
              Previous
            </button>
            <span className="platform-muted">
              Page {list.page} of {pageCount} · {list.total} event{list.total === 1 ? "" : "s"}
            </span>
            <button
              className="platform-button platform-button--quiet"
              disabled={page >= pageCount}
              onClick={() => setPage((value) => value + 1)}
              type="button"
            >
              Next
            </button>
          </div>
        </>
      )}

      {selected === undefined ? null : (
        <section aria-label="Accounting event details" className="platform-card">
          <div className="platform-panel__header">
            <h3>Accounting event — {selected.row.businessReference ?? selected.row.eventType}</h3>
            <button
              className="platform-button platform-button--quiet"
              onClick={() => {
                setSelected(undefined);
                setPreview(undefined);
                setExecution(emptyExecution);
              }}
              type="button"
            >
              Close
            </button>
          </div>
          {selected.error !== undefined ? (
            <p role="alert">{selected.error}</p>
          ) : selected.details === undefined ? (
            <p>Diagnosing…</p>
          ) : (
            <EventDetails details={selected.details} />
          )}
          {execution.stale === true ? (
            <p className="platform-login__error" data-testid="acc-stale-warning" role="alert">
              {execution.error} The event was re-diagnosed; review the new state before recovering.
            </p>
          ) : null}
          {execution.result === undefined ? null : (
            <section aria-label="Recovery result" className="platform-card" role="status">
              <h4>Recovery completed</h4>
              <p>
                {execution.result.eventType}: {execution.result.beforeClassification} → {execution.result.afterClassification} ·
                Journal {execution.result.journalNumber}
                {execution.result.orderHealthAfter === null ? "" : ` · Order health ${execution.result.orderHealthAfter}`}
              </p>
              <p className="platform-muted" data-testid="acc-verified">
                Verify again:{" "}
                {selected.details?.finding.current === false ? "resolved" : "checking…"}
              </p>
              {onViewRepairRecord === undefined ? null : (
                <button
                  className="platform-button platform-button--quiet"
                  onClick={() => onViewRepairRecord(execution.result!.repairExecutionId)}
                  type="button"
                >
                  View Repair Record
                </button>
              )}
            </section>
          )}
          {preview === undefined ? null : preview.error !== undefined ? (
            <p role="alert">{preview.error}</p>
          ) : preview.result === undefined ? (
            <p>Preparing recovery preview…</p>
          ) : (
            <RecoveryPreview
              execution={execution}
              onChange={(next) => setExecution((current) => ({ ...current, ...next }))}
              onExecute={() => execute(selected.row, preview.result!)}
              preview={preview.result}
            />
          )}
        </section>
      )}
    </section>
  );
}

function IntegrityExplanation({ item }: { readonly item: AccountingIntegrityRow }): ReactElement {
  return (
    <div className="platform-panel" data-testid="acc-integrity-explanation">
      <h4>Manual review required — {item.code}</h4>
      <dl className="platform-detail-list">
        <dt>What is wrong</dt>
        <dd>{item.reason}</dd>
        <dt>Why recovery is unsafe</dt>
        <dd>{item.whyNotAutomatic}</dd>
        <dt>Event / source</dt>
        <dd>
          {item.eventType} · {item.eventStatus ?? "no event"} · {item.sourceType} {item.businessReference ?? item.sourceId}
        </dd>
        {item.journal === null ? null : (
          <>
            <dt>Journal</dt>
            <dd>
              {item.journal.journalNumber ?? "none"} · {item.journal.status ?? "—"} · debit {item.journal.debit ?? "—"} /
              credit {item.journal.credit ?? "—"} · {item.journal.lines} line(s) · period {item.journal.periodStatus ?? "—"}
            </dd>
          </>
        )}
        <dt>Original actor</dt>
        <dd>{item.actor.state}</dd>
        {item.reconstructable === null ? null : (
          <>
            <dt>Capture inputs reconstructable</dt>
            <dd>
              {item.reconstructable ? "yes" : "no"}
              {item.certifiedCapture === null ? "" : " · certified Company path: Accounting → Historical Recovery"}
            </dd>
          </>
        )}
        <dt>Recommended investigation</dt>
        <dd>{item.recommendedInvestigation}</dd>
      </dl>
    </div>
  );
}

function RecoveryContext({ context }: { readonly context: AccountingRecoveryContext }): ReactElement {
  return (
    <details data-testid="acc-recovery-context">
      <summary>Recovery checks</summary>
      <dl className="platform-detail-list">
        <dt>Decision for this event type</dt>
        <dd>
          {context.decision?.decision ?? "—"} — {context.decision?.reason ?? ""}
          {context.decision?.condition == null ? "" : ` Condition: ${context.decision.condition}`}
        </dd>
        <dt>Source</dt>
        <dd>
          {context.source.type} {context.source.reference ?? ""} · {context.source.state}
        </dd>
        <dt>Original actor</dt>
        <dd>
          {context.originalActor.state} — {context.originalActor.note}
        </dd>
        <dt>Fiscal period</dt>
        <dd>
          {context.fiscalPeriod.status ?? "none"} (year {context.fiscalPeriod.yearStatus ?? "—"})
        </dd>
        <dt>Mappings</dt>
        <dd>
          {context.mappings.state}
          {context.mappings.blockerCodes.length === 0 ? "" : ` · ${context.mappings.blockerCodes.join(", ")}`}
        </dd>
        <dt>Existing journals</dt>
        <dd>
          {context.existingJournals.linkedToEvent} linked to the event · {context.existingJournals.postedForSource} posted for the source
          {context.existingJournals.eventJournal === null
            ? ""
            : ` · ${context.existingJournals.eventJournal.journalNumber} ${context.existingJournals.eventJournal.status} (${
                context.existingJournals.eventJournal.balanced ? "balanced" : "NOT balanced"
              })`}
        </dd>
        <dt>Planned operation</dt>
        <dd>{context.plannedOperation}</dd>
        <dt>After recovery</dt>
        <dd>{context.postRecoveryExpectation}</dd>
        {context.recommendedInvestigation.length === 0 ? null : (
          <>
            <dt>Recommended investigation</dt>
            <dd>{context.recommendedInvestigation.join(" ")}</dd>
          </>
        )}
      </dl>
    </details>
  );
}

function EventDetails({ details }: { readonly details: AccountingEventDetails }): ReactElement {
  return (
    <>
      <dl className="platform-detail-list">
        <dt>Event</dt>
        <dd>
          {details.event.eventType} · {details.event.status} · {details.event.sourceType}{" "}
          {details.event.businessReference ?? ""}
        </dd>
        <dt>Failure</dt>
        <dd>
          {details.event.failureSummary ?? "—"}
          {details.event.failureCode === null ? "" : ` (${details.event.failureCode})`} · attempt {details.event.attempts} of{" "}
          {details.event.maxAttempts}
        </dd>
        <dt>Accounting mode</dt>
        <dd>{details.accountingMode.enabled ? "ON" : "OFF"}</dd>
        <dt>Finding</dt>
        <dd>{details.finding.detectedState}</dd>
        <dt>Expected state</dt>
        <dd>{details.finding.expectedState}</dd>
        <dt>Repairability</dt>
        <dd data-testid="acc-repairability">{details.finding.repairability}</dd>
        <dt>Platform recovery</dt>
        <dd>
          {details.support.support} — {details.support.reason}
        </dd>
      </dl>
      {details.finding.blockers.length === 0 ? null : (
        <ul aria-label="Accounting blockers" className="platform-list">
          {details.finding.blockers.map((issue) => (
            <li key={issue.code}>
              <code>{issue.code}</code> — {issue.message}
            </li>
          ))}
        </ul>
      )}
      {details.recovery === undefined ? null : <RecoveryContext context={details.recovery} />}
      <details>
        <summary>Administrative diagnostics</summary>
        <dl className="platform-detail-list">
          <dt>Fiscal period</dt>
          <dd>
            {details.diagnostics.fiscalPeriod.status ?? "—"} (year {details.diagnostics.fiscalPeriod.yearStatus ?? "—"})
          </dd>
          <dt>Area enabled / actor present</dt>
          <dd>
            {details.diagnostics.areaEnabled ? "yes" : "no"} / {details.diagnostics.actorPresent ? "yes" : "no"}
          </dd>
          <dt>Posted journals for source</dt>
          <dd>{details.diagnostics.postedJournalsForSource}</dd>
          {details.diagnostics.precheck === null ? null : (
            <>
              <dt>Expected journal</dt>
              <dd>
                Debit {details.diagnostics.precheck.expectedDebitTotal} = Credit{" "}
                {details.diagnostics.precheck.expectedCreditTotal} ·{" "}
                {details.diagnostics.precheck.resolvedMappings.map((line) => `${line.entryIntent} ${line.accountCode}`).join(", ")}
              </dd>
            </>
          )}
        </dl>
      </details>
    </>
  );
}

function RecoveryPreview({
  execution,
  onChange,
  onExecute,
  preview,
}: {
  readonly execution: Execution;
  readonly onChange: (next: Partial<Execution>) => void;
  readonly onExecute: () => void;
  readonly preview: AccountingRecoveryPreview;
}): ReactElement {
  const executable = preview.execution.available && preview.repairability === "READY" && preview.proposedRepair !== null;
  return (
    <section aria-label="Accounting recovery preview" className="platform-card">
      <h4>Recovery preview — {preview.proposedRepair?.title ?? "No certified recovery"}</h4>
      <p className="platform-muted">Preview only. Nothing has been changed.</p>
      <p data-testid="acc-preview-repairability">{preview.repairability}</p>
      {preview.proposedRepair === null ? null : <p>{preview.proposedRepair.explanation}</p>}
      <h5>What would change</h5>
      <ul aria-label="Recovery changes" className="platform-list">
        {preview.proposedChanges.map((change, index) => (
          <li key={`${change.entityType}:${index}`}>
            <strong>{change.action}</strong> {change.entityType} — {change.description}
          </li>
        ))}
      </ul>
      <h5>What would remain</h5>
      <ul aria-label="Recovery preserved" className="platform-list">
        {preview.preservedHistory.map((record, index) => (
          <li key={`${record.entityType}:${index}`}>{record.description}</li>
        ))}
      </ul>
      {preview.blockers.length === 0 ? null : (
        <ul aria-label="Recovery blockers" className="platform-list">
          {preview.blockers.map((issue) => (
            <li key={issue.code}>
              <code>{issue.code}</code> — {issue.message}
            </li>
          ))}
        </ul>
      )}
      {preview.recovery === undefined ? null : <RecoveryContext context={preview.recovery} />}
      <dl className="platform-detail-list">
        <dt>Required permission</dt>
        <dd>
          {preview.requiredPermission} (Company equivalent: {preview.domainPermissionEquivalent})
        </dd>
        <dt>Execution</dt>
        <dd>{preview.execution.reason}</dd>
      </dl>
      {!executable ? null : (
        <section aria-label="Confirm recovery" className="platform-card">
          <h5>Confirm recovery</h5>
          <label className="platform-field" htmlFor="acc-reason">
            <span>Reason for this recovery (required)</span>
            <textarea
              disabled={execution.running}
              id="acc-reason"
              maxLength={500}
              onChange={(event) => onChange({ reason: event.target.value })}
              value={execution.reason}
            />
          </label>
          {execution.error !== undefined && execution.stale !== true ? (
            <p className="platform-login__error" role="alert">
              {execution.error}
            </p>
          ) : null}
          <button
            className="platform-button"
            disabled={execution.reason.trim().length < 3 || execution.running}
            onClick={onExecute}
            type="button"
          >
            {execution.running ? "Recovering…" : execution.retryable === true ? "Retry Recovery" : "Execute Recovery"}
          </button>
        </section>
      )}
    </section>
  );
}
