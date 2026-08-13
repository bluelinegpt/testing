import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { type ControlledTransaction, Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { PlatformDashboardService } from "./platform-dashboard.service.js";

const enabled = process.env.RUN_PLATFORM_DASHBOARD_DATABASE === "true";

/**
 * Platform Dashboard against the real schema.
 *
 * Every fixture lives inside ONE manually-controlled transaction
 * (`database.startTransaction()`), opened in `beforeAll` and always rolled
 * back in `afterAll` — never committed, never cleaned up with an explicit
 * `DELETE`. That is not just tidiness: `platform-security-certification.test.ts`
 * asserts that no file under `apps/api/src/platform/` (this one included)
 * issues a raw `delete from` anywhere, with exactly one reviewed exemption
 * for the real Delete User service. A rolled-back transaction proves the
 * fixtures never happened at all, which is a stronger guarantee than a
 * cleanup query, and keeps this suite inside that same invariant rather than
 * asking for a second exemption.
 *
 * `companiesByStatus`/`companyRanking`'s own `companyId` filters keep every
 * assertion scoped to this suite's fixtures regardless of what else exists in
 * the shared Development database.
 *
 * Gated behind `RUN_PLATFORM_DASHBOARD_DATABASE=true`, matching every other
 * database-backed suite in this module.
 */
describe.skipIf(!enabled)("Platform Dashboard", () => {
  let pool: pg.Pool;
  let root: Kysely<DatabaseSchema>;
  let transaction: ControlledTransaction<DatabaseSchema>;
  let dashboard: PlatformDashboardService;
  const companyIds: string[] = [];

  beforeAll(async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });
    const settings = configuration();
    pool = new pg.Pool({ connectionString: settings.database.url, max: 4 });
    root = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    transaction = await root.startTransaction().execute();
    dashboard = new PlatformDashboardService(transaction);
  }, 30_000);

  afterAll(async () => {
    await transaction.rollback().execute();
    await root.destroy();
  }, 30_000);

  async function createCompany(
    status: "draft" | "active" | "suspended" | "closed",
    environment: "development" | "demo" | "sandbox" | "trial" | "production",
  ): Promise<{ companyId: string; areaId: string; traderId: string; accountId: string }> {
    const companyId = randomUUID();
    const suffix = companyId.slice(0, 8);
    companyIds.push(companyId);
    await sql`
      insert into companies (id, code, subdomain, name_en, status, environment, activated_at)
      values (${companyId}::uuid, ${`DASH-${suffix}`}, ${`dash-${suffix}`}, ${`Dashboard Fixture ${suffix}`},
              ${status}, ${environment},
              ${status === "draft" ? null : sql`now()`})
    `.execute(transaction);

    const accountId = randomUUID();
    await sql`
      insert into accounts (id, company_id, account_kind, username, normalized_username, password_hash, status)
      values (${accountId}::uuid, ${companyId}::uuid, 'company_user', ${`dash-${suffix}`}, ${`dash-${suffix}`}, 'x', 'disabled')
    `.execute(transaction);
    await sql`
      insert into company_users (company_id, account_id, name_en, display_name, is_active)
      values (${companyId}::uuid, ${accountId}::uuid, 'Dashboard Fixture', 'Dashboard Fixture', false)
    `.execute(transaction);

    const emirateId = (
      await sql<{ id: string }>`select id from emirates order by code limit 1`.execute(transaction)
    ).rows[0]?.id;
    const areaId = randomUUID();
    await sql`
      insert into areas (id, company_id, code, name_en, emirate_id)
      values (${areaId}::uuid, ${companyId}::uuid, ${`A-${suffix}`}, 'Fixture Area', ${emirateId ?? null}::uuid)
    `.execute(transaction);

    const traderId = randomUUID();
    await sql`
      insert into traders (id, company_id, code, name_en, mobile_number)
      values (${traderId}::uuid, ${companyId}::uuid, ${`T-${suffix}`}, 'Fixture Trader', '971500000001')
    `.execute(transaction);

    return { accountId, areaId, companyId, traderId };
  }

  async function createOrder(
    company: { companyId: string; areaId: string; traderId: string; accountId: string },
    overrides: {
      createdAt: string;
      deliveredAt?: string;
      deliveryStatus?: string;
      codAmount?: number;
      serviceFee?: number;
    },
  ): Promise<void> {
    const orderId = randomUUID();
    const suffix = orderId.slice(0, 8);
    await sql`
      insert into orders (
        id, company_id, order_number, order_date, trader_id, area_id, created_by_account_id,
        customer_name, customer_mobile_number, customer_address, package_count, payment_condition,
        final_service_fee_snapshot, customer_provenance_status, pricing_provenance_status,
        service_fee, service_fee_override_reason, cod_amount, delivery_status, delivered_at, created_at
      ) values (
        ${orderId}::uuid, ${company.companyId}::uuid, ${`ORD-${suffix}`}, ${overrides.createdAt.slice(0, 10)},
        ${company.traderId}::uuid, ${company.areaId}::uuid, ${company.accountId}::uuid,
        'Fixture Customer', '971500000099', 'Fixture Address', 1, 'customer_pays_cod_and_fee',
        ${overrides.serviceFee ?? 0}, 'legacy_unattributed', 'legacy_unattributed',
        ${overrides.serviceFee ?? 0},
        ${overrides.serviceFee === undefined || overrides.serviceFee === 0 ? "Dashboard fixture order" : null},
        ${overrides.codAmount ?? 0},
        ${overrides.deliveryStatus ?? "new"}, ${overrides.deliveredAt ?? null}, ${overrides.createdAt}
      )
    `.execute(transaction);
  }

  it("scopes current-state Company status/environment breakdown to the requested Company, not the whole Platform", async () => {
    const company = await createCompany("active", "development");
    const status = await dashboard.companiesByStatus({ companyId: company.companyId });
    expect(status.items).toEqual([{ count: 1, percent: 100, value: "active" }]);
    expect(status.total).toBe(1);

    const environment = await dashboard.companiesByEnvironment({ companyId: company.companyId });
    expect(environment.items).toEqual([{ count: 1, percent: 100, value: "development" }]);
  });

  it("computes Total Orders (created in range), Delivered (delivered_at in range), Delivered COD and Service Fees precisely", async () => {
    const company = await createCompany("active", "development");
    // In range, delivered in range.
    await createOrder(company, {
      codAmount: 100,
      createdAt: "2026-01-10T08:00:00Z",
      deliveredAt: "2026-01-10T09:00:00Z",
      deliveryStatus: "delivered",
      serviceFee: 10,
    });
    // Created in range, cancelled — counts toward Total Orders only.
    await createOrder(company, { createdAt: "2026-01-12T08:00:00Z", deliveryStatus: "cancelled" });
    // Created OUTSIDE range entirely — must not appear anywhere.
    await createOrder(company, {
      codAmount: 50,
      createdAt: "2026-01-20T08:00:00Z",
      deliveredAt: "2026-01-20T09:00:00Z",
      deliveryStatus: "delivered",
      serviceFee: 5,
    });
    // Created BEFORE range, but delivered INSIDE range — must count toward
    // Delivered/COD (delivered_at basis) but NOT toward Total Orders
    // (created_at basis). This is the documented timestamp-basis behaviour.
    await createOrder(company, {
      codAmount: 40,
      createdAt: "2025-12-30T08:00:00Z",
      deliveredAt: "2026-01-05T09:00:00Z",
      deliveryStatus: "delivered",
      serviceFee: 4,
    });

    const result = await dashboard.summary({
      companyId: company.companyId,
      from: "2026-01-01",
      to: "2026-01-15",
    });
    const orders = result.orders as Record<string, unknown>;
    expect(orders.total).toBe(2);
    expect(orders.delivered).toBe(2);
    expect(orders.cod).toBe(140);
    expect(orders.serviceFees).toBe(14);
    expect(orders.deliveryRate).toBe(100);
  });

  it("buckets a near-midnight UTC order under the correct Asia/Dubai calendar date", async () => {
    const company = await createCompany("active", "development");
    // 2026-01-14T20:01:00Z is 2026-01-15T00:01:00 in Asia/Dubai (UTC+4) — a
    // grouping bug that used UTC days would place this under 01-14.
    await createOrder(company, { createdAt: "2026-01-14T20:01:00Z" });

    const trend = await dashboard.ordersTrend({
      companyId: company.companyId,
      from: "2026-01-14",
      groupBy: "daily",
      to: "2026-01-16",
    });
    const series = trend.series as { bucket: string; created: number }[];
    expect(series.find((point) => point.bucket === "2026-01-15")?.created).toBe(1);
    expect(series.find((point) => point.bucket === "2026-01-14")?.created).toBe(0);
  });

  it("returns a dense zero-filled series for a period with no Orders, with no gaps", async () => {
    const company = await createCompany("active", "development");
    const trend = await dashboard.ordersTrend({
      companyId: company.companyId,
      from: "2026-02-01",
      groupBy: "daily",
      to: "2026-02-05",
    });
    const series = trend.series as { bucket: string; created: number; delivered: number }[];
    expect(series).toHaveLength(5);
    expect(series.every((point) => point.created === 0 && point.delivered === 0)).toBe(true);
  });

  it("groups Orders Trend weekly and monthly on request", async () => {
    const company = await createCompany("active", "development");
    const weekly = await dashboard.ordersTrend({
      companyId: company.companyId,
      from: "2026-01-01",
      groupBy: "weekly",
      to: "2026-01-28",
    });
    expect((weekly.series as unknown[]).length).toBeGreaterThan(0);
    expect((weekly.series as unknown[]).length).toBeLessThanOrEqual(5);

    const monthly = await dashboard.ordersTrend({
      companyId: company.companyId,
      from: "2026-01-01",
      groupBy: "monthly",
      to: "2026-03-31",
    });
    expect((monthly.series as unknown[]).length).toBe(3);
  });

  it("ranks Companies by Orders, respects Top-N, and reports a zero-Order Company honestly", async () => {
    const busy = await createCompany("active", "development");
    const quiet = await createCompany("active", "development");
    await createOrder(busy, { createdAt: "2026-01-05T08:00:00Z" });
    await createOrder(busy, { createdAt: "2026-01-06T08:00:00Z" });
    await createOrder(busy, { createdAt: "2026-01-07T08:00:00Z" });

    const ranking = (
      await dashboard.companyRanking({ from: "2026-01-01", limit: 2, metric: "orders", to: "2026-01-15" })
    ).items as { id: string; orders: number }[];
    expect(ranking).toHaveLength(2);
    expect(ranking[0]?.id).toBe(busy.companyId);
    expect(ranking[0]?.orders).toBe(3);

    const scoped = (
      await dashboard.companyRanking({ companyId: quiet.companyId, from: "2026-01-01", to: "2026-01-15" })
    ).items as { id: string; orders: number }[];
    expect(scoped).toEqual([expect.objectContaining({ id: quiet.companyId, orders: 0 })]);
  });

  it("paginates and sorts the Company Overview table, and reports Last Order correctly", async () => {
    const company = await createCompany("active", "development");
    await createOrder(company, { createdAt: "2026-01-05T08:00:00Z" });
    await createOrder(company, { createdAt: "2026-01-10T08:00:00Z" });

    const overview = await dashboard.companyOverview({
      companyId: company.companyId,
      from: "2026-01-01",
      page: 1,
      pageSize: 10,
      sort: "orders",
      to: "2026-01-15",
    });
    expect(overview.total).toBe(1);
    const rows = overview.items as { id: string; orders: number; lastOrderAt: string | null }[];
    expect(rows[0]?.id).toBe(company.companyId);
    expect(rows[0]?.orders).toBe(2);
    expect(rows[0]?.lastOrderAt).not.toBeNull();
  });

  it("rejects a date range wider than the supported maximum instead of running an unbounded query", async () => {
    await expect(dashboard.summary({ from: "2020-01-01", to: "2026-12-31" })).rejects.toThrow();
  });
});
