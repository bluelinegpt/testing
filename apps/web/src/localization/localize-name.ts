import type { SupportedLocale } from "./locale.js";

export interface BilingualName {
  readonly en?: string | null | undefined;
  readonly ar?: string | null | undefined;
}

function clean(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Display a bilingual business-data value in the user's Text Language.
 *
 * The preferred-language value is shown first; when it is missing the other
 * language is used as a controlled fallback so the caller never renders a blank
 * label. Returns an empty string only when neither language has a value.
 */
export function localizeName(textLanguage: SupportedLocale, name: BilingualName): string {
  const preferred = textLanguage === "ar" ? clean(name.ar) : clean(name.en);
  const fallback = textLanguage === "ar" ? clean(name.en) : clean(name.ar);
  return preferred ?? fallback ?? "";
}
