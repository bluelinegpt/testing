import type { ColumnType, Generated } from "kysely";

type UntypedTable = Record<string, unknown>;
type MoneyColumn = ColumnType<string, string | number, string | number>;
type TimestampColumn = ColumnType<Date, Date | string, Date | string>;

interface AccountTable {
  id: Generated<string>;
  company_id: string | null;
  account_kind: string;
  username: string;
  normalized_username: Generated<string>;
  email: string | null;
  normalized_email: Generated<string | null>;
  mobile_number: string | null;
  normalized_mobile_number: Generated<string | null>;
  password_hash: string;
  status: string;
  preferred_language: "en" | "ar";
  failed_login_attempts: number;
  locked_until: TimestampColumn | null;
  force_password_change: Generated<boolean>;
  temporary_password_expires_at: TimestampColumn | null;
  last_failed_login_at: TimestampColumn | null;
  password_changed_at: TimestampColumn | null;
  last_login_at: TimestampColumn | null;
  administrative_lock_reason: string | null;
  administrative_locked_at: TimestampColumn | null;
  administrative_locked_by_account_id: string | null;
  created_at: Generated<TimestampColumn>;
  updated_at: Generated<TimestampColumn>;
  version: Generated<number>;
}

interface CompanyUserTable {
  id: Generated<string>;
  company_id: string;
  account_id: string;
  display_name: string;
  name_en: string;
  name_ar: string | null;
  email: string | null;
  mobile_number: string | null;
  notes: string | null;
  is_active: Generated<boolean>;
  created_at: Generated<TimestampColumn>;
  updated_at: Generated<TimestampColumn>;
  deactivated_at: TimestampColumn | null;
  version: Generated<number>;
}

interface RoleTable {
  id: Generated<string>;
  company_id: string | null;
  code: string;
  name: string;
  description: string | null;
  is_system: Generated<boolean>;
  is_active: Generated<boolean>;
  created_at: Generated<TimestampColumn>;
  updated_at: Generated<TimestampColumn>;
  version: Generated<number>;
}

interface AccountSessionTable {
  id: Generated<string>;
  company_id: string | null;
  account_id: string;
  token_hash: string;
  expires_at: TimestampColumn;
  revoked_at: TimestampColumn | null;
  last_seen_at: TimestampColumn | null;
  created_ip: string | null;
  user_agent: string | null;
  created_at: Generated<TimestampColumn>;
}

interface DriverReconciliationPaymentTable {
  amount: MoneyColumn;
  bank_reference: string | null;
  company_bank_account_id: string | null;
  company_id: string;
  created_at: Generated<TimestampColumn>;
  created_by_account_id: string | null;
  id: Generated<string>;
  payment_at: TimestampColumn;
  payment_method: "bank_transfer" | "cash";
  reconciliation_id: string;
}

interface TraderSettlementPaymentTable {
  amount: MoneyColumn;
  bank_reference: string | null;
  company_bank_account_id: string | null;
  company_id: string;
  created_at: Generated<TimestampColumn>;
  created_by_account_id: string | null;
  id: Generated<string>;
  payment_at: TimestampColumn;
  payment_method: "bank_transfer" | "cash";
  settlement_id: string;
  trader_bank_account_id: string | null;
  trader_bank_account_snapshot: unknown | null;
}

// Exact row contracts are added with each domain repository; this inventory prevents the
// runtime schema from being represented as empty while those modules are still pending.
export interface DatabaseSchema {
  account_roles: UntypedTable;
  account_sessions: AccountSessionTable;
  accounting_periods: UntypedTable;
  accounts: AccountTable;
  allowance_types: UntypedTable;
  areas: UntypedTable;
  audit_events: UntypedTable;
  chart_of_accounts: UntypedTable;
  companies: UntypedTable;
  company_bank_accounts: UntypedTable;
  company_reference_counters: UntypedTable;
  company_settings: UntypedTable;
  company_users: CompanyUserTable;
  customer_addresses: UntypedTable;
  customers: UntypedTable;
  driver_commission_calculations: UntypedTable;
  driver_commission_orders: UntypedTable;
  driver_commission_rules: UntypedTable;
  driver_documents: UntypedTable;
  driver_reconciliation_expenses: UntypedTable;
  driver_reconciliation_orders: UntypedTable;
  driver_reconciliation_payments: DriverReconciliationPaymentTable;
  driver_reconciliations: UntypedTable;
  drivers: UntypedTable;
  employee_allowances: UntypedTable;
  employee_salary_versions: UntypedTable;
  employee_roles: UntypedTable;
  employees: UntypedTable;
  expense_types: UntypedTable;
  file_objects: UntypedTable;
  hr_document_attachments: UntypedTable;
  hr_documents: UntypedTable;
  idempotency_records: UntypedTable;
  import_batches: UntypedTable;
  import_errors: UntypedTable;
  international_shipments: UntypedTable;
  journal_entries: UntypedTable;
  journal_lines: UntypedTable;
  operating_expenses: UntypedTable;
  order_assignments: UntypedTable;
  order_attachments: UntypedTable;
  order_expenses: UntypedTable;
  order_events: UntypedTable;
  order_items: UntypedTable;
  order_status_history: UntypedTable;
  orders: UntypedTable;
  outsourced_driver_payments: UntypedTable;
  payroll_commission_links: UntypedTable;
  payroll_entries: UntypedTable;
  payroll_periods: UntypedTable;
  permissions: UntypedTable;
  password_reset_tokens: UntypedTable;
  role_permissions: UntypedTable;
  roles: RoleTable;
  saas_usage_events: UntypedTable;
  support_cases: UntypedTable;
  third_party_delivery_companies: UntypedTable;
  tracking_access_events: UntypedTable;
  tracking_tokens: UntypedTable;
  trader_bank_accounts: UntypedTable;
  trader_service_prices: UntypedTable;
  trader_settlement_orders: UntypedTable;
  trader_settlement_payments: TraderSettlementPaymentTable;
  trader_settlements: UntypedTable;
  traders: UntypedTable;
  vehicles: UntypedTable;
}
