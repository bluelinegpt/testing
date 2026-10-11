import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";

/**
 * Company Data Reset test fixture (disposable databases only).
 *
 * One Company with: an active Company Admin, an Employee user (with its
 * Employee), a Driver user whose Driver has history (a conversation
 * participant), a second Driver user whose Driver has none, an ordinary user
 * (who created the Customer, so its login is history), a Trader, a Customer,
 * an Order, an accounting event + journal, configuration (settings, chart of
 * accounts, fiscal year / period), a Platform administrator with Repair
 * Center audit rows, and a general audit row. Codes, numbers and order
 * numbers are deliberately IDENTICAL across Companies.
 */

export interface ResetFixture {
  readonly company: string;
  readonly code: string;
  readonly admin: string;
  readonly employeeUser: string;
  readonly ordinaryUser: string;
  readonly driverUser: string;
  readonly driverUserNoHistory: string;
  readonly employee: string;
  readonly driver: string;
  readonly driverNoHistory: string;
  readonly trader: string;
  readonly customer: string;
  readonly order: string;
  readonly platformAdmin: string;
  readonly adminRole: string;
  readonly area: string;
}

export const DISPOSABLE_DATABASE = /(stage2|disposable|migcert|p2p5|perf|_test|blueline_phase|reset_cert)/u;

/** Hard guard: reset execution tests never run outside a disposable database. */
export function assertDisposableDatabase(url: string | undefined): void {
  const name = new URL(url ?? "postgresql://x/none").pathname.replace(/^\//u, "");
  if (!DISPOSABLE_DATABASE.test(name) || /prod/iu.test(name) || process.env.NODE_ENV === "production") {
    throw new Error(`Refusing to run Company Data Reset tests against '${name}'`);
  }
}

export async function seedResetCompany(
  client: pg.PoolClient,
  label: string,
  options: { readonly driverHistory?: boolean } = {},
): Promise<ResetFixture> {
  const company = randomUUID();
  const tag = company.slice(0, 8);
  const ids = {
    admin: randomUUID(),
    adminRole: randomUUID(),
    customer: randomUUID(),
    driver: randomUUID(),
    driverNoHistory: randomUUID(),
    driverUser: randomUUID(),
    driverUserNoHistory: randomUUID(),
    employee: randomUUID(),
    employeeUser: randomUUID(),
    memberRole: randomUUID(),
    order: randomUUID(),
    ordinaryUser: randomUUID(),
    platformAdmin: randomUUID(),
    trader: randomUUID(),
  };
  const code = `DEV-CDR-${label}-${tag}`;
  const emirate = (await client.query<{ id: string }>("select id from emirates order by code limit 1")).rows[0]!;
  await client.query(
    "insert into companies (id, code, subdomain, name_en, status, environment, activated_at) values ($1, $2, $3, $4, 'active', 'development', now())",
    [company, code, `dev-cdr-${label.toLowerCase()}-${tag}`, `Reset ${label}`],
  );
  await client.query(
    `insert into accounts (id, company_id, account_kind, username, normalized_username, password_hash, status) values
      ($1, $6, 'company_user', $7, $7, 'x', 'active'),
      ($2, $6, 'company_user', $8, $8, 'x', 'active'),
      ($3, $6, 'company_user', $9, $9, 'x', 'active'),
      ($4, $6, 'driver', $10, $10, 'x', 'active'),
      ($5, $6, 'driver', $11, $11, 'x', 'active')`,
    [
      ids.admin, ids.employeeUser, ids.ordinaryUser, ids.driverUser, ids.driverUserNoHistory, company,
      `cdr-admin-${tag}`, `cdr-employee-${tag}`, `cdr-ordinary-${tag}`, `cdr-driver-${tag}`, `cdr-driver2-${tag}`,
    ],
  );
  await client.query(
    "insert into accounts (id, company_id, account_kind, username, normalized_username, password_hash, status) values ($1, null, 'platform_administrator', $2, $2, 'x', 'disabled')",
    [ids.platformAdmin, `cdr-platform-${tag}`],
  );
  const users = await client.query<{ id: string; account_id: string }>(
    `insert into company_users (company_id, account_id, name_en, display_name) values
      ($1, $2, 'Admin', 'Admin'), ($1, $3, 'Employee User', 'Employee User'), ($1, $4, 'Ordinary', 'Ordinary')
     returning id, account_id`,
    [company, ids.admin, ids.employeeUser, ids.ordinaryUser],
  );
  const employeeCompanyUser = users.rows.find((row) => row.account_id === ids.employeeUser)!.id;
  await client.query(
    "insert into roles (id, company_id, code, name, is_system, is_active) values ($1, $3, 'company_admin', 'Company Administrator', true, true), ($2, $3, 'cdr_member', 'Member', false, true)",
    [ids.adminRole, ids.memberRole, company],
  );
  await client.query(
    "insert into role_permissions (role_id, permission_code) values ($1, 'users_roles.manage'), ($2, 'orders.create')",
    [ids.adminRole, ids.memberRole],
  );
  await client.query(
    "insert into account_roles (account_id, role_id, company_id) values ($1, $4, $6), ($2, $5, $6), ($3, $5, $6)",
    [ids.admin, ids.employeeUser, ids.ordinaryUser, ids.adminRole, ids.memberRole, company],
  );
  await client.query("insert into company_settings (company_id) values ($1)", [company]);
  const area = randomUUID();
  await client.query("insert into areas (id, company_id, code, name_en, emirate_id) values ($1, $2, 'AREA-1', 'Area', $3)", [area, company, emirate.id]);
  await client.query(
    "insert into chart_of_accounts (id, company_id, code, name_en, account_type, account_class, normal_balance) values ($1, $2, '1000', 'Cash', 'asset', 'cash', 'debit')",
    [randomUUID(), company],
  );
  const fiscalYear = randomUUID();
  const period = randomUUID();
  await client.query(
    "insert into fiscal_years (id, company_id, fiscal_year_code, name, start_date, end_date, status) values ($1, $2, 'FY-2026', 'FY', '2026-01-01', '2026-12-31', 'open')",
    [fiscalYear, company],
  );
  await client.query(
    "insert into accounting_periods (id, company_id, period_start, period_end, fiscal_year_id, period_number, period_code, name, status) values ($1, $2, '2026-01-01', '2026-01-31', $3, 1, 'P-01', 'Jan', 'open')",
    [period, company, fiscalYear],
  );

  // Workforce: Employee (no history), Driver with history, Driver without.
  await client.query(
    "insert into employees (id, company_id, company_user_id, employee_number, name_en, basic_salary, is_active, payroll_eligible, salary_hold) values ($1, $2, $3, 'EMP-0001', 'Employee One', 0, true, false, false)",
    [ids.employee, company, employeeCompanyUser],
  );
  await client.query(
    `insert into drivers (id, company_id, code, name_en, mobile_number, driver_type, outsourced_fee_per_delivered_order, account_id) values
      ($1, $3, 'DRV-0001', 'Driver One', '971500000003', 'outsourced', 5, $4),
      ($2, $3, 'DRV-0002', 'Driver Two', '971500000004', 'outsourced', 5, $5)`,
    [ids.driver, ids.driverNoHistory, company, ids.driverUser, ids.driverUserNoHistory],
  );
  // Login links: the Driver users to their Drivers, and the Admin to the Employee (R4).
  await client.query(
    `insert into user_business_links (company_id, account_id, entity_type, entity_id, access_status, is_primary, created_by_account_id) values
      ($1, $2, 'driver', $3, 'active', true, $6), ($1, $4, 'driver', $5, 'active', true, $6), ($1, $6, 'employee', $7, 'active', false, $6)`,
    [company, ids.driverUser, ids.driver, ids.driverUserNoHistory, ids.driverNoHistory, ids.admin, ids.employee],
  );

  // Masters and business data.
  await client.query("insert into traders (id, company_id, code, name_en, mobile_number) values ($1, $2, 'TRD-0001', 'Trader One', '971500000001')", [ids.trader, company]);
  await client.query(
    "insert into customers (id, company_id, code, name, mobile_number, created_by_account_id) values ($1, $2, 'CUS-0001', 'Customer One', '971500000002', $3)",
    [ids.customer, company, ids.ordinaryUser],
  );
  await client.query(
    `insert into orders (id, company_id, order_number, order_date, trader_id, area_id, created_by_account_id, customer_name, customer_mobile_number,
       customer_address, package_count, payment_condition, final_service_fee_snapshot, customer_provenance_status, pricing_provenance_status, service_fee)
     values ($1, $2, 'ORD-DUP-0001', '2026-01-15', $3, $4, $5, 'Someone', '971500000009', 'Address', 1, 'customer_pays_cod_and_fee', 25,
       'legacy_unattributed', 'legacy_unattributed', 25)`,
    [ids.order, company, ids.trader, area, ids.admin],
  );
  await client.query(
    "insert into order_status_history (id, company_id, order_id, status_dimension, to_status, changed_by_account_id) values ($1, $2, $3, 'delivery', 'new', $4)",
    [randomUUID(), company, ids.order, ids.admin],
  );
  const conversation = randomUUID();
  await client.query(
    "insert into conversations (id, company_id, conversation_type, participant_context_type, created_by_account_id) values ($1, $2, 'general_support', 'driver', $3)",
    [conversation, company, ids.admin],
  );
  if (options.driverHistory !== false) {
    // History for Driver One: an Order assigned to it (orders.assigned_driver_id).
    await client.query("update orders set assigned_driver_id = $1 where id = $2", [ids.driver, ids.order]);
    await client.query(
      "insert into order_assignments (company_id, order_id, driver_id, assigned_by_account_id) values ($1, $2, $3, $4)",
      [company, ids.order, ids.driver, ids.admin],
    );
  }
  const event = randomUUID();
  const journal = randomUUID();
  await client.query(
    `insert into accounting_events (id, company_id, event_type, event_version, source_entity_type, source_entity_id, effective_accounting_date,
       correlation_id, idempotency_key, event_hash, actor_type, description)
     values ($1, $2, 'order_delivered', 1, 'order', $3, '2026-01-15', $4, $4, $4, 'system', 'x')`,
    [event, company, ids.order, `cdr-${tag}`],
  );
  await client.query(
    `insert into journal_entries (id, company_id, journal_number, accounting_period_id, fiscal_year_id, business_date, source_type, description,
       created_by_account_id, accounting_event_id) values ($1, $2, 'JE-0001', $3, $4, '2026-01-15', 'order', 'x', $5, $6)`,
    [journal, company, period, fiscalYear, ids.admin, event],
  );
  await client.query("update accounting_events set journal_id = $1 where id = $2", [journal, event]);

  // Platform audit for this Company.
  const execution = (
    await client.query<{ id: string }>(
      `insert into platform_repair_executions(company_id, order_id, entity_type, entity_id, entity_number, finding_id, reason_code, capability_code,
         preview_version, actor_account_id, actor_authority, reason, before_state_fingerprint, after_state_fingerprint, before_health, after_health,
         before_classification, after_classification, result, idempotency_key, request_hash)
       values ($1, $2, 'order', $2, 'ORD-DUP-0001', 'fnd_cdr', 'MISSING_RECEIVABLE', 'REPAIR_TRADER_RECEIVABLE', 'rcv1:x', $3,
         'platform.companies.repair_center.execute', 'Fixture', 'a', 'b', 'ISSUE', 'HEALTHY', 'MISSING_RECEIVABLE', 'HEALTHY_ACTIVE_RECEIVABLE',
         'succeeded', $4, 'h') returning id`,
      [company, ids.order, ids.platformAdmin, `cdr-fixture-${randomUUID()}`],
    )
  ).rows[0]!.id;
  await client.query(
    `insert into platform_repair_attempts(company_id, entity_type, entity_id, actor_account_id, actor_authority, result, error_code, repair_execution_id)
     values ($1, 'order', $2, $3, 'platform.companies.repair_center.execute', 'REPLAYED', null, $4)`,
    [company, ids.order, ids.platformAdmin, execution],
  );
  await client.query(
    "insert into audit_events (company_id, action, subject_type, correlation_id, actor_account_id) values ($1, 'cdr.fixture', 'test', $2, $3)",
    [company, `cdr-audit-${tag}`, ids.admin],
  );
  // Fire the deferred integrity triggers now, as a commit would: the fixture is valid data.
  await client.query("set constraints all immediate");
  await client.query("set constraints all deferred");
  return { ...ids, area, code, company };
}

/** Content fingerprint of chosen tables for one Company. */
export async function fingerprint(client: pg.PoolClient, companyId: string, tables: readonly string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of tables) {
    const row = (
      await client.query<{ n: string; digest: string | null }>(
        `select count(*)::text as n, md5(string_agg(t::text, '|' order by t::text)) as digest from "${table}" t where t.company_id = $1`,
        [companyId],
      )
    ).rows[0]!;
    result[table] = `${row.n}:${row.digest ?? "-"}`;
  }
  return result;
}

export const USER_TABLES = ["accounts", "company_users", "account_roles", "user_business_links", "account_sessions"] as const;
export const WORKFORCE_TABLES = ["employees", "drivers"] as const;
export const MASTER_TABLES = ["traders", "customers"] as const;
export const CONFIGURATION_TABLES = ["company_settings", "areas", "chart_of_accounts", "fiscal_years", "accounting_periods", "roles"] as const;
export const AUDIT_TABLES = ["platform_repair_executions", "platform_repair_attempts", "audit_events"] as const;

export function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
