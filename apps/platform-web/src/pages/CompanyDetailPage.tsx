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
  type CompanyUsersResetPreview,
  type CompanyUsersResetResult,
  type CompanyUsersResetEligible,
  type ReadinessSummary,
} from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";
import { companyPortalUrl } from "../config/company-portal.js";
import { CompanyAdministrators } from "./CompanyAdministrators.js";
import { CompanyWhatsAppPanel } from "./CompanyWhatsAppPanel.js";

type CompanyDetailTab =
  | "information"
  | "administrators"
  | "website"
  | "whatsapp"
  | "configuration"
  | "audit"
  | "lifecycle";

type ResetBusyOperation = "loading-users" | "preparing-preview" | "reset-in-progress";

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
  const [resetBusyOperation, setResetBusyOperation] = useState<ResetBusyOperation | undefined>();
  const [resetCompletionMessage, setResetCompletionMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>(undefined);
  const [deletionEligibility, setDeletionEligibility] = useState<
    CompanyDeletionEligibility | undefined
  >(undefined);
  const [deletionPreview, setDeletionPreview] = useState<CompanyDeletionPreview | undefined>(
    undefined,
  );
  const [deletionBackup, setDeletionBackup] = useState<CompanyDeletionBackup | undefined>(
    undefined,
  );
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
  const [usersResetCandidates, setUsersResetCandidates] = useState<CompanyResetPreview["usersToRemove"]>([]);
  const [usersResetAdmins, setUsersResetAdmins] = useState<CompanyUsersResetEligible["adminUsersPreserved"]>([]);
  const [usersResetBlockers, setUsersResetBlockers] = useState<readonly string[]>([]);
  const [usersResetPreview, setUsersResetPreview] = useState<CompanyUsersResetPreview | undefined>(undefined);
  const [usersResetSelected, setUsersResetSelected] = useState<string[]>([]);
  const [usersResetConfirmation, setUsersResetConfirmation] = useState("");
  const [usersResetResult, setUsersResetResult] = useState<CompanyUsersResetResult | undefined>(undefined);
  const [usersResetError, setUsersResetError] = useState<string | undefined>(undefined);
  const [productionConfirmation, setProductionConfirmation] = useState("");
  const [productionError, setProductionError] = useState<string | undefined>(undefined);
  const [shipmentPrefix, setShipmentPrefix] = useState("");
  const [activeTab, setActiveTab] = useState<CompanyDetailTab>("information");
  const resetBusyText = resetBusyOperation === "loading-users"
    ? "Loading users…"
    : resetBusyOperation === "preparing-preview"
      ? "Preparing preview…"
      : resetBusyOperation === "reset-in-progress"
        ? "Reset in progress…"
        : undefined;

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

  async function saveShipmentPrefix(): Promise<void> {
    if (company === undefined || !/^[A-Z]{3}$/.test(shipmentPrefix)) return;
    setBusy(true);
    setError(undefined);
    try {
      await platformApi.updateShipmentPrefix(companyId, shipmentPrefix, company.version);
      await load();
    } catch (failure) {
      setError(
        failure instanceof PlatformApiError
          ? failure.message
          : "The shipment prefix could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function activateGeneratedShipmentSerials(): Promise<void> {
    if (company === undefined) return;
    const reason = globalThis.prompt(
      "Reason for permanently enabling server-generated shipment serials:",
    );
    if (reason === null || reason.trim().length < 3) return;
    // Prefix saves and other Platform actions increment the Company's
    // optimistic-lock version. Read it again immediately before this
    // irreversible action so activation never submits a version captured by
    // the page before the prefix was saved.
    let latestCompany: CompanyDetail;
    try {
      latestCompany = await platformApi.company(companyId);
      setCompany(latestCompany);
    } catch {
      setError("The latest Company state could not be loaded. Refresh and try again.");
      return;
    }
    if (
      !globalThis.confirm(
        `Permanently activate ${latestCompany.shipmentPrefix ?? "this prefix"}? The prefix cannot be changed after activation.`,
      )
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      await platformApi.activateShipmentSerial(
        companyId,
        reason.trim(),
        latestCompany.version,
        latestCompany.shipmentPrefix ?? "",
      );
      await load();
    } catch (failure) {
      setError(
        failure instanceof PlatformApiError
          ? failure.message
          : "Generated shipment serials could not be activated.",
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
      setDeletionBackup(
        await platformApi.companyDeletionBackup(companyId, deletionPreview.operationId),
      );
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
      setError(
        failure instanceof PlatformApiError ? failure.message : "Unable to create verified backup.",
      );
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
      setError(
        failure instanceof PlatformApiError
          ? failure.message
          : "Permanent deletion failed and was rolled back.",
      );
      setDeletionStatus("Failed / rolled back");
    } finally {
      setBusy(false);
    }
  }

  async function runResetPreview(): Promise<void> {
    setBusy(true);
    setResetBusyOperation("preparing-preview");
    setResetCompletionMessage(undefined);
    setResetError(undefined);
    setResetResult(undefined);
    setResetConfirmation("");
    try {
      const preview = await platformApi.companyResetPreview(companyId);
      setResetPreview(preview);
      setResetCompletionMessage(
        `Done — preview ready: ${preview.totalRows.toLocaleString()} transactional row(s); ` +
          `${preview.fiscalCalendar.fiscalYearsToOpen} fiscal year(s) and ${preview.fiscalCalendar.periodsToOpen} period(s) will be opened.`,
      );
    } catch (failure) {
      setResetError(
        failure instanceof PlatformApiError ? failure.message : "Unable to run the reset preview.",
      );
    } finally {
      setResetBusyOperation(undefined);
      setBusy(false);
    }
  }

  async function executeReset(): Promise<void> {
    if (resetPreview === undefined) return;
    setBusy(true);
    setResetBusyOperation("reset-in-progress");
    setResetCompletionMessage(undefined);
    setResetError(undefined);
    setResetResult(undefined);
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
      setResetBusyOperation(undefined);
      setBusy(false);
    }
  }

  async function runUsersResetSelection(accountIds: string[]): Promise<void> {
    setUsersResetSelected(accountIds);
    setUsersResetConfirmation("");
    setUsersResetError(undefined);
    setUsersResetResult(undefined);
    setUsersResetPreview(undefined);
    setResetCompletionMessage(undefined);
    if (accountIds.length === 0) return;
    setBusy(true);
    setResetBusyOperation("preparing-preview");
    try {
      const preview = await platformApi.previewCompanyUsersReset(companyId, accountIds);
      setUsersResetPreview(preview);
      setResetCompletionMessage(
        `Done — preview ready for ${preview.selectedUsers.length} selected user(s): ` +
          `${preview.accountsToDelete.length} account(s) will be deleted and ` +
          `${preview.identitiesRetained.length} identity/identities retained for history or shared access.`,
      );
      setUsersResetCandidates((current) => {
        const byId = new Map(current.map((user) => [user.accountId, user]));
        for (const user of [...preview.selectedUsers, ...preview.adminUsersPreserved]) byId.set(user.accountId, user);
        return [...byId.values()];
      });
    } catch (failure) {
      setUsersResetError(failure instanceof PlatformApiError ? failure.message : "Unable to preview selected users.");
    } finally {
      setResetBusyOperation(undefined);
      setBusy(false);
    }
  }

  async function runUsersResetList(): Promise<void> {
    setBusy(true);
    setResetBusyOperation("loading-users");
    setResetCompletionMessage(undefined);
    setUsersResetError(undefined);
    setUsersResetResult(undefined);
    setUsersResetSelected([]);
    setUsersResetPreview(undefined);
    try {
      const eligible = await platformApi.eligibleCompanyUsersReset(companyId);
      setUsersResetCandidates(eligible.usersToRemove);
      setUsersResetAdmins(eligible.adminUsersPreserved);
      setUsersResetBlockers(eligible.blockers);
      setResetCompletionMessage(
        `Done — loaded ${eligible.usersToRemove.length} eligible user(s); ` +
          `${eligible.adminUsersPreserved.length} Admin account(s) protected.`,
      );
    } catch (failure) {
      setUsersResetError(failure instanceof PlatformApiError ? failure.message : "Unable to load eligible users.");
    } finally {
      setResetBusyOperation(undefined);
      setBusy(false);
    }
  }

  async function executeUsersReset(): Promise<void> {
    if (usersResetPreview === undefined || usersResetSelected.length === 0) return;
    setBusy(true);
    setResetBusyOperation("reset-in-progress");
    setResetCompletionMessage(undefined);
    setUsersResetError(undefined);
    setUsersResetResult(undefined);
    try {
      const result = await platformApi.resetCompanyUsers(companyId, usersResetSelected, usersResetConfirmation);
      setUsersResetResult(result);
      setUsersResetPreview(undefined);
      setUsersResetSelected([]);
      setUsersResetConfirmation("");
      const eligible = await platformApi.eligibleCompanyUsersReset(companyId);
      setUsersResetCandidates(eligible.usersToRemove);
      setUsersResetAdmins(eligible.adminUsersPreserved);
      setUsersResetBlockers(eligible.blockers);
      await load();
    } catch (failure) {
      setUsersResetError(failure instanceof PlatformApiError ? failure.message : "The selected-user reset failed and was rolled back.");
    } finally {
      setResetBusyOperation(undefined);
      setResetCompletionMessage(undefined);
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

      <div aria-label="Company sections" className="company-detail-tabs" role="tablist">
        {(
          [
            ["information", "Company Information"],
            ["administrators", "Administrators & Passwords"],
            ["website", "Website"],
            ["whatsapp", "WhatsApp"],
            ["configuration", "Configuration & Accounting"],
            ["audit", "Audit"],
            ["lifecycle", "Lifecycle"],
          ] as const
        ).map(([tab, label]) => (
          <button
            aria-controls={`company-tab-${tab}`}
            aria-selected={activeTab === tab}
            className="company-detail-tabs__tab"
            id={`company-tab-button-${tab}`}
            key={tab}
            onClick={() => setActiveTab(tab)}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      <section
        aria-labelledby="company-tab-button-information"
        hidden={activeTab !== "information"}
        id="company-tab-information"
        role="tabpanel"
      >
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
              ["Mobile app code", company.mobileCode],
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
      </section>

      <section
        aria-labelledby="company-tab-button-website"
        className="company-website-summary"
        hidden={activeTab !== "website"}
        id="company-tab-website"
        role="tabpanel"
      >
        <div className="platform-panel__header">
          <div>
            <h3 id="company-website-summary-heading">Company Website</h3>
            <p className="platform-muted">
              Templates, content, publishing, AI settings and domains are managed on a separate
              page.
            </p>
          </div>
          <Link className="platform-button" to={`/companies/${companyId}/website`}>
            Manage Website
          </Link>
        </div>
      </section>

      <section
        aria-labelledby="company-tab-button-whatsapp"
        hidden={activeTab !== "whatsapp"}
        id="company-tab-whatsapp"
        role="tabpanel"
      >
        {activeTab === "whatsapp" && companyId ? (
          <CompanyWhatsAppPanel companyId={companyId} />
        ) : null}
      </section>

      <section hidden={activeTab !== "information"}>
        <h3>Technical information</h3>
        <dl className="platform-review">
          <div>
            <dt>Company ID</dt>
            <dd>{company.id}</dd>
          </div>
        </dl>
      </section>

      <section
        aria-labelledby="company-tab-button-configuration"
        hidden={activeTab !== "configuration"}
        id="company-tab-configuration"
        role="tabpanel"
      >
        <h3>PSystem Serial numbering</h3>
        <p className="platform-muted">
          New Companies receive and activate a permanent name-based prefix automatically. The
          controls below appear only for existing legacy Companies that have not been activated.
        </p>
        <dl className="platform-review">
          <div>
            <dt>Shipment prefix</dt>
            <dd>{company.shipmentPrefix ?? "Not assigned"}</dd>
          </div>
          <div>
            <dt>PSystem Serial generation</dt>
            <dd>
              {company.shipmentSerialEnabledAt
                ? `Activated ${new Date(company.shipmentSerialEnabledAt).toISOString().slice(0, 19).replace("T", " ")}`
                : "Not activated"}
            </dd>
          </div>
        </dl>
        {canManage && !company.shipmentSerialEnabledAt ? (
          <div className="platform-actions">
            <label className="platform-field" htmlFor="shipment-prefix">
              <span>Correct unused prefix</span>
              <input
                id="shipment-prefix"
                maxLength={3}
                onChange={(event) =>
                  setShipmentPrefix(
                    event.target.value
                      .replace(/[^A-Za-z]/g, "")
                      .toUpperCase()
                      .slice(0, 3),
                  )
                }
                placeholder={company.shipmentPrefix ?? "ABC"}
                value={shipmentPrefix}
              />
            </label>
            <button
              className="platform-button platform-button--quiet"
              disabled={busy || !/^[A-Z]{3}$/.test(shipmentPrefix)}
              onClick={() => void saveShipmentPrefix()}
              type="button"
            >
              Save prefix
            </button>
            <button
              className="platform-button"
              disabled={busy || company.shipmentPrefix === null}
              onClick={() => void activateGeneratedShipmentSerials()}
              type="button"
            >
              Activate PSystem Serials
            </button>
          </div>
        ) : null}

        <h3>Configuration</h3>
        <dl className="platform-review">
          {[
            [
              "Country",
              company.countryCode === "AE" ? "United Arab Emirates (AE)" : company.countryCode,
            ],
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
                  <span className={`platform-badge platform-badge--${item.state}`}>
                    {item.state}
                  </span>
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
      </section>

      <section
        aria-labelledby="company-tab-button-administrators"
        hidden={activeTab !== "administrators"}
        id="company-tab-administrators"
        role="tabpanel"
      >
        <CompanyAdministrators companyId={companyId} onChanged={() => void load()} />
      </section>

      <section
        aria-labelledby="company-tab-button-audit"
        hidden={activeTab !== "audit"}
        id="company-tab-audit"
        role="tabpanel"
      >
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
      </section>

      <section
        aria-labelledby="company-tab-button-lifecycle"
        hidden={activeTab !== "lifecycle"}
        id="company-tab-lifecycle"
        role="tabpanel"
      >
        {company.status === "closed" ? (
          <p className="platform-warning" role="status">
            This Company is closed. Closed is currently a terminal state, so Reactivate is not
            available. Reactivation applies only to suspended Companies.
          </p>
        ) : null}
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
              <section
                aria-labelledby="company-maintenance-heading"
                style={{ cursor: resetBusyOperation === undefined ? undefined : "progress" }}
              >
                <h4 id="company-maintenance-heading">Training data &amp; environment</h4>
                {resetBusyText === undefined ? null : (
                  <p className="platform-reset-progress" role="status" aria-live="polite">
                    <span className="platform-reset-progress__spinner" aria-hidden="true" />
                    {resetBusyText}
                  </p>
                )}
                {resetBusyText === undefined && resetCompletionMessage !== undefined ? (
                  <p role="status" aria-live="polite">{resetCompletionMessage}</p>
                ) : null}
                <p className="platform-muted">
                  This Company is in <strong>{company.environment}</strong>. Its transactional data
                  — orders, settlements, reconciliations, accounting entries, payments, expenses,
                  customers, traders, drivers, employees and all non-Admin Company accounts —
                  including Trader and Driver Portal accounts — can be reset for training. Any
                  account with an assigned Admin role, the Company profile, chart of accounts and
                  configuration are preserved. Non-Admin company access and sessions are removed;
                  identities referenced by preserved history are retained only as disabled records.
                  Once the Company moves to production, resetting becomes permanently unavailable.
                </p>
                {canReset ? (
                  <>
                    <section aria-labelledby="users-only-reset-heading" className="platform-review">
                      <h5 id="users-only-reset-heading">Users Only Reset</h5>
                      <p className="platform-muted">
                        Select only the non-Admin Company or Trader Portal accounts to remove. Other company data and unselected users are preserved; identities required by shared access or history remain without target-company access.
                      </p>
                      <button className="platform-button platform-button--quiet" disabled={busy} onClick={() => void runUsersResetList()} type="button">
                        {resetBusyOperation === "loading-users" ? "Loading users…" : "Load Users for Selective Reset"}
                      </button>
                      {usersResetCandidates.length > 0 ? (
                        <div aria-label="Eligible users for selective reset">
                          <label>
                            <input
                              checked={usersResetSelected.length === usersResetCandidates.length && usersResetCandidates.length > 0}
                              disabled={busy}
                              onChange={(event) => void runUsersResetSelection(event.target.checked ? usersResetCandidates.map((user) => user.accountId) : [])}
                              type="checkbox"
                            /> Select All eligible users
                          </label>
                          {usersResetCandidates.map((user) => (
                            <label key={user.accountId} style={{ display: "block" }}>
                              <input
                                checked={usersResetSelected.includes(user.accountId)}
                                disabled={busy}
                                onChange={(event) => {
                                  const ids = event.target.checked
                                    ? [...usersResetSelected, user.accountId]
                                    : usersResetSelected.filter((id) => id !== user.accountId);
                                  void runUsersResetSelection(ids);
                                }}
                                type="checkbox"
                              /> {user.displayName} ({user.username}) — {user.accountKind} — {user.status}
                              {user.retentionReason ? <span> — {user.retentionReason}</span> : null}
                            </label>
                          ))}
                        </div>
                      ) : null}
                      {usersResetAdmins.map((user) => (
                        <p key={user.accountId}>Admin protected — not selectable: {user.displayName} ({user.username}) — {user.accountKind}</p>
                      ))}
                      {usersResetBlockers.map((blocker) => <p className="platform-warning" key={blocker}>{blocker}</p>)}
                      {usersResetPreview === undefined ? null : (
                        <div>
                          <p><strong>Selected:</strong> {usersResetPreview.selectedUsers.length}</p>
                          <p><strong>Physical account deletion:</strong> {usersResetPreview.accountsToDelete.length}</p>
                          {usersResetPreview.accountsToDelete.map((user) => (
                            <p key={user.accountId}>{user.displayName} ({user.username}) — {user.accountKind} — {user.status}</p>
                          ))}
                          <p><strong>Target-company access removal only; identity retained for history or other-company access:</strong> {usersResetPreview.identitiesRetained.length}</p>
                          {usersResetPreview.identitiesRetained.map((user) => (
                            <p key={user.accountId}>
                              {user.displayName} ({user.username}) — {user.accountKind} — {user.status} — {user.reason === "preserved_history" ? (user.retentionReason ?? "preserved history") : "Other-company access is retained; only this Company's access is removed."}
                              {user.references.length ? ` — ${user.references.map((ref) => `${ref.table}.${ref.column} (${ref.rows}; ${ref.onDelete})`).join(", ")}` : ""}
                            </p>
                          ))}
                          {usersResetPreview.adminUsersPreserved.map((user) => (
                            <p key={user.accountId}>Admin protected and not selectable: {user.displayName} ({user.username})</p>
                          ))}
                          {usersResetPreview.blockers.map((blocker) => <p className="platform-warning" key={blocker}>{blocker}</p>)}
                          {usersResetPreview.eligible ? (
                            <>
                              <label className="platform-field" htmlFor="users-reset-confirmation">
                                <span>Type {usersResetPreview.confirmation} to confirm</span>
                                <input autoComplete="off" id="users-reset-confirmation" onChange={(event) => setUsersResetConfirmation(event.target.value)} value={usersResetConfirmation} />
                              </label>
                              <button className="platform-button" disabled={busy || usersResetConfirmation !== usersResetPreview.confirmation} onClick={() => void executeUsersReset()} type="button">
                                {resetBusyOperation === "reset-in-progress" ? "Reset in progress…" : "Reset Selected Users"}
                              </button>
                            </>
                          ) : null}
                        </div>
                      )}
                      {usersResetResult === undefined ? null : (
                        <div role="status">
                          <p><strong>Done — Users Only reset succeeded.</strong> {usersResetResult.cleanup.accountsDeleted} account(s) deleted; {usersResetResult.cleanup.sessionsRevoked} Company session(s) revoked; {usersResetResult.cleanup.employeesUnlinked} Employee profile(s) unlinked for later account creation; {usersResetResult.cleanup.retainedIdentities.length} identity/identities retained safely.</p>
                          {usersResetResult.cleanup.retainedIdentities.map((user) => (
                            <p key={user.accountId}>Retained {user.displayName} ({user.username}) — {user.reason}; Company access removed. {user.references.map((ref) => `${ref.table}.${ref.column} (${ref.rows})`).join(", ")}</p>
                          ))}
                        </div>
                      )}
                      {usersResetError === undefined ? null : <p className="platform-login__error" role="alert">{usersResetError}</p>}
                    </section>
                    <button
                      className="platform-button platform-button--quiet"
                      disabled={busy}
                      onClick={() => void runResetPreview()}
                      type="button"
                    >
                      {resetBusyOperation === "preparing-preview" ? "Preparing preview…" : "Preview Data Reset"}
                    </button>
                    {resetPreview === undefined ? null : (
                      <div className="platform-review">
                        <p role="status">READY FOR RESET: {resetPreview.eligible ? "YES" : "NO"}</p>
                        <p>
                          <strong>Transactional rows to remove:</strong>{" "}
                          {resetPreview.totalRows.toLocaleString()}
                          {" across "}
                          {resetPreview.tables.length} table(s). A full-database backup is taken
                          automatically before anything is removed.
                        </p>
                        <p>
                          <strong>Fiscal calendar:</strong> preserve {resetPreview.fiscalCalendar.fiscalYearsPreserved} fiscal year(s)
                          and {resetPreview.fiscalCalendar.periodsPreserved} period(s); open {resetPreview.fiscalCalendar.fiscalYearsToOpen}
                          fiscal year(s) and {resetPreview.fiscalCalendar.periodsToOpen} period(s). IDs, dates, numbering and fiscal-year links remain unchanged.
                        </p>
                        {resetPreview.tables.map((entry) => (
                          <p key={entry.table}>
                            {entry.table}: {entry.rows.toLocaleString()}
                          </p>
                        ))}
                        <section aria-label="Company user reset preview">
                          <h5>Company accounts</h5>
                          <p>
                            <strong>Users to remove:</strong> {resetPreview.usersToRemove.length}
                          </p>
                          {resetPreview.usersToRemove.length === 0 ? (
                            <p>No non-Admin Company users will be removed.</p>
                          ) : (
                            resetPreview.usersToRemove.map((user) => (
                              <p key={user.accountId}>
                                {user.displayName} ({user.username}) — {user.accountKind}
                                {user.sharedIdentity
                                  ? " — shared identity; other-Company access will be preserved"
                                  : ""}
                              </p>
                            ))
                          )}
                          <p>
                            <strong>Admin users preserved:</strong>{" "}
                            {resetPreview.adminUsersPreserved.length}
                          </p>
                          {resetPreview.adminUsersPreserved.length === 0 ? (
                            <p>No assigned Admin users were found.</p>
                          ) : (
                            resetPreview.adminUsersPreserved.map((user) => (
                              <p key={user.accountId}>
                                {user.displayName} ({user.username}) — {user.accountKind}; all Company access preserved
                              </p>
                            ))
                          )}
                          <p className="platform-muted">
                            Admin status is determined from assigned Company roles. A login identity
                            referenced by preserved history is retained but disabled after its
                            Company access is removed.
                          </p>
                        </section>
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
                              {resetBusyOperation === "reset-in-progress" ? "Reset in progress…" : "Reset Company Data"}
                            </button>
                          </>
                        ) : null}
                      </div>
                    )}
                    {resetResult === undefined ? null : (
                      <div className="platform-review" role="status">
                        <p>
                          <strong>Done — Full company reset succeeded.</strong>{" "}
                          {resetResult.totalRemoved.toLocaleString()}
                          {" row(s) removed across "}
                          {resetResult.removed.length} table(s). {resetResult.preservedVerified}
                          {" preserved table(s) verified unchanged."}
                        </p>
                        <p>
                          <strong>Fiscal calendar:</strong> {resetResult.fiscalCalendar.fiscalYearsPreserved} fiscal year(s)
                          and {resetResult.fiscalCalendar.periodsPreserved} period(s) preserved; opened {resetResult.fiscalCalendar.fiscalYearsOpened}
                          fiscal year(s) and {resetResult.fiscalCalendar.periodsOpened} period(s).
                        </p>
                        <p>
                          <strong>Backup:</strong> {resetResult.backupFile}
                        </p>
                        <p>
                          <strong>Non-Admin accounts deleted:</strong>{" "}
                          {resetResult.userCleanup.accountsDeleted.toLocaleString()}. Admin-role
                          accounts were preserved; {resetResult.userCleanup.companyUsersRemoved.toLocaleString()}{" "}
                          Company user memberships, {resetResult.userCleanup.roleAssignmentsRemoved.toLocaleString()}{" "}
                          role assignments, {resetResult.userCleanup.businessAccessLinksRemoved.toLocaleString()}{" "}
                          portal access links and {resetResult.userCleanup.sessionsRevoked.toLocaleString()}{" "}
                          sessions were removed.
                        </p>
                        {resetResult.userCleanup.sharedIdentitiesPreserved > 0 ||
                        resetResult.userCleanup.historyReferencedIdentitiesPreserved > 0 ? (
                          <p>
                            {resetResult.userCleanup.sharedIdentitiesPreserved.toLocaleString()}{" "}
                            shared identity/identities and{" "}
                            {resetResult.userCleanup.historyReferencedIdentitiesPreserved.toLocaleString()}{" "}
                            identity/identities referenced by preserved history were retained safely.
                          </p>
                        ) : null}
                        {resetResult.userCleanup.retainedIdentities.map((user) => (
                          <p key={user.accountId}>
                            Retained identity {user.displayName} ({user.username}, {user.accountKind})
                            {user.reason === "preserved_history"
                              ? " — disabled; target-Company access removed"
                              : " — target-Company access removed; other-Company access preserved"}
                            {user.references.length > 0
                              ? ` — preserved references: ${user.references
                                  .map((reference) => `${reference.table}.${reference.column} (${reference.rows}; ${reference.onDelete === "other-company access preserved" ? reference.onDelete : `FK ON DELETE ${reference.onDelete}`})`)
                                  .join(", ")}`
                              : " — other-company access is preserved"}
                          </p>
                        ))}
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
                    <p role="status">
                      READY FOR DELETE: {deletionPreview.readyForDelete ? "YES" : "NO"}
                    </p>
                    <p>
                      <strong>Manifest:</strong> {deletionPreview.manifestVersion ?? "pending"} (
                      {deletionPreview.manifestHash?.slice(0, 12) ?? "pending"}…)
                    </p>
                    <p>
                      <strong>Total Company rows:</strong> {deletionPreview.totalCompanyRows ?? 0}
                    </p>
                    <p>
                      <strong>External objects:</strong>{" "}
                      {deletionPreview.externalFiles?.fileObjects ?? 0}
                    </p>
                    <p>
                      <strong>Global/shared data:</strong> preserved
                    </p>
                    {Object.entries(deletionPreview.moduleCounts ?? {}).map(([module, count]) => (
                      <p key={module}>
                        {module}: {count}
                      </p>
                    ))}
                    {(deletionPreview.blockers ?? []).map((blocker) => (
                      <p className="platform-warning" key={blocker}>
                        {blocker}
                      </p>
                    ))}
                    {(deletionPreview.unknownReferences ?? []).map((reference) => (
                      <p className="platform-warning" key={reference}>
                        {reference}
                      </p>
                    ))}
                    <button
                      className="platform-button platform-button--quiet"
                      disabled={
                        busy ||
                        (deletionPreview.blockers ?? []).length > 0 ||
                        !deletionEligibility?.eligible
                      }
                      onClick={() => void createDeletionBackup()}
                      type="button"
                    >
                      Create Verified Backup
                    </button>
                  </div>
                )}
                {deletionBackup === undefined ? null : (
                  <div className="platform-review">
                    <p>
                      <strong>Backup:</strong> Verified full-database backup
                    </p>
                    <p>
                      <strong>Size:</strong> {deletionBackup.sizeBytes.toLocaleString()} bytes
                    </p>
                    <p>
                      <strong>Verified:</strong> {deletionBackup.verifiedAt}
                    </p>
                    <label className="platform-field" htmlFor="permanent-delete-confirmation">
                      <span>Type DELETE {company.code}</span>
                      <input
                        id="permanent-delete-confirmation"
                        onChange={(event) => setDeleteConfirmation(event.target.value)}
                        value={deleteConfirmation}
                      />
                    </label>
                    <button
                      className="platform-button"
                      disabled={busy || deleteConfirmation !== `DELETE ${company.code}`}
                      onClick={() => void permanentlyDelete()}
                      type="button"
                    >
                      Permanently Delete Company
                    </button>
                  </div>
                )}
                {deletionStatus === undefined ? null : <p role="status">{deletionStatus}</p>}
              </section>
            ) : null}
            <p className="platform-muted">
              Suspension stops sign-in and ends existing sessions. No data is removed, and a
              suspended Company can be reactivated without recreating anything.
            </p>
          </>
        ) : (
          <p className="platform-muted">
            You have read-only Platform access. Lifecycle actions require
            <code> platform.companies.manage</code>.
          </p>
        )}
      </section>
    </section>
  );
}
