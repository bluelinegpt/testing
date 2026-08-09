import { ArrowLeft, Plus, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { movementRelatedRecords } from "./accounting-related.js";
import { AccountingApi, accountingQueryKey } from "./accounting-api.js";
import { useAccountingFocus } from "./accounting-focus.js";
import type { AccountingRecord } from "./accounting-types.js";
import { useAccountingResource } from "./use-accounting-resource.js";

/** Mirrors `cashBankMovementTypes`, minus `opening_balance` which the Opening
 *  Balance workflow owns and the Movement event writer rejects. */
const movementTypeOrder = [
  "cash_to_bank_transfer",
  "bank_to_cash_transfer",
  "cash_deposit",
  "cash_withdrawal",
  "bank_deposit",
  "bank_withdrawal",
  "bank_to_bank_transfer",
  "cash_to_cash_transfer",
] as const;

/** Business meaning of the money's origin/destination for a deposit or a
 *  withdrawal, submitted as the backend classification mapping key. */
const depositClassifications = [
  "cash_bank_deposit_owner_contribution",
  "cash_bank_deposit_refund",
  "cash_bank_deposit_loan",
] as const;

const withdrawalClassifications = [
  "cash_bank_withdrawal_owner",
  "cash_bank_withdrawal_refund",
  "cash_bank_withdrawal_loan_repayment",
] as const;

interface MovementShape {
  readonly classification: "deposit" | "transfer" | "withdrawal";
  readonly destination: "bank" | "cash" | null;
  readonly source: "bank" | "cash" | null;
  readonly value: string;
}

interface MovementFilters {
  readonly accountingStatus: string;
  readonly amountFrom: string;
  readonly amountTo: string;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly movementFamily: string;
  readonly movementNumber: string;
  readonly movementType: string;
  readonly page: number;
  readonly pageSize: number;
  readonly referenceNumber: string;
  readonly sortBy: string;
  readonly sortDirection: string;
  readonly status: string;
}

const emptyFilters: MovementFilters = {
  accountingStatus: "",
  amountFrom: "",
  amountTo: "",
  dateFrom: "",
  dateTo: "",
  movementFamily: "",
  movementNumber: "",
  movementType: "",
  page: 1,
  pageSize: 25,
  referenceNumber: "",
  sortBy: "accountingDate",
  sortDirection: "desc",
  status: "",
};

function filterStorageKey(companyId: string): string {
  return `blueline:accounting:cash-bank-filters:${companyId}`;
}

function readStoredFilters(companyId: string): MovementFilters {
  if (typeof sessionStorage === "undefined") return emptyFilters;
  try {
    const raw = sessionStorage.getItem(filterStorageKey(companyId));
    if (raw === null) return emptyFilters;
    return { ...emptyFilters, ...(JSON.parse(raw) as Partial<MovementFilters>) };
  } catch {
    return emptyFilters;
  }
}

function toQuery(filters: MovementFilters): Readonly<Record<string, unknown>> {
  return {
    accountingStatus: filters.accountingStatus || undefined,
    amountFrom: filters.amountFrom || undefined,
    amountTo: filters.amountTo || undefined,
    dateFrom: filters.dateFrom || undefined,
    dateTo: filters.dateTo || undefined,
    movementFamily: filters.movementFamily || undefined,
    movementNumber: filters.movementNumber || undefined,
    movementType: filters.movementType || undefined,
    page: filters.page,
    pageSize: filters.pageSize,
    referenceNumber: filters.referenceNumber || undefined,
    sortBy: filters.sortBy,
    sortDirection: filters.sortDirection,
    status: filters.status || undefined,
  };
}

function accountingStateOf(record: AccountingRecord): "failed" | "pending" | "posted" {
  const status = String(record.accountingStatus ?? record.accountingEventStatus ?? "");
  if (status === "posted") return "posted";
  if (["failed", "blocked_configuration", "blocked_period"].includes(status)) return "failed";
  return "pending";
}

function accountLabel(account: AccountingRecord): string {
  return `${String(account.code ?? "")} — ${String(account.name ?? "")}`;
}

/** From/To label for a list row, using Codes rather than identifiers. */
function endpointLabel(row: AccountingRecord, side: "destination" | "source"): string {
  const cash = row[`${side}CashAccountCode`];
  const bank = row[`${side}BankAccountCode`];
  if (typeof cash === "string" && cash !== "") return cash;
  if (typeof bank === "string" && bank !== "") return bank;
  return "—";
}

function AccountSelector({
  accounts,
  emptyText,
  id,
  label,
  loading,
  onChange,
  value,
}: {
  readonly accounts: readonly AccountingRecord[];
  readonly emptyText: string;
  readonly id: string;
  readonly label: string;
  readonly loading: boolean;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  const { t } = useTranslation();
  const listId = `${id}-options`;
  const selected = accounts.find((account) => String(account.id) === value);
  const [text, setText] = useState(selected === undefined ? "" : accountLabel(selected));
  useEffect(() => {
    setText(selected === undefined ? "" : accountLabel(selected));
  }, [selected]);
  return (
    <label className="accounting-form-wide">
      <span className="accounting-field-label-row">
        {label}
        <span className="accounting-field-required">*</span>
      </span>
      <input
        aria-label={label}
        autoComplete="off"
        disabled={loading}
        id={id}
        list={listId}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const match = accounts.find(
            (account) => accountLabel(account).toLowerCase() === next.trim().toLowerCase(),
          );
          onChange(match === undefined ? "" : String(match.id));
        }}
        placeholder={t("accounting.movements.searchAccount")}
        type="search"
        value={text}
      />
      <datalist id={listId}>
        {accounts.map((account) => (
          <option key={String(account.id)} value={accountLabel(account)} />
        ))}
      </datalist>
      {accounts.length === 0 && !loading ? (
        <small className="accounting-account-status">{emptyText}</small>
      ) : null}
    </label>
  );
}

function MovementPreviewPanel({ preview }: { readonly preview: AccountingRecord }) {
  const { t } = useTranslation();
  const lines = Array.isArray(preview.lines) ? (preview.lines as readonly AccountingRecord[]) : [];
  const issues = Array.isArray(preview.issues) ? (preview.issues as readonly string[]) : [];
  return (
    <section className="accounting-preview-panel">
      <h3>{t("accounting.movements.expectedAccountingEntry")}</h3>
      <p className="accounting-preview-note">{t("accounting.movements.previewNote")}</p>
      {issues.length === 0 ? null : (
        <div className="alert alert-error" role="alert">
          <strong>{t("accounting.movements.confirmBlocked")}</strong>
          <ul>
            {issues.map((issue) => (
              <li key={issue}>
                {t(`accounting.movements.issues.${issue.split(":")[0] ?? issue}`, {
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
            {lines.map((line, index) => (
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
      <dl className="accounting-detail-grid accounting-allocation-grid">
        <div>
          <dt>{t("accounting.preview.debit")}</dt>
          <dd>{formatAed(preview.debitTotal)}</dd>
        </div>
        <div>
          <dt>{t("accounting.preview.credit")}</dt>
          <dd>{formatAed(preview.creditTotal)}</dd>
        </div>
        <div>
          <dt>{t("accounting.movements.treatment")}</dt>
          <dd>
            {t(`accounting.movements.treatments.${String(preview.treatment ?? "")}`, {
              defaultValue: String(preview.treatment ?? "—"),
            })}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function CreateMovementWorkflow({
  canConfirm,
  client,
  companyId,
  onCancel,
  onSaved,
}: {
  readonly canConfirm: boolean;
  readonly client: AccountingApi;
  readonly companyId: string;
  readonly onCancel: () => void;
  readonly onSaved: (movementId: string, confirmed: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? "en";
  const [movementType, setMovementType] = useState<string>("cash_to_bank_transfer");
  const [sourceId, setSourceId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [amount, setAmount] = useState("");
  const [withFee, setWithFee] = useState(false);
  const [feeAmount, setFeeAmount] = useState("");
  const [feeDescription, setFeeDescription] = useState("");
  const [classification, setClassification] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [description, setDescription] = useState("");
  const [movementDate, setMovementDate] = useState("");
  const [accountingDate, setAccountingDate] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const context = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "cash-bank:movement-context", {}),
    (signal) => client.get<AccountingRecord>("cash-bank/movement-context", undefined, signal),
  );
  const currency = String(context.data?.currency ?? "AED");
  const shapes = Array.isArray(context.data?.movementTypes)
    ? (context.data.movementTypes as readonly MovementShape[])
    : [];
  const shape = shapes.find((item) => item.value === movementType);
  const cashAccounts = Array.isArray(context.data?.cashAccounts)
    ? (context.data.cashAccounts as readonly AccountingRecord[])
    : [];
  const bankAccounts = Array.isArray(context.data?.bankAccounts)
    ? (context.data.bankAccounts as readonly AccountingRecord[])
    : [];
  // Only an Account with a usable GL link can post, so an unlinked Account is
  // never offered rather than accepted and rejected at confirmation.
  const usable = (kind: "bank" | "cash" | null) =>
    kind === null
      ? []
      : (kind === "cash" ? cashAccounts : bankAccounts).filter(
          (account) => account.glLinkValid === true,
        );
  const bankChargeReady =
    ((context.data?.bankChargeAccount ?? {}) as AccountingRecord).status === "resolved";

  useEffect(() => {
    const today = typeof context.data?.today === "string" ? context.data.today : "";
    if (today !== "" && movementDate === "") setMovementDate(today);
  }, [context.data?.today, movementDate]);
  const effectiveAccountingDate = accountingDate === "" ? movementDate : accountingDate;

  // Changing the Movement Type changes which endpoints exist at all, so any
  // selection that no longer applies is cleared instead of silently submitted.
  useEffect(() => {
    setSourceId("");
    setDestinationId("");
    setClassification("");
  }, [movementType]);

  const parsedAmount = parseMoneyInput(amount, { allowZero: false, required: true });
  const parsedFee = withFee
    ? parseMoneyInput(feeAmount, { allowZero: true, required: true })
    : ({ normalized: "0", ok: true, value: 0 } as const);
  const amountText = parsedAmount.ok ? parsedAmount.normalized : "";
  const feeText = parsedFee.ok ? parsedFee.normalized : "";

  const needsClassification = shape !== undefined && shape.classification !== "transfer";
  const ready =
    shape !== undefined &&
    parsedAmount.ok &&
    parsedFee.ok &&
    effectiveAccountingDate !== "" &&
    (shape.source === null || sourceId !== "") &&
    (shape.destination === null || destinationId !== "") &&
    (!needsClassification || classification !== "");

  const previewKey = accountingQueryKey(companyId, "cash-bank:movement-preview", {
    accountingDate: effectiveAccountingDate,
    amount: amountText,
    classification,
    destinationId,
    fee: feeText,
    movementType,
    sourceId,
  });
  const preview = useAccountingResource<AccountingRecord>(previewKey, (signal) =>
    !ready || shape === undefined
      ? Promise.resolve({} as AccountingRecord)
      : client.get<AccountingRecord>(
          "cash-bank/movement-preview",
          {
            accountingDate: effectiveAccountingDate,
            amount: amountText,
            classificationMappingKey: needsClassification ? classification : undefined,
            destinationBankAccountId: shape.destination === "bank" ? destinationId : undefined,
            destinationCashAccountId: shape.destination === "cash" ? destinationId : undefined,
            feeAmount: feeText,
            movementType,
            sourceBankAccountId: shape.source === "bank" ? sourceId : undefined,
            sourceCashAccountId: shape.source === "cash" ? sourceId : undefined,
          },
          signal,
        ),
  );
  const confirmable = preview.data?.confirmable === true;

  const body = () => ({
    accountingDate: effectiveAccountingDate,
    amount: amountText,
    classificationMappingKey: needsClassification ? classification : undefined,
    description: description.trim() === "" ? undefined : description.trim(),
    destinationBankAccountId: shape?.destination === "bank" ? destinationId : undefined,
    destinationCashAccountId: shape?.destination === "cash" ? destinationId : undefined,
    feeAmount: feeText === "" ? "0" : feeText,
    feeDescription:
      withFee && feeDescription.trim() !== "" ? feeDescription.trim() : undefined,
    movementDate,
    movementType,
    referenceNumber: referenceNumber.trim() === "" ? undefined : referenceNumber.trim(),
    sourceBankAccountId: shape?.source === "bank" ? sourceId : undefined,
    sourceCashAccountId: shape?.source === "cash" ? sourceId : undefined,
  });

  const translateError = (cause: unknown) =>
    cause instanceof ApiError
      ? t(`accounting.movements.issues.${cause.code}`, {
          defaultValue: t(`accounting.errors.codes.${cause.code}`, {
            defaultValue: cause.message || t("accounting.errors.safe"),
          }),
        })
      : t("accounting.errors.safe");

  const save = async (confirm: boolean) => {
    setError(undefined);
    if (!parsedAmount.ok) {
      setError(t("accounting.errors.invalidNumber"));
      return;
    }
    setPending(true);
    let movementId = "";
    try {
      const created = await client.post<AccountingRecord>("cash-bank/movements", body());
      movementId = String(created.id);
      if (!confirm) {
        onSaved(movementId, false);
        return;
      }
      // The backend lifecycle is create(draft) → confirm; these are two
      // operations, so a failed confirmation leaves a recoverable draft rather
      // than losing the User's input.
      await client.post(`cash-bank/movements/${movementId}/confirm`, {});
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("blueline:accounting-cash-bank-movement-recorded"));
      }
      onSaved(movementId, true);
    } catch (cause) {
      if (movementId !== "") {
        setError(
          `${t("accounting.movements.savedAsDraftAfterFailure")} ${translateError(cause)}`,
        );
        onSaved(movementId, false);
        return;
      }
      setError(translateError(cause));
    } finally {
      setPending(false);
    }
  };

  const classificationOptions =
    shape?.classification === "deposit"
      ? depositClassifications
      : shape?.classification === "withdrawal"
        ? withdrawalClassifications
        : [];

  return (
    <section className="accounting-payment-workflow">
      <LoadPanel error={context.error} loading={context.loading} onRefresh={context.refresh}>
        <section className="accounting-preview-panel">
          <h3>{t("accounting.movements.movementDetails")}</h3>
          <div className="accounting-form-grid">
            <label>
              <span className="accounting-field-label-row">
                {t("accounting.movements.movementType")}
                <span className="accounting-field-required">*</span>
              </span>
              <select onChange={(event) => setMovementType(event.target.value)} value={movementType}>
                {movementTypeOrder
                  .filter((type) => shapes.some((item) => item.value === type))
                  .map((type) => (
                    <option key={type} value={type}>
                      {t(`accounting.movements.types.${type}`)}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span className="accounting-field-label-row">{t("accounting.fields.currency")}</span>
              <input dir="ltr" readOnly value={currency} />
            </label>
          </div>

          {/* Only the endpoints this Movement Type actually has are rendered. */}
          <div className="accounting-form-grid">
            {shape?.source == null ? null : (
              <AccountSelector
                accounts={usable(shape.source)}
                emptyText={
                  shape.source === "cash"
                    ? t("accounting.movements.noEligibleCashAccounts")
                    : t("accounting.movements.noEligibleBankAccounts")
                }
                id="movement-source"
                label={
                  shape.source === "cash"
                    ? t("accounting.movements.fromCashAccount")
                    : t("accounting.movements.fromBankAccount")
                }
                loading={context.loading}
                onChange={setSourceId}
                value={sourceId}
              />
            )}
            {shape?.destination == null ? null : (
              <AccountSelector
                accounts={usable(shape.destination)}
                emptyText={
                  shape.destination === "cash"
                    ? t("accounting.movements.noEligibleCashAccounts")
                    : t("accounting.movements.noEligibleBankAccounts")
                }
                id="movement-destination"
                label={
                  shape.destination === "cash"
                    ? t("accounting.movements.toCashAccount")
                    : t("accounting.movements.toBankAccount")
                }
                loading={context.loading}
                onChange={setDestinationId}
                value={destinationId}
              />
            )}
          </div>

          <div className="accounting-form-grid">
            <label>
              <span className="accounting-field-label-row">
                {t("accounting.fields.amount")}
                <span className="accounting-field-required">*</span>
              </span>
              <input
                dir="ltr"
                inputMode="decimal"
                onChange={(event) => setAmount(event.target.value)}
                value={amount}
              />
            </label>
            {!needsClassification ? null : (
              <label>
                <span className="accounting-field-label-row">
                  {shape?.classification === "deposit"
                    ? t("accounting.movements.sourceOfFunds")
                    : t("accounting.movements.purpose")}
                  <span className="accounting-field-required">*</span>
                </span>
                <select
                  onChange={(event) => setClassification(event.target.value)}
                  value={classification}
                >
                  <option value="">{t("common.select")}</option>
                  {classificationOptions.map((key) => (
                    <option key={key} value={key}>
                      {t(`accounting.movements.classifications.${key}`)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              <span className="accounting-field-label-row">
                {t("accounting.movements.referenceNumber")}
              </span>
              <input
                onChange={(event) => setReferenceNumber(event.target.value)}
                value={referenceNumber}
              />
            </label>
            <label className="accounting-form-wide">
              <span className="accounting-field-label-row">
                {t("accounting.movements.description")}
              </span>
              <textarea
                onChange={(event) => setDescription(event.target.value)}
                value={description}
              />
            </label>
          </div>

          {shape?.source == null ? null : (
            <div className="accounting-form-grid">
              <label className="accounting-form-wide">
                <span className="accounting-field-label-row">
                  <input
                    checked={withFee}
                    disabled={!bankChargeReady}
                    onChange={(event) => setWithFee(event.target.checked)}
                    type="checkbox"
                  />
                  {t("accounting.movements.addBankFee")}
                </span>
                {bankChargeReady ? null : (
                  <small className="accounting-account-status">
                    {t("accounting.movements.issues.bank_charge_mapping_missing")}
                  </small>
                )}
              </label>
              {!withFee ? null : (
                <>
                  <label>
                    <span className="accounting-field-label-row">
                      {t("accounting.movements.bankFee")}
                    </span>
                    <input
                      dir="ltr"
                      inputMode="decimal"
                      onChange={(event) => setFeeAmount(event.target.value)}
                      value={feeAmount}
                    />
                  </label>
                  {parsedFee.ok && Number(parsedFee.normalized) > 0 ? (
                    <label>
                      <span className="accounting-field-label-row">
                        {t("accounting.movements.feeDescription")}
                      </span>
                      <input
                        onChange={(event) => setFeeDescription(event.target.value)}
                        value={feeDescription}
                      />
                    </label>
                  ) : null}
                </>
              )}
            </div>
          )}

          <details
            className="accounting-technical-details"
            onToggle={(event) => setAdvanced(event.currentTarget.open)}
            open={advanced}
          >
            <summary>{t("accounting.movements.advanced")}</summary>
            <div className="accounting-form-grid">
              <label>
                <span className="accounting-field-label-row">
                  {t("accounting.movements.movementDate")}
                </span>
                <input
                  onChange={(event) => setMovementDate(event.target.value)}
                  type="date"
                  value={movementDate}
                />
              </label>
              <label>
                <span className="accounting-field-label-row">
                  {t("accounting.fields.accountingDate")}
                </span>
                <small className="accounting-field-helper">
                  {t("accounting.movements.accountingDateHelp")}
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
              {t("accounting.movements.datesDefault", {
                date: formatAccountingDate(movementDate, language),
              })}
            </p>
          )}
        </section>

        <section className="accounting-preview-panel">
          <h3>{t("accounting.movements.movementSummary")}</h3>
          <dl className="accounting-detail-grid accounting-allocation-grid">
            <div>
              <dt>{t("accounting.movements.from")}</dt>
              <dd>
                <DirectionalText>
                  {String(preview.data?.sourceAccount ?? t("accounting.movements.external"))}
                </DirectionalText>
              </dd>
            </div>
            <div>
              <dt>{t("accounting.movements.to")}</dt>
              <dd>
                <DirectionalText>
                  {String(preview.data?.destinationAccount ?? t("accounting.movements.external"))}
                </DirectionalText>
              </dd>
            </div>
            <div>
              <dt>{t("accounting.fields.amount")}</dt>
              <dd>{formatAed(amountText === "" ? "0" : amountText)}</dd>
            </div>
            <div>
              <dt>{t("accounting.movements.bankFee")}</dt>
              <dd>{formatAed(feeText === "" ? "0" : feeText)}</dd>
            </div>
            <div>
              <dt>{t("accounting.movements.sourceEffect")}</dt>
              <dd>
                {preview.data?.sourceEffect == null
                  ? "—"
                  : `- ${formatAed(preview.data.sourceEffect)}`}
              </dd>
            </div>
            <div>
              <dt>{t("accounting.movements.destinationEffect")}</dt>
              <dd>
                {preview.data?.destinationEffect == null
                  ? "—"
                  : `+ ${formatAed(preview.data.destinationEffect)}`}
              </dd>
            </div>
            <div>
              <dt>{t("accounting.movements.movementDate")}</dt>
              <dd>{formatAccountingDate(movementDate, language)}</dd>
            </div>
            <div>
              <dt>{t("accounting.fields.accountingDate")}</dt>
              <dd>{formatAccountingDate(effectiveAccountingDate, language)}</dd>
            </div>
          </dl>
        </section>

        {!ready ? (
          <p className="accounting-field-helper">{t("accounting.movements.previewPending")}</p>
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
        ) : preview.data === undefined ? null : (
          <MovementPreviewPanel preview={preview.data} />
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
            className="button button-secondary"
            disabled={pending || !ready}
            onClick={() => void save(false)}
            type="button"
          >
            {t("accounting.movements.saveDraft")}
          </button>
          {canConfirm ? (
            <button
              className="button button-primary"
              disabled={pending || !confirmable}
              onClick={() => void save(true)}
              type="button"
            >
              {t("accounting.movements.confirmMovement")}
            </button>
          ) : null}
        </footer>
      </LoadPanel>
    </section>
  );
}

function MovementDetailView({
  detail,
  movementId,
  onNavigate,
  permissions,
  showTechnical,
}: {
  readonly detail: AccountingRecord;
  readonly movementId: string;
  readonly onNavigate: (path: string) => void;
  readonly permissions: readonly string[];
  readonly showTechnical: boolean;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? "en";
  const state = accountingStateOf(detail);
  const endpoint = (side: "destination" | "source") => {
    const code = detail[`${side}CashAccountCode`] ?? detail[`${side}BankAccountCode`];
    const name = detail[`${side}CashAccountName`] ?? detail[`${side}BankAccountName`];
    return code == null ? "—" : `${String(code)} — ${String(name ?? "")}`;
  };
  return (
    <>
      <section className="accounting-preview-panel">
        <h3>{t("accounting.movements.summary")}</h3>
        <dl className="accounting-detail-grid">
          <div>
            <dt>{t("accounting.fields.movementNumber")}</dt>
            <dd>
              <DirectionalText>{String(detail.movement_number ?? "—")}</DirectionalText>
            </dd>
          </div>
          <div>
            <dt>{t("accounting.fields.status")}</dt>
            <dd>
              <StatusBadge value={detail.status} />
            </dd>
          </div>
          <div>
            <dt>{t("accounting.movements.movementType")}</dt>
            <dd>
              {t(`accounting.movements.types.${String(detail.movement_type ?? "")}`, {
                defaultValue: String(detail.movement_type ?? "—"),
              })}
            </dd>
          </div>
          <div>
            <dt>{t("accounting.movements.movementDate")}</dt>
            <dd>{formatAccountingDate(detail.movementDate, language)}</dd>
          </div>
          <div>
            <dt>{t("accounting.fields.accountingDate")}</dt>
            <dd>{formatAccountingDate(detail.accountingDate, language)}</dd>
          </div>
          <div>
            <dt>{t("accounting.movements.from")}</dt>
            <dd>
              <DirectionalText>{endpoint("source")}</DirectionalText>
            </dd>
          </div>
          <div>
            <dt>{t("accounting.movements.to")}</dt>
            <dd>
              <DirectionalText>{endpoint("destination")}</DirectionalText>
            </dd>
          </div>
          <div>
            <dt>{t("accounting.fields.amount")}</dt>
            <dd>{formatAed(detail.amount)}</dd>
          </div>
          <div>
            <dt>{t("accounting.movements.bankFee")}</dt>
            <dd>{formatAed(detail.fee_amount)}</dd>
          </div>
          <div>
            <dt>{t("accounting.fields.currency")}</dt>
            <dd>
              <DirectionalText>{String(detail.currency ?? "AED")}</DirectionalText>
            </dd>
          </div>
          <div>
            <dt>{t("accounting.movements.referenceNumber")}</dt>
            <dd>
              <DirectionalText>{String(detail.reference_number ?? "—")}</DirectionalText>
            </dd>
          </div>
          <div>
            <dt>{t("accounting.movements.description")}</dt>
            <dd>{String(detail.description ?? "—")}</dd>
          </div>
        </dl>
      </section>

      <section className="accounting-preview-panel">
        <h3>{t("accounting.movements.accounting")}</h3>
        <dl className="accounting-detail-grid">
          <div>
            <dt>{t("accounting.movements.accountingState")}</dt>
            <dd>
              {state === "posted"
                ? t("accounting.movements.accountingPosted")
                : state === "failed"
                  ? t("accounting.movements.accountingFailed")
                  : t("accounting.movements.accountingPending")}
            </dd>
          </div>
          <div>
            <dt>{t("accounting.fields.journalNumber")}</dt>
            <dd>
              <DirectionalText>{String(detail.journalNumber ?? "—")}</DirectionalText>
            </dd>
          </div>
          <div>
            <dt>{t("accounting.movements.reversalJournal")}</dt>
            <dd>
              <DirectionalText>{String(detail.reversalJournalNumber ?? "—")}</DirectionalText>
            </dd>
          </div>
          {detail.accountingErrorSummary == null ? null : (
            <div>
              <dt>{t("accounting.movements.accountingError")}</dt>
              <dd>{String(detail.accountingErrorSummary)}</dd>
            </div>
          )}
        </dl>
      </section>

      {/* The shared Related Records panel replaces the five ad-hoc buttons that
          used to sit here: business references instead of identifiers, an
          explicit empty state for a relationship that does not exist, and no
          link the User has no permission to follow. */}
      <RelatedRecords
        onNavigate={onNavigate}
        records={movementRelatedRecords(detail, { permissions, t })}
        title={t("accounting.movements.relatedRecords")}
      />

      {!showTechnical ? null : (
        <details className="accounting-technical-details">
          <summary>{t("accounting.technicalDetails")}</summary>
          <RecordDetail record={detail} showTechnical />
        </details>
      )}
      <span className="sr-only">{movementId}</span>
    </>
  );
}

export function CashBankMovementsPage({
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
  const [dialog, setDialog] = useState<"cancel" | "confirm" | "reverse">();
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string>();
  const [filters, setFilters] = useState<MovementFilters>(() => readStoredFilters(companyId));
  const creating = mode === "new";
  useAccountingFocus(creating);

  useEffect(() => {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(filterStorageKey(companyId), JSON.stringify(filters));
  }, [companyId, filters]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const reload = () => setRevision((value) => value + 1);
    window.addEventListener("blueline:accounting-cash-bank-movement-recorded", reload);
    return () =>
      window.removeEventListener("blueline:accounting-cash-bank-movement-recorded", reload);
  }, []);

  const detailId = mode === "detail" ? id : undefined;
  const listResource = useAccountingResource<{
    readonly items: readonly AccountingRecord[];
    readonly totalCount?: number;
  }>(
    accountingQueryKey(companyId, "cash-bank/movements", { ...toQuery(filters), revision }),
    (signal) =>
      creating || detailId !== undefined
        ? Promise.resolve({ items: [] as readonly AccountingRecord[] })
        : client.get<{
            readonly items: readonly AccountingRecord[];
            readonly totalCount?: number;
          }>("cash-bank/movements", toQuery(filters), signal),
  );
  const detailResource = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "cash-bank/movement", { id: detailId ?? "", revision }),
    (signal) =>
      detailId === undefined
        ? Promise.resolve({} as AccountingRecord)
        : client.get<AccountingRecord>(`cash-bank/movements/${detailId}`, undefined, signal),
  );

  const refresh = () => setRevision((value) => value + 1);
  const items = listResource.data?.items ?? [];
  const totalCount = Number(listResource.data?.totalCount ?? 0);
  const pageCount = Math.max(1, Math.ceil(totalCount / filters.pageSize));
  const setFilter = (patch: Partial<MovementFilters>) =>
    setFilters((current) => ({ ...current, page: 1, ...patch }));
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;

  const runAction = async (
    name: "cancel" | "confirm" | "reverse",
    input: { readonly date?: string | undefined; readonly reason?: string | undefined },
  ) => {
    await client.post(
      `cash-bank/movements/${detailId}/${name}`,
      name === "reverse"
        ? { reason: input.reason, reversalDate: input.date }
        : name === "cancel"
          ? { reason: input.reason }
          : { note: input.reason },
    );
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("blueline:accounting-cash-bank-movement-recorded"));
    }
    refresh();
  };

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
        }>("cash-bank/movements", { ...toQuery(filters), page, pageSize: 200 });
        collected.push(...chunk.items);
        total = Number(chunk.totalCount ?? collected.length);
        page += 1;
      } while (collected.length < Math.min(total, cap) && collected.length % 200 === 0);
      const header = [
        t("accounting.fields.movementNumber"),
        t("accounting.fields.accountingDate"),
        t("accounting.movements.movementType"),
        t("accounting.movements.from"),
        t("accounting.movements.to"),
        t("accounting.fields.amount"),
        t("accounting.movements.bankFee"),
        t("accounting.fields.status"),
        t("accounting.fields.journalNumber"),
      ];
      const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
      const csv = [
        header.map(escape).join(","),
        ...collected.map((row) =>
          [
            row.movementNumber,
            row.accountingDate,
            t(`accounting.movements.types.${String(row.movementType)}`, {
              defaultValue: String(row.movementType),
            }),
            endpointLabel(row, "source"),
            endpointLabel(row, "destination"),
            row.amount,
            row.feeAmount,
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
      anchor.download = "cash-bank-movements.csv";
      anchor.click();
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (total > cap) setExportNote(t("accounting.movements.exportCapped", { value: cap }));
    } catch {
      setExportNote(t("accounting.errors.safe"));
    } finally {
      setExporting(false);
    }
  };

  if (creating) {
    return (
      <section className="accounting-page">
        <PageHeader
          eyebrow={t("accounting.title")}
          title={t("accounting.movements.newMovement")}
        />
        <CreateMovementWorkflow
          canConfirm={rights.approve}
          client={client}
          companyId={companyId}
          onCancel={() => onNavigate("/accounting/cash-bank-movements")}
          onSaved={(movementId) => onNavigate(`/accounting/cash-bank-movements/${movementId}`)}
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
          title={t("accounting.sections.cash-bank-movements")}
        />
        <LoadPanel
          error={detailResource.error}
          loading={detailResource.loading}
          onRefresh={detailResource.refresh}
        >
          <button
            className="button button-secondary"
            onClick={() => onNavigate("/accounting/cash-bank-movements")}
            type="button"
          >
            <ArrowLeft aria-hidden="true" size={16} />
            {t("common.back")}
          </button>
          {detail === undefined ? null : (
            <>
              <AccountingDocumentActions
                api={api}
                filename={`cash-bank-movement-${String(detail.movement_number ?? detailId)}.pdf`}
                path={`operations/accounting/reports/documents/cash-bank-movements/${detailId}/pdf`}
              />
              <MovementDetailView
                detail={detail}
                movementId={detailId}
                onNavigate={onNavigate}
                permissions={permissions}
                showTechnical={rights.manage || rights.configure}
              />
              <AttachmentPanel
                attachments={
                  Array.isArray(detail.attachments)
                    ? (detail.attachments as readonly AccountingRecord[])
                    : []
                }
                canManage={rights.manage && String(detail.status) === "draft"}
                onAttach={async (input) => {
                  await client.post(`cash-bank/movements/${detailId}/attachments`, input);
                  refresh();
                }}
              />
              <div className="accounting-lifecycle-actions">
                {String(detail.status) === "draft" && rights.manage ? (
                  <button
                    className="button button-secondary"
                    onClick={() => setDialog("cancel")}
                    type="button"
                  >
                    {t("accounting.actions.cancel")}
                  </button>
                ) : null}
                {String(detail.status) === "draft" && rights.approve ? (
                  <button
                    className="button button-primary"
                    onClick={() => setDialog("confirm")}
                    type="button"
                  >
                    {t("accounting.movements.confirmMovement")}
                  </button>
                ) : null}
                {String(detail.status) === "confirmed" && rights.reverse ? (
                  <button
                    className="button button-danger"
                    onClick={() => setDialog("reverse")}
                    type="button"
                  >
                    {t("common.reverse")}
                  </button>
                ) : null}
              </div>
              {dialog === undefined ? null : (
                <ActionDialog
                  action={dialog}
                  amount={detail.amount}
                  onClose={() => setDialog(undefined)}
                  onConfirm={(input) => runAction(dialog, input)}
                  recordReference={String(detail.movement_number ?? detailId)}
                  requireDate={dialog === "reverse"}
                  requireReason={dialog !== "confirm"}
                />
              )}
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
        title={t("accounting.sections.cash-bank-movements")}
        actions={
          <>
            <button className="button button-secondary" onClick={refresh} type="button">
              <RefreshCw aria-hidden="true" size={16} />
              {t("common.refresh")}
            </button>
            {rights.manage ? (
              <button
                className="button button-primary"
                onClick={() => onNavigate("/accounting/cash-bank-movements/new")}
                type="button"
              >
                <Plus aria-hidden="true" size={16} />
                {t("accounting.movements.newMovement")}
              </button>
            ) : null}
          </>
        }
      />
      <div className="accounting-quick-filters">
        <button
          className="button button-secondary"
          onClick={() => setFilter({ dateFrom: today, dateTo: today })}
          type="button"
        >
          {t("accounting.payments.quick.today")}
        </button>
        <button
          className="button button-secondary"
          onClick={() => setFilter({ dateFrom: monthStart, dateTo: today })}
          type="button"
        >
          {t("accounting.payments.quick.thisMonth")}
        </button>
        <button
          className="button button-secondary"
          onClick={() => setFilter({ movementFamily: "cash" })}
          type="button"
        >
          {t("accounting.movements.quick.cash")}
        </button>
        <button
          className="button button-secondary"
          onClick={() => setFilter({ movementFamily: "bank" })}
          type="button"
        >
          {t("accounting.movements.quick.bank")}
        </button>
        <button
          className="button button-secondary"
          onClick={() => setFilter({ movementFamily: "transfer" })}
          type="button"
        >
          {t("accounting.movements.quick.transfers")}
        </button>
        <button
          className="button button-secondary"
          onClick={() => setFilter({ movementFamily: "fee" })}
          type="button"
        >
          {t("accounting.movements.quick.bankCharges")}
        </button>
        <button
          className="button button-secondary"
          onClick={() => setFilter({ accountingStatus: "pending" })}
          type="button"
        >
          {t("accounting.movements.accountingPending")}
        </button>
        <button
          className="button button-secondary"
          onClick={() => setFilter({ accountingStatus: "failed" })}
          type="button"
        >
          {t("accounting.movements.accountingFailed")}
        </button>
        <button
          className="button button-secondary"
          onClick={() => setFilter({ status: "reversed" })}
          type="button"
        >
          {t("accounting.payments.quick.reversed")}
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
          {t("accounting.fields.movementNumber")}
          <input
            onChange={(event) => setFilter({ movementNumber: event.target.value })}
            value={filters.movementNumber}
          />
        </label>
        <label>
          {t("accounting.movements.movementType")}
          <select
            onChange={(event) => setFilter({ movementType: event.target.value })}
            value={filters.movementType}
          >
            <option value="">{t("common.all", { defaultValue: "All" })}</option>
            {movementTypeOrder.map((type) => (
              <option key={type} value={type}>
                {t(`accounting.movements.types.${type}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("accounting.movements.referenceNumber")}
          <input
            onChange={(event) => setFilter({ referenceNumber: event.target.value })}
            value={filters.referenceNumber}
          />
        </label>
        <label>
          {t("accounting.fields.status")}
          <select
            onChange={(event) => setFilter({ status: event.target.value })}
            value={filters.status}
          >
            <option value="">{t("common.all", { defaultValue: "All" })}</option>
            <option value="draft">{t("accounting.status.draft")}</option>
            <option value="confirmed">{t("accounting.status.confirmed")}</option>
            <option value="cancelled">{t("accounting.status.cancelled")}</option>
            <option value="reversed">{t("accounting.status.reversed")}</option>
          </select>
        </label>
        <label>
          {t("accounting.movements.accountingState")}
          <select
            onChange={(event) => setFilter({ accountingStatus: event.target.value })}
            value={filters.accountingStatus}
          >
            <option value="">{t("common.all", { defaultValue: "All" })}</option>
            <option value="pending">{t("accounting.movements.accountingPending")}</option>
            <option value="posted">{t("accounting.movements.accountingPosted")}</option>
            <option value="failed">{t("accounting.movements.accountingFailed")}</option>
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
            <option value="accountingDate">{t("accounting.fields.accountingDate")}</option>
            <option value="movementDate">{t("accounting.movements.movementDate")}</option>
            <option value="movementNumber">{t("accounting.fields.movementNumber")}</option>
            <option value="movementType">{t("accounting.movements.movementType")}</option>
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
          {t("accounting.movements.results", { value: totalCount })}
        </p>
        {/* Primary columns are sized to fit without horizontal scrolling. */}
        <div className="accounting-payments-table">
          <AccountingTable
            columns={[
              {
                key: "movementNumber",
                label: t("accounting.fields.movementNumber"),
                technical: true,
              },
              { date: true, key: "accountingDate", label: t("accounting.fields.accountingDate") },
              {
                key: "movementType",
                label: t("accounting.movements.movementType"),
                render: (row) =>
                  t(`accounting.movements.types.${String(row.movementType)}`, {
                    defaultValue: String(row.movementType),
                  }),
              },
              {
                key: "from",
                label: t("accounting.movements.from"),
                render: (row) => (
                  <DirectionalText>{endpointLabel(row, "source")}</DirectionalText>
                ),
              },
              {
                key: "to",
                label: t("accounting.movements.to"),
                render: (row) => (
                  <DirectionalText>{endpointLabel(row, "destination")}</DirectionalText>
                ),
              },
              { key: "amount", label: t("accounting.fields.amount"), money: true },
              { key: "feeAmount", label: t("accounting.movements.bankFee"), money: true },
              { key: "status", label: t("accounting.fields.status"), status: true },
              {
                key: "journalNumber",
                label: t("accounting.fields.journalNumber"),
                render: (row) => {
                  const state = accountingStateOf(row);
                  return row.journalNumber == null ? (
                    <span className="accounting-pending-amount">
                      {state === "failed"
                        ? t("accounting.movements.accountingFailed")
                        : t("accounting.movements.accountingPending")}
                    </span>
                  ) : (
                    <DirectionalText>{String(row.journalNumber)}</DirectionalText>
                  );
                },
              },
            ]}
            empty={t("accounting.empty")}
            items={items}
            onOpen={(row) => onNavigate(`/accounting/cash-bank-movements/${String(row.id)}`)}
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
          <span>{t("accounting.payments.pageOf", { page: filters.page, pages: pageCount })}</span>
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
