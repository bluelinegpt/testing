import { useCallback, useEffect, useState, type ReactElement } from "react";

import { PlatformApiError, platformApi, type CompanyOrdersAi } from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";

/**
 * Platform Administration → Company → AI.
 *
 * The main switch for Orders AI: the AI tab on the Company's Orders screen,
 * where users ask questions about their Orders in Arabic or English and keep
 * favourite questions. Off for every Company until switched on here. When it
 * is on, the Company can still hide the AI tab in its own Orders menu.
 */
export function CompanyOrdersAiPanel({ companyId }: { companyId: string }): ReactElement {
  const session = usePlatformSession();
  const canManage = session.can("platform.companies.manage");
  const [settings, setSettings] = useState<CompanyOrdersAi>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings(await platformApi.companyOrdersAi(companyId));
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof PlatformApiError ? failure.message : "AI settings could not be loaded.");
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(isEnabled: boolean): Promise<void> {
    if (settings === undefined) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setSettings(
        await platformApi.updateCompanyOrdersAi(companyId, {
          expectedVersion: settings.version,
          isEnabled,
        }),
      );
      setNotice(isEnabled ? "Orders AI is on for this Company." : "Orders AI is off for this Company.");
    } catch (failure) {
      if (failure instanceof PlatformApiError && failure.code === "orders_ai_settings_stale") {
        setError("Someone else changed this setting. It has been reloaded; please check and try again.");
        await load();
      } else {
        setError(failure instanceof PlatformApiError ? failure.message : "AI settings could not be saved.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="company-ai-heading" className="platform-panel">
      <div className="platform-panel__header">
        <div>
          <h3 id="company-ai-heading">AI</h3>
          <p className="platform-muted">
            Orders AI adds an AI tab to the Company&apos;s Orders screen: users ask about their Orders
            in Arabic or English and get the matching list. The AI only turns the question into list
            filters; it never sees Order data. The Company can still hide the tab in its Orders menu.
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
              <dt>Orders AI</dt>
              <dd>{settings.isEnabled ? "On" : "Off"}</dd>
            </div>
            <div>
              <dt>Last changed</dt>
              <dd>{settings.updatedAt === null ? "Never" : new Date(settings.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
          {canManage ? (
            <div className="platform-actions">
              <button
                className={settings.isEnabled ? "platform-button platform-button--quiet" : "platform-button"}
                disabled={busy}
                onClick={() => void save(!settings.isEnabled)}
                type="button"
              >
                {settings.isEnabled ? "Turn off Orders AI" : "Turn on Orders AI"}
              </button>
            </div>
          ) : (
            <p className="platform-muted">You can view this setting but not change it.</p>
          )}
        </>
      )}
    </section>
  );
}
