import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { Link, useParams } from "react-router-dom";

import {
  PlatformApiError,
  platformApi,
  type AccountingSetupSummary,
  type AuditEntry,
  type CompanyDetail,
  type ReadinessSummary,
} from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";
import { CompanyAdministrators } from "./CompanyAdministrators.js";

/**
 * One Company: overview, profile, accounting setup, readiness and lifecycle.
 *
 * Readiness and the accounting summary are rendered from what the SERVER says.
 * Nothing here recomputes whether a Company may be activated — the button is
 * offered when the server says it can be, and the server checks again when it
 * is pressed.
 */
export function CompanyDetailPage(): ReactElement {
  const { companyId = "" } = useParams();
  const session = usePlatformSession();
  const canManage = session.can("platform.companies.manage");

  const [company, setCompany] = useState<CompanyDetail | undefined>(undefined);
  const [setup, setSetup] = useState<AccountingSetupSummary | undefined>(undefined);
  const [readiness, setReadiness] = useState<ReadinessSummary | undefined>(undefined);
  const [audit, setAudit] = useState<readonly AuditEntry[] | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [detail, accounting, ready] = await Promise.all([
        platformApi.company(companyId),
        platformApi.accountingSetup(companyId),
        platformApi.readiness(companyId),
      ]);
      setCompany(detail);
      setSetup(accounting);
      setReadiness(ready);
      // Audit is a separate, separately-permissioned read. A Platform account
      // without the audit permission still gets a working page; it just does
      // not get the trail.
      setAudit(await platformApi.audit(companyId).catch(() => undefined));
    } catch {
      setFailed(true);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveProfile(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await platformApi.updateCompany(companyId, draft);
      setEditing(false);
      await load();
    } catch (failure) {
      setError(
        failure instanceof PlatformApiError ? failure.message : "The profile could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function act(action: string, needsReason: boolean): Promise<void> {
    let reason: string | undefined;
    if (needsReason) {
      // Suspension and closure are decisions someone will later be asked to
      // explain, so the reason is collected here and stored in the audit trail.
      const entered = globalThis.prompt(`Reason for ${action}:`);
      if (entered === null || entered.trim().length < 3) return;
      reason = entered.trim();
    }
    setBusy(true);
    setError(undefined);
    try {
      await platformApi.lifecycle(companyId, action, reason);
      await load();
    } catch (failure) {
      setError(
        failure instanceof PlatformApiError
          ? failure.message
          : `The Company could not be ${action}d.`,
      );
    } finally {
      setBusy(false);
    }
  }

  if (failed) {
    return (
      <section className="platform-panel">
        <h2>Company</h2>
        <p role="alert">This Company could not be loaded.</p>
        <Link to="/companies">Back to Companies</Link>
      </section>
    );
  }
  if (company === undefined || setup === undefined || readiness === undefined) {
    return (
      <section className="platform-panel">
        <p>Loading…</p>
      </section>
    );
  }

  return (
    <section className="platform-panel">
      <div className="platform-panel__header">
        <div>
          <h2>{company.nameEn}</h2>
          <p className="platform-muted">
            {company.code} · {company.subdomain} ·{" "}
            <span className={`platform-badge platform-badge--${company.status}`}>
              {company.status}
            </span>{" "}
            <span
              className={
                company.environment === "production"
                  ? "platform-badge platform-badge--production"
                  : "platform-badge"
              }
            >
              {company.environment}
            </span>
          </p>
        </div>
        <Link className="platform-button platform-button--quiet" to="/companies">
          Back
        </Link>
      </div>

      {error === undefined ? null : (
        <p className="platform-login__error" role="alert">
          {error}
        </p>
      )}

      <div className="platform-panel__header">
        <h3>Company Profile</h3>
        {canManage && !editing ? (
          <button
            className="platform-button platform-button--quiet"
            onClick={() => {
              setDraft({
                name: company.nameEn,
                nameAr: company.nameAr ?? "",
                contactName: company.contactName ?? "",
                telephone: company.telephone ?? "",
                email: company.email ?? "",
                addressEn: company.addressEn ?? "",
                tradeLicenseNumber: company.tradeLicenseNumber ?? "",
                taxRegistrationNumber: company.taxRegistrationNumber ?? "",
              });
              setEditing(true);
            }}
            type="button"
          >
            Edit profile
          </button>
        ) : null}
      </div>

      {editing ? (
        <form className="platform-form" onSubmit={(event) => void saveProfile(event)}>
          {/*
            Only the editable fields appear. Code, subdomain and environment are
            absent because the API has no field for them - the form mirrors the
            contract rather than offering inputs the server would reject.
          */}
          {[
            ["name", "Name"],
            ["nameAr", "Name (Arabic)"],
            ["contactName", "Contact name"],
            ["telephone", "Telephone"],
            ["email", "Email"],
            ["addressEn", "Address"],
            ["tradeLicenseNumber", "Trade licence number"],
            ["taxRegistrationNumber", "Tax registration number"],
          ].map(([field, label]) => (
            <label className="platform-field" htmlFor={`edit-${field}`} key={field}>
              <span>{label}</span>
              <input
                id={`edit-${field}`}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [field as string]: event.target.value }))
                }
                required={field === "name"}
                type="text"
                value={draft[field as string] ?? ""}
              />
            </label>
          ))}
          <div className="platform-actions">
            <button
              className="platform-button platform-button--quiet"
              disabled={busy}
              onClick={() => setEditing(false)}
              type="button"
            >
              Cancel
            </button>
            <button className="platform-button" disabled={busy} type="submit">
              {busy ? "Saving..." : "Save profile"}
            </button>
          </div>
        </form>
      ) : (
        <dl className="platform-review">
          {[
            ["Name", company.nameEn],
            ["Name (Arabic)", company.nameAr ?? "\u2014"],
            ["Code", company.code],
            ["Subdomain", company.subdomain],
            ["Environment", company.environment],
            ["Contact name", company.contactName ?? "\u2014"],
            ["Telephone", company.telephone ?? "\u2014"],
            ["Email", company.email ?? "\u2014"],
            ["Address", company.addressEn ?? "\u2014"],
            ["Trade licence number", company.tradeLicenseNumber ?? "\u2014"],
            ["Tax registration number", company.taxRegistrationNumber ?? "\u2014"],
            ["Created", new Date(company.createdAt).toISOString().slice(0, 10)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="platform-muted">
        Code, subdomain and environment are fixed after creation. Environment in particular is a
        safety property that future maintenance operations depend on.
      </p>

      <h3>Configuration</h3>
      <dl className="platform-review">
        {[
          ["Country", company.countryCode],
          ["Timezone", company.timezone ?? "\u2014"],
          ["Currency", company.baseCurrency ?? "\u2014"],
          ["Default language", company.defaultLanguage ?? "\u2014"],
          [
            "Business day",
            setup.businessDay === null
              ? "\u2014"
              : `${setup.businessDay.startTime} ${setup.businessDay.timezone}`,
          ],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="platform-muted">
        Currency, timezone and language are set at creation. Changing them after a Company has
        posted is an accounting decision rather than a profile edit, and is not offered here.
      </p>

      <h3>Accounting Setup</h3>
      {setup.templateCode === null ? (
        <p className="platform-muted">No Accounting template has been applied.</p>
      ) : (
        <>
          <dl className="platform-review">
            {[
              ["Status", setup.status.replace(/_/g, " ")],
              ["Template", `${setup.templateCode} v${String(setup.templateVersion)}`],
              ["Template hash", setup.templateSha256 ?? "—"],
              [
                "Applied",
                setup.appliedAt === null
                  ? "—"
                  : new Date(setup.appliedAt).toISOString().slice(0, 19),
              ],
              ["Applied by", setup.appliedBy ?? "—"],
              ["Chart of Accounts", String(setup.counts.accounts ?? 0)],
              ["Account mappings", String(setup.counts.mappings ?? 0)],
              ["Expense types", String(setup.counts.expenseTypes ?? 0)],
              ["Expense categories", String(setup.counts.categories ?? 0)],
              ["Allowance types", String(setup.counts.allowanceTypes ?? 0)],
              ["Reference prefixes", String(setup.counts.referencePrefixes ?? 0)],
              ["Cash accounts", String(setup.counts.cashAccounts ?? 0)],
              ["Bank accounts", String(setup.counts.bankAccounts ?? 0)],
              [
                "Business day",
                setup.businessDay === null
                  ? "—"
                  : `${setup.businessDay.startTime} ${setup.businessDay.timezone}`,
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {/* Shown because "did this tenant really start clean?" is the
              question this panel exists to answer. */}
          <p className="platform-muted">
            Opening balances {setup.counts.openingBalanceBatches ?? 0} · Journals{" "}
            {setup.counts.journals ?? 0} · Accounting events {setup.counts.accountingEvents ?? 0}
          </p>
        </>
      )}

      <h3>Onboarding readiness</h3>
      <table className="platform-table">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Required</th>
            <th scope="col">State</th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {readiness.items.map((item) => (
            <tr key={item.key}>
              <td>{item.label}</td>
              <td>{item.required ? "Required" : "Optional"}</td>
              <td>
                <span className={`platform-badge platform-badge--${item.state}`}>{item.state}</span>
              </td>
              <td>{item.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(readiness.warnings ?? []).map((warning) => (
        // An operational note, not a readiness failure: an unopened accounting
        // period blocks posting, not activation.
        <p className="platform-warning" key={warning} role="status">
          {warning}
        </p>
      ))}
      <p className="platform-muted">Next step: {readiness.nextStep}</p>

      <CompanyAdministrators companyId={companyId} onChanged={() => void load()} />

      <h3>Audit summary</h3>
      {audit === undefined ? (
        <p className="platform-muted">
          Platform audit requires the <code>platform.audit.read</code> permission.
        </p>
      ) : audit.length === 0 ? (
        <p className="platform-muted">No Platform actions recorded for this Company yet.</p>
      ) : (
        <table className="platform-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Action</th>
              <th scope="col">Actor</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((entry, index) => (
              <tr key={`${entry.occurredAt}-${entry.action}-${index}`}>
                <td>{new Date(entry.occurredAt).toISOString().slice(0, 19).replace("T", " ")}</td>
                <td>{entry.action.replace("platform.company.", "")}</td>
                <td>{entry.actor ?? "\u2014"}</td>
                <td>{entry.reason ?? "\u2014"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canManage ? (
        <>
          <h3>Lifecycle</h3>
          <div className="platform-actions">
            {company.status === "draft" ? (
              <button
                className="platform-button"
                disabled={busy || !readiness.canActivate}
                onClick={() => void act("activate", false)}
                title={
                  readiness.canActivate
                    ? undefined
                    : `Blocked by: ${readiness.blockedBy.join(", ")}`
                }
                type="button"
              >
                Activate
              </button>
            ) : null}
            {company.status === "active" ? (
              <button
                className="platform-button platform-button--quiet"
                disabled={busy}
                onClick={() => void act("suspend", true)}
                type="button"
              >
                Suspend
              </button>
            ) : null}
            {company.status === "suspended" ? (
              <button
                className="platform-button"
                disabled={busy}
                onClick={() => void act("reactivate", false)}
                type="button"
              >
                Reactivate
              </button>
            ) : null}
            {company.status !== "disabled" ? (
              <button
                className="platform-button platform-button--quiet"
                disabled={busy}
                onClick={() => void act("disable", true)}
                type="button"
              >
                Close Company
              </button>
            ) : null}
          </div>
          {/* No delete control exists anywhere: a Company's orders, journals
              and audit trail must outlive the Company being closed. */}
          <p className="platform-muted">
            Suspension stops sign-in and ends existing sessions. No data is removed, and
            reactivation restores access without recreating anything.
          </p>
        </>
      ) : (
        <p className="platform-muted">
          You have read-only Platform access. Lifecycle actions require
          <code> platform.companies.manage</code>.
        </p>
      )}
    </section>
  );
}
