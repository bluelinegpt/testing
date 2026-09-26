import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { BalanceControlService } from "./balance-control.service.js";
import { BalanceEnforcementCoordinator } from "./balance-enforcement.coordinator.js";
import { FundingAccountLockService } from "./funding-account-lock.service.js";
import type { FundingAccountBalanceService } from "./funding-account-balance.service.js";

/**
 * The parts of balance enforcement that only a real database can answer.
 *
 * Everything provable with stubs lives in balance-enforcement.coordinator.test.ts.
 * What is here needs PostgreSQL itself: that `select ... for update` normalises
 * its order across two transactions, that the unique index refuses a second
 * audit for one payment, and that a throw mid-transaction leaves nothing
 * behind. A stub asserting any of those would be asserting its own behaviour.
 *
 * Every test runs inside one transaction that is deliberately rolled back, the
 * pattern the other *.database.test.ts files use: no fixture outlives the run.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

interface Fixture {
  readonly actorId: string;
  readonly bankAccountId: string;
  readonly cashAccountA: string;
  readonly cashAccountB: string;
  readonly companyId: string;
  readonly policyId: string;
}

function connect(): { database: Kysely<DatabaseSchema>; pool: Pool } {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 4 });
  return { database: new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) }), pool };
}

/** Company, actor, GL accounts, two Cash accounts, one Bank account, one policy. */
async function seed(transaction: Transaction<DatabaseSchema>): Promise<Fixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const cashGlA = randomUUID();
  const cashGlB = randomUUID();
  const bankGl = randomUUID();
  const short = companyId.slice(0, 8);
  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`BE-${short}`},${`be-${short}`},'Balance Enforcement Test','active',now())`.execute(
    transaction,
  );
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${actorId}::uuid,${companyId}::uuid,'company_user',${`be.a.${actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into chart_of_accounts(
      id,company_id,code,name_en,account_type,account_class,normal_balance,
      is_posting_account,is_active
    ) values
      (${cashGlA}::uuid,${companyId}::uuid,'1010','Cash drawer A','asset','cash','debit',true,true),
      (${cashGlB}::uuid,${companyId}::uuid,'1011','Cash drawer B','asset','cash','debit',true,true),
      (${bankGl}::uuid,${companyId}::uuid,'1020','Bank current','asset','bank','debit',true,true)`.execute(
    transaction,
  );

  // Ids chosen so that sorting by account id is OBSERVABLE: 'a…' sorts before
  // 'b…', and the tests below feed them in the wrong order on purpose.
  const cashAccountA = `aaaaaaaa-0000-4000-8000-${short.padEnd(12, "0")}`;
  const cashAccountB = `bbbbbbbb-0000-4000-8000-${short.padEnd(12, "0")}`;
  const bankAccountId = `cccccccc-0000-4000-8000-${short.padEnd(12, "0")}`;
  await sql`insert into company_cash_accounts(
      id,company_id,cash_account_code,cash_account_name,cash_account_type,
      linked_gl_account_id,effective_from,created_by_account_id
    ) values
      (${cashAccountA}::uuid,${companyId}::uuid,'CASH-0001','Drawer A','main_cash',
        ${cashGlA}::uuid,current_date,${actorId}::uuid),
      (${cashAccountB}::uuid,${companyId}::uuid,'CASH-0002','Drawer B','petty_cash',
        ${cashGlB}::uuid,current_date,${actorId}::uuid)`.execute(transaction);
  await sql`insert into company_bank_accounts(
      id,company_id,bank_name,account_name,bank_account_code,linked_gl_account_id,
      effective_from,created_by_account_id
    ) values(${bankAccountId}::uuid,${companyId}::uuid,'Test Bank','Main Current','BANK-0001',
      ${bankGl}::uuid,current_date,${actorId}::uuid)`.execute(transaction);

  // The seeded default policy only covers Companies that existed when the
  // migration ran, so this Company needs its own.
  const policyId = randomUUID();
  await sql`insert into company_balance_policies(
      id,company_id,cash_policy,bank_policy,bank_overdraft_limit,effective_from,
      change_reason,created_by_account_id
    ) values(${policyId}::uuid,${companyId}::uuid,'allow_with_override','allow_within_overdraft',
      0,'-infinity'::date,'Fixture policy',${actorId}::uuid)`.execute(transaction);

  return { actorId, bankAccountId, cashAccountA, cashAccountB, companyId, policyId };
}

function services(companyId: string) {
  const tenants = { current: () => ({ companyId }) } as unknown as TenantContextAccessor;
  const locks = new FundingAccountLockService(tenants);
  const control = new BalanceControlService(
    undefined as never,
    undefined as never,
    tenants,
    undefined as never,
  );
  return { control, locks, tenants };
}

/** Runs `work` inside a transaction that is always rolled back. */
async function inRolledBackTransaction(
  database: Kysely<DatabaseSchema>,
  work: (transaction: Transaction<DatabaseSchema>, fixture: Fixture) => Promise<void>,
): Promise<void> {
  const marker = new Error("rollback balance enforcement test");
  await expect(
    database.transaction().execute(async (transaction) => {
      const fixture = await seed(transaction);
      await work(transaction, fixture);
      throw marker;
    }),
  ).rejects.toBe(marker);
}

describe.skipIf(!runDatabaseTests)("FundingAccountLockService", () => {
  it("locks Cash before Bank and account ids in ascending order", async () => {
    const { database, pool } = connect();
    try {
      await inRolledBackTransaction(database, async (transaction, fixture) => {
        const { locks } = services(fixture.companyId);
        // Deliberately the reverse of the expected lock order.
        const locked = await locks.lockAll(transaction, [
          { accountId: fixture.bankAccountId, kind: "bank" },
          { accountId: fixture.cashAccountB, kind: "cash" },
          { accountId: fixture.cashAccountA, kind: "cash" },
        ]);
        expect(locked.map((entry) => `${entry.kind}:${entry.accountId}`)).toEqual([
          `cash:${fixture.cashAccountA}`,
          `cash:${fixture.cashAccountB}`,
          `bank:${fixture.bankAccountId}`,
        ]);
      });
    } finally {
      // destroy() ends the underlying pool; calling pool.end() as well throws.
      await database.destroy();
    }
  });

  it("removes duplicate requests before locking", async () => {
    const { database, pool } = connect();
    try {
      await inRolledBackTransaction(database, async (transaction, fixture) => {
        const { locks } = services(fixture.companyId);
        const locked = await locks.lockAll(transaction, [
          { accountId: fixture.cashAccountA, kind: "cash" },
          { accountId: fixture.cashAccountA, kind: "cash" },
          { accountId: fixture.cashAccountA, kind: "cash" },
        ]);
        expect(locked).toHaveLength(1);
        expect(locked[0]?.accountId).toBe(fixture.cashAccountA);
      });
    } finally {
      // destroy() ends the underlying pool; calling pool.end() as well throws.
      await database.destroy();
    }
  });

  it("normalises order across two transactions given opposite input orders", async () => {
    const { database, pool } = connect();
    try {
      // Both transactions ask for the same two accounts in OPPOSITE orders. The
      // helper must hand both the same sequence -- that normalisation is what
      // makes a deadlock impossible. No deadlock is provoked here: the second
      // transaction only plans, it does not contend for a held lock.
      await inRolledBackTransaction(database, async (transaction, fixture) => {
        const { locks } = services(fixture.companyId);
        const forward = await locks.lockAll(transaction, [
          { accountId: fixture.cashAccountA, kind: "cash" },
          { accountId: fixture.bankAccountId, kind: "bank" },
        ]);
        const reverse = await locks.lockAll(transaction, [
          { accountId: fixture.bankAccountId, kind: "bank" },
          { accountId: fixture.cashAccountA, kind: "cash" },
        ]);
        expect(reverse.map((e) => `${e.kind}:${e.accountId}`)).toEqual(
          forward.map((e) => `${e.kind}:${e.accountId}`),
        );
        expect(forward[0]?.kind).toBe("cash");
      });
    } finally {
      // destroy() ends the underlying pool; calling pool.end() as well throws.
      await database.destroy();
    }
  });

  // NOT TESTED HERE: that the lock actually blocks a competing transaction.
  //
  // It cannot be, inside this isolation pattern. Every fixture row is created
  // in a transaction that is rolled back and never committed, so a second
  // connection cannot see the account at all -- `for update nowait` against it
  // matches zero rows and returns cheerfully rather than raising 55P03. A test
  // written that way passes whether or not the lock is real, which is worse
  // than no test.
  //
  // Proving genuine contention needs committed fixtures and a cleanup path,
  // i.e. a different test pattern than the one this repository uses. What IS
  // proven here is the part that was actually at risk of being wrong: the
  // ORDER, which is what prevents the deadlock.

  it("reports a nonexistent and a cross-Company account identically", async () => {
    const { database, pool } = connect();
    try {
      await inRolledBackTransaction(database, async (transaction, fixture) => {
        const { locks } = services(fixture.companyId);
        // A real account belonging to a DIFFERENT Company.
        const otherCompany = await seed(transaction);
        const nonexistent = randomUUID();
        const errors: string[] = [];
        for (const accountId of [nonexistent, otherCompany.cashAccountA]) {
          await sql.raw(`savepoint lock_probe`).execute(transaction);
          try {
            await locks.lockAll(transaction, [{ accountId, kind: "cash" }]);
            errors.push("no-error");
          } catch (error) {
            errors.push((error as { errorCode?: string }).errorCode ?? "unknown");
          } finally {
            await sql.raw(`rollback to savepoint lock_probe`).execute(transaction);
            await sql.raw(`release savepoint lock_probe`).execute(transaction);
          }
        }
        // Identical, so the endpoint cannot be used to enumerate another
        // Company's account ids by watching which error comes back.
        expect(errors).toEqual([
          "funding_account_lock_not_found",
          "funding_account_lock_not_found",
        ]);
      });
    } finally {
      // destroy() ends the underlying pool; calling pool.end() as well throws.
      await database.destroy();
    }
  });

  it("refuses a non-transaction executor", async () => {
    const { database, pool } = connect();
    try {
      const { locks } = services(randomUUID());
      await expect(
        locks.lockAll(database as unknown as Transaction<DatabaseSchema>, [
          { accountId: randomUUID(), kind: "cash" },
        ]),
      ).rejects.toMatchObject({ errorCode: "funding_account_lock_requires_transaction" });
    } finally {
      // destroy() ends the underlying pool; calling pool.end() as well throws.
      await database.destroy();
    }
  });

  it("refuses a blank account id as a caller defect, not a missing account", async () => {
    const { database, pool } = connect();
    try {
      await inRolledBackTransaction(database, async (transaction, fixture) => {
        const { locks } = services(fixture.companyId);
        await expect(
          locks.lockAll(transaction, [{ accountId: "  ", kind: "cash" }]),
        ).rejects.toMatchObject({ errorCode: "funding_account_lock_account_required" });
      });
    } finally {
      // destroy() ends the underlying pool; calling pool.end() as well throws.
      await database.destroy();
    }
  });
});

describe.skipIf(!runDatabaseTests)("Balance override audits", () => {
  const overriddenResult = (fixture: Fixture, accounts: readonly ("bank" | "cash")[]) => ({
    accounts: accounts.map((kind) => ({
      accountId: kind === "cash" ? fixture.cashAccountA : fixture.bankAccountId,
      allowed: true,
      amount: "250.00",
      appliedPolicy: "allow_with_override" as const,
      currentBalance: "100.00",
      failureCode: null,
      failureReason: null,
      kind,
      overdraftLimit: "0.00",
      overrideAccepted: true,
      overrideRequired: true,
      policyId: fixture.policyId,
      projectedBalance: "-150.00",
      shortfall: "150.00",
    })),
    allowed: true,
    balanceCoverageIncomplete: false,
    coverage: {
      generalExpenseCashRowsWithoutCompanyCashAccount: 0,
      outsourcedDriverFeeCashPaymentsWithoutCashAccount: 0,
      payrollPaymentsWithoutCashAccount: 0,
      traderSettlementCashPaymentsWithoutCashAccount: 0,
    },
    failureCode: null,
    failureReason: null,
    overrideAccepted: true,
    overrideRequired: true,
    policy: {
      bankOverdraftLimit: "0.00",
      bankPolicy: "allow_within_overdraft" as const,
      cashPolicy: "allow_with_override" as const,
      effectiveFrom: null,
      effectiveTo: null,
      id: fixture.policyId,
      overridePermission: "accounting.manage",
    },
    requiresOverrideAudit: true,
  });

  const coordinatorFor = (fixture: Fixture) => {
    const { control, locks, tenants } = services(fixture.companyId);
    return new BalanceEnforcementCoordinator(
      locks,
      undefined as unknown as FundingAccountBalanceService,
      control,
      tenants,
    );
  };

  const auditCount = async (transaction: Transaction<DatabaseSchema>, companyId: string) =>
    Number(
      (
        await sql<{ count: string }>`
          select count(*)::text as count from balance_override_audits
           where company_id=${companyId}::uuid
        `.execute(transaction)
      ).rows[0]!.count,
    );

  it("writes one audit per overridden account", async () => {
    const { database, pool } = connect();
    try {
      await inRolledBackTransaction(database, async (transaction, fixture) => {
        const coordinator = coordinatorFor(fixture);
        const paymentId = randomUUID();
        const written = await coordinator.recordOverrides(transaction, {
          actorId: fixture.actorId,
          overrideReason: "Authorised by Finance",
          result: overriddenResult(fixture, ["cash", "bank"]),
          sourceEntityId: paymentId,
          sourceReference: "EXPPAY-0001",
          sourceType: "general_expense_payment",
        });
        expect(written).toHaveLength(2);
        expect(await auditCount(transaction, fixture.companyId)).toBe(2);
        const rows = await sql<{ accountKind: string; bank: string | null; cash: string | null }>`
          select account_kind as "accountKind", company_cash_account_id as cash,
                 company_bank_account_id as bank
            from balance_override_audits where company_id=${fixture.companyId}::uuid
           order by account_kind
        `.execute(transaction);
        // Each audit names its OWN account, in its own column.
        expect(rows.rows[0]).toMatchObject({ accountKind: "bank", cash: null });
        expect(rows.rows[0]?.bank).toBe(fixture.bankAccountId);
        expect(rows.rows[1]).toMatchObject({ accountKind: "cash", bank: null });
        expect(rows.rows[1]?.cash).toBe(fixture.cashAccountA);
      });
    } finally {
      // destroy() ends the underlying pool; calling pool.end() as well throws.
      await database.destroy();
    }
  });

  it("writes nothing when the result carries no accepted override", async () => {
    const { database, pool } = connect();
    try {
      await inRolledBackTransaction(database, async (transaction, fixture) => {
        const coordinator = coordinatorFor(fixture);
        const result = overriddenResult(fixture, ["cash"]);
        const written = await coordinator.recordOverrides(transaction, {
          actorId: fixture.actorId,
          overrideReason: "Authorised by Finance",
          result: {
            ...result,
            accounts: [{ ...result.accounts[0]!, overrideAccepted: false }],
            overrideAccepted: false,
            requiresOverrideAudit: false,
          },
          sourceEntityId: randomUUID(),
          sourceType: "general_expense_payment",
        });
        expect(written).toEqual([]);
        expect(await auditCount(transaction, fixture.companyId)).toBe(0);
      });
    } finally {
      // destroy() ends the underlying pool; calling pool.end() as well throws.
      await database.destroy();
    }
  });

  it("writes nothing for a blocked result", async () => {
    const { database, pool } = connect();
    try {
      await inRolledBackTransaction(database, async (transaction, fixture) => {
        const coordinator = coordinatorFor(fixture);
        await expect(
          coordinator.recordOverrides(transaction, {
            actorId: fixture.actorId,
            overrideReason: "Authorised by Finance",
            result: { ...overriddenResult(fixture, ["cash"]), allowed: false },
            sourceEntityId: randomUUID(),
            sourceType: "general_expense_payment",
          }),
        ).rejects.toMatchObject({ errorCode: "balance_override_audit_not_permitted" });
        expect(await auditCount(transaction, fixture.companyId)).toBe(0);
      });
    } finally {
      // destroy() ends the underlying pool; calling pool.end() as well throws.
      await database.destroy();
    }
  });

  it("does not write a second audit when finalisation is called twice", async () => {
    const { database, pool } = connect();
    try {
      await inRolledBackTransaction(database, async (transaction, fixture) => {
        const coordinator = coordinatorFor(fixture);
        const paymentId = randomUUID();
        const input = {
          actorId: fixture.actorId,
          overrideReason: "Authorised by Finance",
          result: overriddenResult(fixture, ["cash"]),
          sourceEntityId: paymentId,
          sourceType: "payroll_payment" as const,
        };
        const first = await coordinator.recordOverrides(transaction, input);
        const second = await coordinator.recordOverrides(transaction, input);
        expect(first).toHaveLength(1);
        expect(second).toEqual([]);
        expect(await auditCount(transaction, fixture.companyId)).toBe(1);
      });
    } finally {
      // destroy() ends the underlying pool; calling pool.end() as well throws.
      await database.destroy();
    }
  });

  it("has a unique index that refuses a duplicate identity written directly", async () => {
    const { database, pool } = connect();
    try {
      await inRolledBackTransaction(database, async (transaction, fixture) => {
        const paymentId = randomUUID();
        const insert = (id: string) => sql`
          insert into balance_override_audits(
            id,company_id,company_cash_account_id,account_kind,source_type,source_entity_id,
            direction,transaction_amount,current_balance,projected_balance,applied_policy,
            overdraft_limit_snapshot,policy_id,override_reason,override_by_account_id
          ) values(
            ${id}::uuid,${fixture.companyId}::uuid,${fixture.cashAccountA}::uuid,'cash',
            'payroll_payment',${paymentId}::uuid,'outbound',250,100,-150,'allow_with_override',
            0,${fixture.policyId}::uuid,'Authorised',${fixture.actorId}::uuid
          )
        `.execute(transaction);
        await insert(randomUUID());
        await sql.raw("savepoint dup_probe").execute(transaction);
        // The application check is bypassed entirely here: this is the database
        // itself refusing, which is the guarantee the index exists to give.
        await expect(insert(randomUUID())).rejects.toMatchObject({ code: "23505" });
        await sql.raw("rollback to savepoint dup_probe").execute(transaction);
        await sql.raw("release savepoint dup_probe").execute(transaction);
        expect(await auditCount(transaction, fixture.companyId)).toBe(1);
      });
    } finally {
      // destroy() ends the underlying pool; calling pool.end() as well throws.
      await database.destroy();
    }
  });

  it("leaves rows with no source entity outside the unique index", async () => {
    const { database, pool } = connect();
    try {
      await inRolledBackTransaction(database, async (transaction, fixture) => {
        const insert = () => sql`
          insert into balance_override_audits(
            company_id,company_cash_account_id,account_kind,source_type,source_entity_id,
            direction,transaction_amount,current_balance,projected_balance,applied_policy,
            overdraft_limit_snapshot,policy_id,override_reason,override_by_account_id
          ) values(
            ${fixture.companyId}::uuid,${fixture.cashAccountA}::uuid,'cash',
            'payroll_payment',null,'outbound',250,100,-150,'allow_with_override',
            0,${fixture.policyId}::uuid,'Historical',${fixture.actorId}::uuid
          )
        `.execute(transaction);
        // Two rows with a null entity id are not "the same" record -- they
        // carry no identity to be unique on, and merging them would be a guess.
        await insert();
        await insert();
        expect(await auditCount(transaction, fixture.companyId)).toBe(2);
      });
    } finally {
      // destroy() ends the underlying pool; calling pool.end() as well throws.
      await database.destroy();
    }
  });

  it("rolls back the audit when the surrounding transaction fails", async () => {
    const { database, pool } = connect();
    try {
      const companyHolder: { value?: string } = {};
      const marker = new Error("rollback audit durability test");
      await expect(
        database.transaction().execute(async (transaction) => {
          const fixture = await seed(transaction);
          companyHolder.value = fixture.companyId;
          const coordinator = coordinatorFor(fixture);
          await coordinator.recordOverrides(transaction, {
            actorId: fixture.actorId,
            overrideReason: "Authorised by Finance",
            result: overriddenResult(fixture, ["cash"]),
            sourceEntityId: randomUUID(),
            sourceType: "payroll_payment",
          });
          expect(await auditCount(transaction, fixture.companyId)).toBe(1);
          throw marker;
        }),
      ).rejects.toBe(marker);
      // After rollback the audit is gone: an override record cannot outlive the
      // payment it justifies.
      const survivors = await sql<{ count: string }>`
        select count(*)::text as count from balance_override_audits
         where company_id=${companyHolder.value!}::uuid
      `.execute(database);
      expect(survivors.rows[0]?.count).toBe("0");
    } finally {
      // destroy() ends the underlying pool; calling pool.end() as well throws.
      await database.destroy();
    }
  });
});
