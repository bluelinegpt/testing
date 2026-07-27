import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import type { CompanyBankAccount, CompanySettings } from "../../api/contracts.js";
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
