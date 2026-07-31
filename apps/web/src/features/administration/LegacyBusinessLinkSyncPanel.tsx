import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";

interface LegacyCandidate {
  readonly candidateId: string;
  readonly classifications: readonly string[];
  readonly code: string;
  readonly eligible: boolean;
  readonly profileType: "employee" | "driver" | "trader";
}

interface LegacyPreview {
  readonly candidates: readonly LegacyCandidate[];
  readonly classificationCounts: Readonly<Record<string, number>>;
  readonly generatedAt: string;
  readonly maximumBatchSize: number;
  readonly previewIdentity: string;
  readonly versionBasis: string;
}

export function LegacyBusinessLinkSyncPanel({ api }: { readonly api: ApiClient }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<LegacyPreview>();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const load = async () => {
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await api.get<LegacyPreview>("users/business-links/legacy-preview");
      setPreview(result);
      setSelected(result.candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.candidateId));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t("access.legacy.loadFailed"));
    }
  };
  const synchronize = async () => {
    if (!preview || selected.length === 0) return;
    if (!globalThis.confirm(t("access.legacy.confirm"))) return;
    setError(undefined);
    try {
      const result = await api.post<{ created: number; existing: number }>(
        "users/business-links/legacy-sync",
        { candidateIds: selected, previewIdentity: preview.previewIdentity },
        { "X-Idempotency-Key": `legacy-link-sync:${crypto.randomUUID()}` },
      );
      await load();
      setMessage(t("access.legacy.completed", result));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t("access.legacy.syncFailed"));
    }
  };
  return (
    <details className="detail-panel">
      <summary>{t("access.legacy.title")}</summary>
      <p>{t("access.legacy.description")}</p>
      <button className="button button-secondary" onClick={() => void load()} type="button">
        {t("access.legacy.preview")}
      </button>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {message ? <div className="alert alert-success">{message}</div> : null}
      {preview ? (
        <>
          <p>
            {t("access.legacy.generatedAt")}: {preview.generatedAt} · {t("access.legacy.maximum")}:{" "}
            {preview.maximumBatchSize}
          </p>
          <div className="tag-list">
            {Object.entries(preview.classificationCounts).map(([classification, count]) => (
              <span className="tag" key={classification}>
                {t(`access.legacy.classifications.${classification}`)}: {count}
              </span>
            ))}
          </div>
          <div className="table-scroll-x">
            <table>
              <thead>
                <tr>
                  <th>{t("common.select")}</th>
                  <th>{t("access.columns.profile")}</th>
                  <th>{t("workforce.code")}</th>
                  <th>{t("access.legacy.classification")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.candidates.map((candidate) => (
                  <tr key={candidate.candidateId}>
                    <td>
                      <input
                        checked={selected.includes(candidate.candidateId)}
                        disabled={!candidate.eligible}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, candidate.candidateId]
                              : current.filter((id) => id !== candidate.candidateId),
                          )
                        }
                        type="checkbox"
                      />
                    </td>
                    <td>{t(`access.profile.${candidate.profileType}`)}</td>
                    <td><bdi>{candidate.code}</bdi></td>
                    <td>
                      {candidate.classifications
                        .map((classification) => t(`access.legacy.classifications.${classification}`))
                        .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            className="button button-primary"
            disabled={selected.length === 0 || selected.length > preview.maximumBatchSize}
            onClick={() => void synchronize()}
            type="button"
          >
            {t("access.legacy.synchronizeSelected", { count: selected.length })}
          </button>
        </>
      ) : null}
    </details>
  );
}
