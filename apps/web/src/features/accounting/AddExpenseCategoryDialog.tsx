import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import type { AccountingApi } from "./accounting-api.js";
import type { AccountingRecord } from "./accounting-types.js";

/**
 * Predefined expense mapping keys with user-friendly labels.
 * These must match the backend's allowedExpenseMappingKeys.
 */
const EXPENSE_MAPPING_OPTIONS = [
  { label: "General expense", value: "general_expense" },
  { label: "Fuel / Petrol", value: "fuel_expense" },
  { label: "Salik / Toll", value: "salik_expense" },
  { label: "Parking", value: "parking_expense" },
  { label: "Driver advance", value: "driver_advance" },
  { label: "Office rent", value: "office_rent_expense" },
  { label: "Maintenance", value: "maintenance_expense" },
  { label: "Bank charges", value: "bank_charges" },
  { label: "Other operating expense", value: "other_operating_expense" },
] as const;

interface AccountOption {
  readonly key: string;
  readonly label: string;
}

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
  const [codeEditedManually, setCodeEditedManually] = useState(false);
  const [description, setDescription] = useState("");
  const [mappingKey, setMappingKey] = useState("general_expense");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [accountOptions, setAccountOptions] = useState<readonly AccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [existingCodes, setExistingCodes] = useState(new Set<string>());

  useEffect(() => {
    const load = async () => {
      try {
        const [accounts, mappings, categories] = await Promise.all([
          client.accounts(),
          client.get("mappings"),
          client.get("general-expenses/categories"),
        ]);

        // Build a set of mapping keys already used by existing categories
        const usedKeys = new Set<string>();
        for (const category of categories as Array<{ defaultExpenseMappingKey: string }>) {
          usedKeys.add(category.defaultExpenseMappingKey);
        }

        // Get eligible mapping keys: general_expense + keys already in use
        const eligibleKeys = new Set<string>(["general_expense", ...usedKeys]);

        // Build account options from eligible mappings
        const options: AccountOption[] = [];
        const seenMappings = new Set<string>();

        for (const mapping of mappings as Array<{
          mappingKey: string;
          expenseAccountId: string;
          expenseAccountCode: string;
          isActive: boolean
        }>) {
          if (!mapping.isActive || !eligibleKeys.has(mapping.mappingKey)) continue;
          if (seenMappings.has(mapping.mappingKey)) continue;
          seenMappings.add(mapping.mappingKey);

          // Find the corresponding account
          const account = (accounts as Array<{ id: string; nameEn: string }>).find(
            (a) => a.id === mapping.expenseAccountId,
          );
          if (account) {
            options.push({
              key: mapping.mappingKey,
              label: `${account.nameEn} (${mapping.expenseAccountCode})`,
            });
          }
        }

        setAccountOptions(options);
        if (options.length > 0) {
          setMappingKey(options[0]!.key);
        } else {
          setMappingKey("");
        }

        // Collect existing category codes for collision detection
        const codes = new Set<string>();
        for (const category of categories as Array<{ code: string }>) {
          codes.add(category.code);
        }
        setExistingCodes(codes);
      } catch (cause) {
        setError(t("accounting.errors.safe", {
          defaultValue: "Could not load account options. Please try again.",
        }));
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [client, t]);

  // Auto-generate code from name if not manually edited
  useEffect(() => {
    if (codeEditedManually) return;

    const name = nameEn.trim();
    if (name === "") {
      setCode("");
      return;
    }

    // Generate code: EXP-{NAME}, uppercase, replace non-alphanumeric with hyphens
    const withoutPrefix = name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    let generated = `EXP-${withoutPrefix}`;

    // Check for collisions and append a number if needed
    let counter = 2;
    while (existingCodes.has(generated)) {
      generated = `EXP-${withoutPrefix}-${counter}`;
      counter++;
    }

    setCode(generated);
  }, [nameEn, codeEditedManually, existingCodes]);

  const canSubmit = !loading && accountOptions.length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setError(undefined);
    const trimmedName = nameEn.trim();
    if (trimmedName === "") {
      setError(t("accounting.expenseCategoryDialog.errors.nameRequired"));
      return;
    }
    if (mappingKey === "") {
      setError(t("accounting.expenseCategoryDialog.errors.glAccountRequired"));
      return;
    }
    setSaving(true);
    try {
      const result = await client.post<{ id: string }>("general-expenses/categories", {
        code: code.trim(),
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
          ? t(`accounting.errors.codes.${cause.code}`, {
              defaultValue: cause.message,
            })
          : t("accounting.errors.safe", {
              defaultValue: "Expense category could not be saved. Please check required fields and try again.",
            }),
      );
    } finally {
      setSaving(false);
    }
  };

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
      {loading ? (
        <div>{t("common.loading")}</div>
      ) : (
        <>
          {accountOptions.length === 0 && (
            <div className="alert alert-info">
              No active Expense GL Account is configured yet. Ask an Accounting administrator to add one before creating a Category.
            </div>
          )}
          <div className="accounting-form-grid">
          <label>
            <span className="accounting-field-label-row">
              {t("accounting.expenseCategoryDialog.categoryName")}
              <span className="accounting-field-required">*</span>
            </span>
            <input autoFocus onChange={(event) => setNameEn(event.target.value)} value={nameEn} />
          </label>
          <label>
            <span className="accounting-field-label-row">
              Category Code
            </span>
            <input
              onChange={(event) => {
                setCode(event.target.value);
                setCodeEditedManually(event.target.value !== "");
              }}
              value={code}
            />
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
            <select
              onChange={(event) => setMappingKey(event.target.value)}
              value={mappingKey}
            >
              {accountOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="accounting-form-wide">
            <span className="accounting-field-label-row">
              {t("accounting.expenseCategoryDialog.description")}
            </span>
            <textarea onChange={(event) => setDescription(event.target.value)} value={description} />
          </label>
          </div>
        </>
      )}
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={saving || !canSubmit}
          onClick={() => void submit()}
          type="button"
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </Modal>
  );
}
