import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import { type ErrorReport, type ErrorReportPage, platformApi } from "../api/platform-client.js";

/**
 * The Error Handler -- every captured crash from any app (`web`, `api`,
 * `platform-web`, `store`), which Company it happened to (if any), and the
 * triage a Platform Administrator has done on it.
 *
 * Filtering happens on the SERVER, same reasoning as `CompaniesPage`: this
 * table is meant to grow without bound, so a client-side filter would
 * quietly describe one page of results as if it were everything.
 */
const sourceApps = ["web", "api", "platform-web", "store", "mobile"] as const;
const severities = ["high", "medium", "low"] as const;
const statuses = ["open", "resolved"] as const;

const severityLabel: Record<string, string> = { high: "High", low: "Low", medium: "Medium" };
const statusLabel: Record<string, string> = { open: "Open", resolved: "Resolved" };

export function ErrorsPage(): ReactElement {
  const [search, setSearch] = useState("");
  const [sourceApp, setSourceApp] = useState("");
  const [severity, setSeverity] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ErrorReportPage | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<ErrorReport>();

  const load = useCallback(() => {
    let cancelled = false;
    setFailed(false);
    void platformApi
      .errors({ page, search, severity, sourceApp, status })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [page, search, severity, sourceApp, status]);

  useEffect(() => load(), [load]);

  const pageCount = data === undefined ? 1 : Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <section className="platform-panel">
      <div className="platform-panel__header">
        <h2>Error Handler</h2>
      </div>

      <div className="platform-filters">
        <label className="platform-field" htmlFor="error-search">
          <span>Search</span>
          <input
            id="error-search"
            onChange={(event) => {
              setPage(1);
              setSearch(event.target.value);
            }}
            placeholder="Message, correlation ID, or path"
            type="search"
            value={search}
          />
        </label>
        <label className="platform-field" htmlFor="error-app">
          <span>Application</span>
          <select
            id="error-app"
            onChange={(event) => {
              setPage(1);
              setSourceApp(event.target.value);
            }}
            value={sourceApp}
          >
            <option value="">All applications</option>
            {sourceApps.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="platform-field" htmlFor="error-severity">
          <span>Criticality</span>
          <select
            id="error-severity"
            onChange={(event) => {
              setPage(1);
              setSeverity(event.target.value);
            }}
            value={severity}
          >
            <option value="">All criticality</option>
            {severities.map((value) => (
              <option key={value} value={value}>
                {severityLabel[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="platform-field" htmlFor="error-status">
          <span>Status</span>
          <select
            id="error-status"
            onChange={(event) => {
              setPage(1);
              setStatus(event.target.value);
            }}
            value={status}
          >
            <option value="">All statuses</option>
            {statuses.map((value) => (
              <option key={value} value={value}>
                {statusLabel[value]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {failed ? (
        <p role="alert">The error list could not be loaded.</p>
      ) : data === undefined ? (
        <p>Loading…</p>
      ) : data.items.length === 0 ? (
        <p className="platform-muted">No errors match these filters.</p>
      ) : (
        <>
          <table className="platform-table">
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">Application</th>
                <th scope="col">Criticality</th>
                <th scope="col">Status</th>
                <th scope="col">Message</th>
                <th scope="col">Occurred</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((report) => (
                <tr
                  key={report.id}
                  onClick={() => setSelected(report)}
                  style={{ cursor: "pointer" }}
                >
                  <td>{report.companyName ?? <span className="platform-muted">—</span>}</td>
                  <td>{report.sourceApp}</td>
                  <td>
                    <span className={`platform-badge platform-badge--severity-${report.severity}`}>
                      {severityLabel[report.severity]}
                    </span>
                  </td>
                  <td>
                    <span className={`platform-badge platform-badge--status-${report.status}`}>
                      {statusLabel[report.status]}
                    </span>
                  </td>
                  <td className="platform-truncate">{report.message}</td>
                  <td>{new Date(report.occurredAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="platform-pager">
            <button
              className="platform-button platform-button--quiet"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
              type="button"
            >
              Previous
            </button>
            <span className="platform-muted">
              Page {page} of {pageCount} · {data.total} error{data.total === 1 ? "" : "s"}
            </span>
            <button
              className="platform-button platform-button--quiet"
              disabled={page >= pageCount}
              onClick={() => setPage((current) => current + 1)}
              type="button"
            >
              Next
            </button>
          </div>
        </>
      )}

      {selected === undefined ? null : (
        <ErrorDetailDialog
          onClose={() => setSelected(undefined)}
          onSaved={(updated) => {
            setSelected(updated);
            load();
          }}
          report={selected}
        />
      )}
    </section>
  );
}

function ErrorDetailDialog({
  onClose,
  onSaved,
  report,
}: {
  onClose: () => void;
  onSaved: (updated: ErrorReport) => void;
  report: ErrorReport;
}): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [severity, setSeverity] = useState(report.severity);
  const [status, setStatus] = useState(report.status);
  const [explanation, setExplanation] = useState(report.explanation ?? "");
  const [resolutionNotes, setResolutionNotes] = useState(report.resolutionNotes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    dialogRef.current?.showModal();
    return () => dialogRef.current?.close();
  }, []);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const updated = await platformApi.updateError(report.id, {
        explanation,
        resolutionNotes,
        severity,
        status,
      });
      onSaved(updated);
    } catch {
      setError("Could not save this error report.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog className="platform-dialog platform-dialog--wide" ref={dialogRef} onClose={onClose}>
      <div className="platform-dialog__body">
        <h3>Error detail</h3>
        <dl className="platform-dialog__facts">
          <dt>Company</dt>
          <dd>{report.companyName ?? "— (no Company context)"}</dd>
          <dt>Application</dt>
          <dd>{report.sourceApp}</dd>
          <dt>Occurred</dt>
          <dd>{new Date(report.occurredAt).toLocaleString()}</dd>
          <dt>Build version</dt>
          <dd>{report.appCommit ?? "—"}</dd>
          <dt>Correlation ID</dt>
          <dd>{report.correlationId ?? "—"}</dd>
          <dt>Path</dt>
          <dd>{report.path ?? "—"}</dd>
          <dt>Account</dt>
          <dd>
            {report.accountId ?? "—"}
            {report.accountKind === null ? "" : ` (${report.accountKind})`}
          </dd>
        </dl>

        <label className="platform-field" htmlFor="error-message">
          <span>Message</span>
          <textarea id="error-message" readOnly rows={2} value={report.message} />
        </label>

        {report.stack === null ? null : (
          <label className="platform-field" htmlFor="error-stack">
            <span>Stack trace</span>
            <textarea
              className="platform-mono-textarea"
              id="error-stack"
              readOnly
              rows={8}
              value={report.stack}
            />
          </label>
        )}

        <label className="platform-field" htmlFor="error-severity-edit">
          <span>Criticality</span>
          <select
            id="error-severity-edit"
            onChange={(event) => setSeverity(event.target.value as typeof severity)}
            value={severity}
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>

        <label className="platform-field" htmlFor="error-status-edit">
          <span>Status</span>
          <select
            id="error-status-edit"
            onChange={(event) => setStatus(event.target.value as typeof status)}
            value={status}
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
          </select>
        </label>

        <label className="platform-field" htmlFor="error-explanation">
          <span>Explanation — what caused this</span>
          <textarea
            id="error-explanation"
            onChange={(event) => setExplanation(event.target.value)}
            placeholder="What actually caused this, in plain terms"
            rows={3}
            value={explanation}
          />
        </label>

        <label className="platform-field" htmlFor="error-resolution">
          <span>Resolution notes — how it was fixed</span>
          <textarea
            id="error-resolution"
            onChange={(event) => setResolutionNotes(event.target.value)}
            placeholder="What was changed to fix it, or the plan to fix it"
            rows={3}
            value={resolutionNotes}
          />
        </label>

        {report.resolvedByUsername === null ? null : (
          <p className="platform-muted">
            Resolved by {report.resolvedByUsername}
            {report.resolvedAt === null
              ? ""
              : ` on ${new Date(report.resolvedAt).toLocaleString()}`}
          </p>
        )}

        {error === undefined ? null : (
          <p className="platform-login__error" role="alert">
            {error}
          </p>
        )}

        <div className="platform-dialog__actions">
          <button
            className="platform-button platform-button--quiet"
            disabled={saving}
            onClick={onClose}
            type="button"
          >
            Close
          </button>
          <button className="platform-button" disabled={saving} onClick={() => void save()} type="button">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
