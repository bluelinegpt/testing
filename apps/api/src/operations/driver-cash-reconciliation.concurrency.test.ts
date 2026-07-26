import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import {
  type Caller,
  createCaller,
  createDisposableDatabase,
  type DisposableDatabase,
} from "./concurrency-harness.js";
import type { CreateDriverReconciliationDto } from "./operations.dto.js";

const runConcurrencyTests = process.env.RUN_CONCURRENCY_DATABASE === "true";

interface Fixture {
  readonly accountId: string;
  readonly bankAccountId: string;
  readonly companyId: string;
  readonly driverId: string;
  readonly expenseTypeId: string;
}

function errorCodeOf(reason: unknown): string {
  const error = reason as { code?: string; errorCode?: string } | undefined;
  return error?.errorCode ?? error?.code ?? "unknown";
}

describe.skipIf(!runConcurrencyTests)("driver cash reconciliation concurrency", () => {
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
    const driverAccountId = randomUUID();
    const driverId = randomUUID();
    const bankAccountId = randomUUID();
    await setup.database.transaction().execute(async (transaction) => {
      await sql`
        insert into companies (id, code, subdomain, name_en, status, activated_at)
        values (${companyId}::uuid, ${`CON-${suffix}`}, ${`con-${suffix}`},
                'Concurrency Company', 'active', now())
      `.execute(transaction);
      await sql`
        insert into accounts (id, company_id, account_kind, username, password_hash) values
          (${accountId}::uuid, ${companyId}::uuid, 'company_user', ${`con.actor.${suffix}`}, 'test-only'),
          (${driverAccountId}::uuid, ${companyId}::uuid, 'driver', ${`con.driver.${suffix}`}, 'test-only')
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
        insert into drivers (
          id, company_id, account_id, code, driver_type, name_en, mobile_number, account_status
        ) values (
          ${driverId}::uuid, ${companyId}::uuid, ${driverAccountId}::uuid, ${`DRV-${suffix}`},
          'outsourced', 'Concurrency Driver', '971500000001', 'active'
        )
      `.execute(transaction);
      await sql`
        insert into company_bank_accounts (id, company_id, bank_name, account_name)
        values (${bankAccountId}::uuid, ${companyId}::uuid, 'Race Bank', 'Race Account')
      `.execute(transaction);
      await sql`
        insert into expense_types (company_id, code, name_en, display_name)
        values (${companyId}::uuid, 'PETROL', 'Petrol', 'Petrol')
      `.execute(transaction);
    });
    const type = await sql<{ id: string }>`
      select id from expense_types where company_id = ${companyId}::uuid and code = 'PETROL'
    `.execute(setup.database);
    fixture = {
      accountId,
      bankAccountId,
      companyId,
      driverId,
      expenseTypeId: type.rows[0]?.id ?? "",
    };
  }, 180_000);

  afterAll(async () => {
    try {
      // The suite must not have written a single row into public.
      await disposable?.assertPublicUnchanged();
    } finally {
      await setup?.destroy();
      await disposable?.drop();
    }
  }, 60_000);

  const createOrder = async (collected: number): Promise<string> => {
    const orderId = randomUUID();
    const traderId = randomUUID();
    const areaId = randomUUID();
    const traderAccountId = randomUUID();
    // Unique per call rather than per counter: these run concurrently.
    const suffix = orderId.slice(0, 8);
    // One transaction so the assignment-consistency trigger sees the Order and
    // its assignment together.
    await setup.database.transaction().execute(async (transaction) => {
      await sql`
        insert into areas (id, company_id, emirate_id, code, name_en)
        values (${areaId}::uuid, ${fixture.companyId}::uuid, (select id from emirates where code='DXB'), ${`A-${suffix}`},
                ${`Area ${suffix}`})
      `.execute(transaction);
      await sql`
        insert into accounts (id, company_id, account_kind, username, password_hash)
        values (${traderAccountId}::uuid, ${fixture.companyId}::uuid, 'trader',
                ${`con.trader.${suffix}`}, 'test-only')
      `.execute(transaction);
      await sql`
        insert into traders (
          id, company_id, account_id, code, name_en, mobile_number, account_status
        ) values (${traderId}::uuid, ${fixture.companyId}::uuid, ${traderAccountId}::uuid,
                  ${`T-${suffix}`}, ${`Trader ${suffix}`}, '971500000003', 'active')
      `.execute(transaction);
      await sql`
        insert into orders (
          id, company_id, order_number, order_date, trader_id, area_id,
          created_by_account_id, assigned_driver_id, customer_name,
          customer_mobile_number, customer_address, package_count, payment_condition,
          amount_collected, customer_amount_due, driver_cost,
          trader_gross_payable, trader_paid_service_fee, trader_deductions,
          trader_charges, trader_adjustments, trader_net_payable,
          delivery_status, driver_reconciliation_status, trader_settlement_status,
          delivered_at, pricing_provenance_status, final_service_fee_snapshot,
          customer_provenance_status
        ) values (
          ${orderId}::uuid, ${fixture.companyId}::uuid, ${`CON-${suffix}`}, current_date,
          ${traderId}::uuid, ${areaId}::uuid, ${fixture.accountId}::uuid,
          ${fixture.driverId}::uuid,
          'Customer', '971500000004', 'Address', 1, 'customer_pays_cod_and_fee',
          ${collected}, ${collected}, 7.5, ${collected}, 0, 0, 0, 0, ${collected},
          'assigned_to_driver', 'not_applicable', 'not_eligible', null,
          'legacy_unattributed', 0, 'legacy_unattributed'
        )
      `.execute(transaction);
      await sql`
        insert into order_assignments (company_id, order_id, driver_id, assigned_by_account_id)
        values (${fixture.companyId}::uuid, ${orderId}::uuid, ${fixture.driverId}::uuid,
                ${fixture.accountId}::uuid)
      `.execute(transaction);
      await sql`
        update orders set delivery_status = 'delivered', driver_reconciliation_status = 'pending',
                          trader_settlement_status = 'unsettled', delivered_at = now()
         where id = ${orderId}::uuid
      `.execute(transaction);
      await sql`set constraints all immediate`.execute(transaction);
    });
    return orderId;
  };

  const request = (
    orderIds: readonly string[],
    overrides: Partial<CreateDriverReconciliationDto> = {},
  ): CreateDriverReconciliationDto => ({
    excludedOrderIds: [],
    expenses: [],
    orderIds: [...orderIds],
    payments: [],
    selectionMode: "ids",
    ...overrides,
  });

  const countsFor = async (orderId: string) => {
    const result = await sql<{
      audits: number;
      events: number;
      headers: number;
      history: number;
      links: number;
      payments: number;
    }>`
      select
        (select count(*)::int from driver_reconciliation_orders where order_id = ${orderId}::uuid)
          as links,
        (select count(*)::int from order_status_history
          where order_id = ${orderId}::uuid and status_dimension = 'driver_reconciliation')
          as history,
        (select count(*)::int from order_events
          where order_id = ${orderId}::uuid and event_type = 'driver_cash.money_received')
          as events,
        (select count(*)::int from driver_reconciliations r
          where exists (select 1 from driver_reconciliation_orders l
                         where l.reconciliation_id = r.id and l.order_id = ${orderId}::uuid))
          as headers,
        (select count(*)::int from driver_reconciliation_payments p
          where exists (select 1 from driver_reconciliation_orders l
                         where l.reconciliation_id = p.reconciliation_id
                           and l.order_id = ${orderId}::uuid))
          as payments,
        (select count(*)::int from audit_events a
          where a.action = 'driver_reconciliation.confirm'
            and a.subject_id in (
              select l.reconciliation_id::text from driver_reconciliation_orders l
               where l.order_id = ${orderId}::uuid))
          as audits
    `.execute(setup.database);
    return result.rows[0];
  };

  /**
   * Blocks until PostgreSQL reports that another backend is waiting on a lock.
   *
   * This replaces a fixed sleep: it proceeds exactly when the contended state is
   * real, so the test cannot pass or fail because of machine speed.
   */
  const waitUntilSomeoneIsBlocked = async (timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const waiting = await sql<{ value: number }>`
        select count(*)::int as value
          from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and cardinality(pg_blocking_pids(pid)) > 0
      `.execute(setup.database);
      if ((waiting.rows[0]?.value ?? 0) > 0) return;
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for the confirmation to block on a lock");
      }
      await new Promise((tick) => setImmediate(tick));
    }
  };

  const statusOf = async (orderId: string): Promise<string> => {
    const result = await sql<{ status: string }>`
      select driver_reconciliation_status as status from orders where id = ${orderId}::uuid
    `.execute(setup.database);
    return result.rows[0]?.status ?? "";
  };

  it("allows exactly one confirmation when two callers race for the same Order", async () => {
    const orderId = await createOrder(100);
    const callerA = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    const callerB = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    try {
      const payload = request([orderId], {
        payments: [{ amount: 100, paymentMethod: "cash" }],
      });
      const [first, second] = await Promise.allSettled([
        callerA.service.confirm(payload, randomUUID(), `race-a-${randomUUID()}`),
        callerB.service.confirm(payload, randomUUID(), `race-b-${randomUUID()}`),
      ]);
      const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
      const rejected = [first, second].filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // The loser must fail with a business conflict, not an internal error.
      expect(["reconciliation_order_ineligible", "reconciliation_empty", "23505"]).toContain(
        errorCodeOf((rejected[0] as PromiseRejectedResult).reason),
      );
      expect(await countsFor(orderId)).toEqual({
        audits: 1,
        events: 1,
        headers: 1,
        history: 1,
        links: 1,
        payments: 1,
      });
      expect(await statusOf(orderId)).toBe("reconciled");
    } finally {
      await callerA.destroy();
      await callerB.destroy();
    }
  }, 120_000);

  it("lets only one overlapping selection win and rolls the loser back entirely", async () => {
    const [one, two, three, four, five] = await Promise.all([
      createOrder(10),
      createOrder(20),
      createOrder(30),
      createOrder(40),
      createOrder(50),
    ]);
    const callerA = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    const callerB = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    try {
      const [first, second] = await Promise.allSettled([
        callerA.service.confirm(
          request([one, two, three], { payments: [{ amount: 60, paymentMethod: "cash" }] }),
          randomUUID(),
          `overlap-a-${randomUUID()}`,
        ),
        callerB.service.confirm(
          request([three, four, five], { payments: [{ amount: 120, paymentMethod: "cash" }] }),
          randomUUID(),
          `overlap-b-${randomUUID()}`,
        ),
      ]);
      const winners = [first, second].filter((result) => result.status === "fulfilled");
      expect(winners).toHaveLength(1);
      // Order 3 is shared, so it must be reconciled exactly once.
      const shared = await countsFor(three);
      expect(shared?.links).toBe(1);
      expect(shared?.history).toBe(1);
      expect(shared?.events).toBe(1);

      const winnerIsA = first.status === "fulfilled";
      const losingOrders = winnerIsA ? [four, five] : [one, two];
      for (const orderId of losingOrders) {
        // The losing transaction rolled back completely.
        expect(await statusOf(orderId)).toBe("pending");
        expect(await countsFor(orderId)).toEqual({
          audits: 0,
          events: 0,
          headers: 0,
          history: 0,
          links: 0,
          payments: 0,
        });
      }
    } finally {
      await callerA.destroy();
      await callerB.destroy();
    }
  }, 120_000);

  it("creates one reconciliation for concurrent identical idempotency keys", async () => {
    const orderId = await createOrder(75);
    const key = `idem-same-${randomUUID()}`;
    const payload = request([orderId], { payments: [{ amount: 75, paymentMethod: "cash" }] });
    const callerA = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    const callerB = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    try {
      const results = await Promise.allSettled([
        callerA.service.confirm(payload, randomUUID(), key),
        callerB.service.confirm(payload, randomUUID(), key),
      ]);
      const fulfilled = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      if (fulfilled.length === 2) {
        // Both callers must see the same reconciliation, never two.
        expect(fulfilled[0]?.reconciliationId).toBe(fulfilled[1]?.reconciliationId);
      } else {
        // The concurrent loser is told the submission is in flight.
        const rejected = results.find((result) => result.status === "rejected");
        expect(["reconciliation_submission_in_progress", "idempotency_key_reused"]).toContain(
          errorCodeOf((rejected as PromiseRejectedResult).reason),
        );
      }
      expect(await countsFor(orderId)).toEqual({
        audits: 1,
        events: 1,
        headers: 1,
        history: 1,
        links: 1,
        payments: 1,
      });
    } finally {
      await callerA.destroy();
      await callerB.destroy();
    }
  }, 120_000);

  it("rejects the same key carrying a different material payload", async () => {
    const [one, two] = await Promise.all([createOrder(15), createOrder(25)]);
    const key = `idem-diff-${randomUUID()}`;
    const callerA = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    const callerB = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    try {
      const results = await Promise.allSettled([
        callerA.service.confirm(
          request([one], { payments: [{ amount: 15, paymentMethod: "cash" }] }),
          randomUUID(),
          key,
        ),
        callerB.service.confirm(
          request([two], { payments: [{ amount: 25, paymentMethod: "cash" }] }),
          randomUUID(),
          key,
        ),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(["idempotency_key_reused", "reconciliation_submission_in_progress"]).toContain(
        errorCodeOf((rejected as PromiseRejectedResult).reason),
      );
      // Exactly one of the two Orders was reconciled; no mixed result.
      const reconciled = [await statusOf(one), await statusOf(two)].filter(
        (status) => status === "reconciled",
      );
      expect(reconciled).toHaveLength(1);
    } finally {
      await callerA.destroy();
      await callerB.destroy();
    }
  }, 120_000);

  it("rejects an Order that became ineligible while the confirmation waited for its lock", async () => {
    const orderId = await createOrder(90);
    const blocker = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    const caller = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    try {
      // Two handshakes remove every timing assumption:
      //   1. the blocker signals only after its row lock is actually held, so the
      //      confirmation cannot win the race to the row and finish early;
      //   2. the test signals the blocker only once the database reports the
      //      confirmation is genuinely waiting on that lock.
      let blockerHoldsLock: () => void = () => undefined;
      const lockHeld = new Promise<void>((signal) => {
        blockerHoldsLock = signal;
      });
      let releaseBlocker: () => void = () => undefined;
      const mayProceed = new Promise<void>((signal) => {
        releaseBlocker = signal;
      });

      const blocked = blocker.database.transaction().execute(async (transaction) => {
        await sql`select id from orders where id = ${orderId}::uuid for update`.execute(
          transaction,
        );
        blockerHoldsLock();
        await mayProceed;
        await sql`
          update orders set driver_reconciliation_status = 'not_applicable',
                            updated_at = now(), version = version + 1
           where id = ${orderId}::uuid
        `.execute(transaction);
      });

      await lockHeld;
      const confirmation = caller.service.confirm(
        request([orderId], { payments: [{ amount: 90, paymentMethod: "cash" }] }),
        randomUUID(),
        `stale-${randomUUID()}`,
      );
      await waitUntilSomeoneIsBlocked();
      releaseBlocker();
      await blocked;
      await expect(confirmation).rejects.toMatchObject({
        errorCode: "reconciliation_order_ineligible",
      });
      // Nothing partial survived the rejection.
      expect(await countsFor(orderId)).toEqual({
        audits: 0,
        events: 0,
        headers: 0,
        history: 0,
        links: 0,
        payments: 0,
      });
    } finally {
      await blocker.destroy();
      await caller.destroy();
    }
  }, 120_000);

  it("still reconciles Orders delivered before the Driver was disabled", async () => {
    const orderId = await createOrder(35);
    const caller = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    try {
      await sql`
        update drivers set account_status = 'disabled' where id = ${fixture.driverId}::uuid
      `.execute(setup.database);
      const result = await caller.service.confirm(
        request([orderId], { payments: [{ amount: 35, paymentMethod: "cash" }] }),
        randomUUID(),
        `disabled-${randomUUID()}`,
      );
      expect(result.netAmountExpected).toBe("35.00");
      expect(await statusOf(orderId)).toBe("reconciled");
    } finally {
      await sql`
        update drivers set account_status = 'active' where id = ${fixture.driverId}::uuid
      `.execute(setup.database);
      await caller.destroy();
    }
  }, 120_000);

  it("allows only one of two racing reconciliations to claim a Bank Reference", async () => {
    const [one, two] = await Promise.all([createOrder(45), createOrder(55)]);
    const callerA = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    const callerB = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    try {
      const results = await Promise.allSettled([
        callerA.service.confirm(
          request([one], {
            payments: [
              {
                amount: 45,
                bankAccountId: fixture.bankAccountId,
                bankReference: "REF-001",
                paymentMethod: "bank_transfer",
              },
            ],
          }),
          randomUUID(),
          `bank-a-${randomUUID()}`,
        ),
        callerB.service.confirm(
          request([two], {
            payments: [
              {
                amount: 55,
                bankAccountId: fixture.bankAccountId,
                bankReference: "  ref-001  ",
                paymentMethod: "bank_transfer",
              },
            ],
          }),
          randomUUID(),
          `bank-b-${randomUUID()}`,
        ),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const reconciled = [await statusOf(one), await statusOf(two)].filter(
        (status) => status === "reconciled",
      );
      expect(reconciled).toHaveLength(1);
      const references = await sql<{ total: number }>`
        select count(*)::int as total from driver_reconciliation_payments
         where company_id = ${fixture.companyId}::uuid
           and upper(btrim(bank_reference)) = 'REF-001'
      `.execute(setup.database);
      expect(references.rows[0]?.total).toBe(1);
    } finally {
      await callerA.destroy();
      await callerB.destroy();
    }
  }, 120_000);

  it("survives repeated overlapping rounds without deadlocks or timeouts", async () => {
    const rounds = 12;
    let winners = 0;
    let losers = 0;
    let deadlocks = 0;
    let timeouts = 0;
    for (let round = 0; round < rounds; round += 1) {
      const [one, two, three] = await Promise.all([
        createOrder(11),
        createOrder(12),
        createOrder(13),
      ]);
      const callerA = createCaller(
        disposable.connectionString,
        fixture.companyId,
        fixture.accountId,
        { lockTimeoutMs: 5000 },
      );
      const callerB = createCaller(
        disposable.connectionString,
        fixture.companyId,
        fixture.accountId,
        { lockTimeoutMs: 5000 },
      );
      try {
        // Deliberately opposite declaration order; the service sorts by id, so
        // both transactions must still take locks in the same order.
        const results = await Promise.allSettled([
          callerA.service.confirm(
            request([one, two, three], { payments: [{ amount: 36, paymentMethod: "cash" }] }),
            randomUUID(),
            `dl-a-${randomUUID()}`,
          ),
          callerB.service.confirm(
            request([three, two, one], { payments: [{ amount: 36, paymentMethod: "cash" }] }),
            randomUUID(),
            `dl-b-${randomUUID()}`,
          ),
        ]);
        for (const result of results) {
          if (result.status === "fulfilled") {
            winners += 1;
            continue;
          }
          losers += 1;
          const code = errorCodeOf(result.reason);
          if (code === "40P01") deadlocks += 1;
          if (code === "55P03" || code === "57014") timeouts += 1;
        }
      } finally {
        await callerA.destroy();
        await callerB.destroy();
      }
    }
    console.warn(
      `deadlock probe: rounds=${rounds} winners=${winners} losers=${losers} ` +
        `deadlocks=${deadlocks} timeouts=${timeouts}`,
    );
    expect(winners).toBe(rounds);
    expect(losers).toBe(rounds);
    expect(deadlocks).toBe(0);
    expect(timeouts).toBe(0);
  }, 300_000);

  it("leaves no records behind for previews or failed confirmations", async () => {
    const orderId = await createOrder(65);
    const caller = createCaller(disposable.connectionString, fixture.companyId, fixture.accountId);
    try {
      // Preview writes nothing.
      await caller.service.preview(
        request([orderId], { payments: [{ amount: 65, paymentMethod: "cash" }] }),
      );
      expect(await countsFor(orderId)).toEqual({
        audits: 0,
        events: 0,
        headers: 0,
        history: 0,
        links: 0,
        payments: 0,
      });

      // A failure after the header, links and expenses are written (the payment
      // insert violates the Bank Reference uniqueness index) must roll back all.
      const reused = `REF-ROLLBACK-${randomUUID().slice(0, 8)}`;
      const otherOrder = await createOrder(20);
      await caller.service.confirm(
        request([otherOrder], {
          payments: [
            {
              amount: 20,
              bankAccountId: fixture.bankAccountId,
              bankReference: reused,
              paymentMethod: "bank_transfer",
            },
          ],
        }),
        randomUUID(),
        `rollback-seed-${randomUUID()}`,
      );
      const failingKey = `rollback-${randomUUID()}`;
      await expect(
        caller.service.confirm(
          request([orderId], {
            expenses: [{ amount: 5, expenseTypeId: fixture.expenseTypeId }],
            payments: [
              {
                amount: 60,
                bankAccountId: fixture.bankAccountId,
                bankReference: reused.toLowerCase(),
                paymentMethod: "bank_transfer",
              },
            ],
          }),
          randomUUID(),
          failingKey,
        ),
      ).rejects.toBeDefined();
      expect(await countsFor(orderId)).toEqual({
        audits: 0,
        events: 0,
        headers: 0,
        history: 0,
        links: 0,
        payments: 0,
      });
      expect(await statusOf(orderId)).toBe("pending");

      // The failed attempt did not permanently consume the key, and a corrected
      // submission using the same key succeeds.
      const corrected = await caller.service.confirm(
        request([orderId], {
          expenses: [{ amount: 5, expenseTypeId: fixture.expenseTypeId }],
          payments: [{ amount: 60, paymentMethod: "cash" }],
        }),
        randomUUID(),
        failingKey,
      );
      expect(corrected.netAmountExpected).toBe("60.00");
      expect(await statusOf(orderId)).toBe("reconciled");
    } finally {
      await caller.destroy();
    }
  }, 180_000);

  it("generates unique Company-scoped references under concurrency", async () => {
    const orders = await Promise.all([
      createOrder(1),
      createOrder(2),
      createOrder(3),
      createOrder(4),
      createOrder(5),
    ]);
    const callers = orders.map(() =>
      createCaller(disposable.connectionString, fixture.companyId, fixture.accountId),
    );
    try {
      const results = await Promise.all(
        orders.map((orderId, index) =>
          callers[index]!.service.confirm(
            request([orderId], { payments: [{ amount: index + 1, paymentMethod: "cash" }] }),
            randomUUID(),
            `ref-${index}-${randomUUID()}`,
          ),
        ),
      );
      const numbers = results.map((result) => result.reconciliationNumber);
      expect(new Set(numbers).size).toBe(numbers.length);
      expect(numbers.every((number) => number.startsWith("REC-"))).toBe(true);
    } finally {
      await Promise.all(callers.map((caller) => caller.destroy()));
    }
  }, 180_000);
});
