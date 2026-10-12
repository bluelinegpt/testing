import { useCallback, useEffect, useState, type ReactElement } from "react";

import { PlatformApiError, platformApi, type CompanyMobileApp } from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";

/**
 * Platform Administration → Company → Mobile app.
 *
 * One switch for all of the Company's mobile users (drivers, traders and
 * office staff using the TawseelHub app). Off takes effect at once: app
 * sign-ins are refused with a clear message and anyone already signed in to
 * the app is stopped on their next action. The web portal is not affected.
 */
export function CompanyMobileAppPanel({ companyId }: { companyId: string }): ReactElement {
  const session = usePlatformSession();
  const canManage = session.can("platform.companies.manage");
  const [settings, setSettings] = useState<CompanyMobileApp>();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings(await platformApi.companyMobileApp(companyId));
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof PlatformApiError ? failure.message : "Mobile app settings could not be loaded.");
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(isEnabled: boolean): Promise<void> {
    if (!isEnabled && reason.trim().length === 0) {
      setError("Enter a reason for turning off the mobile app.");
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setSettings(
        await platformApi.updateCompanyMobileApp(companyId, {
          isEnabled,
          ...(isEnabled ? {} : { reason: reason.trim() }),
        }),
      );
      setReason("");
      setNotice(
        isEnabled
          ? "The mobile app is on. Users can sign in to the app again."
          : "The mobile app is off. App users are stopped on their next action; the web portal still works.",
      );
    } catch (failure) {
      setError(failure instanceof PlatformApiError ? failure.message : "Mobile app settings could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="company-mobile-heading" className="platform-panel">
      <div className="platform-panel__header">
        <div>
          <h3 id="company-mobile-heading">Mobile app</h3>
          <p className="platform-muted">
            One switch for all of this Company&apos;s users of the TawseelHub app. It is off until you turn it
            on here. When it is off, the app refuses to sign in with a clear message and anyone already
            signed in is stopped on their next action. The web portal keeps working.
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

      {settings === undefined ? (
        <p className="platform-muted">Loading…</p>
      ) : (
        <>
          <dl className="platform-review">
            <div>
              <dt>Mobile app</dt>
              <dd>{settings.isEnabled ? "On" : "Off"}</dd>
            </div>
            <div>
              <dt>Signed in to the app now</dt>
              <dd>{settings.activeMobileSessions}</dd>
            </div>
            <div>
              <dt>Last changed</dt>
              <dd>{settings.changedAt === null ? "Never" : new Date(settings.changedAt).toLocaleString()}</dd>
            </div>
          </dl>
          {canManage ? (
            settings.isEnabled ? (
              <div className="platform-actions">
                <label className="platform-field">
                  <span>Reason (required to turn off)</span>
                  <input
                    maxLength={300}
                    onChange={(event) => setReason(event.target.value)}
                    type="text"
                    value={reason}
                  />
                </label>
                <button
                  className="platform-button platform-button--quiet"
                  disabled={busy}
                  onClick={() => void save(false)}
                  type="button"
                >
                  Turn off the mobile app
                </button>
              </div>
            ) : (
              <div className="platform-actions">
                <button className="platform-button" disabled={busy} onClick={() => void save(true)} type="button">
                  Turn on the mobile app
                </button>
              </div>
            )
          ) : (
            <p className="platform-muted">You can view this setting but not change it.</p>
          )}
        </>
      )}
    </section>
  );
}
