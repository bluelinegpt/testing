import { createContext, useCallback, useContext, useEffect, type ReactNode } from "react";

import { storeI18n, type SupportedLanguage } from "../localization/i18n.js";

/**
 * Locale-prefixed URLs.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LANGUAGE IS IN THE PATH
 * ---------------------------------------------------------------------------
 *
 * A shopper who shares a Product link in Arabic expects the recipient to open
 * it in Arabic. If the language lives only in local storage or in a toggle, the
 * shared URL renders in whatever language the RECIPIENT last used, and the two
 * people are looking at different pages behind the same address.
 *
 * The same problem applies to crawlers, more permanently: `hreflang` alternates
 * must point at distinct URLs. Without a prefix there is exactly one URL per
 * page, the Arabic version is not addressable, and it is not indexable either.
 *
 * ---------------------------------------------------------------------------
 * WHY UNPREFIXED URLS STILL WORK
 * ---------------------------------------------------------------------------
 *
 * Links to `/{store-slug}` already exist — in the seed data, in the sitemap
 * generated before this change, and potentially wherever a Trader has pasted
 * their shop address. Those keep resolving, in the default language. The prefix
 * is additive: `/shop`, `/en/shop` and `/ar/shop` all resolve, and the canonical
 * tag names the prefixed form so crawlers converge on one address without any
 * existing link breaking.
 */

export const localePrefixes = ["en", "ar"] as const;

/**
 * `null` means the URL carried no prefix.
 *
 * Kept distinct from `"en"` on purpose: an unprefixed URL must not start
 * rewriting itself to a prefixed one mid-session, or the shopper's back button
 * lands on a URL they were never on.
 */
const LocalePrefixContext = createContext<SupportedLanguage | null>(null);

export function isLocalePrefix(value: string): value is SupportedLanguage {
  return (localePrefixes as readonly string[]).includes(value);
}

/**
 * Prefix a path for the active locale.
 *
 * Every in-app link goes through this. A link built by hand would silently drop
 * the shopper out of Arabic on the next navigation — the kind of bug that only
 * shows up on the second click, which is exactly the click nobody tests.
 */
export function useLocalePath(): (path: string) => string {
  const prefix = useContext(LocalePrefixContext);
  return useCallback(
    (path: string) => {
      if (prefix === null) return path;
      return path === "/" ? `/${prefix}` : `/${prefix}${path}`;
    },
    [prefix],
  );
}

/** The locale the URL asked for, or `null` when the URL did not say. */
export function useLocalePrefix(): SupportedLanguage | null {
  return useContext(LocalePrefixContext);
}

/**
 * Bind a subtree to a locale.
 *
 * The URL is the authority. A shopper arriving on `/ar/shop` from a shared
 * message gets Arabic regardless of what the toggle was last set to, because
 * the alternative — the URL saying one thing and the page showing another — is
 * indistinguishable from a broken link.
 */
export function LocaleScope({
  children,
  locale,
}: {
  readonly children: ReactNode;
  readonly locale: SupportedLanguage | null;
}) {
  useEffect(() => {
    if (locale !== null && storeI18n.language !== locale) {
      void storeI18n.changeLanguage(locale);
    }
  }, [locale]);

  return <LocalePrefixContext.Provider value={locale}>{children}</LocalePrefixContext.Provider>;
}

/**
 * Swap the locale prefix on the current path.
 *
 * Used by the language toggle so switching language keeps the shopper on the
 * page they were reading rather than returning them to the marketplace root.
 */
export function pathWithLocale(pathname: string, locale: SupportedLanguage): string {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const first = segments[0];
  if (first !== undefined && isLocalePrefix(first)) segments.shift();
  return `/${[locale, ...segments].join("/")}`;
}
