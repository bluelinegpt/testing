import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import type { AccountingApi } from "./accounting-api.js";
import type { AccountingRecord } from "./accounting-types.js";

/**
 * Inline "+ Add Category" for the General Expense form.
 *
 * Reuses the existing Category API exactly as the full Setup screen
 * (`expense-categories` section of `AccountingResourcePage`) does --
 * `POST general-expenses/categories`, permission `accounting.manage`,
 * server-side audited, idempotent. Nothing here is a second category
 * subsystem; it is a friendlier front door onto the same one.
 *
 * ===========================================================================
 * WHY "LINKED GL EXPENSE ACCOUNT" IS A MAPPING KEY, NOT A RAW ACCOUNT PICKER
 * ===========================================================================
 *
 * A Category has no direct GL-account column. It carries
 * `defaultExpenseMappingKey`, resolved through `account_mappings` at posting
 * time -- the server's own `assertCategoryMapping` requires that key to name
 * an ACTIVE mapping whose target account is `account_type = 'expense'`. This
 * dialog mirrors that exactly: it lists mapping keys that already resolve to
 * an active expense account, labelled by the account's own name, and stores
 * the category against that mapping key.
 *
 * The list is deliberately narrower than "every active expense-type mapping
 * in this Company": several existing keys (`driver_expense`,
 * `outsourced_driver_fee_expense`, `employee_payroll_expense`, `bank_charge`)
 * point at expense accounts too, but each is reserved for its OWN subsystem's
 * automatic postings, not for a General Expense Category. Offering them here
 * would let a Category quietly land manual expenses on an account meant only
 * for automatic ones -- technically accepted by the database, wrong in
 * substance. Eligible mapping keys are therefore `general_expense` plus
 * whatever other keys an existing Category in THIS Company already uses --
 * i.e. keys a person has already vetted as appropriate for this exact
 * purpose, never a subsystem-reserved one nobody chose for this.
 */

interface MappingRow {
  readonly expenseAccountCode?: string | undefined;
  readonly expenseAccountId?: string | undefined;
  readonly isActive?: boolean | undefined;
  readonly mappingKey?: string | undefined;
}

interface AccountRow {
  readonly accountType?: string | undefined;
  readonly id?: string | undefined;
  readonly isActive?: boolean | undefined;
  readonly isPostingAccount?: boolean | undefined;
  readonly nameAr?: string | null | undefined;
  readonly nameEn?: string | undefined;
}

interface GlAccountOption {
  readonly label: string;
  readonly mappingKey: string;
}

/** Uppercase, ASCII-safe, within the server's `code` pattern (max 32 chars). */
function suggestCode(name: string, taken: ReadonlySet<string>): string {
  const slug = name
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 26);
  const base = slug === "" ? "EXP" : `EXP-${slug}`.slice(0, 28);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base.slice(0, 28 - String(suffix).length - 1)}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

export function AddExpenseCategoryDialog({
  client,
  companyId,
  language,
  onClose,
  onCreated,
}: {
  readonly client: AccountingApi;
  readonly companyId: string;
  readonly language: "ar" | "en";
  readonly onClose: () => void;
  readonly onCreated: (category: { readonly id: string; readonly nameEn: string }) => void;
}) {
  const { t } = useTranslation();
  const [nameEn, setNameEn] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [mappingKey, setMappingKey] = useState("");
  const [existingCodes, setExistingCodes] = useState<ReadonlySet<string>>(new Set());
  const [glOptions, setGlOptions] = useState<readonly GlAccountOption[]>();
  const [glOptionsError, setGlOptionsError] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      client.get<readonly AccountingRecord[]>(
        "general-expenses/categories",
        undefined,
        controller.signal,
      ),
      client.get<readonly MappingRow[]>("mappings", undefined, controller.signal),
      client.accounts(undefined, controller.signal),
    ])
      .then(([categories, mappings, accounts]) => {
        if (controller.signal.aborted) return;
        setExistingCodes(
          new Set(
            categories
              .map((category) => String(category.code ?? "").toUpperCase())
              .filter((value) => value !== ""),
          ),
        );
        // Vetted for THIS purpose: the schema default, plus any key an
        // existing Category already relies on. Never a subsystem-reserved key
        // (driver fees, payroll, bank charges) nobody chose for this.
        const vettedKeys = new Set<string>(["general_expense"]);
        for (const category of categories) {
          const key = String(category.defaultExpenseMappingKey ?? "").trim();
          if (key !== "") vettedKeys.add(key);
        }
        const accountsById = new Map(
          (accounts as readonly AccountRow[]).map((row) => [row.id, row]),
        );
        const options: GlAccountOption[] = [];
        for (const mapping of mappings) {
          const key = mapping.mappingKey ?? "";
          if (!vettedKeys.has(key) || mapping.isActive !== true) continue;
          const account = accountsById.get(mapping.expenseAccountId);
          if (
            account === undefined ||
            account.accountType !== "expense" ||
            account.isActive !== true ||
            account.isPostingAccount !== true
          )
            continue;
          const name =
            language === "ar" ? (account.nameAr ?? account.nameEn ?? key) : (account.nameEn ?? key);
          options.push({
            label:
              mapping.expenseAccountCode === undefined
                ? String(name)
                : `${String(name)} (${mapping.expenseAccountCode})`,
            mappingKey: key,
          });
        }
        setGlOptions(options);
        setMappingKey((current) => (current === "" ? (options[0]?.mappingKey ?? "") : current));
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setGlOptions([]);
        setGlOptionsError(
          cause instanceof ApiError
            ? cause.message
            : t("accounting.errors.load", { defaultValue: "Accounting data could not be loaded." }),
        );
      });
    return () => controller.abort();
    // Fetched once, when the dialog opens. `companyId` is in the dependency
    // list purely so switching Companies without unmounting (should that ever
    // happen) still refetches for the right tenant -- every request below is
    // already Company-scoped server-side regardless.
  }, [client, companyId, language, t]);

  useEffect(() => {
    if (codeTouched) return;
    setCode(nameEn.trim() === "" ? "" : suggestCode(nameEn, existingCodes));
  }, [codeTouched, existingCodes, nameEn]);

  const submit = async () => {
    setError(undefined);
    const trimmedName = nameEn.trim();
    if (trimmedName === "") {
      setError(t("accounting.expenseCategoryDialog.errors.nameRequired"));
      return;
    }
    const trimmedCode = code.trim();
    if (trimmedCode === "") {
      setError(t("accounting.expenseCategoryDialog.errors.codeRequired"));
      return;
    }
    if (mappingKey === "") {
      setError(t("accounting.expenseCategoryDialog.errors.glAccountRequired"));
      return;
    }
    setSaving(true);
    try {
      const result = await client.post<{ id: string }>("general-expenses/categories", {
        code: trimmedCode.toUpperCase(),
        defaultExpenseMappingKey: mappingKey,
        defaultVatTreatment: "out_of_scope",
        description: description.trim() === "" ? undefined : description.trim(),
        // Today: the earliest date this brand-new Category can legitimately
        // apply to anything, matching how the full Setup screen's own
        // effectiveFrom picker defaults for a new record.
        effectiveFrom: new Date().toISOString().slice(0, 10),
        nameAr: nameAr.trim() === "" ? undefined : nameAr.trim(),
        nameEn: trimmedName,
      });
      onCreated({ id: result.id, nameEn: trimmedName });
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? t(`accounting.errors.codes.${cause.code}`, { defaultValue: cause.message })
          : t("accounting.errors.safe", {
              defaultValue: "The operation could not be completed safely.",
            }),
      );
    } finally {
      setSaving(false);
    }
  };

  const loadingGlOptions = glOptions === undefined;
  const noEligibleAccounts = !loadingGlOptions && glOptions.length === 0;

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("accounting.expenseCategoryDialog.title")}
      titleId="add-expense-category-title"
    >
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <div className="accounting-form-grid">
        <label>
          <span className="accounting-field-label-row">
            {t("accounting.expenseCategoryDialog.code")}
          </span>
          <small className="accounting-field-helper">
            {t("accounting.expenseCategoryDialog.codeHelper")}
          </small>
          <input
            onChange={(event) => {
              setCodeTouched(true);
              setCode(event.target.value);
            }}
            value={code}
          />
        </label>
        <label>
          <span className="accounting-field-label-row">
            {t("accounting.expenseCategoryDialog.categoryName")}
            <span className="accounting-field-required">*</span>
          </span>
          <input autoFocus onChange={(event) => setNameEn(event.target.value)} value={nameEn} />
        </label>
        <label>
          <span className="accounting-field-label-row">
            {t("accounting.expenseCategoryDialog.categoryNameAr")}
          </span>
          <input dir="rtl" onChange={(event) => setNameAr(event.target.value)} value={nameAr} />
        </label>
        <label>
          <span className="accounting-field-label-row">
            {t("accounting.expenseCategoryDialog.linkedGlAccount")}
            <span className="accounting-field-required">*</span>
          </span>
          <small className="accounting-field-helper">
            {t("accounting.expenseCategoryDialog.linkedGlAccountHelper")}
          </small>
          <select
            disabled={loadingGlOptions || noEligibleAccounts}
            onChange={(event) => setMappingKey(event.target.value)}
            value={mappingKey}
          >
            {loadingGlOptions ? (
              <option value="">{t("common.loading")}</option>
            ) : noEligibleAccounts ? (
              <option value="">{t("accounting.expenseCategoryDialog.noEligibleAccounts")}</option>
            ) : (
              glOptions.map((option) => (
                <option key={option.mappingKey} value={option.mappingKey}>
                  {option.label}
                </option>
              ))
            )}
          </select>
          {glOptionsError === undefined ? null : (
            <small className="accounting-field-helper">{glOptionsError}</small>
          )}
        </label>
        <label className="accounting-form-wide">
          <span className="accounting-field-label-row">
            {t("accounting.expenseCategoryDialog.description")}
          </span>
          <textarea onChange={(event) => setDescription(event.target.value)} value={description} />
        </label>
      </div>
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={saving || noEligibleAccounts}
          onClick={() => void submit()}
          type="button"
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </Modal>
  );
}
