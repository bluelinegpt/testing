import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import type { SupportCase } from "../../api/contracts.js";
import { PageHeader } from "../../components/PageHeader.js";
import { formatDate } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";

const supportStatuses = ["open", "in_progress", "resolved", "closed"] as const;

export function SupportWorkspace({ api }: { api: ApiClient }) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const [cases, setCases] = useState<readonly SupportCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setCases(await api.get<readonly SupportCase[]>("support/cases"));
    } catch {
      setError(t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => void load(), [load]);

  const createCase = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    try {
      await api.post<SupportCase>("support/cases", {
        description: String(form.get("description") ?? ""),
        priority: String(form.get("priority") ?? "normal"),
        title: String(form.get("title") ?? ""),
      });
      event.currentTarget.reset();
      await load();
    } catch {
      setError(t("support.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (supportCase: SupportCase, status: string) => {
    setError(undefined);
    try {
      await api.patch<SupportCase>(`support/cases/${supportCase.id}`, {
        resolutionNotes: supportCase.resolutionNotes ?? undefined,
        status,
      });
      await load();
    } catch {
      setError(t("support.saveFailed"));
    }
  };

  return (
    <>
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <PageHeader
        actions={
          <button className="button button-secondary" onClick={() => void load()} type="button">
            {t("common.refresh")}
          </button>
        }
        eyebrow={t("workspace.administration")}
        title={t("support.title")}
      />
      <div className="data-surface support-surface">
        <form className="support-form" onSubmit={(event) => void createCase(event)}>
          <label className="field compact-field">
            <span>{t("support.caseTitle")}</span>
            <input maxLength={160} name="title" required />
          </label>
          <label className="field compact-field">
            <span>{t("support.priority")}</span>
            <select defaultValue="normal" name="priority">
              <option value="low">{t("support.low")}</option>
              <option value="normal">{t("support.normal")}</option>
              <option value="high">{t("support.high")}</option>
              <option value="urgent">{t("support.urgent")}</option>
            </select>
          </label>
          <label className="field compact-field support-description">
            <span>{t("support.description")}</span>
            <textarea maxLength={2000} name="description" required rows={3} />
          </label>
          <button className="button button-primary" disabled={saving} type="submit">
            {saving ? t("common.working") : t("support.create")}
          </button>
        </form>
        <table>
          <thead>
            <tr>
              <th>{t("support.case")}</th>
              <th>{t("support.priority")}</th>
              <th>{t("support.status")}</th>
              <th>{t("support.updated")}</th>
              <th>
                <span className="sr-only">{t("common.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {cases.map((supportCase) => (
              <tr key={supportCase.id}>
                <td>
                  <strong>{supportCase.caseNumber}</strong>
                  <span className="cell-secondary">{supportCase.title}</span>
                  <span className="cell-secondary">{supportCase.description}</span>
                </td>
                <td>{t(`support.${supportCase.priority}`)}</td>
                <td>
                  <span className="status status-neutral">
                    {t(`support.${supportCase.status}`)}
                  </span>
                </td>
                <td>
                  {formatDate(supportCase.updatedAt, locale)}
                  <span className="cell-secondary">{supportCase.createdBy}</span>
                </td>
                <td>
                  <div className="row-actions">
                    {supportStatuses
                      .filter((status) => status !== supportCase.status)
                      .map((status) => (
                        <button
                          key={status}
                          onClick={() => void updateStatus(supportCase, status)}
                          type="button"
                        >
                          {t(`support.${status}`)}
                        </button>
                      ))}
                  </div>
                </td>
              </tr>
            ))}
            {!loading && cases.length === 0 ? (
              <tr>
                <td className="empty-state" colSpan={5}>
                  {t("support.empty")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {loading ? <div className="loading-row">{t("common.loading")}</div> : null}
      </div>
    </>
  );
}
