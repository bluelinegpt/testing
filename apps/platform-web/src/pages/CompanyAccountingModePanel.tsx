import { useCallback, useEffect, useState, type ReactElement } from "react";

import {
  PlatformApiError,
  platformApi,
  type CompanyAccountingModeBlocker,
  type CompanyAccountingModePreview,
  type CompanyAccountingModeStatus,
} from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";

const BLOCKER_LABELS: Readonly<Record<string, string>> = {
  failed_accounting_events: "Failed accounting entries",
  in_flight_accounting_events: "Accounting entries being processed right now",
  pending_accounting_events: "Accounting entries waiting to post",
  running_accounting_batches: "Accounting batch jobs still running",
  unfinished_journal_entries: "Journals not yet posted",
};

function blockerText(blocker: CompanyAccountingModeBlocker): string {
  const label = BLOCKER_LABELS[blocker.code] ?? blocker.code.replace(/_/g, " ");
  return blocker.detail === undefined ? label : `${label}: ${blocker.detail}`;
}

/**
 * Platform Administration -> Company -> Configuration & Accounting ->
 * Accounting mode.
 *
 * The switch for GL Accounting ON/OFF already exists in the API
 * (`platform/companies/:id/accounting-mode`) with its own preview, typed
 * confirmation and stale-version guard; this panel is only its screen. The
 * server decides whether the change is allowed -- the panel shows the preview
 * it returns and sends back exactly the confirmation and configuration version
 * that preview was computed against.
 *
 * OFF keeps every operational screen (orders, driver collections, settlements,
 * receivables, cash and bank) and stops only GL capture: no Accounting Events,
 * Journals or fiscal-period work.
 */
export function CompanyAccountingModePanel({
  companyCode,
  companyId,
}: {
  companyCode: string;
  companyId: string;
}): ReactElement {
  const session = usePlatformSession();
  const canChange = session.can("platform.companies.accounting_mode.manage");
  const [status, setStatus] = useState<CompanyAccountingModeStatus>();
  const [preview, setPreview] = useState<CompanyAccountingModePreview>();
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await platformApi.companyAccountingMode(companyId));
      setError(undefined);
    } catch (failure) {
      setError(
        failure instanceof PlatformApiError ? failure.message : "Accounting mode could not be loaded.",
      );
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openPreview(action: "enable" | "disable"): Promise<void> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setReason("");
    setTyped("");
    try {
      setPreview(await platformApi.companyAccountingModePreview(companyId, action));
    } catch (failure) {
      setError(
        failure instanceof PlatformApiError ? failure.message : "The preview could not be loaded.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function execute(): Promise<void> {
    if (preview === undefined) return;
    if (reason.trim().length === 0) {
      setError("Enter a reason for this change.");
      return;
    }
    if (typed.trim() !== preview.confirmation) {
      setError(`Type ${preview.confirmation} exactly to confirm.`);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await platformApi.changeCompanyAccountingMode(companyId, preview.action, {
        confirmation: typed.trim(),
        expectedConfigurationVersion: preview.expectedConfigurationVersion,
        reason: reason.trim(),
      });
      setNotice(
        preview.action === "disable"
          ? "Accounting is OFF. Operations, settlements, collections and cash balances keep working; no new accounting entries are created."
          : "Accounting is ON. New operations create accounting entries again; the period it was OFF is not filled in automatically.",
      );
      setPreview(undefined);
      await load();
    } catch (failure) {
      // A stale preview (someone changed the configuration meanwhile) or new
      // unresolved work: the server refused and nothing changed.
      setError(
        failure instanceof PlatformApiError ? failure.message : "The change could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  const enabled = status?.accountingEnabled === true;

  return (
    <section aria-labelledby="company-accounting-mode-heading" className="platform-panel">
      <div className="platform-panel__header">
        <div>
          <h3 id="company-accounting-mode-heading">Accounting mode</h3>
          <p className="platform-muted">
            GL Accounting for {companyCode}. When it is OFF, orders, driver collections, trader
            settlements, receivables and cash/bank balances all keep working; only accounting
            entries, journals and fiscal periods stop. Nothing already recorded is changed either way.
          </p>
        </div>
      </div>

      {error ? (
        <p className="platform-warning" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="platform-muted" role="status">
          {notice}
        </p>
      ) : null}

      {status === undefined ? (
        error === undefined ? <p className="platform-muted">Loading…</p> : null
      ) : (
        <>
          <dl className="platform-review">
            <div>
              <dt>Accounting</dt>
              <dd data-testid="accounting-mode-state">{enabled ? "ON" : "OFF"}</dd>
            </div>
            <div>
              <dt>Automatic posting</dt>
              <dd>{status.automaticPostingEnabled ? "On" : "Off"}</dd>
            </div>
            <div>
              <dt>Unresolved accounting entries</dt>
              <dd>
                {status.unresolved.failed} failed · {status.unresolved.pending} waiting ·{" "}
                {status.unresolved.otherUnresolved} in progress
              </dd>
            </div>
          </dl>

          {!canChange ? (
            <p className="platform-muted">You can view this setting but not change it.</p>
          ) : preview === undefined ? (
            <div className="platform-actions">
              <button
                className={enabled ? "platform-button platform-button--quiet" : "platform-button"}
                disabled={busy}
                onClick={() => void openPreview(enabled ? "disable" : "enable")}
                type="button"
              >
                {enabled ? "Turn accounting off…" : "Turn accounting on…"}
              </button>
            </div>
          ) : (
            <div
              aria-label={preview.action === "disable" ? "Turn accounting off" : "Turn accounting on"}
              className="platform-warning"
              role="region"
            >
              {preview.blockers.length > 0 ? (
                <>
                  <p>
                    <strong>
                      {preview.action === "disable"
                        ? "Accounting cannot be turned off yet. Resolve these first:"
                        : "Accounting cannot be turned on yet. Resolve these first:"}
                    </strong>
                  </p>
                  <ul>
                    {preview.blockers.map((blocker) => (
                      <li key={`${blocker.code}:${blocker.detail ?? ""}`}>{blockerText(blocker)}</li>
                    ))}
                  </ul>
                </>
              ) : !preview.executable ? (
                <p>No change is needed: accounting is already {enabled ? "ON" : "OFF"}.</p>
              ) : (
                <>
                  <p>
                    {preview.action === "disable"
                      ? "Nothing blocks this. Automatic posting is switched off with it. Turning accounting back on later does not fill in the period it was OFF."
                      : "Nothing blocks this. Automatic posting stays off until it is switched on separately. The period accounting was OFF is not filled in."}
                  </p>
                  <label className="platform-field">
                    <span>Reason</span>
                    <input
                      maxLength={500}
                      onChange={(event) => setReason(event.target.value)}
                      type="text"
                      value={reason}
                    />
                  </label>
                  <label className="platform-field">
                    <span>
                      Type <code>{preview.confirmation}</code> to confirm
                    </span>
                    <input
                      autoComplete="off"
                      onChange={(event) => setTyped(event.target.value)}
                      type="text"
                      value={typed}
                    />
                  </label>
                </>
              )}
              <div className="platform-actions">
                {preview.executable && preview.blockers.length === 0 ? (
                  <button
                    className="platform-button"
                    disabled={busy}
                    onClick={() => void execute()}
                    type="button"
                  >
                    {preview.action === "disable" ? "Turn accounting off" : "Turn accounting on"}
                  </button>
                ) : null}
                <button
                  className="platform-button platform-button--quiet"
                  disabled={busy}
                  onClick={() => {
                    setPreview(undefined);
                    setError(undefined);
                  }}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
