import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import type { CompanySettings } from "../../api/contracts.js";
import { PageHeader } from "../../components/PageHeader.js";
import { parseMoneyInput, safeMoneyValue } from "../../utils/numeric-input.js";
import { AddExpenseCategoryDialog } from "./AddExpenseCategoryDialog.js";
import { AccountingRecoveryNavigation } from "./BatchOperationsPage.js";
import {
  AttachmentPanel,
  AccountingDocumentActions,
  AccountingTable,
  ActionDialog,
  DirectionalText,
  LoadPanel,
  RecordDetail,
  RecordForm,
  StatusBadge,
  SummaryCards,
  accountingPermissions,
  isMoneySummaryKey,
  summaryCardLabel,
  formatAccountingDate,
  formatAed,
  type AccountingColumn,
} from "./AccountingComponents.js";
import { RelatedRecords, type RelatedRecord } from "./RelatedRecords.js";
import { RecordPaymentWorkflow } from "./ExpensePaymentsPage.js";
import {
  EventFailureDetails,
  EventLifecycleBanner,
  EventProcessingTimeline,
  EventReprocessAction,
} from "./AccountingEventLifecyclePanels.js";
import { eventLifecycle } from "./accounting-event-lifecycle.js";
import {
  eventRelatedRecords,
  expenseRelatedRecords,
  journalLineRelatedRecord,
  eventSourceRelatedRecord,
  journalLink,
  journalRelatedRecords,
  journalSourceRecord,
  openingBalanceRelatedRecords,
} from "./accounting-related.js";
import {
  accountLabel as accountPartsLabel,
  accountingLabel,
  eventTypeLabel,
  operationalAreaLabel,
  partyLabel,
  subledgerReference,
  subledgerTypeLabel,
} from "./accounting-labels.js";
import {
  AccountingFilterSummary,
  AccountingPagination,
  SortableHeader,
} from "./AccountingListControls.js";
import { useListState, type ListStateControls } from "./use-list-state.js";
import { useAccountingFocus } from "./accounting-focus.js";
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
  readonly permission?: "accounts" | "configure" | "manage" | "periods";
  readonly referenceKeys: readonly string[];
  readonly summaryPath?: string;
}

/**
 * Outstanding placeholder for an Expense that has not been approved yet, so
 * an unrecognised liability is never shown as a settled AED 0.00. The amount
 * that WOULD become outstanding on approval is offered as a tooltip.
 */
function NotYetRecognizedAmount({ expected }: { readonly expected: string }) {
  const { t } = useTranslation();
  return (
    <span
      className="accounting-pending-amount"
      title={t("accounting.expenses.expectedAfterApproval", {
        amount: formatAed(expected),
        defaultValue: `Expected after approval: ${formatAed(expected)}`,
      })}
    >
      {t("accounting.expenses.notYetRecognized", { defaultValue: "Not yet recognized" })}
    </span>
  );
}

const notYetRecognized = (expected: string) => <NotYetRecognizedAmount expected={expected} />;

/**
 * Payment position of an approved General Expense plus the direct Record
 * Payment action and every related record, all addressed by business
 * reference. Read-only: it never creates a Payment — Record Payment opens the
 * Payment workflow with this Expense already selected.
 */
function ExpensePaymentPanel({
  client,
  canRecordPayment,
  companyId,
  expense,
  expenseId,
  onPaymentRecorded,
  onNavigate,
}: {
  readonly client: AccountingApi;
  readonly canRecordPayment: boolean;
  readonly companyId: string;
  readonly expense: AccountingRecord;
  readonly expenseId: string;
  readonly onPaymentRecorded: () => void;
  readonly onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [recordingPayment, setRecordingPayment] = useState(false);
  const payments = Array.isArray(expense.payments)
    ? (expense.payments as readonly AccountingRecord[])
    : [];
  const events = Array.isArray(expense.accountingEvents)
    ? (expense.accountingEvents as readonly AccountingRecord[])
    : [];
  const expenseJournal = events.find(
    (event) => event.eventType === "general_expense_approved" && event.journalId != null,
  );
  const paymentJournals = events.filter(
    (event) => event.eventType === "general_expense_payment_completed" && event.journalId != null,
  );
  const outstanding = safeMoneyValue(moneyInput(expense.outstandingAmount));
  const payable =
    canRecordPayment &&
    ["approved", "partially_paid"].includes(String(expense.status ?? "")) &&
    outstanding > 0;
  return (
    <section className="accounting-preview-panel">
      <h3>{t("accounting.payments.paymentPosition")}</h3>
      <dl className="accounting-detail-grid accounting-allocation-grid">
        <div>
          <dt>{t("accounting.payments.paymentStatus")}</dt>
          <dd>
            <StatusBadge value={expense.paymentStatus} />
          </dd>
        </div>
        <div>
          <dt>{t("accounting.payments.paidAmount")}</dt>
          <dd>{formatAed(expense.paidAmount)}</dd>
        </div>
        <div>
          <dt>{t("accounting.payments.outstandingAmount")}</dt>
          <dd>{formatAed(expense.outstandingAmount)}</dd>
        </div>
      </dl>
      {payable ? (
        <div className="accounting-lifecycle-actions">
          <button
            className="button button-primary"
            onClick={() => setRecordingPayment((current) => !current)}
            type="button"
          >
            {recordingPayment
              ? t("common.cancel")
              : t("accounting.actions.recordPayment", { defaultValue: "Pay this expense" })}
          </button>
        </div>
      ) : null}
      {!recordingPayment ? null : (
        <RecordPaymentWorkflow
          client={client}
          companyId={companyId}
          embedded
          onCancel={() => setRecordingPayment(false)}
          onConfirmed={() => {
            setRecordingPayment(false);
            onPaymentRecorded();
          }}
          preselectedExpenseId={expenseId}
        />
      )}
      <h4>{t("accounting.payments.relatedPayments")}</h4>
      <AccountingTable
        columns={[
          { key: "paymentNumber", label: t("accounting.fields.paymentNumber"), technical: true },
          { date: true, key: "paymentDate", label: t("accounting.fields.paymentDate") },
          { key: "amount", label: t("accounting.fields.amount"), money: true },
          { key: "status", label: t("accounting.fields.status"), status: true },
        ]}
        empty={t("accounting.payments.noPayments")}
        items={payments}
        onOpen={(row) => onNavigate(`/accounting/expense-payments/${String(row.id)}`)}
      />
      <h4>{t("accounting.payments.relatedRecords")}</h4>
      <div className="accounting-lifecycle-actions">
        <button
          className="button button-secondary"
          disabled={expenseJournal === undefined}
          onClick={() => onNavigate(`/accounting/journals/${String(expenseJournal?.journalId)}`)}
          type="button"
        >
          {t("accounting.payments.openExpenseJournal")}
        </button>
        {paymentJournals.map((event) => (
          <button
            className="button button-secondary"
            key={String(event.id)}
            onClick={() => onNavigate(`/accounting/journals/${String(event.journalId)}`)}
            type="button"
          >
            {t("accounting.payments.openPaymentJournal")}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Read-only Accounting Preview: the Journal approval WOULD create, the
 * accounts each line resolves to, the outstanding amount that would be
 * recognised, and any blocking issues. Displays server-resolved data only —
 * it never posts, and never computes accounts itself.
 */
function AccountingPreviewPanel({ preview }: { readonly preview: AccountingRecord }) {
  const { t } = useTranslation();
  const lines = Array.isArray(preview.lines) ? (preview.lines as readonly AccountingRecord[]) : [];
  const issues = Array.isArray(preview.issues) ? (preview.issues as readonly string[]) : [];
  const warnings = Array.isArray(preview.warnings) ? (preview.warnings as readonly string[]) : [];
  if (lines.length === 0 && issues.length === 0) return null;
  const accountLabel = (line: AccountingRecord) =>
    line.accountCode === null || line.accountCode === undefined
      ? t("accounting.preview.unresolvedAccount", { defaultValue: "Unresolved" })
      : `${String(line.accountCode)} — ${String(line.accountNameEn ?? "")}`;
  return (
    <section className="accounting-preview-panel">
      <h3>{t("accounting.preview.title", { defaultValue: "Accounting Preview" })}</h3>
      <p className="accounting-preview-note">
        {t("accounting.preview.description", {
          defaultValue: "The Journal that approval will create. Nothing is posted yet.",
        })}
      </p>
      {issues.length === 0 ? null : (
        <div className="alert alert-error" role="alert">
          <strong>
            {t("accounting.preview.blocked", { defaultValue: "Approval is blocked" })}
          </strong>
          <ul>
            {issues.map((issue) => (
              <li key={issue}>
                {t(`accounting.preview.issues.${issue.split(":")[0]}`, { defaultValue: issue })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warnings.map((warning) => (
        <p className="field-hint" key={warning}>
          {t(`accounting.preview.warnings.${warning}`, { defaultValue: warning })}
        </p>
      ))}
      <div className="table-scroll-x">
        <table className="data-table accounting-table">
          <thead>
            <tr>
              <th>{t("accounting.preview.account", { defaultValue: "Account" })}</th>
              <th>{t("accounting.preview.description", { defaultValue: "Description" })}</th>
              <th>{t("accounting.preview.debit", { defaultValue: "Debit" })}</th>
              <th>{t("accounting.preview.credit", { defaultValue: "Credit" })}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={`${String(line.accountCode ?? "")}-${String(line.entryIntent)}-${index}`}>
                <td>
                  <DirectionalText>{accountLabel(line)}</DirectionalText>
                </td>
                <td>{String(line.description ?? "—")}</td>
                <td>{line.entryIntent === "debit" ? formatAed(line.amount) : "—"}</td>
                <td>{line.entryIntent === "credit" ? formatAed(line.amount) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="accounting-detail-grid accounting-preview-totals">
        <div>
          <dt>{t("accounting.preview.gross", { defaultValue: "Gross Amount" })}</dt>
          <dd>{formatAed(preview.grossAmount)}</dd>
        </div>
        <div>
          <dt>
            {t("accounting.preview.currentOutstanding", { defaultValue: "Current Outstanding" })}
          </dt>
          <dd>{formatAed(preview.currentOutstanding)}</dd>
        </div>
        <div>
          <dt>
            {t("accounting.preview.expectedOutstanding", {
              defaultValue: "Expected After Approval",
            })}
          </dt>
          <dd>{formatAed(preview.expectedOutstandingAfterApproval)}</dd>
        </div>
      </dl>
    </section>
  );
}

// Mirrors `generalExpensePayeeTypes` in the API's general-expense DTO, which
// validates this field with @IsIn — the two lists must stay in step.
const generalExpensePayeeTypes = [
  "supplier",
  "employee",
  "driver",
  "trader",
  "government",
  "landlord",
  "service_provider",
  "other",
] as const;

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
      {
        name: "accountType",
        required: true,
        type: "select",
        options: ["asset", "liability", "equity", "revenue", "expense"].map((value) => ({
          label: value,
          value,
        })),
      },
      { name: "accountClass", required: true },
      {
        name: "normalBalance",
        required: true,
        type: "select",
        options: ["debit", "credit"].map((value) => ({ label: value, value })),
      },
      { name: "isPostingAccount", type: "checkbox" },
      { name: "isControlAccount", type: "checkbox" },
      {
        name: "currency",
        required: true,
        type: "select",
        options: [{ label: "AED", value: "AED" }],
      },
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
      {
        name: "currency",
        required: true,
        type: "select",
        options: [{ label: "AED", value: "AED" }],
      },
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
      { action: "return-to-draft", permission: "manage", reason: true },
      { action: "delete", permission: "manage", reason: true },
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
    // Keys must match the list endpoint's aliases exactly. They previously did
    // not: `operationalArea` (returned as `area`) and `effectiveAccountingDate`
    // (returned as `accountingDate`) rendered blank, and `processingStatus`
    // (returned as `status`) resolved to undefined so every row showed the
    // status "Unknown". Event Type and Area now resolve to business labels.
    columns: [
      { key: "eventType", label: "Event", labelNamespace: "accounting.eventTypes" },
      { key: "area", label: "Area", labelNamespace: "accounting.operationalAreas" },
      { key: "sourceReference", label: "Source", technical: true },
      { date: true, key: "accountingDate", label: "Accounting date" },
      { key: "status", label: "Status", status: true },
      { key: "failureCategory", label: "Failure", labelNamespace: "accounting.failureCategories" },
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
      {
        name: "code",
        hidden: true,
        helperText: "Auto-generated on save in the format EXP-000001",
      },
      { name: "nameEn", required: true },
      { name: "nameAr" },
      {
        name: "defaultExpenseMappingKey",
        required: true,
        type: "select",
        options: [
          { label: "General expense", value: "general_expense" },
          { label: "Fuel / Petrol", value: "fuel_expense" },
          { label: "Salik / Toll", value: "salik_expense" },
          { label: "Parking", value: "parking_expense" },
          { label: "Driver advance", value: "driver_advance" },
          { label: "Office rent", value: "office_rent_expense" },
          { label: "Maintenance", value: "maintenance_expense" },
          { label: "Bank charges", value: "bank_charges" },
          { label: "Other operating expense", value: "other_operating_expense" },
        ],
      },
      {
        name: "defaultVatTreatment",
        required: true,
        type: "select",
        options: [
          "standard_rated",
          "zero_rated",
          "exempt",
          "out_of_scope",
          "non_recoverable",
          "partially_recoverable",
        ].map((value) => ({ label: value, value })),
      },
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
      // No `reason: true` on Submit or Approve, unlike the transitions below:
      // neither has a dedicated reason column to fill -- only Reject's and
      // Cancel's reasons are persisted (`rejection_reason`/
      // `cancellation_reason` in `general-expense.service.ts`; Approve's own
      // `reason(input.reason)` call only ever lands in the accounting event's
      // `metadata.reason`, not a durable column). Forcing the operator to
      // type one added friction with no business payoff. Matches the
      // existing convention already used for Journal's own `approve`/`post`/
      // `validate` actions below, which never required one either. The
      // backend still receives a non-empty `reason` on every "expenses"
      // action regardless -- `submitAction`'s payload falls back to
      // `accounting.confirmation.confirmedByUser` when the operator leaves it
      // blank, so `GeneralExpenseReasonDto`'s own requirement is still
      // satisfied without any backend change.
      { action: "submit", permission: "manage" },
      { action: "withdraw", permission: "manage", reason: true },
      { action: "approve", permission: "approve" },
      { action: "reject", permission: "approve", reason: true },
      { action: "return-to-draft", permission: "manage", reason: true },
      { action: "cancel", permission: "manage", reason: true },
      { action: "reverse", permission: "reverse", reason: true, reversalDate: true },
    ],
    // Primary columns only — they must fit without horizontal scrolling.
    // `paymentStatus`, category, VAT and the accounting date remain available
    // on the record detail. Gross reads `totalAmount`, the field the list
    // endpoint actually returns; the previous `grossAmount` key does not
    // exist in the response, so every row rendered AED 0.00.
    columns: [
      { key: "expenseNumber", label: "Expense", technical: true },
      { date: true, key: "expenseDate", label: "Expense date" },
      { key: "payeeName", label: "Payee" },
      { key: "totalAmount", label: "Gross", money: true },
      { key: "paidAmount", label: "Paid", money: true },
      {
        key: "outstandingAmount",
        label: "Outstanding",
        // Outstanding is `approved_amount - paid_amount`, so it is legitimately
        // zero until approval. Showing a bare AED 0.00 reads as "nothing is
        // owed", so an unapproved Expense states that it is not yet recognised.
        render: (row) =>
          ["approved", "partially_paid", "paid", "reversed"].includes(String(row.status ?? ""))
            ? formatAed(row.outstandingAmount)
            : notYetRecognized(String(row.totalAmount ?? "0")),
      },
      { key: "status", label: "Status", status: true },
    ],
    // The operator-facing form is deliberately simple: one Category, one
    // Amount. `submitCreate` (below) builds the single accounting line the
    // backend requires from Category + Description + Amount -- the raw line
    // fields (category, description, quantity, unit amount, VAT treatment,
    // VAT rate, recoverable %, mapping key) used to be typed here directly;
    // they still exist on the backend/domain model (`GeneralExpenseLineDto`)
    // and are still shown, read-only, on an Expense's own detail page. See
    // the report for the full audit of why they were removed from Create.
    createFields: [
      {
        name: "expenseDate",
        type: "date",
        label: "Expense Date",
        helperText: "Accounting date will be set automatically to match",
      },
      // accountingDate is auto-set to match expenseDate on the backend
      // Required here now that it also drives the accounting line
      // `submitCreate` builds automatically -- the backend line always needs
      // a Category (`GeneralExpenseLineDto.categoryId`).
      { name: "categoryId", required: true },
      { name: "payeeType" },
      { name: "payeeName" },
      {
        name: "payeeContact",
        placeholder: "+971 50 123 4567",
        helperText: "Mobile or phone number (e.g., +971 50 123 4567)",
      },
      { name: "referenceNumber" },
      // Required here (unlike the header `description` column, which is
      // optional) because it becomes the accounting line's own description,
      // and the backend rejects an empty one (`GeneralExpenseLineDto`).
      { name: "description", required: true, type: "textarea" },
      { name: "amount", required: true, type: "money" },
      { name: "notes", type: "textarea" },
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
      {
        name: "type",
        required: true,
        type: "select",
        options: ["main_cash", "branch_cash", "petty_cash", "cash_drawer", "safe", "other"].map(
          (value) => ({ label: value, value }),
        ),
      },
      { name: "locationOrCustodian" },
      { name: "linkedGlAccountId", required: true, type: "account" },
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
      {
        name: "accountType",
        required: true,
        type: "select",
        options: ["current", "savings", "merchant", "settlement", "other"].map((value) => ({
          label: value,
          value,
        })),
      },
      { name: "linkedGlAccountId", required: true, type: "account" },
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

function accountLabel(account: AccountingRecord): string {
  const code = recordText(account, "code", "accountCode", "account_code");
  const name = recordText(
    account,
    "nameEn",
    "name_en",
    "displayName",
    "display_name",
    "name",
    "nameAr",
    "name_ar",
  );
  if (code !== "" && name !== "") return `${code} — ${name}`;
  return name || code || String(account.id ?? "");
}

function recordText(record: AccountingRecord, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function recordBoolean(record: AccountingRecord, ...keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "active"].includes(normalized)) return true;
      if (["false", "0", "no", "inactive"].includes(normalized)) return false;
    }
  }
  return undefined;
}

function normalizeAccountToken(value: string): string {
  return value.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function normalizedAccountType(account: AccountingRecord): string {
  return normalizeAccountToken(recordText(account, "accountType", "account_type", "type"));
}

function normalizedAccountClass(account: AccountingRecord): string {
  return normalizeAccountToken(recordText(account, "accountClass", "account_class", "class"));
}

function accountSearchText(account: AccountingRecord): string {
  return [
    recordText(account, "code", "accountCode", "account_code"),
    recordText(account, "nameEn", "name_en", "displayName", "display_name", "name"),
    recordText(account, "nameAr", "name_ar"),
    normalizedAccountType(account),
    normalizedAccountClass(account),
    recordText(account, "normalBalance", "normal_balance"),
  ]
    .map((value) => String(value ?? "").toLocaleLowerCase())
    .join(" ");
}

function flattenAccounts(accounts: readonly AccountingRecord[]): readonly AccountingRecord[] {
  const flattened: AccountingRecord[] = [];
  for (const account of accounts) {
    flattened.push(account);
    const children = account.children ?? account.accounts;
    if (Array.isArray(children))
      flattened.push(...flattenAccounts(children as readonly AccountingRecord[]));
  }
  return flattened;
}

function accountOptionsForSection(
  accounts: readonly AccountingRecord[],
  section: AccountingSection,
) {
  const flattened = flattenAccounts(accounts);
  return flattened
    .filter((account) => {
      const isPosting = recordBoolean(
        account,
        "isPostingAccount",
        "is_posting_account",
        "postingAccount",
        "posting",
      );
      const isActive = recordBoolean(account, "isActive", "is_active", "active", "enabled");
      const status = normalizeAccountToken(recordText(account, "status"));
      return isPosting === true && isActive !== false && status !== "inactive";
    })
    .filter((account) => {
      const accountType = normalizedAccountType(account);
      const accountClass = normalizedAccountClass(account);
      if (section === "cash-accounts") {
        return accountType === "asset" && accountClass === "cash";
      }
      if (section === "bank-accounts") {
        return accountType === "asset" && accountClass === "bank";
      }
      return true;
    })
    .map((account) => {
      const label = accountLabel(account);
      return {
        label,
        searchText: `${label} ${accountSearchText(account)}`,
        value: String(account.id ?? ""),
      };
    })
    .filter((option) => option.value !== "");
}

interface ManualJournalAccountOption {
  readonly code: string;
  readonly isControlAccount: boolean;
  readonly label: string;
  readonly searchText: string;
  readonly value: string;
}

function manualJournalAccountOptions(
  accounts: readonly AccountingRecord[],
): readonly ManualJournalAccountOption[] {
  return flattenAccounts(accounts)
    .filter((account) => {
      const isPosting = recordBoolean(
        account,
        "isPostingAccount",
        "is_posting_account",
        "postingAccount",
        "posting",
        "isPosting",
        "is_posting",
      );
      const isActive = recordBoolean(account, "isActive", "is_active", "active", "enabled");
      const isControl = recordBoolean(
        account,
        "isControlAccount",
        "is_control_account",
        "controlAccount",
        "control",
        "isControl",
        "is_control",
      );
      const isSummary = recordBoolean(
        account,
        "isSummaryAccount",
        "is_summary_account",
        "summaryAccount",
        "summary",
        "isSummary",
        "is_summary",
      );
      const status = normalizeAccountToken(recordText(account, "status"));
      return (
        isPosting === true &&
        isActive !== false &&
        isSummary !== true &&
        !["inactive", "disabled", "archived"].includes(status)
      );
    })
    .map((account) => {
      const code = recordText(account, "code", "accountCode", "account_code");
      const label = accountLabel(account);
      return {
        code,
        isControlAccount:
          recordBoolean(
            account,
            "isControlAccount",
            "is_control_account",
            "controlAccount",
            "control",
            "isControl",
            "is_control",
          ) === true,
        label,
        searchText: `${label} ${accountSearchText(account)}`.toLocaleLowerCase(),
        value: String(account.id ?? ""),
      };
    })
    .filter((option) => option.value !== "");
}

function parseJournalAmountInput(value: string): {
  readonly invalid: boolean;
  readonly value: number;
} {
  const text = value.trim();
  if (text === "") return { invalid: false, value: 0 };
  const parsed = parseMoneyInput(text, { allowZero: true, required: true });
  if (!parsed.ok) return { invalid: true, value: 0 };
  return { invalid: false, value: parsed.value };
}

function positiveMoneyInput(value: string): boolean {
  const parsed = parseJournalAmountInput(value);
  return !parsed.invalid && parsed.value > 0;
}

function accountingFormErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (Array.isArray(error.details) && error.details.length > 0) return error.details.join("\n");
    return error.message || error.code || fallback;
  }
  if (error instanceof Error && error.message !== "") {
    if (error.message === "journal_line_single_side_required")
      return "Enter a Debit or Credit amount.";
    return error.message;
  }
  return fallback;
}

type TranslationFn = (key: string, options?: { readonly defaultValue?: string }) => string;

/**
 * Adapt i18next's `t` to the narrow contract the accounting helpers want.
 *
 * `TranslationFn` deliberately accepts an OPTIONAL options object whose
 * `defaultValue` is itself optional. Under `exactOptionalPropertyTypes` that is
 * not assignable to i18next's `TFunction`, whose matching overload requires the
 * options object to be present with a non-undefined `defaultValue`.
 *
 * The two shapes are both correct for their own side; the adapter reconciles
 * them explicitly by choosing the right overload rather than casting. Keeping
 * it here also keeps the i18next generic out of the validation helpers, which
 * should only ever need "give me a string for this key".
 */
const asTranslationFn =
  (t: TFunction): TranslationFn =>
  (key, options) =>
    options?.defaultValue === undefined ? t(key) : t(key, { defaultValue: options.defaultValue });

function hasLinkedGlAccount(record: AccountingRecord | undefined): boolean {
  return (
    record !== undefined &&
    (recordText(record, "linkedGlAccountId") !== "" ||
      recordText(record, "linkedGlAccountCode") !== "" ||
      recordText(record, "linkedGlAccountName") !== "")
  );
}

function bankAccountEditFields(
  section: AccountingSection,
  fields: readonly FieldDefinition[],
): readonly FieldDefinition[] {
  if (section !== "bank-accounts") return fields;
  const hiddenForEdit = new Set(["accountNumber", "iban"]);
  return fields.filter((field) => !hiddenForEdit.has(field.name));
}

function bankAccountEditInitial(record: AccountingRecord | undefined): AccountingRecord {
  if (record === undefined) return {};
  const initial: Record<string, unknown> = {};
  const fieldNames = [
    "code",
    "accountName",
    "bankName",
    "branchName",
    "swiftCode",
    "accountType",
    "linkedGlAccountId",
    "effectiveFrom",
    "effectiveTo",
    "description",
    "version",
  ] as const;
  for (const key of fieldNames) {
    const value = record[key];
    if (value !== undefined && value !== null) initial[key] = value;
  }
  return initial;
}

function bankAccountDisplayRecord(record: AccountingRecord, t: TranslationFn): AccountingRecord {
  const glLinked = hasLinkedGlAccount(record);
  const isActive = recordBoolean(record, "isActive", "is_active", "active");
  const linkedGlAccount = glLinked
    ? accountLabel({
        code: record.linkedGlAccountCode,
        id: record.linkedGlAccountId,
        name: record.linkedGlAccountName,
      })
    : t("accounting.glLink.notLinked", { defaultValue: "Not Linked" });
  return {
    code: record.code,
    accountName: record.accountName,
    bankName: record.bankName,
    branchName: record.branchName,
    maskedAccountNumber: record.maskedAccountNumber,
    maskedIban: record.maskedIban,
    swiftCode: record.swiftCode,
    accountType: record.accountType,
    currency: record.currency,
    isActive:
      isActive === false
        ? t("common.inactive", { defaultValue: "Inactive" })
        : t("common.active", { defaultValue: "Active" }),
    glLinkStatus: glLinked
      ? t("accounting.glLink.linked", { defaultValue: "Linked" })
      : t("accounting.glLink.notLinked", { defaultValue: "Not Linked" }),
    linkedGlAccount,
    effectiveFrom: record.effectiveFrom,
    effectiveTo: record.effectiveTo,
    description: record.description,
    version: record.version,
  };
}

function chooseOpeningBalanceAccount(
  accounts: readonly AccountingRecord[],
  keywords: readonly string[],
  fallbackType: string,
): AccountingRecord | undefined {
  return (
    accounts.find((account) =>
      keywords.some((keyword) => accountSearchText(account).includes(keyword)),
    ) ??
    accounts.find((account) => normalizedAccountType(account) === fallbackType) ??
    accounts[0]
  );
}

function hasValidOpeningBalanceLines(lines: readonly AccountingRecord[]): boolean {
  if (lines.length < 2) return false;
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    const debit = safeMoneyValue(
      typeof line.debit === "string" || typeof line.debit === "number" ? line.debit : undefined,
    );
    const credit = safeMoneyValue(
      typeof line.credit === "string" || typeof line.credit === "number" ? line.credit : undefined,
    );
    if ((debit > 0 && credit > 0) || (debit <= 0 && credit <= 0)) return false;
    totalDebit += debit;
    totalCredit += credit;
  }
  return totalDebit > 0 && Math.abs(totalDebit - totalCredit) < 0.005;
}

function OpeningBalanceCreateForm({
  accounts,
  loadingAccounts,
  onCancel,
  onSubmit,
}: {
  readonly accounts: readonly AccountingRecord[];
  readonly loadingAccounts: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const postingAccounts = useMemo(
    () =>
      accounts.filter((account) => account.isPostingAccount === true && account.isActive !== false),
    [accounts],
  );
  const defaultDebitAccount = chooseOpeningBalanceAccount(
    postingAccounts,
    ["cash", "bank", "asset"],
    "asset",
  );
  const defaultCreditAccount = chooseOpeningBalanceAccount(
    postingAccounts.filter(
      (account) => String(account.id ?? "") !== String(defaultDebitAccount?.id ?? ""),
    ),
    ["opening", "capital", "equity", "retained"],
    "equity",
  );
  const [amount, setAmount] = useState("");
  const [creditAccountId, setCreditAccountId] = useState("");
  const [debitAccountId, setDebitAccountId] = useState("");
  const [description, setDescription] = useState("Opening Balance");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [error, setError] = useState<string>();
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const selectedDebitAccountId = debitAccountId || String(defaultDebitAccount?.id ?? "");
  const selectedCreditAccountId = creditAccountId || String(defaultCreditAccount?.id ?? "");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    const parsedAmount = parseMoneyInput(amount, { allowZero: false, required: true });
    if (!parsedAmount.ok) {
      setError("Enter a valid opening balance amount greater than zero.");
      return;
    }
    if (effectiveDate.trim() === "") {
      setError("Select the opening balance effective date.");
      return;
    }
    if (selectedDebitAccountId === "" || selectedCreditAccountId === "") {
      setError("Select both the opening balance account and the offset account.");
      return;
    }
    if (selectedDebitAccountId === selectedCreditAccountId) {
      setError("The opening balance account and offset account must be different.");
      return;
    }
    const lineDescription = description.trim() || "Opening Balance";
    setPending(true);
    try {
      await onSubmit({
        currency: "AED",
        description: lineDescription,
        effectiveDate,
        openingBalanceAmount: parsedAmount.value,
        openingBalanceCreditAccountId: selectedCreditAccountId,
        openingBalanceDebitAccountId: selectedDebitAccountId,
        notes: notes.trim() || undefined,
      });
    } catch (cause) {
      if (cause instanceof ApiError) {
        if (cause.code === "accounting_fiscal_period_not_found") {
          setError(
            "This opening-balance date is not inside an Accounting Fiscal Period. Create the Fiscal Year with periods, or open the Fiscal Period covering this date, then save again.",
          );
          setPending(false);
          return;
        }
        const details =
          Array.isArray(cause.details) && cause.details.length > 0
            ? `\n${cause.details.join("\n")}`
            : "";
        setError(
          `${cause.message || cause.code || "The opening balance could not be saved."}${details}`,
        );
      } else if (cause instanceof Error) {
        setError(cause.message);
      } else {
        setError("The opening balance could not be saved.");
      }
      setPending(false);
    }
  };

  return (
    <form className="accounting-form" onSubmit={handleSubmit}>
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      <p className="field-hint accounting-form-wide">
        Enter the opening balance once. The system will create the balanced accounting lines
        automatically.
      </p>
      {postingAccounts.length === 0 && !loadingAccounts ? (
        <div className="alert alert-error">
          No active posting accounts are available. Create posting accounts in Chart of Accounts
          first.
        </div>
      ) : null}
      <div className="accounting-form-grid">
        <label>
          Effective date *
          <input
            required
            type="date"
            value={effectiveDate}
            onChange={(event) => setEffectiveDate(event.target.value)}
          />
        </label>
        <label>
          Opening balance amount *
          <input
            inputMode="decimal"
            placeholder="25000.00"
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label>
          Currency *
          <select value="AED" disabled>
            <option value="AED">AED</option>
          </select>
        </label>
        <label>
          Opening balance account * (Debit)
          <select
            required
            value={selectedDebitAccountId}
            onChange={(event) => setDebitAccountId(event.target.value)}
          >
            <option value="">Select account</option>
            {postingAccounts.map((account) => (
              <option key={String(account.id)} value={String(account.id)}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Offset account * (Credit)
          <select
            required
            value={selectedCreditAccountId}
            onChange={(event) => setCreditAccountId(event.target.value)}
          >
            <option value="">Select account</option>
            {postingAccounts.map((account) => (
              <option key={String(account.id)} value={String(account.id)}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
        </label>
        <label className="accounting-form-wide">
          Description *
          <textarea
            required
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label className="accounting-form-wide">
          Notes
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
      </div>
      <div className="accounting-form-actions">
        <button className="button button-secondary" onClick={onCancel} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={pending || postingAccounts.length === 0}
          type="submit"
        >
          {pending ? t("common.saving", { defaultValue: "Saving..." }) : t("common.create")}
        </button>
      </div>
    </form>
  );
}

function OpeningBalanceLinesForm({
  accounts,
  loadingAccounts,
  onCancel,
  onSubmit,
}: {
  readonly accounts: readonly AccountingRecord[];
  readonly loadingAccounts: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const postingAccounts = useMemo(
    () =>
      accounts.filter((account) => account.isPostingAccount === true && account.isActive !== false),
    [accounts],
  );
  const defaultDebitAccount = chooseOpeningBalanceAccount(
    postingAccounts,
    ["cash", "bank", "asset"],
    "asset",
  );
  const defaultCreditAccount = chooseOpeningBalanceAccount(
    postingAccounts.filter(
      (account) => String(account.id ?? "") !== String(defaultDebitAccount?.id ?? ""),
    ),
    ["opening", "capital", "equity", "retained"],
    "equity",
  );
  const [amount, setAmount] = useState("");
  const [creditAccountId, setCreditAccountId] = useState("");
  const [debitAccountId, setDebitAccountId] = useState("");
  const [description, setDescription] = useState("Opening Balance");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const selectedDebitAccountId = debitAccountId || String(defaultDebitAccount?.id ?? "");
  const selectedCreditAccountId = creditAccountId || String(defaultCreditAccount?.id ?? "");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    const parsedAmount = parseMoneyInput(amount, { allowZero: false, required: true });
    if (!parsedAmount.ok) {
      setError("Enter a valid opening balance amount greater than zero.");
      return;
    }
    if (selectedDebitAccountId === "" || selectedCreditAccountId === "") {
      setError("Select both the opening balance account and the offset account.");
      return;
    }
    if (selectedDebitAccountId === selectedCreditAccountId) {
      setError("The opening balance account and offset account must be different.");
      return;
    }
    const lineDescription = description.trim() || "Opening Balance";
    setPending(true);
    try {
      await onSubmit({
        description: lineDescription,
        openingBalanceAmount: parsedAmount.value,
        openingBalanceCreditAccountId: selectedCreditAccountId,
        openingBalanceDebitAccountId: selectedDebitAccountId,
      });
    } catch (cause) {
      if (cause instanceof ApiError) {
        const details =
          Array.isArray(cause.details) && cause.details.length > 0
            ? `\n${cause.details.join("\n")}`
            : "";
        setError(
          `${cause.message || cause.code || "The opening balance lines could not be saved."}${details}`,
        );
      } else if (cause instanceof Error) {
        setError(cause.message);
      } else {
        setError("The opening balance lines could not be saved.");
      }
      setPending(false);
    }
  };

  return (
    <form className="accounting-form" onSubmit={handleSubmit}>
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      <p className="field-hint accounting-form-wide">
        Enter the amount once. The system will replace the opening-balance lines with one Debit line
        and one Credit line.
      </p>
      {postingAccounts.length === 0 && !loadingAccounts ? (
        <div className="alert alert-error">
          No active posting accounts are available. Create posting accounts in Chart of Accounts
          first.
        </div>
      ) : null}
      <div className="accounting-form-grid">
        <label>
          Opening balance amount *
          <input
            inputMode="decimal"
            placeholder="25000.00"
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label>
          Currency *
          <select value="AED" disabled>
            <option value="AED">AED</option>
          </select>
        </label>
        <label>
          Opening balance account * (Debit)
          <select
            required
            value={selectedDebitAccountId}
            onChange={(event) => setDebitAccountId(event.target.value)}
          >
            <option value="">Select account</option>
            {postingAccounts.map((account) => (
              <option key={String(account.id)} value={String(account.id)}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Offset account * (Credit)
          <select
            required
            value={selectedCreditAccountId}
            onChange={(event) => setCreditAccountId(event.target.value)}
          >
            <option value="">Select account</option>
            {postingAccounts.map((account) => (
              <option key={String(account.id)} value={String(account.id)}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
        </label>
        <label className="accounting-form-wide">
          Description *
          <textarea
            required
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </div>
      <div className="accounting-form-actions">
        <button className="button button-secondary" onClick={onCancel} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={pending || postingAccounts.length === 0}
          type="submit"
        >
          {pending ? t("common.saving", { defaultValue: "Saving..." }) : "Save debit and credit"}
        </button>
      </div>
    </form>
  );
}

interface ManualJournalHeaderDraft {
  readonly currency: string;
  readonly description: string;
  readonly journalDate: string;
  readonly notes: string;
  readonly sourceReference: string;
}

interface ManualJournalLineDraft {
  readonly accountDisplay: string;
  readonly accountId: string;
  readonly amountSide?: "credit" | "debit";
  readonly credit: string;
  readonly debit: string;
  readonly description: string;
  readonly localId: string;
  readonly subledgerId: string;
  readonly subledgerType: string;
}

interface ManualJournalLineErrors {
  readonly accountId?: string;
  readonly amount?: string;
  readonly subledger?: string;
}

function makeManualJournalLineId(): string {
  return `journal-line-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emptyManualJournalLine(): ManualJournalLineDraft {
  return {
    accountDisplay: "",
    accountId: "",
    credit: "",
    debit: "",
    description: "",
    localId: makeManualJournalLineId(),
    subledgerId: "",
    subledgerType: "",
  };
}

function dateOnlyFromRecord(
  record: AccountingRecord | undefined,
  ...keys: readonly string[]
): string {
  const value = record === undefined ? "" : recordText(record, ...keys);
  if (value !== "") return value.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function manualJournalHeaderFromRecord(
  record: AccountingRecord | undefined,
): ManualJournalHeaderDraft {
  return {
    currency: recordText(record ?? {}, "currency") || "AED",
    description: recordText(record ?? {}, "description"),
    journalDate: dateOnlyFromRecord(record, "journalDate", "journal_date", "date"),
    notes: recordText(record ?? {}, "notes"),
    sourceReference: recordText(record ?? {}, "sourceReference", "source_reference"),
  };
}

function isAccountingRecord(value: unknown): value is AccountingRecord {
  return typeof value === "object" && value !== null;
}

function journalLineRecords(record: AccountingRecord | undefined): readonly AccountingRecord[] {
  return Array.isArray(record?.lines) ? record.lines.filter(isAccountingRecord) : [];
}

/**
 * Narrow an `unknown` to the inputs the money parsers actually accept.
 *
 * Both call sites read from `Record<string, unknown>` data — an accounting
 * record field and a draft line value — so neither can promise a primitive at
 * compile time.
 *
 * Anything outside `string | number | null | undefined` becomes `undefined`, so
 * `safeMoneyValue` applies its own fallback. That is exactly what already
 * happened at runtime: `parseMoneyInput` rejects a boolean, object or array and
 * returns the fallback, so this narrows the type without changing any result.
 *
 * Deliberately not `String(value)`: stringifying an object would turn
 * "[object Object]" into a parse attempt and could invent a number where the
 * data has none.
 */
function moneyInput(value: unknown): string | number | null | undefined {
  if (value === null || value === undefined) return value;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function normalizeLineAmount(value: unknown): string {
  const amount = safeMoneyValue(moneyInput(value), 0);
  return amount > 0 ? amount.toFixed(2) : "";
}

function manualJournalAmountSide(
  line: Pick<ManualJournalLineDraft, "credit" | "debit">,
): "credit" | "debit" | undefined {
  const debit = moneyInputToCents(line.debit);
  const credit = moneyInputToCents(line.credit);
  const hasDebit = !debit.invalid && debit.cents > 0;
  const hasCredit = !credit.invalid && credit.cents > 0;
  if (hasDebit && !hasCredit) return "debit";
  if (hasCredit && !hasDebit) return "credit";
  return undefined;
}

function normalizeManualJournalLineDraft(line: ManualJournalLineDraft): ManualJournalLineDraft {
  const side = line.amountSide ?? manualJournalAmountSide(line);
  if (side === "debit") {
    if (line.credit !== "" || line.amountSide !== "debit") {
      return { ...line, amountSide: "debit", credit: "" };
    }
    return line;
  }
  if (side === "credit") {
    if (line.debit !== "" || line.amountSide !== "credit") {
      return { ...line, amountSide: "credit", debit: "" };
    }
    return line;
  }
  if (line.amountSide !== undefined) {
    // Omitted, not set to undefined: the draft type treats "no side yet" as an
    // absent property, and an explicit undefined is a different thing.
    const { amountSide: _cleared, ...withoutSide } = line;
    void _cleared;
    return withoutSide;
  }
  return line;
}

function manualJournalLinesFromRecord(
  record: AccountingRecord | undefined,
  accountOptions: readonly ManualJournalAccountOption[],
): readonly ManualJournalLineDraft[] {
  const sourceLines = journalLineRecords(record);
  if (sourceLines.length === 0) return [emptyManualJournalLine(), emptyManualJournalLine()];
  return sourceLines.map((line) => {
    const accountId = recordText(line, "accountId", "account_id");
    const accountCode = recordText(line, "accountCode", "account_code");
    const option =
      accountOptions.find((candidate) => candidate.value === accountId) ??
      accountOptions.find((candidate) => candidate.code === accountCode);
    const debit = normalizeLineAmount(line.debit);
    const credit = normalizeLineAmount(line.credit);
    const amountSide = manualJournalAmountSide({ credit, debit });
    return {
      accountDisplay:
        option?.label ??
        recordText(line, "accountLabel", "accountName", "account_name") ??
        accountCode,
      accountId: option?.value ?? accountId,
      ...(amountSide === undefined ? {} : { amountSide }),
      credit: amountSide === "debit" ? "" : credit,
      debit: amountSide === "credit" ? "" : debit,
      description: recordText(line, "description", "lineDescription", "line_description"),
      localId: makeManualJournalLineId(),
      subledgerId: recordText(line, "subledgerId", "subledger_id"),
      subledgerType: recordText(line, "subledgerType", "subledger_type"),
    };
  });
}

function moneyInputToCents(value: string): { readonly cents: number; readonly invalid: boolean } {
  const parsed = parseJournalAmountInput(value);
  if (parsed.invalid) return { cents: 0, invalid: true };
  return { cents: Math.round(parsed.value * 100), invalid: false };
}

function centsToMoney(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

function formatAccountingCents(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function lineHasContent(line: ManualJournalLineDraft): boolean {
  return (
    line.accountDisplay.trim() !== "" ||
    line.accountId.trim() !== "" ||
    line.description.trim() !== "" ||
    line.subledgerId.trim() !== "" ||
    line.subledgerType.trim() !== "" ||
    line.debit.trim() !== "" ||
    line.credit.trim() !== ""
  );
}

function matchManualJournalAccount(
  line: ManualJournalLineDraft,
  options: readonly ManualJournalAccountOption[],
): ManualJournalAccountOption | undefined {
  const normalized = line.accountDisplay.trim().toLocaleLowerCase();
  return options.find(
    (option) =>
      option.value === line.accountId ||
      option.value === line.accountDisplay ||
      option.code.toLocaleLowerCase() === normalized ||
      option.label.toLocaleLowerCase() === normalized,
  );
}

function validateManualJournalLines(
  lines: readonly ManualJournalLineDraft[],
  accountOptions: readonly ManualJournalAccountOption[],
  t: TranslationFn,
  requireComplete: boolean,
): {
  readonly errors: Readonly<Record<string, ManualJournalLineErrors>>;
  readonly formError: string;
  readonly payloadLines: readonly Record<string, unknown>[];
  readonly totalCreditCents: number;
  readonly totalDebitCents: number;
} {
  const errors: Record<string, ManualJournalLineErrors> = {};
  const payloadLines: Record<string, unknown>[] = [];
  let totalCreditCents = 0;
  let totalDebitCents = 0;
  let nextLineNumber = 1;

  lines.forEach((sourceLine) => {
    const line = normalizeManualJournalLineDraft(sourceLine);
    if (!lineHasContent(line) && !requireComplete) return;
    if (!lineHasContent(line) && requireComplete) return;

    // Built up field by field, so the local needs to be mutable — but the
    // shared contract stays readonly. A mapped type strips `readonly` here
    // only, and stays derived from `ManualJournalLineErrors` so it cannot
    // drift if a field is added. A mutable object is assignable to the
    // readonly type, so the collected errors go back out unchanged.
    const lineErrors: {
      -readonly [Key in keyof ManualJournalLineErrors]: ManualJournalLineErrors[Key];
    } = {};
    const account = matchManualJournalAccount(line, accountOptions);
    const debit = moneyInputToCents(line.debit);
    const credit = moneyInputToCents(line.credit);
    const hasDebit = !debit.invalid && debit.cents > 0;
    const hasCredit = !credit.invalid && credit.cents > 0;

    if (account === undefined) {
      lineErrors.accountId = t("accounting.manualJournalEditor.errors.accountRequired", {
        defaultValue: "Select an Account.",
      });
    }
    if (debit.invalid || credit.invalid) {
      lineErrors.amount = t("accounting.manualJournalEditor.errors.invalidAmount", {
        defaultValue: "Enter a valid positive amount.",
      });
    } else if (hasDebit && hasCredit) {
      lineErrors.amount = t("accounting.manualJournalEditor.errors.singleSide", {
        defaultValue: "A line cannot contain both Debit and Credit.",
      });
    } else if (!hasDebit && !hasCredit) {
      lineErrors.amount = t("accounting.manualJournalEditor.errors.amountRequired", {
        defaultValue: "Enter a Debit or Credit amount.",
      });
    }
    if (account?.isControlAccount === true && line.subledgerId.trim() === "") {
      lineErrors.subledger = t("accounting.manualJournalEditor.errors.subledgerRequired", {
        defaultValue: "Select the required subledger.",
      });
    }

    if (Object.keys(lineErrors).length > 0) {
      errors[sourceLine.localId] = lineErrors;
      return;
    }

    const debitCents = hasDebit ? debit.cents : 0;
    const creditCents = hasCredit ? credit.cents : 0;
    const amountSide = hasDebit ? "debit" : "credit";
    totalDebitCents += debitCents;
    totalCreditCents += creditCents;
    payloadLines.push({
      accountId: account?.value,
      amountSide,
      credit: amountSide === "credit" ? centsToMoney(creditCents) : null,
      debit: amountSide === "debit" ? centsToMoney(debitCents) : null,
      description: optionalText(line.description),
      lineNumber: nextLineNumber,
      subledgerId: account?.isControlAccount === true ? optionalText(line.subledgerId) : undefined,
      subledgerType:
        account?.isControlAccount === true ? optionalText(line.subledgerType) : undefined,
    });
    nextLineNumber += 1;
  });

  const formError =
    requireComplete && payloadLines.length < 2
      ? t("accounting.manualJournalEditor.errors.minimumLines", {
          defaultValue: "Add at least two Journal lines.",
        })
      : "";

  return {
    errors,
    formError,
    payloadLines,
    totalCreditCents,
    totalDebitCents,
  };
}

/**
 * Read-only Journal lines, rendered from the enriched detail payload.
 *
 * This is what a Posted, Approved, Reversed or Cancelled Journal shows instead
 * of the editor's disabled inputs. Every cell is a business value:
 *
 *  - Account is `Code — Name`, Arabic name in Arabic mode, Code always visible
 *    and always LTR.
 *  - Subledger Type is the translated label, never the stored snake_case value.
 *  - Subledger is the resolved business reference (`EMP-000002 — Shoala`), and
 *    degrades to an em dash rather than to the subledger identifier.
 *  - Related Record links to the source record only where a route is verified
 *    AND the User may open it.
 *
 * No identifier appears in this table; identifiers stay in Technical Details.
 */
function JournalLinesReadOnly({
  language,
  lines,
  onNavigate,
  permissions,
}: {
  readonly language: string;
  readonly lines: readonly AccountingRecord[];
  readonly onNavigate: (path: string) => void;
  readonly permissions: readonly string[];
}) {
  const { t } = useTranslation();
  if (lines.length === 0) {
    return <div className="accounting-empty">{t("accounting.empty")}</div>;
  }
  return (
    <div className="manual-journal-lines">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>{t("accounting.manualJournalEditor.account", { defaultValue: "Account" })}</th>
            <th>
              {t("accounting.manualJournalEditor.lineDescription", {
                defaultValue: "Line Description",
              })}
            </th>
            <th>{t("accounting.manualJournalEditor.debit", { defaultValue: "Debit" })}</th>
            <th>{t("accounting.manualJournalEditor.credit", { defaultValue: "Credit" })}</th>
            <th>{t("accounting.related.subledgerType")}</th>
            <th>{t("accounting.related.subledger")}</th>
            <th>{t("accounting.related.openRecord")}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => {
            const subledgerType = line.subledgerType;
            const reference = subledgerReference(line, language);
            const related = journalLineRelatedRecord(line, language, { permissions, t });
            const linkable =
              related.path !== undefined &&
              related.permitted !== false &&
              related.reference !== undefined;
            return (
              <tr key={String(line.id ?? index)}>
                <td>{String(line.lineNumber ?? index + 1)}</td>
                <td>
                  <DirectionalText>
                    {accountPartsLabel(
                      line.accountCode,
                      line.accountName,
                      line.accountNameAr,
                      language,
                    )}
                  </DirectionalText>
                </td>
                <td>{String(line.description ?? "—")}</td>
                <td>{formatAed(line.debit)}</td>
                <td>{formatAed(line.credit)}</td>
                <td>
                  {subledgerType === null || subledgerType === undefined || subledgerType === ""
                    ? "—"
                    : subledgerTypeLabel(t, subledgerType)}
                </td>
                <td>
                  {reference === undefined ? (
                    "—"
                  ) : (
                    <DirectionalText>{reference.label}</DirectionalText>
                  )}
                </td>
                <td>
                  {linkable ? (
                    <button
                      className="accounting-related-link"
                      onClick={() => onNavigate(related.path!)}
                      type="button"
                    >
                      <DirectionalText>{related.reference}</DirectionalText>
                    </button>
                  ) : related.reference === undefined ? (
                    <span className="accounting-pending-amount">{related.emptyState}</span>
                  ) : (
                    <span
                      className="accounting-related-disabled"
                      title={
                        related.permitted === false
                          ? t("accounting.related.restricted")
                          : related.disabledReason
                      }
                    >
                      <DirectionalText>{related.reference}</DirectionalText>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ManualJournalEditor({
  accounts,
  accountsError,
  accountsLoading,
  canApprove,
  canManage,
  canPost,
  canReverse,
  client,
  initialRecord,
  listPath,
  onCancel,
  onNavigate,
  onSaved,
  permissions,
}: {
  readonly accounts: readonly AccountingRecord[];
  readonly accountsError?: string | null;
  readonly accountsLoading: boolean;
  readonly canApprove: boolean;
  readonly canManage: boolean;
  readonly canPost: boolean;
  readonly canReverse: boolean;
  readonly client: AccountingApi;
  readonly initialRecord?: AccountingRecord;
  readonly listPath: string;
  readonly onCancel: () => void;
  readonly onNavigate: (path: string) => void;
  readonly onSaved: (recordId?: string) => void;
  readonly permissions: readonly string[];
}) {
  const { i18n, t } = useTranslation();
  const language = i18n.resolvedLanguage ?? "en";
  const accountOptions = useMemo(() => manualJournalAccountOptions(accounts), [accounts]);
  const [header, setHeader] = useState<ManualJournalHeaderDraft>(() =>
    manualJournalHeaderFromRecord(initialRecord),
  );
  const [lineErrors, setLineErrors] = useState<Readonly<Record<string, ManualJournalLineErrors>>>(
    {},
  );
  const [lines, setLines] = useState<readonly ManualJournalLineDraft[]>(() =>
    manualJournalLinesFromRecord(initialRecord, accountOptions),
  );
  const [formError, setFormError] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [reverseReason, setReverseReason] = useState("");
  // The Reversal Reason box stays hidden until the User actually starts the
  // Reverse action, so a Posted Journal reads as a record, not as a form.
  const [reverseStarted, setReverseStarted] = useState(false);
  const accountListId = `manual-journal-account-options-${String(initialRecord?.id ?? "new")}`;
  const recordId = String(initialRecord?.id ?? "");
  const status = String(initialRecord?.status ?? "draft");
  const isExisting = recordId !== "";
  // "approved" is read-only too: the database history guard only lets an
  // approved Journal transition to posted/cancelled — any content edit is
  // rejected server-side, so the form must not offer one.
  const isReadOnly = ["approved", "posted", "reversed", "cancelled"].includes(status);
  const totals = useMemo(
    () => validateManualJournalLines(lines, accountOptions, asTranslationFn(t), false),
    [accountOptions, lines, t],
  );
  // The Journal's operational source, resolved once for the read-only header.
  // Same helper the Related Records panel uses, so the two can never disagree.
  const sourceLink = useMemo(
    () =>
      initialRecord === undefined
        ? undefined
        : journalSourceRecord(initialRecord, { permissions, t }),
    [initialRecord, permissions, t],
  );
  const differenceCents = totals.totalDebitCents - totals.totalCreditCents;
  const balanced = differenceCents === 0 && totals.totalDebitCents > 0;

  useEffect(() => {
    setHeader(manualJournalHeaderFromRecord(initialRecord));
    setLines(manualJournalLinesFromRecord(initialRecord, accountOptions));
    setLineErrors({});
    setFormError("");
    // Reset the editor only when the selected Journal changes. Account options load
    // asynchronously; tying this reset to accountOptions can wipe user-entered lines
    // right after the selector data arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRecord]);

  // The editor renders BELOW the list on the same page, so opening it (Create
  // or a row click) would otherwise leave the viewport parked at the top with
  // the form out of sight — bring its first field into view instead.
  const editorRef = useRef<HTMLElement>(null);
  useEffect(() => {
    editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [initialRecord]);

  const updateLine = (localId: string, patch: Partial<ManualJournalLineDraft>) => {
    setLines((current) =>
      current.map((line) => (line.localId === localId ? { ...line, ...patch } : line)),
    );
    setLineErrors((current) => {
      const next = { ...current };
      delete next[localId];
      return next;
    });
  };

  const handleAccountChange = (line: ManualJournalLineDraft, value: string) => {
    const draftLine = { ...line, accountDisplay: value };
    const matched = matchManualJournalAccount(draftLine, accountOptions);
    updateLine(line.localId, {
      accountDisplay: value,
      accountId: matched?.value ?? "",
    });
  };

  const handleAccountBlur = (line: ManualJournalLineDraft) => {
    const matched = matchManualJournalAccount(line, accountOptions);
    if (matched !== undefined) {
      updateLine(line.localId, { accountDisplay: matched.label, accountId: matched.value });
    }
  };

  const handleDebitChange = (line: ManualJournalLineDraft, value: string) => {
    const isDebitSide = positiveMoneyInput(value);
    // Typing a debit claims the debit side; clearing it releases the side only
    // if this line held it. "Release" means omit the key, not send undefined.
    const nextSide = isDebitSide
      ? "debit"
      : line.amountSide === "debit"
        ? undefined
        : line.amountSide;
    updateLine(line.localId, {
      ...(nextSide === undefined ? {} : { amountSide: nextSide }),
      credit: isDebitSide ? "" : line.credit,
      debit: value,
    });
  };

  const handleCreditChange = (line: ManualJournalLineDraft, value: string) => {
    const isCreditSide = positiveMoneyInput(value);
    const nextSide = isCreditSide
      ? "credit"
      : line.amountSide === "credit"
        ? undefined
        : line.amountSide;
    updateLine(line.localId, {
      ...(nextSide === undefined ? {} : { amountSide: nextSide }),
      credit: value,
      debit: isCreditSide ? "" : line.debit,
    });
  };

  const persistJournal = async (requireComplete: boolean, requireBalanced: boolean) => {
    const normalizedLines = lines.map(normalizeManualJournalLineDraft);
    if (normalizedLines.some((line, index) => line !== lines[index])) {
      setLines(normalizedLines);
    }
    const validation = validateManualJournalLines(
      normalizedLines,
      accountOptions,
      asTranslationFn(t),
      requireComplete,
    );
    const nextFormErrors: string[] = [];
    if (header.description.trim() === "") {
      nextFormErrors.push(
        t("accounting.manualJournalEditor.errors.descriptionRequired", {
          defaultValue: "Enter a Journal description.",
        }),
      );
    }
    if (validation.formError !== "") nextFormErrors.push(validation.formError);
    if (requireBalanced && validation.totalDebitCents !== validation.totalCreditCents) {
      nextFormErrors.push(
        t("accounting.manualJournalEditor.errors.notBalanced", {
          defaultValue: "Journal is not balanced.",
        }),
      );
    }
    setLineErrors(validation.errors);
    if (Object.keys(validation.errors).length > 0 || nextFormErrors.length > 0) {
      setFormError(nextFormErrors.join("\n"));
      return undefined;
    }
    // A single line can never satisfy the server's two-line minimum; failing
    // here keeps the whole save atomic instead of leaving a header-only draft.
    if (validation.payloadLines.length === 1) {
      setFormError(
        t("accounting.manualJournalEditor.errors.minimumLines", {
          defaultValue: "Add at least two Journal lines.",
        }),
      );
      return undefined;
    }
    // Header and lines are saved in ONE request (and one server transaction):
    // either everything is stored or nothing is, so a rejected line can no
    // longer leave behind an orphaned header-only draft. With no lines yet
    // (header-only draft), the `lines` field is simply omitted. Currency is
    // create-only (always AED) — UpdateJournalDto does not accept it.
    const headerPayload = {
      description: header.description.trim(),
      journalDate: header.journalDate,
      notes: optionalText(header.notes),
      sourceReference: optionalText(header.sourceReference),
      ...(validation.payloadLines.length >= 2 ? { lines: validation.payloadLines } : {}),
    };
    if (isExisting) {
      await client.patch(`${listPath}/${recordId}`, headerPayload);
      return recordId;
    }
    const created = await client.post<AccountingRecord>(listPath, {
      ...headerPayload,
      currency: header.currency || "AED",
    });
    return String(created.id ?? "");
  };

  const runAction = async (action: string) => {
    setPendingAction(action);
    setFormError("");
    try {
      // A read-only Journal (approved and beyond) cannot be re-saved — the
      // backend rejects any edit — so lifecycle actions like Post run
      // directly against the already-stored record.
      const savedId = isReadOnly
        ? recordId
        : action === "save"
          ? await persistJournal(false, false)
          : await persistJournal(true, true);
      if (savedId === undefined || savedId === "") return;
      if (action === "validate") {
        await client.post(`${listPath}/${savedId}/validate`, {});
      } else if (action === "approve") {
        if (status === "draft") await client.post(`${listPath}/${savedId}/validate`, {});
        await client.post(`${listPath}/${savedId}/approve`, {});
      } else if (action === "post") {
        await client.post(`${listPath}/${savedId}/post`, {});
      }
      onSaved(savedId);
    } catch (error) {
      setFormError(
        accountingFormErrorMessage(
          error,
          t("accounting.manualJournalEditor.errors.saveFailed", {
            defaultValue: "The Journal could not be saved.",
          }),
        ),
      );
    } finally {
      setPendingAction("");
    }
  };

  const handleReverse = async () => {
    if (!isExisting) return;
    if (reverseReason.trim() === "") {
      setFormError(
        t("accounting.manualJournalEditor.errors.reversalReasonRequired", {
          defaultValue: "Enter a reversal reason.",
        }),
      );
      return;
    }
    setPendingAction("reverse");
    try {
      await client.post(`${listPath}/${recordId}/reverse`, {
        reason: reverseReason.trim(),
        reversalReason: reverseReason.trim(),
        // Required by ReverseJournalDto to resolve the Fiscal Period the
        // reversal posts into. This form had no date field at all, so the
        // request always reached the server without one -- `@Matches` alone
        // does not reject an absent value, so it silently became `undefined`
        // rather than a validation error, and the date-to-Period lookup then
        // matched zero rows. Defaults to today, same as every other reversal
        // in this app: a reversal is posted the day it is performed.
        reversalDate: new Date().toISOString().slice(0, 10),
      });
      onSaved(recordId);
    } catch (error) {
      setFormError(
        accountingFormErrorMessage(
          error,
          t("accounting.manualJournalEditor.errors.reverseFailed", {
            defaultValue: "The Journal could not be reversed.",
          }),
        ),
      );
    } finally {
      setPendingAction("");
    }
  };

  return (
    <section className="manual-journal-editor" ref={editorRef}>
      {formError === "" ? null : <div className="form-error">{formError}</div>}
      <div className="manual-journal-card">
        <div className="manual-journal-section-heading">
          <h3>
            {isExisting
              ? String(initialRecord?.journalNumber ?? "")
              : t("accounting.manualJournalEditor.newJournal", { defaultValue: "New Journal" })}
          </h3>
          <StatusBadge value={status} />
        </div>
        {isReadOnly ? (
          // A read-only Journal is a record, not a form: the header renders as
          // labelled values with a friendly Source Type and a Source Reference
          // that links only where a route is verified.
          <dl className="accounting-detail-grid">
            <div>
              <dt>{t("accounting.fields.journalNumber", { defaultValue: "Journal Number" })}</dt>
              <dd>
                <DirectionalText>{String(initialRecord?.journalNumber ?? "—")}</DirectionalText>
              </dd>
            </div>
            <div>
              <dt>{t("accounting.fields.status", { defaultValue: "Status" })}</dt>
              <dd>
                <StatusBadge value={status} />
              </dd>
            </div>
            <div>
              <dt>
                {t("accounting.manualJournalEditor.journalDate", { defaultValue: "Journal Date" })}
              </dt>
              <dd>{formatAccountingDate(header.journalDate, language)}</dd>
            </div>
            <div>
              <dt>{t("accounting.manualJournalEditor.currency", { defaultValue: "Currency" })}</dt>
              <dd>
                <DirectionalText>{header.currency || "AED"}</DirectionalText>
              </dd>
            </div>
            <div className="manual-journal-wide">
              <dt>
                {t("accounting.manualJournalEditor.description", { defaultValue: "Description" })}
              </dt>
              <dd>{header.description === "" ? "—" : header.description}</dd>
            </div>
            <div>
              <dt>{t("accounting.related.sourceType", { defaultValue: "Source Type" })}</dt>
              <dd>
                {accountingLabel(
                  t,
                  "accounting.journalSources",
                  initialRecord?.journalSource ?? initialRecord?.sourceEntityType,
                )}
              </dd>
            </div>
            <div>
              <dt>
                {t("accounting.manualJournalEditor.sourceReference", {
                  defaultValue: "Source Reference",
                })}
              </dt>
              <dd>
                {sourceLink === undefined ? (
                  <DirectionalText>
                    {header.sourceReference === "" ? "—" : header.sourceReference}
                  </DirectionalText>
                ) : sourceLink.path !== undefined && sourceLink.permitted !== false ? (
                  <button
                    className="accounting-related-link"
                    onClick={() => onNavigate(sourceLink.path!)}
                    type="button"
                  >
                    <DirectionalText>{sourceLink.reference}</DirectionalText>
                  </button>
                ) : sourceLink.reference === undefined ? (
                  <span className="accounting-pending-amount">{sourceLink.emptyState}</span>
                ) : (
                  <span
                    className="accounting-related-disabled"
                    title={
                      sourceLink.permitted === false
                        ? t("accounting.related.restricted")
                        : sourceLink.disabledReason
                    }
                  >
                    <DirectionalText>{sourceLink.reference}</DirectionalText>
                  </span>
                )}
              </dd>
            </div>
            {header.notes === "" ? null : (
              <div className="manual-journal-wide">
                <dt>{t("accounting.manualJournalEditor.notes", { defaultValue: "Notes" })}</dt>
                <dd>{header.notes}</dd>
              </div>
            )}
          </dl>
        ) : (
          <div className="manual-journal-header-grid">
            <label>
              {t("accounting.manualJournalEditor.journalDate", { defaultValue: "Journal Date" })} *
              <input
                disabled={isReadOnly}
                onChange={(event) =>
                  setHeader({ ...header, journalDate: event.currentTarget.value })
                }
                type="date"
                value={header.journalDate}
              />
            </label>
            <label>
              {t("accounting.manualJournalEditor.currency", { defaultValue: "Currency" })}
              <input readOnly value={header.currency || "AED"} />
            </label>
            <label className="manual-journal-wide">
              {t("accounting.manualJournalEditor.description", { defaultValue: "Description" })} *
              <input
                disabled={isReadOnly}
                onChange={(event) =>
                  setHeader({ ...header, description: event.currentTarget.value })
                }
                value={header.description}
              />
            </label>
            <label>
              {t("accounting.manualJournalEditor.sourceReference", {
                defaultValue: "Source Reference",
              })}
              <input
                disabled={isReadOnly}
                onChange={(event) =>
                  setHeader({ ...header, sourceReference: event.currentTarget.value })
                }
                value={header.sourceReference}
              />
            </label>
            <label className="manual-journal-wide">
              {t("accounting.manualJournalEditor.notes", { defaultValue: "Notes" })}
              <textarea
                disabled={isReadOnly}
                onChange={(event) => setHeader({ ...header, notes: event.currentTarget.value })}
                value={header.notes}
              />
            </label>
          </div>
        )}
      </div>

      <div className="manual-journal-card">
        <div className="manual-journal-section-heading">
          <h3>{t("accounting.manualJournalEditor.lines", { defaultValue: "Journal lines" })}</h3>
          <span>
            {accountsLoading
              ? t("common.loading", { defaultValue: "Loading..." })
              : accountsError !== undefined && accountsError !== null
                ? t("accounting.manualJournalEditor.accountLoadFailed", {
                    defaultValue: "Could not load Accounts.",
                  })
                : accountOptions.length === 0
                  ? t("accounting.manualJournalEditor.noAccounts", {
                      defaultValue: "No active posting accounts are available.",
                    })
                  : t("accounting.manualJournalEditor.accountHelp", {
                      defaultValue: "Search by Account code, English name, or Arabic name.",
                    })}
          </span>
        </div>
        <datalist id={accountListId}>
          {accountOptions.map((option) => (
            <option key={option.value} value={option.label} />
          ))}
        </datalist>
        {isReadOnly ? (
          // A read-only Journal shows the ENRICHED lines, not disabled inputs:
          // resolved Account "Code — Name", a translated Subledger Type, the
          // subledger's business reference, and a link to the source record
          // where a verified route exists. No identifier is rendered here.
          <JournalLinesReadOnly
            language={language}
            lines={journalLineRecords(initialRecord)}
            onNavigate={onNavigate}
            permissions={permissions}
          />
        ) : (
          <div className="manual-journal-lines">
            <table>
              <thead>
                <tr>
                  <th>
                    {t("accounting.manualJournalEditor.account", { defaultValue: "Account" })}
                  </th>
                  <th>
                    {t("accounting.manualJournalEditor.lineDescription", {
                      defaultValue: "Line Description",
                    })}
                  </th>
                  <th>{t("accounting.manualJournalEditor.debit", { defaultValue: "Debit" })}</th>
                  <th>{t("accounting.manualJournalEditor.credit", { defaultValue: "Credit" })}</th>
                  <th>
                    {t("accounting.manualJournalEditor.subledger", { defaultValue: "Subledger" })}
                  </th>
                  <th>{t("accounting.manualJournalEditor.remove", { defaultValue: "Remove" })}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const selectedAccount = matchManualJournalAccount(line, accountOptions);
                  const errors = lineErrors[line.localId];
                  return (
                    <tr key={line.localId}>
                      <td>
                        <input
                          autoComplete="off"
                          className="manual-journal-account-input"
                          disabled={isReadOnly}
                          list={accountListId}
                          onBlur={() => handleAccountBlur(line)}
                          onChange={(event) => handleAccountChange(line, event.currentTarget.value)}
                          placeholder={t("accounting.manualJournalEditor.accountPlaceholder", {
                            defaultValue: "Search Account",
                          })}
                          value={line.accountDisplay}
                        />
                        {errors?.accountId === undefined ? null : (
                          <span className="form-field-error">{errors.accountId}</span>
                        )}
                      </td>
                      <td>
                        <input
                          disabled={isReadOnly}
                          onChange={(event) =>
                            updateLine(line.localId, { description: event.currentTarget.value })
                          }
                          value={line.description}
                        />
                      </td>
                      <td>
                        <input
                          className="manual-journal-amount-input"
                          disabled={isReadOnly || positiveMoneyInput(line.credit)}
                          inputMode="decimal"
                          onChange={(event) => handleDebitChange(line, event.currentTarget.value)}
                          value={line.debit}
                        />
                      </td>
                      <td>
                        <input
                          className="manual-journal-amount-input"
                          disabled={isReadOnly || positiveMoneyInput(line.debit)}
                          inputMode="decimal"
                          onChange={(event) => handleCreditChange(line, event.currentTarget.value)}
                          value={line.credit}
                        />
                        {errors?.amount === undefined ? null : (
                          <span className="form-field-error">{errors.amount}</span>
                        )}
                      </td>
                      <td>
                        {selectedAccount?.isControlAccount === true ? (
                          <div className="manual-journal-subledger">
                            <input
                              disabled={isReadOnly}
                              onChange={(event) =>
                                updateLine(line.localId, {
                                  subledgerType: event.currentTarget.value,
                                })
                              }
                              placeholder={t("accounting.manualJournalEditor.subledgerType", {
                                defaultValue: "Subledger Type",
                              })}
                              value={line.subledgerType}
                            />
                            <input
                              disabled={isReadOnly}
                              onChange={(event) =>
                                updateLine(line.localId, { subledgerId: event.currentTarget.value })
                              }
                              placeholder={t("accounting.manualJournalEditor.subledgerReference", {
                                defaultValue: "Subledger Reference",
                              })}
                              value={line.subledgerId}
                            />
                            {errors?.subledger === undefined ? null : (
                              <span className="form-field-error">{errors.subledger}</span>
                            )}
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <button
                          className="button button-secondary"
                          disabled={isReadOnly || lines.length <= 1}
                          onClick={() =>
                            setLines((current) =>
                              current.filter((candidate) => candidate.localId !== line.localId),
                            )
                          }
                          type="button"
                        >
                          {t("common.remove", { defaultValue: "Remove" })}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {isReadOnly ? null : (
          <button
            className="button button-secondary"
            onClick={() => setLines((current) => [...current, emptyManualJournalLine()])}
            type="button"
          >
            {t("accounting.manualJournalEditor.addLine", { defaultValue: "Add Line" })}
          </button>
        )}
      </div>
      <div className="manual-journal-totals">
        <div className="manual-journal-total-card">
          <span>
            {t("accounting.manualJournalEditor.totalDebit", { defaultValue: "Total Debit" })}
          </span>
          <strong>{formatAccountingCents(totals.totalDebitCents, header.currency || "AED")}</strong>
        </div>
        <div className="manual-journal-total-card">
          <span>
            {t("accounting.manualJournalEditor.totalCredit", { defaultValue: "Total Credit" })}
          </span>
          <strong>
            {formatAccountingCents(totals.totalCreditCents, header.currency || "AED")}
          </strong>
        </div>
        <div className="manual-journal-total-card">
          <span>
            {t("accounting.manualJournalEditor.difference", { defaultValue: "Difference" })}
          </span>
          <strong>
            {formatAccountingCents(Math.abs(differenceCents), header.currency || "AED")}
          </strong>
        </div>
        <div className="manual-journal-total-card">
          <span>
            {t("accounting.manualJournalEditor.status", { defaultValue: "Balance status" })}
          </span>
          <strong className={balanced ? "manual-journal-balanced" : "manual-journal-unbalanced"}>
            {balanced
              ? t("accounting.manualJournalEditor.balanced", { defaultValue: "Balanced" })
              : t("accounting.manualJournalEditor.unbalanced", { defaultValue: "Unbalanced" })}
          </strong>
        </div>
      </div>
      {status === "posted" && canReverse && reverseStarted ? (
        <label className="manual-journal-card">
          {t("accounting.manualJournalEditor.reversalReason", {
            defaultValue: "Reversal Reason",
          })}
          <textarea
            onChange={(event) => setReverseReason(event.currentTarget.value)}
            value={reverseReason}
          />
        </label>
      ) : null}
      <div className="manual-journal-actions">
        <button
          className="button button-secondary"
          disabled={pendingAction !== ""}
          onClick={() => {
            onCancel();
            // Return the viewport to the list heading the editor was opened from.
            window.scrollTo({ behavior: "smooth", top: 0 });
          }}
          type="button"
        >
          {t("common.back")}
        </button>
        {/* Editing actions are HIDDEN, not merely disabled, once a Journal is
            approved or beyond: the backend rejects any edit, so offering a
            greyed-out Save/Validate/Approve only invites a dead click.
            "approved" still shows Post, which is its one legal transition. */}
        {isReadOnly ? null : (
          <>
            <button
              className="button button-secondary"
              disabled={pendingAction !== "" || !canManage}
              onClick={() => void runAction("save")}
              type="button"
            >
              {t("accounting.manualJournalEditor.saveDraft", { defaultValue: "Save Draft" })}
            </button>
            <button
              className="button button-secondary"
              disabled={pendingAction !== "" || !canManage}
              onClick={() => void runAction("validate")}
              type="button"
            >
              {t("accounting.actions.validate", { defaultValue: "Validate" })}
            </button>
            <button
              className="button button-secondary"
              disabled={pendingAction !== "" || !canApprove}
              onClick={() => void runAction("approve")}
              type="button"
            >
              {t("accounting.actions.approve", { defaultValue: "Approve" })}
            </button>
          </>
        )}
        {status !== "approved" ? null : (
          <button
            className="button button-primary"
            disabled={pendingAction !== "" || !canPost}
            onClick={() => void runAction("post")}
            type="button"
          >
            {t("accounting.actions.post", { defaultValue: "Post" })}
          </button>
        )}
        {status === "posted" && canReverse ? (
          <button
            className="button button-danger"
            disabled={pendingAction !== ""}
            // First click reveals the Reversal Reason; the second confirms.
            onClick={() => (reverseStarted ? void handleReverse() : setReverseStarted(true))}
            type="button"
          >
            {reverseStarted
              ? t("accounting.manualJournalEditor.confirmReverse", {
                  defaultValue: "Confirm Reverse",
                })
              : t("accounting.actions.reverse", { defaultValue: "Reverse" })}
          </button>
        ) : null}
        {!reverseStarted ? null : (
          <button
            className="button button-secondary"
            disabled={pendingAction !== ""}
            onClick={() => {
              setReverseStarted(false);
              setReverseReason("");
            }}
            type="button"
          >
            {t("common.cancel", { defaultValue: "Cancel" })}
          </button>
        )}
      </div>
    </section>
  );
}

/* Exported for tests: the lifecycle table below is the single place deciding
   which actions a record offers, and it is worth asserting directly. */
export function actionAvailable(
  section: AccountingSection,
  record: AccountingRecord,
  action: string,
): boolean {
  // `processing_status` is included because the Accounting Event DETAIL payload
  // is the raw row (snake_case) while the list aliases it to `status` — without
  // it the Event action gate silently never matched.
  const status = String(record.status ?? record.processingStatus ?? record.processing_status ?? "");
  const active = record.isActive === true;
  if (action === "activate") return !active;
  if (action === "deactivate") return active;
  const allowed: Readonly<
    Partial<Record<AccountingSection, Readonly<Record<string, readonly string[]>>>>
  > = {
    "fiscal-years": {
      close: ["open", "reopened"],
      open: ["draft"],
      reopen: ["closed"],
    },
    "fiscal-periods": {
      close: ["open", "reopened", "soft_closed"],
      open: ["future"],
      reopen: ["closed"],
      "soft-close": ["open", "reopened"],
    },
    journals: {
      approve: ["balanced"],
      cancel: ["draft", "balanced", "approved"],
      post: ["approved"],
      reverse: ["posted"],
      validate: ["draft", "balanced"],
    },
    "opening-balances": {
      approve: ["validated"],
      post: ["approved"],
      /* The way back for a Batch that was validated but never approved. The
         demotion has always existed — editing a validated Batch performs it —
         but without an action of its own there was no way to ask for it, so a
         validated Batch's only forward move was Approve. Validated only:
         approved and posted Batches stay immutable, and a posted one is
         corrected by Reverse, never by this. */
      "return-to-draft": ["validated"],
      /* Draft only. A Draft has produced no Journal, no Event and no ledger
         movement, so removing it is not a financial act. Everything from
         `validated` on is reached through Return to draft first, and a posted
         Batch is corrected by Reverse and never deleted. */
      delete: ["draft"],
      reverse: ["posted"],
      /* Draft only. The service still accepts a `validated` batch — that path
         exists so a batch which no longer balances is demoted back to Draft —
         but a validated batch's lines are themselves immutable, so it cannot
         stop balancing and the re-check can only ever be a no-op. Offering
         Validate again just invited a second press; Approve is the real next
         step from here. */
      validate: ["draft"],
    },
    events: {
      reprocess: ["failed", "blocked_configuration", "retry_pending"],
    },
    expenses: {
      approve: ["submitted"],
      cancel: ["draft", "submitted", "rejected"],
      reject: ["submitted"],
      reverse: ["approved", "partially_paid", "paid"],
      submit: ["draft"],
      "return-to-draft": ["rejected"],
      withdraw: ["submitted"],
    },
  };
  const statuses = allowed[section]?.[action];
  if (section === "opening-balances" && action === "validate") {
    const lines = Array.isArray(record.lines) ? (record.lines as readonly AccountingRecord[]) : [];
    if (!hasValidOpeningBalanceLines(lines)) return false;
  }
  return statuses === undefined || statuses.includes(status);
}

/** `Code — Name` for a party carried on a Source Transaction row. */
function sourceParty(
  source: AccountingRecord,
  prefix: "driver" | "trader",
  language: string,
): string {
  return partyLabel(
    source[`${prefix}Code`],
    source[`${prefix}Name`],
    source[`${prefix}NameAr`],
    language,
  );
}

/**
 * The Source Transaction section of an Accounting Event.
 *
 * The shape is driven by `sourceTransaction.kind`, which the backend resolves
 * from the Event's own `source_entity_type`. Only fields the backend actually
 * returned are rendered — a field the source table does not carry is omitted
 * rather than shown as a blank or a zero.
 */
function EventSourceTransaction({
  language,
  source,
}: {
  readonly language: string;
  readonly source: AccountingRecord | undefined;
}) {
  const { t } = useTranslation();
  if (source === undefined) return null;
  if (source.found === false) {
    return (
      <section className="accounting-preview-panel">
        <h3>{t("accounting.related.sourceTransaction")}</h3>
        <p className="accounting-empty">{t("accounting.related.sourceRecordNotFound")}</p>
      </section>
    );
  }
  const kind = String(source.kind ?? "");
  const money = (key: string) =>
    source[key] === null || source[key] === undefined ? undefined : formatAed(source[key]);
  const plain = (key: string) => {
    const value = source[key];
    return value === null || value === undefined || value === "" ? undefined : String(value);
  };
  const party = (prefix: "driver" | "trader") => {
    const label = sourceParty(source, prefix, language);
    return label === "—" ? undefined : label;
  };
  // Each entry is [label, value]; an undefined value is dropped, so no card
  // ever shows an empty row.
  const rowsByKind: Readonly<Record<string, readonly (readonly [string, string | undefined])[]>> = {
    cash_bank_movement: [
      [t("accounting.fields.movementNumber"), plain("movementNumber")],
      [
        t("accounting.related.sourceType"),
        source.movementType === undefined
          ? undefined
          : accountingLabel(t, "accounting.movements.types", source.movementType),
      ],
      [
        t("accounting.related.sourceAccount"),
        plain("sourceAccountCode") === undefined
          ? undefined
          : accountPartsLabel(source.sourceAccountCode, source.sourceAccountName, "", language),
      ],
      [
        t("accounting.related.destinationAccount"),
        plain("destinationAccountCode") === undefined
          ? undefined
          : accountPartsLabel(
              source.destinationAccountCode,
              source.destinationAccountName,
              "",
              language,
            ),
      ],
      [t("accounting.fields.amount"), money("amount")],
    ],
    driver_reconciliation: [
      [t("accounting.related.driverCollection"), plain("reconciliationNumber")],
      [t("accounting.related.driver", { defaultValue: "Driver" }), party("driver")],
      [t("accounting.related.grossCollection"), money("grossCollections")],
      [t("accounting.related.driverExpenses"), money("driverExpenses")],
      [t("accounting.related.feeDeduction"), money("feeDeduction")],
    ],
    general_expense: [
      [t("accounting.fields.expenseNumber"), plain("expenseNumber")],
      [t("accounting.fields.payeeName"), plain("payee")],
      [
        t("accounting.fields.expenseDate", { defaultValue: "Expense Date" }),
        plain("expenseDate") === undefined
          ? undefined
          : formatAccountingDate(source.expenseDate, language),
      ],
      [t("accounting.fields.net"), money("netAmount")],
      [t("accounting.fields.vat"), money("vatAmount")],
      [t("accounting.fields.gross"), money("totalAmount")],
    ],
    general_expense_payment: [
      [t("accounting.fields.paymentNumber"), plain("paymentNumber")],
      [t("accounting.fields.expenseNumber"), plain("expenseNumber")],
      [t("accounting.fields.payeeName"), plain("payee")],
      [t("accounting.fields.amount"), money("amount")],
      [t("accounting.fields.cash"), money("cashAmount")],
      [t("accounting.fields.visa"), money("visaAmount")],
    ],
    order: [
      [t("accounting.related.order"), plain("orderNumber")],
      [t("accounting.related.trader", { defaultValue: "Trader" }), party("trader")],
      [t("accounting.related.driver", { defaultValue: "Driver" }), party("driver")],
      [t("accounting.related.cod"), money("customerAmountDue")],
      [t("accounting.related.serviceFee"), money("serviceFeeNet")],
      [t("accounting.related.traderPayable"), money("traderNetPayable")],
    ],
    outsourced_driver_fee_accrual: [
      [t("accounting.related.driverFeeAccrual"), plain("feeReference")],
      [t("accounting.related.driver", { defaultValue: "Driver" }), party("driver")],
      [t("accounting.related.order"), plain("orderNumber")],
      [t("accounting.fields.amount"), money("feeAmount")],
    ],
    outsourced_driver_fee_payment: [
      [t("accounting.fields.paymentNumber"), plain("paymentNumber")],
      [t("accounting.related.driver", { defaultValue: "Driver" }), party("driver")],
      [t("accounting.fields.amount"), money("amount")],
    ],
    payroll_payment: [
      [t("accounting.fields.paymentNumber"), plain("paymentNumber")],
      [t("accounting.related.payrollPeriod"), plain("periodReference")],
    ],
    payroll_period: [
      [t("accounting.related.payrollPeriod"), plain("periodReference")],
      [t("accounting.related.netPayroll"), money("netPayroll")],
    ],
    trader_collection: [
      [t("accounting.related.traderCollection"), plain("collectionNumber")],
      [t("accounting.related.trader", { defaultValue: "Trader" }), party("trader")],
      [t("accounting.fields.amount"), money("amount")],
    ],
    trader_receivable: [
      [t("accounting.related.traderReceivable"), plain("receivableNumber")],
      [t("accounting.related.trader", { defaultValue: "Trader" }), party("trader")],
      [t("accounting.related.sourceType"), plain("sourceType")],
      [t("accounting.fields.amount"), money("amount")],
    ],
    trader_settlement: [
      [t("accounting.related.traderSettlement"), plain("settlementNumber")],
      [t("accounting.related.trader", { defaultValue: "Trader" }), party("trader")],
      [t("accounting.fields.amount"), money("netPayable")],
    ],
  };
  const rows = (rowsByKind[kind] ?? []).filter(([, value]) => value !== undefined);
  if (rows.length === 0) return null;
  return (
    <section className="accounting-preview-panel">
      <h3>{t("accounting.related.sourceTransaction")}</h3>
      <dl className="accounting-detail-grid">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <DirectionalText>{String(value)}</DirectionalText>
            </dd>
          </div>
        ))}
        <div>
          <dt>{t("accounting.fields.status")}</dt>
          <dd>
            <StatusBadge value={source.status} />
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * Business summary of an Accounting Event: friendly labels only.
 *
 * Amount is the total of the Event's own debit components — the same figure
 * the Journal posts as Total Debit — and shows an em dash rather than 0.00
 * when the Event carries no components.
 */
function AccountingEventSummary({
  detail,
  language,
}: {
  readonly detail: AccountingRecord;
  readonly language: string;
}) {
  const { t } = useTranslation();
  const components = Array.isArray(detail.components)
    ? (detail.components as readonly AccountingRecord[])
    : [];
  const debitCents = components
    .filter((item) => String(item.entryIntent) === "debit")
    .reduce((total, item) => total + Math.round(Number(item.amount ?? 0) * 100), 0);
  // Business Party comes from the resolved Source Transaction — the Event row
  // itself stores no party. Trader first, then Driver, then Expense Payee.
  const source =
    typeof detail.sourceTransaction === "object" && detail.sourceTransaction !== null
      ? (detail.sourceTransaction as AccountingRecord)
      : undefined;
  const partyCandidates =
    source === undefined
      ? []
      : [
          sourceParty(source, "trader", language),
          sourceParty(source, "driver", language),
          String(source.payee ?? "").trim(),
        ];
  const party = partyCandidates.find((value) => value !== "" && value !== "—") ?? "";
  return (
    <section className="accounting-preview-panel">
      <h3>{t("accounting.related.title")}</h3>
      <dl className="accounting-detail-grid">
        <div>
          <dt>{t("accounting.related.event")}</dt>
          <dd>{eventTypeLabel(t, detail.event_type ?? detail.eventType)}</dd>
        </div>
        <div>
          <dt>{t("accounting.fields.area")}</dt>
          <dd>{operationalAreaLabel(t, detail.operational_area ?? detail.area)}</dd>
        </div>
        <div>
          <dt>{t("accounting.fields.status")}</dt>
          <dd>
            <StatusBadge value={detail.processing_status ?? detail.status} />
          </dd>
        </div>
        <div>
          <dt>{t("accounting.fields.accountingDate")}</dt>
          <dd>{formatAccountingDate(detail.effective_accounting_date, language)}</dd>
        </div>
        <div>
          <dt>{t("accounting.fields.attempts")}</dt>
          <dd>{String(detail.attempt_count ?? 0)}</dd>
        </div>
        <div>
          <dt>{t("accounting.related.sourceTransaction")}</dt>
          <dd>
            <DirectionalText>
              {String(detail.sourceReference ?? "") === ""
                ? t("accounting.related.notAvailable")
                : String(detail.sourceReference)}
            </DirectionalText>
          </dd>
        </div>
        {party === "" ? null : (
          <div>
            <dt>{t("accounting.related.businessParty")}</dt>
            <dd>
              <DirectionalText>{party}</DirectionalText>
            </dd>
          </div>
        )}
        <div>
          <dt>{t("accounting.fields.amount")}</dt>
          {/* An em dash, not 0.00: an Event with no components has no amount. */}
          <dd>{debitCents === 0 ? "—" : formatAed((debitCents / 100).toFixed(2))}</dd>
        </div>
        <div>
          <dt>{t("accounting.fields.currency", { defaultValue: "Currency" })}</dt>
          <dd>
            <DirectionalText>{String(detail.currency ?? "AED")}</DirectionalText>
          </dd>
        </div>
        <div>
          <dt>{t("accounting.related.generatedJournal")}</dt>
          <dd>
            <DirectionalText>
              {String(detail.journalNumber ?? "") === ""
                ? t("accounting.related.journalNotCreated")
                : String(detail.journalNumber)}
            </DirectionalText>
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * Accounting Event list columns.
 *
 * Built per render rather than declared statically because three cells need
 * translation, the User's permissions and the navigator: Source Transaction
 * and Journal are links, and the Journal cell has to explain WHY a Journal is
 * missing rather than leaving a blank.
 *
 * Every value comes from the enriched list payload. No cell triggers a
 * request, so the list stays one query regardless of row count.
 */
function eventListColumns(
  t: TFunction,
  language: string,
  onNavigate: (path: string) => void,
  permissions: readonly string[],
): readonly AccountingColumn[] {
  const context = { permissions, t };
  const openLink = (record: RelatedRecord) =>
    record.reference === undefined ? (
      <span className="accounting-pending-amount">{record.emptyState}</span>
    ) : record.path !== undefined && record.permitted !== false ? (
      <button
        className="accounting-related-link"
        onClick={(event) => {
          // The row itself opens the Event; the link must not do both.
          event.stopPropagation();
          onNavigate(record.path!);
        }}
        type="button"
      >
        <DirectionalText>{record.reference}</DirectionalText>
      </button>
    ) : (
      <span
        className="accounting-related-disabled"
        title={
          record.permitted === false ? t("accounting.related.restricted") : record.disabledReason
        }
      >
        <DirectionalText>{record.reference}</DirectionalText>
      </span>
    );
  return [
    {
      key: "eventType",
      label: t("accounting.related.event", { defaultValue: "Event" }),
      render: (row) => eventTypeLabel(t, row.eventType),
    },
    {
      key: "area",
      label: t("accounting.fields.area", { defaultValue: "Area" }),
      render: (row) => operationalAreaLabel(t, row.area),
    },
    {
      key: "sourceReference",
      label: t("accounting.related.sourceTransaction"),
      render: (row) => {
        const record = eventSourceRelatedRecord(row, context);
        return record === undefined ? (
          <span className="accounting-pending-amount">{t("accounting.related.notApplicable")}</span>
        ) : (
          openLink(record)
        );
      },
    },
    {
      key: "partyReference",
      label: t("accounting.related.businessParty"),
      render: (row) => {
        const label = partyLabel(row.partyReference, row.partyName, row.partyNameAr, language);
        return label === "—" ? (
          <span className="accounting-pending-amount">{t("accounting.related.notAvailable")}</span>
        ) : (
          <DirectionalText>{label}</DirectionalText>
        );
      },
    },
    {
      key: "amount",
      label: t("accounting.fields.amount", { defaultValue: "Amount" }),
      // An em dash, never 0.00: an Event type that carries no single
      // authoritative amount must not look like a zero-value transaction.
      render: (row) =>
        row.amount === null || row.amount === undefined || row.amount === ""
          ? "—"
          : formatAed(row.amount),
    },
    { date: true, key: "accountingDate", label: t("accounting.fields.accountingDate") },
    {
      key: "status",
      label: t("accounting.fields.status"),
      // The BUSINESS state, not the stored one: an Event sitting in `received`
      // because its Area is switched off reads "Waiting for Driver Collections
      // Automatic Posting", not a bare "Received" badge.
      render: (row) => {
        const lifecycle = eventLifecycle(row, t);
        return (
          <span className={`accounting-lifecycle-chip ${lifecycle.tone}`}>{lifecycle.label}</span>
        );
      },
    },
    {
      key: "failureCategory",
      label: t("accounting.failures.category"),
      // A concise title only. The full explanation and the required action
      // belong on the detail screen, never as a paragraph inside a table cell.
      render: (row) => {
        const lifecycle = eventLifecycle(row, t);
        return lifecycle.blocker === undefined ? "—" : lifecycle.blocker;
      },
    },
    { key: "attemptCount", label: t("accounting.fields.attempts", { defaultValue: "Attempts" }) },
    {
      key: "journalNumber",
      label: t("accounting.related.generatedJournal"),
      render: (row) => {
        const number = typeof row.journalNumber === "string" ? row.journalNumber.trim() : "";
        if (number !== "") {
          return openLink(
            journalLink(
              String(row.journalId ?? ""),
              number,
              t("accounting.related.openJournal"),
              context,
            ),
          );
        }
        // No Journal: say which of the three reasons applies.
        const status = String(row.status ?? "");
        return (
          <span className="accounting-pending-amount">
            {["failed", "blocked_configuration", "blocked_period"].includes(status)
              ? t("accounting.related.postingFailed", { defaultValue: "Posting Failed" })
              : ["received", "validated", "retry_pending"].includes(status)
                ? t("accounting.related.awaitingPosting", { defaultValue: "Awaiting Posting" })
                : t("accounting.related.journalNotCreated")}
          </span>
        );
      },
    },
  ];
}

/**
 * The three Accounting lists whose page, size, sort and filters live in the
 * URL, with the backend sort keys each one accepts.
 *
 * `sortKeys` mirrors the server's allowlist exactly. A column absent from it
 * renders as a plain header, so the screen can never request a sort the DTO
 * would reject.
 *
 * `search` maps the single search box to that screen's real reference filter —
 * these DTOs have no `search` field, and the API runs with
 * `forbidNonWhitelisted`.
 */
/** Stable empty array: a new literal each render would churn memo deps. */
const noFilterKeys: readonly string[] = [];

const scalableLists: Readonly<
  Record<
    string,
    {
      readonly defaultSortBy: string;
      readonly filterKeys: readonly string[];
      readonly searchKey: string;
      readonly sortKeys: Readonly<Record<string, string>>;
    }
  >
> = {
  events: {
    defaultSortBy: "createdAt",
    filterKeys: [
      "area",
      "dateFrom",
      "dateTo",
      "eventType",
      "failureCategory",
      "sourceReference",
      "status",
    ],
    searchKey: "sourceReference",
    sortKeys: {
      accountingDate: "accountingDate",
      amount: "amount",
      attemptCount: "attemptCount",
      eventType: "eventType",
      journalNumber: "journalNumber",
      sourceReference: "sourceReference",
      status: "status",
    },
  },
  journals: {
    defaultSortBy: "businessDate",
    filterKeys: ["dateFrom", "dateTo", "journalNumber", "journalSource", "status"],
    searchKey: "journalNumber",
    sortKeys: {
      businessDate: "businessDate",
      description: "description",
      journalNumber: "journalNumber",
      status: "status",
      totalCredit: "totalCredit",
      totalDebit: "totalDebit",
    },
  },
  "opening-balances": {
    defaultSortBy: "effectiveDate",
    filterKeys: ["batchNumber", "dateFrom", "dateTo", "fiscalYearId", "status"],
    searchKey: "batchNumber",
    sortKeys: {
      batchNumber: "batchNumber",
      effectiveDate: "effectiveDate",
      status: "status",
      totalCredit: "totalCredit",
      totalDebit: "totalDebit",
    },
  },
};

/**
 * Wraps each column label in a sortable header where the backend allows that
 * column to be sorted.
 *
 * The key comes from the screen's `sortKeys` map, which mirrors the server
 * allowlist — a column missing from it stays a plain header, so the UI can
 * never request a sort the DTO would reject.
 */
function withSortableHeaders(
  columns: readonly AccountingColumn[],
  config: { readonly sortKeys: Readonly<Record<string, string>> } | undefined,
  state: ListStateControls,
): readonly AccountingColumn[] {
  if (config === undefined) return columns;
  return columns.map((column) => {
    const sortKey = config.sortKeys[column.key];
    if (sortKey === undefined) return column;
    return {
      ...column,
      label: <SortableHeader label={column.label} sortKey={sortKey} state={state} />,
    };
  });
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
  readonly id?: string | undefined;
  readonly onNavigate: (path: string) => void;
  readonly permissions: readonly string[];
  readonly section: AccountingSection;
}) {
  const { i18n, t } = useTranslation();
  const language = i18n.resolvedLanguage ?? "en";
  const client = useMemo(() => new AccountingApi(api), [api]);
  const definition = definitions[section];
  const [filters, setFilters] = useState({ page: 1, pageSize: 50, search: "" });
  const [creating, setCreating] = useState(false);
  // Inline "+ Add Category" from the General Expense create form. `patch`
  // auto-selects the new Category on the open `RecordForm` WITHOUT resetting
  // any other field the operator already typed -- see RecordForm's own doc.
  const [addingCategory, setAddingCategory] = useState(false);
  const [categoryPatch, setCategoryPatch] =
    useState<readonly { readonly name: string; readonly value: string }[]>();
  // The three scalable Accounting lists drive their page, size, sort and
  // filters from the URL. Everything else keeps the previous local state, so
  // this phase cannot disturb the lists it is not scoped to.
  const listConfig = scalableLists[section];
  const listState = useListState({
    companyId,
    defaultSortBy: listConfig?.defaultSortBy ?? "createdAt",
    filterKeys: listConfig?.filterKeys ?? noFilterKeys,
  });
  const urlDriven = listConfig !== undefined && id === undefined && !creating;
  // The request the backend actually receives. `search` is deliberately NOT
  // sent: none of these three DTOs declares it, and the global ValidationPipe
  // runs with `forbidNonWhitelisted`, so the old search box was producing a
  // 400 the moment anyone typed in it. It now maps to each screen's real
  // reference filter instead.
  const listQuery = useMemo(
    () =>
      urlDriven
        ? {
            ...listState.filters,
            page: listState.page,
            pageSize: listState.pageSize,
            sortBy: listState.sortBy,
            sortDirection: listState.sortDirection,
          }
        : filters,
    [
      filters,
      listState.filters,
      listState.page,
      listState.pageSize,
      listState.sortBy,
      listState.sortDirection,
      urlDriven,
    ],
  );
  // The inline Create editor is local state, not a route, so it asks the
  // workspace for full-width focus mode directly.
  useAccountingFocus(creating);
  const [editingOpeningBalanceLines, setEditingOpeningBalanceLines] = useState(false);
  const [action, setAction] = useState<{
    readonly action: LifecycleAction;
    readonly record: AccountingRecord;
  }>();
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkReprocessing, setBulkReprocessing] = useState(false);
  const [editingDetail, setEditingDetail] = useState(false);
  const [revision, setRevision] = useState(0);
  // A confirmed Expense Payment changes the Expense totals, its payment status
  // and its Accounting Events, so any screen showing them reloads without the
  // User having to refresh by hand.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reload = () => setRevision((value) => value + 1);
    window.addEventListener("blueline:accounting-expense-payment-recorded", reload);
    return () => window.removeEventListener("blueline:accounting-expense-payment-recorded", reload);
  }, []);
  const permissionSet = accountingPermissions(permissions);
  const detailPath =
    id !== undefined && definition?.detailPath !== undefined
      ? definition.detailPath(id)
      : undefined;
  const queryKey = accountingQueryKey(companyId, `${section}:${detailPath ?? "list"}`, {
    ...listQuery,
    revision,
  });
  const resource = useAccountingResource<unknown>(queryKey, (signal) => {
    if (definition === undefined) return Promise.resolve([]);
    return client.get<unknown>(
      detailPath ?? definition.listPath,
      detailPath === undefined ? listQuery : undefined,
      signal,
    );
  });
  const summary = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, `${section}:summary`, { revision }),
    (signal) =>
      definition?.summaryPath === undefined
        ? Promise.resolve({})
        : client.get<AccountingRecord>(definition.summaryPath, undefined, signal),
  );
  const openingBalanceAccounts = useAccountingResource<readonly AccountingRecord[]>(
    accountingQueryKey(companyId, "opening-balances:account-options", {
      creating,
      editingDetail,
      editingOpeningBalanceLines,
      id,
      revision,
      section,
    }),
    (signal) =>
      (section === "opening-balances" &&
        (creating || editingOpeningBalanceLines || id !== undefined)) ||
      ((creating || editingDetail) && (section === "cash-accounts" || section === "bank-accounts"))
        ? client.accountHierarchy(signal)
        : Promise.resolve([]),
  );
  const manualJournalAccounts = useAccountingResource<readonly AccountingRecord[]>(
    accountingQueryKey(companyId, "journals:account-options", {
      creating,
      id,
      revision,
      section,
    }),
    (signal) =>
      section === "journals" && (creating || id !== undefined)
        ? client.accounts({ activeOnly: true }, signal)
        : Promise.resolve([]),
  );
  // A General Expense cannot be created without a Category (the accounting
  // line the form builds automatically always needs one), so the create form
  // checks whether any ACTIVE Category exists and offers a direct link to the
  // Setup screen when none does. Read-only: never creates or modifies
  // Category data. Each row also carries `defaultVatTreatment` /
  // `defaultExpenseMappingKey`, which `submitCreate` reads to build the line
  // without asking the operator for either.
  const expenseCategoryOptions = useAccountingResource<
    AccountingPage | readonly AccountingRecord[]
  >(
    accountingQueryKey(companyId, "expenses:category-availability", {
      creating,
      revision,
      section,
    }),
    (signal) =>
      section === "expenses" && creating
        ? client.get("general-expenses/categories", { activeOnly: true }, signal)
        : Promise.resolve([]),
  );
  const hasActiveExpenseCategory = normalizePage(expenseCategoryOptions.data).length > 0;
  // VAT is Company-level configuration (`configuration/settings`, the same
  // screen Accounting Configuration itself uses) -- fetched here only so the
  // line the form builds can use the Company's actual standard rate for a
  // `standard_rated` Category. Never rendered as a field: the operator is
  // never asked to type a VAT treatment or rate.
  const companySettings = useAccountingResource<CompanySettings | undefined>(
    accountingQueryKey(companyId, "expenses:company-settings", { creating, section }),
    (signal) =>
      section === "expenses" && creating
        ? api.get<CompanySettings>("configuration/settings", signal)
        : Promise.resolve(undefined),
  );
  // Read-only Accounting Preview for the open Expense: shows the Journal
  // approval WOULD create and whether anything blocks it. Creates nothing.
  const accountingPreview = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "expenses:accounting-preview", { id, revision, section }),
    (signal) =>
      section === "expenses" && id !== undefined
        ? client.get<AccountingRecord>(
            `general-expenses/${id}/accounting-preview`,
            undefined,
            signal,
          )
        : Promise.resolve({} as AccountingRecord),
  );
  const previewBlocked =
    section === "expenses" &&
    Array.isArray(accountingPreview.data?.issues) &&
    accountingPreview.data.issues.length > 0;
  const createFields = useMemo<readonly FieldDefinition[]>(() => {
    const fields = definition?.createFields ?? [];
    // Category and payee-type fields hold IDs/enum codes, never free text: as
    // plain inputs they invited a typed Category NAME, which the API rejects
    // (`must be a UUID`) or — for a well-formed but unknown id — fails as a
    // foreign-key violation surfaced only as a generic integrity error.
    if (section === "expenses") {
      const categoryOptions = normalizePage(expenseCategoryOptions.data).map((category) => ({
        label:
          category.code === undefined || category.code === null
            ? String(category.nameEn ?? category.id)
            : `${String(category.code)} — ${String(category.nameEn ?? "")}`,
        value: String(category.id),
      }));
      const categoryStatus = expenseCategoryOptions.loading
        ? ("loading" as const)
        : expenseCategoryOptions.error === undefined
          ? ("ready" as const)
          : ("error" as const);
      return fields.map((field) => {
        if (field.name === "categoryId") {
          return {
            ...field,
            emptyText: expenseCategoryOptions.loading
              ? t("common.loading", { defaultValue: "Loading..." })
              : t("accounting.expenses.noCategories"),
            options: categoryOptions,
            optionsError: expenseCategoryOptions.error,
            optionsStatus: categoryStatus,
            // Hidden rather than disabled for someone who can create General
            // Expenses but not manage Categories (§8): the Category dropdown
            // itself stays fully usable either way, only the extra control is
            // withheld from someone it was never meant for. In the current
            // permission model the two are the same gate (`accounting.manage`
            // covers both), so this is a hidden case today but not an
            // assumption this code bakes in.
            ...(permissionSet.manage
              ? {
                  trailingAction: {
                    label: t("accounting.expenseCategoryDialog.addCategory"),
                    onClick: () => setAddingCategory(true),
                  },
                }
              : {}),
            type: "select" as const,
          };
        }
        if (field.name === "payeeType") {
          return {
            ...field,
            options: generalExpensePayeeTypes.map((value) => ({ label: value, value })),
            type: "select" as const,
          };
        }
        return field;
      });
    }
    if (section !== "cash-accounts" && section !== "bank-accounts") return fields;
    const options = accountOptionsForSection(normalizePage(openingBalanceAccounts.data), section);
    return fields.map((field) =>
      field.name === "linkedGlAccountId"
        ? {
            ...field,
            emptyText: openingBalanceAccounts.loading
              ? t("common.loading", { defaultValue: "Loading..." })
              : t("accounting.emptyCompatibleAccounts", {
                  defaultValue: "No compatible active posting accounts are available.",
                }),
            options,
            optionsError: openingBalanceAccounts.error,
            optionsStatus: openingBalanceAccounts.loading
              ? "loading"
              : openingBalanceAccounts.error === undefined
                ? "ready"
                : "error",
          }
        : field,
    );
  }, [
    definition?.createFields,
    expenseCategoryOptions.data,
    permissionSet.manage,
    expenseCategoryOptions.error,
    expenseCategoryOptions.loading,
    openingBalanceAccounts.data,
    openingBalanceAccounts.error,
    openingBalanceAccounts.loading,
    section,
    t,
  ]);
  const baseRecords = normalizePage(resource.data);
  // Totals come from the server response, never from the loaded page: a count
  // derived in the browser would only ever describe the current page.
  const listPage =
    typeof resource.data === "object" && resource.data !== null
      ? (resource.data as { total?: number; totalPages?: number })
      : undefined;
  const listTotal = Number(listPage?.total ?? 0);
  const listTotalPages = Number(listPage?.totalPages ?? 0);
  // A stale or hand-edited URL can point past the end of the result set; step
  // back to the last real page instead of showing an empty screen.
  const { page: listPageNumber, setPage: setListPage } = listState;
  useEffect(() => {
    if (!urlDriven || resource.loading) return;
    if (listTotalPages > 0 && listPageNumber > listTotalPages) {
      setListPage(listTotalPages);
    }
  }, [listPageNumber, listTotalPages, resource.loading, setListPage, urlDriven]);
  const records =
    section === "chart-of-accounts"
      ? baseRecords
          .filter(
            (record) =>
              filters.search.trim() === "" ||
              `${String(record.code ?? "")} ${String(record.nameEn ?? "")}`
                .toLocaleLowerCase()
                .includes(filters.search.trim().toLocaleLowerCase()),
          )
          .map((record) => ({
            ...record,
            displayName: `${"› ".repeat(Number(record.depth ?? 0))}${String(record.nameEn ?? "")}`,
          }))
      : baseRecords;
  const detail =
    detailPath === undefined ? undefined : (resource.data as AccountingRecord | undefined);

  if (definition === undefined) return null;
  const canCreate =
    definition.createFields !== undefined &&
    definition.createPath !== undefined &&
    permissionSet[definition.permission ?? "manage"];
  const refresh = () => {
    setRevision((value) => value + 1);
    resource.refresh();
    summary.refresh();
  };
  const submitCreate = async (payload: Record<string, unknown>) => {
    if (section === "expenses") {
      // The operator only fills in Category, Description and Amount -- the
      // single accounting line the backend requires is built here, not typed
      // by hand. `expenseAccountMappingKey` is left unset on purpose: the
      // server itself falls back to the Category's own `defaultExpenseMappingKey`
      // when a line omits it (`replaceLines`), which is exactly the mapping
      // this Category was created (or vetted) against.
      const { amount, ...header } = payload;
      const categoryId = String(header.categoryId ?? "");
      const description = String(header.description ?? "").trim();
      const category = normalizePage(expenseCategoryOptions.data).find(
        (row) => String(row.id) === categoryId,
      );
      // Never asked of the operator: the line's VAT treatment is the
      // Category's own `defaultVatTreatment` (required on every Category).
      // Only a `standard_rated` Category needs an actual rate, taken from the
      // Company's configured VAT settings; every other treatment prices at
      // 0% -- the backend zeroes the rate for zero_rated/exempt/out_of_scope
      // regardless of what is sent (`calculateLine`), so 0% is always safe
      // there.
      const vatTreatment = String(category?.defaultVatTreatment ?? "out_of_scope");
      const vatRate =
        vatTreatment === "standard_rated" && companySettings.data?.vatEnabled === true
          ? String(companySettings.data.vatRate ?? "0")
          : "0";
      await client.post(definition.createPath!, {
        ...header,
        lines: [
          {
            categoryId,
            description,
            quantity: "1",
            unitAmount: amount,
            vatTreatment,
            vatRate,
            // `partially_recoverable` has no stored default on the Category
            // itself; 100% keeps the line's own math internally consistent
            // (fully recoverable) until a future task decides this treatment
            // needs its own operator-facing control.
            ...(vatTreatment === "partially_recoverable" ? { recoverablePercentage: "100" } : {}),
          },
        ],
      });
    } else {
      await client.post(definition.createPath!, payload);
    }
    setCreating(false);
    refresh();
  };
  const submitAndSendForApproval = async (payload: Record<string, unknown>) => {
    if (section !== "expenses") return submitCreate(payload);
    const { amount, ...header } = payload;
    const categoryId = String(header.categoryId ?? "");
    const description = String(header.description ?? "").trim();
    const category = normalizePage(expenseCategoryOptions.data).find(
      (row) => String(row.id) === categoryId,
    );
    const vatTreatment = String(category?.defaultVatTreatment ?? "out_of_scope");
    const vatRate =
      vatTreatment === "standard_rated" && companySettings.data?.vatEnabled === true
        ? String(companySettings.data.vatRate ?? "0")
        : "0";
    const created = await client.post<AccountingRecord>(definition.createPath!, {
      ...header,
      lines: [
        {
          categoryId,
          description,
          quantity: "1",
          unitAmount: amount,
          vatTreatment,
          vatRate,
          ...(vatTreatment === "partially_recoverable" ? { recoverablePercentage: "100" } : {}),
        },
      ],
    });
    await client.post(`general-expenses/${String(created.id)}/submit`, {
      reason: "Created and submitted for approval",
      version: Number(created.version),
    });
    setCreating(false);
    refresh();
  };
  const submitOpeningBalanceLines = async (payload: Record<string, unknown>) => {
    await client.put(`${definition.listPath}/${id}/lines`, payload);
    setEditingOpeningBalanceLines(false);
    refresh();
  };
  const submitDetailEdit = async (payload: Record<string, unknown>) => {
    if (detailPath === undefined || detail === undefined) return;
    const version = detail.version === undefined ? undefined : Number(detail.version);
    await client.patch(detailPath, {
      ...payload,
      version: Number.isNaN(version) ? undefined : version,
    });
    setEditingDetail(false);
    refresh();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("blueline:accounting-cash-bank-links-changed"));
    }
  };
  const executeAction = async (
    lifecycle: LifecycleAction,
    record: AccountingRecord,
    input: { readonly date?: string | undefined; readonly reason?: string | undefined },
  ) => {
    const recordId = String(record.id ?? id);
    /* Deleting a Draft Opening Balance is the one action that removes its own
       record, so it is an HTTP DELETE on the record itself rather than a POST
       to a lifecycle sub-path, and it ends on the list — the detail route it
       was opened from no longer resolves. The shared `ApiClient.delete` sends
       no body, so the reason travels as a query parameter. */
    if (section === "opening-balances" && lifecycle.action === "delete") {
      const reason = input.reason?.trim() ?? "";
      const query = reason === "" ? "" : `?reason=${encodeURIComponent(reason)}`;
      await client.delete(`${definition.listPath}/${recordId}${query}`);
      setAction(undefined);
      onNavigate("/accounting/opening-balances");
      return;
    }
    let path = `${definition.listPath}/${recordId}/${lifecycle.action}`;
    if (section === "chart-of-accounts") path = `accounts/${recordId}/${lifecycle.action}`;
    if (section === "expense-categories")
      path = `general-expenses/categories/${recordId}/${lifecycle.action}`;
    if (section === "cash-accounts")
      path = `cash-bank/cash-accounts/${recordId}/${lifecycle.action}`;
    if (section === "bank-accounts")
      path = `cash-bank/bank-accounts/${recordId}/${lifecycle.action}`;
    if (section === "events" && lifecycle.action === "reprocess")
      path = `events/${recordId}/reprocess`;
    const version = record.version === undefined ? undefined : Number(record.version);
    const payload =
      section === "expenses"
        ? {
            accountingDate: lifecycle.reversalDate ? input.date : undefined,
            reason: input.reason ?? t("accounting.confirmation.confirmedByUser"),
            version,
          }
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
  const detailLines = Array.isArray(detail?.lines)
    ? (detail.lines as readonly AccountingRecord[])
    : [];
  const openingBalanceLinesAreValid = hasValidOpeningBalanceLines(detailLines);
  const canEditOpeningBalanceLines =
    section === "opening-balances" &&
    id !== undefined &&
    permissionSet.manage &&
    ["draft", "validated"].includes(String(detail?.status ?? ""));
  const canEditBankAccount =
    section === "bank-accounts" &&
    id !== undefined &&
    detail !== undefined &&
    permissionSet.configure;
  const bankGlLinked = hasLinkedGlAccount(detail);
  const detailEditFields = bankAccountEditFields(section, createFields);
  const displayedDetail =
    section === "bank-accounts" && detail !== undefined
      ? bankAccountDisplayRecord(detail, (key, options) =>
          t(key, { defaultValue: options?.defaultValue ?? key }),
        )
      : detail;
  // Related Records for the sections that have relationships worth following.
  // Everything it needs already arrives with the detail response, so opening a
  // record still costs exactly one request.
  const relatedRecords =
    detail === undefined
      ? undefined
      : section === "journals"
        ? journalRelatedRecords(detail, { permissions, t })
        : section === "events"
          ? eventRelatedRecords(detail, { permissions, t })
          : section === "expenses"
            ? expenseRelatedRecords(detail, { permissions, t })
            : section === "opening-balances"
              ? openingBalanceRelatedRecords(detail, { permissions, t })
              : undefined;
  return (
    <section className="accounting-page">
      <PageHeader
        actions={
          <>
            <button className="button button-secondary" onClick={refresh} type="button">
              <RefreshCw size={16} />
              {t("common.refresh")}
            </button>
            {canCreate ? (
              <button
                className="button button-primary"
                onClick={() => setCreating(true)}
                type="button"
              >
                <Plus size={16} />
                {t("common.create")}
              </button>
            ) : null}
          </>
        }
        eyebrow={t("accounting.title")}
        title={title}
      />
      {section === "events" ? <AccountingRecoveryNavigation active="events" /> : null}
      {detail === undefined ? (
        <>
          {definition.summaryPath === undefined ? null : (
            <LoadPanel error={summary.error} loading={summary.loading} onRefresh={summary.refresh}>
              {/* Only SCALAR summary values become cards. Most summary
                  endpoints return a flat map of counts and totals, but the
                  Accounting Events one returns `{ items: [...] }` — a
                  breakdown by area and status — and mapping that blindly
                  rendered a card labelled "items" reading
                  "[object Object],[object Object]…" on screen. A value this
                  renderer cannot display is skipped rather than stringified;
                  the breakdown belongs to a table, not a summary tile. */}
              <SummaryCards
                items={Object.entries(summary.data ?? {})
                  .filter(([, value]) => value === null || typeof value !== "object")
                  .slice(0, 6)
                  .map(([key, value]) => ({
                    label: summaryCardLabel(key, t),
                    money: isMoneySummaryKey(key),
                    value,
                  }))}
              />
            </LoadPanel>
          )}
          <div className="accounting-filter-bar">
            <label>
              {t("common.search")}
              <input
                onChange={(event) =>
                  urlDriven
                    ? // Maps to the screen's real reference filter. The old
                      // `search` parameter is not declared on any of these
                      // DTOs, so with `forbidNonWhitelisted` it produced a 400
                      // as soon as anyone typed.
                      listState.setFilter(listConfig!.searchKey, event.target.value)
                    : setFilters((current) => ({
                        ...current,
                        page: 1,
                        search: event.target.value,
                      }))
                }
                placeholder={
                  urlDriven
                    ? t(`accounting.list.searchBy.${section}`, { defaultValue: "" }) || undefined
                    : undefined
                }
                value={
                  urlDriven ? (listState.filters[listConfig!.searchKey] ?? "") : filters.search
                }
              />
            </label>
            {!urlDriven ? null : (
              <>
                <label>
                  {t("accounting.list.fromDate")}
                  <input
                    max={listState.filters.dateTo ?? undefined}
                    onChange={(event) => listState.setFilter("dateFrom", event.target.value)}
                    type="date"
                    value={listState.filters.dateFrom ?? ""}
                  />
                </label>
                <label>
                  {t("accounting.list.toDate")}
                  {/* `min` keeps From from exceeding To without a second
                      validation path to keep in step. */}
                  <input
                    min={listState.filters.dateFrom ?? undefined}
                    onChange={(event) => listState.setFilter("dateTo", event.target.value)}
                    type="date"
                    value={listState.filters.dateTo ?? ""}
                  />
                </label>
                <AccountingFilterSummary state={listState} />
              </>
            )}
            {section === "events" &&
            (permissionSet.manage || permissionSet.post) &&
            selectedIds.size > 0 ? (
              <button
                className="button button-secondary"
                onClick={() => setBulkReprocessing(true)}
                type="button"
              >
                {t("accounting.actions.createReprocessBatch", { count: selectedIds.size })}
              </button>
            ) : null}
          </div>
          <LoadPanel error={resource.error} loading={resource.loading} onRefresh={resource.refresh}>
            <AccountingTable
              columns={withSortableHeaders(
                section === "events"
                  ? eventListColumns(t, language, onNavigate, permissions)
                  : definition.columns,
                urlDriven ? listConfig : undefined,
                listState,
              )}
              empty={t("accounting.empty")}
              items={records}
              onOpen={
                definition.detailPath === undefined
                  ? undefined
                  : (row) => onNavigate(`/accounting/${section}/${String(row.id)}`)
              }
              onToggleSelection={
                section === "events"
                  ? (recordId) =>
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        if (next.has(recordId)) next.delete(recordId);
                        else next.add(recordId);
                        return next;
                      })
                  : undefined
              }
              selectedIds={section === "events" ? selectedIds : undefined}
            />
            {!urlDriven ? null : (
              <AccountingPagination
                state={listState}
                total={listTotal}
                totalPages={listTotalPages}
              />
            )}
          </LoadPanel>
        </>
      ) : (
        <LoadPanel error={resource.error} loading={resource.loading} onRefresh={resource.refresh}>
          <button
            className="button button-secondary"
            onClick={() => onNavigate(`/accounting/${section}`)}
            type="button"
          >
            {t("common.back")}
          </button>
          {id !== undefined && section === "journals" ? (
            <AccountingDocumentActions
              api={api}
              filename={`journal-${String(detail.journalNumber ?? id)}.pdf`}
              path={`operations/accounting/reports/documents/journals/${id}/pdf`}
            />
          ) : null}
          {id !== undefined && section === "opening-balances" ? (
            <AccountingDocumentActions
              api={api}
              filename={`opening-balance-${String(detail.batchNumber ?? id)}.pdf`}
              path={`operations/accounting/reports/documents/opening-balances/${id}/pdf`}
            />
          ) : null}
          {id !== undefined && section === "expenses" ? (
            <AccountingDocumentActions
              api={api}
              filename={`expense-${String(detail.expenseNumber ?? id)}.pdf`}
              path={`operations/accounting/reports/documents/expenses/${id}/pdf`}
            />
          ) : null}
          {section === "journals" ? (
            <ManualJournalEditor
              accounts={normalizePage(manualJournalAccounts.data)}
              accountsError={manualJournalAccounts.error ?? null}
              accountsLoading={manualJournalAccounts.loading}
              canApprove={permissionSet.approve}
              canManage={permissionSet.manage}
              canPost={permissionSet.post}
              canReverse={permissionSet.reverse}
              client={client}
              initialRecord={detail}
              listPath={definition.listPath}
              onCancel={() => onNavigate(`/accounting/${section}`)}
              onNavigate={onNavigate}
              onSaved={() => refresh()}
              permissions={permissions}
            />
          ) : (
            <>
              {canEditBankAccount ? (
                <div className="accounting-lifecycle-actions">
                  <button
                    className="button button-secondary"
                    onClick={() => setEditingDetail(true)}
                    type="button"
                  >
                    {t("common.edit", { defaultValue: "Edit" })}
                  </button>
                  <button
                    className="button button-secondary"
                    onClick={() => setEditingDetail(true)}
                    type="button"
                  >
                    {bankGlLinked
                      ? t("accounting.actions.changeGlAccount", {
                          defaultValue: "Change GL Account",
                        })
                      : t("accounting.actions.linkGlAccount", {
                          defaultValue: "Link GL Account",
                        })}
                  </button>
                </div>
              ) : null}
              {editingDetail && canEditBankAccount ? (
                <RecordForm
                  fields={detailEditFields}
                  initial={bankAccountEditInitial(detail)}
                  onCancel={() => setEditingDetail(false)}
                  onSubmit={submitDetailEdit}
                  submitLabel={t("accounting.actions.saveBankAccount", {
                    defaultValue: "Save Bank Account",
                  })}
                />
              ) : null}
              {section === "events" ? (
                <>
                  {/* Status first: what state the Event is in, what is
                      blocking it, and what to do next. */}
                  <EventLifecycleBanner
                    detail={detail}
                    lifecycle={eventLifecycle(detail, t)}
                    onNavigate={onNavigate}
                    permissions={permissions}
                  />
                  <AccountingEventSummary detail={detail} language={language} />
                  <EventFailureDetails
                    detail={detail}
                    language={language}
                    lifecycle={eventLifecycle(detail, t)}
                  />
                  <EventProcessingTimeline detail={detail} language={language} />
                  <EventSourceTransaction
                    language={language}
                    source={
                      typeof detail.sourceTransaction === "object" &&
                      detail.sourceTransaction !== null
                        ? (detail.sourceTransaction as AccountingRecord)
                        : undefined
                    }
                  />
                  {/* Identifiers, hashes, correlation and retry metadata stay
                      behind a collapsed, permission-gated section — never in
                      the business summary above. */}
                  {!(permissionSet.configure || permissionSet.manage) ? null : (
                    <details className="accounting-technical-details">
                      <summary>{t("accounting.technicalDetails")}</summary>
                      <RecordDetail record={displayedDetail ?? detail} showTechnical />
                    </details>
                  )}
                </>
              ) : (
                <RecordDetail
                  record={displayedDetail ?? detail}
                  showTechnical={permissionSet.configure || permissionSet.manage}
                />
              )}
              {Array.isArray(detail.lines) ? (
                <AccountingTable
                  columns={
                    // Expense lines carry a resolved expense account and a
                    // gross amount, not debit/credit columns — the generic
                    // Journal shape left every cell empty here.
                    section === "expenses"
                      ? [
                          { key: "lineNumber", label: "#" },
                          {
                            key: "expenseAccountCode",
                            label: t("accounting.fields.account"),
                            render: (line) =>
                              line.expenseAccountCode === null ||
                              line.expenseAccountCode === undefined ? (
                                <span className="accounting-pending-amount">
                                  {t("accounting.preview.unresolvedAccount", {
                                    defaultValue: "Unresolved",
                                  })}
                                </span>
                              ) : (
                                <DirectionalText>
                                  {`${String(line.expenseAccountCode)} — ${String(
                                    line.expenseAccountNameEn ?? "",
                                  )}`}
                                </DirectionalText>
                              ),
                          },
                          { key: "description", label: t("accounting.fields.description") },
                          { key: "netAmount", label: t("accounting.fields.net"), money: true },
                          { key: "vatAmount", label: t("accounting.fields.vat"), money: true },
                          { key: "grossAmount", label: t("accounting.fields.gross"), money: true },
                        ]
                      : [
                          { key: "lineNumber", label: "#" },
                          {
                            key: "accountCode",
                            label: t("accounting.fields.account"),
                            technical: true,
                          },
                          { key: "description", label: t("accounting.fields.description") },
                          { key: "debit", label: t("accounting.fields.debit"), money: true },
                          { key: "credit", label: t("accounting.fields.credit"), money: true },
                        ]
                  }
                  empty={t("accounting.empty")}
                  items={detailLines}
                />
              ) : null}
              {canEditOpeningBalanceLines ? (
                editingOpeningBalanceLines || !openingBalanceLinesAreValid ? (
                  <OpeningBalanceLinesForm
                    accounts={normalizePage(openingBalanceAccounts.data)}
                    loadingAccounts={openingBalanceAccounts.loading}
                    onCancel={() => {
                      if (!openingBalanceLinesAreValid) onNavigate(`/accounting/${section}`);
                      else setEditingOpeningBalanceLines(false);
                    }}
                    onSubmit={submitOpeningBalanceLines}
                  />
                ) : (
                  <button
                    className="button button-secondary"
                    onClick={() => setEditingOpeningBalanceLines(true)}
                    type="button"
                  >
                    Set opening balance amount
                  </button>
                )
              ) : null}
              {section === "expenses" ? (
                <AttachmentPanel
                  attachments={
                    Array.isArray(detail.attachments)
                      ? (detail.attachments as readonly AccountingRecord[])
                      : []
                  }
                  canManage={
                    permissionSet.manage && !["posted", "reversed"].includes(String(detail.status))
                  }
                  onAttach={async (input) => {
                    await client.post(`general-expenses/${id}/attachments`, input);
                    refresh();
                  }}
                />
              ) : null}
              {section === "expenses" && accountingPreview.data !== undefined ? (
                <AccountingPreviewPanel preview={accountingPreview.data} />
              ) : null}
              {section === "expenses" && id !== undefined ? (
                <ExpensePaymentPanel
                  client={client}
                  canRecordPayment={permissionSet.manage}
                  companyId={companyId}
                  expense={detail}
                  expenseId={id}
                  onPaymentRecorded={refresh}
                  onNavigate={onNavigate}
                />
              ) : null}
              <div className="accounting-lifecycle-actions">
                {section !== "events" || id === undefined ? null : (
                  // Single-Event reprocessing, gated by the backend readiness
                  // endpoint rather than by the row on screen.
                  <EventReprocessAction
                    client={client}
                    companyId={companyId}
                    detail={detail}
                    eventId={id}
                    language={language}
                    onDone={() => refresh()}
                  />
                )}
                {definition.actions
                  ?.filter(
                    (item) =>
                      // The Event Reprocess action is rendered above with its
                      // own preview and eligibility check.
                      !(section === "events" && item.action === "reprocess") &&
                      (permissionSet[item.permission] ||
                        (section === "events" && permissionSet.post)) &&
                      actionAvailable(section, detail, item.action) &&
                      // Approval is offered only when the preview resolves
                      // every account — otherwise it would be approved here
                      // and fail later during Accounting Event processing.
                      !(item.action === "approve" && previewBlocked),
                  )
                  .map((item) => (
                    <button
                      className="button button-secondary"
                      key={item.action}
                      onClick={() => setAction({ action: item, record: detail })}
                      type="button"
                    >
                      {t(`accounting.actions.${item.action}`, { defaultValue: item.action })}
                    </button>
                  ))}
              </div>
            </>
          )}
          {relatedRecords === undefined ? null : (
            <RelatedRecords onNavigate={onNavigate} records={relatedRecords} />
          )}
        </LoadPanel>
      )}
      {creating ? (
        section === "journals" ? (
          <ManualJournalEditor
            accounts={normalizePage(manualJournalAccounts.data)}
            accountsError={manualJournalAccounts.error ?? null}
            accountsLoading={manualJournalAccounts.loading}
            canApprove={permissionSet.approve}
            canManage={permissionSet.manage}
            canPost={permissionSet.post}
            canReverse={permissionSet.reverse}
            client={client}
            listPath={definition.listPath}
            onCancel={() => setCreating(false)}
            onNavigate={onNavigate}
            permissions={permissions}
            onSaved={(recordId) => {
              setCreating(false);
              refresh();
              if (recordId !== undefined && recordId !== "") {
                onNavigate(`/accounting/${section}/${recordId}`);
              }
            }}
          />
        ) : section === "opening-balances" ? (
          <OpeningBalanceCreateForm
            accounts={normalizePage(openingBalanceAccounts.data)}
            loadingAccounts={openingBalanceAccounts.loading}
            onCancel={() => setCreating(false)}
            onSubmit={submitCreate}
          />
        ) : (
          <>
            {section === "expenses" &&
            !expenseCategoryOptions.loading &&
            !hasActiveExpenseCategory ? (
              <div className="accounting-inline-notice" role="status">
                <span>
                  {t("accounting.expenses.noCategories", {
                    defaultValue:
                      "No active Expense Category exists. Create one before recording a General Expense.",
                  })}
                </span>
                {permissionSet.manage ? (
                  <button
                    className="button button-secondary"
                    onClick={() => setAddingCategory(true)}
                    type="button"
                  >
                    {t("accounting.expenseCategoryDialog.addCategory")}
                  </button>
                ) : (
                  // No `accounting.manage` -- the inline dialog would refuse
                  // them just like this would, but at least the full Setup
                  // screen states plainly why rather than opening a form only
                  // to reject it.
                  <button
                    className="button button-secondary"
                    onClick={() => onNavigate("/accounting/expense-categories")}
                    type="button"
                  >
                    {t("accounting.sections.expense-categories")}
                  </button>
                )}
              </div>
            ) : null}
            <RecordForm
              fields={createFields}
              onCancel={() => setCreating(false)}
              onSecondarySubmit={section === "expenses" ? submitAndSendForApproval : undefined}
              onSubmit={submitCreate}
              patch={section === "expenses" ? categoryPatch : undefined}
              secondarySubmitLabel={
                section === "expenses"
                  ? t("accounting.actions.createAndSubmit", {
                      defaultValue: "Create & Send for Approval",
                    })
                  : undefined
              }
              submitLabel={t("common.create")}
            />
          </>
        )
      ) : null}
      {!addingCategory ? null : (
        <AddExpenseCategoryDialog
          client={client}
          companyId={companyId}
          language={language === "ar" ? "ar" : "en"}
          onClose={() => setAddingCategory(false)}
          onCreated={(category) => {
            setAddingCategory(false);
            expenseCategoryOptions.refresh();
            // A NEW array each time, per RecordForm's own contract, so the
            // merge fires even if the operator adds two Categories in a row
            // with the very same id shape. `categoryId` is now the only
            // Category field on the form -- `submitCreate` derives the
            // accounting line's own category from it directly.
            setCategoryPatch([{ name: "categoryId", value: category.id }]);
          }}
        />
      )}
      {action === undefined ? null : (
        <ActionDialog
          action={action.action.action}
          amount={action.record.totalAmount ?? action.record.grossAmount ?? action.record.amount}
          onClose={() => setAction(undefined)}
          onConfirm={(input) => executeAction(action.action, action.record, input)}
          recordReference={referenceOf(action.record, definition.referenceKeys)}
          requireDate={action.action.reversalDate}
          requireReason={action.action.reason}
          warningKey={
            section === "opening-balances" && action.action.action === "delete"
              ? "accounting.confirmation.deleteDraftOpeningBalance"
              : undefined
          }
        />
      )}
      {!bulkReprocessing ? null : (
        <ActionDialog
          action="createReprocessBatch"
          onClose={() => setBulkReprocessing(false)}
          onConfirm={async ({ reason }) => {
            const created = await client.post<{ readonly id: string }>("batches", {
              batchType: "accounting_event_reprocess",
              reason,
              sourceIds: [...selectedIds],
            });
            setSelectedIds(new Set());
            setBulkReprocessing(false);
            onNavigate(`/accounting/batch-operations/${created.id}`);
          }}
          recordReference={t("accounting.confirmation.selectedEvents", {
            count: selectedIds.size,
          })}
          requireReason
        />
      )}
    </section>
  );
}
