import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import { PageHeader } from "../../components/PageHeader.js";
// Cash and Bank Movements moved to their own screen
// (`CashBankMovementsPage.tsx`); the imports it alone used are gone with it.
import {
  AccountingTable,
  LoadPanel,
  RecordDetail,
  RecordForm,
  StatusBadge,
  SummaryCards,
  accountingPermissions,
  formatAed,
} from "./AccountingComponents.js";
import { AccountingApi, accountingQueryKey } from "./accounting-api.js";
import { useAccountingFocus } from "./accounting-focus.js";
import type { AccountingPage, AccountingRecord, FieldDefinition } from "./accounting-types.js";
import { useAccountingResource } from "./use-accounting-resource.js";

function useClient(api: ApiClient) {
  return useMemo(() => new AccountingApi(api), [api]);
}

interface OverviewMetric {
  readonly key: string;
  readonly money?: boolean;
}

interface OverviewPanelDefinition {
  readonly metrics: readonly OverviewMetric[];
  readonly name: string;
  readonly path: string;
}

const configurationAccountLabels: Readonly<Record<string, string>> = {
  currentYearEarningsAccountId: "Current Year Earnings Account",
  defaultAccountsPayableAccountId: "Accounts Payable Account",
  defaultAccountsReceivableAccountId: "Accounts Receivable Account",
  defaultBankAccountId: "Default Bank Account",
  defaultCashAccountId: "Default Cash Account",
  defaultDeliveryRevenueAccountId: "Delivery Revenue Account",
  defaultOutsourcedDriverPayableAccountId: "Outsourced Driver Payable Account",
  defaultPayrollPayableAccountId: "Payroll Payable Account",
  defaultRoundingAccountId: "Default Rounding Account",
  defaultServiceFeeRevenueAccountId: "Service Fee Revenue Account",
  defaultTraderPayableAccountId: "Trader Payable Account",
  defaultVatInputAccountId: "Input VAT Account",
  defaultVatOutputAccountId: "Output VAT Account",
  retainedEarningsAccountId: "Retained Earnings Account",
};

const configurationAccountFields = Object.keys(configurationAccountLabels);
const configurationAccountSections: Readonly<Record<string, string>> = {
  currentYearEarningsAccountId: "equity",
  defaultAccountsPayableAccountId: "receivablesPayables",
  defaultAccountsReceivableAccountId: "receivablesPayables",
  defaultBankAccountId: "cashBank",
  defaultCashAccountId: "cashBank",
  defaultDeliveryRevenueAccountId: "revenue",
  defaultOutsourcedDriverPayableAccountId: "receivablesPayables",
  defaultPayrollPayableAccountId: "receivablesPayables",
  defaultRoundingAccountId: "equity",
  defaultServiceFeeRevenueAccountId: "revenue",
  defaultTraderPayableAccountId: "receivablesPayables",
  defaultVatInputAccountId: "vat",
  defaultVatOutputAccountId: "vat",
  retainedEarningsAccountId: "equity",
};

function recordText(record: AccountingRecord, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value);
  }
  return "";
}

function normalizeAccountToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function normalizedAccountClass(record: AccountingRecord): string {
  return normalizeAccountToken(recordText(record, "accountClass", "account_class", "class"));
}

function normalizedAccountType(record: AccountingRecord): string {
  return normalizeAccountToken(recordText(record, "accountType", "account_type", "type"));
}

function accountCode(record: AccountingRecord): string {
  return recordText(record, "code", "accountCode", "account_code");
}

function accountLabel(record: AccountingRecord, language: string): string {
  const code = accountCode(record);
  const nameEn = recordText(
    record,
    "accountNameEn",
    "nameEn",
    "account_name_en",
    "displayName",
    "display_name",
    "name",
  );
  const nameAr = recordText(record, "accountNameAr", "nameAr", "account_name_ar");
  const name = language.toLowerCase().startsWith("ar") ? nameAr || nameEn : nameEn || nameAr;
  return code === "" ? name : `${code} — ${name}`;
}

function accountSearchText(record: AccountingRecord): string {
  return [
    recordText(record, "code", "accountCode", "account_code"),
    recordText(
      record,
      "accountNameEn",
      "nameEn",
      "account_name_en",
      "displayName",
      "display_name",
      "name",
    ),
    recordText(record, "accountNameAr", "nameAr", "account_name_ar"),
  ]
    .filter((value) => value !== "")
    .join(" ")
    .toLowerCase();
}

function recordBoolean(record: AccountingRecord, ...keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "y"].includes(normalized)) return true;
      if (["false", "0", "no", "n"].includes(normalized)) return false;
    }
  }
  return undefined;
}

function isActivePostingAccount(record: AccountingRecord): boolean {
  const posting = recordBoolean(
    record,
    "isPostingAccount",
    "is_posting_account",
    "postingAccount",
    "posting",
    "isPosting",
  );
  const active = recordBoolean(record, "isActive", "is_active", "active", "enabled");
  return (
    posting === true &&
    active !== false &&
    recordText(record, "status").toLowerCase() !== "inactive"
  );
}

function accountClassifierText(record: AccountingRecord): string {
  return [
    normalizedAccountType(record),
    normalizedAccountClass(record),
    normalizeAccountToken(recordText(record, "systemPurpose", "system_purpose")),
    normalizeAccountToken(recordText(record, "controlAccountType", "control_account_type")),
    normalizeAccountToken(accountLabel(record, "en")),
  ]
    .filter((value) => value !== "")
    .join(" ");
}

function accountTypeMatches(record: AccountingRecord, ...types: readonly string[]): boolean {
  const value = normalizedAccountType(record);
  return types.some((type) => value === normalizeAccountToken(type));
}

function accountMatches(record: AccountingRecord, ...terms: readonly string[]): boolean {
  const value = accountClassifierText(record);
  return terms.some((term) => value.includes(normalizeAccountToken(term)));
}

interface AccountCompatibilityRule {
  readonly fallbackTypes: readonly string[];
  readonly preferredCodes?: readonly string[];
  readonly preferredTerms: readonly string[];
}

const configurationAccountCompatibility: Readonly<Record<string, AccountCompatibilityRule>> = {
  currentYearEarningsAccountId: {
    fallbackTypes: ["equity"],
    preferredCodes: ["3010"],
    preferredTerms: ["current_year_earnings", "current_year", "earnings"],
  },
  defaultAccountsPayableAccountId: {
    fallbackTypes: ["liability"],
    preferredCodes: ["2030"],
    preferredTerms: ["accounts_payable", "account_payable", "payable"],
  },
  defaultAccountsReceivableAccountId: {
    fallbackTypes: ["asset"],
    preferredCodes: ["1100"],
    preferredTerms: ["accounts_receivable", "account_receivable", "receivable"],
  },
  defaultBankAccountId: {
    fallbackTypes: ["asset"],
    preferredCodes: ["1010"],
    preferredTerms: ["bank"],
  },
  defaultCashAccountId: {
    fallbackTypes: ["asset"],
    preferredCodes: ["1000"],
    preferredTerms: ["cash"],
  },
  defaultDeliveryRevenueAccountId: {
    fallbackTypes: ["revenue", "income"],
    preferredCodes: ["4000"],
    preferredTerms: ["delivery_revenue", "delivery", "revenue"],
  },
  defaultOutsourcedDriverPayableAccountId: {
    fallbackTypes: ["liability"],
    preferredCodes: ["2010"],
    preferredTerms: ["outsourced_driver_payable", "driver_payable", "outsourced_driver", "payable"],
  },
  defaultPayrollPayableAccountId: {
    fallbackTypes: ["liability"],
    preferredCodes: ["2020"],
    preferredTerms: ["payroll_payable", "salary_payable", "payroll", "payable"],
  },
  defaultRoundingAccountId: {
    fallbackTypes: ["expense"],
    preferredCodes: ["5090"],
    preferredTerms: ["rounding", "other_expense", "expense"],
  },
  defaultServiceFeeRevenueAccountId: {
    fallbackTypes: ["revenue", "income"],
    preferredCodes: ["4010"],
    preferredTerms: ["service_fee_revenue", "service_fee", "revenue"],
  },
  defaultTraderPayableAccountId: {
    fallbackTypes: ["liability"],
    preferredCodes: ["2000"],
    preferredTerms: ["trader_payable", "payable"],
  },
  defaultVatInputAccountId: {
    fallbackTypes: ["asset"],
    preferredCodes: ["1110"],
    preferredTerms: [
      "input_vat_receivable",
      "vat_receivable",
      "input_vat",
      "vat",
      "tax",
      "receivable",
    ],
  },
  defaultVatOutputAccountId: {
    fallbackTypes: ["liability"],
    preferredCodes: ["2040"],
    preferredTerms: ["output_vat_payable", "vat_payable", "output_vat", "vat", "tax", "payable"],
  },
  retainedEarningsAccountId: {
    fallbackTypes: ["equity"],
    preferredCodes: ["3000"],
    preferredTerms: ["retained_earnings", "retained", "earnings"],
  },
};

function accountCodeMatches(
  record: AccountingRecord,
  codes: readonly string[] | undefined,
): boolean {
  if (codes === undefined || codes.length === 0) return false;
  return codes.includes(accountCode(record));
}

function toAccountOption(
  record: AccountingRecord,
  language: string,
): { readonly label: string; readonly searchText: string; readonly value: string } | undefined {
  const value = String(record.id ?? "").trim();
  const label = accountLabel(record, language);
  if (value === "" || label === "") return undefined;
  return { label, searchText: accountSearchText(record), value };
}

function compatibleAccounts(
  records: readonly AccountingRecord[],
  fieldName: string,
  language: string,
): readonly { readonly label: string; readonly searchText: string; readonly value: string }[] {
  const active = records.filter(isActivePostingAccount);
  const rule = configurationAccountCompatibility[fieldName];
  if (rule === undefined) return [];

  const fallback = active.filter((record) =>
    rule.fallbackTypes.some((type) => accountTypeMatches(record, type)),
  );
  const preferred = fallback.filter(
    (record) =>
      accountCodeMatches(record, rule.preferredCodes) ||
      accountMatches(record, ...rule.preferredTerms),
  );
  const selected = preferred.length > 0 ? preferred : fallback;

  return selected
    .map((record) => toAccountOption(record, language))
    .filter(
      (
        option,
      ): option is {
        readonly label: string;
        readonly searchText: string;
        readonly value: string;
      } => option !== undefined,
    );
}

function extractAccountRows(
  data: readonly AccountingRecord[] | AccountingPage | undefined,
): readonly AccountingRecord[] {
  if (data === undefined) return [];
  if (Array.isArray(data)) return data;
  if ("items" in data && Array.isArray(data.items)) return data.items;
  return [];
}

function normalizeConfigurationInitial(
  data: AccountingRecord | undefined,
  accounts: readonly AccountingRecord[],
  companyCurrency: string,
): AccountingRecord {
  const normalized: Record<string, unknown> = {
    ...(data ?? { defaultAccountingMethod: "accrual", fiscalYearStartMonth: 1 }),
    baseCurrency: companyCurrency,
  };
  delete normalized.defaultSuspenseAccountId;

  for (const fieldName of configurationAccountFields) {
    const rawValue = String(normalized[fieldName] ?? "").trim();
    if (rawValue === "") {
      normalized[fieldName] = null;
      continue;
    }
    if (accounts.some((record) => String(record.id) === rawValue)) continue;

    const matchingAccount = accounts.find(
      (record) =>
        accountCode(record) === rawValue ||
        accountLabel(record, "en") === rawValue ||
        accountLabel(record, "ar") === rawValue,
    );
    normalized[fieldName] = matchingAccount?.id === undefined ? null : String(matchingAccount.id);
  }

  return normalized;
}

const overviewPanels: readonly OverviewPanelDefinition[] = [
  {
    metrics: [
      { key: "draftCount" },
      { key: "balancedCount" },
      { key: "approvedCount" },
      { key: "postedCount" },
      { key: "awaitingApproval" },
      { key: "awaitingPosting" },
    ],
    name: "journals",
    path: "journals/summary",
  },
  {
    metrics: [{ key: "eventCount" }, { key: "eventGroupCount" }, { key: "processingAttemptCount" }],
    name: "events",
    path: "events/summary",
  },
  {
    metrics: [
      { key: "expenseCount" },
      { key: "awaitingApprovalCount" },
      { key: "unpaidCount" },
      { key: "partiallyPaidCount" },
      { key: "approvedAmount", money: true },
      { key: "outstandingAmount", money: true },
    ],
    name: "expenses",
    path: "general-expenses/summary",
  },
  {
    metrics: [
      { key: "draftCount" },
      { key: "confirmedCount" },
      { key: "reversedCount" },
      { key: "confirmedAmount", money: true },
      { key: "missingEventCount" },
    ],
    name: "cashBank",
    path: "cash-bank/summary",
  },
] as const;

export function AccountingOverview({
  api,
  companyId,
  onNavigate,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const client = useClient(api);
  const configuration = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "overview:configuration"),
    (signal) => client.configuration(signal),
  );
  const completeness = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "overview:completeness"),
    (signal) => client.configurationReadiness(signal),
  );
  const automatic = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "overview:automatic"),
    (signal) => client.automaticPostingStatus(signal),
  );
  const actions = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "overview:actions"),
    (signal) => client.dashboardActions(signal),
  );
  const financialSnapshot = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "overview:financial-snapshot"),
    (signal) => client.financialSnapshot(signal),
  );
  const recentActivity = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "overview:recent-activity"),
    (signal) => client.recentActivity(signal),
  );
  const completedSteps = Array.isArray(completeness.data?.completedSteps)
    ? completeness.data.completedSteps.length
    : 0;
  const incompleteSteps = Array.isArray(completeness.data?.incompleteSteps)
    ? completeness.data.incompleteSteps.length
    : 0;
  const setupPercentage =
    completedSteps + incompleteSteps === 0
      ? undefined
      : Math.round((completedSteps / (completedSteps + incompleteSteps)) * 100);
  return (
    <section className="accounting-page">
      <PageHeader
        description={t("accounting.overview.description")}
        eyebrow={t("accounting.title")}
        title={t("accounting.sections.overview")}
      />
      <section className="accounting-status-strip">
        <article>
          <span>{t("accounting.setup.steps.activation")}</span>
          <StatusBadge
            value={configuration.data?.accountingEnabled === true ? "enabled" : "disabled"}
          />
        </article>
        <article>
          <span>{t("accounting.configuration.automatic")}</span>
          <StatusBadge
            value={automatic.data?.automaticPostingEnabled === true ? "enabled" : "disabled"}
          />
        </article>
        <article>
          <span>{t("accounting.configuration.readiness")}</span>
          <StatusBadge value={completeness.data?.ready === true ? "complete" : "incomplete"} />
        </article>
        <article>
          <span>{t("accounting.setup.complete")}</span>
          <strong>{setupPercentage === undefined ? "—" : `${setupPercentage}%`}</strong>
        </article>
      </section>
      <section className="accounting-overview-setup">
        <div>
          <h2>{t("accounting.setup.title")}</h2>
          <p>{t("accounting.setup.description")}</p>
        </div>
        <button
          className="button button-primary"
          onClick={() => onNavigate("/accounting/setup")}
          type="button"
        >
          {t("accounting.setup.continue")}
        </button>
      </section>
      <div className="accounting-dashboard-grid">
        {overviewPanels.map((panel) => (
          <OverviewPanel
            client={client}
            companyId={companyId}
            key={panel.name}
            onOpen={() =>
              onNavigate(
                `/accounting/${panel.name === "cashBank" ? "cash-bank-movements" : panel.name}`,
              )
            }
            panel={panel}
          />
        ))}
      </div>
      <section className="accounting-dashboard-panel">
        <header>
          <h2>{t("accounting.dashboard.actionsRequired")}</h2>
          <button aria-label={t("common.refresh")} onClick={actions.refresh} type="button">
            <RefreshCw size={16} />
          </button>
        </header>
        <LoadPanel error={actions.error} loading={actions.loading} onRefresh={actions.refresh}>
          <div className="accounting-action-list">
            {(Array.isArray(actions.data?.items) ? actions.data.items : []).map((item, index) => {
              const row = item as AccountingRecord;
              return (
                <button
                  className="button button-secondary"
                  key={`${String(row.key)}-${index}`}
                  onClick={() => onNavigate(String(row.target ?? "/accounting/setup"))}
                  type="button"
                >
                  <span>
                    {t(`accounting.dashboard.actionLabels.${String(row.key)}`, {
                      defaultValue: String(row.key).replaceAll(/([A-Z])/g, " $1"),
                    })}
                  </span>
                  <strong>
                    {row.count === null ? t("accounting.setup.unavailable") : String(row.count)}
                  </strong>
                  <StatusBadge value={row.severity} />
                </button>
              );
            })}
          </div>
        </LoadPanel>
      </section>
      <section className="accounting-dashboard-panel">
        <header>
          <h2>{t("accounting.dashboard.postedLedgerSnapshot")}</h2>
          <button
            aria-label={t("common.refresh")}
            onClick={financialSnapshot.refresh}
            type="button"
          >
            <RefreshCw size={16} />
          </button>
        </header>
        <LoadPanel
          error={financialSnapshot.error}
          loading={financialSnapshot.loading}
          onRefresh={financialSnapshot.refresh}
        >
          <SummaryCards
            items={[
              "cashBalance",
              "bankBalance",
              "accountsReceivable",
              "traderPayables",
              "generalExpensePayables",
              "payrollPayables",
              "currentPeriodRevenue",
              "currentPeriodExpenses",
              "currentProfitOrLoss",
              "trialBalanceDifference",
            ].map((key) => ({
              label: t(`accounting.dashboard.snapshot.${key}`),
              value:
                financialSnapshot.data?.[key] === null
                  ? t("accounting.setup.unavailable")
                  : formatAed(financialSnapshot.data?.[key]),
            }))}
          />
          {financialSnapshot.data?.provisional === true ? (
            <StatusBadge value="provisional" />
          ) : null}
        </LoadPanel>
      </section>
      <section className="accounting-dashboard-panel">
        <header>
          <h2>{t("accounting.dashboard.recentActivity")}</h2>
          <button aria-label={t("common.refresh")} onClick={recentActivity.refresh} type="button">
            <RefreshCw size={16} />
          </button>
        </header>
        <LoadPanel
          error={recentActivity.error}
          loading={recentActivity.loading}
          onRefresh={recentActivity.refresh}
        >
          <ul className="accounting-recent-activity">
            {(Array.isArray(recentActivity.data?.items) ? recentActivity.data.items : []).map(
              (item, index) => {
                const row = item as AccountingRecord;
                return (
                  <li key={`${String(row.reference ?? row.activityType)}-${index}`}>
                    <button
                      onClick={() => onNavigate(String(row.target ?? "/accounting/events"))}
                      type="button"
                    >
                      <strong>{String(row.reference ?? row.activityType)}</strong>
                      <span>{String(row.description ?? "")}</span>
                      <StatusBadge value={row.status} />
                      <time>{String(row.timestamp ?? "")}</time>
                    </button>
                  </li>
                );
              },
            )}
          </ul>
        </LoadPanel>
      </section>
    </section>
  );
}

function OverviewPanel({
  client,
  companyId,
  onOpen,
  panel,
}: {
  readonly client: AccountingApi;
  readonly companyId: string;
  readonly onOpen: () => void;
  readonly panel: OverviewPanelDefinition;
}) {
  const { t } = useTranslation();
  const resource = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, `overview:${panel.name}`),
    (signal) => client.get(panel.path, undefined, signal),
  );
  const data = resource.data ?? {};
  const eventGroups = Array.isArray(data.items)
    ? data.items.filter(
        (item): item is AccountingRecord => typeof item === "object" && item !== null,
      )
    : [];
  const values: AccountingRecord =
    panel.name === "events"
      ? {
          eventCount: eventGroups.reduce((total, item) => total + Number(item.count ?? 0), 0),
          eventGroupCount: eventGroups.length,
          processingAttemptCount: eventGroups.reduce(
            (total, item) => total + Number(item.totalAttempts ?? 0),
            0,
          ),
        }
      : data;
  return (
    <article className="accounting-dashboard-panel">
      <header>
        <h2>{t(`accounting.dashboard.${panel.name}`)}</h2>
        <button aria-label={t("common.refresh")} onClick={resource.refresh} type="button">
          <RefreshCw size={16} />
        </button>
      </header>
      <LoadPanel error={resource.error} loading={resource.loading} onRefresh={resource.refresh}>
        <SummaryCards
          items={panel.metrics.map((metric) => ({
            label: t(`accounting.overviewMetrics.${panel.name}.${metric.key}`),
            ...(metric.money === true ? { money: true } : {}),
            value: values[metric.key] ?? "—",
          }))}
        />
        <button className="button button-secondary" onClick={onOpen} type="button">
          {t("accounting.actions.open")}
        </button>
      </LoadPanel>
      <small>
        {resource.refreshedAt === undefined
          ? ""
          : t("accounting.lastRefreshed", {
              value: new Date(resource.refreshedAt).toLocaleTimeString(),
            })}
      </small>
    </article>
  );
}

export function AccountingConfigurationPage({
  api,
  companyId,
  onNavigate,
  permissions,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly onNavigate: (path: string) => void;
  readonly permissions: readonly string[];
}) {
  const { i18n, t } = useTranslation();
  const client = useClient(api);
  const permission = accountingPermissions(permissions);
  const [revision, setRevision] = useState(0);
  const [editingConfiguration, setEditingConfiguration] = useState(false);
  const [configurationSaveMessage, setConfigurationSaveMessage] = useState<string>();
  const [creatingMapping, setCreatingMapping] = useState(false);
  // Both inline forms on this page are local state, not routes, so they ask
  // the workspace for full-width focus mode directly.
  useAccountingFocus(editingConfiguration || creatingMapping);
  const [closingMapping, setClosingMapping] = useState<AccountingRecord>();
  const companyProfile = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "company-profile", { revision }),
    (signal) => api.get("company-profile", signal),
  );
  const configuration = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "configuration", { revision }),
    (signal) => client.get("configuration", undefined, signal),
  );
  const chartAccounts = useAccountingResource<readonly AccountingRecord[]>(
    accountingQueryKey(companyId, "configuration-chart-accounts", { revision }),
    (signal) => client.accounts({ activeOnly: true }, signal),
  );
  const readiness = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "automatic-readiness", { revision }),
    (signal) => client.get("automatic-posting/readiness", undefined, signal),
  );
  const status = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "automatic-status", { revision }),
    (signal) => client.get("automatic-posting/status", undefined, signal),
  );
  const mappings = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "mapping-completeness", { revision }),
    (signal) => client.get("mappings/completeness", undefined, signal),
  );
  const mappingRows = useAccountingResource<readonly AccountingRecord[]>(
    accountingQueryKey(companyId, "mappings", { revision }),
    (signal) => client.get("mappings", undefined, signal),
  );
  const chartAccountRows = useMemo(
    () => extractAccountRows(chartAccounts.data),
    [chartAccounts.data],
  );
  const companyCurrency =
    recordText(
      companyProfile.data ?? {},
      "baseCurrency",
      "base_currency",
      "currency",
      "defaultCurrency",
    ) ||
    recordText(configuration.data ?? {}, "baseCurrency", "base_currency", "currency") ||
    "AED";
  const configurationInitial = useMemo(
    () => normalizeConfigurationInitial(configuration.data, chartAccountRows, companyCurrency),
    [chartAccountRows, companyCurrency, configuration.data],
  );
  const accountOptionsStatus: FieldDefinition["optionsStatus"] = chartAccounts.loading
    ? "loading"
    : chartAccounts.error !== undefined
      ? "error"
      : "ready";
  const configurationFields: readonly FieldDefinition[] = useMemo(
    () => [
      {
        helperText: t("accounting.configuration.helpers.baseCurrency"),
        label: t("accounting.configuration.fields.baseCurrency"),
        name: "baseCurrency",
        options: [{ label: companyCurrency, value: companyCurrency }],
        readOnly: true,
        required: true,
        section: t("accounting.configuration.sections.basics"),
        type: "select",
      },
      {
        helperText: t("accounting.configuration.helpers.fiscalYearStartMonth"),
        label: t("accounting.configuration.fields.fiscalYearStartMonth"),
        name: "fiscalYearStartMonth",
        required: true,
        section: t("accounting.configuration.sections.basics"),
        type: "number",
      },
      {
        helperText: t("accounting.configuration.helpers.defaultAccountingMethod"),
        label: t("accounting.configuration.fields.defaultAccountingMethod"),
        name: "defaultAccountingMethod",
        options: [
          {
            label: t("accounting.configuration.accountingMethod.accrual", {
              defaultValue: "Accrual",
            }),
            value: "accrual",
          },
          {
            label: t("accounting.configuration.accountingMethod.cash", { defaultValue: "Cash" }),
            value: "cash",
          },
        ],
        required: true,
        section: t("accounting.configuration.sections.basics"),
        type: "select",
      },
      {
        // Segregation of Duties is a Company decision, not a build constant:
        // a Company with one accountant cannot operate under maker-checker.
        helperText: t("accounting.configuration.helpers.segregationPolicy"),
        label: t("accounting.configuration.fields.segregationPolicy"),
        name: "segregationPolicy",
        options: (["strict", "conditional", "single_user"] as const).map((value) => ({
          label: t(`accounting.configuration.segregation.${value}`),
          value,
        })),
        section: t("accounting.configuration.sections.basics"),
        type: "select" as const,
      },
      ...configurationAccountFields.map((fieldName) => ({
        helperText: t(`accounting.configuration.helpers.${fieldName}`, { defaultValue: "" }),
        label: t(`accounting.configuration.fields.${fieldName}`, {
          defaultValue: configurationAccountLabels[fieldName],
        }),
        name: fieldName,
        options: compatibleAccounts(chartAccountRows, fieldName, i18n.language),
        optionsError: chartAccounts.error,
        optionsStatus: accountOptionsStatus,
        placeholder: t("accounting.configuration.searchOrSelectAccount"),
        section: t(`accounting.configuration.sections.${configurationAccountSections[fieldName]}`),
        type: "account" as const,
      })),
      { hidden: true, name: "defaultSuspenseAccountId", type: "account" },
    ],
    [
      accountOptionsStatus,
      chartAccountRows,
      chartAccounts.error,
      companyCurrency,
      i18n.language,
      t,
    ],
  );
  const refresh = () => setRevision((value) => value + 1);
  return (
    <section className="accounting-page">
      <PageHeader
        eyebrow={t("accounting.title")}
        title={t("accounting.sections.configuration")}
        actions={
          <button className="button button-secondary" onClick={refresh} type="button">
            <RefreshCw size={16} />
            {t("common.refresh")}
          </button>
        }
      />
      <div className="accounting-dashboard-grid">
        <ConfigurationPanel
          data={configuration.data}
          error={configuration.error}
          loading={configuration.loading}
          onRefresh={configuration.refresh}
          title={t("accounting.configuration.foundation")}
        />
        <ConfigurationPanel
          data={status.data}
          error={status.error}
          loading={status.loading}
          onRefresh={status.refresh}
          title={t("accounting.configuration.automatic")}
        />
        <ConfigurationPanel
          data={readiness.data}
          error={readiness.error}
          loading={readiness.loading}
          onRefresh={readiness.refresh}
          title={t("accounting.configuration.readiness")}
        />
        <ConfigurationPanel
          data={mappings.data}
          error={mappings.error}
          loading={mappings.loading}
          onRefresh={mappings.refresh}
          title={t("accounting.configuration.mappings")}
        />
      </div>
      <section className="accounting-mapping-panel">
        <header>
          <h2>{t("accounting.mappings.title")}</h2>
          {permission.configure ? (
            <button
              className="button button-primary"
              onClick={() => setCreatingMapping(true)}
              type="button"
            >
              {t("accounting.mappings.create")}
            </button>
          ) : null}
        </header>
        <LoadPanel
          error={mappingRows.error}
          loading={mappingRows.loading}
          onRefresh={mappingRows.refresh}
        >
          <AccountingTable
            columns={[
              { key: "mappingKey", label: t("accounting.mappings.key"), technical: true },
              { key: "debitAccountCode", label: t("accounting.fields.debit"), technical: true },
              { key: "creditAccountCode", label: t("accounting.fields.credit"), technical: true },
              {
                key: "expenseAccountCode",
                label: t("accounting.mappings.expenseAccount"),
                technical: true,
              },
              {
                key: "payableAccountCode",
                label: t("accounting.mappings.payableAccount"),
                technical: true,
              },
              { key: "effectiveFrom", label: t("accounting.mappings.effectiveFrom") },
              { key: "effectiveTo", label: t("accounting.mappings.effectiveTo") },
            ]}
            empty={t("accounting.empty")}
            items={mappingRows.data ?? []}
            onOpen={permission.configure ? setClosingMapping : undefined}
          />
        </LoadPanel>
      </section>
      {permission.configure ? (
        <div className="accounting-lifecycle-actions">
          <button
            className="button button-secondary"
            onClick={() => {
              setConfigurationSaveMessage(undefined);
              setEditingConfiguration(true);
            }}
            type="button"
          >
            {t("accounting.actions.editConfiguration")}
          </button>
          <button
            className="button button-primary"
            onClick={() => onNavigate("/accounting/setup")}
            type="button"
          >
            {t("accounting.setup.continue")}
          </button>
        </div>
      ) : null}
      {configurationSaveMessage === undefined ? null : (
        <div className="form-success" role="status">
          {configurationSaveMessage}
        </div>
      )}
      {companyProfile.error === undefined ? null : (
        <div className="form-error" role="alert">
          {t("accounting.configuration.companyCurrencyCouldNotLoad", {
            defaultValue: companyProfile.error,
          })}
        </div>
      )}
      {editingConfiguration ? (
        <RecordForm
          fields={configurationFields}
          initial={configurationInitial}
          onCancel={() => setEditingConfiguration(false)}
          onSubmit={async (input) => {
            const payload: Record<string, unknown> = {
              ...input,
              baseCurrency: companyCurrency,
              fiscalYearStartMonth: Number(input.fiscalYearStartMonth),
            };
            delete payload.defaultSuspenseAccountId;
            for (const fieldName of configurationAccountFields) {
              if (String(payload[fieldName] ?? "").trim() === "") payload[fieldName] = null;
            }
            if (configuration.data?.configured === false)
              await client.post("configuration", payload);
            else await client.patch("configuration", payload);
            setConfigurationSaveMessage(t("accounting.configuration.saveSuccess"));
            setEditingConfiguration(false);
            refresh();
          }}
          submitLabel={t("common.save")}
        />
      ) : null}
      {creatingMapping ? (
        <RecordForm
          fields={[
            {
              name: "mappingKey",
              required: true,
              type: "select",
              options: [
                "order_cod_receivable",
                "delivery_revenue",
                "service_fee_revenue",
                "additional_fee_revenue",
                "output_vat",
                "trader_payable",
                "trader_settlement_cash",
                "trader_settlement_bank",
                "driver_collection_cash",
                "driver_expense",
                "employee_payroll_expense",
                "employee_payroll_payable",
                "employee_payroll_cash_payment",
                "outsourced_driver_fee_expense",
                "outsourced_driver_payable",
                "outsourced_driver_cash_payment",
                "driver_collection_fee_offset",
                "general_expense",
                "input_vat",
                "general_expense_payable",
                "general_expense_cash_payment",
                "general_expense_bank_payment",
                "cash_transfer",
                "bank_transfer",
              ].map((value) => ({ label: value, value })),
            },
            { name: "debitAccountId" },
            { name: "creditAccountId" },
            { name: "vatAccountId" },
            { name: "feeAccountId" },
            { name: "expenseAccountId" },
            { name: "payableAccountId" },
            { name: "effectiveFrom", required: true, type: "date" },
            { name: "effectiveTo", type: "date" },
          ]}
          onCancel={() => setCreatingMapping(false)}
          onSubmit={async (input) => {
            await client.post("mappings", input);
            setCreatingMapping(false);
            refresh();
          }}
          submitLabel={t("accounting.mappings.create")}
        />
      ) : null}
      {closingMapping === undefined ? null : (
        <RecordForm
          fields={[
            { name: "effectiveTo", required: true, type: "date" },
            { name: "reason", required: true, type: "textarea" },
          ]}
          onCancel={() => setClosingMapping(undefined)}
          onSubmit={async (input) => {
            await client.patch(`mappings/${String(closingMapping.id)}`, input);
            setClosingMapping(undefined);
            refresh();
          }}
          submitLabel={t("accounting.mappings.close")}
        />
      )}
    </section>
  );
}

function ConfigurationPanel({
  data,
  error,
  loading,
  onRefresh,
  title,
}: {
  readonly data?: AccountingRecord | undefined;
  readonly error?: string | undefined;
  readonly loading: boolean;
  readonly onRefresh: () => void;
  readonly title: string;
}) {
  const visibleEntries = Object.entries(data ?? {}).filter(
    ([key, value]) =>
      !["companyId", "id", "configurationId", "version"].includes(key) &&
      (value === null || ["string", "number", "boolean"].includes(typeof value)),
  );
  return (
    <article className="accounting-dashboard-panel">
      <h2>{title}</h2>
      <LoadPanel error={error} loading={loading} onRefresh={onRefresh}>
        <dl className="accounting-detail-grid accounting-business-status">
          {visibleEntries.map(([key, value]) => (
            <div key={key}>
              <dt>{key.replaceAll(/([A-Z])/g, " $1")}</dt>
              <dd>
                {typeof value === "boolean" ? (
                  <StatusBadge value={value ? "enabled" : "disabled"} />
                ) : (
                  String(value ?? "—")
                )}
              </dd>
            </div>
          ))}
        </dl>
      </LoadPanel>
    </article>
  );
}

export function LedgerPage({
  api,
  companyId,
  kind,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly kind: "bank" | "cash";
}) {
  const { t } = useTranslation();
  const client = useClient(api);
  const [accountId, setAccountId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [movementType, setMovementType] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const accounts = useAccountingResource<readonly AccountingRecord[]>(
    accountingQueryKey(companyId, `${kind}-account-options`),
    (signal) => client.get(`cash-bank/${kind}-accounts`, { activeOnly: false }, signal),
  );
  const ledger = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, `${kind}-ledger`, {
      accountId,
      dateFrom,
      dateTo,
      movementType,
      search,
      sortDirection,
      status,
    }),
    (signal) =>
      accountId === ""
        ? Promise.resolve({ items: [] })
        : client.get(
            `cash-bank/${kind}-accounts/${accountId}/ledger`,
            {
              ...(dateFrom === "" ? {} : { dateFrom }),
              ...(dateTo === "" ? {} : { dateTo }),
              ...(movementType === "" ? {} : { movementType }),
              ...(search === "" ? {} : { search }),
              sortDirection,
              ...(status === "" ? {} : { status }),
            },
            signal,
          ),
  );
  const items = Array.isArray(ledger.data?.items) ? (ledger.data.items as AccountingRecord[]) : [];
  return (
    <section className="accounting-page">
      <PageHeader
        eyebrow={t("accounting.title")}
        title={t(`accounting.sections.${kind === "cash" ? "cashbook" : "bank-ledger"}`)}
      />
      <label className="accounting-account-filter">
        {t(`accounting.fields.${kind}Account`)}
        <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          <option value="">{t("common.select")}</option>
          {accounts.data?.map((account) => (
            <option key={String(account.id)} value={String(account.id)}>
              {String(account.code)} — {String(account.name ?? account.accountName)}
            </option>
          ))}
        </select>
      </label>
      <div className="accounting-filters">
        <label>
          {t("accounting.fields.dateFrom")}
          <input
            type="date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
          />
        </label>
        <label>
          {t("accounting.fields.dateTo")}
          <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        </label>
        <label>
          {t("common.search")}
          <input
            placeholder={t("accounting.movements.ledgerSearch")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          {t("accounting.movements.movementType")}
          <select value={movementType} onChange={(event) => setMovementType(event.target.value)}>
            <option value="">{t("common.all")}</option>
            {[
              "cash_deposit",
              "cash_withdrawal",
              "bank_deposit",
              "bank_withdrawal",
              "cash_to_bank_transfer",
              "bank_to_cash_transfer",
              "bank_to_bank_transfer",
              "cash_to_cash_transfer",
              "opening_balance",
            ].map((value) => (
              <option key={value} value={value}>
                {t(`accounting.movements.types.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("accounting.fields.status")}
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">{t("common.all")}</option>
            {["confirmed", "reversed"].map((value) => (
              <option key={value} value={value}>
                {t(`accounting.status.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("accounting.movements.dateOrder")}
          <select
            value={sortDirection}
            onChange={(event) => setSortDirection(event.target.value as "asc" | "desc")}
          >
            <option value="desc">{t("accounting.movements.newestFirst")}</option>
            <option value="asc">{t("accounting.movements.oldestFirst")}</option>
          </select>
        </label>
        <button
          className="button button-secondary"
          onClick={() => {
            setDateFrom("");
            setDateTo("");
            setMovementType("");
            setStatus("");
            setSearch("");
            setSortDirection("desc");
          }}
          type="button"
        >
          {t("common.clear")}
        </button>
      </div>
      <LoadPanel error={ledger.error} loading={ledger.loading} onRefresh={ledger.refresh}>
        <SummaryCards
          items={[
            {
              label: t("accounting.fields.openingBalance"),
              value: ledger.data?.openingBalance,
              money: true,
            },
          ]}
        />
        <AccountingTable
          columns={[
            { key: "accountingDate", label: t("accounting.fields.accountingDate") },
            {
              key: "movementNumber",
              label: t("accounting.fields.movementNumber"),
              technical: true,
            },
            { key: "description", label: t("accounting.fields.description") },
            { key: "debit", label: t("accounting.fields.inflow"), money: true },
            { key: "credit", label: t("accounting.fields.outflow"), money: true },
            { key: "runningBalance", label: t("accounting.fields.runningBalance"), money: true },
            { key: "status", label: t("accounting.fields.status"), status: true },
          ]}
          empty={t("accounting.empty")}
          items={items}
        />
      </LoadPanel>
    </section>
  );
}

const reconciliationAreas = [
  "orders",
  "trader_receivables",
  "trader_settlements",
  "driver_collections",
  "driver_expenses",
  "employee_payroll",
  "outsourced_driver_fees",
  "general_expenses",
  "cash_bank_management",
] as const;

const reconciliationResults = ["posted", "queued", "missing", "mismatch", "failed", "reversed"] as const;

const emptyReconciliationFilters = {
  area: "",
  dateFrom: "",
  dateTo: "",
  eventType: "",
  page: 1,
  pageSize: 25,
  result: "",
  sortBy: "accountingDate",
  sortDirection: "desc",
};

export function ReconciliationPage({
  api,
  companyId,
  preview = false,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly preview?: boolean;
}) {
  const { t } = useTranslation();
  const client = useClient(api);
  const [dates, setDates] = useState({ dateFrom: "", dateTo: "" });
  const [filters, setFilters] = useState(emptyReconciliationFilters);
  const [previewData, setPreviewData] = useState<AccountingRecord>();
  const [selectedReconciliation, setSelectedReconciliation] = useState<AccountingRecord>();
  const resource = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, preview ? "backfill-preview-base" : "reconciliation"),
    (signal) =>
      preview ? Promise.resolve({}) : client.get("reconciliation/summary", undefined, signal),
  );
  const reconciliationRows = useAccountingResource<AccountingPage>(
    accountingQueryKey(companyId, "reconciliation-rows", filters),
    (signal) =>
      preview
        ? Promise.resolve({ items: [] })
        : client.get(
            "reconciliation",
            {
              ...filters,
              area: filters.area || undefined,
              dateFrom: filters.dateFrom || undefined,
              dateTo: filters.dateTo || undefined,
              eventType: filters.eventType || undefined,
              result: filters.result || undefined,
            },
            signal,
          ),
  );
  const reconciliationDetail = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "reconciliation-detail", {
      area: selectedReconciliation?.area,
      sourceId: selectedReconciliation?.sourceEntityId,
    }),
    (signal) =>
      selectedReconciliation === undefined
        ? Promise.resolve({})
        : client.get(
            `reconciliation/${String(selectedReconciliation.area)}/${String(selectedReconciliation.sourceEntityId)}`,
            undefined,
            signal,
          ),
  );
  return (
    <section className="accounting-page">
      <PageHeader
        eyebrow={t("accounting.title")}
        title={t(`accounting.sections.${preview ? "backfill-preview" : "reconciliation"}`)}
      />
      {preview ? (
        <form
          className="accounting-filter-bar"
          onSubmit={(event) => {
            event.preventDefault();
            void client
              .post<AccountingRecord>("reconciliation/preview-backfill", {
                ...dates,
                areas: [
                  "orders",
                  "trader_receivables",
                  "trader_settlements",
                  "driver_collections",
                  "driver_expenses",
                  "employee_payroll",
                  "outsourced_driver_fees",
                  "general_expenses",
                  "cash_bank_management",
                ],
              })
              .then(setPreviewData);
          }}
        >
          <label>
            {t("accounting.fields.dateFrom")}
            <input
              type="date"
              value={dates.dateFrom}
              onChange={(event) =>
                setDates((current) => ({ ...current, dateFrom: event.target.value }))
              }
            />
          </label>
          <label>
            {t("accounting.fields.dateTo")}
            <input
              type="date"
              value={dates.dateTo}
              onChange={(event) =>
                setDates((current) => ({ ...current, dateTo: event.target.value }))
              }
            />
          </label>
          <button className="button button-primary" type="submit">
            {t("accounting.actions.preview")}
          </button>
          <p>{t("accounting.backfill.previewOnly")}</p>
        </form>
      ) : null}
      <LoadPanel error={resource.error} loading={resource.loading} onRefresh={resource.refresh}>
        <RecordDetail record={previewData ?? resource.data ?? {}} />
        {!preview && Array.isArray(resource.data?.items) ? (
          <AccountingTable
            columns={[
              { key: "area", label: t("accounting.reconciliation.area") },
              { key: "eventCount", label: t("accounting.reconciliation.events") },
              { key: "postedCount", label: t("accounting.status.posted") },
              { key: "exceptionCount", label: t("accounting.reconciliation.exceptions") },
              { key: "missingOperationalCount", label: t("accounting.reconciliation.missing") },
            ]}
            empty={t("accounting.empty")}
            items={resource.data.items as readonly AccountingRecord[]}
          />
        ) : null}
        {preview && Array.isArray(previewData?.areas) ? (
          <AccountingTable
            columns={[
              { key: "area", label: t("accounting.reconciliation.area") },
              { key: "eligibleCount", label: t("accounting.backfill.eligible") },
            ]}
            empty={t("accounting.empty")}
            items={previewData.areas as readonly AccountingRecord[]}
          />
        ) : null}
      </LoadPanel>
      {!preview ? (
        <>
          <div className="accounting-filter-bar">
            <label>
              {t("accounting.reconciliation.area")}
              <select
                value={filters.area}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, area: event.target.value, page: 1 }))
                }
              >
                <option value="">{t("accounting.reconciliation.allAreas")}</option>
                {reconciliationAreas.map((area) => (
                  <option key={area} value={area}>
                    {t(`accounting.reconciliation.areas.${area}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("accounting.fields.dateFrom")}
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    dateFrom: event.target.value,
                    page: 1,
                  }))
                }
              />
            </label>
            <label>
              {t("accounting.fields.dateTo")}
              <input
                type="date"
                value={filters.dateTo}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    dateTo: event.target.value,
                    page: 1,
                  }))
                }
              />
            </label>
            <label>
              {t("accounting.reconciliation.eventType")}
              <input
                placeholder={t("accounting.reconciliation.eventTypePlaceholder")}
                value={filters.eventType}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    eventType: event.target.value,
                    page: 1,
                  }))
                }
              />
            </label>
            <label>
              {t("accounting.reconciliation.result")}
              <select
                value={filters.result}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, page: 1, result: event.target.value }))
                }
              >
                <option value="">{t("accounting.reconciliation.allResults")}</option>
                {reconciliationResults.map((result) => (
                  <option key={result} value={result}>
                    {t(`accounting.reconciliation.results.${result}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("accounting.reconciliation.sortBy")}
              <select
                value={filters.sortBy}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, page: 1, sortBy: event.target.value }))
                }
              >
                <option value="accountingDate">{t("accounting.fields.accountingDate")}</option>
                <option value="sourceReference">{t("accounting.reconciliation.source")}</option>
                <option value="eventType">{t("accounting.reconciliation.eventType")}</option>
                <option value="journalNumber">{t("accounting.fields.journalNumber")}</option>
                <option value="status">{t("accounting.fields.status")}</option>
              </select>
            </label>
            <label>
              {t("accounting.reconciliation.sortDirection")}
              <select
                value={filters.sortDirection}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    page: 1,
                    sortDirection: event.target.value,
                  }))
                }
              >
                <option value="desc">{t("accounting.reconciliation.descending")}</option>
                <option value="asc">{t("accounting.reconciliation.ascending")}</option>
              </select>
            </label>
            <button
              className="button button-secondary"
              type="button"
              onClick={() =>
                setFilters({ ...emptyReconciliationFilters, pageSize: filters.pageSize })
              }
            >
              {t("accounting.reconciliation.clear")}
            </button>
          </div>
          <LoadPanel
            error={reconciliationRows.error}
            loading={reconciliationRows.loading}
            onRefresh={reconciliationRows.refresh}
          >
          <AccountingTable
            columns={[
              { key: "area", label: t("accounting.reconciliation.area") },
              {
                key: "sourceReference",
                label: t("accounting.reconciliation.source"),
                technical: true,
              },
              { key: "eventType", label: t("accounting.reconciliation.eventType") },
              { key: "result", label: t("accounting.reconciliation.result"), status: true },
              {
                key: "journalNumber",
                label: t("accounting.fields.journalNumber"),
                technical: true,
              },
              { key: "journalDebit", label: t("accounting.fields.debit"), money: true },
              { key: "journalCredit", label: t("accounting.fields.credit"), money: true },
            ]}
            empty={t("accounting.empty")}
            items={reconciliationRows.data?.items ?? []}
            onOpen={setSelectedReconciliation}
          />
            <nav
              aria-label={t("accounting.reconciliation.pagination")}
              className="accounting-pagination"
            >
              <span>
                {t("accounting.reconciliation.pageOf", {
                  page: filters.page,
                  pages: Math.max(
                    1,
                    Math.ceil(Number(reconciliationRows.data?.total ?? 0) / filters.pageSize),
                  ),
                  total: Number(reconciliationRows.data?.total ?? 0),
                })}
              </span>
              <label className="accounting-pagination-size">
                <span>{t("accounting.reconciliation.pageSize")}</span>
                <select
                  value={filters.pageSize}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      page: 1,
                      pageSize: Number(event.target.value),
                    }))
                  }
                >
                  {[25, 50, 100, 200].map((pageSize) => (
                    <option key={pageSize} value={pageSize}>
                      {pageSize}
                    </option>
                  ))}
                </select>
              </label>
              <div className="accounting-pagination-buttons">
                <button
                  className="button button-secondary"
                  disabled={filters.page <= 1}
                  type="button"
                  onClick={() =>
                    setFilters((current) => ({ ...current, page: current.page - 1 }))
                  }
                >
                  {t("accounting.reconciliation.previous")}
                </button>
                <button
                  className="button button-secondary"
                  disabled={
                    filters.page >=
                    Math.max(
                      1,
                      Math.ceil(Number(reconciliationRows.data?.total ?? 0) / filters.pageSize),
                    )
                  }
                  type="button"
                  onClick={() =>
                    setFilters((current) => ({ ...current, page: current.page + 1 }))
                  }
                >
                  {t("accounting.reconciliation.next")}
                </button>
              </div>
            </nav>
          </LoadPanel>
        </>
      ) : null}
      {selectedReconciliation === undefined ? null : (
        <LoadPanel
          error={reconciliationDetail.error}
          loading={reconciliationDetail.loading}
          onRefresh={reconciliationDetail.refresh}
        >
          <RecordDetail record={reconciliationDetail.data ?? {}} />
        </LoadPanel>
      )}
    </section>
  );
}
