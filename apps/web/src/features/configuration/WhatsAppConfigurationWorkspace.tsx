import { MessageCircle, Plug, RefreshCw, Unplug } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import { PageHeader } from "../../components/PageHeader.js";
import { formatDateTime } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import { WhatsAppMessageOperations } from "./WhatsAppMessageOperations.js";

/** Mirrors the API's `CompanyWhatsAppConnectionView` — timestamps arrive as
 *  ISO strings over JSON. The `qr` payload is transient pairing data: it
 *  lives only in component state, never in any browser storage. */
export interface WhatsAppConnectionView {
  readonly status: string;
  /** True when Platform Administration has switched WhatsApp off for this
   *  company — a banner explains it and lifecycle actions are hidden. */
  readonly platformDisabled?: boolean;
  readonly providerType: string;
  readonly connectedPhoneNumber: string | null;
  readonly connectedAt: string | null;
  readonly lastConnectedAt: string | null;
  readonly lastDisconnectedAt: string | null;
  readonly disconnectReason: string | null;
  readonly lastHealthCheckAt: string | null;
  readonly requiresQrScan: boolean;
  readonly qrAvailable: boolean;
  readonly qr: string | null;
}

export interface WhatsAppGroupView {
  readonly id: string;
  readonly name: string;
  readonly participantCount?: number;
}

interface WhatsAppMessageSummaryView {
  readonly pending: number;
  readonly processing: number;
  readonly failed: number;
  readonly requiresReview: number;
  readonly sentToday: number;
  readonly sentLast24h: number;
  readonly oldestPendingAt: string | null;
  readonly lastSuccessfulSendAt: string | null;
}

interface DispatcherHealthView {
  readonly running: boolean;
  readonly lastTickAt: string | null;
  readonly lastSendAt: string | null;
}

interface TraderGroupHealthView {
  readonly connected: boolean;
  readonly checkedAt: string | null;
  readonly configured: number;
  readonly availableCount: number;
  readonly needsAttention: number;
  readonly rows: readonly {
    readonly traderId: string;
    readonly traderName: string;
    readonly groupNameSnapshot: string | null;
    readonly providerGroupId: string;
    readonly available: boolean | null;
  }[];
}

const POLL_INTERVAL_MS = 3000;
const transitionalStatuses = new Set(["connecting", "waiting_for_qr_scan"]);
const reconnectStatuses = new Set(["disconnected", "authentication_failed", "requires_reconnect"]);

/** Duplicate group names stay distinguishable through a short, safe slice of
 *  the provider id — never the full JID, never participant data. */
export function shortGroupId(id: string): string {
  const bare = id.split("@")[0] ?? id;
  return `…${bare.slice(-6)}`;
}

export function WhatsAppConfigurationWorkspace({
  api,
  permissions,
}: {
  api: ApiClient;
  permissions: readonly string[];
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const canManage =
    permissions.includes("whatsapp.connection.manage") ||
    permissions.includes("users_roles.manage");
  const canManageMessages =
    permissions.includes("whatsapp.messages.manage") || permissions.includes("users_roles.manage");
  const [connection, setConnection] = useState<WhatsAppConnectionView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string>();
  const [groups, setGroups] = useState<readonly WhatsAppGroupView[]>();
  const [groupsRefreshedAt, setGroupsRefreshedAt] = useState<Date>();
  const [groupSearch, setGroupSearch] = useState("");

  const [summary, setSummary] = useState<WhatsAppMessageSummaryView>();

  const loadConnection = useCallback(async () => {
    try {
      setConnection(await api.get<WhatsAppConnectionView>("whatsapp/connection"));
      setError(undefined);
    } catch {
      setError(t("common.loadFailed"));
    }
  }, [api, t]);
  useEffect(() => void loadConnection(), [loadConnection]);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api.get<WhatsAppMessageSummaryView>("whatsapp/messages/summary"));
    } catch {
      // Counts are advisory; the page stays useful without them.
    }
  }, [api]);
  useEffect(() => void loadSummary(), [loadSummary]);

  const [dispatcherHealth, setDispatcherHealth] = useState<DispatcherHealthView>();
  useEffect(() => {
    if (!canManage) return;
    let active = true;
    api
      .get<DispatcherHealthView>("whatsapp/dispatcher/health")
      .then((health) => {
        if (active) setDispatcherHealth(health);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, canManage]);

  const [groupHealth, setGroupHealth] = useState<TraderGroupHealthView>();
  const loadGroupHealth = useCallback(async () => {
    try {
      setGroupHealth(await api.get<TraderGroupHealthView>("whatsapp/trader-groups/health"));
    } catch {
      // Advisory panel only.
    }
  }, [api]);

  // Pairing is asynchronous on the backend: poll the one status endpoint
  // while a connection attempt is in flight, and stop on any settled state.
  const status = connection?.status ?? "not_connected";
  // Platform Administration's kill switch: every lifecycle action is hidden
  // (the API refuses them anyway) and the banner above explains why.
  const platformDisabled = connection?.platformDisabled === true;
  useEffect(() => {
    if (!transitionalStatuses.has(status)) return;
    const timer = globalThis.setInterval(() => void loadConnection(), POLL_INTERVAL_MS);
    return () => globalThis.clearInterval(timer);
  }, [loadConnection, status]);

  useEffect(() => {
    if (status === "connected") void loadGroupHealth();
  }, [loadGroupHealth, status]);

  // Render whatever QR the latest poll returned; a rotated QR simply
  // replaces the image. jsdom/canvas failures degrade to instructions only.
  const qr = connection?.qr ?? undefined;
  useEffect(() => {
    if (qr === undefined) {
      setQrDataUrl(undefined);
      return;
    }
    let active = true;
    QRCode.toDataURL(qr, { margin: 2, width: 320 })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [qr]);

  const loadGroups = useCallback(async () => {
    try {
      setGroups(await api.get<readonly WhatsAppGroupView[]>("whatsapp/groups"));
      setGroupsRefreshedAt(new Date());
      setError(undefined);
    } catch (issue) {
      if (issue instanceof ApiError && issue.code === "whatsapp_not_connected") {
        setGroups(undefined);
      } else {
        setError(t("common.loadFailed"));
      }
    }
  }, [api, t]);
  useEffect(() => {
    if (status === "connected" && groups === undefined) void loadGroups();
  }, [groups, loadGroups, status]);

  const mutate = useCallback(
    async (path: string) => {
      setBusy(true);
      try {
        setConnection(await api.post<WhatsAppConnectionView>(path));
        setError(undefined);
      } catch (issue) {
        setError(
          issue instanceof ApiError && issue.code === "whatsapp_provider_unavailable"
            ? t("whatsapp.providerUnavailable")
            : t("common.operationFailed"),
        );
      } finally {
        setBusy(false);
      }
    },
    [api, t],
  );

  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const group of groups ?? []) counts.set(group.name, (counts.get(group.name) ?? 0) + 1);
    return counts;
  }, [groups]);
  const visibleGroups = useMemo(() => {
    const query = groupSearch.trim().toLowerCase();
    const all = groups ?? [];
    return query.length === 0
      ? all
      : all.filter((group) => group.name.toLowerCase().includes(query));
  }, [groups, groupSearch]);

  const statusBadge = (
    <span className={`status-badge status-${status.replaceAll("_", "-")}`}>
      {t(`whatsapp.status.${status}`)}
    </span>
  );

  return (
    <>
      <PageHeader
        eyebrow={t("nav.configuration")}
        title={t("whatsapp.title")}
        description={t("whatsapp.pageDescription")}
        actions={
          canManage ? (
            <button
              className="button button-secondary"
              disabled={busy}
              onClick={() => void loadConnection()}
              type="button"
            >
              <RefreshCw size={17} aria-hidden="true" />
              {t("whatsapp.refreshStatus")}
            </button>
          ) : undefined
        }
      />
      {error ? <p className="alert alert-error">{error}</p> : null}
      {connection?.platformDisabled === true ? (
        <p className="alert alert-warning">{t("whatsapp.platformDisabledAlert")}</p>
      ) : null}

      <section className="detail-panel">
        <h2>
          <MessageCircle size={18} aria-hidden="true" /> {t("whatsapp.connectionHeading")}
        </h2>
        <dl>
          <div className="detail-line">
            <dt>{t("common.status")}</dt>
            <dd>{statusBadge}</dd>
          </div>
          {connection?.connectedPhoneNumber ? (
            <div className="detail-line">
              <dt>{t("whatsapp.connectedNumber")}</dt>
              <dd dir="ltr">{connection.connectedPhoneNumber}</dd>
            </div>
          ) : null}
          {connection?.connectedAt ? (
            <div className="detail-line">
              <dt>{t("whatsapp.connectedSince")}</dt>
              <dd>{formatDateTime(connection.connectedAt, locale)}</dd>
            </div>
          ) : null}
          {connection?.lastHealthCheckAt ? (
            <div className="detail-line">
              <dt>{t("whatsapp.lastActivity")}</dt>
              <dd>{formatDateTime(connection.lastHealthCheckAt, locale)}</dd>
            </div>
          ) : null}
        </dl>

        {status === "not_connected" && canManage && !platformDisabled ? (
          <>
            <p>{t("whatsapp.connectExplainer1")}</p>
            <p>{t("whatsapp.connectExplainer2")}</p>
            <p>{t("whatsapp.connectExplainer3")}</p>
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => void mutate("whatsapp/connection/connect")}
              type="button"
            >
              <Plug size={17} aria-hidden="true" />
              {t("whatsapp.connect")}
            </button>
          </>
        ) : null}

        {status === "connecting" ? <p className="form-hint">{t("whatsapp.qrPreparing")}</p> : null}

        {status === "waiting_for_qr_scan" ? (
          <div className="mobile-qr-panel">
            <h3>{t("whatsapp.scanTitle")}</h3>
            <p>{t("whatsapp.scanSteps")}</p>
            {qrDataUrl ? (
              <img alt={t("whatsapp.scanTitle")} className="mobile-qr-image" src={qrDataUrl} />
            ) : (
              <p className="form-hint">{t("whatsapp.qrPreparing")}</p>
            )}
          </div>
        ) : null}

        {reconnectStatuses.has(status) && canManage && !platformDisabled ? (
          <>
            {status === "disconnected" ? (
              <p className="form-hint">{t("whatsapp.attemptEnded")}</p>
            ) : (
              <p className="alert alert-warning">{t("whatsapp.reconnectRequiredAlert")}</p>
            )}
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => void mutate("whatsapp/connection/reconnect")}
              type="button"
            >
              <Plug size={17} aria-hidden="true" />
              {t("whatsapp.reconnect")}
            </button>
          </>
        ) : null}

        {status === "connected" && canManage ? (
          <div className="row-actions">
            <button
              className="button button-secondary"
              disabled={busy}
              onClick={() => void mutate("whatsapp/connection/reconnect")}
              type="button"
            >
              <RefreshCw size={17} aria-hidden="true" />
              {t("whatsapp.reconnect")}
            </button>
            <button
              className="button button-secondary"
              disabled={busy}
              onClick={() => setConfirmingDisconnect(true)}
              type="button"
            >
              <Unplug size={17} aria-hidden="true" />
              {t("whatsapp.disconnect")}
            </button>
          </div>
        ) : null}
      </section>

      {summary === undefined ? null : (
        <section className="detail-panel">
          <h2>{t("whatsapp.pipelineTitle")}</h2>
          <dl>
            <div className="detail-line">
              <dt>{t("whatsapp.pipelinePending")}</dt>
              <dd>{summary.pending}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("whatsapp.pipelineProcessing")}</dt>
              <dd>{summary.processing}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("whatsapp.pipelineFailed")}</dt>
              <dd>{summary.failed}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("whatsapp.pipelineReview")}</dt>
              <dd>{summary.requiresReview}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("whatsapp.pipelineSentToday")}</dt>
              <dd>{summary.sentToday}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("whatsapp.pipelineSent24h")}</dt>
              <dd>{summary.sentLast24h}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("whatsapp.pipelineOldestPending")}</dt>
              <dd>
                {summary.oldestPendingAt === null
                  ? "—"
                  : formatDateTime(summary.oldestPendingAt, locale)}
              </dd>
            </div>
            <div className="detail-line">
              <dt>{t("whatsapp.pipelineLastSend")}</dt>
              <dd>
                {summary.lastSuccessfulSendAt === null
                  ? "—"
                  : formatDateTime(summary.lastSuccessfulSendAt, locale)}
              </dd>
            </div>
          </dl>
          {dispatcherHealth === undefined ? null : (
            <p className="form-hint">
              {t("whatsapp.dispatcherTitle")}:{" "}
              {dispatcherHealth.running
                ? t("whatsapp.dispatcherRunning")
                : t("whatsapp.dispatcherStopped")}
              {dispatcherHealth.lastTickAt
                ? ` · ${t("whatsapp.dispatcherLastTick", {
                    time: formatDateTime(dispatcherHealth.lastTickAt, locale),
                  })}`
                : ""}
            </p>
          )}
        </section>
      )}

      {status === "connected" && groupHealth !== undefined ? (
        <section className="detail-panel">
          <h2>{t("whatsapp.groupHealthTitle")}</h2>
          <p>
            {t("whatsapp.groupHealthConfigured", { value: groupHealth.configured })}
            {" · "}
            {t("whatsapp.groupHealthAvailable", { value: groupHealth.availableCount })}
            {" · "}
            {t("whatsapp.groupHealthAttention", { value: groupHealth.needsAttention })}
          </p>
          {groupHealth.checkedAt ? (
            <p className="form-hint">
              {t("whatsapp.groupHealthLastChecked", {
                time: formatDateTime(groupHealth.checkedAt, locale),
              })}
            </p>
          ) : null}
          {groupHealth.needsAttention > 0 ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t("operations.trader", { defaultValue: "Trader" })}</th>
                    <th scope="col">{t("whatsapp.historyGroup")}</th>
                    <th scope="col">{t("common.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {groupHealth.rows
                    .filter((row) => row.available === false)
                    .map((row) => (
                      <tr key={row.traderId}>
                        <td>{row.traderName}</td>
                        <td>
                          {row.groupNameSnapshot ?? "—"}{" "}
                          <span className="mono" dir="ltr">
                            {shortGroupId(row.providerGroupId)}
                          </span>
                        </td>
                        <td>
                          <span className="status-badge status-failed">
                            {t("whatsapp.mappedGroupMissing")}
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      <WhatsAppMessageOperations api={api} canManage={canManageMessages} />

      {status === "connected" ? (
        <section className="detail-panel">
          <h2>{t("whatsapp.groupsTitle")}</h2>
          <div className="row-actions">
            <label className="field">
              <span className="sr-only">{t("common.search")}</span>
              <input
                onChange={(event) => setGroupSearch(event.target.value)}
                placeholder={t("whatsapp.searchGroups")}
                type="search"
                value={groupSearch}
              />
            </label>
            <button
              className="button button-secondary"
              onClick={() => void loadGroups()}
              type="button"
            >
              <RefreshCw size={17} aria-hidden="true" />
              {t("whatsapp.refreshGroups")}
            </button>
          </div>
          {groupsRefreshedAt ? (
            <p className="form-hint">
              {t("whatsapp.lastRefreshed", {
                time: formatDateTime(groupsRefreshedAt, locale),
              })}
            </p>
          ) : null}
          {groups !== undefined && visibleGroups.length === 0 ? (
            <p className="empty-state">{t("whatsapp.groupsEmpty")}</p>
          ) : null}
          {visibleGroups.length > 0 ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t("common.name")}</th>
                    <th scope="col">{t("whatsapp.members")}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleGroups.map((group) => (
                    <tr key={group.id}>
                      <td>
                        {group.name}
                        {(nameCounts.get(group.name) ?? 0) > 1 ? (
                          <span className="mono" dir="ltr">
                            {" "}
                            {shortGroupId(group.id)}
                          </span>
                        ) : null}
                      </td>
                      <td>{group.participantCount ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {confirmingDisconnect ? (
        <Modal
          closeLabel={t("common.close")}
          onRequestClose={() => setConfirmingDisconnect(false)}
          title={t("whatsapp.disconnectTitle")}
          titleId="whatsapp-disconnect-title"
        >
          <p>{t("whatsapp.disconnectBody")}</p>
          <div className="modal-actions">
            <button
              className="button button-secondary"
              onClick={() => setConfirmingDisconnect(false)}
              type="button"
            >
              {t("common.cancel")}
            </button>
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => {
                setConfirmingDisconnect(false);
                void mutate("whatsapp/connection/disconnect");
              }}
              type="button"
            >
              {t("whatsapp.disconnect")}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
