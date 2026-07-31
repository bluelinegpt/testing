import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import {
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import { parseMoneyInput } from "../../utils/numeric-input.js";
import type {
  AccountingPermissionSet,
  AccountingRecord,
  FieldDefinition,
} from "./accounting-types.js";

export function hasPermission(
  permissions: readonly string[],
  permission: keyof AccountingPermissionSet,
): boolean {
  const map: Readonly<Record<keyof AccountingPermissionSet, string>> = {
    accounts: "accounting.chart_of_accounts.manage",
    approve: "accounting.approve",
    configure: "accounting.configuration.manage",
    manage: "accounting.manage",
    periods: "accounting.periods.manage",
    post: "accounting.post",
    reverse: "accounting.reverse",
    view: "accounting.view",
  };
  return permissions.includes(map[permission]) || permissions.includes("users_roles.manage");
}

export function accountingPermissions(permissions: readonly string[]): AccountingPermissionSet {
  return {
    accounts: hasPermission(permissions, "accounts"),
    approve: hasPermission(permissions, "approve"),
    configure: hasPermission(permissions, "configure"),
    manage: hasPermission(permissions, "manage"),
    periods: hasPermission(permissions, "periods"),
    post: hasPermission(permissions, "post"),
    reverse: hasPermission(permissions, "reverse"),
    view: hasPermission(permissions, "view"),
  };
}

export function formatAed(value: unknown): string {
  const source = typeof value === "string" ? value : "0";
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(source);
  if (match === null) return `AED ${source}`;
  const [, sign = "", integer = "0", decimals = ""] = match;
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `AED ${sign}${grouped}.${decimals.padEnd(2, "0").slice(0, 2)}`;
}

export function DirectionalText({ children }: { readonly children: ReactNode }) {
  return <bdi className="accounting-code">{children}</bdi>;
}

export function AccountingDocumentActions({
  api,
  filename,
  path,
}: {
  readonly api: ApiClient;
  readonly filename: string;
  readonly path: string;
}) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const run = async (action: "preview" | "print" | "download") => {
    setBusy(action); setError(undefined);
    try {
      const separator = path.includes("?") ? "&" : "?";
      const blob = await api.getBinary(`${path}${separator}language=${i18n.language.startsWith("ar") ? "ar" : "en"}${action === "download" ? "&disposition=attachment" : ""}`);
      const url = URL.createObjectURL(blob);
      if (action === "download") {
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = filename; anchor.click();
      } else {
        const opened = globalThis.open(url, "_blank", "noopener,noreferrer");
        if (action === "print" && opened !== null) opened.addEventListener("load", () => opened.print(), { once: true });
      }
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (issue) {
      setError(issue instanceof ApiError ? issue.code : "request_failed");
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="accounting-document-actions">
      {(["preview","print","download"] as const).map((action) => (
        <button className="button button-secondary" disabled={busy !== undefined} key={action}
          onClick={() => void run(action)} type="button">{t(`common.${action}`)}</button>
      ))}
      {error === undefined ? null : <span className="form-error" role="alert">
        {t(`accounting.errors.codes.${error}`, { defaultValue: t("accounting.errors.safe") })}
      </span>}
    </div>
  );
}

export function StatusBadge({ value }: { readonly value: unknown }) {
  const { t } = useTranslation();
  const status = String(value ?? "unknown");
  return (
    <span className={`status-badge accounting-status status-${status.replaceAll("_", "-")}`}>
      {t(`accounting.status.${status}`, { defaultValue: status.replaceAll("_", " ") })}
    </span>
  );
}

export function LoadPanel({
  children,
  error,
  loading,
  onRefresh,
}: {
  readonly children: ReactNode;
  readonly error?: string;
  readonly loading: boolean;
  readonly onRefresh: () => void;
}) {
  const { t } = useTranslation();
  if (loading) return <div className="accounting-state" role="status">{t("common.loading")}</div>;
  if (error !== undefined) {
    return (
      <div className="accounting-state accounting-state-error" role="alert">
        <AlertTriangle aria-hidden="true" />
        <div>
          <strong>{t("accounting.errors.load")}</strong>
          <p>{t(`accounting.errors.codes.${error}`, { defaultValue: t("accounting.errors.safe") })}</p>
        </div>
        <button className="button button-secondary" onClick={onRefresh} type="button">
          <RefreshCw aria-hidden="true" size={16} /> {t("common.tryAgain")}
        </button>
      </div>
    );
  }
  return <>{children}</>;
}

export interface AccountingColumn {
  readonly key: string;
  readonly label: string;
  readonly money?: boolean;
  readonly status?: boolean;
  readonly technical?: boolean;
}

export function AccountingTable({
  columns,
  empty,
  items,
  onOpen,
  onToggleSelection,
  selectedIds,
}: {
  readonly columns: readonly AccountingColumn[];
  readonly empty: string;
  readonly items: readonly AccountingRecord[];
  readonly onOpen?: (row: AccountingRecord) => void;
  readonly onToggleSelection?: (id: string) => void;
  readonly selectedIds?: ReadonlySet<string>;
}) {
  if (items.length === 0) return <div className="accounting-empty">{empty}</div>;
  return (
    <div className="table-shell accounting-table-shell">
      <table className="data-table accounting-table">
        <thead><tr>
          {onToggleSelection === undefined ? null : <th><span className="sr-only">Select</span></th>}
          {columns.map((column) => <th key={column.key}>{column.label}</th>)}
        </tr></thead>
        <tbody>
          {items.map((row, index) => (
            <tr
              className={onOpen === undefined ? undefined : "accounting-clickable-row"}
              key={String(row.id ?? row.code ?? row.reference ?? index)}
              onClick={onOpen === undefined ? undefined : () => onOpen(row)}
            >
              {onToggleSelection === undefined ? null : (
                <td>
                  <input
                    aria-label={`Select ${String(row.id ?? index)}`}
                    checked={selectedIds?.has(String(row.id)) === true}
                    onChange={() => onToggleSelection(String(row.id))}
                    onClick={(event) => event.stopPropagation()}
                    type="checkbox"
                  />
                </td>
              )}
              {columns.map((column) => {
                const value = row[column.key];
                return (
                  <td key={column.key}>
                    {column.status === true ? <StatusBadge value={value} /> :
                      column.money === true ? formatAed(value) :
                        column.technical === true ? <DirectionalText>{String(value ?? "—")}</DirectionalText> :
                          String(value ?? "—")}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SummaryCards({ items }: {
  readonly items: readonly { readonly label: string; readonly money?: boolean; readonly value: unknown }[];
}) {
  return (
    <div className="accounting-summary-grid">
      {items.map((item) => (
        <article className="accounting-summary-card" key={item.label}>
          <span>{item.label}</span>
          <strong>{item.money === true ? formatAed(item.value) : String(item.value ?? "—")}</strong>
        </article>
      ))}
    </div>
  );
}

export function RecordForm({
  fields,
  initial = {},
  onCancel,
  onSubmit,
  submitLabel,
}: {
  readonly fields: readonly FieldDefinition[];
  readonly initial?: AccountingRecord;
  readonly onCancel: () => void;
  readonly onSubmit: (value: Record<string, unknown>) => Promise<void>;
  readonly submitLabel: string;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...initial }));
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const id = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    const payload = { ...values };
    for (const field of fields) {
      if (field.type === "money") {
        const parsed = parseMoneyInput(String(payload[field.name] ?? ""), {
          allowZero: true,
          required: field.required,
        });
        if (!parsed.ok) {
          setError(t("accounting.errors.invalidNumber"));
          return;
        }
        payload[field.name] = parsed.normalized;
      }
    }
    setPending(true);
    try {
      await onSubmit(payload);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? t(`accounting.errors.codes.${cause.code}`, { defaultValue: t("accounting.errors.safe") })
          : t("accounting.errors.safe"),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="accounting-form" onSubmit={submit}>
      <div className="accounting-form-grid">
        {fields.map((field) => {
          const inputId = `${id}-${field.name}`;
          return (
            <label className={field.type === "textarea" ? "accounting-form-wide" : ""} htmlFor={inputId} key={field.name}>
              <span>{t(`accounting.fields.${field.name}`, { defaultValue: field.name })}{field.required ? " *" : ""}</span>
              {field.type === "select" ? (
                <select id={inputId} required={field.required} value={String(values[field.name] ?? "")}
                  onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}>
                  <option value="">{t("common.select")}</option>
                  {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : field.type === "textarea" ? (
                <textarea id={inputId} value={String(values[field.name] ?? "")}
                  onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} />
              ) : field.type === "checkbox" ? (
                <input checked={values[field.name] === true} id={inputId} type="checkbox"
                  onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.checked }))} />
              ) : (
                <input dir={field.type === "money" ? "ltr" : undefined} id={inputId} required={field.required}
                  type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
                  value={String(values[field.name] ?? "")}
                  onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} />
              )}
            </label>
          );
        })}
      </div>
      {error === undefined ? null : <div className="form-error" role="alert">{error}</div>}
      <footer className="accounting-form-actions">
        <button className="button button-secondary" disabled={pending} onClick={onCancel} type="button">{t("common.cancel")}</button>
        <button className="button button-primary" disabled={pending} type="submit">{submitLabel}</button>
      </footer>
    </form>
  );
}

export function ActionDialog({
  action,
  amount,
  onClose,
  onConfirm,
  recordReference,
  requireDate = false,
  requireReason = false,
}: {
  readonly action: string;
  readonly amount?: unknown;
  readonly onClose: () => void;
  readonly onConfirm: (input: { readonly date?: string; readonly reason?: string }) => Promise<void>;
  readonly recordReference: string;
  readonly requireDate?: boolean;
  readonly requireReason?: boolean;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [date, setDate] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const titleId = useId();
  const confirm = async () => {
    if ((requireReason && reason.trim() === "") || (requireDate && date === "")) {
      setError(t("accounting.errors.required"));
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await onConfirm({ date: date || undefined, reason: reason.trim() || undefined });
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError
        ? t(`accounting.errors.codes.${cause.code}`, { defaultValue: t("accounting.errors.safe") })
        : t("accounting.errors.safe"));
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal closeLabel={t("common.close")} onRequestClose={onClose}
      title={t(`accounting.actions.${action}`, { defaultValue: action })} titleId={titleId}>
      <div className="modal-body accounting-action-dialog">
        <p>{t("accounting.confirmation.reference")} <DirectionalText>{recordReference}</DirectionalText></p>
        {amount === undefined ? null : <strong>{formatAed(amount)}</strong>}
        {requireDate ? <label>{t("accounting.fields.reversalDate")}<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label> : null}
        {requireReason ? <label>{t("common.reason")}<textarea value={reason} onChange={(event) => setReason(event.target.value)} /></label> : null}
        <p className="accounting-warning"><AlertTriangle aria-hidden="true" size={18} />{t("accounting.confirmation.financialImpact")}</p>
        {error === undefined ? null : <div className="form-error" role="alert">{error}</div>}
      </div>
      <footer className="modal-actions">
        <button className="button button-secondary" disabled={pending} onClick={onClose} type="button">{t("common.cancel")}</button>
        <button className="button button-primary" disabled={pending} onClick={() => void confirm()} type="button">{t("common.confirm")}</button>
      </footer>
    </Modal>
  );
}

export function RecordDetail({ record }: { readonly record: AccountingRecord }) {
  const entries = useMemo(() => Object.entries(record).filter(([, value]) =>
    value === null || ["string", "number", "boolean"].includes(typeof value)), [record]);
  return (
    <dl className="accounting-detail-grid">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key.replaceAll(/([A-Z])/g, " $1").replaceAll("_", " ")}</dt>
          <dd>{key.toLowerCase().includes("status") ? <StatusBadge value={value} /> :
            /amount|debit|credit|balance|total|outstanding|paid|fee/i.test(key) && typeof value === "string"
              ? formatAed(value) : <DirectionalText>{String(value ?? "—")}</DirectionalText>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AccountingStatusPanel({ status }: { readonly status?: AccountingRecord }) {
  const { t } = useTranslation();
  if (status === undefined) return <div className="accounting-empty">{t("accounting.statusUnavailable")}</div>;
  return (
    <section className="accounting-status-panel">
      <CheckCircle2 aria-hidden="true" />
      <div>
        <strong>{t("accounting.operationalStatus")}</strong>
        <RecordDetail record={status} />
      </div>
    </section>
  );
}

export function AttachmentPanel({
  attachments,
  canManage,
  onAttach,
}: {
  readonly attachments: readonly AccountingRecord[];
  readonly canManage: boolean;
  readonly onAttach: (input: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  return (
    <section className="accounting-attachments">
      <header>
        <h2>{t("accounting.attachments.title")}</h2>
        {canManage ? (
          <button className="button button-secondary" onClick={() => setAdding(true)} type="button">
            {t("accounting.attachments.link")}
          </button>
        ) : null}
      </header>
      {attachments.length === 0 ? <div className="accounting-empty">{t("accounting.attachments.empty")}</div> : (
        <ul>
          {attachments.map((attachment, index) => (
            <li key={String(attachment.id ?? attachment.fileObjectId ?? index)}>
              <DirectionalText>{String(attachment.fileName ?? attachment.fileNameSnapshot ?? attachment.fileObjectId ?? "—")}</DirectionalText>
              <span>{String(attachment.attachmentType ?? "other")}</span>
              {attachment.description === undefined ? null : <small>{String(attachment.description)}</small>}
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <RecordForm
          fields={[
            { name: "fileObjectId", required: true },
            { name: "attachmentType", required: true, type: "select", options: [
              "invoice", "receipt", "tax_invoice", "quotation", "approval",
              "payment_evidence", "contract", "deposit_slip", "withdrawal_slip",
              "transfer_document", "bank_advice", "cash_count", "other",
            ].map((value) => ({ label: value, value })) },
            { name: "description", type: "textarea" },
          ]}
          onCancel={() => setAdding(false)}
          onSubmit={async (input) => {
            await onAttach(input);
            setAdding(false);
          }}
          submitLabel={t("accounting.attachments.link")}
        />
      ) : null}
    </section>
  );
}
