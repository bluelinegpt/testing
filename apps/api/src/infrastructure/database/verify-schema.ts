import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Pool, type PoolClient } from "pg";

import { accountingJournalSources } from "../../accounting/accounting.constants.js";
import { configuration } from "../../configuration/environment.js";

const expectedTables = [
  "account_roles",
  "account_sessions",
  "account_mappings",
  "accounting_configuration_history",
  "accounting_configurations",
  "accounting_event_components",
  "accounting_events",
  "accounting_periods",
  "accounting_zero_opening_confirmations",
  "accounts",
  "allowance_types",
  "areas",
  "audit_events",
  "chart_of_accounts",
  "companies",
  "company_bank_accounts",
  "company_cash_accounts",
  "company_reference_counters",
  "company_shipment_serial_counters",
  "company_settings",
  "company_users",
  "customer_addresses",
  "customers",
  "driver_commission_calculations",
  "driver_commission_orders",
  "driver_commission_rules",
  "driver_documents",
  "driver_reconciliation_expenses",
  "driver_reconciliation_orders",
  "driver_reconciliation_payments",
  "driver_reconciliations",
  "drivers",
  "employee_allowances",
  "employee_salary_versions",
  "employees",
  "expense_types",
  "file_objects",
  "fiscal_years",
  "general_expense_attachments",
  "general_expense_categories",
  "general_expense_lines",
  "general_expense_payment_rows",
  "general_expense_payments",
  "general_expenses",
  "cash_bank_movements",
  "cash_bank_movement_attachments",
  "hr_document_attachments",
  "hr_documents",
  "idempotency_records",
  "import_batches",
  "import_errors",
  "international_shipments",
  "journal_entries",
  "journal_lines",
  "operating_expenses",
  "opening_balance_batches",
  "opening_balance_lines",
  "order_assignments",
  "order_attachments",
  "order_expenses",
  "order_events",
  "order_items",
  "order_status_history",
  "orders",
  "outsourced_driver_payments",
  "outsourced_driver_fee_accruals",
  "outsourced_driver_fee_payment_allocations",
  "outsourced_driver_fee_payments",
  "outsourced_driver_fee_versions",
  "payroll_adjustments",
  "payroll_calculation_exceptions",
  "payroll_commission_links",
  "payroll_entries",
  "payroll_line_allowances",
  "payroll_payment_allocations",
  "payroll_payments",
  "payroll_periods",
  "permissions",
  "password_reset_tokens",
  "user_business_links",
  "role_permissions",
  "roles",
  "saas_usage_events",
  "support_cases",
  "shipment_prefix_reservations",
  "third_party_delivery_companies",
  "tracking_access_events",
  "tracking_tokens",
  "trader_bank_accounts",
  "trader_service_prices",
  "trader_settlement_orders",
  "trader_settlement_payments",
  "trader_settlements",
  "traders",
  "vehicles",
  "company_whatsapp_connections",
  "trader_whatsapp_settings",
  "whatsapp_message_outbox",
  "whatsapp_message_attempts",
  "company_whatsapp_platform_settings",
  "company_whatsapp_message_templates",
] as const;

const expectedTriggers = [
  "orders_psystem_serial_immutable",
  "companies_shipment_numbering_guard",
  "companies_shipment_prefix_reservation",
  "account_mappings_history_guard",
  "account_mappings_validation_guard",
  "account_mappings_general_expense_guard",
  "account_roles_scope_guard",
  "account_sessions_scope_guard",
  "accounting_configurations_history_writer",
  "accounting_configurations_validation_guard",
  "accounting_events_immutable",
  "driver_reconciliations_accounting_event_capture",
  "accounting_periods_calendar_guard",
  "accounting_periods_history_guard",
  "accounting_periods_overlap_guard",
  "audit_events_actor_scope_guard",
  "chart_of_accounts_history_guard",
  "chart_of_accounts_validation_guard",
  "company_users_account_kind_guard",
  "driver_reconciliation_expenses_description_guard",
  "driver_reconciliation_expenses_immutable",
  "driver_reconciliation_expenses_reference_normalize",
  "expense_types_name_guard",
  "fiscal_years_history_guard",
  "fiscal_years_overlap_guard",
  "general_expense_lines_immutable",
  "general_expense_payment_rows_immutable",
  "general_expense_payments_immutable",
  "cash_bank_movements_immutable",
  "company_cash_accounts_gl_guard",
  "company_bank_accounts_gl_guard",
  "driver_reconciliation_orders_driver_guard",
  "driver_reconciliation_orders_immutable",
  "driver_reconciliation_orders_single_active_link",
  "driver_reconciliation_payments_immutable",
  "driver_reconciliation_payments_reference_normalize",
  "driver_reconciliations_confirmation_guard",
  "driver_reconciliations_reference_immutable",
  "drivers_account_kind_guard",
  "driver_commission_calculations_immutable",
  "driver_commission_orders_legacy_immutable",
  "driver_commission_rules_no_overlap",
  "employee_allowances_max_four",
  "employee_allowances_no_overlap",
  "employee_allowances_payroll_guard",
  "employee_salary_versions_payroll_guard",
  "employee_salary_versions_no_overlap",
  "international_shipments_order_guard",
  "journal_entries_accounting_immutable",
  "journal_entries_accounting_state_guard",
  "journal_lines_account_snapshot",
  "journal_lines_totals_guard",
  "journal_lines_validation_guard",
  "orders_accounting_event_capture",
  "opening_balance_batches_immutable",
  "opening_balance_batches_validation_guard",
  "opening_balance_lines_immutable",
  "opening_balance_lines_account_snapshot",
  "opening_balance_lines_totals_guard",
  "opening_balance_lines_validation_guard",
  "password_reset_tokens_scope_guard",
  "user_business_links_entity_guard",
  "user_business_links_account_kind_guard",
  "account_sessions_profile_guard",
  "employee_business_access_suspend",
  "driver_business_access_suspend",
  "trader_business_access_suspend",
  "order_assignments_current_driver_consistency",
  "order_assignments_history_guard",
  "order_assignments_initial_guard",
  "orders_assignment_consistency",
  "outsourced_driver_fee_accruals_immutable",
  "outsourced_driver_fee_accruals_scope_guard",
  "outsourced_driver_fee_payment_allocations_immutable",
  "outsourced_driver_fee_payment_allocations_scope_guard",
  "outsourced_driver_fee_accruals_accounting_event_capture",
  "outsourced_driver_fee_payments_accounting_event_capture",
  "payroll_payments_accounting_event_capture",
  "payroll_periods_accounting_event_capture",
  "outsourced_driver_fee_payment_allocations_total_guard",
  "outsourced_driver_fee_payments_immutable",
  "outsourced_driver_fee_payments_scope_guard",
  "outsourced_driver_fee_payments_total_guard",
  "outsourced_driver_fee_versions_guard",
  "outsourced_driver_fee_versions_immutable",
  "outsourced_driver_payments_legacy_immutable",
  "payroll_entries_foundation_guard",
  "payroll_periods_foundation_guard",
  "payroll_adjustments_immutable",
  "payroll_adjustments_scope_guard",
  "payroll_line_allowances_immutable",
  "payroll_line_allowances_max_four",
  "payroll_commission_links_immutable",
  "payroll_payment_allocations_immutable",
  "payroll_payment_allocations_scope_guard",
  "payroll_payment_allocations_total_guard",
  "payroll_payments_immutable",
  "payroll_payments_total_guard",
  "orders_final_assignment_guard",
  "orders_manual_identifiers_immutable",
  "order_status_history_append_only",
  "order_events_append_only",
  "trader_settlement_orders_immutable",
  "trader_settlement_orders_trader_guard",
  "trader_settlement_payments_immutable",
  "trader_settlements_confirmation_guard",
  "traders_account_kind_guard",
  "traders_code_immutable",
  "traders_mobile_format_guard",
  "areas_code_immutable",
  "trader_service_prices_delete_guard",
  "trader_service_prices_area_emirate_guard",
  "trader_bank_accounts_delete_guard",
  "trader_settlement_payments_recipient_bank_guard",
  "customers_code_immutable",
  "customers_no_delete",
  "customer_addresses_no_delete",
  "customer_addresses_identity_immutable",
  "customer_addresses_default_guard",
  "orders_customer_scope_guard",
  "accounts_username_guard",
  "roles_code_immutable",
  "company_users_profile_guard",
  "employees_user_link_guard",
  "accounts_active_role_guard",
  "account_roles_active_user_guard",
  "roles_active_user_guard",
  "roles_permission_guard",
  "role_permissions_nonempty_guard",
  "company_user_accounts_no_delete",
  "roles_no_delete",
  "accounts_login_identifier_normalizer",
  "accounts_company_user_identifier_sync",
  "whatsapp_message_outbox_update_guard",
] as const;

const expectedFunctions = [
  "allocate_company_psystem_serial",
  "allocate_company_shipment_serial",
  "maintain_shipment_prefix_reservation",
  "protect_company_shipment_numbering",
  "protect_order_psystem_serial",
  "validate_user_business_link_entity",
  "validate_account_session_profile",
  "suspend_disabled_business_profile_access",
  "validate_general_expense_account_mapping",
  "prevent_accounting_date_overlap",
  "protect_account_mapping_history",
  "protect_accounting_account_history",
  "protect_accounting_calendar_history",
  "protect_accounting_event_history",
  "protect_accounting_journal_history",
  "protect_opening_balance_history",
  "record_accounting_configuration_history",
  "synchronize_accounting_journal_totals",
  "synchronize_opening_balance_totals",
  "snapshot_accounting_line_account",
  "validate_account_mapping",
  "validate_accounting_account",
  "validate_accounting_configuration",
  "validate_accounting_journal_line",
  "validate_accounting_journal_state",
  "validate_accounting_period_calendar",
  "validate_opening_balance_foundation",
  "is_valid_order_status_value",
  "enforce_employee_allowance_limit",
  "enforce_payroll_allowance_snapshot_limit",
  "prevent_employee_allowance_overlap",
  "prevent_commission_rule_overlap",
  "prevent_salary_version_overlap",
  "protect_outsourced_driver_fee_foundations",
  "protect_outsourced_driver_fee_payments",
  "protect_legacy_commission_history",
  "protect_payroll_foundation_records",
  "protect_payroll_commission_link_history",
  "protect_used_employee_allowance",
  "protect_used_salary_history",
  "protect_order_assignment_history",
  "reject_final_order_assignment_change",
  "reject_order_status_history_mutation",
  "reject_order_event_mutation",
  "reject_final_commission_mutation",
  "validate_driver_reconciliation_confirmation",
  "validate_outsourced_driver_fee_accrual",
  "validate_outsourced_driver_fee_allocation_scope",
  "validate_outsourced_driver_fee_payment_scope",
  "validate_outsourced_driver_fee_payment_total",
  "validate_outsourced_driver_fee_version",
  "validate_payroll_payment_allocation_scope",
  "validate_payroll_payment_total",
  "validate_payroll_adjustment_scope",
  "protect_driver_reconciliation_reference",
  "normalize_driver_reconciliation_reference",
  "normalize_expense_type_name",
  "validate_reconciliation_expense_description",
  "validate_order_assignment_consistency",
  "validate_trader_settlement_confirmation",
  "protect_customer_code",
  "reject_customer_delete",
  "protect_customer_address_identity",
  "validate_customer_default_address",
  "validate_order_customer_scope",
  "protect_administration_identifiers",
  "validate_company_user_profile",
  "validate_employee_user_link",
  "validate_active_account_roles",
  "validate_active_role_permissions",
  "reject_administration_delete",
  "protect_order_manual_identifiers",
  // These three are the TRIGGER names, not the function names. The functions
  // installed by 20260801120000_accounting_operational_integration are
  // `capture_trader_*_accounting_event`; verifying the trigger names in a
  // function list could only ever fail. Corrected to the real function names,
  // which the migration and the live schema agree on.
  "capture_trader_collection_accounting_event",
  "capture_trader_receivable_accounting_event",
  "capture_trader_settlement_accounting_event",
  "normalize_account_login_identifiers",
  "sync_account_login_identifiers_to_company_user",
  "enforce_single_active_reconciliation_link",
  "reject_whatsapp_outbox_unsafe_update",
] as const;

const expectedConstraints = [
  "companies_shipment_prefix_format_check",
  "companies_shipment_prefix_reservation_fk",
  "shipment_prefix_reservations_activation_order_check",
  "company_shipment_serial_counters_series_check",
  "company_shipment_serial_counters_value_check",
  "accounting_events_identity_unique",
  "accounting_events_attempts_check",
  "accounting_periods_code_unique",
  "accounting_periods_fiscal_year_fk",
  "accounting_periods_no_overlap",
  "accounting_periods_number_unique",
  "account_mappings_no_overlap",
  "chart_of_accounts_class_check",
  "chart_of_accounts_control_check",
  "fiscal_years_no_overlap",
  "driver_reconciliation_expenses_actor_fk",
  "driver_reconciliation_expenses_reference_nonempty",
  "driver_reconciliation_payments_reference_nonempty",
  "driver_reconciliation_payments_creator_fk",
  "expense_types_display_name_nonempty",
  "expense_types_code_format",
  "order_status_history_status_values_check",
  "trader_settlement_payments_creator_fk",
  "orders_prospective_financial_model_check",
  "employees_salary_hold_dates_check",
  "employees_salary_hold_shape_check",
  "payroll_entries_amounts_check",
  "payroll_entries_hold_snapshot_check",
  "payroll_periods_totals_check",
  "payroll_periods_reference_nonempty",
  "payroll_periods_reference_unique",
  "payroll_payments_method_check",
  "payroll_payments_period_fk",
  "payroll_payment_allocations_amount_positive",
  "payroll_calculation_exceptions_period_fk",
  "payroll_calculation_exceptions_resolution_check",
  "outsourced_driver_fee_accruals_amounts_check",
  "outsourced_driver_fee_payments_amount_positive",
  "outsourced_driver_fee_payments_method_source_check",
  "outsourced_driver_fee_payment_allocations_amount_positive",
  "journal_entries_approval_shape_check",
  "journal_entries_fiscal_year_fk",
  "journal_entries_accounting_event_fk",
  "journal_entries_posting_shape_check",
  "opening_balance_batches_period_fk",
  "opening_balance_lines_amount_check",
  "general_expense_categories_dates_check",
  "general_expense_categories_vat_check",
  "general_expenses_amounts_check",
  "general_expenses_lifecycle_shape_check",
  "general_expense_lines_values_check",
  "general_expense_payments_amount_check",
  "general_expense_payment_rows_destination_check",
  "general_expense_payment_rows_company_cash_account_fk",
  "general_expense_payment_rows_company_cash_shape_check",
  "general_expense_attachments_active_check",
  "journal_lines_general_expense_fk",
  "journal_lines_general_expense_payment_fk",
  "cash_bank_movements_structure_check",
  "cash_bank_movements_lifecycle_check",
  "account_sessions_profile_metadata_complete",
  "account_sessions_profile_type_check",
  "account_sessions_profile_link_company_fk",
  "user_business_links_account_company_fk",
  "user_business_links_creator_company_fk",
  "user_business_links_updater_company_fk",
  "user_business_links_suspender_company_fk",
  "user_business_links_revoker_company_fk",
  "user_business_links_entity_type_check",
  "user_business_links_access_status_check",
  "user_business_links_version_positive",
  "user_business_links_status_metadata",
  "password_reset_tokens_source_check",
  "password_reset_tokens_version_positive",
  "journal_lines_cash_bank_movement_fk",
  "whatsapp_message_outbox_message_type_check",
  "whatsapp_message_outbox_type_shape_check",
  "company_whatsapp_platform_settings_reason_shape_check",
  "company_whatsapp_message_templates_status_check",
  "company_whatsapp_message_templates_body_check",
] as const;

const expectedIndexes = [
  "companies_shipment_prefix_unique",
  "orders_psystem_serial_normalized_unique",
  "account_mappings_effective_index",
  "accounting_events_source_index",
  "accounting_events_failure_index",
  "accounting_events_retry_index",
  "accounting_events_type_status_index",
  "accounting_periods_company_dates_index",
  "chart_of_accounts_system_purpose_unique",
  "driver_reconciliation_expenses_parent_index",
  "driver_reconciliation_expenses_actor_index",
  "driver_reconciliation_orders_order_lookup_index",
  "driver_reconciliation_payments_bank_reference_unique",
  "driver_reconciliation_payments_parent_index",
  "expense_types_display_name_unique",
  "order_assignments_active_unique",
  "hr_documents_active_number_unique",
  "trader_settlement_payments_parent_index",
  "customers_code_unique",
  "customer_addresses_one_active_default",
  "orders_customer_index",
  "company_users_company_email_unique",
  "roles_company_name_unique",
  "employees_company_user_unique",
  "orders_daily_serial_number_unique",
  "orders_reference_number_normalized_unique",
  "employees_payroll_eligible_index",
  "employees_salary_hold_index",
  "general_expense_categories_code_unique",
  "general_expenses_source_unique",
  "general_expenses_status_index",
  "general_expenses_payment_status_index",
  "general_expense_lines_header_index",
  "general_expense_payments_header_index",
  "general_expense_payment_rows_payment_index",
  "general_expense_payment_rows_company_cash_account_index",
  "general_expense_attachments_active_unique",
  "company_cash_accounts_code_unique",
  "company_bank_accounts_code_unique",
  "cash_bank_movements_reversal_unique",
  "cash_bank_movements_status_index",
  "cash_bank_movement_attachments_active_unique",
  "employee_allowances_type_effective_index",
  "payroll_periods_active_month_unique",
  "payroll_adjustments_line_index",
  "payroll_calculation_exceptions_period_index",
  "payroll_payments_date_index",
  "payroll_payments_period_index",
  "payroll_payment_allocations_line_index",
  "outsourced_driver_fee_versions_effective_index",
  "outsourced_driver_fee_accruals_order_unique",
  "outsourced_driver_fee_accruals_driver_status_index",
  "fiscal_years_company_dates_index",
  "journal_entries_idempotency_unique",
  "journal_entries_accounting_event_unique",
  "journal_entries_source_entity_index",
  "opening_balance_lines_account_index",
  "outsourced_driver_fee_accruals_business_date_index",
  "outsourced_driver_fee_payments_active_reconciliation_unique",
  "outsourced_driver_fee_payments_driver_date_index",
  "outsourced_driver_fee_payment_allocations_accrual_index",
  "accounts_company_normalized_username_unique",
  "accounts_platform_normalized_username_unique",
  "accounts_company_normalized_email_unique",
  "accounts_company_normalized_mobile_unique",
  "user_business_links_active_exact_unique",
  "user_business_links_employee_active_unique",
  "user_business_links_driver_active_unique",
  "user_business_links_driver_account_active_unique",
  "user_business_links_trader_account_active_unique",
  "account_sessions_profile_active",
] as const;

const expectedColumns = [
  "companies.shipment_prefix",
  "companies.shipment_serial_enabled_at",
  "accounting_configurations.automatic_posting_enabled",
  "accounting_configurations.automatic_posting_areas",
  "accounting_configurations.manual_accounting_activation_date",
  "accounting_configurations.manual_accounting_enabled_at",
  "accounting_configurations.segregation_policy",
  "accounting_zero_opening_confirmations.effective_date",
  "accounting_zero_opening_confirmations.revoked_at",
  "accounting_events.operational_area",
  "accounting_events.attempt_count",
  "accounting_events.failure_category",
  "accounting_periods.fiscal_year_id",
  "accounting_periods.period_code",
  "accounting_periods.version",
  "chart_of_accounts.account_class",
  "chart_of_accounts.control_account_type",
  "chart_of_accounts.normal_balance",
  "expense_types.display_name",
  "driver_reconciliation_expenses.created_by_account_id",
  "driver_reconciliation_expenses.expense_reference",
  "driver_reconciliation_expenses.recorded_at",
  "driver_reconciliation_payments.created_by_account_id",
  "driver_reconciliation_payments.payment_at",
  "trader_settlement_payments.created_by_account_id",
  "trader_settlement_payments.payment_at",
  "orders.operational_completed_at",
  "orders.customer_id",
  "orders.customer_address_id",
  "orders.customer_code_snapshot",
  "orders.customer_area_code_snapshot",
  "orders.customer_area_name_snapshot",
  "orders.customer_provenance_status",
  "orders.serial_number",
  "orders.serial_number_normalized",
  "orders.psystem_serial",
  "orders.psystem_serial_normalized",
  "orders.reference_number",
  "orders.reference_number_normalized",
  "orders.financial_model_version",
  "orders.service_fee_net_amount",
  "orders.service_fee_vat_amount",
  "orders.additional_fees",
  "orders.additional_fee_vat_amount",
  "orders.total_deductions",
  "orders.vat_enabled_snapshot",
  "orders.vat_rate_snapshot",
  "orders.vat_price_mode_snapshot",
  "orders.customer_area_name_ar_snapshot",
  "orders.area_name_fallback_used",
  "accounts.force_password_change",
  "accounts.temporary_password_expires_at",
  "accounts.last_failed_login_at",
  "accounts.normalized_username",
  "accounts.email",
  "accounts.normalized_email",
  "accounts.mobile_number",
  "accounts.normalized_mobile_number",
  "account_sessions.profile_link_id",
  "account_sessions.profile_type",
  "account_sessions.profile_id",
  "user_business_links.entity_type",
  "user_business_links.entity_id",
  "user_business_links.access_status",
  "password_reset_tokens.revoked_at",
  "password_reset_tokens.requested_ip_hash",
  "password_reset_tokens.requested_user_agent",
  "password_reset_tokens.created_by_source",
  "password_reset_tokens.version",
  "company_users.display_name",
  "roles.description",
  "employees.payroll_eligible",
  "employees.salary_hold",
  "employees.salary_hold_reason",
  "employees.salary_hold_from",
  "employees.salary_hold_to",
  "allowance_types.name_ar",
  "employee_salary_versions.updated_by_account_id",
  "employee_salary_versions.updated_at",
  "employee_salary_versions.version",
  "employee_allowances.updated_by_account_id",
  "idempotency_records.response_body",
  "payroll_periods.payroll_month",
  "payroll_periods.period_reference",
  "payroll_periods.total_outstanding",
  "payroll_entries.employee_number_snapshot",
  "payroll_entries.salary_version_id",
  "payroll_entries.outstanding_amount",
  "payroll_entries.department_snapshot",
  "payroll_entries.salary_hold_reason_snapshot",
  "payroll_entries.salary_hold_from_snapshot",
  "payroll_entries.salary_hold_to_snapshot",
  "payroll_commission_links.source_marker",
  "payroll_payments.payroll_period_id",
  "payroll_payments.idempotency_key",
  "payroll_payment_allocations.reversed_at",
  "outsourced_driver_fee_accruals.accrual_business_date",
  "outsourced_driver_fee_accruals.recovery_amount",
  "outsourced_driver_fee_payments.linked_driver_reconciliation_id",
  "outsourced_driver_fee_payments.source_marker",
  "journal_entries.fiscal_year_id",
  "journal_entries.accounting_event_id",
  "journal_entries.total_debit",
  "journal_entries.total_credit",
  "journal_entries.version",
  "journal_lines.line_number",
  "journal_lines.account_code_snapshot",
  "journal_lines.trader_id",
  "journal_lines.general_expense_id",
  "journal_lines.general_expense_payment_id",
  "journal_lines.cash_bank_movement_id",
  "company_bank_accounts.bank_account_code",
  "company_bank_accounts.linked_gl_account_id",
  "company_cash_accounts.cash_account_code",
  "company_cash_accounts.linked_gl_account_id",
  "cash_bank_movements.movement_number",
  "cash_bank_movements.accounting_event_id",
  "general_expenses.expense_number",
  "general_expenses.outstanding_amount",
  "general_expense_lines.expense_cost_amount",
  "general_expense_payments.payment_number",
  "general_expense_payment_rows.payment_method",
  // The drawer a cash row was funded from, distinct from its GL account.
  "general_expense_payment_rows.company_cash_account_id",
  "fiscal_years.version",
  "opening_balance_batches.version",
  "opening_balance_lines.account_code_snapshot",
] as const;

const expectedPayrollPermissions = [
  "outsourced_driver_fees.manage",
  "outsourced_driver_fees.pay",
  "outsourced_driver_fees.reverse",
  "outsourced_driver_fees.view",
  "payroll.approve",
  "payroll.manage",
  "payroll.pay",
  "payroll.reverse",
  "payroll.view",
] as const;

const expectedAccountingPermissions = [
  "accounting.view",
  "accounting.manage",
  "accounting.approve",
  "accounting.post",
  "accounting.reverse",
  "accounting.periods.manage",
  "accounting.chart_of_accounts.manage",
  "accounting.configuration.manage",
] as const;

async function expectDatabaseRejection(
  client: PoolClient,
  label: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  const savepoint = `verify_${label.replaceAll(/[^a-z0-9]/g, "_")}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await operation();
    throw new Error(`${label} unexpectedly succeeded`);
  } catch (error) {
    await client.query(`rollback to savepoint ${savepoint}`);
    if (error instanceof Error && error.message.endsWith("unexpectedly succeeded")) {
      throw error;
    }
  } finally {
    await client.query(`release savepoint ${savepoint}`);
  }
}

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
const settings = configuration();
const pool = new Pool({
  application_name: "blueline-schema-verification",
  connectionTimeoutMillis: settings.database.connectionTimeoutMs,
  connectionString: settings.database.url,
  max: 1,
  query_timeout: settings.database.queryTimeoutMs,
});

const client = await pool.connect();
try {
  const tableResult = await client.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' order by tablename",
  );
  const actualTables = new Set(tableResult.rows.map((row) => row.tablename));
  const missingTables = expectedTables.filter((table) => !actualTables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`Missing expected tables: ${missingTables.join(", ")}`);
  }
  const triggerResult = await client.query<{ tgname: string }>(
    "select tgname from pg_trigger where not tgisinternal",
  );
  const actualTriggers = new Set(triggerResult.rows.map((row) => row.tgname));
  const missingTriggers = expectedTriggers.filter((trigger) => !actualTriggers.has(trigger));
  if (missingTriggers.length > 0) {
    throw new Error(`Missing expected triggers: ${missingTriggers.join(", ")}`);
  }
  const functionResult = await client.query<{ proname: string }>(
    `select proname from pg_proc
     where pronamespace = 'public'::regnamespace`,
  );
  const actualFunctions = new Set(functionResult.rows.map((row) => row.proname));
  const missingFunctions = expectedFunctions.filter((name) => !actualFunctions.has(name));
  if (missingFunctions.length > 0) {
    throw new Error(`Missing expected integrity functions: ${missingFunctions.join(", ")}`);
  }
  const constraintResult = await client.query<{ conname: string }>(
    `select conname from pg_constraint
     where connamespace = 'public'::regnamespace`,
  );
  const actualConstraints = new Set(constraintResult.rows.map((row) => row.conname));
  const missingConstraints = expectedConstraints.filter((name) => !actualConstraints.has(name));
  if (missingConstraints.length > 0) {
    throw new Error(`Missing expected integrity constraints: ${missingConstraints.join(", ")}`);
  }
  // Enum drift guard, read-only: a closed CHECK list that the application also
  // declares in code must permit every value the code can emit. Checking names
  // alone cannot catch this — `journal_entries_source_check` existed and passed
  // while silently rejecting `cash_bank_management`, so every Cash and Bank
  // Movement Journal failed on INSERT with 23514.
  const journalSourceCheck = await client.query<{ definition: string }>(
    `select pg_get_constraintdef(oid) as definition
       from pg_constraint
      where connamespace = 'public'::regnamespace
        and conname = 'journal_entries_source_check'`,
  );
  const journalSourceDefinition = journalSourceCheck.rows[0]?.definition ?? "";
  const unpermittedJournalSources = accountingJournalSources.filter(
    (source) => !journalSourceDefinition.includes(`'${source}'`),
  );
  if (unpermittedJournalSources.length > 0) {
    throw new Error(
      "journal_entries_source_check does not permit every declared Journal source: " +
        `${unpermittedJournalSources.join(", ")}`,
    );
  }
  const indexResult = await client.query<{ indexname: string }>(
    "select indexname from pg_indexes where schemaname = 'public'",
  );
  const actualIndexes = new Set(indexResult.rows.map((row) => row.indexname));
  const missingIndexes = expectedIndexes.filter((name) => !actualIndexes.has(name));
  if (missingIndexes.length > 0) {
    throw new Error(`Missing expected integrity indexes: ${missingIndexes.join(", ")}`);
  }
  const columnResult = await client.query<{ column_name: string; table_name: string }>(
    `select table_name, column_name from information_schema.columns
     where table_schema = 'public'`,
  );
  const actualColumns = new Set(
    columnResult.rows.map((row) => `${row.table_name}.${row.column_name}`),
  );
  const missingColumns = expectedColumns.filter((name) => !actualColumns.has(name));
  if (missingColumns.length > 0) {
    throw new Error(`Missing expected payment traceability columns: ${missingColumns.join(", ")}`);
  }
  const permissionResult = await client.query<{ code: string }>(
    `select code from permissions where code = any($1::text[])`,
    [[...expectedPayrollPermissions, ...expectedAccountingPermissions]],
  );
  const actualPayrollPermissions = new Set(permissionResult.rows.map((row) => row.code));
  const missingPayrollPermissions = expectedPayrollPermissions.filter(
    (code) => !actualPayrollPermissions.has(code),
  );
  if (missingPayrollPermissions.length > 0) {
    throw new Error(
      `Missing expected Payroll permissions: ${missingPayrollPermissions.join(", ")}`,
    );
  }
  const actualAccountingPermissions = new Set(permissionResult.rows.map((row) => row.code));
  const missingAccountingPermissions = expectedAccountingPermissions.filter(
    (code) => !actualAccountingPermissions.has(code),
  );
  if (missingAccountingPermissions.length > 0) {
    throw new Error(
      `Missing expected Accounting permissions: ${missingAccountingPermissions.join(", ")}`,
    );
  }

  await client.query("begin");
  const companyA = randomUUID();
  const companyB = randomUUID();
  const accountA = randomUUID();
  const accountB = randomUUID();

  await client.query(
    `insert into companies (id, code, subdomain, name_en)
     values ($1, 'VERIFY-A', $2, 'Verification Company A'),
            ($3, 'VERIFY-B', $4, 'Verification Company B')`,
    [companyA, `verify-a-${companyA.slice(0, 8)}`, companyB, `verify-b-${companyB.slice(0, 8)}`],
  );
  await client.query(
    `insert into accounts (id, company_id, account_kind, username, password_hash)
     values ($1, $2, 'company_user', 'verify-a', 'synthetic-verification-hash'),
            ($3, $4, 'company_user', 'verify-b', 'synthetic-verification-hash')`,
    [accountA, companyA, accountB, companyB],
  );

  await expectDatabaseRejection(client, "cross_company_user", () =>
    client.query(
      // display_name must be supplied so the rejection proves Company-scope
      // enforcement rather than merely a NOT NULL violation.
      `insert into company_users (company_id, account_id, name_en, display_name)
       values ($1, $2, 'Must Be Rejected', 'Must Be Rejected')`,
      [companyB, accountA],
    ),
  );

  const roleB = randomUUID();
  await client.query(
    "insert into roles (id, company_id, code, name) values ($1, $2, 'verify_role', 'Verify Role')",
    [roleB, companyB],
  );
  await expectDatabaseRejection(client, "null_scope_role_bypass", () =>
    client.query(
      "insert into account_roles (account_id, role_id, company_id) values ($1, $2, null)",
      [accountA, roleB],
    ),
  );

  await expectDatabaseRejection(client, "cross_company_audit_actor", () =>
    client.query(
      `insert into audit_events
         (company_id, actor_account_id, action, subject_type, correlation_id)
       values ($1, $2, 'schema.verify', 'verification', $3)`,
      [companyB, accountA, randomUUID()],
    ),
  );

  await expectDatabaseRejection(client, "cross_company_session", () =>
    client.query(
      `insert into account_sessions (company_id, account_id, token_hash, expires_at)
       values ($1, $2, $3, now() + interval '1 hour')`,
      [companyB, accountA, "a".repeat(64)],
    ),
  );

  await expectDatabaseRejection(client, "cross_company_password_reset", () =>
    client.query(
      `insert into password_reset_tokens (company_id, account_id, token_hash, expires_at)
       values ($1, $2, $3, now() + interval '15 minutes')`,
      [companyB, accountA, "b".repeat(64)],
    ),
  );

  const auditId = randomUUID();
  await client.query(
    `insert into audit_events (id, company_id, actor_account_id, action, subject_type, correlation_id)
     values ($1, $2, $3, 'schema.verify', 'verification', $4)`,
    [auditId, companyA, accountA, randomUUID()],
  );
  await expectDatabaseRejection(client, "audit_update", () =>
    client.query("update audit_events set action = 'schema.changed' where id = $1", [auditId]),
  );

  const fiscalYearId = randomUUID();
  const periodId = randomUUID();
  const debitAccountId = randomUUID();
  const creditAccountId = randomUUID();
  const journalId = randomUUID();
  await client.query(
    `insert into fiscal_years (
       id, company_id, fiscal_year_code, name, start_date, end_date, status
     ) values (
       $1, $2, 'VERIFY-FY', 'Verification Fiscal Year',
       current_date - 10, current_date + 10, 'open'
     )`,
    [fiscalYearId, companyA],
  );
  await client.query(
    `insert into accounting_periods (
       id, company_id, fiscal_year_id, period_number, period_code, name,
       period_start, period_end
     ) values (
       $1, $2, $3, 1, 'VERIFY-P01', 'Verification Period',
       current_date - 1, current_date + 1
     )`,
    [periodId, companyA, fiscalYearId],
  );
  await client.query(
    `insert into chart_of_accounts (
       id, company_id, code, name_en, account_type, account_class, normal_balance
     ) values (
       $1, $2, 'VERIFY-CASH', 'Verification Cash', 'asset', 'cash', 'debit'
     ), (
       $3, $2, 'VERIFY-REV', 'Verification Revenue',
       'revenue', 'delivery_revenue', 'credit'
     )`,
    [debitAccountId, companyA, creditAccountId],
  );
  await client.query(
    `insert into journal_entries
       (id, company_id, journal_number, accounting_period_id, business_date, source_type,
        description, created_by_account_id, fiscal_year_id, journal_type)
     values ($1, $2, 'VERIFY-JOURNAL', $3, current_date, 'manual',
             'Synthetic schema verification', $4, $5, 'manual')`,
    [journalId, companyA, periodId, accountA, fiscalYearId],
  );
  await client.query(
    `insert into journal_lines (
       company_id, journal_entry_id, line_number, account_id, debit, credit
     ) values ($1, $2, 1, $3, 10.00, 0), ($1, $2, 2, $4, 0, 9.00)`,
    [companyA, journalId, debitAccountId, creditAccountId],
  );
  await expectDatabaseRejection(client, "unbalanced_journal", () =>
    client.query(
      `update journal_entries set status = 'balanced'
       where id = $1`,
      [journalId],
    ),
  );
  await client.query(
    "update journal_lines set credit = 10.00 where journal_entry_id = $1 and account_id = $2",
    [journalId, creditAccountId],
  );
  await client.query("update journal_entries set status = 'balanced' where id = $1", [journalId]);
  await client.query(
    `update journal_entries
        set status = 'approved', approved_by_account_id = $2, approved_at = now()
      where id = $1`,
    [journalId, accountA],
  );
  await client.query(
    `update journal_entries
        set status = 'posted', posted_by_account_id = $2, posted_at = now()
      where id = $1`,
    [journalId, accountA],
  );
  await expectDatabaseRejection(client, "posted_journal_update", () =>
    client.query("update journal_entries set description = 'Must Be Rejected' where id = $1", [
      journalId,
    ]),
  );
  await expectDatabaseRejection(client, "posted_journal_line_update", () =>
    client.query("update journal_lines set debit = 11.00 where journal_entry_id = $1", [journalId]),
  );

  await client.query("rollback");
  process.stdout.write(
    `Schema verification passed: ${expectedTables.length} business tables, ${expectedTriggers.length} hardening triggers, ${expectedFunctions.length} integrity functions, operational history protection, assignment consistency, financial confirmation validation, payment traceability, Company/session isolation, append-only audit, and posted-record immutability.\n`,
  );
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
