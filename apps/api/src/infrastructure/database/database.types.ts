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
  preferred_theme: "light" | "dark" | "system";
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
  profile_link_id: string | null;
  profile_type: "employee" | "driver" | "trader" | null;
  profile_id: string | null;
}

interface PasswordResetTokenTable {
  id: Generated<string>;
  company_id: string | null;
  account_id: string;
  token_hash: string;
  expires_at: TimestampColumn;
  used_at: TimestampColumn | null;
  revoked_at: TimestampColumn | null;
  requested_ip_hash: string | null;
  requested_user_agent: string | null;
  created_at: Generated<TimestampColumn>;
  created_by_source: Generated<"self_service" | "administrator">;
  version: Generated<number>;
}

interface UserBusinessLinkTable {
  id: Generated<string>;
  company_id: string;
  account_id: string;
  entity_type: "employee" | "driver" | "trader";
  entity_id: string;
  access_status: Generated<"invited" | "active" | "suspended" | "revoked">;
  is_primary: Generated<boolean>;
  created_by_account_id: string;
  created_at: Generated<TimestampColumn>;
  updated_by_account_id: string | null;
  updated_at: Generated<TimestampColumn>;
  suspended_by_account_id: string | null;
  suspended_at: TimestampColumn | null;
  suspension_reason: string | null;
  revoked_by_account_id: string | null;
  revoked_at: TimestampColumn | null;
  revocation_reason: string | null;
  version: Generated<number>;
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
  account_mappings: UntypedTable;
  accounting_configuration_history: UntypedTable;
  accounting_configurations: UntypedTable;
  accounting_event_components: UntypedTable;
  accounting_events: UntypedTable;
  accounting_periods: UntypedTable;
  accounting_zero_opening_confirmations: UntypedTable;
  accounts: AccountTable;
  allowance_types: UntypedTable;
  areas: UntypedTable;
  audit_events: UntypedTable;
  chart_of_accounts: UntypedTable;
  companies: UntypedTable;
  company_bank_accounts: UntypedTable;
  company_cash_accounts: UntypedTable;
  company_reference_counters: UntypedTable;
  company_settings: UntypedTable;
  company_users: CompanyUserTable;
  communication_notification_outbox: UntypedTable;
  conversation_participants: UntypedTable;
  conversations: UntypedTable;
  customer_addresses: UntypedTable;
  customers: UntypedTable;
  customer_messaging_sessions: UntypedTable;
  device_registrations: UntypedTable;
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
  fiscal_years: UntypedTable;
  general_expense_attachments: UntypedTable;
  general_expense_categories: UntypedTable;
  general_expense_lines: UntypedTable;
  general_expense_payment_rows: UntypedTable;
  general_expense_payments: UntypedTable;
  general_expenses: UntypedTable;
  cash_bank_movements: UntypedTable;
  cash_bank_movement_attachments: UntypedTable;
  hr_document_attachments: UntypedTable;
  hr_documents: UntypedTable;
  idempotency_records: UntypedTable;
  import_batches: UntypedTable;
  import_errors: UntypedTable;
  international_shipments: UntypedTable;
  journal_entries: UntypedTable;
  journal_lines: UntypedTable;
  operating_expenses: UntypedTable;
  opening_balance_batches: UntypedTable;
  opening_balance_lines: UntypedTable;
  order_assignments: UntypedTable;
  order_attachments: UntypedTable;
  order_expenses: UntypedTable;
  order_events: UntypedTable;
  order_items: UntypedTable;
  order_status_history: UntypedTable;
  orders: UntypedTable;
  outsourced_driver_payments: UntypedTable;
  outsourced_driver_fee_accruals: UntypedTable;
  outsourced_driver_fee_payment_allocations: UntypedTable;
  outsourced_driver_fee_payments: UntypedTable;
  outsourced_driver_fee_versions: UntypedTable;
  payroll_adjustments: UntypedTable;
  payroll_calculation_exceptions: UntypedTable;
  payroll_commission_links: UntypedTable;
  payroll_entries: UntypedTable;
  payroll_line_allowances: UntypedTable;
  payroll_payment_allocations: UntypedTable;
  payroll_payments: UntypedTable;
  payroll_periods: UntypedTable;
  platform_demo_request_history: UntypedTable;
  platform_demo_request_notes: UntypedTable;
  platform_demo_requests: UntypedTable;
  platform_trader_application_channels: UntypedTable;
  platform_trader_application_history: UntypedTable;
  platform_trader_application_notes: UntypedTable;
  platform_trader_applications: UntypedTable;
  platform_customer_marketplace_settings: UntypedTable;
  company_customer_quote_participation: UntypedTable;
  company_customer_quote_pricing_profiles: UntypedTable;
  company_customer_quote_pricing_rules: UntypedTable;
  platform_customer_quote_requests: UntypedTable;
  platform_customer_quote_offers: UntypedTable;
  platform_customer_quote_history: UntypedTable;
  platform_customer_quote_notes: UntypedTable;
  platform_blog_categories: UntypedTable;
  platform_blog_authors: UntypedTable;
  platform_blog_tags: UntypedTable;
  platform_blog_articles: UntypedTable;
  platform_blog_article_tags: UntypedTable;
  platform_blog_publication_history: UntypedTable;
  platform_public_redirects: UntypedTable;
  platform_public_site_settings: UntypedTable;
  platform_website_pages: UntypedTable;
  platform_website_pricing_plans: UntypedTable;
  platform_website_features: UntypedTable;
  platform_website_faqs: UntypedTable;
  platform_website_media: UntypedTable;
  platform_website_navigation_items: UntypedTable;
  platform_website_contact_settings: UntypedTable;
  platform_website_revisions: UntypedTable;
  permissions: UntypedTable;
  messages: UntypedTable;
  notification_outbox_events: UntypedTable;
  password_reset_tokens: PasswordResetTokenTable;
  realtime_event_log: UntypedTable;
  user_business_links: UserBusinessLinkTable;
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
