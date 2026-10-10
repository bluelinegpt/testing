import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import { PageHeader } from "../../components/PageHeader.js";
import { formatDateTime } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import {
  type Coordinates,
  mapsLinkFor,
  mapsSearchFor,
  parseCoordinates,
} from "./route-coordinates.js";

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
}

export interface RouteSetup {
  readonly enabled: boolean;
  readonly companyEnabled: boolean;
  readonly platformEnabled: boolean;
  readonly provider: string;
  readonly branch: Coordinates | null;
  readonly verifiedAreaCount: number;
  readonly areaCount: number;
  readonly areas: readonly RouteSetupArea[];
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
        (term === "" ||
          area.nameEn.toLowerCase().includes(term) ||
          (area.nameAr ?? "").includes(term) ||
          area.code.toLowerCase().includes(term)),
    );
  }, [setup, search, emirateId, missingOnly]);

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
                        ) : (
                          <span className="status status-disabled">{t("routePlanning.noPin")}</span>
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
                            <button
                              onClick={() => {
                                setEditingId(area.id);
                                setDraft("");
                              }}
                              type="button"
                            >
                              {pinned ? t("routePlanning.changePin") : t("routePlanning.setPin")}
                            </button>
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
        </>
      )}
    </section>
  );
}
