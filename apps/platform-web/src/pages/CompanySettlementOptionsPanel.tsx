import { useCallback, useEffect, useState, type ReactElement } from "react";

import {
  PlatformApiError,
  platformApi,
  type CompanySettlementOptions,
} from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";

type Option = "oneScreen" | "codShortfall";

/**
 * Platform Administration → Company → Trader Settlement.
 *
 * The two per-Company switches behind the one-screen Trader Settlement (Aiman,
 * 22 Oct 2026). Each can be turned on and off at any time -- this is the
 * rollback. Only the switch changes: no Order, settlement or money is touched,
 * and every change is audited with the reason typed here.
 */
export function CompanySettlementOptionsPanel({ companyId }: { companyId: string }): ReactElement {
  const session = usePlatformSession();
  const canManage = session.can("platform.companies.manage");
  const [options, setOptions] = useState<CompanySettlementOptions>();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setOptions(await platformApi.companySettlementOptions(companyId));
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof PlatformApiError ? failure.message : "Settlement options could not be loaded.");
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(option: Option): Promise<void> {
    if (options === undefined) return;
    if (reason.trim() === "") {
      setError("Enter a reason first. It is kept in the audit trail.");
      return;
    }
    const next = !options[option];
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setOptions(
        await platformApi.updateCompanySettlementOptions(companyId, { [option]: next, reason: reason.trim() }),
      );
      setReason("");
      setNotice(`${label[option]} is now ${next ? "on" : "off"} for this Company.`);
    } catch (failure) {
      setError(failure instanceof PlatformApiError ? failure.message : "Settlement options could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const label: Record<Option, string> = {
    codShortfall: "Trader pays COD shortfall",
    oneScreen: "One-screen settlement",
  };
  const help: Record<Option, string> = {
    codShortfall:
      "On a Pay by Customer order whose COD is above 0 but below the fee, the Trader is charged the difference " +
      "(fee − COD) as a fee on his settlement. New orders only. Off again: new orders stop being charged; " +
      "charges already made stay owed and still show on settlements.",
    oneScreen:
      "Trader Settlement on one screen: orders, fees, credits and nothing-to-pay orders in one table; Draft → " +
      "Preview → Post; Un-post & adjust; no Money Received step; fees above the orders are collected from the " +
      "Trader on the same screen, and every Collect from Trader opens it. Off again: the old screens and the " +
      "Money Received step return; what was posted stays valid.",
  };

  return (
    <section aria-labelledby="company-settlement-heading" className="platform-panel">
      <div className="platform-panel__header">
        <div>
          <h3 id="company-settlement-heading">Trader Settlement</h3>
          <p className="platform-muted">
            Switch these on or off for this Company at any time. Only the setting changes; no order, settlement
            or money is changed. Each change is recorded in the audit with its reason.
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

      {options === undefined ? (
        <p className="platform-muted">Loading…</p>
      ) : (
        <>
          <dl className="platform-review">
            {(["oneScreen", "codShortfall"] as const).map((option) => (
              <div key={option}>
                <dt>{label[option]}</dt>
                <dd>
                  <strong>{options[option] ? "On" : "Off"}</strong>
                  <br />
                  <span className="platform-muted">{help[option]}</span>
                </dd>
              </div>
            ))}
            <div>
              <dt>Open settlement drafts</dt>
              <dd>{options.openDrafts}</dd>
            </div>
            <div>
              <dt>Orders paid, Money Received not confirmed</dt>
              <dd>{options.ordersWaitingReceipt}</dd>
            </div>
          </dl>
          {canManage ? (
            <>
              <label className="platform-field">
                <span>Reason for the change</span>
                <input
                  maxLength={500}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="e.g. Move Lahthza to the one-screen settlement"
                  value={reason}
                />
              </label>
              <div className="platform-actions">
                {(["oneScreen", "codShortfall"] as const).map((option) => (
                  <button
                    className={options[option] ? "platform-button platform-button--quiet" : "platform-button"}
                    disabled={busy}
                    key={option}
                    onClick={() => void toggle(option)}
                    type="button"
                  >
                    {options[option] ? `Turn off ${label[option]}` : `Turn on ${label[option]}`}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="platform-muted">You can view these settings but not change them.</p>
          )}
        </>
      )}
    </section>
  );
}
