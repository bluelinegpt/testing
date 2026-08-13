import { useMemo, useState } from "react";
import type { ReactElement } from "react";

/**
 * Deployment Registry — Platform Administration's copy of the same screen
 * that lives under the Company Portal's Administration section
 * (`apps/web/src/features/administration/DeploymentStatusPage.tsx`). Same
 * data, same schema, same rule: Platform Administration is the primary home
 * (this describes the codebase itself, not any one Company's business), the
 * Company Portal's copy is a convenience so it's reachable without switching
 * apps.
 *
 * Data comes from `Documentation/deployment-registry.json`, baked in at
 * build time via `vite.config.ts`'s `define` as `__DEPLOYMENT_REGISTRY__` --
 * not fetched, because it's repo state, not Company data. Kept current by
 * `.githooks/post-commit` / `.githooks/pre-push` via
 * `scripts/deployment-registry.mjs`, not by hand. `confirmedLiveCommit` /
 * `confirmedLiveAt` are the one exception: only a human confirming Render is
 * actually showing the change sets those
 * (`scripts/deployment-registry.mjs mark-confirmed-live`).
 */

declare const __DEPLOYMENT_REGISTRY__: { readonly apps: readonly DeploymentEntry[] };

interface DeploymentEntry {
  readonly id: string;
  readonly displayName: string;
  readonly path: string;
  readonly renderService: string | null;
  readonly status: "needs_deploy" | "pushed_awaiting_confirmation" | "confirmed_live";
  readonly localCommit: string;
  readonly localCommitDate: string;
  readonly lastChangeDescription: string;
  readonly lastChangeBy: string;
  readonly confirmedLiveCommit: string | null;
  readonly confirmedLiveAt: string | null;
}

const statusRank: Record<DeploymentEntry["status"], number> = {
  needs_deploy: 0,
  pushed_awaiting_confirmation: 1,
  confirmed_live: 2,
};

const statusMeta: Record<DeploymentEntry["status"], { label: string; badgeClass: string }> = {
  confirmed_live: { badgeClass: "platform-badge--registry-live", label: "Confirmed live" },
  needs_deploy: { badgeClass: "platform-badge--registry-pending", label: "Needs deploy" },
  pushed_awaiting_confirmation: {
    badgeClass: "platform-badge--registry-inflight",
    label: "Pushed · awaiting confirmation",
  },
};

function counts(rows: readonly DeploymentEntry[]) {
  return {
    confirmed_live: rows.filter((row) => row.status === "confirmed_live").length,
    needs_deploy: rows.filter((row) => row.status === "needs_deploy").length,
    pushed_awaiting_confirmation: rows.filter(
      (row) => row.status === "pushed_awaiting_confirmation",
    ).length,
    total: rows.length,
  };
}

export function DeploymentRegistryPage(): ReactElement {
  const [appFilter, setAppFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  const entries = __DEPLOYMENT_REGISTRY__.apps;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries
      .filter((entry) => appFilter === "all" || entry.id === appFilter)
      .filter((entry) => statusFilter === "all" || entry.status === statusFilter)
      .filter(
        (entry) =>
          query === "" ||
          `${entry.displayName} ${entry.localCommit} ${entry.lastChangeDescription}`
            .toLowerCase()
            .includes(query),
      )
      .toSorted((a, b) => statusRank[a.status] - statusRank[b.status]);
  }, [appFilter, entries, search, statusFilter]);

  const summary = counts(entries);

  return (
    <section className="platform-panel">
      <div className="platform-panel__header">
        <div>
          <h2>Deployment registry</h2>
          <p className="platform-muted">
            Every app in the monorepo, its last local change, and whether that change has reached
            Render.
          </p>
        </div>
      </div>

      <div className="platform-summary-strip">
        <div className="platform-summary-card platform-summary-card--warn">
          <span className="platform-summary-card__label">Needs deploy</span>
          <span className="platform-summary-card__value">{summary.needs_deploy}</span>
        </div>
        <div className="platform-summary-card platform-summary-card--info">
          <span className="platform-summary-card__label">Pushed · awaiting confirmation</span>
          <span className="platform-summary-card__value">
            {summary.pushed_awaiting_confirmation}
          </span>
        </div>
        <div className="platform-summary-card platform-summary-card--ok">
          <span className="platform-summary-card__label">Confirmed live</span>
          <span className="platform-summary-card__value">{summary.confirmed_live}</span>
        </div>
        <div className="platform-summary-card">
          <span className="platform-summary-card__label">Apps tracked</span>
          <span className="platform-summary-card__value">{summary.total}</span>
        </div>
      </div>

      <div className="platform-filters">
        <label className="platform-field" htmlFor="registry-app">
          <span>Application</span>
          <select
            id="registry-app"
            onChange={(event) => setAppFilter(event.target.value)}
            value={appFilter}
          >
            <option value="all">All applications</option>
            {entries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="platform-field" htmlFor="registry-status">
          <span>Status</span>
          <select
            id="registry-status"
            onChange={(event) => setStatusFilter(event.target.value)}
            value={statusFilter}
          >
            <option value="all">All statuses</option>
            <option value="needs_deploy">Needs deploy</option>
            <option value="pushed_awaiting_confirmation">Pushed · awaiting confirmation</option>
            <option value="confirmed_live">Confirmed live</option>
          </select>
        </label>
        <label className="platform-field" htmlFor="registry-search">
          <span>Search</span>
          <input
            id="registry-search"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Application, commit, or description"
            type="search"
            value={search}
          />
        </label>
      </div>

      <p className="platform-muted">
        {filtered.length} of {entries.length} apps
      </p>

      {filtered.length === 0 ? (
        <p className="platform-muted">No apps match these filters.</p>
      ) : (
        <table className="platform-table">
          <thead>
            <tr>
              <th scope="col">Application</th>
              <th scope="col">Local version</th>
              <th scope="col">Status</th>
              <th scope="col">Last change</th>
              <th scope="col">Changed by</th>
              <th scope="col">Date</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((entry) => {
              const meta = statusMeta[entry.status];
              return (
                <tr key={entry.id}>
                  <td>
                    <strong>{entry.displayName}</strong>
                    <div className="platform-muted">{entry.path}</div>
                  </td>
                  <td>
                    <code>{entry.localCommit}</code>
                  </td>
                  <td>
                    <span className={`platform-badge ${meta.badgeClass}`}>{meta.label}</span>
                    {entry.status === "confirmed_live" && entry.confirmedLiveAt !== null ? (
                      <div className="platform-muted">as of {entry.confirmedLiveAt}</div>
                    ) : null}
                  </td>
                  <td>{entry.lastChangeDescription}</td>
                  <td>{entry.lastChangeBy}</td>
                  <td>{entry.localCommitDate}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="platform-muted platform-registry-footnote">
        &ldquo;Confirmed live&rdquo; is set by hand, not detected automatically — there is no
        Render API access yet, so someone has to check the deployed app and say so. Everything
        else on a row (version, push status, who changed it) comes from git via
        `.githooks/post-commit` and `.githooks/pre-push`.
      </p>
    </section>
  );
}
