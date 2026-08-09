import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import type { IdentityContextAccessor } from "../security/identity-context.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { EmployeeVariableEarningService } from "./employee-variable-earning.service.js";

/**
 * Employee Driver variable earning rule management.
 *
 * The claim under test is that setting a new rate SUPERSEDES rather than
 * rewrites: the old row survives with a closed period, the new one takes over
 * on its own date, and the gist exclusion constraint never has to reject
 * anything the service should have handled.
 *
 * That matters beyond tidiness. `employee_order_earnings` stores the `rule_id`
 * that priced each delivery, so a rule mutated in place would silently restate
 * what an already-paid payslip claims.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `eve_${++this.sequence}`;
    await sql.raw(`savepoint ${savepoint}`).execute(this.transaction);
    try {
      const result = await work(this.transaction);
      await sql.raw(`release savepoint ${savepoint}`).execute(this.transaction);
      return result;
    } catch (error) {
      await sql.raw(`rollback to savepoint ${savepoint}`).execute(this.transaction);
      await sql.raw(`release savepoint ${savepoint}`).execute(this.transaction);
      throw error;
    }
  }
}

interface Fixture {
  readonly actorId: string;
  readonly companyId: string;
  readonly employeeId: string;
}

function connect(): Kysely<DatabaseSchema> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 4 });
  return new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
}

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  const database = connect();
  const marker = new Error("rollback variable earning test");
  try {
    await expect(
      database.transaction().execute(async (transaction) => {
        await work(transaction);
        throw marker;
      }),
    ).rejects.toBe(marker);
  } finally {
    // destroy() ends the underlying pool; calling pool.end() as well throws.
    await database.destroy();
  }
}

async function seed(transaction: Transaction<DatabaseSchema>, label: string): Promise<Fixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const employeeId = randomUUID();
  const short = companyId.slice(0, 8);
  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`${label}-${short}`},${`${label.toLowerCase()}-${short}`},
      'Variable Earning Test','active',now())`.execute(transaction);
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${actorId}::uuid,${companyId}::uuid,'company_user',${`ve.${actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into employees(id,company_id,name_en)
    values(${employeeId}::uuid,${companyId}::uuid,'Ahmad')`.execute(transaction);
  return { actorId, companyId, employeeId };
}

function service(transaction: Transaction<DatabaseSchema>, fixture: Fixture) {
  const tenants = {
    current: () => ({ companyId: fixture.companyId, identityId: fixture.actorId }),
  } as unknown as TenantContextAccessor;
  const identities = {
    current: () => ({ identityId: fixture.actorId }),
  } as unknown as IdentityContextAccessor;
  const manager = new SavepointTransactionManager(
    transaction,
  ) as unknown as KyselyTransactionManager;
  return new EmployeeVariableEarningService(
    manager,
    tenants,
    identities,
    new OperationsHistoryWriter(),
  );
}

describe.skipIf(!runDatabaseTests)("employee driver variable earning rules", () => {
  it("creates a delivery rule and reports it as current", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "VEA");
      const rules = service(transaction, fixture);
      await rules.setDeliveryRule(
        fixture.employeeId,
        { amountPerOrder: 2, effectiveFrom: "2026-01-01" },
        randomUUID(),
      );
      const listed = await rules.rules(transaction, fixture.employeeId);
      expect(listed.delivery).toHaveLength(1);
      expect(listed.delivery[0]!.amount).toBe("2.00");
      expect(listed.delivery[0]!.isCurrent).toBe(true);
      expect(listed.delivery[0]!.effectiveTo).toBeNull();
    });
  });

  it("supersedes a delivery rate instead of overwriting it", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "VEB");
      const rules = service(transaction, fixture);
      await rules.setDeliveryRule(
        fixture.employeeId,
        { amountPerOrder: 2, effectiveFrom: "2026-01-01" },
        randomUUID(),
      );
      await rules.setDeliveryRule(
        fixture.employeeId,
        { amountPerOrder: 3, effectiveFrom: "2026-09-01" },
        randomUUID(),
      );

      const listed = await rules.rules(transaction, fixture.employeeId);
      expect(listed.delivery).toHaveLength(2);
      // Newest first. The old rate is still there, now closed at the new start,
      // so everything priced before September still reads back as 2.00.
      expect(listed.delivery[0]!.amount).toBe("3.00");
      expect(listed.delivery[0]!.effectiveFrom).toBe("2026-09-01");
      expect(listed.delivery[1]!.amount).toBe("2.00");
      expect(listed.delivery[1]!.effectiveTo).toBe("2026-09-01");
    });
  });

  it("creates each collection payment type", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "VEC");
      const rules = service(transaction, fixture);
      await rules.setCollectionRule(
        fixture.employeeId,
        { amount: 1, collectionPaymentType: "per_collected_order", effectiveFrom: "2026-01-01" },
        randomUUID(),
      );
      await rules.setCollectionRule(
        fixture.employeeId,
        {
          amount: 5,
          collectionPaymentType: "flat_per_confirmed_collection",
          effectiveFrom: "2026-06-01",
        },
        randomUUID(),
      );
      await rules.setCollectionRule(
        fixture.employeeId,
        { amount: 0, collectionPaymentType: "none", effectiveFrom: "2026-10-01" },
        randomUUID(),
      );

      const listed = await rules.rules(transaction, fixture.employeeId);
      expect(listed.collection.map((rule) => rule.paymentType)).toEqual([
        "none",
        "flat_per_confirmed_collection",
        "per_collected_order",
      ]);
      // Each period closes exactly where the next begins: no gap, no overlap.
      expect(listed.collection[2]!.effectiveTo).toBe("2026-06-01");
      expect(listed.collection[1]!.effectiveTo).toBe("2026-10-01");
      expect(listed.collection[0]!.effectiveTo).toBeNull();
    });
  });

  it("rejects rates the payment type does not allow", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "VED");
      const rules = service(transaction, fixture);
      const cases: readonly [string, Promise<unknown>][] = [
        [
          "negative delivery rate",
          rules.setDeliveryRule(
            fixture.employeeId,
            { amountPerOrder: -1, effectiveFrom: "2026-01-01" },
            randomUUID(),
          ),
        ],
        [
          "zero delivery rate",
          rules.setDeliveryRule(
            fixture.employeeId,
            { amountPerOrder: 0, effectiveFrom: "2026-01-01" },
            randomUUID(),
          ),
        ],
        [
          "paid collection type with zero amount",
          rules.setCollectionRule(
            fixture.employeeId,
            {
              amount: 0,
              collectionPaymentType: "per_collected_order",
              effectiveFrom: "2026-01-01",
            },
            randomUUID(),
          ),
        ],
        [
          "none with a non-zero amount",
          rules.setCollectionRule(
            fixture.employeeId,
            { amount: 5, collectionPaymentType: "none", effectiveFrom: "2026-01-01" },
            randomUUID(),
          ),
        ],
      ];
      for (const [label, attempt] of cases) {
        await expect(attempt, label).rejects.toMatchObject({ status: 400 });
      }
    });
  });

  it("rejects an effective period that ends before it starts", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "VEE");
      await expect(
        service(transaction, fixture).setDeliveryRule(
          fixture.employeeId,
          { amountPerOrder: 2, effectiveFrom: "2026-09-01", effectiveTo: "2026-08-01" },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "employee_earning_period_invalid" });
    });
  });

  it("refuses an overlap the supersede logic cannot resolve", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "VEF");
      const rules = service(transaction, fixture);
      // A closed rule, so there is no open-ended row for the service to end.
      await rules.setDeliveryRule(
        fixture.employeeId,
        { amountPerOrder: 2, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-01" },
        randomUUID(),
      );
      // Starting inside that closed period is a genuine conflict; the exclusion
      // constraint is left to reject it rather than the service guessing.
      await expect(
        rules.setDeliveryRule(
          fixture.employeeId,
          { amountPerOrder: 3, effectiveFrom: "2026-06-01" },
          randomUUID(),
        ),
      ).rejects.toBeTruthy();
    });
  });

  it("records the supersession in the audit trail", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "VEG");
      const rules = service(transaction, fixture);
      await rules.setDeliveryRule(
        fixture.employeeId,
        { amountPerOrder: 2, effectiveFrom: "2026-01-01" },
        randomUUID(),
      );
      await rules.setDeliveryRule(
        fixture.employeeId,
        { amountPerOrder: 3, effectiveFrom: "2026-09-01" },
        randomUUID(),
      );
      /* Selected by rate, not by time: `now()` is the transaction start inside
         one transaction, so both rows share an `occurred_at` and ordering by it
         is non-deterministic. */
      const audits = await sql<{ after: Record<string, unknown>; n: string }>`
        select after_data as after, count(*) over ()::text as n from audit_events
         where company_id=${fixture.companyId}::uuid
           and action='employee.delivery_earning_rule.set'
           and after_data->>'amount' = '3.00'`.execute(transaction);
      expect(audits.rows).toHaveLength(1);
      // The second entry must name what it displaced, or the trail cannot
      // explain why an old payslip used a different rate.
      expect(audits.rows[0]!.after.supersededRule).not.toBeNull();
    });
  });

  it("cannot read or write another Company's Employee", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const owner = await seed(transaction, "VEH");
      const neighbour = await seed(transaction, "VEI");
      const intruder = service(transaction, neighbour);

      await expect(intruder.rules(transaction, owner.employeeId)).rejects.toMatchObject({
        errorCode: "employee_not_found",
      });
      await expect(
        intruder.setDeliveryRule(
          owner.employeeId,
          { amountPerOrder: 2, effectiveFrom: "2026-01-01" },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "employee_not_found" });
    });
  });
});
