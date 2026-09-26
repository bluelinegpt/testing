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
  // PSystem prefixes are permanent and must never be recycled.
  "shipment_prefix_reservations",
  "storefront_marketplace_categories",
  "role_permissions",
  // 2026-08-12 review: `commerce_customers` / `commerce_customer_addresses`
  // (new Storefront/Commerce tables). Neither carries a `company_id` column
  // -- confirmed against `information_schema.columns`, not inferred from the
  // name. `commerce_customers.account_id` references `accounts` (`on delete
  // restrict`); `commerce_customer_addresses.commerce_customer_id`
  // references `commerce_customers` (`on delete cascade`, a pure child of
  // its global parent, itself carrying no Company reference). No inbound FK
  // from any Company-owned table targets either. This is the customer-side
  // mirror of the already-preserved `trader_commerce_profiles`: one shopper
  // identity, reusable across the Storefronts of many Companies, not owned
  // by any single one — deleting a Company must never delete a shopper who
  // may still be a customer of another Company's Storefront. Only one
  // trigger exists on either table (`commerce_customers_account_scope_guard`,
  // `BEFORE INSERT OR UPDATE`) and it does not fire on DELETE, so no guard
  // allowlist entry is needed.
  "commerce_customers",
  "commerce_customer_addresses",
  // `store_order_number_counters` -- a single shared reference-number
  // sequence (`reference_type='store_order'`, one row), carrying no
  // `company_id` and no FK to `companies` or any Company-owned table at all
  // (confirmed against `pg_constraint`) -- the store-order equivalent of the
  // already-global numbering infrastructure, not per-Company data.
  "store_order_number_counters",
  // This table has no `company_id`, so it is intentionally excluded from
  // the generic direct-table loop. Completed reservations are owned through
  // `store_order_id -> store_orders`; the execution service deletes only
  // those belonging to the target Company's Store Orders. Pending rows have
  // no Store Order yet and remain global checkout coordination state.
  "store_order_idempotency_keys",
  // `store_orders` / `store_order_items` are NOT actually global -- see
  // `COMPANY_DELETION_INDIRECT` below for their real ownership and the
  // matching scoped delete in the execution service. They are listed here
  // for the same reason `role_permissions` and
  // `storefront_marketplace_categories` already are: this set doubles as
  // "the live-schema unknown-global-table scan may skip this table", not
  // only "this table's data survives" -- both of those existing entries are
  // actively deleted by their own explicit statement, not preserved, and
  // these two follow the identical, already-reviewed convention.
  "store_orders",
  "store_order_items",
  "commerce_integration_credentials",
  "company_customer_quote_pricing_rules",
  "platform_customer_marketplace_settings",
  "platform_customer_quote_requests",
  "platform_customer_quote_history",
  "platform_customer_quote_notes",
  "platform_trader_applications",
  "platform_trader_application_channels",
  "platform_trader_application_history",
  "platform_trader_application_notes",
  "platform_blog_categories",
  "platform_blog_authors",
  "platform_blog_tags",
  "platform_blog_articles",
  "platform_blog_article_tags",
  "platform_blog_publication_history",
  "platform_public_redirects",
  "platform_public_site_settings",
  "platform_agent_settings",
  "platform_agent_knowledge",
  "platform_agent_conversations",
  "platform_agent_conversation_comments",
  "platform_agent_conversation_status_history",
  "platform_agent_messages",
  "platform_agent_actions",
  "platform_agent_handoffs",
  "platform_agent_handoff_history",
  "platform_agent_whatsapp_webhooks",
  "platform_demo_requests",
  "platform_demo_request_history",
  "platform_demo_request_notes",
  "platform_website_pages",
  "platform_website_pricing_plans",
  "platform_website_features",
  "platform_website_faqs",
  "platform_website_media",
  "platform_website_navigation_items",
  "platform_website_contact_settings",
  "platform_website_revisions",
] as const;

/** Tables added after the reset manifest's last business-data review. */
const NEW_DIRECT_TABLES = [
  // The counter is Company-owned; only the prefix tombstone above survives.
  "company_shipment_serial_counters",
  "company_website_agent_conversations",
  "company_websites",
  "company_website_delivery_requests",
  "company_website_domains",
  "employee_collection_earning_rules",
  "employee_driver_collection_fact_orders",
  "employee_driver_collection_facts",
  // `20260816200000_driver_earnings_interim_payments` — Employee variable
  // earnings and salary advances paid before Payroll, each with an
  // allocation/junction child, plus Outsourced Driver collection earning
  // rules (reviewed 2026-08-12, see the block comment below).
  "employee_salary_advance_payroll_allocations",
  "employee_salary_advances",
  "employee_variable_earning_payment_allocations",
  "employee_variable_earning_payments",
  "outsourced_driver_collection_earning_rules",
  // 2026-08-12 review: `employee_driver_earning_periods` (a Driver-earning
  // calculation period for an Employee, direct `company_id restrict`) and
  // its pure allocation child `employee_driver_earning_period_delivery_
  // sources` (`period_id -> employee_driver_earning_periods`, also direct
  // `company_id`). Both carry a literal `company_id` column (confirmed
  // against `information_schema.columns`), so the generic per-table
  // deletion loop applies with no special handling, unlike `store_orders`
  // above. One non-DELETE trigger only
  // (`employee_driver_earning_period_immutable_guard`, `BEFORE UPDATE`), no
  // FK cycle.
  "employee_driver_earning_periods",
  "employee_driver_earning_period_delivery_sources",
  "employee_driver_earning_period_payment_allocations",
  "employee_driver_earning_period_payroll_allocations",
  "commerce_integration_connections",
  "commerce_integration_oauth_states",
  "commerce_integration_events",
  "commerce_integration_order_links",
  "commerce_integration_area_mappings",
  "company_customer_quote_participation",
  "company_customer_quote_pricing_profiles",
  "platform_customer_quote_offers",
  "employee_collect_order_earnings",
  "order_serial_history",
  // Platform fees are still Company-owned financial rows: both tables carry
  // a required `company_id`, and payments depend on receivables while
  // receivables depend on Orders. The generic FK-derived deletion ordering
  // therefore removes them safely before their parents.
  "platform_fee_payments",
  "platform_fee_receivables",
] as const;

// 2026-08-31 review: WhatsApp Trader-group foundation
// (`20260956000000_whatsapp_trader_group_foundation`) added four
// Company-scoped tables — `company_whatsapp_connections`,
// `trader_whatsapp_settings`, `whatsapp_message_outbox`,
// `whatsapp_message_attempts` — all registered in
// `reset-company-test-data.manifest.ts`'s `PURGE_TABLES`, so they flow into
// `COMPANY_DELETION_DIRECT_TABLES` via the spread below. All four carry a
// literal `company_id uuid not null references companies(id) on delete
// restrict`; every other FK among them is composite `(x_id, company_id)` and
// `on delete restrict`, forming a strict DAG (attempts -> outbox ->
// {connection, settings' Trader, orders, order_status_history}) that the
// generic FK-derived `dependencyOrder()` sorts correctly with no cycle
// breaks. One BEFORE UPDATE trigger only
// (`whatsapp_message_outbox_update_guard`) — it never fires on DELETE, so no
// `COMPANY_DELETION_APPROVED_GUARDS` entry is needed. This comment is the
// reviewed acknowledgment the pinned count test forces; bumped 156 -> 160 in
// `platform-company-deletion.manifest.test.ts`.
//
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
//
// ---------------------------------------------------------------------------
// 2026-08-12 review: 5 new payroll tables from `20260816200000_driver_
// earnings_interim_payments` and `20260816210000_driver_earning_payment_
// guards` (both already applied). All five carry `company_id uuid not null
// references companies(id) on delete restrict` — direct ownership, no
// indirect join needed. None introduce a new FK cycle: every outbound FK is
// `on delete restrict`, and the live FK graph among them is a strict DAG —
// verified against `pg_constraint`, not assumed from table names.
//
//   employee_salary_advances                    -> employees, accounts,
//                                                    company_cash_accounts,
//                                                    company_bank_accounts
//   employee_salary_advance_payroll_allocations  -> employee_salary_advances,
//                                                    payroll_entries
//   employee_variable_earning_payments           -> employees, accounts,
//                                                    company_cash_accounts,
//                                                    company_bank_accounts
//   employee_variable_earning_payment_allocations -> employee_variable_earning_payments,
//                                                    employee_order_earnings,
//                                                    employee_driver_collection_facts,
//                                                    payroll_entries
//   outsourced_driver_collection_earning_rules   -> drivers, accounts
//                                                    (and is itself referenced
//                                                    by the pre-existing
//                                                    `outsourced_driver_fee_accruals`,
//                                                    already a classified table)
//
// The two `*_allocations` tables are pure junction/allocation rows (payment
// or advance parent + payroll-entry parent) and carry no `company_id`-scoped
// children of their own — the live FK graph places them as leaves, deleted
// before both parents automatically by `dependencyOrder()`'s topological
// sort. No manual `CYCLE_BREAKS` entry was needed for any of the five.
//
// `outsourced_driver_collection_earning_rules` is effective-dated
// configuration (a rate rule per Outsourced Driver, not a transaction), but
// it is still owned by exactly one Company and carries no history that
// outlives the Company itself once `outsourced_driver_fee_accruals` (its one
// dependent, pre-existing table) is gone — ordinary direct-table treatment
// is correct, not a special "config" carve-out.
//
// One new trigger fires on DELETE: `employee_variable_payment_total_guard`
// (a deferred constraint trigger on `employee_variable_earning_payment_
// allocations`, enforcing that active allocations always sum to their
// payment's `amount_paid`). It is business-consistency protection for
// *normal* operation, exactly like every other guard already in
// `COMPANY_DELETION_APPROVED_GUARDS` — safe to disable for the scope of a
// reviewed, whole-Company deletion transaction and restore immediately after,
// the same treatment every other listed guard already receives. No other
// trigger on any of the five tables fires on DELETE (confirmed against
// `pg_trigger.tgtype & 8`, not inferred from trigger names).
//
// Manifest version stays `company-deletion-v2`, matching the Prompt 15
// precedent immediately above: this is an additive classification review,
// not a change to the manifest's methodology or shape. Only the recalculated
// hash changes; there is no hard-coded hash value anywhere to go stale (the
// test asserts the hash against `/^[a-f0-9]{64}$/`, not a pinned digest).
// Pinned count bumped 129 -> 134 in
// `platform-company-deletion.manifest.test.ts` for these five additions.

export const COMPANY_DELETION_DIRECT_TABLES = new Set([
  ...PURGE_TABLES,
  // Both exclusion lists matter: SHARED_PRESERVE holds the global/commerce
  // tables, and PLATFORM_PRESERVE holds the Platform's own deletion
  // bookkeeping (keyed by `company_id_snapshot`, no `company_id` column).
  // The reset manifest classifies all of them as PRESERVE since 2026-08-13,
  // so without this second filter they would flow in here and the per-table
  // `where company_id` count in the preview would fail on a column that
  // does not exist.
  ...[...PRESERVE_TABLES].filter(
    (table) =>
      !SHARED_PRESERVE.includes(table as (typeof SHARED_PRESERVE)[number]) &&
      !PLATFORM_PRESERVE.includes(table as (typeof PLATFORM_PRESERVE)[number]),
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
  // 2026-08-12 review: `store_orders` carries a direct, restricting FK to
  // `companies` -- but under `delivery_company_id`, not the standard
  // `company_id` name the generic per-table deletion loop assumes. It is
  // genuinely Company-owned (this is which delivery Company fulfilled the
  // Storefront order), not global, and must not be preserved as if it were
  // -- so it is handled the same way `role_permissions` already is: an
  // explicit, reviewed scoped delete in the execution service, before the
  // generic ordering loop. `store_order_items` needs no delete statement of
  // its own -- `store_order_items_store_order_id_fkey` is `ON DELETE
  // CASCADE` from `store_orders`, so removing the parent removes it.
  {
    table: "store_orders",
    ownership: "store_orders.delivery_company_id = target (direct FK, non-standard column name)",
  },
  {
    table: "store_order_items",
    ownership: "store_order_items.store_order_id -> store_orders.id (on delete cascade)",
  },
  {
    table: "store_order_idempotency_keys",
    ownership:
      "store_order_idempotency_keys.store_order_id -> store_orders.id where store_orders.delivery_company_id = target",
  },
  {
    table: "commerce_integration_credentials",
    ownership:
      "commerce_integration_credentials.connection_id -> commerce_integration_connections.id where connections.company_id = target",
  },
  {
    table: "company_customer_quote_pricing_rules",
    ownership:
      "company_customer_quote_pricing_rules.pricing_profile_id -> company_customer_quote_pricing_profiles.id where profiles.company_id = target",
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
  "employee_variable_payment_total_guard",
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
