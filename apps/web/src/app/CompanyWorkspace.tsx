import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import type { ApiClient } from "../api/api-client.js";
import type { LoginResponse } from "../api/contracts.js";
import {
  RoleDetailsWorkspace,
  RolesConfigurationWorkspace,
  UserDetailsWorkspace,
  UsersConfigurationWorkspace,
} from "../features/administration/UserRoleConfigurationWorkspace.js";
import { CompanyConfigurationWorkspace } from "../features/configuration/CompanyConfigurationWorkspace.js";
import { CompanyProfileWorkspace } from "../features/configuration/CompanyProfileWorkspace.js";
import {
  CustomerConfigurationWorkspace,
  CustomerDetailWorkspace,
} from "../features/configuration/CustomerConfigurationWorkspace.js";
import {
  WorkforceConfigurationWorkspace,
  WorkforceDetailWorkspace,
} from "../features/configuration/WorkforceConfigurationWorkspace.js";
import {
  TraderConfigurationWorkspace,
  TraderDetailWorkspace,
} from "../features/configuration/TraderConfigurationWorkspace.js";
import {
  DashboardWorkspace,
  type DashboardDrillDown,
} from "../features/dashboard/DashboardWorkspace.js";
import { DriverCollectionsWorkspace } from "../features/operations/DriverCollectionsWorkspace.js";
import {
  OperationsWorkspace,
  type OperationsView,
} from "../features/operations/OperationsWorkspace.js";
import {
  OrderDetailsWorkspace,
  OrdersModuleWorkspace,
} from "../features/operations/OrdersModuleWorkspace.js";
import { TraderSettlementsWorkspace } from "../features/operations/TraderSettlementsWorkspace.js";
import { SupportWorkspace } from "../features/support/SupportWorkspace.js";
import { CompanyAppShell } from "./CompanyAppShell.js";
import { CompanyBrandingProvider } from "./CompanyBrandingContext.js";
import { canAccessCompanyPath, firstAuthorizedCompanyPath } from "./company-access.js";

const redirects: Readonly<Record<string, string>> = {
  "/configuration": "/configuration/general",
  // Both retired stand-alone Driver-reconciliation entry points: Driver
  // Collections is now the single Drivers-menu destination (its own "New
  // Collection" dialog owns creation) — these preserve old bookmarks rather
  // than duplicating UI or leaving three different Driver entries in the nav.
  "/driver-cash-reconciliation": "/drivers",
  "/operations/driver-reconciliations/new": "/drivers",
  "/operations": "/orders",
  "/preferences": "/configuration/general",
  // Legacy route: the operational Trader view is now part of the Trader
  // Settlements workspace itself (outstanding balance is visible per Trader
  // there), so a dedicated /traders screen is no longer authoritative.
  "/traders": "/trader-settlements",
  "/users": "/configuration/users",
  "/roles": "/configuration/roles",
};

const dashboardTargets: Readonly<Record<DashboardDrillDown, string>> = {
  cash: "/cash-management",
  drivers: "/drivers",
  orders: "/orders",
  // Both drill-down tiles land on the one authoritative Trader Settlements
  // workspace — routed directly rather than through the /traders redirect.
  settlements: "/trader-settlements",
  traders: "/trader-settlements",
};

const operationRoutes: Readonly<
  Record<
    string,
    {
      intent?: "create-order" | "import-orders";
      sectionKey?: string;
      titleKey?: string;
      view: OperationsView;
    }
  >
> = {
  "/cash-management": { sectionKey: "nav.finance", titleKey: "nav.cashManagement", view: "cash" },
  "/orders": { view: "orders" },
  "/orders/create": { intent: "create-order", view: "orders" },
  "/orders/import": { intent: "import-orders", view: "orders" },
  "/reports": { view: "reports" },
};

export function CompanyWorkspace({
  api,
  onLogout,
  session,
}: {
  api: ApiClient;
  onLogout: () => Promise<void>;
  session: LoginResponse;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const path = normalizePath(location.pathname);
  const redirect =
    path === "/" ? firstAuthorizedCompanyPath(session.identity.permissions) : redirects[path];
  const authorized = canAccessCompanyPath(path, session.identity.permissions);

  useEffect(() => {
    if (redirect !== undefined) navigate(redirect, { replace: true });
  }, [navigate, redirect]);

  if (redirect !== undefined) return null;

  let content;
  if (!authorized) {
    content = (
      <section className="route-message" role="status">
        <h1>{t("shell.accessDenied")}</h1>
        <p>{t("shell.accessDeniedDescription")}</p>
      </section>
    );
  } else if (path === "/no-access") {
    content = (
      <section className="route-message" role="status">
        <h1>{t("shell.noAccessTitle")}</h1>
        <p>{t("shell.noAccessDescription")}</p>
      </section>
    );
  } else if (path === "/dashboard") {
    content = (
      <DashboardWorkspace api={api} onDrillDown={(target) => navigate(dashboardTargets[target])} />
    );
  } else if (path === "/orders") {
    content = (
      <OrdersModuleWorkspace
        api={api}
        onNavigate={(target) => void navigate(target)}
        permissions={session.identity.permissions}
      />
    );
  } else if (path === "/drivers") {
    content = <DriverCollectionsWorkspace api={api} />;
  } else if (path === "/trader-settlements") {
    content = (
      <TraderSettlementsWorkspace api={api} permissions={session.identity.permissions} />
    );
  } else if (operationRoutes[path] !== undefined) {
    const route = operationRoutes[path];
    content = (
      <OperationsWorkspace
        api={api}
        initialView={route.view}
        permissions={session.identity.permissions}
        onNavigate={(target) => {
          void navigate(target);
        }}
        {...(route.intent === undefined ? {} : { initialDialog: route.intent })}
        {...(route.sectionKey === undefined ? {} : { pageSectionKey: route.sectionKey })}
        {...(route.titleKey === undefined ? {} : { pageTitleKey: route.titleKey })}
      />
    );
  } else if (path.startsWith("/orders/")) {
    const orderNumber = decodeURIComponent(path.slice("/orders/".length));
    content = (
      <OrderDetailsWorkspace
        api={api}
        onBack={() => void navigate("/orders")}
        orderNumber={orderNumber}
        permissions={session.identity.permissions}
      />
    );
  } else if (path === "/configuration/company-profile") {
    content = <CompanyProfileWorkspace api={api} />;
  } else if (path === "/configuration/general") {
    content = <CompanyConfigurationWorkspace api={api} permissions={session.identity.permissions} view="general" />;
  } else if (path === "/configuration/areas") {
    content = <CompanyConfigurationWorkspace api={api} permissions={session.identity.permissions} view="areas" />;
  } else if (path === "/configuration/bank-accounts") {
    content = <CompanyConfigurationWorkspace api={api} permissions={session.identity.permissions} view="bank-accounts" />;
  } else if (path === "/configuration/vat") {
    content = <CompanyConfigurationWorkspace api={api} permissions={session.identity.permissions} view="vat" />;
  } else if (path === "/configuration/employees") {
    content = (
      <WorkforceConfigurationWorkspace
        api={api}
        kind="employees"
        onNavigate={(target) => void navigate(target)}
      />
    );
  } else if (path === "/configuration/drivers") {
    content = (
      <WorkforceConfigurationWorkspace
        api={api}
        kind="drivers"
        onNavigate={(target) => void navigate(target)}
      />
    );
  } else if (path === "/configuration/users") {
    content = (
      <UsersConfigurationWorkspace api={api} onNavigate={(target) => void navigate(target)} />
    );
  } else if (path.startsWith("/configuration/users/")) {
    content = (
      <UserDetailsWorkspace
        api={api}
        accountId={decodeURIComponent(path.slice("/configuration/users/".length))}
        onBack={() => void navigate("/configuration/users")}
      />
    );
  } else if (path === "/configuration/roles") {
    content = (
      <RolesConfigurationWorkspace api={api} onNavigate={(target) => void navigate(target)} />
    );
  } else if (path.startsWith("/configuration/roles/")) {
    content = (
      <RoleDetailsWorkspace
        api={api}
        roleId={decodeURIComponent(path.slice("/configuration/roles/".length))}
        onBack={() => void navigate("/configuration/roles")}
        onNavigate={(target) => void navigate(target)}
      />
    );
  } else if (path === "/configuration/traders") {
    content = (
      <TraderConfigurationWorkspace api={api} onNavigate={(target) => void navigate(target)} />
    );
  } else if (path.startsWith("/configuration/traders/")) {
    content = (
      <TraderDetailWorkspace
        api={api}
        code={decodeURIComponent(path.slice("/configuration/traders/".length))}
        onBack={() => void navigate("/configuration/traders")}
      />
    );
  } else if (path === "/configuration/customers") {
    content = (
      <CustomerConfigurationWorkspace api={api} onNavigate={(target) => void navigate(target)} />
    );
  } else if (path.startsWith("/configuration/customers/")) {
    content = (
      <CustomerDetailWorkspace
        api={api}
        code={decodeURIComponent(path.slice("/configuration/customers/".length))}
        onBack={() => void navigate("/configuration/customers")}
        onCreateOrder={() => void navigate("/orders/create")}
        onNavigate={(target) => void navigate(target)}
      />
    );
  } else if (path.startsWith("/configuration/employees/")) {
    content = (
      <WorkforceDetailWorkspace
        api={api}
        code={decodeURIComponent(path.slice("/configuration/employees/".length))}
        kind="employees"
        onBack={() => void navigate("/configuration/employees")}
        onNavigate={(target) => void navigate(target)}
      />
    );
  } else if (path.startsWith("/configuration/drivers/")) {
    content = (
      <WorkforceDetailWorkspace
        api={api}
        code={decodeURIComponent(path.slice("/configuration/drivers/".length))}
        kind="drivers"
        onBack={() => void navigate("/configuration/drivers")}
        onNavigate={(target) => void navigate(target)}
      />
    );
  } else if (path === "/support") {
    content = <SupportWorkspace api={api} />;
  } else {
    content = (
      <section className="route-message">
        <h1>{t("shell.pageNotFound")}</h1>
        <p>{t("shell.pageNotFoundDescription")}</p>
        <button
          className="button button-primary"
          onClick={() => navigate("/dashboard", { replace: true })}
          type="button"
        >
          {t("shell.returnToDashboard")}
        </button>
      </section>
    );
  }

  return (
    <CompanyBrandingProvider api={api}>
      <CompanyAppShell onLogout={onLogout} session={session}>
        {content}
      </CompanyAppShell>
    </CompanyBrandingProvider>
  );
}

function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}
