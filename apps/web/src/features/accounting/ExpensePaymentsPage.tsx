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
  accountingPermissions,
} from "./AccountingComponents.js";
import { AccountingApi, accountingQueryKey } from "./accounting-api.js";
import type { AccountingPage, AccountingRecord } from "./accounting-types.js";
import { useAccountingResource } from "./use-accounting-resource.js";

export function ExpensePaymentsPage({
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
  const client = useMemo(() => new AccountingApi(api), [api]);
  const rights = accountingPermissions(permissions);
  const [revision, setRevision] = useState(0);
  const [recording, setRecording] = useState(false);
  const [reversing, setReversing] = useState(false);
  const path = id === undefined ? "general-expenses/payments" : `general-expenses/payments/${id}`;
  const resource = useAccountingResource<AccountingPage | AccountingRecord>(
    accountingQueryKey(companyId, path, { revision }),
    (signal) => client.get(path, id === undefined ? { page: 1, pageSize: 50 } : undefined, signal),
  );
  const detail = id === undefined ? undefined : resource.data as AccountingRecord | undefined;
  const items = id === undefined && resource.data !== undefined && "items" in resource.data
    ? resource.data.items as readonly AccountingRecord[] : [];
  const refresh = () => setRevision((value) => value + 1);
  return (
    <section className="accounting-page">
      <PageHeader eyebrow={t("accounting.title")} title={t("accounting.sections.expense-payments")}
        actions={rights.manage ? <button className="button button-primary" onClick={() => setRecording(true)}
          type="button">{t("accounting.actions.recordPayment")}</button> : undefined} />
      <LoadPanel error={resource.error} loading={resource.loading} onRefresh={resource.refresh}>
        {detail === undefined ? (
          <AccountingTable columns={[
            { key: "paymentNumber", label: t("accounting.fields.paymentNumber"), technical: true },
            { key: "expenseNumber", label: t("accounting.fields.expenseNumber"), technical: true },
            { key: "paymentDate", label: t("accounting.fields.paymentDate") },
            { key: "payeeName", label: t("accounting.fields.payeeName") },
            { key: "amount", label: t("accounting.fields.amount"), money: true },
            { key: "cashAmount", label: t("accounting.fields.cash"), money: true },
            { key: "visaAmount", label: t("accounting.fields.visa"), money: true },
            { key: "status", label: t("accounting.fields.status"), status: true },
            { key: "journalNumber", label: t("accounting.fields.journalNumber"), technical: true },
          ]} empty={t("accounting.empty")} items={items}
            onOpen={(row) => onNavigate(`/accounting/expense-payments/${String(row.id)}`)} />
        ) : (
          <>
            <button className="button button-secondary" onClick={() => onNavigate("/accounting/expense-payments")} type="button">{t("common.back")}</button>
            <AccountingDocumentActions api={api}
              filename={`expense-payment-${String(detail.paymentNumber ?? id)}.pdf`}
              path={`operations/accounting/reports/documents/expense-payments/${id}/pdf`} />
            <RecordDetail record={detail} />
            <AccountingStatusPanel status={{
              status: detail.accountingStatus,
              journalNumber: detail.journalNumber,
              eventId: detail.accountingEventId,
            }} />
            <AttachmentPanel
              attachments={Array.isArray(detail.attachments)
                ? detail.attachments as readonly AccountingRecord[] : []}
              canManage={rights.manage && String(detail.status) !== "reversed"}
              onAttach={async (input) => {
                await client.post(`general-expenses/${String(detail.expenseId)}/attachments`, {
                  ...input,
                  paymentId: id,
                });
                refresh();
              }}
            />
            {String(detail.status) === "confirmed" && rights.reverse
              ? <button className="button button-danger" onClick={() => setReversing(true)}
                type="button">{t("common.reverse")}</button> : null}
          </>
        )}
      </LoadPanel>
      {recording ? (
        <RecordForm fields={[
          { name: "expenseId", required: true },
          { name: "expenseVersion", required: true, type: "number" },
          { name: "paymentDate", required: true, type: "date" },
          { name: "accountingDate", type: "date" },
          { name: "paymentMethod", required: true, type: "select", options: [
            { label: t("accounting.fields.cash"), value: "cash" },
            { label: t("accounting.fields.visa"), value: "visa" },
          ] },
          { name: "cashAccountId" }, { name: "companyBankAccountId" },
          { name: "amount", required: true, type: "money" },
          { name: "referenceNumber" }, { name: "notes", type: "textarea" },
        ]} onCancel={() => setRecording(false)} onSubmit={async (payload) => {
          const expenseId = String(payload.expenseId);
          await client.post(`general-expenses/${expenseId}/payments`, {
            accountingDate: payload.accountingDate || undefined,
            expenseVersion: Number(payload.expenseVersion),
            notes: payload.notes,
            paymentDate: payload.paymentDate,
            referenceNumber: payload.referenceNumber,
            rows: [{
              amount: payload.amount,
              cashAccountId: payload.paymentMethod === "cash" ? payload.cashAccountId : undefined,
              companyBankAccountId: payload.paymentMethod === "visa" ? payload.companyBankAccountId : undefined,
              paymentMethod: payload.paymentMethod,
              referenceNumber: payload.referenceNumber,
            }],
          });
          setRecording(false);
          refresh();
        }} submitLabel={t("accounting.actions.confirmPayment")} />
      ) : null}
      {reversing && detail !== undefined ? (
        <ActionDialog action="reversePayment" amount={detail.amount} onClose={() => setReversing(false)}
          onConfirm={async ({ date, reason }) => {
            await client.post(`general-expenses/payments/${id}/reverse`, {
              accountingDate: date,
              reason,
              version: Number(detail.version),
            });
            refresh();
          }} recordReference={String(detail.paymentNumber ?? id)} requireDate requireReason />
      ) : null}
    </section>
  );
}
