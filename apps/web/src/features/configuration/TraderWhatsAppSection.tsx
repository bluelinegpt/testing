import { MessageCircle, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import { useSessionAccess } from "../../app/SessionAccessContext.js";
import { formatDateTime } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import {
  shortGroupId,
  type WhatsAppConnectionView,
  type WhatsAppGroupView,
} from "./WhatsAppConfigurationWorkspace.js";

interface TraderWhatsAppSettingsView {
  readonly traderId: string;
  readonly configured: boolean;
  readonly notificationsEnabled: boolean;
  readonly destinationType: string;
  readonly providerGroupId: string | null;
  readonly groupNameSnapshot: string | null;
  readonly messageLanguage: "both" | "ar" | "en";
  readonly configuredAt: string | null;
}

interface WhatsAppNotificationRow {
  readonly id: string;
  readonly messageType: string;
  readonly orderNumber: string | null;
  readonly orderStatus: string | null;
  readonly groupNameSnapshot: string | null;
  readonly messageLanguage: string;
  readonly status: string;
  readonly failureCode: string | null;
  readonly createdAt: string;
}

const languageOptions = ["both", "ar", "en"] as const;

/**
 * The "WhatsApp Notifications" tab on the Trader profile: one group mapping,
 * a message language, an explicit test message, and read-only history.
 * Mounted like `BusinessAccessPanel` — it fetches its own data by the
 * Trader's UUID and never widens the Trader detail payload.
 */
export function TraderWhatsAppSection({
  api,
  traderId,
  traderName,
}: {
  api: ApiClient;
  traderId: string;
  traderName: string;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const permissions = useSessionAccess()?.permissions ?? [];
  const canManage =
    permissions.includes("whatsapp.trader_settings.manage") ||
    permissions.includes("users_roles.manage");
  const canViewHistory =
    permissions.includes("whatsapp.history.view") || permissions.includes("users_roles.manage");

  const [settings, setSettings] = useState<TraderWhatsAppSettingsView>();
  const [connection, setConnection] = useState<WhatsAppConnectionView>();
  const [groups, setGroups] = useState<readonly WhatsAppGroupView[]>();
  const [history, setHistory] = useState<readonly WhatsAppNotificationRow[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  // Draft edits, applied on Save only.
  const [enabledDraft, setEnabledDraft] = useState(false);
  const [languageDraft, setLanguageDraft] = useState<"both" | "ar" | "en">("both");
  const [groupDraft, setGroupDraft] = useState<{ id: string; name: string } | null>(null);
  const [validation, setValidation] = useState<string>();
  const [dialog, setDialog] = useState<"picker" | "replace" | "remove">();
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerChoice, setPickerChoice] = useState<{ id: string; name: string }>();
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const view = await api.get<TraderWhatsAppSettingsView>(
        `whatsapp/traders/${encodeURIComponent(traderId)}/settings`,
      );
      setSettings(view);
      setEnabledDraft(view.notificationsEnabled);
      setLanguageDraft(view.messageLanguage);
      setGroupDraft(
        view.providerGroupId === null
          ? null
          : { id: view.providerGroupId, name: view.groupNameSnapshot ?? view.providerGroupId },
      );
    } catch {
      setError(t("common.loadFailed"));
    }
  }, [api, t, traderId]);

  const loadConnection = useCallback(async () => {
    try {
      setConnection(await api.get<WhatsAppConnectionView>("whatsapp/connection"));
    } catch {
      // Connection state is contextual here; the section still renders.
    }
  }, [api]);

  const loadGroups = useCallback(async () => {
    try {
      setGroups(await api.get<readonly WhatsAppGroupView[]>("whatsapp/groups"));
    } catch {
      setGroups(undefined);
    }
  }, [api]);

  const loadHistory = useCallback(async () => {
    if (!canViewHistory) return;
    try {
      setHistory(
        await api.get<readonly WhatsAppNotificationRow[]>(
          `whatsapp/traders/${encodeURIComponent(traderId)}/notifications`,
        ),
      );
    } catch {
      setHistory(undefined);
    }
  }, [api, canViewHistory, traderId]);

  useEffect(() => {
    void loadSettings();
    void loadConnection();
    void loadHistory();
  }, [loadConnection, loadHistory, loadSettings]);

  const connected = connection?.status === "connected";
  useEffect(() => {
    if (connected && groups === undefined) void loadGroups();
  }, [connected, groups, loadGroups]);

  const persistedGroupId = settings?.providerGroupId ?? null;
  const mappedGroupMissing =
    connected &&
    groups !== undefined &&
    persistedGroupId !== null &&
    !groups.some((group) => group.id === persistedGroupId);

  const saveSettings = useCallback(
    async (draft: {
      readonly enabled: boolean;
      readonly group: { id: string; name: string } | null;
      readonly language: "both" | "ar" | "en";
    }) => {
      setSaving(true);
      setNotice(undefined);
      try {
        // Group fields are omitted (not blanked) when no group is chosen —
        // the backend keeps the stored mapping, and clearing goes through the
        // explicit Remove Group action instead.
        await api.put(`whatsapp/traders/${encodeURIComponent(traderId)}/settings`, {
          messageLanguage: draft.language,
          notificationsEnabled: draft.enabled,
          ...(draft.group === null
            ? {}
            : { groupNameSnapshot: draft.group.name, providerGroupId: draft.group.id }),
        });
        setNotice(t("whatsapp.saved"));
        setValidation(undefined);
        await loadSettings();
      } catch (issue) {
        setError(
          issue instanceof ApiError && issue.code === "whatsapp_group_required"
            ? t("whatsapp.groupRequired")
            : t("common.operationFailed"),
        );
      } finally {
        setSaving(false);
      }
    },
    [api, loadSettings, t, traderId],
  );

  const onSave = useCallback(() => {
    setError(undefined);
    if (enabledDraft && groupDraft === null) {
      setValidation(t("whatsapp.groupRequired"));
      return;
    }
    // Replacing an existing mapping is an intentional decision — confirm it.
    if (persistedGroupId !== null && groupDraft !== null && groupDraft.id !== persistedGroupId) {
      setDialog("replace");
      return;
    }
    void saveSettings({ enabled: enabledDraft, group: groupDraft, language: languageDraft });
  }, [enabledDraft, groupDraft, languageDraft, persistedGroupId, saveSettings, t]);

  const removeGroup = useCallback(async () => {
    setDialog(undefined);
    setNotice(undefined);
    try {
      await api.delete(`whatsapp/traders/${encodeURIComponent(traderId)}/settings/group`);
      setNotice(t("whatsapp.saved"));
      await loadSettings();
      await loadHistory();
    } catch {
      setError(t("common.operationFailed"));
    }
  }, [api, loadHistory, loadSettings, t, traderId]);

  const sendTestMessage = useCallback(async () => {
    if (sendingTest) return;
    setSendingTest(true);
    setNotice(undefined);
    setError(undefined);
    // One id per deliberate click: a double-submit of this click collapses
    // onto one message server-side; the next click gets a fresh id.
    const clientRequestId = crypto.randomUUID();
    try {
      await api.post(`whatsapp/traders/${encodeURIComponent(traderId)}/test-message`, {
        clientRequestId,
      });
      setNotice(t("whatsapp.testSent"));
    } catch {
      setError(t("whatsapp.testFailed"));
    } finally {
      setSendingTest(false);
      void loadHistory();
    }
  }, [api, loadHistory, sendingTest, t, traderId]);

  const pickerGroups = useMemo(() => {
    const query = pickerSearch.trim().toLowerCase();
    const all = groups ?? [];
    return query.length === 0
      ? all
      : all.filter((group) => group.name.toLowerCase().includes(query));
  }, [groups, pickerSearch]);
  const pickerNameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const group of groups ?? []) counts.set(group.name, (counts.get(group.name) ?? 0) + 1);
    return counts;
  }, [groups]);

  const canSendTest = canManage && connected && persistedGroupId !== null && !sendingTest;

  if (settings === undefined) {
    return (
      <p className={error ? "alert alert-error" : "empty-state"}>{error ?? t("common.loading")}</p>
    );
  }

  return (
    <section className="detail-panel">
      <h2>
        <MessageCircle size={18} aria-hidden="true" /> {t("whatsapp.notifications")}
      </h2>
      {error ? <p className="alert alert-error">{error}</p> : null}
      {notice ? <p className="alert alert-info">{notice}</p> : null}
      {!connected ? <p className="alert alert-warning">{t("whatsapp.notConnectedAlert")}</p> : null}
      {mappedGroupMissing ? (
        <p className="alert alert-warning">{t("whatsapp.mappedGroupMissing")}</p>
      ) : null}

      <div className="field">
        <label>
          <input
            checked={enabledDraft}
            disabled={!canManage}
            onChange={(event) => {
              setEnabledDraft(event.target.checked);
              setValidation(undefined);
            }}
            type="checkbox"
          />{" "}
          {t("whatsapp.notificationsEnabled")}
        </label>
      </div>

      <div className="detail-line">
        <span>{t("whatsapp.destination")}</span>
        <span>{t("whatsapp.destinationGroup")}</span>
      </div>

      <div className="detail-line">
        <span>{t("whatsapp.selectedGroup")}</span>
        <span>
          {groupDraft === null ? (
            t("whatsapp.noGroupSelected")
          ) : (
            <>
              {groupDraft.name}{" "}
              <span className="mono" dir="ltr">
                {shortGroupId(groupDraft.id)}
              </span>
            </>
          )}
        </span>
      </div>
      {canManage ? (
        <div className="row-actions">
          <button
            className="button button-secondary"
            disabled={!connected}
            onClick={() => {
              setPickerChoice(undefined);
              setPickerSearch("");
              void loadGroups();
              setDialog("picker");
            }}
            type="button"
          >
            {t("whatsapp.selectGroup")}
          </button>
          {persistedGroupId !== null ? (
            <button
              className="button button-secondary"
              onClick={() => setDialog("remove")}
              type="button"
            >
              <Trash2 size={17} aria-hidden="true" />
              {t("whatsapp.removeGroup")}
            </button>
          ) : null}
        </div>
      ) : null}
      {validation ? <p className="field-error">{validation}</p> : null}

      <div className="field">
        <label htmlFor="whatsapp-language">{t("whatsapp.messageLanguage")}</label>
        <select
          disabled={!canManage}
          id="whatsapp-language"
          onChange={(event) => setLanguageDraft(event.target.value as "both" | "ar" | "en")}
          value={languageDraft}
        >
          {languageOptions.map((option) => (
            <option key={option} value={option}>
              {t(`whatsapp.language.${option}`)}
            </option>
          ))}
        </select>
      </div>

      {canManage ? (
        <div className="row-actions">
          <button
            className="button button-primary"
            disabled={saving}
            onClick={onSave}
            type="button"
          >
            {t("common.save")}
          </button>
          <button
            className="button button-secondary"
            disabled={!canSendTest}
            onClick={() => void sendTestMessage()}
            type="button"
          >
            <Send size={17} aria-hidden="true" />
            {t("whatsapp.sendTest")}
          </button>
        </div>
      ) : null}

      {canViewHistory ? (
        <>
          <h3>{t("whatsapp.history")}</h3>
          {history === undefined || history.length === 0 ? (
            <p className="empty-state">{t("whatsapp.historyEmpty")}</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t("common.date")}</th>
                    <th scope="col">{t("whatsapp.historyType")}</th>
                    <th scope="col">{t("whatsapp.historyGroup")}</th>
                    <th scope="col">{t("whatsapp.messageLanguage")}</th>
                    <th scope="col">{t("common.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDateTime(row.createdAt, locale)}</td>
                      <td>
                        {row.messageType === "test"
                          ? t("whatsapp.typeTest")
                          : `${t("whatsapp.typeOrderStatus")}${row.orderNumber ? ` · ${row.orderNumber}` : ""}${row.orderStatus ? ` · ${row.orderStatus}` : ""}`}
                      </td>
                      <td>{row.groupNameSnapshot ?? "—"}</td>
                      <td>{t(`whatsapp.language.${row.messageLanguage}`)}</td>
                      <td>
                        <span className={`status-badge status-${row.status.replaceAll("_", "-")}`}>
                          {t(`whatsapp.messageStatus.${row.status}`)}
                        </span>
                        {row.status === "failed" && row.failureCode ? (
                          <span className="form-hint"> {t("whatsapp.testFailed")}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      {dialog === "picker" ? (
        <Modal
          closeLabel={t("common.close")}
          onRequestClose={() => setDialog(undefined)}
          title={t("whatsapp.selectGroup")}
          titleId="whatsapp-group-picker-title"
        >
          <label className="field">
            <span>{t("common.search")}</span>
            <input
              onChange={(event) => setPickerSearch(event.target.value)}
              placeholder={t("whatsapp.searchGroups")}
              type="search"
              value={pickerSearch}
            />
          </label>
          {groups === undefined ? <p className="form-hint">{t("common.loading")}</p> : null}
          {groups !== undefined && pickerGroups.length === 0 ? (
            <p className="empty-state">{t("whatsapp.groupsEmpty")}</p>
          ) : null}
          <div className="field" role="radiogroup" aria-label={t("whatsapp.selectGroup")}>
            {pickerGroups.map((group) => (
              <label key={group.id}>
                <input
                  checked={pickerChoice?.id === group.id}
                  name="whatsapp-group-choice"
                  onChange={() => setPickerChoice({ id: group.id, name: group.name })}
                  type="radio"
                />{" "}
                {group.name}
                {(pickerNameCounts.get(group.name) ?? 0) > 1 ? (
                  <span className="mono" dir="ltr">
                    {" "}
                    {shortGroupId(group.id)}
                  </span>
                ) : null}
                {group.participantCount !== undefined ? (
                  <span className="form-hint">
                    {" "}
                    {t("whatsapp.membersCount", { count: group.participantCount })}
                  </span>
                ) : null}
              </label>
            ))}
          </div>
          <div className="modal-actions">
            <button
              className="button button-secondary"
              onClick={() => setDialog(undefined)}
              type="button"
            >
              {t("common.cancel")}
            </button>
            <button
              className="button button-primary"
              disabled={pickerChoice === undefined}
              onClick={() => {
                if (pickerChoice !== undefined) {
                  setGroupDraft(pickerChoice);
                  setValidation(undefined);
                }
                setDialog(undefined);
              }}
              type="button"
            >
              {t("common.select")}
            </button>
          </div>
        </Modal>
      ) : null}

      {dialog === "replace" ? (
        <Modal
          closeLabel={t("common.close")}
          onRequestClose={() => setDialog(undefined)}
          title={t("whatsapp.replaceTitle")}
          titleId="whatsapp-replace-title"
        >
          <dl>
            <div className="detail-line">
              <dt>{t("whatsapp.replaceCurrent")}</dt>
              <dd>{settings.groupNameSnapshot ?? settings.providerGroupId}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("whatsapp.replaceNew")}</dt>
              <dd>{groupDraft?.name}</dd>
            </div>
          </dl>
          <p>{t("whatsapp.replaceBody")}</p>
          <div className="modal-actions">
            <button
              className="button button-secondary"
              onClick={() => setDialog(undefined)}
              type="button"
            >
              {t("common.cancel")}
            </button>
            <button
              className="button button-primary"
              disabled={saving}
              onClick={() => {
                setDialog(undefined);
                void saveSettings({
                  enabled: enabledDraft,
                  group: groupDraft,
                  language: languageDraft,
                });
              }}
              type="button"
            >
              {t("whatsapp.changeGroup")}
            </button>
          </div>
        </Modal>
      ) : null}

      {dialog === "remove" ? (
        <Modal
          closeLabel={t("common.close")}
          onRequestClose={() => setDialog(undefined)}
          title={t("whatsapp.removeTitle", { name: traderName })}
          titleId="whatsapp-remove-title"
        >
          <p>{t("whatsapp.removeBody")}</p>
          <div className="modal-actions">
            <button
              className="button button-secondary"
              onClick={() => setDialog(undefined)}
              type="button"
            >
              {t("common.cancel")}
            </button>
            <button
              className="button button-primary"
              onClick={() => void removeGroup()}
              type="button"
            >
              {t("whatsapp.removeGroup")}
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
