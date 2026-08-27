import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  readonly coverUrl: string | null;
  readonly customerSupport: string | null;
  readonly deliveryInformation: string | null;
  readonly displayName: string;
  readonly id: string;
  readonly logoUrl: string | null;
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
  onCreated,
  permissions,
  storefrontId,
  traderId,
}: {
  readonly api: ApiClient;
  readonly permissions: readonly string[];
  readonly storefrontId?: string | undefined;
  /**
   * Fired once a Trader's own Store is created.
   *
   * The Trader shell uses this to unlock "Products" immediately (§25/§32 of
   * the Trader Portal UX prompt) rather than requiring a manual refresh or a
   * detour through another screen before the Store the Trader just created
   * becomes usable.
   */
  readonly onCreated?: (() => void) | undefined;
  /**
   * The caller's own Trader id, from the Trader portal shell.
   *
   * Enables the Trader-owned "Create Your Store" experience below. Absent
   * (undefined) when this component is mounted from the Company side, where
   * creation instead means picking one of the Company's Traders — a
   * different form entirely, kept below under `companyMode`.
   */
  readonly traderId?: string | undefined;
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

  // Branding (T2 acceptance, §7-9): Store logo/cover upload -- the same
  // `postMultipart`/file-input pattern already used for the Company's own
  // logo in `CompanyProfileWorkspace.tsx`, pointed at the Storefront's own
  // `media/logo`/`media/cover` routes instead of `company-profile/logo`.
  const [selectedLogoFile, setSelectedLogoFile] = useState<File>();
  const [selectedCoverFile, setSelectedCoverFile] = useState<File>();
  const [logoBusy, setLogoBusy] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [logoError, setLogoError] = useState<string>();
  const [coverError, setCoverError] = useState<string>();
  const logoInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

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

  /** The same advisory check, before any Storefront exists to key it to. */
  const checkSlugAvailability = useCallback(
    async (candidate: string) => {
      if (candidate.trim() === "") {
        setSlugState(undefined);
        return;
      }
      const query = new URLSearchParams({ slug: candidate });
      try {
        setSlugState(await api.get<SlugState>(`operations/trader-storefronts/slug-availability?${query.toString()}`));
      } catch {
        setSlugState(undefined);
      }
    },
    [api],
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

  const ACCEPTED_BRAND_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
  const MAX_BRAND_IMAGE_BYTES = 5 * 1024 * 1024;

  function chooseBrandImage(
    file: File | undefined,
    setSelected: (file: File | undefined) => void,
    setFileError: (error: string | undefined) => void,
  ) {
    setFileError(undefined);
    if (file === undefined) {
      setSelected(undefined);
      return;
    }
    if (!ACCEPTED_BRAND_IMAGE_TYPES.includes(file.type)) {
      setSelected(undefined);
      setFileError("storefront.errors.brandImageType");
      return;
    }
    if (file.size > MAX_BRAND_IMAGE_BYTES) {
      setSelected(undefined);
      setFileError("storefront.errors.brandImageSize");
      return;
    }
    setSelected(file);
  }

  async function uploadBrandImage(purpose: "cover" | "logo") {
    if (storefront === undefined) return;
    const file = purpose === "logo" ? selectedLogoFile : selectedCoverFile;
    if (file === undefined) return;
    const setBusyFlag = purpose === "logo" ? setLogoBusy : setCoverBusy;
    const setFileError = purpose === "logo" ? setLogoError : setCoverError;
    const inputRef = purpose === "logo" ? logoInputRef : coverInputRef;
    const clearSelected = purpose === "logo" ? setSelectedLogoFile : setSelectedCoverFile;
    setBusyFlag(true);
    setFileError(undefined);
    try {
      const body = new FormData();
      body.append("file", file);
      await api.postMultipart<{ fileId: string }>(
        `operations/trader-storefronts/${storefront.id}/media/${purpose}`,
        body,
      );
      clearSelected(undefined);
      if (inputRef.current !== null) inputRef.current.value = "";
      setReload((current) => current + 1);
      setNotice(purpose === "logo" ? "storefront.logoUploaded" : "storefront.coverUploaded");
    } catch (cause) {
      setFileError(
        cause instanceof ApiError
          ? `storefront.errors.${cause.code}`
          : "storefront.errors.storefront_save_failed",
      );
    } finally {
      setBusyFlag(false);
    }
  }

  async function removeBrandImage(purpose: "cover" | "logo") {
    if (storefront === undefined) return;
    const setBusyFlag = purpose === "logo" ? setLogoBusy : setCoverBusy;
    const setFileError = purpose === "logo" ? setLogoError : setCoverError;
    setBusyFlag(true);
    setFileError(undefined);
    try {
      await api.delete<{ removed: boolean }>(
        `operations/trader-storefronts/${storefront.id}/media/${purpose}`,
      );
      setReload((current) => current + 1);
      setNotice(purpose === "logo" ? "storefront.logoRemoved" : "storefront.coverRemoved");
    } catch (cause) {
      setFileError(
        cause instanceof ApiError
          ? `storefront.errors.${cause.code}`
          : "storefront.errors.storefront_save_failed",
      );
    } finally {
      setBusyFlag(false);
    }
  }

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
                  {t(`storefront.templates.${template}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("storefront.fields.theme")}
            <select onChange={(event) => setNewTheme(event.target.value)} value={newTheme}>
              {themes.map((theme) => (
                <option key={theme} value={theme}>
                  {t(`storefront.themes.${theme}`)}
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

  /**
   * A Trader with no Store yet.
   *
   * The one field a Trader supplies that a Company user does not is which
   * Trader owns the Store — here that is already known (`traderId`), so this
   * form is display name, slug and appearance only. The slug availability
   * check runs against the same `slug-availability` endpoint the edit screen
   * uses below, because a second uniqueness implementation is exactly how the
   * two eventually disagree.
   */
  if (!companyMode && storefront === undefined && traderId !== undefined) {
    const createOwnStore = async () => {
      setBusy(true);
      setError(undefined);
      try {
        await api.post("operations/trader-storefronts", {
          businessTemplate: newTemplate,
          displayName: newName,
          slug: newSlug === "" ? suggestSlug(newName) : newSlug,
          theme: newTheme,
          traderId,
        });
        setReload((current) => current + 1);
        onCreated?.();
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.code : "storefront_save_failed");
      } finally {
        setBusy(false);
      }
    };
    return (
      <section className="accounting-page storefront-page">
        <header className="page-heading-copy">
          <h1>{t("storefront.createYourStore")}</h1>
          <p>{t("storefront.createYourStoreLead")}</p>
        </header>
        {error !== undefined ? (
          <div className="alert alert-danger" role="alert">
            {t(`storefront.errors.${error}`, t("common.operationFailed"))}
          </div>
        ) : null}
        <div className="accounting-form">
          <fieldset className="accounting-form-section" disabled={busy}>
            <legend>{t("storefront.sections.identity")}</legend>
            <div className="accounting-form-grid">
              <label>
                {t("storefront.fields.displayName")}
                <input
                  onChange={(event) => {
                    setNewName(event.target.value);
                    if (newSlug === "") setNewSlug(suggestSlug(event.target.value));
                  }}
                  required
                  value={newName}
                />
              </label>
              <label>
                {t("storefront.fields.slug")}
                {/* The domain prefix is shown, not typed — the Trader only
                    ever enters the part that is actually theirs to choose,
                    and seeing the real address the moment they type answers
                    "what will my customers actually see" without waiting for
                    a save. */}
                <div className="storefront-slug-preview" dir="ltr">
                  <span className="storefront-slug-preview__domain">store.bluelinegpt.com/</span>
                  <input
                    dir="ltr"
                    onChange={(event) => setNewSlug(event.target.value)}
                    onBlur={() => {
                      void checkSlugAvailability(newSlug);
                    }}
                    required
                    value={newSlug}
                  />
                </div>
                {slugState !== undefined ? (
                  <p className={slugState.available ? "field-hint-ok" : "field-hint-error"}>
                    {slugState.available
                      ? t("storefront.slugAvailable", { slug: slugState.normalised })
                      : t(
                          `storefront.errors.${slugState.reason ?? "storefront_slug_taken"}`,
                          t("storefront.slugTaken"),
                        )}
                  </p>
                ) : null}
              </label>
            </div>
          </fieldset>

          <fieldset className="accounting-form-section" disabled={busy}>
            <legend>{t("storefront.sections.appearance")}</legend>
            <div className="accounting-form-grid">
              <label>
                {t("storefront.fields.businessTemplate")}
                <select onChange={(event) => setNewTemplate(event.target.value)} value={newTemplate}>
                  {templates.map((template) => (
                    <option key={template} value={template}>
                      {t(`storefront.templates.${template}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("storefront.fields.theme")}
                <select onChange={(event) => setNewTheme(event.target.value)} value={newTheme}>
                  {themes.map((theme) => (
                    <option key={theme} value={theme}>
                      {t(`storefront.themes.${theme}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>

          {/* Disabled with an EXPLAINED reason (§24), not a silently grey
              button — a Trader should never have to guess which field is
              incomplete. */}
          {newName.trim() === "" ? (
            <p className="field-hint">{t("storefront.createBlockedName")}</p>
          ) : newSlug.trim() === "" ? (
            <p className="field-hint">{t("storefront.createBlockedSlug")}</p>
          ) : slugState?.available === false ? (
            <p className="field-hint-error">{t("storefront.createBlockedSlugTaken")}</p>
          ) : null}
          <div className="heading-actions">
            <button
              className="button button-primary"
              disabled={
                newName.trim() === "" || newSlug.trim() === "" || slugState?.available === false
              }
              onClick={() => void createOwnStore()}
              type="button"
            >
              {busy ? t("common.saving") : t("storefront.createYourStore")}
            </button>
          </div>
        </div>
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
          className="button button-secondary"
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
                {t(`storefront.templates.${template}`)}
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
                {t(`storefront.themes.${theme}`)}
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

        {/* Branding (T2 acceptance): logo and cover upload, each saved
            immediately on upload -- not batched with the text-field Save
            button below, because a Trader who uploads a logo and then
            navigates away without touching Save should not lose it. */}
        <fieldset className="accounting-form-section">
          <legend>{t("storefront.sections.branding")}</legend>
          <div className="company-logo-manager">
            <div className="company-logo-previews">
              <figure className="company-logo-figure">
                <figcaption>{t("storefront.branding.currentLogo")}</figcaption>
                {storefront.logoUrl !== null ? (
                  <img
                    alt={t("storefront.branding.currentLogo")}
                    className="company-logo-image"
                    src={storefront.logoUrl}
                  />
                ) : (
                  <span aria-hidden="true" className="company-logo-placeholder">
                    {storefront.displayName.slice(0, 1).toUpperCase()}
                  </span>
                )}
              </figure>
            </div>
            <div className="company-logo-controls">
              <p className="muted">{t("storefront.branding.logoHint")}</p>
              <input
                accept="image/png,image/jpeg,image/webp"
                aria-label={t("storefront.branding.chooseFile")}
                disabled={!canManage || busy}
                onChange={(event) =>
                  chooseBrandImage(event.target.files?.[0], setSelectedLogoFile, setLogoError)
                }
                ref={logoInputRef}
                type="file"
              />
              {logoError !== undefined ? (
                <p className="field-error" role="alert">
                  {t(logoError, t("common.operationFailed"))}
                </p>
              ) : null}
              <div className="company-logo-actions">
                <button
                  className="button button-primary"
                  disabled={selectedLogoFile === undefined || logoBusy || !canManage}
                  onClick={() => void uploadBrandImage("logo")}
                  type="button"
                >
                  {logoBusy
                    ? t("common.working")
                    : storefront.logoUrl !== null
                      ? t("storefront.branding.replaceLogo")
                      : t("storefront.branding.uploadLogo")}
                </button>
                {storefront.logoUrl !== null ? (
                  <button
                    className="button button-secondary"
                    disabled={logoBusy || !canManage}
                    onClick={() => void removeBrandImage("logo")}
                    type="button"
                  >
                    {t("storefront.branding.removeLogo")}
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="company-logo-manager">
            <div className="company-logo-previews">
              <figure className="company-logo-figure">
                <figcaption>{t("storefront.branding.currentCover")}</figcaption>
                {storefront.coverUrl !== null ? (
                  <img
                    alt={t("storefront.branding.currentCover")}
                    className="company-logo-image storefront-cover-image"
                    src={storefront.coverUrl}
                  />
                ) : (
                  <span aria-hidden="true" className="company-logo-placeholder">
                    {t("storefront.branding.noCover")}
                  </span>
                )}
              </figure>
            </div>
            <div className="company-logo-controls">
              <p className="muted">{t("storefront.branding.coverHint")}</p>
              <input
                accept="image/png,image/jpeg,image/webp"
                aria-label={t("storefront.branding.chooseFile")}
                disabled={!canManage || busy}
                onChange={(event) =>
                  chooseBrandImage(event.target.files?.[0], setSelectedCoverFile, setCoverError)
                }
                ref={coverInputRef}
                type="file"
              />
              {coverError !== undefined ? (
                <p className="field-error" role="alert">
                  {t(coverError, t("common.operationFailed"))}
                </p>
              ) : null}
              <div className="company-logo-actions">
                <button
                  className="button button-primary"
                  disabled={selectedCoverFile === undefined || coverBusy || !canManage}
                  onClick={() => void uploadBrandImage("cover")}
                  type="button"
                >
                  {coverBusy
                    ? t("common.working")
                    : storefront.coverUrl !== null
                      ? t("storefront.branding.replaceCover")
                      : t("storefront.branding.uploadCover")}
                </button>
                {storefront.coverUrl !== null ? (
                  <button
                    className="button button-secondary"
                    disabled={coverBusy || !canManage}
                    onClick={() => void removeBrandImage("cover")}
                    type="button"
                  >
                    {t("storefront.branding.removeCover")}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </fieldset>

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
                className="button button-secondary"
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
            className="button button-secondary"
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
              className="button button-secondary"
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
              className="button button-secondary"
              disabled={busy}
              onClick={() => void runAction("remove-suspension")}
              type="button"
            >
              {t("storefront.actions.remove-suspension")}
            </button>
          ) : (
            <button
              className="button button-danger"
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
