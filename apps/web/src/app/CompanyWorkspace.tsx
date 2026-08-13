import { useEffect, useMemo } from "react";
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
import { ProductCatalogueWorkspace } from "../features/storefront/ProductCatalogueWorkspace.js";
import { StorefrontConfigurationWorkspace } from "../features/storefront/StorefrontConfigurationWorkspace.js";
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
import { DailyOperationsSummaryReport } from "../features/operations/DailyOperationsSummaryReport.js";
import { DriverCollectionsWorkspace } from "../features/operations/DriverCollectionsWorkspace.js";
import { PayrollWorkspace } from "../features/payroll/PayrollWorkspace.js";
import { AccountingWorkspace } from "../features/accounting/AccountingWorkspace.js";
import {
  OperationsWorkspace,
  type OperationsView,
} from "../features/operations/OperationsWorkspace.js";
import {
  OrderDetailsWorkspace,
  OrdersModuleWorkspace,
} from "../features/operations/OrdersModuleWorkspace.js";
import { TraderReceivablesWorkspace } from "../features/operations/TraderReceivablesWorkspace.js";
import { TraderSettlementsWorkspace } from "../features/operations/TraderSettlementsWorkspace.js";
import { DeploymentStatusPage } from "../features/administration/DeploymentStatusPage.js";
import { SupportWorkspace } from "../features/support/SupportWorkspace.js";
import { CommunicationCenter } from "../features/communication/CommunicationCenter.js";
import { CompanyAppShell } from "./CompanyAppShell.js";
import { CompanyBrandingProvider } from "./CompanyBrandingContext.js";
import { canAccessCompanyPath, firstAuthorizedCompanyPath } from "./company-access.js";
import { SessionAccessProvider } from "./SessionAccessContext.js";
import { WorkflowErrorBoundary } from "./WorkflowErrorBoundary.js";

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

  // Company, permissions and the navigator, published once so nested panels
  // (Related Records) do not have to be threaded through every dialog. Keyed
  // on the Company so switching it re-creates the value and invalidates every
  // consumer's cache rather than leaving another Company's data on screen.
  const sessionAccess = useMemo(
    () => ({
      companyId: session.identity.companyId,
      navigate: (target: string) => void navigate(target),
      permissions: session.identity.permissions,
    }),
    [navigate, session.identity.companyId, session.identity.permissions],
  );

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
  } else if (path === "/communication") {
    content = (
      <CommunicationCenter
        accessToken={session.accessToken}
        api={api}
        currentAccountId={session.identity.id}
        onNavigate={(target) => void navigate(target)}
        permissions={session.identity.permissions}
      />
    );
  } else if (path === "/orders") {
    content = (
      <OrdersModuleWorkspace
        api={api}
        onNavigate={(target) => void navigate(target)}
        permissions={session.identity.permissions}
      />
    );
  } else if (path === "/drivers" || path.startsWith("/drivers/collections/")) {
    // The list stays mounted underneath a route-opened detail, so Back returns
    // to it with its filters, sorting and page intact.
    content = (
      <DriverCollectionsWorkspace
        api={api}
        detailId={detailSegment(path, "/drivers/collections/")}
      />
    );
  } else if (path === "/trader-settlements" || path.startsWith("/trader-settlements/")) {
    const statementTraderId =
      new URLSearchParams(location.search).get("statementTraderId") ?? undefined;
    content = (
      <TraderSettlementsWorkspace
        api={api}
        detailId={detailSegment(path, "/trader-settlements/")}
        initialStatementOpen={new URLSearchParams(location.search).get("openStatement") === "true"}
        permissions={session.identity.permissions}
        presetTraderId={statementTraderId}
      />
    );
  } else if (path === "/trader-receivables" || path.startsWith("/trader-receivables/")) {
    // `/trader-receivables/collections/:id` is checked first; anything else
    // after the prefix is a Receivable, so the two can never be confused.
    const collectionId = detailSegment(path, "/trader-receivables/collections/");
    content = (
      <TraderReceivablesWorkspace
        api={api}
        collectionDetailId={collectionId}
        permissions={session.identity.permissions}
        receivableDetailId={
          collectionId === undefined ? detailSegment(path, "/trader-receivables/") : undefined
        }
      />
    );
  } else if (path === "/payroll" || path.startsWith("/payroll/")) {
    content = (
      <PayrollWorkspace
        api={api}
        feeAccrualDetailId={detailSegment(path, "/payroll/driver-fees/accruals/")}
        feePaymentDetailId={detailSegment(path, "/payroll/driver-fees/payments/")}
        onDetailClose={() => void navigate("/payroll")}
        paymentDetailId={detailSegment(path, "/payroll/payments/")}
        periodDetailId={detailSegment(path, "/payroll/periods/")}
        permissions={session.identity.permissions}
      />
    );
  } else if (path === "/accounting" || path.startsWith("/accounting/")) {
    content = (
      <AccountingWorkspace
        api={api}
        companyId={session.identity.companyId}
        onNavigate={(target) => void navigate(target)}
        path={path}
        permissions={session.identity.permissions}
      />
    );
  } else if (path === "/reports/daily-operations-summary") {
    content = <DailyOperationsSummaryReport api={api} onNavigate={(target) => void navigate(target)} />;
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
        companyId={session.identity.companyId}
        onBack={() => void navigate("/orders")}
        onNavigate={(target) => void navigate(target)}
        orderNumber={orderNumber}
        permissions={session.identity.permissions}
      />
    );
  } else if (path === "/configuration/company-profile") {
    content = <CompanyProfileWorkspace api={api} permissions={session.identity.permissions} />;
  } else if (path.startsWith("/configuration/storefront-products/")) {
    // The Storefront id is part of the path: a Company user manages one
    // Trader's catalogue at a time, and the API re-checks that ownership.
    const storefrontId = detailSegment(path, "/configuration/storefront-products/");
    content =
      storefrontId === undefined ? null : (
        <ProductCatalogueWorkspace
          api={api}
          permissions={session.identity.permissions}
          storefrontId={storefrontId}
        />
      );
  } else if (
    path === "/configuration/storefront" ||
    path.startsWith("/configuration/storefront/")
  ) {
    // The id segment is optional: a Trader account resolves its own Storefront
    // through `mine`, while a Company user opens a specific one.
    const storefrontId = detailSegment(path, "/configuration/storefront/");
    content = (
      <StorefrontConfigurationWorkspace
        api={api}
        permissions={session.identity.permissions}
        {...(storefrontId === undefined ? {} : { storefrontId })}
      />
    );
  } else if (path === "/configuration/general") {
    content = (
      <CompanyConfigurationWorkspace
        api={api}
        permissions={session.identity.permissions}
        view="general"
      />
    );
  } else if (path === "/configuration/areas") {
    content = (
      <CompanyConfigurationWorkspace
        api={api}
        permissions={session.identity.permissions}
        view="areas"
      />
    );
  } else if (path === "/configuration/bank-accounts") {
    content = (
      <CompanyConfigurationWorkspace
        api={api}
        permissions={session.identity.permissions}
        view="bank-accounts"
      />
    );
  } else if (path === "/configuration/vat") {
    content = (
      <CompanyConfigurationWorkspace
        api={api}
        permissions={session.identity.permissions}
        view="vat"
      />
    );
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
      <UsersConfigurationWorkspace
        api={api}
        initiallyCreating={new URLSearchParams(location.search).get("create") === "true"}
        onNavigate={(target) => void navigate(target)}
      />
    );
  } else if (path.startsWith("/configuration/users/")) {
    content = (
      <UserDetailsWorkspace
        api={api}
        accountId={decodeURIComponent(path.slice("/configuration/users/".length))}
        onBack={() => void navigate("/configuration/users")}
        onNavigate={(target) => void navigate(target)}
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
  } else if (path === "/administration/deployment-status") {
    content = <DeploymentStatusPage />;
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
    <SessionAccessProvider value={sessionAccess}>
      <CompanyBrandingProvider api={api}>
        <CompanyAppShell onLogout={onLogout} session={session}>
          <WorkflowErrorBoundary
            fallbackDescription={t("shell.workflowErrorDescription")}
            fallbackTitle={t("shell.workflowErrorTitle")}
            resetKey={path}
            retryLabel={t("common.tryAgain")}
          >
            {content}
          </WorkflowErrorBoundary>
        </CompanyAppShell>
      </CompanyBrandingProvider>
    </SessionAccessProvider>
  );
}

/**
 * The record identifier in a canonical detail route, or `undefined` when the
 * path is not that route.
 *
 * Returns a value only for a single non-empty segment directly after the
 * prefix, so `/trader-receivables/collections/<id>` can never be read as a
 * Receivable identifier and a trailing slash resolves to the list.
 */
function detailSegment(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (rest === "" || rest.includes("/")) return undefined;
  return decodeURIComponent(rest);
}

function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}
