import {
  ChevronDown,
  CircleUserRound,
  ClipboardList,
  FileBarChart,
  Landmark,
  Gauge,
  LogOut,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShieldCheck,
  Store,
  Truck,
  X,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useLocation } from "react-router-dom";

import type { LoginResponse } from "../api/contracts.js";
import { normalizeLocale, storeLocale, type SupportedLocale } from "../localization/locale.js";
import type { ThemePreference } from "../theme/theme-preference.js";
import { useCompanyBranding } from "./CompanyBrandingContext.js";
import { canAccessCompanyPath, firstAuthorizedCompanyPath } from "./company-access.js";

function brandInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "•";
  return (
    (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")
  ).toUpperCase();
}

type MenuGroupId =
  | "orders"
  | "traders"
  | "drivers"
  | "accounting"
  | "configuration"
  | "administration"
  | "reports";

interface MenuItem {
  readonly icon?: LucideIcon;
  readonly label: string;
  readonly path: string;
}

interface MenuGroup {
  readonly icon: LucideIcon;
  readonly id: MenuGroupId;
  readonly items: readonly MenuItem[];
  readonly label: string;
}

const routeTitles: Readonly<Record<string, string>> = {
  "/dashboard": "nav.dashboard",
  "/orders": "nav.ordersList",
  "/orders/create": "nav.createOrder",
  "/orders/import": "nav.importOrders",
  "/trader-settlements": "nav.traderSettlements",
  "/trader-receivables": "nav.traderReceivables",
  "/drivers": "nav.driversList",
  "/cash-management": "nav.cashManagement",
  "/payroll": "nav.payroll",
  "/reports": "nav.reports",
  "/accounting": "nav.accounting",
  "/configuration/company-profile": "nav.companyProfile",
  "/configuration/storefront": "storefront.title",
  "/configuration/general": "nav.generalSettings",
  "/configuration/traders": "nav.tradersList",
  "/configuration/customers": "nav.customers",
  "/configuration/areas": "nav.areas",
  "/configuration/bank-accounts": "nav.bankAccounts",
  "/configuration/vat": "nav.vatSettings",
  "/configuration/employees": "workforce.employees",
  "/configuration/drivers": "workforce.drivers",
  "/configuration/users": "nav.users",
  "/configuration/roles": "nav.roles",
  "/support": "nav.supportCases",
  "/communication": "nav.communicationCenter",
  "/no-access": "shell.noAccessTitle",
};

const languages = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
] as const;

const themeOptions: readonly { code: ThemePreference; labelKey: string }[] = [
  { code: "light", labelKey: "theme.light" },
  { code: "dark", labelKey: "theme.dark" },
  { code: "system", labelKey: "theme.system" },
];

export function CompanyAppShell({
  children,
  onLogout,
  session,
}: {
  children: ReactNode;
  onLogout: () => Promise<void>;
  session: LoginResponse;
}) {
  const { i18n, t } = useTranslation();
  const location = useLocation();
  const branding = useCompanyBranding();
  const currentLanguage = normalizeLocale(i18n.resolvedLanguage);
  const companyName = branding.companyName === "" ? t("shell.companyPortal") : branding.companyName;
  const signedInDisplayName = session.identity.displayName?.trim() || session.identity.username;
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<MenuGroupId | undefined>(() =>
    groupForPath(location.pathname),
  );
  const drawerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const homePath = firstAuthorizedCompanyPath(session.identity.permissions);

  const groups = useMemo<readonly MenuGroup[]>(
    () =>
      (
        [
          {
            icon: ClipboardList,
            id: "orders",
            label: t("nav.orders"),
            items: [
              { label: t("nav.ordersList"), path: "/orders" },
              { label: t("nav.createOrder"), path: "/orders/create" },
              { label: t("nav.importOrders"), path: "/orders/import" },
            ],
          },
          {
            icon: Store,
            id: "traders",
            label: t("nav.traders"),
            items: [
              { label: t("nav.traderSettlements"), path: "/trader-settlements" },
              { label: t("nav.traderReceivables"), path: "/trader-receivables" },
            ],
          },
          {
            icon: Truck,
            id: "drivers",
            label: t("nav.drivers"),
            items: [{ label: t("nav.driversList"), path: "/drivers" }],
          },
          {
            icon: Landmark,
            id: "accounting",
            label: t("nav.accounting"),
            items: [
              { label: t("accounting.sections.overview"), path: "/accounting" },
              { label: t("nav.cashManagement"), path: "/cash-management" },
              { label: t("nav.payroll"), path: "/payroll" },
              {
                label: t("accounting.sections.chart-of-accounts"),
                path: "/accounting/chart-of-accounts",
              },
              {
                label: t("accounting.sections.cash-accounts"),
                path: "/accounting/cash-accounts",
              },
              {
                label: t("accounting.sections.bank-accounts"),
                path: "/accounting/bank-accounts",
              },
              { label: t("accounting.sections.journals"), path: "/accounting/journals" },
              { label: t("accounting.sections.events"), path: "/accounting/events" },
              { label: t("accounting.sections.expenses"), path: "/accounting/expenses" },
              {
                label: t("accounting.sections.cash-bank-movements"),
                path: "/accounting/cash-bank-movements",
              },
              {
                label: t("accounting.sections.reconciliation"),
                path: "/accounting/reconciliation",
              },
            ],
          },
          {
            icon: Settings,
            id: "configuration",
            label: t("nav.configuration"),
            items: [
              { label: t("nav.companyProfile"), path: "/configuration/company-profile" },
              { label: t("storefront.title"), path: "/configuration/storefront" },
              { label: t("nav.generalSettings"), path: "/configuration/general" },
              { label: t("nav.tradersList"), path: "/configuration/traders" },
              { label: t("nav.customers"), path: "/configuration/customers" },
              { label: t("nav.areas"), path: "/configuration/areas" },
              { label: t("nav.bankAccounts"), path: "/configuration/bank-accounts" },
              { label: t("nav.vatSettings"), path: "/configuration/vat" },
              { label: t("workforce.employees"), path: "/configuration/employees" },
              { label: t("nav.users"), path: "/configuration/users" },
              { label: t("nav.roles"), path: "/configuration/roles" },
            ],
          },
          {
            icon: ShieldCheck,
            id: "administration",
            label: t("nav.administration"),
            items: [
              { icon: MessageSquare, label: t("nav.communicationCenter"), path: "/communication" },
              { label: t("nav.supportCases"), path: "/support" },
            ],
          },
          {
            icon: FileBarChart,
            id: "reports",
            label: t("nav.reports"),
            items: [
              { label: t("nav.ordersExport"), path: "/reports" },
              {
                label: t("nav.dailyOperationsSummary"),
                path: "/reports/daily-operations-summary",
              },
            ],
          },
        ] satisfies readonly MenuGroup[]
      )
        .map((group) => ({
          ...group,
          items: group.items.filter((item) =>
            canAccessCompanyPath(item.path, session.identity.permissions),
          ),
        }))
        .filter((group) => group.items.length > 0),
    [session.identity.permissions, t],
  );

  const normalizedPath = normalizePath(location.pathname);
  const detailRouteTitle = normalizedPath.startsWith("/configuration/users/")
    ? "nav.users"
    : normalizedPath.startsWith("/configuration/roles/")
      ? "nav.roles"
      : normalizedPath.startsWith("/accounting")
        ? "nav.accounting"
        : undefined;
  const pageTitle = t(routeTitles[normalizedPath] ?? detailRouteTitle ?? "nav.dashboard");

  useEffect(() => {
    const group = groupForPath(location.pathname);
    if (group !== undefined) setExpandedGroup(group);
    setDrawerOpen(false);
    requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
  }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    const focusable = drawer?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    focusable?.[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab" || focusable === undefined || focusable.length === 0) return;
      const first = focusable.item(0);
      const last = focusable.item(focusable.length - 1);
      if (first === null || last === null) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [drawerOpen]);

  const changeLanguage = async (locale: SupportedLocale) => {
    await i18n.changeLanguage(locale);
    storeLocale(locale, globalThis.localStorage);
  };

  const changeTheme = async (theme: ThemePreference) => {
    await branding.setThemePreference(theme);
  };

  return (
    <div
      className={`company-shell${collapsed ? " company-shell-collapsed" : ""}${drawerOpen ? " drawer-is-open" : ""}`}
    >
      <button
        aria-label={t("shell.openNavigation")}
        className="mobile-menu-button"
        onClick={() => setDrawerOpen(true)}
        type="button"
      >
        <Menu aria-hidden="true" size={21} />
      </button>
      {drawerOpen ? (
        <button
          aria-label={t("shell.closeNavigation")}
          className="navigation-scrim"
          onClick={() => setDrawerOpen(false)}
          type="button"
        />
      ) : null}
      <aside aria-label={t("workspace.navigation")} className="app-sidebar" ref={drawerRef}>
        <div className="sidebar-brand-row">
          <NavLink aria-label={companyName} className="sidebar-brand" to={homePath}>
            {branding.logoUrl === undefined ? (
              <span className="brand-mark" aria-hidden="true">
                {brandInitials(companyName)}
              </span>
            ) : (
              <img alt="" aria-hidden="true" className="brand-logo" src={branding.logoUrl} />
            )}
            <span className="sidebar-brand-copy">
              <strong title={companyName}>{companyName}</strong>
              {branding.companySubtitle === undefined ? null : (
                <small title={branding.companySubtitle}>{branding.companySubtitle}</small>
              )}
            </span>
          </NavLink>
          {drawerOpen ? (
            <button
              aria-label={t("shell.closeNavigation")}
              className="sidebar-icon-button mobile-drawer-close"
              onClick={() => setDrawerOpen(false)}
              type="button"
            >
              <X aria-hidden="true" size={20} />
            </button>
          ) : null}
        </div>

        <nav className="primary-navigation">
          {canAccessCompanyPath("/dashboard", session.identity.permissions) ? (
            <NavLink className="nav-direct-link" to="/dashboard">
              <Gauge aria-hidden="true" size={19} />
              <span>{t("nav.dashboard")}</span>
            </NavLink>
          ) : null}
          {groups.slice(0, 4).map((group) => (
            <NavigationGroup
              expanded={expandedGroup === group.id}
              group={group}
              key={group.id}
              onToggle={() =>
                setExpandedGroup((current) => (current === group.id ? undefined : group.id))
              }
              pathname={location.pathname}
            />
          ))}
          {groups.slice(4).map((group) => (
            <NavigationGroup
              expanded={expandedGroup === group.id}
              group={group}
              key={group.id}
              onToggle={() =>
                setExpandedGroup((current) => (current === group.id ? undefined : group.id))
              }
              pathname={location.pathname}
            />
          ))}
        </nav>

        <div className="sidebar-footer">
          <button className="sidebar-logout-button" onClick={() => void onLogout()} type="button">
            <LogOut aria-hidden="true" size={18} />
            <span>{t("auth.logout")}</span>
          </button>
          <p className="powered-by">{t("shell.poweredBy")}</p>
        </div>
      </aside>

      <div className="company-main-column">
        <header className="company-top-header">
          <button
            aria-label={collapsed ? t("shell.expandSidebar") : t("shell.collapseSidebar")}
            className="sidebar-collapse-button"
            onClick={() => setCollapsed((value) => !value)}
            type="button"
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" size={20} />
            ) : (
              <PanelLeftClose aria-hidden="true" size={20} />
            )}
          </button>
          <div className="top-header-title">
            <span title={companyName}>{companyName}</span>
            <strong>{pageTitle}</strong>
          </div>
          <div className="top-header-controls">
            <div className="top-header-language" aria-label={t("language.label")} role="group">
              {languages.map((language) => (
                <button
                  aria-pressed={currentLanguage === language.code}
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
                  aria-pressed={branding.themePreference === theme.code}
                  key={theme.code}
                  onClick={() => void changeTheme(theme.code)}
                  type="button"
                >
                  {t(theme.labelKey)}
                </button>
              ))}
            </div>
            <div className="top-header-user">
              <CircleUserRound aria-hidden="true" size={20} />
              <span title={session.identity.username}>{signedInDisplayName}</span>
            </div>
          </div>
        </header>
        <main className="company-content" id="main-content" ref={mainRef} tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

function NavigationGroup({
  expanded,
  group,
  onToggle,
  pathname,
}: {
  expanded: boolean;
  group: MenuGroup;
  onToggle: () => void;
  pathname: string;
}) {
  const Icon = group.icon;
  const active = group.items.some((item) => pathMatches(pathname, item.path));
  return (
    <div className={`nav-group${active ? " nav-group-active" : ""}`}>
      <button
        aria-expanded={expanded}
        className="nav-group-button"
        onClick={onToggle}
        type="button"
      >
        <Icon aria-hidden="true" size={19} />
        <span>{group.label}</span>
        <ChevronDown aria-hidden="true" className="nav-chevron" size={16} />
      </button>
      {expanded ? (
        <div className="nav-submenu">
          {group.items.map((item) => (
            <NavLink className="nav-submenu-link" key={item.path} to={item.path}>
              {item.label}
            </NavLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function groupForPath(pathname: string): MenuGroupId | undefined {
  if (pathname.startsWith("/orders")) return "orders";
  if (pathname === "/trader-settlements" || pathname === "/trader-receivables") return "traders";
  if (pathname === "/drivers" || pathname === "/driver-cash-reconciliation") return "drivers";
  if (pathname === "/cash-management" || pathname === "/payroll") return "accounting";
  if (pathname.startsWith("/accounting")) return "accounting";
  if (pathname.startsWith("/configuration")) return "configuration";
  if (["/support"].includes(normalizePath(pathname))) return "administration";
  if (pathname.startsWith("/reports")) return "reports";
  return undefined;
}

function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function pathMatches(pathname: string, path: string): boolean {
  return normalizePath(pathname) === path;
}
