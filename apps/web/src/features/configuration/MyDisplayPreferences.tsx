import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useCompanyBranding } from "../../app/CompanyBrandingContext.js";
import type { SupportedLocale } from "../../localization/locale.js";

const languages = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
] as const;

/**
 * Per-user "Search and Display Text" preference, shown as its own section inside
 * General Settings. It is self-scoped: every authenticated user can view and
 * change only their own `accounts.preferred_language`. Switching it updates
 * business-data display immediately without changing the UI language or
 * layout direction, and requires no Company-settings permission.
 */
export function MyDisplayPreferences() {
  const { t } = useTranslation();
  const { setTextLanguage, textLanguage } = useCompanyBranding();
  const [saved, setSaved] = useState(false);

  const choose = async (language: SupportedLocale) => {
    setSaved(false);
    await setTextLanguage(language);
    setSaved(true);
  };

  return (
    <section className="configuration-panel my-display-preferences">
      <h2>{t("configuration.myDisplayPreferences")}</h2>
      <div className="preferences-field">
        <span className="preferences-label">{t("preferences.searchAndDisplayText")}</span>
        <p className="muted">{t("preferences.description")}</p>
        <div
          aria-label={t("preferences.searchAndDisplayText")}
          className="preferences-language"
          role="group"
        >
          {languages.map((language) => (
            <button
              aria-pressed={textLanguage === language.code}
              className={
                textLanguage === language.code ? "button button-primary" : "button button-secondary"
              }
              key={language.code}
              onClick={() => void choose(language.code)}
              type="button"
            >
              {language.label}
            </button>
          ))}
        </div>
        {saved ? (
          <p className="form-success" role="status">
            {t("preferences.saved")}
          </p>
        ) : null}
      </div>
    </section>
  );
}
