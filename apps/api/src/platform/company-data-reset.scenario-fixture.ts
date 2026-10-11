import { randomUUID } from "node:crypto";

import type pg from "pg";

import { type ResetFixture, seedResetCompany } from "./company-data-reset.fixture.js";

/**
 * Company Data Reset, Prompt 3 -- the REALISTIC certification Company
 * (disposable databases only).
 *
 * Everything `seedResetCompany` creates (Company Admin, Employee user, Driver
 * users, ordinary user, Employee, Drivers, Trader, Customer, Order, accounting
 * event + journal, configuration, fiscal calendar, Repair Center history,
 * general audit) PLUS: a driver reconciliation, a trader collection, a trader
 * settlement, a trader receivable, a payroll period with a payroll entry, a
 * customer address, a WhatsApp integration connection and a commerce area
 * mapping. Business numbers are deliberately IDENTICAL across Companies
 * ("overlapping-looking" references) so cross-Company isolation is proven on
 * values, not only on ids.
 */

export interface ScenarioFixture extends ResetFixture {
  readonly reconciliation: string;
  readonly collection: string;
  readonly settlement: string;
  readonly receivable: string;
  readonly payrollPeriod: string;
  readonly payrollEntry: string;
  readonly whatsappConnection: string;
  readonly areaMapping: string;
}

/** Business tables the scenario populates, by reset domain (for fingerprints and accuracy checks). */
export const SCENARIO_TABLES = {
  FINANCIAL: ["trader_collections", "trader_settlements", "trader_receivables", "payroll_periods", "payroll_entries", "accounting_events", "journal_entries"],
  INTEGRATIONS: ["company_whatsapp_connections", "commerce_integration_area_mappings"],
  OPERATIONAL: ["orders", "order_status_history", "order_assignments", "conversations", "driver_reconciliations"],
  TRADERS_CUSTOMERS: ["traders", "customers", "customer_addresses"],
  WORKFORCE: ["employees", "drivers"],
} as const;

export async function seedScenarioCompany(client: pg.PoolClient, label: string): Promise<ScenarioFixture> {
  const base = await seedResetCompany(client, label, { driverHistory: true });
  const ids = {
    areaMapping: randomUUID(),
    collection: randomUUID(),
    payrollEntry: randomUUID(),
    payrollPeriod: randomUUID(),
    receivable: randomUUID(),
    reconciliation: randomUUID(),
    settlement: randomUUID(),
    whatsappConnection: randomUUID(),
  };
  const company = base.company;
  // OPERATIONAL: a draft driver reconciliation for the Driver with history.
  await client.query(
    `insert into driver_reconciliations (id, company_id, reconciliation_number, driver_id, business_date, gross_collections, net_amount_received, created_by_account_id)
     values ($1, $2, 'REC-DUP-0001', $3, '2026-01-15', 0, 0, $4)`,
    [ids.reconciliation, company, base.driver, base.admin],
  );
  // FINANCIAL: collection, settlement (draft), receivable, payroll.
  await client.query(
    `insert into trader_collections (id, company_id, collection_number, trader_id, payment_date, payment_method, amount_received, status, received_by_account_id)
     values ($1, $2, 'COL-DUP-0001', $3, '2026-01-16', 'cash', 40, 'confirmed', $4)`,
    [ids.collection, company, base.trader, base.admin],
  );
  await client.query(
    `insert into trader_settlements (id, company_id, settlement_number, trader_id, business_date, gross_payable, net_payable, status, created_by_account_id)
     values ($1, $2, 'SET-DUP-0001', $3, '2026-01-17', 0, 0, 'draft', $4)`,
    [ids.settlement, company, base.trader, base.admin],
  );
  await client.query(
    `insert into trader_receivables (id, company_id, receivable_number, trader_id, source_type, business_date, original_amount_due, status, reason, created_by_account_id)
     values ($1, $2, 'RCV-DUP-0001', $3, 'manual_adjustment', '2026-01-18', 15, 'outstanding', 'Scenario receivable', $4)`,
    [ids.receivable, company, base.trader, base.admin],
  );
  await client.query(
    `insert into payroll_periods (id, company_id, period_start, period_end, payroll_month, period_reference, status, created_by_account_id)
     values ($1, $2, '2026-01-01', '2026-01-31', '2026-01-01', 'PAY-DUP-2026-01', 'draft', $3)`,
    [ids.payrollPeriod, company, base.admin],
  );
  await client.query(
    `insert into payroll_entries (id, company_id, payroll_number, payroll_period_id, employee_id, net_salary, gross_earnings, outstanding_amount,
       employee_number_snapshot, employee_name_snapshot, created_by_account_id, status, source_marker)
     values ($1, $2, 'PRL-DUP-0001', $3, $4, 0, 0, 0, 'EMP-0001', 'Employee One', $5, 'draft', 'new_payroll')`,
    [ids.payrollEntry, company, ids.payrollPeriod, base.employee, base.admin],
  );
  // TRADERS_CUSTOMERS: a customer address.
  await client.query(
    "insert into customer_addresses (company_id, customer_id, area_id, address, created_by_account_id, is_default) values ($1, $2, $3, 'Scenario street', $4, true)",
    [company, base.customer, base.area, base.admin],
  );
  // INTEGRATIONS: WhatsApp connection (unconfigured) + a commerce area mapping.
  await client.query(
    "insert into company_whatsapp_connections (id, company_id, status, provider_type) values ($1, $2, 'not_connected', 'unconfigured')",
    [ids.whatsappConnection, company],
  );
  await client.query(
    `insert into commerce_integration_area_mappings (id, company_id, provider, external_value, normalized_external_value, area_id, created_by_account_id)
     values ($1, $2, 'salla', 'Scenario Area', 'scenario area', $3, $4)`,
    [ids.areaMapping, company, base.area, base.admin],
  );
  await client.query("set constraints all immediate");
  await client.query("set constraints all deferred");
  return { ...base, ...ids };
}
