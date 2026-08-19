import { type ReactElement, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";

import { usePlatformSession } from "../app/PlatformSession.js";
import { VersionBadge } from "../components/VersionBadge.js";
import {
  type ThemePreference,
  applyThemePreference,
  readStoredPreference,
  resolveThemePreference,
  applyResolvedTheme,
} from "../theme/theme-preference.js";
import { AuditPage } from "./AuditPage.js";
import { CompaniesPage } from "./CompaniesPage.js";
import { CompanyDetailPage } from "./CompanyDetailPage.js";
import { CreateCompanyPage } from "./CreateCompanyPage.js";
import { DashboardPage } from "./DashboardPage.js";
import { DeploymentRegistryPage } from "./DeploymentRegistryPage.js";
import { ErrorsPage } from "./ErrorsPage.js";
import { IntegrityCheckPage } from "./IntegrityCheckPage.js";
import { DemoRequestsPage } from "./DemoRequestsPage.js";
import { TraderApplicationsPage } from "./TraderApplicationsPage.js";
import { CustomerQuotesPage } from "./CustomerQuotesPage.js";
import { WebsiteContentPage } from "./WebsiteContentPage.js";
import { AgentAdminPage } from "./AgentAdminPage.js";
import { CommerceIntegrationsPage } from "./CommerceIntegrationsPage.js";

interface NavigationItem {
  readonly label: string;
  readonly path: string;
  readonly permission: string;
}

/**
 * Navigation is filtered by permission — to decide what to SHOW, not what is
 * allowed. Every route behind these links is enforced again by the API, which
 * is the only boundary that counts. Hiding a link the server would refuse is
 * courtesy; relying on the hiding would be a vulnerability.
 */
const navigation: readonly NavigationItem[] = [
  { label: "Dashboard", path: "/", permission: "platform.access" },
  { label: "Companies", path: "/companies", permission: "platform.companies.read" },
  { label: "Website Leads", path: "/demo-requests", permission: "platform.leads.read" },
  { label: "Trader Applications", path: "/trader-applications", permission: "platform.trader_applications.read" },
  { label: "Customer Quotes", path: "/customer-quotes", permission: "platform.customer_quotes.read" },
  { label: "Website", path: "/website", permission: "platform.website.read" },
  { label: "Agent", path: "/agent", permission: "platform.agent.read" },
  { label: "Commerce Integrations", path: "/commerce-integrations", permission: "platform.access" },
  { label: "Audit", path: "/audit", permission: "platform.audit.read" },
  // Repo/deploy state, not Company data — gated on the same base permission
  // as Dashboard rather than a Company-scoped one.
  { label: "Deployment registry", path: "/deployment-registry", permission: "platform.access" },
  { label: "Error Handler", path: "/errors", permission: "platform.errors.read" },
  { label: "Integrity Checker", path: "/integrity", permission: "platform.integrity.read" },
];

const themeOptions: readonly { code: ThemePreference; label: string }[] = [
  { code: "light", label: "Light" },
  { code: "dark", label: "Dark" },
  { code: "system", label: "System" },
];

/**
 * The Light / Dark / System control, matching the Company Portal's.
 *
 * The initial value is read from storage rather than defaulted, because
 * `bootstrap-theme` has already applied it to the document before React
 * mounted — starting this state at "system" would leave the button highlight
 * disagreeing with the palette actually on screen.
 */
function ThemeControl(): ReactElement {
  const [preference, setPreference] = useState<ThemePreference>(() => readStoredPreference());

  // While the preference is "system", the OS switching (a scheduled night
  // shift, a manual toggle) must move the Portal with it. Without this the
  // choice would only be honoured on a full reload.
  useEffect(() => {
    if (preference !== "system") return undefined;
    if (typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => applyResolvedTheme(resolveThemePreference("system"));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  return (
    <div aria-label="Theme" className="platform-theme-control" role="group">
      {themeOptions.map((option) => (
        <button
          aria-pressed={preference === option.code}
          key={option.code}
          onClick={() => {
            setPreference(option.code);
            applyThemePreference(option.code);
          }}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function PlatformShell(): ReactElement {
  const session = usePlatformSession();
  const visible = navigation.filter((item) => session.can(item.permission));

  return (
    <div className="platform-shell">
      <header className="platform-header">
        <div>
          <p className="platform-header__eyebrow">TawseelHub</p>
          <div className="platform-header__title-row">
            <p className="platform-header__title">Platform Administration</p>
            <VersionBadge />
          </div>
        </div>
        <div className="platform-header__account">
          <ThemeControl />
          <span>{session.identity?.displayName}</span>
          <button
            className="platform-button platform-button--quiet"
            onClick={() => void session.signOut()}
            type="button"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="platform-body">
        <nav aria-label="Platform sections" className="platform-nav">
          {visible.map((item) => (
            <NavLink
              className={({ isActive }) =>
                isActive ? "platform-nav__link platform-nav__link--active" : "platform-nav__link"
              }
              end={item.path === "/"}
              key={item.path}
              to={item.path}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <main className="platform-content">
          <Routes>
            <Route element={<DashboardPage />} path="/" />
            {session.can("platform.companies.read") ? (
              <>
                <Route element={<CompaniesPage />} path="/companies" />
                {/* Creation is a separate route so the permission that gates
                    it is the one the API enforces, not the one that shows the
                    list. */}
                {session.can("platform.companies.manage") ? (
                  <Route element={<CreateCompanyPage />} path="/companies/new" />
                ) : null}
                <Route element={<CompanyDetailPage />} path="/companies/:companyId" />
              </>
            ) : null}
            {session.can("platform.audit.read") ? (
              <Route element={<AuditPage />} path="/audit" />
            ) : null}
            {session.can("platform.leads.read") ? (
              <><Route element={<DemoRequestsPage />} path="/demo-requests" /><Route element={<DemoRequestsPage />} path="/demo-requests/:demoRequestId" /></>
            ) : null}
            {session.can("platform.trader_applications.read") ? (
              <><Route element={<TraderApplicationsPage />} path="/trader-applications" /><Route element={<TraderApplicationsPage />} path="/trader-applications/:applicationId" /></>
            ) : null}
            {session.can("platform.customer_quotes.read") ? (
              <><Route element={<CustomerQuotesPage />} path="/customer-quotes" /><Route element={<CustomerQuotesPage />} path="/customer-quotes/:id" /></>
            ) : null}
            {session.can("platform.website.read") ? (
              <><Route element={<WebsiteContentPage />} path="/website" /><Route element={<WebsiteContentPage preview />} path="/website/:id/preview" /><Route element={<WebsiteContentPage />} path="/website/:id" /><Route element={<Navigate replace to="/website" />} path="/website-content" /><Route element={<WebsiteContentPage preview />} path="/website-content/:id/preview" /><Route element={<WebsiteContentPage />} path="/website-content/:id" /></>
            ) : null}
            {session.can("platform.agent.read") ? (
              <Route element={<AgentAdminPage />} path="/agent" />
            ) : null}
            <Route element={<CommerceIntegrationsPage />} path="/commerce-integrations" />
            <Route element={<DeploymentRegistryPage />} path="/deployment-registry" />
            {session.can("platform.errors.read") ? (
              <Route element={<ErrorsPage />} path="/errors" />
            ) : null}
            {session.can("platform.integrity.read") ? (
              <Route element={<IntegrityCheckPage />} path="/integrity" />
            ) : null}
            <Route element={<Navigate replace to="/" />} path="*" />
          </Routes>
        </main>
      </div>
    </div>
  );
}
