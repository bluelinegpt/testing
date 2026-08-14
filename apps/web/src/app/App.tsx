import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { ApiClient } from "../api/api-client.js";
import type { LoginResponse } from "../api/contracts.js";
import { registerErrorReportingClient } from "../api/error-reporting-client.js";
import { AccountSetupView } from "../features/authentication/AccountSetupView.js";
import { LoginView } from "../features/authentication/LoginView.js";
import { PasswordChangeView } from "../features/authentication/PasswordChangeView.js";
import { PortalWorkspace } from "../features/portal/PortalWorkspace.js";
import { StorefrontApp } from "../storefront/StorefrontApp.js";
import { TrackingView } from "../features/tracking/TrackingView.js";
import {
  directionForLocale,
  normalizeLocale,
  storeLocale,
  type SupportedLocale,
} from "../localization/locale.js";
import {
  applyThemePreference,
  isThemePreference,
  type ThemePreference,
} from "../theme/theme-preference.js";
import { CompanyWorkspace } from "./CompanyWorkspace.js";
import { canAccessCompanyPath, firstAuthorizedCompanyPath } from "./company-access.js";

/** Exactly what `GET auth/me` returns: the server-revalidated identity. */
interface RestoredIdentity {
  readonly companyId: string | null;
  readonly displayName?: string;
  readonly forcePasswordChange: boolean;
  readonly identityId: string;
  readonly kind: LoginResponse["identity"]["kind"];
  readonly permissions: readonly string[];
  readonly username?: string;
}

const languages = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
] as const;

/**
 * The trader/driver portal has no Company branding context to persist a theme
 * preference server-side (that is a company-user feature), so the public shell
 * remembers the PREFERENCE locally. `blueline.theme` still caches only the
 * RESOLVED theme for the before-paint bootstrap; this key is the choice the
 * three buttons show.
 */
const THEME_PREFERENCE_STORAGE_KEY = "blueline.theme.preference";

const themeOptions: readonly { code: ThemePreference; labelKey: string }[] = [
  { code: "light", labelKey: "theme.light" },
  { code: "dark", labelKey: "theme.dark" },
  { code: "system", labelKey: "theme.system" },
];

function storedThemePreference(): ThemePreference {
  try {
    const value = globalThis.localStorage?.getItem(THEME_PREFERENCE_STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function App() {
  const { i18n, t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const currentLanguage = normalizeLocale(i18n.resolvedLanguage);
  const api = useMemo(() => {
    const client = new ApiClient();
    registerErrorReportingClient(client);
    return client;
  }, []);
  const [session, setSession] = useState<LoginResponse>();
  const [themePreference, setThemePreference] = useState<ThemePreference>(storedThemePreference);
  // True until the silent restoration attempt below has answered, so neither
  // the login form nor a protected page is shown on a guess.
  const [restoring, setRestoring] = useState(true);
  const trackingToken = trackingTokenFromPath(location.pathname);
  const [requestedPath] = useState(() => safeRequestedPath(location.pathname));

  // Public Trader Storefront PROTOTYPE. Intercepted before any session
  // handling, exactly like the public tracking view: a public visitor never
  // sees the login screen here, and a signed-in office user never gets the
  // portal shell wrapped around a public store page. Storefront paths are
  // also excluded from the post-login redirect (see safeRequestedPath), so
  // this changes nothing about how the authenticated application behaves.
  if (isStorefrontPath(location.pathname)) {
    return <StorefrontApp />;
  }

  // Account activation and password recovery, from a link a Platform
  // Administrator issued. Intercepted here for the same reason the public
  // Storefront and tracking views are: the person following the link has no
  // session yet and must not be shown the sign-in form instead of the page the
  // link was for. The token is read from the query and never persisted.
  const setupToken = accountSetupTokenFromLocation(location.pathname, location.search);
  if (setupToken !== undefined) {
    return <AccountSetupView token={setupToken} />;
  }

  useEffect(() => {
    document.documentElement.lang = currentLanguage;
    document.documentElement.dir = directionForLocale(currentLanguage);
  }, [currentLanguage]);

  // Applies the stored preference on mount and every change. The bootstrap
  // module already painted the CACHED resolved theme before React ran; this
  // re-resolves "system" against the current OS setting so the buttons and
  // the page never disagree.
  useEffect(() => {
    applyThemePreference(themePreference);
  }, [themePreference]);

  /**
   * Silent session restoration.
   *
   * The session token lives in an HttpOnly cookie, so page scripts cannot read
   * it — but the browser sends it. Asking `auth/me` on load is therefore the
   * only way to learn whether a session exists, and the server revalidates the
   * Company and permissions while answering. Until it answers, `restoring` is
   * true and the shell renders a neutral loading state: showing the login form
   * first would flash a sign-in screen at an already-authenticated user, and
   * rendering the workspace first would briefly expose a protected page.
   *
   * A failure is treated as "no session" and nothing more — an expired,
   * revoked or deactivated account simply lands on Sign in.
   */
  useEffect(() => {
    let active = true;
    api
      .get<RestoredIdentity>("auth/me")
      .then((identity) => {
        if (!active) return;
        setSession({
          accessToken: "",
          expiresAt: "",
          identity: {
            companyId: identity.companyId,
            displayName: identity.displayName ?? identity.username ?? "",
            forcePasswordChange: identity.forcePasswordChange,
            id: identity.identityId,
            kind: identity.kind,
            permissions: identity.permissions,
          },
        } as LoginResponse);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  const changeLanguage = async (locale: SupportedLocale) => {
    await i18n.changeLanguage(locale);
    storeLocale(locale, globalThis.localStorage);
  };

  const changeTheme = (preference: ThemePreference) => {
    setThemePreference(preference);
    applyThemePreference(preference);
    try {
      globalThis.localStorage?.setItem(THEME_PREFERENCE_STORAGE_KEY, preference);
    } catch {
      // Preference storage is best-effort; the applied theme still holds for
      // this session.
    }
  };

  const logout = async () => {
    try {
      // Revokes the server-side session AND clears the cookie. Client state is
      // dropped either way, so a failed call cannot leave a signed-out user
      // looking signed in.
      await api.post<void>("auth/logout");
    } finally {
      api.setAccessToken(undefined);
      setSession(undefined);
      navigate(requestedPath, { replace: true });
    }
  };

  /**
   * Where a company user lands after signing in.
   *
   * The URL they originally asked for is honoured when their permissions allow
   * it, so a shared or bookmarked detail link — `/trader-settlements/<id>`,
   * `/accounting/journals/<id>` — survives the login round trip instead of
   * dumping them on the default workspace. `requestedPath` is already captured
   * at mount and sanitised by `safeRequestedPath`; nothing is written to
   * browser storage, and permissions are still enforced on every request.
   */
  const landingPath = (permissions: readonly string[]) =>
    requestedPath !== "/dashboard" && canAccessCompanyPath(requestedPath, permissions)
      ? requestedPath
      : firstAuthorizedCompanyPath(permissions);

  const authenticate = (authenticatedSession: LoginResponse) => {
    setSession(authenticatedSession);
    if (authenticatedSession.identity.kind === "company_user") {
      navigate(landingPath(authenticatedSession.identity.permissions), { replace: true });
    }
  };

  // Neither the login form nor a protected page until restoration has answered.
  if (restoring) {
    return (
      <div className="app-shell public-shell">
        <main className="public-main" role="status">
          {t("common.loading")}
        </main>
      </div>
    );
  }

  if (session?.identity.kind === "company_user" && !session.identity.forcePasswordChange) {
    return <CompanyWorkspace api={api} onLogout={logout} session={session} />;
  }

  return (
    <div className="app-shell public-shell">
      <header className="topbar public-topbar">
        <div className="brand" aria-label="TawseelHub">
          <span className="brand-mark" aria-hidden="true">
            T
          </span>
          <span>TawseelHub</span>
        </div>
        <div className="topbar-actions">
          {session === undefined ? null : (
            <span className="signed-in-user">
              {session.identity.displayName ?? session.identity.username}
            </span>
          )}
          <div className="language-control" aria-label={t("language.label")} role="group">
            {languages.map((language) => (
              <button
                aria-pressed={currentLanguage === language.code}
                className="language-button"
                key={language.code}
                onClick={() => void changeLanguage(language.code)}
                type="button"
              >
                {language.label}
              </button>
            ))}
          </div>
          <div className="theme-control" aria-label={t("theme.label")} role="group">
            {themeOptions.map((theme) => (
              <button
                aria-pressed={themePreference === theme.code}
                key={theme.code}
                onClick={() => changeTheme(theme.code)}
                type="button"
              >
                {t(theme.labelKey)}
              </button>
            ))}
          </div>
        </div>
      </header>
      {session?.identity.forcePasswordChange ? (
        <PasswordChangeView
          api={api}
          onChanged={() => {
            setSession({
              ...session,
              identity: { ...session.identity, forcePasswordChange: false },
            });
            if (session.identity.kind === "company_user") {
              navigate(landingPath(session.identity.permissions), { replace: true });
            }
          }}
        />
      ) : trackingToken !== undefined ? (
        <TrackingView api={api} token={trackingToken} />
      ) : session === undefined ? (
        <LoginView api={api} onAuthenticated={authenticate} />
      ) : session.identity.kind === "trader" || session.identity.kind === "driver" ? (
        <PortalWorkspace api={api} onLogout={logout} session={session} />
      ) : null}
    </div>
  );
}

/**
 * The account-setup token, when the browser is on `/account-setup?token=…`.
 *
 * Returns undefined for anything else, so every other path behaves exactly as
 * it did before.
 */
function accountSetupTokenFromLocation(pathname: string, search: string): string | undefined {
  if (pathname.replace(/\/+$/, "") !== "/account-setup") return undefined;
  const token = new URLSearchParams(search).get("token")?.trim();
  return token === undefined || token === "" ? undefined : token;
}

function isStorefrontPath(pathname: string): boolean {
  return (
    pathname === "/store" ||
    pathname.startsWith("/store/") ||
    pathname === "/storefront-preview" ||
    pathname.startsWith("/storefront-preview/")
  );
}

function safeRequestedPath(pathname: string): string {
  // Public pages are never preserved as a login destination: a user signing
  // in should land in the office, not on a tracking or storefront page.
  if (trackingTokenFromPath(pathname) !== undefined) return "/dashboard";
  if (isStorefrontPath(pathname)) return "/dashboard";
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return "/dashboard";
  return pathname === "/" ? "/dashboard" : pathname;
}

function trackingTokenFromPath(pathname: string): string | undefined {
  const match = /^\/track\/([A-Za-z0-9_-]{43})\/?$/.exec(pathname);
  return match?.[1];
}
