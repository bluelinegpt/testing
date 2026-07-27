import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useCompanyBranding } from "../../app/CompanyBrandingContext.js";
import { PageHeader } from "../../components/PageHeader.js";
import type { SupportedLocale } from "../../localization/locale.js";

const languages = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
] as const;

/**
 * Self-service preferences for the signed-in user. Available to every
 * authenticated Company user (no company_profile.manage permission). It only
 * ever reads and writes the caller's own preference; changing the Search and
 * Display Text does not alter the UI language or layout direction.
 */
export function MyPreferencesWorkspace() {
  const { t } = useTranslation();
  const { setTextLanguage, textLanguage } = useCompanyBranding();
  const [saved, setSaved] = useState(false);

  const choose = async (language: SupportedLocale) => {
    setSaved(false);
    await setTextLanguage(language);
    setSaved(true);
  };

  return (
    <div className="workspace">
      <PageHeader title={t("preferences.title")} />
      <section className="configuration-panel preferences-card">
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
                  textLanguage === language.code
                    ? "button button-primary"
                    : "button button-secondary"
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
    </div>
  );
}
