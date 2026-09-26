import type { TFunction } from "i18next";

import { recordRoute } from "./accounting-routes.js";

/**
 * Business-readable labels for the raw enum values the Accounting backend
 * stores. Normal screens must never render `cash_to_bank_transfer`,
 * `outsourced_driver_fees` or `company_user`.
 *
 * Every resolver falls back to Title Case rather than to the word "Unknown":
 * a recognised-but-untranslated value is still usable information, and showing
 * "Unknown" for a valid status actively misleads. "Unknown" — rendered as an
 * em dash — is reserved for genuinely absent values.
 */

/** `cash_to_bank_transfer` → `Cash To Bank Transfer`. Never returns "Unknown". */
export function toTitleCase(raw: string): string {
  return raw
    .replaceAll(/[_-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Resolves `namespace.value`, falling back to Title Case of the raw value.
 * An empty/absent value renders as an em dash, never as "Unknown".
 *
 * A missing translation is reported once per value to the console in
 * development so unmapped enums surface during testing instead of silently
 * reading as Title Case forever.
 */
const reported = new Set<string>();

export function accountingLabel(
  t: TFunction,
  namespace: string,
  value: unknown,
  options: { readonly emptyLabel?: string } = {},
): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return options.emptyLabel ?? "—";
  const key = `${namespace}.${raw}`;
  const fallback = toTitleCase(raw);
  const translated = t(key, { defaultValue: fallback });
  // `import.meta.env.DEV` is the Vite-native flag; `process.env` is not defined
  // in the browser bundle.
  if (translated === fallback && !reported.has(key) && import.meta.env.DEV) {
    reported.add(key);
    // eslint-disable-next-line no-console
    console.warn(`[accounting] no translation for ${key} — showing "${fallback}"`);
  }
  return translated;
}

/** `order_delivered` → `Order Delivered`. */
export const eventTypeLabel = (t: TFunction, value: unknown): string =>
  accountingLabel(t, "accounting.eventTypes", value);

/** `cash_bank_management` → `Cash and Bank`. */
export const operationalAreaLabel = (t: TFunction, value: unknown): string =>
  accountingLabel(t, "accounting.operationalAreas", value);

/** `company_user` → `Company User`. */
export const actorTypeLabel = (t: TFunction, value: unknown): string =>
  accountingLabel(t, "accounting.actorTypes", value);

/** `single_user` → `Single User Allowed`. */
export const segregationPolicyLabel = (t: TFunction, value: unknown): string =>
  accountingLabel(t, "accounting.configuration.segregation", value);

/** `posted` → `Posted`; falls back to Title Case, never to "Unknown". */
export const statusLabel = (t: TFunction, value: unknown): string =>
  accountingLabel(t, "accounting.status", value);

/**
 * `1000` + `Main Cash` → `1000 — Main Cash`. Reports and Journals must never
 * show a bare account name or an account identifier.
 *
 * `nameAr` is preferred in Arabic; the Code always stays first and unchanged so
 * it remains LTR-readable inside an RTL page.
 */
export function accountLabel(
  code: unknown,
  nameEn: unknown,
  nameAr?: unknown,
  language = "en",
): string {
  const codeText = typeof code === "string" ? code.trim() : "";
  const arabic = typeof nameAr === "string" ? nameAr.trim() : "";
  const english = typeof nameEn === "string" ? nameEn.trim() : "";
  const name = language.startsWith("ar") && arabic !== "" ? arabic : english;
  if (codeText === "" && name === "") return "—";
  if (codeText === "") return name;
  if (name === "") return codeText;
  return `${codeText} — ${name}`;
}

/**
 * `EMP-000002` + `Shoala` → `EMP-000002 — Shoala`. The shared shape for every
 * subledger party: Employee, Driver, Trader, Expense, Collection, Settlement.
 * Identical formatting rules to `accountLabel`.
 */
export const partyLabel = (
  reference: unknown,
  nameEn: unknown,
  nameAr?: unknown,
  language = "en",
): string => accountLabel(reference, nameEn, nameAr, language);

/** `general_expense` → `General Expense`. */
export const subledgerTypeLabel = (t: TFunction, value: unknown): string =>
  accountingLabel(t, "accounting.subledgerTypes", value);

/** A resolved business label plus, when the user may follow it, a route. */
export interface BusinessReference {
  readonly label: string;
  readonly path?: string;
}

const text = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value.trim() : "";
};

/**
 * Resolves a Journal line's subledger to `Reference — Party` using the fields
 * the enriched lines query returns. Checks the specific subledger links before
 * the generic party columns, so a settlement line reads `SET-000012 — Trader`
 * rather than just the Trader.
 *
 * Returns `undefined` when the line carries no subledger, so callers render an
 * em dash rather than an identifier. The raw `subledgerId` is never used as a
 * display value — an unresolvable subledger degrades to its type label.
 */
export function subledgerReference(
  row: Record<string, unknown>,
  language = "en",
): BusinessReference | undefined {
  const pick = (
    reference: string,
    nameEn: string,
    nameAr: string,
    path?: string | undefined,
  ): BusinessReference | undefined => {
    const label = partyLabel(reference, nameEn, nameAr, language);
    if (label === "—") return undefined;
    return path === undefined ? { label } : { label, path };
  };

  const settlementId = text(row, "traderSettlementId");
  if (settlementId !== "")
    return pick(
      text(row, "settlementNumber"),
      text(row, "settlementTraderName"),
      text(row, "settlementTraderNameAr"),
      recordRoute("trader_settlement", settlementId),
    );

  const collectionId = text(row, "driverCollectionId");
  if (collectionId !== "")
    return pick(
      text(row, "collectionNumber"),
      text(row, "collectionDriverName"),
      text(row, "collectionDriverNameAr"),
      recordRoute("driver_collection", collectionId),
    );

  const expenseId = text(row, "generalExpenseId");
  if (expenseId !== "")
    return pick(
      text(row, "generalExpenseNumber"),
      text(row, "generalExpensePayee"),
      "",
      recordRoute("general_expense", expenseId),
    );

  const expensePaymentId = text(row, "generalExpensePaymentId");
  if (expensePaymentId !== "")
    return pick(
      text(row, "generalExpensePaymentNumber"),
      text(row, "generalExpensePayee"),
      "",
      recordRoute("expense_payment", expensePaymentId),
    );

  if (text(row, "payrollPaymentId") !== "")
    return pick(
      text(row, "payrollPaymentNumber"),
      text(row, "payrollPeriodReference"),
      "",
      recordRoute("payroll_payment", text(row, "payrollPaymentId")),
    );

  if (text(row, "payrollPeriodId") !== "")
    return pick(
      text(row, "payrollPeriodReference"),
      "",
      "",
      recordRoute("payroll_period", text(row, "payrollPeriodId")),
    );

  if (text(row, "outsourcedDriverFeePaymentId") !== "")
    return pick(
      text(row, "driverFeePaymentNumber"),
      text(row, "driverFeePaymentDriverName"),
      "",
      recordRoute("outsourced_driver_fee_payment", text(row, "outsourcedDriverFeePaymentId")),
    );

  if (text(row, "outsourcedDriverFeeAccrualId") !== "")
    return pick(
      text(row, "driverFeeAccrualReference"),
      text(row, "driverFeeAccrualDriverName"),
      "",
      recordRoute("outsourced_driver_fee_accrual", text(row, "outsourcedDriverFeeAccrualId")),
    );

  if (text(row, "traderCollectionNumber") !== "")
    return pick(
      text(row, "traderCollectionNumber"),
      text(row, "traderCollectionTraderName"),
      text(row, "traderCollectionTraderNameAr"),
      // The Trader Collection is joined on the line's own `subledger_id`, so
      // that is the identifier its detail route takes.
      recordRoute("trader_collection", text(row, "subledgerId")),
    );

  const traderId = text(row, "traderId");
  if (traderId !== "")
    return pick(
      text(row, "traderCode"),
      text(row, "traderName"),
      text(row, "traderNameAr"),
      recordRoute("trader", text(row, "traderCode")),
    );

  const driverId = text(row, "driverId");
  if (driverId !== "")
    return pick(
      text(row, "driverCode"),
      text(row, "driverName"),
      text(row, "driverNameAr"),
      recordRoute("driver", text(row, "driverCode")),
    );

  const employeeId = text(row, "employeeId");
  if (employeeId !== "")
    return pick(
      text(row, "employeeNumber"),
      text(row, "employeeName"),
      text(row, "employeeNameAr"),
      recordRoute("employee", text(row, "employeeNumber")),
    );

  const orderId = text(row, "orderId");
  if (orderId !== "")
    return pick(
      text(row, "orderNumber"),
      "",
      "",
      recordRoute("order", text(row, "orderNumber")),
    );

  return undefined;
}
