import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { PageHeader } from "../../components/PageHeader.js";
import { formatDateTime } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import {
  type Coordinates,
  mapsLinkFor,
  mapsSearchFor,
  parseCoordinates,
} from "./route-coordinates.js";
import { RouteFeedbackSection } from "./RouteFeedbackSection.js";

export interface RouteSetupArea {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly emirateId: string;
  readonly emirateNameEn: string;
  readonly emirateNameAr: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly coordinatesVerifiedAt: string | null;
  readonly coordinatesVerifiedBy: string | null;
  readonly suggestion: RouteSetupSuggestion | null;
  readonly suggestionRejected: boolean;
}

export type SuggestionFlag = "not_found" | "outside_emirate" | "city_level" | "partial_match";

export interface RouteSetupSuggestion {
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly formattedAddress: string | null;
  readonly flag: SuggestionFlag | null;
  readonly createdAt: string;
}

interface SuggestPinsResult {
  readonly looked: number;
  readonly flagged: number;
  readonly notFound: number;
  readonly remaining: number;
  readonly stopped: "quota" | "google_error" | null;
  readonly setup: RouteSetup;
}

export interface RouteSetup {
  readonly enabled: boolean;
  readonly companyEnabled: boolean;
  readonly platformEnabled: boolean;
  readonly provider: string;
  readonly branch: Coordinates | null;
  readonly verifiedAreaCount: number;
  readonly areaCount: number;
  readonly geocoderConfigured: boolean;
  readonly openSuggestionCount: number;
  readonly flaggedSuggestionCount: number;
  readonly areas: readonly RouteSetupArea[];
}

/** Server error text when it has one (e.g. Google refused the key). */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message.trim() !== "" ? error.message : fallback;
}

/**
 * Configuration › Route planning (decision 10 Oct 2026: stored pins, no
 * per-run cost). The administrator pins each Area's centre once -- by pasting
 * a Google Maps link or typing the numbers -- and the branch where a Driver's
 * run ends. Saving a pin is the confirmation; an Area without one is simply
 * listed unsequenced. Switching route planning on is a Platform decision and
 * is shown here read-only.
 */
export function RoutePlanningSetupWorkspace({ api }: { api: ApiClient }) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const [setup, setSetup] = useState<RouteSetup>();
  const [search, setSearch] = useState("");
  const [emirateId, setEmirateId] = useState("");
  const [missingOnly, setMissingOnly] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [lookup, setLookup] = useState<number>();
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [branchDraft, setBranchDraft] = useState("");
  const [editingBranch, setEditingBranch] = useState(false);
  const [notice, setNotice] = useState<{
    readonly text: string;
    readonly tone: "error" | "success";
  }>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setSetup(await api.get<RouteSetup>("configuration/route-planning"));
    } catch {
      setNotice({ text: t("routePlanning.loadFailed"), tone: "error" });
    } finally {
      setBusy(false);
    }
  }, [api, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const emirates = useMemo(() => {
    const seen = new Map<string, string>();
    for (const area of setup?.areas ?? []) {
      seen.set(area.emirateId, locale === "ar" ? area.emirateNameAr : area.emirateNameEn);
    }
    return [...seen.entries()];
  }, [setup, locale]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (setup?.areas ?? []).filter(
      (area) =>
        (emirateId === "" || area.emirateId === emirateId) &&
        (!missingOnly || area.coordinatesVerifiedAt === null) &&
        (!reviewOnly || area.suggestion !== null) &&
        (term === "" ||
          area.nameEn.toLowerCase().includes(term) ||
          (area.nameAr ?? "").includes(term) ||
          area.code.toLowerCase().includes(term)),
    );
  }, [setup, search, emirateId, missingOnly, reviewOnly]);

  const run = async (work: () => Promise<RouteSetup>, success: string) => {
    setBusy(true);
    setNotice(undefined);
    try {
      setSetup(await work());
      setNotice({ text: success, tone: "success" });
      return true;
    } catch {
      setNotice({ text: t("routePlanning.saveFailed"), tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  /**
   * Google look-ups run in small batches on the server; keep asking until
   * every Area without a pin has a suggestion, or Google says stop.
   */
  const suggestPins = async () => {
    setBusy(true);
    setNotice(undefined);
    let looked = 0;
    let flagged = 0;
    let notFound = 0;
    setLookup(0);
    try {
      for (let round = 0; round < 60; round += 1) {
        const result = await api.post<SuggestPinsResult>("configuration/route-planning/suggestions");
        setSetup(result.setup);
        looked += result.looked;
        flagged += result.flagged;
        notFound += result.notFound;
        setLookup(looked);
        if (result.stopped !== null) {
          setNotice({
            text: t(
              result.stopped === "quota"
                ? "routePlanning.googleStoppedQuota"
                : "routePlanning.googleStoppedError",
            ),
            tone: "error",
          });
          return;
        }
        if (result.looked === 0 || result.remaining === 0) break;
      }
      setNotice({ text: t("routePlanning.googleDone", { looked, flagged, notFound }), tone: "success" });
    } catch (error) {
      setNotice({ text: messageOf(error, t("routePlanning.saveFailed")), tone: "error" });
    } finally {
      setLookup(undefined);
      setBusy(false);
    }
  };

  const acceptClean = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await api.post<{ accepted: number; setup: RouteSetup }>(
        "configuration/route-planning/suggestions/accept-clean",
      );
      setSetup(result.setup);
      setNotice({ text: t("routePlanning.acceptedClean", { count: result.accepted }), tone: "success" });
    } catch (error) {
      setNotice({ text: messageOf(error, t("routePlanning.saveFailed")), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const acceptSuggestion = (area: RouteSetupArea) =>
    run(
      () => api.post<RouteSetup>(`configuration/route-planning/areas/${area.id}/suggestion/accept`),
      t("routePlanning.suggestionAccepted", { area: areaName(area) }),
    );

  const rejectSuggestion = (area: RouteSetupArea) =>
    run(
      () => api.post<RouteSetup>(`configuration/route-planning/areas/${area.id}/suggestion/reject`),
      t("routePlanning.suggestionRejected", { area: areaName(area) }),
    );

  const cleanCount = (setup?.openSuggestionCount ?? 0) - (setup?.flaggedSuggestionCount ?? 0);

  const savePin = async (area: RouteSetupArea) => {
    const point = parseCoordinates(draft);
    if (point === null) {
      setNotice({ text: t("routePlanning.unreadable"), tone: "error" });
      return;
    }
    const saved = await run(
      () => api.put<RouteSetup>(`configuration/route-planning/areas/${area.id}/coordinates`, point),
      t("routePlanning.pinSaved", { area: areaName(area) }),
    );
    if (saved) {
      setEditingId(undefined);
      setDraft("");
    }
  };

  const clearPin = (area: RouteSetupArea) =>
    run(
      () => api.delete<RouteSetup>(`configuration/route-planning/areas/${area.id}/coordinates`),
      t("routePlanning.pinCleared", { area: areaName(area) }),
    );

  const saveBranch = async () => {
    const point = parseCoordinates(branchDraft);
    if (point === null) {
      setNotice({ text: t("routePlanning.unreadable"), tone: "error" });
      return;
    }
    const saved = await run(
      () => api.put<RouteSetup>("configuration/route-planning/branch", point),
      t("routePlanning.branchSaved"),
    );
    if (saved) {
      setEditingBranch(false);
      setBranchDraft("");
    }
  };

  const areaName = (area: RouteSetupArea) =>
    locale === "ar" ? (area.nameAr ?? area.nameEn) : area.nameEn;
  const emirateName = (area: RouteSetupArea) =>
    locale === "ar" ? area.emirateNameAr : area.emirateNameEn;

  return (
    <section className="route-planning-setup">
      <PageHeader description={t("routePlanning.intro")} title={t("routePlanning.title")} />

      <div
        className={`alert ${setup?.enabled === true ? "alert-success" : "alert-info"}`}
        role="status"
      >
        {setup === undefined
          ? t("routePlanning.loading")
          : setup.enabled
            ? t("routePlanning.statusOn")
            : setup.companyEnabled
              ? t("routePlanning.statusStopped")
              : t("routePlanning.statusOff")}
      </div>

      {notice === undefined ? null : (
        <div
          className={`alert ${notice.tone === "success" ? "alert-success" : "alert-error"}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.text}
        </div>
      )}

      {setup === undefined ? null : (
        <>
          <section aria-labelledby="route-branch-heading" className="card">
            <h3 id="route-branch-heading">{t("routePlanning.branchTitle")}</h3>
            <p className="field-hint">{t("routePlanning.branchHint")}</p>
            {setup.branch === null ? (
              <p>{t("routePlanning.branchNotSet")}</p>
            ) : (
              <p>
                {setup.branch.latitude}, {setup.branch.longitude} ·{" "}
                <a href={mapsLinkFor(setup.branch)} rel="noreferrer" target="_blank">
                  {t("routePlanning.viewOnMap")}
                </a>
              </p>
            )}
            {editingBranch ? (
              <div className="filter-bar">
                <label className="field">
                  <span>{t("routePlanning.pasteLabel")}</span>
                  <input
                    onChange={(event) => setBranchDraft(event.target.value)}
                    placeholder={t("routePlanning.pastePlaceholder")}
                    value={branchDraft}
                  />
                </label>
                <div className="row-actions">
                  <button
                    className="button button-primary"
                    disabled={busy}
                    onClick={() => void saveBranch()}
                    type="button"
                  >
                    {t("common.save")}
                  </button>
                  <button className="button" onClick={() => setEditingBranch(false)} type="button">
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <button className="button" onClick={() => setEditingBranch(true)} type="button">
                {setup.branch === null
                  ? t("routePlanning.setBranch")
                  : t("routePlanning.changeBranch")}
              </button>
            )}
          </section>

          <section aria-labelledby="route-google-heading" className="card">
            <h3 id="route-google-heading">{t("routePlanning.googleTitle")}</h3>
            <p className="field-hint">{t("routePlanning.googleHint")}</p>
            {setup.geocoderConfigured ? null : (
              <div className="alert alert-info" role="status">
                {t("routePlanning.googleNotConfigured")}
              </div>
            )}
            {setup.openSuggestionCount === 0 ? null : (
              <p data-testid="route-suggestion-count">
                {t("routePlanning.googleOpen", {
                  open: setup.openSuggestionCount,
                  flagged: setup.flaggedSuggestionCount,
                })}
              </p>
            )}
            <div className="row-actions">
              <button
                className="button button-primary"
                disabled={busy || !setup.geocoderConfigured || setup.verifiedAreaCount === setup.areaCount}
                onClick={() => void suggestPins()}
                type="button"
              >
                {lookup === undefined
                  ? t("routePlanning.googleRun")
                  : t("routePlanning.googleRunning", { done: lookup })}
              </button>
              {cleanCount <= 0 ? null : (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void acceptClean()}
                  type="button"
                >
                  {t("routePlanning.acceptClean", { count: cleanCount })}
                </button>
              )}
            </div>
          </section>

          <p data-testid="route-pin-progress">
            {t("routePlanning.progress", { done: setup.verifiedAreaCount, total: setup.areaCount })}
          </p>

          <div className="filter-bar">
            <label className="field">
              <span>{t("common.search")}</span>
              <input onChange={(event) => setSearch(event.target.value)} value={search} />
            </label>
            <label className="field">
              <span>{t("routePlanning.emirate")}</span>
              <select onChange={(event) => setEmirateId(event.target.value)} value={emirateId}>
                <option value="">{t("routePlanning.allEmirates")}</option>
                {emirates.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("routePlanning.missingOnly")}</span>
              <input
                checked={missingOnly}
                onChange={(event) => setMissingOnly(event.target.checked)}
                type="checkbox"
              />
            </label>
            <label className="field">
              <span>{t("routePlanning.reviewOnly")}</span>
              <input
                checked={reviewOnly}
                onChange={(event) => setReviewOnly(event.target.checked)}
                type="checkbox"
              />
            </label>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("routePlanning.emirate")}</th>
                  <th>{t("routePlanning.area")}</th>
                  <th>{t("routePlanning.pin")}</th>
                  <th>{t("routePlanning.confirmedBy")}</th>
                  <th>
                    <span className="sr-only">{t("common.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((area) => {
                  const pinned =
                    area.latitude !== null &&
                    area.longitude !== null &&
                    area.coordinatesVerifiedAt !== null;
                  return (
                    <tr key={area.id}>
                      <td>{emirateName(area)}</td>
                      <td>
                        <strong>{areaName(area)}</strong>
                        <small className="field-hint"> {area.code}</small>
                      </td>
                      <td>
                        {editingId === area.id ? (
                          <input
                            aria-label={t("routePlanning.pasteLabel")}
                            autoFocus
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void savePin(area);
                            }}
                            placeholder={t("routePlanning.pastePlaceholder")}
                            value={draft}
                          />
                        ) : pinned ? (
                          <a
                            href={mapsLinkFor({
                              latitude: area.latitude as number,
                              longitude: area.longitude as number,
                            })}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {area.latitude}, {area.longitude}
                          </a>
                        ) : area.suggestion !== null ? (
                          <SuggestionCell suggestion={area.suggestion} />
                        ) : (
                          <span className="status status-disabled">
                            {area.suggestionRejected
                              ? t("routePlanning.rejectedBefore")
                              : t("routePlanning.noPin")}
                          </span>
                        )}
                      </td>
                      <td>
                        {area.coordinatesVerifiedAt === null
                          ? "—"
                          : `${area.coordinatesVerifiedBy ?? ""} · ${formatDateTime(area.coordinatesVerifiedAt, locale)}`}
                      </td>
                      <td>
                        <div className="row-actions">
                          {editingId === area.id ? (
                            <>
                              <button
                                disabled={busy}
                                onClick={() => void savePin(area)}
                                type="button"
                              >
                                {t("common.save")}
                              </button>
                              <button onClick={() => setEditingId(undefined)} type="button">
                                {t("common.cancel")}
                              </button>
                            </>
                          ) : (
                            <>
                            {area.suggestion === null || pinned ? null : (
                              <>
                                {area.suggestion.latitude === null ? null : (
                                  <button
                                    disabled={busy}
                                    onClick={() => void acceptSuggestion(area)}
                                    type="button"
                                  >
                                    {t("routePlanning.accept")}
                                  </button>
                                )}
                                <button
                                  className="danger-link"
                                  disabled={busy}
                                  onClick={() => void rejectSuggestion(area)}
                                  type="button"
                                >
                                  {t("routePlanning.reject")}
                                </button>
                              </>
                            )}
                            <button
                              onClick={() => {
                                setEditingId(area.id);
                                setDraft("");
                              }}
                              type="button"
                            >
                              {pinned ? t("routePlanning.changePin") : t("routePlanning.setPin")}
                            </button>
                            </>
                          )}
                          <a
                            href={mapsSearchFor(area.nameEn, area.emirateNameEn)}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {t("routePlanning.findOnMap")}
                          </a>
                          {pinned && editingId !== area.id ? (
                            <button
                              className="danger-link"
                              disabled={busy}
                              onClick={() => void clearPin(area)}
                              type="button"
                            >
                              {t("routePlanning.clearPin")}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {visible.length === 0 ? (
                  <tr>
                    <td className="empty-state" colSpan={5}>
                      {t("routePlanning.empty")}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <RouteFeedbackSection api={api} />
        </>
      )}
    </section>
  );
}

function SuggestionCell({ suggestion }: { readonly suggestion: RouteSetupSuggestion }) {
  const { t } = useTranslation();
  return (
    <div className="route-suggestion">
      {suggestion.latitude === null || suggestion.longitude === null ? null : (
        <>
          <span className="status status-progress">{t("routePlanning.suggested")}</span>{" "}
          <a
            href={mapsLinkFor({ latitude: suggestion.latitude, longitude: suggestion.longitude })}
            rel="noreferrer"
            target="_blank"
          >
            {suggestion.latitude}, {suggestion.longitude}
          </a>
        </>
      )}
      {suggestion.flag === null ? null : (
        <div>
          <span className="status status-warning">{t(`routePlanning.flag_${suggestion.flag}`)}</span>
        </div>
      )}
      {suggestion.formattedAddress === null ? null : (
        <small className="field-hint">{suggestion.formattedAddress}</small>
      )}
    </div>
  );
}
