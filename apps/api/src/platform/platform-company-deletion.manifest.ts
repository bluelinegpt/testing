import { createHash } from "node:crypto";

import {
  CYCLE_BREAKS,
  GLOBAL_TABLES as RESET_GLOBAL_TABLES,
  PRESERVE_TABLES,
  PURGE_TABLES,
} from "./reset-company-test-data.manifest.js";

export const COMPANY_DELETION_MANIFEST_VERSION = "company-deletion-v2";

const PLATFORM_PRESERVE = [
  "platform_company_deletion_backups",
  "platform_company_deletion_cleanup_items",
  "platform_company_deletion_operations",
  "platform_company_deletion_previews",
] as const;

const SHARED_PRESERVE = [
  ...RESET_GLOBAL_TABLES,
  "storefront_marketplace_categories",
  "role_permissions",
] as const;

/** Tables added after the reset manifest's last business-data review. */
const NEW_DIRECT_TABLES = [
  "employee_collection_earning_rules",
  "employee_driver_collection_fact_orders",
  "employee_driver_collection_facts",
] as const;

// Prompt 15 (push notifications) added two new Company-scoped tables —
// `device_registrations` and `notification_outbox_events` — both already
// registered in `reset-company-test-data.manifest.ts`'s `PURGE_TABLES` (they
// hold nothing but this Company's own operational data: device push tokens
// and outbound notification records, with no cross-tenant significance), so
// they already flow into `COMPANY_DELETION_DIRECT_TABLES` correctly via the
// `...PURGE_TABLES` spread below with no further classification needed here.
// This comment IS the reviewed acknowledgment the pinned count in
// `platform-company-deletion.manifest.test.ts` exists to force — see that
// file's "pins the reviewed live Company-table inventory" test (bumped
// 127 -> 129 for these two additions).

export const COMPANY_DELETION_DIRECT_TABLES = new Set([
  ...PURGE_TABLES,
  ...[...PRESERVE_TABLES].filter(
    (table) => !SHARED_PRESERVE.includes(table as (typeof SHARED_PRESERVE)[number]),
  ),
  ...NEW_DIRECT_TABLES,
]);

export const COMPANY_DELETION_INDIRECT = [
  {
    table: "role_permissions",
    ownership: "role_permissions.role_id -> roles.id where roles.company_id = target",
  },
  {
    table: "storefront_marketplace_categories",
    ownership:
      "storefront_marketplace_categories.storefront_id -> trader_storefronts.id where trader_storefronts.company_id = target",
  },
] as const;

export const COMPANY_DELETION_GLOBAL_PRESERVE = new Set(SHARED_PRESERVE);
export const COMPANY_DELETION_PLATFORM_PRESERVE = new Set(PLATFORM_PRESERVE);
export const COMPANY_DELETION_CYCLE_BREAKS = CYCLE_BREAKS;

/**
 * Exact deletion guards reviewed from the live catalog on 2026-08-09. A new
 * delete trigger is an unsupported blocker until this list is reviewed again.
 */
export const COMPANY_DELETION_APPROVED_GUARDS = new Set([
  "account_mappings_history_guard",
  "account_roles_active_user_guard",
  "accounting_batch_jobs_protect_delete",
  "accounting_batch_transitions_no_change",
  "accounting_events_immutable",
  "accounting_periods_history_guard",
  "company_user_accounts_no_delete",
  "audit_events_immutable",
  "balance_override_audits_no_update",
  "cash_bank_movements_immutable",
  "chart_of_accounts_history_guard",
  "closing_workflow_transitions_no_change",
  "closing_workflows_protect_delete",
  "customer_addresses_no_delete",
  "customers_no_delete",
  "driver_commission_calculations_immutable",
  "driver_commission_orders_legacy_immutable",
  "driver_reconciliation_expenses_immutable",
  "driver_reconciliation_orders_immutable",
  "driver_reconciliation_payments_immutable",
  "driver_reconciliations_immutable",
  "employee_allowances_payroll_guard",
  "employee_salary_versions_payroll_guard",
  "fiscal_years_history_guard",
  "general_expense_lines_immutable",
  "general_expense_payment_rows_immutable",
  "general_expense_payments_immutable",
  "journal_entries_accounting_immutable",
  "journal_entries_accounting_state_guard",
  "journal_entries_balance_before_post",
  "journal_lines_immutable_when_posted",
  "journal_lines_totals_guard",
  "opening_balance_batches_immutable",
  "opening_balance_lines_immutable",
  "opening_balance_lines_totals_guard",
  "operating_expenses_immutable",
  "order_assignments_current_driver_consistency",
  "order_assignments_history_guard",
  "order_events_append_only",
  "order_expenses_immutable",
  "order_status_history_append_only",
  "orders_assignment_consistency",
  "outsourced_driver_fee_accruals_immutable",
  "outsourced_driver_fee_payment_allocations_immutable",
  "outsourced_driver_fee_payments_immutable",
  "outsourced_driver_fee_versions_immutable",
  "outsourced_driver_payments_legacy_immutable",
  "payroll_adjustments_immutable",
  "payroll_commission_links_immutable",
  "payroll_entries_foundation_guard",
  "payroll_line_allowances_immutable",
  "payroll_payment_allocations_immutable",
  "payroll_payments_immutable",
  "payroll_periods_foundation_guard",
  "role_permissions_nonempty_guard",
  "roles_no_delete",
  "trader_bank_accounts_delete_guard",
  "trader_service_prices_delete_guard",
  "trader_settlement_orders_immutable",
  "trader_settlement_payments_immutable",
  "trader_settlements_immutable",
  "trader_storefront_slugs_no_change",
]);

const hashInput = JSON.stringify({
  cycles: COMPANY_DELETION_CYCLE_BREAKS,
  direct: [...COMPANY_DELETION_DIRECT_TABLES].sort(),
  global: [...COMPANY_DELETION_GLOBAL_PRESERVE].sort(),
  guards: [...COMPANY_DELETION_APPROVED_GUARDS].sort(),
  indirect: COMPANY_DELETION_INDIRECT,
  platform: [...COMPANY_DELETION_PLATFORM_PRESERVE].sort(),
  version: COMPANY_DELETION_MANIFEST_VERSION,
});

export const COMPANY_DELETION_MANIFEST_HASH = createHash("sha256").update(hashInput).digest("hex");
