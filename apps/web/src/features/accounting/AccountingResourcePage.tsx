import { Plus, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import { PageHeader } from "../../components/PageHeader.js";
import {
  AttachmentPanel,
  AccountingDocumentActions,
  AccountingTable,
  ActionDialog,
  LoadPanel,
  RecordDetail,
  RecordForm,
  SummaryCards,
  accountingPermissions,
  type AccountingColumn,
} from "./AccountingComponents.js";
import { AccountingApi, accountingQueryKey } from "./accounting-api.js";
import type {
  AccountingPage,
  AccountingRecord,
  AccountingSection,
  FieldDefinition,
  LifecycleAction,
} from "./accounting-types.js";
import { useAccountingResource } from "./use-accounting-resource.js";

interface ResourceDefinition {
  readonly actions?: readonly LifecycleAction[];
  readonly columns: readonly AccountingColumn[];
  readonly createFields?: readonly FieldDefinition[];
  readonly createPath?: string;
  readonly detailPath?: (id: string) => string;
  readonly listPath: string;
  readonly permission?: "configure" | "manage" | "periods";
  readonly referenceKeys: readonly string[];
  readonly summaryPath?: string;
}

const definitions: Readonly<Partial<Record<AccountingSection, ResourceDefinition>>> = {
  "chart-of-accounts": {
    actions: [
      { action: "activate", permission: "accounts", reason: true },
      { action: "deactivate", permission: "accounts", reason: true },
    ],
    columns: [
      { key: "code", label: "Code", technical: true },
      { key: "displayName", label: "Name" },
      { key: "accountType", label: "Type" },
      { key: "accountClass", label: "Class" },
      { key: "normalBalance", label: "Normal balance" },
      { key: "isPostingAccount", label: "Posting" },
      { key: "isActive", label: "Active" },
    ],
    createFields: [
      { name: "code", required: true },
      { name: "nameEn", required: true },
      { name: "nameAr" },
      { name: "accountType", required: true, type: "select", options: ["asset","liability","equity","revenue","expense"].map((value) => ({ label: value, value })) },
      { name: "accountClass", required: true },
      { name: "normalBalance", required: true, type: "select", options: ["debit","credit"].map((value) => ({ label: value, value })) },
      { name: "isPostingAccount", type: "checkbox" },
      { name: "isControlAccount", type: "checkbox" },
      { name: "currency", required: true, type: "select", options: [{ label: "AED", value: "AED" }] },
      { name: "effectiveFrom", required: true, type: "date" },
      { name: "effectiveTo", type: "date" },
      { name: "description", type: "textarea" },
    ],
    createPath: "accounts",
    detailPath: (id) => `accounts/${id}`,
    listPath: "accounts/hierarchy",
    permission: "accounts",
    referenceKeys: ["code", "id"],
  },
  "fiscal-years": {
    actions: [
      { action: "open", permission: "periods" },
      { action: "close", permission: "periods", reason: true },
      { action: "reopen", permission: "periods", reason: true },
    ],
    columns: [
      { key: "fiscalYearCode", label: "Code", technical: true },
      { key: "name", label: "Name" },
      { key: "startDate", label: "Start" },
      { key: "endDate", label: "End" },
      { key: "status", label: "Status", status: true },
      { key: "periodCount", label: "Periods" },
    ],
    createFields: [
      { name: "fiscalYearCode", required: true },
      { name: "name", required: true },
      { name: "startDate", required: true, type: "date" },
      { name: "endDate", required: true, type: "date" },
      { name: "generatePeriods", type: "checkbox" },
      { name: "periodCodePrefix" },
    ],
    createPath: "fiscal-years",
    detailPath: (id) => `fiscal-years/${id}`,
    listPath: "fiscal-years",
    permission: "periods",
    referenceKeys: ["fiscalYearCode", "name", "id"],
  },
  "fiscal-periods": {
    actions: [
      { action: "open", permission: "periods" },
      { action: "soft-close", permission: "periods", reason: true },
      { action: "close", permission: "periods", reason: true },
      { action: "reopen", permission: "periods", reason: true },
    ],
    columns: [
      { key: "periodCode", label: "Code", technical: true },
      { key: "name", label: "Name" },
      { key: "periodNumber", label: "Period" },
      { key: "startDate", label: "Start" },
      { key: "endDate", label: "End" },
      { key: "status", label: "Status", status: true },
    ],
    createFields: [
      { name: "fiscalYearId", required: true },
      { name: "periodNumber", required: true, type: "number" },
      { name: "periodCode", required: true },
      { name: "name", required: true },
      { name: "startDate", required: true, type: "date" },
      { name: "endDate", required: true, type: "date" },
      { name: "isAdjustmentPeriod", type: "checkbox" },
    ],
    createPath: "fiscal-periods",
    detailPath: (id) => `fiscal-periods/${id}`,
    listPath: "fiscal-periods",
    permission: "periods",
    referenceKeys: ["periodCode", "name", "id"],
  },
  journals: {
    actions: [
      { action: "validate", permission: "manage" },
      { action: "approve", permission: "approve" },
      { action: "post", permission: "post" },
      { action: "cancel", permission: "manage", reason: true },
      { action: "reverse", permission: "reverse", reason: true, reversalDate: true },
    ],
    columns: [
      { key: "journalNumber", label: "Journal", technical: true },
      { key: "businessDate", label: "Accounting date" },
      { key: "description", label: "Description" },
      { key: "totalDebit", label: "Debit", money: true },
      { key: "totalCredit", label: "Credit", money: true },
      { key: "difference", label: "Difference", money: true },
      { key: "status", label: "Status", status: true },
    ],
    createFields: [
      { name: "journalDate", required: true, type: "date" },
      { name: "description", required: true, type: "textarea" },
      { name: "sourceReference" },
      { name: "currency", required: true, type: "select", options: [{ label: "AED", value: "AED" }] },
      { name: "notes", type: "textarea" },
    ],
    createPath: "journals",
    detailPath: (id) => `journals/${id}`,
    listPath: "journals",
    permission: "manage",
    referenceKeys: ["journalNumber", "id"],
    summaryPath: "journals/summary",
  },
  "opening-balances": {
    actions: [
      { action: "validate", permission: "manage" },
      { action: "approve", permission: "approve" },
      { action: "post", permission: "post" },
      { action: "reverse", permission: "reverse", reason: true, reversalDate: true },
    ],
    columns: [
      { key: "batchNumber", label: "Batch", technical: true },
      { key: "openingDate", label: "Opening date" },
      { key: "description", label: "Description" },
      { key: "totalDebit", label: "Debit", money: true },
      { key: "totalCredit", label: "Credit", money: true },
      { key: "status", label: "Status", status: true },
    ],
    createFields: [
      { name: "effectiveDate", required: true, type: "date" },
      { name: "description", required: true, type: "textarea" },
      { name: "currency", required: true },
      { name: "notes", type: "textarea" },
    ],
    createPath: "opening-balances",
    detailPath: (id) => `opening-balances/${id}`,
    listPath: "opening-balances",
    permission: "manage",
    referenceKeys: ["batchNumber", "id"],
    summaryPath: "opening-balances/summary",
  },
  events: {
    actions: [{ action: "reprocess", permission: "manage", reason: true }],
    columns: [
      { key: "eventType", label: "Event type" },
      { key: "operationalArea", label: "Area" },
      { key: "sourceReference", label: "Source", technical: true },
      { key: "effectiveAccountingDate", label: "Accounting date" },
      { key: "processingStatus", label: "Status", status: true },
      { key: "failureCategory", label: "Failure" },
      { key: "attemptCount", label: "Attempts" },
      { key: "journalNumber", label: "Journal", technical: true },
    ],
    detailPath: (id) => `events/${id}`,
    listPath: "events",
    referenceKeys: ["sourceReference", "id"],
    summaryPath: "events/summary",
  },
  "expense-categories": {
    actions: [
      { action: "activate", permission: "manage", reason: true },
      { action: "deactivate", permission: "manage", reason: true },
    ],
    columns: [
      { key: "code", label: "Code", technical: true },
      { key: "nameEn", label: "Name" },
      { key: "nameAr", label: "Arabic name" },
      { key: "defaultExpenseMappingKey", label: "Expense mapping" },
      { key: "defaultVatTreatment", label: "VAT" },
      { key: "isActive", label: "Active" },
    ],
    createFields: [
      { name: "code", required: true },
      { name: "nameEn", required: true },
      { name: "nameAr" },
      { name: "defaultExpenseMappingKey", required: true },
      { name: "defaultVatTreatment", required: true, type: "select", options: ["standard_rated","zero_rated","exempt","out_of_scope","non_recoverable","partially_recoverable"].map((value) => ({ label: value, value })) },
      { name: "effectiveFrom", required: true, type: "date" },
      { name: "effectiveTo", type: "date" },
      { name: "description", type: "textarea" },
    ],
    createPath: "general-expenses/categories",
    listPath: "general-expenses/categories",
    permission: "manage",
    referenceKeys: ["code", "id"],
  },
  expenses: {
    actions: [
      { action: "submit", permission: "manage", reason: true },
      { action: "withdraw", permission: "manage", reason: true },
      { action: "approve", permission: "approve", reason: true },
      { action: "reject", permission: "approve", reason: true },
      { action: "return-to-draft", permission: "manage", reason: true },
      { action: "cancel", permission: "manage", reason: true },
      { action: "reverse", permission: "reverse", reason: true, reversalDate: true },
    ],
    columns: [
      { key: "expenseNumber", label: "Expense", technical: true },
      { key: "expenseDate", label: "Expense date" },
      { key: "payeeName", label: "Payee" },
      { key: "grossAmount", label: "Gross", money: true },
      { key: "paidAmount", label: "Paid", money: true },
      { key: "outstandingAmount", label: "Outstanding", money: true },
      { key: "status", label: "Status", status: true },
      { key: "paymentStatus", label: "Payment", status: true },
    ],
    createFields: [
      { name: "expenseDate", type: "date" },
      { name: "accountingDate", type: "date" },
      { name: "categoryId" },
      { name: "payeeType" },
      { name: "payeeName" },
      { name: "payeeContact" },
      { name: "referenceNumber" },
      { name: "description", type: "textarea" },
      { name: "notes", type: "textarea" },
      { name: "lineCategoryId", required: true },
      { name: "lineDescription", required: true },
      { name: "quantity", required: true, type: "money" },
      { name: "unitAmount", required: true, type: "money" },
      { name: "vatTreatment", required: true, type: "select", options: [
        "standard_rated", "zero_rated", "exempt", "out_of_scope",
        "non_recoverable", "partially_recoverable",
      ].map((value) => ({ label: value, value })) },
      { name: "vatRate", required: true, type: "money" },
      { name: "recoverablePercentage", type: "money" },
      { name: "expenseAccountMappingKey" },
    ],
    createPath: "general-expenses",
    detailPath: (id) => `general-expenses/${id}`,
    listPath: "general-expenses",
    permission: "manage",
    referenceKeys: ["expenseNumber", "id"],
    summaryPath: "general-expenses/summary",
  },
  "cash-accounts": {
    actions: [
      { action: "activate", permission: "configure", reason: true },
      { action: "deactivate", permission: "configure", reason: true },
    ],
    columns: [
      { key: "code", label: "Code", technical: true },
      { key: "name", label: "Name" },
      { key: "type", label: "Type" },
      { key: "locationOrCustodian", label: "Location / custodian" },
      { key: "linkedGlAccountCode", label: "GL Account", technical: true },
      { key: "isActive", label: "Active" },
    ],
    createFields: [
      { name: "code", required: true },
      { name: "name", required: true },
      { name: "nameAr" },
      { name: "type", required: true, type: "select", options: ["main_cash","branch_cash","petty_cash","cash_drawer","safe","other"].map((value) => ({ label: value, value })) },
      { name: "locationOrCustodian" },
      { name: "linkedGlAccountId", required: true },
      { name: "effectiveFrom", required: true, type: "date" },
      { name: "effectiveTo", type: "date" },
      { name: "description", type: "textarea" },
    ],
    createPath: "cash-bank/cash-accounts",
    detailPath: (id) => `cash-bank/cash-accounts/${id}`,
    listPath: "cash-bank/cash-accounts",
    permission: "configure",
    referenceKeys: ["code", "id"],
  },
  "bank-accounts": {
    actions: [
      { action: "activate", permission: "configure", reason: true },
      { action: "deactivate", permission: "configure", reason: true },
    ],
    columns: [
      { key: "code", label: "Code", technical: true },
      { key: "accountName", label: "Account" },
      { key: "bankName", label: "Bank" },
      { key: "maskedAccountNumber", label: "Account number", technical: true },
      { key: "maskedIban", label: "IBAN", technical: true },
      { key: "linkedGlAccountCode", label: "GL Account", technical: true },
      { key: "isActive", label: "Active" },
    ],
    createFields: [
      { name: "code", required: true },
      { name: "accountName", required: true },
      { name: "bankName", required: true },
      { name: "branchName" },
      { name: "accountNumber" },
      { name: "iban" },
      { name: "swiftCode" },
      { name: "accountType", required: true, type: "select", options: ["current","savings","merchant","settlement","other"].map((value) => ({ label: value, value })) },
      { name: "linkedGlAccountId", required: true },
      { name: "effectiveFrom", required: true, type: "date" },
      { name: "effectiveTo", type: "date" },
      { name: "description", type: "textarea" },
    ],
    createPath: "cash-bank/bank-accounts",
    detailPath: (id) => `cash-bank/bank-accounts/${id}`,
    listPath: "cash-bank/bank-accounts",
    permission: "configure",
    referenceKeys: ["code", "id"],
  },
};

function normalizePage(value: unknown): readonly AccountingRecord[] {
  if (Array.isArray(value)) return value as readonly AccountingRecord[];
  if (typeof value === "object" && value !== null && "items" in value) {
    const items = (value as AccountingPage).items;
    return Array.isArray(items) ? items : [];
  }
  return [];
}

function referenceOf(row: AccountingRecord, keys: readonly string[]): string {
  for (const key of keys) if (typeof row[key] === "string") return row[key] as string;
  return "—";
}

function actionAvailable(
  section: AccountingSection,
  record: AccountingRecord,
  action: string,
): boolean {
  const status = String(record.status ?? record.processingStatus ?? "");
  const active = record.isActive === true;
  if (action === "activate") return !active;
  if (action === "deactivate") return active;
  const allowed: Readonly<Partial<Record<AccountingSection, Readonly<Record<string, readonly string[]>>>>> = {
    "fiscal-years": {
      close: ["open", "reopened"], open: ["draft"], reopen: ["closed"],
    },
    "fiscal-periods": {
      close: ["open", "reopened", "soft_closed"], open: ["future"],
      reopen: ["closed"], "soft-close": ["open", "reopened"],
    },
    journals: {
      approve: ["balanced"], cancel: ["draft", "balanced", "approved"],
      post: ["approved"], reverse: ["posted"], validate: ["draft", "balanced"],
    },
    "opening-balances": {
      approve: ["validated"], post: ["approved"], reverse: ["posted"], validate: ["draft", "validated"],
    },
    events: {
      reprocess: ["failed", "blocked_configuration", "retry_pending"],
    },
    expenses: {
      approve: ["submitted"], cancel: ["draft", "submitted", "rejected"],
      reject: ["submitted"], reverse: ["approved", "partially_paid", "paid"],
      submit: ["draft"], "return-to-draft": ["rejected"], withdraw: ["submitted"],
    },
  };
  const statuses = allowed[section]?.[action];
  return statuses === undefined || statuses.includes(status);
}

export function AccountingResourcePage({
  api,
  companyId,
  id,
  onNavigate,
  permissions,
  section,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly id?: string;
  readonly onNavigate: (path: string) => void;
  readonly permissions: readonly string[];
  readonly section: AccountingSection;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new AccountingApi(api), [api]);
  const definition = definitions[section];
  const [filters, setFilters] = useState({ page: 1, pageSize: 50, search: "" });
  const [creating, setCreating] = useState(false);
  const [addingLine, setAddingLine] = useState(false);
  const [action, setAction] = useState<{ readonly action: LifecycleAction; readonly record: AccountingRecord }>();
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkPreview, setBulkPreview] = useState<AccountingRecord>();
  const [bulkReprocessing, setBulkReprocessing] = useState(false);
  const [revision, setRevision] = useState(0);
  const permissionSet = accountingPermissions(permissions);
  const detailPath = id !== undefined && definition?.detailPath !== undefined
    ? definition.detailPath(id) : undefined;
  const queryKey = accountingQueryKey(companyId, `${section}:${detailPath ?? "list"}`, { ...filters, revision });
  const resource = useAccountingResource<unknown>(queryKey, (signal) => {
    if (definition === undefined) return Promise.resolve([]);
    return client.get<unknown>(detailPath ?? definition.listPath, detailPath === undefined ? filters : undefined, signal);
  });
  const summary = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, `${section}:summary`, { revision }),
    (signal) => definition?.summaryPath === undefined
      ? Promise.resolve({})
      : client.get<AccountingRecord>(definition.summaryPath, undefined, signal),
  );
  const baseRecords = normalizePage(resource.data);
  const records = section === "chart-of-accounts"
    ? baseRecords
        .filter((record) => filters.search.trim() === ""
          || `${String(record.code ?? "")} ${String(record.nameEn ?? "")}`
            .toLocaleLowerCase().includes(filters.search.trim().toLocaleLowerCase()))
        .map((record) => ({
          ...record,
          displayName: `${"› ".repeat(Number(record.depth ?? 0))}${String(record.nameEn ?? "")}`,
        }))
    : baseRecords;
  const detail = detailPath === undefined ? undefined : resource.data as AccountingRecord | undefined;

  if (definition === undefined) return null;
  const canCreate = definition.createFields !== undefined
    && definition.createPath !== undefined
    && permissionSet[definition.permission ?? "manage"];
  const refresh = () => {
    setRevision((value) => value + 1);
    resource.refresh();
    summary.refresh();
  };
  const submitCreate = async (payload: Record<string, unknown>) => {
    if (section === "expenses") {
      const {
        expenseAccountMappingKey,
        lineCategoryId,
        lineDescription,
        quantity,
        recoverablePercentage,
        unitAmount,
        vatRate,
        vatTreatment,
        ...header
      } = payload;
      await client.post(definition.createPath!, {
        ...header,
        lines: [{
          categoryId: lineCategoryId,
          description: lineDescription,
          expenseAccountMappingKey: expenseAccountMappingKey || undefined,
          quantity,
          recoverablePercentage: recoverablePercentage || undefined,
          unitAmount,
          vatRate,
          vatTreatment,
        }],
      });
    } else {
      await client.post(definition.createPath!, payload);
    }
    setCreating(false);
    refresh();
  };
  const submitLine = async (payload: Record<string, unknown>) => {
    const debit = Number(payload.debit ?? 0);
    const credit = Number(payload.credit ?? 0);
    if ((debit > 0) === (credit > 0)) throw new Error("journal_line_single_side_required");
    const lineNumber = Array.isArray(detail?.lines) ? detail.lines.length + 1 : 1;
    await client.post(`${definition.listPath}/${id}/lines`, {
      ...payload,
      credit,
      debit,
      lineNumber,
    });
    setAddingLine(false);
    refresh();
  };
  const executeAction = async (
    lifecycle: LifecycleAction,
    record: AccountingRecord,
    input: { readonly date?: string; readonly reason?: string },
  ) => {
    const recordId = String(record.id ?? id);
    let path = `${definition.listPath}/${recordId}/${lifecycle.action}`;
    if (section === "chart-of-accounts") path = `accounts/${recordId}/${lifecycle.action}`;
    if (section === "expense-categories") path = `general-expenses/categories/${recordId}/${lifecycle.action}`;
    if (section === "cash-accounts") path = `cash-bank/cash-accounts/${recordId}/${lifecycle.action}`;
    if (section === "bank-accounts") path = `cash-bank/bank-accounts/${recordId}/${lifecycle.action}`;
    if (section === "events" && lifecycle.action === "reprocess") path = `events/${recordId}/reprocess`;
    const version = record.version === undefined ? undefined : Number(record.version);
    const payload = section === "expenses"
      ? { accountingDate: lifecycle.reversalDate ? input.date : undefined,
          reason: input.reason ?? t("accounting.confirmation.confirmedByUser"), version }
      : section === "events"
        ? { reason: input.reason }
        : lifecycle.reversalDate
          ? { reversalDate: input.date, reason: input.reason }
          : lifecycle.action === "approve" || lifecycle.action === "post"
            ? { note: input.reason }
            : { reason: input.reason ?? t("accounting.confirmation.confirmedByUser"), version };
    await client.post(path, payload);
    refresh();
  };

  const title = t(`accounting.sections.${section}`);
  return (
    <section className="accounting-page">
      <PageHeader
        actions={
          <>
            <button className="button button-secondary" onClick={refresh} type="button"><RefreshCw size={16} />{t("common.refresh")}</button>
            {canCreate ? <button className="button button-primary" onClick={() => setCreating(true)} type="button"><Plus size={16} />{t("common.create")}</button> : null}
          </>
        }
        eyebrow={t("accounting.title")}
        title={title}
      />
      {detail === undefined ? (
        <>
          {definition.summaryPath === undefined ? null : (
            <LoadPanel error={summary.error} loading={summary.loading} onRefresh={summary.refresh}>
              <SummaryCards items={Object.entries(summary.data ?? {}).slice(0, 6).map(([label, value]) => ({ label, value }))} />
            </LoadPanel>
          )}
          <div className="accounting-filter-bar">
            <label>{t("common.search")}<input value={filters.search}
              onChange={(event) => setFilters((current) => ({ ...current, page: 1, search: event.target.value }))} /></label>
            {section === "events" && (permissionSet.manage || permissionSet.post) && selectedIds.size > 0 ? (
              <button className="button button-secondary" onClick={() => {
                void client.post<AccountingRecord>("events/reprocess-preview", {
                  eventIds: [...selectedIds],
                  reason: t("accounting.confirmation.confirmedByUser"),
                }).then((preview) => {
                  setBulkPreview(preview);
                  setBulkReprocessing(true);
                });
              }} type="button">
                {t("accounting.actions.bulkReprocess", { count: selectedIds.size })}
              </button>
            ) : null}
          </div>
          <LoadPanel error={resource.error} loading={resource.loading} onRefresh={resource.refresh}>
            <AccountingTable columns={definition.columns} empty={t("accounting.empty")}
              items={records}
              onOpen={definition.detailPath === undefined ? undefined : (row) =>
                onNavigate(`/accounting/${section}/${String(row.id)}`)}
              onToggleSelection={section === "events" ? (recordId) => setSelectedIds((current) => {
                const next = new Set(current);
                if (next.has(recordId)) next.delete(recordId);
                else next.add(recordId);
                return next;
              }) : undefined}
              selectedIds={section === "events" ? selectedIds : undefined} />
          </LoadPanel>
        </>
      ) : (
        <LoadPanel error={resource.error} loading={resource.loading} onRefresh={resource.refresh}>
          <button className="button button-secondary" onClick={() => onNavigate(`/accounting/${section}`)} type="button">{t("common.back")}</button>
          {id !== undefined && section === "journals" ? (
            <AccountingDocumentActions api={api} filename={`journal-${String(detail.journalNumber ?? id)}.pdf`}
              path={`operations/accounting/reports/documents/journals/${id}/pdf`} />
          ) : null}
          {id !== undefined && section === "opening-balances" ? (
            <AccountingDocumentActions api={api} filename={`opening-balance-${String(detail.batchNumber ?? id)}.pdf`}
              path={`operations/accounting/reports/documents/opening-balances/${id}/pdf`} />
          ) : null}
          {id !== undefined && section === "expenses" ? (
            <AccountingDocumentActions api={api} filename={`expense-${String(detail.expenseNumber ?? id)}.pdf`}
              path={`operations/accounting/reports/documents/expenses/${id}/pdf`} />
          ) : null}
          <RecordDetail record={detail} />
          {Array.isArray(detail.lines) ? (
            <AccountingTable
              columns={[
                { key: "lineNumber", label: "#" },
                { key: "accountCode", label: t("accounting.fields.account"), technical: true },
                { key: "description", label: t("accounting.fields.description") },
                { key: "debit", label: t("accounting.fields.debit"), money: true },
                { key: "credit", label: t("accounting.fields.credit"), money: true },
              ]}
              empty={t("accounting.empty")}
              items={detail.lines as readonly AccountingRecord[]}
            />
          ) : null}
          {section === "expenses" ? (
            <AttachmentPanel
              attachments={Array.isArray(detail.attachments)
                ? detail.attachments as readonly AccountingRecord[] : []}
              canManage={permissionSet.manage && !["posted", "reversed"].includes(String(detail.status))}
              onAttach={async (input) => {
                await client.post(`general-expenses/${id}/attachments`, input);
                refresh();
              }}
            />
          ) : null}
          {["journals", "opening-balances"].includes(section) && permissionSet.manage
            && String(detail.status) === "draft" ? (
              <button className="button button-secondary" onClick={() => setAddingLine(true)} type="button">
                <Plus size={16} />{t("accounting.actions.addLine")}
              </button>
            ) : null}
          <div className="accounting-lifecycle-actions">
            {definition.actions?.filter((item) =>
              (permissionSet[item.permission] || (section === "events" && permissionSet.post))
              && actionAvailable(section, detail, item.action),
            ).map((item) => (
              <button className="button button-secondary" key={item.action}
                onClick={() => setAction({ action: item, record: detail })} type="button">
                {t(`accounting.actions.${item.action}`, { defaultValue: item.action })}
              </button>
            ))}
          </div>
        </LoadPanel>
      )}
      {creating ? (
        <RecordForm fields={definition.createFields ?? []} onCancel={() => setCreating(false)}
          onSubmit={submitCreate} submitLabel={t("common.create")} />
      ) : null}
      {addingLine ? (
        <RecordForm fields={[
          { name: "accountId", required: true },
          { name: "debit", required: true, type: "money" },
          { name: "credit", required: true, type: "money" },
          { name: "description", type: "textarea" },
          { name: "subledgerType" },
          { name: "subledgerId" },
        ]} onCancel={() => setAddingLine(false)} onSubmit={submitLine}
          submitLabel={t("accounting.actions.addLine")} />
      ) : null}
      {action === undefined ? null : (
        <ActionDialog action={action.action.action}
          amount={action.record.totalAmount ?? action.record.grossAmount ?? action.record.amount}
          onClose={() => setAction(undefined)}
          onConfirm={(input) => executeAction(action.action, action.record, input)}
          recordReference={referenceOf(action.record, definition.referenceKeys)}
          requireDate={action.action.reversalDate} requireReason={action.action.reason} />
      )}
      {!bulkReprocessing ? null : (
        <ActionDialog
          action="bulkReprocess"
          onClose={() => setBulkReprocessing(false)}
          onConfirm={async ({ reason }) => {
            await client.post("events/reprocess", { eventIds: [...selectedIds], reason });
            setSelectedIds(new Set());
            setBulkPreview(undefined);
            refresh();
          }}
          recordReference={`${String(bulkPreview?.eligibleCount ?? 0)} / ${String(bulkPreview?.requestedCount ?? selectedIds.size)}`}
          requireReason
        />
      )}
    </section>
  );
}
