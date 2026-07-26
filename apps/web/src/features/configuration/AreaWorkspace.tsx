import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import type { AreaPage, CompanyArea, Emirate } from "../../api/contracts.js";
import { normalizeLocale } from "../../localization/locale.js";

import { AreaFormDialog } from "./AreaFormDialog.js";

const pageSizes = [25, 50, 100] as const;

/** Configuration → Areas. Areas are disabled, never deleted. */
export function AreaWorkspace({ api }: { api: ApiClient }) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);

  const [emirates, setEmirates] = useState<readonly Emirate[]>([]);
  const [result, setResult] = useState<AreaPage>({ items: [], page: 1, pageSize: 25, total: 0 });
  const [search, setSearch] = useState("");
  const [emirateId, setEmirateId] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "disabled">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof pageSizes)[number]>(25);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CompanyArea>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void api
      .get<readonly Emirate[]>("configuration/emirates")
      .then((loaded) => active && setEmirates(loaded))
      .catch(() => active && setError(t("areas.emiratesLoadFailed")));
    return () => {
      active = false;
    };
  }, [api, t]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const query = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        status,
      });
      if (search.trim().length > 0) query.set("search", search.trim());
      if (emirateId.length > 0) query.set("emirateId", emirateId);
      setResult(await api.get<AreaPage>(`configuration/areas?${query.toString()}`));
    } catch {
      setError(t("areas.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [api, emirateId, page, pageSize, search, status, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const setStatusFor = async (area: CompanyArea, isActive: boolean) => {
    try {
      await api.patch<CompanyArea>(`configuration/areas/${area.id}/status`, { isActive });
      await load();
    } catch {
      setError(t("areas.saveFailed"));
    }
  };

  const emirateName = (area: CompanyArea) =>
    locale === "ar" ? area.emirateNameAr : area.emirateNameEn;
  const lastPage = Math.max(Math.ceil(result.total / result.pageSize), 1);

  return (
    <section className="stacked-section standalone-section">
      <div className="section-heading">
        <h2>{t("areas.title")}</h2>
        <button className="button button-primary" onClick={() => setCreating(true)} type="button">
          {t("areas.create")}
        </button>
      </div>

      <div className="filter-bar">
        <label className="field">
          <span>{t("common.search")}</span>
          <input
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder={t("areas.searchPlaceholder")}
            value={search}
          />
        </label>
        <label className="field">
          <span>{t("areas.emirate")}</span>
          <select
            onChange={(event) => {
              setEmirateId(event.target.value);
              setPage(1);
            }}
            value={emirateId}
          >
            <option value="">{t("areas.allEmirates")}</option>
            {emirates.map((emirate) => (
              <option key={emirate.id} value={emirate.id}>
                {locale === "ar" ? emirate.nameAr : emirate.nameEn}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("configuration.status")}</span>
          <select
            onChange={(event) => {
              setStatus(event.target.value as "all" | "active" | "disabled");
              setPage(1);
            }}
            value={status}
          >
            <option value="all">{t("areas.statusAll")}</option>
            <option value="active">{t("status.active")}</option>
            <option value="disabled">{t("status.disabled")}</option>
          </select>
        </label>
      </div>

      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>{t("areas.code")}</th>
            <th>{t("areas.nameEn")}</th>
            <th>{t("areas.emirate")}</th>
            <th>{t("configuration.status")}</th>
            <th>{t("areas.updatedAt")}</th>
            <th>
              <span className="sr-only">{t("common.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {result.items.map((area) => (
            <tr key={area.id}>
              <td>
                <strong>{area.code}</strong>
              </td>
              <td>{locale === "ar" ? (area.nameAr ?? area.nameEn) : area.nameEn}</td>
              <td>{emirateName(area)}</td>
              <td>
                <span className={`status status-${area.isActive ? "active" : "disabled"}`}>
                  {area.isActive ? t("status.active") : t("status.disabled")}
                </span>
              </td>
              <td>{area.updatedAt.slice(0, 10)}</td>
              <td>
                <div className="row-actions">
                  <button onClick={() => setEditing(area)} type="button">
                    {t("areas.edit")}
                  </button>
                  {area.isActive ? (
                    <button
                      className="danger-link"
                      onClick={() => void setStatusFor(area, false)}
                      type="button"
                    >
                      {t("areas.disable")}
                    </button>
                  ) : (
                    <button onClick={() => void setStatusFor(area, true)} type="button">
                      {t("areas.enable")}
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {result.items.length === 0 && !loading ? (
            <tr>
              <td className="empty-state" colSpan={6}>
                {t("areas.empty")}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <div className="pagination">
        <span data-testid="area-count">
          {result.total} {t("areas.title")}
        </span>
        <label className="field">
          <span className="sr-only">{t("common.pageSize")}</span>
          <select
            onChange={(event) => {
              setPageSize(Number(event.target.value) as (typeof pageSizes)[number]);
              setPage(1);
            }}
            value={pageSize}
          >
            {pageSizes.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <button disabled={page <= 1} onClick={() => setPage((current) => current - 1)} type="button">
          {t("common.previous")}
        </button>
        <span>{t("common.pageOf", { page: result.page, pageCount: lastPage })}</span>
        <button
          disabled={page >= lastPage}
          onClick={() => setPage((current) => current + 1)}
          type="button"
        >
          {t("common.next")}
        </button>
      </div>

      {creating ? (
        <AreaFormDialog
          api={api}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      ) : null}
      {editing === undefined ? null : (
        <AreaFormDialog
          api={api}
          area={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
        />
      )}
    </section>
  );
}
