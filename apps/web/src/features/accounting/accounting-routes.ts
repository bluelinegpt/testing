/**
 * Verified route map for Related Records.
 *
 * Every entry here was confirmed against the live route tables in
 * `CompanyWorkspace.tsx` (operational) and `AccountingWorkspace.tsx`
 * (`parseAccountingRoute`). Nothing is inferred — a link that cannot be proven
 * to resolve is deliberately absent, so the UI disables it rather than
 * navigating to a blank screen.
 *
 * Two contract details that are easy to get wrong and were both verified:
 *
 *  - Order detail routes by ORDER NUMBER (`/orders/:orderNumber`), not by id.
 *  - Trader, Driver and Employee detail route by CODE under
 *    `/configuration/...`, not by id, and not under `/traders` or `/drivers`
 *    (those are exact-match list routes).
 */

/** Record types the application can actually open on a detail screen. */
export type RoutableRecord =
  | "accounting_event"
  | "bank_account"
  | "cash_account"
  | "cash_bank_movement"
  | "driver"
  | "driver_collection"
  | "employee"
  | "expense_payment"
  | "general_expense"
  | "journal"
  | "opening_balance"
  | "order"
  | "outsourced_driver_fee_accrual"
  | "outsourced_driver_fee_payment"
  | "payroll_payment"
  | "payroll_period"
  | "trader"
  | "trader_collection"
  | "trader_receivable"
  | "trader_settlement";

/**
 * Record types that exist as data and carry a business reference, but have NO
 * detail route in the current application.
 *
 * Phase 3B emptied this list: Driver Collection, Trader Settlement, Trader
 * Receivable, Trader Collection, Payroll Period, Payroll Payment and both
 * Outsourced Driver Fee records now have canonical detail routes. The list and
 * the `reference()` fallback that reads it are kept deliberately — a future
 * record type without a detail screen belongs here rather than getting an
 * invented URL.
 */
export const unroutableRecordTypes = [] as const;

export type UnroutableRecord = (typeof unroutableRecordTypes)[number];

/** The list screen each routable record type belongs to, for Back navigation. */
const listRoutes: Readonly<Record<string, string>> = {
  driver_collection: "/drivers",
  outsourced_driver_fee_accrual: "/payroll",
  outsourced_driver_fee_payment: "/payroll",
  payroll_payment: "/payroll",
  payroll_period: "/payroll",
  trader_collection: "/trader-receivables",
  trader_receivable: "/trader-receivables",
  trader_settlement: "/trader-settlements",
};

/**
 * Builds the detail route for a routable record.
 *
 * `identifier` is the value the route actually consumes: an id for Accounting
 * sections, an Order Number for Orders, a Code for Trader/Driver/Employee.
 * Returns `undefined` when the identifier is missing, so the caller disables
 * the link instead of navigating to a malformed URL.
 */
export function recordRoute(
  type: RoutableRecord,
  identifier: string | null | undefined,
): string | undefined {
  const value = typeof identifier === "string" ? identifier.trim() : "";
  if (value === "") return undefined;
  const encoded = encodeURIComponent(value);
  switch (type) {
    case "journal":
      return `/accounting/journals/${encoded}`;
    case "accounting_event":
      return `/accounting/events/${encoded}`;
    case "general_expense":
      return `/accounting/expenses/${encoded}`;
    case "expense_payment":
      return `/accounting/expense-payments/${encoded}`;
    case "opening_balance":
      return `/accounting/opening-balances/${encoded}`;
    case "cash_account":
      return `/accounting/cash-accounts/${encoded}`;
    case "bank_account":
      return `/accounting/bank-accounts/${encoded}`;
    case "cash_bank_movement":
      return `/accounting/cash-bank-movements/${encoded}`;
    // Phase 3B canonical operational detail routes. Each takes the record's
    // internal identifier because every corresponding backend detail endpoint
    // is keyed by it and no by-reference lookup exists; the page itself always
    // shows the business reference. See ACCOUNTING_RELATED_RECORDS.md §3.
    case "driver_collection":
      return `/drivers/collections/${encoded}`;
    case "trader_settlement":
      return `/trader-settlements/${encoded}`;
    case "trader_receivable":
      return `/trader-receivables/${encoded}`;
    case "trader_collection":
      return `/trader-receivables/collections/${encoded}`;
    case "payroll_period":
      return `/payroll/periods/${encoded}`;
    case "payroll_payment":
      return `/payroll/payments/${encoded}`;
    case "outsourced_driver_fee_accrual":
      return `/payroll/driver-fees/accruals/${encoded}`;
    case "outsourced_driver_fee_payment":
      return `/payroll/driver-fees/payments/${encoded}`;
    // Routes by Order NUMBER, not id.
    case "order":
      return `/orders/${encoded}`;
    // Route by CODE under /configuration, not by id.
    case "trader":
      return `/configuration/traders/${encoded}`;
    case "driver":
      return `/configuration/drivers/${encoded}`;
    case "employee":
      return `/configuration/employees/${encoded}`;
    default:
      return undefined;
  }
}

/**
 * Detail route for a SOURCE ENTITY as the Accounting tables record it —
 * `journal_entries.source_entity_type` / `accounting_events.source_entity_type`
 * vocabulary. One centralized resolver so report drill-down, related panels
 * and future callers cannot each grow their own mapping.
 *
 * Orders route by ORDER NUMBER (their route consumes the reference, not the
 * id); everything else routes by id. A type outside this map returns
 * undefined and the caller renders plain text — no route is ever guessed.
 */
export function sourceRecordRoute(
  sourceEntityType: string,
  id: string | null | undefined,
  reference?: string | null,
): string | undefined {
  switch (sourceEntityType) {
    case "order":
      return recordRoute("order", reference ?? null);
    case "driver_reconciliation":
      return recordRoute("driver_collection", id);
    case "general_expense":
      return recordRoute("general_expense", id);
    case "general_expense_payment":
      return recordRoute("expense_payment", id);
    case "cash_bank_movement":
      return recordRoute("cash_bank_movement", id);
    case "outsourced_driver_fee_accrual":
      return recordRoute("outsourced_driver_fee_accrual", id);
    case "outsourced_driver_fee_payment":
      return recordRoute("outsourced_driver_fee_payment", id);
    case "payroll_payment":
      return recordRoute("payroll_payment", id);
    case "payroll_period":
      return recordRoute("payroll_period", id);
    case "trader_receivable":
      return recordRoute("trader_receivable", id);
    case "trader_collection":
      return recordRoute("trader_collection", id);
    case "trader_settlement":
      return recordRoute("trader_settlement", id);
    default:
      return undefined;
  }
}

/** The list screen a record type belongs to, for Back navigation. */
export const recordListRoute = (type: string): string | undefined => listRoutes[type];

/** Whether a record type can be opened on its own detail screen. */
export const isRoutable = (type: string): type is RoutableRecord =>
  !(unroutableRecordTypes as readonly string[]).includes(type);
