export type MoneyString = string;
export type AccountingRecord = Readonly<Record<string, unknown>>;

export interface AccountingPage<T = AccountingRecord> {
  readonly items: readonly T[];
  readonly page?: number;
  readonly pageSize?: number;
  readonly total?: number | string;
}

export interface AccountingLoadState<T> {
  readonly data?: T;
  readonly error?: string;
  readonly loading: boolean;
  readonly refreshedAt?: string;
}

export type AccountingSection =
  | "overview"
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
  | "reports";

export interface AccountingRoute {
  readonly id?: string;
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

export interface FieldDefinition {
  readonly name: string;
  readonly required?: boolean;
  readonly type?: "checkbox" | "date" | "money" | "number" | "select" | "text" | "textarea";
  readonly options?: readonly { readonly label: string; readonly value: string }[];
}

export interface LifecycleAction {
  readonly action: string;
  readonly permission: keyof AccountingPermissionSet;
  readonly reason?: boolean;
  readonly reversalDate?: boolean;
}
