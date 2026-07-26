import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { defaultLocale, readStoredLocale, supportedLocales } from "./locale.js";
import { arabicTranslations } from "./resources/ar.js";
import { englishTranslations } from "./resources/en.js";

export const i18nInstance = i18n.createInstance();

await i18nInstance.use(initReactI18next).init({
  fallbackLng: defaultLocale,
  interpolation: { escapeValue: false },
  lng: readStoredLocale(globalThis.localStorage),
  resources: {
    ar: { translation: arabicTranslations },
    en: { translation: englishTranslations },
  },
  supportedLngs: supportedLocales,
});
