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
  const [companies, setCompanies] = useState<readonly { id: string; nameEn: string }[]>([]);
  const [accepting, setAccepting] = useState<string>();

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    const request = companyFilter
      ? platformApi.verifyCompanyIntegrity(companyFilter, true).then((report) => report.checks.flatMap((check) => check.findings))
      : platformApi.integrityFindings();
    void request
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
  }, [companyFilter]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    void platformApi.companies({ pageSize: 100, sort: "name", direction: "asc" })
      .then((page) => setCompanies(page.items.map((item) => ({ id: item.id, nameEn: item.nameEn }))))
      .catch(() => setCompanies([]));
  }, []);

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

  async function accept(finding: IntegrityFinding & { readonly fingerprint?: string }) {
    if (finding.fingerprint === undefined) return;
    const note = window.prompt("Reason for accepting this finding:");
    if (note === null || note.trim() === "") return;
    setAccepting(`${finding.checkId}:${finding.subjectId}`);
    try {
      await platformApi.acceptIntegrityFinding(finding.companyId, {
        check_code: finding.checkId, subject_type: finding.subjectType,
        subject_id: finding.subjectId, fingerprint: finding.fingerprint, note: note.trim(),
      });
      load();
    } catch (error) {
      setFailed(true);
      window.alert(error instanceof Error ? error.message : "The finding could not be accepted.");
    } finally { setAccepting(undefined); }
  }

  async function revoke(finding: IntegrityFinding & { readonly acceptanceId?: string }) {
    if (finding.acceptanceId === undefined || !window.confirm("Revoke this finding acceptance?")) return;
    setAccepting(`${finding.checkId}:${finding.subjectId}`);
    try { await platformApi.unacceptIntegrityFinding(finding.companyId, finding.acceptanceId); load(); }
    catch (error) { setFailed(true); window.alert(error instanceof Error ? error.message : "The acceptance could not be revoked."); }
    finally { setAccepting(undefined); }
  }

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
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.nameEn}
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
              <th scope="col">Review</th>
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
                <td>
                  {finding.accepted ? <><span className="platform-badge">Accepted</span>{" "}<button className="platform-button" disabled={accepting !== undefined} onClick={() => void revoke(finding)} type="button">Revoke</button></> :
                    <button className="platform-button" disabled={accepting !== undefined} onClick={() => void accept(finding)} type="button">Accept</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
