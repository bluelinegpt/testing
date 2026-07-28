import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import {
  type Caller,
  createCaller,
  createDisposableDatabase,
  type DisposableDatabase,
} from "./concurrency-harness.js";
import type { CreateTraderSettlementDto } from "./operations.dto.js";

const runConcurrencyTests = process.env.RUN_CONCURRENCY_DATABASE === "true";

interface Fixture {
  readonly accountId: string;
  readonly companyId: string;
  readonly traderId: string;
}

function errorCodeOf(reason: unknown): string {
  const error = reason as { code?: string; errorCode?: string } | undefined;
  return error?.errorCode ?? error?.code ?? "unknown";
}

describe.skipIf(!runConcurrencyTests)("trader settlement concurrency", () => {
  let disposable: DisposableDatabase;
  let setup: Caller;
  let fixture: Fixture;

  beforeAll(async () => {
    disposable = await createDisposableDatabase();
    const companyId = randomUUID();
    const accountId = randomUUID();
    setup = createCaller(disposable.connectionString, companyId, accountId);
    const suffix = companyId.slice(0, 8);
    const roleId = randomUUID();
    const traderAccountId = randomUUID();
    const traderId = randomUUID();
    await setup.database.transaction().execute(async (transaction) => {
      await sql`
        insert into companies (id, code, subdomain, name_en, status, activated_at)
        values (${companyId}::uuid, ${`SETCON-${suffix}`}, ${`setcon-${suffix}`},
                'Settlement Concurrency Company', 'active', now())
      `.execute(transaction);
      await sql`
        insert into accounts (id, company_id, account_kind, username, password_hash) values
          (${accountId}::uuid, ${companyId}::uuid, 'company_user', ${`setcon.actor.${suffix}`}, 'test-only'),
          (${traderAccountId}::uuid, ${companyId}::uuid, 'trader', ${`setcon.trader.${suffix}`}, 'test-only')
      `.execute(transaction);
      await sql`
        insert into roles (id, company_id, code, name, is_system)
        values (${roleId}::uuid, ${companyId}::uuid, 'company_admin', 'Company Administrator', true)
      `.execute(transaction);
      await sql`
        insert into role_permissions (role_id, permission_code)
        values (${roleId}::uuid, 'users_roles.manage')
      `.execute(transaction);
      await sql`
        insert into account_roles (account_id, role_id, company_id)
        values (${accountId}::uuid, ${roleId}::uuid, ${companyId}::uuid)
      `.execute(transaction);
      await sql`
        insert into traders (id, company_id, account_id, code, name_en, mobile_number, created_by_account_id)
        values (${traderId}::uuid, ${companyId}::uuid, ${traderAccountId}::uuid,
                ${`TRD-${suffix}`}, 'Concurrency Trader', '971501234567', ${accountId}::uuid)
      `.execute(transaction);
    });
    fixture = { accountId, companyId, traderId };
  }, 180_000);

  afterAll(async () => {
    try {
      await disposable?.assertPublicUnchanged();
    } finally {
      await setup?.destroy();
      await disposable?.drop();
    }
  }, 60_000);

  const createOrder = async (netPayable: number): Promise<string> => {
    const orderId = randomUUID();
    const areaId = randomUUID();
    const suffix = orderId.slice(0, 8);
    await setup.database.transaction().execute(async (transaction) => {
      await sql`
        insert into areas (id, company_id, emirate_id, code, name_en)
        values (${areaId}::uuid, ${fixture.companyId}::uuid,
                (select id from emirates where code='DXB'), ${`A-${suffix}`}, ${`Area ${suffix}`})
      `.execute(transaction);
      await sql`
        insert into orders (
          id, company_id, order_number, order_date, trader_id, area_id, created_by_account_id,
          customer_name, customer_mobile_number, customer_address, package_count, payment_condition,
          final_service_fee_snapshot, customer_provenance_status, pricing_provenance_status,
          trader_gross_payable, trader_net_payable,
          delivery_status, driver_reconciliation_status, trader_settlement_status, return_status
        ) values (
          ${orderId}::uuid, ${fixture.companyId}::uuid, ${`SETCON-${suffix}`}, current_date,
          ${fixture.traderId}::uuid, ${areaId}::uuid, ${fixture.accountId}::uuid,
          'Concurrency Customer', '971509999999', 'Concurrency address', 1,
          'customer_pays_cod_and_fee', 0, 'legacy_unattributed', 'legacy_unattributed',
          ${netPayable}, ${netPayable},
          'delivered', 'reconciled', 'unsettled', 'not_applicable'
        )
      `.execute(transaction);
      await sql`set constraints all immediate`.execute(transaction);
    });
    return orderId;
  };

  const payment = (
    orderId: string,
    amount: number,
    overrides: Partial<CreateTraderSettlementDto> = {},
  ): CreateTraderSettlementDto => ({
    allocations: [{ amount, orderId }],
    amount,
    paymentMethod: "cash",
    traderId: fixture.traderId,
    ...overrides,
  });

  const outstandingOf = async (orderId: string): Promise<string> => {
    const result = await sql<{ value: string }>`
      select trader_outstanding_balance::text as value from orders where id = ${orderId}::uuid
    `.execute(setup.database);
    return result.rows[0]?.value ?? "";
  };

  const statusOf = async (orderId: string): Promise<string> => {
    const result = await sql<{ value: string }>`
      select trader_settlement_status as value from orders where id = ${orderId}::uuid
    `.execute(setup.database);
    return result.rows[0]?.value ?? "";
  };

  it("allows exactly one full payment when two callers race for the same Order", async () => {
    const orderId = await createOrder(100);
    const callerA = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    const callerB = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    try {
      const request = payment(orderId, 100);
      const [first, second] = await Promise.allSettled([
        callerA.traderSettlementService.createPayment(
          request,
          randomUUID(),
          `race-a-${randomUUID()}`,
        ),
        callerB.traderSettlementService.createPayment(
          request,
          randomUUID(),
          `race-b-${randomUUID()}`,
        ),
      ]);
      const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
      const rejected = [first, second].filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // The loser must fail with a business conflict, not an internal error, and
      // must never have been allowed to double-allocate the Order.
      expect([
        "settlement_order_ineligible",
        "settlement_allocation_exceeds_outstanding",
        "settlement_allocation_empty",
      ]).toContain(errorCodeOf((rejected[0] as PromiseRejectedResult).reason));
      expect(await outstandingOf(orderId)).toBe("0.00");
      expect(await statusOf(orderId)).toBe("money_sent_to_trader");
      const linkCount = await sql<{ total: number }>`
        select count(*)::int as total from trader_settlement_orders where order_id = ${orderId}::uuid
      `.execute(setup.database);
      expect(linkCount.rows[0]?.total).toBe(1);
    } finally {
      await callerA.destroy();
      await callerB.destroy();
    }
  }, 120_000);

  it("never over-allocates when two concurrent partial payments would together exceed the balance", async () => {
    const orderId = await createOrder(100);
    const callerA = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    const callerB = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    try {
      // Two partial payments of 70 each: together they exceed the 100 outstanding,
      // so at most one can win in full and the loser must be rejected outright
      // (the service never partially applies a rejected allocation).
      const [first, second] = await Promise.allSettled([
        callerA.traderSettlementService.createPayment(
          payment(orderId, 70),
          randomUUID(),
          `over-a-${randomUUID()}`,
        ),
        callerB.traderSettlementService.createPayment(
          payment(orderId, 70),
          randomUUID(),
          `over-b-${randomUUID()}`,
        ),
      ]);
      const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
      expect(fulfilled).toHaveLength(1);
      const outstanding = Number(await outstandingOf(orderId));
      // Exactly one 70 was applied; the balance can never go negative.
      expect(outstanding).toBe(30);
      expect(outstanding).toBeGreaterThanOrEqual(0);
    } finally {
      await callerA.destroy();
      await callerB.destroy();
    }
  }, 120_000);

  it("creates one settlement for concurrent identical idempotency keys", async () => {
    const orderId = await createOrder(50);
    const key = `idem-same-${randomUUID()}`;
    const request = payment(orderId, 50);
    const callerA = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    const callerB = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    try {
      const results = await Promise.allSettled([
        callerA.traderSettlementService.createPayment(request, randomUUID(), key),
        callerB.traderSettlementService.createPayment(request, randomUUID(), key),
      ]);
      const fulfilled = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      if (fulfilled.length === 2) {
        expect(fulfilled[0]?.settlementId).toBe(fulfilled[1]?.settlementId);
      } else {
        const rejected = results.find((result) => result.status === "rejected");
        expect(["settlement_submission_in_progress", "idempotency_key_reused"]).toContain(
          errorCodeOf((rejected as PromiseRejectedResult).reason),
        );
      }
      const linkCount = await sql<{ total: number }>`
        select count(*)::int as total from trader_settlement_orders where order_id = ${orderId}::uuid
      `.execute(setup.database);
      expect(linkCount.rows[0]?.total).toBe(1);
    } finally {
      await callerA.destroy();
      await callerB.destroy();
    }
  }, 120_000);

  it("allows only one of two racing reversals to succeed", async () => {
    const orderId = await createOrder(40);
    const caller = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    const settlement = await caller.traderSettlementService.createPayment(
      payment(orderId, 40),
      randomUUID(),
      `reverse-base-${randomUUID()}`,
    );
    const callerA = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    const callerB = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    try {
      const [first, second] = await Promise.allSettled([
        callerA.traderSettlementService.reverse(settlement.settlementId, "race A", randomUUID()),
        callerB.traderSettlementService.reverse(settlement.settlementId, "race B", randomUUID()),
      ]);
      const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
      const rejected = [first, second].filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(["settlement_already_reversed"]).toContain(
        errorCodeOf((rejected[0] as PromiseRejectedResult).reason),
      );
      expect(await outstandingOf(orderId)).toBe("40.00");
      expect(await statusOf(orderId)).toBe("unsettled");
    } finally {
      await caller.destroy();
      await callerA.destroy();
      await callerB.destroy();
    }
  }, 120_000);
});
