import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import { ApiError } from "../../api/api-client.js";
import type {
  BusinessDayConfiguration,
  BusinessDayWindow,
  CompanyBankAccount,
  CompanySettings,
} from "../../api/contracts.js";
import { PageHeader } from "../../components/PageHeader.js";
import { AreaWorkspace } from "./AreaWorkspace.js";
import { MyDisplayPreferences } from "./MyDisplayPreferences.js";

export type ConfigurationView = "general" | "areas" | "bank-accounts" | "vat";

export function CompanyConfigurationWorkspace({
  api,
  permissions,
  view,
}: {
  api: ApiClient;
  permissions: readonly string[];
  view: ConfigurationView;
}) {
  const { t } = useTranslation();
  // Company settings require the configuration permission; My Display
  // Preferences (below) is self-service and shown to every authenticated user.
  const canManageCompany = permissions.includes("users_roles.manage");
  const [settings, setSettings] = useState<CompanySettings>();
  const [bankAccounts, setBankAccounts] = useState<readonly CompanyBankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [createBankOpen, setCreateBankOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      // Company settings are only fetched when the user may manage them, so an
      // ordinary user opening General Settings for their own preference never
      // triggers a forbidden settings request.
      if ((view === "general" || view === "vat") && canManageCompany) {
        setSettings(await api.get<CompanySettings>("configuration/settings"));
      } else if (view === "bank-accounts") {
        setBankAccounts(
          await api.get<readonly CompanyBankAccount[]>("configuration/bank-accounts"),
        );
      }
      // AreaWorkspace loads and paginates Areas itself.
    } catch {
      setError(t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [api, canManageCompany, t, view]);

  useEffect(() => void load(), [load]);

  const updateBankStatus = async (account: CompanyBankAccount, isActive: boolean) => {
    setError(undefined);
    try {
      await api.patch<CompanyBankAccount>(`configuration/bank-accounts/${account.id}/status`, {
        isActive,
      });
      await load();
    } catch {
      setError(t("configuration.bankStatusFailed"));
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
          <>
            <button className="button button-secondary" onClick={() => void load()} type="button">
              {t("common.refresh")}
            </button>
            {/* Areas own their header action inside AreaWorkspace. */}
            {view === "bank-accounts" ? (
              <button
                className="button button-primary"
                onClick={() => setCreateBankOpen(true)}
                type="button"
              >
                {t("configuration.createBank")}
              </button>
            ) : null}
          </>
        }
        eyebrow={t("nav.configuration")}
        title={t(configurationTitleKey(view))}
      />
      <div className="data-surface configuration-surface">
        {settings === undefined || (view !== "general" && view !== "vat") ? null : (
          <SettingsPanel
            api={api}
            mode={view}
            settings={settings}
            onError={() => setError(t("configuration.settingsSaveFailed"))}
            onSaved={load}
          />
        )}
        {view === "general" ? (
          <BusinessCalendarPanel api={api} settings={settings} />
        ) : null}
        {view === "general" ? <MyDisplayPreferences /> : null}
        {view === "areas" ? <AreaWorkspace api={api} /> : null}
        {view === "bank-accounts" ? (
          <section className="stacked-section standalone-section">
            <h2>{t("configuration.banks")}</h2>
            <table>
              <thead>
                <tr>
                  <th>{t("configuration.bankName")}</th>
                  <th>{t("configuration.accountName")}</th>
                  <th>{t("configuration.iban")}</th>
                  <th>{t("configuration.status")}</th>
                  <th>
                    <span className="sr-only">{t("common.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {bankAccounts.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <strong>{account.bankName}</strong>
                      <span className="cell-secondary">{account.currency}</span>
                    </td>
                    <td>
                      {account.accountName}
                      {account.accountNumberMasked === null ? null : (
                        <span className="cell-secondary">{account.accountNumberMasked}</span>
                      )}
                    </td>
                    <td>{account.iban ?? "-"}</td>
                    <td>
                      <span className={`status status-${account.isActive ? "active" : "disabled"}`}>
                        {account.isActive ? t("status.active") : t("status.disabled")}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        {account.isActive ? (
                          <button
                            className="danger-link"
                            onClick={() => void updateBankStatus(account, false)}
                            type="button"
                          >
                            {t("configuration.deactivateBank")}
                          </button>
                        ) : (
                          <button
                            onClick={() => void updateBankStatus(account, true)}
                            type="button"
                          >
                            {t("configuration.activateBank")}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {bankAccounts.length === 0 ? (
                  <tr>
                    <td className="empty-state" colSpan={5}>
                      {t("configuration.noBanks")}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>
        ) : null}
        {loading ? <div className="loading-row">{t("common.loading")}</div> : null}
      </div>
      {createBankOpen ? (
        <CreateBankDialog
          api={api}
          onClose={() => setCreateBankOpen(false)}
          onSaved={async () => {
            setCreateBankOpen(false);
            await load();
          }}
        />
      ) : null}
    </>
  );
}

function SettingsPanel({
  api,
  mode,
  onError,
  onSaved,
  settings,
}: {
  api: ApiClient;
  mode: "general" | "vat";
  onError: () => void;
  onSaved: () => Promise<void>;
  settings: CompanySettings;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const vatEnabled = mode === "vat" ? form.get("vatEnabled") === "on" : settings.vatEnabled;
    setSaving(true);
    try {
      await api.patch<CompanySettings>("configuration/settings", {
        defaultLanguage:
          mode === "general"
            ? String(form.get("defaultLanguage") ?? settings.defaultLanguage)
            : settings.defaultLanguage,
        timezone:
          mode === "general"
            ? String(form.get("timezone") ?? settings.timezone)
            : settings.timezone,
        vatEnabled,
        vatPriceMode: vatEnabled
          ? mode === "vat"
            ? String(form.get("vatPriceMode") ?? settings.vatPriceMode ?? "exclusive")
            : (settings.vatPriceMode ?? "exclusive")
          : undefined,
        vatRate: vatEnabled
          ? mode === "vat"
            ? Number(form.get("vatRate") ?? settings.vatRate ?? 0)
            : Number(settings.vatRate ?? 0)
          : undefined,
      });
      await onSaved();
    } catch {
      onError();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="configuration-panel">
      <h2>{t(mode === "general" ? "nav.generalSettings" : "nav.vatSettings")}</h2>
      <form className="settings-form" onSubmit={(event) => void submit(event)}>
        {mode === "general" ? (
          <label className="field compact-field">
            <span>{t("configuration.defaultLanguage")}</span>
            <select defaultValue={settings.defaultLanguage} name="defaultLanguage">
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </label>
        ) : null}
        {mode === "general" ? (
          <label className="field compact-field">
            <span>{t("configuration.timezone")}</span>
            <input defaultValue={settings.timezone} maxLength={80} name="timezone" required />
          </label>
        ) : null}
        {mode === "vat" ? (
          <label className="toggle-row settings-toggle">
            <input defaultChecked={settings.vatEnabled} name="vatEnabled" type="checkbox" />
            <span>{t("configuration.vatEnabled")}</span>
          </label>
        ) : null}
        {mode === "vat" ? (
          <label className="field compact-field">
            <span>{t("configuration.vatRate")}</span>
            <input
              defaultValue={settings.vatRate ?? "5"}
              max="100"
              min="0"
              name="vatRate"
              step="0.0001"
              type="number"
            />
          </label>
        ) : null}
        {mode === "vat" ? (
          <label className="field compact-field">
            <span>{t("configuration.vatPriceMode")}</span>
            <select defaultValue={settings.vatPriceMode ?? "exclusive"} name="vatPriceMode">
              <option value="exclusive">{t("configuration.vatExclusive")}</option>
              <option value="inclusive">{t("configuration.vatInclusive")}</option>
            </select>
          </label>
        ) : null}
        <button className="button button-primary" disabled={saving} type="submit">
          {saving ? t("common.working") : t("common.save")}
        </button>
      </form>
    </section>
  );
}

/**
 * Business Calendar — the Company's business-day rule.
 *
 * Everything shown here is resolved by the backend. The browser never computes
 * a window: it would build one from the viewer's own clock and timezone, and
 * two people in different places would see different "today". The example
 * window below is exactly the window a report will query.
 */
function BusinessCalendarPanel({
  api,
  settings,
}: {
  api: ApiClient;
  settings: CompanySettings | undefined;
}) {
  const { t } = useTranslation();
  const [configurations, setConfigurations] = useState<readonly BusinessDayConfiguration[]>([]);
  const [window, setWindow] = useState<BusinessDayWindow>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    const rules = await api.get<readonly BusinessDayConfiguration[]>("configuration/business-day");
    setConfigurations(rules);
    const today = new Date().toISOString().slice(0, 10);
    setWindow(
      await api.get<BusinessDayWindow>(
        `configuration/business-day/window?businessDateFrom=${today}`,
      ),
    );
  }, [api]);

  useEffect(() => {
    void load().catch(() => setError(t("configuration.businessDay.loadFailed")));
  }, [load, t]);

  const current = configurations.find((rule) => rule.isCurrent);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    const form = new FormData(event.currentTarget);
    try {
      await api.post<BusinessDayConfiguration>("configuration/business-day", {
        businessDayStart: String(form.get("businessDayStart") ?? "08:00"),
        changeReason: String(form.get("changeReason") ?? ""),
        effectiveFrom: String(form.get("effectiveFrom") ?? ""),
        timezone: String(form.get("timezone") ?? "Asia/Dubai"),
      });
      setNotice(t("configuration.businessDay.saved"));
      await load();
    } catch (cause) {
      setError(message(cause, t("configuration.businessDay.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="configuration-panel">
      <h2>{t("configuration.businessDay.title")}</h2>
      <p>{t("configuration.businessDay.explanation")}</p>
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {notice === undefined ? null : <div className="alert alert-info">{notice}</div>}
      {/* The display timezone and the business-day timezone are separate on
          purpose — the business-day rule is effective-dated and must not be
          rewritten when a display preference changes. Divergence is legitimate,
          so this warns rather than blocks, and nothing is synchronised. */}
      {current === undefined ||
      settings === undefined ||
      settings.timezone === current.timezone ? null : (
        <div className="alert alert-warning" role="alert">
          {t("configuration.businessDay.timezoneDiverged", {
            businessDayTimezone: current.timezone,
            displayTimezone: settings.timezone,
          })}
        </div>
      )}

      <dl className="detail-grid">
        <div>
          <dt>{t("configuration.businessDay.companyTimezone")}</dt>
          <dd dir="ltr">{current?.timezone ?? "-"}</dd>
        </div>
        <div>
          <dt>{t("configuration.businessDay.startTime")}</dt>
          <dd dir="ltr">{current?.businessDayStart ?? "-"}</dd>
        </div>
        <div>
          <dt>{t("configuration.businessDay.duration")}</dt>
          <dd>{t("configuration.businessDay.durationValue")}</dd>
        </div>
        {window === undefined ? null : (
          <div>
            <dt>{t("configuration.businessDay.exampleWindow")}</dt>
            {/* Codes, dates and times stay LTR even in Arabic. */}
            <dd dir="ltr">
              {window.businessDateFrom} {window.businessDayStart} → {window.displayEnd}
            </dd>
          </div>
        )}
      </dl>

      {/* No Business Day End field: the end is always the next day at the same
          start time, so an editable end could only create a gap or an overlap. */}
      <form className="settings-form" onSubmit={(event) => void submit(event)}>
        <label className="field compact-field">
          <span>{t("configuration.businessDay.companyTimezone")}</span>
          <input
            defaultValue={current?.timezone ?? settings?.timezone ?? "Asia/Dubai"}
            dir="ltr"
            list="business-day-timezones"
            maxLength={80}
            name="timezone"
            required
          />
          <datalist id="business-day-timezones">
            {supportedTimezones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </label>
        <label className="field compact-field">
          <span>{t("configuration.businessDay.startTime")}</span>
          <input
            defaultValue={current?.businessDayStart ?? "08:00"}
            dir="ltr"
            name="businessDayStart"
            required
            type="time"
          />
        </label>
        <label className="field compact-field">
          <span>{t("configuration.businessDay.effectiveFrom")}</span>
          <input dir="ltr" name="effectiveFrom" required type="date" />
        </label>
        <label className="field compact-field">
          <span>{t("configuration.businessDay.changeReason")}</span>
          <input maxLength={500} name="changeReason" required />
        </label>
        <button className="button button-primary" disabled={saving} type="submit">
          {saving ? t("common.working") : t("common.save")}
        </button>
      </form>

      <section className="stacked-section">
        <h3>{t("configuration.businessDay.history")}</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("configuration.businessDay.effectiveFrom")}</th>
              <th>{t("configuration.businessDay.effectiveTo")}</th>
              <th>{t("configuration.businessDay.companyTimezone")}</th>
              <th>{t("configuration.businessDay.startTime")}</th>
              <th>{t("configuration.businessDay.changeReason")}</th>
            </tr>
          </thead>
          <tbody>
            {configurations.map((rule) => (
              <tr key={rule.id}>
                <td dir="ltr">
                  {rule.effectiveFrom ?? t("configuration.businessDay.sinceAlways")}
                </td>
                <td dir="ltr">{rule.effectiveTo ?? t("configuration.businessDay.openEnded")}</td>
                <td dir="ltr">{rule.timezone}</td>
                <td dir="ltr">{rule.businessDayStart}</td>
                <td>{rule.changeReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  );
}

/**
 * Offered as suggestions, not as the authority.
 *
 * The backend validates against the runtime's own IANA database, so a zone
 * missing from this list is still accepted if it is real — the list exists to
 * save typing, not to define what is legal.
 */
const supportedTimezones = [
  "Asia/Dubai",
  "Asia/Riyadh",
  "Asia/Kuwait",
  "Asia/Qatar",
  "Asia/Bahrain",
  "Asia/Muscat",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Europe/London",
  "UTC",
] as const;

/** Prefer the API's own explanation; fall back only when there is none. */
function message(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message.trim() !== "" ? error.message : fallback;
}

function configurationTitleKey(view: ConfigurationView): string {
  return {
    areas: "nav.areas",
    "bank-accounts": "nav.bankAccounts",
    general: "nav.generalSettings",
    vat: "nav.vatSettings",
  }[view];
}

function CreateBankDialog({
  api,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError(undefined);
    try {
      await api.post<CompanyBankAccount>("configuration/bank-accounts", {
        accountName: String(form.get("accountName") ?? ""),
        accountNumberMasked: optionalString(form.get("accountNumberMasked")),
        bankName: String(form.get("bankName") ?? ""),
        iban: optionalString(form.get("iban")),
        swiftCode: optionalString(form.get("swiftCode")),
      });
      await onSaved();
    } catch {
      setError(t("common.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section
        aria-labelledby="create-bank-title"
        aria-modal="true"
        className="modal modal-small"
        role="dialog"
      >
        <div className="modal-heading">
          <h2 id="create-bank-title">{t("configuration.createBank")}</h2>
          <button
            aria-label={t("common.close")}
            className="close-button"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {error === undefined ? null : <div className="alert alert-error">{error}</div>}
          <label className="field">
            <span>{t("configuration.bankName")}</span>
            <input maxLength={160} name="bankName" required />
          </label>
          <label className="field">
            <span>{t("configuration.accountName")}</span>
            <input maxLength={160} name="accountName" required />
          </label>
          <label className="field">
            <span>{t("configuration.accountNumberMasked")}</span>
            <input maxLength={64} name="accountNumberMasked" />
          </label>
          <label className="field">
            <span>{t("configuration.iban")}</span>
            <input maxLength={34} name="iban" />
          </label>
          <label className="field">
            <span>{t("configuration.swiftCode")}</span>
            <input maxLength={16} name="swiftCode" />
          </label>
          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button className="button button-primary" disabled={saving} type="submit">
              {saving ? t("common.working") : t("common.save")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function optionalString(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : undefined;
}
