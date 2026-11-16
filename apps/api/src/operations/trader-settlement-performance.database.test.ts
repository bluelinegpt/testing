import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { type Caller, createCaller } from "./concurrency-harness.js";
import type { CreateTraderSettlementDto } from "./operations.dto.js";

/**
 * SET-PERF-1 (16 Nov 2026): posting a Trader Settlement must be fast, must not
 * hold the settlement-number counter while slow work runs, and must never
 * create a second settlement when the same draft is posted twice.
 *
 * WRITES COMMITTED DATA (confirmed settlements are immutable and cannot be
 * cleaned up), so it is gated twice: RUN_SETTLEMENT_PERF_DATABASE=true, and
 * DATABASE_URL must name the throw-away database in
 * BLUELINE_DISPOSABLE_DB_NAME. Never point it at a real database.
 *
 * The Company is loaded with Lahthza-sized cash history (1,400 confirmed
 * Movements, half of them legacy trails without a source marker) because that
 * is what made the balance check slow.
 */

const disposableName = process.env.BLUELINE_DISPOSABLE_DB_NAME ?? "";
const databaseUrl = process.env.DATABASE_URL ?? "";
const runDatabaseTests =
  process.env.RUN_SETTLEMENT_PERF_DATABASE === "true" &&
  disposableName.length > 0 &&
  databaseUrl.endsWith(`/${disposableName}`);

interface Fixture {
  readonly actorId: string;
  readonly cashAccountId: string;
  readonly companyId: string;
  readonly traderIds: readonly string[];
}

const ordersPerTrader = 14;
const orderAmount = 150;

describe.skipIf(!runDatabaseTests)("Trader Settlement posting performance (SET-PERF-1)", () => {
  let admin: Pool;
  let fixture: Fixture;
  const callers: Caller[] = [];
  const caller = (): Caller => {
    const created = createCaller(databaseUrl, fixture.companyId, fixture.actorId, {
      useProductionBalanceEnforcement: true,
    });
    callers.push(created);
    return created;
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 2 });
    const companyId = randomUUID();
    const actorId = randomUUID();
    const cashAccountId = randomUUID();
    const traderIds = [randomUUID(), randomUUID(), randomUUID()];
    const suffix = companyId.slice(0, 8);
    const client = await admin.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into companies (id, code, subdomain, name_en, status, activated_at)
         values ($1, $2, $3, 'Settlement Performance Company', 'active', now())`,
        [companyId, `SETPERF-${suffix}`, `setperf-${suffix}`],
      );
      await client.query(
        `insert into accounts (id, company_id, account_kind, username, password_hash)
         values ($1, $2, 'company_user', $3, 'test-only')`,
        [actorId, companyId, `setperf.actor.${suffix}`],
      );
      const roleId = randomUUID();
      await client.query(
        `insert into roles (id, company_id, code, name, is_system)
         values ($1, $2, 'company_admin', 'Company Administrator', true)`,
        [roleId, companyId],
      );
      await client.query(
        `insert into role_permissions (role_id, permission_code) values ($1, 'users_roles.manage')`,
        [roleId],
      );
      await client.query(
        `insert into account_roles (account_id, role_id, company_id) values ($1, $2, $3)`,
        [actorId, roleId, companyId],
      );
      await client.query(
        `insert into company_cash_accounts
           (id, company_id, cash_account_code, cash_account_name, cash_account_type, effective_from, is_active)
         values ($1, $2, 'CASH-01', 'Main Cash', 'main_cash', current_date - 365, true)`,
        [cashAccountId, companyId],
      );
      for (const [index, traderId] of traderIds.entries()) {
        const traderAccountId = randomUUID();
        await client.query(
          `insert into accounts (id, company_id, account_kind, username, password_hash)
           values ($1, $2, 'trader', $3, 'test-only')`,
          [traderAccountId, companyId, `setperf.trader${index}.${suffix}`],
        );
        await client.query(
          `insert into traders (id, company_id, account_id, code, name_en, mobile_number, created_by_account_id)
           values ($1, $2, $3, $4, $5, '971501234567', $6)`,
          [
            traderId,
            companyId,
            traderAccountId,
            `TRD-${index}-${suffix}`,
            `Perf Trader ${index}`,
            actorId,
          ],
        );
        const areaId = randomUUID();
        await client.query(
          `insert into areas (id, company_id, emirate_id, code, name_en)
           values ($1, $2, (select id from emirates where code = 'DXB'), $3, $4)`,
          [areaId, companyId, `A-${index}-${suffix}`, `Area ${index}`],
        );
        await client.query(
          `insert into orders (
             company_id, order_number, order_date, trader_id, area_id, created_by_account_id,
             customer_name, customer_mobile_number, customer_address, package_count, payment_condition,
             final_service_fee_snapshot, customer_provenance_status, pricing_provenance_status,
             trader_gross_payable, trader_net_payable,
             delivery_status, driver_reconciliation_status, trader_settlement_status, return_status,
             service_fee_override_reason
           )
           select $1, $2 || '-' || g, current_date, $3, $4, $5,
                  'Perf Customer', '971509999999', 'Perf address', 1, 'customer_pays_cod_and_fee',
                  0, 'legacy_unattributed', 'legacy_unattributed', $6, $6,
                  'delivered', 'reconciled', 'unsettled', 'not_applicable',
                  'Configured Trader/Area price is zero'
             from generate_series(1, $7::int) g`,
          [
            companyId,
            `PERF-${index}-${suffix}`,
            traderId,
            areaId,
            actorId,
            orderAmount,
            ordersPerTrader,
          ],
        );
      }
      await client.query("set constraints all immediate");
      await client.query("commit");
      // Lahthza-sized cash history in the paying drawer. Inserted as data only:
      // the triggers that would otherwise demand an owning record per row are
      // bypassed for this one bulk statement.
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      await client.query(
        `insert into cash_bank_movements(
           company_id, movement_number, movement_type, movement_date, accounting_date, amount,
           payment_method, correlation_id, idempotency_identity, created_by_account_id, status,
           confirmed_by_account_id, confirmed_at, created_at, destination_cash_account_id,
           generated_by_source_type)
         select $1, 'PERF-MOV-' || g, 'cash_deposit', current_date - 90 + (g % 90),
                current_date - 90 + (g % 90), 100 + g % 400, 'cash',
                case when g % 2 = 0 then gen_random_uuid()::text else 'manual-' || g end,
                'perf:' || g, $2, 'confirmed', $2, now() - interval '1 day', now() - interval '1 day',
                $3, null
           from generate_series(1, 1400) g`,
        [companyId, actorId, cashAccountId],
      );
      await client.query("commit");
      await client.query("analyze cash_bank_movements");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    fixture = { actorId, cashAccountId, companyId, traderIds };
  }, 180_000);

  afterAll(async () => {
    for (const created of callers) await created.destroy();
    await admin?.end();
  });

  const draftFor = async (traderId: string): Promise<string> => {
    const orders = await admin.query<{ id: string }>(
      `select id from orders where company_id = $1 and trader_id = $2
          and trader_settlement_status = 'unsettled' order by order_number`,
      [fixture.companyId, traderId],
    );
    const payload: CreateTraderSettlementDto = {
      allocations: orders.rows.map((order) => ({ amount: orderAmount, orderId: order.id })),
      amount: orderAmount * orders.rows.length,
      cashAccountId: fixture.cashAccountId,
      paymentMethod: "cash",
      traderId,
    };
    const draft = await admin.query<{ id: string }>(
      `insert into trader_settlement_drafts (company_id, trader_id, payload, created_by_account_id, updated_by_account_id)
       values ($1, $2, $3, $4, $4) returning id`,
      [fixture.companyId, traderId, JSON.stringify(payload), fixture.actorId],
    );
    return draft.rows[0]!.id;
  };

  const timed = async <T>(operation: () => Promise<T>): Promise<{ ms: number; value: T }> => {
    const started = performance.now();
    const value = await operation();
    return { ms: Math.round(performance.now() - started), value };
  };

  it("posts a 14-order settlement in under 2 seconds", async () => {
    const draftId = await draftFor(fixture.traderIds[0]!);
    const { ms, value } = await timed(() =>
      caller().traderSettlementService.confirmDraft(draftId, randomUUID()),
    );
    expect(value.settlementId).not.toBeNull();
    console.warn(`SET-PERF-1 confirm (14 orders): ${ms} ms`);
    expect(ms).toBeLessThan(2_000);
  }, 60_000);

  it("posts two Traders at the same moment without one waiting on the other's settlement number", async () => {
    const [draftA, draftB] = [
      await draftFor(fixture.traderIds[1]!),
      await draftFor(fixture.traderIds[2]!),
    ];
    const [first, second] = await Promise.all([
      timed(() => caller().traderSettlementService.confirmDraft(draftA, randomUUID())),
      timed(() => caller().traderSettlementService.confirmDraft(draftB, randomUUID())),
    ]);
    console.warn(`SET-PERF-1 concurrent confirms: ${first.ms} ms and ${second.ms} ms`);
    expect(first.value.settlementId).not.toBeNull();
    expect(second.value.settlementId).not.toBeNull();
    expect(first.value.settlementId).not.toBe(second.value.settlementId);
    // Both share the same paying drawer, so the second waits for the first's
    // funding-account lock and commit -- but never more than a second on top.
    expect(Math.abs(first.ms - second.ms)).toBeLessThan(1_000);
    expect(Math.max(first.ms, second.ms)).toBeLessThan(3_000);
  }, 60_000);

  it("a second post of the same draft returns the same settlement: one settlement, one payment, one movement", async () => {
    // Fresh orders for Trader 0 (its first 14 were settled above).
    await admin.query(
      `insert into orders (
         company_id, order_number, order_date, trader_id, area_id, created_by_account_id,
         customer_name, customer_mobile_number, customer_address, package_count, payment_condition,
         final_service_fee_snapshot, customer_provenance_status, pricing_provenance_status,
         trader_gross_payable, trader_net_payable,
         delivery_status, driver_reconciliation_status, trader_settlement_status, return_status,
         service_fee_override_reason)
       select company_id, order_number || '-again', order_date, trader_id, area_id, created_by_account_id,
              customer_name, customer_mobile_number, customer_address, package_count, payment_condition,
              final_service_fee_snapshot, customer_provenance_status, pricing_provenance_status,
              trader_gross_payable, trader_net_payable,
              'delivered', 'reconciled', 'unsettled', 'not_applicable', service_fee_override_reason
         from orders where company_id = $1 and trader_id = $2 limit 3`,
      [fixture.companyId, fixture.traderIds[0]],
    );
    const draftId = await draftFor(fixture.traderIds[0]!);
    const [one, two] = await Promise.all([
      caller().traderSettlementService.confirmDraft(draftId, randomUUID()),
      caller().traderSettlementService.confirmDraft(draftId, randomUUID()),
    ]);
    const three = await caller().traderSettlementService.confirmDraft(draftId, randomUUID());
    expect(one.settlementId).not.toBeNull();
    expect(two.settlementId).toBe(one.settlementId);
    expect(three.settlementId).toBe(one.settlementId);
    const counts = await admin.query<{ movements: number; payments: number; settlements: number }>(
      `select (select count(*)::int from trader_settlements s
                where s.company_id = $1 and s.id = d.confirmed_settlement_id) as settlements,
              (select count(*)::int from trader_settlement_payments p
                where p.company_id = $1 and p.settlement_id = d.confirmed_settlement_id) as payments,
              (select count(*)::int from cash_bank_movements m
                where m.company_id = $1 and m.correlation_id = d.confirmed_settlement_id::text) as movements
         from trader_settlement_drafts d where d.company_id = $1 and d.id = $2`,
      [fixture.companyId, draftId],
    );
    expect(counts.rows[0]).toEqual({ movements: 1, payments: 1, settlements: 1 });
    const orderCount = await admin.query<{ value: number }>(
      `select count(*)::int as value from trader_settlements
        where company_id = $1 and trader_id = $2 and reversal_of_id is null`,
      [fixture.companyId, fixture.traderIds[0]],
    );
    expect(orderCount.rows[0]?.value).toBe(2); // the 14-order post above, and this one
  }, 60_000);

  it("the single-account balance equals that account's row in the full balance list", async () => {
    const service = caller();
    const { CashBankQueryService } = await import("../accounting/cash-bank-query.service.js");
    const support = {
      assertPermission: () => undefined,
      context: () => ({ actorId: fixture.actorId, companyId: fixture.companyId }),
    };
    const query = new CashBankQueryService(service.database, support as never, {} as never);
    const all = await query.balances();
    const { ms, value: one } = await timed(() => query.balanceFor("cash", fixture.cashAccountId));
    console.warn(`SET-PERF-1 balanceFor: ${ms} ms`);
    expect(one).toEqual(all.find((row) => row.id === fixture.cashAccountId && row.kind === "cash"));
    expect(ms).toBeLessThan(300);
  }, 60_000);
});
