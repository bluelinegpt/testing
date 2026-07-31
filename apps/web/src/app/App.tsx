import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { ApiClient } from "../api/api-client.js";
import type { LoginResponse } from "../api/contracts.js";
import { LoginView } from "../features/authentication/LoginView.js";
import { PasswordChangeView } from "../features/authentication/PasswordChangeView.js";
import { PortalWorkspace } from "../features/portal/PortalWorkspace.js";
import { TrackingView } from "../features/tracking/TrackingView.js";
import {
  directionForLocale,
  normalizeLocale,
  storeLocale,
  type SupportedLocale,
} from "../localization/locale.js";
import { CompanyWorkspace } from "./CompanyWorkspace.js";
import { firstAuthorizedCompanyPath } from "./company-access.js";

const languages = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
] as const;

export function App() {
  const { i18n, t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const currentLanguage = normalizeLocale(i18n.resolvedLanguage);
  const api = useMemo(() => new ApiClient(), []);
  const [session, setSession] = useState<LoginResponse>();
  const trackingToken = trackingTokenFromPath(location.pathname);
  const [requestedPath] = useState(() => safeRequestedPath(location.pathname));

  useEffect(() => {
    document.documentElement.lang = currentLanguage;
    document.documentElement.dir = directionForLocale(currentLanguage);
  }, [currentLanguage]);

  const changeLanguage = async (locale: SupportedLocale) => {
    await i18n.changeLanguage(locale);
    storeLocale(locale, globalThis.localStorage);
  };

  const logout = async () => {
    try {
      await api.post<void>("auth/logout");
    } finally {
      api.setAccessToken(undefined);
      setSession(undefined);
      navigate(requestedPath, { replace: true });
    }
  };

  const authenticate = (authenticatedSession: LoginResponse) => {
    setSession(authenticatedSession);
    if (authenticatedSession.identity.kind === "company_user") {
      navigate(firstAuthorizedCompanyPath(authenticatedSession.identity.permissions), {
        replace: true,
      });
    }
  };

  if (session?.identity.kind === "company_user" && !session.identity.forcePasswordChange) {
    return <CompanyWorkspace api={api} onLogout={logout} session={session} />;
  }

  return (
    <div className="app-shell public-shell">
      <header className="topbar public-topbar">
        <div className="brand" aria-label="BluelineGPT">
          <span className="brand-mark" aria-hidden="true">
            B
          </span>
          <span>BluelineGPT</span>
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
              navigate(firstAuthorizedCompanyPath(session.identity.permissions), { replace: true });
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

function safeRequestedPath(pathname: string): string {
  if (trackingTokenFromPath(pathname) !== undefined) return "/dashboard";
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return "/dashboard";
  return pathname === "/" ? "/dashboard" : pathname;
}

function trackingTokenFromPath(pathname: string): string | undefined {
  const match = /^\/track\/([A-Za-z0-9_-]{43})\/?$/.exec(pathname);
  return match?.[1];
}
