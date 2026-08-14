import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  PlatformApiError,
  platformApi,
  type AccountingSetupSummary,
  type AuditEntry,
  type CompanyDetail,
  type CompanyDeletionEligibility,
  type CompanyDeletionPreview,
  type CompanyDeletionBackup,
  type CompanyResetPreview,
  type CompanyResetResult,
  type ReadinessSummary,
} from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";
import { companyPortalUrl } from "../config/company-portal.js";
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
  const navigate = useNavigate();
  const session = usePlatformSession();
  const canManage = session.can("platform.companies.manage");
  const canDelete = session.can("platform.companies.delete");
  const canReset = session.can("platform.companies.reset");

  const [company, setCompany] = useState<CompanyDetail | undefined>(undefined);
  const [setup, setSetup] = useState<AccountingSetupSummary | undefined>(undefined);
  const [readiness, setReadiness] = useState<ReadinessSummary | undefined>(undefined);
  const [audit, setAudit] = useState<readonly AuditEntry[] | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [deletionEligibility, setDeletionEligibility] = useState<CompanyDeletionEligibility | undefined>(undefined);
  const [deletionPreview, setDeletionPreview] = useState<CompanyDeletionPreview | undefined>(undefined);
  const [deletionBackup, setDeletionBackup] = useState<CompanyDeletionBackup | undefined>(undefined);
  const [deletionKey, setDeletionKey] = useState<string | undefined>(undefined);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deletionStatus, setDeletionStatus] = useState<string | undefined>(undefined);
  const [deletionPreviewError, setDeletionPreviewError] = useState<
    { code: string | undefined; message: string } | undefined
  >(undefined);
  const closeDialogRef = useRef<HTMLDialogElement>(null);
  const [closeReason, setCloseReason] = useState("");
  const [closeConfirmation, setCloseConfirmation] = useState("");
  const [closeError, setCloseError] = useState<string | undefined>(undefined);
  const [resetPreview, setResetPreview] = useState<CompanyResetPreview | undefined>(undefined);
  const [resetConfirmation, setResetConfirmation] = useState("");
  const [resetResult, setResetResult] = useState<CompanyResetResult | undefined>(undefined);
  const [resetError, setResetError] = useState<string | undefined>(undefined);
  const [productionConfirmation, setProductionConfirmation] = useState("");
  const [productionError, setProductionError] = useState<string | undefined>(undefined);

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
      setDeletionEligibility(
        detail.status === "closed"
          ? await platformApi.companyDeletionEligibility(companyId)
          : undefined,
      );
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

  function openCloseDialog(): void {
    setCloseReason("");
    setCloseConfirmation("");
    setCloseError(undefined);
    closeDialogRef.current?.showModal();
  }

  function cancelClose(): void {
    closeDialogRef.current?.close();
    setCloseReason("");
    setCloseConfirmation("");
    setCloseError(undefined);
  }

  async function confirmClose(): Promise<void> {
    if (company === undefined) return;
    setBusy(true);
    setCloseError(undefined);
    try {
      await platformApi.closeCompany(companyId, closeReason.trim(), closeConfirmation);
      closeDialogRef.current?.close();
      setCloseReason("");
      setCloseConfirmation("");
      await load();
    } catch (failure) {
      setCloseError(
        failure instanceof PlatformApiError ? failure.message : "The Company could not be closed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function runDeletionPreview(): Promise<void> {
    const key = globalThis.crypto.randomUUID();
    setBusy(true);
    setDeletionPreviewError(undefined);
    setDeletionBackup(undefined);
    setDeletionStatus("Preparing deletion preview");
    try {
      setDeletionPreview(await platformApi.companyDeletionPreview(companyId, key));
      setDeletionKey(key);
      setDeletionStatus("Preview ready");
    } catch (failure) {
      // A dedicated, inline state -- not the page-level banner. A preview
      // failure is a normal, expected outcome of this specific action (a
      // stale operation, a permission gap, a genuine integrity conflict),
      // not a page-wide error, and it needs its own Retry right where the
      // click happened.
      setDeletionPreviewError({
        code: failure instanceof PlatformApiError ? failure.code : undefined,
        message:
          failure instanceof PlatformApiError ? failure.message : "Unable to run deletion preview.",
      });
      setDeletionStatus(undefined);
    } finally {
      setBusy(false);
    }
  }

  /** A short, safe label for a known preview-failure code -- the raw backend
   * message is always shown too, this just gives the reader a category
   * before they read it. Falls back to a generic label for anything not
   * recognized, since an unrecognized code must still read as "blocked",
   * never as silence. */
  function deletionPreviewErrorLabel(code: string | undefined): string {
    switch (code) {
      case "company_deletion_preview_not_eligible":
        return "Company is not ready for a deletion preview";
      case "company_deletion_preview_in_progress":
        return "Existing deletion operation must be refreshed";
      case "permission_denied":
        return "Permission denied";
      case "database_integrity_conflict":
        return "Database integrity conflict";
      default:
        return "Deletion preview blocked";
    }
  }

  async function createDeletionBackup(): Promise<void> {
    if (deletionPreview === undefined) return;
    setBusy(true);
    setError(undefined);
    setDeletionStatus("Creating and verifying full-database backup");
    try {
      setDeletionBackup(await platformApi.companyDeletionBackup(companyId, deletionPreview.operationId));
      // The preview snapshot was taken before a backup existed, so its own
      // `readyForDelete` is stale the moment the backup completes -- the
      // button that creates the backup is only reachable when the preview
      // already carries zero blockers, so a verified backup is the one
      // remaining condition and readiness can be updated locally rather
      // than showing a stale "NO" next to a flow that has, in fact, just
      // become ready.
      setDeletionPreview((current) =>
        current === undefined ? current : { ...current, readyForDelete: true },
      );
      setDeletionStatus("Backup verified — ready for final confirmation");
    } catch (failure) {
      setError(failure instanceof PlatformApiError ? failure.message : "Unable to create verified backup.");
      setDeletionStatus("Backup failed");
    } finally {
      setBusy(false);
    }
  }

  async function permanentlyDelete(): Promise<void> {
    if (deletionPreview === undefined || deletionKey === undefined) return;
    setBusy(true);
    setError(undefined);
    setDeletionStatus("Revalidating and deleting Company data");
    try {
      await platformApi.permanentlyDeleteCompany(companyId, {
        operationId: deletionPreview.operationId,
        previewId: deletionPreview.previewId,
        confirmation: deleteConfirmation,
        idempotencyKey: deletionKey,
      });
      navigate("/companies", {
        replace: true,
        state: { notice: `${company?.code ?? "Company"} was permanently deleted.` },
      });
    } catch (failure) {
      setError(failure instanceof PlatformApiError ? failure.message : "Permanent deletion failed and was rolled back.");
      setDeletionStatus("Failed / rolled back");
    } finally {
      setBusy(false);
    }
  }

  async function runResetPreview(): Promise<void> {
    setBusy(true);
    setResetError(undefined);
    setResetResult(undefined);
    setResetConfirmation("");
    try {
      setResetPreview(await platformApi.companyResetPreview(companyId));
    } catch (failure) {
      setResetError(
        failure instanceof PlatformApiError ? failure.message : "Unable to run the reset preview.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function executeReset(): Promise<void> {
    if (resetPreview === undefined) return;
    setBusy(true);
    setResetError(undefined);
    try {
      const result = await platformApi.resetCompanyData(companyId, resetConfirmation);
      setResetResult(result);
      setResetPreview(undefined);
      setResetConfirmation("");
      await load();
    } catch (failure) {
      setResetError(
        failure instanceof PlatformApiError
          ? failure.message
          : "The reset failed and was rolled back.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmMoveToProduction(): Promise<void> {
    setBusy(true);
    setProductionError(undefined);
    try {
      await platformApi.moveCompanyToProduction(companyId);
      setProductionConfirmation("");
      setResetPreview(undefined);
      setResetResult(undefined);
      await load();
    } catch (failure) {
      setProductionError(
        failure instanceof PlatformApiError
          ? failure.message
          : "The Company could not be moved to production.",
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
        <div className="platform-actions">
          <a
            className="platform-button"
            href={companyPortalUrl(company.subdomain)}
            rel="noreferrer"
            target="_blank"
          >
            Open Portal
          </a>
          <Link className="platform-button platform-button--quiet" to="/companies">
            Back
          </Link>
        </div>
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
        Code and subdomain are fixed after creation. Environment moves only one way — to
        production, via the Lifecycle section below — because it gates whether the Company&apos;s
        data can ever be reset.
      </p>

      <h3>Technical information</h3>
      <dl className="platform-review">
        <div>
          <dt>Company ID</dt>
          <dd>{company.id}</dd>
        </div>
      </dl>

      <h3>Configuration</h3>
      <dl className="platform-review">
        {[
          ["Country", company.countryCode === "AE" ? "United Arab Emirates (AE)" : company.countryCode],
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
            {company.status !== "disabled" && company.status !== "closed" ? (
              <button
                className="platform-button platform-button--quiet"
                disabled={busy}
                onClick={openCloseDialog}
                type="button"
              >
                Close Company
              </button>
            ) : null}
          </div>
          <dialog className="platform-dialog" ref={closeDialogRef}>
            <form
              className="platform-dialog__body"
              method="dialog"
              onSubmit={(event) => {
                event.preventDefault();
                void confirmClose();
              }}
            >
              <h3>Close Company</h3>
              <dl className="platform-dialog__facts">
                <dt>Company Name</dt>
                <dd>{company.nameEn}</dd>
                <dt>Company Code</dt>
                <dd>{company.code}</dd>
                <dt>Environment</dt>
                <dd>{company.environment}</dd>
                <dt>Current Status</dt>
                <dd>{company.status}</dd>
              </dl>
              <p className="platform-warning" role="status">
                No Company data will be deleted by closing the Company.
              </p>
              <label className="platform-field" htmlFor="close-reason">
                <span>Reason for closing this Company</span>
                <input
                  autoFocus
                  id="close-reason"
                  onChange={(event) => setCloseReason(event.target.value)}
                  required
                  type="text"
                  value={closeReason}
                />
              </label>
              <label className="platform-field" htmlFor="close-confirmation">
                <span>Type CLOSE {company.code} to confirm</span>
                <input
                  autoComplete="off"
                  id="close-confirmation"
                  onChange={(event) => setCloseConfirmation(event.target.value)}
                  value={closeConfirmation}
                />
              </label>
              {closeError === undefined ? null : (
                <p className="platform-login__error" role="alert">
                  {closeError}
                </p>
              )}
              <div className="platform-dialog__actions">
                <button
                  className="platform-button platform-button--quiet"
                  disabled={busy}
                  onClick={cancelClose}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="platform-button"
                  disabled={
                    busy ||
                    closeReason.trim().length < 3 ||
                    closeConfirmation !== `CLOSE ${company.code}`
                  }
                  type="submit"
                >
                  Close Company
                </button>
              </div>
            </form>
          </dialog>
          {company.environment !== "production" ? (
            <section aria-labelledby="company-maintenance-heading">
              <h4 id="company-maintenance-heading">Training data &amp; environment</h4>
              <p className="platform-muted">
                This Company is in <strong>{company.environment}</strong>. Its transactional data
                — orders, settlements, reconciliations, accounting entries, payments, expenses,
                customers, traders, drivers and employees — can be reset for training. The
                Company profile, its users, chart of accounts and configuration are always
                preserved. Once the Company moves to production, resetting becomes permanently
                unavailable.
              </p>
              {canReset ? (
                <>
                  <button
                    className="platform-button platform-button--quiet"
                    disabled={busy}
                    onClick={() => void runResetPreview()}
                    type="button"
                  >
                    Preview Data Reset
                  </button>
                  {resetPreview === undefined ? null : (
                    <div className="platform-review">
                      <p role="status">
                        READY FOR RESET: {resetPreview.eligible ? "YES" : "NO"}
                      </p>
                      <p>
                        <strong>Rows to remove:</strong> {resetPreview.totalRows.toLocaleString()}
                        {" across "}
                        {resetPreview.tables.length} table(s). A full-database backup is taken
                        automatically before anything is removed.
                      </p>
                      {resetPreview.tables.map((entry) => (
                        <p key={entry.table}>
                          {entry.table}: {entry.rows.toLocaleString()}
                        </p>
                      ))}
                      {resetPreview.blockers.map((blocker) => (
                        <p className="platform-warning" key={blocker}>
                          {blocker}
                        </p>
                      ))}
                      {resetPreview.eligible ? (
                        <>
                          <label className="platform-field" htmlFor="reset-confirmation">
                            <span>Type RESET {company.code} to confirm</span>
                            <input
                              autoComplete="off"
                              id="reset-confirmation"
                              onChange={(event) => setResetConfirmation(event.target.value)}
                              value={resetConfirmation}
                            />
                          </label>
                          <button
                            className="platform-button"
                            disabled={busy || resetConfirmation !== `RESET ${company.code}`}
                            onClick={() => void executeReset()}
                            type="button"
                          >
                            Reset Company Data
                          </button>
                        </>
                      ) : null}
                    </div>
                  )}
                  {resetResult === undefined ? null : (
                    <div className="platform-review" role="status">
                      <p>
                        <strong>Reset complete.</strong> {resetResult.totalRemoved.toLocaleString()}
                        {" row(s) removed across "}
                        {resetResult.removed.length} table(s). {resetResult.preservedVerified}
                        {" preserved table(s) verified unchanged."}
                      </p>
                      <p>
                        <strong>Backup:</strong> {resetResult.backupFile}
                      </p>
                    </div>
                  )}
                  {resetError === undefined ? null : (
                    <p className="platform-login__error" role="alert">
                      {resetError}
                    </p>
                  )}
                </>
              ) : null}
              <h4>Move to production</h4>
              <p className="platform-warning">
                Moving to production is one-way. After this, the Company&apos;s data can never be
                reset or deleted by any tool, and there is no way back to {company.environment}.
              </p>
              <label className="platform-field" htmlFor="production-confirmation">
                <span>Type PRODUCTION {company.code} to confirm</span>
                <input
                  autoComplete="off"
                  id="production-confirmation"
                  onChange={(event) => setProductionConfirmation(event.target.value)}
                  value={productionConfirmation}
                />
              </label>
              <button
                className="platform-button"
                disabled={busy || productionConfirmation !== `PRODUCTION ${company.code}`}
                onClick={() => void confirmMoveToProduction()}
                type="button"
              >
                Move to Production
              </button>
              {productionError === undefined ? null : (
                <p className="platform-login__error" role="alert">
                  {productionError}
                </p>
              )}
            </section>
          ) : null}
          {company.status === "closed" ? (
            <section aria-labelledby="deletion-foundation-heading">
              <h4 id="deletion-foundation-heading">Permanent Company deletion</h4>
              <p>Environment: {company.environment}</p>
              <p>Closed at: {company.closedAt ?? "—"}</p>
              <p>
                {deletionEligibility?.eligible
                  ? "Eligible for deletion immediately, subject to preview and backup readiness."
                  : deletionEligibility?.eligibleAt === null || deletionEligibility === undefined
                    ? "Deletion eligibility is unavailable."
                    : `Deletion available after ${deletionEligibility.eligibleAt}. Remaining: ${deletionEligibility.remainingSeconds} seconds.`}
              </p>
              {canDelete ? (
                <button
                  className="platform-button platform-button--quiet"
                  disabled={busy}
                  onClick={() => void runDeletionPreview()}
                  type="button"
                >
                  Run Deletion Preview
                </button>
              ) : null}
              {deletionPreviewError === undefined ? null : (
                <div className="platform-review" role="alert">
                  <p>
                    <strong>{deletionPreviewErrorLabel(deletionPreviewError.code)}</strong>
                  </p>
                  <p className="platform-warning">{deletionPreviewError.message}</p>
                  {canDelete ? (
                    <button
                      className="platform-button platform-button--quiet"
                      disabled={busy}
                      onClick={() => void runDeletionPreview()}
                      type="button"
                    >
                      Retry Deletion Preview
                    </button>
                  ) : null}
                </div>
              )}
              {deletionPreview === undefined ? null : (
                <div className="platform-review">
                  <p role="status">READY FOR DELETE: {deletionPreview.readyForDelete ? "YES" : "NO"}</p>
                  <p><strong>Manifest:</strong> {deletionPreview.manifestVersion ?? "pending"} ({deletionPreview.manifestHash?.slice(0, 12) ?? "pending"}…)</p>
                  <p><strong>Total Company rows:</strong> {deletionPreview.totalCompanyRows ?? 0}</p>
                  <p><strong>External objects:</strong> {deletionPreview.externalFiles?.fileObjects ?? 0}</p>
                  <p><strong>Global/shared data:</strong> preserved</p>
                  {Object.entries(deletionPreview.moduleCounts ?? {}).map(([module, count]) => (
                    <p key={module}>{module}: {count}</p>
                  ))}
                  {(deletionPreview.blockers ?? []).map((blocker) => <p className="platform-warning" key={blocker}>{blocker}</p>)}
                  {(deletionPreview.unknownReferences ?? []).map((reference) => (
                    <p className="platform-warning" key={reference}>
                      {reference}
                    </p>
                  ))}
                  <button
                    className="platform-button platform-button--quiet"
                    disabled={busy || (deletionPreview.blockers ?? []).length > 0 || !deletionEligibility?.eligible}
                    onClick={() => void createDeletionBackup()}
                    type="button"
                  >Create Verified Backup</button>
                </div>
              )}
              {deletionBackup === undefined ? null : (
                <div className="platform-review">
                  <p><strong>Backup:</strong> Verified full-database backup</p>
                  <p><strong>Size:</strong> {deletionBackup.sizeBytes.toLocaleString()} bytes</p>
                  <p><strong>Verified:</strong> {deletionBackup.verifiedAt}</p>
                  <label className="platform-field" htmlFor="permanent-delete-confirmation">
                    <span>Type DELETE {company.code}</span>
                    <input id="permanent-delete-confirmation" onChange={(event) => setDeleteConfirmation(event.target.value)} value={deleteConfirmation} />
                  </label>
                  <button className="platform-button" disabled={busy || deleteConfirmation !== `DELETE ${company.code}`} onClick={() => void permanentlyDelete()} type="button">
                    Permanently Delete Company
                  </button>
                </div>
              )}
              {deletionStatus === undefined ? null : <p role="status">{deletionStatus}</p>}
            </section>
          ) : null}
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
