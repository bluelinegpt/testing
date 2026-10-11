import { type ReactElement, useCallback, useEffect, useState } from "react";

import {
  type PayrollHealthPage,
  type PayrollHealthRow,
  type PayrollHealthSummary,
  type PayrollRepairFinding,
  type PayrollRepairPreview,
  type PayrollRepairResult,
  platformApi,
  platformApiErrorMessage,
  PlatformApiError,
} from "../api/platform-client.js";

/**
 * Repair Center -> Payroll Health (Phase 5, Prompt 1).
 *
 * Simple headlines only ("ISSUE -- Payroll calculation is inconsistent.",
 * "ISSUE -- Payroll accounting failed.", "ISSUE -- Payroll payment state is
 * inconsistent.", "REVIEW -- Payroll history requires manual review."). The
 * default list shows only periods needing attention (ISSUE + REVIEW).
 *
 * Opening a period runs the read-only Preview (recomputed server-side). An
 * "Execute Repair" control exists ONLY for a READY finding whose execution
 * route is this Payroll route, behind a confirmation with a reason; one
 * idempotency key per attempt (Retry reuses it); a stale preview is never
 * retried automatically. Payroll ACCOUNTING failures are recovered from
 * Accounting Health (the certified accounting recovery), so here they only
 * point there. MANUAL_REVIEW / BLOCKED findings show why the repair is not
 * automatic and what to do -- never an execute, delete, reset or recalculate
 * control.
 */

const PAGE_SIZE = 25;

const STALE_CODES = new Set([
  "repair_preview_stale",
  "repair_finding_not_current",
  "repair_not_ready",
  "repair_capability_not_applicable",
]);

const repairabilityLabel: Record<string, string> = {
  BLOCKED: "Blocked",
  MANUAL_REVIEW: "Manual review",
  NOT_REQUIRED: "Not required",
  READY: "Ready",
};

const healthBadge = (health: string): string =>
  health === "ISSUE"
    ? "platform-badge platform-badge--severity-high"
    : health === "REVIEW"
      ? "platform-badge platform-badge--severity-medium"
      : "platform-badge platform-badge--active";

function errorText(failure: unknown): string {
  return failure instanceof PlatformApiError ? failure.message : platformApiErrorMessage(0, undefined, undefined);
}

interface Execution {
  readonly findingId?: string | undefined;
  readonly reason: string;
  readonly running: boolean;
  readonly attemptKey?: string | undefined;
  readonly retryable?: boolean | undefined;
  readonly stale?: boolean | undefined;
  readonly error?: string | undefined;
  readonly result?: PayrollRepairResult | undefined;
}

const emptyExecution: Execution = { reason: "", running: false };

export function PayrollHealthPanel({
  companyId,
  onRepairAttempted,
  onViewRepairRecord,
}: {
  readonly companyId: string;
  /** Called after every repair attempt (refreshes the landing and History). */
  readonly onRepairAttempted?: () => void;
  /** Opens the authoritative Repair History record of a successful repair. */
  readonly onViewRepairRecord?: (repairExecutionId: string) => void;
}): ReactElement {
  const [summary, setSummary] = useState<PayrollHealthSummary>();
  const [list, setList] = useState<PayrollHealthPage>();
  const [error, setError] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<PayrollHealthRow>();
  const [preview, setPreview] = useState<{ result?: PayrollRepairPreview; error?: string }>();
  const [execution, setExecution] = useState<Execution>(emptyExecution);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    Promise.all([
      platformApi.payrollHealthSummary(companyId),
      platformApi.payrollHealthFindings(companyId, { page, pageSize: PAGE_SIZE, status: showAll ? "all" : "attention" }),
    ])
      .then(([nextSummary, nextList]) => {
        if (cancelled) return;
        setSummary(nextSummary);
        setList(nextList);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(errorText(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, page, showAll, refresh]);

  const openPreview = useCallback(
    (periodId: string): void => {
      setPreview({});
      void platformApi
        .payrollRepairPreview(companyId, periodId)
        .then((result) => setPreview({ result }))
        .catch((failure: unknown) => setPreview({ error: errorText(failure) }));
    },
    [companyId],
  );

  const view = (row: PayrollHealthRow): void => {
    setSelected(row);
    setExecution(emptyExecution);
    setPreview(undefined);
    if (row.entityType === "payroll_period") openPreview(row.entityId);
  };

  const execute = (plan: PayrollRepairPreview, finding: PayrollRepairFinding): void => {
    if (execution.running || finding.repairCapability === null) return;
    const attemptKey = execution.attemptKey ?? `rc-ui-${globalThis.crypto.randomUUID()}`;
    setExecution({
      ...execution,
      attemptKey,
      error: undefined,
      findingId: finding.findingId,
      result: undefined,
      retryable: false,
      running: true,
      stale: false,
    });
    void platformApi
      .executePayrollRepair(companyId, plan.periodId, {
        capabilityCode: finding.repairCapability,
        findingId: finding.findingId,
        idempotencyKey: attemptKey,
        previewVersion: plan.previewVersion,
        reason: execution.reason.trim(),
      })
      .then((result) => {
        setExecution({ ...emptyExecution, result });
        setRefresh((value) => value + 1); // Refresh Payroll Health
        onRepairAttempted?.();
        openPreview(plan.periodId); // Verify again
      })
      .catch((failure: unknown) => {
        onRepairAttempted?.();
        if (failure instanceof PlatformApiError && STALE_CODES.has(failure.code)) {
          setExecution({ ...emptyExecution, error: failure.message, stale: true });
          openPreview(plan.periodId); // never retried automatically: a fresh preview is shown
          return;
        }
        const unknownOutcome = !(failure instanceof PlatformApiError) || failure.status === 0 || failure.status >= 500;
        setExecution((current) => ({
          ...current,
          attemptKey: unknownOutcome ? attemptKey : undefined,
          error: unknownOutcome
            ? `${errorText(failure)} The repair may or may not have completed. Retry is safe: it reuses the same request and can never apply twice.`
            : `Repair not applied — nothing was changed. ${errorText(failure)}`,
          retryable: unknownOutcome,
          running: false,
        }));
      });
  };

  return (
    <section aria-label="Payroll Health" className="platform-card">
      <h3>Payroll Health</h3>
      {error !== undefined ? (
        <p className="platform-login__error" role="alert">
          {error}
        </p>
      ) : null}
      {summary === undefined ? (
        error === undefined ? <p>Loading Payroll Health…</p> : null
      ) : (
        <>
          <p>
            <span className={healthBadge(summary.payrollHealth)}>{summary.payrollHealth}</span>{" "}
            {summary.periodsWithFindings} of {summary.totalPeriods} Payroll periods need attention · GL Accounting{" "}
            {summary.accountingMode.enabled ? "ON" : "OFF"}
          </p>
          {summary.headlines.length === 0 ? (
            <p>Payroll is consistent.</p>
          ) : (
            <ul aria-label="Payroll headlines" className="platform-list">
              {summary.headlines.map((headline) => (
                <li key={headline}>{headline}</li>
              ))}
            </ul>
          )}
        </>
      )}

      <label className="platform-field">
        <input
          checked={showAll}
          onChange={(event) => {
            setPage(1);
            setShowAll(event.target.checked);
          }}
          type="checkbox"
        />{" "}
        <span>Show all findings (default: needs attention)</span>
      </label>

      {list === undefined ? null : list.items.length === 0 ? (
        <p>No Payroll period needs attention.</p>
      ) : (
        <table aria-label="Payroll findings" className="platform-table">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Status</th>
              <th>Health</th>
              <th>Finding</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.items.map((row) => (
              <tr key={`${row.entityType}:${row.entityId}`}>
                <td>{row.reference}</td>
                <td>{row.status ?? "—"}</td>
                <td>
                  <span className={healthBadge(row.health)}>{row.health}</span>
                </td>
                <td>{row.headline}</td>
                <td>
                  <button className="platform-button platform-button--secondary" onClick={() => view(row)} type="button">
                    {row.entityType === "payroll_period" ? "Preview" : "Details"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {list !== undefined && list.total > list.pageSize ? (
        <p>
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} type="button">
            Previous
          </button>{" "}
          Page {list.page} of {Math.ceil(list.total / list.pageSize)}{" "}
          <button disabled={page * list.pageSize >= list.total} onClick={() => setPage(page + 1)} type="button">
            Next
          </button>
        </p>
      ) : null}

      {selected === undefined ? null : selected.entityType !== "payroll_period" ? (
        <section aria-label="Driver fee review" className="platform-card">
          <h4>{selected.reference}</h4>
          <p>{selected.headline}</p>
          <p>
            Manual review: an outsourced driver fee is never re-priced or re-allocated automatically. Compare the
            accrual with the fee version in force for its Order and with its payment allocations, then correct it
            through the Company&apos;s driver fee workflow.
          </p>
        </section>
      ) : (
        <PeriodPreview
          execution={execution}
          onChange={(change) => setExecution((current) => ({ ...current, ...change }))}
          onExecute={execute}
          onViewRepairRecord={onViewRepairRecord}
          preview={preview}
        />
      )}
    </section>
  );
}

const COMPONENT_PAIRS: readonly (readonly [string, string, string])[] = [
  ["Allowances", "allowances", "allowanceRecords"],
  ["Driver commission", "driverCommission", "commissionRecords"],
  ["Earning adjustments (bonus)", "earningAdjustments", "activeEarningAdjustments"],
  ["Deduction adjustments", "deductionAdjustments", "activeDeductionAdjustments"],
];

function lineIssues(line: PayrollRepairPreview["lines"][number]): string {
  const issues: string[] = [];
  if (line.flags.amounts) issues.push("amounts");
  if (line.flags.components) issues.push("components");
  if (line.flags.payment) issues.push("payment state");
  if (line.flags.allocation) issues.push("allocations");
  return issues.join(", ");
}

/**
 * Finding detail (opened period only -- never in the list): the lines that
 * need attention with current vs expected amounts, the component snapshots
 * that disagree with their records, the payments and the accounting events.
 */
function PeriodDetail({ plan }: { readonly plan: PayrollRepairPreview }): ReactElement | null {
  const flagged = plan.lines.filter(
    (line) => line.flags.amounts || line.flags.components || line.flags.payment || line.flags.allocation,
  );
  const componentRows = flagged.flatMap((line) =>
    COMPONENT_PAIRS.filter(([, snapshot, records]) => {
      const left = line.components?.[snapshot];
      const right = line.components?.[records];
      return left !== undefined && right !== undefined && Number(left) !== Number(right);
    }).map(([label, snapshot, records]) => ({
      key: `${line.lineId}:${snapshot}`,
      label,
      line,
      records: line.components?.[records] ?? "—",
      snapshot: line.components?.[snapshot] ?? "—",
    })),
  );
  if (flagged.length === 0 && plan.payments.length === 0 && plan.accounting.events.length === 0) return null;
  return (
    <>
      {flagged.length === 0 ? null : (
        <table aria-label="Lines needing attention" className="platform-table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Line status</th>
              <th>Gross (current / expected)</th>
              <th>Net (current / expected)</th>
              <th>Paid (current / expected)</th>
              <th>Outstanding (current / expected)</th>
              <th>Inconsistent</th>
            </tr>
          </thead>
          <tbody>
            {flagged.map((line) => (
              <tr key={line.lineId}>
                <td>
                  {line.employeeNumber ?? "—"} · {line.employeeName ?? "—"}
                  {line.employeeActive === false ? " (inactive today)" : ""}
                </td>
                <td>
                  {line.status}
                  {line.flags.payment ? ` → ${line.expected.status}` : ""}
                </td>
                <td>
                  {line.current.gross} / {line.expected.gross}
                </td>
                <td>
                  {line.current.net} / {line.expected.net}
                </td>
                <td>
                  {line.current.paid} / {line.expected.paid}
                </td>
                <td>
                  {line.current.outstanding} / {line.expected.outstanding}
                </td>
                <td>{lineIssues(line)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {componentRows.length === 0 ? null : (
        <table aria-label="Component differences" className="platform-table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Component</th>
              <th>On the line</th>
              <th>In its records</th>
            </tr>
          </thead>
          <tbody>
            {componentRows.map((row) => (
              <tr key={row.key}>
                <td>{row.line.employeeNumber ?? "—"}</td>
                <td>{row.label}</td>
                <td>{row.snapshot}</td>
                <td>{row.records}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {plan.payments.length === 0 ? null : (
        <table aria-label="Payroll payments" className="platform-table">
          <thead>
            <tr>
              <th>Payment</th>
              <th>Status</th>
              <th>Amount</th>
              <th>Active allocations</th>
            </tr>
          </thead>
          <tbody>
            {plan.payments.map((payment) => (
              <tr key={payment.paymentId}>
                <td>{payment.paymentNumber}</td>
                <td>{payment.status}</td>
                <td>{payment.totalAmount}</td>
                <td>{payment.activeAllocated}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {plan.accounting.events.length === 0 ? null : (
        <table aria-label="Payroll accounting events" className="platform-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Status</th>
              <th>Recovery</th>
            </tr>
          </thead>
          <tbody>
            {plan.accounting.events.map((event) => (
              <tr key={event.eventId}>
                <td>{event.eventType}</td>
                <td>{event.status}</td>
                <td>{event.recovery === null ? "—" : (repairabilityLabel[event.recovery] ?? event.recovery)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function PeriodPreview({
  execution,
  onChange,
  onExecute,
  onViewRepairRecord,
  preview,
}: {
  readonly execution: Execution;
  readonly onChange: (change: Partial<Execution>) => void;
  readonly onExecute: (plan: PayrollRepairPreview, finding: PayrollRepairFinding) => void;
  readonly onViewRepairRecord?: ((repairExecutionId: string) => void) | undefined;
  readonly preview?: { result?: PayrollRepairPreview; error?: string } | undefined;
}): ReactElement {
  if (preview === undefined || (preview.result === undefined && preview.error === undefined)) {
    return <p>Loading preview…</p>;
  }
  if (preview.result === undefined) {
    return (
      <p className="platform-login__error" role="alert">
        {preview.error}
      </p>
    );
  }
  const plan = preview.result;
  return (
    <section aria-label="Payroll repair preview" className="platform-card">
      <h4>
        {plan.periodReference} · {plan.period.status}{" "}
        <span className={healthBadge(plan.health)}>{plan.health}</span>
      </h4>
      {execution.stale === true ? (
        <p role="status">{execution.error} The preview was refreshed; review it before trying again.</p>
      ) : null}
      {execution.result === undefined ? null : (
        <p role="status">
          Repaired: {execution.result.capabilityCode} ({execution.result.beforeHealth} → {execution.result.afterHealth}).{" "}
          {onViewRepairRecord === undefined ? null : (
            <button
              className="platform-button platform-button--secondary"
              onClick={() => onViewRepairRecord(execution.result!.repairExecutionId)}
              type="button"
            >
              View repair record
            </button>
          )}
        </p>
      )}
      <dl className="platform-detail-list">
        <dt>Period</dt>
        <dd>
          {plan.period.start} – {plan.period.end}
        </dd>
        <dt>GL Accounting</dt>
        <dd>{plan.accounting.enabled ? "ON" : "OFF"}</dd>
        <dt>Net salary (stored / expected)</dt>
        <dd>
          {plan.period.totals.netSalary ?? "—"} / {plan.period.expectedTotals.netSalary ?? "—"}
        </dd>
        <dt>Lines / payments / accounting events</dt>
        <dd>
          {plan.lines.length} / {plan.payments.length} / {plan.accounting.events.length}
        </dd>
      </dl>
      <PeriodDetail plan={plan} />
      {plan.findings.length === 0 ? <p>This Payroll period is consistent. Nothing to repair.</p> : null}
      {plan.findings.map((finding) => {
        const executable = finding.execution.available && finding.executionRoute === "payroll";
        return (
          <section aria-label={`Finding ${finding.reasonCode}`} className="platform-card" key={finding.findingId}>
            <h5>{finding.headline}</h5>
            <p>{finding.reason}</p>
            <dl className="platform-detail-list">
              <dt>Repairability</dt>
              <dd>{repairabilityLabel[finding.repairability] ?? finding.repairability}</dd>
              <dt>Planned operation</dt>
              <dd>{finding.plannedOperation}</dd>
              <dt>Expected result</dt>
              <dd>{finding.expectedResult}</dd>
              {finding.whyNotAutomatic === null ? null : (
                <>
                  <dt>Why this is not automatic</dt>
                  <dd>{finding.whyNotAutomatic}</dd>
                </>
              )}
              <dt>Recommended action</dt>
              <dd>{finding.recommendedAction}</dd>
            </dl>
            {finding.blockers.length === 0 ? null : (
              <ul aria-label="Repair blockers" className="platform-list">
                {finding.blockers.map((issue) => (
                  <li key={issue.code}>
                    <code>{issue.code}</code> — {issue.message}
                  </li>
                ))}
              </ul>
            )}
            {finding.executionRoute === "accounting_event" ? (
              <p>Recover the failed Payroll accounting event from Accounting Health on this page.</p>
            ) : null}
            {!executable ? null : (
              <section aria-label="Confirm repair" className="platform-card">
                <label className="platform-field" htmlFor={`pay-reason-${finding.findingId}`}>
                  <span>Reason for this repair (required)</span>
                  <textarea
                    disabled={execution.running}
                    id={`pay-reason-${finding.findingId}`}
                    maxLength={500}
                    onChange={(event) => onChange({ findingId: finding.findingId, reason: event.target.value })}
                    value={execution.findingId === finding.findingId ? execution.reason : ""}
                  />
                </label>
                {execution.findingId === finding.findingId && execution.error !== undefined && execution.stale !== true ? (
                  <p className="platform-login__error" role="alert">
                    {execution.error}
                  </p>
                ) : null}
                <button
                  className="platform-button"
                  disabled={
                    execution.findingId !== finding.findingId || execution.reason.trim().length < 3 || execution.running
                  }
                  onClick={() => onExecute(plan, finding)}
                  type="button"
                >
                  {execution.running && execution.findingId === finding.findingId
                    ? "Repairing…"
                    : execution.retryable === true && execution.findingId === finding.findingId
                      ? "Retry Repair"
                      : "Execute Repair"}
                </button>
              </section>
            )}
          </section>
        );
      })}
    </section>
  );
}
