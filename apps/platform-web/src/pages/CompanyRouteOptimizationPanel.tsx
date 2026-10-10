import { useCallback, useEffect, useState, type ReactElement } from "react";

import {
  PlatformApiError,
  platformApi,
  type CompanyRouteOptimization,
  type RouteKillSwitch,
} from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";

const MANAGE = "platform.company_route_optimization.manage";

/**
 * Platform Administration → Company → Route planning.
 *
 * Driver route planning sequences a Driver's Areas (not addresses) with the
 * free stored-pin Area engine: no external call, no per-run cost. It is off
 * for every Company until switched on here, and the Platform-wide kill
 * switch below stops it for all Companies at once. The Company pins its
 * Areas and its branch in its own Configuration › Route planning screen.
 */
export function CompanyRouteOptimizationPanel({ companyId }: { companyId: string }): ReactElement {
  const session = usePlatformSession();
  const canManage = session.can(MANAGE);
  const [overview, setOverview] = useState<CompanyRouteOptimization>();
  const [killSwitch, setKillSwitch] = useState<RouteKillSwitch>();
  const [budget, setBudget] = useState("200");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [killNote, setKillNote] = useState("");

  const apply = useCallback((next: CompanyRouteOptimization) => {
    setOverview(next);
    setBudget(String(next.dailyCallBudget));
  }, []);

  const load = useCallback(async () => {
    try {
      const [company, flag] = await Promise.all([
        platformApi.companyRouteOptimization(companyId),
        platformApi.routeKillSwitch(),
      ]);
      apply(company);
      setKillSwitch(flag);
      setError(undefined);
    } catch (failure) {
      setError(
        failure instanceof PlatformApiError
          ? failure.message
          : "Route planning could not be loaded.",
      );
    }
  }, [apply, companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(isEnabled: boolean): Promise<void> {
    if (overview === undefined) return;
    const dailyCallBudget = Number(budget);
    if (!Number.isInteger(dailyCallBudget) || dailyCallBudget < 1 || dailyCallBudget > 100_000) {
      setError("The daily budget must be a whole number from 1 to 100000.");
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      apply(
        await platformApi.updateCompanyRouteOptimization(companyId, {
          dailyCallBudget,
          expectedVersion: overview.version,
          isEnabled,
        }),
      );
      setNotice(
        isEnabled
          ? "Route planning is on for this Company."
          : "Route planning is off for this Company.",
      );
    } catch (failure) {
      if (
        failure instanceof PlatformApiError &&
        failure.code === "route_optimization_settings_stale"
      ) {
        setError(
          "Someone else changed these settings. They have been reloaded; please check and save again.",
        );
        await load();
      } else {
        setError(
          failure instanceof PlatformApiError
            ? failure.message
            : "Route planning could not be saved.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleKillSwitch(isEnabled: boolean): Promise<void> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const note = killNote.trim();
      setKillSwitch(
        await platformApi.configureRouteKillSwitch({ isEnabled, ...(note ? { note } : {}) }),
      );
      setKillNote("");
    } catch (failure) {
      setError(
        failure instanceof PlatformApiError
          ? failure.message
          : "The kill switch could not be changed.",
      );
    } finally {
      setBusy(false);
    }
  }

  const platformOn = killSwitch?.isEnabled ?? overview?.platformEnabled ?? false;
  const effective = overview !== undefined && overview.isEnabled && platformOn;
  const pinsComplete =
    overview !== undefined &&
    overview.areaCount > 0 &&
    overview.verifiedAreaCount === overview.areaCount;

  return (
    <section aria-labelledby="company-route-heading" className="platform-panel">
      <div className="platform-panel__header">
        <div>
          <h3 id="company-route-heading">Route planning</h3>
          <p className="platform-muted">
            Sequences each Driver&apos;s Areas, not addresses — it is not turn-by-turn navigation.
            Uses the free stored-pin Area engine: no external calls and no per-run cost.
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

      {overview === undefined ? (
        <p className="platform-muted">Loading…</p>
      ) : (
        <>
          <dl className="platform-review">
            <div>
              <dt>Status for this Company</dt>
              <dd>
                {effective
                  ? "On"
                  : overview.isEnabled
                    ? "On, but stopped by the Platform kill switch"
                    : "Off"}
              </dd>
            </div>
            <div>
              <dt>Area pins confirmed</dt>
              <dd>
                {overview.verifiedAreaCount} of {overview.areaCount}
                {pinsComplete ? "" : " — Areas without a pin are listed unsequenced"}
              </dd>
            </div>
            <div>
              <dt>Branch location</dt>
              <dd>
                {overview.branchSet ? "Set" : "Not set — runs will not start or end at the branch"}
              </dd>
            </div>
            <div>
              <dt>Last changed</dt>
              <dd>
                {overview.updatedAt === null
                  ? "Never"
                  : new Date(overview.updatedAt).toLocaleString()}
              </dd>
            </div>
          </dl>

          {canManage ? (
            <div className="platform-form">
              <label className="platform-field">
                <span>Daily budget for paid engine calls</span>
                <input
                  inputMode="numeric"
                  max={100000}
                  min={1}
                  onChange={(event) => setBudget(event.target.value)}
                  type="number"
                  value={budget}
                />
                <small className="platform-muted">
                  Not used by the free Area engine. Kept for a possible paid engine later.
                </small>
              </label>
              <div className="platform-actions">
                {overview.isEnabled ? (
                  <button
                    className="platform-button platform-button--quiet"
                    disabled={busy}
                    onClick={() => void save(false)}
                    type="button"
                  >
                    Turn off for this Company
                  </button>
                ) : null}
                <button
                  className="platform-button"
                  disabled={busy}
                  onClick={() => void save(true)}
                  type="button"
                >
                  {overview.isEnabled ? "Save" : "Turn on for this Company"}
                </button>
              </div>
            </div>
          ) : (
            <p className="platform-muted">You can view these settings but not change them.</p>
          )}

          <h4>Runs, last 14 days</h4>
          {overview.runsByDay.length === 0 ? (
            <p className="platform-muted">No runs planned yet.</p>
          ) : (
            <table className="platform-table">
              <thead>
                <tr>
                  <th scope="col">Business date</th>
                  <th scope="col">Runs</th>
                  <th scope="col">Fallback ordering</th>
                </tr>
              </thead>
              <tbody>
                {overview.runsByDay.map((day) => (
                  <tr key={day.businessDate}>
                    <td>{day.businessDate}</td>
                    <td>{day.runs}</td>
                    <td>{day.fallbackRuns}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {killSwitch === undefined ? null : (
        <div className="platform-panel" aria-labelledby="route-kill-switch-heading">
          <h4 id="route-kill-switch-heading">Platform-wide kill switch</h4>
          <p className="platform-muted">
            {killSwitch.isEnabled
              ? "Route planning may run for Companies that are switched on."
              : "Off: no Company gets an optimized route; Drivers see the fallback ordering only."}
            {killSwitch.note ? ` Note: ${killSwitch.note}` : ""}
          </p>
          {canManage ? (
            <div className="platform-form">
              <label className="platform-field">
                <span>Note (optional)</span>
                <input
                  maxLength={500}
                  onChange={(event) => setKillNote(event.target.value)}
                  value={killNote}
                />
              </label>
              <div className="platform-actions">
                <button
                  className={
                    killSwitch.isEnabled
                      ? "platform-button platform-button--quiet"
                      : "platform-button"
                  }
                  disabled={busy}
                  onClick={() => void toggleKillSwitch(!killSwitch.isEnabled)}
                  type="button"
                >
                  {killSwitch.isEnabled
                    ? "Stop route planning for all Companies"
                    : "Allow route planning"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
