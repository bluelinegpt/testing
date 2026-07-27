import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Pool, type PoolClient } from "pg";

import { configuration } from "../../configuration/environment.js";

const expectedTables = [
  "account_roles",
  "account_sessions",
  "accounting_periods",
  "accounts",
  "allowance_types",
  "areas",
  "audit_events",
  "chart_of_accounts",
  "companies",
  "company_bank_accounts",
  "company_reference_counters",
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
  "hr_document_attachments",
  "hr_documents",
  "idempotency_records",
  "import_batches",
  "import_errors",
  "international_shipments",
  "journal_entries",
  "journal_lines",
  "operating_expenses",
  "order_assignments",
  "order_attachments",
  "order_expenses",
  "order_events",
  "order_items",
  "order_status_history",
  "orders",
  "outsourced_driver_payments",
  "payroll_commission_links",
  "payroll_entries",
  "payroll_periods",
  "permissions",
  "password_reset_tokens",
  "role_permissions",
  "roles",
  "saas_usage_events",
  "support_cases",
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
] as const;

const expectedTriggers = [
  "account_roles_scope_guard",
  "account_sessions_scope_guard",
  "audit_events_actor_scope_guard",
  "company_users_account_kind_guard",
  "driver_reconciliation_expenses_description_guard",
  "driver_reconciliation_expenses_immutable",
  "driver_reconciliation_expenses_reference_normalize",
  "expense_types_name_guard",
  "driver_reconciliation_orders_driver_guard",
  "driver_reconciliation_orders_immutable",
  "driver_reconciliation_orders_single_active_link",
  "driver_reconciliation_payments_immutable",
  "driver_reconciliation_payments_reference_normalize",
  "driver_reconciliations_confirmation_guard",
  "driver_reconciliations_reference_immutable",
  "drivers_account_kind_guard",
  "driver_commission_calculations_immutable",
  "driver_commission_rules_no_overlap",
  "employee_allowances_max_four",
  "employee_salary_versions_no_overlap",
  "international_shipments_order_guard",
  "password_reset_tokens_scope_guard",
  "order_assignments_current_driver_consistency",
  "order_assignments_history_guard",
  "order_assignments_initial_guard",
  "orders_assignment_consistency",
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
] as const;

const expectedFunctions = [
  "is_valid_order_status_value",
  "enforce_employee_allowance_limit",
  "prevent_commission_rule_overlap",
  "prevent_salary_version_overlap",
  "protect_order_assignment_history",
  "reject_final_order_assignment_change",
  "reject_order_status_history_mutation",
  "reject_order_event_mutation",
  "reject_final_commission_mutation",
  "validate_driver_reconciliation_confirmation",
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
  "normalize_account_login_identifiers",
  "sync_account_login_identifiers_to_company_user",
  "enforce_single_active_reconciliation_link",
] as const;

const expectedConstraints = [
  "driver_reconciliation_expenses_actor_fk",
  "driver_reconciliation_expenses_reference_nonempty",
  "driver_reconciliation_payments_reference_nonempty",
  "driver_reconciliation_payments_creator_fk",
  "expense_types_display_name_nonempty",
  "expense_types_code_format",
  "order_status_history_status_values_check",
  "trader_settlement_payments_creator_fk",
  "orders_prospective_financial_model_check",
] as const;

const expectedIndexes = [
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
  "orders_serial_number_normalized_unique",
  "orders_reference_number_normalized_unique",
  "accounts_company_normalized_username_unique",
  "accounts_platform_normalized_username_unique",
  "accounts_company_normalized_email_unique",
  "accounts_company_normalized_mobile_unique",
] as const;

const expectedColumns = [
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
  "company_users.display_name",
  "roles.description",
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

  const periodId = randomUUID();
  const debitAccountId = randomUUID();
  const creditAccountId = randomUUID();
  const journalId = randomUUID();
  await client.query(
    `insert into accounting_periods (id, company_id, period_start, period_end)
     values ($1, $2, current_date - 1, current_date + 1)`,
    [periodId, companyA],
  );
  await client.query(
    `insert into chart_of_accounts (id, company_id, code, name_en, account_type)
     values ($1, $2, 'VERIFY-CASH', 'Verification Cash', 'asset'),
            ($3, $2, 'VERIFY-REV', 'Verification Revenue', 'revenue')`,
    [debitAccountId, companyA, creditAccountId],
  );
  await client.query(
    `insert into journal_entries
       (id, company_id, journal_number, accounting_period_id, business_date, source_type,
        description, created_by_account_id)
     values ($1, $2, 'VERIFY-JOURNAL', $3, current_date, 'manual',
             'Synthetic schema verification', $4)`,
    [journalId, companyA, periodId, accountA],
  );
  await client.query(
    `insert into journal_lines (company_id, journal_entry_id, account_id, debit, credit)
     values ($1, $2, $3, 10.00, 0), ($1, $2, $4, 0, 9.00)`,
    [companyA, journalId, debitAccountId, creditAccountId],
  );
  await expectDatabaseRejection(client, "unbalanced_journal", () =>
    client.query(
      `update journal_entries set status = 'posted', posted_by_account_id = $2, posted_at = now()
       where id = $1`,
      [journalId, accountA],
    ),
  );
  await client.query(
    "update journal_lines set credit = 10.00 where journal_entry_id = $1 and account_id = $2",
    [journalId, creditAccountId],
  );
  await client.query(
    `update journal_entries set status = 'posted', posted_by_account_id = $2, posted_at = now()
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
