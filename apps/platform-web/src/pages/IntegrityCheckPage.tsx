import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";

import { type IntegrityFinding, platformApi } from "../api/platform-client.js";

/**
 * The Integration Integrity Checker -- read-only, by design. See
 * `IntegrityCheckService`'s own comment (API side) for what each check
 * means and why nothing here writes anything.
 *
 * Findings are re-derived live on every load, never stored -- there is
 * nothing paginated to fetch page-by-page and no history to browse, unlike
 * the Errors or Deployment Registry screens. A healthy Company should show
 * zero findings; filtering here is client-side because the whole premise is
 * that this list is normally small.
 */
const severityLabel: Record<string, string> = { high: "High", low: "Low", medium: "Medium" };

export function IntegrityCheckPage(): ReactElement {
  const [findings, setFindings] = useState<readonly IntegrityFinding[]>();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [companyFilter, setCompanyFilter] = useState("");
  const [checkFilter, setCheckFilter] = useState("");

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void platformApi
      .integrityFindings()
      .then((result) => {
        if (!cancelled) setFindings(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  const companies = useMemo(() => {
    const seen = new Map<string, string>();
    for (const finding of findings ?? []) seen.set(finding.companyId, finding.companyName);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [findings]);

  const checks = useMemo(() => {
    const seen = new Map<string, string>();
    for (const finding of findings ?? []) seen.set(finding.checkId, finding.checkLabel);
    return [...seen.entries()];
  }, [findings]);

  const filtered = (findings ?? []).filter(
    (finding) =>
      (companyFilter === "" || finding.companyId === companyFilter) &&
      (checkFilter === "" || finding.checkId === checkFilter),
  );

  return (
    <section className="platform-panel">
      <div className="platform-panel__header">
        <div>
          <h2>Integration Integrity Checker</h2>
          <p className="platform-muted">
            Cross-module data drift — an operation that should have written to two tables
            together, where one side went missing. Read-only: nothing here repairs anything.
          </p>
        </div>
        <button className="platform-button" disabled={loading} onClick={load} type="button">
          {loading ? "Checking…" : "Run checks"}
        </button>
      </div>

      {findings !== undefined && findings.length === 0 ? (
        <div className="platform-summary-card platform-summary-card--ok">
          <span className="platform-summary-card__label">All checks passed</span>
          <span className="platform-summary-card__value">0</span>
        </div>
      ) : null}

      {findings !== undefined && findings.length > 0 ? (
        <div className="platform-filters">
          <label className="platform-field" htmlFor="integrity-company">
            <span>Company</span>
            <select
              id="integrity-company"
              onChange={(event) => setCompanyFilter(event.target.value)}
              value={companyFilter}
            >
              <option value="">All companies</option>
              {companies.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="platform-field" htmlFor="integrity-check">
            <span>Check</span>
            <select
              id="integrity-check"
              onChange={(event) => setCheckFilter(event.target.value)}
              value={checkFilter}
            >
              <option value="">All checks</option>
              {checks.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {failed ? (
        <p role="alert">The integrity checks could not be run.</p>
      ) : findings === undefined ? (
        <p>Running checks…</p>
      ) : findings.length === 0 ? null : (
        <table className="platform-table">
          <thead>
            <tr>
              <th scope="col">Company</th>
              <th scope="col">Check</th>
              <th scope="col">Criticality</th>
              <th scope="col">Subject</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((finding) => (
              <tr key={`${finding.checkId}:${finding.subjectId}`}>
                <td>{finding.companyName}</td>
                <td>{finding.checkLabel}</td>
                <td>
                  <span className={`platform-badge platform-badge--severity-${finding.severity}`}>
                    {severityLabel[finding.severity]}
                  </span>
                </td>
                <td>
                  {finding.subjectType}
                  <div className="platform-muted">{finding.subjectReference}</div>
                </td>
                <td>{finding.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
