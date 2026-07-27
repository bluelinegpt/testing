import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ApiClient } from "../api/api-client.js";
import type { AccountPreferences, CompanyBranding } from "../api/contracts.js";
import type { SupportedLocale } from "../localization/locale.js";
import { type BilingualName, localizeName } from "../localization/localize-name.js";

interface CompanyBrandingContextValue {
  readonly branding: CompanyBranding | undefined;
  readonly companyName: string;
  readonly companySubtitle: string | undefined;
  readonly localize: (name: BilingualName) => string;
  readonly logoUrl: string | undefined;
  readonly refreshBranding: () => Promise<void>;
  readonly setTextLanguage: (language: SupportedLocale) => Promise<void>;
  readonly textLanguage: SupportedLocale;
}

export const CompanyBrandingContext = createContext<CompanyBrandingContextValue | undefined>(
  undefined,
);

export function CompanyBrandingProvider({
  api,
  children,
}: {
  api: ApiClient;
  children: ReactNode;
}) {
  const [branding, setBranding] = useState<CompanyBranding>();
  const [textLanguage, setTextLanguageState] = useState<SupportedLocale>("en");
  const [logoUrl, setLogoUrl] = useState<string | undefined>(undefined);
  const logoUrlRef = useRef<string | undefined>(undefined);

  const refreshBranding = useCallback(async () => {
    try {
      setBranding(await api.get<CompanyBranding>("company-profile/branding"));
    } catch {
      // Leave branding undefined; the portal falls back to safe placeholders.
    }
  }, [api]);

  useEffect(() => {
    void refreshBranding();
  }, [refreshBranding]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<AccountPreferences>("me/preferences")
      .then((preferences) => {
        if (!cancelled) setTextLanguageState(preferences.textLanguage);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Load the logo bytes through the authenticated endpoint and expose an object
  // URL. Keyed on the file id so a replaced logo is re-fetched (cache-bust) and
  // a removed logo clears the URL; the previous object URL is always revoked.
  const logoFileId = branding?.logoFileId ?? undefined;
  useEffect(() => {
    if (logoFileId === undefined) {
      if (logoUrlRef.current !== undefined) {
        URL.revokeObjectURL(logoUrlRef.current);
        logoUrlRef.current = undefined;
      }
      setLogoUrl(undefined);
      return;
    }
    let cancelled = false;
    api
      .getBinary("company-profile/logo")
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (logoUrlRef.current !== undefined) URL.revokeObjectURL(logoUrlRef.current);
        logoUrlRef.current = url;
        setLogoUrl(url);
      })
      .catch(() => {
        // A logo failure must never block the portal: fall back to initials.
        if (!cancelled) setLogoUrl(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [api, logoFileId]);

  useEffect(
    () => () => {
      if (logoUrlRef.current !== undefined) URL.revokeObjectURL(logoUrlRef.current);
    },
    [],
  );

  const setTextLanguage = useCallback(
    async (language: SupportedLocale) => {
      // Optimistic: update display immediately without a reload and without
      // touching the UI layout language or direction.
      setTextLanguageState(language);
      try {
        await api.patch<AccountPreferences>("me/preferences/text-language", {
          textLanguage: language,
        });
      } catch {
        // Keep the optimistic value; the next load reconciles from the server.
      }
    },
    [api],
  );

  const localize = useCallback(
    (name: BilingualName) => localizeName(textLanguage, name),
    [textLanguage],
  );

  const companyName = branding
    ? localize({ ar: branding.nameAr, en: branding.nameEn })
    : "";
  const companySubtitle = branding
    ? localize({ ar: branding.subtitleAr, en: branding.subtitleEn }) || undefined
    : undefined;

  const value = useMemo<CompanyBrandingContextValue>(
    () => ({
      branding,
      companyName,
      companySubtitle,
      localize,
      logoUrl,
      refreshBranding,
      setTextLanguage,
      textLanguage,
    }),
    [branding, companyName, companySubtitle, localize, logoUrl, refreshBranding, setTextLanguage, textLanguage],
  );

  return <CompanyBrandingContext.Provider value={value}>{children}</CompanyBrandingContext.Provider>;
}

/** Full branding context. Throws if used outside the provider (shell/profile page). */
export function useCompanyBranding(): CompanyBrandingContextValue {
  const value = useContext(CompanyBrandingContext);
  if (value === undefined) {
    throw new Error("useCompanyBranding must be used within a CompanyBrandingProvider");
  }
  return value;
}
