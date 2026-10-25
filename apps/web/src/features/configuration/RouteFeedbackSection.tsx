import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import { formatDate } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";

export type RouteFeedbackReason = "wrong_order" | "wrong_location" | "too_long" | "other";

interface FeedbackArea {
  readonly areaId: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
}

export interface RouteFeedbackReport {
  readonly days: number;
  readonly runCount: number;
  readonly likeCount: number;
  readonly dislikeCount: number;
  readonly reasons: readonly { readonly reason: RouteFeedbackReason; readonly count: number }[];
  readonly flaggedAreas: readonly (FeedbackArea & { readonly count: number })[];
  readonly rows: readonly {
    readonly runId: string;
    readonly referenceNumber: string;
    readonly businessDate: string;
    readonly driverNameEn: string;
    readonly driverNameAr: string | null;
    readonly rating: "like" | "dislike";
    readonly reason: RouteFeedbackReason | null;
    readonly comment: string | null;
    readonly direction: "recommended" | "reversed";
    readonly updatedAt: string;
    readonly flaggedAreas: readonly FeedbackArea[];
    readonly plannedAreas: readonly FeedbackArea[];
    readonly actualAreas: readonly FeedbackArea[];
  }[];
}

/**
 * Driver feedback on routes (Aiman, 25 Oct 2026): likes and dislikes, the
 * reasons, the Areas Drivers say are pinned in the wrong place, and for each
 * route the planned Area order next to the order actually delivered in.
 */
export function RouteFeedbackSection({ api }: { readonly api: ApiClient }) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const [report, setReport] = useState<RouteFeedbackReport>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void api
      .get<RouteFeedbackReport>("configuration/route-planning/feedback")
      .then((data) => active && setReport(data))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [api]);

  const name = (area: FeedbackArea) => (locale === "ar" ? (area.nameAr ?? area.nameEn) : area.nameEn);
  const list = (areas: readonly FeedbackArea[]) =>
    areas.length === 0 ? "—" : areas.map(name).join(" → ");

  if (failed || report === undefined) return null;
  return (
    <section aria-labelledby="route-feedback-heading" className="card route-feedback">
      <h3 id="route-feedback-heading">{t("routePlanning.feedbackTitle")}</h3>
      <p data-testid="route-feedback-summary">
        {t("routePlanning.feedbackSummary", {
          days: report.days,
          runs: report.runCount,
          likes: report.likeCount,
          dislikes: report.dislikeCount,
        })}
      </p>
      {report.rows.length === 0 ? (
        <p className="field-hint">{t("routePlanning.feedbackEmpty")}</p>
      ) : (
        <>
          {report.reasons.length === 0 ? null : (
            <p>
              <strong>{t("routePlanning.feedbackReasons")}:</strong>{" "}
              {report.reasons
                .map((entry) => `${t(`routePlanning.reason_${entry.reason}`)} (${entry.count})`)
                .join(" · ")}
            </p>
          )}
          {report.flaggedAreas.length === 0 ? null : (
            <p>
              <strong>{t("routePlanning.feedbackFlaggedAreas")}:</strong>{" "}
              {report.flaggedAreas.map((area) => `${name(area)} (${area.count})`).join(" · ")}
            </p>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("routePlanning.feedbackDate")}</th>
                  <th>{t("routePlanning.feedbackDriver")}</th>
                  <th>{t("routePlanning.feedbackRating")}</th>
                  <th>{t("routePlanning.feedbackReason")}</th>
                  <th>{t("routePlanning.feedbackPlanned")}</th>
                  <th>{t("routePlanning.feedbackActual")}</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.runId}>
                    <td>
                      <bdi>{formatDate(row.businessDate, locale)}</bdi>
                      <small className="field-hint"> {row.referenceNumber}</small>
                    </td>
                    <td>{locale === "ar" ? (row.driverNameAr ?? row.driverNameEn) : row.driverNameEn}</td>
                    <td aria-label={row.rating}>{row.rating === "like" ? "👍" : "👎"}</td>
                    <td>
                      {row.reason === null ? "—" : t(`routePlanning.reason_${row.reason}`)}
                      {row.flaggedAreas.length === 0 ? null : (
                        <div className="field-hint">{list(row.flaggedAreas)}</div>
                      )}
                      {row.comment === null ? null : <div className="field-hint">“{row.comment}”</div>}
                    </td>
                    <td>
                      {list(row.plannedAreas)}
                      {row.direction === "reversed" ? (
                        <small className="field-hint"> ({t("routePlanning.feedbackReversed")})</small>
                      ) : null}
                    </td>
                    <td>{list(row.actualAreas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
