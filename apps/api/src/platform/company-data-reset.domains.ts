import { PURGE_TABLES } from "./reset-company-test-data.manifest.js";

/**
 * COMPANY DATA RESET -- reset domains and presets (Company Data Reset, Prompt 1).
 *
 * A reset is never "delete everything WHERE company_id = X". Every table the
 * manifest classifies PURGE belongs to exactly ONE reset domain below, and a
 * reset removes only the domains the Platform Admin selected (plus domains a
 * selected domain cannot be removed without -- reported in the preview as a
 * REQUIRED DEPENDENCY, never silently). The Company row, configuration,
 * identity tables and Platform audit are PRESERVE in the manifest and are
 * never in any domain.
 *
 * Users are NOT a table domain. User accounts, memberships, roles, Employees
 * and Drivers linked to removed users are handled row by row by the user
 * reset plan (`company-data-reset.planner.ts`), only when a user mode other
 * than KEEP_ALL_USERS is chosen.
 */

export const RESET_DOMAINS = [
  "OPERATIONAL",
  "FINANCIAL",
  "TRADERS_CUSTOMERS",
  "WORKFORCE",
  "INTEGRATIONS",
] as const;
export type ResetDomain = (typeof RESET_DOMAINS)[number];

/** Domains that may be pulled in automatically as a shown REQUIRED DEPENDENCY. */
export const AUTO_DEPENDENCY_DOMAINS: ReadonlySet<ResetDomain> = new Set(["OPERATIONAL", "FINANCIAL"]);

/**
 * Master-data domains: never removed unless explicitly selected. A selection
 * that would need one of them is BLOCKED, not widened.
 */
export const PROTECTED_DOMAINS: ReadonlySet<ResetDomain> = new Set(["TRADERS_CUSTOMERS", "WORKFORCE", "INTEGRATIONS"]);

/**
 * Tables that are PURGE in the manifest but are per-user access state: removed
 * row by row for removed users only, never wholesale.
 */
export const USER_ACCESS_TABLES: ReadonlySet<string> = new Set(["device_registrations"]);

export const DOMAIN_TABLES: Readonly<Record<ResetDomain, readonly string[]>> = {
  OPERATIONAL: [
    "communication_notification_outbox",
    "commerce_integration_events",
    "commerce_integration_order_links",
    "company_route_optimization_usage",
    "conversation_participants",
    "conversations",
    "customer_messaging_sessions",
    "driver_reconciliation_expenses",
    "driver_reconciliation_orders",
    "driver_reconciliation_payments",
    "driver_reconciliations",
    "driver_route_actions",
    "driver_route_runs",
    "driver_route_stops",
    "idempotency_records",
    "import_batches",
    "import_errors",
    "international_shipments",
    "messages",
    "notification_outbox_events",
    "order_assignments",
    "order_attachments",
    "order_events",
    "order_expenses",
    "order_items",
    "order_maintenance_findings",
    "order_serial_history",
    "order_status_history",
    "orders",
    "realtime_event_log",
    "saas_usage_events",
    "support_cases",
    "tracking_access_events",
    "tracking_tokens",
    "whatsapp_message_attempts",
    "whatsapp_message_outbox",
  ],
  FINANCIAL: [
    "accounting_batch_items",
    "accounting_batch_jobs",
    "accounting_batch_transitions",
    "accounting_event_components",
    "accounting_events",
    "cash_bank_movement_attachments",
    "cash_bank_movements",
    "closing_task_attachments",
    "closing_task_comments",
    "closing_workflow_reviews",
    "closing_workflow_tasks",
    "closing_workflow_transitions",
    "closing_workflows",
    "driver_collection_trader_payables",
    "driver_commission_calculations",
    "driver_commission_orders",
    "employee_collect_order_earnings",
    "employee_driver_collection_fact_orders",
    "employee_driver_collection_facts",
    "employee_driver_earning_period_delivery_sources",
    "employee_driver_earning_period_payment_allocations",
    "employee_driver_earning_period_payroll_allocations",
    "employee_driver_earning_periods",
    "employee_order_earnings",
    "employee_salary_advance_payroll_allocations",
    "employee_salary_advances",
    "employee_variable_earning_payment_allocations",
    "employee_variable_earning_payments",
    "general_expense_attachments",
    "general_expense_lines",
    "general_expense_payment_rows",
    "general_expense_payments",
    "general_expenses",
    "journal_entries",
    "journal_lines",
    "opening_balance_batches",
    "opening_balance_lines",
    "operating_expenses",
    "outsourced_driver_fee_accruals",
    "outsourced_driver_fee_payment_allocations",
    "outsourced_driver_fee_payments",
    "outsourced_driver_payments",
    "payroll_adjustments",
    "payroll_calculation_exceptions",
    "payroll_commission_links",
    "payroll_entries",
    "payroll_line_allowances",
    "payroll_payment_allocations",
    "payroll_payments",
    "payroll_periods",
    "platform_fee_payments",
    "platform_fee_receivables",
    "trader_collection_allocations",
    "trader_collections",
    "trader_credits",
    "trader_receivables",
    "trader_settlement_credit_applications",
    "trader_settlement_drafts",
    "trader_settlement_orders",
    "trader_settlement_payments",
    "trader_settlement_receivable_offsets",
    "trader_settlements",
  ],
  TRADERS_CUSTOMERS: [
    "customer_addresses",
    "customers",
    "trader_bank_accounts",
    "trader_commerce_company_links",
    "trader_delivery_company_relationships",
    "trader_service_prices",
    "trader_whatsapp_settings",
    "traders",
  ],
  WORKFORCE: [
    "driver_commission_rules",
    "driver_documents",
    "drivers",
    "employee_allowances",
    "employee_collection_earning_rules",
    "employee_delivery_earning_rules",
    "employee_roles",
    "employee_salary_versions",
    "employees",
    "hr_document_attachments",
    "hr_documents",
    "outsourced_driver_collection_earning_rules",
    "outsourced_driver_fee_versions",
  ],
  INTEGRATIONS: [
    "commerce_integration_area_mappings",
    "commerce_integration_connections",
    "commerce_integration_oauth_states",
    "company_whatsapp_connections",
  ],
};

const tableDomain = new Map<string, ResetDomain>();
for (const domain of RESET_DOMAINS) {
  for (const table of DOMAIN_TABLES[domain]) tableDomain.set(table, domain);
}

export function domainOf(table: string): ResetDomain | null {
  return tableDomain.get(table) ?? null;
}

/**
 * Coverage check, also run by the planner before every preview: every
 * PURGE table is in exactly one domain (or is per-user access state), and
 * every domain table is a PURGE table. A new PURGE table without a domain
 * makes the planner refuse rather than guess.
 */
export function domainCoverageProblems(purgeTables: ReadonlySet<string> = PURGE_TABLES): string[] {
  const problems: string[] = [];
  const seen = new Map<string, ResetDomain>();
  for (const domain of RESET_DOMAINS) {
    for (const table of DOMAIN_TABLES[domain]) {
      const previous = seen.get(table);
      if (previous !== undefined) problems.push(`'${table}' is in both ${previous} and ${domain}`);
      seen.set(table, domain);
      if (!purgeTables.has(table)) problems.push(`'${table}' (${domain}) is not a PURGE table`);
    }
  }
  for (const table of purgeTables) {
    if (!seen.has(table) && !USER_ACCESS_TABLES.has(table)) problems.push(`PURGE table '${table}' has no reset domain`);
  }
  return problems.sort();
}

// ---------------------------------------------------------------- Presets

export const RESET_PRESETS = [
  "OPERATIONAL_DATA",
  "FINANCIAL_DATA",
  "USERS_WORKFORCE",
  "FULL_COMPANY_DATA_KEEP_COMPANY",
  "CUSTOM",
] as const;
export type ResetPreset = (typeof RESET_PRESETS)[number];

export const USER_MODES = ["KEEP_ALL_USERS", "DELETE_SELECTED_USERS", "DELETE_ALL_ELIGIBLE_USERS"] as const;
export type UserMode = (typeof USER_MODES)[number];

export type KeepOrReset = "KEEP" | "RESET";

export interface ResetPlanRequest {
  readonly preset: ResetPreset;
  /** CUSTOM only: the domains to reset. */
  readonly domains?: readonly ResetDomain[] | undefined;
  /** Default KEEP_ALL_USERS. */
  readonly userMode?: UserMode | undefined;
  /** DELETE_SELECTED_USERS: stable account ids. */
  readonly selectedAccountIds?: readonly string[] | undefined;
  /** Company Admins are KEPT unless explicitly marked DELETE here. */
  readonly deleteAdminAccountIds?: readonly string[] | undefined;
  /** FULL preset options (default KEEP). */
  readonly tradersCustomers?: KeepOrReset | undefined;
  readonly workforce?: KeepOrReset | undefined;
}

export interface NormalizedResetRequest {
  readonly preset: ResetPreset;
  readonly selectedDomains: readonly ResetDomain[];
  readonly userMode: UserMode;
  readonly selectedAccountIds: readonly string[];
  readonly deleteAdminAccountIds: readonly string[];
}

export class ResetRequestError extends Error {}

/**
 * Deterministic preset expansion. Nothing is implied: Operational / Financial
 * presets never touch users, workforce, traders or customers; FULL resets
 * Operational + Financial and only what its explicit options add.
 */
export function normalizeResetRequest(request: ResetPlanRequest): NormalizedResetRequest {
  const userMode = request.userMode ?? "KEEP_ALL_USERS";
  const selected = [...new Set(request.selectedAccountIds ?? [])].sort();
  const deleteAdmins = [...new Set(request.deleteAdminAccountIds ?? [])].sort();
  const domains = new Set<ResetDomain>();
  const optionsUsed = request.tradersCustomers !== undefined || request.workforce !== undefined;
  switch (request.preset) {
    case "OPERATIONAL_DATA":
    case "FINANCIAL_DATA":
      if (userMode !== "KEEP_ALL_USERS" || selected.length > 0 || deleteAdmins.length > 0) {
        throw new ResetRequestError(`${request.preset} keeps every user; use USERS_WORKFORCE or CUSTOM to remove users`);
      }
      if (optionsUsed || (request.domains ?? []).length > 0) {
        throw new ResetRequestError(`${request.preset} has fixed domains; use CUSTOM to choose domains`);
      }
      domains.add(request.preset === "OPERATIONAL_DATA" ? "OPERATIONAL" : "FINANCIAL");
      break;
    case "USERS_WORKFORCE":
      if (optionsUsed || (request.domains ?? []).length > 0) {
        throw new ResetRequestError("USERS_WORKFORCE resets no data domain; use CUSTOM to combine");
      }
      if (request.userMode === undefined) {
        throw new ResetRequestError("USERS_WORKFORCE requires an explicit user mode");
      }
      break;
    case "FULL_COMPANY_DATA_KEEP_COMPANY":
      if ((request.domains ?? []).length > 0) {
        throw new ResetRequestError("FULL_COMPANY_DATA_KEEP_COMPANY has fixed domains; use CUSTOM to choose domains");
      }
      if (request.userMode === undefined) {
        throw new ResetRequestError("FULL_COMPANY_DATA_KEEP_COMPANY requires an explicit user mode");
      }
      domains.add("OPERATIONAL");
      domains.add("FINANCIAL");
      if (request.tradersCustomers === "RESET") domains.add("TRADERS_CUSTOMERS");
      if (request.workforce === "RESET") domains.add("WORKFORCE");
      break;
    case "CUSTOM":
      if (optionsUsed) throw new ResetRequestError("CUSTOM takes domains, not preset options");
      for (const domain of request.domains ?? []) domains.add(domain);
      if (domains.size === 0 && userMode === "KEEP_ALL_USERS") {
        throw new ResetRequestError("CUSTOM needs at least one domain or a user mode");
      }
      break;
  }
  if (userMode === "DELETE_SELECTED_USERS" && selected.length === 0) {
    throw new ResetRequestError("DELETE_SELECTED_USERS needs at least one selected account");
  }
  if (userMode !== "DELETE_SELECTED_USERS" && selected.length > 0) {
    throw new ResetRequestError("Selected accounts are only valid with DELETE_SELECTED_USERS");
  }
  if (userMode === "KEEP_ALL_USERS" && deleteAdmins.length > 0) {
    throw new ResetRequestError("KEEP_ALL_USERS cannot delete Company Admins");
  }
  return {
    deleteAdminAccountIds: deleteAdmins,
    preset: request.preset,
    selectedAccountIds: selected,
    selectedDomains: RESET_DOMAINS.filter((domain) => domains.has(domain)),
    userMode,
  };
}
