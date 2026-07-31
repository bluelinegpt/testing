import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import { PageHeader } from "../../components/PageHeader.js";
import {
  AccountingStatusPanel,
  AccountingDocumentActions,
  AccountingTable,
  ActionDialog,
  AttachmentPanel,
  LoadPanel,
  RecordDetail,
  RecordForm,
  StatusBadge,
  SummaryCards,
  accountingPermissions,
  formatAed,
  type AccountingColumn,
} from "./AccountingComponents.js";
import { AccountingApi, accountingQueryKey } from "./accounting-api.js";
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
    metrics: [
      { key: "eventCount" },
      { key: "eventGroupCount" },
      { key: "processingAttemptCount" },
    ],
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
    ? completeness.data.completedSteps.length : 0;
  const incompleteSteps = Array.isArray(completeness.data?.incompleteSteps)
    ? completeness.data.incompleteSteps.length : 0;
  const setupPercentage = completedSteps + incompleteSteps === 0
    ? undefined : Math.round((completedSteps / (completedSteps + incompleteSteps)) * 100);
  return (
    <section className="accounting-page">
      <PageHeader description={t("accounting.overview.description")} eyebrow={t("accounting.title")}
        title={t("accounting.sections.overview")} />
      <section className="accounting-status-strip">
        <article><span>{t("accounting.setup.steps.activation")}</span>
          <StatusBadge value={configuration.data?.accountingEnabled === true ? "enabled" : "disabled"} /></article>
        <article><span>{t("accounting.configuration.automatic")}</span>
          <StatusBadge value={automatic.data?.automaticPostingEnabled === true ? "enabled" : "disabled"} /></article>
        <article><span>{t("accounting.configuration.readiness")}</span>
          <StatusBadge value={completeness.data?.ready === true ? "complete" : "incomplete"} /></article>
        <article><span>{t("accounting.setup.complete")}</span>
          <strong>{setupPercentage === undefined ? "—" : `${setupPercentage}%`}</strong></article>
      </section>
      <section className="accounting-overview-setup">
        <div><h2>{t("accounting.setup.title")}</h2><p>{t("accounting.setup.description")}</p></div>
        <button className="button button-primary" onClick={() => onNavigate("/accounting/setup")} type="button">
          {t("accounting.setup.continue")}
        </button>
      </section>
      <div className="accounting-dashboard-grid">
        {overviewPanels.map((panel) => (
          <OverviewPanel client={client} companyId={companyId} key={panel.name}
            onOpen={() => onNavigate(`/accounting/${panel.name === "cashBank" ? "cash-bank-movements" : panel.name}`)}
            panel={panel} />
        ))}
      </div>
      <section className="accounting-dashboard-panel">
        <header><h2>{t("accounting.dashboard.actionsRequired")}</h2>
          <button aria-label={t("common.refresh")} onClick={actions.refresh} type="button"><RefreshCw size={16} /></button></header>
        <LoadPanel error={actions.error} loading={actions.loading} onRefresh={actions.refresh}>
          <div className="accounting-action-list">{(Array.isArray(actions.data?.items)
            ? actions.data.items : []).map((item, index) => {
              const row = item as AccountingRecord;
              return <button className="button button-secondary" key={`${String(row.key)}-${index}`}
                onClick={() => onNavigate(String(row.target ?? "/accounting/setup"))} type="button">
                <span>{t(`accounting.dashboard.actionLabels.${String(row.key)}`, {
                  defaultValue: String(row.key).replaceAll(/([A-Z])/g, " $1"),
                })}</span>
                <strong>{row.count === null ? t("accounting.setup.unavailable") : String(row.count)}</strong>
                <StatusBadge value={row.severity} />
              </button>;
            })}</div>
        </LoadPanel>
      </section>
      <section className="accounting-dashboard-panel">
        <header><h2>{t("accounting.dashboard.postedLedgerSnapshot")}</h2>
          <button aria-label={t("common.refresh")} onClick={financialSnapshot.refresh} type="button"><RefreshCw size={16} /></button></header>
        <LoadPanel error={financialSnapshot.error} loading={financialSnapshot.loading}
          onRefresh={financialSnapshot.refresh}>
          <SummaryCards items={[
            "cashBalance", "bankBalance", "accountsReceivable", "traderPayables",
            "generalExpensePayables", "payrollPayables", "currentPeriodRevenue",
            "currentPeriodExpenses", "currentProfitOrLoss", "trialBalanceDifference",
          ].map((key) => ({
            label: t(`accounting.dashboard.snapshot.${key}`),
            value: financialSnapshot.data?.[key] === null
              ? t("accounting.setup.unavailable")
              : formatAed(financialSnapshot.data?.[key]),
          }))} />
          {financialSnapshot.data?.provisional === true
            ? <StatusBadge value="provisional" /> : null}
        </LoadPanel>
      </section>
      <section className="accounting-dashboard-panel">
        <header><h2>{t("accounting.dashboard.recentActivity")}</h2>
          <button aria-label={t("common.refresh")} onClick={recentActivity.refresh} type="button"><RefreshCw size={16} /></button></header>
        <LoadPanel error={recentActivity.error} loading={recentActivity.loading}
          onRefresh={recentActivity.refresh}>
          <ul className="accounting-recent-activity">{(Array.isArray(recentActivity.data?.items)
            ? recentActivity.data.items : []).map((item, index) => {
              const row = item as AccountingRecord;
              return <li key={`${String(row.reference ?? row.activityType)}-${index}`}>
                <button onClick={() => onNavigate(String(row.target ?? "/accounting/events"))} type="button">
                  <strong>{String(row.reference ?? row.activityType)}</strong>
                  <span>{String(row.description ?? "")}</span>
                  <StatusBadge value={row.status} />
                  <time>{String(row.timestamp ?? "")}</time>
                </button>
              </li>;
            })}</ul>
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
    ? data.items.filter((item): item is AccountingRecord => typeof item === "object" && item !== null)
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
      <header><h2>{t(`accounting.dashboard.${panel.name}`)}</h2>
        <button aria-label={t("common.refresh")} onClick={resource.refresh} type="button"><RefreshCw size={16} /></button></header>
      <LoadPanel error={resource.error} loading={resource.loading} onRefresh={resource.refresh}>
        <SummaryCards items={panel.metrics.map((metric) => ({
          label: t(`accounting.overviewMetrics.${panel.name}.${metric.key}`),
          ...(metric.money === true ? { money: true } : {}),
          value: values[metric.key] ?? "—",
        }))} />
        <button className="button button-secondary" onClick={onOpen} type="button">{t("accounting.actions.open")}</button>
      </LoadPanel>
      <small>{resource.refreshedAt === undefined ? "" : t("accounting.lastRefreshed", { value: new Date(resource.refreshedAt).toLocaleTimeString() })}</small>
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
  const { t } = useTranslation();
  const client = useClient(api);
  const permission = accountingPermissions(permissions);
  const [revision, setRevision] = useState(0);
  const [editingConfiguration, setEditingConfiguration] = useState(false);
  const [creatingMapping, setCreatingMapping] = useState(false);
  const [closingMapping, setClosingMapping] = useState<AccountingRecord>();
  const configuration = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "configuration", { revision }),
    (signal) => client.get("configuration", undefined, signal),
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
  const refresh = () => setRevision((value) => value + 1);
  return (
    <section className="accounting-page">
      <PageHeader eyebrow={t("accounting.title")} title={t("accounting.sections.configuration")}
        actions={<button className="button button-secondary" onClick={refresh} type="button"><RefreshCw size={16} />{t("common.refresh")}</button>} />
      <div className="accounting-dashboard-grid">
        <ConfigurationPanel data={configuration.data} error={configuration.error} loading={configuration.loading}
          onRefresh={configuration.refresh} title={t("accounting.configuration.foundation")} />
        <ConfigurationPanel data={status.data} error={status.error} loading={status.loading}
          onRefresh={status.refresh} title={t("accounting.configuration.automatic")} />
        <ConfigurationPanel data={readiness.data} error={readiness.error} loading={readiness.loading}
          onRefresh={readiness.refresh} title={t("accounting.configuration.readiness")} />
        <ConfigurationPanel data={mappings.data} error={mappings.error} loading={mappings.loading}
          onRefresh={mappings.refresh} title={t("accounting.configuration.mappings")} />
      </div>
      <section className="accounting-mapping-panel">
        <header>
          <h2>{t("accounting.mappings.title")}</h2>
          {permission.configure ? (
            <button className="button button-primary" onClick={() => setCreatingMapping(true)} type="button">
              {t("accounting.mappings.create")}
            </button>
          ) : null}
        </header>
        <LoadPanel error={mappingRows.error} loading={mappingRows.loading} onRefresh={mappingRows.refresh}>
          <AccountingTable
            columns={[
              { key: "mappingKey", label: t("accounting.mappings.key"), technical: true },
              { key: "debitAccountCode", label: t("accounting.fields.debit"), technical: true },
              { key: "creditAccountCode", label: t("accounting.fields.credit"), technical: true },
              { key: "expenseAccountCode", label: t("accounting.mappings.expenseAccount"), technical: true },
              { key: "payableAccountCode", label: t("accounting.mappings.payableAccount"), technical: true },
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
          <button className="button button-secondary" onClick={() => setEditingConfiguration(true)} type="button">
            {t("accounting.actions.editConfiguration")}
          </button>
          <button className="button button-primary" onClick={() => onNavigate("/accounting/setup")} type="button">
            {t("accounting.setup.continue")}
          </button>
        </div>
      ) : null}
      {editingConfiguration ? (
        <RecordForm
          fields={[
            { name: "baseCurrency", required: true, type: "select", options: [{ label: "AED", value: "AED" }] },
            { name: "fiscalYearStartMonth", required: true, type: "number" },
            { name: "defaultAccountingMethod", required: true, type: "select", options: [
              { label: "Accrual", value: "accrual" }, { label: "Cash", value: "cash" },
            ] },
            { name: "retainedEarningsAccountId" }, { name: "currentYearEarningsAccountId" },
            { name: "defaultRoundingAccountId" }, { name: "defaultSuspenseAccountId" },
            { name: "defaultCashAccountId" }, { name: "defaultBankAccountId" },
            { name: "defaultVatOutputAccountId" }, { name: "defaultVatInputAccountId" },
            { name: "defaultAccountsReceivableAccountId" }, { name: "defaultAccountsPayableAccountId" },
            { name: "defaultPayrollPayableAccountId" }, { name: "defaultOutsourcedDriverPayableAccountId" },
            { name: "defaultTraderPayableAccountId" }, { name: "defaultServiceFeeRevenueAccountId" },
            { name: "defaultDeliveryRevenueAccountId" },
          ]}
          initial={configuration.data ?? { baseCurrency: "AED", defaultAccountingMethod: "accrual", fiscalYearStartMonth: 1 }}
          onCancel={() => setEditingConfiguration(false)}
          onSubmit={async (input) => {
            const payload = { ...input, fiscalYearStartMonth: Number(input.fiscalYearStartMonth) };
            if (configuration.data?.configured === false) await client.post("configuration", payload);
            else await client.patch("configuration", payload);
            setEditingConfiguration(false);
            refresh();
          }}
          submitLabel={t("common.save")}
        />
      ) : null}
      {creatingMapping ? (
        <RecordForm
          fields={[
            { name: "mappingKey", required: true, type: "select", options: [
              "order_cod_receivable", "delivery_revenue", "service_fee_revenue",
              "additional_fee_revenue", "output_vat", "trader_payable",
              "trader_settlement_cash", "trader_settlement_bank", "driver_collection_cash",
              "driver_expense", "employee_payroll_expense", "employee_payroll_payable",
              "employee_payroll_cash_payment", "outsourced_driver_fee_expense",
              "outsourced_driver_payable", "outsourced_driver_cash_payment",
              "driver_collection_fee_offset", "general_expense", "input_vat",
              "general_expense_payable", "general_expense_cash_payment",
              "general_expense_bank_payment", "cash_transfer", "bank_transfer",
            ].map((value) => ({ label: value, value })) },
            { name: "debitAccountId" }, { name: "creditAccountId" },
            { name: "vatAccountId" }, { name: "feeAccountId" },
            { name: "expenseAccountId" }, { name: "payableAccountId" },
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

function ConfigurationPanel({ data, error, loading, onRefresh, title }: {
  readonly data?: AccountingRecord;
  readonly error?: string;
  readonly loading: boolean;
  readonly onRefresh: () => void;
  readonly title: string;
}) {
  const visibleEntries = Object.entries(data ?? {}).filter(([key, value]) =>
    !["companyId", "id", "configurationId", "version"].includes(key)
      && (value === null || ["string", "number", "boolean"].includes(typeof value)),
  );
  return (
    <article className="accounting-dashboard-panel">
      <h2>{title}</h2>
      <LoadPanel error={error} loading={loading} onRefresh={onRefresh}>
        <dl className="accounting-detail-grid accounting-business-status">
          {visibleEntries.map(([key, value]) => <div key={key}>
            <dt>{key.replaceAll(/([A-Z])/g, " $1")}</dt>
            <dd>{typeof value === "boolean"
              ? <StatusBadge value={value ? "enabled" : "disabled"} />
              : String(value ?? "—")}</dd>
          </div>)}
        </dl>
      </LoadPanel>
    </article>
  );
}

const movementFields: readonly FieldDefinition[] = [
  { name: "movementType", required: true, type: "select", options: [
    "cash_deposit","cash_withdrawal","bank_deposit","bank_withdrawal",
    "cash_to_bank_transfer","bank_to_cash_transfer","bank_to_bank_transfer","cash_to_cash_transfer",
  ].map((value) => ({ label: value, value })) },
  { name: "movementDate", required: true, type: "date" },
  { name: "accountingDate", required: true, type: "date" },
  { name: "sourceCashAccountId" }, { name: "sourceBankAccountId" },
  { name: "destinationCashAccountId" }, { name: "destinationBankAccountId" },
  { name: "amount", required: true, type: "money" },
  { name: "feeAmount", type: "money" }, { name: "feeDescription" },
  { name: "classificationMappingKey" }, { name: "referenceNumber" },
  { name: "externalReference" }, { name: "description", type: "textarea" },
];

const movementColumns: readonly AccountingColumn[] = [
  { key: "movementNumber", label: "Movement", technical: true },
  { key: "movementType", label: "Type" },
  { key: "movementDate", label: "Movement date" },
  { key: "accountingDate", label: "Accounting date" },
  { key: "sourceCashAccountName", label: "Source Cash" },
  { key: "sourceBankAccountName", label: "Source Bank" },
  { key: "destinationCashAccountName", label: "Destination Cash" },
  { key: "destinationBankAccountName", label: "Destination Bank" },
  { key: "amount", label: "Principal", money: true },
  { key: "feeAmount", label: "Fee", money: true },
  { key: "status", label: "Status", status: true },
  { key: "journalNumber", label: "Journal", technical: true },
];

export function CashBankMovementsPage({
  api,
  companyId,
  id,
  onNavigate,
  permissions,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly id?: string;
  readonly onNavigate: (path: string) => void;
  readonly permissions: readonly string[];
}) {
  const { t } = useTranslation();
  const client = useClient(api);
  const rights = accountingPermissions(permissions);
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<"cancel" | "confirm" | "reverse">();
  const path = id === undefined ? "cash-bank/movements" : `cash-bank/movements/${id}`;
  const resource = useAccountingResource<AccountingPage | AccountingRecord>(
    accountingQueryKey(companyId, path, { revision }),
    (signal) => client.get(path, { page: 1, pageSize: 50 }, signal),
  );
  const detail = id === undefined ? undefined : resource.data as AccountingRecord | undefined;
  const items = id === undefined && resource.data !== undefined && "items" in resource.data
    ? resource.data.items as readonly AccountingRecord[] : [];
  const refresh = () => setRevision((value) => value + 1);
  const action = async (name: "cancel" | "confirm" | "reverse", input: { readonly date?: string; readonly reason?: string }) => {
    await client.post(`cash-bank/movements/${id}/${name}`, name === "reverse"
      ? { reason: input.reason, reversalDate: input.date }
      : name === "cancel" ? { reason: input.reason } : { note: input.reason });
    refresh();
  };
  return (
    <section className="accounting-page">
      <PageHeader eyebrow={t("accounting.title")} title={t("accounting.sections.cash-bank-movements")}
        actions={id === undefined && rights.manage
          ? <button className="button button-primary" onClick={() => setCreating(true)} type="button">{t("common.create")}</button>
          : undefined} />
      <LoadPanel error={resource.error} loading={resource.loading} onRefresh={resource.refresh}>
        {detail === undefined ? (
          <AccountingTable columns={movementColumns} empty={t("accounting.empty")} items={items}
            onOpen={(row) => onNavigate(`/accounting/cash-bank-movements/${String(row.id)}`)} />
        ) : (
          <>
            <button className="button button-secondary" onClick={() => onNavigate("/accounting/cash-bank-movements")} type="button">{t("common.back")}</button>
            <AccountingDocumentActions api={api}
              filename={`cash-bank-movement-${String(detail.movementNumber ?? id)}.pdf`}
              path={`operations/accounting/reports/documents/cash-bank-movements/${id}/pdf`} />
            <RecordDetail record={detail} />
            <AccountingStatusPanel status={{
              accountingEventId: detail.accounting_event_id ?? detail.accountingEventId,
              accountingEventStatus: detail.accountingEventStatus,
              journalId: detail.journalId,
              journalNumber: detail.journalNumber,
            }} />
            <AttachmentPanel
              attachments={Array.isArray(detail.attachments)
                ? detail.attachments as readonly AccountingRecord[] : []}
              canManage={rights.manage && !["confirmed", "reversed"].includes(String(detail.status))}
              onAttach={async (input) => {
                await client.post(`cash-bank/movements/${id}/attachments`, input);
                refresh();
              }}
            />
            <div className="accounting-lifecycle-actions">
              {String(detail.status) === "draft" && rights.manage ? <>
                <button className="button button-secondary" onClick={() => void client.get(`cash-bank/movements/${id}/validate`).then(refresh)} type="button">{t("accounting.actions.validate")}</button>
                <button className="button button-secondary" onClick={() => setDialog("cancel")} type="button">{t("accounting.actions.cancel")}</button>
              </> : null}
              {String(detail.status) === "draft" && rights.approve
                ? <button className="button button-primary" onClick={() => setDialog("confirm")} type="button">{t("accounting.actions.confirm")}</button>
                : null}
              {String(detail.status) === "confirmed" && rights.reverse
                ? <button className="button button-danger" onClick={() => setDialog("reverse")} type="button">{t("common.reverse")}</button> : null}
            </div>
          </>
        )}
      </LoadPanel>
      {creating ? <RecordForm fields={movementFields} onCancel={() => setCreating(false)}
        onSubmit={async (payload) => { await client.post("cash-bank/movements", payload); setCreating(false); refresh(); }}
        submitLabel={t("common.create")} /> : null}
      {dialog === undefined || detail === undefined ? null : (
        <ActionDialog action={dialog} amount={detail.amount} onClose={() => setDialog(undefined)}
          onConfirm={(input) => action(dialog, input)}
          recordReference={String(detail.movement_number ?? detail.movementNumber ?? id)}
          requireDate={dialog === "reverse"} requireReason={dialog !== "confirm"} />
      )}
    </section>
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
  const accounts = useAccountingResource<readonly AccountingRecord[]>(
    accountingQueryKey(companyId, `${kind}-account-options`),
    (signal) => client.get(`cash-bank/${kind}-accounts`, { activeOnly: false }, signal),
  );
  const ledger = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, `${kind}-ledger`, { accountId }),
    (signal) => accountId === "" ? Promise.resolve({ items: [] })
      : client.get(`cash-bank/${kind}-accounts/${accountId}/ledger`, undefined, signal),
  );
  const items = Array.isArray(ledger.data?.items) ? ledger.data.items as AccountingRecord[] : [];
  return (
    <section className="accounting-page">
      <PageHeader eyebrow={t("accounting.title")} title={t(`accounting.sections.${kind === "cash" ? "cashbook" : "bank-ledger"}`)} />
      <label className="accounting-account-filter">{t(`accounting.fields.${kind}Account`)}
        <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          <option value="">{t("common.select")}</option>
          {accounts.data?.map((account) => <option key={String(account.id)} value={String(account.id)}>{String(account.code)} — {String(account.name ?? account.accountName)}</option>)}
        </select>
      </label>
      <LoadPanel error={ledger.error} loading={ledger.loading} onRefresh={ledger.refresh}>
        <SummaryCards items={[{ label: t("accounting.fields.openingBalance"), value: ledger.data?.openingBalance, money: true }]} />
        <AccountingTable columns={[
          { key: "accountingDate", label: t("accounting.fields.accountingDate") },
          { key: "movementNumber", label: t("accounting.fields.movementNumber"), technical: true },
          { key: "description", label: t("accounting.fields.description") },
          { key: "debit", label: t("accounting.fields.inflow"), money: true },
          { key: "credit", label: t("accounting.fields.outflow"), money: true },
          { key: "runningBalance", label: t("accounting.fields.runningBalance"), money: true },
          { key: "status", label: t("accounting.fields.status"), status: true },
        ]} empty={t("accounting.empty")} items={items} />
      </LoadPanel>
    </section>
  );
}

export function ReconciliationPage({ api, companyId, preview = false }: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly preview?: boolean;
}) {
  const { t } = useTranslation();
  const client = useClient(api);
  const [dates, setDates] = useState({ dateFrom: "", dateTo: "" });
  const [previewData, setPreviewData] = useState<AccountingRecord>();
  const [selectedReconciliation, setSelectedReconciliation] = useState<AccountingRecord>();
  const resource = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, preview ? "backfill-preview-base" : "reconciliation"),
    (signal) => preview ? Promise.resolve({}) : client.get("reconciliation/summary", undefined, signal),
  );
  const reconciliationRows = useAccountingResource<AccountingPage>(
    accountingQueryKey(companyId, "reconciliation-rows"),
    (signal) => preview
      ? Promise.resolve({ items: [] })
      : client.get("reconciliation", { page: 1, pageSize: 100 }, signal),
  );
  const reconciliationDetail = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "reconciliation-detail", {
      area: selectedReconciliation?.area,
      sourceId: selectedReconciliation?.sourceEntityId,
    }),
    (signal) => selectedReconciliation === undefined
      ? Promise.resolve({})
      : client.get(
          `reconciliation/${String(selectedReconciliation.area)}/${String(selectedReconciliation.sourceEntityId)}`,
          undefined,
          signal,
        ),
  );
  return (
    <section className="accounting-page">
      <PageHeader eyebrow={t("accounting.title")}
        title={t(`accounting.sections.${preview ? "backfill-preview" : "reconciliation"}`)} />
      {preview ? (
        <form className="accounting-filter-bar" onSubmit={(event) => {
          event.preventDefault();
          void client.post<AccountingRecord>("reconciliation/preview-backfill", {
            ...dates,
            areas: [
              "orders", "trader_receivables", "trader_settlements", "driver_collections",
              "driver_expenses", "employee_payroll", "outsourced_driver_fees",
              "general_expenses", "cash_bank_management",
            ],
          }).then(setPreviewData);
        }}>
          <label>{t("accounting.fields.dateFrom")}<input type="date" value={dates.dateFrom} onChange={(event) => setDates((current) => ({ ...current, dateFrom: event.target.value }))} /></label>
          <label>{t("accounting.fields.dateTo")}<input type="date" value={dates.dateTo} onChange={(event) => setDates((current) => ({ ...current, dateTo: event.target.value }))} /></label>
          <button className="button button-primary" type="submit">{t("accounting.actions.preview")}</button>
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
        <LoadPanel error={reconciliationRows.error} loading={reconciliationRows.loading}
          onRefresh={reconciliationRows.refresh}>
          <AccountingTable
            columns={[
              { key: "area", label: t("accounting.reconciliation.area") },
              { key: "sourceReference", label: t("accounting.reconciliation.source"), technical: true },
              { key: "eventType", label: t("accounting.reconciliation.eventType") },
              { key: "result", label: t("accounting.reconciliation.result"), status: true },
              { key: "journalNumber", label: t("accounting.fields.journalNumber"), technical: true },
              { key: "journalDebit", label: t("accounting.fields.debit"), money: true },
              { key: "journalCredit", label: t("accounting.fields.credit"), money: true },
            ]}
            empty={t("accounting.empty")}
            items={reconciliationRows.data?.items ?? []}
            onOpen={setSelectedReconciliation}
          />
        </LoadPanel>
      ) : null}
      {selectedReconciliation === undefined ? null : (
        <LoadPanel error={reconciliationDetail.error} loading={reconciliationDetail.loading}
          onRefresh={reconciliationDetail.refresh}>
          <RecordDetail record={reconciliationDetail.data ?? {}} />
        </LoadPanel>
      )}
    </section>
  );
}
