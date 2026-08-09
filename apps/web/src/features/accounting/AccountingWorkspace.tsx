import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import { AccountingFocusContext } from "./accounting-focus.js";
import {
  AccountingOverview,
  AccountingConfigurationPage,
  LedgerPage,
  ReconciliationPage,
} from "./AccountingOperationsPages.js";
import { CashBankMovementsPage } from "./CashBankMovementsPage.js";
import { AccountingResourcePage } from "./AccountingResourcePage.js";
import { ExpensePaymentsPage } from "./ExpensePaymentsPage.js";
import { AccountingReportsWorkspace } from "./AccountingReportsWorkspace.js";
import { AccountingSetupWizard } from "./AccountingSetupWizard.js";
import { AccountingDashboardPage } from "./AccountingDashboardPage.js";
import { AutomaticPostingPage } from "./AutomaticPostingPage.js";
import { BatchOperationsPage } from "./BatchOperationsPage.js";
import { HistoricalRecoveryPage } from "./HistoricalRecoveryPage.js";
import { ClosingWorkflowsPage } from "./ClosingWorkflowsPage.js";
import { DailyCashActivityPage } from "./DailyCashActivityPage.js";
import { PaymentPositionPage } from "./PaymentPositionPage.js";
import type { AccountingRoute, AccountingSection } from "./accounting-types.js";

const sections: readonly AccountingSection[] = [
  "overview",
  "dashboard",
  "setup",
  "configuration",
  "mappings",
  "chart-of-accounts",
  "fiscal-years",
  "fiscal-periods",
  "journals",
  "opening-balances",
  "events",
  "expense-categories",
  "expenses",
  "expense-payments",
  "cash-accounts",
  "bank-accounts",
  "cash-bank-movements",
  "cashbook",
  "bank-ledger",
  "reconciliation",
  "backfill-preview",
  "automatic-posting",
  "reports",
  "daily-cash-activity",
  "payment-position",
  "closing-workflows",
  "batch-operations",
  "historical-recovery",
];

const navigationGroups = [
  {
    key: "setup",
    sections: [
      "configuration",
      "chart-of-accounts",
      "mappings",
      "fiscal-years",
      "fiscal-periods",
      "cash-accounts",
      "bank-accounts",
      // Expense Categories is setup data that General Expenses depend on, so
      // it belongs in Setup next to the other reference data — the route and
      // page already existed but were unreachable without this entry.
      "expense-categories",
      "opening-balances",
      // Automatic Posting areas: previously only reachable by scrolling deep
      // into the Setup Wizard, which was effectively undiscoverable.
      "automatic-posting",
    ],
  },
  {
    key: "transactions",
    sections: ["journals", "expenses", "expense-payments", "cash-bank-movements"],
  },
  {
    key: "monitoring",
    // Period Closing is a monitoring/control activity, not a transaction: it
    // records the process that precedes a close and posts nothing itself.
    // Batch Operations is a control activity: it plans and validates existing
    // single-item actions and executes none of them.
    sections: [
      "events",
      "reconciliation",
      "cashbook",
      "bank-ledger",
      "closing-workflows",
      "batch-operations",
      // Historical Recovery is a read-only preview of accounting gaps; it
      // belongs with the other control/monitoring surfaces.
      "historical-recovery",
    ],
  },
  { key: "reports", sections: ["reports", "daily-cash-activity", "payment-position"] },
] as const;

export function parseAccountingRoute(pathname: string): AccountingRoute {
  const parts = pathname
    .replace(/^\/accounting\/?/, "")
    .split("/")
    .filter(Boolean);
  const section = (parts[0] === undefined ? "overview" : parts[0]) as AccountingSection;
  if (!sections.includes(section)) return { section: "overview" };
  // `/accounting/<section>/new/<id>` preselects a record in a create form —
  // used by Record Payment, which opens the Payment form already pointed at
  // the Expense the User came from.
  if (parts[1] === "new") {
    return {
      mode: "new",
      section,
      ...(parts[2] === undefined ? {} : { id: decodeURIComponent(parts[2]) }),
    };
  }
  return {
    ...(parts[1] === undefined
      ? {}
      : { id: decodeURIComponent(parts[1]), mode: "detail" as const }),
    section,
  };
}

export function AccountingWorkspace({
  api,
  companyId,
  onNavigate,
  path,
  permissions,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly onNavigate: (path: string) => void;
  readonly path: string;
  readonly permissions: readonly string[];
}) {
  const { t } = useTranslation();
  const route = parseAccountingRoute(path);
  const common = { api, companyId, onNavigate, permissions };
  // Focus mode: a single record, editor or report fills the width with the
  // internal navigation hidden. Route-driven screens (a record id, a "new"
  // form, a selected report) resolve here; inline editors that live in local
  // state ask for it through AccountingFocusContext instead.
  const [childFocused, setChildFocused] = useState(false);
  // `mode` is set for both a selected record ("detail") and a "new" form, and
  // a chosen report reads as a detail of the reports section.
  const autoFocused = route.mode !== undefined || childFocused;
  // The menu also collapses on demand, so a wide LIST screen can be expanded
  // too — not just record/report screens. A manual choice wins over the
  // automatic one in both directions until the section changes.
  const [manualFocus, setManualFocus] = useState<boolean>();
  const focused = manualFocus ?? autoFocused;
  // Never strand the layout: changing section drops any inline-editor focus
  // and returns the menu to its automatic behaviour for the new screen.
  useEffect(() => {
    setChildFocused(false);
    setManualFocus(undefined);
  }, [route.section]);
  const requestFocus = useCallback((next: boolean) => setChildFocused(next), []);
  let content;
  switch (route.section) {
    case "overview":
      content = <AccountingOverview api={api} companyId={companyId} onNavigate={onNavigate} />;
      break;
    case "configuration":
      content = (
        <AccountingConfigurationPage
          api={api}
          companyId={companyId}
          onNavigate={onNavigate}
          permissions={permissions}
        />
      );
      break;
    case "setup":
      content = (
        <AccountingSetupWizard
          api={api}
          companyId={companyId}
          onNavigate={onNavigate}
          permissions={permissions}
        />
      );
      break;
    case "mappings":
      content = (
        <AccountingConfigurationPage
          api={api}
          companyId={companyId}
          onNavigate={onNavigate}
          permissions={permissions}
        />
      );
      break;
    case "cash-bank-movements":
      content = <CashBankMovementsPage {...common} id={route.id} mode={route.mode} />;
      break;
    case "cashbook":
      content = <LedgerPage api={api} companyId={companyId} kind="cash" />;
      break;
    case "bank-ledger":
      content = <LedgerPage api={api} companyId={companyId} kind="bank" />;
      break;
    case "reconciliation":
      content = <ReconciliationPage api={api} companyId={companyId} />;
      break;
    case "backfill-preview":
      content = <ReconciliationPage api={api} companyId={companyId} preview />;
      break;
    case "automatic-posting":
      content = <AutomaticPostingPage api={api} companyId={companyId} permissions={permissions} />;
      break;
    case "expense-payments":
      content = <ExpensePaymentsPage {...common} id={route.id} mode={route.mode} />;
      break;
    case "dashboard":
      content = <AccountingDashboardPage api={api} />;
      break;
    case "payment-position":
      content = <PaymentPositionPage api={api} />;
      break;
    case "daily-cash-activity":
      content = <DailyCashActivityPage api={api} />;
      break;
    case "closing-workflows":
      content = <ClosingWorkflowsPage {...common} id={route.id} />;
      break;
    case "batch-operations":
      content = <BatchOperationsPage {...common} id={route.id} />;
      break;
    case "historical-recovery":
      content = <HistoricalRecoveryPage {...common} />;
      break;
    case "reports":
      content = (
        <AccountingReportsWorkspace
          api={api}
          companyId={companyId}
          kind={route.id}
          onNavigate={onNavigate}
        />
      );
      break;
    default:
      content = <AccountingResourcePage {...common} id={route.id} section={route.section} />;
  }
  return (
    <AccountingFocusContext.Provider value={requestFocus}>
      <div
        className={`accounting-workspace${focused ? " accounting-workspace-focused" : ""}`}
        data-company-query-scope={companyId}
        key={companyId}
      >
        {focused ? null : (
          <aside className="accounting-internal-navigation">
            {/* Dashboard sits ABOVE Overview and is a separate screen: Overview
                is unchanged and still the default at /accounting. */}
            <NavLink
              className={({ isActive }) => (isActive ? "active" : "")}
              to="/accounting/dashboard"
            >
              {t("accounting.sections.dashboard")}
            </NavLink>
            <NavLink className={({ isActive }) => (isActive ? "active" : "")} end to="/accounting">
              {t("accounting.sections.overview")}
            </NavLink>
            <NavLink
              className={({ isActive }) => (isActive ? "active" : "")}
              to="/accounting/setup"
            >
              {t("accounting.setup.continue")}
            </NavLink>
            {navigationGroups.map((group) => (
              <details key={group.key} open>
                <summary>{t(`accounting.navigationGroups.${group.key}`)}</summary>
                {group.sections.map((section) => (
                  <NavLink
                    className={({ isActive }) => (isActive ? "active" : "")}
                    key={section}
                    to={`/accounting/${section}`}
                  >
                    {t(`accounting.sections.${section}`)}
                  </NavLink>
                ))}
              </details>
            ))}
          </aside>
        )}
        <main className="accounting-content">
          <button
            aria-expanded={!focused}
            className="accounting-menu-toggle"
            onClick={() => setManualFocus(!focused)}
            title={focused ? t("accounting.showMenu") : t("accounting.hideMenu")}
            type="button"
          >
            {focused ? (
              <PanelLeftOpen aria-hidden="true" size={18} />
            ) : (
              <PanelLeftClose aria-hidden="true" size={18} />
            )}
            <span>{focused ? t("accounting.showMenu") : t("accounting.hideMenu")}</span>
          </button>
          {content}
        </main>
      </div>
    </AccountingFocusContext.Provider>
  );
}
