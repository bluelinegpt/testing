import type pg from "pg";

/**
 * Shared manifest and live-schema inspection for the Company test-data reset tools.
 *
 * This module is READ-ONLY. It classifies tables, resolves Company ownership, counts rows
 * and computes ordering. It issues no statement that can change data, and the safety test
 * enforces that mechanically. The execution engine imports from here; nothing here imports
 * the engine, so the read-only path can never reach a data-changing statement.
 */

export type Classification = "PURGE" | "PRESERVE" | "CONDITIONAL" | "UNSAFE";

/**
 * Operational, financial and business-master records produced by running the system.
 * Reviewed table by table against the live schema in Prompt 1B; the business-master block
 * was approved for this full-cycle development reset in Prompt 2A.
 */
export const PURGE_TABLES = new Set([
  // Orders
  "driver_commission_orders",
  "employee_order_earnings",
  "import_batches",
  "import_errors",
  "international_shipments",
  "order_assignments",
  "order_attachments",
  "order_events",
  "order_expenses",
  "order_items",
  "order_status_history",
  "orders",
  "saas_usage_events",
  "tracking_access_events",
  "tracking_tokens",
  // Driver Reconciliation
  "driver_reconciliation_expenses",
  "driver_reconciliation_orders",
  "driver_reconciliation_payments",
  "driver_reconciliations",
  // Driver Collections
  "driver_collection_trader_payables",
  "trader_collection_allocations",
  "trader_collections",
  "trader_receivables",
  // Driver commissions and outsourced Driver fees
  "driver_commission_calculations",
  "outsourced_driver_fee_accruals",
  "outsourced_driver_fee_payment_allocations",
  "outsourced_driver_fee_payments",
  "outsourced_driver_payments",
  // Trader Settlements
  "trader_settlement_orders",
  "trader_settlement_payments",
  "trader_settlements",
  // Payroll runs, calculations and payments
  "payroll_adjustments",
  "payroll_calculation_exceptions",
  "payroll_commission_links",
  "payroll_entries",
  "payroll_line_allowances",
  "payroll_payment_allocations",
  "payroll_payments",
  "payroll_periods",
  // General and operating expenses
  "general_expense_attachments",
  "general_expense_lines",
  "general_expense_payment_rows",
  "general_expense_payments",
  "general_expenses",
  "operating_expenses",
  // Cash and bank transactions
  "cash_bank_movement_attachments",
  "cash_bank_movements",
  // Accounting events and journals
  "accounting_event_components",
  "accounting_events",
  "journal_entries",
  "journal_lines",
  // Accounting batch runs
  "accounting_batch_items",
  "accounting_batch_jobs",
  "accounting_batch_transitions",
  // Period closing execution history
  "closing_task_attachments",
  "closing_task_comments",
  "closing_workflow_reviews",
  "closing_workflow_tasks",
  "closing_workflow_transitions",
  "closing_workflows",
  // Transactional opening balances
  "opening_balance_batches",
  "opening_balance_lines",
  // Communication and runtime records
  "communication_notification_outbox",
  "conversation_participants",
  "conversations",
  "customer_messaging_sessions",
  "idempotency_records",
  "messages",
  "realtime_event_log",
  "support_cases",
  // Per-entity records of the business masters below. They are not Company-wide
  // configuration: every row belongs to one Employee or one Driver and is meaningless
  // once that master is gone. Foreign keys make this mandatory rather than optional —
  // employees and drivers cannot be removed while these rows still reference them.
  // The catalog tables they draw from (allowance_types, expense_types) stay preserved.
  "driver_commission_rules",
  "employee_allowances",
  "employee_delivery_earning_rules",
  "employee_salary_versions",
  "hr_document_attachments",
  "hr_documents",
  "outsourced_driver_fee_versions",
  // Business masters — approved for this full-cycle development reset (Prompt 2A)
  "customer_addresses",
  "customers",
  "driver_documents",
  "drivers",
  "employee_roles",
  "employees",
  "trader_bank_accounts",
  "trader_commerce_company_links",
  "trader_delivery_company_relationships",
  "trader_service_prices",
  "traders",
]);

/**
 * Company identity, login, roles, permissions, accounting setup, fiscal setup, area and
 * platform configuration, audit trails, stored files and migration bookkeeping.
 */
export const PRESERVE_TABLES = new Set([
  "account_mappings",
  "account_roles",
  "account_sessions",
  "accounting_configuration_history",
  "accounting_configurations",
  "accounting_periods",
  "accounting_zero_opening_confirmations",
  "accounts",
  "allowance_types",
  "areas",
  "audit_events",
  "balance_override_audits",
  "chart_of_accounts",
  "companies",
  "company_balance_policies",
  "company_bank_accounts",
  "company_business_day_configurations",
  "company_cash_accounts",
  "company_reference_counters",
  "company_settings",
  "company_users",
  "emirates",
  "expense_types",
  "file_objects",
  "fiscal_years",
  "general_expense_categories",
  "kysely_migration",
  "kysely_migration_lock",
  /* Platform-wide Marketplace taxonomy, also listed in GLOBAL_TABLES. Global
     tables appear in both sets by convention -- `companies`, `emirates` and
     `permissions` all do -- because `classify` reads the classification lists
     and GLOBAL_TABLES only describes ownership. */
  "marketplace_categories",
  "marketplace_subcategories",
  "password_reset_tokens",
  "permissions",
  "role_permissions",
  "roles",
  /*
   * The Storefront subtree, preserved because it is not Company-owned data.
   *
   * A Storefront hangs off `trader_commerce_id -> trader_commerce_profiles`, which carries
   * no `company_id` and is GLOBAL by design; the Company association lives in the
   * many-to-many `trader_commerce_company_links`. `trader_storefronts.company_id` and
   * `.trader_id` are both nullable legacy columns and both NULL on live data, so the
   * engine's removal statement -- scoped by `company_id = $1` -- never matched these rows
   * in the first place: they were listed for removal but silently survived every reset.
   *
   * Preserving them makes that real behaviour explicit instead of implied, and keeps the
   * subtree internally consistent: nothing outside it references in, and its outward
   * references all land on preserved tables (`companies`, `file_objects`,
   * `marketplace_categories`, `trader_commerce_profiles`).
   *
   * Revisit together with `trader_commerce_company_links` if Storefronts are ever made
   * genuinely per-Company.
   */
  "storefront_marketplace_categories",
  "third_party_delivery_companies",
  "trader_commerce_profiles",
  "trader_storefront_categories",
  "trader_storefront_product_media",
  "trader_storefront_product_option_groups",
  "trader_storefront_product_option_values",
  "trader_storefront_products",
  "trader_storefront_slugs",
  "trader_storefronts",
  "user_business_links",
  "vehicles",
]);

/**
 * Prompt 2A resolved the business-master question, so this set is normally empty. A table
 * added to the schema and left unclassified becomes UNSAFE rather than silently landing
 * here, which keeps new tables from slipping into a reset.
 */
export const CONDITIONAL_TABLES = new Set<string>([]);

/** Global tables that carry no Company column by design. */
export const GLOBAL_TABLES = new Set([
  "companies",
  "emirates",
  "kysely_migration",
  "kysely_migration_lock",
  /* Platform-wide Marketplace taxonomy. Neither table carries a `company_id`:
     one shared list of Categories and Subcategories that every Company selects
     from, the same shape as `emirates`. Resetting one Company must not remove
     reference data the others are still pointing at. */
  "marketplace_categories",
  "marketplace_subcategories",
  "permissions",
  "role_permissions",
  "trader_commerce_profiles",
]);

/**
 * Self-referencing table pairs form foreign-key cycles that no ordering can resolve.
 * No foreign key in this database is declared DEFERRABLE (verified against pg_constraint:
 * 0 of 570), so `set constraints ... deferred` is not available. Each cycle is instead
 * broken by clearing one nullable side first, inside the same transaction, before any row
 * is removed. Both columns below are nullable in the live schema.
 */
export const CYCLE_BREAKS: { table: string; columns: string[]; reason: string }[] = [
  {
    table: "journal_entries",
    columns: ["accounting_event_id"],
    reason:
      "breaks journal_entries <-> accounting_events; the column is nullable and both sides " +
      "are removed in the same transaction, so no surviving row loses its link",
  },
  {
    table: "conversations",
    columns: ["last_message_id"],
    reason:
      "breaks conversations <-> messages; the column is nullable and the constraint already " +
      "clears it automatically when the message goes, so clearing it first is the same end state",
  },
];

/**
 * Foreign keys that exist for backward compatibility and carry no ownership meaning.
 *
 * The inbound-reference check refuses to remove a table that anything outside the removal
 * set still points at. That check is structural -- it reads `pg_constraint`, not rows -- so
 * it cannot tell a live relationship from a dormant column kept only so older code keeps
 * compiling. Each entry below records an edge that has been reviewed and found to be the
 * latter, and is skipped by `collectInboundReferences` alone. Nothing else consults this
 * list: ordering, classification and the removal statements are all unaffected.
 *
 * This never disables the database's own protection. Every edge here is declared RESTRICT,
 * so if the columns ever do hold a value for the Company being reset, Postgres refuses the
 * removal and the whole reset rolls back. The list changes what the tool declines up front,
 * not what the database enforces.
 */
export const LEGACY_COMPATIBILITY_EDGES: {
  child: string;
  parent: string;
  columns: string[];
  reason: string;
}[] = [
  {
    child: "trader_storefronts",
    parent: "traders",
    columns: ["company_id", "trader_id"],
    reason:
      "Storefront ownership moved from the Delivery Company to Trader Commerce in " +
      "20260807100000_storefront_commerce_ownership_rebind, which kept these two columns as " +
      "nullable compatibility references and states that no Company ownership may be " +
      "inferred from them. The pair is MATCH SIMPLE with a CHECK that both are NULL or " +
      "neither, so the constraint is skipped whenever they are unset -- which is every row",
  },
];

/**
 * Module grouping for the report. First matching rule wins, so the specific exact-name
 * rules are listed before the broader prefix rules.
 */
const MODULE_RULES: { module: string; tables?: string[]; prefixes?: string[] }[] = [
  {
    module: "Driver Reconciliation",
    prefixes: ["driver_reconciliation"],
    tables: ["driver_reconciliations"],
  },
  {
    module: "Driver Collections",
    tables: [
      "driver_collection_trader_payables",
      "trader_collections",
      "trader_collection_allocations",
      "trader_receivables",
    ],
  },
  {
    module: "Driver commissions / outsourced Driver fees",
    prefixes: ["driver_commission", "outsourced_driver"],
  },
  { module: "Trader Settlements", prefixes: ["trader_settlement"] },
  { module: "Payroll", prefixes: ["payroll_"] },
  {
    module: "General Expenses",
    prefixes: ["general_expense", "operating_expense"],
    tables: ["expense_types"],
  },
  {
    module: "Cash / Bank transactions",
    prefixes: ["cash_bank_movement"],
    tables: ["company_cash_accounts", "company_bank_accounts", "company_balance_policies"],
  },
  { module: "Accounting Batch", prefixes: ["accounting_batch"] },
  { module: "Accounting Events", prefixes: ["accounting_event"] },
  { module: "Journals / Journal Lines", prefixes: ["journal_"] },
  { module: "Ledger / posting links", prefixes: ["opening_balance"], tables: ["account_mappings"] },
  {
    module: "Period Closing",
    prefixes: ["closing_"],
    tables: ["accounting_periods", "fiscal_years", "accounting_zero_opening_confirmations"],
  },
  { module: "Audit", tables: ["audit_events", "balance_override_audits"] },
  {
    module: "Communication / notifications",
    prefixes: ["conversation", "communication_"],
    tables: ["messages", "customer_messaging_sessions", "realtime_event_log", "support_cases"],
  },
  {
    module: "Storefront / Commerce",
    prefixes: ["trader_storefront", "trader_commerce"],
    tables: ["trader_delivery_company_relationships"],
  },
  {
    module: "Business masters",
    prefixes: ["employee", "driver_documents", "trader_bank", "trader_service"],
    tables: ["traders", "drivers", "customers", "customer_addresses", "vehicles"],
  },
  {
    module: "Orders",
    prefixes: ["order_", "import_", "tracking_"],
    tables: ["orders", "international_shipments", "saas_usage_events"],
  },
];

export const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface ForeignKey {
  child: string;
  parent: string;
  childColumns: string[];
  parentColumns: string[];
}

export interface OwnershipStep {
  table: string;
  childColumns: string[];
  parentColumns: string[];
}

export interface Ownership {
  kind: "direct" | "indirect" | "global" | "unresolved";
  path: string;
  steps: OwnershipStep[];
}

export interface TableReport {
  module: string;
  guards: string[];
  table: string;
  classification: Classification;
  reason: string;
  ownership: Ownership;
  rows: number | null;
  scope: "company" | "global" | "unknown";
}

export interface SchemaSnapshot {
  tables: string[];
  companyScoped: Set<string>;
  foreignKeys: ForeignKey[];
  guards: Map<string, string[]>;
}

export function moduleOf(table: string): string {
  for (const rule of MODULE_RULES) {
    if ((rule.tables ?? []).includes(table)) {
      return rule.module;
    }
    if ((rule.prefixes ?? []).some((prefix) => table.startsWith(prefix))) {
      return rule.module;
    }
  }
  return "Other";
}

export function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Refusing to use unexpected identifier '${name}'`);
  }
  return `"${name}"`;
}

export function classify(
  table: string,
  ownership: Ownership,
): { classification: Classification; reason: string } {
  if (PRESERVE_TABLES.has(table)) {
    return { classification: "PRESERVE", reason: "master data, configuration, identity or audit" };
  }
  if (CONDITIONAL_TABLES.has(table)) {
    return {
      classification: "CONDITIONAL",
      reason: "awaiting an explicit business decision",
    };
  }
  if (PURGE_TABLES.has(table)) {
    if (ownership.kind === "direct" || ownership.kind === "indirect") {
      return {
        classification: "PURGE",
        reason: "operational, financial or business-master record",
      };
    }
    return {
      classification: "UNSAFE",
      reason: "listed for removal but Company ownership could not be resolved",
    };
  }
  return {
    classification: "UNSAFE",
    reason: "not present in any classification list — review required before any reset",
  };
}

export function resolveOwnership(
  table: string,
  companyScoped: Set<string>,
  foreignKeys: ForeignKey[],
): Ownership {
  if (GLOBAL_TABLES.has(table) && !companyScoped.has(table)) {
    return { kind: "global", path: "global table (no Company column by design)", steps: [] };
  }
  if (companyScoped.has(table)) {
    return { kind: "direct", path: `${table}.company_id`, steps: [] };
  }

  const byChild = new Map<string, ForeignKey[]>();
  for (const key of foreignKeys) {
    byChild.set(key.child, [...(byChild.get(key.child) ?? []), key]);
  }

  const queue: { table: string; steps: OwnershipStep[] }[] = [{ table, steps: [] }];
  const visited = new Set<string>([table]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current.steps.length >= 4) {
      continue;
    }
    for (const key of byChild.get(current.table) ?? []) {
      if (visited.has(key.parent)) {
        continue;
      }
      const steps = [
        ...current.steps,
        { table: key.parent, childColumns: key.childColumns, parentColumns: key.parentColumns },
      ];
      if (companyScoped.has(key.parent)) {
        const rendered = steps
          .map((step, index) => {
            const from = index === 0 ? table : steps[index - 1]?.table;
            return `${from}.${step.childColumns.join("+")} -> ${step.table}.${step.parentColumns.join("+")}`;
          })
          .join(" -> ");
        return { kind: "indirect", path: `${rendered} -> ${key.parent}.company_id`, steps };
      }
      visited.add(key.parent);
      queue.push({ table: key.parent, steps });
    }
  }
  return { kind: "unresolved", path: "no Company ownership path found", steps: [] };
}

export function buildCountStatement(table: string, ownership: Ownership): string | null {
  if (ownership.kind === "direct") {
    return `select count(*)::bigint as n from ${quoteIdentifier(table)} where company_id = $1`;
  }
  if (ownership.kind === "global") {
    return `select count(*)::bigint as n from ${quoteIdentifier(table)}`;
  }
  if (ownership.kind === "indirect") {
    const joins: string[] = [];
    ownership.steps.forEach((step, index) => {
      const childAlias = `t${index}`;
      const parentAlias = `t${index + 1}`;
      const condition = step.childColumns
        .map(
          (column, position) =>
            `${parentAlias}.${quoteIdentifier(step.parentColumns[position] ?? column)} = ` +
            `${childAlias}.${quoteIdentifier(column)}`,
        )
        .join(" and ");
      joins.push(`join ${quoteIdentifier(step.table)} ${parentAlias} on ${condition}`);
    });
    const last = `t${ownership.steps.length}`;
    return (
      `select count(*)::bigint as n from ${quoteIdentifier(table)} t0 ` +
      `${joins.join(" ")} where ${last}.company_id = $1`
    );
  }
  return null;
}

/** True when this foreign key is one of the declared cycle-breaking links. */
export function isBrokenEdge(key: ForeignKey): boolean {
  return CYCLE_BREAKS.some(
    (entry) =>
      entry.table === key.child &&
      entry.columns.some((column) => key.childColumns.includes(column)),
  );
}

export function dependencyOrder(
  tables: string[],
  foreignKeys: ForeignKey[],
): { order: string[]; cycle: string[]; blocked: string[] } {
  const inScope = new Set(tables);
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>(tables.map((table) => [table, 0]));
  for (const key of foreignKeys) {
    if (!inScope.has(key.child) || !inScope.has(key.parent) || key.child === key.parent) {
      continue;
    }
    if (isBrokenEdge(key)) {
      continue;
    }
    const set = dependents.get(key.child) ?? new Set<string>();
    if (set.has(key.parent)) {
      continue;
    }
    set.add(key.parent);
    dependents.set(key.child, set);
    indegree.set(key.parent, (indegree.get(key.parent) ?? 0) + 1);
  }

  const ready = tables.filter((table) => (indegree.get(table) ?? 0) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const table = ready.shift() as string;
    order.push(table);
    for (const parent of dependents.get(table) ?? []) {
      const remaining = (indegree.get(parent) ?? 0) - 1;
      indegree.set(parent, remaining);
      if (remaining === 0) {
        ready.push(parent);
        ready.sort();
      }
    }
  }

  const remaining = new Set(tables.filter((table) => !order.includes(table)));
  const reachesItself = (start: string): boolean => {
    const seen = new Set<string>();
    const stack = [...(dependents.get(start) ?? [])].filter((next) => remaining.has(next));
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === start) {
        return true;
      }
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      for (const next of dependents.get(current) ?? []) {
        if (remaining.has(next)) {
          stack.push(next);
        }
      }
    }
    return false;
  };
  const cycle = [...remaining].filter((table) => reachesItself(table)).sort();
  return {
    order,
    cycle,
    blocked: [...remaining].filter((table) => !cycle.includes(table)).sort(),
  };
}

export async function introspectSchema(client: pg.PoolClient): Promise<SchemaSnapshot> {
  const tables = (
    await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables " +
        "where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name",
    )
  ).rows.map((row) => row.table_name);

  const companyScoped = new Set(
    (
      await client.query<{ table_name: string }>(
        "select table_name from information_schema.columns " +
          "where table_schema = 'public' and column_name = 'company_id'",
      )
    ).rows.map((row) => row.table_name),
  );

  const foreignKeys = (
    await client.query<{
      child: string;
      parent: string;
      child_columns: string[];
      parent_columns: string[];
    }>(
      /* `attname` is of type `name`, so aggregating it yields `name[]` (OID
         1003) -- an array type node-postgres has no parser for, which arrives
         as the raw literal string "{a,b}" instead of an array. The `::text`
         casts make these `text[]`, which it does parse. Without them every
         downstream use is wrong: `.join`/`.map` throw, and `.includes` quietly
         degrades to substring matching. */
      `select
         child_class.relname as child,
         parent_class.relname as parent,
         (select array_agg(child_attribute.attname::text order by child_key.ordinality)
            from unnest(constraint_row.conkey) with ordinality as child_key(attnum, ordinality)
            join pg_attribute child_attribute
              on child_attribute.attrelid = constraint_row.conrelid
             and child_attribute.attnum = child_key.attnum) as child_columns,
         (select array_agg(parent_attribute.attname::text order by parent_key.ordinality)
            from unnest(constraint_row.confkey) with ordinality as parent_key(attnum, ordinality)
            join pg_attribute parent_attribute
              on parent_attribute.attrelid = constraint_row.confrelid
             and parent_attribute.attnum = parent_key.attnum) as parent_columns
       from pg_constraint constraint_row
       join pg_class child_class on child_class.oid = constraint_row.conrelid
       join pg_class parent_class on parent_class.oid = constraint_row.confrelid
       join pg_namespace child_namespace on child_namespace.oid = child_class.relnamespace
       where constraint_row.contype = 'f' and child_namespace.nspname = 'public'`,
    )
  ).rows.map<ForeignKey>((row) => ({
    child: row.child,
    parent: row.parent,
    childColumns: row.child_columns ?? [],
    parentColumns: row.parent_columns ?? [],
  }));

  // Bit 8 of pg_trigger.tgtype marks a trigger that fires on row-removal events.
  const guards = new Map<string, string[]>();
  for (const row of (
    await client.query<{ table_name: string; trigger_name: string }>(
      "select target.relname as table_name, trigger_row.tgname as trigger_name " +
        "from pg_trigger trigger_row " +
        "join pg_class target on target.oid = trigger_row.tgrelid " +
        "join pg_namespace target_namespace on target_namespace.oid = target.relnamespace " +
        "where not trigger_row.tgisinternal and target_namespace.nspname = 'public' " +
        "and (trigger_row.tgtype & 8) > 0 order by target.relname, trigger_row.tgname",
    )
  ).rows) {
    guards.set(row.table_name, [...(guards.get(row.table_name) ?? []), row.trigger_name]);
  }

  return { tables, companyScoped, foreignKeys, guards };
}

export async function buildReports(
  client: pg.PoolClient,
  companyId: string,
  snapshot: SchemaSnapshot,
): Promise<TableReport[]> {
  const reports: TableReport[] = [];
  for (const table of snapshot.tables) {
    const ownership = resolveOwnership(table, snapshot.companyScoped, snapshot.foreignKeys);
    const { classification, reason } = classify(table, ownership);
    const statement = buildCountStatement(table, ownership);
    let rows: number | null = null;
    if (statement !== null) {
      const parameters = ownership.kind === "global" ? [] : [companyId];
      rows = Number((await client.query<{ n: string }>(statement, parameters)).rows[0]?.n ?? 0);
    }
    reports.push({
      module: moduleOf(table),
      guards: snapshot.guards.get(table) ?? [],
      table,
      classification,
      reason,
      ownership,
      rows,
      scope: ownership.kind === "global" ? "global" : statement === null ? "unknown" : "company",
    });
  }
  return reports;
}

/**
 * Readiness blockers, shared by the dry run and the execution engine so that the engine
 * can never proceed past a state the dry run reports as not ready.
 */
export function computeBlockers(
  reports: TableReport[],
  snapshot: SchemaSnapshot,
  environment: string,
  companyCode: string,
): { blockers: string[]; order: string[]; cycle: string[]; blocked: string[] } {
  const blockers: string[] = [];
  if (environment === "production") {
    blockers.push("NODE_ENV is production — test-data reset is a development-only capability.");
  }
  if (!/^DEV-/i.test(companyCode)) {
    blockers.push(`Company '${companyCode}' is not a DEV-* development Company.`);
  }

  const purgeTables = reports
    .filter((report) => report.classification === "PURGE")
    .map((report) => report.table);
  const { order, cycle, blocked } = dependencyOrder(purgeTables, snapshot.foreignKeys);
  const purgeSet = new Set(purgeTables);

  for (const report of reports.filter((entry) => entry.classification === "UNSAFE")) {
    blockers.push(`Table '${report.table}' is UNSAFE: ${report.reason}`);
  }
  for (const report of reports.filter(
    (entry) => entry.classification === "CONDITIONAL" && (entry.rows ?? 0) > 0,
  )) {
    blockers.push(
      `CONDITIONAL table '${report.table}' holds ${report.rows ?? 0} row(s) and has no recorded decision.`,
    );
  }
  if (cycle.length > 0) {
    blockers.push(
      `Unbroken foreign-key cycle in the removal set: ${cycle.join(", ")}` +
        (blocked.length > 0 ? ` (also blocking ${blocked.join(", ")})` : ""),
    );
  }

  // Every removal-set table must be scoped by its own company_id column, so that every
  // statement the engine issues carries `where company_id = $1`. An indirectly owned table
  // would need a join and is refused until it is reviewed.
  for (const report of reports.filter((entry) => entry.classification === "PURGE")) {
    if (report.ownership.kind !== "direct") {
      blockers.push(
        `Removal-set table '${report.table}' is not directly Company-scoped ` +
          `(${report.ownership.path}); direct company_id scoping is required.`,
      );
    }
  }

  // A guarded table is covered when the approved procedure applies to it, which is exactly
  // the removal set. A guarded table outside the removal set is never touched at all.
  for (const [table, triggers] of snapshot.guards) {
    if (!purgeSet.has(table)) {
      continue;
    }
    const report = reports.find((entry) => entry.table === table);
    if ((report?.rows ?? 0) > 0 && !PURGE_TABLES.has(table)) {
      blockers.push(`Guarded table '${table}' (${triggers.join(", ")}) has no approved procedure.`);
    }
  }

  for (const [parent, children] of collectInboundReferences(snapshot.foreignKeys, purgeSet)) {
    blockers.push(
      `Removal-set table '${parent}' is still referenced by: ${[...children].sort().join(", ")}.`,
    );
  }

  return { blockers, order, cycle, blocked };
}

/**
 * True when this foreign key is a reviewed compatibility reference rather than a live
 * relationship. Matched on child table, parent table AND the exact column set, so a real
 * foreign key added to the same pair of tables later is still reported.
 */
export function isLegacyCompatibilityEdge(key: ForeignKey): boolean {
  return LEGACY_COMPATIBILITY_EDGES.some(
    (entry) =>
      entry.child === key.child &&
      entry.parent === key.parent &&
      entry.columns.length === key.childColumns.length &&
      entry.columns.every((column) => key.childColumns.includes(column)),
  );
}

export function collectInboundReferences(
  foreignKeys: ForeignKey[],
  purgeSet: Set<string>,
): Map<string, Set<string>> {
  const inbound = new Map<string, Set<string>>();
  for (const key of foreignKeys) {
    if (!purgeSet.has(key.parent) || purgeSet.has(key.child) || key.child === key.parent) {
      continue;
    }
    // Declared compatibility references only. The database still enforces the constraint.
    if (isLegacyCompatibilityEdge(key)) {
      continue;
    }
    inbound.set(key.parent, (inbound.get(key.parent) ?? new Set<string>()).add(key.child));
  }
  return inbound;
}
