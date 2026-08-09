export type MoneyString = string;
export type AccountingRecord = Readonly<Record<string, unknown>>;

export interface AccountingPage<T = AccountingRecord> {
  readonly items: readonly T[];
  readonly page?: number;
  readonly pageSize?: number;
  readonly total?: number | string;
}

export interface AccountingLoadState<T> {
  readonly data?: T | undefined;
  readonly error?: string | undefined;
  readonly loading: boolean;
  readonly refreshedAt?: string | undefined;
}

export type AccountingSection =
  | "overview"
  // A separate screen from Overview, not a replacement for it.
  | "dashboard"
  | "setup"
  | "configuration"
  | "mappings"
  | "chart-of-accounts"
  | "fiscal-years"
  | "fiscal-periods"
  | "journals"
  | "opening-balances"
  | "events"
  | "expense-categories"
  | "expenses"
  | "expense-payments"
  | "cash-accounts"
  | "bank-accounts"
  | "cash-bank-movements"
  | "cashbook"
  | "bank-ledger"
  | "reconciliation"
  | "backfill-preview"
  | "automatic-posting"
  | "reports"
  | "daily-cash-activity"
  | "payment-position"
  | "closing-workflows"
  | "batch-operations"
  | "historical-recovery";

export interface AccountingRoute {
  readonly id?: string | undefined;
  readonly mode?: "detail" | "list" | "new";
  readonly section: AccountingSection;
}

export interface AccountingPermissionSet {
  readonly accounts: boolean;
  readonly approve: boolean;
  readonly configure: boolean;
  readonly manage: boolean;
  readonly periods: boolean;
  readonly post: boolean;
  readonly reverse: boolean;
  readonly view: boolean;
}

export interface AccountingSelectOption {
  readonly label: string;
  readonly searchText?: string | undefined;
  readonly value: string;
}

export interface FieldDefinition {
  readonly emptyText?: string;
  readonly helperText?: string;
  readonly hidden?: boolean;
  readonly label?: string;
  readonly name: string;
  readonly options?: readonly AccountingSelectOption[];
  readonly optionsError?: string | undefined;
  readonly optionsStatus?: "error" | "loading" | "ready";
  readonly placeholder?: string;
  readonly readOnly?: boolean;
  readonly required?: boolean | undefined;
  readonly section?: string | undefined;
  /**
   * An optional small control rendered beside a `select` field's own control
   * (e.g. "+ Add Category" next to the Category dropdown), so a missing option
   * can be created without leaving the form it belongs to. Deliberately just a
   * label/click pair rather than arbitrary children: this stays a thin,
   * reusable extension point, not a place to grow per-field custom UI.
   */
  readonly trailingAction?:
    | { readonly disabled?: boolean; readonly label: string; readonly onClick: () => void }
    | undefined;
  readonly type?:
    "account" | "checkbox" | "date" | "money" | "number" | "select" | "text" | "textarea";
}

export interface LifecycleAction {
  readonly action: string;
  readonly permission: keyof AccountingPermissionSet;
  readonly reason?: boolean;
  readonly reversalDate?: boolean;
}
