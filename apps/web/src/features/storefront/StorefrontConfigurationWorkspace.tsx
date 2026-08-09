import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { DeliveryCompaniesSection } from "./DeliveryCompaniesSection.js";
import { StoreMarketplaceClassification } from "./MarketplaceClassification.js";
import { hasStorefrontPermission } from "./storefront-permissions.js";

/**
 * Trader Storefront configuration workspace.
 *
 * ---------------------------------------------------------------------------
 * THE SERVER OWNS EVERY DECISION THIS SCREEN DISPLAYS
 * ---------------------------------------------------------------------------
 *
 * Slug availability, publication readiness, permitted status moves and
 * suspension are all decided by the API. This screen renders those answers and
 * disables controls accordingly; it never computes its own verdict. In
 * particular the availability indicator is ADVISORY — the same wording the
 * backend uses — because only the unique index can arbitrate two Traders
 * claiming one URL, and the submit path is what surfaces the real outcome.
 */

export type StorefrontStatus =
  | "draft"
  | "published"
  | "temporarily_closed"
  | "unpublished"
  | "suspended";

interface BusinessHoursEntry {
  readonly days: string;
  readonly time: string;
}

export interface StorefrontConfiguration {
  readonly brandAccentColor: string | null;
  readonly brandPrimaryColor: string | null;
  readonly businessHours: readonly BusinessHoursEntry[];
  readonly businessTemplate: string;
  readonly customerSupport: string | null;
  readonly deliveryInformation: string | null;
  readonly displayName: string;
  readonly id: string;
  readonly publicEmail: string | null;
  readonly publicMobile: string | null;
  readonly publicUrl: string;
  readonly publicWhatsapp: string | null;
  readonly publishedAt: string | null;
  readonly returnPolicy: string | null;
  readonly seoDescriptionAr: string | null;
  readonly seoDescriptionEn: string | null;
  readonly seoIndexable: boolean;
  readonly seoTitleAr: string | null;
  readonly seoTitleEn: string | null;
  readonly slug: string;
  readonly status: StorefrontStatus;
  readonly storeDescription: string | null;
  readonly suspendedAt: string | null;
  readonly suspensionReason: string | null;
  readonly terms: string | null;
  readonly theme: string;
  readonly traderId: string;
  readonly version: number;
}

/**
 * Clearing an SEO override.
 *
 * An empty text box and an unset override are the same intent, but they are not
 * the same value: the database rejects a blank override precisely so an empty
 * title can never be published. Null restores the derived title instead.
 */
function blankSeoToNull(
  draft: Partial<StorefrontConfiguration>,
): Record<string, unknown> {
  const seoTextFields = [
    "seoDescriptionAr",
    "seoDescriptionEn",
    "seoTitleAr",
    "seoTitleEn",
  ] as const;
  const next: Record<string, unknown> = { ...draft };
  for (const field of seoTextFields) {
    if (typeof next[field] === "string" && next[field].trim() === "") next[field] = null;
  }
  return next;
}

const templates = ["fashion", "electronics", "jewelry", "general"] as const;
const themes = ["luxury_minimal", "modern", "clean_light"] as const;

/**
 * Which actions a status permits.
 *
 * A mirror of the backend transition table, used ONLY to decide what to show.
 * The backend re-checks every move, so a stale copy here can hide a legal
 * action but can never authorise an illegal one.
 */
function availableActions(status: StorefrontStatus): readonly string[] {
  if (status === "draft") return ["publish"];
  if (status === "published") return ["temporarily-close", "unpublish"];
  if (status === "temporarily_closed") return ["reopen", "unpublish"];
  if (status === "unpublished") return ["publish"];
  return [];
}

/** Mirrors the server's slug normalisation so the suggestion matches what is stored. */
export function suggestSlug(displayName: string): string {
  return displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/, "");
}

interface SlugState {
  readonly available: boolean;
  readonly normalised: string;
  readonly reason: string | null;
}

interface CompanyStorefrontSummary {
  readonly displayName: string;
  readonly id: string;
  readonly slug: string;
  readonly status: StorefrontStatus;
}

interface SelectableTrader {
  readonly code?: string;
  readonly id: string;
  readonly name?: string;
  readonly nameEn?: string;
}

export function StorefrontConfigurationWorkspace({
  api,
  permissions,
  storefrontId,
}: {
  readonly api: ApiClient;
  readonly permissions: readonly string[];
  readonly storefrontId?: string | undefined;
}) {
  const { t } = useTranslation();
  const [storefront, setStorefront] = useState<StorefrontConfiguration>();
  const [draft, setDraft] = useState<Partial<StorefrontConfiguration>>({});
  const [slugState, setSlugState] = useState<SlugState>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [reload, setReload] = useState(0);
  /**
   * Company mode.
   *
   * `mine` resolves the caller's OWN Storefront and therefore only answers for
   * a Trader account. A Company user manages Traders' Storefronts instead, so
   * the refusal is treated as a mode switch rather than an error: the screen
   * lists the Company's Storefronts and offers to create one.
   */
  const [companyMode, setCompanyMode] = useState(false);
  const [storefronts, setStorefronts] = useState<readonly CompanyStorefrontSummary[]>([]);
  const [traders, setTraders] = useState<readonly SelectableTrader[]>([]);
  const [newTraderId, setNewTraderId] = useState("");
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newTemplate, setNewTemplate] = useState("general");
  const [newTheme, setNewTheme] = useState("clean_light");

  const canManage = hasStorefrontPermission(permissions, "storefront.manage");
  const canPublish = hasStorefrontPermission(permissions, "storefront.publish");
  const canSuspend = hasStorefrontPermission(permissions, "storefront.suspend");

  useEffect(() => {
    let active = true;
    setLoading(true);
    const path =
      storefrontId === undefined
        ? "operations/trader-storefronts/mine"
        : `operations/trader-storefronts/${storefrontId}`;
    api
      .get<StorefrontConfiguration | null>(path)
      .then((value) => {
        if (!active) return;
        setStorefront(value ?? undefined);
        setDraft({});
        setError(undefined);
      })
      .catch(async (cause: unknown) => {
        if (!active) return;
        const code = cause instanceof ApiError ? cause.code : "storefront_load_failed";
        if (code !== "storefront_trader_context_required") {
          setError(code);
          return;
        }
        // A Company user: list this Company's Storefronts instead.
        setCompanyMode(true);
        try {
          const list = await api.get<{ items: CompanyStorefrontSummary[] }>(
            "operations/trader-storefronts",
          );
          if (active) setStorefronts(list.items);
          const traderList = await api.get<SelectableTrader[]>("operations/traders");
          if (active) setTraders(Array.isArray(traderList) ? traderList : []);
        } catch {
          if (active) setError("storefront_load_failed");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, storefrontId, reload]);

  const value = useCallback(
    <K extends keyof StorefrontConfiguration>(key: K): StorefrontConfiguration[K] | undefined =>
      (draft[key] as StorefrontConfiguration[K] | undefined) ?? storefront?.[key],
    [draft, storefront],
  );

  const dirty = Object.keys(draft).length > 0;
  const suspended = storefront?.status === "suspended";

  /**
   * Business-hours validation, checked before the row can be saved.
   *
   * Both fields are required by the API contract, so an entry missing either
   * one would be rejected server-side with a shape error the user cannot act
   * on. Catching it here names the actual problem.
   */
  const hours = value("businessHours") ?? [];
  const hoursError =
    hours.some((entry) => entry.days.trim() === "" || entry.time.trim() === "")
      ? "storefront_hours_incomplete"
      : undefined;

  const checkSlug = useCallback(
    async (candidate: string) => {
      if (storefront === undefined) return;
      const query = new URLSearchParams({ slug: candidate, storefrontId: storefront.id });
      try {
        setSlugState(await api.get<SlugState>(`operations/trader-storefronts/slug-availability?${query.toString()}`));
      } catch {
        // An advisory check that fails is not an error the user must act on;
        // the submit path reports the authoritative answer.
        setSlugState(undefined);
      }
    },
    [api, storefront],
  );

  const save = async () => {
    if (storefront === undefined) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const updated = await api.patch<StorefrontConfiguration>(
        `operations/trader-storefronts/${storefront.id}`,
        // Blank SEO text means "no override", which is null. Sending "" would
        // be rejected outright by the database's blank-override check, so the
        // Trader clearing a field they no longer want must not produce an error.
        { ...blankSeoToNull(draft), expectedVersion: storefront.version },
      );
      setStorefront(updated);
      setDraft({});
      setNotice("storefront.saved");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.code : "storefront_save_failed");
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (action: string, body: Record<string, unknown> = {}) => {
    if (storefront === undefined) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const updated = await api.post<StorefrontConfiguration>(
        `operations/trader-storefronts/${storefront.id}/${action}`,
        { ...body, expectedVersion: storefront.version },
      );
      setStorefront(updated);
      setDraft({});
      setNotice(`storefront.action.${action}`);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.code : "storefront_action_failed");
    } finally {
      setBusy(false);
    }
  };

  const actions = useMemo(
    () => (storefront === undefined ? [] : availableActions(storefront.status)),
    [storefront],
  );

  if (loading) return <div className="accounting-state">{t("common.loading")}</div>;

  if (error !== undefined && storefront === undefined) {
    return (
      <div className="accounting-state" role="alert">
        {t(`storefront.errors.${error}`, t("common.operationFailed"))}
      </div>
    );
  }

  if (companyMode && storefront === undefined) {
    const traderLabel = (trader: SelectableTrader) =>
      `${trader.nameEn ?? trader.name ?? trader.id}${trader.code === undefined ? "" : ` (${trader.code})`}`;
    const createStorefront = async () => {
      setBusy(true);
      setError(undefined);
      try {
        await api.post("operations/trader-storefronts", {
          businessTemplate: newTemplate,
          displayName: newName,
          slug: newSlug === "" ? suggestSlug(newName) : newSlug,
          theme: newTheme,
          traderId: newTraderId,
        });
        setNewName("");
        setNewSlug("");
        setNewTraderId("");
        setReload((current) => current + 1);
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.code : "storefront_save_failed");
      } finally {
        setBusy(false);
      }
    };
    return (
      <section className="accounting-page storefront-page">
        <header className="page-heading-copy">
          <h1>{t("storefront.title")}</h1>
          <p>{t("storefront.subtitle")}</p>
        </header>
        {error !== undefined ? (
          <div className="alert alert-danger" role="alert">
            {t(`storefront.errors.${error}`, t("common.operationFailed"))}
          </div>
        ) : null}

        {storefronts.length === 0 ? (
          <div className="accounting-empty">{t("storefront.companyNoneYet")}</div>
        ) : (
          <div className="table-scroll-x">
            <table className="data-table accounting-table">
              <thead>
                <tr>
                  <th>{t("storefront.fields.displayName")}</th>
                  <th>{t("storefront.fields.slug")}</th>
                  <th>{t("storefront.fields.status")}</th>
                  <th>{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {storefronts.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.displayName}</td>
                    <td>
                      <bdi>{entry.slug}</bdi>
                    </td>
                    <td>{t(`storefront.status.${entry.status}`)}</td>
                    <td>
                      <a href={`/configuration/storefront/${entry.id}`}>{t("common.open")}</a>
                      {" · "}
                      <a href={`/configuration/storefront-products/${entry.id}`}>
                        {t("productCatalogue.title")}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <fieldset className="accounting-form" disabled={!canManage || busy}>
          <legend>{t("storefront.createTitle")}</legend>
          <label>
            {t("storefront.fields.trader")}
            <select onChange={(event) => setNewTraderId(event.target.value)} value={newTraderId}>
              <option value="">{t("common.select")}</option>
              {traders.map((trader) => (
                <option key={trader.id} value={trader.id}>
                  {traderLabel(trader)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("storefront.fields.displayName")}
            <input
              onChange={(event) => {
                setNewName(event.target.value);
                setNewSlug(suggestSlug(event.target.value));
              }}
              value={newName}
            />
          </label>
          <label>
            {t("storefront.fields.slug")}
            <input onChange={(event) => setNewSlug(event.target.value)} value={newSlug} />
          </label>
          <label>
            {t("storefront.fields.businessTemplate")}
            <select onChange={(event) => setNewTemplate(event.target.value)} value={newTemplate}>
              {templates.map((template) => (
                <option key={template} value={template}>
                  {t(`storefront.template.${template}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("storefront.fields.theme")}
            <select onChange={(event) => setNewTheme(event.target.value)} value={newTheme}>
              {themes.map((theme) => (
                <option key={theme} value={theme}>
                  {t(`storefront.theme.${theme}`)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button button-primary"
            disabled={newTraderId === "" || newName.trim() === ""}
            onClick={() => void createStorefront()}
            type="button"
          >
            {t("common.create")}
          </button>
        </fieldset>
      </section>
    );
  }

  if (storefront === undefined) {
    return (
      <section className="accounting-page storefront-page">
        <h1>{t("storefront.title")}</h1>
        <div className="accounting-empty">{t("storefront.noneYet")}</div>
      </section>
    );
  }

  return (
    <section className="accounting-page storefront-page">
      <header className="page-heading-copy">
        <h1>{t("storefront.title")}</h1>
        <p>{t("storefront.subtitle")}</p>
      </header>

      {suspended ? (
        <div className="alert alert-danger" role="alert">
          {t("storefront.suspendedNotice", { reason: storefront.suspensionReason ?? "" })}
        </div>
      ) : null}

      {error !== undefined ? (
        <div className="alert alert-danger" role="alert">
          {t(`storefront.errors.${error}`, t("common.operationFailed"))}
        </div>
      ) : null}
      {notice !== undefined ? (
        <div className="alert alert-info" role="status">
          {t(notice, t("common.saved"))}
        </div>
      ) : null}

      <div className="accounting-summary-grid">
        <article className="accounting-summary-card">
          <span>{t("storefront.fields.status")}</span>
          <strong>{t(`storefront.status.${storefront.status}`)}</strong>
        </article>
        <article className="accounting-summary-card">
          <span>{t("storefront.fields.publicUrl")}</span>
          <strong>
            <bdi>{storefront.publicUrl}</bdi>
          </strong>
        </article>
      </div>

      <fieldset className="accounting-form" disabled={!canManage || suspended || busy}>
        <legend>{t("storefront.sections.information")}</legend>

        <label>
          {t("storefront.fields.displayName")}
          <input
            onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
            value={value("displayName") ?? ""}
          />
        </label>

        <label>
          {t("storefront.fields.slug")}
          <input
            onChange={(event) => {
              setDraft({ ...draft, slug: event.target.value });
              void checkSlug(event.target.value);
            }}
            value={value("slug") ?? ""}
          />
        </label>
        <button
          onClick={() => {
            const suggestion = suggestSlug(value("displayName") ?? "");
            setDraft({ ...draft, slug: suggestion });
            void checkSlug(suggestion);
          }}
          type="button"
        >
          {t("storefront.generateSlug")}
        </button>
        {slugState === undefined ? null : (
          <p className={slugState.available ? "form-hint" : "form-field-error"} role="status">
            {slugState.available
              ? t("storefront.slugAvailable", { slug: slugState.normalised })
              : t(`storefront.errors.${slugState.reason ?? "storefront_slug_invalid"}`)}
          </p>
        )}

        <label>
          {t("storefront.fields.businessTemplate")}
          <select
            onChange={(event) => setDraft({ ...draft, businessTemplate: event.target.value })}
            value={value("businessTemplate") ?? "general"}
          >
            {templates.map((template) => (
              <option key={template} value={template}>
                {t(`storefront.template.${template}`)}
              </option>
            ))}
          </select>
        </label>

        <label>
          {t("storefront.fields.theme")}
          <select
            onChange={(event) => setDraft({ ...draft, theme: event.target.value })}
            value={value("theme") ?? "clean_light"}
          >
            {themes.map((theme) => (
              <option key={theme} value={theme}>
                {t(`storefront.theme.${theme}`)}
              </option>
            ))}
          </select>
        </label>

        <label>
          {t("storefront.fields.brandPrimaryColor")}
          <input
            onChange={(event) => setDraft({ ...draft, brandPrimaryColor: event.target.value })}
            type="color"
            value={value("brandPrimaryColor") ?? "#1f2937"}
          />
        </label>
        <label>
          {t("storefront.fields.brandAccentColor")}
          <input
            onChange={(event) => setDraft({ ...draft, brandAccentColor: event.target.value })}
            type="color"
            value={value("brandAccentColor") ?? "#b08d57"}
          />
        </label>

        <label>
          {t("storefront.fields.storeDescription")}
          <textarea
            onChange={(event) => setDraft({ ...draft, storeDescription: event.target.value })}
            rows={3}
            value={value("storeDescription") ?? ""}
          />
        </label>

        {/* Search and social metadata.
            Every field is an OVERRIDE, not a requirement. The Store already
            produces a correct title and description from its name and
            description above, so a Trader who ignores this section entirely is
            not penalised — the placeholder shows them what will be published if
            they leave it blank, which is more useful than an empty box that
            implies something is missing. */}
        <fieldset className="accounting-form">
          <legend>{t("storefront.seo.legend")}</legend>
          <p className="accounting-hint">{t("storefront.seo.hint")}</p>

          <label>
            {t("storefront.seo.titleEn")}
            <input
              maxLength={160}
              onChange={(event) => setDraft({ ...draft, seoTitleEn: event.target.value })}
              placeholder={value("displayName") ?? ""}
              value={value("seoTitleEn") ?? ""}
            />
          </label>
          <label>
            {t("storefront.seo.titleAr")}
            <input
              dir="rtl"
              maxLength={160}
              onChange={(event) => setDraft({ ...draft, seoTitleAr: event.target.value })}
              value={value("seoTitleAr") ?? ""}
            />
          </label>
          <label>
            {t("storefront.seo.descriptionEn")}
            <textarea
              maxLength={320}
              onChange={(event) => setDraft({ ...draft, seoDescriptionEn: event.target.value })}
              placeholder={value("storeDescription") ?? ""}
              rows={2}
              value={value("seoDescriptionEn") ?? ""}
            />
          </label>
          <label>
            {t("storefront.seo.descriptionAr")}
            <textarea
              dir="rtl"
              maxLength={320}
              onChange={(event) => setDraft({ ...draft, seoDescriptionAr: event.target.value })}
              rows={2}
              value={value("seoDescriptionAr") ?? ""}
            />
          </label>

          {/* Phrased as opting OUT. A checkbox labelled "indexable" that is on
              by default reads as something the Trader turned on themselves. */}
          <label className="accounting-checkbox">
            <input
              checked={!(value("seoIndexable") ?? true)}
              onChange={(event) => setDraft({ ...draft, seoIndexable: !event.target.checked })}
              type="checkbox"
            />
            {t("storefront.seo.hideFromSearch")}
          </label>
        </fieldset>

        <label>
          {t("storefront.fields.publicMobile")}
          <input
            onChange={(event) => setDraft({ ...draft, publicMobile: event.target.value })}
            value={value("publicMobile") ?? ""}
          />
        </label>
        <label>
          {t("storefront.fields.publicWhatsapp")}
          <input
            onChange={(event) => setDraft({ ...draft, publicWhatsapp: event.target.value })}
            value={value("publicWhatsapp") ?? ""}
          />
        </label>
        <label>
          {t("storefront.fields.publicEmail")}
          <input
            onChange={(event) => setDraft({ ...draft, publicEmail: event.target.value })}
            type="email"
            value={value("publicEmail") ?? ""}
          />
        </label>

        {/* Business hours. The API model is one {days,time} entry per row, so
            this edits exactly that — a closed day is simply absent, and the
            public page shows only the days that are listed. Multiple intervals
            per day are not offered because the stored model cannot express
            them, and inventing a second one here would put data on the public
            page that the server never validated. */}
        <fieldset className="accounting-form">
          <legend>{t("storefront.fields.businessHours")}</legend>
          {(value("businessHours") ?? []).map((entry, index) => (
            <div className="storefront-hours-row" key={`${entry.days}-${String(index)}`}>
              <label>
                {t("storefront.hours.days")}
                <input
                  onChange={(event) => {
                    const next = [...(value("businessHours") ?? [])];
                    next[index] = { ...next[index]!, days: event.target.value };
                    setDraft({ ...draft, businessHours: next });
                  }}
                  value={entry.days}
                />
              </label>
              <label>
                {t("storefront.hours.time")}
                <input
                  onChange={(event) => {
                    const next = [...(value("businessHours") ?? [])];
                    next[index] = { ...next[index]!, time: event.target.value };
                    setDraft({ ...draft, businessHours: next });
                  }}
                  placeholder="10:00 – 22:00"
                  value={entry.time}
                />
              </label>
              <button
                onClick={() =>
                  setDraft({
                    ...draft,
                    businessHours: (value("businessHours") ?? []).filter(
                      (_, position) => position !== index,
                    ),
                  })
                }
                type="button"
              >
                {t("storefront.hours.remove")}
              </button>
            </div>
          ))}
          {hoursError === undefined ? null : (
            <p className="form-field-error" role="alert">
              {t(`storefront.errors.${hoursError}`)}
            </p>
          )}
          <button
            disabled={(value("businessHours") ?? []).length >= 14}
            onClick={() =>
              setDraft({
                ...draft,
                businessHours: [
                  ...(value("businessHours") ?? []),
                  { days: t("storefront.hours.defaultDays"), time: "" },
                ],
              })
            }
            type="button"
          >
            {t("storefront.hours.add")}
          </button>
        </fieldset>

        <label>
          {t("storefront.fields.deliveryInformation")}
          <textarea
            onChange={(event) => setDraft({ ...draft, deliveryInformation: event.target.value })}
            rows={2}
            value={value("deliveryInformation") ?? ""}
          />
        </label>
        <label>
          {t("storefront.fields.returnPolicy")}
          <textarea
            onChange={(event) => setDraft({ ...draft, returnPolicy: event.target.value })}
            rows={2}
            value={value("returnPolicy") ?? ""}
          />
        </label>
        <label>
          {t("storefront.fields.terms")}
          <textarea
            onChange={(event) => setDraft({ ...draft, terms: event.target.value })}
            rows={2}
            value={value("terms") ?? ""}
          />
        </label>
        <label>
          {t("storefront.fields.customerSupport")}
          <textarea
            onChange={(event) => setDraft({ ...draft, customerSupport: event.target.value })}
            rows={2}
            value={value("customerSupport") ?? ""}
          />
        </label>

        <button
          className="button button-primary"
          disabled={!dirty || busy || hoursError !== undefined}
          onClick={() => void save()}
          type="button"
        >
          {t("common.save")}
        </button>
      </fieldset>

      <section className="accounting-form">
        <h2>{t("storefront.sections.publication")}</h2>
        {actions.length === 0 ? (
          <p className="form-hint">{t("storefront.noActions")}</p>
        ) : (
          actions.map((action) => (
            <button
              disabled={!canPublish || busy || dirty}
              key={action}
              onClick={() => void runAction(action)}
              type="button"
            >
              {t(`storefront.actions.${action}`)}
            </button>
          ))
        )}
        {dirty ? <p className="form-hint">{t("storefront.saveBeforeAction")}</p> : null}

        {canSuspend ? (
          suspended ? (
            <button
              disabled={busy}
              onClick={() => void runAction("remove-suspension")}
              type="button"
            >
              {t("storefront.actions.remove-suspension")}
            </button>
          ) : (
            <button
              disabled={busy}
              onClick={() => void runAction("suspend", { reason: t("storefront.defaultSuspendReason") })}
              type="button"
            >
              {t("storefront.actions.suspend")}
            </button>
          )
        ) : null}
      </section>

      <StoreMarketplaceClassification
        api={api}
        canManage={canManage}
        storefrontId={storefront.id}
      />

      <DeliveryCompaniesSection api={api} canManage={canManage} storefrontId={storefront.id} />

      <section className="accounting-form">
        <h2>{t("storefront.sections.preview")}</h2>
        <p className="form-hint">{t("storefront.previewHint")}</p>
        <a href={storefront.publicUrl} rel="noreferrer" target="_blank">
          {t("storefront.openPreview")}
        </a>
      </section>
    </section>
  );
}
