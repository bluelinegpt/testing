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
