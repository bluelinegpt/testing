import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { runReset } from "./reset-company-test-data.engine.js";

/**
 * Real-database proof for the reset execution engine.
 *
 * Everything runs inside ONE transaction that is always rolled back, so the test never
 * changes the development database. It builds two throwaway Companies with fresh UUIDs and
 * resets only the first, which is what makes the isolation assertion meaningful.
 *
 * Enable with RUN_RESET_DATABASE=true.
 */

const runDatabaseTests = process.env.RUN_RESET_DATABASE === "true";

interface Fixture {
  company: string;
  account: string;
  area: string;
  trader: string;
  customer: string;
  driver: string;
  order: string;
  conversation: string;
  message: string;
  event: string;
  journal: string;
  fiscalYear: string;
  period: string;
}

async function seedCompany(client: pg.PoolClient, label: string): Promise<Fixture> {
  const fixture: Fixture = {
    company: randomUUID(),
    account: randomUUID(),
    area: randomUUID(),
    trader: randomUUID(),
    customer: randomUUID(),
    driver: randomUUID(),
    order: randomUUID(),
    conversation: randomUUID(),
    message: randomUUID(),
    event: randomUUID(),
    journal: randomUUID(),
    fiscalYear: randomUUID(),
    period: randomUUID(),
  };
  const suffix = fixture.company.slice(0, 8);
  const emirate = (await client.query<{ id: string }>("select id from emirates limit 1")).rows[0];
  if (emirate === undefined) {
    throw new Error("No emirates present; cannot seed the reset fixture");
  }

  await client.query(
    "insert into companies (id, code, subdomain, name_en, status, environment, activated_at) " +
      "values ($1, $2, $3, $4, 'active', 'development', now())",
    [
      fixture.company,
      `DEV-RST-${label}-${suffix}`,
      `dev-rst-${label.toLowerCase()}-${suffix}`,
      `Reset ${label}`,
    ],
  );
  await client.query(
    // Disabled so the fixture does not have to satisfy the active-user-needs-a-role guard.
    "insert into accounts (id, company_id, account_kind, username, normalized_username, " +
      "password_hash, status) values ($1, $2, 'company_user', $3, $3, 'x', 'disabled')",
    [fixture.account, fixture.company, `reset-${label}-${suffix}`],
  );
  await client.query(
    "insert into areas (id, company_id, code, name_en, emirate_id) values ($1, $2, $3, 'Area', $4)",
    [fixture.area, fixture.company, `A-${suffix}`, emirate.id],
  );
  await client.query(
    "insert into chart_of_accounts (id, company_id, code, name_en, account_type, account_class, " +
      "normal_balance) values ($1, $2, $3, 'Cash', 'asset', 'cash', 'debit')",
    [randomUUID(), fixture.company, `1000-${suffix}`],
  );
  await client.query(
    "insert into fiscal_years (id, company_id, fiscal_year_code, name, start_date, end_date, " +
      "status) values ($1, $2, $3, 'FY', '2026-01-01', '2026-12-31', 'open')",
    [fixture.fiscalYear, fixture.company, `FY-${suffix}`],
  );
  await client.query(
    "insert into accounting_periods (id, company_id, period_start, period_end, fiscal_year_id, " +
      "period_number, period_code, name, status) " +
      "values ($1, $2, '2026-01-01', '2026-01-31', $3, 1, $4, 'Jan', 'open')",
    [fixture.period, fixture.company, fixture.fiscalYear, `P-${suffix}`],
  );
  await client.query(
    "insert into audit_events (id, company_id, action, subject_type, correlation_id) " +
      "values ($1, $2, 'reset.fixture', 'test', $3)",
    [randomUUID(), fixture.company, suffix],
  );

  await client.query(
    "insert into traders (id, company_id, code, name_en, mobile_number) values ($1, $2, $3, $4, $5)",
    [fixture.trader, fixture.company, `T-${suffix}`, `Trader ${label}`, "971500000001"],
  );
  await client.query(
    "insert into customers (id, company_id, code, name, mobile_number, created_by_account_id) " +
      "values ($1, $2, $3, $4, $5, $6)",
    [
      fixture.customer,
      fixture.company,
      `C-${suffix}`,
      `Customer ${label}`,
      "971500000002",
      fixture.account,
    ],
  );
  await client.query(
    "insert into drivers (id, company_id, code, name_en, mobile_number, driver_type, " +
      "outsourced_fee_per_delivered_order) values ($1, $2, $3, $4, $5, 'outsourced', 5)",
    [fixture.driver, fixture.company, `D-${suffix}`, `Driver ${label}`, "971500000003"],
  );
  await client.query(
    "insert into orders (id, company_id, order_number, order_date, trader_id, area_id, " +
      "created_by_account_id, customer_name, customer_mobile_number, customer_address, " +
      "package_count, payment_condition, final_service_fee_snapshot, " +
      "customer_provenance_status, pricing_provenance_status, service_fee) " +
      "values ($1, $2, $3, '2026-01-15', $4, $5, $6, 'Someone', '971500000004', 'Address', 1, " +
      "'customer_pays_cod_and_fee', 25, 'legacy_unattributed', 'legacy_unattributed', 25)",
    [
      fixture.order,
      fixture.company,
      `ORD-${suffix}`,
      fixture.trader,
      fixture.area,
      fixture.account,
    ],
  );
  await client.query(
    "insert into order_status_history (id, company_id, order_id, status_dimension, to_status, " +
      "changed_by_account_id) values ($1, $2, $3, 'delivery', 'new', $4)",
    [randomUUID(), fixture.company, fixture.order, fixture.account],
  );

  // Communication cycle: conversations.last_message_id <-> messages.conversation_id
  await client.query(
    "insert into conversations (id, company_id, conversation_type, participant_context_type, " +
      "created_by_account_id) values ($1, $2, 'general_support', 'trader', $3)",
    [fixture.conversation, fixture.company, fixture.account],
  );
  await client.query(
    "insert into messages (id, company_id, conversation_id, sender_role, message_type, " +
      "conversation_sequence, text_body) values ($1, $2, $3, 'office', 'text', 1, 'hello')",
    [fixture.message, fixture.company, fixture.conversation],
  );
  await client.query("update conversations set last_message_id = $1 where id = $2", [
    fixture.message,
    fixture.conversation,
  ]);

  // Accounting cycle: journal_entries.accounting_event_id <-> accounting_events.journal_id
  await client.query(
    "insert into accounting_events (id, company_id, event_type, event_version, " +
      "source_entity_type, source_entity_id, effective_accounting_date, correlation_id, " +
      "idempotency_key, event_hash, actor_type, description) " +
      "values ($1, $2, 'order_delivered', 1, 'order', $3, '2026-01-15', $4, $4, $4, 'system', 'x')",
    [fixture.event, fixture.company, fixture.order, `corr-${suffix}`],
  );
  await client.query(
    "insert into journal_entries (id, company_id, journal_number, accounting_period_id, " +
      "fiscal_year_id, business_date, source_type, description, created_by_account_id, " +
      "accounting_event_id) " +
      "values ($1, $2, $3, $4, $5, '2026-01-15', 'order', 'x', $6, $7)",
    [
      fixture.journal,
      fixture.company,
      `JE-${suffix}`,
      fixture.period,
      fixture.fiscalYear,
      fixture.account,
      fixture.event,
    ],
  );
  await client.query("update accounting_events set journal_id = $1 where id = $2", [
    fixture.journal,
    fixture.event,
  ]);

  return fixture;
}

async function countFor(client: pg.PoolClient, table: string, company: string): Promise<number> {
  const result = await client.query<{ n: string }>(
    `select count(*)::bigint as n from ${table} where company_id = $1`,
    [company],
  );
  return Number(result.rows[0]?.n ?? 0);
}

describe.skipIf(!runDatabaseTests)("reset execution engine against a real database", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  });

  it("resets one Company completely and leaves the other untouched", async () => {
    const client = await pool.connect();
    await client.query("begin");
    try {
      const alpha = await seedCompany(client, "A");
      const beta = await seedCompany(client, "B");
      // Seeding queues deferred trigger events, and PostgreSQL refuses `alter table` while
      // any are pending. Real runs begin the transaction with the reset, so this only
      // affects the fixture; flushing here reproduces that clean starting state.
      await client.query("set constraints all immediate");

      const removedTables = [
        "orders",
        "order_status_history",
        "customers",
        "traders",
        "drivers",
        "conversations",
        "messages",
        "accounting_events",
        "journal_entries",
      ];
      const preservedTables = [
        "accounts",
        "areas",
        "chart_of_accounts",
        "fiscal_years",
        "accounting_periods",
        "audit_events",
      ];

      for (const table of [...removedTables, ...preservedTables]) {
        expect(await countFor(client, table, alpha.company), `${table} seeded`).toBeGreaterThan(0);
      }

      const summary = await runReset(client, alpha.company, () => undefined);
      expect(summary.totalRemoved).toBeGreaterThan(0);

      // Transactional state and business masters are gone for the reset Company.
      for (const table of removedTables) {
        expect(await countFor(client, table, alpha.company), `${table} cleared`).toBe(0);
      }
      // Preserved configuration and audit survive.
      for (const table of preservedTables) {
        expect(await countFor(client, table, alpha.company), `${table} preserved`).toBeGreaterThan(
          0,
        );
      }
      // The other Company is completely untouched.
      for (const table of [...removedTables, ...preservedTables]) {
        expect(await countFor(client, table, beta.company), `${table} isolated`).toBeGreaterThan(0);
      }

      // Both cycles were broken and both sides removed.
      expect(summary.cycleBreaks.map((entry) => entry.table).sort()).toEqual([
        "conversations",
        "journal_entries",
      ]);

      // Every suspended guard is enabled again, before any commit.
      const disabled = await client.query<{ tgname: string }>(
        "select tgname from pg_trigger where not tgisinternal and tgenabled <> 'O'",
      );
      expect(disabled.rows).toEqual([]);

      // Running it again is safe and removes nothing.
      const second = await runReset(client, alpha.company, () => undefined);
      expect(second.totalRemoved).toBe(0);
    } finally {
      await client.query("rollback");
      client.release();
    }
  }, 120_000);

  it("refuses a non-development Company and changes nothing", async () => {
    const client = await pool.connect();
    await client.query("begin");
    try {
      const company = randomUUID();
      const suffix = company.slice(0, 8);
      // Deliberately no `environment` column here: this proves the CURRENT
      // guard (`runReset` refusing a non-development `environment`, see
      // reset-company-test-data.engine.ts) still refuses a Company that was
      // never marked as a development/test Company, using the schema's own
      // `production` default -- the same real-world shape as any Company
      // nobody has ever explicitly moved to a test environment. This test
      // used to assert an older `code` naming-convention guard
      // (`/not a DEV-\*/`) that no longer exists in the engine; updated to
      // assert the guard that replaced it.
      await client.query(
        "insert into companies (id, code, subdomain, name_en, status) " +
          "values ($1, $2, $3, 'Live', 'active')",
        [company, `LIVE-${suffix}`, `live-${suffix}`],
      );
      await expect(runReset(client, company, () => undefined)).rejects.toThrow(
        /environment is 'production'/,
      );

      const disabled = await client.query<{ tgname: string }>(
        "select tgname from pg_trigger where not tgisinternal and tgenabled <> 'O'",
      );
      expect(disabled.rows).toEqual([]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  }, 60_000);

  it("restores suspended guards when the transaction rolls back", async () => {
    const client = await pool.connect();
    await client.query("begin");
    try {
      await client.query("savepoint suspend_probe");
      await client.query("alter table orders disable trigger orders_assignment_consistency");
      const during = await client.query<{ tgenabled: string }>(
        "select tgenabled from pg_trigger where tgname = 'orders_assignment_consistency'",
      );
      expect(during.rows[0]?.tgenabled).toBe("D");

      await client.query("rollback to savepoint suspend_probe");
      const after = await client.query<{ tgenabled: string }>(
        "select tgenabled from pg_trigger where tgname = 'orders_assignment_consistency'",
      );
      expect(after.rows[0]?.tgenabled).toBe("O");
    } finally {
      await client.query("rollback");
      client.release();
    }
  }, 60_000);
});
