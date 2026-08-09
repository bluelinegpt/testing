import { ArrowLeft, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { PageHeader } from "../../components/PageHeader.js";
import { parseMoneyInput } from "../../utils/numeric-input.js";
import {
  AccountingDocumentActions,
  AccountingTable,
  ActionDialog,
  AttachmentPanel,
  DirectionalText,
  LoadPanel,
  RecordDetail,
  StatusBadge,
  accountingPermissions,
  formatAccountingDate,
  formatAed,
} from "./AccountingComponents.js";
import { RelatedRecords } from "./RelatedRecords.js";
import { expensePaymentRelatedRecords } from "./accounting-related.js";
import { AccountingApi, accountingQueryKey } from "./accounting-api.js";
import { useAccountingFocus } from "./accounting-focus.js";
import type { AccountingRecord } from "./accounting-types.js";
import { useAccountingResource } from "./use-accounting-resource.js";

type PaymentMethod = "cash" | "visa";

interface PaymentRowDraft {
  readonly accountId: string;
  readonly amount: string;
  readonly key: string;
  readonly method: PaymentMethod;
  readonly referenceNumber: string;
}

interface PaymentFilters {
  readonly accountingStatus: string;
  readonly amountFrom: string;
  readonly amountTo: string;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly expenseNumber: string;
  readonly page: number;
  readonly pageSize: number;
  readonly payee: string;
  readonly paymentMethod: string;
  readonly paymentNumber: string;
  readonly sortBy: string;
  readonly sortDirection: string;
  readonly status: string;
}

const emptyFilters: PaymentFilters = {
  accountingStatus: "",
  amountFrom: "",
  amountTo: "",
  dateFrom: "",
  dateTo: "",
  expenseNumber: "",
  page: 1,
  pageSize: 25,
  payee: "",
  paymentMethod: "",
  paymentNumber: "",
  sortBy: "paymentDate",
  sortDirection: "desc",
  status: "",
};

/** Filters survive opening a Payment and coming back within the session. */
function filterStorageKey(companyId: string): string {
  return `blueline:accounting:expense-payment-filters:${companyId}`;
}

function readStoredFilters(companyId: string): PaymentFilters {
  if (typeof sessionStorage === "undefined") return emptyFilters;
  try {
    const raw = sessionStorage.getItem(filterStorageKey(companyId));
    if (raw === null) return emptyFilters;
    const parsed = JSON.parse(raw) as Partial<PaymentFilters>;
    return { ...emptyFilters, ...parsed };
  } catch {
    return emptyFilters;
  }
}

function toQuery(filters: PaymentFilters): Readonly<Record<string, unknown>> {
  return {
    accountingStatus: filters.accountingStatus || undefined,
    amountFrom: filters.amountFrom || undefined,
    amountTo: filters.amountTo || undefined,
    dateFrom: filters.dateFrom || undefined,
    dateTo: filters.dateTo || undefined,
    expenseNumber: filters.expenseNumber || undefined,
    page: filters.page,
    pageSize: filters.pageSize,
    payee: filters.payee || undefined,
    paymentMethod: filters.paymentMethod || undefined,
    paymentNumber: filters.paymentNumber || undefined,
    sortBy: filters.sortBy,
    sortDirection: filters.sortDirection,
    status: filters.status || undefined,
  };
}

function addDecimal(left: string, right: string): string {
  // Money is added in minor units so no intermediate float can drift.
  const toMinor = (value: string) => Math.round(Number(value === "" ? "0" : value) * 100);
  return ((toMinor(left) + toMinor(right)) / 100).toFixed(2);
}

function subtractDecimal(left: string, right: string): string {
  const toMinor = (value: string) => Math.round(Number(value === "" ? "0" : value) * 100);
  return ((toMinor(left) - toMinor(right)) / 100).toFixed(2);
}

function compareMoney(left: string, right: string): number {
  const toMinor = (value: string) => Math.round(Number(value === "" ? "0" : value) * 100);
  return toMinor(left) - toMinor(right);
}

function sumRows(amounts: readonly string[]): string {
  return amounts.reduce((total, amount) => addDecimal(total, amount || "0"), "0.00");
}

/** Business-readable label for an eligible Expense — never an identifier. */
function expenseOptionLabel(expense: AccountingRecord): string {
  const payee = String(expense.payeeName ?? "").trim();
  const outstanding = formatAed(expense.outstandingAmount);
  return payee === ""
    ? `${String(expense.expenseNumber)} — ${outstanding}`
    : `${String(expense.expenseNumber)} — ${payee} — ${outstanding}`;
}

function accountingStateOf(record: AccountingRecord): "failed" | "pending" | "posted" {
  const status = String(record.accountingStatus ?? "");
  if (status === "posted") return "posted";
  if (["failed", "blocked_configuration", "blocked_period"].includes(status)) return "failed";
  return "pending";
}

function ExpenseSelector({
  client,
  companyId,
  onSelect,
  preselectedExpenseId,
  selected,
}: {
  readonly client: AccountingApi;
  readonly companyId: string;
  readonly onSelect: (expense: AccountingRecord | undefined) => void;
  readonly preselectedExpenseId?: string | undefined;
  readonly selected?: AccountingRecord | undefined;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? "en";
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebounced(search), 250);
    return () => globalThis.clearTimeout(timer);
  }, [search]);
  const payable = useAccountingResource<{ readonly items: readonly AccountingRecord[] }>(
    accountingQueryKey(companyId, "expense-payments:payable", {
      includeExpenseId: preselectedExpenseId ?? "",
      search: debounced,
    }),
    (signal) =>
      client.get<{ readonly items: readonly AccountingRecord[] }>(
        "general-expenses/payable",
        {
          includeExpenseId: preselectedExpenseId,
          limit: 50,
          search: debounced || undefined,
        },
        signal,
      ),
  );
  const options = payable.data?.items ?? [];

  // A preselected Expense (Record Payment from the Expense screen) resolves
  // itself once, so the User never searches for what they just opened.
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || selected !== undefined || preselectedExpenseId === undefined) return;
    const match = options.find((option) => String(option.id) === preselectedExpenseId);
    if (match !== undefined) {
      applied.current = true;
      onSelect(match);
    }
  }, [onSelect, options, preselectedExpenseId, selected]);

  if (selected !== undefined) {
    return (
      <section className="accounting-preview-panel accounting-payment-selection">
        <header className="accounting-payment-selection-header">
          <h3>{t("accounting.payments.expenseToPay")}</h3>
          <button
            className="button button-secondary"
            onClick={() => onSelect(undefined)}
            type="button"
          >
            {t("accounting.payments.changeExpense")}
          </button>
        </header>
        <dl className="accounting-detail-grid">
          <div>
            <dt>{t("accounting.fields.expenseNumber")}</dt>
            <dd>
              <DirectionalText>{String(selected.expenseNumber)}</DirectionalText>
            </dd>
          </div>
          <div>
            <dt>{t("accounting.fields.payeeName")}</dt>
            <dd>{String(selected.payeeName ?? "—")}</dd>
          </div>
          <div>
            <dt>{t("accounting.payments.category")}</dt>
            <dd>
              {selected.categoryCode === null || selected.categoryCode === undefined
                ? "—"
                : `${String(selected.categoryCode)} — ${String(selected.categoryNameEn ?? "")}`}
            </dd>
          </div>
          <div>
            <dt>{t("accounting.payments.approvedAmount")}</dt>
            <dd>{formatAed(selected.approvedAmount)}</dd>
          </div>
          <div>
            <dt>{t("accounting.payments.paidAmount")}</dt>
            <dd>{formatAed(selected.paidAmount)}</dd>
          </div>
          <div>
            <dt>{t("accounting.payments.outstandingAmount")}</dt>
            <dd>{formatAed(selected.outstandingAmount)}</dd>
          </div>
          <div>
            <dt>{t("accounting.fields.currency")}</dt>
            <dd>
              <DirectionalText>{String(selected.currency ?? "AED")}</DirectionalText>
            </dd>
          </div>
          <div>
            <dt>{t("accounting.payments.expenseDate")}</dt>
            <dd>{formatAccountingDate(selected.expenseDate, language)}</dd>
          </div>
          <div>
            <dt>{t("accounting.fields.accountingDate")}</dt>
            <dd>{formatAccountingDate(selected.accountingDate, language)}</dd>
          </div>
        </dl>
      </section>
    );
  }

  return (
    <section className="accounting-preview-panel accounting-payment-selection">
      <h3>{t("accounting.payments.expenseToPay")}</h3>
      <label className="accounting-payment-search">
        <span>{t("accounting.payments.searchExpenses")}</span>
        <input
          autoComplete="off"
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("accounting.payments.searchExpensesPlaceholder")}
          type="search"
          value={search}
        />
      </label>
      {payable.loading ? (
        <p className="accounting-state" role="status">
          {t("common.loading")}
        </p>
      ) : payable.error !== undefined ? (
        <p className="form-error" role="alert">
          {t(`accounting.errors.codes.${payable.error}`, {
            defaultValue: t("accounting.errors.safe"),
          })}
        </p>
      ) : options.length === 0 ? (
        <p className="accounting-empty">{t("accounting.payments.noEligibleExpenses")}</p>
      ) : (
        <ul className="accounting-option-list">
          {options.map((option) => (
            <li key={String(option.id)}>
              <button onClick={() => onSelect(option)} type="button">
                <DirectionalText>{expenseOptionLabel(option)}</DirectionalText>
                <small>
                  {[
                    option.categoryCode === null || option.categoryCode === undefined
                      ? undefined
                      : String(option.categoryCode),
                    option.referenceNumber === null || option.referenceNumber === undefined
                      ? undefined
                      : String(option.referenceNumber),
                    formatAccountingDate(option.expenseDate, language),
                  ]
                    .filter((part) => part !== undefined && part !== "")
                    .join(" · ")}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PaymentPreviewPanel({
  currency,
  preview,
}: {
  readonly currency: string;
  readonly preview: {
    readonly confirmable: boolean;
    readonly issues: readonly string[];
    readonly lines: readonly AccountingRecord[];
  };
}) {
  const { t } = useTranslation();
  return (
    <section className="accounting-preview-panel">
      <h3>{t("accounting.payments.expectedAccountingEntry")}</h3>
      <p className="accounting-preview-note">{t("accounting.payments.previewNote")}</p>
      {preview.issues.length === 0 ? null : (
        <div className="alert alert-error" role="alert">
          <strong>{t("accounting.payments.confirmBlocked")}</strong>
          <ul>
            {preview.issues.map((issue) => (
              <li key={issue}>
                {t(`accounting.payments.issues.${issue.split(":")[0] ?? issue}`, {
                  defaultValue: t(`accounting.preview.issues.${issue.split(":")[0] ?? issue}`, {
                    defaultValue: issue,
                  }),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="table-scroll-x">
        <table className="data-table accounting-table">
          <thead>
            <tr>
              <th>{t("accounting.preview.account")}</th>
              <th>{t("accounting.preview.description")}</th>
              <th>{t("accounting.preview.debit")}</th>
              <th>{t("accounting.preview.credit")}</th>
            </tr>
          </thead>
          <tbody>
            {preview.lines.map((line, index) => (
              <tr key={`${String(line.accountCode ?? "")}-${String(line.entryIntent)}-${index}`}>
                <td>
                  <DirectionalText>
                    {line.accountCode === null || line.accountCode === undefined
                      ? t("accounting.preview.unresolvedAccount")
                      : `${String(line.accountCode)} — ${String(line.accountNameEn ?? "")}`}
                  </DirectionalText>
                </td>
                <td>{String(line.description ?? "—")}</td>
                <td>{line.entryIntent === "debit" ? formatAed(line.amount) : "—"}</td>
                <td>{line.entryIntent === "credit" ? formatAed(line.amount) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="accounting-preview-note">
        <DirectionalText>{currency}</DirectionalText>
      </p>
    </section>
  );
}

function RecordPaymentWorkflow({
  client,
  companyId,
  onCancel,
  onConfirmed,
  preselectedExpenseId,
}: {
  readonly client: AccountingApi;
  readonly companyId: string;
  readonly onCancel: () => void;
  readonly onConfirmed: (expenseId: string) => void;
  readonly preselectedExpenseId?: string | undefined;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? "en";
  const [expense, setExpense] = useState<AccountingRecord>();
  const [rows, setRows] = useState<readonly PaymentRowDraft[]>([]);
  const [paymentDate, setPaymentDate] = useState("");
  const [accountingDate, setAccountingDate] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [referenceNumber, setReferenceNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const context = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "expense-payments:context", {}),
    (signal) => client.get<AccountingRecord>("general-expenses/payment-context", undefined, signal),
  );
  const currency = String(context.data?.currency ?? "AED");
  const cashAccounts = Array.isArray(context.data?.cashAccounts)
    ? (context.data.cashAccounts as readonly AccountingRecord[])
    : [];
  const bankAccounts = Array.isArray(context.data?.bankAccounts)
    ? (context.data.bankAccounts as readonly AccountingRecord[])
    : [];
  // Only an Account whose GL link is valid can receive a posting, so an
  // unlinked Account is never offered as a silent default.
  const usableCash = cashAccounts.filter((account) => account.glLinkValid === true);
  const usableBank = bankAccounts.filter((account) => account.glLinkValid === true);

  // Payment Date defaults to today in the Company timezone and stays hidden
  // until the User opens Advanced; Accounting Date follows Payment Date.
  useEffect(() => {
    const today = typeof context.data?.today === "string" ? context.data.today : "";
    if (today !== "" && paymentDate === "") setPaymentDate(today);
  }, [context.data?.today, paymentDate]);
  const effectiveAccountingDate = accountingDate === "" ? paymentDate : accountingDate;

  // The simplest case is one row; the User only ever sees more after asking
  // for another payment method.
  useEffect(() => {
    if (rows.length > 0 || context.data === undefined) return;
    const cash = usableCash[0];
    const bank = usableBank[0];
    setRows([
      {
        accountId: String((cash ?? bank)?.id ?? ""),
        amount: "",
        key: "row-1",
        method: cash === undefined && bank !== undefined ? "visa" : "cash",
        referenceNumber: "",
      },
    ]);
  }, [context.data, rows.length, usableBank, usableCash]);

  // Amounts are normalised once (Arabic digits, stray currency text, decimal
  // separators) so the total, the preview and the confirmation all use the same
  // canonical value the API contract accepts.
  const normalizedAmounts = rows.map((row) =>
    parseMoneyInput(row.amount, { allowZero: false, required: true }),
  );
  const outstanding = String(expense?.outstandingAmount ?? "0.00");
  const total = sumRows(
    normalizedAmounts.map((parsed) => (parsed.ok ? parsed.normalized : "0")),
  );
  const remainingAfter = subtractDecimal(outstanding, total);
  const exceedsOutstanding = compareMoney(total, outstanding) > 0;
  const rowsComplete =
    rows.length > 0 &&
    rows.every((row, index) => row.accountId !== "" && normalizedAmounts[index]?.ok === true);
  const readyForPreview =
    expense !== undefined &&
    rowsComplete &&
    !exceedsOutstanding &&
    effectiveAccountingDate !== "" &&
    compareMoney(total, "0") > 0;

  // Read-only preview, one request per payment row so a mixed Cash + Bank
  // payment shows exactly the credit lines it will produce. Creates nothing.
  const previewKey = accountingQueryKey(companyId, "expense-payments:preview", {
    accountingDate: effectiveAccountingDate,
    expenseId: String(expense?.id ?? ""),
    rows: rows
      .map((row, index) => {
        const parsed = normalizedAmounts[index];
        return `${row.method}:${row.accountId}:${parsed?.ok === true ? parsed.normalized : ""}`;
      })
      .join("|"),
  });
  const preview = useAccountingResource<readonly AccountingRecord[]>(previewKey, async (signal) => {
    if (!readyForPreview || expense === undefined) return [];
    return Promise.all(
      rows.map((row, index) =>
        client.get<AccountingRecord>(
          `general-expenses/${String(expense.id)}/payment-preview`,
          {
            accountingDate: effectiveAccountingDate,
            amount: (() => {
              const parsed = normalizedAmounts[index];
              return parsed?.ok === true ? parsed.normalized : "0";
            })(),
            companyBankAccountId: row.method === "visa" ? row.accountId : undefined,
            companyCashAccountId: row.method === "cash" ? row.accountId : undefined,
            paymentMethod: row.method,
          },
          signal,
        ),
      ),
    );
  });

  const combinedPreview = useMemo(() => {
    const parts = preview.data ?? [];
    if (parts.length === 0) return undefined;
    const issues = [
      ...new Set(
        parts.flatMap((part) => (Array.isArray(part.issues) ? (part.issues as string[]) : [])),
      ),
    ];
    // One aggregated Debit against the payable, one Credit per row — the
    // shape `OperationalSourceLoader` produces for a Payment Event.
    const debit = {
      accountCode: undefined as unknown,
      accountNameEn: undefined as unknown,
      amount: total,
      description: t("accounting.payments.payableCleared"),
      entryIntent: "debit",
    };
    const credits: AccountingRecord[] = [];
    for (const part of parts) {
      const lines = Array.isArray(part.lines) ? (part.lines as readonly AccountingRecord[]) : [];
      for (const line of lines) {
        if (line.entryIntent === "debit") {
          debit.accountCode = line.accountCode;
          debit.accountNameEn = line.accountNameEn;
        } else credits.push(line);
      }
    }
    return {
      confirmable: parts.every((part) => part.confirmable === true) && !exceedsOutstanding,
      issues,
      lines: [debit as AccountingRecord, ...credits],
    };
  }, [exceedsOutstanding, preview.data, t, total]);

  const setRow = (key: string, patch: Partial<PaymentRowDraft>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const payFullOutstanding = () => {
    if (expense === undefined || rows.length === 0) return;
    if (rows.length === 1) {
      setRow(rows[0]!.key, { amount: outstanding });
      return;
    }
    // With several methods, the last row absorbs whatever is unallocated.
    const allocated = sumRows(
      normalizedAmounts.slice(0, -1).map((parsed) => (parsed.ok ? parsed.normalized : "0")),
    );
    const remainder = subtractDecimal(outstanding, allocated);
    setRow(rows[rows.length - 1]!.key, {
      amount: compareMoney(remainder, "0") > 0 ? remainder : "0.00",
    });
  };

  const addRow = () =>
    setRows((current) => [
      ...current,
      {
        accountId: String((usableBank[0] ?? usableCash[0])?.id ?? ""),
        amount: "",
        key: `row-${current.length + 1}-${String(current.length)}`,
        method: usableBank.length > 0 ? "visa" : "cash",
        referenceNumber: "",
      },
    ]);

  const confirm = async () => {
    if (expense === undefined) return;
    setError(undefined);
    const normalizedRows: { readonly amount: string; readonly row: PaymentRowDraft }[] = [];
    for (const row of rows) {
      const parsed = parseMoneyInput(row.amount, { allowZero: false, required: true });
      if (!parsed.ok) {
        setError(t("accounting.errors.invalidNumber"));
        return;
      }
      normalizedRows.push({ amount: parsed.normalized, row });
    }
    if (exceedsOutstanding) {
      setError(t("accounting.payments.amountExceedsOutstanding"));
      return;
    }
    setPending(true);
    try {
      await client.post(`general-expenses/${String(expense.id)}/payments`, {
        accountingDate: accountingDate === "" ? undefined : accountingDate,
        expenseVersion: Number(expense.version),
        notes: notes.trim() === "" ? undefined : notes.trim(),
        paymentDate,
        referenceNumber: referenceNumber.trim() === "" ? undefined : referenceNumber.trim(),
        rows: normalizedRows.map(({ amount, row }) => ({
          amount,
          // The Cash Account itself, not its GL account: the API derives the GL
          // account from the chosen drawer and rejects a client-named one.
          companyBankAccountId: row.method === "visa" ? row.accountId : undefined,
          companyCashAccountId: row.method === "cash" ? row.accountId : undefined,
          paymentMethod: row.method,
          referenceNumber:
            row.referenceNumber.trim() === "" ? undefined : row.referenceNumber.trim(),
        })),
      });
      // Everything showing this Expense — its detail, the Expense list, the
      // Payments list, Accounting Events and the reports — reloads itself.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("blueline:accounting-expense-payment-recorded"));
      }
      onConfirmed(String(expense.id));
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? t(`accounting.payments.issues.${cause.code}`, {
              defaultValue: t(`accounting.errors.codes.${cause.code}`, {
                defaultValue: cause.message || t("accounting.errors.safe"),
              }),
            })
          : t("accounting.errors.safe"),
      );
    } finally {
      setPending(false);
    }
  };

  const accountsFor = (method: PaymentMethod) => (method === "cash" ? usableCash : usableBank);
  const accountLabel = (account: AccountingRecord) =>
    `${String(account.code ?? "")} — ${String(account.name ?? "")}`;

  return (
    <section className="accounting-payment-workflow">
      <LoadPanel error={context.error} loading={context.loading} onRefresh={context.refresh}>
        <ExpenseSelector
          client={client}
          companyId={companyId}
          onSelect={(next) => {
            setExpense(next);
            setError(undefined);
          }}
          preselectedExpenseId={preselectedExpenseId}
          selected={expense}
        />
        {expense === undefined ? null : (
          <>
            <section className="accounting-preview-panel">
              <h3>{t("accounting.payments.paymentDetails")}</h3>
              <dl className="accounting-detail-grid accounting-allocation-grid">
                <div>
                  <dt>{t("accounting.payments.approvedAmount")}</dt>
                  <dd>{formatAed(expense.approvedAmount)}</dd>
                </div>
                <div>
                  <dt>{t("accounting.payments.alreadyPaid")}</dt>
                  <dd>{formatAed(expense.paidAmount)}</dd>
                </div>
                <div>
                  <dt>{t("accounting.payments.outstandingAmount")}</dt>
                  <dd>{formatAed(outstanding)}</dd>
                </div>
                <div>
                  <dt>{t("accounting.payments.paymentAmount")}</dt>
                  <dd>{formatAed(total)}</dd>
                </div>
                <div>
                  <dt>{t("accounting.payments.remainingAfterPayment")}</dt>
                  <dd>
                    {compareMoney(remainingAfter, "0") < 0 ? "—" : formatAed(remainingAfter)}
                  </dd>
                </div>
                <div>
                  <dt>{t("accounting.fields.currency")}</dt>
                  <dd>
                    <DirectionalText>{currency}</DirectionalText>
                  </dd>
                </div>
              </dl>
              <div className="accounting-lifecycle-actions">
                <button className="button button-secondary" onClick={payFullOutstanding} type="button">
                  {t("accounting.payments.payFullOutstanding")}
                </button>
                <span className="accounting-field-helper">
                  {t("accounting.payments.enterPartialAmount")}
                </span>
              </div>
              {exceedsOutstanding ? (
                <p className="form-error" role="alert">
                  {t("accounting.payments.amountExceedsOutstanding")}
                </p>
              ) : null}

              {rows.map((row, index) => {
                const accounts = accountsFor(row.method);
                return (
                  <fieldset className="accounting-form-section" key={row.key}>
                    <legend>
                      {rows.length === 1
                        ? t("accounting.payments.paymentMethod")
                        : t("accounting.payments.methodNumber", { number: index + 1 })}
                    </legend>
                    <div className="accounting-form-grid">
                      <label>
                        <span className="accounting-field-label-row">
                          {t("accounting.payments.paymentMethod")}
                          <span className="accounting-field-required">*</span>
                        </span>
                        <select
                          onChange={(event) => {
                            const method = event.target.value as PaymentMethod;
                            setRow(row.key, {
                              accountId: String(accountsFor(method)[0]?.id ?? ""),
                              method,
                            });
                          }}
                          value={row.method}
                        >
                          <option value="cash">{t("accounting.payments.methodCash")}</option>
                          <option value="visa">{t("accounting.payments.methodVisaBank")}</option>
                        </select>
                      </label>
                      <label>
                        <span className="accounting-field-label-row">
                          {row.method === "cash"
                            ? t("accounting.fields.cashAccount")
                            : t("accounting.fields.bankAccount")}
                          <span className="accounting-field-required">*</span>
                        </span>
                        <select
                          onChange={(event) => setRow(row.key, { accountId: event.target.value })}
                          value={row.accountId}
                        >
                          <option value="">{t("common.select")}</option>
                          {accounts.map((account) => (
                            <option key={String(account.id)} value={String(account.id)}>
                              {accountLabel(account)}
                            </option>
                          ))}
                        </select>
                        {accounts.length === 0 ? (
                          <small className="accounting-account-status">
                            {row.method === "cash"
                              ? t("accounting.payments.noActiveCashAccount")
                              : t("accounting.payments.noActiveBankAccount")}
                          </small>
                        ) : null}
                      </label>
                      <label>
                        <span className="accounting-field-label-row">
                          {t("accounting.payments.paymentAmount")}
                          <span className="accounting-field-required">*</span>
                        </span>
                        <input
                          dir="ltr"
                          inputMode="decimal"
                          onChange={(event) => setRow(row.key, { amount: event.target.value })}
                          value={row.amount}
                        />
                      </label>
                      <label>
                        <span className="accounting-field-label-row">
                          {t("accounting.payments.rowReference")}
                        </span>
                        <input
                          onChange={(event) =>
                            setRow(row.key, { referenceNumber: event.target.value })
                          }
                          value={row.referenceNumber}
                        />
                      </label>
                    </div>
                    {rows.length > 1 ? (
                      <button
                        className="button button-secondary"
                        onClick={() =>
                          setRows((current) => current.filter((item) => item.key !== row.key))
                        }
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={16} />
                        {t("accounting.payments.removeMethod")}
                      </button>
                    ) : null}
                  </fieldset>
                );
              })}
              <button className="button button-secondary" onClick={addRow} type="button">
                <Plus aria-hidden="true" size={16} />
                {t("accounting.payments.addAnotherMethod")}
              </button>

              <div className="accounting-form-grid">
                <label>
                  <span className="accounting-field-label-row">
                    {t("accounting.payments.referenceNumber")}
                  </span>
                  <small className="accounting-field-helper">
                    {t("accounting.payments.referenceHelp")}
                  </small>
                  <input
                    onChange={(event) => setReferenceNumber(event.target.value)}
                    value={referenceNumber}
                  />
                </label>
                <label className="accounting-form-wide">
                  <span className="accounting-field-label-row">
                    {t("accounting.payments.notes")}
                  </span>
                  <textarea onChange={(event) => setNotes(event.target.value)} value={notes} />
                </label>
              </div>

              <details
                className="accounting-technical-details"
                onToggle={(event) => setAdvanced(event.currentTarget.open)}
                open={advanced}
              >
                <summary>{t("accounting.payments.advanced")}</summary>
                <div className="accounting-form-grid">
                  <label>
                    <span className="accounting-field-label-row">
                      {t("accounting.fields.paymentDate")}
                    </span>
                    <input
                      onChange={(event) => setPaymentDate(event.target.value)}
                      type="date"
                      value={paymentDate}
                    />
                  </label>
                  <label>
                    <span className="accounting-field-label-row">
                      {t("accounting.fields.accountingDate")}
                    </span>
                    <small className="accounting-field-helper">
                      {t("accounting.payments.accountingDateHelp")}
                    </small>
                    <input
                      onChange={(event) => setAccountingDate(event.target.value)}
                      type="date"
                      value={accountingDate}
                    />
                  </label>
                </div>
              </details>
              {advanced ? null : (
                <p className="accounting-field-helper">
                  {t("accounting.payments.datesDefault", {
                    date: formatAccountingDate(paymentDate, language),
                  })}
                </p>
              )}
            </section>

            <section className="accounting-preview-panel">
              <h3>{t("accounting.payments.paymentSummary")}</h3>
              <dl className="accounting-detail-grid">
                <div>
                  <dt>{t("accounting.fields.expenseNumber")}</dt>
                  <dd>
                    <DirectionalText>{String(expense.expenseNumber)}</DirectionalText>
                  </dd>
                </div>
                <div>
                  <dt>{t("accounting.fields.payeeName")}</dt>
                  <dd>{String(expense.payeeName ?? "—")}</dd>
                </div>
                <div>
                  <dt>{t("accounting.payments.outstandingBefore")}</dt>
                  <dd>{formatAed(outstanding)}</dd>
                </div>
                <div>
                  <dt>{t("accounting.payments.paymentAmount")}</dt>
                  <dd>{formatAed(total)}</dd>
                </div>
                <div>
                  <dt>{t("accounting.payments.remainingAfterPayment")}</dt>
                  <dd>
                    {compareMoney(remainingAfter, "0") < 0 ? "—" : formatAed(remainingAfter)}
                  </dd>
                </div>
                <div>
                  <dt>{t("accounting.fields.paymentDate")}</dt>
                  <dd>{formatAccountingDate(paymentDate, language)}</dd>
                </div>
              </dl>
            </section>

            {!readyForPreview ? (
              <p className="accounting-field-helper">{t("accounting.payments.previewPending")}</p>
            ) : preview.loading ? (
              <p className="accounting-state" role="status">
                {t("common.loading")}
              </p>
            ) : preview.error !== undefined ? (
              <p className="form-error" role="alert">
                {t(`accounting.errors.codes.${preview.error}`, {
                  defaultValue: t("accounting.errors.safe"),
                })}
              </p>
            ) : combinedPreview === undefined ? null : (
              <PaymentPreviewPanel currency={currency} preview={combinedPreview} />
            )}
          </>
        )}
        {error === undefined ? null : (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <footer className="accounting-form-actions accounting-form-actions-sticky">
          <button
            className="button button-secondary"
            disabled={pending}
            onClick={onCancel}
            type="button"
          >
            <ArrowLeft aria-hidden="true" size={16} />
            {t("common.back")}
          </button>
          <button
            className="button button-primary"
            disabled={pending || combinedPreview?.confirmable !== true}
            onClick={() => void confirm()}
            type="button"
          >
            {t("accounting.actions.confirmPayment")}
          </button>
        </footer>
      </LoadPanel>
    </section>
  );
}

function PaymentDetailView({
  api,
  client,
  companyId,
  detail,
  onNavigate,
  onRefresh,
  paymentId,
  permissions,
  showTechnical,
}: {
  readonly api: ApiClient;
  readonly client: AccountingApi;
  readonly companyId: string;
  readonly detail: AccountingRecord;
  readonly onNavigate: (path: string) => void;
  readonly onRefresh: () => void;
  readonly paymentId: string;
  readonly permissions: readonly string[];
  readonly showTechnical: boolean;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? "en";
  const expenseId = String(detail.expenseId ?? "");
  // Allocation needs the Expense's own totals and the Payments recorded before
  // this one. Read-only.
  const expense = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "expense-payments:expense", { expenseId }),
    (signal) =>
      expenseId === ""
        ? Promise.resolve({} as AccountingRecord)
        : client.get<AccountingRecord>(`general-expenses/${expenseId}`, undefined, signal),
  );
  const siblingPayments = Array.isArray(expense.data?.payments)
    ? (expense.data.payments as readonly AccountingRecord[])
    : [];
  const index = siblingPayments.findIndex((payment) => String(payment.id) === paymentId);
  const paidBefore = siblingPayments
    .slice(0, index < 0 ? 0 : index)
    .filter((payment) => String(payment.status) === "confirmed")
    .reduce((total, payment) => addDecimal(total, String(payment.amount ?? "0")), "0.00");
  const approved = String(expense.data?.approvedAmount ?? "0.00");
  const thisPayment = String(detail.amount ?? "0.00");
  const remainingAfter = subtractDecimal(subtractDecimal(approved, paidBefore), thisPayment);
  const state = accountingStateOf(detail);
  const method =
    compareMoney(String(detail.cashAmount ?? "0"), "0") > 0 &&
    compareMoney(String(detail.visaAmount ?? "0"), "0") > 0
      ? t("accounting.payments.methodMixed")
      : compareMoney(String(detail.visaAmount ?? "0"), "0") > 0
        ? t("accounting.payments.methodVisaBank")
        : t("accounting.payments.methodCash");

  return (
    <>
      <AccountingDocumentActions
        api={api}
        filename={`expense-payment-${String(detail.paymentNumber ?? paymentId)}.pdf`}
        path={`operations/accounting/reports/documents/expense-payments/${paymentId}/pdf`}
      />
      <section className="accounting-preview-panel">
        <h3>{t("accounting.payments.summary")}</h3>
        <dl className="accounting-detail-grid">
          <div>
            <dt>{t("accounting.fields.paymentNumber")}</dt>
            <dd>
              <DirectionalText>{String(detail.paymentNumber ?? "—")}</DirectionalText>
            </dd>
          </div>
          <div>
            <dt>{t("accounting.fields.status")}</dt>
            <dd>
              <StatusBadge value={detail.status} />
            </dd>
          </div>
          <div>
            <dt>{t("accounting.fields.expenseNumber")}</dt>
            <dd>
              <DirectionalText>{String(detail.expenseNumber ?? "—")}</DirectionalText>
            </dd>
          </div>
          <div>
            <dt>{t("accounting.fields.payeeName")}</dt>
            <dd>{String(expense.data?.payeeName ?? "—")}</dd>
          </div>
          <div>
            <dt>{t("accounting.fields.paymentDate")}</dt>
            <dd>{formatAccountingDate(detail.paymentDate, language)}</dd>
          </div>
          <div>
            <dt>{t("accounting.fields.accountingDate")}</dt>
            <dd>{formatAccountingDate(detail.accountingDate, language)}</dd>
          </div>
          <div>
            <dt>{t("accounting.fields.amount")}</dt>
            <dd>{formatAed(detail.amount)}</dd>
          </div>
          <div>
            <dt>{t("accounting.payments.paymentMethod")}</dt>
            <dd>{method}</dd>
          </div>
          <div>
            <dt>{t("accounting.payments.referenceNumber")}</dt>
            <dd>
              <DirectionalText>{String(detail.referenceNumber ?? "—")}</DirectionalText>
            </dd>
          </div>
          <div>
            <dt>{t("accounting.payments.reversedStatus")}</dt>
            <dd>
              {String(detail.status) === "reversed"
                ? t("accounting.payments.paymentReversed")
                : t("common.no", { defaultValue: "No" })}
            </dd>
          </div>
        </dl>
      </section>

      <section className="accounting-preview-panel">
        <h3>{t("accounting.payments.allocation")}</h3>
        <dl className="accounting-detail-grid accounting-allocation-grid">
          <div>
            <dt>{t("accounting.payments.approvedAmount")}</dt>
            <dd>{formatAed(approved)}</dd>
          </div>
          <div>
            <dt>{t("accounting.payments.paidBeforeThisPayment")}</dt>
            <dd>{formatAed(paidBefore)}</dd>
          </div>
          <div>
            <dt>{t("accounting.payments.thisPayment")}</dt>
            <dd>{formatAed(thisPayment)}</dd>
          </div>
          <div>
            <dt>{t("accounting.payments.remainingAfterPayment")}</dt>
            <dd>{formatAed(compareMoney(remainingAfter, "0") < 0 ? "0.00" : remainingAfter)}</dd>
          </div>
        </dl>
      </section>

      <section className="accounting-preview-panel">
        <h3>{t("accounting.payments.accounting")}</h3>
        <dl className="accounting-detail-grid">
          <div>
            <dt>{t("accounting.payments.accountingState")}</dt>
            <dd>
              {state === "posted"
                ? t("accounting.payments.accountingPosted")
                : state === "failed"
                  ? t("accounting.payments.accountingFailed")
                  : t("accounting.payments.accountingPending")}
            </dd>
          </div>
          <div>
            <dt>{t("accounting.fields.journalNumber")}</dt>
            <dd>
              <DirectionalText>{String(detail.journalNumber ?? "—")}</DirectionalText>
            </dd>
          </div>
        </dl>
      </section>

      {/* The shared Related Records panel replaces the three ad-hoc buttons
          that used to sit here: it shows business references rather than
          identifiers, keeps a row visible when the relationship does not exist
          yet, and never offers a link the User cannot follow. */}
      <RelatedRecords
        onNavigate={onNavigate}
        records={expensePaymentRelatedRecords(detail, { permissions, t })}
        title={t("accounting.payments.relatedRecords")}
      />

      <AttachmentPanel
        attachments={
          Array.isArray(detail.attachments)
            ? (detail.attachments as readonly AccountingRecord[])
            : []
        }
        canManage={showTechnical && String(detail.status) !== "reversed"}
        onAttach={async (input) => {
          await client.post(`general-expenses/${expenseId}/attachments`, {
            ...input,
            paymentId,
          });
          onRefresh();
        }}
      />

      {!showTechnical ? null : (
        <details className="accounting-technical-details">
          <summary>{t("accounting.technicalDetails")}</summary>
          <RecordDetail record={detail} showTechnical />
        </details>
      )}
    </>
  );
}

export function ExpensePaymentsPage({
  api,
  companyId,
  id,
  mode,
  onNavigate,
  permissions,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly id?: string | undefined;
  readonly mode?: "detail" | "list" | "new" | undefined;
  readonly onNavigate: (path: string) => void;
  readonly permissions: readonly string[];
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new AccountingApi(api), [api]);
  const rights = accountingPermissions(permissions);
  const [revision, setRevision] = useState(0);
  const [reversing, setReversing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string>();
  const [filters, setFilters] = useState<PaymentFilters>(() => readStoredFilters(companyId));
  const recording = mode === "new";
  // Record Payment and the Payment detail both fill the width; the workflow is
  // local state, so it asks the workspace for focus mode directly.
  useAccountingFocus(recording);

  useEffect(() => {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(filterStorageKey(companyId), JSON.stringify(filters));
  }, [companyId, filters]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const reload = () => setRevision((value) => value + 1);
    window.addEventListener("blueline:accounting-expense-payment-recorded", reload);
    return () =>
      window.removeEventListener("blueline:accounting-expense-payment-recorded", reload);
  }, []);

  const detailId = mode === "detail" ? id : undefined;
  const listResource = useAccountingResource<{
    readonly items: readonly AccountingRecord[];
    readonly totalCount?: number;
  }>(
    accountingQueryKey(companyId, "general-expenses/payments", {
      ...toQuery(filters),
      revision,
    }),
    (signal) =>
      recording || detailId !== undefined
        ? Promise.resolve({ items: [] as readonly AccountingRecord[] })
        : client.get<{
            readonly items: readonly AccountingRecord[];
            readonly totalCount?: number;
          }>("general-expenses/payments", toQuery(filters), signal),
  );
  const detailResource = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "general-expenses/payment", { id: detailId ?? "", revision }),
    (signal) =>
      detailId === undefined
        ? Promise.resolve({} as AccountingRecord)
        : client.get<AccountingRecord>(`general-expenses/payments/${detailId}`, undefined, signal),
  );

  const refresh = () => setRevision((value) => value + 1);
  const items = listResource.data?.items ?? [];
  const totalCount = Number(listResource.data?.totalCount ?? 0);
  const pageCount = Math.max(1, Math.ceil(totalCount / filters.pageSize));
  const setFilter = (patch: Partial<PaymentFilters>) =>
    setFilters((current) => ({ ...current, page: 1, ...patch }));

  const quickFilter = (patch: Partial<PaymentFilters>) => setFilter(patch);
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;

  /**
   * Exports exactly the filtered result set, paging through the same
   * server-side filters. Capped so a very wide filter cannot pull an unbounded
   * export; when the cap is reached the User is told, never silently truncated.
   */
  const exportFiltered = async () => {
    setExporting(true);
    setExportNote(undefined);
    try {
      const cap = 2000;
      const collected: AccountingRecord[] = [];
      let page = 1;
      let total = 0;
      do {
        const chunk = await client.get<{
          readonly items: readonly AccountingRecord[];
          readonly totalCount?: number;
        }>("general-expenses/payments", { ...toQuery(filters), page, pageSize: 200 });
        collected.push(...chunk.items);
        total = Number(chunk.totalCount ?? collected.length);
        page += 1;
      } while (collected.length < Math.min(total, cap) && collected.length % 200 === 0);
      const header = [
        t("accounting.fields.paymentNumber"),
        t("accounting.fields.expenseNumber"),
        t("accounting.fields.payeeName"),
        t("accounting.fields.paymentDate"),
        t("accounting.payments.paymentMethod"),
        t("accounting.fields.amount"),
        t("accounting.fields.status"),
        t("accounting.fields.journalNumber"),
      ];
      const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
      const csv = [
        header.map(escape).join(","),
        ...collected.map((row) =>
          [
            row.paymentNumber,
            row.expenseNumber,
            row.payeeName,
            row.paymentDate,
            compareMoney(String(row.visaAmount ?? "0"), "0") > 0
              ? t("accounting.payments.methodVisaBank")
              : t("accounting.payments.methodCash"),
            row.amount,
            row.status,
            row.journalNumber,
          ]
            .map(escape)
            .join(","),
        ),
      ].join("\r\n");
      const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "expense-payments.csv";
      anchor.click();
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (total > cap) setExportNote(t("accounting.payments.exportCapped", { value: cap }));
    } catch {
      setExportNote(t("accounting.errors.safe"));
    } finally {
      setExporting(false);
    }
  };

  if (recording) {
    return (
      <section className="accounting-page">
        <PageHeader
          eyebrow={t("accounting.title")}
          title={t("accounting.actions.recordPayment")}
        />
        <RecordPaymentWorkflow
          client={client}
          companyId={companyId}
          onCancel={() =>
            onNavigate(
              id === undefined ? "/accounting/expense-payments" : `/accounting/expenses/${id}`,
            )
          }
          onConfirmed={(expenseId) =>
            onNavigate(
              id === undefined
                ? "/accounting/expense-payments"
                : `/accounting/expenses/${expenseId}`,
            )
          }
          preselectedExpenseId={id}
        />
      </section>
    );
  }

  if (detailId !== undefined) {
    const detail = detailResource.data;
    return (
      <section className="accounting-page">
        <PageHeader
          eyebrow={t("accounting.title")}
          title={t("accounting.sections.expense-payments")}
        />
        <LoadPanel
          error={detailResource.error}
          loading={detailResource.loading}
          onRefresh={detailResource.refresh}
        >
          <button
            className="button button-secondary"
            onClick={() => onNavigate("/accounting/expense-payments")}
            type="button"
          >
            <ArrowLeft aria-hidden="true" size={16} />
            {t("common.back")}
          </button>
          {detail === undefined ? null : (
            <>
              <PaymentDetailView
                api={api}
                client={client}
                companyId={companyId}
                detail={detail}
                onNavigate={onNavigate}
                onRefresh={refresh}
                paymentId={detailId}
                permissions={permissions}
                showTechnical={rights.manage || rights.configure}
              />
              {String(detail.status) === "confirmed" && rights.reverse ? (
                <div className="accounting-lifecycle-actions">
                  <button
                    className="button button-danger"
                    onClick={() => setReversing(true)}
                    type="button"
                  >
                    {t("accounting.actions.reversePayment")}
                  </button>
                </div>
              ) : null}
              {reversing ? (
                <ActionDialog
                  action="reversePayment"
                  amount={detail.amount}
                  onClose={() => setReversing(false)}
                  onConfirm={async ({ date, reason }) => {
                    await client.post(`general-expenses/payments/${detailId}/reverse`, {
                      accountingDate: date,
                      reason,
                      version: Number(detail.version),
                    });
                    refresh();
                  }}
                  recordReference={String(detail.paymentNumber ?? detailId)}
                  requireDate
                  requireReason
                />
              ) : null}
            </>
          )}
        </LoadPanel>
      </section>
    );
  }

  return (
    <section className="accounting-page">
      <PageHeader
        eyebrow={t("accounting.title")}
        title={t("accounting.sections.expense-payments")}
        actions={
          <>
            <button className="button button-secondary" onClick={refresh} type="button">
              <RefreshCw aria-hidden="true" size={16} />
              {t("common.refresh")}
            </button>
            {rights.manage ? (
              <button
                className="button button-primary"
                onClick={() => onNavigate("/accounting/expense-payments/new")}
                type="button"
              >
                <Plus aria-hidden="true" size={16} />
                {t("accounting.actions.recordPayment")}
              </button>
            ) : null}
          </>
        }
      />
      <div className="accounting-quick-filters">
        <button
          className="button button-secondary"
          onClick={() => quickFilter({ dateFrom: today, dateTo: today })}
          type="button"
        >
          {t("accounting.payments.quick.today")}
        </button>
        <button
          className="button button-secondary"
          onClick={() => quickFilter({ dateFrom: monthStart, dateTo: today })}
          type="button"
        >
          {t("accounting.payments.quick.thisMonth")}
        </button>
        <button
          className="button button-secondary"
          onClick={() => quickFilter({ paymentMethod: "cash" })}
          type="button"
        >
          {t("accounting.payments.methodCash")}
        </button>
        <button
          className="button button-secondary"
          onClick={() => quickFilter({ paymentMethod: "visa" })}
          type="button"
        >
          {t("accounting.payments.methodVisaBank")}
        </button>
        <button
          className="button button-secondary"
          onClick={() => quickFilter({ status: "reversed" })}
          type="button"
        >
          {t("accounting.payments.quick.reversed")}
        </button>
        <button
          className="button button-secondary"
          onClick={() => quickFilter({ accountingStatus: "failed" })}
          type="button"
        >
          {t("accounting.payments.quick.failedAccounting")}
        </button>
        <button
          className="button button-secondary"
          onClick={() => setFilters({ ...emptyFilters, pageSize: filters.pageSize })}
          type="button"
        >
          {t("accounting.payments.clearFilters")}
        </button>
      </div>
      <div className="accounting-filter-bar">
        <label>
          {t("accounting.fields.dateFrom")}
          <input
            onChange={(event) => setFilter({ dateFrom: event.target.value })}
            type="date"
            value={filters.dateFrom}
          />
        </label>
        <label>
          {t("accounting.fields.dateTo")}
          <input
            onChange={(event) => setFilter({ dateTo: event.target.value })}
            type="date"
            value={filters.dateTo}
          />
        </label>
        <label>
          {t("accounting.fields.expenseNumber")}
          <input
            onChange={(event) => setFilter({ expenseNumber: event.target.value })}
            value={filters.expenseNumber}
          />
        </label>
        <label>
          {t("accounting.fields.paymentNumber")}
          <input
            onChange={(event) => setFilter({ paymentNumber: event.target.value })}
            value={filters.paymentNumber}
          />
        </label>
        <label>
          {t("accounting.fields.payeeName")}
          <input
            onChange={(event) => setFilter({ payee: event.target.value })}
            value={filters.payee}
          />
        </label>
        <label>
          {t("accounting.payments.paymentMethod")}
          <select
            onChange={(event) => setFilter({ paymentMethod: event.target.value })}
            value={filters.paymentMethod}
          >
            <option value="">{t("common.all", { defaultValue: "All" })}</option>
            <option value="cash">{t("accounting.payments.methodCash")}</option>
            <option value="visa">{t("accounting.payments.methodVisaBank")}</option>
          </select>
        </label>
        <label>
          {t("accounting.fields.status")}
          <select
            onChange={(event) => setFilter({ status: event.target.value })}
            value={filters.status}
          >
            <option value="">{t("common.all", { defaultValue: "All" })}</option>
            <option value="confirmed">{t("accounting.status.confirmed")}</option>
            <option value="reversed">{t("accounting.status.reversed")}</option>
          </select>
        </label>
        <label>
          {t("accounting.payments.accountingState")}
          <select
            onChange={(event) => setFilter({ accountingStatus: event.target.value })}
            value={filters.accountingStatus}
          >
            <option value="">{t("common.all", { defaultValue: "All" })}</option>
            <option value="pending">{t("accounting.payments.accountingPending")}</option>
            <option value="posted">{t("accounting.payments.accountingPosted")}</option>
            <option value="failed">{t("accounting.payments.accountingFailed")}</option>
          </select>
        </label>
        <label>
          {t("accounting.payments.amountFrom")}
          <input
            dir="ltr"
            inputMode="decimal"
            onChange={(event) => setFilter({ amountFrom: event.target.value })}
            value={filters.amountFrom}
          />
        </label>
        <label>
          {t("accounting.payments.amountTo")}
          <input
            dir="ltr"
            inputMode="decimal"
            onChange={(event) => setFilter({ amountTo: event.target.value })}
            value={filters.amountTo}
          />
        </label>
        <label>
          {t("accounting.payments.sortBy")}
          <select
            onChange={(event) => setFilter({ sortBy: event.target.value })}
            value={filters.sortBy}
          >
            <option value="paymentDate">{t("accounting.fields.paymentDate")}</option>
            <option value="paymentNumber">{t("accounting.fields.paymentNumber")}</option>
            <option value="expenseNumber">{t("accounting.fields.expenseNumber")}</option>
            <option value="payee">{t("accounting.fields.payeeName")}</option>
            <option value="amount">{t("accounting.fields.amount")}</option>
          </select>
        </label>
        <label>
          {t("accounting.payments.sortDirection")}
          <select
            onChange={(event) => setFilter({ sortDirection: event.target.value })}
            value={filters.sortDirection}
          >
            <option value="desc">{t("accounting.payments.newestFirst")}</option>
            <option value="asc">{t("accounting.payments.oldestFirst")}</option>
          </select>
        </label>
        <button
          className="button button-secondary"
          disabled={exporting}
          onClick={() => void exportFiltered()}
          type="button"
        >
          {t("accounting.payments.export")}
        </button>
      </div>
      {exportNote === undefined ? null : (
        <p className="accounting-field-helper" role="status">
          {exportNote}
        </p>
      )}
      <LoadPanel
        error={listResource.error}
        loading={listResource.loading}
        onRefresh={listResource.refresh}
      >
        <p className="accounting-field-helper" role="status">
          {t("accounting.payments.results", { value: totalCount })}
        </p>
        {/* Primary columns are sized to fit without horizontal scrolling. */}
        <div className="accounting-payments-table">
          <AccountingTable
            columns={[
            {
              key: "paymentNumber",
              label: t("accounting.fields.paymentNumber"),
              technical: true,
            },
            {
              key: "expenseNumber",
              label: t("accounting.fields.expenseNumber"),
              technical: true,
            },
            { key: "payeeName", label: t("accounting.fields.payeeName") },
            { date: true, key: "paymentDate", label: t("accounting.fields.paymentDate") },
            {
              key: "method",
              label: t("accounting.payments.paymentMethod"),
              render: (row) =>
                compareMoney(String(row.cashAmount ?? "0"), "0") > 0 &&
                compareMoney(String(row.visaAmount ?? "0"), "0") > 0
                  ? t("accounting.payments.methodMixed")
                  : compareMoney(String(row.visaAmount ?? "0"), "0") > 0
                    ? t("accounting.payments.methodVisaBank")
                    : t("accounting.payments.methodCash"),
            },
            { key: "amount", label: t("accounting.fields.amount"), money: true },
            { key: "status", label: t("accounting.fields.status"), status: true },
            {
              key: "journalNumber",
              label: t("accounting.fields.journalNumber"),
              render: (row) => {
                const state = accountingStateOf(row);
                return row.journalNumber === null || row.journalNumber === undefined ? (
                  <span className="accounting-pending-amount">
                    {state === "failed"
                      ? t("accounting.payments.accountingFailed")
                      : t("accounting.payments.accountingPending")}
                  </span>
                ) : (
                  <DirectionalText>{String(row.journalNumber)}</DirectionalText>
                );
              },
            },
          ]}
            empty={t("accounting.empty")}
            items={items}
            onOpen={(row) => onNavigate(`/accounting/expense-payments/${String(row.id)}`)}
          />
        </div>
        <div className="accounting-pagination">
          <button
            className="button button-secondary"
            disabled={filters.page <= 1}
            onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}
            type="button"
          >
            {t("common.previous", { defaultValue: "Previous" })}
          </button>
          <span>
            {t("accounting.payments.pageOf", { page: filters.page, pages: pageCount })}
          </span>
          <button
            className="button button-secondary"
            disabled={filters.page >= pageCount}
            onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}
            type="button"
          >
            {t("common.next", { defaultValue: "Next" })}
          </button>
          <label>
            {t("accounting.payments.rowsPerPage")}
            <select
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  page: 1,
                  pageSize: Number(event.target.value),
                }))
              }
              value={filters.pageSize}
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
        </div>
      </LoadPanel>
    </section>
  );
}
