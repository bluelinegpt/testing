import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "../../components/PageHeader.js";

// Baked in at build time by vite.config.ts from Documentation/deployment-registry.json
// -- the single catalog every app (web, api, platform-web, store) shares.
// Kept updated by .githooks/post-commit and .githooks/pre-push, not by hand:
// see the hooks' own comments for why a written instruction alone isn't
// trustworthy enough for this.
declare const __DEPLOYMENT_REGISTRY__: {
  readonly apps: readonly DeploymentEntry[];
};

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

export function DeploymentStatusPage() {
  const { t } = useTranslation();
  const [appFilter, setAppFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  const entries = __DEPLOYMENT_REGISTRY__.apps;

  const statusLabel: Record<DeploymentEntry["status"], string> = {
    confirmed_live: t("deploymentStatus.confirmedLive"),
    needs_deploy: t("deploymentStatus.needsDeploy"),
    pushed_awaiting_confirmation: t("deploymentStatus.pushedAwaitingConfirmation"),
  };
  const statusClass: Record<DeploymentEntry["status"], string> = {
    confirmed_live: "deployment-status-badge deployment-status-live",
    needs_deploy: "deployment-status-badge deployment-status-needs-deploy",
    pushed_awaiting_confirmation: "deployment-status-badge deployment-status-pushed",
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries
      .filter((entry) => appFilter === "all" || entry.id === appFilter)
      .filter((entry) => statusFilter === "all" || entry.status === statusFilter)
      .filter(
        (entry) => query === "" || entry.localCommit.toLowerCase().includes(query),
      )
      .toSorted((a, b) => statusRank[a.status] - statusRank[b.status]);
  }, [appFilter, entries, search, statusFilter]);

  return (
    <div className="deployment-status-page">
      <PageHeader eyebrow={t("nav.administration")} title={t("deploymentStatus.title")} />
      <div className="deployment-status-filters">
        <select
          aria-label={t("deploymentStatus.app")}
          onChange={(event) => setAppFilter(event.target.value)}
          value={appFilter}
        >
          <option value="all">{t("deploymentStatus.allApps")}</option>
          {entries.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.displayName}
            </option>
          ))}
        </select>
        <select
          aria-label={t("deploymentStatus.status")}
          onChange={(event) => setStatusFilter(event.target.value)}
          value={statusFilter}
        >
          <option value="all">{t("deploymentStatus.allStatuses")}</option>
          <option value="needs_deploy">{t("deploymentStatus.needsDeploy")}</option>
          <option value="pushed_awaiting_confirmation">
            {t("deploymentStatus.pushedAwaitingConfirmation")}
          </option>
          <option value="confirmed_live">{t("deploymentStatus.confirmedLive")}</option>
        </select>
        <input
          aria-label={t("deploymentStatus.localVersion")}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("deploymentStatus.searchPlaceholder")}
          type="search"
          value={search}
        />
      </div>
      <table className="deployment-status-table">
        <thead>
          <tr>
            <th>{t("deploymentStatus.app")}</th>
            <th>{t("deploymentStatus.localVersion")}</th>
            <th>{t("deploymentStatus.status")}</th>
            <th>{t("deploymentStatus.lastChange")}</th>
            <th>{t("deploymentStatus.changedBy")}</th>
            <th>{t("deploymentStatus.date")}</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((entry) => (
            <tr key={entry.id}>
              <td>
                <div className="deployment-status-app-name">{entry.displayName}</div>
                <div className="deployment-status-app-path">{entry.path}</div>
              </td>
              <td className="deployment-status-mono">{entry.localCommit}</td>
              <td>
                <span className={statusClass[entry.status]}>{statusLabel[entry.status]}</span>
              </td>
              <td>{entry.lastChangeDescription}</td>
              <td>{entry.lastChangeBy}</td>
              <td>{entry.localCommitDate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
