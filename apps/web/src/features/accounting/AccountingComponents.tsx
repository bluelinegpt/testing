import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import { parseMoneyInput } from "../../utils/numeric-input.js";
import { accountingLabel, statusLabel } from "./accounting-labels.js";
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

function normalizeDateInput(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (match === null) return trimmed;
  const [, month = "", day = "", year = ""] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
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
    setBusy(action);
    setError(undefined);
    try {
      const separator = path.includes("?") ? "&" : "?";
      const blob = await api.getBinary(
        `${path}${separator}language=${i18n.language.startsWith("ar") ? "ar" : "en"}${action === "download" ? "&disposition=attachment" : ""}`,
      );
      const url = URL.createObjectURL(blob);
      if (action === "download") {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
      } else {
        const opened = globalThis.open(url, "_blank", "noopener,noreferrer");
        if (action === "print" && opened !== null)
          opened.addEventListener("load", () => opened.print(), { once: true });
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
      {(["preview", "print", "download"] as const).map((action) => (
        <button
          className="button button-secondary"
          disabled={busy !== undefined}
          key={action}
          onClick={() => void run(action)}
          type="button"
        >
          {t(`common.${action}`)}
        </button>
      ))}
      {error === undefined ? null : (
        <span className="form-error" role="alert">
          {t(`accounting.errors.codes.${error}`, { defaultValue: t("accounting.errors.safe") })}
        </span>
      )}
    </div>
  );
}

export function StatusBadge({ value }: { readonly value: unknown }) {
  const { t } = useTranslation();
  const status = typeof value === "string" ? value.trim() : "";
  // An absent status renders as an em dash; a present-but-untranslated one
  // renders as Title Case. Neither ever renders as the word "Unknown", which
  // previously appeared for perfectly valid statuses.
  if (status === "") return <span className="status-badge accounting-status">—</span>;
  return (
    <span className={`status-badge accounting-status status-${status.replaceAll("_", "-")}`}>
      {statusLabel(t, status)}
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
  readonly error?: string | undefined;
  readonly loading: boolean;
  readonly onRefresh: () => void;
}) {
  const { t } = useTranslation();
  if (loading)
    return (
      <div className="accounting-state" role="status">
        {t("common.loading")}
      </div>
    );
  if (error !== undefined) {
    return (
      <div className="accounting-state accounting-state-error" role="alert">
        <AlertTriangle aria-hidden="true" />
        <div>
          <strong>{t("accounting.errors.load")}</strong>
          <p>
            {t(`accounting.errors.codes.${error}`, { defaultValue: t("accounting.errors.safe") })}
          </p>
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
  /** Date-only display in the active locale — never a UTC timestamp. */
  readonly date?: boolean;
  readonly key: string;
  /**
   * Translation namespace for a raw enum value, e.g. `accounting.eventTypes`.
   * Falls back to Title Case rather than showing the raw value or "Unknown".
   */
  readonly labelNamespace?: string;
  /**
   * ReactNode, not string: a sortable column supplies a header button here.
   * The value is only ever rendered into the `<th>`, never read as text.
   */
  readonly label: ReactNode;
  readonly money?: boolean;
  /** Full control over the cell when a business rule needs more than the value. */
  readonly render?: (row: AccountingRecord) => ReactNode;
  readonly status?: boolean;
  readonly technical?: boolean;
}

/**
 * Date-only rendering for values the API returns as `YYYY-MM-DD` or as a
 * timestamp. Parsed as calendar parts, never through the timezone-shifting
 * `new Date(iso)` path, so a stored business date can never display as the
 * previous day.
 */
export function formatAccountingDate(value: unknown, locale: string): string {
  if (typeof value !== "string" || value.trim() === "") return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (match === null) return value;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-AE" : "en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
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
  readonly onOpen?: ((row: AccountingRecord) => void) | undefined;
  readonly onToggleSelection?: ((id: string) => void) | undefined;
  readonly selectedIds?: ReadonlySet<string> | undefined;
}) {
  const { i18n, t } = useTranslation();
  const language = i18n.resolvedLanguage ?? "en";
  if (items.length === 0) return <div className="accounting-empty">{empty}</div>;
  return (
    <div className="table-shell accounting-table-shell">
      <table className="data-table accounting-table">
        <thead>
          <tr>
            {onToggleSelection === undefined ? null : (
              <th>
                <span className="sr-only">Select</span>
              </th>
            )}
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* A row that opens a record must be reachable without a mouse. It
              carried a click handler but no role, no tabindex and no key
              handler, so a keyboard user could not open an Accounting Event at
              all — and the Event detail is the only route to Reprocess. Enter
              and Space match what a button does; the row keeps its click
              behaviour for pointer users. */}
          {items.map((row, index) => (
            <tr
              className={onOpen === undefined ? undefined : "accounting-clickable-row"}
              key={String(row.id ?? row.code ?? row.reference ?? index)}
              onClick={onOpen === undefined ? undefined : () => onOpen(row)}
              onKeyDown={
                onOpen === undefined
                  ? undefined
                  : (event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onOpen(row);
                    }
              }
              role={onOpen === undefined ? undefined : "button"}
              tabIndex={onOpen === undefined ? undefined : 0}
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
                  <td
                    // Presentational only: lets the stylesheet right-align
                    // money and give it tabular figures so columns line up.
                    className={column.money === true ? "is-money" : undefined}
                    key={column.key}
                  >
                    {column.render !== undefined ? (
                      column.render(row)
                    ) : column.status === true ? (
                      <StatusBadge value={value} />
                    ) : column.labelNamespace !== undefined ? (
                      accountingLabel(t, column.labelNamespace, value)
                    ) : column.date === true ? (
                      formatAccountingDate(value, language)
                    ) : column.money === true ? (
                      formatAed(value)
                    ) : column.technical === true ? (
                      <DirectionalText>{String(value ?? "—")}</DirectionalText>
                    ) : (
                      String(value ?? "—")
                    )}
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

/**
 * A summary tile shows one scalar. Anything else shows the em dash.
 *
 * `String(value)` on an array or object yields "[object Object]", which is
 * what the Accounting Events screen displayed for its `items` breakdown. The
 * guard lives here, at the single place every summary tile renders through, so
 * no caller can reintroduce it by passing a shape this component cannot show.
 */
function summaryCardText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return "—";
  return String(value);
}

/* Summary endpoints return a flat map keyed by raw API names (`draftCount`,
   `totalPostedDebit`). Those keys were rendered straight into the card label,
   and because the label is uppercased by CSS they reached the screen as
   "DRAFTCOUNT" and "TOTALPOSTEDDEBIT".

   A key is translated when we have a label for it and humanised otherwise, so a
   metric the API adds later degrades to "Total posted credit" rather than back
   to a raw identifier. */
export function summaryCardLabel(
  key: string,
  translate: (key: string, options: { readonly defaultValue: string }) => string,
): string {
  return translate(`accounting.summary.${key}`, { defaultValue: humaniseSummaryKey(key) });
}

function humaniseSummaryKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* Only totals carry money. The `*Count` metrics are counts of records and must
   not be formatted as AED. */
export function isMoneySummaryKey(key: string): boolean {
  return key.startsWith("total") && !/count$/i.test(key);
}

export function SummaryCards({
  items,
}: {
  readonly items: readonly {
    readonly label: string;
    readonly money?: boolean;
    readonly value: unknown;
  }[];
}) {
  return (
    <div className="accounting-summary-grid">
      {items.map((item) => (
        <article className="accounting-summary-card" key={item.label}>
          <span>{item.label}</span>
          <strong>
            {item.money === true ? formatAed(item.value) : summaryCardText(item.value)}
          </strong>
        </article>
      ))}
    </div>
  );
}

const emptyRecord: AccountingRecord = {};

function AccountSelector({
  field,
  inputId,
  label,
  onChange,
  value,
}: {
  readonly field: FieldDefinition;
  readonly inputId: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  const { t } = useTranslation();
  const options = field.options ?? [];
  const selected = options.find((option) => option.value === value);
  const [display, setDisplay] = useState(selected?.label ?? "");
  const listId = `${inputId}-accounts`;

  useEffect(() => {
    setDisplay(selected?.label ?? "");
  }, [selected?.label, value]);

  const choose = (nextDisplay: string) => {
    setDisplay(nextDisplay);
    const normalized = nextDisplay.trim().toLowerCase();
    const match = options.find(
      (option) =>
        option.label.toLowerCase() === normalized ||
        option.searchText?.toLowerCase() === normalized,
    );
    onChange(match?.value ?? "");
  };

  const statusText =
    field.optionsStatus === "loading"
      ? t("accounting.configuration.loadingAccounts", {
          defaultValue: "Loading compatible accounts...",
        })
      : field.optionsStatus === "error"
        ? (field.optionsError ??
          t("accounting.configuration.accountsCouldNotLoad", {
            defaultValue: "Accounts could not be loaded.",
          }))
        : options.length === 0
          ? (field.emptyText ??
            t("accounting.configuration.noCompatibleAccounts", {
              defaultValue: "No compatible active posting accounts are available.",
            }))
          : undefined;

  return (
    <div className="accounting-account-selector">
      <input
        aria-label={label}
        disabled={field.readOnly === true || field.optionsStatus === "loading"}
        id={inputId}
        list={listId}
        placeholder={
          field.placeholder ??
          t("accounting.configuration.searchOrSelectAccount", {
            defaultValue: "Search or select an account",
          })
        }
        required={field.required}
        type="search"
        value={display}
        onBlur={() => {
          if (display.trim() === "") {
            onChange("");
            return;
          }
          if (selected !== undefined && value !== "") setDisplay(selected.label);
        }}
        onChange={(event) => choose(event.target.value)}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.value} value={option.label} />
        ))}
      </datalist>
      <input name={field.name} type="hidden" value={value} />
      {statusText === undefined ? null : (
        <small className="accounting-account-status">{statusText}</small>
      )}
    </div>
  );
}

export function RecordForm({
  fields,
  initial = emptyRecord,
  onCancel,
  onSecondarySubmit,
  onSubmit,
  patch,
  secondarySubmitLabel,
  submitLabel,
}: {
  readonly fields: readonly FieldDefinition[];
  readonly initial?: AccountingRecord;
  readonly onCancel: () => void;
  readonly onSecondarySubmit?: ((value: Record<string, unknown>) => Promise<void>) | undefined;
  readonly onSubmit: (value: Record<string, unknown>) => Promise<void>;
  /**
   * Sets one or more fields' values from outside the form -- e.g.
   * auto-selecting a Category just created through a `trailingAction` on both
   * `categoryId` and `lineCategoryId` at once -- without touching anything
   * else the operator has already typed. A NEW array reference (not a value
   * comparison) is what triggers the merge below, so the caller must
   * construct a fresh array each time, including for repeats of the same
   * selection. A single `setState` call with every entry, never several in a
   * row: separate calls in one handler would each overwrite the last before
   * React applies any of them.
   */
  readonly patch?: readonly { readonly name: string; readonly value: string }[] | undefined;
  readonly secondarySubmitLabel?: string | undefined;
  readonly submitLabel: string;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...initial }));
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const secondarySubmit = useRef(false);
  const id = useId();

  useEffect(() => {
    setValues({ ...initial });
  }, [initial]);

  useEffect(() => {
    if (patch === undefined || patch.length === 0) return;
    setValues((current) => {
      const next = { ...current };
      for (const entry of patch) next[entry.name] = entry.value;
      return next;
    });
    // Only `patch` should drive this -- merging on every render, or resetting
    // when unrelated state changes, would fight the operator's own typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch]);

  const formRef = useRef<HTMLFormElement>(null);

  /* The form renders below the heading, the summary cards and the filter bar,
     so on these pages pressing Create left it off-screen and looked like
     nothing had happened. Scroll it into view and put the caret in the first
     editable field. Runs once per mount, which is exactly when the form opens.

     `scrollIntoView` and `focus({ preventScroll })` are both feature-detected:
     jsdom implements neither fully, and an unguarded call here would fail every
     suite that renders this form. */
  useEffect(() => {
    const form = formRef.current;
    if (form === null) return;
    if (typeof form.scrollIntoView === "function") {
      // Default ("auto") behaviour rather than "smooth": the form is a new
      // surface the User just asked for, so landing on it directly is clearer
      // than animating past the summary cards on the way down.
      form.scrollIntoView({ block: "start" });
    }
    const firstField = form.querySelector<HTMLElement>(
      [
        "input:not([type='hidden']):not([disabled]):not([readonly])",
        "select:not([disabled])",
        "textarea:not([disabled]):not([readonly])",
      ].join(", "),
    );
    if (firstField !== null && typeof firstField.focus === "function") {
      // The scroll above already framed the form; focusing must not fight it.
      firstField.focus({ preventScroll: true });
    }
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    const payload: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.hidden === true) continue;
      const rawValue = values[field.name];
      const trimmedValue = typeof rawValue === "string" ? rawValue.trim() : rawValue;
      if (field.required === true && String(trimmedValue ?? "").trim() === "") {
        const label =
          field.label ?? t(`accounting.fields.${field.name}`, { defaultValue: field.name });
        setError(
          t("accounting.errors.requiredField", {
            defaultValue: "{{field}} is required.",
            field: label,
          }),
        );
        return;
      }
      if (field.type === "money") {
        const parsed = parseMoneyInput(String(trimmedValue ?? ""), {
          allowZero: true,
          required: field.required,
        });
        if (!parsed.ok) {
          setError(t("accounting.errors.invalidNumber"));
          return;
        }
        payload[field.name] = parsed.normalized;
      } else if (field.type === "account" || field.name.endsWith("AccountId")) {
        const value = String(trimmedValue ?? "").trim();
        payload[field.name] = value === "" ? null : value;
      } else if (field.type === "date") {
        const value = normalizeDateInput(String(trimmedValue ?? ""));
        if (value !== "" || field.required === true) payload[field.name] = value;
      } else if (typeof trimmedValue === "string") {
        if (trimmedValue !== "" || field.required === true) payload[field.name] = trimmedValue;
      } else if (trimmedValue !== undefined && trimmedValue !== null) {
        payload[field.name] = trimmedValue;
      }
    }
    setPending(true);
    try {
      await (secondarySubmit.current && onSecondarySubmit !== undefined
        ? onSecondarySubmit(payload)
        : onSubmit(payload));
    } catch (cause) {
      if (cause instanceof ApiError) {
        const message = t(`accounting.errors.codes.${cause.code}`, {
          defaultValue: cause.message || t("accounting.errors.safe"),
        });
        const details = cause.details?.filter((detail) => detail.trim() !== "").join("\n");
        setError(details === undefined || details === "" ? message : `${message}\n${details}`);
      } else {
        setError(t("accounting.errors.safe"));
      }
    } finally {
      setPending(false);
      secondarySubmit.current = false;
    }
  };
  const visibleFields = fields.filter((field) => field.hidden !== true);
  const groupedFields = visibleFields.reduce<
    Array<{ readonly fields: FieldDefinition[]; readonly section?: string | undefined }>
  >((groups, field) => {
    const previous = groups[groups.length - 1];
    if (previous !== undefined && previous.section === field.section) previous.fields.push(field);
    else groups.push({ fields: [field], section: field.section });
    return groups;
  }, []);

  return (
    <form className="accounting-form" onSubmit={submit} ref={formRef}>
      <div className="accounting-form-sections">
        {groupedFields.map((group, groupIndex) => (
          <fieldset
            className="accounting-form-section"
            key={`${group.section ?? "section"}-${groupIndex}`}
          >
            {group.section === undefined ? null : <legend>{group.section}</legend>}
            <div className="accounting-form-grid">
              {group.fields.map((field) => {
                const inputId = `${id}-${field.name}`;
                const label =
                  field.label ?? t(`accounting.fields.${field.name}`, { defaultValue: field.name });
                return (
                  <label
                    className={
                      field.type === "textarea" || field.type === "account"
                        ? "accounting-form-wide"
                        : ""
                    }
                    htmlFor={inputId}
                    key={field.name}
                  >
                    <span className="accounting-field-label-row">
                      {label}
                      {field.required ? <span className="accounting-field-required">*</span> : null}
                    </span>
                    {field.helperText === undefined ? null : (
                      <small className="accounting-field-helper">{field.helperText}</small>
                    )}
                    {field.type === "select" ? (
                      <span className="accounting-field-with-action">
                        <select
                          disabled={field.readOnly}
                          id={inputId}
                          required={field.required}
                          value={String(values[field.name] ?? "")}
                          onChange={(event) =>
                            setValues((current) => ({
                              ...current,
                              [field.name]: event.target.value,
                            }))
                          }
                        >
                          <option value="">{t("common.select")}</option>
                          {field.options?.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        {field.trailingAction === undefined ? null : (
                          <button
                            className="button button-secondary accounting-field-trailing-action"
                            disabled={field.trailingAction.disabled}
                            onClick={field.trailingAction.onClick}
                            type="button"
                          >
                            {field.trailingAction.label}
                          </button>
                        )}
                      </span>
                    ) : field.type === "account" ? (
                      <AccountSelector
                        field={field}
                        inputId={inputId}
                        label={label}
                        value={String(values[field.name] ?? "")}
                        onChange={(nextValue) =>
                          setValues((current) => ({ ...current, [field.name]: nextValue }))
                        }
                      />
                    ) : field.type === "textarea" ? (
                      <textarea
                        id={inputId}
                        value={String(values[field.name] ?? "")}
                        onChange={(event) =>
                          setValues((current) => ({ ...current, [field.name]: event.target.value }))
                        }
                      />
                    ) : field.type === "checkbox" ? (
                      <input
                        checked={values[field.name] === true}
                        id={inputId}
                        type="checkbox"
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [field.name]: event.target.checked,
                          }))
                        }
                      />
                    ) : (
                      <input
                        dir={field.type === "money" ? "ltr" : undefined}
                        id={inputId}
                        required={field.required}
                        disabled={field.readOnly}
                        placeholder={field.placeholder}
                        type={
                          field.type === "date"
                            ? "date"
                            : field.type === "number"
                              ? "number"
                              : "text"
                        }
                        value={String(values[field.name] ?? "")}
                        onChange={(event) =>
                          setValues((current) => ({ ...current, [field.name]: event.target.value }))
                        }
                      />
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      {error === undefined ? null : (
        <div className="form-error" role="alert">
          {error.split("\n").map((line, index) => (
            <div key={`${line}-${index}`}>{line}</div>
          ))}
        </div>
      )}
      <footer className="accounting-form-actions accounting-form-actions-sticky">
        <button
          className="button button-secondary"
          disabled={pending}
          onClick={onCancel}
          type="button"
        >
          {t("common.cancel")}
        </button>
        <button className="button button-primary" disabled={pending} type="submit">
          {submitLabel}
        </button>
        {onSecondarySubmit === undefined || secondarySubmitLabel === undefined ? null : (
          <button
            className="button button-primary"
            disabled={pending}
            onClick={() => {
              secondarySubmit.current = true;
            }}
            type="submit"
          >
            {secondarySubmitLabel}
          </button>
        )}
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
  warningKey = "accounting.confirmation.financialImpact",
}: {
  readonly action: string;
  readonly amount?: unknown;
  readonly onClose: () => void;
  readonly onConfirm: (input: {
    readonly date?: string | undefined;
    readonly reason?: string | undefined;
  }) => Promise<void>;
  readonly recordReference: string;
  readonly requireDate?: boolean | undefined;
  readonly requireReason?: boolean | undefined;
  /* Almost every action here is financial and the default warning is right for
     it. Deleting a Draft is the exception: nothing was posted, so promising a
     balance revalidation would be false. */
  readonly warningKey?: string | undefined;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  // Defaults to today rather than blank: a reversal almost always posts on the
  // day it is performed, and an empty date here means the request never
  // resolves to a Fiscal Period at all -- a 409 the operator cannot self-serve
  // out of. Still fully editable for the rare backdated reversal.
  const [date, setDate] = useState(() => (requireDate ? new Date().toISOString().slice(0, 10) : ""));
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
      setError(
        cause instanceof ApiError
          ? t(`accounting.errors.codes.${cause.code}`, {
              defaultValue: cause.message || t("accounting.errors.safe"),
            })
          : cause instanceof Error
            ? cause.message
            : t("accounting.errors.safe"),
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t(`accounting.actions.${action}`, { defaultValue: action })}
      titleId={titleId}
    >
      <div className="modal-body accounting-action-dialog">
        <p>
          {t("accounting.confirmation.reference")}{" "}
          <DirectionalText>{recordReference}</DirectionalText>
        </p>
        {amount === undefined ? null : <strong>{formatAed(amount)}</strong>}
        {requireDate ? (
          <label>
            {t("accounting.fields.reversalDate")}
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
        ) : null}
        {requireReason ? (
          <label>
            {t("common.reason")}
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
        ) : null}
        <p className="accounting-warning">
          <AlertTriangle aria-hidden="true" size={18} />
          {t(warningKey)}
        </p>
        {error === undefined ? null : (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <footer className="modal-actions">
        <button
          className="button button-secondary"
          disabled={pending}
          onClick={onClose}
          type="button"
        >
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={pending}
          onClick={() => void confirm()}
          type="button"
        >
          {t("common.confirm")}
        </button>
      </footer>
    </Modal>
  );
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateKeyPattern = /date$|_at$|At$/;

/** Raw identifiers are wiring, not business information — administrators only. */
function isTechnicalEntry(key: string, value: unknown): boolean {
  return (
    key === "id" ||
    /Id$|_id$/.test(key) ||
    key.toLowerCase().includes("mappingkey") ||
    key === "correlationId" ||
    key === "version" ||
    (typeof value === "string" && uuidPattern.test(value))
  );
}

export function RecordDetail({
  record,
  showTechnical = false,
}: {
  readonly record: AccountingRecord;
  /** Reveals identifiers and mapping keys; pass only for authorized administrators. */
  readonly showTechnical?: boolean;
}) {
  const { i18n, t } = useTranslation();
  const language = i18n.resolvedLanguage ?? "en";
  const entries = useMemo(
    () =>
      Object.entries(record).filter(
        ([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value),
      ),
    [record],
  );
  const business = entries.filter(([key, value]) => !isTechnicalEntry(key, value));
  const technical = entries.filter(([key, value]) => isTechnicalEntry(key, value));
  const cell = (key: string, value: unknown) =>
    key.toLowerCase().includes("status") ? (
      <StatusBadge value={value} />
    ) : dateKeyPattern.test(key) && typeof value === "string" ? (
      formatAccountingDate(value, language)
    ) : /amount|debit|credit|balance|total|outstanding|paid|fee/i.test(key) &&
      typeof value === "string" ? (
      formatAed(value)
    ) : (
      <DirectionalText>{String(value ?? "—")}</DirectionalText>
    );
  return (
    <>
      <dl className="accounting-detail-grid">
        {business.map(([key, value]) => (
          <div key={key}>
            <dt>{key.replaceAll(/([A-Z])/g, " $1").replaceAll("_", " ")}</dt>
            <dd>{cell(key, value)}</dd>
          </div>
        ))}
      </dl>
      {!showTechnical || technical.length === 0 ? null : (
        <details className="accounting-technical-details">
          <summary>
            {t("accounting.technicalDetails", { defaultValue: "Technical details" })}
          </summary>
          <dl className="accounting-detail-grid">
            {technical.map(([key, value]) => (
              <div key={key}>
                <dt>{key.replaceAll(/([A-Z])/g, " $1").replaceAll("_", " ")}</dt>
                <dd>{cell(key, value)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </>
  );
}

export function AccountingStatusPanel({ status }: { readonly status?: AccountingRecord }) {
  const { t } = useTranslation();
  if (status === undefined)
    return <div className="accounting-empty">{t("accounting.statusUnavailable")}</div>;
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
      {attachments.length === 0 ? (
        <div className="accounting-empty">{t("accounting.attachments.empty")}</div>
      ) : (
        <ul>
          {attachments.map((attachment, index) => (
            <li key={String(attachment.id ?? attachment.fileObjectId ?? index)}>
              <DirectionalText>
                {String(
                  attachment.fileName ??
                    attachment.fileNameSnapshot ??
                    attachment.fileObjectId ??
                    "—",
                )}
              </DirectionalText>
              <span>{String(attachment.attachmentType ?? "other")}</span>
              {attachment.description === undefined ? null : (
                <small>{String(attachment.description)}</small>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <RecordForm
          fields={[
            { name: "fileObjectId", required: true },
            {
              name: "attachmentType",
              required: true,
              type: "select",
              options: [
                "invoice",
                "receipt",
                "tax_invoice",
                "quotation",
                "approval",
                "payment_evidence",
                "contract",
                "deposit_slip",
                "withdrawal_slip",
                "transfer_document",
                "bank_advice",
                "cash_count",
                "other",
              ].map((value) => ({ label: value, value })),
            },
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
