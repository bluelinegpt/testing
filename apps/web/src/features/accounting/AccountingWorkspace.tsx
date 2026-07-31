import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import { AccountingOverview, AccountingConfigurationPage, CashBankMovementsPage, LedgerPage, ReconciliationPage } from "./AccountingOperationsPages.js";
import { AccountingResourcePage } from "./AccountingResourcePage.js";
import { ExpensePaymentsPage } from "./ExpensePaymentsPage.js";
import { AccountingReportsWorkspace } from "./AccountingReportsWorkspace.js";
import { AccountingSetupWizard } from "./AccountingSetupWizard.js";
import type { AccountingRoute, AccountingSection } from "./accounting-types.js";

const sections: readonly AccountingSection[] = [
  "overview",
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
  "reports",
];

const navigationGroups = [
  { key: "setup", sections: ["configuration","chart-of-accounts","mappings","fiscal-years","fiscal-periods","opening-balances"] },
  { key: "transactions", sections: ["journals","expenses","expense-payments","cash-bank-movements"] },
  { key: "monitoring", sections: ["events","reconciliation","cashbook","bank-ledger"] },
  { key: "reports", sections: ["reports"] },
] as const;

export function parseAccountingRoute(pathname: string): AccountingRoute {
  const parts = pathname.replace(/^\/accounting\/?/, "").split("/").filter(Boolean);
  const section = (parts[0] === undefined ? "overview" : parts[0]) as AccountingSection;
  if (!sections.includes(section)) return { section: "overview" };
  if (parts[1] === "new") return { mode: "new", section };
  return { ...(parts[1] === undefined ? {} : { id: decodeURIComponent(parts[1]), mode: "detail" as const }), section };
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
  let content;
  switch (route.section) {
    case "overview":
      content = <AccountingOverview api={api} companyId={companyId} onNavigate={onNavigate} />;
      break;
    case "configuration":
      content = <AccountingConfigurationPage api={api} companyId={companyId} onNavigate={onNavigate} permissions={permissions} />;
      break;
    case "setup":
      content = <AccountingSetupWizard api={api} companyId={companyId} onNavigate={onNavigate} permissions={permissions} />;
      break;
    case "mappings":
      content = <AccountingConfigurationPage api={api} companyId={companyId} onNavigate={onNavigate} permissions={permissions} />;
      break;
    case "cash-bank-movements":
      content = <CashBankMovementsPage {...common} id={route.id} />;
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
    case "expense-payments":
      content = <ExpensePaymentsPage {...common} id={route.id} />;
      break;
    case "reports":
      content = <AccountingReportsWorkspace api={api} companyId={companyId} kind={route.id} onNavigate={onNavigate} />;
      break;
    default:
      content = <AccountingResourcePage {...common} id={route.id} section={route.section} />;
  }
  return (
    <div className="accounting-workspace" data-company-query-scope={companyId} key={companyId}>
      <aside className="accounting-internal-navigation">
        <NavLink className={({ isActive }) => isActive ? "active" : ""} end to="/accounting">
          {t("accounting.sections.overview")}
        </NavLink>
        <NavLink className={({ isActive }) => isActive ? "active" : ""} to="/accounting/setup">
          {t("accounting.setup.continue")}
        </NavLink>
        {navigationGroups.map((group) => (
          <details key={group.key} open>
            <summary>{t(`accounting.navigationGroups.${group.key}`)}</summary>
            {group.sections.map((section) => (
              <NavLink className={({ isActive }) => isActive ? "active" : ""} key={section}
                to={`/accounting/${section}`}>{t(`accounting.sections.${section}`)}</NavLink>
            ))}
          </details>
        ))}
      </aside>
      <main className="accounting-content">{content}</main>
    </div>
  );
}
