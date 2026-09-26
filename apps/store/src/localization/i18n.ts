import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import { storeConfiguration } from "../config/environment.js";

import { ar } from "./resources/ar.js";
import { en } from "./resources/en.js";

/**
 * Store localization.
 *
 * A fresh i18next instance rather than the Delivery Portal's. The portal bundle
 * carries thousands of operational strings — settlements, reconciliation,
 * payroll, accounting — none of which a shopper will ever see, and importing it
 * would ship all of them to every customer while coupling the Store to the
 * portal's translation lifecycle.
 *
 * Direction is applied to the document element, not to a wrapper, so `dir`
 * cascades to portals, dialogs and anything else rendered outside the React
 * root. The stylesheet uses logical properties throughout, so RTL mirroring
 * follows from this one attribute rather than from a second set of rules.
 *
 * Trader content — Store names, Product descriptions — is NEVER machine
 * translated. It is shown exactly as the Trader wrote it; per-language Trader
 * content is a data model change for a later phase.
 */

export const supportedLanguages = ["en", "ar"] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

export function directionFor(language: string): "ltr" | "rtl" {
  return language.startsWith("ar") ? "rtl" : "ltr";
}

export function applyDocumentLanguage(language: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language;
  document.documentElement.dir = directionFor(language);
}

export const storeI18n = i18next.createInstance();

void storeI18n.use(initReactI18next).init({
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  lng: storeConfiguration.defaultLanguage,
  resources: { ar: { translation: ar }, en: { translation: en } },
  supportedLngs: [...supportedLanguages],
});

storeI18n.on("languageChanged", applyDocumentLanguage);
applyDocumentLanguage(storeConfiguration.defaultLanguage);
