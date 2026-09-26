export const supportedLocales = ["en", "ar"] as const;

export type SupportedLocale = (typeof supportedLocales)[number];

export const defaultLocale: SupportedLocale = "en";
export const localeStorageKey = "blueline.locale";

export function normalizeLocale(value: string | null | undefined): SupportedLocale {
  return value?.toLowerCase().split("-")[0] === "ar" ? "ar" : defaultLocale;
}

export function directionForLocale(locale: SupportedLocale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}

/**
 * BCP-47 tag for the document's `lang` attribute -- deliberately more
 * specific than the bare locale code (`en`/`ar`) used everywhere else in the
 * app. Chromium's native `<input type="date">` picks its displayed day/month
 * order from the nearest ancestor's `lang` attribute: plain `en` renders
 * US-style mm/dd/yyyy, while `en-AE` (like nearly every English locale
 * outside the US) renders dd/mm/yyyy -- matching this business's own UAE
 * dates everywhere else in the app (the same region tag `formatDate`/
 * `formatCurrency` already resolve through, see `localeTags` in
 * `formatters.ts`).
 */
export function htmlLangForLocale(locale: SupportedLocale): string {
  return locale === "ar" ? "ar-AE" : "en-AE";
}

export function readStoredLocale(storage: Pick<Storage, "getItem"> | undefined): SupportedLocale {
  if (storage === undefined) return defaultLocale;

  try {
    return normalizeLocale(storage.getItem(localeStorageKey));
  } catch {
    return defaultLocale;
  }
}

export function storeLocale(
  locale: SupportedLocale,
  storage: Pick<Storage, "setItem"> | undefined,
): void {
  if (storage === undefined) return;

  try {
    storage.setItem(localeStorageKey, locale);
  } catch {
    // A blocked storage API must not prevent language switching.
  }
}
